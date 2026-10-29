// Run: node scripts/run-ts-test.mjs test/turn-file-changes.ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { SessionStore } from '../src/main/sessionStore'
import { TurnArtifactStore } from '../src/main/turnArtifacts'
import { filesFromTurnChanges } from '../src/main/turnFileChanges'
import { fileDiffsFromSummary } from '../src/renderer/components/diffModel'
import type { Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-turn-changes-'))
const workdir = join(root, 'work')
const previousUserData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
let seq = 0
const event = (type: UAEvent['type'], payload: UAEvent['payload'], state: UAEvent['state'] = 'success'): UAEvent =>
  ({ sessionId: 's', seq: seq++, ts: seq, type, state, payload })
const change = (id: string, path: string, diff: string, kind = 'update', turnId = 't'): UAEvent =>
  event('file_change', { id, turnId, changes: [{ path, diff, kind }] })
const patch = (before: string, after: string, line = 20): string =>
  `--- a/f.ts\n+++ b/f.ts\n@@ -${line} +${line} @@\n-${before}\n+${after}\n`
const changes = [
  change('a', join(workdir, 'f.ts'), patch('original', 'intermediate')),
  change('b', join(workdir, 'f.ts'), patch('intermediate', 'final')),
  change('c', 'new.ts', 'created\n', 'add'),
  change('d', 'empty.ts', '', 'add'),
  change('e', 'deleted.ts', 'gone\n', 'delete')
]

try {
  const { Orchestrator } = await import('../src/main/orchestrator')
  const { loadCodexLikeEvents } = await import('../src/main/history')
  await mkdir(workdir)
  const files = await filesFromTurnChanges([...changes, changes[1],
    { ...change('failed', 'failed.ts', patch('a', 'b')), state: 'failed' },
    { ...change('running', 'running.ts', patch('a', 'b')), state: 'running' },
    change('escape', '../secret', 'secret', 'add'),
    change('absolute-escape', join(root, 'secret'), 'secret', 'add')
  ], workdir)
  assert.deepEqual(files.map((file) => file.path), ['f.ts', 'new.ts', 'empty.ts', 'deleted.ts'])
  assert.deepEqual([files[0].added, files[0].removed], [1, 1])
  assert.match(files[0].unifiedDiff, /-original\n\+final/)
  assert.doesNotMatch(files[0].unifiedDiff, /intermediate|uniagent-unknown/)
  assert.ok(files.every((file) => file.snapshotState === 'patch-only' && !file.reversible))
  assert.equal(files[1].added, 1)
  assert.equal(files[3].removed, 1)
  assert.deepEqual(await filesFromTurnChanges([
    change('a', 'f.ts', patch('a', 'b')), change('b', 'f.ts', patch('b', 'a'))
  ], workdir), [])
  assert.deepEqual(await filesFromTurnChanges([
    change('a', 'f.ts', 'new\n', 'add'), change('b', 'f.ts', 'new\n', 'delete')
  ], workdir), [])
  const shifted = await filesFromTurnChanges([
    change('a', 'f.ts', '--- a/f.ts\n+++ b/f.ts\n@@ -2,0 +3 @@\n+inserted\n'),
    change('b', 'f.ts', patch('old', 'new', 10))
  ], workdir)
  assert.match(shifted[0].unifiedDiff, /@@ -9 \+10 @@/)
  assert.deepEqual([shifted[0].added, shifted[0].removed], [2, 1])
  const invalid = await filesFromTurnChanges([
    change('a', 'f.ts', patch('a', 'b')), change('b', 'f.ts', patch('wrong', 'c'))
  ], workdir)
  assert.equal(invalid[0].unifiedDiff, '', 'inconsistent patches cannot invent a diff')
  const noNewline = await filesFromTurnChanges([change('a', 'f.ts',
    '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'
  )], workdir)
  assert.equal(noNewline[0].added, 1)
  assert.match(noNewline[0].unifiedDiff, /No newline at end of file/)

  const store = new SessionStore(join(root, 'sessions.json'))
  const session: Session = {
    id: 's', title: 'test', nativeSessionId: 'thread', config: { agentId: 'traex', workdir },
    status: 'idle', createdAt: 1, updatedAt: 1, origin: 'created'
  }
  store.save([session])
  const artRoot = join(root, 'artifacts')
  const orchestrator = new Orchestrator(() => undefined, store, artRoot)
  orchestrator.loadPersisted()
  const owner = orchestrator.getSessionById('s')!
  const events = [event('turn_started', { turnId: 't' }), ...changes,
    change('other', 'other.ts', 'other', 'add', 'another-turn'), event('turn_completed', { turnId: 't' })]
  for (const ev of events) (orchestrator as any).captureTurnEvent(owner, ev)
  await (orchestrator as any).finalizeTurnArtifact(owner)
  const summary = await orchestrator.getTurnArtifactSummary('s', 't')
  assert.deepEqual(summary?.files.map((file) => file.path), files.map((file) => file.path))
  assert.equal(fileDiffsFromSummary(summary!.files).length, 4, 'the existing card receives four files')
  const scope = { kind: 'turn' as const, turnId: 't' }
  assert.equal((await orchestrator.reviewGetChangeSet('s', scope)).items.length, 4)
  const pair = await orchestrator.reviewGetFilePair({ sessionId: 's', path: 'f.ts', kind: 'modify', unifiedDiff: '', scope })
  assert.equal(pair.degraded, true)
  assert.equal(pair.before.trim(), 'original')
  assert.equal(pair.after.trim(), 'final')
  const artifacts = new TurnArtifactStore(artRoot)
  assert.equal((await artifacts.previewRewind('s', 't', workdir)).allowed, false)

  // Historical native patches retain add/delete content; no aggregate diff exists.
  const rollout = join(root, 'rollout.jsonl')
  const record = (payload: object) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload })
  await writeFile(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread', cwd: workdir } }),
    record({ type: 'task_started', turn_id: 't' }),
    record({ type: 'user_message', message: 'edit files' }),
    ...changes.map((ev) => {
      const c = ev.payload.changes[0]
      return record({ type: 'patch_apply_end', call_id: ev.payload.id, turn_id: 't', success: true,
        changes: { [c.path]: { type: c.kind, ...(c.kind === 'update' ? { unified_diff: c.diff } : { content: c.diff }) } } })
    }),
    record({ type: 'task_complete', turn_id: 't' })
  ].join('\n'))
  const restored = await loadCodexLikeEvents(rollout, 'traex', 'thread')
  ;(orchestrator as any).events.set('s', restored.events)
  // Simulate an old version's empty artifact, leaving the manifest empty too.
  const artifactPath = join(artRoot, 'v1/s/t.json.gz')
  const legacy = JSON.parse(gunzipSync(await readFile(artifactPath)).toString())
  legacy.files = []
  delete legacy.fileChangesCaptured
  await writeFile(artifactPath, gzipSync(JSON.stringify(legacy)))
  const manifestPath = join(artRoot, 'v1/s/manifest.json.gz')
  const manifest = JSON.parse(gunzipSync(await readFile(manifestPath)).toString())
  manifest.turns[0].files = []
  await writeFile(manifestPath, gzipSync(JSON.stringify(manifest)))
  await writeFile(join(workdir, 'f.ts'), 'unrelated later edits')
  assert.deepEqual((await orchestrator.getTurnArtifactSummary('s', 't'))?.files.map((file) => file.path), files.map((file) => file.path))
  assert.equal((await orchestrator.reviewGetChangeSet('s', scope)).items.length, 4)
  assert.deepEqual(await orchestrator.reviewGetFilePair({ sessionId: 's', path: 'f.ts', kind: 'modify', unifiedDiff: '', scope }), pair)
  assert.equal((await (orchestrator as any).artifacts.previewRewind('s', 't', workdir)).allowed, false)
  assert.equal((await artifacts.read('s', 't'))?.files.length, 0, 'recovery is read-only')

  // An explicit empty aggregate remains authoritative (all edits were undone).
  ;(orchestrator as any).captureTurnEvent(owner, event('turn_started', { turnId: 't2' }))
  ;(orchestrator as any).captureTurnEvent(owner, change('x', 'x.ts', 'temporary', 'add', 't2'))
  ;(orchestrator as any).captureTurnEvent(owner, event('diff_update', { turnId: 't2', diff: '' }))
  await (orchestrator as any).finalizeTurnArtifact(owner)
  assert.deepEqual((await orchestrator.getTurnArtifactSummary('s', 't2'))?.files, [])
  console.log('turn-file-changes: all assertions passed')
} finally {
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
  await rm(root, { recursive: true, force: true })
}
