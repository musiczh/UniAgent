import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDeepSeekInventoryDetail, projectDeepSeekInventory, resolveDeepSeekPluginEntryId } from '../src/main/deepseekInventory.ts'

// The managed runtime is no longer pinned: resolve the newest installed runtime-<version> dir.
function resolveInstalledDeepSeekRuntime(): string {
  const root = join(homedir(), 'Library/Application Support/UniAgent/deepseek')
  const installed = existsSync(root) ? readdirSync(root).filter((name) => /^runtime-.+/.test(name)) : []
  installed.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
  return join(root, installed[0] || 'runtime-0.2.1-rc.2')
}

const fixture = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-inventory-'))
const home = join(fixture, 'home'), projectRoot = join(fixture, 'project'), cwd = join(projectRoot, 'nested')
const custom = join(fixture, 'custom'), bundled = join(fixture, 'runtime', 'bundled')
const options = { home, cwd, projectRoot, customSkillDirs: [custom], bundledSkillDirs: [bundled] }
const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, text)
}
const manifest = '# Native skill\nUse the actual SDK-discovered instructions.\n'
const raw = (secret = 'INVENTORY_SECRET') => ({
  skills: [{ name: 'review-code', description: 'Review source code', source: 'user-dsh', provider: 'filesystem',
    path: join(home, '.dsh', 'skills', 'review-code', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true } }],
  tools: [{ name: 'read_file', description: 'Read a permitted file', parameters: { type: 'object',
    properties: { path: { type: 'string' }, api_key: { default: secret } }, env: { API_KEY: secret } } }],
  commands: [{ definitionId: 'native-command:compact', name: 'compact', description: 'Compact context', input: { default: secret } }],
  plugins: {
    entries: [{ entryId: 'native-loader:fixture', moduleName: '@deepseek-ai/fixture', enabled: true, fiberPhase: 'active',
      meta: { title: { en: 'Fixture plugin', zh: '测试插件' }, description: 'Native plugin metadata', error: secret,
        icon: `https://user:${secret}@example.test/icon?token=${secret}` }, config: { apiKey: secret }, env: { SECRET: secret } },
    { entryId: 'native-loader:local', moduleName: `${pathToFileURL(join(fixture, 'local-plugin.mjs')).href}?token=${secret}`,
      enabled: false, fiberPhase: null }],
    agentPresets: [{ id: 'native:preset', name: 'Research', isDefault: true,
      rows: [{ entryId: 'native-loader:fixture', moduleName: '@deepseek-ai/fixture', enabled: 'conditional', fiberPhase: 'active',
        condition: secret, meta: { error: secret } }] }]
  }
})

try {
  await mkdir(cwd, { recursive: true })
  await mkdir(join(projectRoot, '.git'))
  await put(raw().skills[0].path, manifest)
  await put(join(dirname(raw().skills[0].path), 'reference.txt'), 'Supporting information')
  await mkdir(join(dirname(raw().skills[0].path), 'scripts'))
  await put(join(dirname(raw().skills[0].path), '.secret'), 'Hidden detail file')
  const first = projectDeepSeekInventory(raw())
  assert.equal(first.agentId, 'deepseek')
  assert.equal(first.available, true)
  assert.equal(first.status, 'available')
  assert.equal(first.writable, false, 'absence of native management signal keeps enumeration read-only')
  assert.equal(first.managementSupported, false)
  assert.deepEqual(first.items.map(item => [item.kind, item.name]).sort(), [
    ['agent-profile', 'Research'], ['command', 'compact'], ['plugin', 'Fixture plugin'],
    ['plugin', 'local-plugin.mjs'], ['skill', 'review-code'], ['tool', 'read_file']
  ].sort())
  assert.equal(first.items.every(item => !item.manageable && !item.copyable), true)
  assert.equal(first.items.every(item => /^deepseek:[a-z-]+:[a-f0-9]{24}$/.test(item.id)), true)
  const allDetails = await Promise.all(first.items.map(item => getDeepSeekInventoryDetail(item.id, raw(), options)))
  for (const sentinel of ['INVENTORY_SECRET', 'apiKey', 'API_KEY', 'Bearer', 'token=', '"condition"', '"icon"', fixture + '/local-plugin']) {
    assert.equal(JSON.stringify({ first, allDetails }).includes(sentinel), false, sentinel)
  }
  assert.equal(projectDeepSeekInventory(raw('ROTATED_SECRET')).revision, first.revision, 'configuration-only changes do not affect public revisions')
  const inputBefore = raw(); const original = JSON.stringify(inputBefore)
  projectDeepSeekInventory(inputBefore)
  assert.equal(JSON.stringify(inputBefore), original, 'projection leaves the private native snapshot unchanged')
  const reordered = raw(); reordered.plugins.entries.reverse()
  assert.equal(projectDeepSeekInventory(reordered).revision, first.revision, 'native enumeration order does not affect public revisions')
  const emptyTools = raw(); emptyTools.tools = []
  assert.equal(projectDeepSeekInventory(emptyTools).items.some(item => item.kind === 'tool'), false, 'role restrictions never resurrect fallback tools')
  const masked = raw(); masked.skills[0].invocation = { modelInvocable: false, userInvocable: false }
  assert.equal(projectDeepSeekInventory(masked).items.some(item => item.kind === 'skill'), false)

  const manageable = raw() as ReturnType<typeof raw> & { plugins: { managementAvailable?: boolean } }
  manageable.plugins.managementAvailable = true
  const managed = projectDeepSeekInventory(manageable)
  assert.equal(managed.writable, true)
  assert.equal(managed.managementSupported, true)
  assert.equal(managed.items.filter(item => item.kind === 'plugin').every(item => item.manageable), true)
  assert.equal(managed.items.filter(item => item.kind !== 'plugin').some(item => item.manageable), false)
  const managedPlugin = managed.items.find(item => item.name === 'Fixture plugin')!
  assert.equal(resolveDeepSeekPluginEntryId(managedPlugin.id, manageable), 'native-loader:fixture')
  assert.equal(resolveDeepSeekPluginEntryId(managedPlugin.id, raw()), undefined)
  assert.equal(resolveDeepSeekPluginEntryId('/tmp/not-a-native-id', manageable), undefined)
  const protectedPlugin = structuredClone(manageable)
  ;(protectedPlugin.plugins.entries[0] as { readOnlyReason?: string }).readOnlyReason = 'management-required'
  assert.equal(projectDeepSeekInventory(protectedPlugin).items.find(item => item.id === managedPlugin.id)?.manageable, false)
  assert.equal(resolveDeepSeekPluginEntryId(managedPlugin.id, protectedPlugin), undefined)
  const protectedOnly = { skills: [], tools: [], commands: [], plugins: { managementAvailable: true, entries: [protectedPlugin.plugins.entries[0]] } }
  const installationAuthority = projectDeepSeekInventory(protectedOnly)
  assert.equal(installationAuthority.writable, false)
  assert.equal(installationAuthority.managementSupported, true, 'install authority exists even when every current item is protected')
  const readonlyPlugin = structuredClone(manageable)
  ;(readonlyPlugin.plugins.entries[0] as { manageable?: boolean }).manageable = false
  assert.equal(projectDeepSeekInventory(readonlyPlugin).items.find(item => item.id === managedPlugin.id)?.manageable, false)
  const failed = raw(); failed.plugins.entries[0].fiberPhase = 'failed'
  const failedInventory = projectDeepSeekInventory(failed)
  assert.equal(failedInventory.items.find(item => item.name === 'Fixture plugin')?.status, 'invalid')
  assert.equal(JSON.stringify(failedInventory).includes('INVENTORY_SECRET'), false)
  const brokenPreset = raw() as ReturnType<typeof raw> & { plugins: { agentPresets: Array<{ broken?: string }> } }
  brokenPreset.plugins.agentPresets[0].broken = 'BROKEN_PRESET_SECRET'
  const brokenInventory = projectDeepSeekInventory(brokenPreset)
  assert.equal(brokenInventory.items.find(item => item.kind === 'agent-profile')?.status, 'invalid')
  assert.equal(JSON.stringify(brokenInventory).includes('BROKEN_PRESET_SECRET'), false)

  for (const malformed of [null, {}, { ...raw(), tools: 'MALFORMED_SECRET' }, { ...raw(), skills: [null] },
    { ...raw(), plugins: { entries: [{ moduleName: 'bad' }] } }, { ...raw(), tools: [{ name: '../secret' }] }]) {
    const inventory = projectDeepSeekInventory(malformed)
    assert.equal(inventory.status, 'invalid')
    assert.equal(inventory.items.length, 0)
    assert.equal(JSON.stringify(inventory).includes('MALFORMED_SECRET'), false)
  }
  const duplicated = raw(); duplicated.tools.push(duplicated.tools[0])
  assert.equal(projectDeepSeekInventory(duplicated).status, 'invalid')
  assert.equal(await getDeepSeekInventoryDetail('/tmp/arbitrary-file', raw(), options), undefined)

  const skill = first.items.find(item => item.kind === 'skill')!
  const detail = await getDeepSeekInventoryDetail(skill.id, raw(), options)
  assert.equal(detail?.manifestText, manifest)
  assert.equal(detail?.manifestFile, 'SKILL.md')
  assert.equal(detail?.openable, true)
  assert.equal(detail?.folderPath, await realpath(dirname(raw().skills[0].path)))
  const canonical = raw(); canonical.skills[0].path = await realpath(canonical.skills[0].path)
  assert.equal((await getDeepSeekInventoryDetail(skill.id, canonical, options))?.openable, true,
    'native SDK canonical paths under macOS /private/var match the trusted /var home')
  assert.deepEqual(detail?.files?.map(file => file.relativePath), ['reference.txt', 'scripts', 'SKILL.md'].sort((a, b) => a.localeCompare(b)))
  for (const [source, path] of [
    ['project-dsh', join(projectRoot, '.dsh', 'skills', 'fixture', 'SKILL.md')],
    ['project-agents', join(projectRoot, '.agents', 'skills', 'fixture', 'SKILL.md')],
    ['user-agents', join(home, '.agents', 'skills', 'fixture', 'SKILL.md')],
    ['custom', join(custom, 'fixture', 'SKILL.md')], ['bundled', join(bundled, 'fixture', 'SKILL.md')]
  ]) {
    await put(path, manifest)
    const state = raw(); state.skills[0].source = source; state.skills[0].path = path
    const entry = projectDeepSeekInventory(state).items.find(item => item.kind === 'skill')!
    assert.equal((await getDeepSeekInventoryDetail(entry.id, state, options))?.manifestText, manifest, source)
  }
  const nestedProject = raw(); nestedProject.skills[0].source = 'project-dsh'
  nestedProject.skills[0].path = join(projectRoot, '.dsh', 'skills', 'fixture', 'SKILL.md')
  assert.equal((await getDeepSeekInventoryDetail(projectDeepSeekInventory(nestedProject).items.find(item => item.kind === 'skill')!.id,
    nestedProject, { home, cwd }))?.manifestText, manifest, 'nearest trusted git project root matches native discovery')

  const outside = join(fixture, 'outside', 'SKILL.md'); await put(outside, 'OUTSIDE_SECRET')
  for (const [source, path] of [
    ['user-dsh', outside], ['project-dsh', raw().skills[0].path], ['runtime', outside],
    ['custom', outside], ['bundled', outside]
  ]) {
    const state = raw(); state.skills[0].source = source; state.skills[0].path = path
    const entry = projectDeepSeekInventory(state).items.find(item => item.kind === 'skill')!
    const safe = await getDeepSeekInventoryDetail(entry.id, state, options)
    assert.equal(safe?.openable, false)
    assert.equal(safe?.manifestText?.includes('OUTSIDE_SECRET') || false, false)
    assert.equal(safe?.folderPath, undefined)
  }
  const injectedRoot = { ...raw(), projectRoot: dirname(outside) }; injectedRoot.skills[0].source = 'project-dsh'; injectedRoot.skills[0].path = outside
  assert.equal((await getDeepSeekInventoryDetail(projectDeepSeekInventory(injectedRoot).items.find(item => item.kind === 'skill')!.id,
    injectedRoot, options))?.openable, false, 'raw discovery metadata cannot expand filesystem trust')
  const virtual = raw(); delete (virtual.skills[0] as { path?: string }).path
  const virtualEntry = projectDeepSeekInventory(virtual).items.find(item => item.kind === 'skill')!
  assert.equal((await getDeepSeekInventoryDetail(virtualEntry.id, virtual, options))?.openable, false)

  await symlink(dirname(outside), join(home, '.dsh', 'skills', 'escaped'))
  const symlinked = raw(); symlinked.skills[0].path = join(home, '.dsh', 'skills', 'escaped', 'SKILL.md')
  assert.equal((await getDeepSeekInventoryDetail(skill.id, symlinked, options))?.openable, false)
  await rm(raw().skills[0].path); await symlink(outside, raw().skills[0].path)
  const escapedFile = await getDeepSeekInventoryDetail(skill.id, raw(), options)
  assert.equal(escapedFile?.openable, false)
  assert.equal(escapedFile?.manifestText?.includes('OUTSIDE_SECRET') || false, false)
  await rm(raw().skills[0].path); await put(raw().skills[0].path, manifest)
  await put(raw().skills[0].path, 'x'.repeat(5 * 1024 * 1024 + 1))
  const oversized = await getDeepSeekInventoryDetail(skill.id, raw(), options)
  assert.equal(oversized?.openable, false)
  assert.equal(oversized?.manifestText, undefined, 'over-limit files are rejected before content reaches the renderer')
  await put(raw().skills[0].path, manifest)
  await symlink(dirname(outside), join(dirname(raw().skills[0].path), 'secret-link'))
  assert.equal((await getDeepSeekInventoryDetail(skill.id, raw(), options))?.files?.some(file => file.relativePath === 'secret-link'), false)
  await rm(join(home, '.dsh', 'skills'), { recursive: true })
  await symlink(dirname(outside), join(home, '.dsh', 'skills'))
  const symlinkRoot = raw(); symlinkRoot.skills[0].path = join(home, '.dsh', 'skills', 'SKILL.md')
  assert.equal((await getDeepSeekInventoryDetail(skill.id, symlinkRoot, options))?.openable, false)
  const untrustedCustom = join(fixture, 'custom-link'); await symlink(dirname(outside), untrustedCustom)
  const linkedCustom = raw(); linkedCustom.skills[0].source = 'custom'; linkedCustom.skills[0].path = join(untrustedCustom, 'SKILL.md')
  const customEntry = projectDeepSeekInventory(linkedCustom).items.find(item => item.kind === 'skill')!
  assert.equal((await getDeepSeekInventoryDetail(customEntry.id, linkedCustom, { ...options, customSkillDirs: [untrustedCustom] }))?.openable, false)
} finally {
  await rm(fixture, { recursive: true, force: true })
}

console.log('deepseek-inventory: role-filtered native inventory, public metadata and trusted detail roots ok')

if (process.env.UNIAGENT_DEEPSEEK_INVENTORY_NATIVE_TEST === '1') {
  const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || resolveInstalledDeepSeekRuntime()
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-inventory-native-'))
  const probeHome = join(directory, 'home'), plugin = join(directory, 'bridge.mjs')
  let child: ChildProcessWithoutNullStreams | undefined
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolveResult, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native inventory probe timed out: ${method}`)) }, 20_000)
    pending.set(id, {
      resolve: value => { clearTimeout(timer); value.error ? reject(new Error('Native inventory RPC failed')) : resolveResult(value.result) },
      reject: error => { clearTimeout(timer); reject(error) }
    })
    child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await mkdir(probeHome)
    await symlink(join(runtime, 'node_modules'), join(directory, 'node_modules'), 'dir')
    await copyFile(resolve('src/main/deepseekBridgePlugin.mjs'), plugin)
    for (const name of ['deepseekControlPlugin.mjs', 'deepseekRolePlugin.mjs']) await copyFile(resolve('src/main', name), join(directory, name))
    await put(join(probeHome, 'skills', 'native-review', 'SKILL.md'), '---\nname: native-review\ndescription: Native inventory fixture\n---\nRead the fixture.\n')
    await writeFile(join(probeHome, 'cordis.patch.yml'), JSON.stringify([
      ...['acp', 'otel', 'session-telemetry-otel', 'hmr'].map(id => ({ id, disabled: true })),
      { insert: [{ id: 'uniagent-bridge', name: pathToFileURL(plugin).href, inject: ['acpAppStartup'],
        config: { provider: 'deepseek-official', model: 'deepseek-flash' } }] }
    ]))
    child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'acp'], {
      cwd: directory, env: { ...process.env, HOME: probeHome, DSH_HOME: probeHome, DSH_AGENTS_HOME: join(probeHome, '.agents'),
        UNIAGENT_USER_DATA: probeHome, XDG_CONFIG_HOME: probeHome, XDG_CACHE_HOME: probeHome, XDG_DATA_HOME: probeHome,
        TMPDIR: directory, DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: '', DSH_BUNDLED_SKILL_DIR: '' }
    })
    child.stderr.resume()
    let buffer = ''
    child.stdout.on('data', data => {
      buffer += data.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let value: any
        try { value = JSON.parse(line) } catch { continue }
        if (value.method === undefined && pending.has(value.id)) {
          const callback = pending.get(value.id)!; pending.delete(value.id); callback.resolve(value)
        }
      }
    })
    child.once('error', () => {
      for (const callback of pending.values()) callback.reject(new Error('Native inventory process could not start'))
      pending.clear()
    })
    child.once('exit', () => {
      for (const callback of pending.values()) callback.reject(new Error('Native inventory process exited'))
      pending.clear()
    })
    await request('initialize', { protocolVersion: 1, clientInfo: { name: 'uniagent-inventory-probe' }, clientCapabilities: {} })
    const session = await request('session/new', { cwd: directory, mcpServers: [] })
    const native = await request('_uniagent/inventory', { sessionId: session.sessionId })
    const inventory = projectDeepSeekInventory(native)
    assert.equal(inventory.status, 'available', 'actual SDK snapshot is accepted without dropping official entries')
    assert.equal(native.plugins.managementAvailable, true, 'native SDK management availability is preserved by the bridge')
    assert.equal(inventory.writable, true)
    const bridgeEntry = native.plugins.entries.find((entry: any) => entry.moduleName === pathToFileURL(plugin).href)
    assert.ok(bridgeEntry)
    assert.equal(bridgeEntry.readOnlyReason, 'management-required')
    assert.equal(inventory.items.find(item => item.name === 'bridge.mjs')?.manageable, false, 'the required bridge cannot be disabled through inventory actions')
    assert.equal(inventory.items.filter(item => item.kind === 'tool').length, native.tools.length)
    assert.equal(inventory.items.filter(item => item.kind === 'plugin').length, native.plugins.entries.length)
    assert.equal(inventory.items.filter(item => item.kind === 'command').length, native.commands.length)
    assert.equal(inventory.items.filter(item => item.kind === 'agent-profile').length, native.plugins.agentPresets?.length || 0)
    const nativeSkill = inventory.items.find(item => item.name === 'native-review' && item.kind === 'skill')!
    assert.ok(nativeSkill)
    assert.equal((await getDeepSeekInventoryDetail(nativeSkill.id, native, { home: probeHome, dshHome: probeHome, cwd: directory }))?.openable, true,
      'actual SDK native skill path is safely browsable')
    const details = await Promise.all(inventory.items.filter(item => item.kind !== 'skill').map(item => getDeepSeekInventoryDetail(item.id, native)))
    assert.equal(JSON.stringify({ inventory, details }).includes(directory), false, 'native Loader URLs do not expose the isolated filesystem root')
    await request('session/close', { sessionId: session.sessionId })
    console.log(`deepseek-inventory: official SDK snapshot accepted (${native.tools.length} tools, ${native.plugins.entries.length} plugins, ${native.commands.length} commands)`)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolveExit => {
        const timer = setTimeout(() => child!.kill('SIGKILL'), 5_000)
        child!.once('exit', () => { clearTimeout(timer); resolveExit() })
        child!.kill('SIGTERM')
      })
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
