import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run: node scripts/run-ts-test.mjs test/handoff-inbox-claim.ts
const root = fs.mkdtempSync(join(tmpdir(), 'uniagent-inbox-claim-'))
const previousHome = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const { handoffInboxDir, watchHandoffInbox } = await import('../src/main/handoff.ts')
const inbox = handoffInboxDir()
const file = join(inbox, 'request.json')
const rename = fs.renameSync
fs.mkdirSync(inbox, { recursive: true })
let stop: (() => void) | undefined
try {
  for (const outcome of ['consumed', 'denied', 'owned']) {
    fs.writeFileSync(file, JSON.stringify({ id: 'request', prompt: 'Run once' }))
    fs.renameSync = (from, to) => {
      if (String(from) === file && outcome === 'consumed') rename(from, String(to) + '.other')
      if (String(from) === file && outcome === 'denied') throw Object.assign(new Error('denied'), { code: 'EACCES' })
      rename(from, to)
    }
    syncBuiltinESMExports()
    const delivered: unknown[] = []
    stop = watchHandoffInbox(req => delivered.push(req))
    assert.equal(delivered.length, outcome === 'owned' ? 1 : 0, 'only the successful claimant may execute')
    assert.equal(fs.existsSync(file), outcome === 'denied', 'unclaimed requests must remain available')
    stop()
    stop = undefined
  }
} finally {
  stop?.()
  fs.renameSync = rename
  syncBuiltinESMExports()
  if (previousHome === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousHome
  fs.rmSync(root, { recursive: true, force: true })
}
console.log('handoff-inbox-claim: ok')
