import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { agentForSession, assertAgentSupportsSteer, type AgentDef, type AgentRole, type Attachment, type Session, type SessionConfig, type UAEvent } from '../shared/types'
import type { TeamAssignment, TeamCommunication, TeamCreateProjectInput, TeamDefinition, TeamDefinitionInput, TeamInteraction, TeamProject } from '../shared/teamTypes'
import { WorktreeService, parseWorkspaceSelection } from './worktreeService'
import { TeamStore, prepareTeam, teamId, teamKeys, teamRecord, teamText } from './teamStore'
import { authenticateTeamRuntime, bindTeamRuntime, TEAM_EXECUTION } from './teamRuntime'
import { assignmentPrompt, memberContext, teamInstructions } from './teamContext'
import { agentRoleUnavailableReason, zcodeRoleSelection } from './agentRoles'
import { copyAgentRole } from './roleStore'
import type { Orchestrator } from './orchestrator'
import type { ProjectStore } from './projectStore'
import { createTeamDecision } from './teamDecisions'
import { pendingTeamQuestion, validateTeamAnswer, teamInteractionForUser } from '../shared/teamQuestions'
import { asInteractionRequest } from '../shared/interactionRequests'
import { isMcpToolApproval } from '../shared/questions'
import { isSessionBusy } from '../shared/sessionStatus'

const NL = String.fromCharCode(10)
const ACTIVE = new Set(['queued', 'running', 'blocked', 'cancelling'])
const LIVE = new Set(['ready', 'running', 'waiting_members', 'waiting_user'])
const strings = (v: unknown, label: string, max = 100): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > max) throw new Error('invalid_' + label)
  return v.map(x => teamText(x, label, 8000))
}
export class TeamRuntimeError extends Error {
  constructor(message: string, readonly details: unknown) { super(message) }
}
/** Trusted main-process entry only; never accepted as part of renderer input. */
export interface TeamInitialTurn { prompt: string; source: 'feishu' }
export class TeamService extends EventEmitter {
  readonly store: TeamStore
  private delivering = new Set<string>()
  private scheduling = new Set<string>()
  private scheduled = false
  private readWatermarks = new Map<string, Set<number>>()
  private reservations = new Set<string>()
  private storageFailures = new Set<string>()
  private questionWaiters = new Map<string, Set<() => void>>()
  private closed = false
  private recovering = false
  private timer: ReturnType<typeof setInterval>
  constructor(private orchestrator: Orchestrator, private spaces: ProjectStore, private agents: () => AgentDef[], store = new TeamStore(), private resolveConfig: (config: SessionConfig, validate: boolean) => SessionConfig = (config, validate) => spaces.resolveSessionConfig(config, validate)) {
    super()
    this.store = store
    orchestrator.on('event', (ev: UAEvent) => { if (!this.closed) this.onEvent(ev) })
    orchestrator.on('statusChange', ({ sessionId }: { sessionId: string }) => {
      if (this.closed || this.recovering) return
      const binding = orchestrator.getSessionById(sessionId)?.teamBinding
      if (binding) {
        try { this.syncRuntime(binding.teamProjectId) } catch (e) { this.emit('errorNotice', String(e)) }
        this.schedule()
      }
    })
    this.timer = setInterval(() => { try { this.tick() } catch (e) { this.emit('errorNotice', String(e)) } }, 5000)
    this.timer.unref()
  }
  close(): void { clearInterval(this.timer); this.closed = true; for (const callbacks of [...this.questionWaiters.values()]) for (const check of [...callbacks]) check() }
  hasActiveWork(): boolean {
    return this.delivering.size > 0 || this.scheduling.size > 0 || this.reservations.size > 0 ||
      this.store.catalog().projects.some(p => !p.archivedAt && (p.status === 'stopping' ||
        LIVE.has(p.status) && p.assignments.some(a => a.runId === p.runId && ACTIVE.has(a.status))))
  }
  catalog() {
    const catalog = this.store.catalog()
    const unavailableReasons: Record<string, string> = {}
    for (const team of catalog.teams) { try { this.validateTeam(team) } catch (e) { unavailableReasons[team.id] = String(e) } }
    return { ...catalog, unavailableReasons }
  }
  private save(p: TeamProject, semantic = true): TeamProject {
    try {
      const next = this.store.saveProject(p, semantic)
      this.didSave(next); this.emit('changed'); return next
    }
    catch (error) { this.storageFailures.add(p.id); this.emit('errorNotice', '团队项目保存失败，已暂停派单：' + String(error)); throw error }
  }
  private didSave(next: TeamProject): void {
    this.orchestrator.syncTeamQuestions(next.memberSessions[next.team.leaderMemberId], next.interactions.filter(interaction => interaction.runId === next.runId && interaction.kind === 'leader_question' && interaction.decision), LIVE.has(next.status) && !next.archivedAt)
    if (next.archivedAt || !LIVE.has(next.status)) this.orchestrator.clearFeishuTeamInput(next.memberSessions[next.team.leaderMemberId])
    this.storageFailures.delete(next.id); for (const i of next.interactions) for (const check of [...this.questionWaiters.get(i.id) || []]) check()
  }
  private change(id: string, edit: (p: TeamProject) => void): TeamProject { const p = this.store.project(id); edit(p); return this.save(p) }
  worktreeBusy(path: string): boolean {
    return this.store.catalog().projects.some(p => p.worktree?.checkoutRoot === path &&
      (p.status === 'initializing' || p.status === 'stopping' || this.scheduling.has(p.id) || this.delivering.has(p.id) ||
        p.assignments.some(a => a.runId === p.runId && ACTIVE.has(a.status))))
  }
  returnWorktree(path: string): () => void {
    const previous = this.store.catalog().projects.filter(p => p.worktree?.checkoutRoot === path)
    const restore = (): void => { for (const p of previous) { this.save(p); this.configureRuntime(p) } }
    try {
      for (const original of previous) {
        const p = structuredClone(original)
        const config = this.resolveConfig({ agentId: p.team.members[0].role.agentId, projectId: p.spaceId, requirementId: p.requirementId, workdir: '' }, true)
        delete p.worktree
        p.spaceRoots = [config.workdir, ...(config.additionalDirectories || [])]
        this.save(p)
        this.configureRuntime(p)
      }
    } catch (error) { restore(); throw error }
    return restore
  }
  private waitForAnswer(projectId: string, questionId: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const callbacks = this.questionWaiters.get(questionId) || new Set<() => void>()
      const cleanup = (): void => { callbacks.delete(check); if (!callbacks.size) this.questionWaiters.delete(questionId); signal?.removeEventListener('abort', cancel) }
      const cancel = (): void => {
        cleanup()
        try {
          const project = this.store.project(projectId)
          const interaction = project.interactions.find(item => item.id === questionId)
          reject(new Error(interaction?.state === 'pending' && interaction.runId === project.runId && LIVE.has(project.status) && !project.archivedAt
            ? 'question_wait_interrupted' : interaction?.state === 'cancelled' ? 'question_cancelled' : 'interaction_expired'))
        }
        catch (error) { reject(error) }
      }
      const check = (): void => {
        try {
          const p = this.store.project(projectId)
          const i = p.interactions.find(i => i.id === questionId)
          if (i?.state === 'answered') { cleanup(); resolve({ questionId, revision: i.revision, state: i.state, answer: i.answer, materials: i.decision?.materials }); return }
          if (!this.closed && i?.state === 'pending' && i.runId === p.runId && LIVE.has(p.status) && !p.archivedAt && ['running', 'queued', 'awaiting-approval'].includes(this.session(i.sessionId).status)) return
          cleanup()
          if (i?.state === 'pending' && i.runId === p.runId && LIVE.has(p.status) && !p.archivedAt) { reject(new Error('question_wait_interrupted')); return }
          if (i?.state === 'pending') this.change(projectId, next => { const request = next.interactions.find(item => item.id === questionId)!; request.state = 'expired'; request.revision += 1 })
          reject(new Error(i?.state === 'cancelled' ? 'question_cancelled' : 'interaction_expired'))
        } catch (error) { cleanup(); reject(error) }
      }
      callbacks.add(check); this.questionWaiters.set(questionId, callbacks)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel(); else check()
    })
  }
  private session(id: string): Session { const s = this.orchestrator.getSessionById(id); if (!s) throw new Error('team_session_missing'); return s }
  binding(sessionId: string) {
    const s = this.session(sessionId)
    if (!s.teamBinding) throw new Error('not_team_session')
    const p = this.store.project(s.teamBinding.teamProjectId)
    const memberId = s.teamBinding.memberId
    if (p.memberSessions[memberId] !== sessionId) throw new Error('team_session_binding_conflict')
    return { p, memberId, leader: memberId === p.team.leaderMemberId }
  }
  private configureRuntime(p: TeamProject): void {
    for (const m of p.team.members) {
      const sid = p.memberSessions[m.id]
      if (sid) bindTeamRuntime(sid, m.id === p.team.leaderMemberId, teamInstructions(p, m.id), m.id === p.team.leaderMemberId ? () => this.prepareLeaderTurn(p.id) : undefined, () => this.rewindReason(p.id), () => this.afterRewind(p.id))
    }
  }
  private rewindReason(id: string): string | undefined {
    const p = this.store.project(id)
    if (p.archivedAt) return '请先恢复已归档的专家团会话'
    if (this.delivering.has(id) || this.scheduling.has(id) || p.status === 'stopping' ||
      Object.values(p.memberSessions).some(sid => this.reservations.has(sid) || isSessionBusy(this.session(sid).status)) ||
      p.assignments.some(a => a.runId === p.runId && ACTIVE.has(a.status))) return '请先停止专家团，再回退 Leader 会话；成员已执行的修改不会随会话回退撤销'
    return undefined
  }
  private afterRewind(id: string): void {
    const p = this.store.project(id)
    if (p.finalResult) p.previousResults.push({ runId: p.runId, result: p.finalResult })
    p.finalResult = undefined
    if (p.messages.length) p.legacyMessagesArchived = true
    for (const i of p.interactions) if (i.state === 'pending') { i.state = 'expired'; i.revision += 1 }
    p.runId += 1; p.status = 'interrupted'; p.activeMs = 0; p.activeSince = undefined
    p.handledInboxSeq = p.inboxSeq; p.lastTerminalSeq = {}; p.leaderStartSeq = undefined
    this.readWatermarks.delete(p.memberSessions[p.team.leaderMemberId])
    this.addInbox(p, 'recovery', 'Leader 会话已回退。此前成员任务、交付与决策保留为历史，成员产生的外部修改没有自动撤销。继续前核对工作区与历史记录，再决定是否重新派单。')
    this.save(p)
  }

  async recover(): Promise<void> {
    this.recovering = true
    try {
      for (const p of this.store.catalog().projects) {
        try {
          p.sessionMode = 'leader'
          // Session records already contain the binding, even if the final project save was interrupted.
          for (const session of this.orchestrator.listSessions()) {
            if (session.teamBinding?.teamProjectId === p.id && !p.memberSessions[session.teamBinding.memberId]) p.memberSessions[session.teamBinding.memberId] = session.id
          }
          for (const c of p.communications || []) if (c.state === 'sending') { c.state = 'unknown'; c.error = '应用重启，投递结果未知；请核对成员上下文，勿自动重发'; c.settledAt = Date.now() }
          const question = pendingTeamQuestion(p)
          if (!['completed', 'failed', 'interrupted'].includes(p.status)) p.status = question ? 'waiting_user' : 'interrupted'
          p.activeSince = undefined
          for (const a of p.assignments) if (ACTIVE.has(a.status)) { a.status = 'interrupted'; a.endedAt ||= Date.now(); a.error = '应用重启，等待 Leader 决定是否续做'; a.lastTick = undefined }
          for (const i of p.interactions) if (i.state === 'pending' && i.id !== question?.id) { i.state = 'expired'; i.revision += 1 }
          this.didSave(await this.store.saveRecoveredProject(p))
          for (const m of p.team.members) this.binding(p.memberSessions[m.id])
          this.configureRuntime(p)
          const leaderId = p.memberSessions[p.team.leaderMemberId]
          const leader = this.orchestrator.getSessionById(leaderId)
          if (leader && (leader.title !== p.name.trim().slice(0, 80) || !leader.titleLocked)) {
            this.orchestrator.renameSession(leaderId, p.name)
          }
          for (const sid of Object.values(p.memberSessions)) {
            const session = this.orchestrator.getSessionById(sid)
            if (session && !!session.archived !== !!p.archivedAt) this.orchestrator.setArchived(sid, !!p.archivedAt, TEAM_EXECUTION)
          }
        } catch (error) {
          this.storageFailures.add(p.id)
          p.status = 'interrupted'; p.error = String(error)
          this.didSave(await this.store.saveRecoveredProject(p))
        }
      }
    } finally { this.recovering = false }
    this.emit('changed')
  }
  private validateTeam(t: TeamDefinition): void {
    if (t.members.length < 2 || !t.members.some(m => m.id === t.leaderMemberId)) throw new Error('team_requires_one_leader_and_member')
    for (const m of t.members) {
      const role = copyAgentRole(m.role)
      delete role.workdir; delete role.projectId
      const reason = agentRoleUnavailableReason(role, this.agents())
      if (reason) throw new Error(m.role.name + ': ' + reason)
      const agent = this.agents().find(a => a.id === role.agentId)!
      if (!['codex', 'traex', 'claude', 'zcode'].includes(agent.adapter)) throw new Error(m.role.name + ': team_mcp_unsupported')
    }
  }
  private readonly worktrees = new WorktreeService()
  private readonly worktreeCreates = new Map<string, { scope: string; promise: Promise<TeamProject> }>()
  private readonly worktreeStarts = new Map<string, Promise<void>>()

  async create(input: TeamCreateProjectInput, beforeStart?: (project: TeamProject) => void, initialTurn?: TeamInitialTurn, background = false): Promise<TeamProject> {
    const selection = parseWorkspaceSelection(input.workspaceSelection)
    if (selection?.mode !== 'worktree') return this.createProject(input, beforeStart, initialTurn)
    const key = selection.requestId!
    const scope = JSON.stringify([input.spaceId, input.teamId, input.requirementId, selection.baseRef])
    const pending = this.worktreeCreates.get(key)
    if (pending) {
      if (pending.scope !== scope) throw new Error('工作树创建请求与团队草稿不一致')
      return pending.promise
    }
    const promise = this.createProject(input, beforeStart, initialTurn, background)
    this.worktreeCreates.set(key, { scope, promise })
    try { return await promise }
    finally { this.worktreeCreates.delete(key) }
  }

  private async createProject(input: TeamCreateProjectInput, beforeStart?: (project: TeamProject) => void, initialTurn?: TeamInitialTurn, background = false): Promise<TeamProject> {
    const v = teamRecord(input)
    teamKeys(v, ['teamId', 'spaceId', 'requirementId', 'prompt', 'attachments', 'workspaceSelection'])
    const selection = parseWorkspaceSelection(input.workspaceSelection)
    const team = this.store.team(teamText(v.teamId, 'team_id', 128))
    if (team.status !== 'active') throw new Error('team_not_active')
    this.validateTeam(team)
    const space = this.spaces.get(teamText(v.spaceId, 'space_id', 128))
    if (!space) throw new Error('space_not_found')
    const goal = teamText(v.prompt, 'prompt', 100000)
    const requirementId = v.requirementId === undefined ? undefined : teamText(v.requirementId, 'requirement_id', 128)
    this.resolveConfig({ agentId: team.members[0].role.agentId, projectId: space.id, workdir: '', requirementId }, true)
    const config = this.spaces.resolveSessionConfig({ agentId: team.members[0].role.agentId, projectId: space.id, workdir: '' }, true)
    let p: TeamProject = { id: teamId('tp'), sessionMode: 'leader', revision: 0, name: goal.split(NL)[0].slice(0, 60), goal, spaceId: space.id, spaceRoots: [config.workdir, ...(config.additionalDirectories || [])], teamId: team.id, team, memberSessions: Object.fromEntries(team.members.map(m => [m.id, teamId('s')])), runId: 1, status: 'initializing', phase: '准备', summary: '', sharedContext: { brief: goal, decisions: [], openQuestions: [] }, assignments: [], inbox: [], inboxSeq: 0, handledInboxSeq: 0, interactions: [], artifacts: [], messages: [], previousResults: [], createdAt: Date.now(), updatedAt: Date.now(), activeMs: 0 }
    p.requirementId = requirementId
    if (selection?.mode === 'worktree') {
      const previous = this.catalog().projects.find(project => project.worktree?.creationRequestId === selection.requestId)
      if (previous) {
        if (previous.spaceId !== space.id || previous.teamId !== team.id || previous.requirementId !== requirementId || previous.worktree?.baseRef !== selection.baseRef) throw new Error('工作树创建请求与团队草稿不一致')
        if (Object.values(previous.memberSessions).some(id => this.orchestrator.getSessionById(id))) return previous
        p = previous
        p.status = 'initializing'
        p.goal = goal
        p.name = goal.split(NL)[0].slice(0, 60)
        p.sharedContext.brief = goal
      } else p.worktree = await this.worktrees.allocate(space, selection)
    }
    p = this.save(p)
    if (background && p.worktree) {
      this.orchestrator.createTeamSessions(team.members.map(m => ({ id: p.memberSessions[m.id], title: m.id === p.team.leaderMemberId ? p.name : p.name + ' · ' + m.role.name, binding: { teamProjectId: p.id, memberId: m.id }, config: this.roleConfig(m.role, p) })))
      this.orchestrator.updateWorktreeTask(p.memberSessions[p.team.leaderMemberId], { kind: 'message', prompt: goal, attachments: input.attachments })
      this.configureRuntime(p)
      void this.prepareWorktreeProject(p.id)
      return this.store.project(p.id)
    }
    try {
      if (p.worktree) {
        p.worktree = await this.worktrees.create(p.worktree)
        const workspace = this.spaces.resolveSessionConfig({ ...config, worktree: p.worktree }, true)
        p.spaceRoots = [workspace.workdir, ...(workspace.additionalDirectories || [])]
        p = this.save(p)
      }
      const sessions = this.orchestrator.createTeamSessions(team.members.map(m => ({ id: p.memberSessions[m.id], title: m.id === p.team.leaderMemberId ? p.name : p.name + ' · ' + m.role.name, binding: { teamProjectId: p.id, memberId: m.id }, config: this.roleConfig(m.role, p) })))
      p.memberSessions = Object.fromEntries(sessions.map(s => [s.teamBinding!.memberId, s.id]))
      // Bridges that need an external conversation anchor must bind it after the
      // fixed member Sessions exist but before ready/send emits the first runnable
      // project state. Keep this synchronous so no team event can overtake it.
      beforeStart?.(structuredClone(p))
      p.status = 'ready'; p = this.save(p)
      this.configureRuntime(p)
      await this.orchestrator.sendMessage(p.memberSessions[p.team.leaderMemberId], initialTurn?.prompt || goal, input.attachments, undefined, false, initialTurn ? { source: initialTurn.source } : undefined)
      return this.store.project(p.id)
    } catch (error) {
      this.change(p.id, x => {
        x.status = 'failed'; x.error = String(error)
        if (x.worktree && x.worktree.state !== 'ready') x.worktree = { ...x.worktree, state: 'failed', lastError: String(error) }
      })
      throw error
    }
  }
  prepareWorktreeProject(id: string): Promise<void> {
    const pending = this.worktreeStarts.get(id)
    if (pending) return pending
    const operation = (async () => {
      let p = this.store.project(id)
      const leaderId = p.memberSessions[p.team.leaderMemberId]
      const leader = this.orchestrator.getSessionById(leaderId)
      const task = leader?.worktreeTask
      if (!leader || task?.kind !== 'message' || !p.worktree || p.archivedAt) throw new Error('团队创建任务不可用')
      try {
        this.validateTeam(p.team)
        this.orchestrator.updateWorktreeTask(leaderId, task)
        const alreadyReady = p.worktree.state === 'ready'
        const tree = { ...p.worktree, state: alreadyReady ? 'ready' as const : 'creating' as const }
        delete tree.lastError
        p.status = 'initializing'; p.error = undefined; p.worktree = tree
        p = this.save(p)
        if (!alreadyReady) for (const sid of Object.values(p.memberSessions)) this.orchestrator.updateWorktreeCreation(sid, tree)
        const ready = alreadyReady ? tree : await this.worktrees.create(tree)
        p = this.store.project(id)
        if (p.archivedAt || p.status !== 'initializing' || leader.archived) throw new Error('团队创建已暂停，请恢复后重试')
        if (!alreadyReady) for (const sid of Object.values(p.memberSessions)) this.orchestrator.updateWorktreeCreation(sid, ready)
        p.worktree = ready
        const workspace = this.roleConfig(p.team.members[0].role, p)
        p.spaceRoots = [workspace.workdir, ...(workspace.additionalDirectories || [])]
        p.status = 'ready'; p = this.save(p)
        this.configureRuntime(p)
        await this.orchestrator.sendMessage(leaderId, task.prompt, task.attachments)
        this.orchestrator.updateWorktreeTask(leaderId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.change(id, current => { current.status = 'failed'; current.error = message; if (current.worktree?.state !== 'ready') current.worktree = { ...p.worktree!, state: 'failed', lastError: message } })
        if (leader.config.worktree?.state !== 'ready') for (const sid of Object.values(p.memberSessions)) this.orchestrator.updateWorktreeCreation(sid, { ...p.worktree!, state: 'failed', lastError: message })
        this.orchestrator.updateWorktreeTask(leaderId, leader.submittedUserMessages?.length ? undefined : task, leader.submittedUserMessages?.length ? undefined : message)
      }
    })().catch(error => { this.emit('errorNotice', '工作树创建失败：' + String(error)) }).finally(() => { this.worktreeStarts.delete(id) })
    this.worktreeStarts.set(id, operation)
    return operation
  }

  private roleConfig(role: AgentRole, p: TeamProject): SessionConfig {
    const snapshot = copyAgentRole(role)
    delete snapshot.projectId; delete snapshot.workdir
    const agent = this.agents().find(agent => agent.id === role.agentId)
    return this.resolveConfig({ agentId: role.agentId, model: role.model, effort: role.effort,
      ...(agent?.adapter === 'zcode' ? { zcodeModelSelection: zcodeRoleSelection(role, agent) } : {}),
      permissionMode: role.permissionMode, projectId: p.spaceId, requirementId: p.requirementId, workdir: p.spaceRoots[0], worktree: p.worktree, roleSnapshot: snapshot }, true)
  }
  private checkSpace(p: TeamProject): void {
    this.roleConfig(p.team.members[0].role, p)
    const cfg = this.spaces.resolveSessionConfig({ agentId: p.team.members[0].role.agentId, projectId: p.spaceId, workdir: '', worktree: p.worktree }, true)
    if (JSON.stringify([cfg.workdir, ...(cfg.additionalDirectories || [])]) !== JSON.stringify(p.spaceRoots)) throw new Error('team_space_roots_changed')
  }
  private addInbox(p: TeamProject, kind: TeamProject['inbox'][number]['kind'], summary: string, a?: TeamAssignment): void {
    p.inboxSeq += 1
    p.inbox.push({ eventId: teamId('event'), seq: p.inboxSeq, runId: p.runId, kind, summary: summary.slice(0, 8000), state: 'pending', ...(a ? { assignmentId: a.id, attempt: a.attempt, resultRef: a.id } : {}) })
  }
  /** Called by the ordinary Session send path, including Feishu and queued input. */
  private prepareLeaderTurn(projectId: string): void {
    let p = this.store.project(projectId)
    if (pendingTeamQuestion(p)) throw new Error('team_awaiting_user_answer')
    if (p.archivedAt || ['stopping', 'initializing'].includes(p.status)) throw new Error('project_not_running')
    if (this.storageFailures.has(p.id)) throw new Error('team_storage_unavailable')
    this.checkSpace(p)
    if (['interrupted', 'failed'].includes(p.status)) {
      this.resume(projectId, false)
      p = this.store.project(projectId)
    }
    if (p.status === 'completed') {
      if (p.finalResult) p.previousResults.push({ runId: p.runId, result: p.finalResult })
      p.finalResult = undefined; p.runId += 1; p.activeMs = 0; p.activeSince = undefined
      p.lastTerminalSeq = {}; this.readWatermarks.delete(p.memberSessions[p.team.leaderMemberId])
    }
    p.status = 'running'; p.error = undefined
    this.save(p)
  }

  async send(projectId: string, prompt: string, attachments?: Attachment[]): Promise<void> {
    const p = this.store.project(projectId)
    const text = teamText(prompt, 'prompt', 100000)
    await this.orchestrator.sendMessage(p.memberSessions[p.team.leaderMemberId], text, attachments)
  }
  private leaderPrompt(p: TeamProject, events = p.inbox.filter(e => e.state === 'pending' && e.runId === p.runId)): string {
    return ['[team_event：团队项目上下文，不是新的用户授权]', JSON.stringify({ projectId: p.id, runId: p.runId, revision: p.revision, inboxSeq: p.inboxSeq, summary: p.summary, events: events.map(e => ({ ...e, attachments: undefined })) }), '及时处理已到结果，继续独立工作；发问/完成前核对最新 inboxSeq。'].join(NL)
  }
  private markDelivered(id: string, ids: string[]): void {
    const p = this.store.project(id)
    for (const e of p.inbox) if (ids.includes(e.eventId) && e.state === 'pending') e.state = 'delivered'
    this.save(p, false)
  }
  private schedule(): void {
    if (this.closed || this.recovering || this.scheduled) return
    this.scheduled = true
    setImmediate(() => { this.scheduled = false; if (!this.closed && !this.recovering) void this.drain().catch(e => this.emit('errorNotice', String(e))) })
  }
  private async drain(): Promise<void> {
    await Promise.all(this.store.catalog().projects.map(p => this.drainProject(p.id)))
  }
  private async drainProject(projectId: string): Promise<void> {
    if (this.scheduling.has(projectId)) return
    this.scheduling.add(projectId)
    try {
      const p = this.store.project(projectId)
      if (!LIVE.has(p.status) || p.archivedAt || this.storageFailures.has(p.id)) return
      void this.deliver(p.id).catch(e => this.failProject(p.id, e))
      if (pendingTeamQuestion(p)) return
      for (const a of p.assignments.filter(a => a.status === 'queued' && a.runId === p.runId)) {
        const current = this.store.project(projectId)
        if (!LIVE.has(current.status)) break
        const active = current.assignments.filter(x => x.runId === current.runId && !x.endedAt && (x.status === 'running' || (x.status === 'blocked' || x.status === 'cancelling') && isSessionBusy(this.session(current.memberSessions[x.memberId]).status)))
        if (current.team.limits.concurrency > 0 && active.length >= current.team.limits.concurrency) { this.wait(current, a.id, `当前项目并发已满（${active.length}/${current.team.limits.concurrency}）`); continue }
        const s = this.session(current.memberSessions[a.memberId])
        if (isSessionBusy(s.status)) { this.wait(current, a.id, `${current.team.members.find(m => m.id === a.memberId)?.role.name || '成员'}正在执行当前项目内的上一项任务`); continue }
        this.checkSpace(current)
        this.reservations.add(s.id)
        try { await this.startAssignment(current.id, a.id) } finally { this.reservations.delete(s.id) }
      }
    } finally { this.scheduling.delete(projectId); this.syncRuntime(projectId) }
  }
  private wait(p: TeamProject, assignmentId: string, reason: string): void {
    const assignment = p.assignments.find(a => a.id === assignmentId)
    const summary = '等待原因：' + reason
    if (assignment && assignment.summary !== summary) { assignment.summary = summary; this.save(p) }
  }
  private async deliver(id: string): Promise<void> {
    if (this.delivering.has(id)) return
    const p = this.store.project(id)
    if (!LIVE.has(p.status) || p.archivedAt || this.storageFailures.has(p.id)) return
    const leader = this.session(p.memberSessions[p.team.leaderMemberId])
    if (pendingTeamQuestion(p)) return
    const pending = p.inbox.filter(e => e.state === 'pending' && e.runId === p.runId)
    if (!pending.length || this.orchestrator.teamDeliveryBlocked(leader.id)) return
    if (leader.status === 'awaiting-approval' || leader.status === 'cancelling' || leader.status === 'queued') return
    this.delivering.add(id)
    this.reservations.add(leader.id)
    try {
      this.checkSpace(p)
      const baseAgent = this.agents().find(a => a.id === leader.config.agentId)
      if (leader.status === 'running' && (!baseAgent || !agentForSession(baseAgent, leader).capabilities.steer)) return
      if (leader.status === 'running') await this.orchestrator.steerTeamMessage(leader.id, this.leaderPrompt(p, pending), pending.flatMap(e => e.attachments || []))
      else {
        const events = await this.orchestrator.getEvents(leader.id)
        const fresh = this.store.project(id)
        if (!LIVE.has(fresh.status) || fresh.runId !== p.runId || fresh.archivedAt || pendingTeamQuestion(fresh) || this.orchestrator.teamDeliveryBlocked(leader.id)) return
        fresh.leaderStartSeq = events.at(-1)?.seq ?? -1; fresh.error = undefined
        this.save(fresh, false)
        await this.orchestrator.sendTeamMessage(leader.id, this.leaderPrompt(fresh, pending), pending.flatMap(e => e.attachments || []), '处理团队消息')
      }
      this.markDelivered(id, pending.map(e => e.eventId))
    } catch (error) {
      if (!/requires_active_turn|team_turn_not_running|session_not_idle|team_start_cancelled/.test(String(error))) throw error
    } finally {
      this.delivering.delete(id)
      this.reservations.delete(leader.id)
      this.syncRuntime(id)
      const fresh = this.store.project(id)
      if (LIVE.has(fresh.status) && fresh.inbox.some(e => e.state === 'pending' && !e.attachments?.length && !pending.some(old => old.eventId === e.eventId))) this.schedule()
    }
  }
  private async startAssignment(projectId: string, assignmentId: string): Promise<void> {
    let p = this.store.project(projectId)
    const a = p.assignments.find(a => a.id === assignmentId)!
    const sessionId = p.memberSessions[a.memberId]
    const events = await this.orchestrator.getEvents(sessionId)
    p = this.store.project(projectId)
    const next = p.assignments.find(a => a.id === assignmentId)!
    if (next.status !== 'queued' || !LIVE.has(p.status) || pendingTeamQuestion(p)) return
    next.status = 'running'; next.summary = '执行中'; next.startedAt = Date.now(); next.lastTick = Date.now(); next.startSeq = events.at(-1)?.seq ?? -1
    this.save(p)
    try { await this.orchestrator.sendTeamMessage(sessionId, assignmentPrompt(p, next), undefined, next.title) }
    catch (error) { this.change(projectId, x => { const item = x.assignments.find(a => a.id === assignmentId)!; if (['stopping', 'interrupted'].includes(x.status)) { item.status = 'cancelled'; return } item.status = 'failed'; item.error = String(error); item.endedAt = Date.now(); this.addInbox(x, 'result', item.title + ' 启动失败：' + String(error), item) }); this.schedule() }
  }

  async handleTool(token: unknown, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error('team_request_cancelled')
    const caller = authenticateTeamRuntime(token)
    const { p, memberId, leader } = this.binding(caller)
    const v = teamRecord(args || {})
    if (leader && pendingTeamQuestion(p) && !['get_team_context', 'ask_team_user'].includes(tool)) throw new Error('team_awaiting_user_answer')
    if (tool === 'get_team_context') {
      teamKeys(v, ['sinceRevision', 'sections', 'cursor', 'limit', 'artifactId', 'offset'])
      if (v.artifactId) { const artifact = p.artifacts.find(a => a.id === v.artifactId); if (artifact?.snapshot) this.store.verifySnapshot(p.id, artifact) }
      const context = memberContext(p, memberId, v)
      context.members = p.team.members.map(m => {
        const session = this.orchestrator.getSessionById(p.memberSessions[m.id])
        const base = this.agents().find(a => a.id === m.role.agentId)
        const effective = base && session ? agentForSession(base, session) : base
        return {
          memberId: m.id,
          name: m.role.name,
          description: m.role.instructions || '',
          directMessageSupported: m.id !== p.team.leaderMemberId && effective?.capabilities.steer === true
        }
      })
      if (leader && Array.isArray(context.inbox)) {
        const read = this.readWatermarks.get(caller) || new Set<number>()
        for (const event of context.inbox) read.add(event.seq)
        this.readWatermarks.set(caller, read)
        context.readInboxSeq = this.readableInboxSeq(p, caller)
      }
      return { ...context, ...(this.storageFailures.has(p.id) ? { error: 'team_storage_unavailable' } : {}) }
    }
    if (tool === 'send_team_message') {
      if (!leader) throw new Error('leader_required')
      return this.sendDirect(p, caller, v)
    }
    if (!LIVE.has(p.status) && !(tool === 'report_team_task' && !leader && p.status === 'failed')) throw new Error('project_not_running')
    if (this.storageFailures.has(p.id)) throw new Error('team_storage_unavailable')
    if (!isSessionBusy(this.session(caller).status)) throw new Error('team_turn_not_running')
    if (tool !== 'report_team_task' && !leader) throw new Error('leader_required')
    if (tool === 'ask_team_user') {
      teamKeys(v, ['requestId', 'title', 'purpose', 'questions', 'materials', 'supersedes', 'basedOnInboxSeq'])
      const requestId = teamText(v.requestId, 'request_id', 128)
      const fingerprint = createHash('sha256').update(JSON.stringify(v)).digest('hex')
      const previous = p.interactions.find(i => i.runId === p.runId && i.decision && i.requestId === requestId)
      if (previous) { if (previous.requestFingerprint !== fingerprint) throw new Error('request_id_conflict'); return this.waitForAnswer(p.id, previous.id, signal) }
      if (pendingTeamQuestion(p) && v.supersedes === undefined) throw new Error('team_awaiting_user_answer')
      if (v.basedOnInboxSeq !== p.inboxSeq) throw new Error('inbox_changed')
      const replaced = v.supersedes === undefined ? undefined : p.interactions.find(i => i.id === v.supersedes && i.runId === p.runId && i.kind === 'leader_question' && i.state === 'pending')
      if (v.supersedes !== undefined && !replaced) throw new Error('question_not_replaceable')
      const question = createTeamDecision(p, v, this.store, path => this.checkedPath(p, path))
      question.requestFingerprint = fingerprint
      if (replaced) { replaced.state = 'expired'; replaced.revision += 1 }
      p.interactions.push(question); p.status = 'waiting_user'; this.save(p)
      return this.waitForAnswer(p.id, question.id, signal)
    }
    if (tool === 'answer_member_question') {
      teamKeys(v, ['interactionId', 'revision', 'answer'])
      const i = p.interactions.find(i => i.id === v.interactionId && i.memberId !== p.team.leaderMemberId && i.kind === 'native_question')
      if (!i) throw new Error('member_business_question_required')
      await this.respond(p.id, i.id, v.revision, v.answer, true)
      return { answered: true }
    }
    if (tool === 'review_team_task') {
      teamKeys(v, ['assignmentId', 'attempt', 'decision', 'reason'])
      const a = p.assignments.find(a => a.id === v.assignmentId && a.runId === p.runId)
      if (!a || a.attempt !== v.attempt || !a.endedAt) throw new Error('delivery_not_ready')
      if (!['accept', 'rework'].includes(v.decision) || v.decision === 'accept' && a.status !== 'succeeded') throw new Error('invalid_review_decision')
      const reason = teamText(v.reason, 'review_reason', 8000)
      if (a.review && (a.review.decision !== v.decision || a.review.reason !== reason)) throw new Error('review_already_recorded')
      a.review ||= { decision: v.decision, reason, reviewedAt: Date.now() }
      this.save(p)
      return { assignmentId: a.id, attempt: a.attempt, review: a.review }
    }
    if (tool === 'dispatch_team_task') return this.dispatch(p, v)
    if (tool === 'report_team_task') {
      if (leader) throw new Error('member_required')
      teamKeys(v, ['assignmentId', 'attempt', 'state', 'summary', 'resultText', 'artifactRefs', 'question'])
      const a = p.assignments.find(a => a.id === v.assignmentId && a.memberId === memberId && a.runId === p.runId)
      if (!a || !['running', 'blocked'].includes(a.status)) throw new Error('assignment_not_owned')
      if (a.attempt !== v.attempt) throw new Error('stale_attempt')
      if (!['progress', 'blocked', 'result'].includes(v.state)) throw new Error('invalid_report_state')
      a.summary = teamText(v.summary, 'summary', 2000)
      if (v.resultText !== undefined) a.candidateResult = teamText(v.resultText, 'result', 200000, false)
      if (v.question !== undefined) a.question = teamText(v.question, 'question', 8000)
      if (v.state === 'blocked') { if (!a.question) throw new Error('blocked_requires_question'); a.status = 'blocked' }
      if (v.state === 'result') { a.question = undefined; a.status = 'running' }
      for (const path of strings(v.artifactRefs, 'artifact_refs', 30)) {
        this.checkedPath(p, path)
        const artifact = { ...this.store.snapshotArtifact(p.id, { title: path.split('/').at(-1) || path, path: this.checkedPath(p, path) }), assignmentId: a.id }
        p.artifacts.push(artifact); a.artifactRefs.push(artifact.id)
      }
      this.save(p)
      return { accepted: true, state: v.state }
    }
    if (tool === 'cancel_team_task') {
      teamKeys(v, ['assignmentId', 'reason'])
      const a = p.assignments.find(a => a.id === v.assignmentId && a.runId === p.runId)
      if (!a) throw new Error('assignment_not_found')
      a.error = teamText(v.reason, 'reason', 2000)
      if (!ACTIVE.has(a.status)) return { status: a.status }
      const sid = p.memberSessions[a.memberId]
      a.status = a.status !== 'queued' && !a.endedAt && isSessionBusy(this.session(sid).status) ? 'cancelling' : 'cancelled'
      if (a.status === 'cancelled') { a.endedAt = Date.now(); this.addInbox(p, 'result', a.title + ' 已取消', a) }
      this.save(p)
      if (a.status === 'cancelling') this.orchestrator.interrupt(sid)
      return { status: a.status }
    }
    if (tool === 'update_team_project') return this.updateProject(p, caller, v)
    throw new Error('unknown_team_tool')
  }
  private async sendDirect(p: TeamProject, caller: string, v: Record<string, any>): Promise<TeamCommunication> {
    teamKeys(v, ['requestId', 'memberId', 'assignmentId', 'attempt', 'message'])
    const requestId = teamText(v.requestId, 'request_id', 128)
    const message = teamText(v.message, 'message', 16000)
    const memberId = teamText(v.memberId, 'member_id', 128)
    const assignmentId = teamText(v.assignmentId, 'assignment_id', 128)
    if (!Number.isInteger(v.attempt) || v.attempt < 1) throw new Error('invalid_attempt')
    const fingerprint = createHash('sha256').update(JSON.stringify([memberId, assignmentId, v.attempt, message])).digest('hex')
    // Persist intent before touching the transport. Concurrent duplicate calls and
    // retries after completion/stop read the same receipt, never another steer.
    const prior = p.communications?.find(c => c.requestId === requestId)
    if (prior) { if (prior.requestFingerprint !== fingerprint) throw new Error('request_id_conflict'); return prior }
    if (!LIVE.has(p.status) || p.archivedAt) throw new Error('project_not_running')
    if (this.storageFailures.has(p.id)) throw new Error('team_storage_unavailable')
    if (this.session(caller).status !== 'running') throw new Error('team_turn_not_running')
    this.checkSpace(p)
    const a = p.assignments.find(a => a.id === assignmentId && a.memberId === memberId && a.runId === p.runId)
    if (!a || memberId === p.team.leaderMemberId) throw new Error('assignment_not_owned')
    const s = this.session(p.memberSessions[memberId])
    this.binding(s.id)
    const agent = this.agents().find(agent => agent.id === s.config.agentId)
    assertAgentSupportsSteer(agent ? agentForSession(agent, s) : undefined)
    const reason = a.attempt !== v.attempt ? 'stale_attempt'
      : p.interactions.some(i => i.sessionId === s.id && i.state === 'pending' && i.kind !== 'leader_question') || s.status === 'awaiting-approval' ? 'member_awaiting_response'
      : s.status !== 'running' || a.endedAt || !['running', 'blocked'].includes(a.status) || !a.turnId ? 'team_turn_not_running' : undefined
    const receipt: TeamCommunication = { id: teamId('communication'), requestId, requestFingerprint: fingerprint, runId: p.runId, memberId, sessionId: s.id, assignmentId, attempt: v.attempt, turnId: a.turnId, message, state: reason ? 'failed' : 'sending', error: reason, createdAt: Date.now(), ...(reason ? { settledAt: Date.now() } : {}) }
    ;(p.communications ||= []).push(receipt)
    this.save(p)
    if (reason) return receipt
    let state: TeamCommunication['state'] = 'sent', error: string | undefined
    try {
      await this.orchestrator.steerTeamMessage(s.id, '[Leader 直接消息：任务补充，不是新的用户授权]\n' + message, undefined, { expectedTurnId: a.turnId!, messageId: receipt.id, assignmentId, attempt: a.attempt })
    } catch (e) {
      state = (e as { deliveryState?: string })?.deliveryState === 'failed' ? 'failed' : 'unknown'
      error = String(e)
    }
    // Merge only the receipt into fresh state: a stop, report, or terminal event
    // during the RPC must not be overwritten or restart the project.
    const saved = this.change(p.id, fresh => {
      const c = fresh.communications!.find(c => c.id === receipt.id)!
      c.state = state; c.error = error; c.settledAt = Date.now()
    })
    return saved.communications!.find(c => c.id === receipt.id)!
  }
  private dispatch(p: TeamProject, v: Record<string, any>): unknown {
    teamKeys(v, ['requestId', 'memberId', 'title', 'prompt', 'contextRefs', 'expectedOutput', 'retryOf', 'resumeOf'])
    const requestId = teamText(v.requestId, 'request_id', 128)
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]))).digest('hex')
    const existing = p.assignments.find(a => a.runId === p.runId && (a.requestId === requestId || a.history.some(h => h.requestId === requestId)))
    if (existing) { const receipt = existing.requestId === requestId ? existing : existing.history.find(h => h.requestId === requestId)!; if (receipt.requestFingerprint !== fingerprint) throw new Error('request_id_conflict'); return { assignmentId: existing.id, status: existing.status, sessionId: p.memberSessions[existing.memberId], permissionMode: receipt.permissionMode || existing.permissionMode, attempt: receipt.attempt } }
    const member = p.team.members.find(m => m.id === v.memberId && m.id !== p.team.leaderMemberId)
    if (!member) throw new Error('member_unavailable')
    const agent = this.agents().find(a => a.id === member.role.agentId)
    if (!agent) throw new Error('member_unavailable')
    const requestedPermission = member.role.permissionMode
    if (p.team.limits.maxAssignments > 0 && p.assignments.filter(a => a.runId === p.runId).reduce((n, a) => n + a.attempt, 0) >= p.team.limits.maxAssignments) throw new Error('limit_reached')
    if (v.retryOf && v.resumeOf) throw new Error('invalid_resume_retry')
    const priorId = v.retryOf || v.resumeOf
    const prior = priorId ? p.assignments.find(a => a.id === priorId && a.memberId === member.id && a.runId === p.runId) : undefined
    if (priorId && (!prior || isSessionBusy(this.session(p.memberSessions[member.id]).status) || !(prior.review?.decision === 'rework' || ['blocked', 'failed', 'interrupted', 'cancelled'].includes(prior.status)))) throw new Error('assignment_not_resumable')
    const refs = strings(v.contextRefs, 'context_refs')
    if (refs.some(ref => !p.artifacts.some(a => a.id === ref && p.assignments.some(t => t.id === a.assignmentId && !!t.endedAt)) && !p.assignments.some(a => a.id === ref && !!a.endedAt))) throw new Error('invalid_context_ref')
    const next: TeamAssignment = { id: prior?.id || teamId('assignment'), runId: p.runId, memberId: member.id, requestId, requestFingerprint: fingerprint, title: teamText(v.title, 'title', 200), prompt: teamText(v.prompt, 'prompt', 100000), permissionMode: requestedPermission, expectedOutput: teamText(v.expectedOutput || '', 'expected_output', 8000, false), contextRefs: refs, status: 'queued', attempt: (prior?.attempt || 0) + 1, history: prior ? [...prior.history, { attempt: prior.attempt, status: prior.status, title: prior.title, dispatchedAt: prior.dispatchedAt ?? prior.createdAt, permissionMode: prior.permissionMode, result: prior.result, error: prior.error, turnId: prior.turnId, requestId: prior.requestId, requestFingerprint: prior.requestFingerprint, artifactRefs: [...prior.artifactRefs], review: prior.review, endedAt: prior.endedAt }] : [], summary: '等待原因：等待当前项目调度', artifactRefs: [], createdAt: prior?.createdAt || Date.now(), dispatchedAt: Date.now(), activeMs: 0 }
    if (prior) p.assignments[p.assignments.indexOf(prior)] = next
    else p.assignments.push(next)
    this.save(p); this.schedule()
    return { assignmentId: next.id, status: 'queued', sessionId: p.memberSessions[member.id], permissionMode: next.permissionMode, attempt: next.attempt, inboxSeq: p.inboxSeq }
  }
  private updateProject(p: TeamProject, caller: string, v: Record<string, any>): unknown {
    teamKeys(v, ['expectedRevision', 'handledInboxSeq', 'basedOnInboxSeq', 'phase', 'summary', 'sharedContextPatch', 'action', 'finalResult'])
    if (v.expectedRevision !== p.revision) throw new TeamRuntimeError('revision_conflict', { revision: p.revision, inboxSeq: p.inboxSeq })
    if (v.handledInboxSeq !== undefined) {
      const max = this.readableInboxSeq(p, caller)
      if (!Number.isInteger(v.handledInboxSeq) || v.handledInboxSeq < p.handledInboxSeq || v.handledInboxSeq > max) throw new Error('invalid_handled_inbox_seq')
      p.handledInboxSeq = v.handledInboxSeq
      for (const e of p.inbox) if (e.seq <= p.handledInboxSeq) e.state = 'consumed'
    }
    if (v.action === 'complete' && (v.basedOnInboxSeq !== p.inboxSeq || p.handledInboxSeq !== p.inboxSeq)) throw new TeamRuntimeError('inbox_changed', { inboxSeq: p.inboxSeq, inbox: p.inbox.filter(e => e.seq > p.handledInboxSeq) })
    if (v.phase !== undefined) p.phase = teamText(v.phase, 'phase', 200)
    if (v.summary !== undefined) p.summary = teamText(v.summary, 'summary', 8000, false)
    if (v.sharedContextPatch) {
      const patch = teamRecord(v.sharedContextPatch); teamKeys(patch, ['brief', 'decisions', 'openQuestions'])
      if (patch.brief !== undefined) p.sharedContext.brief = teamText(patch.brief, 'brief', 16000, false)
      if (patch.decisions !== undefined) p.sharedContext.decisions = strings(patch.decisions, 'decisions')
      if (patch.openQuestions !== undefined) p.sharedContext.openQuestions = strings(patch.openQuestions, 'questions')
    }
    if (v.action === 'complete') {
      if (p.assignments.some(a => a.runId === p.runId && ACTIVE.has(a.status))) throw new Error('active_assignments')
      if (this.orchestrator.teamDeliveryBlocked(caller)) throw new Error('leader_input_pending')
      if (p.assignments.some(a => a.runId === p.runId && a.status === 'succeeded' && a.review?.decision !== 'accept')) throw new Error('unreviewed_deliveries')
      if (p.interactions.some(i => i.runId === p.runId && i.state === 'pending')) throw new Error('pending_interactions')
      const result = teamRecord(v.finalResult); teamKeys(result, ['summary', 'artifactRefs', 'acceptedFindings', 'unresolvedDisagreements', 'validationGaps'])
      p.finalResult = { deliveredAt: Date.now(), summary: teamText(result.summary, 'final_summary', 100000), artifactRefs: strings(result.artifactRefs, 'artifact_refs'), acceptedFindings: strings(result.acceptedFindings, 'findings'), unresolvedDisagreements: strings(result.unresolvedDisagreements, 'disagreements'), validationGaps: strings(result.validationGaps, 'validation_gaps') }
      p.finalResult.artifactRefs = p.finalResult.artifactRefs.map(ref => {
        if (p.artifacts.some(a => a.id === ref)) return ref
        if (!isAbsolute(ref)) throw new Error('invalid_artifact_ref')
        const path = this.checkedPath(p, ref)
        const artifact = { id: teamId('artifact'), title: path.split('/').at(-1)!, path, createdAt: Date.now() }
        p.artifacts.push(artifact); return artifact.id
      })
      if (p.activeSince !== undefined) p.activeMs += Math.max(0, Date.now() - p.activeSince)
      p.activeSince = undefined
      p.status = 'completed'; p.summary = p.finalResult.summary.slice(0, 8000)
    } else if (v.action === 'wait_members') p.phase = v.phase || '等待成员交付'
    else if (v.action !== undefined) throw new Error('invalid_team_action')
    const saved = this.save(p)
    return { revision: saved.revision, inboxSeq: saved.inboxSeq, status: saved.status }
  }

  private readableInboxSeq(p: TeamProject, caller: string): number {
    const unread = p.inbox.find(e => e.runId === p.runId && e.seq > p.handledInboxSeq && e.state === 'pending' && !this.readWatermarks.get(caller)?.has(e.seq))
    return unread ? unread.seq - 1 : p.inboxSeq
  }

  private onEvent(ev: UAEvent): void {
    ev = asInteractionRequest(ev)
    const s = this.orchestrator.getSessionById(ev.sessionId)
    if (!s?.teamBinding) return
    try {
      const { p, memberId, leader } = this.binding(s.id)
      const current = p.assignments.findLast(a => a.memberId === memberId && a.runId === p.runId && ['running', 'blocked', 'cancelling'].includes(a.status) && !a.endedAt)
      if (ev.type === 'approval_request') {
        if (ev.payload.teamQuestion || ev.payload.method === 'local/plan') return
        const existing = p.interactions.findLast(i => i.runId === p.runId && i.sessionId === s.id && i.requestId === ev.payload.requestId && (ev.payload.delivery === 'async' || i.assignmentId === current?.id && i.attempt === current?.attempt))
        if (ev.state === 'pending' && (p.archivedAt || ['stopping', 'interrupted', 'completed'].includes(p.status))) return
        if (ev.state === 'pending' && !existing) {
          p.interactions.push({ id: teamId('interaction'), revision: 1, kind: ['question', 'elicitation'].includes(ev.payload.kind) && !isMcpToolApproval(ev.payload.params) ? 'native_question' : 'native_approval', memberId, sessionId: s.id, runId: p.runId, requestId: ev.payload.requestId, event: ev, assignmentId: current?.id, attempt: current?.attempt, state: 'pending', createdAt: ev.ts })
          const interaction = p.interactions.at(-1)!
          if (!leader && interaction.kind === 'native_question') this.addInbox(p, 'interaction', JSON.stringify({ interactionId: interaction.id, revision: interaction.revision, memberId, requestId: interaction.requestId, event: ev, instruction: '成员业务问题，请 Leader 读取上下文后回答；需要用户决策时先提供材料并 ask_team_user。' }), current)
        } else if (existing && ev.state === 'pending') {
          if (existing.state !== 'pending') return
          existing.event = { ...ev, payload: { ...existing.event?.payload, ...ev.payload } }
          this.save(p, false); return
        } else if (existing && (ev.state === 'cancelled' || ev.state === 'failed' || ev.payload.submittedAnswer !== undefined)) {
          if (existing.state !== 'pending') return
          existing.state = ev.state === 'cancelled' ? 'cancelled' : ev.state === 'failed' ? 'expired' : 'answered'
          existing.event = { ...ev, payload: { ...existing.event?.payload, ...ev.payload } }
          existing.answer = ev.payload.submittedAnswer
          existing.revision += 1
        } else return
        this.save(p); this.schedule(); return
      }
      if (ev.type === 'error') {
        if (current) current.error = String(ev.payload.message || 'Agent 执行失败')
        else if (leader) p.error = String(ev.payload.message || 'Leader 执行失败')
        this.save(p); return
      }
      if (ev.type === 'turn_started') {
        if (leader) p.leaderStartSeq = ev.seq
        if (!leader && current) current.turnId = ev.payload.turnId || current.turnId
        this.save(p, false); return
      }
      if (ev.type !== 'turn_completed') return
      if ((p.lastTerminalSeq?.[s.id] ?? -1) >= ev.seq) return
      p.lastTerminalSeq = { ...p.lastTerminalSeq, [s.id]: ev.seq }
      const text = this.orchestrator.latestAgentMessageText(s.id, leader ? p.leaderStartSeq ?? -1 : current?.startSeq ?? ev.seq)
      if (leader) {
        if ((ev.state === 'failed' || p.error) && LIVE.has(p.status) && !p.archivedAt) { p.status = pendingTeamQuestion(p) ? 'waiting_user' : 'failed'; p.error ||= 'Leader 本轮执行失败，可恢复后继续' }
      } else if (current && (!current.turnId || !ev.payload.turnId || current.turnId === ev.payload.turnId) && (current.startSeq === undefined || ev.seq > current.startSeq)) {
        current.turnId = ev.payload.turnId
        current.endedAt = Date.now(); current.lastTick = undefined
        current.result = current.candidateResult || text
        const cancelling = current.status === 'cancelling' || p.status === 'stopping'
        current.status = cancelling || ev.state === 'cancelled' ? 'cancelled' : ev.state === 'failed' || current.error ? 'failed' : current.question ? 'blocked' : current.result ? 'succeeded' : 'failed'
        if (current.status === 'failed' && !current.error) current.error = current.result ? '本轮执行失败' : '本轮没有最终输出'
        if (current.result) {
          const artifact = { id: teamId('artifact'), title: current.title, text: current.result, assignmentId: current.id, createdAt: Date.now() }
          p.artifacts.push(artifact); current.artifactRefs.push(artifact.id)
        }
        this.addInbox(p, current.status === 'blocked' ? 'blocked' : 'result', JSON.stringify({ member: p.team.members.find(m => m.id === memberId)?.role.name, title: current.title, status: current.status, summary: current.summary, question: current.question, result: current.result?.slice(0, 6000), error: current.error, artifactRefs: current.artifactRefs }), current)
      }
      for (const i of p.interactions) if (i.sessionId === s.id && i.kind !== 'leader_question' && i.event?.payload.delivery !== 'async' && i.event?.payload.method !== 'local/plan' && i.state === 'pending') { i.state = 'expired'; i.revision += 1 }
      this.save(p); this.schedule()
    } catch (e) { this.emit('errorNotice', String(e)) }
  }
  async respond(projectId: string, interactionId: string, revision: number, answer: unknown, byLeader = false, source?: 'feishu' | 'mcp'): Promise<void> {
    const p = this.store.project(projectId)
    const i = p.interactions.find(i => i.id === interactionId)
    if (!i || i.runId !== p.runId || i.state !== 'pending') throw new Error('interaction_expired')
    if (i.revision !== revision) throw new Error('revision_conflict')
    if (byLeader ? i.kind !== 'native_question' || i.memberId === p.team.leaderMemberId : !teamInteractionForUser(i, p.team.leaderMemberId)) throw new Error('interaction_wrong_recipient')
    if (p.archivedAt || !LIVE.has(p.status)) throw new Error('interaction_expired')
    const encoded = JSON.stringify(answer)
    if (!encoded || encoded.length > 100000) throw new Error('invalid_answer')
    if (i.decision) {
      validateTeamAnswer(i, answer)
      for (const ref of i.decision.materials) {
        const artifact = p.artifacts.find(a => a.id === ref.artifactId)
        if (!artifact) throw new Error('material_missing')
        this.store.verifySnapshot(p.id, artifact)
      }
      i.answer = structuredClone(answer); i.state = 'answered'; i.revision += 1
      if (!this.questionWaiters.has(i.id)) this.addInbox(p, 'interaction', JSON.stringify({ questionId: i.id, revision, title: i.decision.title, answer, materials: i.decision.materials }))
      this.save(p); this.schedule(); return
    }
    if (i.kind === 'leader_question') {
      const raw = teamRecord(answer)
      const values = raw.answers && typeof raw.answers === 'object' ? Object.fromEntries(Object.entries(raw.answers).map(([key, item]) => [key, Array.isArray((item as any)?.answers) ? (item as any).answers.join('、') : ''])) : raw
      teamKeys(values, (i.questions || []).filter(q => !q.resolved && !q.answer).map(q => q.id))
      if (!Object.keys(values).some(key => i.questions?.some(q => q.id === key && !q.resolved && !q.answer) && typeof values[key] === 'string' && values[key].trim())) throw new Error('empty_answer')
      for (const q of i.questions || []) if (!q.resolved && values[q.id] !== undefined) q.answer = teamText(values[q.id], 'answer', 16000)
      i.state = i.questions?.every(q => q.resolved || q.answer) ? 'answered' : 'pending'; i.revision += 1
      p.messages.push({ id: teamId('msg'), runId: p.runId, interactionId: i.id, kind: 'user', text: Object.entries(values).map(([key, value]) => (i.questions?.find(q => q.id === key)?.prompt || key) + '\n' + value).join('\n\n'), createdAt: Date.now() })
      this.addInbox(p, 'interaction', '用户回答问题：' + JSON.stringify(i.questions))
      this.save(p); this.schedule(); return
    }
    const result = await this.orchestrator.respondToRequest(i.sessionId, i.requestId!, answer, source ? { source } : undefined)
    if (!result?.handled) throw new Error('interaction_expired')
    this.change(projectId, next => { const request = next.interactions.find(r => r.id === i.id); if (!request || next.runId !== i.runId || request.sessionId !== i.sessionId || request.requestId !== i.requestId || request.state === 'expired' || request.state === 'cancelled') return; if (request.state === 'pending') { request.state = 'answered'; request.revision += 1 }; request.answer = answer; this.addInbox(next, 'interaction', '角色 ' + i.memberId + (byLeader ? ' 的业务问题已由 Leader 回答。' : ' 的原生提问/授权已由用户处理，原操作按实际结果继续。')) })
    this.schedule()
  }
  stop(id: string): void {
    const p = this.store.project(id)
    if (p.archivedAt) return
    if (p.activeSince !== undefined) p.activeMs += Math.max(0, Date.now() - p.activeSince)
    p.activeSince = undefined; p.status = 'stopping'
    for (const a of p.assignments) if (a.runId === p.runId && ACTIVE.has(a.status)) {
      if (a.lastTick !== undefined) a.activeMs += Math.max(0, Date.now() - a.lastTick)
      a.lastTick = undefined
      a.status = a.status !== 'queued' && !a.endedAt && isSessionBusy(this.session(p.memberSessions[a.memberId]).status) ? 'cancelling' : 'cancelled'
      if (a.status === 'cancelled') a.endedAt ||= Date.now()
    }
    for (const i of p.interactions) if (i.state === 'pending') { i.state = 'cancelled'; i.revision += 1 }
    this.save(p)
    const failures: string[] = []
    for (const sid of Object.values(p.memberSessions)) {
      try { this.orchestrator.interrupt(sid) } catch (e) { failures.push(String(e)) }
    }
    if (failures.length) this.emit('errorNotice', '部分角色停止失败：' + failures.join('；'))
    this.schedule()
  }
  resume(id: string, schedule = true): void {
    const p = this.store.project(id)
    if (!['failed', 'interrupted'].includes(p.status) || p.archivedAt) throw new Error('project_not_resumable')
    this.validateTeam(p.team); this.checkSpace(p)
    const missing = p.team.members.filter(m => !p.memberSessions[m.id] || !this.orchestrator.getSessionById(p.memberSessions[m.id]))
    if (missing.some(m => p.assignments.some(a => a.memberId === m.id && a.startedAt) || m.id === p.team.leaderMemberId && (p.messages.length || p.leaderStartSeq !== undefined))) throw new Error('team_session_history_missing')
    if (missing.length) {
      const sessions = this.orchestrator.createTeamSessions(missing.map(m => ({ id: p.memberSessions[m.id], title: m.id === p.team.leaderMemberId ? p.name : p.name + ' · ' + m.role.name, binding: { teamProjectId: p.id, memberId: m.id }, config: this.roleConfig(m.role, p) })))
      for (const s of sessions) p.memberSessions[s.teamBinding!.memberId] = s.id
      this.save(p, false)
    }
    for (const sid of Object.values(p.memberSessions)) { this.binding(sid); if (isSessionBusy(this.session(sid).status) || this.reservations.has(sid) || this.delivering.has(id) || this.scheduling.has(id)) throw new Error('team_still_running') }
    p.status = 'running'; p.error = undefined; p.activeSince = undefined
    for (const a of p.assignments) if (a.status === 'cancelling') a.status = 'interrupted'
    p.lastTerminalSeq = {}; this.readWatermarks.delete(p.memberSessions[p.team.leaderMemberId])
    for (const e of p.inbox) if (e.state !== 'consumed') e.state = 'pending'
    this.addInbox(p, 'recovery', '用户要求恢复项目。先核对已完成结果与中断任务，不自动重跑；通过 retryOf/resumeOf 决定续做。')
    this.save(p); this.configureRuntime(p); if (schedule) this.schedule()
  }
  archive(id: string, archived = true): void {
    const p = this.store.project(id)
    if (archived && (p.interactions.some(i => i.runId === p.runId && i.state === 'pending') || this.delivering.has(id) || Object.values(p.memberSessions).some(sid => this.reservations.has(sid) || isSessionBusy(this.orchestrator.getSessionById(sid)?.status) || this.orchestrator.teamDeliveryBlocked(sid)) || p.status !== 'interrupted' && p.assignments.some(a => ACTIVE.has(a.status)))) throw new Error('team_still_running')
    p.archivedAt = archived ? Date.now() : undefined
    this.save(p)
    for (const sid of Object.values(p.memberSessions)) this.orchestrator.setArchived(sid, archived, TEAM_EXECUTION)
  }
  deleteProject(id: string): void {
    const p = this.store.project(id)
    if (this.delivering.has(id) || Object.values(p.memberSessions).some(s => this.reservations.has(s) || isSessionBusy(this.orchestrator.getSessionById(s)?.status)) || !p.archivedAt && (!['completed', 'failed', 'interrupted'].includes(p.status) || p.status !== 'interrupted' && p.assignments.some(a => ACTIVE.has(a.status)))) throw new Error('team_still_running')
    this.store.deleteProject(id)
    this.orchestrator.deleteTeamSessions(id)
    this.emit('changed')
  }
  rename(id: string, name: string): void { const p = this.change(id, p => { p.name = teamText(name, 'project_name', 100) }); this.orchestrator.renameSession(p.memberSessions[p.team.leaderMemberId], p.name) }
  memberSession(id: string, memberId: string): string { const p = this.store.project(id); const sid = p.memberSessions[memberId]; if (!sid) throw new Error('member_unavailable'); this.binding(sid); return sid }
  checkedPath(p: TeamProject, path: string): string {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) throw new Error('invalid_artifact_path')
    const real = realpathSync(path)
    const config = this.resolveConfig(this.session(p.memberSessions[p.team.leaderMemberId]).config, true)
    const roots = [...p.spaceRoots, ...(config.requirementDir ? [config.requirementDir] : [])]
    if (!roots.some(root => { const rel = relative(realpathSync(root), real); return !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel) })) throw new Error('invalid_artifact_path')
    return real
  }
  artifact(id: string, artifactId: string) { const p = this.store.project(id); const a = p.artifacts.find(a => a.id === artifactId); if (!a) throw new Error('artifact_not_found'); if (a.snapshot) this.store.verifySnapshot(p.id, a); else if (a.path) this.checkedPath(p, a.path); return a }
  private failProject(id: string, error: unknown): void { this.change(id, p => { if (LIVE.has(p.status) && !p.archivedAt) { p.status = 'failed'; p.error = String(error) } }); this.emit('errorNotice', String(error)) }
  private syncRuntime(id: string): void {
    if (this.storageFailures.has(id)) return
    const p = this.store.project(id)
    const before = JSON.stringify(p)
    const previousStatus = p.status
    const now = Date.now()
    const sessions = Object.values(p.memberSessions).map(sid => this.orchestrator.getSessionById(sid)).filter(Boolean) as Session[]
    const leader = sessions.find(s => s.id === p.memberSessions[p.team.leaderMemberId])
    const inFlight = this.delivering.has(id) || this.scheduling.has(id) || sessions.some(s => this.reservations.has(s.id))
    const running = LIVE.has(p.status) && !p.archivedAt && sessions.some(s => s.status === 'running')
    if (p.activeSince !== undefined) p.activeMs += Math.max(0, now - p.activeSince)
    p.activeSince = running ? now : undefined
    for (const a of p.assignments) if (a.runId === p.runId && !a.endedAt && ACTIVE.has(a.status)) {
      if (a.lastTick !== undefined) a.activeMs += Math.max(0, now - a.lastTick)
      const session = sessions.find(s => s.id === p.memberSessions[a.memberId])
      a.lastTick = running && session?.status === 'running' ? now : undefined
    }
    if (p.status === 'stopping' && !inFlight && !sessions.some(s => isSessionBusy(s.status))) {
      p.status = 'interrupted'
      for (const a of p.assignments) if (a.runId === p.runId && ACTIVE.has(a.status)) { a.status = 'cancelled'; a.endedAt ||= now; a.lastTick = undefined }
    } else if (LIVE.has(p.status) && !p.archivedAt) {
      const pendingUser = p.interactions.some(i => i.runId === p.runId && i.state === 'pending' && teamInteractionForUser(i, p.team.leaderMemberId))
      const waitingMembers = p.assignments.some(a => a.runId === p.runId && !a.endedAt && ACTIVE.has(a.status)) || sessions.some(s => s.id !== leader?.id && isSessionBusy(s.status))
      const blockingQuestion = pendingTeamQuestion(p)
      p.status = blockingQuestion ? 'waiting_user' : leader?.status === 'running' || leader?.status === 'queued' ? 'running' : pendingUser ? 'waiting_user' : waitingMembers ? 'waiting_members' : 'waiting_user'
    }
    if (JSON.stringify(p) !== before) this.save(p, previousStatus !== p.status)
    else for (const i of p.interactions) for (const check of [...this.questionWaiters.get(i.id) || []]) check()
  }
  private tick(): void {
    if (this.recovering) return
    for (let p of this.store.catalog().projects) {
      if (this.storageFailures.has(p.id)) continue
      if (p.archivedAt || ['failed', 'completed', 'interrupted', 'initializing'].includes(p.status)) continue
      this.syncRuntime(p.id)
      p = this.store.project(p.id)
      let dirty = false
      let semantic = false
      if (LIVE.has(p.status)) {
        for (const a of p.assignments) if (a.runId === p.runId && !a.endedAt && ['running', 'blocked'].includes(a.status)) {
          const s = this.orchestrator.getSessionById(p.memberSessions[a.memberId])
          if (p.team.limits.taskMinutes > 0 && a.activeMs >= p.team.limits.taskMinutes * 60000 && s && isSessionBusy(s.status)) { a.error = '任务超时'; a.status = 'cancelling'; dirty = true; semantic = true }
        }
        if (p.team.limits.runMinutes > 0 && p.activeMs >= p.team.limits.runMinutes * 60000) { this.stop(p.id); continue }
      }
      if (dirty) { try { this.save(p, semantic); for (const a of p.assignments) if (a.status === 'cancelling' && a.error === '任务超时') this.orchestrator.interrupt(p.memberSessions[a.memberId]) } catch (e) { this.emit('errorNotice', String(e)) } }
    }
    this.schedule()
  }

  saveTeam(input: TeamDefinitionInput): TeamDefinition {
    const candidate = prepareTeam(input, input.id ? this.store.team(input.id) : undefined)
    if (candidate.status === 'active') this.validateTeam(candidate)
    const saved = this.store.saveTeam(input)
    this.emit('changed')
    return saved
  }
  deleteTeam(id: string, revision: number): void {
    this.store.deleteTeam(teamText(id, 'team_id', 128), revision)
    this.emit('changed')
  }
}
