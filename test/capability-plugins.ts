import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverInstalledPlugins,
  executePluginAction,
  capabilityPluginInventoryId,
  parseClaudePluginList,
  parseCodexPluginList,
  parseTraexPluginList,
  parseTraexMarketplace,
  pluginActionCommand,
  type PluginCommandRunner
} from '../src/main/capability-sync/plugins.ts'
import { listCapabilityInventories } from '../src/main/capability-sync/inventory.ts'

assert.equal(parseCodexPluginList(JSON.stringify({ installed: [{
  pluginId: 'figma@openai-curated', name: 'figma', marketplaceName: 'openai-curated',
  version: '2.0.21', installed: true, enabled: true, source: { source: 'local', path: '/safe/figma' }
}] }))[0].pluginId, 'figma@openai-curated')

assert.equal(parseTraexPluginList('Plugins:\n\n✓ browser\n  From local: /safe/browser\n  id: browser@openai-bundled\n')[0].pluginId, 'browser@openai-bundled')
assert.equal(parseTraexMarketplace('Found 1 plugins:\n\nMarketplace: openai-bundled\n* browser (browser@openai-bundled)\n')[0].pluginId, 'browser@openai-bundled')
assert.throws(() => parseTraexMarketplace('Found 1 plugins:\n'), /plugin_enumeration_failed/)

assert.equal(parseClaudePluginList(JSON.stringify({ installed: [{
  id: 'superpowers@official', version: '6.3.0', scope: 'user', enabled: true, installPath: '/safe/superpowers'
}] }))[0].pluginId, 'superpowers@official')

assert.throws(() => parseClaudePluginList(JSON.stringify({ installed: [{
  id: 'bad@official', scope: 'user', installPath: 'relative/plugin'
}] })), /plugin_enumeration_failed/)

const home = await realpath(await mkdtemp(join(tmpdir(), 'ua-plugin-')))
const pluginDir = join(home, '.codex/plugins/cache/openai-curated/figma/2.0.21')
await mkdir(join(pluginDir, '.codex-plugin'), { recursive: true })
await mkdir(join(pluginDir, 'skills', 'design-to-code'), { recursive: true })
await writeFile(join(pluginDir, 'skills', 'design-to-code', 'SKILL.md'), '# Design to code\n')
await writeFile(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({
  name: 'figma', version: '2.0.21', skills: './skills', mcpServers: { figma: {} }, hooks: './hooks.json'
}))
const runner: PluginCommandRunner = async (bin) => ({ stdout: bin === 'codex' ? JSON.stringify({ installed: [{
  pluginId: 'figma@openai-curated', name: 'figma', marketplaceName: 'openai-curated', version: '2.0.21',
  installed: true, enabled: true, source: { source: 'local', path: pluginDir }
}], available: [] }) : '' })
const discovered = await discoverInstalledPlugins('codex', home, runner)
assert.equal(discovered.length, 1)
assert.deepEqual({ pluginId: discovered[0].pluginId, cachedVersions: discovered[0].cachedVersions, components: discovered[0].components }, {
  pluginId: 'figma@openai-curated', cachedVersions: 1,
  components: { skills: 1, mcps: 1, hooks: 1, apps: 0, models: 0, commands: 0 }
})

await mkdir(join(home, '.codex/skills'), { recursive: true })
await mkdir(join(home, '.trae/skills'), { recursive: true })
await mkdir(join(home, '.claude/skills'), { recursive: true })
await writeFile(join(home, '.codex/config.toml'), 'model="gpt"\n')
await writeFile(join(home, '.trae/traecli.toml'), 'model="gpt"\n')
const inventoryRunner: PluginCommandRunner = async (bin, args) => {
  if (bin === 'codex') return runner(bin, args, { home })
  if (bin === 'traecli') return { stdout: args.includes('marketplace') ? 'Found 0 plugins:\n' : 'Plugins:\n' }
  return { stdout: JSON.stringify({ installed: [], available: [] }) }
}
const inventory = await listCapabilityInventories(home, inventoryRunner)
const plugin = inventory.inventories.find((entry) => entry.agentId === 'codex')?.items.find((entry) => entry.kind === 'plugin')
assert.equal(plugin?.pluginId, 'figma@openai-curated')
assert.equal(plugin?.name, 'figma')
assert.equal(plugin?.components?.skills, 1)
assert.equal(inventory.inventories.flatMap((entry) => entry.items).some((entry) => entry.kind === 'skill' && entry.name === 'design-to-code'), false)

assert.deepEqual(pluginActionCommand('codex', 'migrate', 'figma@openai-curated'), { bin: 'codex', args: ['plugin', 'add', 'figma@openai-curated', '--json'] })
assert.deepEqual(pluginActionCommand('traex', 'uninstall', 'figma@openai-curated'), { bin: 'traecli', args: ['plugin', 'uninstall', 'figma@openai-curated'] })
assert.deepEqual(pluginActionCommand('claude', 'migrate', 'superpowers@official'), { bin: 'claude', args: ['plugin', 'install', 'superpowers@official', '--scope', 'user'] })
assert.deepEqual(pluginActionCommand('claude', 'uninstall', 'superpowers@official'), { bin: 'claude', args: ['plugin', 'uninstall', 'superpowers@official', '--scope', 'user', '--json', '--keep-data'] })

let codexInstalled = true
let traexInstalled = false
const calls: Array<{ bin: string; args: string[] }> = []
const actionRunner: PluginCommandRunner = async (bin, args) => {
  calls.push({ bin, args })
  if (bin === 'codex' && args[1] === 'list') return { stdout: JSON.stringify({ installed: codexInstalled ? [{
    pluginId: 'figma@openai-curated', name: 'figma', marketplaceName: 'openai-curated', version: '2.0.21', installed: true, source: { path: pluginDir }
  }] : [], available: [] }) }
  if (bin === 'codex' && args[1] === 'remove') { codexInstalled = false; return { stdout: '{}' } }
  if (bin === 'traecli' && args[1] === 'marketplace') return { stdout: 'Found 1 plugins:\n\nMarketplace: openai-curated\n* figma (figma@openai-curated)\n' }
  if (bin === 'traecli' && args[1] === 'install') { traexInstalled = true; return { stdout: '' } }
  if (bin === 'traecli' && args[1] === 'list') return { stdout: traexInstalled
    ? `Plugins:\n\n✓ figma\n  From local: ${pluginDir}\n  id: figma@openai-curated\n`
    : 'Plugins:\n' }
  return { stdout: JSON.stringify({ installed: [], available: [] }) }
}
const pluginId = capabilityPluginInventoryId('codex', 'figma@openai-curated')
for (const targetAgentId of ['zcode', 'nika'] as const) {
  await assert.rejects(executePluginAction(home, { id: pluginId, action: 'migrate', targetAgentId }, actionRunner), /plugin_target_incompatible/)
  assert.equal(calls.some(call => call.args.includes('install') || call.args.includes('add')), false, 'unsupported targets cannot run an installation')
}
assert.deepEqual(await executePluginAction(home, { id: pluginId, action: 'migrate', targetAgentId: 'traex' }, actionRunner), {
  action: 'migrate', sourceAgentId: 'codex', targetAgentId: 'traex', pluginId: 'figma@openai-curated'
})
assert.equal(calls.some((call) => call.bin === 'traecli' && call.args.join(' ') === 'plugin install figma@openai-curated'), true)
assert.deepEqual(await executePluginAction(home, { id: pluginId, action: 'uninstall' }, actionRunner), {
  action: 'uninstall', sourceAgentId: 'codex', pluginId: 'figma@openai-curated'
})
assert.equal(calls.some((call) => call.bin === 'codex' && call.args.join(' ') === 'plugin remove figma@openai-curated --json'), true)
assert.equal(existsSync(join(home, '.codex/plugins/cache/openai-curated/figma')), false)

console.log('capability plugin tests passed')
