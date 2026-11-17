import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSourceService } from '../src/main/model-sources/service'
import { encryptLocalSecretAsync } from '../src/main/localSecretStore'
import { codexModelKey, parseCodexModelKey } from '../src/shared/codexModelIdentity'

const root = await mkdtemp(join(tmpdir(), 'ua-source-migration-'))
process.env.UNIAGENT_USER_DATA = root
let routes: any[] = []
const deps = { agents: () => ['codex', 'claude'].map(id => ({ id, installed: true } as any)), adapters: { codex: { apply: async () => ({}) }, claude: { apply: async () => ({}) } }, gateway: { port: 34567, update: async (state: any) => { routes = state.routes; return 34567 }, close: async () => {} } }
const codexKey = await encryptLocalSecretAsync('fixture-codex-key'), claudeKey = await encryptLocalSecretAsync('fixture-claude-key')
const modelIds = ['deepseek-flash', 'deepseek-v4-pro']
const source = (agent: string, key: string, baseUrl = agent === 'codex' ? 'https://api.deepseek.com' : 'https://api.deepseek.com/anthropic') => ({ id: 'source-' + agent, name: `${agent === 'codex' ? 'Codex' : 'Claude'} · deepseek`, preset: 'deepseek', plan: 'deepseek', enabled: true, revision: 3, runtimeRevision: 2, token: 'fixture-token-' + agent, encryptedKey: key, endpoints: [{ id: agent, protocol: agent === 'codex' ? 'openai-responses' : 'anthropic-messages', baseUrl, auth: 'bearer' }], models: modelIds.map(id => ({ id, label: id, routes: [{ endpointId: agent, upstreamModel: id }] })) })
const converted = (claudeUrl?: string) => ({ version: 1, revision: 'fixture-revision', port: 0, receipts: [], sources: [source('codex', codexKey), source('claude', claudeKey, claudeUrl)], bindings: ['codex', 'claude'].map(agentId => ({ sourceId: 'source-' + agentId, agentId, endpointId: agentId, enabled: true, modelIds, appliedRevision: 3, appliedRuntimeRevision: 2 })), aliases: { 'codex/deepseek': 'source-codex', 'claude/deepseek': 'source-claude' } })
try {
  const legacy = join(root, 'legacy')
  for (const agent of ['codex','claude']) {
    await mkdir(join(legacy, agent + '-sources'), { recursive: true })
    await writeFile(join(legacy, agent + '-sources/settings.json'), JSON.stringify({ version: 1, enabled: true, sources: [{ id: 'deepseek', preset: 'deepseek', enabled: true, baseUrl: source(agent, '').endpoints[0].baseUrl, models: modelIds, encryptedKey: agent === 'codex' ? codexKey : claudeKey }] }))
  }
  const first = new ModelSourceService({ ...deps, directory: join(legacy, 'model-sources') }); await first.start()
  assert.equal(first.snapshot().sources.length, 1, 'different protocols and legacy keys belong to one provider source')
  assert.equal(first.snapshot().sources[0].name, 'DeepSeek')
  assert.equal(first.snapshot().sources[0].models.length, 2, 'protocol variants do not duplicate model rows')
  await first.apply()
  assert.equal(routes.find(route => route.id.includes('/codex/')).apiKey, 'fixture-codex-key')
  assert.equal(routes.find(route => route.id.includes('/claude/')).apiKey, 'fixture-claude-key')
  await first.close()

  const directory = join(root, 'converted'); await mkdir(directory)
  const original = JSON.stringify(converted()); await writeFile(join(directory, 'settings.json'), original)
  const repaired = new ModelSourceService({ ...deps, directory }); await repaired.start(); await repaired.apply()
  const snapshot = repaired.snapshot(), merged = snapshot.sources[0]
  assert.equal(snapshot.sources.length, 1, 'already migrated split rows are consolidated on load')
  assert.equal(merged.id, 'source-codex'); assert.equal(snapshot.bindings.length, 2)
  assert.equal(await readFile(join(directory, 'settings.before-source-grouping.json'), 'utf8'), original)
  for (const agent of ['codex','claude']) {
    const old = codexModelKey(modelIds[0], { kind: 'third-party', sourceId: 'source-' + agent })
    const config = repaired.normalize({ agentId: agent, workdir: root, model: old })
    assert.equal(parseCodexModelKey(config.model!)!.source.sourceId, merged.id)
    repaired.assertReady(config)
  }
  const current = await readFile(join(directory, 'settings.json'), 'utf8')
  const again = new ModelSourceService({ ...deps, directory }); await again.start()
  assert.equal(again.snapshot().sources[0].id, merged.id)
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), current, 'reload is idempotent')
  await again.close()
  assert.ok(!JSON.stringify(snapshot).includes('endpointKeys'))
  assert.ok(!JSON.stringify(repaired.configuration()).includes('endpointKeys'))
  const originalFetch = globalThis.fetch; let credential: string | undefined
  try {
    globalThis.fetch = (async (_url, options: any) => { credential = options.headers.Authorization; return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }], content: [{ text: 'OK' }] }), { status: 200 }) }) as typeof fetch
    await repaired.query(merged, 'claude'); assert.equal(credential, 'Bearer fixture-claude-key')
    await repaired.test(merged, 'codex', modelIds[0]); assert.equal(credential, 'Bearer fixture-codex-key')
  } finally { globalThis.fetch = originalFetch }
  await repaired.save({ source: { ...merged, name: 'DeepSeek renamed' }, bindings: snapshot.bindings, expectedRevision: snapshot.revision, operationId: 'rename' })
  assert.equal(routes.find(route => route.id.includes('/claude/')).apiKey, 'fixture-claude-key', 'metadata edits preserve the per-protocol credential')
  await repaired.save({ source: { ...repaired.snapshot().sources[0], apiKey: 'fixture-new-shared-key' }, bindings: snapshot.bindings, expectedRevision: repaired.snapshot().revision, operationId: 'replace-key' })
  assert.ok(routes.every(route => route.apiKey === 'fixture-new-shared-key'), 'an explicit source key update replaces all protocol credentials')
  await repaired.close()

  const custom = join(root, 'custom'); await mkdir(custom)
  await writeFile(join(custom, 'settings.json'), JSON.stringify(converted('https://custom.example/anthropic')))
  const independent = new ModelSourceService({ ...deps, directory: custom }); await independent.start()
  assert.equal(independent.snapshot().sources.length, 2, 'a custom provider address must not be merged by vendor name')
  await independent.close()
  const disabledDirectory = join(root, 'disabled'); await mkdir(disabledDirectory)
  const disabledStore = converted(); disabledStore.sources[1].enabled = false; disabledStore.bindings[1].enabled = false
  disabledStore.sources[1].models = disabledStore.sources[1].models.slice(0, 1); disabledStore.bindings[1].modelIds = modelIds.slice(0, 1)
  await writeFile(join(disabledDirectory, 'settings.json'), JSON.stringify(disabledStore))
  const disabled = new ModelSourceService({ ...deps, directory: disabledDirectory }); await disabled.start(); await disabled.apply()
  assert.equal(disabled.snapshot().sources.length, 1)
  assert.equal(disabled.snapshot().bindings.find(binding => binding.agentId === 'claude')?.enabled, false)
  assert.deepEqual(disabled.snapshot().bindings.find(binding => binding.agentId === 'claude')?.modelIds, modelIds.slice(0, 1))
  assert.ok(!routes.some(route => route.id.includes('/claude/')), 'consolidation does not enable a previously disabled Agent')
  await disabled.close()
  const accountsDirectory = join(root, 'accounts'); await mkdir(accountsDirectory)
  await writeFile(join(accountsDirectory, 'settings.json'), JSON.stringify({ ...converted(), aliases: {} }))
  const accounts = new ModelSourceService({ ...deps, directory: accountsDirectory }); await accounts.start()
  assert.equal(accounts.snapshot().sources.length, 2, 'explicit independent sources are not collapsed by vendor name')
  await accounts.close()
  console.log('✓ source migration: one provider row, independent protocol credentials, existing-store repair, old UUIDs, idempotence and custom source isolation')
} finally { await rm(root, { recursive: true, force: true }) }
