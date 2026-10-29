import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '../src/shared/types'
import { detectZCodeRuntime } from '../src/main/zcode/runtime'

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
let modelCalls = 0
let featurePhase = 'existing conversation'
const requestShapes: unknown[] = []
const server = createServer(async (req, res) => {
  try {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('fixture request too large') }
    const input = JSON.parse(body)
    requestShapes.push({ stream: input.stream, keys: Object.keys(input), toolCount: input.tools?.length })
    const messages = input.messages ?? []
    const last = messages.findLastIndex((item: any) => item.role === 'user')
    const prompt = JSON.stringify(messages[last]?.content ?? '')
    modelCalls++
    if (prompt.includes('FAIL_ONCE_FIXTURE')) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid fixture API key"}}'); return
    }
    const name = prompt.includes('WRITE') ? 'Write' : prompt.includes('STOP') ? 'Bash' : 'uniagent_query'
    const tool = input.tools?.find((item: any) => name === 'uniagent_query' ? item.function?.name.endsWith('__uniagent_query') : item.function?.name === name)
    const toolResult = messages.slice(last + 1).find((item: any) => item.role === 'tool')
    const args = name === 'Write' ? { file_path: file, content: 'APPROVED\n' } : name === 'Bash' ? { command: '/bin/sleep 30', description: 'Fixture stop' } : { action: 'list', type: 'agent' }
    const delta = tool && !toolResult ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${++requests}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: input.tools?.length ? 'RUNNER_OK ' + (toolResult?.content ?? 'NO_TOOL') : JSON.stringify({ passed: true, reason: 'Fixture completed' }) }
    const common = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model }
    if (input.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: JSON.stringify({ passed: true, reason: 'Fixture completed' }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool && !toolResult ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch { res.writeHead(500); res.end('{"error":{"message":"fixture failure"}}') }
})

const { Orchestrator } = await import('../src/main/orchestrator')
const { SessionStore } = await import('../src/main/sessionStore')
const { writeZCodeJson } = await import('../src/main/zcode/store')
const { zcodeRuntimeConfigPath } = await import('../src/main/zcode/runtime')
const { ensureHandoffServer, writeHandoffCatalog } = await import('../src/main/handoff')
const { ZCODE_PERMISSION_MODES } = await import('../src/main/zcode/catalog')
const agent = { id: 'zcode', name: 'ZCode', adapter: 'zcode' as const, bin: 'zcode', icon: 'zcode', builtin: true, installed: true,
  capabilities: { streaming: true, protocol: 'zcode-protocol' as const, modelSelect: false, reasoningEffort: false,
    permissionModes: ZCODE_PERMISSION_MODES, imageAttachments: false, fileAttachments: true, sideChat: true, sessionFork: true,
    nativeGoal: true, collaborationModes: ['default', 'plan'] }, models: [] }
const store = new SessionStore(join(root, 'sessions.json'))
let orchestrator = new Orchestrator(id => id === 'zcode' ? agent : undefined, store, join(root, 'artifacts'))
const allEvents: any[] = []
function bind() { orchestrator.on('event', event => allEvents.push(event)) }
bind()
function terminal(sessionId?: string, acceptError = false): Promise<void> {
  let timer: ReturnType<typeof setTimeout>
  const result = new Promise<void>((resolve, reject) => {
    const listener = (change: any) => {
      if (sessionId && change.sessionId !== sessionId || !['idle', 'completed', 'error'].includes(change.status)) return
      clearTimeout(timer); orchestrator.off('statusChange', listener)
      if (change.status === 'error' && !acceptError) reject(new Error('orchestrator fixture failed: ' + JSON.stringify({ errors: allEvents.filter(e => e.type === 'error').map(e => e.payload),
        featurePhase, requestShapes: requestShapes.slice(-4), control: (orchestrator as any).zcodeRunners.get(change.sessionId)?.snapshot?.control,
        goal: (orchestrator as any).zcodeRunners.get(change.sessionId)?.snapshot?.goal,
        rows: (orchestrator as any).zcodeRunners.get(change.sessionId)?.snapshot?.rows.window.slice(-6).map((row: any) => ({ kind: row.kind, state: row.state, status: row.status, error: row.error, text: row.text?.slice(0, 120) })),
        warnings: allEvents.filter(e => e.type === 'system_notice' && e.payload.kind === 'warning').map(e => e.payload.text) })))
      else resolve()
    }
    orchestrator.on('statusChange', listener)
    timer = setTimeout(() => { orchestrator.off('statusChange', listener); reject(new Error('orchestrator fixture timeout')) }, 20000)
  })
  void result.catch(() => undefined)
  return result
}
try {
  await mkdir(workspace)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await writeFile(providerFile, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: selection.providerId,
    providerName: 'Local fixture', enabled: true, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'LOCAL_FIXTURE_ONLY' },
      api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1` }, personalModelIds: [selection.modelId] } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: selection } }), { mode: 0o600 })
  if (!process.env.ZCODE_TEST_RUNTIME_CONFIG) throw new Error('Set ZCODE_TEST_RUNTIME_CONFIG to the installed runtime.json path')
  const prepared = JSON.parse(await readFile(process.env.ZCODE_TEST_RUNTIME_CONFIG, 'utf8'))
  const runtime = await detectZCodeRuntime({ ...prepared, schemaVersion: 1, personalProviderConfigPath: providerFile, dataRootId: 'fixture-data' })
  writeZCodeJson(zcodeRuntimeConfigPath(), runtime.config)
  ensureHandoffServer(); writeHandoffCatalog([agent], [])
  const config = { agentId: 'zcode', workdir: workspace, permissionMode: 'full-access' as const, collaborationMode: 'default' as const }
  const done = terminal()
  const session = orchestrator.createSession(config, 'Call uniagent_query action=list type=agent and return the result')
  await orchestrator.sendMessage(session.id, 'Call uniagent_query action=list type=agent a second time')
  await done
  assert.equal(orchestrator.getQueue(session.id).length, 0)
  const events = await orchestrator.getEvents(session.id)
  assert.equal(events.filter(e => e.type === 'user_message').length, 2)
  assert.ok(events.some(e => e.type === 'agent_message' && e.payload.text.includes('zcode')))
  assert.ok(events.some(e => e.type === 'tool_call' && e.payload.result && e.payload.input))
  assert.ok(events.some(e => e.type === 'system_notice' && e.payload.kind === 'usage' && e.payload.usage.inputTokens > 0))
  assert.equal(session.zcodeState?.deliveries.length, 2)
  assert.ok(session.zcodeState?.deliveries.every(item => item.phase === 'observed'))
  assert.equal(orchestrator.listSessions().length, 1)
  // Simulate a crash after native completion but before durable queue removal.
  const receipt = session.zcodeState!.deliveries.at(-1)!
  session.pendingQueue = [{ id: receipt.queueItemId, prompt: receipt.submission.text, acceptedAt: receipt.issuedAt, state: 'dispatching', attempts: 1 }]
  store.saveOrThrow([session])
  orchestrator.disposeAll(); await orchestrator.closeZCodeRuntime()
  orchestrator = new Orchestrator(id => id === 'zcode' ? agent : undefined, store, join(root, 'artifacts')); bind(); orchestrator.loadPersisted()
  assert.equal(orchestrator.getQueue(session.id)[0].deliveryUncertain, true)
  const callsBeforeRestore = requests
  await orchestrator.getEvents(session.id)
  assert.equal(requests, callsBeforeRestore)
  assert.equal(orchestrator.getQueue(session.id).length, 0)
  const resumed = terminal(session.id)
  await orchestrator.sendMessage(session.id, 'Call uniagent_query action=list type=agent after cold resume')
  await resumed
  assert.equal(orchestrator.getQueue(session.id).length, 0)
  assert.equal((await orchestrator.getEvents(session.id)).filter(e => e.type === 'user_message').length, 3)
  const parentNativeId = session.nativeSessionId
  const parentCount = (await orchestrator.getEvents(session.id)).filter(e => e.type === 'user_message').length
  const sideTerminal = (): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { orchestrator.off('sideStatus', listener); reject(new Error('side fixture timeout')) }, 20000)
    const listener = (change: any) => { if (change.sessionId === session.id && change.status === 'idle') { clearTimeout(timer); orchestrator.off('sideStatus', listener); resolve() } }
    orchestrator.on('sideStatus', listener)
  })
  const sideDone = sideTerminal()
  featurePhase = 'side'
  await orchestrator.sendSideMessage(session.id, 'Call uniagent_query action=list type=agent from the side branch')
  await sideDone
  assert.ok(orchestrator.getSideEvents(session.id).some(event => event.type === 'agent_message' && event.payload.text.includes('zcode')),
    'side executes in the official native child')
  assert.equal(orchestrator.getSessionById(session.id)?.nativeSessionId, parentNativeId)
  assert.equal((await orchestrator.getEvents(session.id)).filter(e => e.type === 'user_message').length, parentCount, 'side input never enters the parent')
  const sideNativeId = (orchestrator as any).sideNativeSessionIds.get(session.id)
  const cachedSideMessages = orchestrator.getSideEvents(session.id).filter(event => event.type === 'agent_message').length
  orchestrator.disposeAll(); await orchestrator.closeZCodeRuntime()
  orchestrator = new Orchestrator(id => id === 'zcode' ? agent : undefined, store, join(root, 'artifacts')); bind(); orchestrator.loadPersisted()
  const coldSideDone = sideTerminal()
  await orchestrator.sendSideMessage(session.id, 'Call uniagent_query action=list type=agent after side cold restore')
  await coldSideDone
  assert.equal((orchestrator as any).sideNativeSessionIds.get(session.id), sideNativeId)
  assert.equal(orchestrator.getSideEvents(session.id).filter(event => event.type === 'agent_message').length, cachedSideMessages + 1, 'cold side restore must not duplicate old native replies')
  const fork = await orchestrator.forkSameSession('zcode', parentNativeId!)
  featurePhase = 'fork'
  assert.ok(fork?.nativeSessionId && fork.nativeSessionId !== parentNativeId)
  const forkDone = terminal(fork.id)
  await orchestrator.sendMessage(fork.id, 'Call uniagent_query action=list type=agent from the fork')
  await forkDone
  assert.equal(fork.zcodeState?.deliveries.at(-1)?.phase, 'observed')
  await assert.rejects(orchestrator.runNativeAction(session.id, { type: 'goal.set', objective: 'fixture', tokenBudget: 100 }), /Token/)
  const goalDone = terminal(session.id)
  featurePhase = 'goal'
  await orchestrator.runNativeAction(session.id, { type: 'goal.set', objective: 'Call uniagent_query action=list type=agent and finish the fixture' })
  await goalDone
  assert.equal(orchestrator.getSessionById(session.id)?.goal?.status, 'complete')
  featurePhase = 'goal.clear'
  await orchestrator.runNativeAction(session.id, { type: 'goal.clear' })
  assert.equal(orchestrator.getSessionById(session.id)?.goal, undefined)
  featurePhase = 'existing follow-up checks'
  await assert.rejects(orchestrator.updateSessionConfig(session.id, { agentId: 'codex' }))
  await assert.rejects(orchestrator.updateSessionConfig(session.id, { workdir: root }))
  await orchestrator.setCollaborationMode(session.id, 'plan')
  assert.equal(orchestrator.getSessionById(session.id)!.zcodeState!.pendingConfig?.planEnabled, true)
  const planned = terminal(session.id)
  await orchestrator.sendMessage(session.id, 'Call uniagent_query action=list type=agent with Plan enabled')
  await planned
  assert.equal(orchestrator.getSessionById(session.id)!.zcodeState!.deliveries.at(-1)!.submission.planEnabled, true)
  assert.equal((orchestrator as any).zcodeRunners.get(session.id).snapshot.config.planEnabled, true, 'the native runtime must apply Plan')
  assert.equal(orchestrator.getSessionById(session.id)!.zcodeState!.pendingConfig, undefined)
  await orchestrator.setCollaborationMode(session.id, 'default')
  const planCommand = terminal(session.id)
  await orchestrator.sendMessage(session.id, 'Call uniagent_query action=list type=agent through the Plan command', undefined, undefined, true)
  await planCommand
  assert.equal(orchestrator.getSessionById(session.id)!.zcodeState!.deliveries.at(-1)!.submission.planEnabled, true)
  await orchestrator.setCollaborationMode(session.id, 'default')
  await orchestrator.updateSessionConfig(session.id, { permissionMode: 'ask' })
  const approve = (e: any) => { if (e.type === 'approval_request' && e.state === 'pending' && e.payload.method === 'zcode/permission')
    void orchestrator.respondToRequest(session.id, e.payload.requestId, { optionId: e.payload.options.find((option: any) => option.kind === 'allowOnce').optionId }) }
  orchestrator.on('event', approve)
  const written = terminal(session.id)
  await orchestrator.sendMessage(session.id, 'WRITE fixture')
  await written
  assert.equal((orchestrator as any).zcodeRunners.get(session.id).snapshot.config.planEnabled, false, 'the native runtime must leave Plan before implementation')
  orchestrator.off('event', approve)
  assert.equal(await readFile(file, 'utf8'), 'APPROVED\n')
  const resolved = (await orchestrator.getEvents(session.id)).find(e => e.type === 'approval_request' && e.payload.resolved)
  assert.ok(resolved)
  assert.equal(resolved.payload.method, 'zcode/permission')
  assert.equal(resolved.payload.kind, 'fileChange')
  assert.deepEqual(resolved.payload.params.changes, [{ path: file }])
  const failed = terminal(undefined, true)
  const retrySession = orchestrator.createSession(config, 'FAIL_ONCE_FIXTURE')
  await failed
  const failedReceipt = retrySession.zcodeState!.deliveries.at(-1)!
  assert.equal(failedReceipt.phase, 'failed')
  const callsAfterFailure = modelCalls
  await orchestrator.sendMessage(retrySession.id, 'Call uniagent_query action=list type=agent after the failed input')
  assert.equal(modelCalls, callsAfterFailure); assert.equal(orchestrator.getQueue(retrySession.id).length, 2)
  orchestrator.resumePendingQueues()
  await (orchestrator as any).sendTails.get(retrySession.id)
  assert.equal(modelCalls, callsAfterFailure)
  orchestrator.setQueueEditing(retrySession.id, failedReceipt.queueItemId)
  orchestrator.editQueueItem(retrySession.id, failedReceipt.queueItemId, 'Call uniagent_query action=list type=agent on explicit retry')
  assert.equal(failedReceipt.retryRequested, true)
  const retried = terminal(retrySession.id)
  orchestrator.setQueueEditing(retrySession.id, null)
  await retried
  assert.equal(orchestrator.getQueue(retrySession.id).length, 0)
  const newReceipt = retrySession.zcodeState!.deliveries.findLast(item => item.queueItemId === failedReceipt.queueItemId)!
  assert.notEqual(newReceipt.commandId, failedReceipt.commandId); assert.equal(newReceipt.phase, 'observed')
  const disposingRunner = (orchestrator as any).zcodeRunners.get(retrySession.id)
  const disposingConnection = disposingRunner.lease.connection
  const originalRequest = disposingConnection.request.bind(disposingConnection)
  let resolveUnsubscribe!: () => void
  const unsubscribeGate = new Promise<void>(resolve => { resolveUnsubscribe = resolve })
  let unsubscribeStarted!: () => void
  const started = new Promise<void>(resolve => { unsubscribeStarted = resolve })
  disposingConnection.request = async (method: string, ...args: any[]) => {
    if (method === 'v4/conversation/unsubscribe') { unsubscribeStarted(); await unsubscribeGate }
    return originalRequest(method, ...args)
  }
  orchestrator.disposeSession(retrySession.id)
  await started
  const reopening = (orchestrator as any).ensureZCodeRunner(retrySession)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((orchestrator as any).zcodeRunners.has(retrySession.id), false)
  resolveUnsubscribe()
  const reopenedRunner = await reopening
  assert.notEqual(reopenedRunner, disposingRunner)
  assert.equal(reopenedRunner.lease.owners.get(retrySession.nativeSessionId), reopenedRunner.owner)
  disposingConnection.request = originalRequest
  const restoredSession = orchestrator.getSessionById(session.id)!
  const { zcodeCommandId } = await import('../src/main/zcode/protocol')
  const unknown = structuredClone(restoredSession.zcodeState!.deliveries.at(-1)!)
  unknown.commandId = zcodeCommandId(); unknown.queueItemId = 'fixture-unknown'; unknown.phase = 'sent'
  restoredSession.zcodeState!.deliveries.push(unknown)
  restoredSession.pendingQueue = [{ id: unknown.queueItemId, prompt: unknown.submission.text, acceptedAt: unknown.issuedAt, state: 'dispatching', attempts: 1 }]
  store.saveOrThrow([restoredSession]); orchestrator.disposeAll(); await orchestrator.closeZCodeRuntime()
  orchestrator = new Orchestrator(id => id === 'zcode' ? agent : undefined, store, join(root, 'artifacts')); bind(); orchestrator.loadPersisted()
  const callsBeforeUnknown = requests
  await orchestrator.getEvents(session.id)
  assert.equal(orchestrator.getSessionById(session.id)!.zcodeState!.deliveries.at(-1)!.phase, 'uncertain')
  assert.equal(orchestrator.getQueue(session.id)[0].deliveryUncertain, true)
  orchestrator.resumePendingQueues()
  assert.equal(requests, callsBeforeUnknown)
  const malformed = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8'))
  malformed[0].zcodeState.deliveries[0].payloadHash = '0'.repeat(64)
  await writeFile(join(root, 'malformed.json'), JSON.stringify(malformed), { mode: 0o600 })
  const preserved = new SessionStore(join(root, 'malformed.json')).load()
  assert.equal(preserved.length, 1); assert.equal(preserved[0].zcodeStateInvalid, true); assert.equal(preserved[0].status, 'error')
  assert.equal(preserved[0].pendingQueue![0].deliveryUncertain, true)
  console.log(JSON.stringify({ result: 'zcode-orchestrator-check-passed', cases: ['directDurableQueue', 'fifo', 'productionHandoff', 'coldObservedReconciliation', 'coldFollowup', 'sideIsolation', 'sideColdRestore', 'nativeFork', 'nativeGoalSetClear', 'goalBudgetRejected', 'immutableScope', 'plan', 'approval', 'toolAndUsage', 'failedRequiresExplicitRetry', 'disposeResumeOwner', 'unknownNoReplay', 'malformedLedgerPreserved'] }))
} finally {
  orchestrator.disposeAll(); await orchestrator.closeZCodeRuntime()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
}
