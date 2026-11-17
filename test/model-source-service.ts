import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSourceService } from '../src/main/model-sources/service'
import { sourceDraft, validateModelSource } from '../src/shared/modelSources'
import { codexModelKey } from '../src/shared/codexModelIdentity'
import { encryptLocalSecretAsync } from '../src/main/localSecretStore'
import { manageRevision } from '../src/main/assistant/manageValue'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'
import { SettingsService } from '../src/main/settingsService'

const directory = await mkdtemp(join(tmpdir(), 'ua-model-sources-'))
process.env.UNIAGENT_USER_DATA = directory
let failKimi = true, busy = false, busySource = '', gatewayRoutes: any[] = []
const gateway = { port: 34567, update: async (value: any) => { gatewayRoutes = value.routes; return 34567 }, close: async () => {} }
const agents = () => ['codex', 'claude', 'kimi'].map(id => ({ id, installed: true })) as any[]
const deps = { agents, gateway, busy: (id: string, sourceId: string) => busy && id === 'kimi' && sourceId === busySource, adapters: { codex: { apply: async () => ({}) }, claude: { apply: async () => ({}) }, kimi: { apply: async () => { if (failKimi) throw new Error('fixture apply failure'); return { nativeModels: { 'deepseek-flash': 'kimi-native-flash' } } } } } }
const service = new ModelSourceService(deps)
try {
  await service.start()
  const draft = sourceDraft('deepseek')
  const input = { ...draft, preset: 'ark-coding-plan' as const, plan: 'coding', models: draft.models.map(model => ({ ...model, capabilities: { contextWindow: 1000000 } })), apiKey: 'fixture-source-key' }
  const bindings = [{ agentId: 'claude', enabled: true, endpointId: 'anthropic-messages', modelIds: ['deepseek-flash'] }, { agentId: 'kimi', enabled: true, endpointId: 'anthropic-messages', modelIds: ['deepseek-flash'] }]
  let saved = await service.save({ source: input, bindings, expectedRevision: service.snapshot().revision, operationId: 'save-one' })
  const source = saved.sources[0]
  assert.equal(saved.sources.length, 1)
  assert.equal(saved.statuses.find(status => status.agentId === 'claude')?.state, 'applied')
  assert.equal(saved.statuses.find(status => status.agentId === 'kimi')?.state, 'failed')
  assert.equal(gatewayRoutes[0].apiKey, input.apiKey)
  assert.ok(!JSON.stringify(saved).includes(input.apiKey))
  const text = await readFile(join(directory, 'model-sources/settings.json'), 'utf8')
  assert.ok(!text.includes(input.apiKey))
  assert.equal((await stat(join(directory, 'model-sources/settings.json'))).mode & 0o777, 0o600)
  const config = { agentId: 'claude', workdir: directory, model: codexModelKey('deepseek-flash', { kind: 'third-party', sourceId: source.id }) }
  service.assertReady(config)
  assert.equal(service.connection(config).apiKey, gatewayRoutes[0].token)
  assert.equal(service.mergeModels('claude', []).length, 1)
  await assert.rejects(service.save({ source: input, bindings, expectedRevision: 'stale', operationId: 'stale-op' }), /revision_conflict/)
  const repeated = await service.save({ source: input, bindings, expectedRevision: 'stale', operationId: 'save-one' })
  assert.equal(repeated.sources.length, 1, 'idempotent retry must not create a source')
  failKimi = false; saved = await service.apply(source.id)
  assert.equal(saved.statuses.find(status => status.agentId === 'kimi')?.state, 'applied')
  const oldRoute = gatewayRoutes.find(route => route.id.includes('/kimi/'))
  assert.notEqual(oldRoute.token, gatewayRoutes.find(route => route.id.includes('/claude/')).token, 'credentials are scoped to each Agent')
  busy = true; busySource = 'another-source'
  saved = await service.apply(source.id)
  assert.equal(saved.statuses.find(status => status.agentId === 'kimi')?.state, 'applied', 'a different source task must not block this source')
  busySource = source.id
  saved = await service.save({ source: { ...source, apiKey: 'rotated-fixture-key' }, bindings, expectedRevision: saved.revision, operationId: 'rotate-while-running' })
  assert.equal(saved.statuses.find(status => status.agentId === 'kimi')?.state, 'pending')
  assert.deepEqual(gatewayRoutes.find(route => route.id === oldRoute.id), oldRoute, 'whole active tool loop keeps its old route and key')
  assert.throws(() => service.assertReady({ ...config, agentId: 'kimi', model: 'kimi-native-flash' }), /尚未生效/)
  busy = false; await service.applyPending()
  assert.ok(!gatewayRoutes.some(route => route.id === oldRoute.id), 'retired route is removed when the Agent becomes idle')
  const native = { id: 'kimi-native-flash', label: 'native', efforts: ['medium'], defaultEffort: 'medium' } as any
  assert.deepEqual(service.mergeModels('kimi', [native])[0].efforts, ['medium'], 'native capability contract has priority')
  await service.save({ source: { ...input, name: 'second account' }, bindings: [], expectedRevision: saved.revision, operationId: 'second-account' })
  assert.equal(service.snapshot().sources.length, 2, 'same vendor must allow separate accounts')
  saved = await service.save({ source: { ...source, enabled: false }, bindings, expectedRevision: service.snapshot().revision, operationId: 'disable-source' })
  assert.throws(() => service.assertReady(config), /停用/)
  assert.deepEqual(service.mergeModels('claude', []), [])
  assert.ok(!gatewayRoutes.some(route => route.id.startsWith(source.id + '/')))
  await assert.rejects(service.save({ source: { ...source, endpoints: source.endpoints.map(endpoint => ({ ...endpoint, baseUrl: 'https://another.example' })) }, bindings: [], expectedRevision: saved.revision, operationId: 'changed-address' }), /API Key/)
  const restore = new ModelSourceService(deps); await restore.start()
  assert.equal(restore.snapshot().sources.length, 2)
  assert.ok(restore.snapshot().sources.every(source => source.hasCredential))
  const configuration = service.configuration() as any
  assert.ok(!JSON.stringify(configuration).includes('encryptedKey'))
  for (const metadata of ['appliedRevision','appliedRuntimeRevision','retiredNativeModels','nativeModels','managedHash']) assert.ok(!JSON.stringify(configuration).includes(metadata))
  configuration.sources[1].name = 'via settings'
  const unchangedRevision = service.snapshot().sources[0].revision
  await service.updateConfiguration({ sources: configuration.sources }, manageRevision(service.configuration()))
  assert.equal(service.snapshot().sources[1].name, 'via settings')
  assert.equal(service.snapshot().sources[0].revision, unchangedRevision, 'editing another source does not change a source runtime revision')
  await assert.rejects(service.updateConfiguration({ sources: [] }, manageRevision(service.configuration())), /删除/)
  await service.updateConfiguration({ bindings: [] }, manageRevision(service.configuration()))
  assert.ok(service.owns({ ...config, agentId: 'kimi', model: 'kimi-native-flash' }), 'withdrawal preserves native model ownership')
  assert.equal(service.mergeModels('kimi', [native]).length, 0, 'withdrawn native entries cannot leak back into selection')
  assert.deepEqual(service.projectNativeModels('kimi', [native]), [], 'live native catalogs also hide withdrawn managed entries')
  const settings = new SettingsService({ modelSources: { read: async () => service.configuration(), update: (changes, revision) => service.updateConfiguration(changes, revision) }, agents } as any)
  const settingsRead = await settings.read('/codex-sources/configuration') as any
  assert.equal(settingsRead.schema.properties.sources.type, 'array')
  assert.equal(settingsRead.schema.properties.sources.items.properties.models.items.properties.maxContextWindow.type, 'integer')
  const settingsSources = structuredClone(settingsRead.value.sources); settingsSources[1].enabled = !settingsSources[1].enabled
  settingsSources[1].models[0].maxContextWindow = 1000000
  settingsSources[1].models[0].capabilities.contextWindow = 900000
  const settingsSaved = await settings.update('/codex-sources/configuration', { sources: settingsSources }, settingsRead.revision) as any
  assert.equal(settingsSaved.value.sources[1].enabled, settingsSources[1].enabled)
  assert.equal(settingsSaved.value.sources[1].models[0].maxContextWindow, 1000000)
  assert.equal(settingsSaved.value.sources[1].models[0].capabilities.contextWindow, 900000)
  const overLimit = structuredClone(settingsSaved.value.sources); overLimit[1].models[0].capabilities.contextWindow = 1000001
  await assert.rejects(settings.update('/codex-sources/configuration', { sources: overLimit }, settingsSaved.revision), /官方上限/)
  await assert.rejects(settings.update('/codex-sources/configuration', { sources: [] }, settingsRead.revision), /revision_conflict/)
  await assert.rejects(settings.update('/codex-sources/configuration', { sources: [{ ...settingsSources[0], apiKey: 'must-not-accept' }] }, settingsSaved.revision), /invalid_|not_writable/)
  const importer = new ModelSourceService({ ...deps, directory: join(directory, 'imports'), adapters: { kimi: { apply: async () => ({}), discover: async () => [{ ...input, apiKey: 'native-import-key' }] } } })
  const imports = await importer.discoverImports()
  assert.equal(imports.candidates[0].hasCredential, true); assert.ok(!JSON.stringify(imports).includes('native-import-key'))
  await importer.start()
  const imported = await importer.save({ source: imports.candidates[0].source, bindings: [], expectedRevision: importer.snapshot().revision, operationId: 'native-import' })
  assert.equal(imported.sources[0].hasCredential, true); await importer.close()

  const repairDirectory = join(directory, 'capability-repair')
  let appliedCapabilities: any, repairBusy = false
  const repairDeps = { directory: repairDirectory, agents: () => [{ id: 'kimi', installed: true }] as any, gateway, busy: () => repairBusy, adapters: { kimi: { apply: async (source: any) => { appliedCapabilities = source.models[0].capabilities; return { nativeModels: { 'kimi-k3.1-pro': 'native-k3' } } } } } }
  const seed = new ModelSourceService(repairDeps); await seed.start()
  const ark = sourceDraft('ark-coding-plan'); ark.models = ark.models.filter(model => model.id === 'kimi-k3.1-pro'); ark.apiKey = 'fixture-ark-key'
  const seeded = await seed.save({ source: ark, bindings: [{ agentId: 'kimi', enabled: true, endpointId: 'openai-chat', modelIds: ['kimi-k3.1-pro'] }], expectedRevision: seed.snapshot().revision, operationId: 'seed-ark' })
  await seed.close()
  const repairFile = join(repairDirectory, 'settings.json'), oldStore = JSON.parse(await readFile(repairFile, 'utf8'))
  oldStore.sources[0].models[0].capabilities = { contextWindow: 500000, imageInput: false }
  for (const id of ['deepseek-v4.1-flash', 'glm-5.3', 'doubao-seed-2.1-pro', 'ark-code-latest']) {
    const model = sourceDraft('ark-coding-plan').models.find(model => model.id === id)!
    oldStore.sources[0].models.push({ ...model, capabilities: { contextWindow: 100000, imageInput: false } })
  }
  await writeFile(repairFile, JSON.stringify(oldStore))
  repairBusy = true
  const repaired = new ModelSourceService(repairDeps); await repaired.start()
  assert.equal(repaired.snapshot().sources[0].revision, seeded.sources[0].revision + 1, 'repairing several models increments the source revision only once')
  assert.notEqual(repaired.snapshot().revision, seeded.revision)
  const repairedModels = repaired.snapshot().sources[0].models
  for (const [id, efforts, defaultEffort] of [
    ['deepseek-v4.1-flash', ['low', 'high', 'max'], 'high'],
    ['glm-5.3', ['low', 'high', 'max'], 'max'],
    ['doubao-seed-2.1-pro', ['low', 'medium', 'high'], 'high']
  ] as const) {
    const model = repairedModels.find(model => model.id === id)!
    assert.deepEqual(model.capabilities?.efforts, efforts, id + ': restore missing provider levels')
    assert.equal(model.capabilities?.defaultEffort, defaultEffort)
    assert.equal(model.capabilities?.contextWindow, 100000, 'repair preserves per-model context overrides')
  }
  assert.equal(repairedModels.find(model => model.id === 'ark-code-latest')?.capabilities?.efforts, undefined, 'auto-routing aliases do not invent reasoning levels')
  await repaired.apply()
  assert.equal(repaired.snapshot().statuses[0].state, 'pending', 'capability repair must wait for an active Agent')
  repairBusy = false; await repaired.applyPending()
  assert.deepEqual(appliedCapabilities.thinkingOptions, ['low', 'high', 'max'])
  assert.equal(appliedCapabilities.defaultEffort, 'max')
  assert.equal(appliedCapabilities.contextWindow, 500000, 'context overrides are preserved')
  assert.equal(appliedCapabilities.imageInput, false, 'existing capability overrides are preserved')
  assert.equal(repaired.mergeModels('kimi', [ { id: 'native-k3', label: 'native', efforts: [], thinkingOptions: ['low','high','max'], defaultThinking: 'max' } ])[0].label, '方舟 CP · kimi-k3.1-pro')
  const repairedStore = JSON.parse(await readFile(repairFile, 'utf8'))
  assert.equal(repairedStore.sources[0].encryptedKey, oldStore.sources[0].encryptedKey, 'capability repair does not rewrite credentials')
  await repaired.save({ source: { ...repaired.snapshot().sources[0], name: '方舟备用账号', models: ark.models.map(model => ({ ...model, capabilities: { ...model.capabilities, efforts: ['high'], defaultEffort: 'high', thinkingOptions: ['high'] } })) }, bindings: [{ agentId: 'kimi', enabled: true, endpointId: 'openai-chat', modelIds: ['kimi-k3.1-pro'] }], expectedRevision: repaired.snapshot().revision, operationId: 'override-efforts' })
  const overrideRevision = repaired.snapshot().sources[0].revision
  await repaired.close()
  const reopen = new ModelSourceService(repairDeps); await reopen.start(); await reopen.apply()
  assert.equal(reopen.snapshot().sources[0].revision, overrideRevision, 'complete capability overrides do not get rewritten on startup')
  assert.deepEqual(appliedCapabilities.thinkingOptions, ['high'])
  assert.equal(appliedCapabilities.defaultEffort, 'high')
  assert.equal(reopen.mergeModels('kimi', [ { id: 'native-k3', label: 'native', efforts: [] } ])[0].label, '方舟备用账号 · kimi-k3.1-pro', 'custom account names remain distinguishable')
  await reopen.close()

  if (!INTERNAL_DISTRIBUTION) assert.throws(() => sourceDraft('trae'), /数据源预设不可用/, 'the public edition has no internal enterprise source')
  for (const preset of INTERNAL_DISTRIBUTION ? ['ark-coding-plan', 'trae'] as const : ['ark-coding-plan'] as const) {
    const provider = sourceDraft(preset)
    provider.apiKey = preset === 'trae' ? undefined : 'fixture-provider-key'
    provider.endpoints = [{ id: 'anthropic-messages', protocol: 'anthropic-messages', baseUrl: 'https://fixture.example', auth: preset === 'trae' ? 'none' : 'bearer' }]
    provider.models = ['gpt', 'flash', 'pro'].map((id, index) => ({ id, label: id, capabilities: { contextWindow: 200000, efforts: index === 0 ? ['low','medium','high','xhigh'] : index === 1 ? ['low','medium','high','max'] : ['low','medium','high'], defaultEffort: ['medium','max','high'][index] as any }, routes: [{ endpointId: 'anthropic-messages', upstreamModel: id }] }))
    const nativeIds = Object.fromEntries(provider.models.map(model => [model.id, 'native-' + model.id]))
    const providerService = new ModelSourceService({ directory: join(directory, preset + '-defaults'), gateway, enterprise: preset === 'trae' ? { discover: async () => provider, test: async () => 'fixture' } : undefined, agents: () => ['deepseek','zcode'].map(id => ({ id, installed: true })) as any, adapters: Object.fromEntries(['deepseek','zcode'].map(id => [id, { apply: async () => ({ nativeModels: nativeIds }) }])) })
    await providerService.start()
    const providerSaved = await providerService.save({ source: provider, bindings: ['deepseek','zcode'].map(agentId => ({ agentId, enabled: true, endpointId: 'anthropic-messages', modelIds: provider.models.map(model => model.id) })), expectedRevision: providerService.snapshot().revision, operationId: 'seed-trae-defaults' })
    for (const agentId of ['deepseek','zcode']) {
      for (const model of provider.models) {
        const config = { agentId, workdir: directory, model: nativeIds[model.id], modelSource: { kind: 'third-party' as const, sourceId: providerSaved.sources[0].id } }
        assert.equal(providerService.normalize(config).effort, model.capabilities!.defaultEffort, 'missing session efforts resolve the exact model default, not a shared Provider default')
        assert.equal(providerService.normalize({ ...config, effort: 'low' }).effort, 'low', 'explicit user levels are preserved')
        const native = { id: config.model, label: 'native', efforts: model.capabilities!.efforts!, defaultEffort: model.capabilities!.efforts!.at(-1), ...(agentId === 'zcode' ? { thinkingOptions: model.capabilities!.efforts, defaultThinking: model.capabilities!.efforts!.at(-1) } : {}) } as any
        const projected = providerService.mergeModels(agentId, [native]).find(item => item.id === config.model)!
        assert.equal(projected.defaultEffort, model.capabilities!.defaultEffort)
        if (agentId === 'zcode') {
          assert.equal(projected.defaultThinking, model.capabilities!.defaultEffort, 'ZCode infers the final option as default; source projection must retain its declared default')
          const selected = { ...config, zcodeModelSelection: { providerId: 'native', modelId: model.id, options: { reasoningLevel: 'low' } } }
          assert.equal(providerService.normalize(selected).effort, undefined, 'an explicit native ZCode selection takes priority')
        }
      }
    }
    await providerService.close()

    // Startup probes run before source application. Applying a Provider must publish
    // its read-back catalog even when the lifecycle cache has no/stale native rows.
    for (const agentId of ['kimi', 'deepseek', 'zcode']) {
      const levels = ['low', 'medium', 'high', 'max'] as const
      let readback: any[] = [{ id: 'native-flash', label: 'flash', efforts: agentId === 'kimi' ? [] : [...levels],
        ...(agentId !== 'deepseek' ? { thinkingOptions: [...levels], defaultThinking: 'max' } : {}), defaultEffort: 'max' }]
      const applied = new ModelSourceService({ directory: join(directory, 'readback-' + preset + '-' + agentId), gateway,
        agents: () => [{ id: agentId, installed: true }] as any,
        enterprise: preset === 'trae' ? { discover: async () => provider, test: async () => 'fixture' } : undefined,
        adapters: { [agentId]: { apply: async () => ({ nativeModels: { flash: 'native-flash' }, models: readback }) } } })
      await applied.start()
      await applied.save({ source: { ...provider, models: [provider.models[1]] }, bindings: [{ agentId, enabled: true, endpointId: 'anthropic-messages', modelIds: ['flash'] }], expectedRevision: applied.snapshot().revision, operationId: 'readback' })
      const first = applied.mergeModels(agentId, [])[0]
      assert.deepEqual(agentId === 'deepseek' ? first.efforts : first.thinkingOptions, levels, agentId + ': first application publishes read-back thinking levels')
      const stale = [{ ...first, efforts: [], thinkingOptions: [] }]
      assert.deepEqual(applied.mergeModels(agentId, stale), [first], 'projecting a stale lifecycle cache cannot erase applied capabilities')
      readback = [{ ...readback[0], efforts: agentId === 'kimi' ? [] : ['high'], thinkingOptions: agentId === 'deepseek' ? undefined : ['high'], defaultEffort: 'high', defaultThinking: 'high' }]
      await applied.apply()
      const refreshed = applied.mergeModels(agentId, [first])[0]
      assert.deepEqual(agentId === 'deepseek' ? refreshed.efforts : refreshed.thinkingOptions, ['high'], 'reapplication replaces the catalog instead of reusing stale capabilities')
      const sessionModel = { ...first, efforts: [], thinkingOptions: [] }
      const sessionProjection = applied.projectNativeModels(agentId, [sessionModel])[0]
      assert.deepEqual(sessionProjection.efforts, [], 'existing sessions retain their own native capabilities')
      if (agentId !== 'deepseek') assert.deepEqual(sessionProjection.thinkingOptions, [])
      await applied.close()
    }
  }

  const legacy = join(directory, 'legacy'); await mkdir(join(legacy, 'claude-sources'), { recursive: true })
  await writeFile(join(legacy, 'claude-sources/settings.json'), JSON.stringify({ version: 1, sources: [{ id: 'deepseek', preset: 'deepseek', enabled: true, baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-flash'], encryptedKey: await encryptLocalSecretAsync('legacy-fixture-key') }] }))
  const migrated = new ModelSourceService({ ...deps, directory: join(legacy, 'model-sources') }); await migrated.start(); await migrated.apply()
  const old = { ...config, model: codexModelKey('deepseek-flash', { kind: 'third-party', sourceId: 'deepseek' }) }
  const normalized = migrated.normalize(old)
  assert.notEqual(normalized.model, old.model); migrated.assertReady(normalized)
  const migratedAgain = new ModelSourceService({ ...deps, directory: join(legacy, 'model-sources') }); await migratedAgain.start()
  assert.equal(migratedAgain.snapshot().sources[0].id, migrated.snapshot().sources[0].id)

  assert.throws(() => validateModelSource({ ...input, models: [{ ...input.models[0], capabilities: { contextWindow: -1 } }] }), /能力/)
  assert.throws(() => validateModelSource({ ...input, endpoints: [{ ...input.endpoints[0], baseUrl: 'https://secret@example.com' }] }), /Base URL/)
  console.log('✓ model sources: encrypted storage, multi-account, per-Agent results, retries, disable, settings and legacy identity')
} finally { await service.close(); await rm(directory, { recursive: true, force: true }) }
