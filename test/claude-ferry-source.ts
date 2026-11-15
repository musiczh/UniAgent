import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSourceService } from '../src/main/claudeSourceService'
import { projectClaudeFerryModels } from '../src/main/claudeFerrySource'
import { configureClaudeSourceRuntime, prepareClaudeSourceRuntime } from '../src/main/claudeSourceRuntime'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import { CLAUDE_SOURCE_PRESETS } from '../src/shared/claudeSources'
import type { SessionConfig } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'ua-claude-ferry-'))
process.env.UNIAGENT_USER_DATA = directory
process.env.FERRY_HOME = directory
const requests: string[] = []
let status = 200
let catalog: unknown = { data: [
  { id: 'claude-gpt-6-1-sol', display_name: 'Ferry GPT-6.1-Sol', max_input_tokens: 475000,
    capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } }, image_input: { supported: true } } },
  { id: 'claude-gpt-6-1-sol-max[1m]', display_name: 'Ferry GPT-6.1-Sol Max 1M', max_input_tokens: 922000,
    capabilities: { effort: { supported: false }, image_input: { supported: false } } }
] }
const server = createServer((request, response) => {
  requests.push(request.url!)
  assert.equal(request.headers.authorization, 'Bearer ferry', '模型查询不能发送 Claude 原生或其它厂商凭据')
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(catalog))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = (server.address() as { port: number }).port
const runtimeFile = join(directory, 'runtime.json')
const sourceRef = { kind: 'third-party' as const, sourceId: 'ferry' }
const ferryKey = codexModelKey('claude-gpt-6-1-sol', sourceRef)
const config: SessionConfig = { agentId: 'claude', model: ferryKey, workdir: directory, permissionMode: 'full-access', effort: 'high' }
const native = { id: 'sonnet', label: 'Sonnet', efforts: [] }
const nativeBaseUrl = process.env.ANTHROPIC_BASE_URL
try {
  assert.throws(() => projectClaudeFerryModels({ models: [] }), /Ferry/)
  assert.deepEqual(projectClaudeFerryModels({ data: [null, { id: 'ferry-gpt-6-1-sol' }, { id: 'claude-bad model' }] }), [])
  const projected = projectClaudeFerryModels({ data: [
    { id: 'claude-custom', display_name: 'Custom', max_input_tokens: -1, capabilities: { effort: { supported: true, low: { supported: 'true' }, xhigh: { supported: true } } } },
    { id: 'claude-custom', display_name: 'Custom', max_input_tokens: -1, capabilities: { effort: { supported: true, xhigh: { supported: true } } } }
  ] })
  assert.equal(projected.length, 1, '重复模型 ID 不能造成重复菜单条目')
  assert.equal(projected[0].label, 'Ferry Custom')
  assert.deepEqual(projected[0].efforts, ['xhigh'])
  assert.equal(projected[0].defaultEffort, 'xhigh')
  assert.equal(projected[0].contextWindow, undefined)
  const service = new ClaudeSourceService()
  await service.start()
  await service.save({ ...CLAUDE_SOURCE_PRESETS.mimo, preset: 'mimo', enabled: true, apiKey: 'fixture-mimo-key' })
  const withoutFerry = await service.refreshModels([native])
  assert.equal(withoutFerry[0], native)
  assert.equal(withoutFerry.some(model => model.modelSource?.sourceId === 'ferry'), false, '未安装或未启动 Ferry 时保留原有来源')
  assert.deepEqual(requests, [])

  await writeFile(runtimeFile, JSON.stringify({ pid: process.pid, port, version: '0.1.98', token: 'fixture-control-secret' }))
  const models = await service.refreshModels([native])
  assert.deepEqual(models.map(model => model.modelSource?.sourceId || 'native'), ['native', 'mimo', 'mimo', 'ferry', 'ferry'],
    'Claude 的原生、UniAgent 第三方和 Ferry 模型必须按现有顺序共存')
  assert.deepEqual(models.find(model => model.id === ferryKey), {
    id: ferryKey, label: 'Ferry GPT-6.1-Sol', efforts: ['low', 'high'], defaultEffort: 'high',
    contextWindow: 475000, imageInput: true, supportsFast: false, supportsMax: false, modelSource: sourceRef
  })
  assert.deepEqual(models.at(-1)?.efforts, [], '不提供档位的模型不能沿用 Claude 原生档位')
  assert.equal(models.at(-1)?.contextWindow, 922000)
  assert.ok(requests.every(path => path === '/v1/models'))
  assert.equal(service.normalize(config).modelSource?.sourceId, 'ferry')
  assert.throws(() => service.assertReady({ ...config, model: codexModelKey('claude-missing', sourceRef) }), /Ferry/)
  assert.throws(() => service.normalize({ ...config, modelSource: { kind: 'native' } }), /不匹配/)

  configureClaudeSourceRuntime(value => service.connection(value))
  const [ferry, mimo] = await Promise.all([
    prepareClaudeSourceRuntime(config),
    prepareClaudeSourceRuntime({ ...config, model: codexModelKey('mimo-v2.6-pro', { kind: 'third-party', sourceId: 'mimo' }) })
  ])
  try {
    assert.equal(ferry!.model, 'claude-gpt-6-1-sol', '运行时使用 Claude 模型 ID，不能把菜单来源 key 或 Codex Ferry ID 发到网关')
    assert.equal(ferry!.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)
    assert.equal(ferry!.env.ANTHROPIC_AUTH_TOKEN, 'ferry')
    assert.equal(ferry!.env.ANTHROPIC_API_KEY, '')
    assert.equal(ferry!.env.CLAUDE_CODE_OAUTH_TOKEN, '')
    assert.equal(ferry!.env.CLAUDE_CODE_EFFORT_LEVEL, 'high')
    assert.equal(ferry!.settings.enableArtifact, false, 'Ferry 运行时按其官方配置关闭不支持的 Artifact')
    assert.equal(ferry!.redact('ferry-gpt-6-1-sol'), 'ferry-gpt-6-1-sol', 'Ferry 的固定占位认证值不能误删正常回复中的模型名称')
    assert.equal(mimo!.env.ANTHROPIC_BASE_URL, CLAUDE_SOURCE_PRESETS.mimo.baseUrl)
    assert.equal(mimo!.env.ANTHROPIC_AUTH_TOKEN, 'fixture-mimo-key')
    assert.notEqual(ferry!.args[1], mimo!.args[1], '并发来源必须使用各自的会话覆盖文件')
    const savedOverride = JSON.parse(await readFile(ferry!.args[1], 'utf8'))
    assert.equal(savedOverride.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`, '连接覆盖必须写入该会话的运行文件')
    assert.equal(process.env.ANTHROPIC_BASE_URL, nativeBaseUrl, '会话覆盖不能修改全局原生连接环境')
    assert.equal(await prepareClaudeSourceRuntime({ ...config, model: 'sonnet', modelSource: undefined }), undefined)
  } finally { await ferry!.dispose(); await mimo!.dispose() }

  status = 503
  const unavailable = await service.refreshModels([native])
  assert.equal(unavailable[0], native)
  assert.equal(unavailable.filter(model => model.modelSource?.sourceId === 'mimo').length, 2)
  service.assertReady({ ...config, model: 'sonnet' })
  assert.throws(() => service.assertReady(config), /Ferry/, '网关失败只阻止 Ferry，不能回退到原生连接')
  await assert.rejects(service.connection(config), /Ferry/)

  status = 200
  catalog = { data: [{ id: 'claude-gpt-6-1-sol', display_name: 'Ferry GPT-6.1-Sol', capabilities: { effort: { supported: false } } }] }
  const recovered = await service.refreshModels([native])
  assert.equal(recovered.filter(model => model.modelSource?.sourceId === 'ferry').length, 1, '刷新应移除网关已删除的模型')
  service.assertReady(config)
  for (const invalid of [0, 65536, '8790']) {
    await writeFile(runtimeFile, JSON.stringify({ port: invalid }))
    await service.refreshModels([native])
    assert.throws(() => service.assertReady(config), /Ferry/)
  }
  console.log('Claude Ferry：三类来源共存、真实能力、独立运行时、故障隔离与刷新恢复通过')
} finally {
  configureClaudeSourceRuntime(undefined)
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
}
