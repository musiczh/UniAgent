import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { ReviewFilePair, ReviewFilePairReq, ReviewScope } from '../shared/types'
import { resolveReviewScope } from './gitChangeSet'

const execFileP = promisify(execFile)

/**
 * Doc10 (FR-E1 变更集视图) — reconstruct one file's COMPLETE before/after contents
 * for the Android-Studio-style side-by-side review.
 *
 * We resolve full text from the two real sources instead of the patch hunks, so
 * "完整" shows the whole file with no `⋯` fold markers:
 *  - Git scopes resolve both sides to the correct tree/index/disk source.
 *  - Live on-disk sides are read through a no-follow confined handle.
 *  - turn scope carries a captured artifact snapshot (`req.before`/`req.after`);
 *    when present it is authoritative and complete.
 *
 * When the complete text is genuinely unavailable (not a git repo, path missing
 * from HEAD, working file gone) we DO NOT fabricate a fold — we fall back to the
 * patch hunks and mark the pair `degraded: true` so the panel says so explicitly.
 * `binary`/`tooLarge` short-circuit rendering with a notice instead of bytes.
 */

const MAX_BYTES = 1.5 * 1024 * 1024 // 1.5MB — above this we don't reconstruct.

/** Forward-compatible view of fields the shared `ReviewFilePairReq` may add later
 * (scope, rename oldPath, turn-snapshot before/after). Read defensively so this
 * module compiles before/after those type additions land. */
type ReviewFilePairReqExt = ReviewFilePairReq & {
  scope?: 'workspace' | 'turn' | ReviewScope
  oldPath?: string
  before?: string
  after?: string
}

export async function reviewGetFilePair(
  req: ReviewFilePairReq,
  workdir?: string
): Promise<ReviewFilePair> {
  const { path, unifiedDiff, kind } = req
  const ext = req as ReviewFilePairReqExt
  const base: ReviewFilePair = { path, kind, before: '', after: '' }

  // Turn scope: the before/after snapshot captured at that turn is authoritative
  // and already complete — trust it verbatim, no disk/git access.
  if (ext.before !== undefined || ext.after !== undefined) {
    return { ...base, before: ext.before ?? '', after: ext.after ?? '' }
  }
  if (normalizeScope(ext.scope) === 'turn') {
    // No snapshot wired yet → the full turn file isn't available; degrade to the
    // patch context (never a ⋯ fold marker).
    const recon = reconstructFromDiff(unifiedDiff, kind)
    return { ...base, before: recon.before, after: recon.after, degraded: true }
  }

  const scope = typeof ext.scope === 'object' ? ext.scope : { kind: 'workspace' as const }
  const git = (args: string[]): Promise<string> =>
    execFileP('git', args, { cwd: workdir, maxBuffer: 64 * 1024 * 1024 }).then((result) => result.stdout)
  const resolved = workdir ? await resolveReviewScope(git, scope).catch(() => null) : null

  const wantBefore = kind !== 'add'
  const wantAfter = kind !== 'delete'

  let before = ''
  let beforeOk = !wantBefore // a pure add has no before → trivially complete.
  if (wantBefore && resolved) {
    const oldPath = ext.oldPath || renameSourceFromDiff(unifiedDiff)
    const blob = await readGitBlob(workdir, resolved.beforeRef, resolved.pathPrefix, oldPath || path)
    if (blob) {
      if (blob.includes(0)) return { ...base, binary: true }
      if (blob.length > MAX_BYTES) return { ...base, tooLarge: true }
      before = blob.toString('utf8')
      beforeOk = true
    }
  }

  let after = ''
  let afterOk = !wantAfter // a pure delete has no after → trivially complete.
  if (wantAfter && (resolved || scope.kind === 'workspace')) {
    if (resolved?.afterRef) {
      const blob = await readGitBlob(workdir, resolved.afterRef, resolved.pathPrefix, path)
      if (blob) {
        if (blob.includes(0)) return { ...base, binary: true }
        if (blob.length > MAX_BYTES) return { ...base, tooLarge: true }
        after = blob.toString('utf8')
        afterOk = true
      }
    } else {
      // Live workspace reads stay confined and reject symlink/path races.
      const diskFile = await readConfinedFile(workdir, path)
      if (diskFile?.tooLarge) return { ...base, tooLarge: true }
      if (diskFile?.bytes?.includes(0)) return { ...base, binary: true }
      if (diskFile?.bytes) {
        after = diskFile.bytes.toString('utf8')
        afterOk = true
      }
    }
  }

  // Got the complete text for both sides → a full, non-degraded pair.
  if (beforeOk && afterOk) return { ...base, before, after }

  // Full content unavailable (not a repo / missing from HEAD / working file gone).
  // Explicitly degrade to the patch hunks — never insert a ⋯ fold marker.
  const recon = reconstructFromDiff(unifiedDiff, kind)
  return {
    ...base,
    before: beforeOk ? before : recon.before,
    after: afterOk ? after : recon.after,
    degraded: true
  }
}

/** Read a committed/index blob via `git show <ref>:<path>` (object DB, not disk → no
 * symlink follow). Path is confined with the same no-`..`/no-absolute rule as the
 * disk read. Returns the raw bytes, or null when the path isn't in that ref / not a
 * repo. `encoding:'buffer'` yields a Buffer at runtime (cast: promisify types it
 * as string). */
async function readGitBlob(
  workdir: string | undefined,
  ref: string,
  pathPrefix: string,
  requestedPath: string
): Promise<Buffer | null> {
  const normalized = normalizeRelativePath(requestedPath)
  if (!workdir || !normalized) return null
  try {
    const repoPath = `${pathPrefix}${normalized}`
    const spec = ref === ':' ? `:0:${repoPath}` : `${ref}:${repoPath}`
    const { stdout } = await execFileP('git', ['show', spec], {
      cwd: workdir,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer'
    })
    return stdout as unknown as Buffer
  } catch {
    return null
  }
}

/** Extract a rename's original path from its unified diff (`rename from …`, or the
 * `--- a/…` header) so we can read the correct HEAD blob for a renamed file. */
function renameSourceFromDiff(unifiedDiff: string): string | undefined {
  if (!unifiedDiff) return undefined
  const rename = unifiedDiff.match(/^rename from (.+)$/m)
  if (rename) return rename[1]
  const minus = unifiedDiff.match(/^--- a\/(.+)$/m)
  if (minus && minus[1] !== '/dev/null') return minus[1]
  return undefined
}

/** Normalize the legacy string/object scope enough to keep turn snapshots isolated. */
function normalizeScope(scope: ReviewFilePairReqExt['scope']): 'workspace' | 'turn' | undefined {
  if (scope === 'turn' || scope === 'workspace') return scope
  if (scope && typeof scope === 'object') {
    const kind = scope.kind
    if (kind === 'turn' || kind === 'workspace') return kind
  }
  return undefined
}

interface PathIdentity { dev: number; ino: number }

async function readConfinedFile(
  workdir: string | undefined,
  requestedPath: string
): Promise<{ bytes?: Buffer; tooLarge?: true } | null> {
  const normalized = normalizeRelativePath(requestedPath)
  if (!workdir || !normalized) return null
  try {
    const root = await realpath(resolve(workdir))
    const candidate = join(root, ...normalized.split('/'))
    const target = await realpath(candidate)
    const fromRoot = relative(root, target)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null

    const before = await directoryIdentities(root, dirname(candidate))
    const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) return null
      const leaf = await lstat(candidate)
      if (leaf.isSymbolicLink() || leaf.dev !== opened.dev || leaf.ino !== opened.ino) return null
      if (opened.size > MAX_BYTES) return { tooLarge: true }
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      const after = await directoryIdentities(root, dirname(candidate))
      const current = await lstat(candidate)
      if (!sameIdentities(before, after) || current.isSymbolicLink() ||
          current.dev !== opened.dev || current.ino !== opened.ino) return null
      if (bytesRead > MAX_BYTES) return { tooLarge: true }
      return { bytes: buffer.subarray(0, bytesRead) }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function normalizeRelativePath(path: string): string | null {
  if (typeof path !== 'string' || !path || path.includes('\0') ||
      isAbsolute(path) || win32.isAbsolute(path)) return null
  const slashPath = sep === '\\' ? path.replace(/\\/g, '/') : path
  const parts = slashPath.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return null
  return parts.join('/')
}

async function directoryIdentities(root: string, parent: string): Promise<PathIdentity[]> {
  const rel = relative(root, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside_root')
  const paths = [root]
  let cursor = root
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    paths.push(cursor)
  }
  const identities: PathIdentity[] = []
  for (const path of paths) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_path')
    identities.push({ dev: info.dev, ino: info.ino })
  }
  return identities
}

function sameIdentities(left: PathIdentity[], right: PathIdentity[]): boolean {
  return left.length === right.length &&
    left.every((identity, index) => identity.dev === right[index]?.dev && identity.ino === right[index]?.ino)
}

/**
 * Reconstruct before/after text from a unified diff for a single file — ONLY the
 * degraded fallback when the complete file can't be sourced from git HEAD + disk.
 * Context lines (` `) go to both sides, `-` to before, `+` to after. It does NOT
 * insert any `⋯` fold marker between hunks: an unavailable-complete pair is flagged
 * `degraded` by the caller instead of faking elided regions. Returns ok=false when
 * no hunk header was found (nothing to reconstruct).
 */
export function reconstructFromDiff(
  unifiedDiff: string,
  kind: ReviewFilePair['kind']
): { before: string; after: string; ok: boolean } {
  const lines = (unifiedDiff || '').split('\n')
  const before: string[] = []
  const after: string[] = []
  let inHunk = false
  let sawHunk = false
  for (const ln of lines) {
    if (ln.startsWith('@@')) {
      inHunk = true
      sawHunk = true
      continue
    }
    if (!inHunk) continue // skip diff/index/---/+++ header lines
    const tag = ln[0]
    const body = ln.slice(1)
    if (tag === '+') after.push(body)
    else if (tag === '-') before.push(body)
    else if (tag === '\\') continue // "\ No newline at end of file"
    else {
      // context (' ') or a stray blank line inside the hunk
      before.push(body)
      after.push(body)
    }
  }
  // Pure add/delete files carry only one side in practice; keep the other empty.
  if (kind === 'add') before.length = 0
  if (kind === 'delete') after.length = 0
  return { before: before.join('\n'), after: after.join('\n'), ok: sawHunk }
}
