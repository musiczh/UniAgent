import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import * as TOML from '@iarna/toml'
import { generateTaskTitleText } from '../src/main/taskTitleRuntime'
import { deepseekHostTitlePlugin, generateDeepSeekTitle } from '../src/main/taskTitleDeepSeek'
import { generateAcpTitle } from '../src/main/taskTitleAcp'
import { ACPRemoteError } from '../src/main/acp/acpConnection'
import { buildQuickReplyPrompt, parseQuickReplies, QUICK_REPLY_SCHEMA } from '../src/shared/quickReplies'
import type { AgentDef } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'title-native-runtime-'))
const previous = { GROK_HOME: process.env.GROK_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, UNIAGENT_USER_DATA: process.env.UNIAGENT_USER_DATA }
const subscriptionError = '403 Your current subscription does not have access to Kimi Code right now.'
let mode = 'success', options: any, created = 0, closed = 0, pendingReject: ((error: Error) => void) | undefined, imageCapability = false
const requests: any[] = []
class Connection extends EventEmitter {
  error?: Error
  titleOnly = false
  state = { sessionId: 'title-owned', configOptions: [
    { id: 'model', type: 'select', category: 'model', currentValue: 'other', options: [{ value: 'small' }, { value: 'other' }] },
    { id: 'thinking', type: 'select', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }, { value: 'fast' }] }
  ] }
  async initialize() {
    options.validateInitialize?.({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: imageCapability } } })
    if (options.providerLabel === 'kimi') {
      const configuration = TOML.parse(await readFile(join(options.env.KIMI_CODE_HOME, 'config.toml'), 'utf8')) as any
      assert.deepEqual(Object.keys(configuration.models), ['small'])
      assert.deepEqual(Object.keys(configuration.providers), ['native'])
      assert.equal(configuration.mcp, undefined)
      assert.equal(configuration.hooks, undefined)
      assert.equal(options.args[0], '--agent-file')
      assert.equal(options.args[2], 'acp')
      assert.match(await readFile(options.args[1], 'utf8'), /^---\nname: uniagent-title\ndescription: Task title generation\ntools: \[\]/)
      this.titleOnly = (await readFile(options.args[1], 'utf8')).includes('JSON task title')
      assert.deepEqual(JSON.parse(await readFile(join(options.env.KIMI_CODE_HOME, 'credentials/kimi-code.json'), 'utf8')), { fixture: true })
    } else {
      const configuration = TOML.parse(await readFile(join(options.env.GROK_HOME, 'config.toml'), 'utf8')) as any
      assert.equal(configuration.models.default, 'small')
      assert.equal(configuration.model.small.base_url, 'http://fixture.invalid')
      assert.equal(configuration.hooks, undefined)
      assert.equal(configuration.managed_mcps.enabled, false)
    }
    return { protocolVersion: 1, agentCapabilities: {} }
  }
  async request(method: string, params: any) {
    requests.push({ method, params })
    if (method === 'session/new') {
      assert.deepEqual(params.mcpServers, [])
      if (options.providerLabel === 'grok') {
        const profile = params._meta.agentProfile
        assert.equal(profile.injectDefaultTools, false)
        assert.deepEqual(profile.toolConfig.tools, [{ id: 'GrokBuild:read_file' }])
        assert.ok(profile.disallowedTools.includes('read_file'))
        assert.ok(profile.disallowedTools.includes('Agent'))
      }
      return structuredClone(this.state)
    }
    if (method === 'session/set_config_option') {
      if (mode !== 'unconfirmed') this.state.configOptions.find(option => option.id === params.configId)!.currentValue = params.value
      return structuredClone(this.state)
    }
    if (method === 'session/prompt') {
      if (mode === 'subscription') throw new ACPRemoteError('wrapped ACP error', -32603, subscriptionError)
      if (mode === 'hang') return new Promise((_resolve, reject) => { pendingReject = reject })
      if (mode === 'request') this.emit('request', { id: 1, method: 'session/request_permission' })
      if (mode === 'tool') this.emit('notification', { method: 'session/update', params: { sessionId: 'title-owned', update: { sessionUpdate: 'tool_call' } } })
      const text = mode === 'large' ? 'x'.repeat(4097) : mode === 'replies' && !this.titleOnly
        ? '{"replies":[{"label":"继续","text":"按方案继续实施。"}]}' : '{"title":"生成任务标题","description":"任务描述夹具","needsClarification":false}'
      this.emit('notification', { method: 'session/update', params: { sessionId: 'title-owned', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
      if (this.error) throw this.error
      return { stopReason: mode === 'incomplete' ? 'max_tokens' : 'end_turn', _meta: { usage: { inputTokens: 8, outputTokens: 3 } } }
    }
    throw new Error('unexpected method')
  }
  notify() {}
  respondErrorAndFail(_id: any, _code: any, _message: any, error: Error) { this.error = error }
  protocolViolation(error: Error) { this.error = error }
  async closeAndWait() { closed++; pendingReject?.(new Error('closed')); pendingReject = undefined }
}

const deps = { createAcp: (value: any) => { options = value; created++; return new Connection() as any }, timeoutMs: 2000 }
const agent = (id: string): AgentDef => ({ id, adapter: id, name: id, bin: '/fixture', installed: true, capabilities: { modelSelect: true, startupSystemPrompt: true },
  models: [{ id: 'small', label: 'Small', imageInput: true, efforts: id === 'kimi' ? [] : ['low', 'high'], thinkingOptions: id === 'kimi' ? ['low', 'fast'] : undefined }] } as AgentDef)
try {
  process.env.GROK_HOME = join(root, 'grok')
  process.env.UNIAGENT_USER_DATA = join(root, 'data')
  process.env.KIMI_CODE_HOME = join(root, 'kimi')
  await mkdir(process.env.GROK_HOME)
  await mkdir(join(process.env.KIMI_CODE_HOME, 'credentials'), { recursive: true })
  await writeFile(join(process.env.GROK_HOME, 'auth.json'), '{"fixture":true}', { mode: 0o600 })
  await writeFile(join(process.env.GROK_HOME, 'config.toml'), TOML.stringify({ model: { small: { base_url: 'http://fixture.invalid', api_key: 'fixture' }, other: {} }, hooks: { forbidden: {} } }))
  await writeFile(join(process.env.KIMI_CODE_HOME, 'credentials/kimi-code.json'), '{"fixture":true}', { mode: 0o600 })
  await writeFile(join(process.env.KIMI_CODE_HOME, 'config.toml'), TOML.stringify({ providers: { native: { type: 'kimi', api_key: 'fixture' }, unrelated: { type: 'other' } },
    models: { small: { provider: 'native', model: 'small' }, other: { provider: 'unrelated', model: 'other' } }, mcp: { forbidden: {} }, hooks: { forbidden: {} } }))
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
  const image = { kind: 'image' as const, path: join(root, 'image.png'), name: 'image.png', mime: 'image/png' }
  await writeFile(image.path, Buffer.from(imageData, 'base64'))
  for (const id of ['grok', 'kimi']) {
    const config = { agentId: id, model: 'small', ...(id === 'grok' ? { effort: 'high' as const } : { kimiThinking: 'fast' }) }
    mode = 'success'; requests.length = 0
    const usage: any[] = []
    assert.equal(JSON.parse(await generateTaskTitleText(agent(id), config, 'fixture title', new AbortController().signal, { ...deps, onUsage: value => usage.push(value) })).title, '生成任务标题')
    assert.equal(requests.find(request => request.method === 'session/prompt').params.sessionId, 'title-owned')
    assert.deepEqual(requests.filter(request => request.method === 'session/set_config_option').map(request => request.params.value), ['small', id === 'grok' ? 'high' : 'fast'])
    assert.deepEqual(usage, [{ inputTokens: 8, outputTokens: 3 }])
    mode = 'replies'
    assert.equal(parseQuickReplies(await generateTaskTitleText(agent(id), config, buildQuickReplyPrompt('实施功能', '已准备方案'), new AbortController().signal,
      { ...deps, outputSchema: QUICK_REPLY_SCHEMA }))[0].label, '继续', `${id} can return replies through the shared runtime`)
    const privateHome = options.env[id === 'grok' ? 'GROK_HOME' : 'KIMI_CODE_HOME']
    assert.notEqual(privateHome, process.env[id === 'grok' ? 'GROK_HOME' : 'KIMI_CODE_HOME'])
    await assert.rejects(readFile(join(privateHome, 'config.toml')), { code: 'ENOENT' })
    for (const failure of ['unconfirmed', 'tool', 'request', 'large', 'incomplete']) {
      mode = failure
      await assert.rejects(generateTaskTitleText(agent(id), config, 'reject invalid output', new AbortController().signal, deps))
    }
    if (id === 'kimi') {
      mode = 'subscription'
      await assert.rejects(generateTaskTitleText(agent(id), config, 'show native error', new AbortController().signal, deps), error => error instanceof Error && error.message === subscriptionError)
    }
    mode = 'hang'
    const controller = new AbortController()
    const pending = generateTaskTitleText(agent(id), config, 'cancel owned request', controller.signal, deps)
    while (!pendingReject) await new Promise(resolve => setTimeout(resolve, 1))
    controller.abort()
    await assert.rejects(pending, /取消/)
    mode = 'success'
  }
  assert.ok(closed >= created, 'all acquired isolated connections close')
  const kimiVision = agent('kimi'); kimiVision.models[0].imageInput = true
  imageCapability = true; requests.length = 0; mode = 'success'
  await generateTaskTitleText(kimiVision, { agentId: 'kimi', model: 'small', kimiThinking: 'fast' }, 'initial output and image', new AbortController().signal, deps, [image])
  assert.deepEqual(requests.find(row => row.method === 'session/prompt').params.prompt[1], { type: 'image', data: imageData, mimeType: 'image/png' })
  imageCapability = false; requests.length = 0
  await assert.rejects(generateTaskTitleText(kimiVision, { agentId: 'kimi', model: 'small' }, 'negotiated text only', new AbortController().signal, deps, [image]))
  assert.equal(requests.some(row => row.method === 'session/prompt'), false, 'ACP without image support rejects before submitting the prompt')

  const plugin = await import('data:text/javascript;base64,' + Buffer.from(deepseekHostTitlePlugin).toString('base64'))
  const calls: any[] = [], streams: any[] = [], usages: any[] = []
  let nativeMode = 'success', disposedStreams = 0
  const admitted: any[] = []
  const ctx: any = { attachments: { admitPromptContent: async (parts: any[]) => {
    admitted.push(parts)
    return parts.map(part => part.type === 'image' ? { type: 'image', attachment: { id: 'fixture-image', mediaType: part.mediaType } } : part)
  } }, llm: {
    resolveModelInfo: async () => ({ inputModalities: nativeMode === 'text-only' ? ['text'] : ['text', 'image'] }),
    prepareCall: async (config: any, signal: AbortSignal) => {
      calls.push(config)
      const resolved = nativeMode === 'wrong-route' ? { ...config, model: 'wrong' } : config
      return { config: resolved, stream: async function* (options: any) {
        streams.push(options); assert.equal(signal, options.signal)
        try {
          if (nativeMode === 'tool') yield { type: 'tool-call-delta', name: 'read_file' }
          yield { type: 'text-delta', text: '{"title":"原生标题","description":"任务描述夹具","needsClarification":false}' }
          yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } }
          if (nativeMode !== 'missing-finish') yield { type: 'finish', reason: { kind: 'stop' } }
        } finally { disposedStreams++ }
      } }
    }
  }, loader: { import: async (name: string) => {
    assert.equal(name, '@deepseek-ai/dsh-typert-protocol')
    return { TypertRemoteService: class { ctx: any; constructor(context: any, serviceKey: string, options: any) { this.ctx = context; assert.equal(options.namespace, 'uniagent-title'); context[serviceKey] = this } },
      Remote: (options: any) => (_method: any, context: any) => { assert.deepEqual(options, { mode: 'stream' }); context.addInitializer(() => {}) } }
  } } }
  await plugin.apply(ctx)
  const host = { stream: (_endpoint: string, args: any, signal: AbortSignal) => {
    assert.equal(_endpoint, 'uniagent-title/generate'); return ctx.uniagentTitle.generate(args.request, signal)
  }, close: () => { throw new Error('shared Host must remain alive') } } as any
  const config = { agentId: 'deepseek', model: '["official","small"]', effort: 'high' as const }
  assert.equal(JSON.parse(await generateDeepSeekTitle(config, 'title only', new AbortController().signal, async () => host, (input, output) => usages.push([input, output]))).title, '原生标题')
  assert.deepEqual(calls[0], { provider: 'official', model: 'small', reasoningEffort: 'high', maxTokens: 4096 })
  assert.deepEqual(streams[0].tools, [])
  assert.deepEqual(streams[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'title only' }] }])
  assert.deepEqual(usages, [[7, 2]])
  await generateDeepSeekTitle(config, 'system and user', new AbortController().signal, async () => host, () => {}, [], { systemPrompt: 'SYSTEM_FIXTURE' })
  assert.deepEqual(streams.at(-1).messages, [{ role: 'system', content: [{ type: 'text', text: 'SYSTEM_FIXTURE' }] }, { role: 'user', content: [{ type: 'text', text: 'system and user' }] }])
  await generateDeepSeekTitle(config, 'structured routing facts', new AbortController().signal, async () => host, () => {}, [], { maxOutputChars: 20000, maxTokens: 16384 })
  assert.equal(calls.at(-1).maxTokens, 16384, 'structured routing output has an explicit budget without changing ordinary title defaults')
  await assert.rejects(ctx.uniagentTitle.generate({ provider: 'official', model: 'small', prompt: 'invalid budget', maxTokens: 16385 }, new AbortController().signal).next(), /Invalid/)
  const deepseek: AgentDef = { ...agent('deepseek'), models: [{ id: config.model, label: 'Small', efforts: ['high'], imageInput: true }] }
  const largePrompt = '需求资料。'.repeat(26000)
  const generation = { deepseekHost: async () => host, maxInputBytes: 512 * 1024 }
  const beforeLarge = calls.length
  await assert.rejects(generateTaskTitleText(deepseek, config, largePrompt, new AbortController().signal, { deepseekHost: generation.deepseekHost }), /输入/)
  assert.equal(calls.length, beforeLarge, 'ordinary titles retain their 64 KB limit')
  await assert.rejects(generateTaskTitleText(deepseek, config, '   ', new AbortController().signal, generation), /输入/)
  await generateTaskTitleText(deepseek, config, 'x'.repeat(64 * 1024), new AbortController().signal, { deepseekHost: generation.deepseekHost })
  await generateTaskTitleText(deepseek, config, largePrompt, new AbortController().signal, generation)
  assert.ok(streams.at(-1).messages.find((message: any) => message.role === 'user').content[0].text === largePrompt, 'large curation materials reach the Host unchanged')
  await generateTaskTitleText(deepseek, config, 'x'.repeat(512 * 1024), new AbortController().signal, generation)
  await assert.rejects(generateTaskTitleText(deepseek, config, 'x'.repeat(512 * 1024 + 1), new AbortController().signal, generation), /输入/)
  await assert.rejects(ctx.uniagentTitle.generate({ provider: 'official', model: 'small', prompt: 'x'.repeat(512 * 1024 + 1) }, new AbortController().signal).next(), /Invalid/)
  const streamsBeforeFailures = disposedStreams
  for (const failure of ['wrong-route', 'tool', 'missing-finish']) {
    nativeMode = failure
    await assert.rejects(generateDeepSeekTitle(config, 'reject output', new AbortController().signal, async () => host, () => {}))
  }
  assert.equal(disposedStreams - streamsBeforeFailures, 2, 'tool and unfinished output release their streams; a rejected route never creates one')
  nativeMode = 'success'
  await generateDeepSeekTitle(config, 'initial output and image', new AbortController().signal, async () => host, () => {}, [image])
  assert.deepEqual(admitted[0][1], { type: 'image', data: imageData, mediaType: 'image/png' })
  assert.deepEqual(streams.at(-1).messages[0].content[1], { type: 'image', attachment: { id: 'fixture-image', mediaType: 'image/png' } }, 'Host uses official attachment admission before sending the LLM image block')
  nativeMode = 'text-only'
  await assert.rejects(generateDeepSeekTitle(config, 'text-only route', new AbortController().signal, async () => host, () => {}, [image]), /实际不支持图片/)
  assert.equal(admitted.length, 1, 'unsupported DeepSeek route never admits or forwards images')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(ctx.uniagentTitle.generate({ provider: 'official', model: 'small', prompt: 'cancel' }, controller.signal).next())
  await assert.rejects(ctx.uniagentTitle.generate({ provider: 'official', model: 'small', prompt: 'invalid', tools: ['read_file'] }, new AbortController().signal).next(), /Invalid/)
  console.log('PASS native title paths: explicit models/effort, empty tools, isolated credentials/config, result bounds, cancellation and shared Host preservation')
} finally {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(root, { recursive: true, force: true })
}

// Opt-in qualification with the installed CLI and a loopback model fixture.
// Real-provider/model acceptance remains in cdp-task-title-generation.mjs.
if (process.env.UNIAGENT_TITLE_GROK_NATIVE === '1') {
  const directory = await mkdtemp(join(tmpdir(), 'title-grok-tools-'))
  const native = join(directory, 'grok')
  await mkdir(native)
  const previous = { GROK_HOME: process.env.GROK_HOME, XAI_API_KEY: process.env.XAI_API_KEY, UNIAGENT_USER_DATA: process.env.UNIAGENT_USER_DATA }
  const captures: Array<{ model: string; tools: string[] }> = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    let body: any
    try { body = raw ? JSON.parse(raw) : {} }
    catch { response.writeHead(400); response.end('invalid fixture request'); return }
    if (!body.messages) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'grok-4.6', context_window: 200000 }] }))
      return
    }
    if (request.headers.authorization !== 'Bearer fixture') { response.writeHead(403); response.end('fixture credential required'); return }
    captures.push({ model: body.model, tools: (body.tools || []).map((tool: any) => tool.function?.name || tool.name) })
    const delta = { role: 'assistant', content: '{"title":"工具隔离验证","description":"任务描述夹具","needsClarification":false}' }
    const usage = { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
    response.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
    response.end(body.stream ? 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6', choices: [{ index: 0, delta, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n'
      : JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'grok-4.6', choices: [{ index: 0, message: delta, finish_reason: 'stop' }], usage }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/v1'
  await writeFile(join(native, 'config.toml'), TOML.stringify({ cli: { auto_update: false, use_leader: false },
    features: { managed_config: false, feedback: false, telemetry: false }, managed_mcps: { enabled: false }, models: { default: 'grok-4.6' },
    model: { 'grok-4.6': { model: 'grok-4.6', base_url: base, api_key: 'fixture', api_backend: 'chat_completions', agent_type: 'grok-build', max_retries: 0, context_window: 200000 } },
    endpoints: { models_base_url: base, xai_api_base_url: base, cli_chat_proxy_base_url: base } }))
  process.env.GROK_HOME = native
  process.env.XAI_API_KEY = 'fixture'
  process.env.UNIAGENT_USER_DATA = join(directory, 'data')
  try {
    const agent = { id: 'grok', name: 'Grok', adapter: 'grok', bin: process.env.UNIAGENT_TITLE_GROK_BIN || join(homedir(), '.grok/bin/grok') } as AgentDef
    const text = await generateAcpTitle(agent, { agentId: 'grok', model: 'grok-4.6' }, 'Only return the requested task title JSON.', new AbortController().signal, { timeoutMs: 30_000 }, () => {})
    assert.equal(JSON.parse(text).title, '工具隔离验证')
    assert.ok(captures.some(request => request.tools.length === 0), 'the real CLI title request advertises no tools')
    assert.ok(captures.every(request => request.tools.length === 0 || request.tools.length === 1 && request.tools[0] === 'session_title'), 'only native session-name housekeeping is separate from the empty title toolset')
    console.log('PASS installed Grok title tool isolation: ' + JSON.stringify(captures))
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(directory, { recursive: true, force: true })
  }
}
