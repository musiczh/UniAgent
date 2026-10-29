import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { DeepSeekHostRunner } from '../src/main/deepseekHostRunner.ts'
import { DeepSeekHostClient, DeepSeekHostError } from '../src/main/deepseekHostClient.ts'
import type { AgentDef, UAEvent } from '../src/shared/types.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
class Feed {
  queue: any[] = []
  wake?: () => void
  push(value: any): void { this.queue.push(value); this.wake?.() }
  async *read(signal?: AbortSignal): AsyncGenerator<any> {
    const abort = () => this.wake?.()
    signal?.addEventListener('abort', abort)
    try {
      while (!signal?.aborted) {
        if (this.queue.length) { yield this.queue.shift(); continue }
        await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally { signal?.removeEventListener('abort', abort) }
  }
}
class Host {
  calls: Array<{ method: string; args: any }> = []
  follow = new Feed()
  events = new Feed()
  seq = 0
  promptError?: Error
  promptAccepted = true
  planSupported = true
  planMode = false
  rejectPlan = false
  permission = 'workspace-write'
  permissionOptions = ['workspace-write', 'danger-full-access', 'auto']
  ignorePermission = false
  nativeIds = new Set<string>()
  lifetime = new AbortController()
  followBaseline = true
  async call(method: string, args: any = {}): Promise<any> {
    this.calls.push({ method, args })
    if (method === 'session/create') { this.nativeIds.add(args.request.sessionId); return { sessionId: args.request.sessionId } }
    if (method === 'session/list') return { items: [...this.nativeIds].map(sessionId => ({ sessionId, running: false })) }
    if (method === 'session/modelCatalog') return { groups: [{ id: 'provider', models: [{ id: 'model', name: 'Model' }] }], default: { provider: 'provider', model: 'model' } }
    if (method === 'commands/list') return [{ name: 'permission' }, ...(this.planSupported ? [{ name: 'plan' }] : []), { name: 'compact' }]
    if (method === 'permissionPresets/catalog') return { options: this.permissionOptions.map(value => ({ value, name: value })) }
    if (method === 'commands/execute') {
      if (args.line.startsWith('/permission ') && !this.ignorePermission) this.permission = args.line.slice('/permission '.length)
      if (args.line.startsWith('/plan')) {
        if (this.rejectPlan) return { commandId: 'command', result: { kind: 'error' } }
        this.planMode = args.line !== '/plan off'
      }
      return { commandId: 'command', result: { kind: 'success' } }
    }
    if (method === 'session/selectModel') return { selected: args.request }
    if (method === 'session/prompt' && this.promptError) throw this.promptError
    if (method === 'session/prompt') return { accepted: this.promptAccepted }
    if (method === 'session/cancel') return { accepted: true }
    if (method === '$events/result') return undefined
    if (method === 'session/page') return { records: [{ type: 'event', event: { seq: 42, type: 'assistant/message', data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'image-42' } }] } } } }] }
    if (method === 'session/attachment') return { attachment: { mediaType: 'image/png' }, data: 'aW1hZ2U=' }
    throw new Error('Unexpected method: ' + method)
  }
  async *stream(endpoint: string, _args: any, signal: AbortSignal): AsyncGenerator<any> {
    if (endpoint === '$events') {
      yield { type: 'ready', clientId: 'client-1', host: { home: '/private' } }
      yield* this.events.read(AbortSignal.any([signal, this.lifetime.signal]))
    } else if (endpoint === 'session/follow') {
      if (!this.followBaseline) { yield* this.follow.read(signal); return }
      yield { type: 'snapshot', cursor: this.seq, records: [], projections: { values: { permissions: { currentValue: this.permission } } } }
      yield* this.follow.read(signal)
    } else throw new Error('Unexpected stream: ' + endpoint)
  }
  native(type: string, data: any): void { this.follow.push({ type: 'event', event: { type, data, seq: ++this.seq, time: Date.now() } }) }
}
const host = new Host()
const agent = { id: 'deepseek', adapter: 'deepseek' } as AgentDef
const config = { agentId: 'deepseek', workdir: '/tmp', model: '["provider","model"]', permissionMode: 'ask' as const }
for (const action of ['interrupt', 'timeout'] as const) {
  const stalledHost = new Host()
  stalledHost.followBaseline = false
  const stalled = new DeepSeekHostRunner('stalled-' + action, { n: 0 }, agent, config, undefined, undefined,
    async () => stalledHost as unknown as DeepSeekHostClient)
  let outcome: unknown
  if (action === 'timeout') mock.timers.enable({ apis: ['setTimeout'] })
  const pending = stalled.updateConfig(config).then(() => { outcome = 'unexpected success' }, error => { outcome = error })
  try {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(outcome, undefined)
    if (action === 'interrupt') stalled.interrupt()
    else mock.timers.tick(30_001)
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(outcome instanceof DeepSeekHostError, action + ' must settle a missing initial snapshot')
    assert.equal(outcome.code, action === 'interrupt' ? 'initialization-cancelled' : 'initialization-timeout')
    assert.equal(stalledHost.calls.some(call => call.method === 'session/prompt'), false)
  } finally {
    if (action === 'timeout') mock.timers.reset()
    await stalled.disposeAndWait(); stalledHost.lifetime.abort(); await pending
  }
}

{
  const cancelledHost = new Host()
  cancelledHost.followBaseline = false
  const cancelled = new DeepSeekHostRunner('cancelled-turn', { n: 0 }, agent, config, undefined, undefined,
    async () => cancelledHost as unknown as DeepSeekHostClient)
  const emitted: UAEvent[] = [], done: any[] = []
  cancelled.on('event', event => emitted.push(event)); cancelled.on('done', result => done.push(result))
  const pending = cancelled.startTurn('must not submit')
  try {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
    cancelled.interrupt()
    await pending
    assert.equal(done.at(-1)?.interrupted, true)
    assert.equal(emitted.some(event => event.type === 'error'), false, 'user cancellation is not a provider failure')
    assert.equal(cancelledHost.calls.some(call => call.method === 'session/prompt'), false)
    cancelledHost.followBaseline = true
    await cancelled.probeSession()
    assert.equal(cancelledHost.nativeIds.size, 1, 'manual retry reuses the cancelled initialization identity')
  } finally { await cancelled.disposeAndWait(); cancelledHost.lifetime.abort() }
}

{
  let release!: (client: DeepSeekHostClient) => void
  const acquiring = new Promise<DeepSeekHostClient>(resolve => { release = resolve })
  const lateHost = new Host()
  const cancelled = new DeepSeekHostRunner('cancelled-acquire', { n: 0 }, agent, config, undefined, undefined, () => acquiring)
  const pending = cancelled.updateConfig(config).catch(error => error)
  cancelled.interrupt()
  release(lateHost as unknown as DeepSeekHostClient)
  try {
    assert.equal((await pending).code, 'initialization-cancelled')
    assert.equal(lateHost.calls.length, 0, 'a cancelled initialization must not create a session after acquire resolves')
  } finally { await cancelled.disposeAndWait(); lateHost.lifetime.abort() }
}
{
  const unsupportedHost = new Host()
  unsupportedHost.planSupported = false
  const unsupportedRunner = new DeepSeekHostRunner('unsupported-plan', { n: 0 }, agent,
    { ...config, collaborationMode: 'plan' }, undefined, undefined, async () => unsupportedHost as unknown as DeepSeekHostClient)
  try {
    await assert.rejects(unsupportedRunner.probeSession(), /Plan/,
      'a restored Plan selection must fail if the Host no longer advertises the native command')
    const done: any[] = []
    unsupportedRunner.on('done', result => done.push(result))
    await unsupportedRunner.startTurn('Must not execute outside Plan')
    assert.equal(done.at(-1)?.failed, true)
    assert.equal(unsupportedHost.calls.some(call => call.method === 'session/prompt'), false)
  } finally { await unsupportedRunner.disposeAndWait(); unsupportedHost.lifetime.abort() }
}
const runner = new DeepSeekHostRunner('test', { n: 0 }, agent, config, undefined, undefined, async () => host as unknown as DeepSeekHostClient)
const events: UAEvent[] = [], completions: any[] = []
runner.on('event', event => events.push(event)); runner.on('done', done => completions.push(done))
try {
  const probe = await runner.probeSession()
  assert.equal(probe.contract.structuredUsage, true)
  assert.deepEqual(probe.contract.permissionModes.map(mode => mode.id), ['ask', 'full-access', 'approve-for-me'])
  assert.equal(host.calls.some(call => call.method === 'commands/execute' && call.args.line === '/permission workspace-write'), true)
  const auto = await runner.updateConfig({ ...config, permissionMode: 'approve-for-me' })
  assert.equal(host.permission, 'auto')
  assert.equal(auto.contract?.currentPermissionMode, 'approve-for-me')
  host.permissionOptions = ['workspace-write', 'danger-full-access']
  await runner.updateConfig(config)
  assert.deepEqual((await runner.probeSession()).contract.permissionModes.map(mode => mode.id), ['ask', 'full-access'])
  await assert.rejects(runner.updateConfig({ ...config, permissionMode: 'approve-for-me' }), /权限|permission/)
  host.permissionOptions.push('auto')
  host.ignorePermission = true
  await assert.rejects(runner.updateConfig({ ...config, permissionMode: 'full-access' }), /permission-not-applied/)
  host.ignorePermission = false
  await runner.updateConfig(config)
  await runner.setCollaborationMode('plan')
  assert.equal(host.planMode, true, 'Plan must execute the native entry command')
  await runner.updateConfig({ ...config, collaborationMode: 'plan', permissionMode: 'full-access' })
  assert.equal(host.planMode, true, 'permission changes must preserve Plan')
  await runner.setCollaborationMode('default')
  assert.equal(host.planMode, false, 'leaving Plan must execute /plan off')
  await runner.updateConfig(config)
  const duplicate = new DeepSeekHostRunner('duplicate', { n: 0 }, agent, config, probe.nativeSessionId, undefined, async () => host as unknown as DeepSeekHostClient)
  await assert.rejects(duplicate.probeSession(), /正在被其他应用使用/)
  await duplicate.disposeAndWait()
  host.rejectPlan = true
  await assert.rejects(runner.setCollaborationMode('plan'), /command-rejected/)
  assert.equal(host.planMode, false, 'a rejected entry must not report an active Plan mode')
  host.rejectPlan = false
  const turn = runner.startTurn('Hello')
  await tick()
  assert.equal(runner.isRunning(), true)
  assert.equal(completions.length, 0, 'accepted:true is not completion')
  const steering = await runner.steer('Change direction')
  assert.equal(steering.appendedToTurn, true)
  assert.equal(host.calls.at(-1)?.args.request.mode, 'steer')
  host.promptAccepted = false
  await assert.rejects(runner.steer('Rejected direction'), /invalid-prompt-acknowledgement/)
  host.promptAccepted = true
  host.native('turn/start', { turn: 1 })
  const ask = (id: string, event = 'approval/request', request: any = { toolName: 'bash', callId: 'tool-1' }) => host.events.push({ type: 'waterfall', eventId: id, event, request, agentId: probe.nativeSessionId })
  ask('approval-1'); await tick()
  assert.ok(events.some(event => event.type === 'approval_request' && event.state === 'pending'))
  const answers = await Promise.all([runner.respondResult('approval-1', { outcome: { outcome: 'selected', optionId: 'allow_once' } }), runner.respondResult('approval-1', { outcome: { outcome: 'selected', optionId: 'allow_once' } })])
  assert.equal(answers.filter(answer => answer.handled).length, 1)
  assert.deepEqual(host.calls.filter(call => call.method === '$events/result').map(call => call.args.outcome), [{ kind: 'result', value: 'allowed-once' }])
  ask('cancelled-approval'); await tick()
  host.events.push({ type: 'cancel', eventId: 'cancelled-approval' }); await tick()
  assert.equal((await runner.respondResult('cancelled-approval', { outcome: { outcome: 'selected', optionId: 'allow_once' } })).handled, false)
  ask('question', 'user-questions/request', { questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }] }] }); await tick()
  assert.equal((await runner.respondResult('question', { answers: [{ id: 'q', selected: ['not-an-option'] }] })).handled, false)
  assert.equal((await runner.respondResult('question', { answers: [{ id: 'q', selected: [], custom: 'A' }] })).handled, true)
  assert.deepEqual(host.calls.at(-1)?.args.outcome, { kind: 'result', value: { answers: [{ id: 'q', selected: [], custom: 'A' }] } }, 'free text must not become plan approval')
  host.follow.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', turn: 1, step: 1 } })
  host.follow.push({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hello' } } })
  host.native('assistant/message', { turn: 1, step: 1, message: { id: 'message', content: [{ type: 'text', text: 'Hello' }] }, usage: { inputTokens: 10, outputTokens: 1 } })
  host.native('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await turn
  const texts = events.filter(event => event.type === 'agent_message')
  assert.equal(texts.length, 2); assert.equal(texts[0].payload.id, texts[1].payload.id)
  assert.equal(completions.length, 1); assert.equal(completions[0].failed, false)
  assert.equal((await runner.queryUsage())?.outputTokens, 1)
  const slow = runner.startTurn('Slow'); await tick()
  runner.interrupt(); await tick()
  assert.equal(runner.isRunning(), true, 'cancel acknowledgement does not manufacture turn/end')
  host.native('turn/end', { turn: 2, reason: { kind: 'aborted' } }); await slow
  assert.equal(completions.at(-1).interrupted, true)
  host.promptError = new DeepSeekHostError('session/writer-held')
  const before = host.calls.filter(call => call.method === 'session/prompt').length
  await runner.startTurn('conflict'); await tick()
  assert.equal(host.calls.filter(call => call.method === 'session/prompt').length, before + 1, 'occupied writer never retries or queues')
  assert.equal(completions.at(-1).failed, true)
  host.promptError = undefined
  const afterFailure = runner.startTurn('next'); await tick()
  host.native('turn/end', { turn: 3, reason: { kind: 'completed' } }); await afterFailure
  assert.equal(completions.at(-1).failed, false)
  assert.equal(await runner.readNativeImage({ eventSeq: 42, blockIndex: 0 }), 'data:image/png;base64,aW1hZ2U=')
  assert.equal(await runner.readNativeImage({ eventSeq: 42, blockIndex: 1 }), null)
  await assert.rejects(runner.readNativeImage({ eventSeq: -1, blockIndex: 0 }), /invalid-image-reference/)
  assert.deepEqual(host.calls.filter(call => call.method === 'session/attachment').at(-1)?.args, { request: { sessionId: probe.nativeSessionId, attachmentId: 'image-42' } })
  // 0.2.1 reuses a stored Session through create only while it is blank; a resumed
  // Session must attach without create or the Host would mint a different identity.
  const resumeHost = new Host()
  resumeHost.nativeIds.add('resumed-session')
  const resumed = new DeepSeekHostRunner('resumed', { n: 0 }, agent, config, 'resumed-session', undefined, async () => resumeHost as unknown as DeepSeekHostClient)
  const resumedProbe = await resumed.probeSession()
  assert.equal(resumedProbe.nativeSessionId, 'resumed-session', 'a resumed Session keeps its native identity')
  assert.equal(resumeHost.calls.some(call => call.method === 'session/create'), false, 'a resumed Session is never re-created through session/create')
  await resumed.disposeAndWait(); resumeHost.lifetime.abort()
  const unauthorized = runner.startTurn('expired credential'); await tick()
  host.native('turn/end', { turn: 4, reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'sensitive-provider-detail' } } })
  await unauthorized
  assert.equal(completions.at(-1).authRequired, true)
  assert.ok(events.some(event => event.type === 'error' && event.payload.authRequired === true))
  assert.equal(events.filter(event => event.type === 'error').some(event => event.payload.message?.includes('sensitive-provider-detail')), false)
  const disconnecting = runner.startTurn('connection loss'); await tick()
  host.follow.push(null); await disconnecting
  const delivered = host.calls.filter(call => call.method === 'session/prompt').length
  await runner.startTurn('manual retry 1')
  const repeated = runner.startTurn('manual retry 2'); await tick()
  assert.equal(host.calls.filter(call => call.method === 'session/prompt').length, delivered, 'a lost event channel cannot admit more prompts on the same Host generation')
  await repeated
  console.log('PASS Host runner: completion barrier, exact-once approval, cancellation, native questions, stream merge, usage and fail-fast ownership')
} finally {
  await runner.disposeAndWait(); host.lifetime.abort()
}
