import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '../src/shared/types'
import { ZCodeRunner } from '../src/main/zcode/runner'
import { ZCodeRuntimePool } from '../src/main/zcode/runtimePool'
import { detectZCodeRuntime, zcodeRuntimeConfigPath } from '../src/main/zcode/runtime'
import { ZCodeConfigurationService, probeZCodeModels } from '../src/main/zcode/configuration'
import { ZCODE_MODEL_SERVICES } from '../src/shared/zcode'
import { writeZCodeJson } from '../src/main/zcode/store'
import { ZCodeRpcError } from '../src/main/zcode/connection'
import { zcodeAttachmentRefs } from '../src/main/zcode/attachments'

// Bounded production-runner probe: official runtime with a loopback model and fixture MCP only.
const root = await mkdtemp('/tmp/uzr-')
const previousUserData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = join(root, 'user-data')
const workspace = join(root, 'workspace')
const providerFile = join(root, 'provider.json')
const mcpFile = join(root, 'mcp.cjs')
const file = join(workspace, 'fixture.txt')
const selection = { providerId: 'personal:uniagent-fixture', modelId: 'uniagent-fixture', options: { reasoningLevel: 'disabled' } }
let requests = 0
const server = createServer(async (req, res) => {
  try {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('fixture request too large') }
    const input = JSON.parse(body)
    const messages = input.messages ?? []
    const last = messages.findLastIndex((item: any) => item.role === 'user')
    const prompt = JSON.stringify(messages[last]?.content ?? '')
    const name = prompt.includes('WRITE') ? 'Write' : prompt.includes('STOP') ? 'Bash' : 'echo_caller'
    const compact = prompt.includes('create a detailed summary of the conversation so far')
    const tool = compact ? undefined : input.tools?.find((item: any) => name === 'echo_caller' ? item.function?.name.endsWith('__echo_caller') : item.function?.name === name)
    const toolResult = messages.slice(last + 1).find((item: any) => item.role === 'tool')
    const args = name === 'Write' ? { file_path: file, content: 'APPROVED\n' } : name === 'Bash' ? { command: '/bin/sleep 30', description: 'Fixture stop' } : {}
    const delta = tool && !toolResult ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${++requests}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: compact ? '<analysis>fixture</analysis><summary>COMPACT_FIXTURE_SUMMARY</summary>' : 'RUNNER_OK ' + (toolResult?.content ?? 'NO_TOOL') }
    const common = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model }
    if (input.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'COMPACT_FIXTURE_SUMMARY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool && !toolResult ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch { res.writeHead(500); res.end('{"error":{"message":"fixture failure"}}') }
})
let pool = new ZCodeRuntimePool()
const runners: ZCodeRunner[] = []
let rejectPersist = false
function timeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const result = Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('runner fixture timeout')), 15_000) })]).finally(() => clearTimeout(timer))
  void result.catch(() => undefined)
  return result
}
try {
  await mkdir(workspace)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await writeFile(providerFile, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: selection.providerId,
    providerName: 'Local fixture', enabled: true, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'LOCAL_FIXTURE_ONLY' },
      api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1` }, personalModelIds: [selection.modelId, 'uniagent-fixture-two'] } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: selection } }), { mode: 0o600 })
  await writeFile(mcpFile, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'echo_caller',description:'Return fixture identity',inputSchema:{type:'object',properties:{}}}]};
else if(m.method==='tools/call')result={content:[{type:'text',text:process.env.UNIAGENT_CALLER_SESSION}]};else result={};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`, { mode: 0o600 })
  if (!process.env.ZCODE_TEST_RUNTIME_CONFIG) throw new Error('Set ZCODE_TEST_RUNTIME_CONFIG to the installed runtime.json path')
  const prepared = JSON.parse(await readFile(process.env.ZCODE_TEST_RUNTIME_CONFIG, 'utf8'))
  writeZCodeJson(zcodeRuntimeConfigPath(), { ...prepared, personalProviderConfigPath: providerFile, dataRootId: 'model-list-fixture' })
  for (const definition of ZCODE_MODEL_SERVICES) {
    const configuration = new ZCodeConfigurationService((service, key) => probeZCodeModels(service, key,
      async () => Response.json({ data: [{ id: 'glm-5.3-flash' }, { id: 'embedding-fixture' }] })))
    assert.equal((await configuration.check({ service: definition.id, apiKey: 'LOCAL_FIXTURE_ONLY' }, async () => {})).phase, 'ready')
    const configured = await detectZCodeRuntime(JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8')))
    assert.deepEqual(configured.models.map(model => model.label), ['GLM-5.3-Flash'])
    const configuredPool = new ZCodeRuntimePool()
    const session: Session = { id: `LIST_${definition.id}`, title: 'Model list fixture', status: 'draft', createdAt: 1,
      config: { agentId: 'zcode', workdir: workspace, permissionMode: 'ask', collaborationMode: 'default' } }
    const runner = new ZCodeRunner({ session, runtime: configured, pool: configuredPool, clientId: 'list-fixture',
      nextSeq: () => 1, persist: () => {}, mcpServers: () => [] })
    try {
      const contract = await timeout(runner.ensureSession())
      assert.deepEqual(contract.models.map(model => model.label), ['GLM-5.3-Flash'], 'native engine also excludes unavailable template models and other services')
      assert.ok(contract.models[0].thinkingOptions?.length)
    } finally { try { await runner.dispose() } finally { await configuredPool.close() } }
  }
  console.log('Model-list configuration: all four services accepted by the official engine; no inference request')
  const runtime = await detectZCodeRuntime({ ...prepared, personalProviderConfigPath: providerFile, dataRootId: 'fixture-data' })
  const closingPool = new ZCodeRuntimePool()
  const lateLease = closingPool.acquire(runtime, workspace)
  await closingPool.close()
  await assert.rejects(lateLease, /closed/)
  assert.equal(closingPool.hasActiveLeases, false)
  const sessions: Session[] = ['FIXTURE_A', 'FIXTURE_B'].map(id => ({ id, title: id, status: 'draft', createdAt: 1,
    config: { agentId: 'zcode', workdir: workspace, permissionMode: 'full-access', collaborationMode: 'default' } }))
  const make = (session: Session) => {
    let sequence = 0
    const runner = new ZCodeRunner({ session, runtime, pool, clientId: 'fixture-client', nextSeq: () => ++sequence,
      persist: () => { assert.ok(session.zcodeState); if (rejectPersist) throw new Error('fixture storage failure') }, mcpServers: () => [{ name: 'fixture', command: runtime.config.executable, args: [mcpFile],
        env: [{ name: 'UNIAGENT_CALLER_SESSION', value: session.id }], isolation: 'session', protocolVersion: 'legacy' }] })
    runners.push(runner)
    return runner
  }
  for (const session of sessions) {
    const runner = make(session)
    assert.equal((await timeout(runner.ensureSession())).models.find(model => model.zcodeSelection?.modelId === selection.modelId)?.zcodeSelection?.providerId, selection.providerId)
    if (session.id === 'FIXTURE_A') {
      const ledger = session.zcodeState!.deliveries
      const seed = { text: 'failed attempt', modelSelection: selection, mode: 'yolo' as const, planEnabled: false }
      const { zcodePayloadHash } = await import('../src/main/zcode/store')
      ledger.push(...Array.from({ length: 1024 }, (_, index) => ({ queueItemId: 'failed-retry', commandId: 'failed-' + index,
        nativeSessionId: session.nativeSessionId, phase: 'failed' as const, issuedAt: 1, submission: seed, payloadHash: zcodePayloadHash(seed) })))
      runner.prepare('bounded-ledger', 'must not run')
      assert.equal(session.zcodeState!.deliveries.length, 101)
      session.zcodeState!.deliveries = []
      rejectPersist = true
      assert.throws(() => runner.prepare('storage-failed', 'must not run'), /storage failure/)
      assert.equal(session.zcodeState!.deliveries.length, 0)
      rejectPersist = false
      const prepared = runner.prepare('prepared-storage-failed', 'Call echo_caller and return its result')
      const callsBefore = requests
      rejectPersist = true
      await assert.rejects(runner.submit(prepared), /storage failure/)
      assert.equal(prepared.phase, 'prepared'); assert.equal(requests, callsBefore); assert.equal(runner.isRunning(), false)
      rejectPersist = false
      const resumed = timeout(once(runner, 'done'))
      await runner.submit(prepared); await resumed
    }
    const done = timeout(once(runner, 'done'))
    const receipt = runner.prepare('queue-' + session.id, 'Call echo_caller and return its result')
    await runner.submit(receipt)
    assert.equal((await done)[0].delivery, 'observed')
    assert.equal(receipt.phase, 'observed')
    assert.ok(runner.snapshot?.rows.window.some(row => row.kind === 'assistantText' && row.text.includes(session.id)))
  }
  assert.notEqual(sessions[0].nativeSessionId, sessions[1].nativeSessionId)
  const firstRunner = runners[0]
  const first = sessions[0]
  await assert.rejects(pool.acquire({ ...runtime, fingerprint: 'new-runtime-while-old-active' }, workspace), /旧引擎会话/)
  const { zcodeModelKey } = await import('../src/main/zcode/catalog')
  const secondSelection = { providerId: selection.providerId, modelId: 'uniagent-fixture-two', options: { reasoningLevel: 'enabled' } }
  const changed = await firstRunner.updateConfig({ ...first.config, model: zcodeModelKey(secondSelection), zcodeModelSelection: secondSelection })
  assert.equal(changed.currentModelId, zcodeModelKey(secondSelection))
  assert.equal(firstRunner.snapshot?.config.thought, 'enabled')
  assert.equal(first.config.model, changed.currentModelId)
  assert.deepEqual(first.config.zcodeModelSelection, secondSelection)
  await assert.rejects(firstRunner.updateConfig({ ...first.config, effort: 'ultra' }), /不支持/)
  const modelConnection = (firstRunner as any).lease.connection
  const modelRequest = modelConnection.request.bind(modelConnection)
  const missingCalls: string[] = []
  modelConnection.request = (method: string, params: any, ...rest: any[]) => {
    missingCalls.push(method)
    return method === 'v4/command' && params.type === 'switchModelConfig'
      ? Promise.reject(new ZCodeRpcError(-32601, 'fixture: method not found')) : modelRequest(method, params, ...rest)
  }
  try {
    await assert.rejects(firstRunner.updateConfig({ ...first.config, model: zcodeModelKey(selection), zcodeModelSelection: selection }), /缺少原生模型切换接口/)
    assert.deepEqual(first.config.zcodeModelSelection, secondSelection)
    assert.ok(!missingCalls.some(method => method === 'session/setModel' || method === 'session/setThoughtLevel'))
  } finally { modelConnection.request = modelRequest }
  const attachmentPath = join(root, 'input.txt')
  await writeFile(attachmentPath, 'fixture attached input')
  const switchedTurn = timeout(once(firstRunner, 'done'))
  const switchedReceipt = firstRunner.prepare('switched', 'Call echo_caller after switching',
    await zcodeAttachmentRefs([{ kind: 'file', path: attachmentPath, name: 'input.txt' }]))
  assert.equal(switchedReceipt.submission.modelSelection.modelId, secondSelection.modelId)
  assert.equal(switchedReceipt.submission.attachments?.[0].fileName, 'input.txt')
  await firstRunner.submit(switchedReceipt); await switchedTurn
  const forkedNativeId = await firstRunner.forkNative()
  assert.notEqual(forkedNativeId, first.nativeSessionId)
  const child: Session = { id: 'FIXTURE_FORK', title: 'Fork fixture', status: 'idle', createdAt: 1, config: structuredClone(first.config), nativeSessionId: forkedNativeId,
    zcodeState: { schemaVersion: 1, dataRootId: first.zcodeState!.dataRootId, workspaceKey: first.zcodeState!.workspaceKey, runtimeFingerprint: first.zcodeState!.runtimeFingerprint, deliveries: [] } }
  const childRunner = make(child)
  await timeout(childRunner.ensureSession())
  const childDone = timeout(once(childRunner, 'done'))
  await childRunner.submit(childRunner.prepare('fork-followup', 'Call echo_caller after forking'))
  await childDone
  assert.ok(childRunner.snapshot?.rows.window.some(row => row.kind === 'assistantText' && row.text.includes(child.id)), 'fork rebinds MCP to the child caller')
  await childRunner.dispose()
  const compactDone = timeout(once(firstRunner, 'done'))
  const compactReceipt = firstRunner.prepare('compact-fixture', '/compact')
  const compactAck = await firstRunner.submit(compactReceipt)
  const compactResult = await compactDone
  assert.equal(compactReceipt.phase, 'observed', JSON.stringify({ ack: compactAck, done: compactResult, control: firstRunner.snapshot?.control,
    rows: firstRunner.snapshot?.rows.window.slice(-3).map(row => ({ kind: row.kind, state: row.state, error: row.error, text: row.text?.slice(0, 120) })) }))
  const savedWindow = firstRunner.snapshot!.rows.window
  firstRunner.snapshot!.rows.window = savedWindow.slice(-1)
  const olderReceipt = sessions[0].zcodeState!.deliveries[0]
  olderReceipt.phase = 'acknowledged'
  sessions[0].pendingQueue = [{ id: olderReceipt.queueItemId, prompt: olderReceipt.submission.text,
    acceptedAt: olderReceipt.issuedAt, state: 'pending', deliveryUncertain: true }]
  const callsBeforeHistoryReconciliation = requests
  await (firstRunner as any).reconcileDeliveries()
  assert.equal(olderReceipt.phase, 'observed'); assert.ok(olderReceipt.turnId)
  assert.equal(requests, callsBeforeHistoryReconciliation)
  firstRunner.snapshot!.rows.window = savedWindow
  delete sessions[0].pendingQueue
  await Promise.all(runners.map(runner => runner.dispose())); await pool.close()
  runtime.fingerprint = 'upgraded-compatible-runtime'
  pool = new ZCodeRuntimePool()
  for (const session of sessions) {
    const runner = make(session)
    await timeout(runner.ensureSession())
    assert.equal(session.zcodeState!.runtimeFingerprint, runtime.fingerprint)
    const done = timeout(once(runner, 'done'))
    await runner.submit(runner.prepare('cold-' + session.id, 'Call echo_caller and return its result'))
    assert.equal((await done)[0].failed, false)
    assert.ok(runner.snapshot?.rows.window.some(row => row.kind === 'assistantText' && row.text.includes(session.id)))
  }
  const runner = runners[runners.length - 1]
  const unavailableReceipt = runner.prepare('query-unavailable', 'must not run')
  unavailableReceipt.phase = 'sent'
  sessions[1].pendingQueue = [{ id: unavailableReceipt.queueItemId, prompt: unavailableReceipt.submission.text,
    acceptedAt: unavailableReceipt.issuedAt, state: 'pending', deliveryUncertain: true }]
  const connection = (runner as any).lease.connection
  const nativeRequest = connection.request.bind(connection)
  connection.request = (method: string, params: any, ...rest: any[]) => method === 'v4/commands/query'
    ? Promise.resolve({ results: [{ key: params.commands[0], result: { commandId: unavailableReceipt.commandId,
      status: 'failed', reasonCode: 'fault.command.queryUnavailable', revisionAtDecision: 0 } }] })
    : nativeRequest(method, params, ...rest)
  await (runner as any).reconcileDeliveries()
  assert.equal(unavailableReceipt.phase, 'uncertain')
  assert.throws(() => runner.prepare('must-not-replay', 'must not run'))
  connection.request = nativeRequest
  sessions[1].zcodeState!.deliveries = sessions[1].zcodeState!.deliveries.filter(item => item !== unavailableReceipt)
  delete sessions[1].pendingQueue
  await runner.updateConfig({ ...sessions[1].config, permissionMode: 'ask' })
  sessions[1].config.permissionMode = 'ask'
  let respondFailure: unknown
  const resolutions: any[] = []
  runner.on('event', event => { if (event.type === 'approval_request' && event.state === 'success') resolutions.push(event) })
  const deny = (event: any) => {
    if (event.type === 'approval_request' && event.state === 'pending' && event.payload.method === 'zcode/permission') {
      void runner.respondResult(event.payload.interactionId, { optionId: event.payload.options.find((option: any) => option.kind === 'deny').optionId }).catch(error => { respondFailure = error })
    }
  }
  runner.on('event', deny)
  const denied = timeout(once(runner, 'done'))
  await runner.submit(runner.prepare('write-denied', 'WRITE the fixture file'))
  await denied
  runner.off('event', deny)
  assert.equal(respondFailure, undefined)
  await assert.rejects(access(file))
  const allow = (event: any) => {
    if (event.type === 'approval_request' && event.state === 'pending' && event.payload.method === 'zcode/permission') {
      void runner.respondResult(event.payload.interactionId, { optionId: event.payload.options.find((option: any) => option.kind === 'allowOnce').optionId }).catch(error => { respondFailure = error })
    }
  }
  runner.on('event', allow)
  const approved = timeout(once(runner, 'done'))
  await runner.submit(runner.prepare('write-approved', 'WRITE the fixture file'))
  await approved
  assert.equal(respondFailure, undefined)
  runner.off('event', allow)
  assert.equal(await readFile(file, 'utf8'), 'APPROVED\n')
  await runner.updateConfig({ ...sessions[1].config, permissionMode: 'full-access' })
  assert.equal(resolutions.length, 2)
  for (const event of resolutions) {
    assert.equal(event.payload.kind, 'fileChange')
    assert.equal(event.payload.method, 'zcode/permission')
    assert.deepEqual(event.payload.params.changes, [{ path: file }])
    assert.ok(event.payload.options.some((option: any) => option.optionId === event.payload.submittedAnswer.optionId))
  }
  sessions[1].config.permissionMode = 'full-access'
  const stopped = timeout(once(runner, 'done'))
  const stopOnTool = (event: any) => { if (event.type === 'tool_call' && event.payload.name === 'Bash' && event.state === 'running') void runner.interrupt() }
  runner.on('event', stopOnTool)
  await runner.submit(runner.prepare('stop', 'STOP fixture'))
  assert.equal((await stopped)[0].interrupted, true)
  assert.equal((await runner.loadEarlier()).hasMore, false)
  runner.off('event', stopOnTool)
  const sourceRequest = connection.request.bind(connection)
  let releaseConfig!: () => void
  let configReached!: () => void
  const configReady = new Promise<void>(resolve => { configReached = resolve })
  connection.request = async (method: string, params: any, ...rest: any[]) => {
    const result = await sourceRequest(method, params, ...rest)
    if (method === 'v4/command' && params.type === 'switchModelConfig') {
      configReached()
      await new Promise<void>(resolve => { releaseConfig = resolve })
    }
    return result
  }
  const closingSelection = { ...selection, options: { reasoningLevel: 'enabled' } }
  const configChange = runner.updateConfig({ ...sessions[1].config, model: zcodeModelKey(closingSelection), zcodeModelSelection: closingSelection })
  await timeout(Promise.race([configReady, configChange.then(() => { throw new Error('fixture expected a native model switch before closing') })]))
  const closing = runner.dispose()
  releaseConfig()
  await configChange; await closing
  connection.request = sourceRequest
  assert.deepEqual(sessions[1].config.zcodeModelSelection, closingSelection, 'confirmed settings survive closing during the ACK')
  const reopened = make(sessions[1])
  await reopened.ensureSession()
  assert.equal(reopened.snapshot?.config.thought, 'enabled')
  console.log(JSON.stringify({ result: 'zcode-runner-check-passed', cases: ['poolCloseDuringAcquire', 'boundedLedger', 'persistFailureNoSend', 'preparedSameIdRetry', 'twoSessionMcp', 'modelAndDepthSwitch', 'missingModelCommandRejected', 'fileAttachment', 'closeDuringConfigAck', 'oldEngineUpgradeGuard', 'compatibleRuntimeRestore', 'nativeForkMcpOwner', 'nativeCompact', 'olderReceiptReconciliation', 'queryUnavailableNoReplay', 'coldResumeMcp', 'denyWrite', 'approveWrite', 'resolvedApprovalCard', 'switchMode', 'stop', 'rowsRange'] }))
} finally {
  await Promise.allSettled(runners.map(runner => runner.dispose()))
  await pool.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
}
