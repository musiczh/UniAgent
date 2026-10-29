import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { KIMI_NATIVE_RELEASE, KimiOnboarding, managedKimiPath } from '../src/main/kimiInstallation.ts'
if (process.env.UNIAGENT_KIMI_INSTALL_NATIVE_TEST !== '1') throw new Error('Explicit isolated download test required')
const root = await mkdtemp(join(tmpdir(), 'uniagent-kimi-native-install-'))
const env = { HOME: root, PATH: '/usr/bin:/bin', KIMI_CODE_HOME: join(root, 'home') }
await mkdir(env.KIMI_CODE_HOME)
const instance = new KimiOnboarding({ env: () => env, find: async () => { try { await access(managedKimiPath(env)); return managedKimiPath(env) } catch { return undefined } } })
let previous = ''
instance.onChanged = value => { if (value.phase !== previous) { previous = value.phase; console.log(value.phase) } }
const result = await instance.install()
assert.equal(result.phase, 'completed', JSON.stringify(result))
assert.equal(result.status, 'needs-auth', 'no real credentials supplied')
const binary = managedKimiPath(env)
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), KIMI_NATIVE_RELEASE.sha256)
await writeFile('/tmp/uniagent-kimi-qualified-binary.txt', binary)
console.log(JSON.stringify({ version: result.version, status: result.status, binary, note: 'isolated user directory; no global installation or login' }))
