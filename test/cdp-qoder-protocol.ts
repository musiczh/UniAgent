// Opt-in live protocol acceptance. Uses an official shared CN CLI and fixture-owned native state.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { Options } from '@qoder-ai/qoder-agent-sdk'
import { QoderSdkClient, qoderLaunch } from '../src/main/qoderSdk.ts'
import { QoderRunner, qoderReviewInput } from '../src/main/qoderRunner.ts'
import { writeForkTarget } from '../src/main/forkContext.ts'

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'uniagent-qoder-protocol-')))
const home = join(fixture, 'home'), cwd = join(fixture, 'workspace'), extra = join(fixture, 'extra')
const evidence = resolve(process.env.UNIAGENT_QODER_EVIDENCE_DIR || 'docs/qoder-integration-2026-11-09/verification')
const cli = await realpath(process.env.UNIAGENT_QODER_REAL_BIN || join(homedir(), '.local/bin/qoderclicn'))
const cliVersion = (await promisify(execFile)(cli, ['--version'], { timeout: 10000 })).stdout.trim()
const env = { ...process.env, HOME: home, USERPROFILE: home, QODERCN_CONFIG_DIR: join(home, '.qoder-cn') }
const testModel = process.env.UNIAGENT_QODER_TEST_MODEL || 'qfmodel'
const remainingOnly = process.env.UNIAGENT_QODER_VERIFY_REMAINING === '1'
const previousChecks: any[] = []
let previousHistory: any[] = []
if (remainingOnly) for (const file of ['protocol-initial-pass.json', 'protocol-results.json', 'protocol-remaining-results.json']) {
  try {
    const report = JSON.parse(await readFile(join(evidence, file), 'utf8'))
    previousChecks.push(...report.checks, ...(report.previousPassed || []).map(id => ({ id, passed: true })))
    if (file === 'protocol-remaining-results.json') previousHistory = report.history || [{ checks: report.checks }]
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const previousPassed = new Set(previousChecks.filter(check => check.passed).map(check => check.id))
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|PASSWORD/.test(key)) delete env[key]
const clients = new Set<QoderSdkClient>(), checks: any[] = []
let closed = false
let elicitationCount = 0
async function cleanup() { if (closed) return; closed = true; await Promise.all([...clients].map(client => client.close())); await rm(fixture, { recursive: true, force: true }) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)) })
async function check(id: string, test: () => Promise<unknown>) {
  if (remainingOnly && previousPassed.has(id)) return
  try { const detail = await test(); checks.push({ id, passed: true, detail }); console.log('✓ ' + id) }
  catch (error) { checks.push({ id, passed: false, error: String(error) }); console.error('✗ ' + id + ': ' + String(error)); process.exitCode = 1 }
}
async function open(resume?: string, review = false, mcpServers?: Options['mcpServers']) {
  const config = { agentId: 'qoder', workdir: cwd, model: testModel, effort: 'low' as const, permissionMode: 'ask' as const }
  const client = new QoderSdkClient(qoderLaunch(cli, config, 'When asked for a role marker, reply ROLE_CN_OK.', mcpServers, resume, env, review))
  clients.add(client)
  client.on('approval', request => {
    if (request.kind === 'elicitation') elicitationCount++
    client.respond(request.requestId, request.kind === 'elicitation' ? { action: 'accept', content: { answer: 'fixture' } }
      : { behavior: 'allow', updatedInput: request.toolName === 'AskUserQuestion' ? { ...request.input,
        answers: Object.fromEntries((request.input.questions || []).map(question => [question.question, question.options?.[0]?.label || 'A'])) } : request.input })
  })
  await client.ready
  return client
}
async function turn(client: QoderSdkClient, content: string, attachments?: any[]): Promise<any[]> {
  const rows: any[] = []
  return new Promise((done, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); client.off('message', message); client.off('failure', failed); error ? reject(error) : done(rows) }
    const message = (value: any) => { rows.push(value); if (value.type === 'result') finish(value.is_error ? new Error((value.errors || []).join('; ') || 'native turn failed') : undefined) }
    const failed = (error: Error) => finish(error)
    const timer = setTimeout(() => finish(new Error('native turn timed out')), 150000)
    client.on('message', message); client.on('failure', failed)
    void client.request('send', { uuid: randomUUID(), content, attachments, waitForReplay: true }).catch(failed)
  })
}
const text = (rows: any[]) => rows.filter(row => row.type === 'assistant').flatMap(row => row.message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')

function backgroundAgentLaunch(rows: any[], subagentType: string) {
  const call = rows.filter(row => row.type === 'assistant' && !row.parent_tool_use_id).flatMap(row => row.message?.content || [])
    .find(block => block.type === 'tool_use' && block.name === 'Agent' && block.input?.subagent_type === subagentType && block.input?.run_in_background === true)
  assert.ok(call?.id, 'the requested native background Agent must actually be invoked')
  const receipt = rows.find(row => row.type === 'user' && row.message?.content?.some?.(block => block.type === 'tool_result' && block.tool_use_id === call.id))?.tool_use_result
  assert.equal(receipt?.isAsync, true)
  assert.equal(receipt?.status, 'async_launched')
  assert.ok(typeof receipt?.agentId === 'string' && receipt.agentId)
  assert.ok(typeof receipt?.outputFile === 'string' && receipt.outputFile)
  return { call, receipt }
}

async function waitForNativeRow(client: QoderSdkClient, rows: any[], matches: (row: any) => boolean): Promise<any> {
  const existing = rows.find(matches)
  if (existing) return existing
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, row?: any) => {
      clearTimeout(timer); client.off('message', message); client.off('failure', failed)
      error ? reject(error) : resolve(row)
    }
    const message = (row: any) => { if (matches(row)) finish(undefined, row) }
    const failed = (error: Error) => finish(error)
    const timer = setTimeout(() => finish(new Error('native background task notification timed out')), 150000)
    client.on('message', message); client.on('failure', failed)
  })
}

function projectedNativeAgent(rows: any[], nativeHistoryId: string, status: string) {
  const runner = new QoderRunner('native-child-projection', { n: 0 })
  const agents: any[] = []
  runner.on('event', event => { if (event.type === 'subagent') agents.push(...event.payload.agents) })
  for (const row of rows) runner.acceptMessage(row)
  const agent = agents.filter(agent => agent.nativeHistoryId === nativeHistoryId).at(-1)
  assert.ok(agent, 'the real native child must be exposed by QoderRunner with its history identity')
  assert.equal(agent.status, status)
  return agent
}

try {
  for (const path of [cwd, extra, join(home, '.qoder-cn/skills/native-proof'), join(home, '.agents/skills/shared-proof'), join(home, '.qoder-cn/agents'), evidence]) await mkdir(path, { recursive: true, mode: 0o700 })
  await cp(join(homedir(), '.qoder-cn/.auth'), join(home, '.qoder-cn/.auth'), { recursive: true })
  const git = async (...args: string[]) => (await promisify(execFile)('git', ['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test', ...args], { cwd, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim()
  await git('init', '-b', 'main')
  await writeFile(join(cwd, 'review.txt'), 'base\n'); await git('add', 'review.txt'); await git('commit', '-m', 'base'); await git('branch', 'base')
  await writeFile(join(cwd, 'review.txt'), 'committed\n'); await git('add', 'review.txt'); await git('commit', '-m', 'change')
  const commit = await git('rev-parse', 'HEAD')
  await writeFile(join(cwd, 'review.txt'), 'uncommitted\n')
  for (const [folder, name] of [[join(home, '.qoder-cn/skills/native-proof'), 'native-proof'], [join(home, '.agents/skills/shared-proof'), 'shared-proof']]) {
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: local fixture\n---\nReply SKILL_CN_OK without tools.`)
  }
  await writeFile(join(home, '.qoder-cn/agents/reader.md'), '---\nname: fixture-reader\ndescription: local reader fixture\ntools: Read, Glob, Grep\n---\nOnly read files and return CHILD_CN_OK.')
  const hook = join(fixture, 'hook.cjs'), hookMarker = join(fixture, 'hook-proof')
  await writeFile(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(hookMarker)},'HOOK_CN_OK')`, { mode: 0o700 })
  const hookCommand = [process.execPath, hook].map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ')
  const server = join(fixture, 'mcp.cjs')
  await writeFile(server, `const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let toolCall;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.id===undefined)return;
if(v.id==='form-fixture'){send({jsonrpc:'2.0',id:toolCall,result:{content:[{type:'text',text:v.result?.action==='accept'&&v.result.content?.answer==='fixture'?'MCP_ELICIT_OK':'MCP_ELICIT_FAILED '+JSON.stringify(v.result||v.error)}]}});return;}
let result={};if(v.method==='initialize')result={protocolVersion:v.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
if(v.method==='tools/list')result={tools:[{name:'proof',description:'return MCP_CN_OK',inputSchema:{type:'object',properties:{}}},{name:'form_elicit',description:'ask a local fixture form and return its response',inputSchema:{type:'object',properties:{}}}]};
if(v.method==='tools/call'&&v.params.name==='form_elicit'){toolCall=v.id;send({jsonrpc:'2.0',id:'form-fixture',method:'elicitation/create',params:{mode:'form',message:'Local fixture only',requestedSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}}});return;}
if(v.method==='tools/call')result={content:[{type:'text',text:'MCP_CN_OK'}]};
send({jsonrpc:'2.0',id:v.id,result});})`)
  await writeFile(join(home, '.qoder-cn/settings.json'), JSON.stringify({ skills: { loadFromAgentsDirectory: true },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand }] }] }, mcpServers: { fixture: { command: process.execPath, args: [server] } } }), { mode: 0o600 })
  const client = await open()
  const init = await client.ready
  assert.ok((await client.request('models')).some(model => model.value === testModel && model.isEnabled !== false), '指定测试模型未在 CN CLI 目录中开放，停止验收，避免静默使用 Auto')
  await client.request('setModel', testModel)
  await check('Q09.fixture-byok-lifecycle', async () => {
    const provider = 'uniagent-local-fixture'
    const validations: Array<{ model?: string; stream?: boolean; includeUsage?: boolean }> = []
    const upstream = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const input = raw ? JSON.parse(raw) : {}
      if (!request.url?.endsWith('/models')) validations.push({ model: input.model, stream: input.stream, includeUsage: input.stream_options?.include_usage })
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      if (input.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const value of [
          { id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'BYOK_CN_OK' }, finish_reason: null }] },
          { id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }
        ]) response.write('data: ' + JSON.stringify(value) + '\n\n')
        response.end('data: [DONE]\n\n')
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(request.url?.endsWith('/models') ? { object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }
        : { id: 'fixture', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'BYOK_CN_OK' }, finish_reason: 'stop' }], usage }))
    })
    await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
    const port = (upstream.address() as any).port
    try {
      const value = { providerId: provider, displayName: 'Local fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-local-only', protocol: 'openai', models: [{ model: 'fixture-model' }] }
      const checked = await client.request('byok.check', value)
      assert.equal(checked.success, true, checked.error)
      assert.ok(validations.length > 0, 'the native CLI must validate the configured model against the local endpoint')
      assert.ok(validations.every(request => request.model === 'fixture-model'), 'validation preserves the requested model')
      assert.ok(validations.some(request => request.stream === true && request.includeUsage === true), 'native validation must consume the completed usage-bearing SSE response')
      await client.request('byok.create', value)
      assert.ok((await client.request('byok.list')).some(row => row.providerId === provider))
      await client.request('byok.update', { providerId: provider, displayName: 'Updated fixture' })
      assert.equal((await client.request('byok.list')).find(row => row.providerId === provider)?.displayName, 'Updated fixture')
    } finally { await client.request('byok.delete', { providerId: provider }).catch(() => {}); await new Promise<void>(done => upstream.close(() => done())) }
    assert.equal((await client.request('byok.list')).some(row => row.providerId === provider), false)
  })
  await check('Q36.local-plugin-lifecycle', async () => {
    const plugin = join(fixture, 'plugin'); await mkdir(join(plugin, '.qoder-plugin'), { recursive: true }); await mkdir(join(plugin, 'skills/proof'), { recursive: true })
    await writeFile(join(plugin, '.qoder-plugin/plugin.json'), '{"name":"uniagent-proof","version":"1.0.0"}')
    await writeFile(join(plugin, 'skills/proof/SKILL.md'), '---\nname: proof\ndescription: fixture\n---\nRead only.')
    const installed = await client.request('plugins.install', { source: plugin, scope: 'user' })
    const id = installed.pluginId
    assert.ok((await client.request('plugins.list')).some(row => row.id === id && row.enabled))
    await client.request('plugins.disable', { id, scope: 'user' }); assert.equal((await client.request('plugins.list')).find(row => row.id === id).enabled, false)
    await client.request('plugins.enable', { id, scope: 'user' }); assert.equal((await client.request('plugins.list')).find(row => row.id === id).enabled, true)
    await client.request('plugins.uninstall', { id, scope: 'user' }); assert.equal((await client.request('plugins.list')).some(row => row.id === id), false)
  })
  await check('Q34.skills-and-agents', async () => { assert.ok(init.skills.some(skill => skill.name === 'native-proof')); assert.ok(init.agents.some(agent => agent.name === 'fixture-reader')); return { sharedDiscovered: init.skills.some(skill => skill.name === 'shared-proof') } })
  await check('Q34.resource-reload', async () => {
    await mkdir(join(home, '.qoder-cn/skills/reloaded-proof'), { recursive: true })
    await writeFile(join(home, '.qoder-cn/skills/reloaded-proof/SKILL.md'), '---\nname: reloaded-proof\ndescription: fixture reload\n---\nReply RELOADED_CN_OK.')
    await client.request('reloadPlugins')
    const reloaded = await client.request('reloadSkills')
    assert.ok(reloaded.skills.some(skill => skill.name === 'reloaded-proof'))
  })
  await check('Q38.external-mcp', async () => { const status = await client.request('mcp'); assert.ok(status.mcpServers.some(server => server.name === 'fixture' && server.status === 'connected')); return status.mcpServers.map(server => ({ name: server.name, status: server.status })) })
  for (const transport of ['http', 'sse'] as const) await check(`Q38.${transport}-and-header-auth`, async () => {
    let stream: import('node:http').ServerResponse | undefined
    const methods: string[] = [], headers: boolean[] = []
    const local = createServer(async (request, response) => {
      headers.push(request.headers['x-fixture'] === 'local-only')
      if (!headers.at(-1)) { response.writeHead(401); response.end(); return }
      if (request.method === 'GET' && request.url === '/sse') {
        stream = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('event: endpoint\ndata: /messages\n\n'); return
      }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
      const value = JSON.parse(Buffer.concat(chunks).toString())
      methods.push(value.method)
      if (value.id === undefined) { response.writeHead(202); response.end(); return }
      const result = value.method === 'initialize' ? { protocolVersion: value.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-' + transport, version: '1' } }
        : value.method === 'tools/list' ? { tools: [{ name: 'proof', description: 'Local transport fixture', inputSchema: { type: 'object' } }] } : {}
      const reply = JSON.stringify({ jsonrpc: '2.0', id: value.id, result })
      if (transport === 'sse') { response.writeHead(202); response.end(); stream?.write('event: message\ndata: ' + reply + '\n\n') }
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(reply) }
    })
    await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve))
    let transportClient: QoderSdkClient | undefined
    try {
      transportClient = await open(undefined, false, { transport: { type: transport, url: `http://127.0.0.1:${(local.address() as any).port}/${transport === 'sse' ? 'sse' : 'mcp'}`, headers: { 'X-Fixture': 'local-only' } } })
      const status = (await transportClient.request('mcp')).mcpServers.find(server => server.name === 'transport')
      assert.equal(status?.status, 'connected')
      assert.ok(methods.includes('initialize') && methods.includes('tools/list') && headers.every(Boolean))
      return { status: status.status, methods, authenticatedRequests: headers.length }
    } finally { await transportClient?.close(); local.closeAllConnections(); await new Promise<void>(resolve => local.close(() => resolve())) }
  })
  await check('Q08.model-and-effort', async () => { await client.request('setModel', testModel) })
  await check('Q20.additional-directory', async () => { await client.request('addDirectories', [extra]) })
  await check('Q32.plan-control', async () => { await client.request('setPlanMode', true); const plan = await client.request('getPlanMode'); assert.equal(plan.active, true); await client.request('setPlanMode', false) })
  let nativeId: string | undefined
  let completedRoleReplyText: string | undefined
  await check('Q11.Q16.Q38.role-question-mcp', async () => {
    const rows = await turn(client, 'Call fixture MCP proof tool. Then use AskUserQuestion with one question and options A and B. After the answer, report the MCP result and role marker. Do not write files or use Bash.')
    nativeId = rows.find(row => row.type === 'system' && row.subtype === 'init')?.session_id || rows.find(row => row.session_id)?.session_id
    assert.match(text(rows), /MCP_CN_OK/); assert.match(text(rows), /ROLE_CN_OK/)
    assert.ok(rows.some(row => row.message?.content?.some?.(block => block.type === 'tool_use' && block.name === 'AskUserQuestion')))
    completedRoleReplyText = rows.find(row => row.type === 'result')?.result
    assert.equal(typeof completedRoleReplyText, 'string')
    assert.ok(completedRoleReplyText)
    return { nativeId }
  })
  await check('Q16.external-mcp-elicitation', async () => {
    const elicitationClient = await open(undefined, false, { fixture: { command: process.execPath, args: [server] } })
    try {
      const rows = await turn(elicitationClient, 'Call fixture MCP form_elicit and report its exact result. Do not call proof or any other tools.')
      assert.match(text(rows), /MCP_ELICIT_OK/, `onElicitation callbacks: ${elicitationCount}; response=${text(rows)}`)
      assert.ok(elicitationCount > 0)
      const result = rows.find(row => row.type === 'result')
      return { callbacks: elicitationCount, initialModel: rows.find(row => row.type === 'system' && row.subtype === 'init')?.model,
        modelCredits: Object.fromEntries(Object.entries(result?.modelUsage || {}).map(([name, usage]: [string, any]) => [name, usage.credits])) }
    } finally { await elicitationClient.close() }
  })
  await check('Q16.worker-scoped-elicitation', async () => {
    const scoped = await open()
    try {
      const before = elicitationCount
      const rows = await turn(scoped, 'Call fixture MCP form_elicit and report its exact result. Do not call any other tools.')
      assert.match(text(rows), /MCP_ELICIT_OK/)
      assert.ok(elicitationCount > before)
      const result = rows.find(row => row.type === 'result')
      assert.ok(result?.modelUsage?.[testModel]?.credits > 0, 'the requested model must account for the real inference')
      return { callbacks: elicitationCount - before, initialModel: rows.find(row => row.type === 'system' && row.subtype === 'init')?.model,
        modelCredits: Object.fromEntries(Object.entries(result?.modelUsage || {}).map(([name, usage]: [string, any]) => [name, usage.credits])) }
    } finally { await scoped.close(); clients.delete(scoped) }
  })
  await check('Q35.native-hooks', async () => { assert.equal(await readFile(hookMarker, 'utf8'), 'HOOK_CN_OK') })
  const image = join(fixture, 'red.png')
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'))
  await check('Q19.image-and-file-input', async () => { const rows = await turn(client, 'Confirm that an image attachment is present. Reply IMAGE_CN_OK. Do not use tools.', [{ kind: 'image', path: image }, { kind: 'file', path: hook }]); assert.match(text(rows), /IMAGE_CN_OK/) })
  await check('Q29.subagent-history', async () => {
    const rows = await turn(client, 'Use the Agent tool with fixture-reader to read the workspace and return CHILD_CN_OK. Then report its result. Do not perform the subagent task yourself.')
    const call = rows.filter(row => row.type === 'assistant' && !row.parent_tool_use_id).flatMap(row => row.message?.content || [])
      .find(block => block.type === 'tool_use' && block.name === 'Agent' && block.input?.subagent_type === 'fixture-reader')
    assert.ok(call?.id, 'the foreground child must come from the requested native Agent invocation')
    const nativeHistoryId = rows.find(row => row.type === 'user' && row.tool_use_result?.agentId && row.message?.content?.some?.(block => block.type === 'tool_result' && block.tool_use_id === call.id))?.tool_use_result.agentId
    assert.ok(nativeHistoryId, 'tool result must provide the actual child history identity')
    const history = await client.request('subagentHistory', { sessionId: nativeId, agentId: nativeHistoryId })
    assert.ok(history.length > 0)
    assert.match(text(history), /CHILD_CN_OK/)
    const projected = projectedNativeAgent(rows, nativeHistoryId, 'completed')
    assert.equal(projected.dispatchId, call.id)
    return { childToolUseId: call.id, nativeHistoryId, projectedTaskId: projected.agentThreadId }
  })
  await check('Q29.subagent-cancellation', async () => {
    let agentId: string | undefined, cancellation: Promise<unknown> | undefined
    const observed: any[] = []
    const projection = new QoderRunner('native-cancel-projection', { n: 0 })
    const projectedAgents: any[] = []
    projection.on('event', event => { if (event.type === 'subagent') projectedAgents.push(...event.payload.agents) })
    ;(projection as any).sdk = client
    const cancel = (row: any) => {
      observed.push(row)
      projection.acceptMessage(row)
      const receipt = row.type === 'user' && row.tool_use_result
      if (receipt?.isAsync === true && receipt.status === 'async_launched' && typeof receipt.agentId === 'string' && !agentId) {
        agentId = receipt.agentId
        cancellation = Promise.resolve().then(() => {
          const projected = projectedAgents.filter(agent => agent.nativeHistoryId === agentId).at(-1)
          assert.ok(projected, 'the actual Runner card must provide the native child cancellation identity')
          return projection.control('stopTask', projected.agentThreadId)
        })
        void cancellation.catch(() => {})
      }
    }
    client.on('message', cancel)
    try {
      const rows = await turn(client, 'Start a general-purpose Agent with run_in_background=true to use Bash to sleep 30 seconds, then return CANCEL_CHILD_END. Wait for that background agent. Do not sleep in the parent.')
      const { call, receipt } = backgroundAgentLaunch(rows, 'general-purpose')
      assert.equal(agentId, receipt.agentId); await cancellation
      const notification = await waitForNativeRow(client, observed, row => row.type === 'system' && row.subtype === 'task_notification' && row.output_file === receipt.outputFile)
      assert.equal(notification.status, 'stopped')
      const sessionId = rows.find(row => row.session_id)?.session_id
      const history = await client.request('subagentHistory', { sessionId, agentId: receipt.agentId })
      assert.match(JSON.stringify(history), /\[Request interrupted by user\]/)
      assert.doesNotMatch(text(history), /CANCEL_CHILD_END/)
      const projected = projectedNativeAgent(observed, receipt.agentId, 'interrupted')
      assert.equal(projected.dispatchId, call.id)
      return { childToolUseId: call.id, nativeHistoryId: receipt.agentId, projectedTaskId: projected.agentThreadId, taskId: notification.task_id, status: notification.status }
    } finally { client.off('message', cancel) }
  })
  await check('Q12.role-tools-apply-to-subagents', async () => {
    const launch = qoderLaunch(cli, { agentId: 'qoder', workdir: cwd, model: testModel, effort: 'low', permissionMode: 'full-access',
      roleSnapshot: { id: 'restricted', name: 'Restricted', agentId: 'qoder', instructions: '', toolPolicy: { mode: 'allow-only', tools: ['Agent', 'Read'] } } }, '', {}, undefined, env)
    const restricted = new QoderSdkClient(launch); clients.add(restricted)
    restricted.on('approval', request => restricted.respond(request.requestId, { behavior: 'allow', updatedInput: request.input }))
    await restricted.ready
    const observed: any[] = []
    const observe = (row: any) => observed.push(row)
    restricted.on('message', observe)
    try {
      const rows = await turn(restricted, 'Use a general-purpose Agent with run_in_background=true to try Write to create role-forbidden.txt with ROLE_WRITE_FORBIDDEN, then report whether the write was allowed. Wait for that background agent. Do not perform the write in the parent.')
      const { call, receipt } = backgroundAgentLaunch(rows, 'general-purpose')
      const notification = await waitForNativeRow(restricted, observed, row => row.type === 'system' && row.subtype === 'task_notification' && row.output_file === receipt.outputFile)
      assert.equal(notification.status, 'completed', 'the real restricted child must finish before checking its write result')
      const sessionId = rows.find(row => row.session_id)?.session_id
      const history = await restricted.request('subagentHistory', { sessionId, agentId: receipt.agentId })
      assert.ok(text(history).trim(), 'the real restricted child must provide a final response')
      await assert.rejects(readFile(join(cwd, 'role-forbidden.txt')))
      const projected = projectedNativeAgent(observed, receipt.agentId, 'completed')
      assert.equal(projected.dispatchId, call.id)
      return { childToolUseId: call.id, nativeHistoryId: receipt.agentId, projectedTaskId: projected.agentThreadId, taskId: notification.task_id, status: notification.status }
    } finally { restricted.off('message', observe); await restricted.close(); clients.delete(restricted) }
  })
  await check('Q24.Q26.history-forks', async () => {
    assert.ok(nativeId)
    const history = await client.request('history', { sessionId: nativeId })
    assert.ok(history.length > 1)
    const user = history.find(row => row.type === 'user' && typeof row.message?.content === 'string')
    assert.ok(user?.uuid)
    const completed = history.find(row => row.type === 'assistant' && text([row]) === completedRoleReplyText)
    assert.ok(completed?.uuid, 'use the persisted entry of the actually completed source reply')
    const whole = await client.request('forkSession', { sessionId: nativeId })
    const point = await client.request('forkSession', { sessionId: nativeId, messageId: completed.uuid })
    assert.ok(whole.sessionId !== nativeId && point.sessionId !== whole.sessionId)
    const prefix = await client.request('history', { sessionId: point.sessionId })
    assert.equal(prefix.at(-1)?.type, 'assistant', 'cold continuation retains a completed history point')
    assert.equal(text([prefix.at(-1)]), completedRoleReplyText)
    const resumed = await open(point.sessionId)
    assert.match(text(await turn(resumed, 'Reply FORK_CN_OK without tools.')), /FORK_CN_OK/)
    await resumed.close(); clients.delete(resumed)
  })
  await check('Q27.cross-agent-transcript-import', async () => {
    const archive = join(fixture, 'archive'); await mkdir(archive)
    await writeFile(join(archive, 'context.json'), JSON.stringify({ messages: [{ role: 'user', content: 'Remember MIGRATED_CN_492.' }, { role: 'assistant', content: 'I remember MIGRATED_CN_492.' }] }))
    const id = randomUUID(); await writeForkTarget({ home, agentId: 'qoder', nativeId: id, archive, cwd, model: testModel })
    const imported = await open(id)
    assert.match(text(await turn(imported, 'What exact marker did I ask you to remember? No tools.')), /MIGRATED_CN_492/)
    await imported.close(); clients.delete(imported)
  })
  await check('Q21.manual-compaction', async () => { const rows = await turn(client, '/compact'); assert.ok(rows.some(row => row.type === 'system' && row.subtype === 'compact_boundary')) })
  await check('Q30.Q31.goal-lifecycle-and-rounds', async () => {
    await client.request('setGoalMaxTurns', 1)
    const snapshot = await client.request('setGoal', { objective: 'Wait for user confirmation without using tools.', status: 'paused' })
    assert.equal(snapshot.status, 'paused'); assert.equal(snapshot.max_turns, 1)
    const resumed = await client.request('resumeGoal'); assert.ok(resumed)
    await client.request('setGoal', { status: 'paused' }); await client.request('interrupt')
    const completed = await client.request('setGoal', { status: 'complete' }); assert.equal(completed.status, 'complete')
    assert.equal(await client.request('clearGoal'), true)
    assert.equal(await client.request('getGoal'), null)
  })
  await check('Q33.review-tools-restricted', async () => {
    const reviewed = await open(nativeId, true)
    const input = await qoderReviewInput({ scope: { type: 'custom' }, instructions: 'Try to use Write to create forbidden.txt, then report whether writes are permitted.' }, cwd)
    await turn(reviewed, input)
    await assert.rejects(readFile(join(cwd, 'forbidden.txt')))
    for (const scope of [{ type: 'uncommittedChanges' }, { type: 'baseBranch', branch: 'base' }, { type: 'commit', sha: commit }] as const) {
      const rows = await turn(reviewed, await qoderReviewInput({ scope }, cwd))
      assert.ok(text(rows).trim(), 'each review scope produces a report')
      assert.equal(await readFile(join(cwd, 'review.txt'), 'utf8'), 'uncommitted\n')
    }
    await reviewed.close(); clients.delete(reviewed)
  })
} finally {
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, remainingOnly ? 'protocol-remaining-results.json' : 'protocol-results.json'), JSON.stringify({ region: 'cn', model: testModel, scope: remainingOnly ? 'remaining' : 'full', previousPassed: [...previousPassed], cliVersion, sdkVersion: '1.0.59', checks, passed: checks.length > 0 && checks.every(item => item.passed),
    ...(remainingOnly ? { history: [...previousHistory, { recordedAt: new Date().toISOString(), checks }] } : {}) }, null, 2))
  await cleanup()
}
