// Shared acceptance-process isolation helpers for the packaged-app CDP verifiers.
// Extracted from the former provider-specific acceptance helper: these utilities are
// provider-agnostic and only ever signal processes this verifier itself spawned.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export function parseProcessIdentityWithoutCommand(line) {
  const match =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(
      line
    )
  if (!match) return undefined
  const [pid, ppid, uid, pgid] = match.slice(1, 5).map(Number)
  if (
    ![pid, ppid, uid, pgid].every(Number.isSafeInteger) ||
    pid <= 0 ||
    ppid < 0 ||
    uid < 0 ||
    pgid <= 0
  ) {
    return undefined
  }
  return {
    pid,
    ppid,
    uid,
    pgid,
    startTime: `${match[5]} ${match[6]} ${match[7]} ${match[8]} ${match[9]}`
  }
}

export function sameAcceptanceProcessIdentity(left, right) {
  return left.pid === right.pid && left.uid === right.uid && left.startTime === right.startTime
}

export async function scanAcceptanceProcessIdentities() {
  const { stdout } = await execFileP(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,uid=,pgid=,lstart='],
    {
      encoding: 'utf8',
      env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000
    }
  )
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const processes = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const identity = parseProcessIdentityWithoutCommand(line)
    if (!identity) throw new Error(`unable to parse process identity: ${line.slice(0, 240)}`)
    if (uid === undefined || identity.uid === uid) processes.push(identity)
  }
  return processes
}

export async function inspectAcceptanceProcessIdentity(pid) {
  try {
    const { stdout } = await execFileP(
      '/bin/ps',
      ['-p', String(pid), '-o', 'pid=,ppid=,uid=,pgid=,lstart='],
      {
        encoding: 'utf8',
        env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        maxBuffer: 1024 * 1024,
        timeout: 5_000
      }
    )
    let found
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const parsed = parseProcessIdentityWithoutCommand(line)
      if (!parsed) throw new Error(`unable to parse process identity: ${line.slice(0, 240)}`)
      if (parsed.pid === pid) found = parsed
    }
    return found
  } catch (error) {
    const processMissing =
      (error?.code === 1 || error?.status === 1) &&
      !String(error?.stdout || '').trim() &&
      !String(error?.stderr || '').trim()
    if (processMissing) return undefined
    throw error
  }
}

function processDepth(identity, byPid) {
  let depth = 0
  let cursor = identity
  const seen = new Set([cursor.pid])
  while (byPid.has(cursor.ppid) && !seen.has(cursor.ppid)) {
    cursor = byPid.get(cursor.ppid)
    seen.add(cursor.pid)
    depth += 1
  }
  return depth
}

async function captureRootIdentity(pid, expectedUid) {
  const identity = await inspectAcceptanceProcessIdentity(pid)
  if (!identity) throw new Error(`acceptance process ${pid} disappeared before ownership capture`)
  if (expectedUid !== undefined) assert.equal(identity.uid, expectedUid, 'acceptance process uid mismatch')
  return identity
}

export function createAcceptanceProcessSweeper({
  roots = [],
  includeCurrentProcessDescendants = false,
  includePgid = true,
  scanIntervalMs = 100,
  termGraceMs = 1_500,
  killDeadlineMs = 10_000,
  emptyScans = 3
} = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const rootIdentities = new Map()
  const retainedIdentities = new Map()

  async function addRoot(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'root pid must be positive')
    if (pid === process.pid || rootIdentities.has(pid)) return
    rootIdentities.set(pid, await captureRootIdentity(pid, uid))
  }
  for (const pid of [...roots, ...(includeCurrentProcessDescendants ? [process.pid] : [])]) {
    if (Number.isSafeInteger(pid) && pid > 0) {
      rootIdentities.set(pid, undefined)
    }
  }

  async function ensureRootsCaptured() {
    for (const [pid, identity] of [...rootIdentities]) {
      if (identity) continue
      try {
        rootIdentities.set(pid, await captureRootIdentity(pid, uid))
      } catch {
        rootIdentities.delete(pid)
      }
    }
  }

  async function ownedProcesses() {
    await ensureRootsCaptured()
    const snapshot = await scanAcceptanceProcessIdentities()
    const liveByPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
    const owned = new Map()
    const rootValues = [...rootIdentities.values()].filter(Boolean)
    for (const root of rootValues) {
      const live = liveByPid.get(root.pid)
      if (live && sameAcceptanceProcessIdentity(live, root)) owned.set(live.pid, live)
    }
    for (const [pid, retained] of [...retainedIdentities]) {
      const live = liveByPid.get(pid)
      if (!live || !sameAcceptanceProcessIdentity(live, retained)) {
        retainedIdentities.delete(pid)
      } else {
        owned.set(pid, live)
      }
    }
    const rootPids = new Set(
      rootValues
        .filter((root) => {
          const live = liveByPid.get(root.pid)
          return live && sameAcceptanceProcessIdentity(live, root)
        })
        .map((root) => root.pid)
    )
    const rootPgids = new Set(
      rootValues.filter((root) => root.pid !== process.pid).map((root) => root.pgid)
    )
    let added = true
    while (added) {
      added = false
      for (const entry of snapshot) {
        if (owned.has(entry.pid)) continue
        if (
          owned.has(entry.ppid) ||
          rootPids.has(entry.ppid) ||
          (includePgid && rootPgids.has(entry.pgid))
        ) {
          owned.set(entry.pid, entry)
          added = true
        }
      }
    }
    owned.delete(process.pid)
    for (const identity of owned.values()) retainedIdentities.set(identity.pid, identity)
    return [...owned.values()]
  }

  async function signalOwned(signal) {
    const observed = await ownedProcesses()
    if (observed.length === 0) return []
    const validation = await scanAcceptanceProcessIdentities()
    const liveByPid = new Map(validation.map((entry) => [entry.pid, entry]))
    const owned = observed.filter((entry) => {
      const live = liveByPid.get(entry.pid)
      return live && sameAcceptanceProcessIdentity(live, entry)
    })
    const ownedByPid = new Map(owned.map((entry) => [entry.pid, entry]))
    const signaledGroups = new Set()
    if (includePgid) {
      for (const root of rootIdentities.values()) {
        if (!root || root.pid === process.pid) continue
        if (!root || signaledGroups.has(root.pgid)) continue
        if (!owned.some((entry) => entry.pgid === root.pgid)) continue
        signaledGroups.add(root.pgid)
        try {
          process.kill(-root.pgid, signal)
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      }
    }
    for (const identity of owned.sort(
      (left, right) => processDepth(right, ownedByPid) - processDepth(left, ownedByPid)
    )) {
      const live = await inspectAcceptanceProcessIdentity(identity.pid)
      if (!live || !sameAcceptanceProcessIdentity(live, identity)) continue
      try {
        process.kill(identity.pid, signal)
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
    return owned
  }

  async function sweep({ force = false, shouldAbort = () => false } = {}) {
    let empty = 0
    let lastScanError
    const signals = force
      ? [{ signal: 'SIGKILL', duration: killDeadlineMs }]
      : [
          { signal: 'SIGTERM', duration: termGraceMs },
          { signal: 'SIGKILL', duration: killDeadlineMs }
        ]
    for (const phase of signals) {
      empty = 0
      const deadline = Date.now() + phase.duration
      while (Date.now() < deadline) {
        if (shouldAbort()) return
        try {
          const owned = await signalOwned(phase.signal)
          lastScanError = undefined
          empty = owned.length === 0 ? empty + 1 : 0
          if (empty >= emptyScans) return
        } catch (error) {
          lastScanError = error
          empty = 0
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, scanIntervalMs))
      }
    }
    let remaining = []
    try {
      remaining = await ownedProcesses()
    } catch (error) {
      lastScanError = error
    }
    throw new Error(
      `acceptance cleanup did not converge; remaining=${remaining.map((entry) => entry.pid).join(',') || 'unknown'}; ` +
        `lastScanError=${String(lastScanError || 'none')}`
    )
  }

  return {
    addRoot,
    ownedProcesses,
    signalOwned,
    sweep,
    forceSweep: () => sweep({ force: true })
  }
}

/**
 * Convert SIGINT/SIGTERM into one shared cleanup flow. The first signal starts
 * cleanup and exits after it finishes; a second signal escalates the shared
 * cleanup into a forced sweep without broad process matching.
 */
export function createAcceptanceTerminationHandler({
  cleanup,
  requestForceCleanup,
  onFirstSignal = () => {},
  onCleanupError = () => {},
  exit
}) {
  assert.equal(typeof cleanup, 'function', 'cleanup must be a function')
  assert.equal(typeof requestForceCleanup, 'function', 'requestForceCleanup must be a function')
  assert.equal(typeof onFirstSignal, 'function', 'onFirstSignal must be a function')
  assert.equal(typeof onCleanupError, 'function', 'onCleanupError must be a function')
  assert.equal(typeof exit, 'function', 'exit must be a function')

  let signalExitPromise
  let firstSignalSeen = false

  return {
    handleTerminationSignal(signal, code) {
      if (!firstSignalSeen) {
        firstSignalSeen = true
        onFirstSignal(signal)
      } else {
        requestForceCleanup()
      }
      const sharedCleanup = cleanup()
      if (signalExitPromise) return
      signalExitPromise = sharedCleanup
        .catch((error) => onCleanupError(error))
        .then(() => exit(code))
    },
    getExitPromise() {
      return signalExitPromise
    }
  }
}
