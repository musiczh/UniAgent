import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../../src/main/router/database'
import { RouterController } from '../../src/main/router/controller'
import { routerMcpServers } from '../../src/main/router/mcp'
import { DEFAULT_ROUTER_CONFIG, type RouterInput, type RouterObject } from '../../src/shared/router'
import type { RouterStore } from '../../src/main/router/store'
import type { AgentDef, Attachment, Session } from '../../src/shared/types'

export async function routerFixture(objects: RouterObject[], options: { now?: number; send?: (id: string, prompt: string, attachments?: Attachment[]) => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ua-router-quality-')), now = options.now || Date.now()
  const db = new RouterDatabase(join(directory, 'router.sqlite'), undefined, () => now)
  const store = new Proxy({} as RouterStore, { get(_, key: string) { return async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
  const config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }, journal: Array<{ action: string; target?: string; requestId: string }> = []
  const sessions = new Map<string, Session>(objects.filter(row => row.kind === 'task').map(row => [row.id, { id: row.id, title: row.title, createdAt: now, status: row.busy ? 'running' : 'idle', archived: row.archived, readOnly: row.readOnly,
    nativeSessionId: row.nativeSessionId, config: { agentId: row.agentId || 'codex', workdir: '/original', projectId: row.projectId, requirementId: row.requirementId } }]))
  const controller = new RouterController(store, { config: () => config, saveConfig() {}, agents: () => [{ id: 'deepseek', adapter: 'deepseek', installed: true, models: [{ id: config.model, efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef],
    objects: async () => objects, changed() {}, error() {}, recoverTask: async () => undefined,
    newTask: async (request, decision, execution) => { journal.push({ action: decision.action, target: decision.requirementId || decision.projectId, requestId: request.requestId }); return { id: 'fixture-' + request.requestId, title: decision.title || request.prompt, status: 'idle', createdAt: now, config: execution } },
    orchestrator: { getSessionById: id => sessions.get(id), managedSessions: () => [...sessions.values()], getEvents: async () => [],
      createRouterDraft: (config, id) => { if (!sessions.has(id)) sessions.set(id, { id, config, title: 'Router fixture', status: 'idle', createdAt: now }); return sessions.get(id)! },
      updateSessionConfig: (id, patch) => Object.assign(sessions.get(id)!.config, patch), sendMessage: async (id, prompt, attachments) => { sessions.get(id)!.status = 'running'; await options.send?.(id, prompt, attachments) },
      acceptRoutedInput: async (id, requestId) => { journal.push({ action: 'reuse_task', target: id, requestId }); return { status: sessions.get(id)?.status === 'running' ? 'queued' : 'accepted' } },
      interrupt() {}, appendSystemNotice() {}, disposeSession() {} } as any }, directory)
  await controller.recover()
  let seq = 0
  return { controller, db, directory, config, sessions, journal,
    async submit(input: Omit<RouterInput, 'requestId'> & { requestId?: string }) {
      const requestId = input.requestId || randomUUID()
      await controller.submit({ ...input, requestId, execution: input.execution || { agentId: 'codex', workdir: '/submitted', projectId: 'default', taskScope: { kind: 'space', projectId: 'default' } } })
      for (let i = 0; i < 100 && db.request(requestId)?.state !== 'routing'; i++) await new Promise(resolve => setTimeout(resolve, 10))
      return requestId
    },
    async call(name: string, args: unknown) {
      const server = routerMcpServers(db.sessionId())![0], env = Object.fromEntries(server.env.map(row => [row.name, row.value]))
      return (await fetch(env.UNIAGENT_ROUTER_ENDPOINT, { method: 'POST', headers: { authorization: 'Bearer ' + env.UNIAGENT_ROUTER_TOKEN }, body: JSON.stringify({ name, arguments: args }) })).json()
    },
    async end(state: 'success' | 'failed' = 'success') {
      // These fixtures issue individual protocol calls without a real model.
      // Explicitly stop unfinished probes so recovery cannot leak into the next case.
      if (db.pending().some(row => row.routerSessionId === db.sessionId() && row.state === 'routing')) await controller.interrupt()
      const id = db.sessionId(); sessions.get(id)!.status = 'idle'; await controller.event({ sessionId: id, seq: ++seq, ts: now, type: 'turn_completed', state, payload: {} })
    },
    close: () => controller.close() }
}
