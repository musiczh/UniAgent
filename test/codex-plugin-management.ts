import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentToolDetail, listAgentToolInventories, manageAgentToolInventory } from '../src/main/agentToolInventory.ts'
import type { PluginCommandRunner } from '../src/main/capability-sync/plugins.ts'
import { setCodexPluginEnabled } from '../src/main/codexPluginManagement.ts'
import type { AppServerRpc } from '../src/main/appServerTransport.ts'

const home = await realpath(await mkdtemp(join(tmpdir(), 'ua-codex-plugins-')))
try {
  const root = join(home, '.codex/plugins/cache/local/design/1.0.0')
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, 'skills/design-to-code'), { recursive: true })
  await mkdir(join(home, '.codex/skills'), { recursive: true })
  await writeFile(join(home, '.codex/config.toml'), 'model="fixture"\n')
  await writeFile(join(root, 'skills/design-to-code/SKILL.md'), '---\nname: design-to-code\ndescription: Turn designs into code.\n---\n# Design instructions\n')
  const manifest = { name: 'design', version: '1.0.0', description: 'Complete plugin introduction.', skills: './skills', author: { name: 'Design, Inc.' },
    interface: { displayName: 'Design', shortDescription: 'Create designs, ship code', logo: './logo.svg' } }
  const manifestFile = join(root, '.codex-plugin/plugin.json')
  await writeFile(manifestFile, JSON.stringify(manifest))
  await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  let enabled = false, remote = false, changes = 0
  const runner: PluginCommandRunner = async (bin, args) => ({ stdout: bin === 'codex' ? JSON.stringify({ installed: [{
    pluginId: 'design@local', name: 'design', marketplaceName: 'local', version: '1.0.0', enabled,
    source: remote ? { source: 'remote', id: 'plugin_fixture' } : { source: 'local', path: root }
  }], available: [] }) : bin === 'traecli' ? args.includes('marketplace') ? 'Found 0 plugins:\n' : 'Plugins:\n' : '{"installed":[],"available":[]}' })
  const options = { home, agents: [{ id: 'codex', name: 'Codex', bin: 'fixture-codex', installed: true, adapter: 'codex' as const }], pluginRunner: runner,
    codexPluginState: async (id: string, next: boolean) => { assert.equal(id, 'design@local'); enabled = next; changes++ } }
  const inventory = async () => (await listAgentToolInventories(options)).inventories[0]
  const plugin = (await inventory()).items.find(item => item.kind === 'plugin')!
  assert.equal(plugin.name, 'Design')
  assert.equal(plugin.enabled, false)
  assert.equal(plugin.stateManageable, true)
  assert.equal((await inventory()).items.some(item => item.name === 'design-to-code'), false, 'disabled plugin skills must not enter the active inventory')
  const detail = await getAgentToolDetail(plugin.id, options)
  assert.equal(detail.plugin?.description, manifest.description)
  assert.equal(detail.plugin?.author, manifest.author.name)
  assert.equal(detail.plugin?.shortDescription, manifest.interface.shortDescription)
  assert(detail.plugin?.logoDataUrl?.startsWith('data:image/svg+xml;base64,'))
  assert.equal(detail.manifestText, undefined, 'plugin details expose selected metadata instead of the raw manifest')
  const skill = detail.plugin!.skills[0]
  assert.equal(skill.description, 'Turn designs into code.')
  assert.equal(skill.manageable, false)
  assert.equal(skill.plugin, 'design@local')
  assert((await getAgentToolDetail(skill.id, options)).manifestText?.includes('Design instructions'), 'disabled plugin skills remain readable from plugin details')
  const request = { agentId: 'codex', action: 'plugin-enable', id: plugin.id, expectedFingerprint: plugin.fingerprint }
  await assert.rejects(manageAgentToolInventory({ ...request, path: root }, options), /invalid_capability_inventory_manage_request/)
  await assert.rejects(manageAgentToolInventory({ ...request, expectedFingerprint: 'old' }, options), /capability_inventory_stale/)
  assert.equal(changes, 0)
  const afterEnable = await manageAgentToolInventory(request, options)
  assert.equal(afterEnable.items.find(item => item.id === plugin.id)?.enabled, true)
  assert(afterEnable.items.some(item => item.name === 'design-to-code'))
  await assert.rejects(manageAgentToolInventory(request, options), /capability_inventory_stale/, 'state changes invalidate stale actions')
  const updated = afterEnable.items.find(item => item.id === plugin.id)!
  await manageAgentToolInventory({ ...request, action: 'plugin-disable', expectedFingerprint: updated.fingerprint }, options)
  assert.equal(changes, 2)
  const disabled = (await inventory()).items.find(item => item.id === plugin.id)!
  await assert.rejects(manageAgentToolInventory({ ...request, expectedFingerprint: disabled.fingerprint }, { ...options, codexPluginState: async () => {} }), /capability_inventory_manage_failed/, 'write success alone must not report success without native readback')
  remote = true
  const remotePlugin = (await inventory()).items.find(item => item.id === plugin.id)!
  assert.equal(remotePlugin.stateManageable, false)
  assert(remotePlugin.stateReadOnlyReason?.includes('Codex 插件页'))
  await assert.rejects(manageAgentToolInventory({ ...request, expectedFingerprint: remotePlugin.fingerprint }, options), /capability_inventory_read_only/)
  assert.equal(changes, 2, 'remote enable/disable must never fall back to installing or uninstalling')

  for (const logo of ['../../../../outside.svg', './linked.svg', './large.svg']) {
    await writeFile(join(home, 'outside.svg'), 'private fixture')
    if (logo === './linked.svg') await symlink(join(home, 'outside.svg'), join(root, 'linked.svg'))
    if (logo === './large.svg') await writeFile(join(root, 'large.svg'), 'x'.repeat(512 * 1024 + 1))
    await writeFile(manifestFile, JSON.stringify({ ...manifest, interface: { ...manifest.interface, logo } }))
    assert.equal((await getAgentToolDetail(plugin.id, options)).plugin?.logoDataUrl, undefined, 'unsafe or oversized logos must not be exposed')
  }
  const failed = (await listAgentToolInventories({ ...options, pluginRunner: async () => { throw new Error('sensitive command output') } })).inventories[0]
  assert(failed.message?.includes('插件清单读取失败'))
  assert(!JSON.stringify(failed).includes('sensitive command output'))

  for (const status of ['ok', 'okOverridden', 'throw']) {
    let disposed = false
    const calls: { method: string; params: any }[] = []
    const client = Object.assign(new EventEmitter(), {
      start: async () => {}, notify: () => {}, dispose: async () => { disposed = true },
      request: async (method: string, params: any) => {
        calls.push({ method, params })
        if (method === 'config/read') return { layers: [{ name: { type: 'user', file: join(home, '.codex/config.toml') }, version: 'current' }] }
        if (method === 'config/value/write') {
          if (status === 'throw') throw new Error('write failed')
          return { status }
        }
        return {}
      }
    }) as unknown as AppServerRpc
    const action = setCodexPluginEnabled('fixture', home, 'design.v2@local', true, client)
    if (status === 'ok') await action
    else await assert.rejects(action)
    assert.equal(disposed, true)
    assert.deepEqual(calls.find(call => call.method === 'config/value/write')?.params, {
      keyPath: 'plugins."design.v2@local".enabled', value: true, mergeStrategy: 'upsert', filePath: join(home, '.codex/config.toml'), expectedVersion: 'current'
    })
  }
  console.log('codex-plugin-management: installed metadata, disabled Skill details, verified state writes, remote limits, stale actions and safe logos passed')
} finally { await rm(home, { recursive: true, force: true }) }
