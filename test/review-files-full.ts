import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { reviewGetFilePair } from '../src/main/reviewFiles'
import { getGitChangeSet } from '../src/main/gitChangeSet'
import type { ReviewChangeItem } from '../src/shared/types'

const execFileP = promisify(execFile)

/**
 * Doc(review 完整文件) — the workspace review pair must serve the COMPLETE file
 * (git HEAD blob for before + on-disk after), never insert a `⋯` fold marker, and
 * flag `degraded` only when the full text is genuinely unavailable. This exercises
 * A / M / D / R over a real git repo and asserts no `⋯` leaks into any pair.
 */
const workdir = await mkdtemp(join(tmpdir(), 'uniagent-review-full-'))
const git = (args: string[]): Promise<void> =>
  execFileP('git', args, { cwd: workdir }).then(() => undefined)

try {
  await git(['init', '-q'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'commit.gpgsign', 'false'])

  // A committed baseline with several files, plus enough unchanged lines that a
  // hunk-only reconstruction WOULD elide (and thus insert ⋯) — proving we return
  // the whole file instead.
  const modifyBase = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  await writeFile(join(workdir, 'modify.txt'), modifyBase)
  await writeFile(join(workdir, 'delete.txt'), 'to be deleted\nsecond line\n')
  await writeFile(join(workdir, 'rename-src.txt'), 'rename me\nkeep this line\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'baseline'])

  // Working-tree edits: modify (edit lines 1 and 40 → two far-apart hunks),
  // delete, rename (with a content tweak), and a brand-new add.
  const modifiedText = modifyBase.replace('line 1\n', 'LINE ONE\n').replace('line 40\n', 'LINE FORTY\n')
  await writeFile(join(workdir, 'modify.txt'), modifiedText)
  await execFileP('git', ['rm', '-q', 'delete.txt'], { cwd: workdir })
  await execFileP('git', ['mv', 'rename-src.txt', 'rename-dst.txt'], { cwd: workdir })
  await writeFile(join(workdir, 'rename-dst.txt'), 'renamed!\nkeep this line\n')
  await writeFile(join(workdir, 'add.txt'), 'fresh file\nline two\n')

  const changeSet = await getGitChangeSet(workdir)
  assert.equal(changeSet.isGitRepo, true, 'workdir is a git repo')
  const byPath = new Map<string, ReviewChangeItem>(changeSet.items.map((it) => [it.path, it]))

  // ---- M: modify → complete file both sides, both edits present, no ⋯ --------
  {
    const item = byPath.get('modify.txt')
    assert.ok(item, 'modify.txt in change set')
    assert.equal(item!.kind, 'modify')
    const pair = await reviewGetFilePair(
      { sessionId: 't', path: 'modify.txt', unifiedDiff: item!.unifiedDiff, kind: 'modify' },
      workdir
    )
    assert.equal(pair.degraded, undefined, 'modify pair is fully reconstructed')
    assert.ok(!pair.before.includes('⋯') && !pair.after.includes('⋯'), 'no ⋯ fold marker')
    // Complete file → all 40 lines on each side (unchanged middle preserved).
    assert.equal(pair.before.split('\n').filter(Boolean).length, 40)
    assert.equal(pair.after.split('\n').filter(Boolean).length, 40)
    assert.ok(pair.before.startsWith('line 1\n') && pair.before.includes('\nline 40'))
    assert.ok(pair.after.startsWith('LINE ONE\n') && pair.after.includes('\nLINE FORTY'))
    assert.ok(pair.after.includes('\nline 20\n'), 'unchanged middle kept, not elided')
  }

  // ---- D: delete → after empty, before is the whole committed file -----------
  {
    const item = byPath.get('delete.txt')
    assert.ok(item, 'delete.txt in change set')
    assert.equal(item!.kind, 'delete')
    const pair = await reviewGetFilePair(
      { sessionId: 't', path: 'delete.txt', unifiedDiff: item!.unifiedDiff, kind: 'delete' },
      workdir
    )
    assert.equal(pair.degraded, undefined, 'delete pair is complete (before from HEAD)')
    assert.equal(pair.after, '', 'deleted file has no after')
    assert.equal(pair.before, 'to be deleted\nsecond line\n')
    assert.ok(!pair.before.includes('⋯'))
  }

  // ---- A (tracked add) & untracked add → before empty, after = disk ----------
  {
    const item = byPath.get('add.txt')
    assert.ok(item, 'add.txt in change set')
    const pair = await reviewGetFilePair(
      { sessionId: 't', path: 'add.txt', unifiedDiff: item!.unifiedDiff, kind: 'add' },
      workdir
    )
    assert.equal(pair.degraded, undefined, 'add pair is complete (after from disk)')
    assert.equal(pair.before, '', 'added file has no before')
    assert.equal(pair.after, 'fresh file\nline two\n')
    assert.ok(!pair.after.includes('⋯'))
  }

  // ---- R: rename → before from HEAD:<oldPath>, after from disk ---------------
  {
    const item = byPath.get('rename-dst.txt')
    assert.ok(item, 'rename-dst.txt in change set')
    assert.equal(item!.kind, 'rename')
    assert.equal(item!.oldPath, 'rename-src.txt')
    const pair = await reviewGetFilePair(
      {
        sessionId: 't',
        path: 'rename-dst.txt',
        unifiedDiff: '',
        kind: 'modify',
        oldPath: item!.oldPath
      },
      workdir
    )
    assert.equal(pair.degraded, undefined, 'rename pair reads HEAD:<oldPath> for before')
    assert.equal(pair.before, 'rename me\nkeep this line\n', 'before is the old file blob')
    assert.equal(pair.after, 'renamed!\nkeep this line\n', 'after is the renamed on-disk file')
    assert.ok(!pair.before.includes('⋯') && !pair.after.includes('⋯'))
  }

  // ---- full unavailable → explicit degraded, still NO ⋯ ----------------------
  {
    // Not a git repo path (empty workdir) with a modify kind but a real hunk diff:
    // before can't come from HEAD and disk has no file → degraded, patch fallback,
    // and crucially no fabricated ⋯ between hunks.
    const noRepo = await mkdtemp(join(tmpdir(), 'uniagent-review-norepo-'))
    try {
      const twoHunk =
        '@@ -1,1 +1,1 @@\n-old first\n+new first\n@@ -40,1 +40,1 @@\n-old last\n+new last\n'
      const pair = await reviewGetFilePair(
        { sessionId: 't', path: 'ghost.txt', unifiedDiff: twoHunk, kind: 'modify' },
        noRepo
      )
      assert.equal(pair.degraded, true, 'unavailable complete text is flagged degraded')
      assert.ok(!pair.before.includes('⋯') && !pair.after.includes('⋯'), 'no ⋯ even when degraded')
      assert.ok(pair.before.startsWith('old first\nold last'))
      assert.ok(pair.after.startsWith('new first\nnew last'))
    } finally {
      await rm(noRepo, { recursive: true, force: true })
    }
  }

  // ---- turn scope with a captured snapshot is authoritative & complete -------
  {
    const pair = await reviewGetFilePair(
      {
        sessionId: 't',
        path: 'snap.txt',
        unifiedDiff: '',
        kind: 'modify',
        ...( { before: 'snap before\n', after: 'snap after\n' } as object )
      },
      workdir
    )
    assert.equal(pair.degraded, undefined, 'turn snapshot pair is complete')
    assert.equal(pair.before, 'snap before\n')
    assert.equal(pair.after, 'snap after\n')
  }

  // ---- turn scope WITHOUT a snapshot degrades (no ⋯) -------------------------
  {
    const pair = await reviewGetFilePair(
      {
        sessionId: 't',
        path: 'modify.txt',
        unifiedDiff: '@@ -1,1 +1,1 @@\n-line 1\n+LINE ONE\n',
        kind: 'modify',
        ...( { scope: 'turn' } as object )
      },
      workdir
    )
    assert.equal(pair.degraded, true, 'turn scope without snapshot is degraded')
    assert.ok(!pair.before.includes('⋯') && !pair.after.includes('⋯'))
  }

  console.log('review-files-full: all assertions passed')
} finally {
  await rm(workdir, { recursive: true, force: true })
}
