import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import type { RouterStore } from '../src/main/router/store'
import { projectMemoryMcpEnv } from '../src/main/router/mcp'
import { DEFAULT_ROUTER_CONFIG, type GlobalMemoryItem } from '../src/shared/router'
import type { AgentDef, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-memory-')), db = new RouterDatabase(join(root, 'router.sqlite'))
const store = new Proxy({} as RouterStore, { get(_, key: string) { return async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
const agent = { id: 'deepseek', installed: true, adapter: 'deepseek', models: [{ id: DEFAULT_ROUTER_CONFIG.model, efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef
const session: Session = { id: 'task', title: '任务', status: 'idle', createdAt: 1, config: { agentId: 'codex', workdir: root, projectId: 'ua' } }
let config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }
const controller = new RouterController(store, { agents: () => [agent], config: () => config, saveConfig: value => { config = value },
  orchestrator: { getSessionById: id => id === session.id ? session : undefined, getEvents: async () => [], managedSessions: () => [session] } as any,
  projectMemory: async () => [], objects: async () => [], changed: () => {}, error: () => {}, newTask: async () => session, recoverTask: async () => undefined }, root)
try {
  await controller.recover()
  // Historical memberships stay readable, and project memory remains a separate
  // on-demand capability. Global-memory extraction and jobs are gone.
  const row: GlobalMemoryItem = { id: 'legacy', content: '历史全局记忆仍保留', scope: { kind: 'global' }, status: 'active', revision: 0, source: { version: 'fixture' }, updatedAt: 1 }
  db.writeMemory(row)
  assert.equal(db.memories().find(item => item.id === 'legacy')?.content, row.content, 'existing global-memory rows are not migrated or deleted')
  assert.equal('enqueueMemory' in db, false, 'background global-memory extraction is removed')
  assert.equal('memoryJobs' in db, false)
  assert.equal('memoryPage' in db, false)
  assert.equal('memoryForSession' in controller, false)
  assert.equal('memoryContext' in controller, false)
  const guide = await controller.projectContext(session.id, session.config)
  assert.match(guide, /project_memory/)
  const env = projectMemoryMcpEnv(session.id)
  assert.deepEqual(Object.keys(env).sort(), ['UNIAGENT_PROJECT_MEMORY_ENDPOINT', 'UNIAGENT_PROJECT_MEMORY_TOKEN'])
  assert.ok(env.UNIAGENT_PROJECT_MEMORY_TOKEN, 'project memory remains available after the on-demand binding')
  assert.equal(db.memories().length, 1)
  await controller.event({ sessionId: session.id, seq: 3, ts: 3, type: 'turn_completed', state: 'success', payload: {} })
  assert.equal(db.memories(undefined, true).length, 1, 'a successful turn does not enqueue or create global-memory candidates')
  console.log('PASS Router memory removal: global tool/jobs/IPC gone, historical rows and project memory retained')
} finally { await controller.close(); db.close() }
