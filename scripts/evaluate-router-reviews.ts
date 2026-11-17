import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { ROUTER_SYSTEM_PROMPT, type RouterDecision, type RouterObject } from '../src/shared/router'
import { readDeepSeekReusableConnection } from '../src/main/deepseekService'
import { DeepSeekHostService } from '../src/main/deepseekHostService'
import { DeepSeekHostRunner } from '../src/main/deepseekHostRunner'
import { routerMcpServers } from '../src/main/router/mcp'
import { prepareDeepSeekHostContext, registerDeepSeekHostContext } from '../src/main/deepseekHostContext'
import { sanitizeRouterReview } from '../src/shared/routerReview'
import { routerFixture } from '../test/fixtures/router-quality'
import { loadReviewCases, judgeReview, reviewExpectation, chronologicalReviewCases, type ReviewCase } from '../test/fixtures/router-reviews'
import { routerSystemCases } from '../test/fixtures/router-system'
import { RouterContextService } from '../src/main/router/context'

// Explicit evaluator; normal regression discovery never runs a native model.
// The only assignment implementations are the existing isolated fixture journal.
const root = process.env.UA_ROUTER_REVIEW_EXPORT
const systemCases = process.env.UA_ROUTER_EVAL_SYSTEM_CASES === '1'
if (!root && !systemCases) throw new Error('UA_ROUTER_REVIEW_EXPORT required')
const live = process.env.UA_ROUTER_REVIEW_LIVE === '1'
const output = resolve(process.env.UA_ROUTER_EVAL_OUTPUT || 'out/router-review-replay.json')
const entrySource = process.env.UA_ROUTER_EVAL_ENTRY || 'scripts/evaluate-router-reviews.ts'
const entryPath = isAbsolute(entrySource) ? entrySource : resolve(entrySource)
const bundlePath = process.argv[1] ? resolve(process.argv[1]) : undefined
const hashFile = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const entrypoint = { source: entryPath, sourceSha256: await hashFile(entryPath), compiledBundle: bundlePath, compiledSha256: bundlePath ? await hashFile(bundlePath) : undefined,
  command: process.env.UA_ROUTER_EVAL_ENTRY_COMMAND || 'node scripts/run-ts-test.mjs ' + entryPath, variant: process.env.UA_ROUTER_EVAL_VARIANT || 'working-tree' }
const cases: Array<ReviewCase & { syntheticExpectation?: Partial<RouterDecision> }> = systemCases ? process.env.UA_ROUTER_EVAL_CONTEXT_SNAPSHOT ?
  JSON.parse(await readFile(process.env.UA_ROUTER_EVAL_CONTEXT_SNAPSHOT, 'utf8')) : await routerSystemCases() : await loadReviewCases(root!)
if (process.env.UA_ROUTER_EVAL_PREPARE_SYSTEM === '1') {
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(cases, null, 2)); process.exit(0)
}
if (process.env.UA_ROUTER_EVAL_PROMPTS) throw new Error('custom_eval_prompt_unsupported: use a frozen implementation checkout for baseline prompts')
const prompts = { systemPrompt: ROUTER_SYSTEM_PROMPT }
const material = process.env.UA_ROUTER_EVAL_MATERIAL ? JSON.parse(await readFile(process.env.UA_ROUTER_EVAL_MATERIAL, 'utf8')) : undefined
if (material) {
  const description = material.probes.find((probe: any) => probe.kind === 'description' && probe.passed)?.output.description
  if (!description || !material.material?.document?.content) throw Error('current_material_not_verified')
  const requirement = cases.flatMap(row => row.objects).find(object => object.id === material.material.requirementId)
  if (!requirement) throw Error('current_material_requirement_unavailable')
  const context = new RouterContextService({ projects: () => [], sessions: () => [], events: async () => [], seed: () => undefined,
    requirements: async () => [{ id: requirement.id, name: requirement.title, projectId: requirement.projectId,
      createdAt: material.material.document.updatedAt, updatedAt: material.material.document.updatedAt, status: 'active' } as any],
    overview: async () => { throw Error('use verified current material') },
    routing: async () => ({ snapshot: { status: 'missing', sourceRevision: material.material.revision }, sources: { revision: material.material.revision,
      documents: [{ ...material.material.document, kind: 'core', title: '当前需求核心原文（非当时快照）',
        contentHash: material.material.document.contentHash || createHash('sha256').update(material.material.document.content).digest('hex'),
        status: material.material.document.status || 'active', freshness: material.material.document.freshness || 'needs-review',
        sources: material.material.document.sources || [], dependencies: material.material.document.dependencies || [] }], references: material.references || [] } }) as any })
  const supplied = (await context.objects())[0]
  for (const row of cases) {
    row.objects = row.objects.map(object => object.id !== material.material.requirementId ? object : { ...object, summary: description, version: supplied.version,
      sources: supplied.sources, description: undefined })
    row.gaps.push('本组明确替换为当前需求原文、资料入口目录及真实生成的摘要，保持其它候选与历史时钟；是资料供给对照，不是当时原文回放或泛化验证。')
  }
}
const report: any = { entrypoint, mode: material ? 'native-model-current-material-counterfactual' : live ? 'native-model-recorded-candidates' : 'recorded-decisions-current-host', sourceExport: root,
  notice: material ? '资料供给对照：仅将指定需求替换为已读取的当前核心原文、当前资料入口目录和真实生成摘要，来源通过生产 RouterContextService 构造，保持原始输入、其它候选及历史时钟。这不是当时原文回放或泛化验证，不并入历史回放成绩。' :
    systemCases ? '新合成契约样本；候选来自实际 RouterContextService 的原始来源夹具，不是用户反馈或独立真实标签。预期结果不提供给模型。' :
    '候选仅从被评价尝试及其先前历史中的真实查询返回重建；不是当时全部数据库，也不等同原生历史完整回放。未额外注入feedback.expected或本轮评分；原始输入及图片自身可能包含历史分配或反馈。',
  promptHashes: Object.fromEntries(Object.entries(prompts).map(([key, value]) => [key, createHash('sha256').update(String(value)).digest('hex')])),
  contextSnapshot: process.env.UA_ROUTER_EVAL_CONTEXT_SNAPSHOT,
  material: material && { ...material.material, referenceCount: material.references?.length || 0, referenceRevision: material.referenceRevision },
  startedAt: new Date().toISOString(), cases: [], inventory: cases.map(row => ({ id: row.id, matches: row.feedback?.matches ?? null,
    expected: row.syntheticExpectation || reviewExpectation(row.feedback), feedbackRevision: row.feedback?.revision, availability: row.availability, attempts: row.traces.length,
    objects: row.objects.length, gaps: row.gaps, ...(row.id.startsWith('9f753fca') ? { legacyContractDifference: '旧标签按项目直属任务；新规则默认新建需求，保留原标签单列' } : {}), originalJudgment: judgeReview(row.feedback, row.request.decision, row.objects),
    errors: row.trace?.steps?.filter(step => step.kind === 'error').map(step => step.data) || [] })),
  realBusinessDeliveries: 0, errors: [] }
const sourceFiles = ['src/shared/router.ts', 'src/shared/taskTitle.ts', 'src/main/taskTitleTokens.ts', 'src/main/router/controller.ts', 'src/main/router/database.ts', 'src/main/router/context.ts', 'src/main/router/mcp.ts', 'src/main/sessionInstructions.ts',
  'src/main/router/summary.ts', 'src/main/router/worker.ts', 'src/main/requirementSpace.ts', 'src/shared/requirementTypes.ts',
  'test/fixtures/router-reviews.ts', 'test/fixtures/router-quality.ts', 'test/fixtures/router-system.ts', entrySource]
const sourceRoot = process.env.UA_ROUTER_EVAL_SOURCE_ROOT || ''
report.sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await hashFile(isAbsolute(file) ? file : join(sourceRoot, file))])))
report.implementation = { checkout: process.env.UA_ROUTER_EVAL_SOURCE_ROOT || process.cwd(), revision: process.env.UA_ROUTER_EVAL_REVISION || 'working-tree' }
if (process.env.UA_ROUTER_EVAL_SOURCE_MANIFEST) throw new Error('source_manifest_override_forbidden: run the frozen implementation checkout instead')
await mkdir(resolve(output, '..'), { recursive: true })
const save = () => writeFile(output, JSON.stringify(sanitizeRouterReview(report), null, 2))

async function prepareEvaluatorHost(home: string): Promise<string> {
  const patch = await prepareDeepSeekHostContext(home)
  // Test-only Host plugin: after the router MCP servers are bound, use the
  // official tools.restrict filter to remove every global native tool. The
  // evaluator additionally disables the native presets and working-directory
  // tool, then verifies the actual request header before accepting a case.
  const pluginPath = join(home, 'uniagent-context', 'plugin.mjs')
  let source = await readFile(pluginPath, 'utf8')
  source = source.replace("import { readFile } from 'node:fs/promises'", "import { readFile, writeFile } from 'node:fs/promises'")
  source = source.replace("for (const fiber of previous?.fibers || []) await fiber.dispose()", "for (const fiber of previous?.fibers || []) await fiber.dispose(); previous?.restriction?.()")
  source = source.replace("        bindings.set(agent, { raw, fibers })", `        const toolService = agent.ctx.get('tools')
        if (!toolService) throw new Error('eval_tool_service_unavailable')
        if (previous?.restriction) previous.restriction()
        const restrictable = [...toolService.view(agent.ctx).restrictableNames]
        const restriction = restrictable.length ? toolService.restrict({ deny: restrictable }) : undefined
        const visible = toolService.schemas(agent.ctx).map(row => row.name)
        await writeFile(join(config.directory, 'eval-tool-debug.json'), JSON.stringify({ restrictable, visible }, null, 2))
        const allowed = ['router_query', 'router_assign_task', 'mcp__uniagent-router__router_query', 'mcp__uniagent-router__router_assign_task']
        const unexpected = visible.filter(name => !allowed.includes(name))
        if (unexpected.length) { restriction?.(); throw new Error('eval_tool_isolation_failed:' + unexpected.join(',')) }
        await writeFile(join(config.directory, 'eval-tool-catalog.json'), JSON.stringify({ restrictable, visible }, null, 2))
        bindings.set(agent, { raw, fibers, restriction })`)
  await writeFile(pluginPath, source)
  const overlay = JSON.parse(await readFile(patch, 'utf8'))
  overlay.push({ id: 'tool-working-directory', disabled: true })
  overlay.push({ id: 'mcp-resources', disabled: true })
  overlay.push({ id: 'agent-preset-registry', config: { default: 'eval-router' } })
  overlay.push({ insert: [{ id: 'preset-eval-router', name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'eval-router', order: 1, plugins: [{ id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } }] } }] })
  await writeFile(patch, JSON.stringify(overlay))
  return patch
}
let now = Date.now()
const objects: RouterObject[] = []
const backend = process.env.UA_ROUTER_EVAL_BACKEND || 'deepseek'
if (live && backend !== 'deepseek') throw new Error('free_eval_requires_deepseek_host')
const model = process.env.UA_ROUTER_EVAL_MODEL || 'deepseek-flash', effort = process.env.UA_ROUTER_EVAL_EFFORT || 'max'
const rounds = Math.max(1, Math.min(3, Number(process.env.UA_ROUTER_EVAL_ROUNDS || 1)))
const appData = process.env.UA_ROUTER_EVAL_USER_DATA || join(homedir(), 'Library/Application Support/uniagent')
let host: DeepSeekHostService | undefined, runner: DeepSeekHostRunner | undefined, nativeSession: string | undefined, nativeRoot: string | undefined, toolFollow: AsyncGenerator<any> | undefined
let current: any, finish: ((value: any) => void) | undefined
const f = await routerFixture(objects, { now: () => now, send: async (_id, prompt, attachments) => {
  if (!live) return
  if (!runner) throw new Error('deepseek_host_runner_not_ready')
  try { await runner.startTurn(prompt, attachments) }
  catch (error) {
    if (current) current.runtimeFailure = error instanceof Error ? error.message : String(error)
    finish?.({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
} })
try {
  if (live) {
    if (!Number.isFinite(now) || !f.db.sessionId()) throw new Error('router_fixture_session_unavailable')
    const directory = await mkdtemp(join(tmpdir(), 'ua-router-review-deepseek-'))
    nativeRoot = directory
    const home = join(directory, 'host'), cwd = join(directory, 'workspace')
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const previousData = process.env.UNIAGENT_USER_DATA
    let connection
    try {
      process.env.UNIAGENT_USER_DATA = appData
      connection = await readDeepSeekReusableConnection()
    } finally {
      if (previousData === undefined) delete process.env.UNIAGENT_USER_DATA
      else process.env.UNIAGENT_USER_DATA = previousData
    }
    if (!connection.apiKey) throw new Error('deepseek_free_connection_unavailable: no local API key; configure the official DeepSeek connection or set UA_ROUTER_EVAL_USER_DATA')
    const runtime = JSON.parse(await readFile(join(appData, 'deepseek/active-runtime.json'), 'utf8'))
    if (!/^installed-[a-f0-9-]+$/.test(runtime.directory)) throw new Error('deepseek_free_runtime_invalid')
    const bin = process.env.UA_ROUTER_EVAL_DSH_BIN || join(appData, 'deepseek', runtime.directory, 'node_modules/.bin/dsh')
    const patch = await prepareEvaluatorHost(home)
    host = new DeepSeekHostService({ bin, home, cwd, patchFile: patch, timeoutMs: 60000,
      modelEnvironment: { DEEPSEEK_API_KEY: connection.apiKey, DEEPSEEK_BASE_URL: connection.baseUrl } })
    const client = await host.start()
    const catalog: any = await client.call('session/modelCatalog', {})
    const group = catalog.groups?.find((row: any) => row.id === 'deepseek-official')
    const selected = group?.models?.find((row: any) => row.id === model)
    if (!selected) throw new Error('free_deepseek_model_unavailable: ' + model)
    if (!(selected.reasoning?.efforts || []).some((row: any) => row.id === effort)) throw new Error('free_deepseek_effort_unavailable: ' + model + '/' + effort)
    registerDeepSeekHostContext(client, home, id => routerMcpServers(id) || [])
    const sessionId = f.db.sessionId()!
    const agent = { id: 'deepseek', adapter: 'deepseek', name: 'DeepSeek Harness', installed: true, models: [], capabilities: {} } as any
    const runnerConfig = { agentId: 'deepseek', workdir: f.directory, model: JSON.stringify(['deepseek-official', model]), effort,
      permissionMode: 'ask' as const, managedPurpose: 'router' as const }
    runner = new DeepSeekHostRunner(sessionId, { n: 0 }, agent, runnerConfig, undefined, undefined, async () => client)
    runner.on('event', (event: any) => {
      if (!current) return
      if (event.type === 'turn_completed') { current.nativeTurnId = event.payload?.turnId; current.events.push({ type: 'turn_completed', state: event.state, payload: { turnId: event.payload?.turnId } }) }
      if (event.type === 'error') { current.errors.push(event.payload); current.events.push({ type: 'error', state: event.state, payload: event.payload }) }
      if (event.type === 'agent_message' && event.state === 'success') {
        const key = event.payload?.id || current.agentMessages.length
        const previous = current.agentMessages.find((row: any) => row.id === key)
        const text = String(event.payload?.text || '').slice(-4000)
        if (previous) previous.text = text
        else current.agentMessages.push({ id: key, text })
      }
      if (event.type === 'tool_call') {
        const key = event.payload?.id || event.payload?.name
        const row = { name: event.payload?.name, state: event.state, input: event.payload?.input, arguments: event.payload?.arguments,
          output: event.payload?.output, ...(event.payload?.output && event.payload.output.length > 20000 ? { outputTruncated: true, output: event.payload.output.slice(0, 20000) } : {}) }
        const previous = current.toolCalls.findIndex((item: any) => item.id === key)
        if (previous >= 0) current.toolCalls[previous] = { id: key, ...row }
        else current.toolCalls.push({ id: key, ...row })
      }
      if (event.type === 'approval_request') {
        const id = event.payload?.requestId || event.payload?.id
        const title = String(event.payload?.title || event.payload?.name || '')
        if (event.payload?.kind === 'question') {
          current.errors.push({ code: 'unexpected_question' }); runner!.interrupt(); return
        }
        const routerTool = ['router_query', 'router_assign_task'].some(name => title.includes(name))
        current.approvalRequests.push({ title, allowed: routerTool })
        current.errors.push({ code: routerTool ? 'router_tool_approval_allowed' : 'unexpected_tool_approval_rejected', title })
        if (id) void runner!.respondResult(id, { outcome: { outcome: 'selected', optionId: routerTool ? 'allow_once' : 'reject_once' } })
      }
    })
    runner.on('done', (result: any) => {
      if (!current) return
      current.turnResult = result
      finish?.({ status: result.failed ? 'failed' : result.interrupted ? 'cancelled' : 'completed', ...result })
    })
    nativeSession = sessionId
    report.actualModel = { provider: 'deepseek-official', model, effort }
    report.model = { model, effort, transport: 'deepseek-official-host', isolation: 'temporary Host HOME; production Host runner; only router MCP servers; official Host tools.restrict filter; isolated Router DB and fixture journal' }
    report.freeModel = { provider: 'deepseek-official', model, effort, source: process.env.UA_ROUTER_EVAL_USER_DATA || appData }
    const probe = await runner.probeSession()
    nativeSession = probe.nativeSessionId
    let toolCatalog: any
    try { toolCatalog = JSON.parse(await readFile(join(home, 'uniagent-context', 'eval-tool-catalog.json'), 'utf8')) }
    catch { throw new Error('eval_tool_catalog_unavailable: the Host did not expose a verified tool catalog') }
    report.toolCatalog = toolCatalog
    const visible = Array.isArray(toolCatalog.visible) ? toolCatalog.visible : []
    const unexpectedPreTurn = visible.filter((name: string) => !['router_query', 'router_assign_task', 'mcp__uniagent-router__router_query', 'mcp__uniagent-router__router_assign_task'].includes(name))
    if (unexpectedPreTurn.length) throw new Error('eval_tool_isolation_failed: ' + JSON.stringify(unexpectedPreTurn))
    const bindingFiles = (await readdir(join(home, 'uniagent-context'))).filter(name => name.endsWith('.json') && !name.startsWith('eval-') && name !== 'patch.json')
    const binding = JSON.parse(await readFile(join(home, 'uniagent-context', bindingFiles[0]), 'utf8'))
    if (typeof binding.systemPrompt !== 'string' || !binding.systemPrompt.startsWith(prompts.systemPrompt) || binding.systemPrompt.split(prompts.systemPrompt).length - 1 !== 1) throw new Error('eval_system_prompt_not_applied')
    report.systemPrompt = { source: 'ROUTER_SYSTEM_PROMPT', sha256: createHash('sha256').update(binding.systemPrompt).digest('hex'), currentRuleCount: binding.systemPrompt.split(prompts.systemPrompt).length - 1, appliedBy: 'Host systemPrompt section' }
    report.preTurnToolCatalog = { restrictable: toolCatalog.restrictable || [], visible }
    report.isolationEvidence = { routerMcpServersOnly: true, nativeToolsDenied: toolCatalog.restrictable || [], visibleTools: visible,
      approvalPolicy: 'auto-allow only router_query/router_assign_task; reject other permissions; interrupt questions',
      businessDispatch: 'routerFixture newTask/acceptRoutedInput are in-memory stubs; assignments counted only in fixture journal',
      isolatedDatabase: f.directory }
    toolFollow = client.stream<any>('session/follow', { request: { address: { kind: 'session', sessionId: probe.nativeSessionId }, maxMessages: 1, assistantStream: true } })
    void (async () => {
      try {
        for await (const frame of toolFollow!) {
          if (frame.type !== 'event' || frame.event?.type !== 'request/header') continue
          const header = frame.event.data?.header
          report.requestHeader = { config: header?.config, tools: (header?.tools || []).map((tool: any) => tool.name) }
        }
      } catch (error) { if (!(error instanceof Error) || !/aborted|cancelled|closed/.test(error.message)) report.errors.push('request_header_stream:' + String(error)) }
    })()
  }
  await save()
  let selected = cases.filter(row => (row.feedback || row.syntheticExpectation) && (!process.env.UA_ROUTER_EVAL_FILTER || new RegExp(process.env.UA_ROUTER_EVAL_FILTER).test(row.id)))
  // Analyze negative feedback first outside the model replay. A fixed Session
  // must receive historical inputs chronologically so later queries cannot leak
  // into an earlier request's native history.
  if (!systemCases) selected = chronologicalReviewCases(selected)
  report.order = systemCases ? 'frozen-synthetic-order' : 'chronological'
  report.rounds = rounds
  report.roundNotice = rounds > 1 ? '同一免费模型、同一固定 Router Session 连续接收同一历史材料；每轮内部仍按历史时间顺序。' : undefined
  if (process.env.UA_ROUTER_EVAL_REVERSE === '1') selected.reverse()
  const attempts = Array.from({ length: rounds }, (_, round) => selected.map(row => ({ row, round }))).flat()
  for (const { row, round } of attempts) {
    current = { id: row.id, round, originalDecision: row.request.decision, expected: row.syntheticExpectation || reviewExpectation(row.feedback), events: [], toolCalls: [], agentMessages: [], approvalRequests: [], errors: [], gaps: row.gaps,
      ...(row.id.startsWith('9f753fca') ? { legacyContractDifference: '旧标签按项目直属任务；新规则默认新建需求，保留原标签单列' } : {}),
      candidateHash: createHash('sha256').update(JSON.stringify(row.objects)).digest('hex') }
    report.cases.push(current)
    if (!row.objects.length || !row.trace && !row.syntheticExpectation) { current.skipped = 'historical_context_unavailable'; await save(); continue }
    now = row.trace?.startedAt || row.request.createdAt
    await f.db.index([])
    objects.splice(0, objects.length, ...row.objects)
    for (const [id, session] of f.sessions) if (!session.config.managedPurpose) f.sessions.delete(id)
    for (const object of objects.filter(row => row.kind === 'task')) f.sessions.set(object.id, { id: object.id, title: object.title, status: object.busy ? 'running' : 'idle', createdAt: now,
      archived: object.archived, readOnly: object.readOnly, nativeSessionId: object.nativeSessionId,
      config: { agentId: object.agentId || 'codex', projectId: object.projectId, requirementId: object.requirementId, workdir: f.directory } })
    // Keep clocks and source metadata local to this historical attempt. No current
    // production object, feedback correction or new fixture task enters the catalog.
    const turn = new Promise<any>(resolve => { finish = resolve })
    const started = Date.now()
    const requestId = await f.submit({ prompt: row.request.prompt, attachments: row.request.attachments, scope: row.request.scope, execution: row.request.execution })
    if (!live) {
      for (const query of row.queries.filter(query => query.arguments.requestId === row.id && !['bootstrap','resolve_reference','memories'].includes(query.arguments.mode) && !query.arguments.cursor)) {
        const { cursor: _cursor, scanId: _scan, ...args } = query.arguments
        await f.call('router_query', { ...args, requestId })
      }
      current.receipt = await f.call('router_assign_task', { ...row.request.decision, requestId, version: f.db.request(requestId)!.version })
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { current.turn = await Promise.race([turn, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('native_turn_timeout')), 300000) })]) }
      catch (error) {
        current.runtimeFailure = error instanceof Error ? error.message : String(error)
        runner?.interrupt()
        current.turn = await Promise.race([turn, new Promise(resolve => setTimeout(() => resolve({ status: 'failed', error: 'native_turn_timeout' }), 15000))])
      }
      finally { clearTimeout(timer) }
    }
    if (live && !report.requestHeader) {
      for (let i = 0; i < 50 && !report.requestHeader; i++) await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (live && !report.toolHeaderVerified) {
      const tools = report.requestHeader?.tools
      if (!Array.isArray(tools) || tools.length === 0) throw new Error('eval_tool_catalog_unverified: no request header tools')
      const unexpected = tools.filter((name: string) => !['router_query', 'router_assign_task', 'mcp__uniagent-router__router_query', 'mcp__uniagent-router__router_assign_task'].includes(name))
      if (unexpected.length) throw new Error('eval_tool_isolation_failed: ' + JSON.stringify(unexpected))
      const canonical = tools.map((name: string) => name.replace(/^mcp__uniagent-router__/, ''))
      if (!canonical.includes('router_query') || !canonical.includes('router_assign_task')) throw new Error('eval_router_tools_missing: ' + JSON.stringify(tools))
      const headerConfig = report.requestHeader?.config || {}
      if (headerConfig.provider !== 'deepseek-official' || headerConfig.model !== model || headerConfig.reasoningEffort !== effort) {
        throw new Error('eval_model_route_mismatch: ' + JSON.stringify(headerConfig))
      }
      report.toolCatalog = { source: 'request/header', visible: tools, canonical }
      report.toolHeaderVerified = true
      report.isolationEvidence = { ...report.isolationEvidence, visibleTools: canonical, source: 'request/header', modelRoute: headerConfig }
    }
    const actual = f.db.request(requestId)!
    current.decision = actual.decision
    current.state = actual.state
    current.delivery = actual.delivery
    current.judgment = live && (!actual.decision || current.turn?.status !== 'completed') ? 'unscored' : row.syntheticExpectation ?
      Object.entries(row.syntheticExpectation).every(([key, value]) => actual.decision?.[key as keyof RouterDecision] === value) ? 'matched' : 'mismatched' : judgeReview(row.feedback, actual.decision, objects)
    if (live && (!actual.decision || current.turn?.status !== 'completed')) current.runtimeFailure ||= 'native_turn_without_completed_assignment'
    current.assignments = f.journal.filter(entry => entry.requestId === requestId)
    current.durationMs = Date.now() - started
    console.log(JSON.stringify({ id: row.id.slice(0, 8), judgment: current.judgment, action: actual.decision?.action, target: actual.decision?.taskId || actual.decision?.requirementId || actual.decision?.projectId, durationMs: current.durationMs }))
    if (actual.state === 'needs_input') await f.controller.cancel(requestId, actual.version)
    await f.end()
    current.steps = (await f.controller.reviewDetail(requestId, undefined, true)).trace?.steps
    await save()
  }
} catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
finally {
  // Dispose the owner and close the Host before touching the infinite
  // session/follow generator: its pending next() only settles when the
  // underlying session stream is closed.
  await runner?.disposeAndWait().catch(() => undefined)
  await Promise.race([host?.stop().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5000))])
  const follow = toolFollow
  toolFollow = undefined
  if (follow) await Promise.race([follow.return(undefined).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))])
  if (nativeRoot) await rm(nativeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  await f.close()
  report.nativeSession = nativeSession
  report.completedAt = new Date().toISOString()
  report.summary = { total: cases.length, negative: cases.filter(row => row.feedback?.matches === false).length, positive: cases.filter(row => row.feedback?.matches === true).length,
    synthetic: cases.filter(row => row.syntheticExpectation).length,
    unrated: cases.filter(row => !row.feedback).length, attempted: report.cases.length, matched: report.cases.filter((row: any) => row.judgment === 'matched').length,
    mismatched: report.cases.filter((row: any) => row.judgment === 'mismatched').length, runtimeFailures: report.cases.filter((row: any) => row.runtimeFailure).length,
    skipped: report.cases.filter((row: any) => row.skipped).length, rounds, attempts: report.cases.length,
    rated: report.cases.filter((row: any) => ['matched','mismatched'].includes(row.judgment)).length,
    accuracyOnRated: (() => { const rated = report.cases.filter((row: any) => ['matched','mismatched'].includes(row.judgment)).length; return rated ? report.cases.filter((row: any) => row.judgment === 'matched').length / rated : null })(),
    unratedExcluded: report.cases.filter((row: any) => row.judgment === 'unscored').length,
    isolatedAssignments: f.journal.length, realBusinessDeliveries: 0, toolCatalogVerified: report.toolHeaderVerified === true }
  if (live && (report.summary.mismatched || report.summary.runtimeFailures)) process.exitCode = 1
  await save()
  console.log(JSON.stringify({ summary: report.summary, errors: report.errors }))
}
