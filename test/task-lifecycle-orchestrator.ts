import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { TaskLifecycleStore } from '../src/main/taskLifecycleStore'
import { TaskLifecycleService } from '../src/main/taskLifecycleService'
import type { AgentDef, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'lifecycle-host-'))
const agent: AgentDef = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', builtin: true, icon: '', installed: true, models: [], capabilities: { streaming: true, modelSelect: true, reasoningEffort: false, permissionModes: [{ id: 'ask', label: '按需批准', hint: '' }] } }
const start = AppServerRunner.prototype.startTurn
const sends: AppServerRunner[] = []
AppServerRunner.prototype.startTurn = async function() { sends.push(this) }
let enabled = true
const metadata = new SessionStore(join(root, 'sessions.json'))
const host = new Orchestrator(() => enabled ? agent : undefined, metadata, root, join(root, 'logs'))
const store = new TaskLifecycleStore(join(root, 'lifecycle'))
const lifecycle = new TaskLifecycleService(store, { session: id => host.getSessionById(id), busy: id => host.hasActiveSessionWork(id), pending: id => host.taskDecisions(id).length,
  reserve: id => host.reserveTaskMutation(id), mirrorArchive: (id, archived) => host.applyTaskArchive(id, archived), publish: session => host.publishTaskState(session) })
host.configureTaskArchive((id, archived) => lifecycle.archive(id, archived))
const accepted: Promise<void>[] = []
host.on('taskInputAccepted', id => { accepted.push(lifecycle.inputAccepted(id)) })
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 200; i++) { if (check()) return; await tick() }; assert.fail('did not settle') }
try {
  const session = host.createSession({ agentId: 'codex', workdir: root }, '原任务')
  await until(() => sends.length === 1)
  let seq = 100
  const finish = () => {
    const runner = sends.at(-1)!
    for (const [type, payload] of [['turn_started',{turnId:'t'+sends.length}],['turn_completed',{}]] as const) runner.emit('event',{sessionId:session.id,seq:seq++,ts:Date.now(),type,payload,state:'success'} satisfies UAEvent)
    runner.emit('done', { nativeSessionId: 'native', failed: false })
  }
  finish(); await until(() => session.status === 'idle')
  const state = lifecycle.snapshot(session.id)
  assert.equal(host.taskDecisions(session.id).length, 0)
  await lifecycle.decide(session.id, { actionId: 'defer', expectedVersion: state.record.version, inputRevision: state.inputRevision, turnRevision: state.turnRevision, disposition: 'standby' })
  const release = host.reserveTaskMutation(session.id)
  await assert.rejects(host.sendMessage(session.id, '状态保存中'), /状态正在保存/); release()
  enabled = false; await assert.rejects(host.sendMessage(session.id, '不可接受'), /agent_not_available/); enabled = true
  assert.equal(lifecycle.snapshot(session.id).record.phase, 'standby')
  await host.sendMessage(session.id, '继续同一任务'); await until(() => sends.length === 2)
  await Promise.all(accepted)
  assert.equal(lifecycle.snapshot(session.id).record.phase, 'active')
  assert.equal(host.listSessions().length, 1)
  await assert.rejects(Promise.resolve(host.setArchived(session.id, true)), /仍在执行/)
  assert.equal(session.archived, false); assert.equal(session.status, 'running')
  finish(); await until(() => session.status === 'idle')
  await host.setArchived(session.id, true)
  assert.equal(session.archived, true)
  const persisted = metadata.load()
  const reboot = new TaskLifecycleStore(join(root, 'lifecycle')); await reboot.hydrate(persisted)
  assert.equal(persisted.find(s => s.id === session.id)?.archived, true, 'journal restores archive even when legacy metadata mirror lagged')
  await host.setArchived(session.id, false)
  assert.equal(session.archived, false); assert.equal(sends.length, 2, 'restoring visibility never replays input')
} finally {
  AppServerRunner.prototype.startTurn = start
  host.disposeAll(); await rm(root, { recursive: true, force: true })
}
console.log('PASS R08 actual Orchestrator acceptance signal, failed input, archive reservation, busy guard, restart mirror and same Session continuation')
