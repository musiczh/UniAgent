import assert from 'node:assert/strict'
import {
  automationCanDelete,
  automationCanEdit,
  automationCanToggle,
  buildScheduleExpression,
  describeCadence,
  describeNextRun,
  describeSchedule,
  nextScheduleRuns,
  parseScheduleExpression,
  scheduleForSave,
  scheduleForTask
} from '../src/renderer/components/AutomationsPanel'
import type { AutomationTask } from '../src/shared/types'

const rrule = 'RRULE:FREQ=WEEKLY;BYHOUR=12;BYMINUTE=17;BYDAY=MO,TU,WE,TH,FR'
const parsedRrule = parseScheduleExpression(rrule)
assert.equal(parsedRrule.ok, true)
assert.equal(parsedRrule.freq, 'weekly')
assert.deepEqual([...parsedRrule.days], ['MO', 'TU', 'WE', 'TH', 'FR'])
assert.equal(buildScheduleExpression(parsedRrule), rrule)

const sixFieldCron = parseScheduleExpression('0 0 9 * * 1-5')
assert.equal(sixFieldCron.cronFields, 6)
assert.equal(buildScheduleExpression(sixFieldCron), '0 0 9 * * 1-5')

const fiveFieldCron = parseScheduleExpression('30 21 1,15 * *')
assert.equal(fiveFieldCron.cronFields, 5)
assert.deepEqual([...fiveFieldCron.monthDays], [1, 15])
assert.equal(buildScheduleExpression(fiveFieldCron), '30 21 1,15 * *')
assert.equal(buildScheduleExpression({ ...fiveFieldCron, cronMode: false }), 'RRULE:FREQ=MONTHLY;BYHOUR=21;BYMINUTE=30;BYMONTHDAY=1,15')
assert.equal(buildScheduleExpression({ ...fiveFieldCron, cronFields: 6 }), '0 30 21 1,15 * *')

const sundayCron = parseScheduleExpression('0 15 8 * * 0,7')
assert.deepEqual([...sundayCron.days], ['SU'])
assert.equal(buildScheduleExpression(sundayCron), '0 15 8 * * 0')

const invalid = parseScheduleExpression('whenever the moon is full')
assert.equal(invalid.ok, false)
assert.equal(buildScheduleExpression(invalid), 'whenever the moon is full')
assert.equal(parseScheduleExpression('0 0 24 * * *').ok, false)
assert.equal(parseScheduleExpression('0 0 9 1 * 1').ok, false)

const mondayMorning = new Date(2026, 7, 24, 8, 0, 0)
const runs = nextScheduleRuns(parsedRrule, 3, mondayMorning)
assert.equal(runs.length, 3)
assert.deepEqual(runs.map((run) => run.getDay()), [1, 2, 3])
assert.deepEqual(runs.map((run) => [run.getHours(), run.getMinutes()]), [[12, 17], [12, 17], [12, 17]])

const local: AutomationTask = { id: 'local', agentId: 'codex', name: 'local', status: 'active', path: '/tmp/automation.toml' }
const localFromCron = scheduleForTask('30 21 * * *')
assert.equal(localFromCron.cronMode, false)
assert.equal(localFromCron.raw, '30 21 * * *')
assert.equal(buildScheduleExpression({ ...localFromCron, minute: 35 }), 'RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=35')
assert.equal(automationCanToggle(local), true)
assert.equal(automationCanEdit(local), true)
assert.equal(automationCanDelete(local), true)

// The five/six-field cron form still parses and round-trips, but the editor only
// keeps it while the user stays in cron mode; saving normalizes through the visual
// form.
const parsedCron = parseScheduleExpression('30 21 * * *')
assert.equal(parsedCron.cronMode, true)
assert.equal(parsedCron.cronFields, 5)
assert.equal(buildScheduleExpression(parsedCron), '30 21 * * *')
assert.equal(buildScheduleExpression({ ...parsedCron, cronFields: 6 }), '0 30 21 * * *')
assert.equal(scheduleForSave({ ...parsedCron, cronMode: false }), 'RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=30')
assert.equal(scheduleForSave({ ...parsedCron, ok: false, raw: 'raw text exactly' }), null)

// Automations are local-only: edit/toggle/delete all require an on-disk path, and
// an unknown status can never be toggled.
const pathless: AutomationTask = { id: 'pathless', agentId: 'codex', name: 'pathless', status: 'active' }
assert.equal(automationCanEdit(pathless), false)
assert.equal(automationCanDelete(pathless), false)
assert.equal(automationCanToggle(pathless), false)
assert.equal(automationCanToggle({ ...local, status: 'unknown' }), false)

// 补3 — humanize schedules; raw cron/RRULE must never surface in the summary.
const from = new Date(2026, 7, 28, 8, 0, 0) // Fri 2026-08-28 08:00
assert.equal(describeCadence(parseScheduleExpression('0 0 9 * * 1-5')), '每周一至周五 09:00')
assert.equal(describeCadence(parseScheduleExpression('RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=30')), '每天 21:30')
assert.equal(describeCadence(parseScheduleExpression('30 21 1,15 * *')), '每月 1 号、15 号 21:30')
assert.equal(describeNextRun(parseScheduleExpression('0 0 9 * * 1-5'), from), '2026-08-28 周五 09:00')

const weekdayDesc = describeSchedule('0 0 9 * * 1-5 · 仅工作日', from)
assert.equal(weekdayDesc.cadence, '每周一至周五 09:00')
assert.equal(weekdayDesc.nextRun, '2026-08-28 周五 09:00')

// One-off datetime strings pass through unchanged, and no raw cron leaks.
const oneOff = describeSchedule('2026-08-24 21:16 · Asia/Shanghai', from)
assert.equal(oneOff.cadence, '2026-08-24 21:16 · Asia/Shanghai')
assert.equal(oneOff.nextRun, null)

// Genuinely opaque expressions collapse to a generic label (never expose cron).
const opaque = describeSchedule('*/5 8-18 * * MON#2', from)
assert.equal(opaque.cadence, '自定义调度')
assert.equal(/\*/.test(opaque.cadence), false)
assert.equal(describeSchedule('', from).cadence, '')
