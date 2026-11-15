import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { generateTaskTitleText, TASK_TITLE_SYSTEM_PROMPT } from '../src/main/taskTitleRuntime'
import { ACPConnection, ACPTimeoutError } from '../src/main/acp/acpConnection'
import { parseCodexConfig } from '../src/main/codexSourceConfig'
import { resolveTaskTitleConfig, taskTitleUnsupported } from '../src/shared/taskTitle'
import { buildQuickReplyPrompt } from '../src/shared/quickReplies'
import type { AgentDef } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'task-title-traex-'))
const previousHome = process.env.TRAE_HOME
process.env.TRAE_HOME = join(root, 'native')
await mkdir(join(process.env.TRAE_HOME, 'cli'), { recursive: true })
await writeFile(join(process.env.TRAE_HOME, 'cli', 'auth.json'), '{"fixture":"traex-auth"}')
await writeFile(join(process.env.TRAE_HOME, 'cli', 'models_cache.json'), '{"models":[{"slug":"Native-Small","config_name":"native-small"}]}')
await writeFile(join(process.env.TRAE_HOME, 'traecli.toml'), 'model_provider = "trae"\n[hooks]\nforbidden = true\n[mcp_servers.forbidden]\ncommand = "/do-not-start"\n')
const image = join(root, 'image.png')
await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
const agent = { id: 'traex', name: 'TraeX', adapter: 'traex', bin: '/fixture/traex', installed: true,
  models: [{ id: 'Native-Small', label: 'Native Small', efforts: ['low', 'high'], imageInput: true }],
  capabilities: { modelSelect: true, startupSystemPrompt: true } } as AgentDef
const config = { agentId: 'traex', model: 'Native-Small', effort: 'high' as const }
const requests: { method: string; params: any }[] = []
let launch: any, mode = 'success', closed = 0
class Connection extends EventEmitter {
  error?: Error
  rejectPending?: (error: Error) => void
  async initialize() {
    const native = parseCodexConfig(await readFile(join(launch.env.TRAE_HOME, 'traecli.toml'), 'utf8'))
    assert.equal(native.model_provider, 'trae')
    assert.deepEqual(native.model_tool_modes, { 'native-small': 'direct' })
    assert.equal(native.model_catalog_json, join(launch.env.TRAE_HOME, 'models.json'))
    assert.equal(native.hooks, undefined)
    assert.equal(native.mcp_servers, undefined)
    assert.deepEqual(JSON.parse(await readFile(join(launch.env.TRAE_HOME, 'cli', 'auth.json'), 'utf8')), { fixture: 'traex-auth' })
    assert.deepEqual(JSON.parse(await readFile(native.model_catalog_json, 'utf8')), { models: [{ slug: 'Native-Small', config_name: 'native-small' }] })
    const overrides = parseCodexConfig(launch.args.filter((_arg: string, index: number) => launch.args[index - 1] === '-c').join('\n'))
    assert.equal(overrides.model, 'native-small')
    assert.equal(overrides.model_reasoning_effort, 'high', 'TraeX ACP configures effort through its documented startup flag')
    assert.equal(overrides.default_permissions, ':read-only')
    assert.equal(overrides.developer_instructions, TASK_TITLE_SYSTEM_PROMPT)
    assert.equal(overrides.features.computer_use, false)
    assert.equal(overrides.features.browser_use, false)
    assert.equal(overrides.features.plugins, false)
    const denied = launch.args.filter((_arg: string, index: number) => launch.args[index - 1] === '--disallowed-tool')
    for (const name of ['Read', 'Write', 'Bash', 'Agent', 'AskUserQuestion', 'exec', 'wait', 'list_mcp_resources', 'multi_agent_v1', 'tool_search']) assert.ok(denied.includes(name), name)
    assert.ok(launch.args.includes('acp') && launch.args.includes('serve'))
    launch.validateInitialize({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } })
  }
  async request(method: string, params: any, timeoutMs?: number): Promise<any> {
    requests.push({ method, params })
    if (mode === 'phase-timeout' && method === 'session/new') throw new ACPTimeoutError('TraeX ACP session/new 超时')
    if (mode === 'slow-new' && method === 'session/new' || mode === 'combined-slow' && method === 'session/set_model' || mode === 'slow-config' && method === 'session/set_config_option') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ACPTimeoutError('TraeX ACP ' + method + ' 超时')), timeoutMs ?? 5)
        setTimeout(() => { clearTimeout(timer); resolve() }, 10)
      })
    }
    if (method === 'session/new' && mode.startsWith('combined')) return { sessionId: 'title', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'native-small', options: [{ value: 'native-small' }] }
    ], models: { currentModelId: 'native-small', availableModels: [{ modelId: mode === 'combined-missing' ? 'native-small/low' : 'native-small/high' }] } }
    if (method === 'session/set_model') {
      assert.deepEqual(params, { sessionId: 'title', modelId: 'native-small/high' })
      if (mode === 'combined-failed') throw new Error('模型选择失败')
      return mode === 'combined-invalid' ? null : {}
    }
    if (method === 'session/new') return { sessionId: 'title', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: ['wrong-model','slow-config'].includes(mode) ? 'other' : 'native-small', options: [{ value: 'native-small' }] },
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] }
    ] }
    if (method === 'session/set_config_option') return { configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: mode === 'slow-config' ? 'native-small' : 'other', options: [{ value: 'native-small' }] },
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] }
    ] }
    if (method === 'session/prompt') {
      if (mode === 'hang') return new Promise((_resolve, reject) => { this.rejectPending = reject })
      if (mode === 'tool') this.emit('notification', { method: 'session/update', params: { sessionId: 'title', update: { sessionUpdate: 'tool_call' } } })
      if (mode === 'interaction') this.emit('request', { id: 1, method: 'session/request_permission' })
      if (this.error) throw this.error
      const text = mode === 'replies' ? '{"replies":[{"label":"继续","text":"按方案继续修复。"}]}'
        : '{"title":"标题生成","description":"恢复辅助生成能力","needsClarification":false}'
      this.emit('notification', { method: 'session/update', params: { sessionId: 'title', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
      return { stopReason: 'end_turn', _meta: { usage: { inputTokens: 8, outputTokens: 4 } } }
    }
    throw new Error('unexpected method ' + method)
  }
  notify() {}
  respondErrorAndFail(_id: any, _code: any, _message: any, error: Error) { this.error = error }
  protocolViolation(error: Error) { this.error = error }
  async closeAndWait() { closed++; this.rejectPending?.(new Error('closed')) }
}
const deps = { createAcp: (options: any) => { launch = options; return new Connection() as any }, timeoutMs: 2000 }
try {
  assert.equal(taskTitleUnsupported(agent), undefined, 'ready TraeX is selectable')
  assert.equal(resolveTaskTitleConfig({ enabled: true, ...config }, [agent]).enabled, true)
  const usage: any[] = []
  const result = await generateTaskTitleText(agent, config, 'fixture', new AbortController().signal,
    { ...deps, onUsage: value => usage.push(value) }, [{ kind: 'image', path: image, name: 'image.png' }])
  assert.equal(JSON.parse(result).title, '标题生成')
  assert.deepEqual(requests.find(request => request.method === 'session/new')!.params.mcpServers, [])
  assert.ok(requests.find(request => request.method === 'session/prompt')!.params.prompt.some((block: any) => block.type === 'image'))
  assert.deepEqual(usage, [{ inputTokens: 8, outputTokens: 4 }])
  assert.notEqual(launch.env.TRAE_HOME, process.env.TRAE_HOME)
  await assert.rejects(readFile(join(launch.env.TRAE_HOME, 'traecli.toml')), { code: 'ENOENT' })
  mode = 'replies'
  const replies = await generateTaskTitleText(agent, config, buildQuickReplyPrompt('修复标题', '原因已定位'), new AbortController().signal, deps)
  assert.equal(JSON.parse(replies).replies[0].label, '继续')
  mode = 'combined'
  assert.equal(JSON.parse(await generateTaskTitleText(agent, config, 'fixture', new AbortController().signal, deps)).title, '标题生成')
  assert.ok(requests.some(request => request.method === 'session/set_model' && request.params.modelId === 'native-small/high'))
  for (const failure of ['combined-missing', 'combined-failed', 'combined-invalid']) {
    mode = failure
    await assert.rejects(generateTaskTitleText(agent, config, 'fixture', new AbortController().signal, deps), /模型|思考/)
  }
  mode = 'wrong-model'
  await assert.rejects(generateTaskTitleText(agent, config, 'fixture', new AbortController().signal, deps), /模型/)
  for (const failure of ['tool', 'interaction']) {
    mode = failure
    await assert.rejects(generateTaskTitleText(agent, config, 'fixture', new AbortController().signal, deps), /工具/)
  }
  for (const slow of ['slow-new','combined-slow','slow-config']) {
    mode = slow
    assert.equal(JSON.parse(await generateTaskTitleText(agent, config, 'slow configuration', new AbortController().signal, deps)).title, '标题生成', slow + ' respects the caller timeout through configuration')
  }
  mode = 'phase-timeout'
  await assert.rejects(generateTaskTitleText(agent, config, 'show timeout phase', new AbortController().signal, deps), /TraeX ACP session\/new 超时/)
  mode = 'hang'
  await assert.rejects(generateTaskTitleText(agent, config, 'fixture', new AbortController().signal, { ...deps, timeoutMs: 30 }), /超时/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(generateTaskTitleText(agent, config, 'fixture', cancelled.signal, deps), /取消/)
  assert.ok(closed >= 5)
  console.log('PASS TraeX title selection, native ACP isolation, tool denial, exact model/effort, images, usage, replies and cancellation')
} finally {
  if (previousHome === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = previousHome
  await rm(root, { recursive: true, force: true })
}

// Qualify the installed CLI without a real account or external model request.
if (process.env.UNIAGENT_TITLE_TRAEX_NATIVE === '1') {
  const directory = await mkdtemp(join(tmpdir(), 'title-traex-tools-'))
  const native = join(directory, 'trae')
  await mkdir(join(native, 'cli'), { recursive: true })
  await writeFile(join(native, 'cli', 'auth.json'), '{"OPENAI_API_KEY":"fixture"}')
  const nativeCatalog = JSON.parse(await readFile(join(previousHome || join(homedir(), '.trae'), 'cli', 'models_cache.json'), 'utf8'))
  // Bind the isolated catalog to its actual fixture Provider, retaining the
  // installed catalog's model, effort and harness metadata. Native selectors
  // choose this declared Provider; no real account or external request is used.
  nativeCatalog.models = nativeCatalog.models.map((model: any) => ({ ...model, model_provider_id: 'fixture' }))
  await writeFile(join(native, 'cli', 'models_cache.json'), JSON.stringify(nativeCatalog))
  const captures: Array<{ model: string; effort?: string; tools: string[] }> = []
  const acknowledged: Array<{ model?: string; effort?: string }> = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (!request.url?.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":[]}')
      return
    }
    captures.push({ model: body.model, effort: body.reasoning?.effort, tools: (body.tools || []).map((tool: any) => tool.name || tool.function?.name || tool.type) })
    const text = '{"title":"工具隔离验证","description":"验证标题请求不携带工具","needsClarification":false}'
    const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [type, data] of [
      ['response.created', { response: { id: 'resp-fixture', object: 'response', status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
      ['response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
      ['response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text }],
      ['response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response: { id: 'resp-fixture', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } }]
    ] as const) response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/v1'
  await writeFile(join(native, 'traecli.toml'), 'model_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url=' + JSON.stringify(base) + '\nwire_api="responses"\nexperimental_bearer_token="fixture"\nrequires_openai_auth=false\nsupports_websockets=false\n')
  process.env.TRAE_HOME = native
  try {
    for (const model of ['DeepSeek-V4.1-Flash', 'GPT-5.6-Luna']) {
      const selected = { ...agent, bin: process.env.UNIAGENT_TITLE_TRAEX_BIN || join(homedir(), '.local/bin/traex'), models: [{ id: model, label: model, efforts: ['low'] }] } as AgentDef
      const output = await generateTaskTitleText(selected, { agentId: 'traex', model, effort: 'low' }, 'Return only the requested title JSON.', new AbortController().signal, {
        createAcp: options => {
          const connection = new ACPConnection(options)
          const request = connection.request.bind(connection)
          connection.request = async (method, params) => {
            const result = await request<any>(method, params)
            if (method === 'session/set_model') {
              assert.deepEqual(result, {}, 'official session/set_model acknowledges the advertised selector with an empty object')
              acknowledged.push({ model: String((params as any).modelId).replace(/\/low$/, ''), effort: 'low' })
            } else if (method === 'session/new' || method === 'session/set_config_option') acknowledged.push({
              model: result.configOptions?.find((option: any) => option.category === 'model')?.currentValue,
              effort: result.configOptions?.find((option: any) => option.category === 'thought_level')?.currentValue
            })
            return result
          }
          return connection
        }
      })
      assert.equal(JSON.parse(output).title, '工具隔离验证')
      const declared = nativeCatalog.models.find((entry: any) => entry.slug === model)
      assert.equal(captures.at(-1)?.model, declared.slug, 'the custom Provider receives the selected catalog model slug')
      assert.equal(captures.at(-1)?.effort, 'low', 'the installed CLI model request uses the explicitly selected effort')
      assert.deepEqual(captures.at(-1)?.tools, [], 'the installed CLI title request advertises no tools')
      assert.deepEqual(acknowledged.at(-1), { model: declared.config_name, effort: 'low' }, 'native ACP selects the canonical model/effort combination; the HTTP request verifies its catalog model and effort')
    }
    console.log('PASS installed TraeX tool isolation: ' + JSON.stringify(captures))
  } finally {
    if (previousHome === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = previousHome
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}
