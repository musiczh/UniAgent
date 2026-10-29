import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService } from '../src/main/teamService'
import { TeamStore } from '../src/main/teamStore'
import { ProjectStore } from '../src/main/projectStore'
import { Orchestrator } from '../src/main/orchestrator'
import { buildCommand } from '../src/main/adapter'
import { SessionStore } from '../src/main/sessionStore'
import { teamRuntime } from '../src/main/teamRuntime'
import { handoffMcpArgs } from '../src/main/handoff'
import { DEFAULT_TEAM_LIMITS, DEFAULT_TEAM_RULES } from '../src/shared/teamTypes'
import { splitFeishuContext } from '../src/shared/feishuContext'
import type { AgentDef, UAEvent } from '../src/shared/types'

// The real stores, orchestrator event log, ACLs and scheduler run here. Only the
// external Agent transport is replaced so races and failures are deterministic.
const agent: AgentDef = { id: 'codex', name: 'Codex', bin: 'codex', adapter: 'codex', icon: '', builtin: true, installed: true, models: [], capabilities: { modelSelect: true, reasoningEffort: true, streaming: true, steer: true, permissionModes: [{ id: 'read-only', label: 'Read only' }, { id: 'full-access', label: 'Full access' }] } }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r)) }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'team-contract-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const spaces = new ProjectStore(root)
  const space = spaces.create({ name: 'Test', primaryDirectory: workspace, additionalDirectories: [] })
  const orchestrator = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'), join(root, 'logs'), (cfg, validate) => spaces.resolveSessionConfig(cfg, validate))
  const starts: string[] = [], steers: string[] = [], answers: string[] = [], sentPermissions: Array<string | undefined> = []
  const record = (sid: string, event: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'>) => (orchestrator as any).record(sid, event)
  const status = (sid: string, value: string) => (orchestrator as any).setStatus(orchestrator.getSessionById(sid), value)
  orchestrator.sendTeamMessage = async (...args: any[]) => {
    const [sid, prompt, attachments, , permissionMode] = args
    assert.ok(!['running', 'awaiting-approval'].includes(orchestrator.getSessionById(sid)!.status), 'never start concurrent turns in one session')
    starts.push(sid); sentPermissions.push(permissionMode); status(sid, 'running'); record(sid, { type: 'user_message', payload: { text: prompt, attachments } }); record(sid, { type: 'turn_started', payload: { turnId: 'turn-' + starts.length } })
  }
  orchestrator.sendMessage = async (sid, prompt, attachments) => {
    if (!teamRuntime(sid)?.leader) return Orchestrator.prototype.sendMessage.call(orchestrator, sid, prompt, attachments)
    teamRuntime(sid)?.beforeUserTurn?.()
    if (orchestrator.getSessionById(sid)?.status === 'running') {
      record(sid, { type: 'user_message', payload: { text: prompt, attachments } }); return
    }
    await orchestrator.sendTeamMessage(sid, prompt, attachments)
  }
  orchestrator.steerTeamMessage = async (sid, prompt) => { assert.equal(orchestrator.getSessionById(sid)!.status, 'running'); steers.push(prompt) }
  orchestrator.respondToRequest = (sid, rid) => { answers.push(sid + ':' + rid); record(sid, { type: 'approval_request', state: 'success', payload: { requestId: rid } }); status(sid, 'running'); return { handled: true, hasPendingRequests: false } }
  orchestrator.interrupt = sid => { status(sid, 'idle') }
  const store = new TeamStore(root)
  const service = new TeamService(orchestrator, spaces, () => [agent], store)
  const notices: string[] = []; service.on('errorNotice', text => notices.push(text))
  const input = { name: 'Team', description: '', rules: DEFAULT_TEAM_RULES, leaderMemberId: 'leader', members: ['leader', 'alpha', 'beta'].map(id => ({ id, role: { id: 'role_' + id, name: id, agentId: 'codex', permissionMode: 'read-only' as const } })), limits: { ...DEFAULT_TEAM_LIMITS }, status: 'active' as const }
  const team = service.saveTeam(input)
  const p = await service.create({ teamId: team.id, spaceId: space.id, prompt: 'Analyse' }); await flush()
  const project = () => store.project(p.id)
  const sid = (member: string) => p.memberSessions[member]
  const tool = (member: string, name: string, args: unknown = {}) => service.handleTool(teamRuntime(sid(member))!.token, name, args) as Promise<any>
  const dispatch = async (member = 'alpha', extra: Record<string, unknown> = {}) => { const result = await tool('leader', 'dispatch_team_task', { requestId: 'req-' + project().assignments.length, memberId: member, title: 'Work ' + member, prompt: 'Analyse', ...extra }); await flush(); return result }
  const finish = async (member: string, text = 'Result', state: UAEvent['state'] = 'success') => {
    const a = project().assignments.findLast(a => a.memberId === member && !a.endedAt)
    record(sid(member), { type: 'agent_message', state: 'success', payload: { text, phase: 'final' } })
    record(sid(member), { type: 'turn_completed', state, payload: { turnId: a?.turnId } }); status(sid(member), 'idle'); await flush()
  }
  return { root, workspace, spaces, space, orchestrator, store, service, input, team, project, sid, tool, dispatch, finish, starts, steers, answers, notices, sentPermissions, record, status, close: () => { service.close(); rmSync(root, { recursive: true, force: true }) } }
}
let passed = 0
async function check(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  if (process.env.UNIAGENT_TEAM_TEST_FILTER && !new RegExp(process.env.UNIAGENT_TEAM_TEST_FILTER).test(name)) return
  const f = await fixture()
  try { await run(f); passed++; console.log('PASS ' + name) } finally { f.close() }
}

await check('create hook observes fixed member Sessions before the team starts', async f => {
  let observed: ReturnType<typeof f.project> | undefined
  let leaderStatus: string | undefined
  const project = await f.service.create({ teamId: f.team.id, spaceId: f.space.id, prompt: 'Hooked team' }, created => {
    observed = created
    const leaderId = created.memberSessions[created.team.leaderMemberId]
    leaderStatus = f.orchestrator.getSessionById(leaderId)?.status
  })
  assert.ok(observed, 'the hook runs once after fixed member Sessions exist')
  assert.equal(observed!.status, 'initializing', 'the hook runs before ready/running state is emitted')
  assert.equal(leaderStatus, 'draft', 'the Leader Session exists but has not started')
  assert.equal(f.store.project(project.id).status, 'running')
})

await check('orphaned team projects can recover, archive and delete', async f => {
  await f.dispatch('alpha')
  for (const sessionId of Object.values(f.project().memberSessions)) (f.orchestrator as any).removeSessionOwner(sessionId)
  await f.service.recover()
  assert.equal(f.project().status, 'interrupted')
  assert.equal(f.project().assignments[0].status, 'interrupted')
  f.service.archive(f.project().id)
  assert.ok(f.project().archivedAt)
  f.service.deleteProject(f.project().id)
  assert.throws(() => f.project(), /team_project_not_found/)
})

await check('recovery writes session metadata only when team state differs', async f => {
  f.service.rename(f.project().id, f.project().name)
  const store = (f.orchestrator as unknown as { store: SessionStore }).store
  const save = store.save.bind(store)
  let writes = 0
  store.save = sessions => { writes++; save(sessions) }
  await f.service.recover()
  assert.equal(writes, 0, 'unchanged team recovery must not rewrite the full session list')
  const member = f.orchestrator.getSessionById(f.sid('alpha'))!
  member.archived = true
  await f.service.recover()
  assert.equal(member.archived, false, 'recovery still reconciles a stale archive flag')
  assert.equal(writes, 1, 'only the changed member requires a session write')
})

await check('recovery yields during disk writes and publishes one complete catalog', async f => {
  const save = f.store.saveRecoveredProject.bind(f.store)
  let release!: () => void
  const disk = new Promise<void>(resolve => { release = resolve })
  let writes = 0, notifications = 0
  f.store.saveRecoveredProject = async project => { writes++; await disk; return save(project) }
  f.store.saveProject = () => { throw new Error('recovery must not write synchronously') }
  f.service.on('changed', () => { notifications++ })
  const starts = f.starts.length
  const recovery = f.service.recover()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(writes, 1)
  assert.equal(notifications, 0, 'no partial catalogs are published while recovery is pending')
  ;(f.service as any).tick()
  await flush()
  assert.equal(f.starts.length, starts, 'recovery must not dispatch persisted work while yielding')
  release()
  await recovery
  assert.equal(writes, 1, 'each recovered project is persisted only once')
  assert.equal(notifications, 1, 'one complete catalog replaces per-project notifications')
  assert.equal(new TeamStore(f.root).project(f.project().id).status, 'interrupted')
})

await check('invalid teams, frozen snapshots, project isolation and persistent dedicated roles', async f => {
  for (const patch of [{ leaderMemberId: '' }, { members: f.input.members.slice(0, 1) }, { members: [f.input.members[0], f.input.members[0]] }]) assert.throws(() => f.service.saveTeam({ ...f.input, ...patch }))
  f.service.saveTeam({ ...f.input, id: f.team.id, revision: f.team.revision, name: 'Changed template' })
  assert.equal(f.project().team.name, 'Team')
  const attachment = {kind:'file' as const,path:join(f.workspace,'facts.txt'),name:'facts.txt'}
  await f.service.send(f.project().id, 'Attached context', [attachment]); await flush()
  assert.deepEqual((await f.orchestrator.getEvents(f.sid('leader'))).findLast(e => e.type === 'user_message')?.payload.attachments, [attachment])
  const other = await f.service.create({ teamId: f.team.id, spaceId: f.space.id, prompt: 'Other' }); await flush()
  assert.notEqual(other.memberSessions.alpha, f.sid('alpha'))
  assert.equal(new TeamStore(f.root).project(f.project().id).team.members.length, 3)
  assert.throws(() => readFileSync(join(f.root, 'roles.json')), /ENOENT/)
})
await check('dispatch idempotency, member ACL, candidate result and real terminal', async f => {
  await assert.rejects(f.service.handleTool('bad', 'get_team_context', {}), /not_team_session/)
  const first = await f.dispatch('alpha')
  const repeat = await f.tool('leader', 'dispatch_team_task', { requestId: 'req-0', memberId: 'alpha', title: 'Work alpha', prompt: 'Analyse' })
  assert.equal(first.assignmentId, repeat.assignmentId); assert.equal(f.starts.filter(s => s === f.sid('alpha')).length, 1)
  await assert.rejects(f.tool('leader', 'dispatch_team_task', { requestId: 'req-0', memberId: 'alpha', title: 'Different', prompt: 'Analyse' }), /request_id_conflict/)
  await assert.rejects(f.tool('alpha', 'dispatch_team_task', {}), /leader_required/)
  await assert.rejects(f.orchestrator.sendMessage(f.sid('alpha'), 'Bypass'), /team_session_requires_project_route/)
  await f.tool('alpha', 'report_team_task', { assignmentId: first.assignmentId, attempt: 1, state: 'result', summary: 'Done', resultText: 'Confirmed' })
  assert.equal(f.project().assignments[0].status, 'running')
  await f.finish('alpha'); assert.equal(f.project().assignments[0].status, 'succeeded')
  assert.equal(f.project().assignments[0].result, 'Confirmed')
  assert.ok(f.steers.some(s => s.includes('Confirmed')), 'notify the running Leader immediately')
  const terminal = (await f.orchestrator.getEvents(f.sid('alpha'))).findLast(e => e.type === 'turn_completed')!
  const seq = f.project().inboxSeq; f.orchestrator.emit('event', terminal); assert.equal(f.project().inboxSeq, seq)
})
await check('dispatch keeps role permissions and only prompt constrains the work', async f => {
  f.store.change(f.project().id, p => { p.team.members.find(m => m.id === 'alpha')!.role.permissionMode = 'full-access' })
  const session = f.orchestrator.getSessionById(f.sid('alpha'))!
  session.config.permissionMode = 'full-access'
  session.nativeSessionId = 'full-access-thread'
  await assert.rejects(f.dispatch('alpha', { permissionMode: 'read-only' }), /unexpected_team_field/)
  const first = await f.dispatch('alpha', { prompt: 'Only inspect files; do not edit them.' })
  assert.equal(first.permissionMode, 'full-access')
  assert.equal(f.sentPermissions.at(-1), undefined)
  assert.match((await f.orchestrator.getEvents(session.id)).findLast(e => e.type === 'user_message')!.payload.text, /Only inspect files/)
  const sendMessage = f.orchestrator.sendMessage
  let command: ReturnType<typeof buildCommand> | undefined
  agent.capabilities.streaming = false
  f.orchestrator.sendMessage = async () => { command = buildCommand(agent, session.config, 'next', session.nativeSessionId) }
  try { await Orchestrator.prototype.sendTeamMessage.call(f.orchestrator, session.id, 'next', undefined, 'next') } finally { f.orchestrator.sendMessage = sendMessage; agent.capabilities.streaming = true }
  assert.equal(session.config.permissionMode, 'full-access')
  assert.equal(session.nativeSessionId, 'full-access-thread')
  assert.ok(command?.args.includes('full-access-thread'))
  await f.dispatch('alpha')
  assert.equal(f.project().assignments.at(-1)?.permissionMode, 'full-access', 'omitting permission uses the role limit')
  await assert.rejects(f.dispatch('beta', { permissionMode: 'full-access' }), /unexpected_team_field/)
})
await check('other sessions in the same workspace do not block this team project', async f => {
  const external = (f.orchestrator as any).createSessionRecord({ agentId: 'codex', projectId: f.space.id, workdir: f.workspace, permissionMode: 'full-access' }, 'external').session
  f.status(external.id, 'running')
  await f.dispatch('alpha')
  assert.equal(f.project().assignments[0].status, 'running')
  assert.ok(f.starts.includes(f.sid('alpha')))
})
await check('queued assignments record the current project wait reason', async f => {
  f.store.change(f.project().id, p => { p.team.limits.concurrency = 1 })
  await f.dispatch('alpha')
  await f.dispatch('beta')
  const queued = f.project().assignments.find(a => a.memberId === 'beta')!
  assert.equal(queued.status, 'queued')
  assert.match(queued.summary, /等待原因：当前项目并发已满/)
})
await check('zero limits leave scheduling and time unrestricted', async f => {
  assert.deepEqual(f.project().team.limits, { concurrency: 0, maxAssignments: 0, taskMinutes: 0, runMinutes: 0 })
  await f.dispatch('alpha'); await f.dispatch('beta')
  f.store.change(f.project().id, p => { p.activeMs = Number.MAX_SAFE_INTEGER; for (const a of p.assignments) a.activeMs = Number.MAX_SAFE_INTEGER })
  ;(f.service as any).tick()
  assert.deepEqual(f.project().assignments.map(a => a.status), ['running', 'running'])
  assert.equal(f.project().status, 'running')
})
await check('a stalled project does not block another team project scheduler', async f => {
  const other = await f.service.create({ teamId: f.team.id, spaceId: f.space.id, prompt: 'Other project' }); await flush()
  const originalGetEvents = f.orchestrator.getEvents.bind(f.orchestrator)
  let release!: () => void
  const stalled = new Promise<void>(resolve => { release = resolve })
  f.orchestrator.getEvents = async id => { if (id === f.sid('alpha')) await stalled; return originalGetEvents(id) }
  try {
    await f.dispatch('alpha')
    await f.service.handleTool(teamRuntime(other.memberSessions.leader)!.token, 'dispatch_team_task', { requestId: 'other-1', memberId: 'alpha', title: 'Other work', prompt: 'Analyse other' })
    await flush()
    assert.equal(f.store.project(other.id).assignments[0].status, 'running')
  } finally {
    release()
    f.orchestrator.getEvents = originalGetEvents
    await flush()
  }
})
await check('an ended blocked task remains blocked while Leader handles it', async f => {
  const a = await f.dispatch('alpha')
  await f.tool('alpha', 'report_team_task', { assignmentId: a.assignmentId, attempt: 1, state: 'blocked', summary: 'Need a decision', question: 'Which value?' })
  await f.finish('alpha', 'Partial')
  await f.finish('leader', 'Reviewing')
  ;(f.service as any).tick()
  assert.equal(f.project().assignments[0].status, 'blocked')
  assert.equal(f.project().assignments[0].question, 'Which value?')
  assert.ok(['running', 'waiting_user'].includes(f.project().status), 'pending results may wake the Leader to handle the blocked task')
})
await check('failure and blocked-result resume preserve successful output and session attempts', async f => {
  const a = await f.dispatch('alpha'); await f.dispatch('beta')
  await f.tool('alpha', 'report_team_task', { assignmentId: a.assignmentId, attempt: 1, state: 'blocked', summary: 'Need value', question: 'Which value?' })
  await f.finish('alpha', 'Partial'); await f.finish('beta', 'Failure details', 'failed')
  assert.equal(f.project().assignments[0].status, 'blocked'); assert.equal(f.project().interactions.length, 0)
  assert.equal(f.project().assignments[1].status, 'failed')
  await f.dispatch('alpha', { requestId: 'resume', resumeOf: a.assignmentId, prompt: 'Use 42' })
  assert.equal(f.project().assignments[0].attempt, 2); assert.equal(f.project().assignments[0].history[0].result, 'Partial')
  await f.finish('alpha', 'Confirmed 42'); assert.equal(f.project().assignments[0].status, 'succeeded')
  assert.equal(f.starts.filter(s => s === f.sid('alpha')).length, 2)
})
await check('team questions use native requests; completion still rejects stale inbox state', async f => {
  let c = await f.tool('leader', 'get_team_context')
  await assert.rejects(f.tool('leader', 'update_team_project', { expectedRevision: c.revision, handledInboxSeq: c.inboxSeq, basedOnInboxSeq: c.inboxSeq, action: 'ask_user', questionGroup: { questions: [{ id: 'a', prompt: 'A?' }] } }), /unexpected_team_field|invalid_team_action/)
  assert.equal(f.project().interactions.length, 0, 'removed team-specific question path cannot create interactions')
  await assert.rejects(f.tool('leader', 'update_team_project', { expectedRevision: c.revision, basedOnInboxSeq: c.inboxSeq - 1, action: 'complete', finalResult: { summary: 'Wrong' } }), /inbox_changed/)
  await f.dispatch(); await f.finish('alpha')
  await f.tool('leader', 'review_team_task', { assignmentId: f.project().assignments[0].id, attempt: 1, decision: 'accept', reason: '符合标准' })
  c = await f.tool('leader', 'get_team_context')
  await f.tool('leader', 'update_team_project', { expectedRevision: c.revision, handledInboxSeq: c.inboxSeq, basedOnInboxSeq: c.inboxSeq, action: 'complete', finalResult: { summary: 'Done' } })
  assert.ok(f.project().finalResult?.deliveredAt, 'persist final delivery time for chronological group chat')
  assert.equal(f.project().status, 'completed')
})
await check('an ended failed assignment does not block the Leader final result', async f => {
  const task = await f.dispatch('alpha')
  await f.finish('alpha', 'Partial implementation notes', 'failed')
  await f.tool('leader', 'review_team_task', { assignmentId: task.assignmentId, attempt: 1, decision: 'rework', reason: 'Leader took over the remaining implementation' })
  const context = await f.tool('leader', 'get_team_context')
  await f.tool('leader', 'update_team_project', {
    expectedRevision: context.revision,
    handledInboxSeq: context.inboxSeq,
    basedOnInboxSeq: context.inboxSeq,
    action: 'complete',
    finalResult: { summary: 'Leader completed the requested implementation and disclosed the failed member attempt.' }
  })
  assert.equal(f.project().status, 'completed')
  assert.match(f.project().finalResult!.summary, /Leader completed/)
})
await check('parallel native requests route once to their own member and stale cards expire', async f => {
  await f.dispatch('alpha'); await f.dispatch('beta')
  for (const member of ['alpha', 'beta']) { f.record(f.sid(member), { type: 'approval_request', state: 'pending', payload: { requestId: 'req_1_1', kind: 'question', params: { questions: [{ id: 'q', question: 'Value?' }] } } }); f.status(f.sid(member), 'awaiting-approval') }
  const [a, b] = f.project().interactions
  await assert.rejects(f.service.respond(f.project().id, a.id, a.revision, { answers: { q: { answers: ['A'] } } }), /interaction_wrong_recipient/)
  await f.tool('leader', 'answer_member_question', { interactionId: a.id, revision: a.revision, answer: { answers: { q: { answers: ['A'] } } } })
  assert.deepEqual(f.answers, [f.sid('alpha') + ':req_1_1']); assert.equal(f.project().interactions[1].state, 'pending')
  await assert.rejects(f.service.respond(f.project().id, a.id, a.revision, {}), /interaction_expired/)
  await f.finish('beta'); await assert.rejects(f.service.respond(f.project().id, b.id, b.revision, {}), /interaction_expired/)
})
await check('independent context, paged artifact reads and symlink escape rejection', async f => {
  const a = await f.dispatch('alpha'); await f.finish('alpha', 'SECRET_' + 'x'.repeat(20000)); await f.dispatch('beta')
  const artifact = f.project().artifacts[0]
  assert.equal((await f.tool('beta', 'get_team_context')).artifacts.length, 0)
  await assert.rejects(f.tool('beta', 'get_team_context', { artifactId: artifact.id }), /artifact_not_authorized/)
  await f.finish('beta'); await f.dispatch('beta', { contextRefs: [artifact.id] })
  assert.equal((await f.tool('beta', 'get_team_context', { artifactId: artifact.id })).nextOffset, 16000)
  const outside = join(f.root, 'outside'); writeFileSync(outside, 'outside'); symlinkSync(outside, join(f.workspace, 'escape'))
  assert.throws(() => f.service.checkedPath(f.project(), join(f.workspace, 'escape')), /invalid_artifact_path/)
})
await check('stop fence preserves interrupted state and never restarts queued work', async f => {
  await f.dispatch('alpha'); await f.dispatch('alpha', { requestId: 'queued' })
  f.service.stop(f.project().id); (f.service as any).tick(); await flush()
  assert.equal(f.project().status, 'interrupted'); assert.equal(f.starts.filter(s => s === f.sid('alpha')).length, 1)
  await f.finish('alpha', 'Late'); assert.equal(f.project().status, 'interrupted')
  await f.finish('leader', 'Late failure', 'failed'); assert.equal(f.project().status, 'interrupted', 'late Leader failure cannot reopen a stopped project')
})
await check('restart freezes work, expires native requests and resumes only the Leader', async f => {
  await f.dispatch('alpha'); await f.finish('alpha', 'Keep this'); await f.dispatch('beta')
  f.record(f.sid('beta'), { type: 'approval_request', state: 'pending', payload: { requestId: 'req_1_9', kind: 'question', params: {} } })
  for (const id of Object.values(f.project().memberSessions)) f.status(id, 'idle')
  const count = f.starts.length
  await f.service.recover(); await flush()
  assert.equal(f.project().status, 'interrupted'); assert.equal(f.project().assignments[1].status, 'interrupted')
  assert.equal(f.project().interactions[0].state, 'expired'); assert.equal(f.starts.length, count)
  f.service.resume(f.project().id); await flush()
  assert.deepEqual(f.starts.slice(count), [f.sid('leader')]); assert.equal(f.project().assignments[0].result, 'Keep this')
  assert.equal(new TeamStore(f.root).project(f.project().id).memberSessions.alpha, f.sid('alpha'))
})
await check('storage failure prevents dispatch, preserves disk state and resumes after repair', async f => {
  const dir = join(f.root, 'team-projects'), backup = dir + '-backup'
  renameSync(dir, backup); writeFileSync(dir, 'disk failure fixture')
  const count = f.starts.length
  await assert.rejects(f.dispatch(), /EEXIST|ENOTDIR/); await flush()
  assert.equal(f.starts.length, count); assert.equal(f.project().assignments.length, 0); assert.ok(f.notices.length)
  rmSync(dir); renameSync(backup, dir)
  f.service.stop(f.project().id); (f.service as any).tick(); f.service.resume(f.project().id); await flush()
  await f.dispatch(); assert.equal(f.project().assignments.length, 1)
})
await check('task permissions do not serialize the Leader and different member sessions', async f => {
  f.orchestrator.getSessionById(f.sid('leader'))!.config.permissionMode = 'full-access'
  f.store.change(f.project().id, p => { p.team.members.find(m => m.id === 'alpha')!.role.permissionMode = 'full-access' })
  f.orchestrator.getSessionById(f.sid('alpha'))!.config.permissionMode = 'full-access'
  await f.dispatch('alpha')
  await f.dispatch('beta')
  assert.deepEqual(f.project().assignments.map(a => a.status), ['running', 'running'])
  assert.deepEqual(f.sentPermissions.slice(-2), [undefined, undefined])
  assert.equal(f.orchestrator.getSessionById(f.sid('leader'))!.status, 'running')
  await f.finish('leader', 'Waiting for members')
  const starts = f.starts.length
  await f.service.send(f.project().id, 'Additional context'); await flush()
  assert.deepEqual(f.starts.slice(starts), [f.sid('leader')], 'user input starts the idle Leader while members are running')
  await f.finish('leader', 'Waiting for results')
  await f.finish('beta', 'Member result')
  assert.equal(f.orchestrator.getSessionById(f.sid('leader'))!.status, 'running', 'member results restart the idle Leader while a writer is running')
  assert.equal(f.project().assignments[0].status, 'running')
})
await check('write tasks still respect the team concurrency limit and same-session queue', async f => {
  f.orchestrator.getSessionById(f.sid('leader'))!.config.permissionMode = 'full-access'
  f.store.change(f.project().id, p => {
    p.team.limits.concurrency = 1
    for (const m of p.team.members) m.role.permissionMode = 'full-access'
  })
  await f.dispatch('alpha')
  await f.dispatch('beta')
  assert.equal(f.project().assignments[1].status, 'queued')
  assert.match(f.project().assignments[1].summary, /当前项目并发已满/)
  f.store.change(f.project().id, p => { p.team.limits.concurrency = 3 })
  await f.dispatch('alpha')
  assert.deepEqual(f.project().assignments.map(a => a.status), ['running', 'running', 'queued'])
  assert.match(f.project().assignments[2].summary, /上一项任务/)
  await f.finish('alpha')
  assert.deepEqual(f.project().assignments.map(a => a.status), ['succeeded', 'running', 'running'])
  assert.equal(f.starts.filter(s => s === f.sid('alpha')).length, 2)
})
await check('cancelling tasks keep their concurrency slot until the turn actually ends', async f => {
  f.orchestrator.getSessionById(f.sid('leader'))!.config.permissionMode = 'full-access'
  f.store.change(f.project().id, p => {
    p.team.limits.concurrency = 1
    for (const m of p.team.members) m.role.permissionMode = 'full-access'
  })
  f.orchestrator.interrupt = sid => { f.status(sid, 'cancelling') }
  const a = await f.dispatch('alpha')
  await f.dispatch('beta')
  await f.tool('leader', 'cancel_team_task', { assignmentId: a.assignmentId, reason: 'Change task' }); await flush()
  assert.deepEqual(f.project().assignments.map(a => a.status), ['cancelling', 'queued'])
  assert.equal(f.starts.filter(s => s === f.sid('beta')).length, 0)
  await f.finish('alpha', 'Partial result', 'cancelled')
  assert.deepEqual(f.project().assignments.map(a => a.status), ['cancelled', 'running'])
  assert.equal(f.starts.filter(s => s === f.sid('beta')).length, 1)
})
await check('assignment quota and active task timeout leave recoverable results', async f => {
  f.store.change(f.project().id, p => { p.team.limits.maxAssignments = 1; p.team.limits.taskMinutes = 1 })
  await f.dispatch(); await assert.rejects(f.dispatch('beta'), /limit_reached/)
  f.store.change(f.project().id, p => { p.assignments[0].activeMs = 60000 })
  ;(f.service as any).tick(); assert.equal(f.project().assignments[0].status, 'cancelling')
  await f.finish('alpha', 'Partial timeout', 'cancelled'); assert.equal(f.project().assignments[0].error, '任务超时')
})
await check('handled watermark cannot skip unseen earlier inbox pages', async f => {
  f.store.change(f.project().id, p => {
    p.inbox = [1, 2, 3].map(seq => ({ eventId: 'event-' + seq, seq, runId: 1, kind: 'result', summary: 'Result ' + seq, state: seq === 1 ? 'consumed' : 'pending' }))
    p.inboxSeq = 3; p.handledInboxSeq = 1
  })
  const c = await f.tool('leader', 'get_team_context', { sections: ['inbox'], cursor: '1', limit: 1 })
  await assert.rejects(f.tool('leader', 'update_team_project', { expectedRevision: c.revision, handledInboxSeq: 3 }), /invalid_handled_inbox_seq/)
})
await check('Leader failure keeps the provider error visible for recovery', async f => {
  f.record(f.sid('leader'), { type: 'error', state: 'failed', payload: { message: 'usageLimitExceeded: account quota exhausted' } })
  await f.finish('leader', '', 'failed')
  assert.equal(f.project().status, 'failed')
  assert.match(f.project().error!, /usageLimitExceeded/)
})
await check('creation failure after session allocation reconciles without starting work', async f => {
  const save = f.store.saveProject.bind(f.store)
  let injected = false
  f.store.saveProject = (p, semantic) => {
    if (p.id !== f.project().id && p.status === 'ready' && !injected) { injected = true; throw new Error('creation save failure') }
    return save(p, semantic)
  }
  const starts = f.starts.length
  await assert.rejects(f.service.create({ teamId: f.team.id, spaceId: f.space.id, prompt: 'Interrupted creation' }), /creation save failure/)
  const created = f.store.catalog().projects.find(p => p.id !== f.project().id)!
  assert.equal(created.status, 'failed')
  await f.service.recover(); await flush()
  assert.equal(f.starts.length, starts)
  for (const sid of Object.values(created.memberSessions)) assert.equal(f.service.binding(sid).p.id, created.id)
})
await check('notification save failure never silently replays the accepted turn', async f => {
  await f.finish('leader', 'Waiting')
  const save = f.store.saveProject.bind(f.store)
  let injected = false
  f.store.saveProject = (p, semantic) => {
    if (!injected && p.inbox.some(e => e.summary === 'New input' && e.state === 'delivered')) { injected = true; throw new Error('delivery save failure') }
    return save(p, semantic)
  }
  const starts = f.starts.length
  f.store.change(f.project().id, p => {
    p.inboxSeq += 1
    p.inbox.push({ eventId: 'new-input', seq: p.inboxSeq, runId: p.runId, kind: 'progress', summary: 'New input', state: 'pending' })
  })
  ;(f.service as any).schedule(); await flush()
  assert.equal(f.project().status, 'failed'); assert.equal(f.starts.length, starts + 1)
  f.status(f.sid('leader'), 'idle'); await f.service.recover(); await flush()
  assert.equal(f.starts.length, starts + 1)
  f.service.resume(f.project().id); await flush()
  assert.equal(f.starts.length, starts + 2)
})
await check('idle Leader waits silently across five-minute intervals and resumes on member delivery', async f => {
  await f.dispatch('alpha')
  await f.finish('leader', 'Waiting')
  assert.equal(f.project().status, 'waiting_members')
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    const count = f.starts.length
    for (const elapsed of [299000, 1001, 300000, 300001, 600000]) {
      now += elapsed; (f.service as any).tick(); await flush()
      assert.equal(f.starts.length, count, 'elapsed waiting time must not wake the Leader')
      assert.equal(f.project().status, 'waiting_members')
      assert.ok(!f.project().inbox.some(e => e.kind === 'progress'))
    }
    const assignment = f.project().assignments[0]
    await f.tool('alpha', 'report_team_task', { assignmentId: assignment.id, attempt: assignment.attempt, state: 'progress', summary: 'Still working' })
    await flush()
    assert.equal(f.project().assignments[0].summary, 'Still working')
    assert.equal(f.starts.length, count, 'member progress updates do not start another Leader turn')
    await f.finish('alpha', 'Member result')
    assert.deepEqual(f.starts.slice(count), [f.sid('leader')], 'member delivery still wakes the Leader')
    assert.equal(f.project().inbox.at(-1)?.kind, 'result')
    f.service.stop(f.project().id); await flush()
    now += 600000; (f.service as any).tick(); await flush()
    assert.equal(f.starts.length, count + 1, 'stopped projects never wake the Leader')
    assert.equal(f.project().status, 'interrupted')
  } finally { Date.now = realNow }
})
await check('stopping while a member start is awaiting events fences the start and resume', async f => {
  const getEvents = f.orchestrator.getEvents.bind(f.orchestrator)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  f.orchestrator.getEvents = async id => { if (id === f.sid('alpha')) await pending; return getEvents(id) }
  await f.dispatch('alpha')
  f.service.stop(f.project().id); (f.service as any).tick()
  assert.equal(f.project().status, 'stopping')
  assert.throws(() => f.service.resume(f.project().id), /not_resumable|still_running/)
  release(); await flush(); (f.service as any).tick()
  assert.equal(f.project().status, 'interrupted')
  assert.equal(f.starts.filter(sid => sid === f.sid('alpha')).length, 0)
})
await check('timer accrues real elapsed milliseconds and stops at final delivery', async f => {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    ;(f.service as any).syncRuntime(f.project().id)
    const baseline = f.project().activeMs
    now += 1234; (f.service as any).tick(); await flush()
    assert.equal(f.project().activeMs - baseline, 1234)
    const file = join(f.workspace, 'final.md'); writeFileSync(file, '# Final')
    const c = await f.tool('leader', 'get_team_context')
    await assert.rejects(f.tool('leader', 'update_team_project', { expectedRevision: c.revision, handledInboxSeq: c.inboxSeq, basedOnInboxSeq: c.inboxSeq, action: 'complete', finalResult: { summary: 'Done', artifactRefs: [join(f.root, 'outside.md')] } }), /invalid_artifact_path/)
    await f.tool('leader', 'update_team_project', { expectedRevision: c.revision, handledInboxSeq: c.inboxSeq, basedOnInboxSeq: c.inboxSeq, action: 'complete', finalResult: { summary: 'Done', artifactRefs: [file] } })
    assert.equal(f.project().activeSince, undefined)
    assert.equal(f.project().artifacts.find(a => a.id === f.project().finalResult?.artifactRefs[0])?.path, realpathSync(file))
    const finalMs = f.project().activeMs
    now += 7000; (f.service as any).tick(); await flush()
    assert.equal(f.project().activeMs, finalMs)
  } finally { Date.now = realNow }
})
await check('pending approvals keep the team waiting for the user without timed Leader wakeups', async f => {
  await f.dispatch('alpha'); await f.finish('leader', 'Waiting')
  const realNow = Date.now; let now = realNow(); Date.now = () => now
  try {
    f.record(f.sid('alpha'), { type: 'approval_request', state: 'pending', payload: { requestId: 'approval', kind: 'command' } })
    f.status(f.sid('alpha'), 'awaiting-approval'); await flush()
    assert.equal(f.project().status, 'waiting_user')
    const count = f.starts.length
    now += 600000; (f.service as any).tick(); await flush()
    assert.equal(f.starts.length, count)
    assert.ok(!f.project().inbox.some(e => e.kind === 'progress'))
  } finally { Date.now = realNow }
})
await check('stop attempts every role even if one interrupt fails and prevents late delivery wakeups', async f => {
  await f.dispatch('alpha'); await f.dispatch('beta'); await f.dispatch('alpha')
  const interrupted: string[] = []
  f.orchestrator.interrupt = sid => { interrupted.push(sid); if (sid === f.sid('leader')) throw Error('transport unavailable'); f.status(sid, 'idle') }
  const count = f.starts.length
  f.service.stop(f.project().id); await flush()
  assert.deepEqual(interrupted, Object.values(f.project().memberSessions))
  assert.equal(f.project().status, 'stopping')
  assert.ok(f.notices.some(n => n.includes('transport unavailable')))
  await f.finish('leader', 'Late'); await f.finish('alpha', 'Late member')
  ;(f.service as any).tick(); await flush()
  assert.equal(f.project().status, 'interrupted')
  assert.equal(f.starts.length, count)
  assert.ok(f.project().assignments.every(a => a.endedAt))
})
await check('deleting a template checks its revision and preserves existing projects', async f => {
  assert.throws(() => f.service.deleteTeam(f.team.id, f.team.revision + 1), /revision_conflict/)
  f.service.deleteTeam(f.team.id, f.team.revision)
  assert.equal(f.service.catalog().teams.length, 0)
  const saved = new TeamStore(f.root)
  assert.equal(saved.catalog().teams.length, 0)
  assert.equal(saved.project(f.project().id).team.name, 'Team')
  assert.ok(f.orchestrator.getSessionById(f.sid('leader')))
})

await check('direct messages bind the active attempt, persist receipts and never enqueue', async f => {
  const a = await f.dispatch()
  const input = { requestId: 'direct-1', memberId: 'alpha', assignmentId: a.assignmentId, attempt: 1, message: 'Scope is read-only; do not edit files.' }
  const starts = f.starts.length, count = f.steers.length
  const sent = await f.tool('leader', 'send_team_message', input)
  assert.equal(sent.state, 'sent'); assert.equal(sent.turnId, f.project().assignments[0].turnId)
  assert.equal(f.starts.length, starts); assert.equal(f.project().assignments.length, 1)
  assert.equal(f.steers.length, count + 1)
  assert.deepEqual(await f.tool('leader', 'send_team_message', input), sent)
  assert.equal(f.steers.length, count + 1)
  await assert.rejects(f.tool('leader', 'send_team_message', { ...input, message: 'Changed' }), /request_id_conflict/)
  await assert.rejects(f.tool('alpha', 'send_team_message', input), /leader_required/)
  await assert.rejects(f.tool('leader', 'send_team_message', { ...input, requestId: 'other', memberId: 'beta' }), /assignment_not_owned/)
  assert.equal((await f.tool('leader', 'send_team_message', { ...input, requestId: 'stale', attempt: 2 })).error, 'stale_attempt')
  assert.equal(f.orchestrator.getSessionById(f.sid('alpha'))!.config.permissionMode, 'read-only')
  assert.equal(new TeamStore(f.root).project(f.project().id).communications![0].state, 'sent')
  const context = await f.tool('alpha', 'get_team_context', { sections: ['communications'] })
  assert.equal(context.communications.length, 2)
  await f.finish('alpha')
  assert.equal((await f.tool('leader', 'send_team_message', { ...input, requestId: 'ended' })).state, 'failed')
})
await check('in-flight direct message deduplicates, merges terminal state and does not reactivate stopped projects', async f => {
  const a = await f.dispatch()
  const input = { requestId: 'slow', memberId: 'alpha', assignmentId: a.assignmentId, attempt: 1, message: 'Keep scope narrow' }
  let release!: () => void, calls = 0
  f.orchestrator.steerTeamMessage = async (_sid, _prompt, _attachments, target) => { calls++; assert.equal(target?.expectedTurnId, f.project().assignments[0].turnId); await new Promise<void>(r => { release = r }) }
  const pending = f.tool('leader', 'send_team_message', input)
  assert.equal(f.project().communications![0].state, 'sending')
  assert.equal((await f.tool('leader', 'send_team_message', input)).state, 'sending')
  assert.equal(calls, 1)
  const disk = new TeamStore(f.root).project(f.project().id)
  assert.equal(disk.communications![0].state, 'sending')
  f.service.stop(f.project().id); await flush()
  const status = f.project().status
  release(); assert.equal((await pending).state, 'sent')
  assert.equal(f.project().status, status)
  assert.equal((await f.tool('leader', 'send_team_message', input)).state, 'sent')
  assert.equal(calls, 1)
})
await check('direct message refusal, unknown transport result, native response gates and crash recovery', async f => {
  const a = await f.dispatch()
  const base = { memberId: 'alpha', assignmentId: a.assignmentId, attempt: 1, message: 'New constraints' }
  let calls = 0
  f.orchestrator.steerTeamMessage = async () => { calls++; throw new Error('transport timeout') }
  assert.equal((await f.tool('leader', 'send_team_message', { ...base, requestId: 'unknown' })).state, 'unknown')
  await f.tool('leader', 'send_team_message', { ...base, requestId: 'unknown' }); assert.equal(calls, 1)
  f.orchestrator.steerTeamMessage = async () => { calls++; throw Object.assign(new Error('provider rejected expected turn'), { deliveryState: 'failed' }) }
  assert.equal((await f.tool('leader', 'send_team_message', { ...base, requestId: 'rejected' })).state, 'failed')
  f.status(f.sid('alpha'), 'awaiting-approval')
  assert.equal((await f.tool('leader', 'send_team_message', { ...base, requestId: 'approval' })).error, 'member_awaiting_response')
  assert.equal(calls, 2)
  f.status(f.sid('alpha'), 'running')
  const originalSteer = agent.capabilities.steer
  agent.capabilities.steer = false
  try { await assert.rejects(f.tool('leader', 'send_team_message', { ...base, requestId: 'unsupported' }), /unsupported_target_capability.*does not support steer/) }
  finally { agent.capabilities.steer = originalSteer }
  f.store.change(f.project().id, p => { p.communications![0].state = 'sending' })
  await f.service.recover()
  assert.equal(f.project().communications![0].state, 'unknown')
  assert.equal(f.project().status, 'interrupted'); assert.equal(calls, 2)
})
await check('direct messages revalidate project space and requirement before transport', async f => {
  const a = await f.dispatch()
  const steers = f.steers.length
  ;(f.service as any).resolveConfig = () => { throw new Error('requirement_archived') }
  await assert.rejects(f.tool('leader', 'send_team_message', { requestId: 'invalid-space', memberId: 'alpha', assignmentId: a.assignmentId, attempt: 1, message: 'New scope' }), /requirement_archived/)
  assert.equal(f.steers.length, steers)
  assert.equal(f.project().communications?.length || 0, 0)
})
await check('direct intent write failure prevents transport and requirement validation precedes project allocation', async f => {
  const a = await f.dispatch()
  const save = f.store.saveProject.bind(f.store), steers = f.steers.length
  f.store.saveProject = () => { throw new Error('disk full') }
  await assert.rejects(f.tool('leader', 'send_team_message', { requestId: 'disk', memberId: 'alpha', assignmentId: a.assignmentId, attempt: 1, message: 'New constraints' }), /disk full/)
  assert.equal(f.steers.length, steers)
  f.store.saveProject = save
  const projects = f.service.catalog().projects.length
  ;(f.service as any).resolveConfig = (config: any) => { if (config.requirementId === 'missing') throw new Error('requirement_missing'); return f.spaces.resolveSessionConfig(config, true) }
  await assert.rejects(f.service.create({ teamId: f.team.id, spaceId: f.space.id, requirementId: 'missing', prompt: 'Test' }), /requirement_missing/)
  assert.equal(f.service.catalog().projects.length, projects)
  const p = await f.service.create({ teamId: f.team.id, spaceId: f.space.id, requirementId: 'req-valid', prompt: 'Test' })
  assert.equal(p.requirementId, 'req-valid')
  for (const sid of Object.values(p.memberSessions)) assert.equal(f.orchestrator.getSessionById(sid)!.config.requirementId, 'req-valid')
  await flush()
})

await check('decision publication freezes materials and validates answers across channels', async f => {
  await f.dispatch('alpha')
  const file = join(f.workspace, 'design.html'); writeFileSync(file, '<html><body>Version A</body></html>')
  const input = { requestId: 'decision-1', title: '选择方案', purpose: 'design', basedOnInboxSeq: f.project().inboxSeq, questions: [{ id: 'choice', question: '选择设计', type: 'single', options: [{ label: 'A' }, { label: 'B' }] }], materials: [{ path: file, title: '设计比较' }] }
  await assert.rejects(f.tool('leader', 'ask_team_user', { ...input, materials: [] }), /decision_material_required/)
  let returned = false
  const pending = f.tool('leader', 'ask_team_user', input).then(result => { returned = true; return result })
  const saved = f.project().interactions.find(i => i.requestId === input.requestId)!
  assert.equal(f.project().status, 'waiting_user', 'publication immediately blocks the project')
  assert.equal(f.orchestrator.getSessionById(f.sid('leader'))!.status, 'awaiting-approval', 'publication immediately blocks the Session')
  const questionEvents = (await f.orchestrator.getEvents(f.sid('leader'))).filter(event => event.payload.teamInteractionId === saved.id)
  assert.equal(questionEvents.length, 1, 'the main process publishes one authoritative question')
  assert.equal(questionEvents[0].payload.method, 'team/askUser')
  assert.equal(f.project().interactions.filter(interaction => interaction.state === 'pending').length, 1, 'a team question must not be copied into a native question')
  const codexArgs = handoffMcpArgs('codex', f.sid('leader'))
  assert.ok(codexArgs.includes('features.code_mode.direct_only_tool_namespaces=["mcp__uniagent"]'))
  assert.ok(!handoffMcpArgs('codex', f.sid('alpha')).some(argument => argument.includes('direct_only_tool_namespaces')))
  assert.ok(!handoffMcpArgs('traex', f.sid('leader')).some(argument => argument.includes('direct_only_tool_namespaces')))
  await flush()
  assert.equal(returned, false, 'publication must wait for the user answer')
  await f.finish('alpha')
  assert.equal(f.steers.length, 0, 'member deliveries must not advance a Leader awaiting the user')
  const artifact = f.service.artifact(f.project().id, saved.decision!.materials[0].artifactId)
  writeFileSync(file, '<html>Version B</html>')
  assert.match(readFileSync(artifact.path!, 'utf8'), /Version A/)
  const retry = f.tool('leader', 'ask_team_user', input)
  await assert.rejects(f.service.respond(f.project().id, saved.id, saved.revision, { answers: { choice: { answers: [''] } } }), /question_required/)
  await assert.rejects(f.service.respond(f.project().id, saved.id, saved.revision, { answers: { choice: { answers: ['A', 'B'] } } }), /single_answer_required/)
  assert.equal(f.orchestrator.getSessionById(f.sid('leader'))!.status, 'awaiting-approval', 'invalid answers keep the Session blocked')
  const answer = { answers: { choice: { answers: ['自定义方案'] } } }
  const inboxSeq = f.project().inboxSeq
  await f.service.respond(f.project().id, saved.id, saved.revision, answer)
  const question = await pending
  assert.deepEqual(question.answer, answer)
  assert.deepEqual(await retry, question, 'duplicate requests resume with the same answer')
  assert.equal(f.project().inboxSeq, inboxSeq, 'a blocking answer must not also inject a wakeup')
  await assert.rejects(f.service.respond(f.project().id, saved.id, saved.revision, answer), /interaction_expired/)
  assert.deepEqual(f.project().interactions.find(i => i.id === saved.id)?.answer, answer)
  assert.equal(f.orchestrator.getSessionById(f.sid('leader'))!.status, 'running')
  assert.equal((await f.orchestrator.getEvents(f.sid('leader'))).filter(event => event.payload.teamInteractionId === saved.id).length, 1, 'answer updates the existing event in place')
})
await check('blocking questions keep transport cancellation separate from project stop', async context => {
  const input = { requestId: 'cancel-question', title: '补充信息', purpose: 'information', basedOnInboxSeq: context.project().inboxSeq, questions: [{ id: 'answer', question: '补充范围', type: 'text' }] }
  const controller = new AbortController()
  const interrupted = assert.rejects(context.service.handleTool(teamRuntime(context.sid('leader'))!.token, 'ask_team_user', input, controller.signal), /question_wait_interrupted/)
  controller.abort(); await interrupted
  const question = context.project().interactions.find(interaction => interaction.requestId === input.requestId)!
  assert.equal(question.state, 'pending', 'an MCP disconnect must not cancel the user decision')
  assert.equal(context.orchestrator.getSessionById(context.sid('leader'))!.status, 'awaiting-approval')
  await context.service.respond(context.project().id, question.id, question.revision, { answers: { answer: { answers: ['All'] } } })
  await flush()
  const stopped = assert.rejects(context.tool('leader', 'ask_team_user', { ...input, requestId: 'stop-question', basedOnInboxSeq: context.project().inboxSeq }), /question_cancelled/)
  context.service.stop(context.project().id); await stopped
  assert.equal(context.project().interactions.find(interaction => interaction.requestId === 'stop-question')?.state, 'cancelled')
})

await check('waiting decisions block turns, force-send, project mutation and queued assignments', async context => {
  await context.dispatch('alpha')
  const queued = await context.dispatch('alpha')
  const input = { requestId: 'wait-question', title: '补充范围', purpose: 'information', basedOnInboxSeq: context.project().inboxSeq, questions: [{ id: 'scope', question: '范围？', type: 'text' }] }
  const pending = context.tool('leader', 'ask_team_user', input)
  const question = context.project().interactions.find(interaction => interaction.requestId === input.requestId)!
  await assert.rejects(context.service.send(context.project().id, 'Skip the question'), /team_awaiting_user_answer/)
  await assert.rejects(Orchestrator.prototype.sendMessage.call(context.orchestrator, context.sid('leader'), 'New turn'), /team_awaiting_user_answer/)
  await assert.rejects(context.orchestrator.forceSend(context.sid('leader'), 'New scope'), /team_awaiting_user_answer/)
  assert.throws(() => context.orchestrator.promoteQueueItem(context.sid('leader'), 'queued-message'), /team_awaiting_user_answer/)
  await assert.rejects(context.orchestrator.runNativeAction(context.sid('leader'), { type: 'goal.clear' }), /team_awaiting_user_answer/)
  await assert.rejects(context.dispatch('beta'), /team_awaiting_user_answer/)
  await assert.rejects(context.tool('leader', 'update_team_project', { expectedRevision: context.project().revision }), /team_awaiting_user_answer/)
  await assert.rejects(context.tool('leader', 'ask_team_user', { ...input, requestId: 'second-question' }), /team_awaiting_user_answer/)
  await context.finish('alpha')
  assert.equal(context.project().assignments.find(assignment => assignment.id === queued.assignmentId)!.status, 'queued')
  assert.equal(context.steers.length, 0)
  context.status(context.sid('leader'), 'idle')
  assert.equal(context.orchestrator.getSessionById(context.sid('leader'))!.status, 'awaiting-approval', 'native idle must not clear a waiting decision')
  const starts = context.starts.length
  ;(context.orchestrator as any).dispatchPendingQueue(context.orchestrator.getSessionById(context.sid('leader')))
  assert.equal(context.starts.length, starts)
  context.status(context.sid('leader'), 'running')
  await context.service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } })
  await pending; await flush()
  assert.equal(context.project().assignments.find(assignment => assignment.id === queued.assignmentId)!.status, 'running')
})

await check('answering a decision does not clear a pending native request', async context => {
  const pending = context.tool('leader', 'ask_team_user', { requestId: 'native-pending', title: '范围', purpose: 'information', basedOnInboxSeq: context.project().inboxSeq, questions: [{ id: 'scope', question: '范围？', type: 'text' }] })
  const question = context.project().interactions.find(interaction => interaction.requestId === 'native-pending')!
  ;(context.orchestrator as any).streamers.set(context.sid('leader'), { hasPendingRequests: () => true })
  await context.service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } })
  await pending
  assert.equal(context.orchestrator.getSessionById(context.sid('leader'))!.status, 'awaiting-approval')
  ;(context.orchestrator as any).streamers.delete(context.sid('leader'))
})

await check('a lost wait preserves the question and permits one answer-driven continuation', async context => {
  const pending = assert.rejects(context.tool('leader', 'ask_team_user', { requestId: 'detached', title: '范围', purpose: 'information', basedOnInboxSeq: context.project().inboxSeq, questions: [{ id: 'scope', question: '范围？', type: 'text' }] }), /question_wait_interrupted/)
  const question = context.project().interactions.find(interaction => interaction.requestId === 'detached')!
  context.status(context.sid('leader'), 'error'); await pending
  assert.equal(context.project().interactions.find(interaction => interaction.id === question.id)!.state, 'pending')
  const starts = context.starts.length
  await context.service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } })
  assert.equal(context.project().inbox.filter(item => item.kind === 'interaction').length, 1)
  await assert.rejects(context.service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } }), /interaction_expired/)
  await flush()
  assert.deepEqual(context.starts.slice(starts), [context.sid('leader')])
})

await check('an answered decision releases a held user queue exactly once', async context => {
  const session = context.orchestrator.getSessionById(context.sid('leader'))!
  ;(context.orchestrator as any).commitQueue(session, [{ id: 'held', prompt: 'Queued input', state: 'pending', attempts: 0, createdAt: Date.now() }])
  let queueStarts = 0
  ;(context.orchestrator as any).prepareUserMessageRun = () => ({ agent, input: {} })
  ;(context.orchestrator as any).run = () => { queueStarts++; context.status(session.id, 'running'); return true }
  const pending = context.tool('leader', 'ask_team_user', { requestId: 'queued-decision', title: '范围', purpose: 'information', basedOnInboxSeq: context.project().inboxSeq, questions: [{ id: 'scope', question: '范围？', type: 'text' }] })
  const question = context.project().interactions.find(interaction => interaction.requestId === 'queued-decision')!
  context.status(session.id, 'queued')
  ;(context.orchestrator as any).dispatchPendingQueue(session)
  await flush()
  assert.equal(queueStarts, 0)
  await context.service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } })
  await pending; await flush()
  assert.equal(queueStarts, 1)
})

for (const loadBeforeAnswer of [true, false]) await check('restart retains the waiting decision and resumes the same Session only after its answer, history loaded ' + loadBeforeAnswer, async context => {
  const leaderId = context.sid('leader')
  context.orchestrator.getSessionById(leaderId)!.nativeSessionId = 'missing-question-history-fixture'
  const pending = assert.rejects(context.tool('leader', 'ask_team_user', { requestId: 'restart-decision', title: '范围', purpose: 'information', basedOnInboxSeq: context.project().inboxSeq, questions: [{ id: 'scope', question: '范围？', type: 'text' }] }), /question_wait_interrupted/)
  const question = context.project().interactions.find(interaction => interaction.requestId === 'restart-decision')!
  context.service.close(); await pending
  const restarted = new Orchestrator(() => agent, new SessionStore(join(context.root, 'sessions.json')), join(context.root, 'artifacts'), join(context.root, 'logs'))
  restarted.loadPersisted()
  const service = new TeamService(restarted, context.spaces, () => [agent], new TeamStore(context.root))
  const starts: string[] = []
  restarted.sendTeamMessage = async sessionId => { starts.push(sessionId); (restarted as any).setStatus(restarted.getSessionById(sessionId), 'running') }
  try {
    await service.recover(); await flush()
    assert.equal(service.store.project(context.project().id).status, 'waiting_user')
    assert.equal(restarted.getSessionById(leaderId)!.status, 'awaiting-approval')
    assert.equal((restarted as any).events.get(leaderId).length, 0, 'recovery must not bypass lazy native transcript loading')
    if (loadBeforeAnswer) {
      const requests = (await restarted.getEvents(leaderId)).filter(event => event.payload.teamInteractionId === question.id)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].payload.interactionExpired, undefined, 'the recovered question remains answerable')
    }
    assert.equal(starts.length, 0)
    await service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } })
    const answered = (await restarted.getEvents(leaderId)).filter(event => event.payload.teamInteractionId === question.id)
    await flush()
    assert.deepEqual(starts, [leaderId])
    assert.equal(service.store.project(context.project().id).runId, context.project().runId)
    assert.equal(answered.length, 1, 'answering before native history loads must not create two request checkpoints')
    assert.equal(answered[0].state, 'success')
    await assert.rejects(service.respond(context.project().id, question.id, question.revision, { answers: { scope: { answers: ['All'] } } }), /interaction_expired/)
  } finally { service.close() }
})
await check('review and rework retain the earlier attempt and its artifacts', async f => {
  const task = await f.dispatch(); await f.finish('alpha', 'First conclusion')
  const artifacts = [...f.project().assignments[0].artifactRefs]
  await f.tool('leader', 'review_team_task', { assignmentId: task.assignmentId, attempt: 1, decision: 'rework', reason: '补齐边界' })
  await f.dispatch('alpha', { requestId: 'rework', resumeOf: task.assignmentId })
  const current = f.project().assignments[0]
  assert.equal(current.attempt, 2)
  assert.equal(current.history[0].result, 'First conclusion')
  assert.deepEqual(current.history[0].artifactRefs, artifacts)
  assert.equal(current.history[0].review?.decision, 'rework')
  assert.deepEqual(current.artifactRefs, [])
})

await check('trusted initial input keeps Feishu source separate from project goal', async f => {
  const send = f.orchestrator.sendMessage
  let input: any[] = []
  f.orchestrator.sendMessage = async (...args) => { input = args; return send(...args) }
  const p = await f.service.create({ teamId: f.team.id, spaceId: f.space.id, prompt: 'Clean goal' }, undefined, { prompt: 'Clean goal with bridge context', source: 'feishu' })
  assert.equal(p.goal, 'Clean goal')
  assert.equal(p.name, 'Clean goal')
  assert.equal(input[1], 'Clean goal with bridge context')
  assert.deepEqual(input[5], { source: 'feishu' })
})
await check('Feishu Leader delivery renews turn permission without changing machine provenance', async f => {
  const sid = f.sid('leader')
  f.record(sid, { type: 'user_message', payload: { text: 'Feishu goal', source: 'feishu' } })
  const first = f.orchestrator.getFeishuSendTurn(sid)
  assert.ok(first)
  await f.finish('leader', 'Waiting for delivery')
  assert.equal(f.orchestrator.getFeishuSendTurn(sid), undefined, 'the finished turn cannot send')
  f.orchestrator.sendMessage = async (id, prompt, attachments, _context, _plan, bubble) => {
    f.status(id, 'running')
    f.record(id, { type: 'user_message', payload: { text: prompt, attachments, source: bubble?.source } })
  }
  await Orchestrator.prototype.sendTeamMessage.call(f.orchestrator, sid, 'Member delivery', undefined, '处理团队消息')
  const next = f.orchestrator.getFeishuSendTurn(sid)
  assert.ok(next)
  assert.notEqual(next, first, 'old uploads retain an expired turn identity')
  const input = (await f.orchestrator.getEvents(sid)).at(-1)!
  assert.equal(input.payload.source, 'mcp')
  assert.equal(splitFeishuContext(input.payload.text)?.text, 'Member delivery')
  f.record(sid, { type: 'user_message', payload: { text: 'Desktop takeover', source: 'app' } })
  await Orchestrator.prototype.sendTeamMessage.call(f.orchestrator, sid, 'Later delivery')
  assert.equal(f.orchestrator.getFeishuSendTurn(sid), undefined, 'desktop input revokes continuation')
  assert.equal(splitFeishuContext((await f.orchestrator.getEvents(sid)).at(-1)!.payload.text), undefined)
  f.record(f.sid('alpha'), { type: 'user_message', payload: { text: 'Member input', source: 'mcp' } })
  assert.equal(f.orchestrator.getFeishuSendTurn(f.sid('alpha')), undefined, 'members cannot inherit Leader permission')
})
for (const end of ['stop', 'complete', 'fail', 'archive'] as const) {
  await check('Feishu team continuation is revoked on ' + end, async f => {
    const sid = f.sid('leader')
    f.record(sid, { type: 'user_message', payload: { text: 'Feishu goal', source: 'feishu' } })
    await f.finish('leader', 'Waiting')
    if (end === 'complete') {
      f.status(sid, 'running')
      const context = await f.tool('leader', 'get_team_context')
      await f.tool('leader', 'update_team_project', { expectedRevision: context.revision, handledInboxSeq: context.inboxSeq, basedOnInboxSeq: context.inboxSeq, action: 'complete', finalResult: { summary: 'Done' } })
    } else if (end === 'fail') {
      f.record(sid, { type: 'turn_completed', state: 'failed', payload: {} })
    } else if (end === 'archive') {
      f.service.archive(f.project().id)
      f.service.archive(f.project().id, false)
    } else f.service.stop(f.project().id)
    f.status(sid, 'running')
    f.record(sid, { type: 'user_message', payload: { text: 'Late delivery', source: 'mcp' } })
    assert.equal(f.orchestrator.getFeishuSendTurn(sid), undefined)
  })
}
await check('ordinary Leader queue blocks delivery while member input stays protected', async f => {
  await Orchestrator.prototype.sendMessage.call(f.orchestrator, f.sid('leader'), 'Follow up')
  const item = f.orchestrator.getQueue(f.sid('leader'))[0]
  assert.equal(item.prompt, 'Follow up')
  assert.equal(f.orchestrator.teamDeliveryBlocked(f.sid('leader')), true)
  f.orchestrator.editQueueItem(f.sid('leader'), item.id, 'Edited follow up')
  assert.equal(f.orchestrator.getQueue(f.sid('leader'))[0].prompt, 'Edited follow up')
  f.orchestrator.dequeue(f.sid('leader'), item.id)
  assert.equal(f.orchestrator.teamDeliveryBlocked(f.sid('leader')), false)
  await assert.rejects(f.orchestrator.forceSend(f.sid('alpha'), 'Bypass'), /team_member_read_only/)
})
await check('stopping during Plan preparation never starts a Leader turn', async f => {
  f.status(f.sid('leader'), 'idle')
  let release!: () => void
  let preparing!: () => void
  const started = new Promise<void>(resolve => { preparing = resolve })
  ;(f.orchestrator as any).ensureStreamerForNativeAction = () => ({ setCollaborationMode: () => { preparing(); return new Promise<void>(resolve => { release = resolve }) } })
  const pending = Orchestrator.prototype.sendMessage.call(f.orchestrator, f.sid('leader'), 'Plan after stop', undefined, undefined, true)
  await started
  Orchestrator.prototype.interrupt.call(f.orchestrator, f.sid('leader'))
  release()
  await assert.rejects(pending, /team_start_cancelled/)
  assert.ok(!(await f.orchestrator.getEvents(f.sid('leader'))).some(e => e.type === 'user_message' && e.payload.text === 'Plan after stop'))
})
console.log('team service: ' + passed + ' scenarios passed')
