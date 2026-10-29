import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire, Module } from 'node:module'
import { createHash } from 'node:crypto'
import { decryptLocalSecret, encryptLocalSecret, isLocalSecret } from '../src/main/localSecretStore'
import { runLegacySecretMigrationWorker, SECRET_MIGRATION_ARG } from '../src/main/legacySecretMigration'
import { deepseekSnapshot, readDeepSeekConnection, saveDeepSeekConnection } from '../src/main/deepseekService'
import { CodexSourceService } from '../src/main/codexSourceService'
import { CODEX_SOURCE_PRESETS } from '../src/shared/codexSources'

if (process.argv[2] === '--read-fixture') {
  assert.equal(decryptLocalSecret(readFileSync(process.argv[3], 'utf8')), 'fixture-local-key')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
const previousElectron = require.cache[electronPath]
const electron = new Module(electronPath)
electron.exports = {
  app: { isPackaged: false, getAppPath: () => fileURLToPath(import.meta.url), whenReady: async () => {}, exit: (code = 0) => process.exit(code) },
  safeStorage: {
    isEncryptionAvailable: () => !process.env.UA_TEST_KEYCHAIN_DENIED,
    decryptString: (value: Buffer) => {
      assert.ok(process.argv.includes(SECRET_MIGRATION_ARG), 'the parent process never touches the keychain')
      if (process.env.UA_TEST_KEYCHAIN_CORRUPT) throw new Error('fixture-secret must not leak')
      // Simulate a synchronous authorization prompt in the child.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      return value.toString()
    }
  }
}
require.cache[electronPath] = electron
if (process.argv.includes(SECRET_MIGRATION_ARG)) {
  await runLegacySecretMigrationWorker()
  await new Promise(() => {})
}

const root = mkdtempSync(join(tmpdir(), 'ua-local-secret-'))
const previous = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
try {
  const keyFile = join(root, 'credentials/key')
  assert.throws(() => decryptLocalSecret('legacy-keychain-ciphertext'), /重新填写/)
  assert.equal(existsSync(keyFile), false, 'reading old data never creates a replacement key')
  const encrypted = encryptLocalSecret('fixture-local-key')
  assert.ok(isLocalSecret(encrypted))
  assert.equal(encrypted.includes('fixture-local-key'), false)
  assert.equal(decryptLocalSecret(encrypted), 'fixture-local-key')
  assert.equal(decryptLocalSecret(encryptLocalSecret('')), '')
  const key = readFileSync(keyFile)
  assert.equal(key.length, 32)
  assert.notEqual(encryptLocalSecret('fixture-local-key'), encrypted, 'each encryption uses a fresh nonce')
  assert.deepEqual(readFileSync(keyFile), key, 'saving another key reuses the installation key')
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, 'credentials')).mode & 0o777, 0o700)
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  }
  const ciphertextFile = join(root, 'fixture.enc')
  writeFileSync(ciphertextFile, encrypted)
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--read-fixture', ciphertextFile], { env: process.env })
  const prefix = 'local:v1:'
  for (const offset of [0, 12, 28]) {
    const bytes = Buffer.from(encrypted.slice(prefix.length), 'base64')
    bytes[offset] ^= 1
    assert.throws(() => decryptLocalSecret(prefix + bytes.toString('base64')), /无法读取/)
  }
  for (const invalid of [prefix, prefix + 'garbage', encrypted + '!', 'local:v2:unknown']) assert.throws(() => decryptLocalSecret(invalid))
  renameSync(keyFile, keyFile + '.backup')
  assert.throws(() => decryptLocalSecret(encrypted), /无法读取/)
  assert.equal(existsSync(keyFile), false, 'decryption never silently replaces a missing key')
  writeFileSync(keyFile, Buffer.alloc(32, 1))
  assert.throws(() => decryptLocalSecret(encrypted), /无法读取/)
  writeFileSync(keyFile, 'corrupt')
  assert.throws(() => encryptLocalSecret('fixture-new-key'), /本地加密密钥/)
  assert.equal(readFileSync(keyFile, 'utf8'), 'corrupt', 'a damaged key is never overwritten')
  renameSync(keyFile + '.backup', keyFile)

  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-new-key')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const sources = (['kimi-code', 'deepseek'] as const).map(preset => ({
      id: CODEX_SOURCE_PRESETS[preset].id, preset, enabled: preset === 'kimi-code', baseUrl, models: ['fixture-model'], encryptedKey: Buffer.from('fixture-new-key').toString('base64')
    }))
    mkdirSync(join(root, 'codex-sources'))
    const settingsFile = join(root, 'codex-sources/settings.json')
    writeFileSync(settingsFile, JSON.stringify({ version: 1, enabled: true, sources }))
    const service = new CodexSourceService()
    assert.equal(service.snapshot().sources.find(source => source.id === 'kimi')?.hasKey, true, 'legacy credentials remain configured until migration succeeds')
    let routerKey: string | undefined
    // Keep the real save/persist/decrypt flow; replace only the router subprocess boundary.
    ;(service as any).spawnChild = async (config: any) => { routerKey = config.sources[0].apiKey }
    const original = readFileSync(settingsFile, 'utf8')
    for (const flag of ['UA_TEST_KEYCHAIN_DENIED', 'UA_TEST_KEYCHAIN_CORRUPT']) {
      process.env[flag] = '1'
      try { await assert.rejects(service.start(), error => /原配置已保留/.test(String(error)) && !String(error).includes('fixture-secret')) }
      finally { delete process.env[flag] }
      assert.equal(readFileSync(settingsFile, 'utf8'), original)
      assert.equal(service.snapshot().enabled, true)
      assert.equal(service.snapshot().sources[0].hasKey, true)
    }
    const spawnRouter = (service as any).spawnChild
    ;(service as any).spawnChild = async () => { writeFileSync(settingsFile, original + '\n') }
    await assert.rejects(service.start(), /其他程序修改/)
    assert.equal(readFileSync(settingsFile, 'utf8'), original + '\n', 'failed migration persistence never overwrites external configuration changes')
    assert.equal(service.snapshot().sources[0].hasKey, true)
    writeFileSync(settingsFile, original)
    ;(service as any).spawnChild = spawnRouter
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 10)
    const legacy = await service.start()
    clearInterval(timer)
    assert.ok(ticks >= 5, 'keychain authorization never blocks the parent event loop')
    assert.equal(legacy.enabled, true)
    assert.equal(routerKey, 'fixture-new-key')
    assert.ok(JSON.parse(readFileSync(settingsFile, 'utf8')).sources.every((source: any) => isLocalSecret(source.encryptedKey)))
    for (const id of ['kimi', 'deepseek']) {
      const source = legacy.sources.find(source => source.id === id)!
      assert.equal(source.hasKey, true)
      assert.equal(source.enabled, id === 'kimi')
      assert.equal(source.baseUrl, baseUrl)
      assert.deepEqual(source.models, ['fixture-model'])
    }
    const { encryptedKey: _oldKey, ...input } = sources[0]
    process.env.UA_TEST_KEYCHAIN_DENIED = '1'
    assert.deepEqual(await service.queryModels(input), ['fixture-model'])
    const saved = await service.save({ ...input, apiKey: 'fixture-new-key' })
    assert.equal(routerKey, 'fixture-new-key')
    assert.equal(saved.sources.find(source => source.id === 'kimi')?.hasKey, true)
    assert.equal(JSON.stringify(saved).includes('fixture-new-key'), false)
    assert.equal(readFileSync(settingsFile, 'utf8').includes('fixture-new-key'), false)
    if (process.platform !== 'win32') {
      assert.equal(statSync(settingsFile).mode & 0o777, 0o600)
      assert.equal(statSync(join(root, 'codex-sources')).mode & 0o777, 0o700)
    }
    await service.save(input)
    assert.equal(routerKey, 'fixture-new-key', 'blank key saves preserve credentials')
    await service.close()
    const reloaded = new CodexSourceService()
    assert.equal(reloaded.snapshot().sources.find(source => source.id === 'deepseek')?.hasKey, true)
    assert.deepEqual(await reloaded.queryModels(input), ['fixture-model'], 'a new service decrypts the saved key for model requests')
    await reloaded.close()
    delete process.env.UA_TEST_KEYCHAIN_DENIED

    const deepseekFile = join(root, 'deepseek/connection.json')
    mkdirSync(join(root, 'deepseek'))
    const deepseekUrl = 'https://api.deepseek.com/anthropic'
    const legacyConnection = JSON.stringify({ baseUrl: deepseekUrl, encryptedKey: sources[0].encryptedKey,
      verifiedConnection: createHash('sha256').update(JSON.stringify([deepseekUrl, 'fixture-new-key'])).digest('hex') })
    writeFileSync(deepseekFile, legacyConnection)
    assert.equal(deepseekSnapshot().hasKey, true)
    process.env.UA_TEST_KEYCHAIN_DENIED = '1'
    await assert.rejects(readDeepSeekConnection(), /原配置已保留/)
    assert.equal(readFileSync(deepseekFile, 'utf8'), legacyConnection)
    delete process.env.UA_TEST_KEYCHAIN_DENIED
    mkdirSync(deepseekFile + '.tmp')
    await assert.rejects(readDeepSeekConnection())
    assert.equal(readFileSync(deepseekFile, 'utf8'), legacyConnection, 'failed writes retain the only usable legacy ciphertext')
    rmSync(deepseekFile + '.tmp', { recursive: true })
    const migratedConnection = await readDeepSeekConnection()
    assert.equal(migratedConnection.hasKey, true)
    assert.equal(migratedConnection.verified, true, 'migration preserves connection verification')
    assert.ok(isLocalSecret(JSON.parse(readFileSync(deepseekFile, 'utf8')).encryptedKey))
    process.env.UA_TEST_KEYCHAIN_DENIED = '1'
    assert.equal((await readDeepSeekConnection()).verified, true, 'subsequent reads do not access the keychain')
    delete process.env.UA_TEST_KEYCHAIN_DENIED
    writeFileSync(deepseekFile, legacyConnection)
    const pending = readDeepSeekConnection()
    saveDeepSeekConnection({ baseUrl: deepseekUrl, apiKey: 'fixture-replacement' })
    await pending
    assert.equal(decryptLocalSecret(JSON.parse(readFileSync(deepseekFile, 'utf8')).encryptedKey), 'fixture-replacement', 'an in-flight migration never overwrites newer input')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  console.log('local-secret-store: encryption, tamper detection, permissions, restart and background legacy migration passed')
} finally {
  delete process.env.UA_TEST_KEYCHAIN_DENIED
  delete process.env.UA_TEST_KEYCHAIN_CORRUPT
  if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath]
  if (previous === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = previous
  rmSync(root, { recursive: true, force: true })
}
