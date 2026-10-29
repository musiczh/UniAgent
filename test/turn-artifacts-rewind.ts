import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TurnArtifactStore,
  parseUnifiedDiffFiles,
  reverseApplyToBefore,
  sha256
} from '../src/main/turnArtifacts'

// A tiny unified-diff builder so tests read like intent, not diff syntax.
// Produces a single-hunk full-file replacement diff for `path`.
function fileDiff(path: string, before: string, after: string, kind: 'add' | 'delete' | 'modify' = 'modify'): string {
  const bl = before === '' ? [] : before.split('\n')
  const al = after === '' ? [] : after.split('\n')
  const a = kind === 'add' ? '/dev/null' : `a/${path}`
  const b = kind === 'delete' ? '/dev/null' : `b/${path}`
  const head = `diff --git a/${path} b/${path}\n--- ${a}\n+++ ${b}\n`
  const hunk = `@@ -1,${bl.length} +1,${al.length} @@\n`
  const body = [...bl.map((l) => `-${l}`), ...al.map((l) => `+${l}`)].join('\n')
  return head + hunk + body
}

async function withStore(fn: (store: TurnArtifactStore, root: string, work: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'uniagent-artifacts-'))
  const root = join(base, 'store')
  const work = join(base, 'work')
  await mkdir(work, { recursive: true })
  let clock = 1000
  const store = new TurnArtifactStore(root, { now: () => clock++ })
  try {
    await fn(store, root, work)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

await withStore(async (store, _root, work) => {
  for (const [index,nativeTurnId] of ['old-1','old-2'].entries()) await store.finalize({
    sessionId:'sdk-fork',nativeThreadId:'parent',nativeTurnId,workdir:work,
    startSeq:index*5,endSeq:index*5+4,startedAt:index,completedAt:index+1,unifiedDiff:''
  })
  const rollback = await store.remapNativeTurns('sdk-fork','fork',new Map([['old-1','new-1']]))
  assert.deepEqual((await store.list('sdk-fork')).map(turn=>[turn.nativeThreadId,turn.nativeTurnId]),[['fork','new-1'],['parent','old-2']])
  assert.equal((await store.read('sdk-fork','new-1'))?.nativeThreadId,'fork')
  await rollback()
  assert.deepEqual((await store.list('sdk-fork')).map(turn=>turn.nativeTurnId),['old-1','old-2'],'failed session persistence restores original snapshot identities')
  await store.remapNativeTurns('sdk-fork','fork',new Map([['old-1','new-1']]))
  await store.trimFrom('sdk-fork','old-2')
  assert.deepEqual((await store.list('sdk-fork')).map(turn=>turn.nativeTurnId),['new-1'])
  assert.equal((await store.previewRewind('sdk-fork','new-1',work)).allowed,true,'retained prefix remains rewindable with the new SDK UUID')
})

// 1. reverseApply + parse are pure and correct, incl. drift detection.
{
  const diff = fileDiff('x.ts', 'a\nb\nc', 'a\nB\nc')
  const parsed = parseUnifiedDiffFiles(diff)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].path, 'x.ts')
  assert.equal(parsed[0].kind, 'modify')
  assert.equal(reverseApplyToBefore('a\nB\nc', parsed[0].unifiedDiff), 'a\nb\nc')
  // drift: after no longer matches the diff's after side
  assert.equal(reverseApplyToBefore('a\nZZ\nc', parsed[0].unifiedDiff), null)
}

// 2. roundtrip: finalize → summary/read/list, snapshots + hashes present.
await withStore(async (store, _root, work) => {
  await writeFile(join(work, 'f.ts'), 'a\nB\nc')
  const summary = await store.finalize({
    sessionId: 's1',
    nativeThreadId: 'th1',
    nativeTurnId: 't1',
    startSeq: 0,
    endSeq: 5,
    startedAt: 1,
    completedAt: 2,
    unifiedDiff: fileDiff('f.ts', 'a\nb\nc', 'a\nB\nc'),
    workdir: work
  })
  assert.equal(summary.state, 'ready')
  assert.equal(summary.files[0].reversible, true)
  assert.equal(summary.files[0].snapshotState, 'full')

  const art = await store.read('s1', 't1')
  assert.ok(art)
  assert.equal(art!.files[0].before, 'a\nb\nc')
  assert.equal(art!.files[0].after, 'a\nB\nc')
  assert.equal(art!.files[0].beforeSha256, sha256('a\nb\nc'))
  assert.equal(art!.files[0].afterSha256, sha256('a\nB\nc'))

  assert.deepEqual((await store.list('s1')).map((t) => t.nativeTurnId), ['t1'])
  assert.equal(await store.summary('s1', 'nope'), null)
})

// 3. same file across multiple turns → reverse order restores earliest before.
await withStore(async (store, _root, work) => {
  const f = join(work, 'g.ts')
  // t1: '' → v1 (add), t2: v1 → v2, t3: v2 → v3
  await writeFile(f, 'v1')
  await store.finalize(base('t1', 0, fileDiff('g.ts', '', 'v1', 'add'), work))
  await writeFile(f, 'v2')
  await store.finalize(base('t2', 1, fileDiff('g.ts', 'v1', 'v2'), work))
  await writeFile(f, 'v3')
  await store.finalize(base('t3', 2, fileDiff('g.ts', 'v2', 'v3'), work))

  // rewind to t2 → file must return to v1 (before t2); t2,t3 removed.
  const preview = await store.previewRewind('s1', 't2')
  assert.equal(preview.allowed, true)
  assert.deepEqual(preview.removeTurnIds, ['t2', 't3'])
  const res = await store.applyRewind('s1', 't2')
  assert.equal(res.ok, true)
  assert.equal(await readFile(f, 'utf8'), 'v1')
})

// 3b. rewinding to a turn that ADDED a file removes the file entirely.
await withStore(async (store, _root, work) => {
  const f = join(work, 'n.ts')
  await writeFile(f, 'created')
  await store.finalize(base('t1', 0, fileDiff('n.ts', '', 'created', 'add'), work))
  const res = await store.applyRewind('s1', 't1')
  assert.equal(res.ok, true)
  assert.equal(existsSync(f), false)
})

// 4. hash drift: external edit after the turn → preview blocked, apply refuses,
//    file left untouched.
await withStore(async (store, _root, work) => {
  const f = join(work, 'h.ts')
  await writeFile(f, 'after')
  await store.finalize(base('t1', 0, fileDiff('h.ts', 'before', 'after'), work))
  await writeFile(f, 'externally edited') // drift
  const preview = await store.previewRewind('s1', 't1')
  assert.equal(preview.allowed, false)
  assert.match(preview.reason || '', /又被修改/)
  const res = await store.applyRewind('s1', 't1')
  assert.equal(res.ok, false)
  assert.equal(await readFile(f, 'utf8'), 'externally edited')
})

// 5. write failure mid-transaction → all files restored from backup.
await withStore(async (store, _root, work) => {
  const a = join(work, 'a.ts')
  const b = join(work, 'b.ts')
  await writeFile(a, 'a-after')
  await writeFile(b, 'b-after')
  await store.finalize({
    sessionId: 's1', nativeThreadId: 'th1', nativeTurnId: 't1',
    startSeq: 0, endSeq: 1, startedAt: 1, completedAt: 2, workdir: work,
    unifiedDiff: fileDiff('a.ts', 'a-before', 'a-after') + '\n' + fileDiff('b.ts', 'b-before', 'b-after')
  })
  // Sabotage the second write: make b.ts a directory so temp+rename onto it fails.
  await rm(b, { force: true })
  await mkdir(b, { recursive: true })
  await writeFile(join(b, 'keep'), 'x')
  const res = await store.applyRewind('s1', 't1')
  assert.equal(res.ok, false)
  // a.ts must be restored to its pre-rewind content, not left at 'a-before'.
  assert.equal(await readFile(a, 'utf8'), 'a-after')
  // b.ts still a directory (untouched) — its backup was refused so nothing written.
  assert.equal((await stat(b)).isDirectory(), true)
})

// 6. git delete diff (`@@ -n,m +0,0 @@`, empty after side) reverses to the full
//    original content, and rewinding restores the deleted file.
await withStore(async (store, _root, work) => {
  const f = join(work, 'del.ts')
  const original = 'line1\nline2\nline3'
  const deleteDiff =
    `diff --git a/del.ts b/del.ts\n--- a/del.ts\n+++ /dev/null\n` +
    `@@ -1,3 +0,0 @@\n` +
    original.split('\n').map((l) => `-${l}`).join('\n')
  const parsed = parseUnifiedDiffFiles(deleteDiff)
  assert.equal(parsed[0].kind, 'delete')
  assert.equal(reverseApplyToBefore('', parsed[0].unifiedDiff), original)
  // finalize with the file already gone from disk (deleted this turn)
  await store.finalize(base('t1', 0, deleteDiff, work))
  const res = await store.applyRewind('s1', 't1')
  assert.equal(res.ok, true)
  assert.equal(await readFile(f, 'utf8'), original)
})

// 7. rename revert: new path removed, old path restored with its content.
await withStore(async (store, _root, work) => {
  const oldF = join(work, 'old.ts')
  const newF = join(work, 'new.ts')
  const content = 'shared\nbody'
  // simulate the post-rename disk state: only new.ts exists
  await writeFile(newF, content)
  const renameDiff =
    `diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n` +
    `--- a/old.ts\n+++ b/new.ts\n@@ -1,2 +1,2 @@\n shared\n body`
  const parsed = parseUnifiedDiffFiles(renameDiff)
  assert.equal(parsed[0].kind, 'rename')
  await store.finalize(base('t1', 0, renameDiff, work))
  const res = await store.applyRewind('s1', 't1')
  assert.equal(res.ok, true)
  assert.equal(existsSync(newF), false)
  assert.equal(await readFile(oldF, 'utf8'), content)
})

// 8. trimFrom drops target..newest manifest entries + blobs, keeps pre-target.
await withStore(async (store, _root, work) => {
  const f = join(work, 'g.ts')
  await writeFile(f, 'v1')
  await store.finalize(base('t1', 0, fileDiff('g.ts', '', 'v1', 'add'), work))
  await writeFile(f, 'v2')
  await store.finalize(base('t2', 1, fileDiff('g.ts', 'v1', 'v2'), work))
  await writeFile(f, 'v3')
  await store.finalize(base('t3', 2, fileDiff('g.ts', 'v2', 'v3'), work))
  await store.trimFrom('s1', 't2')
  assert.deepEqual((await store.list('s1')).map((t) => t.nativeTurnId), ['t1'])
  assert.equal(await store.read('s1', 't2'), null)
  assert.equal(await store.read('s1', 't3'), null)
  assert.ok(await store.read('s1', 't1'))
})

// 7b. A pure rename has no hunks. The diff header still identifies the file and
// unchanged content is a complete before snapshot, so the rename is reversible.
await withStore(async (store, _root, work) => {
  const content = 'unchanged rename body\n'
  await writeFile(join(work, 'renamed.txt'), content)
  const renameDiff = [
    'diff --git a/original.txt b/renamed.txt',
    'similarity index 100%',
    'rename from original.txt',
    'rename to renamed.txt'
  ].join('\n')
  const parsed = parseUnifiedDiffFiles(renameDiff)
  assert.deepEqual(
    parsed.map(({ path, oldPath, kind }) => ({ path, oldPath, kind })),
    [{ path: 'renamed.txt', oldPath: 'original.txt', kind: 'rename' }]
  )
  const summary = await store.finalize(base('t1', 0, renameDiff, work))
  assert.equal(summary.files[0].snapshotState, 'full')
  const artifact = await store.read('s1', 't1')
  assert.equal(artifact?.files[0].before, content)
  assert.equal(artifact?.files[0].after, content)
  const result = await store.applyRewind('s1', 't1')
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(work, 'renamed.txt')), false)
  assert.equal(await readFile(join(work, 'original.txt'), 'utf8'), content)
})

// 7c. Standard binary diffs may omit ---/+++ headers; the diff --git header is
// sufficient to retain the file and its explicit binary snapshot state.
await withStore(async (store, _root, work) => {
  await writeFile(join(work, 'image.bin'), Buffer.from([1, 0, 2]))
  const binaryDiff = [
    'diff --git a/image.bin b/image.bin',
    'index 1111111..2222222 100644',
    'Binary files a/image.bin and b/image.bin differ'
  ].join('\n')
  assert.equal(parseUnifiedDiffFiles(binaryDiff)[0]?.path, 'image.bin')
  const summary = await store.finalize(base('t1', 0, binaryDiff, work))
  assert.equal(summary.files[0].snapshotState, 'binary')
})

// 9. applyRewind success exposes a rollback closure that atomically restores the
//    pre-rewind bytes (used when a later step, e.g. session persist, fails).
await withStore(async (store, _root, work) => {
  const f = join(work, 'g.ts')
  await writeFile(f, 'v1')
  await store.finalize(base('t1', 0, fileDiff('g.ts', '', 'v1', 'add'), work))
  await writeFile(f, 'v2')
  await store.finalize(base('t2', 1, fileDiff('g.ts', 'v1', 'v2'), work))
  const res = await store.applyRewind('s1', 't2')
  assert.equal(res.ok, true)
  assert.equal(await readFile(f, 'utf8'), 'v1') // rewound
  if (res.ok) await res.rollback()
  assert.equal(await readFile(f, 'utf8'), 'v2') // restored to pre-rewind
})

function base(turnId: string, seq: number, unifiedDiff: string, workdir: string) {
  return {
    sessionId: 's1', nativeThreadId: 'th1', nativeTurnId: turnId,
    startSeq: seq, endSeq: seq, startedAt: seq, completedAt: seq + 1,
    unifiedDiff, workdir
  }
}

await withStore(async (store, _root, work) => {
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    store.finalize(base('parallel-' + index, index, '', work))))
  assert.equal((await store.list('s1')).length, 20, 'overlapping empty artifacts must not overwrite manifest entries')
})

console.log('turn-artifacts-rewind: all assertions passed')
