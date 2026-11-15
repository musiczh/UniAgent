import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAutomations } from '../src/main/nativeAutomations'
import { ProjectStore } from '../src/main/projectStore'
import { RequirementStore } from '../src/main/requirementStore'
import { resolveAutomationTaskConfig } from '../src/main/taskScope'
import { automationTaskScope, mergeAutomationPatch } from '../src/shared/automationOwnership'
import type { NativeAutomationInput, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'automation-ownership-'))
const originalNow = Date.now
let now = new Date(2026, 10, 6, 8).getTime()
Date.now = () => now
const sessions: Session[] = []
const errors: unknown[] = []
let enabled = true
try {
  await mkdir(join(root, 'a')); await mkdir(join(root, 'b'))
  const projects = new ProjectStore(root)
  const a = projects.create({ name: '空间 A', primaryDirectory: join(root, 'a'), additionalDirectories: [] })
  const b = projects.create({ name: '空间 B', primaryDirectory: join(root, 'b'), additionalDirectories: [] })
  const requirements = new RequirementStore(root)
  const requirement = await requirements.create({ name: '定时需求', projectId: a.id })
  const input: NativeAutomationInput = { name: '定时检查', prompt: '检查当前需求', schedule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
    agentId: 'codex', taskScope: { kind: 'requirement', requirementId: requirement.id }, permissionMode: 'read-only' }
  const resolveConfig = (task: NativeAutomationInput) => projects.resolveSessionConfig(
    resolveAutomationTaskConfig(task, id => requirements.get(id), id => !!projects.get(id), enabled), true)
  const runtime = {
    run: async (task: NativeAutomationInput, isCurrent: () => boolean) => {
      assert.equal(isCurrent(), true)
      const session: Session = { id: `scheduled-${sessions.length}`, title: task.name, createdAt: now,
        status: 'idle', nativeSessionId: `native-${sessions.length}`, config: resolveConfig(task) }
      sessions.push(session)
      return session
    },
    getSession: (id: string) => sessions.find(session => session.id === id), getError: async () => undefined,
    changed: () => {}, onError: (error: unknown) => { errors.push(error) }
  }
  const file = join(root, 'automations.json')
  let store = new NativeAutomations(runtime, file)
  const task = store.create(input)
  assert.deepEqual(task.taskScope, input.taskScope)
  assert.equal(task.projectId, undefined, 'a requirement plan does not store a main-space snapshot')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8'))[0].taskScope, input.taskScope)
  store = new NativeAutomations(runtime, file)
  assert.deepEqual(store.get(task.id)?.taskScope, input.taskScope, 'ownership survives reading the real persisted file')
  const runDue = async () => {
    now = store.get(task.id)!.nextRunAt!
    store.start(); await new Promise(resolve => setTimeout(resolve, 20)); store.stop()
  }
  await runDue()
  assert.equal(sessions[0].config.requirementId, requirement.id)
  assert.equal(sessions[0].config.projectId, a.id)
  assert.equal(sessions[0].config.workdir, a.primaryDirectory)
  const previous = JSON.stringify(sessions[0])
  await requirements.update(requirement.id, { projectId: b.id })
  await runDue()
  assert.equal(sessions[1].config.projectId, b.id)
  assert.equal(sessions[1].config.workdir, b.primaryDirectory)
  assert.equal(JSON.stringify(sessions[0]), previous, 'rebinding leaves the prior native session and directory intact')
  store.update(task.id, { taskScope: { kind: 'space', projectId: a.id } })
  await runDue()
  assert.equal(sessions[2].config.projectId, a.id)
  assert.equal(sessions[2].config.requirementId, undefined, 'selecting a space clears requirement ownership')
  store.update(task.id, { taskScope: input.taskScope })
  await requirements.update(requirement.id, { status: 'archived' })
  await runDue()
  assert.equal(sessions.length, 3)
  assert.match(store.get(task.id)?.lastRunError ?? '', /需求不可用/)
  assert.equal(store.get(task.id)?.lastSessionId, undefined, 'invalid ownership creates no fallback session')
  await requirements.update(requirement.id, { status: 'active', projectId: 'removed' })
  await runDue()
  assert.equal(sessions.length, 3)
  assert.match(store.get(task.id)?.lastRunError ?? '', /有效空间/)
  enabled = false
  await runDue()
  assert.match(store.get(task.id)?.lastRunError ?? '', /需求功能已停用/)
  assert.equal(sessions.length, 3)
  assert.equal(errors.length, 3, 'each unavailable target is reported once')
  enabled = true
  await requirements.update(requirement.id, { projectId: a.id })
  const before = await readFile(file, 'utf8')
  for (const scope of [null, [], {}, { kind: 'requirement', requirementId: '' }, { kind: 'space', projectId: '' },
    { kind: 'requirement', requirementId: requirement.id, projectId: a.id }]) {
    assert.throws(() => store.update(task.id, { taskScope: scope as any }), /有效.*空间或需求/)
    assert.equal(await readFile(file, 'utf8'), before, 'malformed ownership cannot partially overwrite a plan')
  }
  assert.throws(() => automationTaskScope({ ...input, projectId: a.id }), /有效.*空间或需求/)
  assert.throws(() => mergeAutomationPatch(input, { taskScope: input.taskScope, projectId: a.id }), /有效.*空间或需求/)
  assert.throws(() => resolveConfig({ ...input, taskScope: { kind: 'requirement', requirementId: 'missing' } }), /需求不可用/)
  assert.throws(() => resolveConfig({ ...input, taskScope: { kind: 'space', projectId: 'removed' } }), /有效.*空间或需求/)
  const legacyFile = join(root, 'legacy.json')
  const legacy = { ...task, projectId: a.id, taskScope: undefined }
  await writeFile(legacyFile, JSON.stringify([legacy]))
  const legacyStore = new NativeAutomations(runtime, legacyFile)
  assert.deepEqual(legacyStore.get(task.id)?.taskScope, { kind: 'space', projectId: a.id })
  assert.equal(resolveConfig(legacyStore.get(task.id) as NativeAutomationInput).workdir, a.primaryDirectory)
  legacyStore.update(task.id, { projectId: b.id })
  assert.deepEqual(legacyStore.get(task.id)?.taskScope, { kind: 'space', projectId: b.id }, 'legacy space edits update the canonical ownership')
  let release!: () => void
  const pendingFile = join(root, 'pending.json')
  const pending = new NativeAutomations({ ...runtime, run: async (task, current) => {
    await new Promise<void>(resolve => { release = resolve })
    return current() ? runtime.run(task as NativeAutomationInput, current) : null
  } }, pendingFile)
  const waiting = pending.create({ ...input, schedule: 'ONCE:' + new Date(now + 1000).toISOString() })
  now += 1000; pending.start()
  pending.update(waiting.id, { taskScope: { kind: 'space', projectId: b.id } })
  release(); await new Promise(resolve => setTimeout(resolve, 20)); pending.stop()
  assert.equal(sessions.length, 3, 'editing ownership while Agent readiness is pending cancels the old execution snapshot')
  await writeFile(join(root, 'requirements.json'), '[null]')
  assert.throws(() => resolveConfig(input), /无效记录/, 'a failed requirement read cannot create a default-space session')
  console.log('PASS Scheduled ownership persistence, legacy inputs, actual dispatch directories, rebinding, invalid targets and pending execution edits')
} finally { Date.now = originalNow; await rm(root, { recursive: true, force: true }) }
