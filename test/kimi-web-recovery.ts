import assert from 'node:assert/strict'
import { KimiWebRunner } from '../src/main/kimiWebRunner.ts'
const runner: any = new KimiWebRunner('local', { n: 0 }, { id: 'kimi', adapter: 'kimi' } as any, { agentId: 'kimi', workdir: '/tmp' })
const events: any[] = [], done: any[] = []
let items: any[] = []
runner.runtime = { transcript: async () => ({ items }), getGoal: async () => null, closeAndWait: async () => {} }
runner.on('event', (event: any) => events.push(event)); runner.on('done', (event: any) => done.push(event))
await runner.onFrame({ type: 'turn.started', payload: { turnId: 1 } })
await runner.onFrame({ type: 'assistant.delta', payload: { turnId: 1, delta: 'Before ' } })
const firstId = events.find(event => event.type === 'agent_message').payload.id
const snapshot = { as_of_seq: 10, epoch: 'new', session: { last_turn_reason: 'completed' }, in_flight_turn: null, pending_approvals: [], pending_questions: [] }
await runner.recover(snapshot)
assert.equal(done.length, 0, 'empty snapshot and stale last_turn_reason do not prove completion')
items = [{ kind: 'turn', turnId: 't1', state: 'completed', origin: { kind: 'user' }, prompt: 'local input', steps: [
  { state: 'completed', frames: [{ kind: 'text', role: 'assistant', frameId: 'text-1', text: 'Before tool' }, { kind: 'tool', frameId: 'tool-1', toolCallId: 'read-1', name: 'Read', state: 'done', output: 'contents' }] },
  { state: 'completed', frames: [{ kind: 'text', role: 'assistant', frameId: 'text-2', text: 'After tool' }] }
] }]
await runner.recover(snapshot)
assert.equal(done.length, 1)
assert.equal(done[0].failed, false)
const latest = new Map(events.filter(event => event.type === 'agent_message').map(event => [event.payload.id, event.payload.text]))
assert.equal(latest.get(firstId), 'Before tool')
assert.deepEqual([...latest.values()], ['Before tool', 'After tool'])
assert.equal(events.filter(event => event.type === 'user_message').length, 0, 'outbox retains ownership of local user messages')
await runner.recover(snapshot)
assert.equal(done.length, 1, 'duplicate snapshot must not complete the turn twice')
await runner.onFrame({ type: 'turn.started', payload: { turnId: '2' } })
items.push({ kind: 'turn', turnId: '2', state: 'cancelled', steps: [] })
await runner.recover(snapshot)
assert.equal(done.at(-1).interrupted, true)
await runner.disposeAndWait()
// 运行中轮询重放：服务端 in_flight 旁白滞后于步骤推进（或夹在思考段之后）时，
// 必须按内容归并到既有段，不得新建同文本段——否则界面出现两条一模一样的步骤行。
const polling: any = new KimiWebRunner('polling', { n: 0 }, { id: 'kimi', adapter: 'kimi' } as any, { agentId: 'kimi', workdir: '/tmp' })
const pollEvents: any[] = []
polling.on('event', (event: any) => pollEvents.push(event))
const narration = '我来查这两个失败测试的实际状态和当前接入方式，确认是不是用例过期。'
polling.runtime = { transcript: async () => ({ items: [{ kind: 'turn', turnId: 't1', state: 'running', origin: { kind: 'user' }, prompt: 'task', steps: [
  { state: 'completed', frames: [{ kind: 'text', role: 'assistant', frameId: 'text-1', text: narration }, { kind: 'tool', frameId: 'tool-1', toolCallId: 'bash-1', name: 'Bash', state: 'done', output: 'ok' }] },
  { state: 'running', frames: [{ kind: 'thinking', frameId: 'think-1', text: 'Thinking' }] }
] }] }), getGoal: async () => null, closeAndWait: async () => {} }
await polling.onFrame({ type: 'turn.started', payload: { turnId: 't1' } })
await polling.onFrame({ type: 'assistant.delta', payload: { turnId: 't1', delta: narration } })
await polling.onFrame({ type: 'tool.call.started', payload: { turnId: 't1', toolCallId: 'bash-1', name: 'Bash', args: { command: 'ls' } } })
await polling.onFrame({ type: 'tool.result', payload: { turnId: 't1', toolCallId: 'bash-1', output: 'ok' } })
await polling.onFrame({ type: 'turn.step.started', payload: { turnId: 't1', step: 1 } })
await polling.onFrame({ type: 'thinking.delta', payload: { turnId: 't1', delta: 'Thinking' } })
const liveSnapshot = { as_of_seq: 11, epoch: 'new', session: {}, pending_approvals: [], pending_questions: [], in_flight_turn: { turn_id: 't1', assistant_text: narration, thinking_text: 'Thinking' } }
await polling.recover(liveSnapshot)
const narrations = () => [...new Map(pollEvents.filter(event => event.type === 'agent_message').map(event => [event.payload.id, event.payload.text])).values()]
assert.deepEqual(narrations(), [narration], '快照重放不得把同一段旁白重复成新事件')
await polling.recover(liveSnapshot)
assert.deepEqual(narrations(), [narration], '相同快照重复恢复仍不得产生重复旁白段')
await polling.onFrame({ type: 'assistant.delta', payload: { turnId: 't1', delta: '新步骤旁白' } })
assert.deepEqual(narrations(), [narration, '新步骤旁白'], '新步骤的新旁白仍应成为独立段')
await polling.disposeAndWait()
const reconnect: any = new KimiWebRunner('reconnect', { n: 0 }, { id: 'kimi', adapter: 'kimi' } as any, { agentId: 'kimi', workdir: '/tmp' })
let attempts = 0, tick: (() => void) | undefined
reconnect.running = true
reconnect.ensureReady = async () => { attempts++; reconnect.running = false }
const originalTimeout = globalThis.setTimeout
try {
  globalThis.setTimeout = ((callback: () => void) => { tick = callback; return { unref() {} } }) as any
  reconnect.scheduleRecovery()
} finally { globalThis.setTimeout = originalTimeout }
tick!()
await new Promise(resolve => setImmediate(resolve))
assert.equal(attempts, 1, 'retry reconnect even when the previous connection attempt left no runtime')
await reconnect.disposeAndWait()
for (const kind of ['recovery_limit', 'recovery_failed', 'shutdown_incomplete']) {
  const bounded: any = new KimiWebRunner('bounded-' + kind, { n: 0 }, { id: 'kimi', adapter: 'kimi' } as any, { agentId: 'kimi', workdir: '/tmp' })
  const { KimiWebError } = await import('../src/main/kimiWebTransport.ts')
  const errors: any[] = []
  bounded.running = true
  bounded.runtime = { snapshot: async () => { throw new KimiWebError(kind) }, closeAndWait: async () => {} }
  bounded.ensureReady = async () => { throw new KimiWebError(kind) }
  bounded.on('event', (event: any) => { if (event.type === 'error') errors.push(event) })
  try {
    globalThis.setTimeout = ((callback: () => void) => { tick = callback; return { unref() {} } }) as any
    bounded.scheduleRecovery()
  } finally { globalThis.setTimeout = originalTimeout }
  tick!(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(bounded.isRunning(), false, kind + ': terminal recovery failures must stop polling')
  assert.equal(errors.length, 1)
  assert.ok(errors[0].payload.message.includes('未重发任务'))
  await bounded.disposeAndWait()
}
for (const state of ['missing', 'busy', 'active', 'queued']) {
  const resumed: any = new KimiWebRunner('resume-' + state, { n: 0 }, { id: 'kimi', adapter: 'kimi' } as any, { agentId: 'kimi', workdir: '/tmp' })
  const resumedEvents: any[] = []
  resumed.on('event', (event: any) => resumedEvents.push(event))
  await resumed.onFrame({ type: 'turn.started', payload: { turnId: 't1' } })
  await resumed.onFrame({ type: 'assistant.delta', payload: { turnId: 't1', delta: 'Saved partial result' } })
  const before = [...resumed.segments]
  resumed.runtime = { serviceReplaced: true, snapshot: async () => { throw new Error('old connection closed') }, closeAndWait: async () => {} }
  resumed.ensureReady = async () => { resumed.runtime = {
    status: async () => ({ busy: state === 'busy' }), prompts: async () => ({ active: state === 'active' ? {} : null, queued: state === 'queued' ? [{}] : [] }),
    transcript: async () => ({ items: [] }), closeAndWait: async () => {}
  } }
  try {
    globalThis.setTimeout = ((callback: () => void) => { tick = callback; return { unref() {} } }) as any
    resumed.scheduleRecovery()
  } finally { globalThis.setTimeout = originalTimeout }
  tick!(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumed.isRunning(), state !== 'missing', 'only a verified idle host without the original turn is an unconfirmed result')
  assert.equal(resumedEvents.filter(event => event.payload.code === 'recovery_turn_unconfirmed').length, state === 'missing' ? 1 : 0)
  assert.deepEqual(resumed.segments, before, 'recovering an unconfirmed turn must retain its displayed partial result')
  await resumed.disposeAndWait()
}
console.log('Kimi Web recovery: authoritative terminal, stable text identity, duplicate replay and cancellation passed')
