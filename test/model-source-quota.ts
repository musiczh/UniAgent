import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSourceService } from '../src/main/model-sources/service'
import { normalizeQuotaResponse, quotaRequestFor } from '../src/main/codexSourceQuota'
import { modelSourceConsoleUrl, modelSourceQuotaProvider, validateSourceConsoleUrl } from '../src/shared/modelSourceQuota'
import { sourceDraft, validateModelSource } from '../src/shared/modelSources'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'
import { SettingsService } from '../src/main/settingsService'
import { encryptLocalSecretAsync, decryptLocalSecretAsync } from '../src/main/localSecretStore'

const mimo = normalizeQuotaResponse('mimo', { object: 'balance', balance_infos: [{ currency: 'CNY', cash_balance: '20.00', gift_balance: '5.00', total_available: '35.00', frozen_balance: '8.00', credit_available: '10.00' }] }, 1000)
assert.equal(mimo.balances?.[0].total, '27.00', 'deduct frozen amounts from availability; retain credit detail')
assert.equal(mimo.balances?.[0].creditAvailable, '10.00')
assert.throws(() => normalizeQuotaResponse('kimi-code', {}), /未返回套餐额度/)
assert.equal(normalizeQuotaResponse('kimi-code', { usages: { limit_month_code: { used_ratio: 0.25 } } }).windows?.[0].usedPercent, 25)
const kimiCurrent = normalizeQuotaResponse('kimi-code', {
  usage: { limit: '100', remaining: '82', resetTime: '2026-11-23T00:00:00Z' },
  limits: [
    { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '76', resetTime: '2026-11-18T04:50:00Z' } },
    { window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: '10', remaining: '0' } }
  ]
})
assert.deepEqual(kimiCurrent.windows?.map(window => [window.label, window.usedPercent]), [['5 小时额度', 24], ['1 天额度', 100], ['每周额度', 18]])
assert.equal(kimiCurrent.windows?.[0].resetsAt, Date.parse('2026-11-18T04:50:00Z'))
for (const detail of [{ limit: 100 }, { limit: 0, remaining: 0 }, { limit: 100, remaining: 'bad' }, { limit: 100, remaining: 101 }]) {
  assert.throws(() => normalizeQuotaResponse('kimi-code', { usage: detail }), /额度/)
}
for (const total_available of [null, '', 'bad']) assert.throws(() => normalizeQuotaResponse('mimo', { object: 'balance', balance_infos: [{ total_available, frozen_balance: 0 }] }))
const credits = normalizeQuotaResponse('mimo-token-plan', { object: 'token_plan', quota: { remaining_credits: 0, total_credits: 100 }, period: { end_at: '2026-12-01 00:00:00' } }, 1000)
assert.deepEqual(credits.credits, { remaining: 0, total: 100, unit: '积分', resetsAt: Date.parse('2026-12-01T00:00:00Z') })
for (const remaining_credits of [null, -1, 101]) assert.throws(() => normalizeQuotaResponse('mimo-token-plan', { object: 'token_plan', quota: { remaining_credits, total_credits: 100 } }))
assert.match(quotaRequestFor('mimo-token-plan', 'https://token-plan-cn.xiaomimimo.com/v1', 'fixture')!.url, /token_plan$/)
for (const preset of ['deepseek', 'glm', 'mimo'] as const) assert.ok(modelSourceQuotaProvider(sourceDraft(preset)))
assert.equal(modelSourceQuotaProvider({ ...sourceDraft('mimo', 'token-plan'), plan: 'mimo-token-plan' })?.preset, 'mimo-token-plan')
assert.equal(sourceDraft('mimo', 'mimo-token-plan').plan, 'token-plan')
assert.ok(sourceDraft('mimo', 'mimo-token-plan').endpoints.every(endpoint => endpoint.baseUrl.includes('token-plan-cn.xiaomimimo.com')))
assert.equal(modelSourceQuotaProvider({ ...sourceDraft('deepseek'), endpoints: [{ id: 'x', protocol: 'openai-chat', baseUrl: 'https://proxy.example/v1', auth: 'bearer' }] }), undefined)
if (INTERNAL_DISTRIBUTION) assert.equal(modelSourceConsoleUrl(sourceDraft('trae')), undefined, 'do not invent an enterprise console')
else assert.throws(() => sourceDraft('trae'), /数据源预设不可用/, 'the public edition must not expose the internal enterprise preset')
assert.match(modelSourceConsoleUrl(sourceDraft('ark-coding-plan', 'coding'))!, /coding-plan$/)
assert.match(modelSourceConsoleUrl(sourceDraft('ark-coding-plan', 'agent'))!, /agent-plan$/)
for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com?api_key=secret', 'https://example.com/#access_token=secret']) assert.throws(() => validateSourceConsoleUrl(url))
assert.equal(validateSourceConsoleUrl('https://console.example.com/quota?tab=usage'), 'https://console.example.com/quota?tab=usage')
assert.equal(validateModelSource({ ...sourceDraft('deepseek'), consoleUrl: 'https://console.example.com' }).consoleUrl, 'https://console.example.com/')

const directory = await mkdtemp(join(tmpdir(), 'ua-source-quota-'))
process.env.UNIAGENT_USER_DATA = directory
let calls: { preset: string; key: string }[] = [], fail = false, release: (() => void) | undefined, defer = false
let configurationEvents = 0, quotaEvents = 0
let lastContext: any
const service = new ModelSourceService({ directory, agents: () => [], adapters: {}, gateway: { port: 0, close: async () => {}, update: async () => 0,
  queryQuota: async (preset, _base, key, context) => {
    lastContext = context
    calls.push({ preset, key })
    if (defer) await new Promise<void>(resolve => { release = resolve })
    if (fail) throw new Error('密钥无额度查询权限')
    return normalizeQuotaResponse('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] })
  } } })
try {
  await service.start()
  const first = await service.save({ source: { ...sourceDraft('deepseek'), apiKey: 'fixture-first' }, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'first' })
  const id = first.sources[0].id
  service.on('changed', () => configurationEvents++); service.on('quotaChanged', () => quotaEvents++)
  const revision = first.revision, initialConfig = JSON.stringify(service.configuration())
  defer = true
  const a = service.refreshQuotas(id), b = service.refreshQuotas(id, true)
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(service.snapshot().quotas![id].refreshing, true)
  release(); await Promise.all([a, b]); defer = false
  assert.equal(calls.length, 1, 'concurrent force and automatic refresh share the request')
  assert.equal(service.snapshot().quotas![id].balances![0].total, '0.00')
  assert.equal(service.snapshot().quotas![id].status, 'ready')
  await service.refreshQuotas(); assert.equal(calls.length, 1, 'fresh result is cached')
  fail = true; await service.refreshQuotas(id, true)
  assert.equal(service.snapshot().quotas![id].stale, true)
  assert.equal(service.snapshot().quotas![id].status, 'error')
  assert.equal(service.snapshot().quotas![id].balances![0].total, '0.00')
  await service.refreshQuotas(); assert.equal(calls.length, 2, 'failure has a short cache')
  assert.equal(configurationEvents, 0, 'quota changes must not re-project Agent models')
  assert.ok(quotaEvents >= 4)
  assert.equal(service.snapshot().revision, revision)
  assert.equal(JSON.stringify(service.configuration()), initialConfig, 'quota is runtime state, not a setting')
  assert.ok(!JSON.stringify(service.snapshot()).includes('fixture-first'))
  fail = false; defer = true; release = undefined
  const oldRequest = service.refreshQuotas(id, true)
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  await service.save({ source: { ...service.snapshot().sources[0], apiKey: 'fixture-second' }, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'rotate' })
  assert.equal(service.snapshot().quotas![id].balances, undefined, 'rotating keys clears account data immediately')
  release(); await oldRequest; defer = false
  assert.equal(service.snapshot().quotas![id].balances, undefined, 'late old-account response cannot reappear')
  await service.refreshQuotas(id)
  assert.equal(calls.at(-1)?.key, 'fixture-second')
  const settings = new SettingsService({ modelSources: { read: async () => service.configuration(), update: (changes, revision) => service.updateConfiguration(changes, revision) }, agents: () => [] } as any)
  const read = await settings.read('/codex-sources/configuration') as any
  assert.equal(read.schema.properties.sources.items.properties.consoleUrl.type, 'string')
  const sources = read.value.sources; sources[0].consoleUrl = 'https://console.example.com/quota'
  const updated = await settings.update('/codex-sources/configuration', { sources }, read.revision) as any
  assert.equal(updated.value.sources[0].consoleUrl, sources[0].consoleUrl)
  assert.equal(modelSourceConsoleUrl(service.snapshot().sources[0]), sources[0].consoleUrl)
  sources[0].consoleUrl = 'https://console.example.com?token=bad'
  await assert.rejects(settings.update('/codex-sources/configuration', { sources }, updated.revision), /凭据/)
  delete sources[0].consoleUrl
  await settings.update('/codex-sources/configuration', { sources }, updated.revision)
  assert.equal(service.snapshot().sources[0].consoleUrl, undefined)
  const store = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  assert.equal(store.quotas, undefined)
  await assert.rejects(service.refreshQuotas('missing'), /参数无效/)
  const before = calls.length
  for (const preset of INTERNAL_DISTRIBUTION ? ['trae', 'ark-coding-plan'] as const : ['ark-coding-plan'] as const) await service.save({ source: { ...sourceDraft(preset), apiKey: preset === 'trae' ? undefined : 'fixture-ark' }, bindings: [], expectedRevision: service.snapshot().revision, operationId: preset })
  await service.refreshQuotas()
  assert.equal(calls.length, before, 'unsupported providers never send a key to a guessed endpoint')
  const independentStore = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  independentStore.sources[0].endpointKeys = { [independentStore.sources[0].endpoints[0].id]: await encryptLocalSecretAsync('fixture-other-account') }
  await writeFile(join(directory, 'settings.json'), JSON.stringify(independentStore))
  let accountCalls = 0, accountFail = false
  const independent = new ModelSourceService({ directory, agents: () => [], adapters: {}, gateway: { port: 0, update: async () => 0, close: async () => {}, queryQuota: async (_preset, _base, key) => {
    accountCalls++
    if (accountFail && key === 'fixture-other-account') throw new Error('密钥无额度查询权限')
    return { status: 'ready', capturedAt: Date.now(), kind: 'balance', balances: [{ currency: 'CNY', total: key === 'fixture-other-account' ? '10' : '20' }] }
  } } })
  await independent.start(); await independent.refreshQuotas(id)
  const grouped = independent.snapshot().quotas![id]
  assert.equal(grouped.accounts?.length, 2)
  assert.equal(accountCalls, 2, 'same key is queried once across protocols')
  assert.equal(grouped.balances, undefined, 'different keys are never summed')
  assert.equal(grouped.accounts![0].quota.balances![0].total, '10')
  assert.ok(!JSON.stringify(grouped).includes('fixture-'))
  accountFail = true; await independent.refreshQuotas(id, true)
  const partial = independent.snapshot().quotas![id]
  assert.equal(partial.status, 'error')
  assert.equal(partial.accounts![0].quota.stale, true)
  assert.equal(partial.accounts![0].quota.balances![0].total, '10')
  assert.equal(partial.accounts![1].quota.status, 'ready')
  await independent.close()
  const ark = service.snapshot().sources.find(source => source.preset === 'ark-coding-plan')!
  assert.equal(service.snapshot().quotas![ark.id].needsCredentials, true)
  const events = configurationEvents
  const quotaInput = { sourceId: ark.id, expectedRevision: service.snapshot().revision, operationId: 'ark-quota', credentials: { accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-sk' } }
  const saved = await service.saveQuota(quotaInput)
  assert.equal(saved.sources.find(source => source.id === ark.id)!.revision, ark.revision, 'quota-only saves preserve model bindings')
  assert.equal(configurationEvents, events, 'quota config does not trigger model reapply')
  assert.equal(saved.sources.find(source => source.id === ark.id)!.hasQuotaCredentials, true)
  assert.equal((await service.saveQuota(quotaInput)).revision, saved.revision, 'save receipt is idempotent')
  assert.ok(!JSON.stringify(saved).includes('fixture-ak'))
  const credentialStatus = await settings.read('/codex-sources/configuration/quotaCredentialStatus') as any
  assert.deepEqual(credentialStatus.value.find((item: any) => item.sourceId === ark.id), { sourceId: ark.id, type: 'ak-sk', configured: true })
  assert.equal(credentialStatus.schema.readOnly, true)
  await assert.rejects(settings.update('/codex-sources/configuration/quotaCredentialStatus', [], credentialStatus.revision), /settings_field_not_writable/)
  assert.ok(!JSON.stringify(service.configuration()).includes('fixture-sk'))
  const persisted = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  const encrypted = persisted.sources.find((source: any) => source.id === ark.id).encryptedQuotaCredentials
  assert.ok(encrypted && !encrypted.includes('fixture-sk'))
  assert.equal(JSON.parse(await decryptLocalSecretAsync(encrypted)).secretAccessKey, 'fixture-sk')
  await service.refreshQuotas(ark.id, true)
  assert.equal(lastContext.credentials.secretAccessKey, 'fixture-sk')
  await assert.rejects(service.saveQuota({ ...quotaInput, operationId: 'stale' }), /revision_conflict/)
  await assert.rejects(service.saveQuota({ ...quotaInput, expectedRevision: saved.revision, operationId: 'incomplete', credentials: { accessKeyId: 'alone' } }), /AK.*SK/)
  const meta = await settings.read('/codex-sources/configuration') as any
  assert.equal(meta.schema.properties.sources.items.properties.quotaQuery.properties.template.type, 'string')
  const configSources = meta.value.sources
  configSources.find((source: any) => source.id === ark.id).quotaQuery = { template: 'console' }
  await settings.update('/codex-sources/configuration', { sources: configSources }, meta.revision)
  assert.equal(configurationEvents, events)
  assert.equal(service.snapshot().sources.find(source => source.id === ark.id)!.hasQuotaCredentials, false, 'template changes invalidate independent credentials')
  const custom = { ...sourceDraft('custom'), apiKey: 'fixture-model-key', endpoints: [{ id: 'chat', protocol: 'openai-chat' as const, baseUrl: 'https://team.example/v1', auth: 'bearer' as const }], models: [{ id: 'fixture', label: 'fixture', routes: [{ endpointId: 'chat', upstreamModel: 'fixture' }] }] }
  const customSaved = await service.save({ source: custom, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'custom' })
  const customId = customSaved.sources.at(-1)!.id
  await service.saveQuota({ sourceId: customId, expectedRevision: customSaved.revision, operationId: 'newapi-token', query: { template: 'new-api', userId: '123' }, credentials: { accessToken: 'fixture-access-token' } })
  const beforeRename = service.snapshot().sources.find(source => source.id === customId)!
  await service.save({ source: { ...beforeRename, name: 'Renamed' }, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'rename' })
  assert.equal(service.snapshot().sources.find(source => source.id === customId)!.hasQuotaCredentials, true, 'ordinary model saves retain query credentials')
  await service.refreshQuotas(customId, true)
  assert.equal(lastContext.credentials.accessToken, 'fixture-access-token')
  assert.equal(lastContext.query.userId, '123')
  const amountSettings = await settings.read('/codex-sources/configuration') as any
  amountSettings.value.sources.find((source: any) => source.id === customId).quotaQuery = { template: 'new-api', userId: '123', unit: 'USD', quotaPerUnit: 500000 }
  await settings.update('/codex-sources/configuration', { sources: amountSettings.value.sources }, amountSettings.revision)
  assert.equal(service.snapshot().sources.find(source => source.id === customId)!.hasQuotaCredentials, true, 'unit changes do not change account identity')
  await service.saveQuota({ sourceId: customId, expectedRevision: service.snapshot().revision, operationId: 'newapi-user', query: { template: 'new-api', userId: '456' } })
  assert.equal(service.snapshot().sources.find(source => source.id === customId)!.hasQuotaCredentials, false, 'user ID changes clear the old token')
  const withoutToken = calls.length; await service.refreshQuotas(customId, true)
  assert.equal(calls.length, withoutToken)
  assert.equal(service.snapshot().quotas![customId].needsCredentials, true)
  await service.saveQuota({ sourceId: customId, expectedRevision: service.snapshot().revision, operationId: 'newapi-token2', query: { template: 'new-api', userId: '456' }, credentials: { accessToken: 'fixture-next-token' } })
  const oldCustom = service.snapshot().sources.find(source => source.id === customId)!
  await service.save({ source: { ...oldCustom, apiKey: 'fixture-new-site-key', endpoints: oldCustom.endpoints.map(endpoint => ({ ...endpoint, baseUrl: 'https://different.example/v1' })) }, bindings: [], expectedRevision: service.snapshot().revision, operationId: 'newapi-origin' })
  assert.equal(service.snapshot().sources.find(source => source.id === customId)!.hasQuotaCredentials, false, 'new sites never receive old query tokens')
} finally { await service.close(); await rm(directory, { recursive: true, force: true }) }
console.log('model-source-quota: account identity, cache, zero/stale data, MiMo contracts and settings passed')
