import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppServerRunner, configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter.ts'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'
import { TurnRunner } from '../src/main/adapter.ts'
import { AppendedPromptCard } from '../src/renderer/components/EventStream.tsx'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

class RecordingTransport extends EventEmitter implements AppServerRpc {
  requests: Array<{ method: string; params: any }> = []
  async start(): Promise<void> {}
  notify(): void {}
  respond(): void {}
  interrupt(): void {}
  async dispose(): Promise<void> {}
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'initialize') return {} as T
    if (method === 'config/read') return { config: { model_provider: 'openai' } } as T
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T
    if (method === 'thread/goal/get') return { goal: null } as T
    if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T
    throw new Error(`unexpected method: ${method}`)
  }
}

function agent(adapter: AgentDef['adapter']): AgentDef {
  return {
    id: adapter, name: adapter, bin: '/usr/bin/true', adapter, icon: '', builtin: true, installed: true,
    capabilities: {
      modelSelect: true, reasoningEffort: true, streaming: true,
      permissionModes: [{ id: 'ask', label: '请求批准', hint: '' }],
    },
    models: [],
  }
}

function config(agentId: string): SessionConfig {
  return {
    agentId, workdir: '/repo', permissionMode: 'ask',
    roleSnapshot: {
      id: 'reviewer', name: '审查员', agentId, permissionMode: 'ask',
      instructions: '只报告真实问题。',
    },
  }
}

const transport = new RecordingTransport()
const sourceArgs = [
  '-c', 'openai_base_url="http://127.0.0.1:11436/api/codex/v1"',
  '-c', 'model_catalog_json="/tmp/uniagent-models.json"',
  '-c', 'features.enable_request_compression=false'
]
let appServerArgs: string[] = []
configureCodexAppServerArgsProvider(config => config.model === 'kimi-for-coding' ? sourceArgs : [])
const appServer = new AppServerRunner(
  'streaming-session', { n: 0 }, agent('codex'), { ...config('codex'), model: 'kimi-for-coding' },
  undefined, undefined, (options) => { appServerArgs = options.args; return transport },
)
const streamingEvents: UAEvent[] = []
appServer.on('event', (event) => streamingEvents.push(event))
try {
  await appServer.startTurn('检查代码')
  const launch = streamingEvents.find((event) => event.payload?.kind === 'launch')
  const injected = transport.requests.find((request) => request.method === 'thread/start')?.params.developerInstructions
  assert.ok(launch, 'app-server 必须产生启动事件')
  assert.ok(injected, 'app-server 必须注入 developerInstructions')
  assert.equal(launch?.payload.appendedPrompt, injected, '启动事件必须携带实际注入 app-server 的完整 Prompt')
  assert.ok(String(injected).endsWith('只报告真实问题。'), JSON.stringify(injected))
  const started = transport.requests.find((request) => request.method === 'thread/start')?.params
  assert.equal(started?.config.openai_base_url, 'http://127.0.0.1:11436/api/codex/v1')
  assert.deepEqual(appServerArgs, ['app-server', '-c', 'thread_unload_delay_secs=0', '-c', 'model_catalog_json="/tmp/uniagent-models.json"'],
    '进程启动时加载模型目录，接口地址和请求参数仍由 thread 独立应用')
} finally {
  configureCodexAppServerArgsProvider()
  appServer.dispose()
}

const oneShotEvents: UAEvent[] = []
const oneShot = new TurnRunner('one-shot-session', { n: 0 })
oneShot.on('event', (event) => oneShotEvents.push(event))
const fixtureRoot = await mkdtemp(join(tmpdir(), 'ua-launch-prompt-'))
const fixtureBin = join(fixtureRoot, 'claude.cjs')
try {
  await writeFile(fixtureBin, `#!${process.execPath}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request') send({type: 'control_response', response: {subtype: 'success', request_id: value.request_id, response: {commands: [], models: []}}});
  if (value.type === 'user') send({type: 'result', subtype: 'success', is_error: false, result: 'ok', user_message_uuid: value.uuid});
});
`, { mode: 0o700 })
  const done = once(oneShot, 'done')
  oneShot.start({ ...agent('claude'), bin: fixtureBin }, { ...config('claude'), workdir: fixtureRoot }, '检查代码')
  await done
  const oneShotLaunch = oneShotEvents.find((event) => event.payload?.kind === 'launch')
  assert.ok(String(oneShotLaunch?.payload.appendedPrompt).endsWith('只报告真实问题。'))
} finally {
  await oneShot.disposeClaudeSdk()
  await rm(fixtureRoot, { recursive: true, force: true })
}

const markup = renderToStaticMarkup(createElement(AppendedPromptCard, { prompt: 'abcd中文' }))
assert.match(markup, /<details class="launch-prompt-card">/, '附加 Prompt 卡片默认折叠')
assert.match(markup, /本次启动追加的系统提示/)
assert.match(markup, /约 3 tokens/, 'Token 数使用无需依赖的 UTF-8 字节粗估')
assert.match(markup, /launch-prompt-caret[\s\S]*width="12"/, '折叠箭头与过程内其他折叠项统一为 12px')
assert.match(markup, /ui-icon-sparkles[\s\S]*launch-prompt-title[\s\S]*launch-prompt-tokens[\s\S]*launch-prompt-caret/,
  '附加 Prompt 使用图标、标题、信息和最右侧折叠箭头的统一顺序')
assert.match(markup, /<pre>abcd中文<\/pre>/)
assert.doesNotMatch(markup, /\d+ 行/, '不显示行数')

console.log('launch appended prompt: ok')
