import assert from 'node:assert/strict'
import { configureRequirementRuntime, prepareRequirementTurn, cancelRequirementPreparation, setRequirementsEnabled } from '../src/main/requirementRuntime'
import { configureProjectMemoryRuntime } from '../src/main/projectMemoryRuntime'
import { configureAssistantContextRuntime, prepareAssistantInitialization, assistantInitialization } from '../src/main/assistant/context'
import { Orchestrator } from '../src/main/orchestrator'
import type { Session } from '../src/shared/types'

const session = { id: 'ctx-session', config: { agentId: 'codex', workdir: '/work', requirementId: 'req-1' }, status: 'idle', title: 'ctx', createdAt: 1 } as Session
let reads = 0
let value: any = { revision: 'one', requirement: { name: '测试需求' }, overview: { goal: '必须保留登录态', current: '实现待验证' }, readingStatus: 'ready', memories: { items: [{ id: 'private-progress', text: '最新动态事实' }] }, tasks: [{ summary: '其它会话动态结果' }] }
try {
  setRequirementsEnabled(true)
  configureRequirementRuntime(() => session, async () => { reads++; return value })
  configureAssistantContextRuntime(() => session, () => {})
  for (const input of ['继续登录功能', '加速', '/compact']) {
    const preparation = prepareRequirementTurn(session, input)
    assert.equal(await preparation.ready, input); preparation.complete()
  }
  assert.equal(reads, 0, 'ordinary message preparation does not read dynamic requirement facts')
  await prepareAssistantInitialization(session)
  assert.equal(reads, 1)
  const initial = assistantInitialization(session.id)
  assert.match(initial, /必须保留登录态/)
  assert.match(initial, /测试需求/)
  assert.doesNotMatch(initial, /private-progress|其它会话动态结果|"revision"|"current"|"next"|"workspace"|"documentPath"|"directory"|"read"/)
  value = { ...value, revision: 'two', overview: { goal: '新的目标' } }
  await prepareAssistantInitialization(session)
  assert.equal(reads, 1); assert.equal(assistantInitialization(session.id), initial)
  const eventHost = Object.assign(Object.create(Orchestrator.prototype), { logSession: () => {} }) as any
  for (const state of ['running', 'failed']) eventHost.logEvent({ sessionId: session.id, type: 'context_compaction', state, payload: { id: 'compact-1' } })
  eventHost.logEvent({ sessionId: session.id, type: 'error', state: 'failed', payload: {} })
  await prepareAssistantInitialization(session); assert.equal(reads, 1)
  eventHost.logEvent({ sessionId: session.id, type: 'context_compaction', state: 'success', payload: { id: 'compact-1' } })
  await prepareAssistantInitialization(session); assert.equal(reads, 2)
  assert.match(assistantInitialization(session.id), /新的目标/)
  eventHost.logEvent({ sessionId: session.id, type: 'context_compaction', state: 'success', payload: { id: 'compact-1' } })
  eventHost.logEvent({ sessionId: session.id, type: 'context_compaction', state: 'success', payload: { id: 'side-compact' } }, 'side')
  await prepareAssistantInitialization(session); assert.equal(reads, 2)

  session.config.projectId = 'project'
  let release!: () => void
  configureProjectMemoryRuntime(() => new Promise<void>(resolve => { release = resolve }))
  const cancelled = prepareRequirementTurn(session, '已取消')
  assert.equal(cancelRequirementPreparation(session.id), true)
  release(); await cancelled.ready
  assert.equal(cancelled.current(), false)
  configureProjectMemoryRuntime(undefined)

  const sent: string[] = []
  const host = Object.assign(Object.create(Orchestrator.prototype), {
    sessions: new Map([[session.id, session]]), activeQueueItems: new Map(), queues: new Map(), recoveryTurns: new Map(),
    currentTurnInput: () => ({ payload: { source: 'app' } }),
    setStatus: (s: Session, status: any) => { s.status = status }, runStreaming: (_s: any, _a: any, text: string) => { sent.push(text) }
  }) as any
  const prepared = { agent: { id: 'codex', adapter: 'codex' }, config: session.config, route: 'app-server', input: {} }
  assert.equal(host.run(session, '执行', undefined, undefined, prepared), true)
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(sent, ['执行'], 'orchestrator dispatches the original user text after initialization')
  assert.equal(reads, 3, 'a real binding change rebuilds initialization once')
  setRequirementsEnabled(false)
  const disabled = prepareRequirementTurn(session, '普通任务'); assert.equal(await disabled.ready, '普通任务'); disabled.complete()
  console.log('PASS requirement initialization, on-demand facts, raw dispatch, successful compaction and cancelled preparation')
} finally {
  configureRequirementRuntime(() => undefined); configureProjectMemoryRuntime(undefined)
  configureAssistantContextRuntime(() => undefined, () => {}); setRequirementsEnabled(false)
}
