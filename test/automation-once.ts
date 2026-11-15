import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextScheduleRuns, parseScheduleExpression } from '../src/shared/automationSchedule'
import { NativeAutomations } from '../src/main/nativeAutomations'
import type { AutomationDetail, NativeAutomationInput, Session } from '../src/shared/types'

const target = new Date(2026, 9, 31, 9, 30, 15).getTime()
const schedule = `ONCE:${new Date(target).toISOString()}`
const parsed = parseScheduleExpression(schedule)
assert.equal(parsed.ok, true)
assert.equal(parsed.freq, 'once')
assert.equal(parsed.onceAt, target)
assert.deepEqual(nextScheduleRuns(parsed, 3, new Date(target - 1)).map(date => date.getTime()), [target])
assert.deepEqual(nextScheduleRuns(parsed, 3, new Date(target)), [])
assert.deepEqual(nextScheduleRuns(parsed, 3, new Date(target + 1)), [])
assert.deepEqual(nextScheduleRuns(parsed, 3, new Date(target - 1), 'workday'), [])
assert.equal(parseScheduleExpression('ONCE:2026-10-31T09:30:00+08:00').onceAt, Date.parse('2026-10-31T01:30:00Z'))
for (const value of ['ONCE:', 'ONCE:2026-02-30T09:30:00Z', 'ONCE:2026-10-31T24:00:00Z',
  'ONCE:2026-10-31T09:30:00', 'ONCE:2026-10-31', 'ONCE:2026-10-31T09:30:00+25:00']) {
  assert.equal(parseScheduleExpression(value).ok, false, value)
}

const directory = await mkdtemp(join(tmpdir(), 'automation-once-'))
const originalNow = Date.now
let now = target - 60_000
Date.now = () => now
const input: NativeAutomationInput = { name: '一次性提醒', prompt: '检查项目', schedule,
  agentId: 'codex', projectId: 'default', permissionMode: 'read-only' }
let runs = 0
const runtime = {
  run: async (_task: AutomationDetail, current: () => boolean) => {
    assert.equal(current(), true)
    return { id: `session-${++runs}`, status: 'running' } as Session
  },
  getSession: () => undefined, getError: async () => undefined, changed: () => {},
  onError: (error: unknown) => { throw error }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15))
try {
  const file = join(directory, 'tasks.json')
  const store = new NativeAutomations(runtime, file)
  const task = store.create(input)
  assert.equal(task.nextRunAt, target)
  assert.throws(() => store.create({ ...input, dayMode: 'workday' }), /一次性.*筛选/)
  assert.equal(store.setStatus(task.id, 'paused'), true)
  now = target + 60_000
  store.start()
  await settle()
  assert.equal(runs, 0, 'paused one-off must not run')
  assert.throws(() => store.setStatus(task.id, 'active'), /未来|已过/)
  store.stop()
  assert.throws(() => store.create(input), /未来|已过/)

  now = target - 60_000
  store.update(task.id, { schedule: `ONCE:${new Date(target + 1).toISOString()}` })
  store.setStatus(task.id, 'active')
  now = target + 86_400_000
  const resumed = new NativeAutomations(runtime, file)
  resumed.start()
  await settle()
  assert.equal(runs, 1, 'restart must catch up one missed occurrence')
  assert.equal(resumed.get(task.id)?.nextRunAt, undefined, 'claim must consume the only occurrence before starting Agent')
  assert.equal(resumed.get(task.id)?.lastRunStatus, 'running')
  resumed.handleStatus('session-1', 'awaiting-approval')
  assert.equal(resumed.get(task.id)?.lastRunStatus, 'awaiting-approval')
  resumed.handleStatus('session-1', 'idle')
  assert.equal(resumed.get(task.id)?.status, 'completed')
  assert.equal(resumed.get(task.id)?.lastRunStatus, 'success')
  resumed.stop()
  const completed = new NativeAutomations(runtime, file)
  completed.start()
  await settle()
  assert.equal(runs, 1, 'completed one-off must not replay after restart')
  assert.throws(() => completed.setStatus(task.id, 'active'), /一次性.*执行|重新.*时间/)
  completed.update(task.id, { name: '保留执行记录' })
  assert.equal(completed.get(task.id)?.status, 'completed', 'ordinary edits must not rearm a consumed occurrence')
  const next = now + 60_000
  completed.update(task.id, { schedule: `ONCE:${new Date(next).toISOString()}` })
  assert.equal(completed.get(task.id)?.status, 'active', 'an explicitly changed future schedule can rearm the task')
  assert.equal(completed.get(task.id)?.nextRunAt, next)
  completed.stop()

  const failedFile = join(directory, 'failed.json')
  const failed = new NativeAutomations({ ...runtime, run: async () => { runs++; throw new Error('Agent 无法启动') }, onError: () => {} }, failedFile)
  failed.create({ ...input, schedule: `ONCE:${new Date(next).toISOString()}` })
  now = next
  failed.start()
  await settle()
  assert.equal(failed.list()[0].status, 'completed')
  assert.equal(failed.list()[0].lastRunStatus, 'error')
  failed.stop()
  const before = runs
  const restartedFailure = new NativeAutomations(runtime, failedFile)
  restartedFailure.start()
  await settle()
  assert.equal(runs, before, 'failure must not automatically retry')
  restartedFailure.stop()

  const crashFile = join(directory, 'crash.json')
  const claimed = { ...resumed.get(task.id)!, status: 'active', lastRunStatus: 'running', nextRunAt: undefined }
  await writeFile(crashFile, JSON.stringify([claimed]))
  const crashed = new NativeAutomations(runtime, crashFile)
  crashed.start()
  await settle()
  assert.equal(runs, before, 'a persisted in-flight claim must not start again')
  assert.equal(crashed.get(task.id)?.status, 'completed')
  assert.equal(crashed.get(task.id)?.lastRunStatus, 'error')
  assert.match(crashed.get(task.id)?.lastRunError ?? '', /重启/)
  crashed.stop()
  const overlapFile = join(directory, 'overlap.json')
  const overlap = new NativeAutomations(runtime, overlapFile)
  const firstDue = now + 1000
  const overlapTask = overlap.create({ ...input, schedule: 'ONCE:' + new Date(firstDue).toISOString() })
  now = firstDue
  overlap.start()
  await settle()
  const firstSession = overlap.get(overlapTask.id)!.lastSessionId!
  const secondDue = now + 1000
  overlap.update(overlapTask.id, { schedule: 'ONCE:' + new Date(secondDue).toISOString() })
  overlap.stop()
  now = secondDue
  const occupiedRuns = runs
  overlap.start()
  await settle()
  assert.equal(runs, occupiedRuns, 'one-off must wait for the previous execution instead of overlapping')
  assert.equal(overlap.get(overlapTask.id)?.nextRunAt, secondDue, 'waiting must not consume the only occurrence')
  overlap.handleStatus(firstSession, 'idle')
  overlap.stop()
  overlap.start()
  await settle()
  assert.equal(runs, occupiedRuns + 1, 'the waiting one-off must run after the previous execution finishes')
  overlap.stop()

  let isCurrent: (() => boolean) | undefined
  let release: (() => void) | undefined
  const waiting = new NativeAutomations({ ...runtime, run: async (_task, current) => {
    isCurrent = current
    await new Promise<void>(resolve => { release = resolve })
    return null
  } }, join(directory, 'waiting.json'))
  const waitingTask = waiting.create({ ...input, schedule: 'ONCE:' + new Date(now + 1000).toISOString() })
  now += 1000
  waiting.update(waitingTask.id, { name: '准备执行' })
  waiting.start()
  assert.equal(isCurrent?.(), true)
  waiting.update(waitingTask.id, { prompt: '以新的指令执行' })
  assert.equal(isCurrent?.(), false, 'an edit in the same millisecond must invalidate the old pending execution')
  release?.()
  await settle()
  waiting.stop()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1, 'rejected inputs must not persist extra tasks')
} finally {
  Date.now = originalNow
  await rm(directory, { recursive: true, force: true })
}
console.log('automation-once: ok')
