import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectZCodeEngine, discoverExternalZCodeRuntime, importPreparedZCodeRuntime, loadZCodeRuntimeConfig } from '../src/main/zcode/runtime'
import { ZCodeInstallationService } from '../src/main/zcode/installation'
import { verifyZCodeEngine } from '../src/main/zcode/build'
const root = await realpath(await mkdtemp(join(tmpdir(), 'ua-zcode-discover-')))
const names = ['HOME', 'PATH', 'UNIAGENT_USER_DATA', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']
const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
const bin = join(root, 'bin'), dist = join(root, 'dist')
await mkdir(bin); await mkdir(join(dist, 'provider'), { recursive: true }); await mkdir(join(root, 'home'))
const bundle = join(dist, 'zcode.cjs')
const fixture = `if(process.argv.includes('--version')) console.log('0.16.9');
else if(process.argv.includes('--help')) console.log('app-server --stdio');
else {const send=x=>console.log(JSON.stringify(x));send({method:'startup/storageState',params:{phase:'ready'}});
require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);send({id:q.id,result:q.method==='session/list'?{sessions:[]}:{independentPlanState:false}})})}`
await writeFile(bundle, fixture, { mode: 0o700 })
await writeFile(join(dist, 'provider/zcode-builtin.json'), '{"schemaVersion":1,"config":{}}')
await symlink(process.execPath, join(bin, 'node')); await symlink(bundle, join(bin, 'zcode'))
Object.assign(process.env, { HOME: join(root, 'home'), PATH: bin, UNIAGENT_USER_DATA: join(root, 'data') })
delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
try {
  const found = await discoverExternalZCodeRuntime(process.env, [])
  assert.equal(found?.source, 'cli'); assert.equal(found?.bundlePath, bundle)
  assert.equal(found?.resourceRoot, dist)
  assert.equal(found?.personalProviderConfigPath, undefined)
  const [first, again] = await Promise.all([importPreparedZCodeRuntime(), importPreparedZCodeRuntime()])
  assert.equal(first?.dataRootId, again?.dataRootId, 'registered external identity stays stable across detection')
  assert.equal((await loadZCodeRuntimeConfig())?.source, 'cli')
  assert.equal(await readFile(bundle, 'utf8'), fixture, 'discovery does not patch the native executable')
  const selection = new ZCodeInstallationService()
  assert.equal((await selection.select(join(bin, 'zcode'), async () => {})).phase, 'completed')
  const selected = await loadZCodeRuntimeConfig()
  assert.equal((await selection.select(join(root, 'missing'), async () => {})).phase, 'failed')
  assert.deepEqual(await loadZCodeRuntimeConfig(), selected, 'failed selection keeps the active runtime identity')
  await rm(join(dist, 'provider/zcode-builtin.json'))
  let builds = 0
  const repair = new ZCodeInstallationService({ build: async () => { builds++; throw new Error('must not build') },
    detect: detectZCodeEngine, verify: verifyZCodeEngine, save: async () => {} })
  assert.equal((await repair.install(async () => {})).phase, 'failed')
  assert.equal(builds, 0, 'a broken external program is never silently replaced by a private source build')
  assert.deepEqual(await loadZCodeRuntimeConfig(), selected)
  const app = join(root, 'ZCode.app'), resources = join(app, 'Contents/Resources')
  await mkdir(join(resources, 'glm'), { recursive: true }); await mkdir(join(resources, 'config/provider'), { recursive: true })
  await writeFile(join(resources, 'glm/zcode.cjs'), fixture)
  await writeFile(join(resources, 'config/provider/zcode-builtin.json'), '{"schemaVersion":1,"config":{}}')
  await rm(join(bin, 'zcode'))
  const official = await discoverExternalZCodeRuntime(process.env, [app])
  assert.equal(official?.source, 'official-app'); assert.equal(official?.sourceAppPath, app)
  await rm(join(resources, 'config/provider/zcode-builtin.json'))
  await assert.rejects(discoverExternalZCodeRuntime(process.env, [app]), /完整资源|协议/, 'an incomplete app is not permission to build a second runtime')
  console.log('ZCode external discovery: complete CLI/App reuse, optional plan capability, stable identity, unchanged native files and incomplete-resource rejection passed')
} finally {
  for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name] }
  await rm(root, { recursive: true, force: true })
}
