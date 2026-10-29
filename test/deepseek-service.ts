import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire, Module } from 'node:module'
import { deepseekRuntimeEnv, deepseekSnapshot, installDeepSeek } from '../src/main/deepseekService.ts'
import * as service from '../src/main/deepseekService.ts'
import { deepseekBaseUrl } from '../src/shared/deepseek.ts'

const directory = await mkdtemp(join(tmpdir(), 'ua-dsh-service-'))
const priorData = process.env.UNIAGENT_USER_DATA
const priorPath = process.env.PATH
try {
  process.env.UNIAGENT_USER_DATA = directory
  assert.equal(deepseekBaseUrl(' https://api.deepseek.com/v1/ '), 'https://api.deepseek.com/anthropic')
  for (const url of ['file:///tmp/key', 'https://user:password@api.deepseek.com', 'https://api.deepseek.com?token=key']) assert.throws(() => deepseekBaseUrl(url))
  const snapshot = deepseekSnapshot()
  assert.equal(snapshot.hasKey, false)
  assert.equal(snapshot.source, 'none')
  assert.equal('apiKey' in snapshot, false)
  assert.deepEqual(service.deepseekAccountModels({ groups: [
    { id: 'deepseek-official', models: [{ id: 'api-only', name: 'API only' }] },
    { id: 'deepseek-account', models: [{ id: 'deepseek-v4-flash', name: 'Flash', reasoning: { efforts: [{ id: 'high' }, { id: 'future' }], defaultEffort: 'high' } }] }
  ] }), [{ id: '["deepseek-account","deepseek-v4-flash"]', label: 'Flash · DeepSeek 账户', efforts: ['high'], defaultEffort: 'high' }])
  assert.deepEqual(service.deepseekAccountModels({ groups: [] }), [], 'missing account routes are not invented from API-key defaults')
  await assert.rejects(service.checkDeepSeekConnection({ baseUrl: snapshot.baseUrl }), /先安装/)
  const env = deepseekRuntimeEnv(join(directory,'home'))
  assert.equal(env.DEEPSEEK_API_KEY, '')
  assert.equal(env.DSH_TELEMETRY_MODE, 'DISABLED')
  assert.deepEqual(JSON.parse(await readFile(join(env.DSH_HOME!, 'cordis.patch.yml'), 'utf8')), [])
  const role = { id:'role-a', name:'Role A', agentId:'deepseek', permissionMode:'ask' as const }
  const config = { agentId:'deepseek', workdir:directory, permissionMode:'ask' as const, roleSnapshot:role }
  const shared = join(directory, 'deepseek/home')
  await mkdir(join(shared, 'sessions'), { recursive:true })
  await writeFile(join(shared, 'sessions/history.jsonl'), 'existing native history')
  const custom = { insert:[{ id:'user-native-plugin', name:'user-plugin' }] }
  const previous = JSON.stringify([
    { id:'acp', disabled:true, config:{ model:'deepseek-flash' } },
    { id:'sandbox-policy', config:{ mode:'danger-full-access' } },
    { insert:[{ id:'uniagent-bridge', name:'file:///old/bridge.mjs' }, ...custom.insert] },
    { id:'user-setting', config:{ enabled:true } }
  ])
  await writeFile(join(shared, 'cordis.patch.yml'), previous)
  const first = service.deepseekSessionRuntimeEnv('session/a', config)
  const second = service.deepseekSessionRuntimeEnv('session/b', config)
  assert.equal(first.DSH_HOME, shared)
  assert.equal(second.DSH_HOME, shared, 'stable profile uses native shared history')
  const { load } = await import('js-yaml')
  assert.deepEqual(load(await readFile(join(shared, 'cordis.patch.yml'), 'utf8')), [custom, { id:'user-setting', config:{ enabled:true } }])
  assert.equal(await readFile(join(shared, 'cordis.patch.yml.uniagent-before-stable-acp'), 'utf8'), previous)
  assert.equal(await readFile(join(shared, 'sessions/history.jsonl'), 'utf8'), 'existing native history')
  const before = await readFile(join(shared, 'cordis.patch.yml'), 'utf8')
  service.deepseekSessionRuntimeEnv('session/a', config)
  assert.equal(await readFile(join(shared, 'cordis.patch.yml'), 'utf8'), before, 'migration is idempotent')
  await writeFile(join(shared, 'cordis.patch.yml'), JSON.stringify([custom]))
  const changed = service.deepseekSessionRuntimeEnv('session/a', config)
  assert.notEqual(changed.UNIAGENT_DEEPSEEK_CONFIG_HASH, first.UNIAGENT_DEEPSEEK_CONFIG_HASH)
  assert.equal(await readFile(join(shared, 'cordis.patch.yml'), 'utf8'), JSON.stringify([custom]), 'native-only patches are left byte-for-byte unchanged')
  assert.throws(() => service.deepseekSessionRuntimeEnv('restricted', { ...config, roleSnapshot:{ ...role, instructions:'system rule' } }), /稳定 ACP/)
  assert.throws(() => service.deepseekSessionRuntimeEnv('restricted', { ...config, permissionMode:'read-only' }), /权限/)
  const runtime = join(directory, 'deepseek/runtime-0.2.1-rc.2')
  const stale = join(directory, 'deepseek/runtime-0.0.1')
  const commands = join(directory, 'commands')
  await mkdir(join(runtime,'node_modules/.bin'), { recursive:true })
  await writeFile(join(runtime,'node_modules/.bin/dsh'), 'broken runtime')
  await mkdir(join(stale,'node_modules/.bin'), { recursive:true })
  await writeFile(join(stale,'node_modules/.bin/dsh'), 'stale runtime')
  await mkdir(commands)
  const entry = `#!/usr/bin/env node\nif (process.argv.includes('web')) require(${JSON.stringify(resolve('test/fixtures/fake-deepseek-host.cjs'))}); else require("../../fixture.cjs")\n`
  await writeFile(join(commands,'npm'), `#!/usr/bin/env node\nconst fs = require('node:fs'), path = require('node:path')\nif (process.argv.includes('--version')) { process.stdout.write('11.19.1\\n'); process.exit(0) }\nconst target = process.argv[process.argv.indexOf('--prefix') + 1]\nfs.mkdirSync(path.join(target,'node_modules/.bin'), { recursive:true })\nfs.mkdirSync(path.join(target,'node_modules/@deepseek-ai/dsh'), { recursive:true })\nfs.writeFileSync(path.join(target,'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version:process.env.FAKE_NPM_VERSION || '0.2.1-rc.2' }))\nfs.copyFileSync(${JSON.stringify(resolve('test/fixtures/fake-deepseek.cjs'))}, path.join(target,'fixture.cjs'))\nfs.writeFileSync(path.join(target,'node_modules/.bin/dsh'), ${JSON.stringify(entry)}, { mode:0o755 })\nif (process.env.FAKE_NPM_FAIL) process.exit(1)\n`)
  await chmod(join(commands,'npm'), 0o755)
  process.env.PATH = commands + ':' + priorPath
  const phases: string[] = []
  let cancelDuringVerification = false
  service.configureDeepSeekOnboarding({
    openBrowser: async () => {}, authenticated: () => {},
    metadata: () => ({ version: 'test', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }),
    changed: () => {
      const phase = service.deepseekSnapshot().installation!.phase
      phases.push(phase)
      if (cancelDuringVerification && phase === 'verifying') service.cancelDeepSeekInstall()
    }
  })
  await mkdir(join(runtime, 'node_modules/@deepseek-ai/dsh'), { recursive: true })
  await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.2.0-rc.2' }))
  const agent = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek' as const, bin: '', icon: '', builtin: true,
    models: [], capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] } }
  assert.equal((await service.readDeepSeekConnection()).version, '0.2.0-rc.2', 'an incompatible Host must not block opening its repair settings')
  const incompatible = await service.detectDeepSeek(agent)
  assert.equal(incompatible.version, '0.2.0-rc.2', 'failed detection preserves the installed version for update comparison')
  assert.match(incompatible.unavailableReason!, /0\.2\.1-rc\.2/)
  process.env.FAKE_NPM_FAIL = '1'
  await assert.rejects(installDeepSeek())
  assert.equal(await readFile(join(runtime,'node_modules/.bin/dsh'),'utf8'), 'broken runtime')
  assert.equal(await readFile(join(stale,'node_modules/.bin/dsh'),'utf8'), 'stale runtime', 'failed install keeps other runtimes')
  assert.equal((await readdir(join(directory,'deepseek'))).some(name => name.startsWith('.install-')), false)
  delete process.env.FAKE_NPM_FAIL
  const installedSnapshot = await installDeepSeek()
  assert.equal(installedSnapshot.installed, true)
  assert.equal(installedSnapshot.version, '0.2.1-rc.2', 'snapshot reports the installed registry version')
  assert.equal(await readFile(join(runtime,'node_modules/.bin/dsh'),'utf8'), 'broken runtime', 'installation never overwrites a potentially running bundle')
  assert.equal((await readdir(join(directory,'deepseek'))).includes('runtime-0.0.1'), true, 'installation preserves prior runtimes')
  const pointerFile = join(directory, 'deepseek/active-runtime.json')
  const active = JSON.parse(await readFile(pointerFile, 'utf8'))
  assert.equal(active.schemaVersion, 1)
  assert.match(active.directory, /^installed-/)
  assert.notEqual(await readFile(join(directory, 'deepseek', active.directory, 'node_modules/.bin/dsh'), 'utf8'), 'broken runtime')
  assert.ok(['preparing', 'downloading', 'verifying', 'activating', 'completed'].every(phase => phases.includes(phase)), 'progress reflects actual installation stages')
  const failureMarker = join(shared, 'fixture-host-failure')
  await writeFile(failureMarker, 'exit')
  await assert.rejects(installDeepSeek(), /startup-exited/)
  assert.deepEqual(JSON.parse(await readFile(pointerFile, 'utf8')), active, 'failed activation restores the previous runtime selection')
  assert.equal(service.deepseekSnapshot().installation?.phase, 'failed')
  assert.equal((await service.readDeepSeekConnection()).installed, true, 'broken Host startup still leaves repair settings accessible')
  await rm(failureMarker)
  cancelDuringVerification = true
  const cancelled = installDeepSeek()
  assert.equal(installDeepSeek(), cancelled, 'multiple callers share the same install transaction')
  assert.equal(service.isDeepSeekMaintenance(), true)
  await assert.rejects(service.checkDeepSeekConnection({ baseUrl: snapshot.baseUrl }), /正在安装或更新/)
  assert.throws(() => service.saveDeepSeekConnection({ baseUrl: snapshot.baseUrl }), /正在安装或更新/)
  await assert.rejects(cancelled, /已取消安装/)
  assert.equal(service.isDeepSeekMaintenance(), false)
  assert.equal(service.deepseekSnapshot().installation?.phase, 'cancelled')
  assert.deepEqual(JSON.parse(await readFile(pointerFile, 'utf8')), active, 'cancel before activation retains the old active version')
  cancelDuringVerification = false
  await mkdir(join(directory, 'deepseek/runtime-99.0.0/node_modules/@deepseek-ai/dsh'), { recursive: true })
  await mkdir(join(directory, 'deepseek/runtime-99.0.0/node_modules/.bin'), { recursive: true })
  await writeFile(join(directory, 'deepseek/runtime-99.0.0/node_modules/.bin/dsh'), 'unqualified')
  await writeFile(join(directory, 'deepseek/runtime-99.0.0/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '99.0.0' }))
  assert.equal(deepseekSnapshot().version, '0.2.1-rc.2', 'a newer directory cannot change the active version')
  process.env.FAKE_NPM_VERSION = '99.0.0'
  await assert.rejects(installDeepSeek('99.0.0'), /尚未通过 Host 接入验证/)
  // The previous pin is no longer installable: only the qualified release is.
  process.env.FAKE_NPM_VERSION = '0.2.0-rc.2'
  await assert.rejects(installDeepSeek('0.2.0-rc.2'), /尚未通过 Host 接入验证/)
  const refusedUpdate = await service.updateDeepSeekRuntime('0.2.0-rc.2')
  assert.equal(refusedUpdate.code, 1, 'a checked version that is not the qualified release is refused before install')
  assert.match(refusedUpdate.stderr, /0\.2\.0-rc\.2 尚未通过 Host 接入验证/)
  delete process.env.FAKE_NPM_VERSION
  assert.deepEqual(JSON.parse(await readFile(pointerFile, 'utf8')), active, 'failed qualification preserves the activation record')
  assert.equal((await readdir(join(directory,'deepseek'))).some(name => name.startsWith('.install-')), false)
  const qualifiedUpdate = await service.updateDeepSeekRuntime()
  assert.equal(qualifiedUpdate.code, 0, 'a bare update installs the qualified release')
  assert.equal(deepseekSnapshot().version, '0.2.1-rc.2')
  assert.notEqual(JSON.parse(await readFile(pointerFile, 'utf8')).directory, active.directory, 'a qualified update activates the new runtime')
  assert.equal(typeof service.checkDeepSeekConnection, 'function', 'connection checks must verify the model before saving credentials')
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  const previousElectron = require.cache[electronPath]
  const electron = new Module(electronPath)
  electron.exports = { get safeStorage() { throw new Error('API Key must never access the OS keychain') } }
  require.cache[electronPath] = electron
  let status = 200
  let payload: unknown = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
  let release: (() => void) | undefined
  let received: (() => void) | undefined
  const requests: { url: string; key: string | undefined; body: any }[] = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    requests.push({ url: request.url!, key: request.headers['x-api-key'] as string | undefined, body: JSON.parse(text) })
    received?.()
    if (received) await new Promise<void>(done => { release = done })
    response.writeHead(status, { 'Content-Type': 'application/json', ...(status === 302 ? { Location: '/redirect' } : {}) })
    response.end(JSON.stringify(payload))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic`
  const file = join(directory, 'deepseek/connection.json')
  try {
    const existing = { baseUrl, apiKey: 'fixture-existing-key' }
    await writeFile(file, JSON.stringify({ baseUrl, encryptedKey: Buffer.from('legacy-keychain-fixture').toString('base64'), verifiedConnection: 'old' }))
    assert.equal(service.deepseekSnapshot().hasKey, true, 'legacy keys stay configured while awaiting migration')
    assert.equal(service.deepseekSnapshot().baseUrl, baseUrl)
    service.saveDeepSeekConnection({ baseUrl })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).encryptedKey, Buffer.from('legacy-keychain-fixture').toString('base64'), 'blank saves preserve pending legacy credentials')
    service.saveDeepSeekConnection(existing)
    for (const invalid of [null, { baseUrl: 123 }, { baseUrl, apiKey: 123 }]) await assert.rejects(service.checkDeepSeekConnection(invalid as any), /参数/)
    await assert.rejects(service.checkDeepSeekConnection({ baseUrl: 'file:///tmp/key' }), /服务地址/)
    assert.equal(requests.length, 0, 'invalid input never makes a model request')
    assert.equal(service.deepseekSnapshot().verified, false, 'a saved key alone never proves connectivity')
    const checked = await service.checkDeepSeekConnection({ baseUrl })
    assert.equal(checked.verified, true)
    assert.equal(checked.source, 'harness', 'only explicitly configured credentials are used')
    assert.equal(service.deepseekSnapshot().verified, true, 'successful checks survive a new snapshot')
    const savedConnection = await readFile(file, 'utf8')
    await installDeepSeek()
    assert.equal(await readFile(file, 'utf8'), savedConnection, 'runtime updates preserve the saved login and verification')
    assert.equal(await readFile(join(shared, 'sessions/history.jsonl'), 'utf8'), 'existing native history')
    const recovered = await service.detectDeepSeek({ ...incompatible, authenticationRequired: true })
    assert.equal(recovered.incompatible, false, 're-detection clears the previous incompatible flag')
    assert.equal(recovered.authenticationRequired, false)
    assert.equal(recovered.models.length, 1, 'the updated Host supplies a fresh model catalog')
    const workingRuntime = await readFile(pointerFile, 'utf8')
    await writeFile(failureMarker, 'empty-catalog')
    await assert.rejects(installDeepSeek(), /未提供可用模型/)
    assert.equal(await readFile(pointerFile, 'utf8'), workingRuntime, 'an empty authenticated catalog cannot replace the working runtime')
    assert.equal(await readFile(file, 'utf8'), savedConnection)
    await rm(failureMarker)
    assert.equal(requests.at(-1)?.url, '/anthropic/v1/messages')
    assert.equal(requests.at(-1)?.key, 'fixture-existing-key')
    assert.equal(requests.at(-1)?.body.model, 'deepseek-flash')
    assert.equal(requests.at(-1)?.body.thinking.type, 'disabled')
    assert.equal(requests.at(-1)?.body.stream, false)
    assert.ok(requests.at(-1)?.body.max_tokens <= 32, 'checks use a bounded minimal model request')
    service.saveDeepSeekConnection({ ...existing, apiKey: 'fixture-changed-source-key' })
    assert.equal(service.deepseekSnapshot().verified, false, 'changing imported credentials invalidates the previous check')
    service.saveDeepSeekConnection(existing)
    await service.checkDeepSeekConnection({ baseUrl })
    const before = await readFile(file, 'utf8')
    for (const [code, expected] of [[401, /API Key/], [403, /权限/], [402, /余额|额度/], [429, /频繁/], [500, /服务/]] as const) {
      status = code
      payload = { error: { message: 'fixture-rejected-key must never appear in diagnostics' } }
      await assert.rejects(service.checkDeepSeekConnection({ baseUrl, apiKey: 'fixture-rejected-key' }), (error: Error) => {
        assert.match(error.message, expected)
        assert.equal(error.message.includes('fixture-rejected-key'), false, 'upstream error bodies never leak credentials')
        return true
      })
      assert.equal(await readFile(file, 'utf8'), before, 'failed checks leave the saved connection unchanged')
    }
    status = 200
    for (const malformed of [{}, { type: 'message', role: 'assistant', content: [] }, { type: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] }]) {
      payload = malformed
      await assert.rejects(service.checkDeepSeekConnection({ baseUrl }), /响应/)
      assert.equal(await readFile(file, 'utf8'), before)
    }
    status = 302
    const requestCount = requests.length
    await assert.rejects(service.checkDeepSeekConnection({ baseUrl }), /连接/)
    assert.equal(requests.length, requestCount + 1, 'redirects cannot forward the API key')
    status = 200
    payload = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
    const localKeyFile = join(directory, 'credentials/key')
    const localKey = await readFile(localKeyFile)
    await writeFile(localKeyFile, 'corrupt-fixture')
    assert.equal(service.deepseekSnapshot().hasKey, false, 'unreadable credentials do not block settings')
    await assert.rejects(service.checkDeepSeekConnection({ baseUrl, apiKey: 'fixture-replacement-key' }), /本地加密密钥/)
    assert.equal(await readFile(file, 'utf8'), before, 'encryption failures preserve the saved connection')
    await writeFile(localKeyFile, localKey)
    const replacement = await service.checkDeepSeekConnection({ baseUrl, apiKey: ' fixture-replacement-key ' })
    assert.equal(replacement.verified, true)
    assert.equal(replacement.source, 'harness')
    assert.equal(JSON.stringify(replacement).includes('fixture-replacement-key'), false)
    assert.equal((await readFile(file, 'utf8')).includes('fixture-replacement-key'), false)
    const saved = await readFile(file, 'utf8')
    let markReceived!: () => void
    const requestReceived = new Promise<void>(done => { markReceived = done })
    received = markReceived
    const pending = service.checkDeepSeekConnection({ baseUrl })
    await requestReceived
    await assert.rejects(service.checkDeepSeekConnection({ baseUrl, apiKey: 'another-fixture-key' }), /正在检查/)
    service.saveDeepSeekConnection({ baseUrl: baseUrl.replace('127.0.0.1', 'localhost') })
    release!()
    await assert.rejects(pending, /配置已变化/)
    received = undefined
    await writeFile(file, saved)
    await new Promise<void>(done => server.close(() => done()))
    await assert.rejects(service.checkDeepSeekConnection({ baseUrl }), /连接/)
    assert.equal(await readFile(file, 'utf8'), saved, 'network failures do not overwrite working credentials')
    const previousFetch = globalThis.fetch
    try {
      for (const headersReceived of [false, true]) {
        const timeout = () => { throw new DOMException('fixture-private-detail', 'TimeoutError') }
        globalThis.fetch = headersReceived ? async () => ({ ok: true, json: async () => timeout() } as any) : async () => timeout()
        await assert.rejects(service.checkDeepSeekConnection({ baseUrl }), /连接检查超时/)
        assert.equal(await readFile(file, 'utf8'), saved, 'header and body timeouts preserve the working configuration')
      }
    } finally { globalThis.fetch = previousFetch }
    await rm(file)
    const previousKey = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'inherited-key-must-not-be-used'
    try { await assert.rejects(service.checkDeepSeekConnection({ baseUrl }), /API Key/) }
    finally { if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey; else delete process.env.DEEPSEEK_API_KEY }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    if (previousElectron) require.cache[electronPath] = previousElectron
    else delete require.cache[electronPath]
  }
} finally {
  await service.closeDeepSeekHost()
  if (priorData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = priorData
  process.env.PATH = priorPath
  delete process.env.FAKE_NPM_FAIL
  await rm(directory, { recursive:true, force:true })
}
console.log('deepseek-service: model checks, credential protection, endpoint validation, stable migration and atomic installation passed')
