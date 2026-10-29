import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cancelMCodeOperation, checkMCodeConnection, detectMCode, installMCode, mcodeRuntimeEnv, mcodeSnapshot, reopenMCodeSignIn, signInMCode } from '../src/main/mcodeService.ts'
import type { AgentDef } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-mcode-service-'))
const home = join(root, 'home'), binDir = join(root, 'bin'), data = join(root, 'native-data')
await Promise.all([home, binDir, data].map(dir => mkdir(dir, { recursive: true })))
const keys = ['HOME', 'PATH', 'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR', 'MAVIS_PROFILE', 'MCODE_INSTALL_DIR', 'MCODE_REGION', 'FAKE_MCODE_LOG', 'FAKE_MCODE_STATE', 'FAKE_MCODE_SCENARIO']
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const originalFetch = globalThis.fetch
Object.assign(process.env, { HOME: home, PATH: binDir, MINIMAX_DATA_DIR: data, FAKE_MCODE_LOG: join(root, 'protocol.jsonl'), FAKE_MCODE_STATE: join(root, 'unused.json'), FAKE_MCODE_SCENARIO: '{"nativeData":true}' })
for (const key of ['MAVIS_DATA_DIR', 'MAVIS_PROFILE', 'MCODE_INSTALL_DIR', 'MCODE_REGION']) delete process.env[key]
const fixture = resolve('test/fixtures/fake-mcode.cjs')
const wrapper = `#!${process.execPath}\nrequire(${JSON.stringify(fixture)})\n`
const config = join(data, 'config.yaml')
const nativeBin = join(binDir, 'mcode')
const agent: AgentDef = { id: 'mcode', name: 'MiniMax Code', bin: 'mcode', adapter: 'mcode', icon: 'mcode', models: [], capabilities: { protocol: 'acp', modelSelect: true, reasoningEffort: true, permissionModes: [] } }
const readConfig = async () => JSON.parse(await readFile(config, 'utf8'))
const scenario = (value: object = {}) => { process.env.FAKE_MCODE_SCENARIO = JSON.stringify({ nativeData: true, ...value }) }
let downloads = 0
try {
  assert.equal((await mcodeSnapshot()).status, 'uninstalled')
  await writeFile(nativeBin, wrapper, { mode: 0o700 })
  await writeFile(config, JSON.stringify({ provider: 'third-party', keep: 'preserved' }), { mode: 0o600 })
  const detected = await detectMCode(agent)
  assert.equal(detected.installed, true, 'reuse the external CLI on PATH')
  assert.equal(detected.bin, nativeBin)
  assert.equal(detected.authenticationRequired, false, 'native third-party providers need no second login')
  assert.equal(detected.incompatible, false)
  assert.ok(detected.models.length > 0)
  assert.equal((await mcodeSnapshot()).status, 'ready')
  assert.equal(existsSync(join(data, 'sessions.json')), false, 'detection must not create sessions in the native history')
  assert.equal(mcodeRuntimeEnv().MINIMAX_DATA_DIR, data, 'runtime and history use the same native data root')
  await chmod(nativeBin, 0o600)
  assert.equal((await mcodeSnapshot()).status, 'failed', 'permission errors must not offer a duplicate installation')
  assert.equal((await detectMCode(agent)).lifecycle?.detectionStatus, 'failed')
  await chmod(nativeBin, 0o700)
  globalThis.fetch = async () => { downloads++; throw new Error('must not download') }
  assert.equal((await installMCode()).status, 'ready')
  assert.equal(downloads, 0, 'installation rechecks and skips an existing native executable')

  await writeFile(config, JSON.stringify({ keep: 'preserved' }))
  assert.equal((await mcodeSnapshot()).status, 'needs-auth')
  scenario({ networkFailure: true })
  const failed = await detectMCode(agent)
  assert.equal(failed.installed, true)
  assert.equal(failed.authenticationRequired, false, 'a service failure is not a missing credential')
  assert.equal(failed.incompatible, true)
  scenario()
  await assert.rejects(() => checkMCodeConnection({ apiKey: '   ' }), /填写/)
  await assert.rejects(() => checkMCodeConnection(null as never), /参数/)
  await assert.rejects(() => checkMCodeConnection({ apiKey: 'valid-fixture-key', region: 'invalid' as never }), /区域/)
  await assert.rejects(() => checkMCodeConnection({ apiKey: 'invalid-secret-must-not-appear' }), error => {
    assert.ok(error instanceof Error)
    assert.ok(!error.message.includes('invalid-secret-must-not-appear'))
    return /验证失败/.test(error.message)
  })
  assert.deepEqual(await readConfig(), { keep: 'preserved' }, 'failed key validation must not replace native configuration')
  assert.equal((await checkMCodeConnection({ apiKey: 'valid-fixture-key' })).status, 'ready')
  assert.deepEqual(await readConfig(), { keep: 'preserved', apiKey: 'valid-fixture-key' })

  await writeFile(config, '{}')
  const opened: string[] = []
  const login = signInMCode('global', async url => { opened.push(url) })
  while (!opened.length) await new Promise(done => setTimeout(done, 10))
  await reopenMCodeSignIn()
  assert.equal(opened.length, 2)
  assert.equal((await login).status, 'ready', 'browser login is reused automatically')
  assert.equal((await mcodeSnapshot()).status, 'ready')
  const log = (await readFile(process.env.FAKE_MCODE_LOG!, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(log.some(row => row.kind === 'argv' && row.argv.join(' ') === 'login --region global --no-browser' && row.dataDir === data))
  assert.ok(!log.some(row => JSON.stringify(row).includes('valid-fixture-key')), 'keys never travel through argv or diagnostic logs')

  await rm(join(data, 'auth'), { recursive: true })
  scenario({ loginHold: true })
  const waiting = signInMCode('cn', async () => {})
  const rejected = assert.rejects(() => waiting, /取消/)
  let loginPid: number | undefined
  while (!loginPid) {
    const attempts = (await readFile(process.env.FAKE_MCODE_LOG!, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'argv' && row.argv[0] === 'login')
    if (attempts.length === 2) loginPid = attempts[1].pid
    else await new Promise(done => setTimeout(done, 10))
  }
  await cancelMCodeOperation()
  await rejected
  assert.throws(() => process.kill(loginPid!, 0), /ESRCH/, 'browser cancellation waits for its own CLI to exit')
  assert.equal(existsSync(join(data, 'auth/prod/session.json')), false)
  await assert.rejects(() => reopenMCodeSignIn(), /尚未就绪/)
  scenario()

  await rm(nativeBin)
  await assert.rejects(() => installMCode(), /下载安装程序未完成/)
  assert.equal((await mcodeSnapshot()).installed, false)
  const childPid = join(root, 'installer-child.pid')
  globalThis.fetch = async () => new Response(`#!/bin/bash\n/bin/sleep 60 &\necho $! > '${childPid}'\nwait\n`)
  const cancelling = assert.rejects(() => installMCode(), /取消/)
  while (!existsSync(childPid)) await new Promise(done => setTimeout(done, 10))
  const ownedPid = Number(await readFile(childPid, 'utf8'))
  await cancelMCodeOperation()
  await cancelling
  // The runner's subreaper can retain a stopped orphan as a zombie; it must not remain running.
  const childStatus = await promisify(execFile)('/bin/ps', ['-o', 'stat=', '-p', String(ownedPid)]).then(result => result.stdout.trim(), () => '')
  assert.ok(!childStatus || childStatus.startsWith('Z'), `cancel must stop the owned installer child, status=${childStatus}`)
  const installerSource = join(root, 'fixture-cli')
  await writeFile(installerSource, wrapper, { mode: 0o700 })
  globalThis.fetch = async () => {
    downloads++
    return new Response(`#!/bin/bash\n/bin/mkdir -p "$HOME/.minimax-code/bin"\n/bin/cp '${installerSource}' "$HOME/.minimax-code/bin/mcode"\n/bin/chmod +x "$HOME/.minimax-code/bin/mcode"\n`)
  }
  const installed = await installMCode()
  assert.equal(installed.installed, true)
  assert.equal(installed.status, 'needs-auth', 'installation does not imply authentication')
  assert.equal(installed.bin, join(home, '.minimax-code/bin/mcode'))
  assert.ok(!installed.bin!.includes('uniagent/mcode/runtime'))
  assert.equal((await readdir(data)).includes('sessions.json'), false)

  delete process.env.MINIMAX_DATA_DIR
  process.env.MAVIS_DATA_DIR = join(root, 'explicit-native')
  assert.equal(mcodeRuntimeEnv().MINIMAX_DATA_DIR, process.env.MAVIS_DATA_DIR)
  delete process.env.MAVIS_DATA_DIR
  process.env.MAVIS_PROFILE = 'work'
  assert.equal(mcodeRuntimeEnv().MINIMAX_DATA_DIR, join(home, '.minimax-work'))
} finally {
  await cancelMCodeOperation()
  globalThis.fetch = originalFetch
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
  await rm(root, { recursive: true, force: true })
}
console.log('mcode-service: external installation, native auth/provider reuse, non-destructive key validation, browser/cancel and temporary probes passed')
