import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { SessionStore } from '../src/main/sessionStore'
import { defaultRecoverySettings } from '../src/shared/sessionRecovery'
import { appNotificationBody } from '../src/main/appNotifications'
import { hydrateSubmittedUserMessages } from '../src/main/submittedUserMessages'
import type { AgentDef, Attachment, UAEvent } from '../src/shared/types'

const agent: AgentDef = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', builtin: true, icon: '', installed: true,
  models: [{ id: 'execution', label: 'Execution', efforts: [] }], capabilities: { streaming: true, modelSelect: true, reasoningEffort: false, permissionModes: [{ id: 'read-only', label: '只读', hint: '' }] } }
const settings = { ...defaultRecoverySettings(), enabled: true, agentId: 'codex', model: 'judge', maxRetries: 2, selectedErrors: ['codex:capacity'] }
const yes = JSON.stringify({ retry: true, matchedRuleIds: [], reason: '暂时容量不足' })
const originalStart = AppServerRunner.prototype.startTurn
let sends: Array<{ runner: AppServerRunner; prompt: string; attachments?: Attachment[] }> = []
AppServerRunner.prototype.startTurn = async function(prompt, attachments) { sends.push({ runner: this, prompt, attachments }) }
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(test: () => boolean) { for (let i = 0; i < 300; i++) { if (test()) return; await tick() }; assert.fail('recovery did not settle') }
const root = await mkdtemp(join(tmpdir(), 'recovery-orchestrator-'))
const hosts: Orchestrator[] = []
async function fixture(name: string, wait: (ms: number, signal: AbortSignal) => Promise<void> = async () => {}, attachments?: Attachment[]) {
  sends = []
  const store = new SessionStore(join(root, name, 'sessions.json'))
  const host = new Orchestrator(() => agent, store, join(root, name, 'artifacts'), join(root, name, 'logs'))
  hosts.push(host)
  let judgments = 0
  await host.configureErrorRecovery(() => settings, { judge: async (_config, prompt) => {
    judgments++
    const context = JSON.parse(prompt.split('背景数据：')[1])
    assert.equal(context.execution.model, 'execution')
    return yes
  }, wait, random: () => 0 })
  const events: UAEvent[] = []
  host.on('event', event => events.push(event))
  const session = host.createSession({ agentId: 'codex', model: 'execution', workdir: root }, 'original request', attachments)
  const fail = (delivery: 'accepted' | 'not-accepted' | 'unknown' = 'accepted') => {
    const runner = sends.at(-1)!.runner
    const emit = (type: UAEvent['type'], payload: UAEvent['payload'], state?: UAEvent['state']) => runner.emit('event', { sessionId: session.id, type, state, seq: events.length + 100, ts: Date.now(), payload })
    emit('turn_started', { threadId: 'native-fixture', turnId: `turn-${sends.length}` })
    emit('error', { message: '<span>Selected model is at capacity. Please try a different model.</span>' }, 'failed')
    emit('turn_completed', { recoveryDelivery: delivery }, 'failed')
    runner.emit('done', { nativeSessionId: 'native-fixture', failed: true })
  }
  return { host, session, events, fail, store, judgments: () => judgments }
}
try {
  {
    const f = await fixture('bounded')
    await until(() => sends.length === 1)
    const originalConfig = JSON.stringify(f.session.config)
    f.fail()
    await until(() => sends.length === 2)
    assert.match(sends[1].prompt, /继续完成上一条用户请求/)
    assert.equal(JSON.stringify(f.session.config), originalConfig)
    assert.equal(f.events.filter(event => event.type === 'error').every(event => event.payload.recoveryIntermediate), true)
    assert.equal(f.events.some(event => appNotificationBody(event) !== null), false, 'no terminal notification during recovery')
    f.fail()
    await until(() => sends.length === 3)
    f.fail()
    await until(() => f.session.status === 'error')
    assert.equal(f.judgments(), 2, 'judge count')
    assert.equal(f.session.recovery?.attempts, 2, 'attempt count')
    assert.match(f.session.recovery!.reason, /上限/)
    assert.equal(f.events.filter(event => event.type === 'error' && event.payload.recoveryFinal).length, 1)
    assert.ok(f.events.some(event => event.payload.recoveryFinal && appNotificationBody(event)))
    const submitted = f.store.load()[0].submittedUserMessages!
    assert.equal(submitted.filter(message => message.automaticRecovery).length, 2, 'persisted continuation markers: ' + JSON.stringify(submitted))
    const inputs = f.events.filter(event => event.type === 'user_message').map(event => ({ ...event, payload: { text: event.payload.text } }))
    assert.equal(hydrateSubmittedUserMessages(inputs, submitted).filter(event => event.payload.automaticRecovery).length, 2, 'hydrated continuation markers')
    assert.equal((await f.host.getRecoveryErrors())[0].count, 3)
  }
  {
    const f = await fixture('unknown')
    await until(() => sends.length === 1)
    f.fail('unknown')
    await until(() => f.session.status === 'error')
    assert.equal(f.judgments(), 0)
    assert.equal(sends.length, 1)
  }
  {
    const attachments = [{ kind: 'image', path: '/tmp/failed-turn-image.png', name: 'image.png', mime: 'image/png' }] as Attachment[]
    const f = await fixture('queued-unknown')
    await f.host.sendMessage(f.session.id, 'queued request that will fail', attachments)
    await f.host.sendMessage(f.session.id, 'untouched next request')
    sends[0].runner.emit('done', { nativeSessionId: 'native-fixture' })
    await until(() => sends.length === 2)
    const failedId = f.host.getQueue(f.session.id)[0].id
    f.fail('unknown')
    await until(() => f.session.status === 'error')
    assert.deepEqual(f.host.getQueue(f.session.id).map(item => item.prompt), ['untouched next request'], 'a terminal failure must not return the sent input to the queue')
    assert.deepEqual(f.store.load()[0].pendingQueue?.map(item => item.prompt), ['untouched next request'], 'restart must not resurrect the failed input')
    const failedInput = f.events.find(event => event.type === 'user_message' && event.payload.text === 'queued request that will fail')!
    assert.deepEqual(failedInput.payload.attachments, attachments, 'failed input and image remain in the transcript')
    assert.equal(f.events.filter(event => event.type === 'user_message' && event.payload.text === failedInput.payload.text).length, 1)
    assert.ok(f.events.some(event => event.type === 'turn_completed' && event.state === 'failed' && event.payload.recoveryFinal))
    assert.equal(f.host.getQueue(f.session.id).some(item => item.id === failedId), false)
    assert.equal(sends.length, 2, 'failure does not drain untouched pending inputs')
    await f.host.sendMessage(f.session.id, 'new intent after failure')
    await until(() => sends.length === 3)
    assert.equal(sends[2].prompt, 'new intent after failure')
    sends[2].runner.emit('done', { nativeSessionId: 'native-fixture' })
    await until(() => sends.length === 4)
    assert.equal(sends[3].prompt, 'untouched next request')
    sends[3].runner.emit('done', { nativeSessionId: 'native-fixture' })
    await until(() => f.session.status === 'idle')
    assert.deepEqual(f.host.getQueue(f.session.id), [])
  }
  {
    const attachments = [{ path: '/tmp/recovery-test-image.png', name: 'image.png', mime: 'image/png' }] as Attachment[]
    const f = await fixture('not-accepted', async () => {}, attachments)
    await until(() => sends.length === 1)
    f.fail('not-accepted')
    await until(() => sends.length === 2)
    assert.equal(sends[1].prompt, sends[0].prompt)
    assert.deepEqual(sends[1].attachments, sends[0].attachments)
  }
  {
    const f = await fixture('cancel', (_ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    await f.host.sendMessage(f.session.id, 'queued input awaiting recovery')
    await f.host.sendMessage(f.session.id, 'untouched input after cancellation')
    sends[0].runner.emit('done', { nativeSessionId: 'native-fixture' })
    await until(() => sends.length === 2)
    f.fail('not-accepted')
    await until(() => f.session.recovery?.phase === 'waiting')
    assert.equal(f.host.cancelErrorRecovery(f.session.id), true)
    await tick()
    assert.equal(sends.length, 2)
    assert.equal(f.session.status, 'error')
    assert.equal(f.session.recovery?.phase, 'stopped')
    assert.deepEqual(f.host.getQueue(f.session.id).map(item => item.prompt), ['untouched input after cancellation'])
    assert.deepEqual(f.store.load()[0].pendingQueue?.map(item => item.prompt), ['untouched input after cancellation'])
  }
  {
    const f = await fixture('stop-running-retry')
    f.fail()
    await until(() => sends.length === 2)
    f.host.interrupt(f.session.id)
    assert.equal(f.session.recovery?.phase, 'stopped', 'stopping a dispatched retry also stops its feedback')
  }
  {
    const f = await fixture('new-message', (_ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    f.fail()
    await until(() => f.session.recovery?.phase === 'waiting')
    await f.host.sendMessage(f.session.id, 'new intent')
    await until(() => sends.length === 2)
    assert.equal(sends[1].prompt, 'new intent')
    assert.equal(f.session.recovery, undefined)
    await tick()
    assert.equal(sends.length, 2, 'the cancelled timer never dispatches a continuation')
  }
  {
    const f = await fixture('successful')
    f.fail()
    await until(() => sends.length === 2)
    sends[1].runner.emit('done', { nativeSessionId: 'native-fixture' })
    await until(() => f.session.recovery === undefined)
    assert.equal(f.session.status, 'idle')
  }
  {
    const f = await fixture('restart', (_ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    await f.host.sendMessage(f.session.id, 'queued next request')
    f.fail()
    await until(() => f.session.recovery?.phase === 'waiting')
    await (f.host as any).errorRecovery.persist()
    const restored = new Orchestrator(() => agent, f.store, join(root, 'restart-artifacts'), join(root, 'restart-logs'))
    hosts.push(restored)
    await restored.configureErrorRecovery(() => settings, { judge: async () => { assert.fail('restart must not judge') } })
    await restored.loadPersisted()
    assert.equal(restored.getSessionById(f.session.id)?.recovery?.phase, 'stopped')
    assert.equal(restored.getSessionById(f.session.id)?.status, 'error')
    restored.resumePendingQueues()
    await tick()
    assert.equal(sends.length, 1, 'restart does not bypass a pending recovery by draining the durable queue')
    await writeFile(join(f.store.directory(), 'session-recovery.json'), '{broken')
    const corrupted = new Orchestrator(() => agent, f.store, join(root, 'corrupt-artifacts'), join(root, 'corrupt-logs'))
    hosts.push(corrupted)
    await assert.rejects(corrupted.configureErrorRecovery(() => settings))
    await corrupted.loadPersisted()
    corrupted.resumePendingQueues()
    await tick()
    assert.equal(sends.length, 1, 'corrupt recovery state must not replay the queue with reset counters')
  }
  console.log('PASS recovery integration: continuation, attachments, unknown delivery, bounded attempts, notification gating, cancellation and restored markers')
} finally {
  AppServerRunner.prototype.startTurn = originalStart
  for (const host of hosts) { host.disposeAll(); await host.closeSessionLogs() }
  await rm(root, { recursive: true, force: true })
}
