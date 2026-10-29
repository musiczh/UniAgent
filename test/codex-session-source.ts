import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AppServerRunner, configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import type { AppServerRpc } from '../src/main/appServerTransport'
import type { AgentDef, SessionConfig } from '../src/shared/types'
import { codexModelKey, codexSessionProvider } from '../src/shared/codexModelIdentity'

class Transport extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []
  disposed = false
  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> { this.disposed = true }
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'config/read') return { config: { model_provider: 'user-native-provider' } } as T
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'thread' } } as T
    if (method === 'thread/fork') return { thread: { id: 'forked' } } as T
    if (method === 'thread/goal/get') return { goal: null } as T
    if (method === 'turn/start') return { turn: { id: 'turn' } } as T
    return {} as T
  }
}

const agent: AgentDef = {
  id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', builtin: true, icon: '', models: [],
  capabilities: { modelSelect: true, reasoningEffort: false, streaming: true, permissionModes: [{ id: 'read-only', label: '只读', hint: '' }] }
}
const local = { kind: 'local' as const, sourceId: 'bonsai' }
const third = { kind: 'third-party' as const, sourceId: 'kimi' }
let revision = 0
configureCodexAppServerArgsProvider(config => config.modelSource?.kind === 'native' ? []
  : ['-c', `model_provider="${codexSessionProvider(config.modelSource)}"`, '-c', `source_revision=${revision}`,
    '-c', `model_catalog_json=${JSON.stringify(`/catalog/${config.modelSource?.kind}-${config.modelSource?.sourceId}.json`)}`])
const transports: Transport[] = []
const launches: string[][] = []
const config: SessionConfig = { agentId: 'codex', workdir: '/repo', additionalDirectories: ['/repo/extra'], permissionMode: 'read-only', model: codexModelKey('same-model', local), modelSource: local }
const runner = new AppServerRunner('source-resume', { n: 0 }, agent, config, 'existing-thread', undefined, options => {
  launches.push(options.args)
  const transport = new Transport()
  transports.push(transport)
  return transport
})
const side = new AppServerRunner('source-side', { n: 0 }, agent, config, 'side-thread')
try {
  await runner.forkBeforeTurn('before')
  const initial = transports[0].requests.find(request => request.method === 'thread/resume')!.params
  assert.equal(initial.model, 'same-model')
  assert.equal(initial.modelProvider, 'uniagent-local')
  assert.equal(initial.config.model_provider, 'uniagent-local')
  assert.ok(launches[0].includes('model_catalog_json="/catalog/local-bonsai.json"'),
    '模型目录必须在进程启动时加载，按 thread 传入不会更新 Codex 模型管理器')
  assert.deepEqual(initial.config['sandbox_workspace_write.writable_roots'], ['/repo/extra'])
  assert.equal(transports[0].requests.find(request => request.method === 'thread/fork')?.params.modelProvider, 'uniagent-local')
  side.shareConnectionWith(runner)
  await side.ensureThreadReady()
  assert.equal(transports.length, 1, '同一目录的主会话和侧边会话继续共享进程')
  revision++
  runner.updateConfig(config)
  await runner.forkBeforeTurn('before')
  assert.equal(transports.length, 2, '实际启动参数快照变化必须重建进程，不能重算旧配置掩盖变化')
  assert.equal(transports[0].disposed, false, '主会话更新目录不能结束仍被侧边会话使用的进程')
  runner.updateConfig({ ...config, model: codexModelKey('same-model', third), modelSource: third })
  await runner.forkBeforeTurn('before')
  assert.equal(transports[2].requests.find(request => request.method === 'thread/resume')?.params.modelProvider, 'uniagent-kimi')
  runner.updateConfig({ ...config, model: 'same-model', modelSource: { kind: 'native' } })
  await runner.forkBeforeTurn('before')
  const official = transports[3].requests.find(request => request.method === 'thread/resume')!.params
  assert.equal(official.modelProvider, 'user-native-provider', '恢复官方会话采用原始配置，不继承旧第三方线程 provider')
  assert.equal(official.model, 'same-model')
  assert.ok(!launches[3].some(arg => arg.includes('model_provider=')), '官方启动不追加来源覆盖')
  assert.deepEqual(launches[2], ['app-server', '-c', 'thread_unload_delay_secs=0', '-c', 'model_catalog_json="/catalog/third-party-kimi.json"'])
  assert.deepEqual(launches[3], ['app-server', '-c', 'thread_unload_delay_secs=0'], '原生来源继续使用用户原始模型目录')
  for (const args of launches) assert.ok(!args.some(arg => /^(model|model_provider|mcp_servers\.)=/.test(arg)),
    '模型、provider 和 MCP 配置仍按 thread 隔离')
} finally {
  side.dispose()
  runner.dispose()
  configureCodexAppServerArgsProvider()
}
console.log('codex session source: resume/fork isolation and runtime snapshots passed')
