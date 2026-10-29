import assert from 'node:assert/strict'
import {
  buildRows,
  changeBlockStarts,
  collapseEq,
  fileDiffsFromSummary,
  nextChangePosition,
  parseUnifiedDiff,
  type Row
} from '../src/renderer/components/diffModel'

// 需求二 — change-block anchors: a run of consecutive add/del rows is ONE block.

// 1. A 4-delete + 3-add replacement is a single block (starts at the first del).
{
  const before = 'a\nb\nc\nd\ne\nf\n'
  const after = 'a\nX\nY\nZ\nf\n'
  const rows = buildRows(before, after)
  const starts = changeBlockStarts(rows)
  assert.equal(starts.length, 1, 'contiguous del+add run collapses to one block')
  assert.ok(rows[starts[0]].t === 'del' || rows[starts[0]].t === 'add')
}

// 6. Navigation starts before the first block, so the first “next” lands on it.
assert.equal(nextChangePosition(-1, 1, 3), 0)
assert.equal(nextChangePosition(-1, -1, 3), 2)
assert.equal(nextChangePosition(2, 1, 3), 0)

// 7. Diff metadata preserves A/M/D/R and only counts +/- lines inside hunks.
{
  const rename = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 50%',
    'rename from old.ts',
    'rename to new.ts',
    '--- a/old.ts',
    '+++ b/new.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new'
  ].join('\n')
  const add = 'diff --git a/add.ts b/add.ts\nnew file mode 100644\n--- /dev/null\n+++ b/add.ts\n@@ -0,0 +1,2 @@\n+one\n+two'
  const modify = 'diff --git a/edit.ts b/edit.ts\n--- a/edit.ts\n+++ b/edit.ts\n@@ -1 +1 @@\n-old\n+new'
  const del = 'diff --git a/del.ts b/del.ts\ndeleted file mode 100644\n--- a/del.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone'
  const parsed = parseUnifiedDiff([add, modify, del, rename].join('\n'))
  assert.deepEqual(parsed.map(({ path, oldPath, kind, added, removed }) => ({
    path, oldPath, kind, added, removed
  })), [
    { path: 'add.ts', oldPath: undefined, kind: 'add', added: 2, removed: 0 },
    { path: 'edit.ts', oldPath: undefined, kind: 'modify', added: 1, removed: 1 },
    { path: 'del.ts', oldPath: undefined, kind: 'delete', added: 0, removed: 1 },
    { path: 'new.ts', oldPath: 'old.ts', kind: 'rename', added: 1, removed: 1 }
  ])
}

// 8. Persisted artifact metadata restores a card without a live diff body.
assert.deepEqual(fileDiffsFromSummary([{
  path: 'saved.ts', kind: 'add', added: 2, removed: 0
}]), [{ path: 'saved.ts', kind: 'add', added: 2, removed: 0, diff: '' }])

// 2. Three separated edits → three blocks, in order.
{
  const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n'
  const after = '1\nX\n3\n4\nY\n6\n7\n8\nZ\n'
  const rows = buildRows(before, after)
  const starts = changeBlockStarts(rows)
  assert.equal(starts.length, 3, 'three non-adjacent edits are three blocks')
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], 'ascending')
  for (const s of starts) assert.ok(rows[s].t === 'add' || rows[s].t === 'del')
}

// 3. No changes → no blocks.
{
  const rows = buildRows('same\nlines\n', 'same\nlines\n')
  assert.deepEqual(changeBlockStarts(rows), [])
}

// 4. A `fold` row ends a block: an edit before a fold and an edit after are two blocks.
{
  const rows: Row[] = [
    { t: 'add', rno: 1, r: 'a' },
    { t: 'fold', count: 10, from: 1 },
    { t: 'del', lno: 20, l: 'b' },
    { t: 'add', rno: 21, r: 'c' },
  ]
  assert.deepEqual(changeBlockStarts(rows), [0, 2], 'fold separates blocks; del+add after fold is one block')
}

// 5. changed-only (collapsed) rows still yield sane block starts.
{
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n'
  const afterLines = before.split('\n')
  afterLines[5] = 'EDIT_A'
  afterLines[30] = 'EDIT_B'
  const rows = collapseEq(buildRows(before, afterLines.join('\n')), 3)
  const starts = changeBlockStarts(rows)
  assert.equal(starts.length, 2, 'two edits across a large file remain two blocks after folding')
}

// 9. A matrix above the LCS ceiling preserves known-equal edges and marks only
// the unknown middle as coarse; unchanged lines must never be painted add/delete.
{
  const before = ['same start', ...Array.from({ length: 2001 }, (_, i) => `old ${i}`), 'same end'].join('\n')
  const after = ['same start', ...Array.from({ length: 2001 }, (_, i) => `new ${i}`), 'same end'].join('\n')
  const rows = buildRows(before, after)
  assert.deepEqual(rows.map((row) => row.t), ['eq', 'coarse', 'eq'])
  assert.deepEqual(rows[1], { t: 'coarse', before: 2001, after: 2001 })
}

console.log('diff-change-blocks: all assertions passed')
