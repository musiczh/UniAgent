// Doc10 (FR-E1 变更集视图) — pure model helpers for the Android-Studio-style
// side-by-side review. All functions here are dependency-free (no jsdiff) so
// the panel stays inside the repo's "零重依赖" style: a compact Myers/LCS is all
// we need for line + token alignment.

/** One file's parsed diff, split out of an aggregated `diff --git` unified diff. */
export interface FileDiff {
  path: string
  oldPath?: string
  kind: 'add' | 'delete' | 'modify' | 'rename'
  /** The raw unified-diff text for THIS file (fed back to review:getFilePair). */
  diff: string
  /** Lines added / removed, for the file-list stat badges. */
  added: number
  removed: number
}

/**
 * Split an aggregated unified diff (many `diff --git a/… b/…` sections) into
 * per-file diffs. Detects add/delete via the `new file` / `deleted file` mode
 * lines (falls back to +/- ratios) and counts +/- for the stat badges.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = []
  if (!diff.trim()) return out
  const lines = diff.split('\n')
  let cur: {
    gitOld: string
    gitNew: string
    minus: string
    plus: string
    renameFrom: string
    renameTo: string
    body: string[]
    added: number
    removed: number
    isNew: boolean
    isDel: boolean
    inHunk: boolean
  } | null = null
  const fresh = (gitOld = '', gitNew = '') => ({
    gitOld, gitNew, minus: '', plus: '', renameFrom: '', renameTo: '',
    body: [] as string[], added: 0, removed: 0, isNew: false, isDel: false, inHunk: false
  })
  const flush = (): void => {
    if (!cur) return
    const oldPath = cur.renameFrom || stripDiffPath(cur.minus || cur.gitOld)
    const newPath = cur.renameTo || stripDiffPath(cur.plus || cur.gitNew)
    const isNew = cur.isNew || cur.minus === '/dev/null'
    const isDel = cur.isDel || cur.plus === '/dev/null'
    const renamed = !!cur.renameTo || (!isNew && !isDel && !!oldPath && !!newPath && oldPath !== newPath)
    const path = isDel ? oldPath : newPath || oldPath
    if (!path || path === '/dev/null') return
    const kind: FileDiff['kind'] = isNew ? 'add' : isDel ? 'delete' : renamed ? 'rename' : 'modify'
    out.push({
      path,
      ...(kind === 'rename' && oldPath ? { oldPath } : {}),
      kind,
      diff: cur.body.join('\n'),
      added: cur.added,
      removed: cur.removed
    })
  }
  for (const ln of lines) {
    const m = ln.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      flush()
      cur = fresh(m[1], m[2])
      cur.body.push(ln)
      continue
    }
    if (!cur) {
      // A bare single-file patch starts at its `---` header. Ignore unrelated
      // preamble rather than producing an empty-path file row.
      if (!ln.startsWith('--- ')) continue
      cur = fresh()
    } else if (!cur.gitOld && cur.minus && ln.startsWith('--- ')) {
      // Multiple bare patches have no `diff --git` delimiter.
      flush()
      cur = fresh()
    }
    cur.body.push(ln)
    if (ln.startsWith('--- ')) cur.minus = ln.slice(4).trim().split('\t')[0]
    else if (ln.startsWith('+++ ')) cur.plus = ln.slice(4).trim().split('\t')[0]
    else if (ln.startsWith('rename from ')) cur.renameFrom = ln.slice(12).trim()
    else if (ln.startsWith('rename to ')) cur.renameTo = ln.slice(10).trim()
    else if (ln.startsWith('new file mode')) cur.isNew = true
    else if (ln.startsWith('deleted file mode')) cur.isDel = true
    else if (ln.startsWith('@@')) cur.inHunk = true
    else if (cur.inHunk && /^\+(?!\+\+)/.test(ln)) cur.added++
    else if (cur.inHunk && /^-(?!--)/.test(ln)) cur.removed++
  }
  flush()
  return out
}

function stripDiffPath(path: string): string {
  if (!path || path === '/dev/null') return path
  return path.replace(/^[ab]\//, '')
}

/** Turn artifacts omit patch bodies but already contain authoritative metadata. */
export function fileDiffsFromSummary(
  files: readonly {
    path: string
    oldPath?: string
    kind: FileDiff['kind']
    added: number
    removed: number
  }[]
): FileDiff[] {
  return files.map((file) => ({ ...file, diff: '' }))
}

export type Row =
  | { t: 'eq'; lno: number; rno: number; l: string; r: string }
  | { t: 'del'; lno: number; l: string }
  | { t: 'add'; rno: number; r: string }
  | { t: 'fold'; count: number; from: number }
  | { t: 'coarse'; before: number; after: number }

const LCS_CELL_LIMIT = 4_000_000

/**
 * Build aligned rows from full before/after text via a line-level LCS. Equal
 * lines pair up (eq); left-only lines are del, right-only are add. This is the
 *序列 the split view renders directly — left & right share it, so rows always
 * line up and scroll in sync.
 */
export function buildRows(before: string, after: string): Row[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const rows: Row[] = []
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++

  for (let i = 0; i < prefix; i++) {
    rows.push({ t: 'eq', lno: i + 1, rno: i + 1, l: a[i], r: b[i] })
  }
  const aMiddle = a.slice(prefix, a.length - suffix)
  const bMiddle = b.slice(prefix, b.length - suffix)
  if (aMiddle.length * bMiddle.length > LCS_CELL_LIMIT) {
    rows.push({ t: 'coarse', before: aMiddle.length, after: bMiddle.length })
  } else {
    const ops = lcsDiff(aMiddle, bMiddle)
    let li = 0
    let ri = 0
    for (const op of ops) {
      if (op === 'eq') {
        rows.push({
          t: 'eq', lno: prefix + li + 1, rno: prefix + ri + 1,
          l: aMiddle[li], r: bMiddle[ri]
        })
        li++
        ri++
      } else if (op === 'del') {
        rows.push({ t: 'del', lno: prefix + li + 1, l: aMiddle[li] })
        li++
      } else {
        rows.push({ t: 'add', rno: prefix + ri + 1, r: bMiddle[ri] })
        ri++
      }
    }
  }
  for (let i = suffix; i > 0; i--) {
    const li = a.length - i
    const ri = b.length - i
    rows.push({ t: 'eq', lno: li + 1, rno: ri + 1, l: a[li], r: b[ri] })
  }
  return rows
}

/**
 * Collapse long runs of unchanged (eq) rows in changed-only mode, keeping `ctx`
 * lines of context on either side of any add/del. Collapsed runs become a single
 * `fold` row the panel renders as "⋯ 展开 N 行未变更".
 */
export function collapseEq(rows: Row[], ctx = 3): Row[] {
  const keep = new Array(rows.length).fill(false)
  rows.forEach((r, i) => {
    if (r.t !== 'eq') {
      for (let k = i - ctx; k <= i + ctx; k++) if (k >= 0 && k < rows.length) keep[k] = true
    }
  })
  const out: Row[] = []
  let hidden = 0
  let hiddenFrom = 0
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (hidden > 0) {
        out.push({ t: 'fold', count: hidden, from: hiddenFrom })
        hidden = 0
      }
      out.push(r)
    } else {
      if (hidden === 0) hiddenFrom = i
      hidden++
    }
  })
  if (hidden > 0) out.push({ t: 'fold', count: hidden, from: hiddenFrom })
  return out
}

/**
 * 需求二(按改动块导航) — the row indices that START each change block. A change
 * block is a maximal run of consecutive `add`/`del` rows; a deletion immediately
 * followed by an addition belongs to the SAME block (that's a replacement), and
 * an `eq` or `fold` row ends the current block. Feeds ↑/↓ navigation so pressing
 * "next" jumps one *edit* at a time, not one changed *line* at a time (4 deletes +
 * 3 adds = 1 block, not 7 anchors).
 */
export function changeBlockStarts(rows: Row[]): number[] {
  const starts: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const changed = rows[i].t === 'add' || rows[i].t === 'del'
    const previousChanged = i > 0 && (rows[i - 1].t === 'add' || rows[i - 1].t === 'del')
    if (changed && !previousChanged) starts.push(i)
  }
  return starts
}

/** -1 means navigation has not visited a block yet; the first next lands on 0. */
export function nextChangePosition(current: number, direction: 1 | -1, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

/**
 * Token-level (word) diff between a deleted line and its paired added line, so
 * the panel can highlight only the changed spans. Returns HTML-safe segments
 * with a `changed` flag; the caller wraps changed spans in `.tok-del`/`.tok-add`.
 */
export function inlineTokens(
  left: string,
  right: string
): { left: { text: string; changed: boolean }[]; right: { text: string; changed: boolean }[] } {
  const la = tokenize(left)
  const ra = tokenize(right)
  const ops = lcsDiff(la, ra)
  const L: { text: string; changed: boolean }[] = []
  const R: { text: string; changed: boolean }[] = []
  let li = 0
  let ri = 0
  for (const op of ops) {
    if (op === 'eq') {
      L.push({ text: la[li], changed: false })
      R.push({ text: ra[ri], changed: false })
      li++
      ri++
    } else if (op === 'del') {
      L.push({ text: la[li], changed: true })
      li++
    } else {
      R.push({ text: ra[ri], changed: true })
      ri++
    }
  }
  return { left: mergeSegs(L), right: mergeSegs(R) }
}

/** Split a line into word / non-word tokens so highlighting lands on real edits. */
function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) || []
}

/** Coalesce adjacent segments with the same `changed` flag into one span. */
function mergeSegs(segs: { text: string; changed: boolean }[]): { text: string; changed: boolean }[] {
  const out: { text: string; changed: boolean }[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.changed === s.changed) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

/**
 * Compact LCS diff over two arrays → a sequence of 'eq' | 'del' | 'add' ops.
 * Uses the classic O(n·m) DP table; for the line/word counts we deal with in a
 * single file view this is plenty fast, and it degrades gracefully because the
 * side-by-side panel only ever builds rows for the currently-open file.
 */
function lcsDiff<T>(a: T[], b: T[]): ('eq' | 'del' | 'add')[] {
  const n = a.length
  const m = b.length
  // Token diffs can still be pathological; callers do not present these ops as
  // authoritative line changes. Line diffs are guarded explicitly in buildRows.
  if (n * m > 4_000_000) {
    return [...a.map(() => 'del' as const), ...b.map(() => 'add' as const)]
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: ('eq' | 'del' | 'add')[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('eq')
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push('del')
      i++
    } else {
      ops.push('add')
      j++
    }
  }
  while (i < n) {
    ops.push('del')
    i++
  }
  while (j < m) {
    ops.push('add')
    j++
  }
  return ops
}

/** Aggregate +/- across a whole aggregated diff, for the file-list total. */
export function totalStat(files: FileDiff[]): { added: number; removed: number } {
  return files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 }
  )
}
