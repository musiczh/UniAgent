import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateTaskTitleText, TASK_TITLE_SYSTEM_PROMPT } from '../src/main/taskTitleRuntime'
import { configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import { parseCodexConfig } from '../src/main/codexSourceConfig'
import type { AgentDef } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'task-title-runtime-'))
const previousHome = process.env.CODEX_HOME
process.env.CODEX_HOME = join(root, 'native')
await mkdir(process.env.CODEX_HOME)
const auth = join(process.env.CODEX_HOME, 'auth.json')
await writeFile(auth, '{"fixture":"auth"}')
const catalog = join(root, 'catalog.json')
await writeFile(catalog, JSON.stringify({ models: [{ slug: 'small', shell_type: 'shell_command', additional_tools: ['apply_patch'] }] }))
configureCodexAppServerArgsProvider(() => ['-c', 'model_catalog_json=' + JSON.stringify(catalog)])
const agent = (adapter: string): AgentDef => ({ id: adapter, name: adapter, adapter, bin: '/fixture/agent', installed: true,
  models: [{ id: 'small', label: 'Small', efforts: ['off', 'low', 'high'] }], capabilities: { modelSelect: true, startupSystemPrompt: true } } as AgentDef)
let mode = 'success', rpcClosed = 0, sdkClosed = 0, sourceClosed = 0, madeSdk = 0
let options: any, launch: any, sent: any
const requests: any[] = []
class Rpc extends EventEmitter {
  async start() {
    const cfg = parseCodexConfig(await readFile(join(options.env.CODEX_HOME, 'config.toml'), 'utf8'))
    assert.equal(cfg.model_provider, 'fixture')
    assert.equal(cfg.model_providers.fixture.base_url, 'https://fixture.invalid')
    assert.equal(cfg.openai_base_url, 'http://127.0.0.1:8790/v1', 'the isolated title runtime preserves the native Ferry endpoint')
    assert.equal(cfg.chatgpt_base_url, 'https://chatgpt.fixture.invalid')
    assert.equal(cfg.mcp_servers, undefined, 'native tools are not copied into title runtime')
    assert.equal(cfg.developer_instructions, undefined, 'native rules are not copied')
  }
  notify() {}
  respond() {}
  interrupt() {}
  async dispose() { rpcClosed++ }
  async request(method: string, params: any): Promise<any> {
    requests.push({ method, params })
    if (method === 'thread/start') {
      if (mode === 'wrong-model') return { thread: { id: 'title', model: 'large' } }
      return { thread: { id: 'title', model: 'small' } }
    }
    if (method === 'turn/start') {
      if (mode === 'hang') return {}
      if (mode === 'tool') this.emit('notification', 'item/started', { threadId: 'title', item: { type: 'commandExecution' } })
      else {
        this.emit('notification', 'thread/tokenUsage/updated', { threadId: 'title', tokenUsage: { last: { inputTokens: 8, outputTokens: 4 } } })
        this.emit('notification', 'item/completed', { threadId: 'title', item: { type: 'agentMessage', text: '{"title":"修复图片漏显","description":"任务描述夹具","needsClarification":false}' } })
        this.emit('notification', 'turn/completed', { threadId: 'title', turn: { status: 'completed' } })
      }
    }
    return {}
  }
}
class Sdk extends EventEmitter {
  ready = Promise.resolve()
  respond() {}
  async close() { sdkClosed++ }
  async request(method: string, params: any): Promise<any> {
    if (method === 'send') {
      sent = params
      this.emit('message', { type: 'system', subtype: 'init', tools: mode === 'sdk-tool' ? ['Bash'] : [], model: mode === 'alias-wrong' ? 'opus' : mode === 'alias-correct' ? 'claude-haiku-4-5-20251001' : 'small' })
      if (mode !== 'hang') {
        this.emit('message', { type: 'assistant', message: { content: [{ type: 'text', text: '{"title":"修复图片漏显","description":"任务描述夹具","needsClarification":false}' }] } })
        this.emit('message', { type: 'result', subtype: 'success', is_error: false, result: '{"title":"修复图片漏显","description":"任务描述夹具","needsClarification":false}', usage: { input_tokens: 10, output_tokens: 5 } })
      }
    }
    return {}
  }
}
const deps = {
  createRpc: (value: any) => { options = value; return new Rpc() as any },
  createClaude: (value: any) => { launch = value; madeSdk++; return new Sdk() as any },
  readCodexNative: async () => ({ authPath: auth, config: { model_provider: 'fixture', model_providers: { fixture: { name: 'Fixture', base_url: 'https://fixture.invalid', env_key: 'FIXTURE_KEY' } },
    openai_base_url: 'http://127.0.0.1:8790/v1', chatgpt_base_url: 'https://chatgpt.fixture.invalid',
    mcp_servers: { forbidden: { command: '/do-not-start' } }, developer_instructions: 'DO_NOT_COPY_RULES' } }),
  readClaudeEnvironment: async () => ({ ANTHROPIC_API_KEY: 'fixture-key', UNRELATED_RULES: 'DO_NOT_COPY' }),
  prepareClaudeSource: async () => undefined,
  timeoutMs: 2000
}
try {
  const config = { agentId: 'codex', model: 'small', effort: 'low' as const }
  const codexUsage: any[] = []
  const text = await generateTaskTitleText(agent('codex'), config, 'title fixture', new AbortController().signal, { ...deps, onUsage: value => codexUsage.push(value) })
  assert.equal(JSON.parse(text).title, '修复图片漏显')
  for (const override of options.args.filter((_arg: string, index: number) => options.args[index - 1] === '-c')) {
    assert.equal(parseCodexConfig(override).mcp_servers, undefined, 'isolated title startup must not define an MCP without its transport')
  }
  const thread = requests.find(r => r.method === 'thread/start').params
  assert.equal(thread.model, 'small')
  assert.equal(thread.modelProvider, 'fixture')
  assert.deepEqual(codexUsage, [{ inputTokens: 8, outputTokens: 4 }])
  assert.equal(thread.ephemeral, true)
  assert.deepEqual(thread.dynamicTools, [])
  assert.equal(thread.developerInstructions, TASK_TITLE_SYSTEM_PROMPT)
  assert.equal(thread.config['features.shell_tool'], false)
  assert.equal(requests.find(r => r.method === 'turn/start').params.effort, 'low')
  assert.notEqual(options.env.CODEX_HOME, process.env.CODEX_HOME)
  await assert.rejects(readFile(join(options.env.CODEX_HOME, 'config.toml')), { code: 'ENOENT' }, 'own provider config cleaned')
  assert.ok(rpcClosed > 0)

  requests.length = 0
  await generateTaskTitleText(agent('codex'), { ...config, effort: 'high' }, 'explicit high effort', new AbortController().signal, deps)
  assert.equal(requests.find(r => r.method === 'turn/start').params.effort, 'high', 'title runtime preserves the selected effort')

  mode = 'tool'
  await assert.rejects(generateTaskTitleText(agent('codex'), config, 'deny tool', new AbortController().signal, deps), /工具/)
  mode = 'hang'
  await assert.rejects(generateTaskTitleText(agent('codex'), config, 'timeout', new AbortController().signal, { ...deps, timeoutMs: 10 }), /超时/)
  mode = 'success'
  const already = new AbortController(); already.abort()
  await assert.rejects(generateTaskTitleText(agent('codex'), config, 'cancel', already.signal, deps), /取消/)
  mode = 'wrong-model'
  await assert.rejects(generateTaskTitleText(agent('codex'), config, 'exact model', new AbortController().signal, deps), /模型/)

  mode = 'success'
  const usage: any[] = []
  assert.equal(JSON.parse(await generateTaskTitleText(agent('claude'), { ...config, agentId: 'claude' }, 'fixture', new AbortController().signal, {
    ...deps, onUsage: value => usage.push(value)
  })).title, '修复图片漏显')
  assert.equal(launch.options.model, 'small')
  assert.equal(launch.options.persistSession, false)
  assert.deepEqual(launch.options.tools, [])
  assert.deepEqual(launch.options.allowedTools, [])
  assert.deepEqual(launch.options.mcpServers, {})
  assert.deepEqual(launch.options.settingSources, [])
  assert.equal(launch.options.env.UNRELATED_RULES, undefined)
  assert.equal(usage[0].inputTokens, 10)
  assert.ok(sdkClosed > 0)
  await generateTaskTitleText(agent('claude'), { ...config, agentId: 'claude', effort: 'high' }, 'explicit high effort', new AbortController().signal, deps)
  assert.equal(launch.options.effort, 'high', 'Claude receives the selected effort instead of a fixed low setting')
  await generateTaskTitleText(agent('claude'), { ...config, agentId: 'claude', effort: 'off' }, 'explicit thinking off', new AbortController().signal, deps)
  assert.deepEqual(launch.options.thinking, { type: 'disabled' })
  assert.equal(launch.options.effort, undefined)
  mode = 'sdk-tool'
  await assert.rejects(generateTaskTitleText(agent('claude'), { ...config, agentId: 'claude' }, 'fixture', new AbortController().signal, deps), /工具/)
  mode = 'alias-wrong'
  const aliasAgent = agent('claude'); aliasAgent.models = [{ id: 'haiku', label: 'Haiku', efforts: ['low'] }]
  await assert.rejects(generateTaskTitleText(aliasAgent, { agentId: 'claude', model: 'haiku' }, 'fixture', new AbortController().signal, deps), /模型/)
  mode = 'alias-correct'
  await generateTaskTitleText(aliasAgent, { agentId: 'claude', model: 'haiku' }, 'fixture', new AbortController().signal, deps)
  mode = 'success'
  await assert.rejects(generateTaskTitleText(agent('claude'), { ...config, agentId: 'claude' }, 'fixture', new AbortController().signal, {
    ...deps, prepareClaudeSource: async () => ({ model: 'large', env: {}, settings: {}, args: [], redact: text => text, dispose: async () => {} })
  }), /模型/)

  mode = 'success'
  const controller = new AbortController()
  let finishPreparation!: (value: any) => void
  const before = madeSdk
  const pending = generateTaskTitleText(agent('claude'), { ...config, agentId: 'claude' }, 'fixture', controller.signal, {
    ...deps, prepareClaudeSource: () => new Promise(resolve => { finishPreparation = resolve })
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, /取消/)
  finishPreparation({ model: 'small', env: {}, settings: {}, dispose: async () => { sourceClosed++ }, redact: (text: string) => text, args: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(madeSdk, before, 'late preparation cannot launch a canceled SDK')
  assert.equal(sourceClosed, 1, 'late acquired source runtime is cleaned')
  const image = { kind: 'image' as const, path: join(root, 'attached.png'), name: 'attached.png', mime: 'image/png' }
  const vision = agent('codex'); vision.models[0].imageInput = true
  requests.length = 0
  await generateTaskTitleText(vision, config, 'user and initial output', new AbortController().signal, deps, [image])
  assert.deepEqual(requests.find(row => row.method === 'turn/start').params.input[1], { type: 'localImage', path: image.path })
  vision.models[0].imageInput = false
  requests.length = 0
  await assert.rejects(generateTaskTitleText(vision, config, 'text only', new AbortController().signal, deps, [image]), /图片/)
  assert.equal(requests.length, 0, 'a text-only selection is rejected before starting a native call')
  vision.models[0].imageInput = true
  await writeFile(catalog, JSON.stringify({ models: [{ slug: 'small', input_modalities: ['text'] }] }))
  requests.length = 0
  await assert.rejects(generateTaskTitleText(vision, config, 'native text-only catalog', new AbortController().signal, deps, [image]))
  assert.equal(requests.some(row => row.method === 'turn/start'), false, 'native image rejection never submits a reduced text-only prompt')
  const claudeVision = agent('claude'); claudeVision.models[0].imageInput = true
  await generateTaskTitleText(claudeVision, { ...config, agentId: 'claude' }, 'with image', new AbortController().signal, deps, [image])
  assert.deepEqual(sent.attachments, [image], 'Claude image bytes are handled by the existing SDK worker')
  claudeVision.models[0].imageInput = false
  const madeBeforeRejection = madeSdk
  await assert.rejects(generateTaskTitleText(claudeVision, { ...config, agentId: 'claude' }, 'text only', new AbortController().signal, deps, [image]), /图片/)
  assert.equal(madeSdk, madeBeforeRejection)
  mode = 'success'
  let qoderLaunch: any
  const qoderVision = agent('qoder'); qoderVision.models[0].imageInput = true
  const qoderDeps = { ...deps, createQoder: (launch: any) => { qoderLaunch = launch; return new Sdk() as any } }
  await generateTaskTitleText(qoderVision, { agentId: 'qoder', model: 'small', effort: 'high' }, 'qoder input', new AbortController().signal, { ...qoderDeps, systemPrompt: 'SYSTEM_FIXTURE' }, [image])
  assert.equal(qoderLaunch.options.systemPrompt.append, 'SYSTEM_FIXTURE')
  assert.equal(qoderLaunch.options.extraArgs['reasoning-effort'], 'high')
  assert.deepEqual(qoderLaunch.options.tools, [])
  assert.deepEqual(qoderLaunch.options.mcpServers, {})
  assert.equal(qoderLaunch.options.strictMcpConfig, true)
  assert.deepEqual(sent.attachments, [image])
  mode = 'sdk-tool'
  await assert.rejects(generateTaskTitleText(qoderVision, { agentId: 'qoder', model: 'small' }, 'forbidden tools', new AbortController().signal, qoderDeps), /工具/)
  console.log('PASS title runtime exact model, native provider reuse, no tools, low effort, timeout, cancellation and owned cleanup')
} finally {
  configureCodexAppServerArgsProvider()
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome
  await rm(root, { recursive: true, force: true })
}
