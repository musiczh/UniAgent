import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { UniAgentManagement, type ManagementDeps } from '../src/main/assistant/manage'
import { AppRestartService, RESTART_WAIT, RESTART_NOW, RESTART_CANCEL } from '../src/main/appRestart'
import { encodeAnswer, normalizeQuestions } from '../src/shared/questions'
import type { AssistantScope } from '../src/main/assistant/mcp'
import type { Session } from '../src/shared/types'

const dir = await mkdtemp(join(tmpdir(), 'uniagent-restart-host-'))
const store = new SessionStore(join(dir, 'sessions.json'))
const session = { id: 'assistant', title: '助手', config: { agentId: 'codex', workdir: dir, assistantSnapshot: { assistantId: 'personal', soul: '', soulRevision: 1, workingRules: '', workingRulesRevision: 1 } }, status: 'idle', createdAt: 1 } as Session
const other = { ...session, id: 'other', title: '开发任务', config: { agentId: 'codex', workdir: dir } } as Session
store.saveOrThrow([session, other])
const orchestrator = new Orchestrator(() => undefined, store, join(dir, 'artifacts'), join(dir, 'logs'))
orchestrator.loadPersisted()
const scope = { sessionId: session.id, active: true } as AssistantScope
let resumes = 0
const restart = new AppRestartService(join(dir, 'restart.json'), {
  inspectTarget: async bundle => ({ bundle, executable: bundle + '/Contents/MacOS/UniAgent', sha256: 'a'.repeat(64), version: '1.0.10' }),
  caller: () => ({ available: true, busy: true, lastSeq: 10 }),
  activities: () => [{ id: other.id, title: other.title, status: 'awaiting-approval', revision: '1' }],
  ask: (...args) => orchestrator.requestManagementChoice(...args),
  dismiss: (...args) => orchestrator.dismissManagementConfirmation(...args),
  replyDelivered: () => false, flush: async () => {}, relaunch: () => { throw new Error('must not restart') },
  resume: async () => { resumes++ }, notice: (id, text) => orchestrator.appendSystemNotice(id, text)
})
const deps = { orchestrator, appRestart: restart, teams: { catalog: () => ({ projects: [] }) }, assistant: async () => ({ assistant: { enabled: true } }), changed: () => {} } as unknown as ManagementDeps
const management = new UniAgentManagement(deps, join(dir, 'operations'))
const call = (operation: string, params: Record<string, unknown>, operationId = randomUUID()) => management.call(scope, { action: 'execute', resource: 'settings', operation, params, operationId }) as Promise<any>
const latestRequest = () => orchestrator.pendingSessionRequests(session.id).at(-1)!
const respond = async (choice: string) => {
  const request = latestRequest()
  const fields = normalizeQuestions('question', request.payload.params)
  const answer = encodeAnswer('question', fields, { confirm: { choice: [choice], text: '', other: '' } })
  return orchestrator.respondToRequest(session.id, request.payload.requestId, answer, { source: 'feishu' })
}
try {
  const schema: any = await management.call(scope, { action: 'describe', resource: 'settings' })
  assert.ok(schema.resources.settings.execute.restart)
  assert.ok(schema.resources.settings.query.restartStatus)
  const operationId = randomUUID()
  const receipt = await call('restart', { targetAppPath: '/test/UniAgent.app', prompt: '继续检查' }, operationId)
  assert.equal(receipt.state, 'awaiting_confirmation')
  assert.deepEqual(normalizeQuestions('question', latestRequest().payload.params)[0].options.map(o => o.label), [RESTART_WAIT, RESTART_NOW, RESTART_CANCEL])
  const pending: any = await management.call(scope, { action: 'query', resource: 'tasks', operation: 'pending', params: { sessionId: session.id } })
  assert.equal(pending.items[0].answerable, false, 'the Agent must not answer the restart choice for the user')
  await assert.rejects(Promise.resolve().then(() => respond('伪造选项')), /选项|option|invalid/i)
  assert.equal((await restart.status())?.state, 'awaiting_confirmation')
  const duplicate = await call('restart', { targetAppPath: '/test/UniAgent.app', prompt: '继续检查' }, operationId)
  assert.equal(duplicate.state, 'awaiting_confirmation')
  assert.equal(orchestrator.pendingSessionRequests(session.id).length, 1)
  await respond(RESTART_WAIT)
  const waiting: any = await management.call(scope, { action: 'query', resource: 'settings', operation: 'restartStatus', params: { id: operationId } })
  assert.equal(waiting.mode, 'wait')
  assert.equal(waiting.state, 'waiting')
  assert.equal((await management.call(scope, { action: 'query', resource: 'operations', params: { id: operationId } }) as any).state, 'completed', 'the receipt completes scheduling, while restartStatus still reports waiting')
  await call('reconsiderRestart', { id: operationId })
  assert.equal((await restart.status())?.state, 'awaiting_confirmation')
  await respond(RESTART_CANCEL)
  assert.equal((await restart.status())?.state, 'cancelled')
  assert.equal(orchestrator.pendingSessionRequests(session.id).length, 0)

  let confirmed: boolean | undefined
  orchestrator.requestManagementConfirmation(session.id, 'legacy-confirm', '普通确认', async value => { confirmed = value })
  await respond('确认执行')
  assert.equal(confirmed, true, 'existing binary confirmations still work')
  orchestrator.requestManagementConfirmation(session.id, 'legacy-cancel', '普通确认', async value => { confirmed = value })
  orchestrator.cancelManagementConfirmations(session.id)
  await Promise.resolve()
  assert.equal(confirmed, false)

  const runtime = orchestrator as any
  runtime.events.set(other.id, [{ sessionId: other.id, seq: 1, ts: 1, type: 'user_message', payload: { text: '当前任务' } }])
  const originalWork = orchestrator.restartWorkRevision(other.id)
  runtime.record(other.id, { type: 'agent_message', payload: { text: '输出更新' } })
  runtime.record(other.id, { type: 'reasoning', payload: { text: '思考更新' } })
  assert.equal(orchestrator.restartWorkRevision(other.id), originalWork, 'streaming output must not repeatedly invalidate the user choice')
  runtime.record(other.id, { type: 'user_message', payload: { text: '新增任务' } })
  assert.notEqual(orchestrator.restartWorkRevision(other.id), originalWork)
  assert.equal(orchestrator.hasActiveSessionWork(other.id), false)
  const beforePendingInput = orchestrator.restartWorkRevision(other.id)
  runtime.pendingSends.set(other.id, 1)
  assert.equal(orchestrator.hasActiveSessionWork(other.id), true, 'accepted input is busy before its runner starts')
  assert.notEqual(orchestrator.restartWorkRevision(other.id), beforePendingInput)
  runtime.pendingSends.delete(other.id)
  runtime.nativeActionReservations.add(other.id)
  assert.equal(orchestrator.hasActiveSessionWork(other.id), true)
  runtime.nativeActionReservations.delete(other.id)
  assert.equal(resumes, 0)
  console.log('restart management, protected host choices, legacy confirmations and pending-input activity: passed')
} finally {
  await restart.close(); await management.close(); orchestrator.disposeAll(); await orchestrator.closeSessionLogs()
  await rm(dir, { recursive: true, force: true })
}
