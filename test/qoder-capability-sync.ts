import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilitySyncService } from '../src/main/capability-sync/service.ts'
import { parseNativeConfig, stringifyNativeConfig, discoverProvider } from '../src/main/capability-sync/provider.ts'
import { projectQoderByok, validateQoderByok } from '../src/main/qoderByok.ts'
import { projectQoderHistory } from '../src/main/qoderHistory.ts'
import { computeContext } from '../src/renderer/contextWindow.ts'
import { getAgentToolDetail, listAgentToolInventories } from '../src/main/agentToolInventory.ts'
import { writeForkTarget } from '../src/main/forkContext.ts'
import { listCapabilityInventories } from '../src/main/capability-sync/inventory.ts'
import { qoderHistoryForkPoints } from '../src/main/historyFork.ts'

const native = { enabledPlugins: { demo: true }, mcpServers: { demo: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Api-Key': 'fixture-secret' } } } }
const canonical = parseNativeConfig(JSON.stringify(native))
assert.deepEqual(JSON.parse(stringifyNativeConfig(canonical, 'settings.json')), native)
assert.throws(() => parseNativeConfig('{"mcpServers": []}'), /invalid_mcp_schema/)
assert.throws(() => validateQoderByok({ id: 'x', name: 'x', baseUrl: 'file:///tmp', protocol: 'openai', apiKey: 'x', models: ['m'] }), /URL/)
assert.throws(() => validateQoderByok({ id: 'x', name: 'x', baseUrl: 'https://example.com', protocol: 'openai', models: ['m'] }), /API Key/)
assert.deepEqual(projectQoderByok([{ providerId: 'p', displayName: 'P', baseUrl: 'https://example.com', protocol: 'anthropic', apiKey: 'must-not-project', models: [{ id: 'm' }] }]),
  [{ id: 'p', name: 'P', baseUrl: 'https://example.com', protocol: 'anthropic', kind: 'provider', models: ['m'] }])
const transcript = projectQoderHistory([{ type: 'user', uuid: 'u', timestamp: '2026-11-09T00:00:00Z', message: { content: 'question' } },
  { type: 'assistant', uuid: 'a', timestamp: '2026-11-09T00:00:01Z', message: { content: [{ type: 'text', text: 'answer' }] } }], 'native')
assert.deepEqual(transcript.map(event => [event.type, event.payload.nativeMessageId]), [['user_message', 'u'], ['agent_message', 'a']])
assert.equal(transcript[0].ts, Date.parse('2026-11-09T00:00:00Z'))
const live = transcript.map(event => ({ ...event, seq: event.seq + 100, payload: { ...event.payload, nativeMessageId: 'stream-envelope' } }))
assert.deepEqual(qoderHistoryForkPoints(live, transcript), [{ eventSeq: 101, kind: 'message', nativeId: 'a' }])
assert.deepEqual(qoderHistoryForkPoints(live, [...transcript, { ...transcript[1], payload: { ...transcript[1].payload, nativeMessageId: 'another' } }]), [], 'ambiguous repeated replies cannot invent a native boundary')
assert.deepEqual(qoderHistoryForkPoints(transcript, [...transcript, { ...transcript[1], payload: { ...transcript[1].payload, nativeMessageId: 'another' } }]), [{ eventSeq: 1, kind: 'message', nativeId: 'a' }])
const context = computeContext([{ sessionId: 's', seq: 0, ts: 0, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 0, outputTokens: 0, contextUsedPercentage: 21.5 } } }])
assert.equal(context.used, 0)
assert.equal(context.usedPercentage, 21.5)

const home = await mkdtemp(join(tmpdir(), 'uniagent-qoder-sync-'))
try {
  await mkdir(join(home, '.codex/skills/demo'), { recursive: true })
  await mkdir(join(home, '.qoder-cn/skills'), { recursive: true })
  await writeFile(join(home, '.codex/config.toml'), '[mcp_servers.demo]\ncommand = "node"\nargs = ["fixture.mjs"]\n', { mode: 0o600 })
  await writeFile(join(home, '.codex/skills/demo/SKILL.md'), '---\nname: demo\ndescription: fixture\n---\nRead files.\n', { mode: 0o600 })
  const before = JSON.stringify({ enabledPlugins: { 'keep-native': true }, mcpServers: { demo: { type: 'stdio', command: 'old', args: ['fixture.mjs'] } } })
  await writeFile(join(home, '.qoder-cn/settings.json'), before, { mode: 0o600 })
  assert.equal((await discoverProvider('qoder', home)).layoutKnown, true)
  const service = new CapabilitySyncService(home, join(home, '.uniagent-public/capability-sync'))
  const scan = await service.scan({ source: 'codex', target: 'qoder' })
  assert.equal(scan.executionSupported, true)
  const plan = service.plan({ scanId: scan.id, mode: 'merge', cloneCategories: [], selections: ['skill:demo', 'mcp:demo'], resolutions: { 'mcp:demo': 'source' } })
  assert.deepEqual(plan.blockedReasons, [], JSON.stringify(plan))
  const started = service.execute({ planId: plan.id, expectedSourceRevision: plan.sourceRevision, expectedTargetRevision: plan.targetRevision, ...(plan.requiresConfirmation ? { confirmation: { acknowledged: true } } : {}) })
  let job = started
  const end = Date.now() + 10_000
  while (!['completed', 'failed_no_change', 'rolled_back', 'rollback_failed'].includes(job.state) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 20)); job = service.getJob(started.id)!
  }
  assert.equal(job.state, 'completed', JSON.stringify(job))
  const after = JSON.parse(await readFile(join(home, '.qoder-cn/settings.json'), 'utf8'))
  assert.deepEqual(after.enabledPlugins, { 'keep-native': true })
  assert.deepEqual(after.mcpServers.demo, { command: 'node', args: ['fixture.mjs'], type: 'stdio' })
  assert.equal(await readFile(join(home, '.qoder-cn/skills/demo/SKILL.md'), 'utf8'), await readFile(join(home, '.codex/skills/demo/SKILL.md'), 'utf8'))
  const rolled = await service.rollback(job.transactionId!)
  assert.equal(rolled.state, 'rolled_back')
  assert.equal(await readFile(join(home, '.qoder-cn/settings.json'), 'utf8'), before)
  await assert.rejects(access(join(home, '.qoder-cn/skills/demo')))
  await writeFile(join(home, '.codex/config.toml'), 'model = "codex-only"\n')
  await writeFile(join(home, '.qoder-cn/settings.json'), JSON.stringify({ model: 'qoder-only', mcpServers: { stream: { type: 'sse', url: 'https://example.com/events' } } }))
  const preferences = await service.scan({ source: 'codex', target: 'qoder' })
  assert.equal(preferences.items.find(item => item.id === 'preference:model')?.selectable, false, 'native model IDs cannot be copied between providers')
  const streamInventory = (await listCapabilityInventories(home, undefined, undefined, ['qoder'])).inventories[0]
  const stream = streamInventory.items.find(item => item.kind === 'mcp' && item.name === 'stream')!
  const removal = await service.planRemoval('qoder', [stream.id])
  assert.deepEqual(removal.blockedReasons, [], 'valid native SSE MCP can be removed even when it cannot be synchronized')
  await mkdir(join(home, '.qoder-cn/agents'))
  await writeFile(join(home, '.qoder-cn/agents/reader.md'), '---\nname: reader\ndescription: reader fixture\n---\nRead only.')
  await writeFile(join(home, '.qoder-cn/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'local-fixture-only' }] }] } }))
  const plugin = join(home, '.qoder-cn/plugins/proof')
  await mkdir(join(plugin, '.qoder-plugin'), { recursive: true })
  await mkdir(join(plugin, 'skills/plugin-proof'), { recursive: true })
  await writeFile(join(plugin, '.qoder-plugin/plugin.json'), '{"name":"proof","version":"1.0.0"}')
  await writeFile(join(plugin, 'skills/plugin-proof/SKILL.md'), '---\nname: plugin-proof\ndescription: proof\n---\nRead only.')
  const inventory = await listAgentToolInventories({ home, agents: [{ id: 'qoder', name: 'Qoder CN', bin: '/qoderclicn', installed: true, adapter: 'qoder' }],
    qoderOperation: (async () => [{ id: 'proof@local', name: 'proof', path: plugin, version: '1.0.0', scope: 'user', enabled: true, canDisable: true, resources: {} }]) as any })
  const resources = inventory.inventories[0].items
  assert.ok(resources.some(item => item.kind === 'agent-profile' && item.name === 'reader'))
  assert.ok(resources.some(item => item.kind === 'hook' && item.name === 'PreToolUse'))
  assert.ok(resources.some(item => item.kind === 'skill' && item.name === 'plugin-proof' && item.scope === 'plugin' && !item.manageable))
  assert.equal(JSON.stringify(resources).includes('local-fixture-only'), false, 'hook commands do not cross the inventory bridge')
  await writeFile(join(home, '.qoder-cn/settings.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node', args: [] } } }))
  const catalogOptions = { home, agents: [{ id: 'qoder', name: 'Qoder CN', bin: '/qoderclicn', installed: true, adapter: 'qoder' as const }],
    qoderOperation: (async (_bin: string, method: string) => method === 'plugins.list' ? [] : { mcpServers: [{ name: 'fixture', status: 'connected', serverInfo: { name: 'Fixture', version: '1' }, tools: [{ name: 'proof', description: 'read marker' }] }] }) as any }
  const catalogItem = (await listAgentToolInventories(catalogOptions)).inventories[0].items.find(item => item.kind === 'mcp' && item.name === 'fixture')!
  const catalogDetail = await getAgentToolDetail(catalogItem.id, catalogOptions, true)
  assert.equal(catalogDetail.mcp?.catalogSupported, true)
  assert.equal(catalogDetail.mcp?.catalog?.connectionStatus, 'connected')
  assert.deepEqual(catalogDetail.mcp?.catalog?.tools, [{ name: 'proof', title: undefined, description: 'read marker', parameters: [] }])
  await mkdir(join(home, '.agents/skills/shared-proof'), { recursive: true })
  await writeFile(join(home, '.agents/skills/shared-proof/SKILL.md'), '---\nname: shared-proof\ndescription: shared\n---\nRead only.')
  const scanShared = () => listCapabilityInventories(home, undefined, undefined, ['qoder'])
  assert.equal((await scanShared()).inventories[0].items.some(item => item.scope === 'shared' && item.name === 'shared-proof'), false)
  await writeFile(join(home, '.qoder-cn/settings.json'), '{"skills":{"loadFromAgentsDirectory":true}}')
  assert.ok((await scanShared()).inventories[0].items.some(item => item.scope === 'shared' && item.name === 'shared-proof'))
  const archive = join(home, 'archive'); await mkdir(archive)
  await writeFile(join(archive, 'context.json'), JSON.stringify({ messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }] }))
  const imported = await writeForkTarget({ home, archive, agentId: 'qoder', nativeId: 'fixture-import', cwd: home, model: 'auto' })
  const importedRows = (await readFile(imported, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(importedRows[0].message.content, 'question')
  assert.deepEqual(importedRows[1].message.content, [{ type: 'text', text: 'answer' }], 'Qoder resume requires assistant content blocks')
  const override = join(home, 'native-qoder')
  await mkdir(join(override, 'skills/override-proof'), { recursive: true })
  await writeFile(join(override, 'skills/override-proof/SKILL.md'), '---\nname: override-proof\ndescription: native path\n---\nRead only.')
  await writeFile(join(override, 'settings.json'), '{}')
  const previousRoot = process.env.QODERCN_CONFIG_DIR
  process.env.QODERCN_CONFIG_DIR = override
  try {
    const provider = await discoverProvider('qoder', home)
    assert.ok(provider.items.some(item => item.id === 'skill:override-proof'))
    const inventory = await scanShared()
    assert.ok(inventory.inventories[0].items.some(item => item.name === 'override-proof'))
    assert.equal(inventory.inventories[0].items.some(item => item.name === 'shared-proof'), false)
  } finally { if (previousRoot === undefined) delete process.env.QODERCN_CONFIG_DIR; else process.env.QODERCN_CONFIG_DIR = previousRoot }
} finally { await rm(home, { recursive: true, force: true }) }
console.log('Qoder JSON MCP sync, rollback, BYOK validation, history and context passed')
