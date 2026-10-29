import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ReviewChangeItem, ReviewChangeSet, ReviewScope } from '../shared/types'

const execFileP = promisify(execFile)

/**
 * Doc(变更文件列表改 git-diff 驱动) — collect a session workdir's live git change
 * set so the review panel reflects the real working tree (like Android Studio's
 * Changes view), NOT just the files the agent touched this turn.
 *
 * Each scope resolves to one Git comparator: HEAD→disk, index→disk, HEAD→index,
 * parent→commit, or merge-base(upstream, HEAD)→HEAD. Untracked files are added
 * only to the two disk-backed scopes.
 *
 * Everything runs via execFile (no shell → no injection) with `cwd: workdir`.
 * Any failure (not a repo, git missing, empty repo) yields isGitRepo:false so the
 * panel degrades to the aggregated-diff list.
 */
type Git = (args: string[]) => Promise<string>

export interface ResolvedReviewScope {
  diffArgs: string[]
  beforeRef: string
  /** Missing means the live file on disk. `:` means the Git index. */
  afterRef?: string
  includeUntracked: boolean
  /** Repository-root prefix for paths exposed relative to the session workdir. */
  pathPrefix: string
}

export async function getGitChangeSet(
  workdir?: string,
  scope: ReviewScope = { kind: 'workspace' }
): Promise<ReviewChangeSet> {
  if (!workdir) return { isGitRepo: false, items: [] }
  const git: Git = (args) =>
    execFileP('git', args, { cwd: workdir, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout)

  // 1. Is this a git repo? (also gives us the root for a breadcrumb)
  let root: string
  try {
    root = (await git(['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return { isGitRepo: false, items: [] }
  }

  // 改动2 — current branch name for the summary card 环境信息 (detached HEAD →
  // short sha). Best-effort: a failure just omits the branch.
  let branch: string | undefined
  try {
    const b = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    branch = b && b !== 'HEAD' ? b : (await git(['rev-parse', '--short', 'HEAD'])).trim() || undefined
  } catch {
    /* leave branch undefined */
  }

  let upstream: string | undefined
  let commits: ReviewChangeSet['commits']
  try {
    upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim() || undefined
    if (upstream) {
      const upstreamOid = await verifiedCommit(git, upstream)
      if (!upstreamOid) throw new Error('unreachable_upstream')
      const fields = (await git(['log', '-z', '--format=%H%x00%s', `${upstreamOid}..HEAD`])).split('\0')
      commits = []
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const sha = fields[i].trim()
        if (sha) commits.push({ sha, title: fields[i + 1].trim() })
      }
    }
  } catch {
    upstream = undefined
    commits = undefined
  }

  const resolved = await resolveReviewScope(git, scope, upstream).catch(() => null)
  if (!resolved) return { isGitRepo: true, root, branch, upstream, commits, items: [] }

  const items = new Map<string, ReviewChangeItem>()

  // +/- per file. `--numstat -z` uses NUL separators; renames appear as
  // `\told\0new\0` triples, so we parse the stream token-by-token.
  try {
    const numstat = await git([
      '-c',
      'core.quotepath=false',
      'diff',
      '--relative',
      ...resolved.diffArgs,
      '--numstat',
      '-z'
    ])
    for (const rec of parseNumstatZ(numstat)) {
      items.set(rec.path, {
        path: rec.path,
        oldPath: rec.oldPath,
        kind: rec.oldPath ? 'rename' : 'modify',
        tracked: true,
        added: rec.added,
        removed: rec.removed,
        unifiedDiff: ''
      })
    }
  } catch {
    /* no tracked changes / empty repo — leave items empty for this section */
  }

  // Name status refines the kind (A/D/M/R) for the exact same comparator.
  try {
    const status = await git([
      '-c',
      'core.quotepath=false',
      'diff',
      '--relative',
      ...resolved.diffArgs,
      '--name-status',
      '-z'
    ])
    for (const rec of parseNameStatusZ(status)) {
      const existing = items.get(rec.path)
      if (existing) {
        existing.kind = rec.kind
        if (rec.oldPath) existing.oldPath = rec.oldPath
      } else {
        items.set(rec.path, {
          path: rec.path,
          oldPath: rec.oldPath,
          kind: rec.kind,
          tracked: true,
          added: 0,
          removed: 0,
          unifiedDiff: ''
        })
      }
    }
  } catch {
    /* ignore */
  }

  // 3. Per-file unified diff for the tracked entries (used to reconstruct before).
  for (const item of items.values()) {
    if (!item.tracked) continue
    try {
      item.unifiedDiff = await git([
        '-c',
        'core.quotepath=false',
        'diff',
        '--relative',
        ...resolved.diffArgs,
        '--',
        item.oldPath || item.path,
        item.path
      ])
    } catch {
      /* leave empty → reconstructs from disk */
    }
  }

  // 4. Untracked files belong to workspace and unstaged scopes.
  if (resolved.includeUntracked) {
    try {
      const others = await git(['ls-files', '--others', '--exclude-standard', '-z'])
      for (const path of others.split('\0')) {
        if (!path) continue
        items.set(path, {
          path,
          kind: 'add',
          tracked: false,
          added: 0,
          removed: 0,
          unifiedDiff: ''
        })
      }
    } catch {
      /* ignore */
    }
  }

  return { isGitRepo: true, root, branch, upstream, commits, items: [...items.values()] }
}

export async function resolveReviewScope(
  git: Git,
  scope: ReviewScope,
  knownUpstream?: string
): Promise<ResolvedReviewScope | null> {
  const head = await verifiedCommit(git, 'HEAD')
  const pathPrefix = (await git(['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '')
  const emptyTree = async (): Promise<string> =>
    (await git(['hash-object', '-t', 'tree', '/dev/null'])).trim()

  if (scope.kind === 'workspace') {
    const base = head || await emptyTree()
    return { diffArgs: [base], beforeRef: base, includeUntracked: true, pathPrefix }
  }
  if (scope.kind === 'unstaged') {
    return { diffArgs: [], beforeRef: ':', includeUntracked: true, pathPrefix }
  }
  if (scope.kind === 'staged') {
    const base = head || await emptyTree()
    return { diffArgs: ['--cached', base], beforeRef: base, afterRef: ':', includeUntracked: false, pathPrefix }
  }
  if (scope.kind === 'commit') {
    if (!/^[0-9a-f]{40,64}$/i.test(scope.sha)) return null
    const commit = await verifiedCommit(git, scope.sha)
    const upstream = knownUpstream || (await git([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    ])).trim()
    const upstreamOid = await verifiedCommit(git, upstream)
    if (!commit || commit.toLowerCase() !== scope.sha.toLowerCase() || !upstreamOid) return null
    const localCommits = (await git(['rev-list', `${upstreamOid}..HEAD`])).trim().split(/\s+/)
    if (!localCommits.includes(commit)) return null
    const parents = (await git(['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/)
    const parent = parents[1] || await emptyTree()
    return { diffArgs: [parent, commit], beforeRef: parent, afterRef: commit, includeUntracked: false, pathPrefix }
  }
  if (scope.kind === 'branch') {
    if (!head) return null
    const upstream = knownUpstream || (await git([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    ])).trim()
    const upstreamOid = await verifiedCommit(git, upstream)
    if (!upstreamOid) return null
    const base = (await git(['merge-base', upstreamOid, head])).trim()
    if (!base) return null
    return { diffArgs: [base, head], beforeRef: base, afterRef: head, includeUntracked: false, pathPrefix }
  }
  return null
}

async function verifiedCommit(git: Git, ref: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim() || null
  } catch {
    return null
  }
}

/**
 * Parse `git diff --numstat -z` output. Records are NUL-terminated; a rename
 * carries the added/removed counts then TWO extra NUL-separated fields
 * (old path, new path). Binary files report `-\t-` which we treat as 0/0.
 */
function parseNumstatZ(
  out: string
): { path: string; oldPath?: string; added: number; removed: number }[] {
  const res: { path: string; oldPath?: string; added: number; removed: number }[] = []
  const tokens = out.split('\0')
  let i = 0
  while (i < tokens.length) {
    const head = tokens[i]
    if (!head) {
      i++
      continue
    }
    // head = "<added>\t<removed>\t<path?>" — for renames the path is empty and the
    // old/new paths are the next two NUL fields.
    const parts = head.split('\t')
    if (parts.length < 2) {
      i++
      continue
    }
    const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0
    const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0
    const inlinePath = parts.slice(2).join('\t')
    if (inlinePath) {
      res.push({ path: inlinePath, added, removed })
      i++
    } else {
      // rename: next two fields are old, new
      const oldPath = tokens[i + 1] || ''
      const newPath = tokens[i + 2] || ''
      res.push({ path: newPath || oldPath, oldPath: oldPath || undefined, added, removed })
      i += 3
    }
  }
  return res
}

/** Parse `git diff --name-status -z`: status, path (or old path + new path). */
function parseNameStatusZ(
  out: string
): { path: string; oldPath?: string; kind: ReviewChangeItem['kind'] }[] {
  const res: { path: string; oldPath?: string; kind: ReviewChangeItem['kind'] }[] = []
  const tokens = out.split('\0')
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i++]
    if (!code) {
      continue
    }
    const firstPath = tokens[i++]
    if (!firstPath) {
      continue
    }
    if (code[0] === 'R' || code[0] === 'C') {
      const path = tokens[i++]
      if (path) res.push({ path, oldPath: firstPath, kind: 'rename' })
      continue
    }
    let kind: ReviewChangeItem['kind'] = 'modify'
    if (code[0] === 'A') kind = 'add'
    else if (code[0] === 'D') kind = 'delete'
    res.push({ path: firstPath, kind })
  }
  return res
}
