import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isChinaWorkday } from '../src/shared/chinaWorkCalendar'
import { matchesAutomationDay, nextScheduleRuns, parseScheduleExpression } from '../src/shared/automationSchedule'
import { NativeAutomations } from '../src/main/nativeAutomations'
import type { AutomationDetail, NativeAutomationInput, Session } from '../src/shared/types'

const local = (month: number, day: number, hour = 8) => new Date(2026, month - 1, day, hour)
for (const [month, day] of [[1, 4], [2, 14], [2, 28], [5, 9], [9, 20], [10, 10]]) {
  assert.equal(isChinaWorkday(local(month, day)), true, `makeup workday ${month}/${day}`)
  assert.equal(matchesAutomationDay(local(month, day), 'non-workday'), false)
}
for (const [month, day] of [[1, 1], [1, 3], [2, 15], [2, 23], [4, 6], [5, 5], [6, 19], [9, 25], [10, 1], [10, 7]]) {
  assert.equal(isChinaWorkday(local(month, day)), false, `official holiday ${month}/${day}`)
  assert.equal(matchesAutomationDay(local(month, day), 'non-workday'), true)
}
assert.equal(isChinaWorkday(local(10, 11)), false, 'ordinary Sunday')
assert.equal(isChinaWorkday(local(10, 12)), true, 'ordinary Monday')
assert.equal(isChinaWorkday(new Date(2027, 0, 4)), null, 'unknown calendar must not guess a working Monday')
assert.equal(matchesAutomationDay(new Date(2027, 0, 4), 'non-workday'), null)
assert.equal(isChinaWorkday(new Date(NaN)), null)
const daily = parseScheduleExpression('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30')
const dates = (from: Date, mode: 'workday' | 'non-workday') => nextScheduleRuns(daily, 3, from, mode)
  .map(date => `${date.getMonth() + 1}/${date.getDate()}`)
assert.deepEqual(dates(local(1, 1), 'workday'), ['1/4', '1/5', '1/6'])
assert.deepEqual(dates(local(2, 14), 'non-workday'), ['2/15', '2/16', '2/17'])
assert.deepEqual(dates(local(10, 1), 'workday'), ['10/8', '10/9', '10/10'])
assert.deepEqual(dates(local(10, 10), 'non-workday'), ['10/11', '10/17', '10/18'])
assert.deepEqual(dates(new Date(2027, 0, 1), 'workday'), [])
assert.deepEqual(dates(local(12, 31), 'workday'), ['12/31'], 'do not cross into an unknown calendar')

const root = await mkdtemp(join(tmpdir(), 'automation-workdays-'))
const originalNow = Date.now
let now = local(10, 8).getTime()
Date.now = () => now
const runs: AutomationDetail[] = []
const runtime = {
  run: async (task: AutomationDetail, current: () => boolean) => {
    assert.equal(current(), true); runs.push(task)
    return { id: `run-${runs.length}`, status: 'idle' } as Session
  },
  getSession: () => undefined, getError: async () => undefined, changed: () => {},
  onError: (error: unknown) => { throw error }
}
const input: NativeAutomationInput = { name: '工作日检查', prompt: '检查', schedule: daily.raw, agentId: 'codex',
  projectId: 'default', permissionMode: 'read-only', dayMode: 'workday' }
try {
  const store = new NativeAutomations(runtime, join(root, 'edit.json'))
  const task = store.create(input)
  const legacyFile = join(root, 'legacy.json')
  const { dayMode: _dayMode, ...legacy } = task
  await writeFile(legacyFile, JSON.stringify([legacy]))
  assert.equal(new NativeAutomations(runtime, legacyFile).get(task.id)?.dayMode, 'all', 'existing tasks retain their original schedule without a date filter')
  assert.equal(new Date(task.nextRunAt!).getDate(), 8)
  assert.equal(store.update(task.id, { dayMode: 'non-workday' }), true)
  assert.equal(new Date(store.get(task.id)!.nextRunAt!).getDate(), 11, 'changing day mode recalculates the next date')
  assert.equal(store.setStatus(task.id, 'paused'), true)
  now = local(10, 11, 12).getTime()
  assert.equal(store.setStatus(task.id, 'active'), true)
  assert.equal(new Date(store.get(task.id)!.nextRunAt!).getDate(), 17, 'resume also respects day mode')
  assert.throws(() => store.create({ ...input, dayMode: 'invalid' as any }), /配置无效/)

  async function runDue(date: Date, due: Date, expectedRuns: number, expectedNext?: number): Promise<AutomationDetail> {
    now = due.getTime() - 1000
    const file = join(root, `due-${date.getTime()}.json`)
    const seed = new NativeAutomations(runtime, file).create(input)
    await writeFile(file, JSON.stringify([{ ...seed, nextRunAt: due.getTime() }]))
    now = date.getTime()
    const restored = new NativeAutomations(runtime, file)
    const before = runs.length
    try {
      restored.start()
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(runs.length - before, expectedRuns)
      const row = restored.get(seed.id)!
      assert.equal(row.nextRunAt, expectedNext)
      if (expectedRuns) assert.equal(row.lastRunStatus, 'success')
      return row
    } finally { restored.stop() }
  }
  await runDue(local(10, 10, 12), local(10, 10, 9), 1, local(10, 12, 9).getTime() + 30 * 60_000)
  await runDue(local(10, 11, 12), local(10, 10, 9), 0, local(10, 12, 9).getTime() + 30 * 60_000)
  await runDue(local(10, 1, 12), local(9, 30, 9), 0, local(10, 8, 9).getTime() + 30 * 60_000)
  const final = await runDue(local(12, 31, 12), local(12, 31, 9), 1)
  assert.equal(final.status, 'active', 'keep the task so calendar updates can resume it')
  const exhaustedFile = join(root, 'exhausted.json')
  await writeFile(exhaustedFile, JSON.stringify([final]))
  assert.equal(new NativeAutomations(runtime, exhaustedFile).get(final.id)?.nextRunAt, undefined, 'exhausted calendars survive restart')

  now = local(10, 10, 8).getTime()
  const delayedFile = join(root, 'delayed.json')
  const delayedTask = new NativeAutomations(runtime, delayedFile).create(input)
  now = local(10, 10, 12).getTime()
  let ready: (() => void) | undefined
  let stillCurrent: (() => boolean) | undefined
  const delayed = new NativeAutomations({ ...runtime, run: async (_task, isCurrent) => {
    stillCurrent = isCurrent
    await new Promise<void>(resolve => { ready = resolve })
    return isCurrent() ? { id: 'should-not-start', status: 'idle' } as Session : null
  } }, delayedFile)
  try {
    delayed.start()
    assert.equal(stillCurrent?.(), true)
    now = local(10, 11, 1).getTime()
    assert.equal(stillCurrent?.(), false, 'waiting for Agent readiness must not start a workday task after midnight on a rest day')
    ready?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(delayed.get(delayedTask.id)?.lastSessionId, undefined)
    assert.equal(delayed.get(delayedTask.id)?.lastRunStatus, 'error')
  } finally { delayed.stop() }
  now = new Date(2027, 0, 4, 12).getTime()
  assert.throws(() => store.create(input), /调休日历/)
  assert.equal(JSON.parse(await readFile(join(root, 'edit.json'), 'utf8')).length, 1, 'failed creation is atomic')
  await runDue(new Date(2027, 0, 4, 12), local(12, 31, 9), 0)
} finally {
  Date.now = originalNow
  await rm(root, { recursive: true, force: true })
}
console.log('automation-workdays: ok')
