import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner } from '../src/main/appServerAdapter.ts'
import { diagnostics, DiagnosticsStore } from '../src/main/diagnostics.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

// 契约（见 test/native-goal-plan-review.ts 的 queueWaitMetadataSurvivesStatusReplacement）：
// 同一回合内所有排队阶段共享一个稳定的 queue 事件 id——ready 后重新排队不换 id，
// 只是开启新的活跃阶段并累计时长。渲染侧靠该 id 把快照折叠成一个节点。
const agent: AgentDef = {
  id: 'traex', name: 'TraeX', bin: 'trae', adapter: 'traex', icon: '', builtin: true,
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  models: [], installed: true
}
const config: SessionConfig = { agentId: agent.id, workdir: '/repo', permissionMode: 'ask' }
const root = mkdtempSync(join(tmpdir(), 'uniagent-queue-episodes-'))
const diagnosticStore = new DiagnosticsStore(join(root, 'diagnostics.jsonl'))
const originalRecord = diagnostics.record
diagnostics.record = diagnosticStore.record.bind(diagnosticStore)
const orchestrator = new Orchestrator(
  (id) => id === agent.id ? agent : undefined,
  new SessionStore(join(root, 'sessions.json')),
  join(root, 'artifacts'),
  join(root, 'session-logs')
)
;(orchestrator as any).sessions.set('session-1', {
  id: 'session-1', title: 'test', status: 'idle', createdAt: 1, config
})
const runner = new AppServerRunner('session-1', { n: 0 }, agent, config)
;(runner as any).threadId = 'thread-1'
;(runner as any).curTurnId = 'turn-1'
;(runner as any).startingTurnToken = 'turn-attempt-1'
;(orchestrator as any).bindAppServerDiagnostics(runner, 'session-1')
const events: UAEvent[] = []
runner.on('event', (event) => events.push(event as UAEvent))

const notify = (queue: Record<string, unknown>, receivedAt: number): void => {
  ;(runner as any).onNotification('queue/status', {
    threadId: 'thread-1', turnId: 'turn-1', ...queue
  }, undefined, receivedAt)
}

try {
  // turn 进行中排队 → 就绪 → 再次排队（14h 限流会话的真实形态）：
  // 全程一个 id，ready 事件携带累计时长，reopen 后新阶段从零继续计时。
  notify({ state: 'waiting', position: 10 }, 1_000)
  notify({ state: 'waiting', position: 9 }, 1_500)
  notify({ state: 'ready' }, 3_000)
  notify({ state: 'waiting', position: 4 }, 5_000)
  notify({ state: 'ready' }, 8_000)

  const queueEvents = events.filter(ev => ev.type === 'queue_status')
  assert.equal(queueEvents.length, 5, `应产出 5 条 queue_status 事件，实际 ${queueEvents.length}`)
  const id = (index: number): string => String((queueEvents[index].payload as any)?.id ?? '')
  const queue = (index: number): any => (queueEvents[index].payload as any)?.queue ?? {}

  assert.ok(id(0).startsWith('queue-turn-attempt-1-'), `排队 id 按 turnToken 生成，实际 ${id(0)}`)
  assert.equal(new Set(queueEvents.map(ev => String((ev.payload as any)?.id ?? ''))).size, 1,
    '同一回合所有排队阶段必须共享一个稳定的 queue 事件 id（ready 后 reopen 不换 id）')
  assert.equal(queue(2).waitedMs, 2_000, 'ready 事件携带第一阶段排队时长')
  assert.equal(Number.isFinite(queue(3).startedAt), true, 'reopen 后新阶段携带新的阶段起点')
  assert.equal(queue(3).waitedMs, 2_000, 'reopen 后的活跃阶段携带累计已完成时长')
  assert.equal(queue(4).waitedMs, 5_000, '最终 ready 事件携带跨阶段累计时长')
} finally {
  diagnostics.record = originalRecord
  rmSync(root, { recursive: true, force: true })
}

console.log('PASS queue wait episode ids')
