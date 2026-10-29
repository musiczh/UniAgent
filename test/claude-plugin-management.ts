import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  capabilityPluginInventoryId,
  discoverInstalledPlugins,
  executePluginAction,
  parseClaudePluginList,
  type PluginCommandRunner
} from '../src/main/capability-sync/plugins.ts'

const home = await realpath(await mkdtemp(join(tmpdir(), 'uniagent-claude-plugin-')))
const pluginId = 'fixture-plugin@fixture-local'
const pluginDir = join(home, '.claude/plugins/cache/fixture-local/fixture-plugin/1.0.0')
const dataPath = join(home, '.claude/plugins/data/fixture-plugin-fixture-local/marker.txt')
await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
await mkdir(join(home, '.claude/plugins/data/fixture-plugin-fixture-local'), { recursive: true })
await writeFile(join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }))
await writeFile(dataPath, 'saved-plugin-data')
const row = (scope: string) => ({ id: pluginId, version: '1.0.0', scope, enabled: true, installPath: pluginDir })
const action = { id: capabilityPluginInventoryId('claude', pluginId), action: 'uninstall' as const }

try {
  // Break caught: scope is dropped, project/local installations get removed, or
  // a same-ID project installation prevents a user installation being listed.
  assert.deepEqual(parseClaudePluginList(JSON.stringify({ installed: [row('user'), row('project'), row('local')] })).map(entry => [entry.pluginId, entry.scope]), [[pluginId, 'user']])
  assert.deepEqual(parseClaudePluginList(JSON.stringify({ installed: [row('project'), row('local'), row('unknown')] })), [])
  assert.deepEqual(parseClaudePluginList(JSON.stringify({ installed: [{ ...row('user'), scope: undefined }] })), [])

  let userInstalled = true
  const commands: string[][] = []
  const runner: PluginCommandRunner = async (bin, args, options) => {
    assert.equal(options.home, home)
    if (bin === 'codex') return { stdout: JSON.stringify({ installed: [], available: [] }) }
    if (bin === 'traecli') return { stdout: 'Plugins:\n' }
    assert.equal(bin, 'claude')
    if (args[1] === 'list') return { stdout: JSON.stringify({ installed: [...(userInstalled ? [row('user')] : []), row('project')], available: [] }) }
    commands.push(args)
    assert.deepEqual(args, ['plugin', 'uninstall', pluginId, '--scope', 'user', '--json', '--keep-data'])
    userInstalled = false
    return { stdout: JSON.stringify({ command: 'uninstall', outcome: 'ok', plugin: pluginId, scope: 'user' }) }
  }

  // Break caught: the native user uninstall fails to remove its installation,
  // removes shared cache files, or discards persistent plugin data.
  const found = await discoverInstalledPlugins('claude', home, runner)
  assert.equal(found[0].scope, 'user')
  assert.equal(found[0].status, 'available')
  assert.deepEqual(await executePluginAction(home, action, runner), { action: 'uninstall', sourceAgentId: 'claude', pluginId })
  assert.equal(commands.length, 1)
  assert.equal(existsSync(pluginDir), true)
  assert.equal(await readFile(dataPath, 'utf8'), 'saved-plugin-data')
  assert.deepEqual(await discoverInstalledPlugins('claude', home, runner), [])

  // Break caught: an opaque ID from a read-only/non-user scope can be mutated.
  for (const scope of ['project', 'local', 'unknown']) {
    let mutated = false
    const protectedRunner: PluginCommandRunner = async (bin, args) => {
      if (bin === 'codex') return { stdout: JSON.stringify({ installed: [], available: [] }) }
      if (bin === 'traecli') return { stdout: 'Plugins:\n' }
      if (args[1] === 'list') return { stdout: JSON.stringify({ installed: [row(scope)], available: [] }) }
      mutated = true
      return { stdout: '{}' }
    }
    await assert.rejects(executePluginAction(home, action, protectedRunner), /plugin_target_incompatible/)
    assert.equal(mutated, false)
  }

  // Break caught: a rejected or ineffective native uninstall is reported as success.
  for (const fails of [true, false]) {
    const failedRunner: PluginCommandRunner = async (bin, args) => {
      if (bin === 'codex') return { stdout: JSON.stringify({ installed: [], available: [] }) }
      if (bin === 'traecli') return { stdout: 'Plugins:\n' }
      if (args[1] === 'list') return { stdout: JSON.stringify({ installed: [row('user')], available: [] }) }
      if (fails) throw new Error('CLI rejected removal')
      return { stdout: JSON.stringify({ command: 'uninstall', outcome: 'ok' }) }
    }
    await assert.rejects(executePluginAction(home, action, failedRunner), /plugin_uninstall_failed/)
    assert.equal(existsSync(pluginDir), true)
    assert.equal(await readFile(dataPath, 'utf8'), 'saved-plugin-data')
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
console.log('claude-plugin-management: native user uninstall, scope isolation, retained cache/data and failure verification passed')
