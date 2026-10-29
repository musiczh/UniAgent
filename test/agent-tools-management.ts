import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCapabilityInventories } from '../src/main/capability-sync/inventory.ts'
import type { PluginCommandRunner } from '../src/main/capability-sync/plugins.ts'
import { getAgentToolDetail, listAgentToolInventories, manageAgentToolInventory, removeAgentToolSkill, uninstallAgentToolPlugin, type AgentToolInventoryOptions } from '../src/main/agentToolInventory.ts'
import { INTERNAL_DISTRIBUTION, isDistributionAgent } from '../src/shared/distribution'

const home = await realpath(await mkdtemp(join(tmpdir(), 'ua-tool-management-')))
const runner: PluginCommandRunner = async (bin, args) => ({ stdout: bin === 'traecli'
  ? args.includes('marketplace') ? 'Found 0 plugins:\n' : 'Plugins:\n'
  : JSON.stringify({ installed: [], available: [] }) })
try {
  for (const path of ['.codex/skills', '.trae/skills', '.claude/skills', '.agents/skills/source']) {
    await mkdir(join(home, path), { recursive: true })
  }
  const manifest = '---\nname: source\ndescription: Shared fixture\n---\nSource content\n'
  await writeFile(join(home, '.agents/skills/source/SKILL.md'), manifest)
  await mkdir(join(home, '.claude/skills/private'))
  await writeFile(join(home, '.claude/skills/private/SKILL.md'), manifest.replace('name: source', 'name: private'))
  await symlink(join(home, '.agents/skills/source'), join(home, '.agents/skills/linked'))
  await symlink(join(home, 'missing'), join(home, '.agents/skills/broken'))
  await mkdir(join(home, '.claude/skills/manifest-link'))
  await symlink(join(home, '.agents/skills/source/SKILL.md'), join(home, '.claude/skills/manifest-link/SKILL.md'))
  await writeFile(join(home, '.codex/config.toml'), 'model="fixture"\n')
  await writeFile(join(home, '.trae/traecli.toml'), 'model="fixture"\n')

  const inventories = (await listCapabilityInventories(home, runner)).inventories
  const claude = inventories.find(value => value.agentId === 'claude')!
  assert.equal(claude.items.find(value => value.name === 'private')?.manageable, true,
    'ordinary Claude user Skills must be manageable independently of sync-provider support')
  const codex = inventories.find(value => value.agentId === 'codex')!
  const link = codex.items.find(value => value.name === 'linked')!
  assert.equal(link.entryPath, join(home, '.agents/skills/linked'))
  assert.equal(link.manifestPath, join(home, '.agents/skills/source/SKILL.md'))
  assert.equal(link.removal, 'link')
  assert.equal(link.manageable, true, 'shared-directory links must be removable')
  const broken = codex.items.find(value => value.name === 'broken')!
  assert.equal(broken.status, 'invalid')
  assert.equal(broken.removal, 'link', 'a dangling link remains removable without opening its target')
  const manifestLink = claude.items.find(value => value.name === 'manifest-link')!
  assert.equal(manifestLink.entryPath, join(home, '.claude/skills/manifest-link/SKILL.md'))
  assert.equal(manifestLink.manifestPath, join(home, '.agents/skills/source/SKILL.md'))
  assert.equal(manifestLink.removal, 'link')
  assert.equal(await readFile(join(home, '.agents/skills/source/SKILL.md'), 'utf8'), manifest)
  const names = (['codex', 'traex', 'claude', 'grok', 'kimi', 'deepseek', 'mcode', 'nika', 'zcode'] as const).filter(id => isDistributionAgent(id))
  const options: AgentToolInventoryOptions = { home, pluginRunner: runner,
    agents: names.map(id => ({ id, name: id, adapter: id, bin: id, installed: true })),
    env: { KIMI_CODE_HOME: join(home, '.kimi-code'), MINIMAX_DATA_DIR: join(home, '.minimax'), GROK_HOME: join(home, '.grok') },
    deepseekHome: join(home, 'service/home'),
    nativeSkills: {
      nika: async () => ({ skills: [{ name: 'private-link', path: join(home, '.nika/skills/private-link/SKILL.md') }], plugins: ['fixture-native-plugin'] }),
      zcode: async () => ({ skills: [{ name: 'zcode-private', path: join(home, '.zcode/skills/zcode-private/SKILL.md') },
        ...(zcodeInstalled ? [{ name: 'zcode-plugin-skill', path: join(home, '.zcode/plugins/fixture/skills/plugin-skill/SKILL.md') }] : [])] })
    },
    kimiPluginRemove: async id => {
      assert.equal(id, 'kimi-fixture')
      await writeFile(join(home, '.kimi-code/plugins/installed.json'), '{"version":1,"plugins":[]}')
    },
    zcodePlugins: async () => ({ plugins: zcodeInstalled ? [{ id: 'zcode-fixture@local', name: 'ZCode fixture', enabled: true,
      rootPath: join(home, '.zcode/plugins/fixture') }] : [] }),
    zcodePluginRemove: async id => { assert.equal(id, 'zcode-fixture@local'); zcodeInstalled = false },
    run: async (bin, args) => {
      if (bin === 'mcode') {
        if (args.includes('remove')) miniMaxInstalled = false
        return JSON.stringify({ installed: miniMaxInstalled ? [{ name: 'fixture-plugin', pluginId: 'fixture-plugin@local', installed: true, enabled: true }] : [] })
      }
      if (bin === 'deepseek' && args[1] === 'remove') await writeFile(profile, '{"dependencies":{}}')
      return '{}'
    }
  }
  let miniMaxInstalled = true
  let zcodeInstalled = true
  const profile = join(home, 'service/home/profiles/default/package.json')
  for (const path of ['.grok/skills/grok-private', '.kimi-code/skills', '.minimax/skills/minimax-private',
    'service/home/skills/deepseek-private', 'service/home/profiles/default', '.nika/skills', '.zcode/skills/zcode-private', '.zcode/plugins/fixture/skills/plugin-skill']) {
    await mkdir(join(home, path), { recursive: true })
  }
  for (const root of ['.minimax/skills', '.minimax/.builtin-skills', '.codex/skills', '.agents/skills']) {
    await mkdir(join(home, root, 'priority'), { recursive: true })
    await writeFile(join(home, root, 'priority/SKILL.md'), '---\nname: priority\ndescription: Priority fixture\n---\nPriority\n')
  }
  await writeFile(join(home, '.minimax/config.yaml'), 'skills:\n  external:\n    sources:\n      user-agents:\n        priority: 70\n')
  for (const path of ['.grok/skills/grok-private', '.minimax/skills/minimax-private',
    'service/home/skills/deepseek-private', '.zcode/skills/zcode-private']) await writeFile(join(home, path, 'SKILL.md'), manifest.replace('name: source', `name: ${path.split('/').at(-1)}`))
  await writeFile(profile, '{"dependencies":{"fixture-plugin":"1.0.0","@deepseek-ai/dsh-plugin-manager":"1.0.0"}}')
  await writeFile(join(home, '.zcode/plugins/fixture/skills/plugin-skill/SKILL.md'), '---\nname: zcode-plugin-skill\ndescription: Plugin skill\n---\nPlugin skill\n')
  await writeFile(join(home, '.kimi-code/skills/flat.md'), '---\nname: kimi-flat\ndescription: Flat fixture\n---\nKimi content\n')
  const kimiPlugin = join(home, '.kimi-code/plugins/fixture')
  await mkdir(join(kimiPlugin, 'skills/inside'), { recursive: true })
  await mkdir(join(kimiPlugin, 'direct'), { recursive: true })
  await writeFile(join(kimiPlugin, 'direct/SKILL.md'), '---\nname: plugin-direct\ndescription: Direct plugin skill\n---\nDirect\n')
  await writeFile(join(kimiPlugin, 'kimi.plugin.json'), '{"name":"Kimi fixture","skills":["skills","direct"]}')
  await writeFile(join(kimiPlugin, 'skills/inside/SKILL.md'), '---\nname: plugin-inside\ndescription: Plugin skill\n---\nPlugin skill\n')
  await writeFile(join(home, '.kimi-code/plugins/installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'kimi-fixture', root: kimiPlugin, enabled: true }] }))
  for (const name of ['parent', 'not-opted-in']) {
    await mkdir(join(home, '.kimi-code/skills', name, 'child'), { recursive: true })
    await writeFile(join(home, '.kimi-code/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Nested fixture\nhas-sub-skill: ${name === 'parent'}\n---\nParent\n`)
    await writeFile(join(home, '.kimi-code/skills', name, 'child/SKILL.md'), '---\nname: child\ndescription: Child\n---\nChild\n')
  }
  await symlink(join(home, '.agents/skills/source'), join(home, '.nika/skills/private-link'))

  const result = await listAgentToolInventories(options)
  assert.deepEqual(result.inventories.map(value => value.agentId), names)
  const entry = (agent: string, name: string) => result.inventories.find(value => value.agentId === agent)!.items.find(value => value.name === name)!
  assert(entry('kimi', 'kimi-flat').entryPath?.endsWith('flat.md'))
  assert(entry('kimi', 'parent.child'))
  assert.equal(result.inventories.find(value => value.agentId === 'kimi')!.items.some(value => value.name === 'not-opted-in.child'), false)
  assert(entry('mcode', 'minimax-private'))
  const priorityItems = result.inventories.find(value => value.agentId === 'mcode')!.items.filter(value => value.name === 'priority')
  assert.equal(priorityItems.find(value => value.status === 'available')?.entryPath, join(home, '.agents/skills/priority'),
    'MiniMax external priority overrides the global root and builtin roots rank last')
  assert.equal(priorityItems.filter(value => value.status === 'shadowed').length, 3)
  assert(entry('deepseek', 'deepseek-private'))
  if (INTERNAL_DISTRIBUTION) {
    assert(entry('nika', 'private-link').linked)
    assert.equal(entry('nika', 'fixture-native-plugin').manageable, false)
  }
  assert(entry('zcode', 'zcode-private'))
  assert.equal(entry('zcode', 'zcode-plugin-skill').manageable, false)
  assert.equal(entry('zcode', 'zcode-plugin-skill').scope, 'plugin')
  assert.equal(result.inventories.find(value => value.agentId === 'grok')!.items.some(value => value.entryPath === join(home, '.agents/skills/source')), false,
    'Grok must not inherit the generic shared root when its rules do not read it')
  assert.equal(entry('deepseek', '@deepseek-ai/dsh-plugin-manager').manageable, false)
  assert.equal(entry('kimi', 'plugin-inside').scope, 'plugin')
  assert.equal(entry('kimi', 'plugin-inside').manageable, false)
  assert.equal(entry('kimi', 'plugin-direct').scope, 'plugin', 'manifest paths may point directly to a Skill bundle')
  assert(result.inventories.find(value => value.agentId === 'deepseek')!.readSources!.every(value => !value.path.startsWith(join(home, '.agents'))),
    'DeepSeek scans its service home instead of the host account')
  const detail = await getAgentToolDetail(entry('codex', 'source').id, options)
  assert.equal(detail.manifestText, manifest)
  await removeAgentToolSkill(manifestLink.id, 'claude', manifestLink.fingerprint, options)
  await assert.rejects(lstat(manifestLink.entryPath!), { code: 'ENOENT' })
  assert.equal(await readFile(join(home, '.agents/skills/source/SKILL.md'), 'utf8'), manifest)
  if (INTERNAL_DISTRIBUTION) {
    const nativeLink = entry('nika', 'private-link')
    assert.equal((await getAgentToolDetail(nativeLink.id, options)).manifestText, manifest)
    await removeAgentToolSkill(nativeLink.id, 'nika', nativeLink.fingerprint, options)
    await assert.rejects(lstat(nativeLink.entryPath!), { code: 'ENOENT' })
    assert.equal(await readFile(join(home, '.agents/skills/source/SKILL.md'), 'utf8'), manifest)
  }
  const fresh = await listAgentToolInventories({ ...options, nativeSkills: { ...options.nativeSkills, zcode: undefined } })
  assert.equal(fresh.inventories.find(value => value.agentId === 'zcode')!.status, 'invalid')
  assert(fresh.inventories.find(value => value.agentId === 'codex')!.items.length > 0, 'one failed Agent cannot erase other inventories')
  const flat = entry('kimi', 'kimi-flat')
  await writeFile(flat.entryPath!, 'changed after confirmation')
  await assert.rejects(removeAgentToolSkill(flat.id, 'kimi', flat.fingerprint, options), /stale_selection/)
  assert.equal(await readFile(flat.entryPath!, 'utf8'), 'changed after confirmation')
  const brokenItem = result.inventories.find(value => value.agentId === 'codex')!.items.find(value => value.name === 'broken')!
  await removeAgentToolSkill(brokenItem.id, 'codex', brokenItem.fingerprint, options)
  await assert.rejects(lstat(brokenItem.entryPath!), { code: 'ENOENT' })
  const plugin = entry('mcode', 'fixture-plugin')
  await assert.rejects(uninstallAgentToolPlugin({ agentId: 'mcode', action: 'plugin-uninstall', id: plugin.id, expectedFingerprint: '0'.repeat(64) }, options), /stale_selection/)
  let attemptedRemoval = false
  await assert.rejects(uninstallAgentToolPlugin({ agentId: 'mcode', action: 'plugin-uninstall', id: plugin.id, expectedFingerprint: plugin.fingerprint }, {
    ...options, run: async (bin, args, env) => {
      if (bin === 'mcode' && args.includes('remove')) { attemptedRemoval = true; return '{}' }
      if (bin === 'mcode' && attemptedRemoval) throw new Error('post-uninstall inventory unavailable')
      return options.run!(bin, args, env)
    }
  }), /plugin_uninstall_failed/, 'a successful command cannot count as a verified uninstall when the subsequent scan fails')
  assert.equal(attemptedRemoval, true)
  const removedPlugin = await manageAgentToolInventory({ agentId: 'mcode', action: 'plugin-uninstall', id: plugin.id, expectedFingerprint: plugin.fingerprint }, options)
  assert.equal(removedPlugin.items.some(value => value.id === plugin.id), false)
  assert.equal(miniMaxInstalled, false)
  const deepPlugin = entry('deepseek', 'fixture-plugin')
  await uninstallAgentToolPlugin({ agentId: 'deepseek', action: 'plugin-remove', id: deepPlugin.id, expectedFingerprint: deepPlugin.fingerprint }, options)
  const installedKimi = entry('kimi', 'Kimi fixture')
  const removedKimi = await manageAgentToolInventory({ agentId: 'kimi', action: 'plugin-uninstall', id: installedKimi.id, expectedFingerprint: installedKimi.fingerprint }, options)
  assert.equal(removedKimi.items.some(value => value.name === 'plugin-inside'), false)
  const installedZcode = entry('zcode', 'ZCode fixture')
  const removedZcode = await manageAgentToolInventory({ agentId: 'zcode', action: 'plugin-uninstall', id: installedZcode.id, expectedFingerprint: installedZcode.fingerprint }, options)
  assert.equal(removedZcode.items.some(value => value.name === 'zcode-plugin-skill' || value.id === installedZcode.id), false)
  const partial = await listAgentToolInventories({ ...options, run: async (bin, args, env) => {
    if (bin === 'mcode') throw new Error('CLI unavailable')
    return options.run!(bin, args, env)
  } })
  const miniMax = partial.inventories.find(value => value.agentId === 'mcode')!
  assert.equal(miniMax.status, 'invalid')
  assert(miniMax.items.some(value => value.name === 'minimax-private'), 'plugin lookup failure preserves valid Skills')
  assert(miniMax.readSources!.some(value => value.kind === 'native' && value.status === 'error'))
  for (const name of ['first', 'second']) {
    await writeFile(join(home, `.agents/skills/${name}.md`), `---\nname: ${name}\ndescription: Shared flat\n---\n${name}\n`)
    await symlink(join(home, `.agents/skills/${name}.md`), join(home, `.kimi-code/skills/${name}-link.md`))
  }
  const sharedFlat = (await listAgentToolInventories(options)).inventories.find(value => value.agentId === 'kimi')!
  const first = sharedFlat.items.find(value => value.entryPath === join(home, '.agents/skills/first.md'))!
  assert.equal(sharedFlat.items.filter(value => value.entryPath === join(home, '.kimi-code/skills/first-link.md')).length, 1,
    'flat file links must appear once')
  await removeAgentToolSkill(first.id, 'kimi', first.fingerprint, options)
  await assert.rejects(lstat(join(home, '.kimi-code/skills/first-link.md')), { code: 'ENOENT' })
  assert((await lstat(join(home, '.kimi-code/skills/second-link.md'))).isSymbolicLink(), 'another flat Skill in the same folder is independent')
  assert((await readFile(join(home, '.agents/skills/second.md'), 'utf8')).includes('second'))
  const sharedSource = result.inventories.find(value => value.agentId === 'codex')!.items.find(value => value.name === 'source')!
  await symlink(join(home, '.agents/skills/source/SKILL.md'), manifestLink.entryPath!)
  await removeAgentToolSkill(sharedSource.id, 'codex', sharedSource.fingerprint, options)
  await assert.rejects(lstat(join(home, '.agents/skills/source')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(home, '.agents/skills/linked')), { code: 'ENOENT' })
  await assert.rejects(lstat(manifestLink.entryPath!), { code: 'ENOENT' })
  await assert.rejects(removeAgentToolSkill('arbitrary-path', 'codex', undefined, options), /invalid_selection/)
  console.log('agent-tools-management: private Skills, shared links, dangling links and source paths passed')
} finally {
  await rm(home, { recursive: true, force: true })
}
