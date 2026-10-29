// Run explicitly: node scripts/run-ts-test.mjs test/codex-sources.ts
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { startCodexSourceRouter } from '../src/main/codexSourceRouter'
import { configValue, parseCodexConfig, patchCodexConfig, restoreCodexConfig, validateSourceInput, validateSourceModelQuery, type ConfigField } from '../src/main/codexSourceConfig'
import { fetchSourceModels, modelRequestFor, normalizeSourceModels } from '../src/main/codexSourceModels'
import { normalizeQuotaResponse, quotaErrorMessage, quotaRequestFor, quotaUnavailableReason } from '../src/main/codexSourceQuota'
import { CodexSourceService, codexSourceCatalogModel, codexSourceRuntimeArgs } from '../src/main/codexSourceService'
import * as diagnosticModule from '../src/main/diagnostics'
import * as codexSourceModule from '../src/shared/codexSources'
import * as codexSourceSettingsModule from '../src/renderer/components/CodexSourceSettings'
import { appendCodexSourceModel } from '../src/shared/codexSources'

assert.deepEqual(appendCodexSourceModel(['deepseek-flash'], ' deepseek-v4-pro '), ['deepseek-flash', 'deepseek-v4-pro'])
assert.throws(() => appendCodexSourceModel(['deepseek-flash'], 'deepseek-flash'))
assert.throws(() => appendCodexSourceModel([], 'bad model id'))
assert.throws(() => appendCodexSourceModel(Array.from({ length: 100 }, (_, index) => `model-${index}`), 'model-overflow'))

// 小米 MiMo：Codex 使用 OpenAI Responses 兼容入口，默认两个 V2.6 模型。
// 额度接口只认控制台登录态，preset 带 consoleUrl 供设置页引导到控制台查看。
assert.deepEqual(codexSourceModule.CODEX_SOURCE_PRESETS.mimo, {
  id: 'mimo', label: '小米 MiMo API（按量付费）', baseUrl: 'https://api.xiaomimimo.com/v1',
  models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], consoleUrl: 'https://platform.xiaomimimo.com/console/balance'
})
assert.deepEqual(codexSourceModule.CODEX_SOURCE_PRESETS['mimo-token-plan'], {
  id: 'mimo', label: '小米 MiMo Token Plan（订阅套餐）', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], consoleUrl: 'https://platform.xiaomimimo.com/console/balance'
})
assert.equal(codexSourceModule.CODEX_SOURCE_PRESETS.deepseek.consoleUrl, undefined, '可查额度的厂商不展示控制台入口')
assert.equal(codexSourceModule.CODEX_SOURCE_NAMES.mimo, '小米 MiMo')
assert.ok(codexSourceModule.CODEX_SOURCE_PRESET_ORDER.includes('mimo'))
assert.deepEqual(codexSourceModule.CODEX_SOURCE_PRESET_ORDER.slice(-1), ['mimo'], 'Token Plan 与按量付费共用一行，避免重复展示')
assert.equal(codexSourceModule.codexSourceModelImageInput('mimo', 'mimo-v2.6-pro'), true, 'MiMo V2.6 全模态模型应允许图片输入')
assert.equal(codexSourceModule.codexSourceModelImageInput('mimo-token-plan', 'mimo-v2.6-flash'), true, 'Token Plan 模型同样支持图片')
assert.equal(codexSourceModule.codexSourceModelImageInput('mimo', 'mimo-custom'), false, '未知 MiMo 模型保持纯文本，避免误发图片')
assert.equal(codexSourceModule.codexSourceModelImageInput('deepseek', 'deepseek-v4-pro'), false)
// 真实 /models 返回包含 ASR/TTS；自动查询只保留可对话模型。
const mimoLiveModels = ['mimo-v2.5', 'mimo-v2.5-asr', 'mimo-v2.5-pro', 'mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']
const mimoTextModels = ['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']
assert.deepEqual(codexSourceModule.codexSourceChatModels('mimo', mimoLiveModels), mimoTextModels)
assert.deepEqual(codexSourceModule.codexSourceChatModels('mimo-token-plan', mimoLiveModels.slice(0, 8)), ['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro'])
assert.deepEqual(codexSourceModule.codexSourceChatModels('deepseek', ['deepseek-flash']), ['deepseek-flash'], '其它厂商的模型列表保持不变')

const mimoCatalog = codexSourceCatalogModel('mimo-v2.6-pro', 'mimo')
assert.deepEqual({
  slug: mimoCatalog.slug, context: mimoCatalog.context_window, maxContext: mimoCatalog.max_context_window,
  levels: mimoCatalog.supported_reasoning_levels, defaultLevel: mimoCatalog.default_reasoning_level,
  modalities: mimoCatalog.input_modalities, parallel: mimoCatalog.supports_parallel_tool_calls,
  patch: mimoCatalog.apply_patch_tool_type
}, {
  slug: 'mimo-v2.6-pro', context: 1048576, maxContext: 1048576,
  // MiMo 仅区分思考开关，非 none 档位一致，不能虚构低/高档差异。
  levels: [{ effort: 'high', description: 'high' }], defaultLevel: 'high',
  modalities: ['text', 'image'], parallel: true, patch: undefined
})
assert.deepEqual({
  context: codexSourceCatalogModel('mimo-custom', 'mimo').context_window,
  modalities: codexSourceCatalogModel('mimo-custom', 'mimo').input_modalities,
  levels: codexSourceCatalogModel('mimo-custom', 'mimo').supported_reasoning_levels
}, { context: 131072, modalities: ['text'], levels: [{ effort: 'high', description: 'high' }] }, '未知 MiMo 模型使用保守能力')
const { description: _paygDescription, ...paygCatalog } = codexSourceCatalogModel('mimo-v2.6-pro', 'mimo')
const { description: _tokenPlanDescription, ...tokenPlanCatalog } = codexSourceCatalogModel('mimo-v2.6-pro', 'mimo-token-plan')
assert.deepEqual(tokenPlanCatalog, paygCatalog, 'Token Plan 与按量付费的同一模型能力一致，仅来源说明不同')
assert.equal(codexSourceCatalogModel('glm-5-turbo', 'glm').apply_patch_tool_type, 'freeform', 'GLM 的 freeform patch 不能因新增厂商而丢失')
const mimoRuntimeArgs = codexSourceRuntimeArgs('http://127.0.0.1:11436/api/codex/v1/mimo', '/tmp/models-mimo.json', 'mimo', 'mimo-v2.6-pro')
assert.ok(mimoRuntimeArgs.includes('web_search="disabled"'), 'MiMo 网关拒绝 web_search，必须关闭')
assert.ok(mimoRuntimeArgs.includes('features.standalone_web_search=false'))
assert.ok(mimoRuntimeArgs.includes('features.enable_request_compression=false'))
assert.ok(!codexSourceRuntimeArgs('http://127.0.0.1:11436/api/codex/v1/deepseek', '/tmp/models-deepseek.json', 'deepseek', 'deepseek-flash').includes('web_search="disabled"'), '其它来源保持原有工具配置')
assert.deepEqual(modelRequestFor('https://api.deepseek.com/', 'deepseek-key'), { url: 'https://api.deepseek.com/models', authorization: 'Bearer deepseek-key' })
assert.deepEqual(modelRequestFor('https://api.xiaomimimo.com/v1', 'mimo-key'), { url: 'https://api.xiaomimimo.com/v1/models', authorization: 'Bearer mimo-key' })
assert.deepEqual(modelRequestFor('https://token-plan-cn.xiaomimimo.com/v1', 'tp-key'), { url: 'https://token-plan-cn.xiaomimimo.com/v1/models', authorization: 'Bearer tp-key' })
assert.deepEqual(normalizeSourceModels({
  object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]
}), ['deepseek-v4-pro', 'deepseek-flash'])
assert.throws(() => normalizeSourceModels({ data: [{ id: 'bad model id' }] }))
assert.throws(() => normalizeSourceModels({ data: [] }))

const kimiQuotaRequest = quotaRequestFor('kimi-api', 'https://api.moonshot.cn/v1/', 'kimi-key')
assert.deepEqual(kimiQuotaRequest, { url: 'https://api.moonshot.cn/v1/users/me/balance', authorization: 'Bearer kimi-key' })
assert.deepEqual(quotaRequestFor('deepseek', 'https://api.deepseek.com', 'deepseek-key'), { url: 'https://api.deepseek.com/user/balance', authorization: 'Bearer deepseek-key' })
assert.deepEqual(quotaRequestFor('glm', 'https://open.bigmodel.cn/api/v1', 'glm-key'), { url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', authorization: 'glm-key' })
assert.deepEqual(quotaRequestFor('kimi-code', 'https://api.kimi.com/coding/v1', 'kimi-key'), { url: 'https://api.kimi.com/coding/v1/usages', authorization: 'Bearer kimi-key' })
assert.equal(quotaRequestFor('kimi-api', 'https://proxy.example/v1', 'kimi-key'), null)
assert.equal(quotaUnavailableReason('mimo', 'https://api.xiaomimimo.com/v1'), '小米 MiMo 暂不支持额度查询')
assert.equal(quotaUnavailableReason('mimo-token-plan', 'https://token-plan-cn.xiaomimimo.com/v1'), '小米 MiMo 暂不支持额度查询')
assert.equal(quotaRequestFor('mimo', 'https://api.xiaomimimo.com/v1', 'mimo-key'), null)
assert.equal(quotaUnavailableReason('mimo', 'https://custom.example/v1'), '自定义地址不查询额度', '自定义地址的提示优先于厂商额度能力')
assert.throws(() => normalizeQuotaResponse('mimo', {}), /不支持额度查询/)

assert.deepEqual(normalizeQuotaResponse('kimi-code', {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-10-08T12:00:00Z' },
    limit_7d: { used_ratio: 0.5, reset_time: '2026-10-12T00:00:00Z' },
    limit_month_total: { used_ratio: 0.75, reset_time: '2026-11-01T00:00:00Z' }
  }
}, 500), {
  status: 'ready', kind: 'windows', capturedAt: 500,
  windows: [
    { label: '5 小时额度', usedPercent: 25, resetsAt: Date.parse('2026-10-08T12:00:00Z') },
    { label: '每周额度', usedPercent: 50, resetsAt: Date.parse('2026-10-12T00:00:00Z') },
    { label: '每月额度', usedPercent: 75, resetsAt: Date.parse('2026-11-01T00:00:00Z') }
  ]
})

assert.deepEqual(normalizeQuotaResponse('kimi-api', {
  status: true, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }
}, 1000), {
  status: 'ready', kind: 'balance', capturedAt: 1000,
  balances: [{ currency: 'CNY', total: '49.58894', granted: '46.58893', toppedUp: '3.00001' }]
})
assert.deepEqual(normalizeQuotaResponse('deepseek', {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }]
}, 2000), {
  status: 'ready', kind: 'balance', capturedAt: 2000,
  balances: [{ currency: 'CNY', total: '12.50', granted: '2.50', toppedUp: '10.00' }]
})
assert.deepEqual(normalizeQuotaResponse('glm', {
  data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 28, nextResetTime: 1800000000000 }, { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40 }, { type: 'TIME_LIMIT', percentage: 81 }] }
}, 3000), {
  status: 'ready', kind: 'windows', capturedAt: 3000,
  windows: [{ label: '5 小时额度', usedPercent: 28, resetsAt: 1800000000000 }, { label: '每周额度', usedPercent: 40 }, { label: 'MCP 月额度', usedPercent: 81 }]
})
assert.throws(() => normalizeQuotaResponse('deepseek', { balance_infos: [] }, 4000))
assert.deepEqual(normalizeQuotaResponse('glm', { code: 500, success: false, msg: '当前用户不存在coding plan' }, 4000), {
  status: 'unsupported', capturedAt: 4000, message: '当前账号未开通 GLM Coding Plan'
})
assert.throws(() => normalizeQuotaResponse('glm', { code: 500, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 0 }] } }), /未返回成功结果/)
assert.throws(() => normalizeQuotaResponse('glm', { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: null }] } }), /使用比例/)
assert.equal(normalizeQuotaResponse('glm', { code: 0, data: { level: 'lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100 }] } }).windows?.[0].usedPercent, 100)
assert.equal(quotaErrorMessage(401), '密钥无额度查询权限')
assert.equal(quotaErrorMessage(429), '额度查询过于频繁')

// A wrong replacement must fail here before it can overwrite MCP settings,
// including text inside a multiline string that resembles a TOML assignment.
const original = '# keep this comment\nmodel = "gpt-test"\nopenai_base_url = "http://127.0.0.1:11434/api/codex/v1" # upstream\n[mcp_servers.example]\ncommand = "node"\n[features]\nshell_tool = true\n'
const before = parseCodexConfig(original)
const fields: ConfigField[] = [
  { path: ['openai_base_url'], before: configValue(before, ['openai_base_url']), applied: 'http://127.0.0.1:11436/api/codex/v1' },
  { path: ['model_catalog_json'], before: null, applied: '/tmp/catalog.json' },
  { path: ['features', 'enable_request_compression'], before: null, applied: false }
]
const changed = patchCodexConfig(original, fields.map(field => ({ path: field.path, value: field.applied })))
assert.equal(parseCodexConfig(changed).features.enable_request_compression, false)
assert.deepEqual(parseCodexConfig(changed).mcp_servers, before.mcp_servers)
assert.ok(changed.includes('# keep this comment'))
assert.ok(changed.includes('# upstream'))
assert.deepEqual(parseCodexConfig(restoreCodexConfig(changed, fields)), before)
assert.throws(() => restoreCodexConfig(changed.replace('11436', '11499'), fields))
const dotted = '"features".enable_request_compression = true # keep\n'
assert.equal(parseCodexConfig(patchCodexConfig(dotted, [{ path: ['features', 'enable_request_compression'], value: false }])).features.enable_request_compression, false)
const spoof = 'note = """\nopenai_base_url = "inside a string"\n"""\nopenai_base_url = "https://example.com"\n'
assert.throws(() => patchCodexConfig(spoof, [{ path: ['openai_base_url'], value: 'https://changed.example' }]), 'ambiguous layouts must be rejected without changing the file')
const input = { id: 'kimi', preset: 'kimi-code', enabled: true, baseUrl: 'https://api.kimi.com/coding/v1/', models: ['k3'], apiKey: 'test-key' }
assert.equal(validateSourceInput(input).baseUrl, 'https://api.kimi.com/coding/v1')
assert.deepEqual(validateSourceModelQuery({ id: 'deepseek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com/', apiKey: ' new-key ' }), {
  id: 'deepseek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'new-key'
})
assert.throws(() => validateSourceModelQuery({ id: 'glm', preset: 'deepseek', baseUrl: 'https://api.deepseek.com' }))
assert.throws(() => validateSourceInput({ ...input, models: ['k3', 'k3'] }))
assert.throws(() => validateSourceInput({ ...input, baseUrl: 'https://user:key@example.com' }))
assert.throws(() => validateSourceInput({ ...input, apiKey: 'bad\r\nAuthorization: another' }))
assert.throws(() => validateSourceInput({ ...input, preset: 'glm' }))
assert.throws(() => validateSourceInput({ ...input, baseUrl: 'http://127.0.0.1:11436/api/codex/v1' }))
const mimoInput = { id: 'mimo', preset: 'mimo', enabled: true, baseUrl: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.6-pro'], apiKey: 'mimo-key' }
assert.deepEqual(validateSourceInput(mimoInput), mimoInput)
assert.throws(() => validateSourceInput({ ...mimoInput, id: 'glm' }), '来源 ID 与接入方式必须匹配')
assert.throws(() => validateSourceInput({ ...mimoInput, models: ['mimo-v2.6-pro', 'bad model'] }))
assert.equal(validateSourceInput({ ...mimoInput, baseUrl: 'https://api.xiaomimimo.com/v1/' }).baseUrl, 'https://api.xiaomimimo.com/v1')
const mimoTokenPlanInput = { ...mimoInput, preset: 'mimo-token-plan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'tp-key' }
assert.deepEqual(validateSourceInput(mimoTokenPlanInput), mimoTokenPlanInput)
assert.throws(() => validateSourceInput({ ...mimoTokenPlanInput, id: 'kimi' }), 'Token Plan 接入方式同样必须匹配来源 ID')

const updateRuntimeIssues = (codexSourceModule as Record<string, unknown>).updateCodexSourceRuntimeIssues
assert.equal(typeof updateRuntimeIssues, 'function', 'Codex 来源需要按厂商和模型维护临时运行异常')
const kimiIssue = {
  sourceId: 'kimi', model: 'k3', code: 'codex_source_response_aborted', message: '响应中断，请重试',
  occurredAt: 100, stage: 'upstream_response', error: { name: 'Error', message: 'aborted', code: 'ECONNRESET' }
}
const deepseekIssue = {
  sourceId: 'deepseek', model: 'deepseek-v4-pro', code: 'codex_source_http_error', message: '请求失败（HTTP 500）',
  occurredAt: 200, stage: 'upstream_response', statusCode: 500
}
let runtimeIssues = (updateRuntimeIssues as Function)([], { type: 'issue', issue: kimiIssue })
runtimeIssues = (updateRuntimeIssues as Function)(runtimeIssues, { type: 'issue', issue: deepseekIssue })
runtimeIssues = (updateRuntimeIssues as Function)(runtimeIssues, { type: 'recovered', sourceId: 'kimi', model: 'k3-256k' })
assert.deepEqual(runtimeIssues, [deepseekIssue, kimiIssue], '同厂商其他模型恢复不能误清除当前模型异常')
runtimeIssues = (updateRuntimeIssues as Function)(runtimeIssues, { type: 'recovered', sourceId: 'kimi', model: 'k3' })
assert.deepEqual(runtimeIssues, [deepseekIssue], '只有同一模型恢复后才清除对应异常')

const modelIssuesForSource = (codexSourceModule as Record<string, unknown>).codexSourceModelIssues
assert.equal(typeof modelIssuesForSource, 'function', '服务快照需要把模型异常归属到对应接入商')
assert.deepEqual((modelIssuesForSource as Function)([deepseekIssue, kimiIssue], 'kimi'), [{
  model: 'k3', code: 'codex_source_response_aborted', message: '响应中断，请重试', occurredAt: 100,
  stage: 'upstream_response', error: { name: 'Error', message: 'aborted', code: 'ECONNRESET' }
}])

const toRuntimeDiagnostic = (diagnosticModule as Record<string, unknown>).codexSourceRuntimeDiagnostic
assert.equal(typeof toRuntimeDiagnostic, 'function', 'Codex 来源错误需要转换为 App 运行错误日志')
const diagnosticRoot = mkdtempSync(join(tmpdir(), 'uniagent-codex-source-diagnostic-'))
try {
  const store = new diagnosticModule.DiagnosticsStore(join(diagnosticRoot, 'diagnostics.jsonl'))
  store.record((toRuntimeDiagnostic as Function)(kimiIssue))
  const [entry] = store.list()
  assert.deepEqual({ category: entry.category, source: entry.source, agentId: entry.agentId, code: entry.code, field: entry.field }, {
    category: 'app_runtime', source: 'codex-sources', agentId: 'codex', code: 'codex_source_response_aborted', field: 'kimi:k3'
  })
  assert.match(entry.message, /Kimi.+k3.+响应中断/)
  assert.match(entry.sample || '', /ECONNRESET/)
  assert.doesNotMatch(entry.sample || '', /apiKey|authorization/i)
  const serviceDiagnostic = (toRuntimeDiagnostic as Function)({
    code: 'codex_source_request_compression',
    message: '请重新打开 Codex 会话，使接入配置生效（当前请求仍开启压缩）',
    occurredAt: 300,
    stage: 'request_validation'
  })
  assert.equal(serviceDiagnostic.field, undefined)
  assert.equal(serviceDiagnostic.message, '请重新打开 Codex 会话，使接入配置生效（当前请求仍开启压缩）')
} finally {
  rmSync(diagnosticRoot, { recursive: true, force: true })
}

const SourceRuntimeIssues = (codexSourceSettingsModule as Record<string, unknown>).SourceRuntimeIssues
assert.equal(typeof SourceRuntimeIssues, 'function', '接入商 item 需要渲染对应模型的临时异常')
const sourceIssueMarkup = renderToStaticMarkup(createElement(SourceRuntimeIssues as any, { issues: [
  { model: 'k3', code: 'codex_source_response_aborted', message: '响应中断，请重试', occurredAt: 100, stage: 'upstream_response' },
  { model: 'k3-256k', code: 'codex_source_http_error', message: '请求失败（HTTP 429），请检查额度或稍后重试', occurredAt: 200, stage: 'upstream_response', statusCode: 429 }
] }))
assert.match(sourceIssueMarkup, /k3[^<]*响应中断，请重试/)
assert.match(sourceIssueMarkup, /k3-256k[^<]*请求失败/)
assert.doesNotMatch(renderToStaticMarkup(createElement(SourceRuntimeIssues as any, { issues: [] })), /codex-source-runtime-issue/)

const servers: Server[] = []
const calls: { path: string; authorization?: string; account?: string; body: string }[] = []
const modelCalls: { path: string; authorization?: string }[] = []
const attempts = new Map<string, number>()
async function modelUpstream(): Promise<string> {
  const server = createServer((req, res) => {
    modelCalls.push({ path: req.url!, authorization: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'latest-a' }, { id: 'latest-b' }] }))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function upstream(): Promise<string> {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ path: req.url!, authorization: req.headers.authorization, account: req.headers['chatgpt-account-id'] as string, body })
    const model = JSON.parse(body || '{}').model as string | undefined
    const attempt = model ? (attempts.get(model) || 0) + 1 : 0
    if (model) attempts.set(model, attempt)
    if (model === 'gpt-error' || model === 'k3-error' || model === 'k3-flaky' && attempt === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":"upstream failed"}')
      return
    }
    if (model === 'mimo-balance') {
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end('{"error":{"code":"402","message":"Insufficient account balance","type":"insufficient_balance"}}')
      return
    }
    if (model === 'mimo-unsupported') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end('{"error":{"code":"responses_feature_not_supported","message":"tool type web_search is not supported by this gateway phase.","type":"unsupported_feature"}}')
      return
    }
    if (model === 'k3-quota') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."}}')
      return
    }
    if (model === 'k3-overflow') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"Your request exceeded k3-256k model token limit: 262144","type":"invalid_authentication_error"}}')
      return
    }
    if (model === 'k3-auth400' || model === 'k3-big400' || model === 'k3-invalid400') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(model === 'k3-invalid400' ? '{bad json' : JSON.stringify({ error: {
        message: model === 'k3-auth400' ? 'API key is invalid' : 'Your request exceeded k3-256k model token limit: 262144' + 'x'.repeat(9000),
        type: 'invalid_authentication_error'
      } }))
      return
    }
    if (model === 'k3-schema') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: "Invalid request: tools.function.parameters is not a valid moonshot flavored json schema, details: <At path 'properties.steps': detected infinite recursion without termination condition>" } }))
      return
    }
    if (model === 'k3-rate' || model === 'k3-auth') {
      res.writeHead(model === 'k3-rate' ? 429 : 403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: model === 'k3-rate' ? 'Rate limited' : 'Quota service authorization failed: invalid API Key' } }))
      return
    }
    if (model === 'k3-eof' || model === 'k3-failed') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"response.created"}\n\n')
      if (model === 'k3-failed') res.write('data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n')
      res.end()
      return
    }
    if (model === 'k3-truncated' || model === 'k3-invalid') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"response.created"}\n\n')
      res.end(model === 'k3-truncated'
        ? 'data: {"type":"response.completed"}'
        : 'event: response.completed\ndata: {broken\n\n')
      return
    }
    if (model === 'k3-split') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      const frames = Buffer.from('event: response.created\r\ndata: {}\r\n\r\ndata: {"type":"response.completed",\r\ndata: "response":{"output_text":"中文"}}\r\n\r\n')
      for (const byte of frames) res.write(Buffer.from([byte]))
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"type":"response.created"}\n\n')
    res.end('data: {"type":"response.completed"}\n\n')
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
try {
  const modelsUrl = await modelUpstream()
  assert.deepEqual(await fetchSourceModels(modelsUrl + '/v1', 'models-only-key'), ['latest-a', 'latest-b'])
  assert.deepEqual(modelCalls, [{ path: '/v1/models', authorization: 'Bearer models-only-key' }])
  const unusedOfficialUrl = await upstream()
  assert.ok(unusedOfficialUrl)
  const kimiUrl = await upstream()
  const runtimeEvents: unknown[] = []
  const router = await startCodexSourceRouter({ port: 0, sources: [
    { id: 'kimi', baseUrl: kimiUrl + '/coding/v1', models: ['k3', 'k3-error', 'k3-flaky', 'k3-quota', 'k3-overflow', 'k3-schema', 'k3-rate', 'k3-auth', 'k3-eof', 'k3-failed', 'k3-split', 'k3-truncated', 'k3-invalid', 'k3-auth400', 'k3-big400', 'k3-invalid400'], apiKey: 'kimi-only-key' },
    { id: 'deepseek', baseUrl: kimiUrl + '/deepseek/v1', models: ['k3'], apiKey: 'deepseek-only-key' },
    { id: 'mimo', baseUrl: kimiUrl + '/mimo/v1', models: ['mimo-v2.6-pro', 'mimo-balance', 'mimo-unsupported'], apiKey: 'mimo-only-key' }
  ] }, event => runtimeEvents.push(event))
  servers.push(router)
  const port = (router.address() as { port: number }).port
  const send = (model: string, headers = {}, source = 'kimi', extra = {}): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/api/codex/v1/${source}/responses`, method: 'POST', headers: { authorization: 'Bearer original-only-key', 'chatgpt-account-id': 'original-account', ...headers } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ model, stream: true, ...extra }))
  })
  assert.equal((await send('gpt-test')).status, 404)
  assert.equal(calls.length, 0, '第三方路由不接收官方模型，也不转发官方凭据')
  const response = await send('k3')
  assert.equal(response.status, 200)
  assert.match(response.body, /response.created[\s\S]*response.completed/)
  assert.equal(calls[0].authorization, 'Bearer kimi-only-key')
  assert.equal(calls[0].account, undefined)
  assert.equal(calls[0].path, '/coding/v1/responses')
  const eventsBeforeOriginalFailure = runtimeEvents.length
  assert.equal((await send('gpt-error')).status, 404)
  assert.equal(runtimeEvents.length, eventsBeforeOriginalFailure, '原有模型的请求错误不应显示在额外来源配置页')
  assert.equal((await send('k3-error')).status, 500)
  const sourceFailure = runtimeEvents.find((event: any) => event?.type === 'issue' && event.issue?.model === 'k3-error') as any
  assert.deepEqual(sourceFailure && {
    type: sourceFailure.type, sourceId: sourceFailure.issue.sourceId, model: sourceFailure.issue.model,
    code: sourceFailure.issue.code, message: sourceFailure.issue.message, stage: sourceFailure.issue.stage,
    statusCode: sourceFailure.issue.statusCode
  }, {
    type: 'issue', sourceId: 'kimi', model: 'k3-error', code: 'codex_source_http_error',
    message: '请求失败（HTTP 500）', stage: 'upstream_response', statusCode: 500
  }, '额外来源错误必须携带对应厂商和模型')
  assert.equal((await send('k3-flaky')).status, 500)
  assert.equal((await send('k3-flaky')).status, 200)
  assert.deepEqual(runtimeEvents.filter((event: any) => event?.type === 'issue' && event.issue?.model === 'k3-flaky' || event?.type === 'recovered' && event.model === 'k3-flaky').map((event: any) => event.type), ['issue', 'recovered'], '同一模型后续成功必须发送恢复事件')
  const quotaResponse = await send('k3-quota')
  assert.equal(quotaResponse.status, 403)
  assert.match(quotaResponse.body, /usage limit/, '错误体必须原样透传给调用方')
  const quotaIssue = runtimeEvents.find((event: any) => event?.type === 'issue' && event.issue?.model === 'k3-quota') as any
  assert.equal(quotaIssue?.issue?.message, '请求失败（HTTP 403），额度或用量已达上限，请等待重置或检查套餐', '403 额度耗尽不得误报为 API Key 失效')
  const overflowResponse = await send('k3-overflow')
  assert.equal(overflowResponse.status, 200, '流式 Responses 使用失败事件传递标准错误，并非成功完成')
  const overflowEvent = JSON.parse(overflowResponse.body.replace(/^data: /, '').trim())
  assert.equal(overflowEvent.type, 'response.failed')
  assert.equal(overflowEvent.response.error.code, 'context_length_exceeded',
    '上游误标的上下文超限必须转成 Codex 可识别的标准错误码')
  assert.match(overflowEvent.response.error.message, /262144/, '保留上游模型与限制证据')
  const overflowIssue = runtimeEvents.find((event: any) => event?.type === 'issue' && event.issue?.model === 'k3-overflow') as any
  assert.equal(overflowIssue?.issue?.message, '请求失败（HTTP 400），请求超过模型上下文限制，请压缩上下文或新建会话', '400 上下文超限需给出可操作提示')
  assert.equal((await send('k3', { 'Content-Encoding': 'zstd' })).status, 415)
  assert.deepEqual(runtimeEvents.find((event: any) => event?.type === 'service-issue') && (() => {
    const event = runtimeEvents.find((value: any) => value?.type === 'service-issue') as any
    return { type: event.type, code: event.issue.code, message: event.issue.message }
  })(), {
    type: 'service-issue', code: 'codex_source_request_compression',
    message: '请重新打开 Codex 会话，使接入配置生效（当前请求仍开启压缩）'
  }, '无法归属到具体模型的接入服务错误仍需结构化上报')
  assert.equal((await send('unregistered')).status, 404, '未知模型绝不能猜测或回退官方接口')
  assert.equal((await send('k3', { Origin: 'https://untrusted.example' })).status, 403)
  assert.equal(calls.length, 6, 'cross-site requests must never reach an upstream')
  const schemaResponse = await send('k3-schema')
  assert.equal(schemaResponse.status, 400)
  assert.match(schemaResponse.body, /properties.steps/, 'retain the upstream error body')
  const schemaIssue = runtimeEvents.find((event: any) => event?.type === 'issue' && event.issue?.model === 'k3-schema') as any
  assert.equal(schemaIssue?.issue?.message, '请求失败（HTTP 400），工具参数 Schema 不兼容，请检查或更新 MCP 工具配置')
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/codex/v1/kimi/models?client_version=0.156.1', method: 'GET' }, res => {
      assert.equal(res.statusCode, 200)
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(calls.length, 7, '模型目录只返回当前第三方来源，不访问官方接口')
  const nonStreaming = await send('k3-overflow', {}, 'kimi', { stream: false })
  assert.equal(nonStreaming.status, 400, '非流式调用不能改成 SSE')
  assert.equal(JSON.parse(nonStreaming.body).error.type, 'invalid_authentication_error')
  assert.equal(runtimeEvents.some((event: any) => event.type === 'recovered' && event.model === 'k3-overflow'), false,
    '标准失败事件不能清除来源故障')
  const auth400 = await send('k3-auth400')
  assert.equal(auth400.status, 400)
  assert.equal(JSON.parse(auth400.body).error.code, undefined, '普通认证错误不能伪装成上下文超限')
  const oversizedError = await send('k3-big400')
  assert.equal(oversizedError.status, 400)
  assert.equal(JSON.parse(oversizedError.body).error.message,
    'Your request exceeded k3-256k model token limit: 262144' + 'x'.repeat(9000), '大错误体继续透传，不能截断或无限缓存')
  const invalidError = await send('k3-invalid400')
  assert.equal(invalidError.status, 400)
  assert.equal(invalidError.body, '{bad json')
  assert.equal((await send('k3', {}, 'deepseek')).status, 200)
  assert.equal(calls.at(-1)?.path, '/deepseek/v1/responses')
  assert.equal(calls.at(-1)?.authorization, 'Bearer deepseek-only-key', '同名模型严格按来源路由')
  assert.equal((await send('k3', {}, 'unknown')).status, 404)
  for (const model of ['k3-eof', 'k3-failed', 'k3-truncated', 'k3-invalid']) {
    const response = await send(model)
    assert.equal(response.status, 200, 'observer must preserve the upstream status and stream')
    assert.match(response.body, /response.created/)
    assert.ok(runtimeEvents.some((event: any) => event.type === 'issue' && event.issue.model === model && event.issue.code === 'codex_source_response_incomplete'))
    assert.equal(runtimeEvents.some((event: any) => event.type === 'recovered' && event.model === model), false, 'EOF and SSE failure must not clear provider health')
  }
  assert.equal((await send('k3-split')).status, 200)
  assert.ok(runtimeEvents.some((event: any) => event.type === 'recovered' && event.model === 'k3-split'), 'chunking, UTF-8, CRLF and multiline data must not cause false failures')
  assert.equal((await send('k3-rate')).status, 429)
  assert.equal((await send('k3-auth')).status, 403)
  const rateIssue = runtimeEvents.find((event: any) => event.type === 'issue' && event.issue.model === 'k3-rate') as any
  const authIssue = runtimeEvents.find((event: any) => event.type === 'issue' && event.issue.model === 'k3-auth') as any
  assert.match(rateIssue.issue.message, /请求频率受限/)
  assert.doesNotMatch(rateIssue.issue.message, /额度或用量已达上限/)
  assert.match(authIssue.issue.message, /请检查 API Key/)
  const parameters = {
    type: 'object', properties: { steps: { $ref: '#/$defs/steps', description: '操作步骤' },
      $ref: { type: 'string' }, data: { default: { $ref: '#/opaque-user-value' } } }, required: ['steps'],
    $defs: { steps: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      first: { $ref: '#/$defs/integer' }, second: { $ref: '#/$defs/integer' }
    }, required: ['first'], additionalProperties: false } }, integer: { type: 'integer' } }
  }
  const tools = [{ type: 'namespace', name: 'mcp__fixture', tools: [{ type: 'function', name: 'run', parameters }] }]
  const input = [{ role: 'user', content: '继续原任务' }]
  await send('k3', {}, 'kimi', { input, tools })
  const normalized = JSON.parse(calls.at(-1)!.body)
  assert.deepEqual(normalized.input, input, '工具兼容处理不得改变会话输入')
  assert.equal(normalized.tools[0].tools[0].name, 'run', '保留工具名称及命名空间')
  assert.deepEqual(normalized.tools[0].tools[0].parameters, {
    type: 'object', properties: { steps: { type: 'array', minItems: 1, description: '操作步骤', items: {
      type: 'object', properties: { first: { type: 'integer' }, second: { type: 'integer' } }, required: ['first'], additionalProperties: false
    } }, $ref: { type: 'string' }, data: { default: { $ref: '#/opaque-user-value' } } }, required: ['steps']
  }, '展开非循环引用，重复使用同一类型不能误判为循环')
  await send('k3', {}, 'deepseek', { tools })
  assert.deepEqual(JSON.parse(calls.at(-1)!.body).tools, tools, '其它来源保持原协议')
  const nativeInput = [
    { type: 'message', id: 'msg_foreign-developer', role: 'developer', content: [{ type: 'input_text', text: '项目约束' }, { type: 'input_text', text: '运行环境' }] },
    { type: 'message', id: 'msg_foreign-user', role: 'user', content: [{ type: 'input_text', text: '继续' }, { type: 'input_image', image_url: 'data:image/png;base64,fixture' }] },
    { type: 'function_call', id: 'fc_trace', call_id: 'call_pair', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_pair', output: 'result' },
    { type: 'item_reference', id: 'msg_reference' }
  ]
  await send('k3', {}, 'kimi', { input: nativeInput })
  assert.deepEqual(JSON.parse(calls.at(-1)!.body).input, [
    { type: 'message', role: 'developer', content: nativeInput[0].content },
    { type: 'message', role: 'user', content: nativeInput[1].content },
    ...nativeInput.slice(2)
  ], 'Kimi 接收完整内联消息正文，不能携带旧来源的消息 ID；图片、顺序、调用配对和真正的引用保持原样')
  await send('k3', {}, 'deepseek', { input: nativeInput })
  assert.deepEqual(JSON.parse(calls.at(-1)!.body).input, nativeInput, 'Kimi 的消息 ID 兼容处理不得影响其它来源')
  for (const schema of [
    { type: 'object', properties: { next: { $ref: '#' } } },
    { type: 'object', properties: { next: { $ref: '#/$defs/node' } }, $defs: {
      node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } }
    } },
    { type: 'object', properties: { next: { $ref: '#/$defs/missing' } } },
    { type: 'object', properties: { next: { $ref: 'https://example.invalid/schema' } } },
    { type: 'object', properties: { next: { $ref: '#/$defs/text', type: 'integer' } }, $defs: { text: { type: 'string' } } }
  ]) {
    const original = [{ type: 'function', name: 'recursive', parameters: schema }]
    await send('k3', {}, 'kimi', { tools: original })
    assert.deepEqual(JSON.parse(calls.at(-1)!.body).tools, original, '不能篡改无法等价展开的 Schema')
  }
  // 小米 MiMo 走 Responses 转发；同名/未知模型严格按来源路由，不泄漏其它来源密钥。
  assert.equal((await send('mimo-v2.6-pro', {}, 'mimo')).status, 200)
  assert.equal(calls.at(-1)?.path, '/mimo/v1/responses')
  assert.equal(calls.at(-1)?.authorization, 'Bearer mimo-only-key')
  assert.equal((await send('mimo-v2.6-pro', {}, 'kimi')).status, 404, 'Kimi 来源不能接收未登记的 MiMo 模型')
  assert.equal((await send('k3', {}, 'mimo')).status, 404, 'MiMo 来源不能转发 Kimi 模型')
  assert.equal((await send('mimo-custom', {}, 'mimo')).status, 404, '未知 MiMo 模型不能猜测路由')
  const balanceResponse = await send('mimo-balance', {}, 'mimo')
  assert.equal(balanceResponse.status, 402)
  assert.match(balanceResponse.body, /Insufficient account balance/, '余额错误体必须原样透传给调用方')
  const balanceIssue = runtimeEvents.find((event: any) => event.type === 'issue' && event.issue?.model === 'mimo-balance') as any
  assert.equal(balanceIssue?.issue?.statusCode, 402)
  assert.equal(balanceIssue?.issue?.message, '请求失败（HTTP 402），余额或套餐额度不足，请充值后重试', '402 必须提示充值而不是只报状态码')
  assert.equal((await send('mimo-unsupported', {}, 'mimo')).status, 400)
  const unsupportedIssue = runtimeEvents.find((event: any) => event.type === 'issue' && event.issue?.model === 'mimo-unsupported') as any
  assert.equal(unsupportedIssue?.issue?.message, '请求失败（HTTP 400），上游不支持当前请求的工具或能力，请关闭对应功能或更新接入配置', '不支持的托管工具必须给出可操作提示')
  const filterRoot = mkdtempSync(join(tmpdir(), 'uniagent-router-quota-'))
  try {
    const store = new diagnosticModule.DiagnosticsStore(join(filterRoot, 'diagnostics.jsonl'))
    assert.equal(store.record(diagnosticModule.codexSourceRuntimeDiagnostic(quotaIssue.issue)), undefined)
    assert.ok(store.record(diagnosticModule.codexSourceRuntimeDiagnostic(rateIssue.issue)))
    assert.ok(store.record(diagnosticModule.codexSourceRuntimeDiagnostic(authIssue.issue)))
  } finally { rmSync(filterRoot, { recursive: true, force: true }) }
} finally {
  await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
}

// 设置页由服务快照驱动：新的 MiMo 行必须与默认接入方式一起出现在 Codex 来源列表。
const snapshotFixture = mkdtempSync(join(tmpdir(), 'ua-codex-source-snapshot-'))
try {
  process.env.UNIAGENT_USER_DATA = snapshotFixture
  process.env.CODEX_HOME = join(snapshotFixture, 'codex-home')
  const snapshot = new CodexSourceService().snapshot()
  assert.deepEqual(snapshot.sources.map(source => source.id), ['kimi', 'deepseek', 'glm', 'mimo'])
  assert.deepEqual(snapshot.sources.find(source => source.id === 'mimo'), {
    id: 'mimo', preset: 'mimo', enabled: false, baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], hasKey: false
  })
} finally {
  rmSync(snapshotFixture, { recursive: true, force: true })
  delete process.env.UNIAGENT_USER_DATA
  delete process.env.CODEX_HOME
}
console.log('codex-sources: configuration protection and credential routing checks passed')
