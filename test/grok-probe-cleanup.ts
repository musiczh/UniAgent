import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { probeGrokACP } from '../src/main/grokACPRunner.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-grok-cleanup-test-'))
const bin = join(root, 'grok')
await writeFile(bin, `#!${process.execPath}\nrequire(${JSON.stringify(join(process.cwd(), 'test/fixtures/fake-grok.cjs'))})\n`, { mode: 0o700 })
const env = { GROK_HOME: join(root, 'native-home'), FAKE_GROK_LOG: join(root, 'records.jsonl'), FAKE_GROK_STATE: join(root, 'state.json') }
const rmdir = fs.rmdir
let recreations = 0, persistent = false, inject = true, probeDirectory = ''
// Recreate a real log after rm has enumerated the directory, just before its
// final rmdir. The actual filesystem returns ENOTEMPTY; rm must retry it.
fs.rmdir = ((path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
  const directory = String(path)
  if (inject && basename(directory).startsWith('uniagent-grok-probe-') && fs.existsSync(directory)
    && fs.readdirSync(directory).length === 0 && (persistent || recreations === 0)) {
    probeDirectory = directory
    fs.mkdirSync(join(directory, 'log'))
    fs.writeFileSync(join(directory, 'log/app.log'), '')
    recreations++
  }
  return rmdir(path, callback)
}) as typeof fs.rmdir

try {
  const ready = await probeGrokACP(bin, root, env)
  assert.equal(ready.status, 'ready', 'a late log must not turn a healthy protocol probe into a detection failure')
  assert.equal(recreations, 1, 'fixture must reproduce a late filesystem write')
  assert.equal(fs.existsSync(probeDirectory), false, 'retry must remove the recreated log and probe directory')

  recreations = 0
  const needsAuth = await probeGrokACP(bin, root, { ...env, FAKE_GROK_SCENARIO: JSON.stringify({ authenticationRequired: true }) })
  assert.equal(needsAuth.status, 'needs-auth', 'cleanup must preserve the actual authentication result')
  assert.equal(recreations, 1)
  assert.equal(fs.existsSync(probeDirectory), false)

  persistent = true
  await assert.rejects(probeGrokACP(bin, root, env), { code: 'ENOTEMPTY' }, 'persistent cleanup failures must remain visible')
} finally {
  inject = false
  fs.rmdir = rmdir
  if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}
console.log('Grok probe cleanup: late log retries, preserved authentication and persistent failures passed')
