import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequirementStore } from '../src/main/requirementStore'
import type { UAEvent } from '../src/shared/types'

const home = await mkdtemp(join(tmpdir(), 'requirement-space-'))
try {
  const store = new RequirementStore(home)
  const r = await store.create({ name: '登录需求' })
  const input: UAEvent = { sessionId: 'user-session', seq: 1, ts: 1, type: 'user_message', payload: { text: '登录须保留已有账号状态，不要求重复登录。' } }
  await store.recordInput(r.id, input)
  const boot: any = await store.context(r.id, 'user-session', { action: 'bootstrap' })
  assert.equal(boot.formatVersion, 2)
  assert.deepEqual(await readdir(join(r.dir, 'sources')).catch(() => []), [], 'no transcript copy')
  assert.ok(!boot.recentSources, 'bootstrap must not return raw messages')
  const before = await readFile(r.docPath, 'utf8')
  const revisions = await readdir(join(r.dir, '.uniagent', 'revisions'))
  const bodies = await readdir(join(r.dir, '.uniagent', 'bodies'))
  for (let seq = 2; seq <= 101; seq++) {
    await store.recordInput(r.id, { ...input, seq: seq * 2, ts: seq, payload: { text: '继续' } })
    await store.finishTurn(r.id, { ...input, seq: seq * 2 + 1, ts: seq, type: 'turn_completed', state: 'success' })
  }
  assert.equal(await readFile(r.docPath, 'utf8'), before)
  assert.equal((await store.context(r.id, 'user-session', { action: 'bootstrap' }) as any).revision, boot.revision)
  assert.deepEqual(await readdir(join(r.dir, 'sources')).catch(() => []), [])
  assert.deepEqual(await readdir(join(r.dir, '.uniagent', 'revisions')), revisions)
  assert.deepEqual(await readdir(join(r.dir, '.uniagent', 'bodies')), bodies)
  console.log('PASS requirement space does not duplicate or inject per-turn transcripts')
} finally { await rm(home, { recursive: true, force: true }) }
