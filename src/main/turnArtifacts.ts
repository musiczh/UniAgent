import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { UAEvent } from '../shared/types'
import { filesFromTurnChanges } from './turnFileChanges'

/**
 * 需求3（会话节点回退）/ proposal §3、§6 — per-turn file artifact store.
 *
 * Each Agent turn that touched files gets a gzip-JSON artifact holding the turn's
 * unified diff plus full before/after snapshots (with SHA-256) so a later rewind
 * can be verified and reversed WITHOUT `git reset` — a pure file transaction that
 * only touches files this turn is proven to have changed.
 *
 * Layout under `rootDir` (= app.getPath('userData')/turn-artifacts):
 *   v1/<sessionId>/manifest.json.gz     ordered summaries (no snapshots)
 *   v1/<sessionId>/<nativeTurnId>.json.gz   full artifact incl. before/after
 *
 * Everything is stdlib (zlib/crypto/fs). All disk writes go same-dir temp+rename
 * so a crash never leaves a half file. Path handling reuses the review confinement
 * rules (no-follow open, inode recheck, reject absolute/../symlink escapes).
 */

const VERSION = 1 as const
const MAX_BYTES = 1.5 * 1024 * 1024 // match reviewFiles snapshot ceiling
const ABSENT = '\0absent' // stable sha marker for a missing file side

export type SnapshotState = 'full' | 'patch-only' | 'binary' | 'too-large' | 'missing'
export type ArtifactState = 'ready' | 'patch-only' | 'incomplete'
export type FileKind = 'add' | 'delete' | 'modify' | 'rename'

export interface TurnArtifactFileSummary {
  path: string
  oldPath?: string
  kind: FileKind
  added: number
  removed: number
  reversible: boolean
  snapshotState: SnapshotState
}

export interface TurnArtifactFile extends TurnArtifactFileSummary {
  unifiedDiff: string
  before?: string
  after?: string
  beforeSha256?: string
  afterSha256?: string
}

export interface TurnArtifactSummary {
  sessionId: string
  nativeThreadId: string
  nativeTurnId: string
  startSeq: number
  endSeq: number
  startedAt: number
  completedAt: number
  state: ArtifactState
  files: TurnArtifactFileSummary[]
}

export interface TurnArtifact extends TurnArtifactSummary {
  version: typeof VERSION
  workdir: string
  files: TurnArtifactFile[]
  /** Distinguish a known empty change set from old artifacts that ignored file_change. */
  fileChangesCaptured?: true
}

export interface FinalizeInput {
  sessionId: string
  nativeThreadId: string
  nativeTurnId: string
  startSeq: number
  endSeq: number
  startedAt: number
  completedAt: number
  unifiedDiff: string
  workdir: string
  fileChanges?: UAEvent[]
}

export interface RewindPreview {
  allowed: boolean
  reason?: string
  removeTurnIds: string[]
  files: Array<{ path: string; kind: FileKind; reversible: boolean }>
}

export type RewindResult =
  | { ok: true; restored: string[]; rollback: () => Promise<void> }
  | { ok: false; error: string }

interface Manifest {
  version: typeof VERSION
  sessionId: string
  turns: TurnArtifactSummary[]
}

// ── pure diff helpers (exported for unit tests) ─────────────────────────

export interface ParsedFileDiff {
  path: string
  oldPath?: string
  kind: FileKind
  added: number
  removed: number
  unifiedDiff: string
}

/**
 * Split an aggregated multi-file unified diff (from `turn/diff/updated`) into
 * per-file sections. Prefers `diff --git a/.. b/..` boundaries; falls back to
 * `--- / +++` header pairs. Determines kind from /dev/null and rename headers.
 */
export function parseUnifiedDiffFiles(unifiedDiff: string): ParsedFileDiff[] {
  const text = unifiedDiff || ''
  if (!text.trim()) return []
  const lines = text.split('\n')
  // Find section starts: a `diff --git` line, or a `--- ` line not already inside
  // a git header. Use `diff --git` when present, else group by `--- `.
  const gitStarts: number[] = []
  lines.forEach((ln, i) => {
    if (ln.startsWith('diff --git ')) gitStarts.push(i)
  })
  const sections: string[][] = []
  if (gitStarts.length) {
    for (let s = 0; s < gitStarts.length; s++) {
      const from = gitStarts[s]
      const to = s + 1 < gitStarts.length ? gitStarts[s + 1] : lines.length
      sections.push(lines.slice(from, to))
    }
  } else {
    // No `diff --git`: split on `--- ` header lines.
    let cur: string[] | null = null
    for (const ln of lines) {
      if (ln.startsWith('--- ')) {
        if (cur) sections.push(cur)
        cur = [ln]
      } else if (cur) {
        cur.push(ln)
      }
    }
    if (cur) sections.push(cur)
  }
  const out: ParsedFileDiff[] = []
  for (const sec of sections) {
    const parsed = parseOneFileSection(sec)
    if (parsed) out.push(parsed)
  }
  return out
}

function parseOneFileSection(secLines: string[]): ParsedFileDiff | null {
  let gitOld = ''
  let gitNew = ''
  let minus = ''
  let plus = ''
  let added = 0
  let removed = 0
  let sawHunk = false
  let renameFrom = ''
  let renameTo = ''
  let newFile = false
  let deletedFile = false
  for (const ln of secLines) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(ln)
    if (gitHeader) {
      gitOld = gitHeader[1]
      gitNew = gitHeader[2]
    } else if (ln.startsWith('--- ')) minus = ln.slice(4).trim()
    else if (ln.startsWith('+++ ')) plus = ln.slice(4).trim()
    else if (ln.startsWith('rename from ')) renameFrom = ln.slice('rename from '.length).trim()
    else if (ln.startsWith('rename to ')) renameTo = ln.slice('rename to '.length).trim()
    else if (ln.startsWith('new file mode ')) newFile = true
    else if (ln.startsWith('deleted file mode ')) deletedFile = true
    else if (ln.startsWith('@@')) sawHunk = true
    else if (sawHunk) {
      if (ln.startsWith('+') && !ln.startsWith('+++')) added++
      else if (ln.startsWith('-') && !ln.startsWith('---')) removed++
    }
  }
  const oldStripped = stripDiffPrefix(minus) || gitOld
  const newStripped = stripDiffPrefix(plus) || gitNew
  const isAdd = newFile || minus === '/dev/null' || oldStripped === '/dev/null'
  const isDelete = deletedFile || plus === '/dev/null' || newStripped === '/dev/null'
  const path = isDelete ? oldStripped : newStripped || oldStripped
  if (!path || path === '/dev/null') {
    // Might be a pure-rename section with no content hunks.
    if (renameTo) {
      return {
        path: renameTo,
        oldPath: renameFrom || undefined,
        kind: 'rename',
        added,
        removed,
        unifiedDiff: secLines.join('\n')
      }
    }
    return null
  }
  let kind: FileKind = 'modify'
  let oldPath: string | undefined
  if (isAdd) kind = 'add'
  else if (isDelete) kind = 'delete'
  else if (renameTo || (oldStripped && newStripped && oldStripped !== newStripped)) {
    kind = 'rename'
    oldPath = renameFrom || oldStripped || undefined
  }
  return { path, oldPath, kind, added, removed, unifiedDiff: secLines.join('\n') }
}

function stripDiffPrefix(p: string): string {
  if (!p) return ''
  // Drop a/ or b/ and any trailing tab-metadata.
  const noTab = p.split('\t')[0]
  if (noTab === '/dev/null') return '/dev/null'
  return noTab.replace(/^[ab]\//, '')
}

interface Hunk {
  newStart: number
  before: string[]
  after: string[]
}

function parseHunks(unifiedDiff: string): Hunk[] | null {
  const lines = (unifiedDiff || '').split('\n')
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  for (const ln of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln)
    if (m) {
      if (cur) hunks.push(cur)
      cur = { newStart: parseInt(m[1], 10), before: [], after: [] }
      continue
    }
    if (!cur) continue
    const tag = ln[0]
    const body = ln.slice(1)
    if (tag === '+') cur.after.push(body)
    else if (tag === '-') cur.before.push(body)
    else if (tag === '\\') continue // no-newline marker
    else if (tag === ' ') {
      cur.before.push(body)
      cur.after.push(body)
    } else if (ln === '') {
      // blank line inside hunk counts as context in both sides
      cur.before.push('')
      cur.after.push('')
    }
  }
  if (cur) hunks.push(cur)
  return hunks.length ? hunks : null
}

/**
 * Reverse-apply a file's unified diff against its CURRENT (after) full text to
 * reconstruct the full before text. The hunk's after-side lines (context + added)
 * MUST match the after file at the hunk position, otherwise the diff no longer
 * applies (drift / incomplete data) and we return null — never a guessed file.
 */
export function reverseApplyToBefore(afterText: string, unifiedDiff: string): string | null {
  const hunks = parseHunks(unifiedDiff)
  if (!hunks) return null
  // An empty file is zero lines, not one blank line. `''.split('\n')` yields
  // `['']`, which would corrupt a git delete (`@@ -n,m +0,0 @@`, after side empty).
  const afterLines = afterText === '' ? [] : afterText.split('\n')
  const before: string[] = []
  let cursor = 0 // 0-based index into afterLines
  for (const hunk of hunks) {
    // `+0,0` (pure delete) reports newStart 0 → the hunk inserts at position 0
    // with no after-side lines; clamp so start never goes negative.
    const start = hunk.newStart <= 0 ? 0 : hunk.newStart - 1
    if (start < cursor || start > afterLines.length) return null
    // copy unchanged region before the hunk
    for (let i = cursor; i < start; i++) before.push(afterLines[i])
    // walk the after-side against afterLines[start..], verifying each line
    let a = start
    for (const line of hunk.after) {
      if (afterLines[a] !== line) return null
      a++
    }
    // emit before-side
    for (const line of hunk.before) before.push(line)
    cursor = a
  }
  for (let i = cursor; i < afterLines.length; i++) before.push(afterLines[i])
  return before.join('\n')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class TurnArtifactStore {
  private readonly root: string
  private readonly now: () => number
  private manifestWrites = new Map<string, Promise<void>>()

  constructor(rootDir: string, private readonly opts?: {
    now?: () => number
    loadTurnChanges?: (sessionId: string, turnId: string) => Promise<{
      nativeThreadId: string; workdir: string; events: UAEvent[]
    } | null>
  }) {
    this.root = join(rootDir, `v${VERSION}`)
    this.now = opts?.now ?? Date.now
  }

  // ── collection / read ────────────────────────────────────────────────
  /** SDK forks replace message UUIDs. Publish copied snapshots atomically and retain rollback evidence. */
  async remapNativeTurns(sessionId: string, nativeThreadId: string, ids: Map<string, string>): Promise<() => Promise<void>> {
    await this.manifestWrites.get(sessionId)
    const original = await this.readManifest(sessionId)
    const turns: TurnArtifactSummary[] = []
    for (const summary of original.turns) {
      const nativeTurnId = ids.get(summary.nativeTurnId)
      if (!nativeTurnId) { turns.push(summary); continue }
      const artifact = await this.read(sessionId, summary.nativeTurnId)
      if (!artifact) throw new Error(`回合 ${summary.nativeTurnId} 的快照缺失，无法迁移分叉身份`)
      const copy = { ...artifact, nativeThreadId, nativeTurnId }
      await this.writeArtifact(copy)
      turns.push(toSummary(copy))
    }
    const write = (manifest: Manifest) => atomicWrite(this.manifestPath(sessionId), gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8')))
    await write({ ...original, turns })
    return () => write(original)
  }

  async finalize(input: FinalizeInput): Promise<TurnArtifactSummary> {
    const parsed = parseUnifiedDiffFiles(input.unifiedDiff)
    const files: TurnArtifactFile[] = parsed.length ? [] : await filesFromTurnChanges(input.fileChanges || [], input.workdir)
    for (const pf of parsed) {
      files.push(await this.snapshotFile(pf, input.workdir))
    }
    const state: ArtifactState = deriveState(files)
    const artifact: TurnArtifact = {
      version: VERSION,
      sessionId: input.sessionId,
      nativeThreadId: input.nativeThreadId,
      nativeTurnId: input.nativeTurnId,
      startSeq: input.startSeq,
      endSeq: input.endSeq,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      workdir: input.workdir,
      state,
      files,
      fileChangesCaptured: true
    }
    await this.writeArtifact(artifact)
    const summary = toSummary(artifact)
    await this.upsertManifest(input.sessionId, summary)
    return summary
  }

  async summary(sessionId: string, nativeTurnId: string): Promise<TurnArtifactSummary | null> {
    const manifest = await this.readManifest(sessionId)
    const summary = manifest.turns.find((turn) => turn.nativeTurnId === nativeTurnId)
    if (summary?.files.length) return summary
    const artifact = await this.read(sessionId, nativeTurnId)
    return artifact ? toSummary(artifact) : summary ?? null
  }

  async read(sessionId: string, nativeTurnId: string): Promise<TurnArtifact | null> {
    if (!safeSegment(sessionId) || !safeSegment(nativeTurnId)) return null
    let artifact: TurnArtifact | null = null
    try {
      const buf = await readFile(this.artifactPath(sessionId, nativeTurnId))
      const parsed = JSON.parse(gunzipSync(buf).toString('utf8'))
      if (parsed?.version === VERSION) artifact = parsed as TurnArtifact
    } catch {
      /* missing/legacy artifacts can still have recorded per-file patches */
    }
    if (artifact?.fileChangesCaptured || artifact?.files.length || !this.opts?.loadTurnChanges) return artifact
    const turn = await this.opts.loadTurnChanges(sessionId, nativeTurnId)
    if (!turn) return artifact
    const files = await filesFromTurnChanges(turn.events, turn.workdir)
    if (!files.length) return artifact
    // Read-only recovery: never manufacture historical full snapshots from the
    // current workspace. buildPlan uses this same read, so rewind stays blocked.
    return {
      version: VERSION, sessionId, nativeThreadId: turn.nativeThreadId, nativeTurnId,
      workdir: turn.workdir, startSeq: turn.events[0]?.seq ?? 0,
      endSeq: turn.events.at(-1)?.seq ?? 0, startedAt: turn.events[0]?.ts ?? 0,
      completedAt: turn.events.at(-1)?.ts ?? 0, ...artifact, state: 'patch-only', files
    }
  }

  async list(sessionId: string): Promise<TurnArtifactSummary[]> {
    return (await this.readManifest(sessionId)).turns
  }

  // ── snapshot one file: before via reverse-apply, hashes, reversibility ──
  private async snapshotFile(pf: ParsedFileDiff, workdir: string): Promise<TurnArtifactFile> {
    const base: TurnArtifactFile = {
      path: pf.path,
      oldPath: pf.oldPath,
      kind: pf.kind,
      added: pf.added,
      removed: pf.removed,
      unifiedDiff: pf.unifiedDiff,
      snapshotState: 'patch-only',
      reversible: false
    }
    // after side = current disk content (empty for a delete)
    let after = ''
    let afterMissing = false
    if (pf.kind === 'delete') {
      after = ''
    } else {
      const disk = await readConfinedFile(workdir, pf.path)
      if (disk === null) {
        // path escaped confinement or unreadable → keep patch-only, irreversible
        return base
      }
      if (disk.tooLarge) return { ...base, snapshotState: 'too-large' }
      if (disk.binary) return { ...base, snapshotState: 'binary' }
      if (disk.missing) {
        afterMissing = true
        after = ''
      } else {
        after = disk.text ?? ''
      }
    }
    // before side: pure add → '' ; else reverse-apply the diff onto after.
    let before: string
    if (pf.kind === 'add') {
      before = ''
    } else if (afterMissing) {
      // expected content is gone from disk → cannot verify reversibility
      return { ...base, snapshotState: 'missing' }
    } else {
      const reconstructed = reverseApplyToBefore(after, pf.unifiedDiff)
      if (reconstructed === null) {
        // A pure rename has no hunks: both paths contain the same full text.
        if (pf.kind !== 'rename' || /^@@/m.test(pf.unifiedDiff)) return base
        before = after
      } else {
        before = reconstructed
      }
    }
    const afterSha = pf.kind === 'delete' ? ABSENT : sha256(after)
    const beforeSha = pf.kind === 'add' ? ABSENT : sha256(before)
    return {
      ...base,
      before,
      after,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
      snapshotState: 'full',
      reversible: true
    }
  }

  // ── gzip atomic storage + manifest ────────────────────────────────────
  private artifactPath(sessionId: string, nativeTurnId: string): string {
    return join(this.root, sessionId, `${nativeTurnId}.json.gz`)
  }

  private manifestPath(sessionId: string): string {
    return join(this.root, sessionId, 'manifest.json.gz')
  }

  private async writeArtifact(artifact: TurnArtifact): Promise<void> {
    if (!safeSegment(artifact.sessionId) || !safeSegment(artifact.nativeTurnId)) {
      throw new Error('unsafe artifact id')
    }
    const gz = gzipSync(Buffer.from(JSON.stringify(artifact), 'utf8'))
    await atomicWrite(this.artifactPath(artifact.sessionId, artifact.nativeTurnId), gz)
  }

  private async readManifest(sessionId: string): Promise<Manifest> {
    if (!safeSegment(sessionId)) return { version: VERSION, sessionId, turns: [] }
    try {
      const buf = await readFile(this.manifestPath(sessionId))
      const parsed = JSON.parse(gunzipSync(buf).toString('utf8'))
      if (parsed?.version === VERSION && Array.isArray(parsed.turns)) return parsed as Manifest
    } catch {
      /* no manifest yet */
    }
    return { version: VERSION, sessionId, turns: [] }
  }

  private upsertManifest(sessionId: string, summary: TurnArtifactSummary): Promise<void> {
    const previous = this.manifestWrites.get(sessionId) || Promise.resolve()
    const write = previous.catch(() => undefined).then(() => this.writeManifestEntry(sessionId, summary))
      .finally(() => { if (this.manifestWrites.get(sessionId) === write) this.manifestWrites.delete(sessionId) })
    this.manifestWrites.set(sessionId, write)
    return write
  }

  private async writeManifestEntry(sessionId: string, summary: TurnArtifactSummary): Promise<void> {
    const manifest = await this.readManifest(sessionId)
    const idx = manifest.turns.findIndex((t) => t.nativeTurnId === summary.nativeTurnId)
    if (idx >= 0) manifest.turns[idx] = summary
    else manifest.turns.push(summary)
    // keep manifest ordered by startSeq (oldest → newest) for deterministic list()
    manifest.turns.sort((a, b) => a.startSeq - b.startSeq || a.startedAt - b.startedAt)
    const gz = gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8'))
    await atomicWrite(this.manifestPath(sessionId), gz)
  }

  // ── rewind (pure file transaction; never git reset) ───────────────────

  /**
   * Read-only preflight. removeTurnIds = target turn and everything after it
   * (newest→oldest order for reverse application). Allowed only when every
   * affected file across those turns is reversible AND its current on-disk
   * content still matches the newest turn's recorded `after` (no external drift).
   */
  async previewRewind(
    sessionId: string,
    targetTurnId: string,
    expectedWorkdir?: string
  ): Promise<RewindPreview> {
    const plan = await this.buildPlan(sessionId, targetTurnId, expectedWorkdir)
    if (!plan.ok) return { allowed: false, reason: plan.reason, removeTurnIds: [], files: [] }
    const files = plan.targets.map((t) => ({ path: t.path, kind: t.kind, reversible: t.reversible }))
    if (!plan.reversible) {
      return { allowed: false, reason: plan.reason, removeTurnIds: plan.removeTurnIds, files }
    }
    const drift = await this.detectDrift(plan)
    if (drift) {
      return { allowed: false, reason: drift, removeTurnIds: plan.removeTurnIds, files }
    }
    return { allowed: true, removeTurnIds: plan.removeTurnIds, files }
  }

  /**
   * Execute the rewind as an atomic file transaction:
   *   1. rebuild + re-verify the plan (never trust a stale preview)
   *   2. re-check live drift
   *   3. back up every target file's current bytes in memory
   *   4. write each target's reconstructed `before` via same-dir temp+rename
   *      (delete for files that must return to absent)
   *   5. on ANY write failure, restore all files from the backups → no partial state
   */
  async applyRewind(
    sessionId: string,
    targetTurnId: string,
    expectedWorkdir?: string
  ): Promise<RewindResult> {
    const plan = await this.buildPlan(sessionId, targetTurnId, expectedWorkdir)
    if (!plan.ok) return { ok: false, error: plan.reason }
    if (!plan.reversible) return { ok: false, error: plan.reason ?? '存在无法回退的文件' }
    const drift = await this.detectDrift(plan)
    if (drift) return { ok: false, error: drift }

    const backups: Array<{ path: string; existed: boolean; bytes: Buffer | null }> = []
    const restored: string[] = []
    try {
      for (const t of plan.targets) {
        const backup = await backupFile(plan.workdir, t.path)
        if (backup === null) return { ok: false, error: `无法备份文件：${t.path}` }
        const expected = t.lastAfterAbsent ? ABSENT : t.lastAfterSha256
        if (backupSha(backup) !== expected) {
          return { ok: false, error: `文件在写入前又被修改，未执行回退：${t.path}` }
        }
        backups.push(backup)
      }
      const changed: FileBackup[] = []
      for (let i = 0; i < plan.targets.length; i++) {
        const t = plan.targets[i]
        // Verify the exact bytes backed up are still at the path immediately
        // before replacing them. No stale preview/backup may authorize a write.
        const live = await backupFile(plan.workdir, t.path)
        if (live === null || backupSha(live) !== backupSha(backups[i])) {
          return await rollback(changed, plan.workdir, `文件在写入前又被修改，未执行回退：${t.path}`)
        }
        const ok = t.targetAbsent
          ? await removeConfined(plan.workdir, t.path)
          : await writeConfined(plan.workdir, t.path, t.beforeText ?? '')
        if (!ok) {
          return await rollback(backups.slice(0, i + 1), plan.workdir, `写入失败：${t.path}`)
        }
        changed.push(backups[i])
        restored.push(t.path)
      }
      // Hand the caller a rollback closure so a LATER step (native fork / session
      // persistence) that fails can atomically restore every file to its pre-rewind
      // bytes — the file transaction is only truly committed once the orchestrator
      // confirms the session switch (proposal §6.4/§6.5).
      const workdir = plan.workdir
      const rollbackFiles = async (): Promise<void> => {
        const drift = await targetsMatchRewoundState(workdir, plan.targets)
        if (drift) throw new Error(drift)
        const failures = await restoreBackups(backups, workdir)
        if (failures.length) throw new Error(`文件恢复失败：${failures.join('、')}`)
      }
      return { ok: true, restored, rollback: rollbackFiles }
    } catch (err: any) {
      return await rollback(backups, plan.workdir, `回退异常：${err?.message || err}`)
    }
  }

  /**
   * 需求3 (proposal §6.5) — after a rewind commits, drop the removed range
   * (target..newest) from the manifest and delete their artifact blobs so the
   * frozen snapshots for truncated turns don't linger. Best-effort: a stale blob
   * is harmless (it's no longer referenced by the manifest). Pre-target artifacts
   * are always kept as the original-thread recovery basis.
   */
  async trimFrom(sessionId: string, targetTurnId: string): Promise<void> {
    if (!safeSegment(sessionId)) return
    const manifest = await this.readManifest(sessionId)
    const targetIdx = manifest.turns.findIndex((t) => t.nativeTurnId === targetTurnId)
    if (targetIdx < 0) return
    const removed = manifest.turns.slice(targetIdx)
    manifest.turns = manifest.turns.slice(0, targetIdx)
    const gz = gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8'))
    await atomicWrite(this.manifestPath(sessionId), gz)
    for (const s of removed) {
      if (!safeSegment(s.nativeTurnId)) continue
      await rm(this.artifactPath(sessionId, s.nativeTurnId), { force: true }).catch(() => {})
    }
  }

  /**
   * Collect target turns (target..newest) and resolve each affected file's final
   * pre-target `before` state by walking turns oldest→newest per file: the first
   * turn that touched a file carries the state to restore. Verifies the hash chain
   * (each turn's before == previous turn's after for the same file).
   */
  private async buildPlan(
    sessionId: string,
    targetTurnId: string,
    expectedWorkdir?: string
  ): Promise<Plan> {
    const all = await this.list(sessionId)
    const targetIdx = all.findIndex((t) => t.nativeTurnId === targetTurnId)
    if (targetIdx < 0) return { ok: false, reason: '找不到目标轮的回退快照' }
    const removeSummaries = all.slice(targetIdx) // oldest→newest of removed range
    const removeTurnIds = removeSummaries.map((s) => s.nativeTurnId)
    // load full artifacts (with snapshots) for the removed range
    const arts: TurnArtifact[] = []
    let workdir = ''
    for (const s of removeSummaries) {
      const art = await this.read(sessionId, s.nativeTurnId)
      if (!art) return { ok: false, reason: `第 ${s.nativeTurnId} 轮缺少回退快照` }
      if (s.sessionId !== sessionId || art.sessionId !== sessionId ||
          art.nativeTurnId !== s.nativeTurnId) {
        return { ok: false, reason: `第 ${s.nativeTurnId} 轮的回退快照身份不匹配` }
      }
      if ((workdir && resolve(workdir) !== resolve(art.workdir)) ||
          (expectedWorkdir && resolve(expectedWorkdir) !== resolve(art.workdir))) {
        return { ok: false, reason: `第 ${s.nativeTurnId} 轮的工作目录不匹配` }
      }
      arts.push(art)
      if (art.workdir) workdir = art.workdir
    }
    if (!workdir) return { ok: false, reason: '缺少工作目录，无法回退' }

    // Per file: first-touch before (target state) + last-touch after (drift check).
    // Walk oldest→newest so `first` set once = earliest recorded before.
    // A rename is expanded into two effects — add(newPath) + delete(oldPath) — so
    // reverting removes the new path and restores the old path's content, and the
    // hash chain reuses the same add/delete logic as any other file.
    const byPath = new Map<string, PlanTarget>()
    let reversible = true
    let reason = ''
    for (const art of arts) {
      for (const f of art.files) {
        for (const eff of expandFileEffects(f)) {
          if (!eff.reversible) {
            reversible = false
            reason = `第 ${art.nativeTurnId} 轮的 ${eff.path} 无完整补丁，无法同时回退对话与文件`
          }
          const key = eff.path
          const existing = byPath.get(key)
          if (!existing) {
            byPath.set(key, {
              path: eff.path,
              kind: eff.kind,
              reversible: eff.reversible,
              beforeText: eff.beforeAbsent ? undefined : eff.beforeText,
              beforeSha256: eff.beforeSha256,
              targetAbsent: eff.beforeAbsent,
              lastAfterText: eff.afterAbsent ? undefined : eff.afterText,
              lastAfterSha256: eff.afterSha256,
              lastAfterAbsent: eff.afterAbsent
            })
          } else {
            // hash-chain: this effect's before must equal the previous after we saw.
            if (existing.reversible && eff.reversible) {
              const prevAfter = existing.lastAfterAbsent ? ABSENT : existing.lastAfterSha256
              const thisBefore = eff.beforeAbsent ? ABSENT : eff.beforeSha256
              if (prevAfter && thisBefore && prevAfter !== thisBefore) {
                reversible = false
                reason = `第 ${art.nativeTurnId} 轮的 ${eff.path} 补丁链不连续，无法安全回退`
              }
            }
            existing.reversible = existing.reversible && eff.reversible
            existing.lastAfterText = eff.afterAbsent ? undefined : eff.afterText
            existing.lastAfterSha256 = eff.afterSha256
            existing.lastAfterAbsent = eff.afterAbsent
          }
        }
      }
    }
    const targets = [...byPath.values()]
    return {
      ok: true,
      reason: reason || undefined,
      reversible,
      workdir,
      removeTurnIds,
      targets
    }
  }

  /** Verify the current disk content still matches the last recorded `after`. */
  private async detectDrift(plan: PlanReady): Promise<string | null> {
    for (const t of plan.targets) {
      const disk = await readConfinedFile(plan.workdir, t.path)
      if (disk === null) return `文件路径不安全或不可读：${t.path}`
      const liveSha = t.lastAfterAbsent
        ? (disk.missing ? ABSENT : sha256(disk.text ?? ''))
        : disk.missing ? ABSENT : (disk.binary || disk.tooLarge ? null : sha256(disk.text ?? ''))
      const expected = t.lastAfterAbsent ? ABSENT : t.lastAfterSha256
      if (liveSha === null) return `文件无法校验（二进制或过大）：${t.path}`
      if (expected && liveSha !== expected) {
        return `文件在本轮结束后又被修改，未执行回退：${t.path}`
      }
    }
    return null
  }
}

interface PlanTarget {
  path: string
  kind: FileKind
  reversible: boolean
  beforeText?: string
  beforeSha256?: string
  targetAbsent: boolean
  lastAfterText?: string
  lastAfterSha256?: string
  lastAfterAbsent: boolean
}

/**
 * One file effect on ONE path, normalized so add/delete/modify/rename all share
 * the plan's before/after chain logic. A rename becomes two effects: the new path
 * is an add (revert → remove it) and the old path is a delete (revert → restore
 * its content), so reverting a rename removes the new file and brings the old one
 * back. Non-rename kinds map to a single effect on their own path.
 */
interface FileEffect {
  path: string
  kind: FileKind
  reversible: boolean
  beforeText?: string
  beforeSha256?: string
  beforeAbsent: boolean
  afterText?: string
  afterSha256?: string
  afterAbsent: boolean
}

function expandFileEffects(f: TurnArtifactFile): FileEffect[] {
  if (f.kind === 'rename' && f.oldPath) {
    return [
      // new path: appeared this turn (before absent → after = current content)
      {
        path: f.path,
        kind: 'add',
        reversible: f.reversible,
        beforeAbsent: true,
        beforeSha256: ABSENT,
        afterText: f.after,
        afterSha256: f.afterSha256,
        afterAbsent: false
      },
      // old path: removed this turn (before = pre-rename content → after absent)
      {
        path: f.oldPath,
        kind: 'delete',
        reversible: f.reversible,
        beforeText: f.before,
        beforeSha256: f.beforeSha256,
        beforeAbsent: false,
        afterAbsent: true,
        afterSha256: ABSENT
      }
    ]
  }
  return [
    {
      path: f.path,
      kind: f.kind,
      reversible: f.reversible,
      beforeText: f.kind === 'add' ? undefined : f.before,
      beforeSha256: f.beforeSha256,
      beforeAbsent: f.kind === 'add',
      afterText: f.kind === 'delete' ? undefined : f.after,
      afterSha256: f.afterSha256,
      afterAbsent: f.kind === 'delete'
    }
  ]
}

type Plan =
  | { ok: false; reason: string }
  | PlanReady

interface PlanReady {
  ok: true
  reason?: string
  reversible: boolean
  workdir: string
  removeTurnIds: string[]
  targets: PlanTarget[]
}

// ── shared helpers ────────────────────────────────────────────────────

function deriveState(files: TurnArtifactFile[]): ArtifactState {
  if (!files.length) return 'ready'
  if (files.every((f) => f.snapshotState === 'full')) return 'ready'
  if (files.some((f) => f.snapshotState === 'full')) return 'incomplete'
  return 'patch-only'
}

function toSummary(a: TurnArtifact): TurnArtifactSummary {
  return {
    sessionId: a.sessionId,
    nativeThreadId: a.nativeThreadId,
    nativeTurnId: a.nativeTurnId,
    startSeq: a.startSeq,
    endSeq: a.endSeq,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    state: a.state,
    files: a.files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      kind: f.kind,
      added: f.added,
      removed: f.removed,
      reversible: f.reversible,
      snapshotState: f.snapshotState
    }))
  }
}

/** A path segment used as a directory/file name: reject separators & traversal. */
function safeSegment(seg: string): boolean {
  return typeof seg === 'string' && seg.length > 0 && seg.length < 256 &&
    !seg.includes('\0') && !seg.includes('/') && !seg.includes('\\') &&
    seg !== '.' && seg !== '..'
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

interface ConfinedRead {
  text?: string
  binary?: true
  tooLarge?: true
  missing?: true
}

interface FileBackup { path: string; existed: boolean; bytes: Buffer | null }

/**
 * Read a workdir-relative file with the same confinement as reviewFiles: reject
 * absolute/../ paths, open no-follow, recheck the directory-chain and leaf inode
 * before returning bytes. Returns null when the path escapes confinement.
 * `missing:true` (not null) is a legitimate "file does not exist" result.
 */
async function readConfinedFile(workdir: string, requestedPath: string): Promise<ConfinedRead | null> {
  const normalized = normalizeRelativePath(requestedPath)
  if (!workdir || !normalized) return null
  let root: string
  let candidate: string
  try {
    root = await realpath(resolve(workdir))
    candidate = join(root, ...normalized.split('/'))
  } catch {
    return null
  }
  try {
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
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(0)) return { binary: true }
      return { text: bytes.toString('utf8') }
    } finally {
      await handle.close()
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // File absent — but the parent chain must still be confined.
      try {
        await directoryIdentities(root, dirname(candidate))
        return { missing: true }
      } catch {
        return null
      }
    }
    if (err?.message === 'outside_root' || err?.message === 'unsafe_path') return null
    return null
  }
}

async function backupFile(
  workdir: string,
  path: string
): Promise<FileBackup | null> {
  const disk = await readConfinedFile(workdir, path)
  if (disk === null) return null
  if (disk.missing) return { path, existed: false, bytes: null }
  if (disk.binary || disk.tooLarge) return null // refuse to rewind un-snapshotted content
  return { path, existed: true, bytes: Buffer.from(disk.text ?? '', 'utf8') }
}

async function writeConfined(workdir: string, path: string, text: string): Promise<boolean> {
  try {
    const target = await confinedTarget(workdir, path)
    if (!target) return false
    const before = await directoryIdentities(target.root, dirname(target.path))
    await atomicWrite(target.path, Buffer.from(text, 'utf8'))
    const after = await directoryIdentities(target.root, dirname(target.path))
    return sameIdentities(before, after)
  } catch {
    return false
  }
}

async function removeConfined(workdir: string, path: string): Promise<boolean> {
  try {
    const target = await confinedTarget(workdir, path)
    if (!target) return false
    const before = await directoryIdentities(target.root, dirname(target.path))
    await rm(target.path, { force: true })
    const after = await directoryIdentities(target.root, dirname(target.path))
    return sameIdentities(before, after)
  } catch {
    return false
  }
}

/** Resolve a confined absolute target for writing; null if it escapes root. */
async function confinedTarget(
  workdir: string,
  requestedPath: string
): Promise<{ root: string; path: string } | null> {
  const normalized = normalizeRelativePath(requestedPath)
  if (!workdir || !normalized) return null
  let root: string
  try {
    root = await realpath(resolve(workdir))
  } catch {
    return null
  }
  const candidate = join(root, ...normalized.split('/'))
  const fromRoot = relative(root, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null
  try {
    await directoryIdentities(root, dirname(candidate))
  } catch {
    return null
  }
  return { root, path: candidate }
}

function backupSha(backup: FileBackup): string {
  return backup.existed && backup.bytes ? sha256(backup.bytes.toString('utf8')) : ABSENT
}

async function restoreBackups(backups: FileBackup[], workdir: string): Promise<string[]> {
  const failures: string[] = []
  for (const b of backups) {
    const ok = b.existed && b.bytes
      ? await writeConfined(workdir, b.path, b.bytes.toString('utf8'))
      : await removeConfined(workdir, b.path)
    if (!ok) failures.push(b.path)
  }
  return failures
}

async function targetsMatchRewoundState(
  workdir: string,
  targets: PlanTarget[]
): Promise<string | null> {
  for (const target of targets) {
    const current = await backupFile(workdir, target.path)
    const expected = target.targetAbsent ? ABSENT : target.beforeSha256
    if (!current || backupSha(current) !== expected) {
      return `文件在回退后又被修改，未覆盖该修改：${target.path}`
    }
  }
  return null
}

async function rollback(
  backups: FileBackup[],
  workdir: string,
  error: string
): Promise<RewindResult> {
  const failures = await restoreBackups(backups, workdir)
  return {
    ok: false,
    error: failures.length ? `${error}；文件恢复失败：${failures.join('、')}` : error
  }
}

interface PathIdentity { dev: number; ino: number }

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
    left.every((id, i) => id.dev === right[i]?.dev && id.ino === right[i]?.ino)
}
