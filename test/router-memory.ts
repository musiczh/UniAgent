import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import type { RouterStore } from '../src/main/router/store'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-memory-')), db = new RouterDatabase(join(root, 'router.sqlite'))
const store = new Proxy({} as RouterStore, { get(_, key: string) { return async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
const agent = { id: 'deepseek', installed: true, adapter: 'deepseek', models: [{ id: DEFAULT_ROUTER_CONFIG.model, efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef
const session: Session = { id: 'task', title: '任务', status: 'idle', createdAt: 1, config: { agentId: 'codex', workdir: root, projectId: 'ua' } }
const events: UAEvent[] = [{ sessionId: session.id, seq: 1, ts: 1, type: 'user_message', payload: { text: '请记住：我偏好中文。', source: 'app' } }]
let config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }, extraction = '[{"content":"操作前阅读工程规范"}]'
const controller = new RouterController(store, { agents: () => [agent], config: () => config, saveConfig: value => { config = value },
  orchestrator: { getSessionById: id => id === session.id ? session : undefined, getEvents: async () => events, managedSessions: () => [session] } as any,
  objects: async () => [], changed: () => {}, error: () => {}, newTask: async () => session, recoverTask: async () => undefined,
  extractMemory: async () => extraction }, root)
try {
  await controller.memoryForSession(session.id, { action: 'remember', content: '我偏好中文', scope: { kind: 'global' } })
  const first = db.memories()[0]
  assert.equal(first.status, 'active')
  await assert.rejects(controller.memoryForSession(session.id, { action: 'remember', content: '编造偏好' }), /explicit_user_source/)
  await assert.rejects(controller.memoryForSession(session.id, { action: 'propose', content: '跨空间', scope: { kind: 'space', projectId: 'other' } }), /scope_conflict/)
  await controller.memoryForSession(session.id, { action: 'propose', content: '尚未确认的经验' })
  assert.doesNotMatch(await controller.memoryContext(session.id, session.config), /尚未确认/)
  const candidate = db.memories(undefined, true).find(row => row.status === 'candidate')!
  await controller.memory({ action: 'confirm', id: candidate.id, expectedRevision: candidate.revision })
  assert.match(await controller.memoryContext(session.id, session.config), /尚未确认/)
  await controller.memory({ action: 'revoke', id: candidate.id, expectedRevision: candidate.revision + 1 })
  assert.doesNotMatch(await controller.memoryContext(session.id, session.config), /尚未确认/)
  events[0].payload.text = '原来源已修改'
  assert.doesNotMatch(await controller.memoryContext(session.id, session.config), /我偏好中文/)
  events[0].payload.text = '请记住：我偏好中文。'
  events.push({ sessionId: session.id, seq: 2, ts: 2, type: 'agent_message', payload: { text: '已按规范完成本轮' } })
  await controller.event({ sessionId: session.id, seq: 3, ts: 3, type: 'turn_completed', state: 'success', payload: {} })
  assert.equal(db.memoryJobs().length, 1)
  await (controller as any).extractNextMemory()
  assert.equal(db.memoryJobs()[0].state, 'complete')
  assert.equal(db.memories(undefined, true).find(row => row.content === '操作前阅读工程规范')?.status, 'candidate')
  assert.doesNotMatch(await controller.memoryContext(session.id, session.config), /操作前阅读/)
  await controller.event({ sessionId: session.id, seq: 4, ts: 4, type: 'turn_completed', state: 'success', payload: {} })
  events.push({ sessionId: session.id, seq: 5, ts: 5, type: 'user_message', payload: { text: '新的输入' } })
  await (controller as any).extractNextMemory()
  assert.equal(db.memoryJobs()[1].state, 'stale')
  extraction = '[{"content":"api_key=example"}]'
  await controller.event({ sessionId: session.id, seq: 6, ts: 6, type: 'turn_completed', state: 'success', payload: {} })
  await (controller as any).extractNextMemory()
  assert.equal(db.memoryJobs()[2].state, 'failed')
  assert.equal(db.memories(undefined, true).some(row => row.content.includes('api_key')), false)
  config = { ...config, enabled: false }
  assert.equal(await controller.memoryContext(session.id, session.config), '')
  assert.ok((await controller.memory({ action: 'read' })).some(row => row.id === first.id))
  console.log('PASS Router memory: explicit sources, scopes, candidate/confirm/revoke, changed source, background extraction, stale jobs, credential rejection and disabled context')
} finally { await controller.close() }
