import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { NativeSessionOccupancy } from '../shared/types'
import { resolveNativeSessionFile } from './history'
import { runtimeDiagnosticSample } from './diagnostics'

const execFileP = promisify(execFile)
const LSOF_PATH = '/usr/sbin/lsof'
const PS_PATH = '/bin/ps'
const nativeFileCache = new Map<string, string>()

/** Only writable descriptors can conflict with a send; history readers cannot. */
export function lsofWritableProcessIds(output: string): number[] | undefined {
  const ids = new Set<number>()
  let pid: number | undefined
  let awaitingAccess = false
  let hasAccess = false
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('p')) {
      if (awaitingAccess || (pid !== undefined && !hasAccess)) return undefined
      pid = Number(line.slice(1))
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
      hasAccess = false
    } else if (line.startsWith('f')) {
      if (pid === undefined || awaitingAccess || line.length === 1) return undefined
      awaitingAccess = true
    } else if (line.startsWith('a')) {
      if (pid === undefined || !awaitingAccess || !/^a[rwu]$/.test(line)) return undefined
      if (line !== 'ar') ids.add(pid)
      awaitingAccess = false
      hasAccess = true
    } else if (!line.startsWith('c') || pid === undefined) {
      return undefined
    }
  }
  if (awaitingAccess || (pid !== undefined && !hasAccess)) return undefined
  return [...ids]
}

function processParents(output: string): Map<number, number> | undefined {
  const parents = new Map<number, number>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
    if (!match) return undefined
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    if (
      !Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(parentPid) || parentPid < 0
    ) return undefined
    parents.set(pid, parentPid)
  }
  return parents
}

function belongsToProcessRoot(
  pid: number,
  roots: ReadonlySet<number>,
  parents: ReadonlyMap<number, number>
): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const visited = new Set<number>()
  let current = pid
  while (true) {
    if (roots.has(current)) return true
    if (current <= 1) return false
    if (visited.has(current)) return undefined
    visited.add(current)
    const parent = parents.get(current)
    if (parent === undefined) return undefined
    current = parent
  }
}

/** True when at least one holder is outside the supplied runner process trees. */
export function hasExternalProcessHolder(
  holderPids: Iterable<number>,
  ignoredProcessRoots: ReadonlySet<number>,
  parents: ReadonlyMap<number, number>
): boolean | undefined {
  let unresolved = false
  for (const pid of holderPids) {
    const owned = belongsToProcessRoot(pid, ignoredProcessRoots, parents)
    if (owned === false) return true
    if (owned === undefined) unresolved = true
  }
  return unresolved ? undefined : false
}

export async function inspectNativeSessionOccupancy(
  agentId: string,
  nativeSessionId: string | undefined,
  ignoredProcessRoots: Iterable<number | undefined> = [],
  report?: (sample: Record<string, unknown>) => void
): Promise<NativeSessionOccupancy> {
  const startedAt = Date.now()
  const ignoredRoots = new Set(
    [...ignoredProcessRoots].filter(
      (pid): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
    )
  )
  const evidence: Record<string, unknown> = { ignoredProcessRoots: [...ignoredRoots] }
  let historyVersion: string | undefined
  const finish = (state: NativeSessionOccupancy['state'], reason: string, error?: unknown): NativeSessionOccupancy => {
    const result = { state, checkedAt: Date.now(), ...(historyVersion ? { historyVersion } : {}) }
    report?.({
      ...evidence, ...result, reason, durationMs: Date.now() - startedAt,
      ...(error ? runtimeDiagnosticSample(error) : {})
    })
    return result
  }
  if (
    (agentId !== 'codex' && agentId !== 'traex') ||
    !nativeSessionId
  ) return finish('unsupported', 'no_native_identity')

  const cacheKey = `${agentId}:${nativeSessionId}`
  let file = nativeFileCache.get(cacheKey)
  if (file && !existsSync(file)) {
    nativeFileCache.delete(cacheKey)
    file = undefined
  }
  try {
    if (!file) {
      file = await resolveNativeSessionFile(agentId, nativeSessionId) || undefined
      if (file) nativeFileCache.set(cacheKey, file)
    }
    if (!file) return finish('unsupported', 'native_file_not_found')
    evidence.file = file
    const info = await stat(file)
    historyVersion = `${file}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  } catch (error) {
    return finish('unsupported', 'native_file_unreadable', error)
  }
  if (process.platform !== 'darwin') return finish('unsupported', 'unsupported_platform')
  let stdout = ''
  try {
    const result = await execFileP(LSOF_PATH, ['-Fpcfa', '--', file], {
      timeout: 2_000,
      maxBuffer: 64 * 1024
    })
    stdout = result.stdout
  } catch (error: any) {
    // lsof exits 1 when no process currently holds the file.
    if (error?.code === 1 && !error?.stdout && !error?.stderr?.trim() && !error?.killed) {
      return finish('available', 'no_holders')
    }
    evidence.lsof = error?.stdout
    evidence.stderr = error?.stderr
    return finish('unsupported', 'lsof_failed', error)
  }

  evidence.lsof = stdout
  const pids = lsofWritableProcessIds(stdout)
  if (!pids) return finish('unsupported', 'unknown_file_access')
  evidence.writablePids = pids
  if (!pids.length) return finish('available', 'no_writable_holders')
  if (pids.every((pid) => ignoredRoots.has(pid))) {
    return finish('available', 'owned_writers')
  }

  let parents: Map<number, number> | undefined
  try {
    const result = await execFileP(PS_PATH, ['-axo', 'pid=,ppid='], {
      timeout: 2_000,
      maxBuffer: 512 * 1024
    })
    parents = processParents(result.stdout)
  } catch (error) {
    return finish('unsupported', 'ps_failed', error)
  }
  if (!parents) return finish('unsupported', 'invalid_process_tree')
  const ancestry = new Map<number, number>()
  for (let pid of pids) {
    while (parents.has(pid) && !ancestry.has(pid)) {
      const parent = parents.get(pid)!
      ancestry.set(pid, parent)
      pid = parent
    }
  }
  evidence.parents = Object.fromEntries(ancestry)
  const hasExternalHolder = hasExternalProcessHolder(pids, ignoredRoots, parents)
  if (hasExternalHolder === undefined) return finish('unsupported', 'unresolved_process_tree')
  return hasExternalHolder
    ? finish('occupied', 'external_writer')
    : finish('available', 'owned_writers')
}
