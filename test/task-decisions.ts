import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, UAEvent } from '../src/shared/types'
import { projectTaskDecisions, decisionIdentity } from '../src/shared/taskDecisions'
import { RequestResponseGate, TaskDecisionResolver } from '../src/main/requestResponseGate'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'

const session: Session = { id: 's', title: '任务', createdAt: 1, status: 'running', config: { agentId: 'test', workdir: '/test' } }
const event = (seq: number, payload: UAEvent['payload'] = {}, state: UAEvent['state'] = 'pending'): UAEvent => ({ sessionId: 's', seq, ts: seq, type: 'approval_request', state, payload: { requestId: 'native', kind: 'command', params: { command: 'test' }, ...payload } })
const approval = event(1)
const asyncQuestion: UAEvent = { ...event(2, { id: 'async', delivery: 'async', questions: [{ id: 'q', question: '范围？' }] }), type: 'agent_message' }
const decisions = projectTaskDecisions(session, [approval, asyncQuestion], [event(1)])
assert.equal(decisions.length, 3)
assert.equal(new Set(decisions.map(d => d.id)).size, 3, 'source streams do not collide')
assert.equal(decisions[1].type, 'approval')
assert.equal(decisions.find(d => d.type === 'question')?.blocking, false)
assert.equal(decisions.find(d => d.type === 'question')?.priority, 'high')
assert.equal(session.status, 'running')
assert.equal(projectTaskDecisions(session, [approval, { ...approval, state: 'success' }]).length, 0)
assert.equal(projectTaskDecisions(session, [{ ...approval, payload: { ...approval.payload, interactionExpired: true } }]).length, 0)
assert.notEqual(decisionIdentity(approval), decisionIdentity(event(4)), 'reused native IDs belong to distinct events')
const recovery = { chainId: 'chain', phase: 'waiting' as const, attempts: 1, maxRetries: 2, reason: '自动恢复' }
assert.equal(projectTaskDecisions({ ...session, status: 'error', recovery }, []).length, 0)
assert.equal(projectTaskDecisions({ ...session, status: 'error', recovery: { ...recovery, phase: 'stopped' } }, [event(3), event(4)]).filter(d => d.type === 'exception').length, 1)
assert.equal(projectTaskDecisions({ ...session, archived: true }, [approval]).length, 0)
const legacy = { ...session, taskState: { phase: 'active' as const, version: 1, updatedAt: 1, awaitingAcceptance: true } }
assert.deepEqual(projectTaskDecisions(legacy, []), [], 'old report summaries no longer create delivery decisions')
assert.equal(projectTaskDecisions(legacy, [approval])[0].type, 'approval', 'native approvals still work with old report summaries')

const resolver = new TaskDecisionResolver()
let calls = 0
const input = { id: decisions[0].id, version: decisions[0].version, actionId: 'one', answer: { decision: 'accept' } }
await resolver.resolve('s', input, () => decisions, async () => { calls++ })
await resolver.resolve('s', input, () => [], async () => { calls++ })
assert.equal(calls, 1)
await assert.rejects(resolver.resolve('s', { ...input, answer: { decision: 'decline' } }, () => decisions, async () => {}), /冲突/)
await assert.rejects(resolver.resolve('other', input, () => [], async () => {}), /失效/)
await assert.rejects(resolver.resolve('s', { ...input, actionId: 'two', version: 'old' }, () => decisions, async () => {}), /已更新/)

const gate = new RequestResponseGate(15)
const states: unknown[] = []
let finish!: (value: { handled: boolean; hasPendingRequests: boolean }) => void
const delayed = new Promise<{ handled: boolean; hasPendingRequests: boolean }>(resolve => { finish = resolve })
const keepAlive = setTimeout(() => {}, 200)
const first = gate.run('request', () => delayed, state => states.push(state)) as Promise<unknown>
await assert.rejects(gate.run('request', () => { assert.fail('duplicate dispatch') }, () => {}) as Promise<unknown>, /正在提交/)
await assert.rejects(first, /结果待确认/)
await assert.rejects(gate.run('request', () => { assert.fail('unknown must reconcile') }, () => {}) as Promise<unknown>, /结果待确认/)
assert.deepEqual(states, ['submitting', 'unknown'])
finish({ handled: true, hasPendingRequests: false })
await delayed; await new Promise(resolve => setTimeout(resolve, 1))
assert.equal(states.at(-1), undefined, 'late acknowledgement reconciles unknown')
clearTimeout(keepAlive)

// Exercise the shared Orchestrator path used by conversation and task detail.
const root = await mkdtemp(join(tmpdir(), 'task-decision-gate-'))
try {
  const host = new Orchestrator(() => undefined, new SessionStore(join(root, 'sessions.json')), root, join(root, 'logs'))
  const internal = host as any
  internal.sessions.set('s', structuredClone(session)); internal.events.set('s', [structuredClone(approval)])
  let nativeCalls = 0, complete!: (value: any) => void
  internal.protocolRunners.set('s', { respondResult: () => { nativeCalls++; return new Promise(resolve => { complete = resolve }) } })
  const pending = host.respondToRequest('s', 'native', { decision: 'accept' }) as Promise<unknown>
  await assert.rejects(host.respondToRequest('s', 'native', { decision: 'accept' }) as Promise<unknown>, /正在提交/)
  assert.equal(host.taskDecisions('s')[0].status, 'submitting')
  internal.events.get('s').push(event(2, { resolved: true }, 'success'))
  complete({ handled: true, hasPendingRequests: false }); await pending
  assert.equal(nativeCalls, 1); assert.equal(host.taskDecisions('s').length, 0)
  internal.events.set('s', [{ ...approval, payload: { ...approval.payload, taskResponseState: 'submitting' } }])
  assert.equal(host.taskDecisions('s')[0].status, 'unknown', 'recovered submitting state cannot pretend a native response is still in flight')
  await assert.rejects(host.respondToRequest('s', 'native', { decision: 'accept' }) as Promise<unknown>, /结果待确认/)
  assert.equal(nativeCalls, 1)
  internal.events.set('s', [structuredClone(approval)])
  const order: string[] = []
  Object.defineProperty(internal.sessionLogs, 'backgroundWrites', { value: true })
  internal.sessionLogs.flush = async () => { order.push('flush') }
  internal.protocolRunners.set('s', { respondResult: () => { order.push('dispatch'); return { handled: true, hasPendingRequests: false } } })
  await host.respondToRequest('s', 'native', { decision: 'accept' })
  assert.equal(order[0], 'flush'); assert.ok(order.indexOf('dispatch') > 0); assert.equal(order.at(-1), 'flush')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('PASS R07 native decision identity, async execution, expiry, recovery dedup, version/idempotency, timeout reconciliation and shared native response gate')
