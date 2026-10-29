import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { ZCodeInstallationService } from '../src/main/zcode/installation'

// Explicit real download/build qualification. Caller supplies a dedicated user-data directory.
assert.ok(process.env.ZCODE_INSTALL_TEST_DATA && isAbsolute(process.env.ZCODE_INSTALL_TEST_DATA), 'Set ZCODE_INSTALL_TEST_DATA to an isolated absolute directory')
process.env.UNIAGENT_USER_DATA = process.env.ZCODE_INSTALL_TEST_DATA
const service = new ZCodeInstallationService()
let phase = ''
const timer = setInterval(async () => {
  const snapshot = await service.snapshot()
  if (snapshot.message !== phase) { phase = snapshot.message || ''; console.log(snapshot.phase, phase) }
}, 1000)
try {
  const result = await service.install(async () => {})
  assert.equal(result.phase, 'completed', result.message)
  assert.equal(result.installed, true)
  const reused = await service.install(async () => { throw new Error('Healthy reuse must not activate a replacement') })
  assert.equal(reused.phase, 'completed', reused.message)
  console.log(JSON.stringify({ result: 'zcode-install-check-passed', version: result.version, reuse: true }))
} finally { clearInterval(timer) }
