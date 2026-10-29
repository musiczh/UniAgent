import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ClaudeSourceService, validateClaudeSource } from '../src/main/claudeSourceService'
import { codexSourceCatalogModel } from '../src/main/codexSourceService'
import { configureClaudeSourceRuntime, createClaudeSourceRuntime, prepareClaudeSourceRuntime } from '../src/main/claudeSourceRuntime'
import { ModelCredentials, kimiCredentialCandidates } from '../src/main/modelCredentials'
import { testClaudeConnection } from '../src/main/claudeSourceProbe'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import { CLAUDE_SOURCE_PRESETS, claudeSourceEffort, claudeSourceUsesAuthToken } from '../src/shared/claudeSources'
import type { CodexSourceInput } from '../src/shared/codexSources'
import type { SessionConfig } from '../src/shared/types'
import { decryptLocalSecret, encryptLocalSecret } from '../src/main/localSecretStore'
import { fetchSourceModels } from '../src/main/codexSourceModels'

const fixture = await mkdtemp(join(tmpdir(), 'ua-claude-source-test-'))
process.env.UNIAGENT_USER_DATA = fixture
const source: CodexSourceInput = { ...CLAUDE_SOURCE_PRESETS['kimi-code'], preset: 'kimi-code', enabled: true, models: ['k3'], apiKey: 'fixture-kimi-secret' }
const deepseek: CodexSourceInput = { ...CLAUDE_SOURCE_PRESETS.deepseek, preset: 'deepseek', enabled: true, models: ['deepseek-flash'], apiKey: 'fixture-deepseek-secret' }
const mimo: CodexSourceInput = { ...CLAUDE_SOURCE_PRESETS.mimo, preset: 'mimo', enabled: true, models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], apiKey: 'fixture-mimo-secret' }
const config = (input: CodexSourceInput): SessionConfig => ({ agentId: 'claude', workdir: fixture, permissionMode: 'full-access',
  model: codexModelKey(input.models[0], { kind: 'third-party', sourceId: input.id }) })
let checks = 0
const check = (label: string): void => { checks++; console.log('✓ ' + label) }
try {
  for (const input of [null, {}, [], { ...source, preset: 'kimi-api' }, { ...source, preset: '__proto__' }, { ...source, id: 'deepseek' },
    { ...source, preset: 'glm' }, { ...mimo, preset: 'glm' }, { ...mimo, preset: 'kimi-api' }, { ...mimo, id: 'glm' },
    { ...source, enabled: 'yes' }, { ...source, baseUrl: '' }, { ...source, baseUrl: 'http://evil.example' }, { ...source, baseUrl: 'https://key@host' },
    { ...source, baseUrl: 'https://host?key=value' }, { ...source, baseUrl: 'https://host/#token' }, { ...source, baseUrl: 'https://host/\n' },
    { ...source, baseUrl: 'https://host/' + 'a'.repeat(2048) }, { ...source, apiKey: 'key\nsecret' }, { ...source, apiKey: '密钥' },
    { ...source, apiKey: 'x'.repeat(8193) }, { ...source, models: [] }, { ...source, models: ['same', 'same'] },
    { ...source, models: ['bad model'] }, { ...source, models: ['x'.repeat(121)] }, { ...source, models: Array.from({ length: 101 }, (_, i) => `m${i}`) }]) {
    assert.throws(() => validateClaudeSource(input))
  }
  assert.equal(validateClaudeSource({ ...source, apiKey: ' x ', baseUrl: source.baseUrl + '/' }).apiKey, 'x')
  assert.equal(validateClaudeSource({ ...source, models: Array.from({ length: 100 }, (_, i) => `m${i}`), apiKey: 'x'.repeat(8192) }).models.length, 100)
  assert.deepEqual(validateClaudeSource({ id: 'mimo', preset: 'mimo', enabled: true, baseUrl: 'https://api.xiaomimimo.com/anthropic/', models: ['mimo-v2.6-pro'], apiKey: ' fixture-key ' }), {
    id: 'mimo', preset: 'mimo', enabled: true, baseUrl: 'https://api.xiaomimimo.com/anthropic', models: ['mimo-v2.6-pro'], apiKey: 'fixture-key'
  })
  assert.deepEqual(validateClaudeSource({ id: 'mimo', preset: 'mimo-token-plan', enabled: true, baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', models: ['mimo-v2.6-pro'], apiKey: 'tp-key' }), {
    id: 'mimo', preset: 'mimo-token-plan', enabled: true, baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', models: ['mimo-v2.6-pro'], apiKey: 'tp-key'
  })
  assert.equal(CLAUDE_SOURCE_PRESETS.mimo.baseUrl, 'https://api.xiaomimimo.com/anthropic', 'Claude Code 使用 Anthropic 兼容入口')
  assert.equal(CLAUDE_SOURCE_PRESETS['mimo-token-plan'].baseUrl, 'https://token-plan-cn.xiaomimimo.com/anthropic', 'Token Plan 使用独立的 Anthropic 兼容入口')
  assert.deepEqual(CLAUDE_SOURCE_PRESETS.mimo.models, ['mimo-v2.6-pro', 'mimo-v2.6-flash'])
  assert.equal(claudeSourceUsesAuthToken('mimo'), true, 'MiMo 使用 ANTHROPIC_AUTH_TOKEN/Bearer')
  assert.equal(claudeSourceUsesAuthToken('mimo-token-plan'), true, 'MiMo Token Plan 同样使用 Bearer')
  assert.equal(claudeSourceUsesAuthToken('deepseek'), true)
  assert.equal(claudeSourceUsesAuthToken('kimi-code'), false, 'Kimi Code 使用 x-api-key/ANTHROPIC_API_KEY')
  check('小米 MiMo 输入校验、Anthropic 兼容地址、模型清单与认证方式')

  const service = new ClaudeSourceService()
  await service.start()
  assert.deepEqual(service.snapshot().sources, [])
  await assert.rejects(service.save({ ...source, apiKey: '' }), /API Key/)
  await Promise.all([service.save(source), service.save(deepseek)])
  assert.equal(service.snapshot().sources.length, 2)
  const file = join(fixture, 'claude-sources/settings.json')
  const raw = await readFile(file, 'utf8')
  assert.ok(!raw.includes(source.apiKey!) && !raw.includes(deepseek.apiKey!))
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(join(fixture, 'credentials/key'))).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify(service.snapshot()).includes('encryptedKey'))
  const key = (JSON.parse(raw).sources.find((item: any) => item.id === 'kimi')).encryptedKey
  assert.equal(decryptLocalSecret(key), source.apiKey, 'async and existing sync stores interoperate')
  const restored = new ClaudeSourceService(); await restored.start()
  assert.equal((await restored.connection(config(source))).apiKey, source.apiKey)
  await service.save({ ...source, apiKey: undefined, models: ['k3', 'k3-256k'] })
  assert.equal((await service.connection(config(source))).apiKey, source.apiKey)
  await assert.rejects(service.save({ ...source, apiKey: undefined, baseUrl: 'https://other.example' }), /重新填写/)
  assert.equal(service.snapshot().sources.length, 2)
  check('并发保存、加密落盘、文件权限、重载、留空保留与变更地址隔离')

  const native = { id: 'sonnet', label: 'Sonnet', efforts: [] }
  assert.equal(service.mergeModels([native])[0], native)
  for (const model of service.mergeModels([])) {
    assert.deepEqual(model.efforts, ['low', 'high', 'max'], 'known third-party models must expose actual effort controls')
    assert.equal(model.defaultEffort, 'high')
    assert.ok((model.contextWindow ?? 0) > 0, '第三方模型必须带上下文窗口，供负载计量显示总量')
  }
  assert.equal(service.mergeModels([]).find(model => model.id === codexModelKey('k3-256k', { kind: 'third-party', sourceId: 'kimi' }))?.contextWindow,
    codexSourceCatalogModel('k3-256k', 'kimi-code').context_window, 'Claude 端上下文窗口必须与 Codex 模型目录同源')
  for (const model of ['k3', 'k3-256k', 'kimi-for-coding']) {
    assert.deepEqual(claudeSourceEffort(model, 'kimi-code').efforts, ['low', 'high', 'max'])
  }
  assert.equal(claudeSourceEffort('kimi-for-coding', 'kimi-code').defaultEffort, 'max')
  for (const model of ['kimi-for-coding-highspeed', 'custom-model', 'deepseek-flash']) {
    assert.deepEqual(claudeSourceEffort(model, 'kimi-code').efforts, [], 'do not invent effort support for unknown or fixed-thinking models')
  }
  assert.deepEqual(claudeSourceEffort('deepseek-v4-pro', 'deepseek').efforts, ['low', 'high', 'max'])
  for (const model of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-custom']) {
    assert.deepEqual(claudeSourceEffort(model, 'mimo'), { efforts: ['off', 'high'], defaultEffort: 'high' },
      'MiMo 只有思考开关，档位必须暴露为 关闭/开启 两态而不是虚构强度')
    assert.deepEqual(claudeSourceEffort(model, 'mimo-token-plan'), { efforts: ['off', 'high'], defaultEffort: 'high' },
      'Token Plan 的思考能力与按量付费一致')
  }
  assert.equal(service.normalize(config(source)).modelSource?.sourceId, 'kimi')
  assert.throws(() => service.normalize({ ...config(source), modelSource: { kind: 'native' } }), /不匹配/)
  assert.throws(() => service.assertReady({ ...config(source), model: codexModelKey('missing', { kind: 'third-party', sourceId: 'kimi' }) }), /移除/)
  await service.save({ ...source, enabled: false, apiKey: undefined })
  assert.throws(() => service.assertReady(config(source)), /停用/)
  assert.equal(service.mergeModels([native]).length, 2)
  await service.save(source)
  configureClaudeSourceRuntime(value => service.connection(value))
  for (const effort of ['low', 'high', 'max', 'xhigh', undefined] as const) {
    const runtime = await prepareClaudeSourceRuntime({ ...config(source), effort })
    try {
      assert.equal(runtime!.env.CLAUDE_CODE_EFFORT_LEVEL, effort && effort !== 'xhigh' ? effort : 'high')
      assert.equal(runtime!.env.CLAUDE_CODE_EXTRA_BODY, undefined, 'Kimi 走档位通道，不得注入思考开关覆盖体')
    }
    finally { await runtime!.dispose() }
  }
  assert.equal(await prepareClaudeSourceRuntime({ ...config(source), model: 'sonnet' }), undefined)
  const runtimes = await Promise.all([prepareClaudeSourceRuntime(config(source)), prepareClaudeSourceRuntime(config(deepseek))])
  try {
    assert.notEqual(runtimes[0]!.args[1], runtimes[1]!.args[1])
    for (const [index, runtime] of runtimes.entries()) {
      const value = index ? deepseek : source
      const settings = JSON.parse(await readFile(runtime!.args[1], 'utf8'))
      assert.equal(settings.env.ANTHROPIC_BASE_URL, value.baseUrl)
      assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, '')
      assert.equal(settings.apiKeyHelper, '')
      assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, value.models[0])
      assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, value.models[0])
      assert.ok(!runtime!.args.join(' ').includes(value.apiKey!))
      assert.equal(runtime!.redact('error ' + value.apiKey), 'error [API Key]')
      assert.equal((await stat(runtime!.args[1])).mode & 0o777, 0o600)
    }
  } finally { await Promise.all(runtimes.map(runtime => runtime!.dispose())) }
  for (const runtime of runtimes) await assert.rejects(stat(runtime!.args[1]), { code: 'ENOENT' })
  check('模型列表、身份冲突、停用失败关闭、并发运行隔离、私有覆盖和清理')

  let reusable = [{ ...source, baseUrl: 'https://api.kimi.com/coding/v1' }]
  const credentials = new ModelCredentials({ codex: async () => reusable, claude: () => service.reusableSources(),
    deepseek: async () => ({ apiKey: deepseek.apiKey!, baseUrl: deepseek.baseUrl }), kimi: async () => [] })
  const list = await credentials.list('claude')
  assert.equal(list.length, 2)
  assert.ok(!JSON.stringify(list).includes(source.apiKey!))
  const selected = list.find(item => item.id === 'codex:kimi')!
  const copy = await credentials.resolve('claude', selected)
  assert.equal(copy.baseUrl, source.baseUrl)
  assert.equal(copy.apiKey, source.apiKey)
  assert.equal((await credentials.input('claude', { ...source, apiKey: undefined, credential: selected })).apiKey, source.apiKey)
  await assert.rejects(credentials.input('claude', { ...source, baseUrl: 'https://evil.example', credential: selected }), /官方接口/)
  reusable = [{ ...reusable[0], apiKey: 'new-fixture-key' }]
  await assert.rejects(credentials.resolve('claude', selected), /已变化/)
  assert.equal((await service.connection(config(source))).apiKey, source.apiKey, 'copy stays independent')
  reusable = [{ ...reusable[0], baseUrl: 'https://custom.example' }]
  assert.equal((await credentials.list('claude')).length, 1)
  await assert.rejects(credentials.list('unknown' as any), /未知/)
  check('一键复用、来源变化、独立副本、地址绑定、自定义网关排除与无密钥 IPC')

  await service.save(mimo)
  const mimoModel = service.mergeModels([]).find(model => model.id === codexModelKey('mimo-v2.6-pro', { kind: 'third-party', sourceId: 'mimo' }))
  assert.deepEqual({
    label: mimoModel?.label, efforts: mimoModel?.efforts, defaultEffort: mimoModel?.defaultEffort,
    image: mimoModel?.imageInput, source: mimoModel?.modelSource, contextWindow: mimoModel?.contextWindow
  }, {
    label: '小米 MiMo · mimo-v2.6-pro', efforts: ['off', 'high'], defaultEffort: 'high', image: true,
    source: { kind: 'third-party', sourceId: 'mimo' }, contextWindow: 1048576
  }, 'MiMo 模型必须使用厂商名称、可输入图片、只暴露真实的思考开关，且窗口为 1M')
  assert.equal(mimoModel?.contextWindow, codexSourceCatalogModel('mimo-v2.6-pro', 'mimo').context_window,
    'Claude 端 MiMo 窗口必须与 Codex 模型目录同源')
  assert.equal((await service.connection(config(mimo))).preset, 'mimo')
  const mimoRuntime = await createClaudeSourceRuntime(await service.connection(config(mimo)))
  try {
    const settings = JSON.parse(await readFile(mimoRuntime.args[1], 'utf8'))
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://api.xiaomimimo.com/anthropic')
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, mimo.apiKey)
    assert.equal(settings.env.ANTHROPIC_API_KEY, '')
    assert.equal(settings.env.ANTHROPIC_MODEL, 'mimo-v2.6-pro')
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'high', '未选择时默认思考开启')
    assert.equal(settings.env.CLAUDE_CODE_EXTRA_BODY, undefined, '思考开启时不注入覆盖体，保持 CLI 默认思考')
    assert.ok(!mimoRuntime.args.join(' ').includes(mimo.apiKey!))
  } finally { await mimoRuntime.dispose() }
  for (const [effort, extraBody, level] of [
    ['off', '{"thinking":{"type":"disabled"}}', 'auto'],
    ['high', undefined, 'high']
  ] as const) {
    const runtime = await createClaudeSourceRuntime(await service.connection(config(mimo)), effort)
    try {
      const settings = JSON.parse(await readFile(runtime.args[1], 'utf8'))
      assert.equal(settings.env.CLAUDE_CODE_EXTRA_BODY, extraBody, `MiMo 思考${effort === 'off' ? '关闭' : '开启'}必须下发正确的 CLI 覆盖`)
      assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, level, '关闭思考时不能把 off 当作档位传给 CLI')
    } finally { await runtime.dispose() }
  }
  const tokenPlanRuntime = await createClaudeSourceRuntime({
    preset: 'mimo-token-plan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    model: 'mimo-v2.6-pro', apiKey: 'fixture-tp-key'
  })
  try {
    const settings = JSON.parse(await readFile(tokenPlanRuntime.args[1], 'utf8'))
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://token-plan-cn.xiaomimimo.com/anthropic')
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'fixture-tp-key')
    assert.equal(settings.env.ANTHROPIC_API_KEY, '')
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'high', 'Token Plan 默认同样思考开启')
    assert.equal(settings.env.CLAUDE_CODE_EXTRA_BODY, undefined)
  } finally { await tokenPlanRuntime.dispose() }
  const threeSources = new ClaudeSourceService()
  await threeSources.start()
  assert.equal(threeSources.snapshot().sources.length, 3, '三个厂商配置都必须能重载，不能被旧的 2 条上限拒绝')
  assert.equal((await threeSources.connection(config(mimo))).model, 'mimo-v2.6-pro')
  const codexReusable = await credentials.list('codex')
  const mimoCandidate = codexReusable.find(item => item.preset === 'mimo')
  assert.ok(mimoCandidate, 'Claude 中保存的 MiMo 配置应可复用到 Codex')
  const mimoCopy = await credentials.resolve('codex', mimoCandidate!)
  assert.equal(mimoCopy.baseUrl, 'https://api.xiaomimimo.com/v1', '复用 MiMo 时必须切换到 Codex 的 Responses 地址')
  assert.equal(mimoCopy.apiKey, mimo.apiKey)
  const tokenPlanSource: CodexSourceInput = { ...mimo, preset: 'mimo-token-plan', baseUrl: CLAUDE_SOURCE_PRESETS['mimo-token-plan'].baseUrl, apiKey: 'fixture-tp-secret' }
  await service.save(tokenPlanSource)
  assert.equal((await service.connection(config(tokenPlanSource))).preset, 'mimo-token-plan')
  const tokenPlanCandidate = (await credentials.list('codex')).find(item => item.preset === 'mimo-token-plan')
  assert.ok(tokenPlanCandidate, 'Token Plan 配置应可复用到 Codex')
  const tokenPlanCopy = await credentials.resolve('codex', tokenPlanCandidate!)
  assert.equal(tokenPlanCopy.baseUrl, 'https://token-plan-cn.xiaomimimo.com/v1', '复用 Token Plan 时必须切换到对应的 Responses 地址')
  assert.equal(tokenPlanCopy.apiKey, 'fixture-tp-secret')
  check('小米 MiMo 模型列表、Anthropic 认证、运行环境、跨客户端复用（含 Token Plan）与三厂商重载')

  const kimiHome = join(fixture, 'kimi'); await mkdir(kimiHome)
  const kimiFile = join(kimiHome, 'config.toml')
  await writeFile(kimiFile, '[providers.code]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\napi_key="fixture-static-key"\n[models.alias]\nprovider="code"\nmodel="k3"\n')
  assert.deepEqual((await kimiCredentialCandidates(kimiHome))[0].source.models, ['k3'])
  await writeFile(kimiFile, '[providers.code]\ntype="kimi"\nbase_url="https://custom.example"\napi_key="fixture-custom-key"\n[providers.code.env]\nKIMI_BASE_URL="https://api.kimi.com/coding/v1"\n')
  assert.deepEqual(await kimiCredentialCandidates(kimiHome), [], 'direct base_url wins over env fallback; custom gateway keys must not be imported to the official endpoint')
  await writeFile(kimiFile, '[providers.code]\ntype="kimi"\n[providers.code.env]\nKIMI_BASE_URL="https://api.kimi.com/coding/v1"\nKIMI_API_KEY="fixture-env-key"\n')
  assert.equal((await kimiCredentialCandidates(kimiHome))[0].source.apiKey, 'fixture-env-key')
  for (const extra of ['oauth={storage="file", key="login"}', 'api_key_env="MY_KEY"', 'custom_headers={Authorization="secret"}']) {
    await writeFile(kimiFile, '[providers.code]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\napi_key="fixture-static-key"\n' + extra)
    assert.deepEqual(await kimiCredentialCandidates(kimiHome), [])
  }
  await writeFile(kimiFile, 'malformed [')
  assert.deepEqual(await kimiCredentialCandidates(kimiHome), [])
  check('Kimi TOML 静态密钥与真实模型 ID，OAuth／动态密钥／自定义认证／损坏配置排除')

  let code = 200, response = '{"type":"message","content":[{"type":"text","text":"OK"}]}', hang = false
  const requests: any[] = []
  const server = createServer(async (request, reply) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(raw || '{}') })
    if (request.url === '/models') {
      reply.writeHead(200, { 'content-type': 'application/json' })
      const timer = setInterval(() => reply.write(' '), 5)
      reply.on('close', () => clearInterval(timer)); return
    }
    if (hang) return
    reply.writeHead(code, { 'content-type': 'application/json' }); reply.end(response)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    for (const preset of ['kimi-code', 'deepseek', 'mimo'] as const) {
      await testClaudeConnection({ baseUrl, apiKey: 'probe-fixture-key', model: 'wire-model', preset })
      const request = requests.at(-1)
      assert.equal(request.path, '/v1/messages'); assert.equal(request.body.model, 'wire-model')
      assert.equal(preset === 'kimi-code' ? request.headers['x-api-key'] : request.headers.authorization, preset === 'kimi-code' ? 'probe-fixture-key' : 'Bearer probe-fixture-key')
    }
    for (const status of [301, 401, 402, 403, 404, 429, 500, 503]) {
      code = status; response = '{"error":"probe-fixture-key"}'
      await assert.rejects(testClaudeConnection({ baseUrl, apiKey: 'probe-fixture-key', model: 'wire-model', preset: 'kimi-code' }), error => !String(error).includes('probe-fixture-key'))
    }
    code = 200
    for (const body of ['{broken', '{}', '{"type":"message","content":[],"error":{}}']) {
      response = body
      await assert.rejects(testClaudeConnection({ baseUrl, apiKey: 'probe-fixture-key', model: 'wire-model', preset: 'kimi-code' }), /格式/)
    }
    hang = true
    await assert.rejects(testClaudeConnection({ baseUrl, apiKey: 'probe-fixture-key', model: 'wire-model', preset: 'kimi-code' }, 50), /超时/)
    await assert.rejects(fetchSourceModels(baseUrl, 'probe-fixture-key', 50), /超时/, 'a trickling model response must not bypass the total deadline')
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  await assert.rejects(testClaudeConnection({ baseUrl, apiKey: 'probe-fixture-key', model: 'wire-model', preset: 'kimi-code' }), /无法连接/)
  check('真实 HTTP 请求、认证差异、无重定向、401／402／403／404／429／5xx、畸形响应、超时和断网')

  await writeFile(file, '{broken')
  const broken = new ClaudeSourceService(); await broken.start()
  assert.equal(broken.snapshot().phase, 'error')
  await assert.rejects(broken.save(source), /无法读取/)
  assert.equal(await readFile(file, 'utf8'), '{broken', 'corrupt store must not be silently replaced')
  const encrypted = encryptLocalSecret('fixture-value')
  await writeFile(file, JSON.stringify({ version: 1, sources: [{ ...source, encryptedKey: encrypted }] }))
  const mixedStore = new ClaudeSourceService(); await mixedStore.start()
  assert.ok(!JSON.stringify(mixedStore.snapshot()).includes(source.apiKey!), 'unrecognized plaintext fields never cross IPC')
  await writeFile(file, JSON.stringify({ version: 1, sources: [{ ...source, apiKey: undefined, encryptedKey: encrypted.slice(0, -5) }] }))
  const corruptKey = new ClaudeSourceService(); await corruptKey.start()
  await assert.rejects(corruptKey.connection(config(source)), /API Key/)
  check('损坏存储保留原文件，损坏密文拒绝启动')
  console.log(`claude-model-sources: ${checks} boundary groups passed`)
} finally { configureClaudeSourceRuntime(undefined); await rm(fixture, { recursive: true, force: true }) }
