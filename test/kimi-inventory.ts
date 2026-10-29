import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createKimiSkill, deleteKimiCapability, getKimiInventoryDetail, inspectKimiInventory,
  updateKimiSkill, upsertKimiMcp
} from '../src/main/kimiInventory.ts'

const fixture = await mkdtemp(join(tmpdir(), 'uniagent-kimi-inventory-'))
const home = join(fixture, 'home'), cwd = join(fixture, 'project', 'nested')
const kimiHome = join(home, '.kimi-code'), skills = join(kimiHome, 'skills')
const options = { home, cwd, env: {} }
const manifest = (name: string, extra = '', body = 'Run this skill.') =>
  `---\nname: ${name}\ndescription: Fixture skill\n${extra}---\n\n${body}\n`
const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, text)
}
try {
  await mkdir(cwd, { recursive: true }); await mkdir(join(fixture, 'project', '.git'))
  await put(join(skills, 'review', 'SKILL.md'), manifest('review'))
  await put(join(skills, 'review.md'), '# Flat duplicate must be suppressed')
  await put(join(skills, 'flat.md'), '# Flat skill description\nUse it.')
  await put(join(skills, 'parent', 'SKILL.md'), manifest('parent', 'has-sub-skill: true\n'))
  await put(join(skills, 'parent', 'child', 'SKILL.md'), manifest('child'))
  await put(join(skills, 'parent', 'child.md'), 'Nested flat should not load')
  await put(join(skills, 'plain', 'SKILL.md'), manifest('plain'))
  await put(join(skills, 'plain', 'hidden-child', 'SKILL.md'), manifest('hidden-child'))
  await put(join(skills, '.hidden', 'SKILL.md'), manifest('hidden'))
  await put(join(skills, 'node_modules', 'other', 'SKILL.md'), manifest('other'))
  await put(join(skills, 'invalid', 'SKILL.md'), 'Missing frontmatter')
  await put(join(skills, 'multiline', 'SKILL.md'), '---\nname: multiline\ndescription: |\n  This multiline description is accepted by Kimi.\n  It can span several lines.\n---\nBody\n')
  await put(join(skills, 'unsupported', 'SKILL.md'), manifest('unsupported', 'type: unknown\n'))
  await put(join(home, '.agents', 'skills', 'shared', 'SKILL.md'), manifest('shared'))
  await put(join(home, '.agents', 'skills', 'review', 'SKILL.md'), manifest('REVIEW'))
  await put(join(fixture, 'project', '.kimi-code', 'skills', 'review', 'SKILL.md'), manifest('Review'))
  await put(join(fixture, 'project', 'extras', 'extra', 'SKILL.md'), manifest('extra'))
  await put(join(kimiHome, 'config.toml'), 'extra_skill_dirs = ["extras"]\n')
  const pluginRoot = join(kimiHome, 'plugins', 'managed', 'fixture')
  await put(join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md'), manifest('plugin-skill'))
  await put(join(pluginRoot, 'kimi.plugin.json'), JSON.stringify({
    name: 'fixture', skills: ['skills'], mcpServers: { 'plugin-mcp': { command: 'node', env: { SECRET: 'PLUGIN_SECRET' } } }
  }))
  await put(join(kimiHome, 'plugins', 'installed.json'), JSON.stringify({ version: 1, plugins: [
    { id: 'fixture', root: pluginRoot, enabled: true }, { id: 'disabled', root: pluginRoot, enabled: false }
  ] }))
  await put(join(kimiHome, 'mcp.json'), JSON.stringify({ untouched: { keep: true }, mcpServers: {
    'user-mcp': { command: 'node', args: ['--token', 'ARG_SECRET'], env: { API_KEY: 'ENV_SECRET' }, cwd: '/native/runtime', customField: { keep: true } },
    override: { url: 'https://user:URL_SECRET@example.test/PATH_SECRET?api_key=QUERY_SECRET', headers: { Authorization: 'HEADER_SECRET' } }
  } }))
  await put(join(fixture, 'project', '.mcp.json'), JSON.stringify({ mcpServers: { override: { command: 'root-command' } } }))
  await put(join(cwd, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: { override: { url: 'https://example.test/project' } } }))

  let inventory = await inspectKimiInventory(options)
  assert.equal(inventory.agentId, 'kimi'); assert.equal(inventory.writable, true)
  const available = inventory.items.filter((item) => item.kind === 'skill' && item.status === 'available')
  assert.deepEqual(available.map((item) => item.name).sort(), ['Review', 'extra', 'flat', 'multiline', 'parent', 'parent.child', 'plain', 'plugin-skill', 'shared'].sort())
  assert.equal(inventory.items.filter((item) => item.name.toLowerCase() === 'review').length, 3)
  assert.equal(inventory.items.find((item) => item.name === 'review' && item.owner === 'user')?.status, 'shadowed')
  assert.equal(inventory.items.find((item) => item.name === 'invalid')?.status, 'invalid')
  assert.equal(inventory.items.find((item) => item.name === 'unsupported')?.status, 'unsupported')
  assert.equal(inventory.items.filter((item) => item.owner !== 'user').every((item) => !item.manageable && !item.copyable), true)
  assert.equal(inventory.items.find((item) => item.name === 'plugin-fixture:plugin-mcp')?.owner, 'plugin')
  assert.equal(inventory.items.filter((item) => item.kind === 'mcp' && item.name === 'override' && item.status === 'available').length, 1)
  assert.equal(inventory.items.find((item) => item.kind === 'mcp' && item.name === 'override' && item.status === 'available')?.source, 'project')
  for (const item of inventory.items.filter((item) => item.kind === 'mcp')) {
    const detail = await getKimiInventoryDetail(item.id, options)
    for (const secret of ['ENV_SECRET', 'HEADER_SECRET', 'URL_SECRET', 'PATH_SECRET', 'QUERY_SECRET', 'ARG_SECRET', 'PLUGIN_SECRET']) {
      assert.equal(JSON.stringify({ inventory, detail }).includes(secret), false)
    }
    assert.equal(detail?.openable, false)
  }
  const flat = inventory.items.find((item) => item.name === 'flat')!
  const detail = await getKimiInventoryDetail(flat.id, options)
  assert.equal(detail?.manifestFile, 'flat.md'); assert.equal(detail?.openable, false)
  const parent = inventory.items.find((item) => item.name === 'parent')!
  assert.equal((await getKimiInventoryDetail(parent.id, options))?.openable, true)
  await put(join(fixture, 'shared-manifest.md'), manifest('hardlinked'))
  await link(join(fixture, 'shared-manifest.md'), join(skills, 'hardlinked.md'))
  assert.equal((await inspectKimiInventory(options)).items.find((item) => item.name === 'hardlinked')?.manageable, false)
  await assert.rejects(deleteKimiCapability({ id: inventory.items.find((item) => item.name === 'shared')!.id, expectedFingerprint: inventory.items.find((item) => item.name === 'shared')!.fingerprint }, options), /kimi_read_only/)
  await assert.rejects(createKimiSkill({ name: '../escape', manifestText: manifest('escape') }, options), /kimi_invalid_request/)
  await assert.rejects(createKimiSkill({ name: 'invalid-new', manifestText: 'No frontmatter' }, options), /kimi_invalid_skill/)
  await assert.rejects(createKimiSkill({ name: 'review', manifestText: manifest('review') }, options), /kimi_already_exists/)
  await assert.rejects(createKimiSkill({ name: 'alias', manifestText: manifest('review') }, options), /kimi_already_exists/)
  await put(join(skills, 'flat-alias.md'), manifest('flat-alias-display'))
  await assert.rejects(createKimiSkill({ name: 'flat-alias', manifestText: manifest('new-display') }, options), /kimi_already_exists/)
  await assert.rejects(updateKimiSkill({ id: flat.id, expectedFingerprint: flat.fingerprint, manifestText: manifest('plain') }, options), /kimi_already_exists/)
  const created = await createKimiSkill({ name: 'created', manifestText: manifest('created') }, options)
  assert.equal(created.manageable, true)
  await put(join(skills, 'created', 'reference.txt'), 'Keep supporting files')
  const updated = await updateKimiSkill({ id: created.id, expectedFingerprint: created.fingerprint, manifestText: manifest('created', '', 'Updated body') }, options)
  assert.equal(await readFile(join(skills, 'created', 'reference.txt'), 'utf8'), 'Keep supporting files')
  await assert.rejects(updateKimiSkill({ id: created.id, expectedFingerprint: created.fingerprint, manifestText: manifest('created') }, options), /kimi_stale_inventory/)
  await deleteKimiCapability({ id: updated.id, expectedFingerprint: updated.fingerprint }, options)
  assert.equal((await inspectKimiInventory(options)).items.some((item) => item.id === updated.id), false)

  const userMcp = inventory.items.find((item) => item.name === 'user-mcp')!
  const mcp = await upsertKimiMcp({ name: 'user-mcp', expectedFingerprint: userMcp.fingerprint, config: { command: 'new-command', env: { API_KEY: '[redacted]' } } }, options)
  let config = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8'))
  assert.equal(config.mcpServers['user-mcp'].env.API_KEY, 'ENV_SECRET')
  assert.equal(config.mcpServers['user-mcp'].cwd, '/native/runtime', 'main-only native paths survive a renderer edit')
  assert.deepEqual(config.mcpServers['user-mcp'].customField, { keep: true }, 'unknown native settings survive updates')
  assert.deepEqual(config.untouched, { keep: true }); assert.ok(config.mcpServers.override)
  const endpoint = (await inspectKimiInventory(options)).items.find((item) => item.name === 'override' && item.owner === 'user')!
  const endpointDetail = JSON.parse((await getKimiInventoryDetail(endpoint.id, options))!.manifestText!)
  const beforeEndpoint = config.mcpServers.override.url
  await upsertKimiMcp({ name: endpoint.name, expectedFingerprint: endpoint.fingerprint, config: endpointDetail }, options)
  config = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8'))
  assert.equal(config.mcpServers.override.url, beforeEndpoint, 'redacted endpoint origin roundtrip preserves path and credentials')
  await assert.rejects(upsertKimiMcp({ name: 'user-mcp', config: { command: 'overwrite' } }, options), /kimi_stale_inventory/)
  await assert.rejects(upsertKimiMcp({ name: 'bad', config: { command: 'node', env: { BAD: 1 } } }, options), /kimi_invalid_mcp/)
  await deleteKimiCapability({ id: mcp.id, expectedFingerprint: mcp.fingerprint }, options)
  config = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8'))
  assert.equal(config.mcpServers['user-mcp'], undefined); assert.ok(config.mcpServers.override)

  await symlink(join(home, '.agents', 'skills', 'shared'), join(skills, 'linked'))
  const linked = (await inspectKimiInventory(options)).items.find((item) => item.linked)!
  assert.ok(linked); assert.equal(linked.manageable, false)
  await assert.rejects(deleteKimiCapability({ id: linked.id, expectedFingerprint: linked.fingerprint }, options), /kimi_read_only/)
  const outside = join(fixture, 'outside'); await put(join(outside, 'SKILL.md'), manifest('escaped'))
  await symlink(outside, join(skills, 'escape'))
  assert.equal((await inspectKimiInventory(options)).items.find((item) => item.name === 'escape')?.status, 'invalid')
  await rm(join(kimiHome, 'mcp.json'))
  await symlink(join(fixture, 'project', '.mcp.json'), join(kimiHome, 'mcp.json'))
  await assert.rejects(upsertKimiMcp({ name: 'escape', config: { command: 'no' } }, options), /kimi_unsafe_path/)
  assert.equal(JSON.parse(await readFile(join(fixture, 'project', '.mcp.json'), 'utf8')).mcpServers.escape, undefined)
  await rm(join(kimiHome, 'mcp.json'))
  await put(join(kimiHome, 'mcp.json'), '{broken json')
  await assert.rejects(upsertKimiMcp({ name: 'escape', config: { command: 'no' } }, options), /kimi_invalid_mcp/)
  assert.equal(await readFile(join(kimiHome, 'mcp.json'), 'utf8'), '{broken json')
  const freshOptions = { home, cwd, kimiHome: join(home, 'fresh-kimi'), env: {} }
  const freshMcp = await upsertKimiMcp({ name: 'fresh', config: { command: 'node' } }, freshOptions)
  assert.equal(freshMcp.manageable, true)
  assert.equal((await inspectKimiInventory(freshOptions)).items.some((item) => item.name === 'fresh' && item.kind === 'mcp'), true)
  const envOptions = { home, cwd, env: { KIMI_CODE_HOME: join(home, 'fresh-kimi') } }
  assert.equal((await inspectKimiInventory(envOptions)).items.some((item) => item.id === freshMcp.id), true)
  const swappedOptions = { home, cwd, kimiHome: join(home, 'swapped-kimi'), env: {} }
  await symlink(kimiHome, swappedOptions.kimiHome)
  assert.equal((await inspectKimiInventory(swappedOptions)).writable, false)
  await assert.rejects(createKimiSkill({ name: 'escape-root', manifestText: manifest('escape-root') }, swappedOptions), /kimi_unsafe_path/)
} finally { await rm(fixture, { recursive: true, force: true }) }

console.log('kimi-inventory: native discovery, redaction and user-root mutation boundaries ok')
