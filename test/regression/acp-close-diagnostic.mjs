import { execFile } from 'node:child_process'
import { parsePsProcess, sameProcessIdentity } from '../../src/main/acp/acpProcessLifecycle.ts'

// Passive observers only: no kernel query, method replacement, signals or timers.
export function captureFixtureCloseTrace(connection) {
  const timeline = [{ kind: 'before-close', at: Date.now() }]
  const owners = [...(connection.processTrees?.values() || [])]
  connection.once('close', () => timeline.push({ kind: 'leader-close', at: Date.now() }))
  for (const owner of owners) {
    void owner.closed.then(() => timeline.push({ kind: 'owner-closed', at: Date.now(), rootPid: owner.rootPid }))
    void owner.drained.then(confirmed => timeline.push({ kind: 'owner-drained', at: Date.now(), rootPid: owner.rootPid,
      confirmed, sweepStartedAt: owner.sweepStartedAt, sweepDeadline: owner.sweepDeadline,
      consecutiveEmptyScans: owner.consecutiveEmptyScans, finalized: owner.finalized, rootGroupExtinct: owner.rootGroupExtinct }))
  }
  return {
    markReturned() { timeline.push({ kind: 'close-returned', at: Date.now() }) },
    snapshot() { return timeline.map(row => ({ ...row })) }
  }
}

// Read only the captured fixture PID. Never emit metadata of a reused identity.
export function sampleFixtureState(expected) {
  const queriedAt = Date.now()
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 0 || expected.uid !== process.getuid?.() || typeof expected.startTime !== 'string') {
    return Promise.resolve({ kind: 'unknown', queriedAt, samplingError: { code: 'UNVERIFIED_FIXTURE_IDENTITY' } })
  }
  return new Promise(resolve => {
    execFile('/bin/ps', ['-p', String(expected.pid), '-o', 'pid=,ppid=,uid=,pgid=,lstart=,stat='],
      { encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 1000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        const completedAt = Date.now()
        try {
        const output = typeof stdout === 'string' ? stdout : ''
        if (error) {
          resolve(error.code === 1 && typeof stdout === 'string' && !output.trim()
            ? { kind: 'absent', queriedAt, completedAt }
            : { kind: 'unknown', queriedAt, completedAt, samplingError: { code: error.code, killed: error.killed, signal: error.signal } })
          return
        }
        for (const line of output.split('\n').filter(line => line.trim())) {
          const match = /^(.*\S)\s+(\S+)\s*$/.exec(line)
          const identity = match && parsePsProcess(match[1])
          if (!identity) { resolve({ kind: 'unknown', queriedAt, completedAt, samplingError: { code: 'INVALID_METADATA' } }); return }
          if (!sameProcessIdentity(expected, identity)) { resolve({ kind: 'identity-changed', queriedAt, completedAt }); return }
          resolve({ kind: 'same-identity', queriedAt, completedAt, identity, stat: match[2] })
          return
        }
        resolve({ kind: 'absent', queriedAt, completedAt })
        } catch (samplingError) { resolve({ kind: 'unknown', queriedAt, completedAt, samplingError: { name: samplingError?.name, code: samplingError?.code } }) }
      })
  })
}

// Only call from the original failure catch. Even a sampler/logger exception
// must preserve the exact original AssertionError (including its stack).
export async function annotateFixtureFailure(originalFailure, expected, trace, write = console.error, sample = sampleFixtureState) {
  let diagnostic
  try { diagnostic = { trace: trace.snapshot(), kernel: await sample(expected) } }
  catch (error) { diagnostic = { samplingError: { name: error?.name, code: error?.code } } }
  try { write('ACP_FAILURE_DIAGNOSTIC ' + JSON.stringify(diagnostic)) } catch {}
  throw originalFailure
}
