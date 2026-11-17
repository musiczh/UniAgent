import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAutomations } from '../src/main/nativeAutomations'
import type { AutomationDetail, NativeAutomationInput, Session } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'automation-retry-'))
const originalNow = Date.now
let now = new Date(2026, 9, 10, 10).getTime()
Date.now = () => now
const input: NativeAutomationInput = { name: '失败计划', prompt: '检查项目', schedule: 'RRULE:FREQ=DAILY;BYHOUR=11;BYMINUTE=0',
  agentId: 'codex', projectId: 'default', permissionMode: 'read-only', model: 'model-1', reasoningEffort: 'high', dayMode: 'workday' }
const session = (id: string, status = 'running'): Session => ({ id, status } as Session)
const started: AutomationDetail[] = []
const sessions = new Map<string, Session>()
sessions.set('original-failure', session('original-failure', 'error'))
const runtime: ConstructorParameters<typeof NativeAutomations>[0] = {
  run: async (task: AutomationDetail, isCurrent: () => boolean) => {
    assert.equal(isCurrent(), true)
    started.push(task)
    const created = session('retry-' + started.length)
    sessions.set(created.id, created)
    return created
  },
  getSession: (id: string) => sessions.get(id), getError: async () => 'Agent 执行失败', changed: () => {}, onError: () => {}
}
const stores: NativeAutomations[] = []
async function failedStore(fields: Partial<AutomationDetail> = {}, customRuntime = runtime) {
  const file = join(directory, 'tasks-' + stores.length + '.json')
  const seed = new NativeAutomations(runtime, file).create(input)
  await writeFile(file, JSON.stringify([{ ...seed, ...fields, lastRunAt: now - 1000, lastRunStatus: 'error',
    lastSessionId: 'original-failure', lastRunError: '上次执行失败' }]))
  const store = new NativeAutomations(customRuntime, file)
  stores.push(store)
  store.start()
  return { store, task: store.get(seed.id)!, file }
}
try {
  const { store, task, file } = await failedStore()
  const result = await store.retry(task)
  assert.equal(started.length, 1)
  for (const key of ['prompt', 'agentId', 'permissionMode', 'model', 'reasoningEffort', 'taskScope', 'schedule', 'dayMode'] as const) {
    assert.deepEqual(started[0][key], task[key], 'retry must use the saved ' + key)
  }
  assert.equal(result.nextRunAt, task.nextRunAt, 'retry must not move the next planned occurrence')
  assert.equal(result.status, task.status)
  assert.equal(result.lastRunStatus, 'running')
  assert.equal(result.lastSessionId, 'retry-1', 'retry must create an independent session')
  assert.equal(result.lastRunAt, now)
  assert.equal(result.lastRunError, undefined)
  assert.equal(sessions.has('retry-1'), true)
  assert.equal(task.lastSessionId, 'original-failure', 'the failed record passed by the caller must stay unchanged')
  assert.equal(sessions.get('original-failure')?.status, 'error', 'retry must retain the original failed session')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8'))[0], JSON.parse(JSON.stringify(result)))
  await assert.rejects(store.retry(task), /失败|执行|变化/)
  store.handleStatus('original-failure', 'error', '旧会话的延迟错误')
  assert.equal(store.get(task.id)?.lastRunStatus, 'running', 'late old-session events must not overwrite the retry')
  store.handleStatus('retry-1', 'awaiting-approval')
  assert.equal(store.get(task.id)?.lastRunStatus, 'awaiting-approval')
  store.handleStatus('retry-1', 'error', '新执行失败')
  const failedAgain = store.get(task.id)!
  assert.equal(failedAgain.lastRunError, '新执行失败')
  const sameMillisecond = await store.retry(failedAgain)
  assert.ok(sameMillisecond.lastRunAt! > failedAgain.lastRunAt!, 'each attempt needs a distinct identity even in one millisecond')
  store.handleStatus(sameMillisecond.lastSessionId!, 'idle')
  assert.equal(store.get(task.id)?.lastRunStatus, 'success')
  await assert.rejects(store.retry(store.get(task.id)!), /失败|执行/)

  const paused = await failedStore({ status: 'paused' })
  paused.store.update(paused.task.id, { prompt: '修正后的指令', model: 'model-2' })
  await assert.rejects(paused.store.retry(paused.task), /变化/)
  now = new Date(2026, 9, 11, 10).getTime()
  const pausedResult = await paused.store.retry(paused.store.get(paused.task.id)!)
  assert.equal(pausedResult.status, 'paused', 'manual retry must not resume the schedule')
  assert.equal(pausedResult.nextRunAt, paused.task.nextRunAt)
  assert.equal(started.at(-1)?.prompt, '修正后的指令')
  assert.equal(started.at(-1)?.model, 'model-2')
  assert.equal(pausedResult.lastRunStatus, 'running', 'manual retry must work on a rest day even with the workday filter')
  paused.store.handleStatus(pausedResult.lastSessionId!, 'idle')
  assert.equal(paused.store.get(paused.task.id)?.status, 'paused')

  const once = await failedStore({ schedule: 'ONCE:' + new Date(now - 2000).toISOString(), dayMode: 'all', status: 'completed', nextRunAt: undefined })
  const onceResult = await once.store.retry(once.task)
  assert.equal(onceResult.status, 'completed', 'retry must not rearm a consumed one-off')
  assert.equal(onceResult.nextRunAt, undefined)
  once.store.handleStatus(onceResult.lastSessionId!, 'idle')
  const onceRuns = started.length
  once.store.stop()
  once.store.start()
  assert.equal(started.length, onceRuns, 'successful retry must not automatically replay after restart')

  const startup = await failedStore({}, { ...runtime, run: async () => { throw new Error('Agent 当前不可用') } })
  const rejectedStart = await startup.store.retry(startup.task)
  assert.equal(rejectedStart.lastRunStatus, 'error')
  assert.equal(rejectedStart.lastSessionId, undefined)
  assert.equal(rejectedStart.lastRunError, 'Agent 当前不可用')
  assert.equal(rejectedStart.nextRunAt, startup.task.nextRunAt)
  assert.equal((await startup.store.retry(rejectedStart)).lastRunStatus, 'error', 'startup failure must release the retry lock')

  let release!: () => void
  let current!: () => boolean
  let pendingStarts = 0
  const delayed = await failedStore({}, { ...runtime, run: async (_task, isCurrent) => {
    pendingStarts++
    current = isCurrent
    await new Promise<void>(resolve => { release = resolve })
    return current() ? session('delayed') : null
  } })
  const pending = delayed.store.retry(delayed.task)
  assert.equal(current(), true)
  await assert.rejects(delayed.store.retry(delayed.task), /失败|执行|重试/)
  now = delayed.task.nextRunAt!
  ;(delayed.store as any).tick()
  assert.equal(pendingStarts, 1, 'a scheduled occurrence must not overlap a pending manual retry')
  assert.equal(current(), true, 'advancing the schedule must not cancel an explicit retry')
  delayed.store.update(delayed.task.id, { prompt: '等待期间修改' })
  assert.equal(current(), false, 'an edit while awaiting readiness must invalidate the pending retry')
  release()
  assert.equal((await pending).lastSessionId, undefined)
  const afterEdit = delayed.store.get(delayed.task.id)!
  const deleting = delayed.store.retry(afterEdit)
  delayed.store.delete(delayed.task.id)
  assert.equal(current(), false)
  release()
  await assert.rejects(deleting, /不存在|删除/)

  const interrupted = await failedStore({ status: 'paused' }, { ...runtime, run: async (_task, isCurrent) => {
    current = isCurrent
    await new Promise<void>(resolve => { release = resolve })
    return current() ? session('stopped') : null
  } })
  const stopping = interrupted.store.retry(interrupted.task)
  interrupted.store.stop()
  assert.equal(current(), false)
  release()
  assert.equal((await stopping).lastSessionId, undefined)
  await assert.rejects(interrupted.store.retry(interrupted.store.get(interrupted.task.id)!), /就绪|停止|启动/)
  const invalid = startup.store.get(startup.task.id)!
  await assert.rejects(startup.store.retry({ ...invalid, source: undefined }), /原生/)
  await assert.rejects(startup.store.retry({ ...invalid, id: 'uniagent:missing' }), /不存在/)
  await assert.rejects(startup.store.retry({ ...invalid, lastRunAt: NaN }), /变化/)
  await assert.rejects(startup.store.retry({ ...invalid, lastRunAt: undefined }), /变化/)
  assert.deepEqual(startup.store.get(invalid.id), invalid, 'invalid requests must not change the saved failure')
} finally {
  stores.forEach(store => store.stop())
  Date.now = originalNow
  await rm(directory, { recursive: true, force: true })
}
console.log('automation-retry: ok')
