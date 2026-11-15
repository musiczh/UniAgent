import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { DeepSeekHostService } from '../src/main/deepseekHostService'
import { prepareDeepSeekHostContext, registerDeepSeekHostContext, bindDeepSeekHostContext } from '../src/main/deepseekHostContext'
import { decryptLocalSecret } from '../src/main/localSecretStore'
import { generateDeepSeekTitle } from '../src/main/taskTitleDeepSeek'
import { taskTitleImageBlocks } from '../src/main/taskTitleImages'
import { RequirementRoutingService } from '../src/main/requirementRouting'
import type { RequirementRoutingView } from '../src/shared/requirementTypes'
import { sanitizeRouterReview } from '../src/shared/routerReview'
import { DEFAULT_ROUTER_CONFIG, ROUTER_SYSTEM_PROMPT } from '../src/shared/router'
import { routerMcpServers } from '../src/main/router/mcp'
import { developmentCases, developmentObjects, type DevelopmentRouteCase } from '../test/fixtures/router-development'
import { routerFixture } from '../test/fixtures/router-quality'
import type { Attachment } from '../src/shared/types'

// Explicit live evaluator. The normal regression catalog only runs offline tests.
const exportRoot = process.env.UA_ROUTER_REVIEW_EXPORT || join(homedir(), 'Library/Application Support/uniagent/router/review-exports/33ff97f9-e673-4398-ad33-3405d879ab87')
const output = resolve(process.env.UA_ROUTER_EVAL_OUTPUT || 'docs/router-quality-evaluation.json')
const report: any = { schemaVersion: 1, mode: 'real-harness-production-router-isolated-business', startedAt: new Date().toISOString(), prompt: ROUTER_SYSTEM_PROMPT,
  sourceExport: exportRoot, fixtureNotice: '原输入与用户标签来自导出；候选需求与任务为明确标注的开发重建夹具，非历史完整上下文回放。', cases: [], events: [], errors: [] }
const save = () => writeFile(output, JSON.stringify(sanitizeRouterReview(report), null, 2))
const sourceFiles = ['src/shared/router.ts','src/shared/requirementTypes.ts','src/main/router/controller.ts','src/main/router/database.ts','src/main/router/mcp.ts','src/main/router/context.ts','src/main/router/errors.ts','src/main/router/store.ts','src/main/router/worker.ts','src/main/requirementRouting.ts','src/main/requirementSpace.ts','src/main/requirementStore.ts','src/main/taskTitleDeepSeek.ts','test/fixtures/router-development.ts','test/fixtures/router-quality.ts']
report.sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
const directory = await mkdtemp(join(tmpdir(), 'ua-router-live-quality-')), home = join(directory, 'host')
const userData = join(homedir(), 'Library/Application Support/uniagent'), native = join(userData, 'deepseek')
const pointer = JSON.parse(await readFile(join(native, 'active-runtime.json'), 'utf8')), connection = JSON.parse(await readFile(join(native, 'connection.json'), 'utf8'))
if (!/^installed-[a-f0-9-]+$/.test(pointer.directory) || connection.baseUrl !== 'https://api.deepseek.com/anthropic') throw new Error('official_owned_runtime_required')
process.env.UNIAGENT_USER_DATA = userData
const patch = await prepareDeepSeekHostContext(home), runtime = join(native, pointer.directory)
let nodeBin: string | undefined
try { nodeBin = join(native, JSON.parse(await readFile(join(native, 'node-runtime.json'), 'utf8')).directory, 'bin') } catch (error) { if ((error as any).code !== 'ENOENT') throw error }
const host = new DeepSeekHostService({ bin: join(runtime, 'node_modules/.bin/dsh'), home, cwd: directory, patchFile: patch, nodeBin,
  modelEnvironment: { DEEPSEEK_API_KEY: decryptLocalSecret(connection.encryptedKey), DEEPSEEK_BASE_URL: connection.baseUrl } })
let client: Awaited<ReturnType<typeof host.start>>, follow: any, consume: Promise<void> | undefined, nativeId: string | undefined, turns = 0, currentCase = '', streamError: unknown
const f = await routerFixture(developmentObjects(Date.now()), { send: async (id, prompt, attachments) => {
  if (!nativeId) {
    nativeId = id
    await client.call('session/create', { request: { sessionId: id, cwd: directory } })
    await bindDeepSeekHostContext(client, id, id, directory)
    follow = client.stream('session/follow', { request: { address: { kind: 'session', sessionId: id }, maxMessages: 1, assistantStream: true } })
    if ((await follow.next()).value?.type !== 'snapshot') throw Error('missing_follow_snapshot')
    consume = (async () => {
      for await (const frame of follow) if (frame.type === 'event') {
        const event = frame.event
        if (['tool/call','tool/result','assistant/message','turn/end'].includes(event.type)) { report.events.push({ caseId: currentCase, event }); await save() }
        if (event.type === 'turn/end') { turns++; report.lastTurn = event.data.reason; await f.end(event.data.reason?.kind === 'completed' ? 'success' : 'failed'); await save() }
      }
    })().catch(error => { streamError = error })
  }
  const selected: any = await client.call('session/selectModel', { request: { sessionId: id, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } })
  if (selected.selected?.provider !== 'deepseek-official' || selected.selected?.model !== 'deepseek-flash' || selected.selected?.reasoningEffort !== 'max') throw Error('model_selection_changed')
  report.selected = selected.selected
  const images = await taskTitleImageBlocks((attachments || []).filter(item => item.kind === 'image'), AbortSignal.timeout(30000))
  const content = [{ type: 'text', text: prompt }, ...images.map(({ mimeType, ...image }) => ({ ...image, mediaType: mimeType }))]
  const receipt: any = await client.call('session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue', content } })
  if (!receipt.accepted) throw Error('prompt_not_accepted')
} })
try {
  client = await host.start()
  report.harnessVersion = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
  registerDeepSeekHostContext(client, home, id => routerMcpServers(id) || [])
  const index = JSON.parse(await readFile(join(exportRoot, 'index.json'), 'utf8')), historical: Array<DevelopmentRouteCase & { attachments?: Attachment[] }> = [], unrated: typeof historical = []
  for (const entry of index.records) {
    const record = JSON.parse(await readFile(join(exportRoot, entry.record), 'utf8')), feedback = record.feedbacks.at(-1)
    if (!feedback) { unrated.push({ id: 'U-' + entry.requestId.slice(0, 8), name: record.request.prompt.slice(0, 60), input: record.request.prompt, attachments: record.request.attachments, scope: record.request.scope, expected: {} as DevelopmentRouteCase['expected'], origin: 'unrated-protocol-only' }); continue }
    const expected = feedback.matches ? record.request.decision : feedback.expected
    if (!expected) continue
    const goal = feedback.matches ? { action: expected.action, ...(expected.taskId ? { taskId: expected.taskId } : expected.requirementId ? { requirementId: expected.requirementId } : { projectId: expected.projectId }) }
      : { action: expected.kind === 'reuse_task' ? 'reuse_task' : expected.requirementId ? 'create_task_in_requirement' : 'create_task_in_space', ...(expected.taskId ? { taskId: expected.taskId } : expected.requirementId ? { requirementId: expected.requirementId } : { projectId: expected.projectId }) }
    historical.push({ id: entry.requestId.slice(0, 8), name: record.request.prompt.slice(0, 60), input: record.request.prompt, attachments: record.request.attachments,
      scope: record.request.scope, expected: goal, origin: feedback.matches ? 'user-accepted-input-reconstructed-candidates' : 'user-corrected-input-reconstructed-candidates' })
  }
  const orders = process.env.UA_ROUTER_EVAL_ORDERS === '1' ? [historical] : [historical.slice().reverse(), historical, historical.filter((_, i) => i % 2).concat(historical.filter((_, i) => i % 2 === 0))]
  const cases = [...orders.flatMap((order, index) => order.map(item => ({ ...item, id: 'H' + (index + 1) + '-' + item.id }))), ...developmentCases(), ...unrated]
    .filter(item => !process.env.UA_ROUTER_EVAL_FILTER || new RegExp(process.env.UA_ROUTER_EVAL_FILTER).test(item.id))
  if (!cases.length && process.env.UA_ROUTER_EVAL_PROJECTION_ONLY !== '1') throw Error('no_evaluation_cases_selected')
  report.phase = 'routing'
  report.selectedCases = process.env.UA_ROUTER_EVAL_PROJECTION_ONLY === '1' ? [] : cases.map(item => item.id)
  await save()
  for (const item of process.env.UA_ROUTER_EVAL_PROJECTION_ONLY === '1' ? [] : cases) {
    currentCase = item.id
    const before = turns, start = Date.now(), requestId = await f.submit({ prompt: item.input, attachments: 'attachments' in item ? item.attachments : [], scope: item.scope })
    const deadline = Date.now() + 360000
    while ((turns === before || f.db.request(requestId)?.state === 'routing') && !streamError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    if (streamError) throw streamError
    if (turns === before) throw Error('turn_timeout:' + item.id)
    const actual = f.db.request(requestId)!, detail = await f.controller.reviewDetail(requestId, undefined, true)
    const assignments = f.journal.filter(row => row.requestId === requestId)
    const judged = item.origin !== 'unrated-protocol-only'
    const passed = report.lastTurn?.kind === 'completed' && actual.context?.protocolVersion === 2 && ['bound','needs_input'].includes(actual.state) && assignments.length === (actual.state === 'needs_input' ? 0 : 1) && actual.decision && (!judged || actual.state === (item.expected.action === 'clarify' ? 'needs_input' : 'bound') && Object.entries(item.expected).every(([key, value]) => actual.decision![key as keyof typeof actual.decision] === value))
    report.cases.push({ id: item.id, name: item.name, origin: item.origin, input: item.input, scope: item.scope, expected: item.expected, decision: actual.decision, state: actual.state, delivery: actual.delivery,
      semanticJudged: judged, passed: !!passed, durationMs: Date.now() - start, steps: detail.trace?.steps, fixtureAssignments: assignments })
    await save(); console.log(JSON.stringify({ case: item.id, passed: !!passed, action: actual.decision?.action, target: actual.decision?.taskId || actual.decision?.requirementId || actual.decision?.projectId, durationMs: Date.now() - start }))
  }
  const text = 'Router 与自动归属属于本需求后续分项，尚未实现；设计确认不代表用户已验收。', document = { id: 'core', kind: 'core' as const, title: '已确认范围', content: text, contentHash: 'fixture-core', status: 'active' as const, freshness: 'verified' as const, summary: '', sources: [], dependencies: [], updatedAt: 1 }
  report.phase = 'projection'
  let projected: RequirementRoutingView | undefined
  const projector = new RequirementRoutingService({ enabled: () => true, busy: () => false, sources: async () => ({ revision: 'projection-source', documents: [document] }),
    chunks: text => f.db.routingChunks(text), save: async (_, view) => { projected = view; report.projection = view; await save() }, changed() {}, error: error => report.errors.push(String(error)),
    generate: async (prompt, signal) => {
      const output = await generateDeepSeekTitle(DEFAULT_ROUTER_CONFIG, prompt, signal, async () => client, (input, output) => { report.projectionUsage = { input, output } }, [], { maxOutputChars: 20000, maxTokens: 16384 })
      report.projectionCalls = [...report.projectionCalls || [], { prompt, output }]; await save(); return output
    } })
  try {
    if (process.env.UA_ROUTER_EVAL_SKIP_PROJECTION !== '1') {
      projector.schedule('projection-requirement', { status: 'missing', sourceRevision: 'projection-source' }); await projector.next()
      if (!projected?.features.some(feature => [feature.name,...feature.aliases].some(name => name.includes('Router')) && ['planned','unknown'].includes(feature.implementation.status) && feature.acceptance.status !== 'accepted' && feature.ownershipRefs.some(ref => ref.quote.includes('属于本需求')))) throw Error('projection_semantic_mismatch')
      report.projection = projected
      report.projectionValidated = true
    } else report.projectionSkipped = true
  } finally { await projector.close() }
  report.summary = { total: report.cases.length, passed: report.cases.filter((item: any) => item.passed).length, failed: report.cases.filter((item: any) => !item.passed).map((item: any) => item.id),
    fixedSession: nativeId, fixtureAssignments: f.journal.length, realBusinessDeliveries: 0, projectionValidated: !!report.projectionValidated }
  if (report.summary.failed.length || !projected && !report.projectionSkipped) process.exitCode = 1
  console.log(JSON.stringify(report.summary))
} catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1; console.error('Router evaluation stopped:', report.errors.at(-1)) }
finally {
  await host.stop(); await consume?.catch(() => {}); await f.close(); report.hostStopped = true; report.completedAt = new Date().toISOString()
  report.summary = { ...report.summary, total: report.cases.length, selected: report.selectedCases?.length, passed: report.cases.filter((item: any) => item.passed).length, failed: report.cases.filter((item: any) => !item.passed).map((item: any) => item.id), fixedSession: nativeId, realBusinessDeliveries: 0, projectionValidated: !!report.projectionValidated }
  const current = await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))
  report.sourcesUnchanged = current.every(([file, hash]) => report.sources[file] === hash)
  await save()
}
