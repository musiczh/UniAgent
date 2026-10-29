import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  manageBetaCapabilityInventory, parseBetaCapabilityManageRequest
} from '../src/main/betaCapabilityManagement.ts'
import { inspectKimiInventory } from '../src/main/kimiInventory.ts'
import { grokInventoryFromOptions, type GrokInventoryCommandRunner } from '../src/main/grokInventory.ts'
import { IPC } from '../src/shared/types.ts'
import { listAgentToolInventories, manageAgentToolInventory, type AgentToolInventoryOptions } from '../src/main/agentToolInventory.ts'

const invalid = /invalid_capability_inventory_manage_request/
const fingerprint = 'a'.repeat(64), grokId = 'grok:mcp:' + 'b'.repeat(24)
const kimiId = 'kimi:agent:skill:' + 'c'.repeat(24)
for (const request of [
  null, [], {}, { agentId: 'codex', action: 'skill-create', name: 'x', manifestText: 'x' },
  { agentId: 'kimi', action: 'mcp-add', name: 'x', transport: 'stdio', command: 'node' },
  { agentId: 'grok', action: 'skill-delete', id: grokId, expectedFingerprint: fingerprint },
  { agentId: 'kimi', action: 'skill-delete', id: grokId, expectedFingerprint: fingerprint },
  { agentId: 'grok', action: 'mcp-remove', id: kimiId, expectedFingerprint: fingerprint },
  { agentId: 'grok', action: 'mcp-remove', id: grokId },
  { agentId: 'kimi', action: 'skill-delete', id: kimiId, expectedFingerprint: 'old' },
  { agentId: 'kimi', action: 'skill-create', name: '../escape', manifestText: 'x' },
  { agentId: 'kimi', action: 'skill-create', name: 'x', manifestText: 'x', home: '/secret' },
  { agentId: 'kimi', action: 'skill-create', name: 'x', manifestText: 'x', path: '/secret' },
  { agentId: 'grok', action: 'plugin-install', source: '/tmp/plugin' },
  { agentId: 'grok', action: 'plugin-install', source: '../plugin' },
  { agentId: 'grok', action: 'plugin-install', source: 'file:///tmp/plugin' },
  { agentId: 'grok', action: 'plugin-install', source: '--debug' },
  { agentId: 'grok', action: 'plugin-install', source: 'owner/repo', grokBin: '/secret' },
  { agentId: 'grok', action: 'mcp-add', name: 'x', scope: 'project', transport: 'stdio', command: 'node' },
  { agentId: 'grok', action: 'mcp-add', name: 'x', transport: 'stdio', command: 'node', url: 'https://example.test' },
  { agentId: 'grok', action: 'mcp-add', name: 'x', transport: 'http', url: 'file:///tmp/secret' },
  { agentId: 'grok', action: 'mcp-add', name: 'x', transport: 'http', url: 'https://user:secret@example.test' },
  { agentId: 'grok', action: 'mcp-add', name: 'x', transport: 'stdio', command: 'node', env: { INVALID: 2 } },
  { agentId: 'kimi', action: 'mcp-upsert', name: 'x', config: { command: 'node', cwd: '/secret' } },
  { agentId: 'kimi', action: 'mcp-upsert', name: 'x', config: { command: 'node', extra: 'secret' } },
  { agentId: 'kimi', action: 'mcp-upsert', name: 'x', config: { command: 'node', toolTimeoutMs: 0 } },
  { agentId: 'kimi', action: 'mcp-upsert', name: 'x', config: { transport: 'http', url: 'https://example.test', headers: { 'bad\nheader': 'secret' } } }
]) assert.throws(() => parseBetaCapabilityManageRequest(request), invalid)
let getterCalled = false
const accessorRequest = { agentId: 'kimi', action: 'skill-create', name: 'x', get manifestText() { getterCalled = true; return 'x' } }
assert.throws(() => parseBetaCapabilityManageRequest(accessorRequest), invalid)
assert.equal(getterCalled, false)

const mutableRequest = { agentId: 'kimi', action: 'mcp-upsert', name: 'safe', config: { command: 'node', args: ['first'], env: { TOKEN: 'kept' } } }
const parsed = parseBetaCapabilityManageRequest(mutableRequest)
mutableRequest.config.args[0] = 'replaced'; mutableRequest.config.env.TOKEN = 'changed'
assert.equal(parsed.agentId, 'kimi')
assert.deepEqual((parsed as { config: { args: string[]; env: Record<string, string> } }).config, { command: 'node', args: ['first'], env: { TOKEN: 'kept' } })
for (const source of ['owner/repo@v1.0', 'https://github.com/owner/repo']) {
  assert.equal(parseBetaCapabilityManageRequest({ agentId: 'grok', action: 'plugin-install', source }).action, 'plugin-install')
}
const redactedUpdate = { agentId: 'grok', action: 'mcp-update', id: grokId, expectedFingerprint: fingerprint,
  transport: 'http', url: '[redacted]', headers: '[redacted]' }
assert.equal(parseBetaCapabilityManageRequest(redactedUpdate).action, 'mcp-update', 'existing redacted config can be submitted unchanged')
assert.throws(() => parseBetaCapabilityManageRequest({ agentId: 'grok', action: 'mcp-add', name: 'new', transport: 'http', url: '[redacted]', headers: '[redacted]' }), invalid)

assert.equal(IPC.capabilityInventoryManage, 'capabilityInventory:manage')
const mainSource = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const manageHandler = mainSource.slice(mainSource.indexOf('ipcMain.handle(IPC.capabilityInventoryManage'), mainSource.indexOf('ipcMain.handle(IPC.capabilityInventoryPrepareSync'))
assert.match(manageHandler, /capabilitySyncIpc\(event/)
await assert.rejects(manageAgentToolInventory({ agentId: 'unknown', action: 'plugin-uninstall' }, { home: '/unused', agents: [] }), /capability_inventory_action_unsupported/)
await assert.rejects(manageAgentToolInventory({ agentId: 'grok', action: 'plugin-uninstall' }, { home: '/unused', agents: [] }), /capability_inventory_unavailable/)
const quotaHandler = mainSource.slice(mainSource.indexOf('ipcMain.handle(IPC.getGrokQuota'), mainSource.indexOf('ipcMain.handle(IPC.getLifecycleMetrics'))
assert.match(quotaHandler, /assertTrustedCapabilitySyncIpc\(event\)/)
assert.match(quotaHandler, /if \(isQuitting\) return null/)
assert.match(quotaHandler, /grokQuota\.get/)
assert.match(quotaHandler, /startupProtocolSettled/)
assert.match(mainSource, /new GrokQuotaService/)
const preloadSource = await readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
assert.match(preloadSource, /capabilityInventoryManage:.*invoke\(IPC\.capabilityInventoryManage, request\)/)

const dir = await mkdtemp(join(tmpdir(), 'uniagent-beta-capability-'))
const home = join(dir, 'home'), cwd = join(dir, 'project'), grokHome = join(home, '.grok')
await mkdir(home); await mkdir(cwd); await mkdir(grokHome)
const pluginPath = join(grokHome, 'installed-plugins', 'owner-repo')
await mkdir(pluginPath, { recursive: true })
const options = { home, cwd, env: { KIMI_CODE_HOME: join(home, '.kimi-code'), GROK_HOME: grokHome } }
const skillText = (body: string) => `---\nname: route-skill\ndescription: Route fixture\n---\n${body}\n`
const servers = [{ name: 'native', scope: 'user', enabled: true, command: 'node', args: [], env: { TOKEN: 'ERROR_SECRET' } }]
const plugins = [{ name: 'fixture', repo_key: 'owner/repo', path: pluginPath, status: 'installed', version: '1' }]
const calls: Array<{ bin: string; args: readonly string[]; home?: string }> = []
let failMutation = false, failureMessage = 'ERROR_SECRET /private/home/config command failed', scanCount = 0, changeDuringManage = false
const runner: GrokInventoryCommandRunner = async (bin, args, childOptions) => {
  calls.push({ bin, args: [...args], home: childOptions.env?.HOME })
  if (args.join(' ') === 'inspect --json') {
    scanCount++
    if (changeDuringManage && scanCount === 2) servers[0].command = 'external-change'
    return { stdout: JSON.stringify({ skills: [{ name: 'native-plugin-skill', source: { type: 'plugin' } }], hooks: [], agents: [], projectInstructions: [],
      mcpServers: servers.map((server) => ({ name: server.name, source: { type: 'configToml' }, transport: 'stdio' })),
      plugins: plugins.map((plugin) => ({ ...plugin, scope: 'user', provides: {} })) }) }
  }
  if (args.join(' ') === 'mcp list --json') return { stdout: JSON.stringify(servers) }
  if (args.join(' ') === 'plugin list --json') return { stdout: JSON.stringify(plugins) }
  if (failMutation) throw new Error(failureMessage)
  if (args[0] === 'mcp' && args[1] === 'disable') servers[0].enabled = false
  if (args[0] === 'plugin' && args[1] === 'update') plugins[0].version = '2'
  return { stdout: 'ok' }
}
const grokOptions = { ...options, grokBin: 'trusted-main-grok', grokRunner: runner }
try {
  let inventory = await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'skill-create', name: 'route-skill', manifestText: skillText('Initial') }, options)
  const skill = inventory.items.find((item) => item.name === 'route-skill')!
  assert.equal(skill.manageable, true)
  inventory = await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'skill-update', id: skill.id, expectedFingerprint: skill.fingerprint, manifestText: skillText('Updated') }, options)
  assert.notEqual(inventory.items.find((item) => item.id === skill.id)?.fingerprint, skill.fingerprint)
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'kimi', action: 'skill-delete', id: skill.id, expectedFingerprint: skill.fingerprint }, options), /capability_inventory_stale/)
  const updated = inventory.items.find((item) => item.id === skill.id)!
  await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'skill-delete', id: updated.id, expectedFingerprint: updated.fingerprint }, options)
  assert.equal((await inspectKimiInventory(options)).items.some((item) => item.id === skill.id), false)
  inventory = await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'mcp-upsert', name: 'route-mcp', config: { command: 'node', env: { TOKEN: 'ERROR_SECRET' } } }, options)
  const mcp = inventory.items.find((item) => item.name === 'route-mcp')!
  assert.equal(JSON.stringify(inventory).includes('ERROR_SECRET'), false)
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'kimi', action: 'skill-delete', id: mcp.id, expectedFingerprint: mcp.fingerprint }, options), invalid)
  const disabledInventory = await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'mcp-disable', id: mcp.id, expectedFingerprint: mcp.fingerprint }, options)
  const disabled = disabledInventory.items.find((item) => item.id === mcp.id)!
  const disabledConfig = JSON.parse(await readFile(join(home, '.kimi-code/mcp.json'), 'utf8')).mcpServers['route-mcp']
  assert.equal(disabledConfig.enabled, false)
  assert.equal(disabledConfig.env.TOKEN, 'ERROR_SECRET')
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'kimi', action: 'mcp-enable', id: mcp.id, expectedFingerprint: mcp.fingerprint }, options), /capability_inventory_stale/)
  const enabledInventory = await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'mcp-enable', id: disabled.id, expectedFingerprint: disabled.fingerprint }, options)
  await manageBetaCapabilityInventory({ agentId: 'kimi', action: 'mcp-delete', id: mcp.id, expectedFingerprint: enabledInventory.items.find((item) => item.id === mcp.id)!.fingerprint }, options)
  assert.equal(JSON.parse(await readFile(join(home, '.kimi-code/mcp.json'), 'utf8')).mcpServers['route-mcp'], undefined)

  let grok = await grokInventoryFromOptions(grokOptions.grokBin, { cwd, env: { ...options.env, HOME: home }, runner })
  const toolOptions: AgentToolInventoryOptions = { home, env: options.env,
    agents: [{ id: 'grok', name: 'Grok', adapter: 'grok', bin: grokOptions.grokBin, installed: true }],
    pluginRunner: async bin => ({ stdout: bin === 'traecli' ? 'Found 0 plugins:\n' : '{"installed":[],"available":[]}' }),
    run: async (bin, args, env) => (await runner(bin, args.filter(arg => arg !== '--no-auto-update'), { cwd: home, env })).stdout }
  const displayed = (await listAgentToolInventories(toolOptions)).inventories[0]
  assert.equal(displayed.revision, grok.revision, 'the management page must preserve the native revision used for mutation checks')
  assert(displayed.items.some(item => item.name === 'native-plugin-skill'), 'native plugin Skills stay visible even when the CLI omits their file paths')
  let native = grok.items.find((item) => item.name === 'native')!
  calls.length = 0
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'grok', action: 'mcp-disable', id: native.id, expectedFingerprint: fingerprint }, grokOptions), /capability_inventory_stale/)
  assert.equal(calls.some((call) => call.args[1] === 'disable'), false)
  const fresh = await manageBetaCapabilityInventory({ agentId: 'grok', action: 'mcp-disable', id: native.id, expectedFingerprint: native.fingerprint }, grokOptions)
  assert.notEqual(fresh.revision, grok.revision)
  assert.equal(calls.find((call) => call.args[1] === 'disable')?.bin, grokOptions.grokBin)
  assert.equal(calls.every((call) => call.home === home), true)
  native = fresh.items.find((item) => item.name === 'native')!
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'grok', action: 'plugin-update', id: native.id, expectedFingerprint: native.fingerprint }, grokOptions), invalid)
  calls.length = 0
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'grok', action: 'mcp-disable', id: native.id, expectedFingerprint: native.fingerprint, home: '/renderer-home' }, grokOptions), invalid)
  assert.equal(calls.length, 0)
  failMutation = true
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'grok', action: 'mcp-enable', id: native.id, expectedFingerprint: native.fingerprint }, grokOptions), (error: unknown) => {
    assert.equal((error as Error).message, 'capability_inventory_manage_failed')
    assert.equal((error as Error).stack?.includes('ERROR_SECRET'), false)
    assert.equal((error as Error & { cause?: unknown }).cause, undefined)
    return true
  })
  failureMessage = 'constructor'
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'grok', action: 'mcp-enable', id: native.id, expectedFingerprint: native.fingerprint }, grokOptions), (error: unknown) => {
    assert.equal((error as Error).message, 'capability_inventory_manage_failed'); return true
  })
  failMutation = false
  const plugin = fresh.items.find((item) => item.kind === 'plugin')!
  assert.equal(plugin.manageable, true, 'fixture belongs to the real native installed-plugins directory')
  const pluginResult = await manageBetaCapabilityInventory({ agentId: 'grok', action: 'plugin-update', id: plugin.id, expectedFingerprint: plugin.fingerprint }, grokOptions)
  assert.equal(pluginResult.items.find((item) => item.id === plugin.id)?.version, '2')
  grok = await grokInventoryFromOptions(grokOptions.grokBin, { cwd, env: { ...options.env, HOME: home }, runner })
  native = grok.items.find((item) => item.name === 'native')!
  scanCount = 0; changeDuringManage = true; calls.length = 0
  await assert.rejects(manageBetaCapabilityInventory({ agentId: 'grok', action: 'mcp-enable', id: native.id, expectedFingerprint: native.fingerprint }, grokOptions), /capability_inventory_stale/)
  assert.equal(calls.some((call) => call.args[1] === 'enable'), false)
} finally { await rm(dir, { recursive: true, force: true }) }

console.log('beta-capability-management: strict request routing, stale checks and safe errors ok')
