import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDeepSeekCapabilityManageRequest } from '../src/shared/capabilitySync.ts'
import { inspectDeepSeekCapabilityInventory, manageDeepSeekCapabilityInventory } from '../src/main/deepseekCapabilityManagement.ts'
import { deepseekSessionRuntimeEnv } from '../src/main/deepseekService.ts'

// The managed runtime is no longer pinned: resolve the newest installed runtime-<version> dir.
function resolveInstalledDeepSeekRuntime(): string {
  const root = join(homedir(), 'Library/Application Support/UniAgent/deepseek')
  const installed = existsSync(root) ? readdirSync(root).filter((name) => /^runtime-.+/.test(name)) : []
  installed.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
  return join(root, installed[0] || 'runtime-0.2.1-rc.2')
}

const invalid = 'invalid_capability_inventory_manage_request'
const fingerprint = 'a'.repeat(64), id = 'deepseek:plugin:' + 'a'.repeat(24)
for (const value of [null, {}, { agentId: 'deepseek', action: 'plugin-install', spec: '../local' },
  { agentId: 'deepseek', action: 'plugin-install', spec: 'https://user:SECRET@example.test/plugin.tgz' },
  { agentId: 'deepseek', action: 'plugin-install', spec: 'github:owner/repo' },
  { agentId: 'deepseek', action: 'plugin-install', spec: '@scope/pkg@1.0.0', registry: 'http://localhost' },
  { agentId: 'deepseek', action: 'plugin-disable', id: '/tmp/plugin', expectedFingerprint: fingerprint },
  { agentId: 'deepseek', action: 'plugin-disable', id },
  { agentId: 'deepseek', action: 'plugin-update', id, spec: 'fixture-bundle@2.0.0' },
  { agentId: 'deepseek', action: 'plugin-update', id, expectedFingerprint: fingerprint, spec: '../local' },
  { agentId: 'deepseek', action: 'plugin-update', id, expectedFingerprint: fingerprint, spec: 'fixture-bundle@latest' },
  { agentId: 'deepseek', action: 'plugin-update', id, expectedFingerprint: fingerprint, spec: 'fixture-bundle@^2.0.0' },
  { agentId: 'deepseek', action: 'plugin-remove', id, expectedFingerprint: fingerprint, bundle: 'expanded' }]) {
  assert.throws(() => parseDeepSeekCapabilityManageRequest(value), new RegExp(invalid))
}
for (const spec of [undefined, 'fixture-bundle@2.0.0', '@scope/plugin@0.2.0-rc.2']) {
  const request = { agentId: 'deepseek', action: 'plugin-update', id, expectedFingerprint: fingerprint, ...(spec === undefined ? {} : { spec }) }
  assert.deepEqual(parseDeepSeekCapabilityManageRequest(request), request)
}
for (const spec of ['fixture-bundle', '@scope/plugin@1.2.3', 'plugin@latest', '@scope/plugin@0.2.0-rc.2']) {
  assert.deepEqual(parseDeepSeekCapabilityManageRequest({ agentId: 'deepseek', action: 'plugin-install', spec }),
    { agentId: 'deepseek', action: 'plugin-install', spec })
}
let getterRead = false
assert.throws(() => parseDeepSeekCapabilityManageRequest({ agentId: 'deepseek', action: 'plugin-install', get spec() { getterRead = true; return 'foo' } }), new RegExp(invalid))
assert.equal(getterRead, false)

let enabled = true, bundleEnabled = true, managementAvailable = true, removed = false, failed = false, removalFailed = false, ignored = false, multiple = false, overwritten = false, protectedRow = false
let starts = 0, closes = 0, bundleVersion = '1.0.0', inspectionInstalled = false, changedSource = false, duplicateBundle = false
let replaceOnUpgrade = false, alterEnablementOnUpgrade = false, unknownBundle = false, duplicateName = false
const calls: Array<{ method: string; params: any; generation: number }> = []
const raw = () => ({ skills: [], tools: [], commands: [], plugins: { managementAvailable, entries: removed || !bundleEnabled ? [] : [{
  entryId: 'native-entry', moduleName: changedSource ? 'other-source' : 'fixture-plugin', enabled, fiberPhase: enabled ? 'active' : null,
  ...(protectedRow ? { readOnlyReason: 'management-required', manageable: false } : {})
}] } })
const nativeList = () => ({ plugins: removed || !bundleEnabled ? [] : [{ entryId: 'native-entry', moduleName: 'fixture-plugin', patchId: 'fixture-row', enabled,
  ...(protectedRow ? { readOnlyReason: 'management-required' } : {}) }], bundles: removed ? [] : [{ name: 'fixture-bundle', installed: true,
  removable: true, enabled: bundleEnabled, version: bundleVersion, rows: [{ rowId: 'fixture-row', moduleName: changedSource ? 'other-source' : 'fixture-plugin', ...(bundleEnabled && !unknownBundle ? { entryId: 'native-entry' } : {}) },
    ...(multiple ? [{ rowId: 'other-row', moduleName: 'other-plugin', entryId: 'other-native' }] : [])], overrides: overwritten ? ['bash'] : [] },
    ...(duplicateBundle ? [{ name: 'other-bundle', installed: true, removable: true, enabled: true, version: '1.0.0', rows: [{ rowId: 'fixture-row', moduleName: 'fixture-plugin', entryId: 'native-entry' }], overrides: [] }] : [])] })
const listResult = () => {
  const list = nativeList()
  if (duplicateName) list.bundles.push({ ...list.bundles[0], rows: [] })
  return list
}
const options = { bin: 'fixture', cwd: process.cwd(), env: { DSH_HOME: '/trusted/profile' }, connectionFactory: () => {
  const generation = ++starts
  return Object.assign(new EventEmitter(), {
    initialize: async () => ({ _meta: { 'uniagent/bridge': { version: 1 } } }),
    request: async (method: string, params: any) => {
      calls.push({ method, params, generation })
      if (method === 'session/new') return { sessionId: 'session-' + generation }
      if (method === 'session/close') return {}
      if (method === '_uniagent/inventory') return raw()
      if (method !== '_uniagent/plugin_action') throw new Error('PRIVATE_DIAGNOSTIC_SECRET')
      if (params.action === 'list') return listResult()
      if (params.action === 'inspect') return inspectionInstalled ? { status: 'refused', problem: 'already-installed' } : { status: 'accepted', kind: 'registry', name: 'fixture-bundle', bundle: true }
      if (failed || (params.action === 'remove' && removalFailed)) return { application: 'failed', error: { code: 'operation-error', diagnostic: 'PRIVATE_DIAGNOSTIC_SECRET' }, packageResult: { output: 'TOKEN_SECRET' } }
      if (ignored) return { application: 'restart-required', changed: true, ...(params.action === 'install' ? { bundle: 'fixture-bundle' } : {}) }
      if (params.action === 'enable') { if (params.target === 'bundle') bundleEnabled = true; else enabled = true }
      if (params.action === 'disable') { if (params.target === 'bundle') bundleEnabled = false; else enabled = false }
      if (params.action === 'install') {
        if (params.options.enabled === false) {
          bundleVersion = params.spec.endsWith('@latest') ? '3.0.0' : params.spec.slice(params.spec.lastIndexOf('@') + 1)
          if (replaceOnUpgrade) changedSource = true
          if (alterEnablementOnUpgrade) enabled = !enabled
        }
        else { removed = false; enabled = bundleEnabled = true }
      }
      if (params.action === 'remove') removed = true
      return { application: 'restart-required', changed: true, ...(params.action === 'install' ? { bundle: 'fixture-bundle' } : {}) }
    },
    close() { closes++; queueMicrotask(() => EventEmitter.prototype.emit.call(this, 'close', { unexpected: false })) }
  })
} }
let current = await inspectDeepSeekCapabilityInventory(options)
const plugin = current.items[0]
assert.ok(plugin.manageable)
managementAvailable = false
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-install', spec: 'fixture-bundle' }, options), /capability_inventory_read_only/)
managementAvailable = true
current = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-disable', id: plugin.id, expectedFingerprint: plugin.fingerprint }, options)
assert.equal(current.items[0].source?.startsWith('disabled'), true)
assert.ok(starts >= 3, 'post-mutation verification uses a fresh native runtime')
assert.equal(starts, closes)
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-enable', id: plugin.id, expectedFingerprint: plugin.fingerprint }, options), /capability_inventory_stale/)
current = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-enable', id: plugin.id, expectedFingerprint: current.items[0].fingerprint }, options)
assert.equal(current.items[0].source?.startsWith('enabled'), true)
assert.equal(current.items[0].version, '1.0.0', 'native bundle versions are projected for edit CAS and UI')
const beforeUpgrade = current.items[0]
inspectionInstalled = true
current = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: beforeUpgrade.id, expectedFingerprint: beforeUpgrade.fingerprint, spec: 'fixture-bundle@2.0.0' }, options)
assert.equal(current.items[0].version, '2.0.0')
assert.notEqual(current.items[0].fingerprint, beforeUpgrade.fingerprint)
const upgradeCall = calls.findLast(call => call.method === '_uniagent/plugin_action' && call.params.action === 'install')!
assert.deepEqual(upgradeCall.params.options, { registry: 'https://registry.npmjs.org/', enabled: false }, 'native upgrade retains bundle selection and entry overrides')
assert.ok(calls.findLast(call => call.method === '_uniagent/inventory')!.generation > upgradeCall.generation)
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: beforeUpgrade.id, expectedFingerprint: beforeUpgrade.fingerprint, spec: 'fixture-bundle@3.0.0' }, options), /capability_inventory_stale/)
enabled = false
current = await inspectDeepSeekCapabilityInventory(options)
current = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: current.items[0].id, expectedFingerprint: current.items[0].fingerprint }, options)
assert.equal(current.items[0].version, '3.0.0')
assert.equal(current.items[0].source?.startsWith('disabled'), true, 'upgrade preserves disabled entry override')
assert.equal(calls.findLast(call => call.method === '_uniagent/plugin_action' && call.params.action === 'install')!.params.spec, 'fixture-bundle@latest', 'omitted spec resolves the selected bundle in main')
const beforeWrongTarget = calls.filter(call => call.params?.action === 'install').length
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: current.items[0].id, expectedFingerprint: current.items[0].fingerprint, spec: 'other-bundle@2.0.0' }, options), /capability_inventory_invalid_config/)
assert.equal(calls.filter(call => call.params?.action === 'install').length, beforeWrongTarget)
const savedFingerprint = current.items[0].fingerprint
bundleVersion = '3.0.1'
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: current.items[0].id, expectedFingerprint: savedFingerprint }, options), /capability_inventory_stale/, 'external native version changes invalidate upgrade CAS')
bundleVersion = '3.0.0'; changedSource = true
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: current.items[0].id, expectedFingerprint: savedFingerprint }, options), /capability_inventory_stale/, 'external source replacement invalidates upgrade CAS')
changedSource = false
for (const issue of ['multiple', 'overwritten', 'protected', 'duplicate', 'unknown', 'duplicate-name']) {
  multiple = issue === 'multiple'; overwritten = issue === 'overwritten'; protectedRow = issue === 'protected'; duplicateBundle = issue === 'duplicate'
  unknownBundle = issue === 'unknown'
  duplicateName = issue === 'duplicate-name'
  const fresh = await inspectDeepSeekCapabilityInventory(options), before = calls.filter(call => call.params?.action === 'install').length
  await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: fresh.items[0].id, expectedFingerprint: fresh.items[0].fingerprint }, options), /capability_inventory_(?:read_only|action_unsupported)/)
  assert.equal(calls.filter(call => call.params?.action === 'install').length, before)
}
multiple = overwritten = protectedRow = duplicateBundle = unknownBundle = duplicateName = false
ignored = true
current = await inspectDeepSeekCapabilityInventory(options)
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: current.items[0].id, expectedFingerprint: current.items[0].fingerprint, spec: 'fixture-bundle@4.0.0' }, options), /capability_inventory_manage_failed/, 'a restart-shaped upgrade must actually load the requested native version')
ignored = false
for (const issue of ['source', 'enabled']) {
  replaceOnUpgrade = issue === 'source'; alterEnablementOnUpgrade = issue === 'enabled'
  current = await inspectDeepSeekCapabilityInventory(options)
  await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: current.items[0].id, expectedFingerprint: current.items[0].fingerprint, spec: 'fixture-bundle@4.0.0' }, options), /capability_inventory_manage_failed/, `fresh boot rejects changed native ${issue}`)
  changedSource = false; enabled = false
}
replaceOnUpgrade = alterEnablementOnUpgrade = false; inspectionInstalled = false; enabled = true
current = await inspectDeepSeekCapabilityInventory(options)
for (const field of ['multiple', 'overwritten', 'protected']) {
  multiple = field === 'multiple'; overwritten = field === 'overwritten'; protectedRow = field === 'protected'
  const fresh = await inspectDeepSeekCapabilityInventory(options)
  const before = calls.filter(call => call.method === '_uniagent/plugin_action' && ['disable', 'remove'].includes(call.params.action)).length
  await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-remove', id: plugin.id, expectedFingerprint: fresh.items[0].fingerprint }, options), /capability_inventory_(?:read_only|action_unsupported)/)
  assert.equal(calls.filter(call => call.method === '_uniagent/plugin_action' && ['disable', 'remove'].includes(call.params.action)).length, before)
}
multiple = overwritten = protectedRow = false
removalFailed = true
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-remove', id: plugin.id,
  expectedFingerprint: current.items[0].fingerprint }, options), /capability_inventory_manage_failed/)
assert.equal(bundleEnabled, true, 'failed native removal restores the selected bundle so the user can retry from inventory')
removalFailed = false
current = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-remove', id: plugin.id, expectedFingerprint: current.items[0].fingerprint }, options)
assert.equal(current.items.length, 0)
const disableBundle = calls.findLast(call => call.method === '_uniagent/plugin_action' && call.params.action === 'disable')!
const removal = calls.findLast(call => call.method === '_uniagent/plugin_action' && call.params.action === 'remove')!
assert.ok(removal.generation > disableBundle.generation, 'active bundle removal runs only after native stop and fresh runtime')
current = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-install', spec: 'fixture-bundle' }, options)
assert.equal(current.items.length, 1)
const install = calls.findLast(call => call.method === '_uniagent/plugin_action' && call.params.action === 'install')!
assert.equal(install.params.options.registry, 'https://registry.npmjs.org/')
failed = true
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-disable', id: current.items[0].id,
  expectedFingerprint: current.items[0].fingerprint }, options), error => error instanceof Error && error.message === 'capability_inventory_manage_failed')
assert.equal(starts, closes)
failed = false; ignored = true
await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-disable', id: current.items[0].id,
  expectedFingerprint: current.items[0].fingerprint }, options), /capability_inventory_manage_failed/,
  'a success-shaped native response is rejected when a new runtime does not apply it')
ignored = false
const parallel = await Promise.allSettled([1, 2].map(() => manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-disable',
  id: current.items[0].id, expectedFingerprint: current.items[0].fingerprint }, options)))
assert.equal(parallel.filter(result => result.status === 'fulfilled').length, 1, 'shared profile mutations serialize before their fingerprint check')
assert.equal(parallel.filter(result => result.status === 'rejected' && result.reason.message === 'capability_inventory_stale').length, 1)
assert.equal(starts, closes)
console.log('deepseek-capability-management: strict requests, CAS, protected and bundle bounds, restart verification and safe errors ok')

if (process.env.UNIAGENT_DEEPSEEK_MANAGEMENT_NATIVE_TEST === '1') {
  const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || resolveInstalledDeepSeekRuntime()
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-management-'))
  const home = join(directory, 'deepseek', 'home'), profile = join(home, 'profiles', 'acp'), bundle = join(directory, 'bundle')
  const priorData = process.env.UNIAGENT_USER_DATA
  const metadata = { name: 'fixture-bundle', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } }
  try {
    await mkdir(profile, { recursive: true }); await mkdir(bundle)
    process.env.UNIAGENT_USER_DATA = directory
    const serviceRuntime = join(directory, 'deepseek', 'runtime-0.2.1-rc.2')
    await mkdir(serviceRuntime, { recursive: true })
    await symlink(join(runtime, 'node_modules'), join(serviceRuntime, 'node_modules'), 'dir')
    await symlink(join(runtime, 'node_modules'), join(directory, 'node_modules'), 'dir')
    for (const name of ['deepseekBridgePlugin.mjs', 'deepseekRolePlugin.mjs', 'deepseekControlPlugin.mjs']) await copyFile(resolve('src/main', name), join(directory, name))
    await writeFile(join(bundle, 'package.json'), JSON.stringify(metadata))
    await writeFile(join(bundle, 'plugin.mjs'), 'export function apply() {}\n')
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'fixture-row', name: './plugin.mjs' }] }]))
    const packageManager = join(directory, 'pnpm-fixture.cjs')
    const registryVersion = join(directory, 'registry-version.txt')
    await writeFile(registryVersion, '1.0.0')
    // The real native manager owns validation, profile changes and bundle lifecycle; only registry/package I/O is isolated.
    await writeFile(packageManager, `#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),available=fs.readFileSync(${JSON.stringify(registryVersion)},'utf8').trim(),base=${JSON.stringify(metadata)},spec=args[1]||'',at=spec.indexOf('@',1),range=at<0?undefined:spec.slice(at+1),version=range&&range!=='latest'?range:available,metadata={...base,version};if(args[0]==='config'){console.log('https://registry.npmjs.org/');process.exit(0)}if(args[0]==='view'){console.log(JSON.stringify(metadata));process.exit(0)}const file=path.join(process.cwd(),'package.json'),manifest=JSON.parse(fs.readFileSync(file));if(args[0]==='add'){manifest.dependencies={...manifest.dependencies,'fixture-bundle':version};const target=path.join(process.cwd(),'node_modules','fixture-bundle');fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(${JSON.stringify(bundle)},target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(metadata));}if(args[0]==='remove'){delete manifest.dependencies[args[1]];fs.rmSync(path.join(process.cwd(),'node_modules',args[1]),{recursive:true,force:true})}fs.writeFileSync(file,JSON.stringify(manifest));fs.writeFileSync(path.join(process.cwd(),'pnpm-lock.yaml'),'fixture lock');console.log('package fixture completed');\n`)
    await chmod(packageManager, 0o755)
    const patch = [
      ...['acp', 'hmr', 'otel', 'session-telemetry-otel'].map(id => ({ id, disabled: true })),
      { id: 'plugin-manager', config: { pnpmCommand: packageManager, inspectTimeoutMs: 1000, lockWaitMs: 1000, idleTimeoutMs: 1000, fallbackRegistries: [] } },
      { insert: [{ id: 'uniagent-bridge', name: pathToFileURL(join(directory, 'deepseekBridgePlugin.mjs')).href, inject: ['acpAppStartup'],
        config: { provider: 'deepseek-official', model: 'deepseek-flash' } }] }
    ]
    await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify(patch))
    const shell = join(directory, 'dsh')
    await writeFile(shell, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))} "$@"\n`)
    await chmod(shell, 0o755)
    const nativeOptions = { bin: shell, cwd: directory, env: { ...process.env, HOME: home, DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, '.agents'), UNIAGENT_USER_DATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
      XDG_DATA_HOME: home, TMPDIR: directory, DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: '' } }
    let inventory = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-install', spec: 'fixture-bundle' }, nativeOptions)
    let sessionNumber = 0
    async function sessionInventory() {
      const env = deepseekSessionRuntimeEnv(`native-session-${++sessionNumber}`, { agentId: 'deepseek', workdir: directory, permissionMode: 'ask' })
      return inspectDeepSeekCapabilityInventory({ ...nativeOptions, env: { ...nativeOptions.env, ...env } })
    }
    let item = inventory.items.find(item => item.name === 'plugin.mjs')!
    assert.ok(item?.manageable, 'official installed bundle is native-manageable after fresh boot')
    assert.equal(item.version, '1.0.0')
    const oldItem = item
    await writeFile(registryVersion, '2.0.0')
    await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-install', spec: 'fixture-bundle@2.0.0' }, nativeOptions), /capability_inventory_already_exists/, 'the install preflight still rejects existing dependencies')
    inventory = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: item.id, expectedFingerprint: item.fingerprint, spec: 'fixture-bundle@2.0.0' }, nativeOptions)
    item = inventory.items.find(candidate => candidate.id === item.id)!
    assert.equal(item.version, '2.0.0', 'fresh Harness listBundles reads the upgraded on-disk package version')
    assert.ok(item.source?.startsWith('enabled'), 'upgrade keeps the native entry active')
    assert.notEqual(item.fingerprint, oldItem.fingerprint)
    await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: oldItem.id, expectedFingerprint: oldItem.fingerprint }, nativeOptions), /capability_inventory_stale/)
    assert.equal(JSON.parse(await readFile(join(profile, 'node_modules', 'fixture-bundle', 'package.json'), 'utf8')).version, '2.0.0')
    let sessionState = await sessionInventory()
    assert.equal(sessionState.items.find(item => item.name === 'plugin.mjs')?.source?.startsWith('enabled'), true,
      'new isolated session loads the globally installed native bundle')
    assert.equal(sessionState.items.some(item => item.manageable), false, 'session profile cannot independently edit the global plugin catalog')
    inventory = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-disable', id: item.id, expectedFingerprint: item.fingerprint }, nativeOptions)
    item = inventory.items.find(candidate => candidate.id === item.id)!
    assert.ok(item.source?.startsWith('disabled'))
    assert.equal((await sessionInventory()).items.find(item => item.name === 'plugin.mjs')?.source?.startsWith('disabled'), true)
    const savedProfile = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile
    const savedOverlay = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    await writeFile(registryVersion, '3.0.0')
    inventory = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-update', id: item.id, expectedFingerprint: item.fingerprint }, nativeOptions)
    item = inventory.items.find(candidate => candidate.id === item.id)!
    assert.equal(item.version, '3.0.0')
    assert.ok(item.source?.startsWith('disabled'), 'actual native upgrade preserves the disabled entry override')
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile, savedProfile, 'native upgrade preserves bundle ordering and selection')
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), savedOverlay, 'native upgrade preserves all profile overrides')
    assert.equal((await sessionInventory()).items.find(item => item.name === 'plugin.mjs')?.source?.startsWith('disabled'), true)
    inventory = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-enable', id: item.id, expectedFingerprint: item.fingerprint }, nativeOptions)
    item = inventory.items.find(candidate => candidate.id === item.id)!
    assert.ok(item.source?.startsWith('enabled'))
    assert.equal((await sessionInventory()).items.find(item => item.name === 'plugin.mjs')?.source?.startsWith('enabled'), true)
    const bridgeItem = inventory.items.find(candidate => candidate.name === 'deepseekBridgePlugin.mjs')!
    await assert.rejects(manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-disable', id: bridgeItem.id, expectedFingerprint: bridgeItem.fingerprint }, nativeOptions), /capability_inventory_read_only/)
    inventory = await manageDeepSeekCapabilityInventory({ agentId: 'deepseek', action: 'plugin-remove', id: item.id, expectedFingerprint: item.fingerprint }, nativeOptions)
    assert.equal(inventory.items.some(candidate => candidate.name === 'plugin.mjs'), false)
    assert.equal((await sessionInventory()).items.some(candidate => candidate.name === 'plugin.mjs'), false)
    assert.equal(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies?.['fixture-bundle'], undefined)
    assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), JSON.stringify(patch), 'native profile mutations preserve UniAgent required home overlay')
    console.log('deepseek-capability-management: actual Harness install/upgrade/disable/enable/remove with native versions, preserved overrides, restart application and protected bridge passed')
  } finally {
    if (priorData === undefined) delete process.env.UNIAGENT_USER_DATA
    else process.env.UNIAGENT_USER_DATA = priorData
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
