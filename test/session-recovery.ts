import assert from 'node:assert/strict'
import { SessionRecovery, type RecoverySnapshot } from '../src/main/sessionRecovery'
import { defaultRecoverySettings, type RecoveryProgress } from '../src/shared/sessionRecovery'
import type { RecoveryFailure } from '../src/main/recoveryContext'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(ok => { resolve = ok })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const settings = { ...defaultRecoverySettings(), enabled: true, agentId: 'codex', model: 'judge', selectedErrors: ['codex:capacity'] }
const failure = (id: string, sessionId = 'session'): RecoveryFailure => ({ sessionId, failureId: id, agentId: 'codex', model: 'execution',
  nativeSessionId: 'native', message: 'Selected model is at capacity.', delivery: 'accepted', terminal: true, interrupted: false, nativeRetrying: false })
const yes = JSON.stringify({ retry: true, matchedRuleIds: [], reason: '暂时容量不足' })

function fixture() {
  const saved: RecoverySnapshot[] = [], sent: string[] = [], phases: Array<RecoveryProgress | undefined> = [], waits: number[] = []
  let current = true, judges = 0
  const deps = { settings: () => settings, current: () => current,
    judge: async () => { judges++; return yes },
    save: async (snapshot: RecoverySnapshot) => { saved.push(structuredClone(snapshot)) },
    retry: async (_failure: RecoveryFailure, id: string) => {
      assert.equal(saved.at(-1)!.records[0].phase, 'retrying', 'dispatch follows a durable reservation')
      sent.push(id)
    }, progress: (_sessionId: string, value: RecoveryProgress | undefined) => { phases.push(value) },
    wait: async (ms: number, _signal: AbortSignal) => { waits.push(ms) }, now: () => 1000, random: () => 0 }
  const recovery = new SessionRecovery(deps)
  return { recovery, deps, saved, sent, phases, waits, judges: () => judges, stale: () => { current = false } }
}

{
  const f = fixture()
  for (let i = 1; i <= 3; i++) assert.equal((await f.recovery.recover(failure(String(i)))).state, 'retry-started')
  assert.equal((await f.recovery.recover(failure('4'))).state, 'stopped')
  assert.equal(f.judges(), 3)
  assert.equal(f.sent.length, 3)
  assert.equal(new Set(f.sent).size, 3)
  assert.deepEqual(f.waits, [30000, 60000, 120000])
  assert.equal((await f.recovery.recover(failure('4'))).state, 'ignored')
  assert.equal(f.recovery.snapshot().errors[0].count, 4)
  f.recovery.reset('session')
  assert.equal((await f.recovery.recover(failure('new-user-request'))).state, 'retry-started')
  assert.equal(f.recovery.getProgress('session')?.attempts, 1)
}
{
  const f = fixture(), judgment = deferred<string>()
  f.deps.judge = () => judgment.promise
  const pending = f.recovery.recover(failure('a'))
  await tick()
  assert.equal((await f.recovery.recover(failure('a'))).state, 'ignored')
  f.recovery.cancel('session', '用户停止')
  judgment.resolve(yes)
  assert.equal((await pending).state, 'cancelled')
  assert.equal(f.sent.length, 0)
  assert.equal(f.recovery.getProgress('session')?.reason, '用户停止')
}
{
  const f = fixture(), waiting = deferred<void>()
  f.deps.wait = () => waiting.promise
  const pending = f.recovery.recover(failure('a'))
  await tick()
  assert.equal(f.recovery.getProgress('session')?.phase, 'waiting')
  f.recovery.settingsChanged()
  waiting.resolve()
  assert.equal((await pending).state, 'cancelled')
  assert.equal(f.sent.length, 0)
}
{
  const f = fixture()
  f.deps.save = async snapshot => { if (snapshot.records[0]?.phase === 'retrying') throw new Error('disk full'); f.saved.push(snapshot) }
  assert.equal((await f.recovery.recover(failure('a'))).state, 'stopped')
  assert.equal(f.sent.length, 0, 'failed durable reservation never dispatches')
}
{
  const f = fixture()
  f.deps.judge = async () => { throw new Error('judge unavailable') }
  assert.equal((await f.recovery.recover(failure('a'))).state, 'stopped')
  assert.equal(f.sent.length, 0)
  assert.equal(f.recovery.getProgress('session')?.attempts, 0)
}
{
  const f = fixture()
  f.deps.judge = async () => { f.stale(); return yes }
  assert.equal((await f.recovery.recover(failure('a'))).state, 'stopped')
  assert.equal(f.recovery.getProgress('session')?.phase, 'stopped', 'configuration drift cannot leave a session judging forever')
  assert.equal(f.sent.length, 0)
}
{
  const f = fixture()
  f.deps.settings = () => ({ ...settings, enabled: false })
  assert.equal((await f.recovery.recover(failure('disabled'))).state, 'stopped')
  assert.equal(f.recovery.snapshot().errors.length, 1, 'errors remain available for future selection')
  assert.equal(f.recovery.snapshot().records.length, 0, 'disabled recovery must not change normal restart behavior')
  assert.equal(f.judges(), 0)
}
for (const patch of [{ nativeRetrying: true }, { interrupted: true }, { terminal: false }, { delivery: 'unknown' as const }]) {
  const f = fixture()
  assert.equal((await f.recovery.recover({ ...failure('a'), ...patch })).state, 'stopped')
  assert.equal(f.judges(), 0)
}
{
  const f = fixture()
  await f.recovery.recover(failure('a'))
  const restored = new SessionRecovery(f.deps, f.recovery.snapshot())
  assert.equal(restored.getProgress('session')?.phase, 'stopped')
  assert.equal(restored.getProgress('session')?.attempts, 1)
  assert.match(restored.getProgress('session')!.reason, /重启/)
  assert.equal(f.sent.length, 1, 'construction does not replay persisted work')
}
{
  const f = fixture(), pending: Array<ReturnType<typeof deferred<string>>> = []
  let concurrent = 0, peak = 0
  f.deps.judge = async () => { concurrent++; peak = Math.max(peak, concurrent); const work = deferred<string>(); pending.push(work); try { return await work.promise } finally { concurrent-- } }
  const work = Array.from({ length: 4 }, (_, i) => f.recovery.recover(failure('a', 'session-' + i)))
  await tick()
  assert.equal(pending.length, 2)
  const no = JSON.stringify({ retry: false, matchedRuleIds: [], reason: '无需重试' })
  pending.slice().forEach(item => item.resolve(no))
  await tick()
  assert.equal(pending.length, 4)
  pending.slice(2).forEach(item => item.resolve(no))
  await Promise.all(work)
  assert.equal(peak, 2)
  assert.equal(f.sent.length, 0)
}
console.log('PASS recovery controller: bounded attempts, deduplication, cancellation, durable dispatch, judge failure, restart and concurrency')

{
  const f = fixture()
  let nested: Promise<unknown> | undefined
  f.deps.retry = async (_failure, id) => {
    f.sent.push(id)
    if (f.sent.length === 1) nested = f.recovery.recover(failure('synchronous-next-failure'))
  }
  await f.recovery.recover(failure('first'))
  await nested
  assert.equal(f.sent.length, 2, 'a fast retry failure must not be lost behind the preceding dispatch')
}
