import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'

const root = fs.mkdtempSync(join(tmpdir(), 'uniagent-team-results-'))
const previousHome = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const { watchTeamInbox } = await import('../src/main/handoff')
const inbox = join(root, 'team-inbox')
fs.mkdirSync(inbox)
const rename = fs.renameSync
let stop: (() => void) | undefined
try {
  const id = 'c69e953b-fdf0-429f-ba7c-e28be1743e8d'
  fs.writeFileSync(join(inbox, id + '.json'), JSON.stringify({ id, token: 'private', tool: 'get_team_context' }))
  const temporaries: string[] = []
  fs.renameSync = (from, to) => {
    if (basename(dirname(String(to))) === 'team-results') temporaries.push(String(from))
    rename(from, to)
  }
  syncBuiltinESMExports()
  stop = watchTeamInbox(async () => ({ revision: 1 }))
  await nextTick()
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, 'team-results', id + '.json'), 'utf8')), { ok: true, value: { revision: 1 } })
  assert.ok(!temporaries.includes(join(root, 'team-results', id + '.json.tmp')), 'writers must not share one temporary filename')
  stop()
  const failedId = 'd69e953b-fdf0-429f-ba7c-e28be1743e8d'
  fs.writeFileSync(join(inbox, failedId + '.json'), JSON.stringify({ id: failedId, token: 'private', tool: 'get_team_context' }))
  fs.renameSync = (from, to) => {
    if (basename(dirname(String(to))) === 'team-results') throw Object.assign(new Error('disk unavailable'), { code: 'EIO' })
    rename(from, to)
  }
  syncBuiltinESMExports()
  stop = watchTeamInbox(async () => ({ revision: 2 }))
  await nextTick()
  const { diagnostics } = await import('../src/main/diagnostics')
  assert.ok(diagnostics.list().some(row => row.code === 'team_result_write_failed'))
  assert.deepEqual(fs.readdirSync(join(root, 'team-results')), [id + '.json'], 'failed writes clean up only their own temporary file')
} finally {
  stop?.()
  fs.renameSync = rename
  syncBuiltinESMExports()
  if (previousHome === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousHome
  fs.rmSync(root, { recursive: true, force: true })
}
