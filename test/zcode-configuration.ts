import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ZCodeConfigurationService, probeZCodeModels } from '../src/main/zcode/configuration'
import { ZCODE_MODEL_SERVICES } from '../src/shared/zcode'
import { writeZCodeJson } from '../src/main/zcode/store'
import { zcodeRuntimeConfigPath, detectZCodeRuntime } from '../src/main/zcode/runtime'
import { DiagnosticsStore } from '../src/main/diagnostics'

const root = await mkdtemp('/tmp/uzcfg-test-')
const previous = { HOME: process.env.HOME, UNIAGENT_USER_DATA: process.env.UNIAGENT_USER_DATA }
process.env.HOME = root; process.env.UNIAGENT_USER_DATA = join(root, 'data')
const noSwitch = async () => {}
try {
  await mkdir(join(root, 'provider'))
  const bundlePath = join(root, 'cli.cjs')
  await writeFile(bundlePath, "console.log(process.argv.includes('--version')?'0.16.9':'app-server --stdio')")
  await writeFile(join(root, 'provider/zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { templateRules: ZCODE_MODEL_SERVICES.map(service => ({ templateId: service.templateId,
      config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-4.7'] } })) }
  } }))
  writeZCodeJson(zcodeRuntimeConfigPath(), { schemaVersion: 1, source: 'source-build', executable: process.execPath,
    bundlePath, resourceRoot: root, dataRootId: 'fixture' })
  const originalFetch = globalThis.fetch
  let modelRequests = 0
  globalThis.fetch = async (url, options) => {
    modelRequests++
    assert.equal(String(url), 'https://open.bigmodel.cn/api/coding/paas/v4/models')
    assert.equal(options?.method, 'GET')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-key')
    assert.equal(options?.body, undefined)
    return Response.json({ object: 'list', data: [{ id: 'GLM-5.3' }] })
  }
  try {
    const result = await new ZCodeConfigurationService().check({ service: 'bigmodel-coding', apiKey: 'fixture-key' }, noSwitch)
    assert.equal(result.phase, 'ready', 'a model-list response must pass without starting an inference session')
    assert.equal(modelRequests, 1)
  } finally { globalThis.fetch = originalFetch }
  for (const definition of ZCODE_MODEL_SERVICES) {
    let calls = 0
    const service = new ZCodeConfigurationService(async (selected, key) => {
      calls++
      assert.equal(selected, definition.id)
      assert.equal(key, 'fixture-key')
      return ['glm-5.3', 'glm-4.7', 'embedding-fixture']
    })
    assert.equal((await service.check({ service: definition.id, apiKey: ' fixture-key ' }, noSwitch)).phase, 'ready')
    assert.equal(calls, 1)
    const stored = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8'))
    const doc = JSON.parse(await readFile(stored.personalProviderConfigPath, 'utf8'))
    const provider = doc.config.providerConfigRules.providerRules.find((item: any) => item.providerId === doc.config.defaultModelSelection.providerId)
    assert.equal(provider.config.api.baseUrl, definition.baseUrl)
    assert.equal(provider.config.api.type, definition.apiType)
    assert.equal(provider.config.access.type, definition.accessType)
    assert.equal(provider.config.access.apiKey, 'fixture-key')
    const runtime = await detectZCodeRuntime(stored)
    assert.deepEqual(runtime.models.map(model => model.label), ['GLM-5.3', 'GLM-4.7'], 'only returned, supported models from the selected service are shown')
    assert.ok(runtime.models.every(model => model.zcodeSelection?.providerId === provider.providerId))
    assert.equal((await stat(stored.personalProviderConfigPath)).mode & 0o777, 0o600)
    assert.equal((await service.snapshot()).hasKey, true)
    assert.equal((await service.check({ service: definition.id }, async () => { throw new Error('must not rewrite') })).phase, 'ready')
    assert.equal(calls, 2)
    assert.equal(JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8')).personalProviderConfigPath, stored.personalProviderConfigPath)
  }
  let switches = 0
  const refresh = new ZCodeConfigurationService(async () => ['glm-5.3-flash'])
  assert.equal((await refresh.check({ service: 'zai-api' }, async () => { switches++ })).phase, 'ready')
  assert.equal(switches, 1, 'reusing the saved Key must still activate a changed model list')
  const refreshedConfig = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8'))
  const refreshed = await detectZCodeRuntime(refreshedConfig)
  assert.deepEqual(refreshed.models.map(model => model.label), ['GLM-5.3-Flash'])
  assert.equal(refreshed.selection.modelId, 'GLM-5.3-Flash', 'a removed default falls back to a returned supported model')
  const unsupported = await new ZCodeConfigurationService(async () => ['embedding-fixture']).check({ service: 'zai-api' }, noSwitch)
  assert.equal(unsupported.phase, 'failed'); assert.match(unsupported.message!, /没有.*支持的模型/)
  assert.deepEqual(JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8')), refreshedConfig, 'an unsupported list preserves the last usable configuration')
  const refusedRefresh = await new ZCodeConfigurationService(async () => ['glm-4.7']).check({ service: 'zai-api' }, async () => { throw new Error('active_session') })
  assert.equal(refusedRefresh.phase, 'failed')
  assert.deepEqual(JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8')), refreshedConfig, 'a refreshed list cannot bypass the switch guard')
  const saved = await readFile(zcodeRuntimeConfigPath(), 'utf8')
  for (const [error, expected] of [['401 secret-fixture', /API Key 无效/], ['429', /请求受限/], ['quota exhausted', /额度不足/],
    ['ECONNREFUSED', /连接失败/], ['model not found', /模型不可用/], ['secret-fixture https://private.test', /列表获取失败/]] as const) {
    const service = new ZCodeConfigurationService(async () => { throw new Error(error) })
    const result = await service.check({ service: 'bigmodel-api', apiKey: 'replacement-fixture' }, noSwitch)
    assert.equal(result.phase, 'failed'); assert.match(result.message!, expected)
    assert.ok(!result.message?.includes('secret-fixture'))
    assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), saved)
  }
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const concurrent = new ZCodeConfigurationService(async () => { await wait; return ['glm-5.3', 'glm-4.7', 'embedding-fixture'] })
  const first = concurrent.check({ service: 'zai-api' }, noSwitch)
  await assert.rejects(concurrent.check({ service: 'zai-api' }, noSwitch), /正在检测/)
  release(); assert.equal((await first).phase, 'ready')
  const conflict = new ZCodeConfigurationService(async () => ['GLM-5.3'])
  const marker = saved + '\n'
  const result = await conflict.check({ service: 'zai-api', apiKey: 'new-fixture' }, async () => { await writeFile(zcodeRuntimeConfigPath(), marker) })
  assert.equal(result.phase, 'failed', 'activation must recheck after awaiting the switch guard')
  assert.equal(await readFile(zcodeRuntimeConfigPath(), 'utf8'), marker)
  for (const [id, url] of [
    ['bigmodel-coding', 'https://open.bigmodel.cn/api/coding/paas/v4/models'],
    ['zai-coding', 'https://api.z.ai/api/coding/paas/v4/models'],
    ['bigmodel-api', 'https://open.bigmodel.cn/api/paas/v4/models'],
    ['zai-api', 'https://api.z.ai/api/paas/v4/models']
  ] as const) {
    const models = await probeZCodeModels(id, 'fixture-key', async (target, options) => {
      assert.equal(target, url); assert.equal(options?.method, 'GET')
      assert.equal(options?.redirect, 'error'); assert.equal(options?.body, undefined)
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-key')
      return Response.json({ data: ['glm-5.3', { id: 'glm-5.2' }, { id: 'glm-5.3' }] })
    })
    assert.deepEqual(models, ['glm-5.3', 'glm-5.2'], 'the response list is returned and deduplicated')
  }
  for (const [response, expected] of [
    [new Response('secret-fixture', { status: 401 }), /API Key 无效/],
    [new Response('', { status: 403 }), /API Key 无效/],
    [new Response('', { status: 429 }), /请求受限/],
    [new Response('', { status: 500 }), /HTTP 500/],
    [new Response('not json secret-fixture'), /有效的模型列表/],
    [Response.json({ code: 500, success: false, msg: 'secret-fixture' }), /列表获取失败/],
    [Response.json({ data: [] }), /列表为空/],
    [Response.json({ data: [{ id: ' ' }] }), /格式不兼容/],
    [Response.json({ data: [{ id: 'good' }, {}] }), /格式不兼容/],
    [Response.json({ data: [{ id: 'a'.repeat(513) }] }), /格式不兼容/],
    [Response.json({ data: [{ id: 'a\nb' }] }), /格式不兼容/],
    [new Response('a'.repeat(2 * 1024 * 1024 + 1)), /响应过大/]
  ] as const) {
    await assert.rejects(probeZCodeModels('bigmodel-coding', 'fixture-key', async () => response), error => {
      assert.match((error as Error).message, expected)
      assert.ok(!(error as Error).message.includes('secret-fixture'))
      return true
    })
  }
  const stalled: typeof fetch = async (_url, options) => new Response(new ReadableStream({
    start(stream) { options?.signal?.addEventListener('abort', () => stream.error(new Error('aborted'))) }
  }))
  await assert.rejects(probeZCodeModels('zai-coding', 'fixture-key', stalled, 10), /获取超时/)
  await assert.rejects(probeZCodeModels('zai-coding', 'fixture-key', async () => { throw new TypeError('fetch failed') }), /连接失败/)
  const validation = new ZCodeConfigurationService()
  for (const input of [{ service: 'unknown' }, { service: 'zai-api', apiKey: 'a\nb' }, { service: 'zai-api', apiKey: 'a'.repeat(8193) }]) {
    await assert.rejects(validation.check(input, noSwitch), /参数无效/)
  }
  assert.equal((await validation.check({ service: 'bigmodel-api', apiKey: ' ' }, noSwitch)).phase, 'failed')
  const logPath = join(root, 'setup-diagnostics.jsonl')
  const logs = new DiagnosticsStore(logPath)
  const report = (entry: Parameters<DiagnosticsStore['record']>[0]) => { logs.record(entry) }
  for (const [request, reason, status] of [
    [async () => new Response('secret-fixture', { status: 401 }), 'auth', 401],
    [async () => new Response('secret-fixture'), 'invalid_json', 200],
    [async () => Response.json({ success: false, error: { message: 'secret-fixture' } }), 'business', 200],
    [async () => Response.json({ data: [] }), 'empty_list', 200],
    [async () => { throw new TypeError('secret-fixture', { cause: Object.assign(new Error('secret-fixture'), { code: 'ENOTFOUND' }) }) }, 'network', undefined],
    [stalled, 'timeout', 200]
  ] as const) {
    const service = new ZCodeConfigurationService((id, key) => probeZCodeModels(id, key, request, 10), report)
    assert.equal((await service.check({ service: 'bigmodel-coding', apiKey: 'secret-fixture' }, noSwitch)).phase, 'failed')
    const entry = logs.list().find(entry => entry.code === `zcode_configuration_${reason}`)!
    assert.ok(entry, reason)
    const sample = JSON.parse(entry.sample!)
    assert.equal(entry.field, 'model_list'); assert.equal(sample.service, 'bigmodel-coding')
    assert.equal(sample.httpStatus, status); assert.ok(sample.elapsedMs >= 0)
    assert.match(sample.operationId, /^[a-f0-9-]{36}$/)
    assert.ok(sample.stages.some((step: any) => step.stage === 'resolve_runtime'))
    if (reason === 'network') assert.equal(sample.errorCode, 'ENOTFOUND')
  }
  const invalid = new ZCodeConfigurationService(undefined, report)
  await assert.rejects(invalid.check({ service: 'secret-fixture', apiKey: 'secret-fixture' }, noSwitch))
  const reloaded = new DiagnosticsStore(logPath)
  assert.ok(reloaded.list().some(entry => entry.code === 'zcode_configuration_auth'), 'failure survives an App restart')
  assert.match(reloaded.formatReport(), /model_list/)
  assert.ok(!(await readFile(logPath, 'utf8')).includes('secret-fixture'), 'raw input, bodies and nested errors never reach disk')
  assert.ok(!reloaded.formatReport().includes('secret-fixture'), 'export also excludes credentials')
  const brokenSink = new ZCodeConfigurationService(async () => { throw new Error('401') }, () => { throw new Error('sink failed') })
  assert.match((await brokenSink.check({ service: 'bigmodel-coding', apiKey: 'fixture' }, noSwitch)).message!, /API Key 无效/)
  console.log('zcode-configuration: returned model lists, selected-service catalog, saved-key refresh, default fallback, four provider contracts, failures, diagnostics and concurrent writes passed')
} finally {
  for (const key of ['HOME', 'UNIAGENT_USER_DATA'] as const) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(root, { recursive: true, force: true })
}
