import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { UAEvent } from '../shared/types'
import type { TurnArtifactFile } from './turnArtifacts'

const execFileP = promisify(execFile)
const MAX_BYTES = 1.5 * 1024 * 1024
const MAX_LINES = 100_000
type Line = { text?: string }
type Change = { path: string; oldPath?: string; kind: string; diff?: string }

/** Only successful, turn-attributed edits are evidence; never inspect the workspace. */
export async function filesFromTurnChanges(
  events: readonly UAEvent[], workdir: string
): Promise<TurnArtifactFile[]> {
  const latest = new Map<unknown, UAEvent>()
  for (const event of events) {
    if (event.type === 'file_change') latest.set(event.payload?.id ?? event, event)
  }
  const byPath = new Map<string, Change[]>()
  for (const event of latest.values()) {
    if (event.state !== 'success' || !Array.isArray(event.payload?.changes)) continue
    for (const raw of event.payload.changes) {
      const path = relativeChangePath(raw?.path, workdir)
      if (!path) continue
      const movePath = raw.movePath == null ? undefined : relativeChangePath(raw.movePath, workdir)
      if (raw.movePath != null && !movePath) continue
      const target = movePath || path
      const changes = byPath.get(path) || []
      if (target !== path) byPath.delete(path)
      changes.push({ path: target, oldPath: movePath ? path : undefined, kind: raw.kind, diff: raw.diff })
      byPath.set(target, changes)
    }
  }
  const files: TurnArtifactFile[] = []
  for (const [path, changes] of byPath) {
    const first = changes[0]
    const last = changes[changes.length - 1]
    const oldPath = changes.find((change) => change.oldPath)?.oldPath
    const kind = first.kind === 'add' && last.kind !== 'delete' ? 'add'
      : last.kind === 'delete' ? 'delete' : oldPath ? 'rename' : 'modify'
    const file: TurnArtifactFile = {
      path, oldPath, kind, added: 0, removed: 0, unifiedDiff: '',
      snapshotState: 'patch-only', reversible: false
    }
    // ponytail: patch-only fallback, not a rewind snapshot. Capture full before/after
    // at execution time if these providers need safe file rewind support.
    try {
      const pair = composeChanges(changes)
      const diff = await diffRecordedLines(pair.before, pair.after)
      if (!diff && (kind === 'modify' || (first.kind === 'add' && last.kind === 'delete'))) continue
      file.unifiedDiff = `diff --git a/${oldPath || path} b/${path}\n` +
        (kind === 'rename' ? `rename from ${oldPath}\nrename to ${path}\n` : '') +
        `--- ${kind === 'add' ? '/dev/null' : `a/${oldPath || path}`}\n` +
        `+++ ${kind === 'delete' ? '/dev/null' : `b/${path}`}\n` + diff
      for (const line of diff.split('\n')) {
        if (line.startsWith('+')) file.added++
        else if (line.startsWith('-')) file.removed++
      }
    } catch {
      // Missing, inconsistent, binary or oversized patches still prove the file
      // was touched, but do not justify invented content or a reversible snapshot.
    }
    files.push(file)
  }
  return files
}

function relativeChangePath(value: unknown, workdir: string): string | null {
  if (typeof value !== 'string' || !value || /[\0\r\n\t]/.test(value)) return null
  if (value.split(/[\\/]/).includes('..')) return null
  const path = isAbsolute(value) ? relative(resolve(workdir), value) : value
  if (!path || isAbsolute(path) || win32.isAbsolute(path)) return null
  const parts = path.split(sep).filter((part) => part && part !== '.')
  return parts.includes('..') ? null : parts.join('/') || null
}

/** Unknown context retains shared identity; later patches fill it, never read it from disk. */
function composeChanges(changes: Change[]): { before: Line[]; after: Line[] } {
  const before: Line[] = []
  const after: Line[] = []
  let complete = false
  let bytes = 0
  for (const change of changes) {
    if (typeof change.diff !== 'string' || change.diff.includes('\0')) throw new Error('missing_patch')
    bytes += Buffer.byteLength(change.diff)
    if (bytes > MAX_BYTES) throw new Error('patch_too_large')
    const fullContent = change.kind === 'add' || change.kind === 'delete'
    if (fullContent) {
      // Native add/delete diff fields hold raw file content, not unified diffs.
      const lines = change.diff.match(/[^\n]*\n|[^\n]+$/g) || []
      if (lines.length > MAX_LINES) throw new Error('patch_too_large')
      if (change.kind === 'add') {
        if (after.length) throw new Error('inconsistent_add')
        after.push(...lines.map((text) => ({ text })))
      } else {
        extend(lines.length)
        if (after.length !== lines.length) throw new Error('inconsistent_delete')
        lines.forEach((text, index) => bind(after[index], text))
        after.length = 0
      }
      complete = true
      continue
    }
    const hunks = parsePatch(change.diff)
    let offset = 0
    let previousEnd = 0
    for (const hunk of hunks) {
      const start = hunk.oldStart + offset
      if (hunk.oldStart < previousEnd || start !== hunk.newStart) throw new Error('inconsistent_hunks')
      extend(start + hunk.removed)
      let cursor = start
      const replacement: Line[] = []
      for (const line of hunk.lines) {
        if (line.tag === '+') replacement.push({ text: line.text })
        else {
          const original = after[cursor++]
          bind(original, line.text)
          if (line.tag === ' ') replacement.push(original)
        }
      }
      if (after.length - hunk.removed + replacement.length > MAX_LINES) throw new Error('patch_too_large')
      after.splice(start, hunk.removed, ...replacement)
      offset += hunk.added - hunk.removed
      previousEnd = hunk.oldStart + hunk.removed
    }
  }
  return { before, after }

  function extend(length: number): void {
    if (length > MAX_LINES || (complete && length > after.length)) throw new Error('invalid_patch_extent')
    while (after.length < length) {
      const line: Line = {}
      before.push(line)
      after.push(line)
    }
  }
}

function bind(line: Line, text: string): void {
  if (!line || (line.text !== undefined && line.text !== text)) throw new Error('inconsistent_patch')
  line.text = text
}

function parsePatch(diff: string) {
  const hunks: Array<{ oldStart: number; newStart: number; removed: number; added: number; lines: Array<{ tag: string; text: string }> }> = []
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      const removed = Number(header[2] ?? 1), added = Number(header[4] ?? 1)
      hunks.push({
        oldStart: Number(header[1]) - (removed ? 1 : 0),
        newStart: Number(header[3]) - (added ? 1 : 0), removed, added, lines: []
      })
      continue
    }
    const hunk = hunks[hunks.length - 1]
    if (!hunk) continue
    if (line === '\\ No newline at end of file') {
      const last = hunk.lines[hunk.lines.length - 1]
      if (!last?.text.endsWith('\n')) throw new Error('invalid_newline_marker')
      last.text = last.text.slice(0, -1)
    } else if (/^[ +\-]/.test(line)) hunk.lines.push({ tag: line[0], text: line.slice(1) + '\n' })
    else if (line) throw new Error('invalid_patch_line')
  }
  if (!hunks.length) throw new Error('missing_hunks')
  for (const hunk of hunks) {
    if (hunk.oldStart < 0 || hunk.newStart < 0 ||
        hunk.lines.filter((line) => line.tag !== '+').length !== hunk.removed ||
        hunk.lines.filter((line) => line.tag !== '-').length !== hunk.added) throw new Error('invalid_hunk')
  }
  return hunks
}

async function diffRecordedLines(before: Line[], after: Line[]): Promise<string> {
  const marker = `uniagent-unknown-${randomUUID()}-`
  const unknown = new Map<Line, string>()
  const text = (lines: Line[]): string => lines.map((line) => {
    if (line.text !== undefined) return line.text
    if (!unknown.has(line)) unknown.set(line, `${marker}${unknown.size}\n`)
    return unknown.get(line)!
  }).join('')
  const root = await mkdtemp(join(tmpdir(), 'uniagent-turn-diff-'))
  try {
    await Promise.all([writeFile(join(root, 'before'), text(before)), writeFile(join(root, 'after'), text(after))])
    // Git is already used by review; --no-index compares only these recorded
    // snippets, and zero context excludes all unknown unchanged lines.
    const { stdout } = await execFileP('git', [
      'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--no-renames',
      '--no-indent-heuristic', '--diff-algorithm=myers', '--inter-hunk-context=0', '--unified=0', '--', 'before', 'after'
    ], { cwd: root, maxBuffer: 8 * MAX_BYTES, timeout: 10_000 }).catch((error) => {
      if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }
      throw error
    })
    const start = stdout.indexOf('@@ ')
    if (start < 0) return ''
    const diff = stdout.slice(start).replace(/^(@@ .*? @@).*$/gm, '$1')
    if (diff.includes(marker)) throw new Error('unknown_context_in_diff')
    return diff
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
