import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRunner } from '../src/main/appServerAdapter'
import type { AppServerRpc } from '../src/main/appServerTransport'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { TaskMetadataStore } from '../src/main/taskMetadataStore'
import { TaskTitleService } from '../src/main/taskTitleService'
import { TaskTitleIntegration, taskTitleSessionPolicy } from '../src/main/taskTitleIntegration'
import type { AgentDef } from '../src/shared/types'

class RpcFixture extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []
  turn = 0
  async start() {}
  notify() {}
  respond() {}
  interrupt() {}
  async dispose() {}
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'config/read') return { config: {} } as T
    if (method === 'thread/start') return { thread: { id: params.ephemeral ? 'old-title-thread' : 'native-main' } } as T
    if (method === 'thread/resume') return { thread: { id: params.threadId } } as T
    if (method === 'turn/start') return { turn: { id: params.threadId === 'old-title-thread' ? 'old-title-turn' : `main-${++this.turn}` } } as T
    if (method === 'thread/goal/get') return { goal: null } as T
    if (['initialize', 'thread/name/generate', 'thread/name/set', 'thread/unsubscribe', 'turn/interrupt'].includes(method)) return {} as T
    throw new Error('Unexpected fixture RPC: ' + method)
  }
  user() { this.emit('notification', 'item/completed', { threadId: 'native-main', turnId: `main-${this.turn}`, item: { id: `user-${this.turn}`, type: 'userMessage', content: [{ type: 'text', text: '修复图片漏显' }] } }) }
}
const directory = await mkdtemp(join(tmpdir(), 'title-policy-'))
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('policy fixture timeout') }
try {
  for (const adapter of ['codex', 'traex'] as const) {
    const agent = { id: adapter, adapter, name: adapter, bin: '/usr/bin/true', installed: true, builtin: true, models: [{ id: 'small', efforts: [] }],
      capabilities: { startupSystemPrompt: true, streaming: true, modelSelect: true, permissionModes: [{ id: 'read-only', label: '', hint: '' }] } } as AgentDef
    const host = new Orchestrator(() => agent, new SessionStore(join(directory, `${adapter}.json`)), directory, join(directory, 'logs-' + adapter))
    // Production binding suppresses ordinary managed task naming for configured,
    // unconfigured and disabled auto settings. No binding preserves native legacy.
    let generated = 0
    const titles = new TaskTitleService(new TaskMetadataStore(join(directory, 'metadata-' + adapter)), {
      session: id => host.getSessionById(id), agents: () => [{ ...agent, id: 'codex', adapter: 'codex' }],
      config: () => ({ enabled: true, agentId: 'codex', model: 'small' }),
      generate: async (_agent, ref) => { assert.equal(ref.model, 'small'); generated++; return '{"title":"修复任务图片漏显","description":"任务描述夹具","needsClarification":false}' }, publish: session => host.publishTaskState(session)
    }, { debounceMs: 0 })
    const bridge = new TaskTitleIntegration(titles, id => host.getSessionById(id))
    host.on('sessionCreated', session => titles.store.initialize(session, false))
    host.on('taskTitleInputRecorded', event => bridge.observe(event))
    host.on('taskInputAccepted', id => bridge.accepted(id))
    host.on('event', event => bridge.observe(event))
    const { session } = (host as any).createSessionRecord({ agentId: adapter, workdir: directory, model: 'small', permissionMode: 'read-only' }, '修复图片漏显')
    const runner: AppServerRunner = (host as any).ensureMainStreamer(session, agent)
    const rpc = new RpcFixture()
    // Inject at the real runner's transport boundary, retaining startTurn and all RPC logic.
    ;(runner as any).transportFactory = () => rpc
    host.configureSessionTitleGenerationPolicy(taskTitleSessionPolicy)
    try {
      await host.sendMessage(session.id, '修复图片漏显')
      await until(() => rpc.turn === 1 || host.loadedSessionEvents(session.id).some(event => event.type === 'error'))
      assert.equal(rpc.turn, 1, JSON.stringify(host.loadedSessionEvents(session.id).filter(event => event.type === 'error')))
      rpc.user()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(generated, 0, 'native start and user echo cannot generate before the main AI responds')
      rpc.emit('notification', 'item/completed', { threadId: 'native-main', turnId: 'main-1', item: { id: 'reply-1', type: 'agentMessage', text: '主 AI 确认任务历史图片漏显。', phase: 'final_answer' } })
      await until(() => generated === 1 && session.taskMetadata?.source === 'generated')
      rpc.emit('notification', 'turn/completed', { threadId: 'native-main', turn: { id: 'main-1', status: 'completed' } })
      await until(() => generated === 1 && session.taskMetadata?.source === 'generated')
      assert.equal(session.title, '修复图片漏显')
      assert.equal(session.titleLocked, undefined, 'Task title service does not mutate legacy locking')
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(rpc.requests.filter(r => r.method === 'thread/start' && r.params.ephemeral).length, 0, 'ordinary task must not launch old Codex title thread')
      assert.equal(rpc.requests.filter(r => r.method === 'turn/start').length, 1, 'only the main turn is sent through its native connection')
      assert.equal(rpc.requests.filter(r => r.method === 'thread/name/generate').length, 0, 'ordinary task must not launch old TraeX title request')
      const nativeId = session.nativeSessionId, config = structuredClone(session.config)
      rpc.emit('notification', 'thread/name/updated', { threadId: 'native-main', threadName: '原生被动名称' })
      assert.equal(session.title, '原生被动名称', 'passive native name events remain active')
      assert.equal(session.taskMetadata?.title, '修复任务图片漏显')
      assert.equal(session.nativeSessionId, nativeId)
      assert.deepEqual(session.config, config)

      for (const titleConfig of [undefined, { enabled: false, agentId: 'codex', model: 'small' }]) {
        const { session: unconfigured } = (host as any).createSessionRecord({ agentId: adapter, workdir: directory, permissionMode: 'read-only' }, '未配置命名任务')
        const unconfiguredTitles = new TaskTitleService(new TaskMetadataStore(join(directory, 'off-' + unconfigured.id)), {
          session: id => id === unconfigured.id ? unconfigured : undefined, agents: () => [{ ...agent, id: 'codex', adapter: 'codex' }], config: () => titleConfig,
          generate: async () => { assert.fail('disabled/unconfigured naming cannot request a model') }
        }, { debounceMs: 0 })
        const own: AppServerRunner = (host as any).ensureMainStreamer(unconfigured, agent)
        const ownRpc = new RpcFixture(); (own as any).transportFactory = () => ownRpc
        try {
          unconfiguredTitles.accepted(unconfigured.id, '未配置命名任务', { inputId: 'first' }); unconfiguredTitles.responded(unconfigured.id, '主 AI 回复', 'first')
          await own.startTurn('未配置命名任务'); ownRpc.user()
          await new Promise(resolve => setTimeout(resolve, 20))
          assert.equal(ownRpc.requests.some(r => r.method === 'thread/name/generate' || r.method === 'thread/start' && r.params.ephemeral), false, 'disabled/unconfigured settings cannot quietly use the main title model')
        } finally { await unconfiguredTitles.close(); own.dispose() }
      }

      // Policies are rebound to runners created for forks before normal dispatch.
      const { session: forkSession } = (host as any).createSessionRecord({ agentId: adapter, workdir: directory, permissionMode: 'read-only' }, '恢复输入')
      const fork: AppServerRunner = (host as any).ensureStreamerForFork(forkSession, agent)
      const forkRpc = new RpcFixture(); (fork as any).transportFactory = () => forkRpc
      fork.setInitialTitleSeed('恢复输入')
      await fork.startTurn('恢复输入'); forkRpc.user()
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(forkRpc.requests.some(r => r.method === 'thread/name/generate' || r.method === 'thread/start' && r.params.ephemeral), false, 'fork/reset runner retains ordinary policy')
      fork.dispose()
    } finally { await titles.close(); runner.dispose(); await host.closeSessionLogs() }

    const legacyRpc = new RpcFixture()
    const legacy = new AppServerRunner('legacy', { n: 0 }, agent, { agentId: adapter, workdir: directory, permissionMode: 'read-only' }, undefined, undefined, () => legacyRpc)
    try {
      await legacy.startTurn('修复图片漏显'); legacyRpc.user()
      await until(() => legacyRpc.requests.some(r => adapter === 'codex' ? r.method === 'turn/start' && r.params.threadId === 'old-title-thread' : r.method === 'thread/name/generate'))
    } finally { legacy.dispose() }
  }
  console.log('PASS ordinary task AppServer RPC duplicate suppression, passive native names, forks and legacy default')
} finally { await rm(directory, { recursive: true, force: true }) }
