import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { AgentDef, Project, Session, SessionConfig, UAEvent } from '../../shared/types'
import type { AssistantInput, DocumentEdit, PersonalAssistant, PersonalAssistantSnapshot, SessionSearchRequest } from '../../shared/assistant'
import { migrateAssistantCarrier } from '../../shared/assistant'
import { isSessionBusy } from '../../shared/sessionStatus'
import type { Orchestrator } from '../orchestrator'
import { createAssistantStore } from './store'
import { configureAssistantContext } from './context'
import { assistantIndexedMessage, assistantIndexedSession } from './transcript'
import { bindAssistantScope, revokeAssistantScope, setAssistantScopeActive, watchAssistantInbox, type AssistantScope } from './mcp'
import { AssistantReview } from './review'
import { AssistantCommands } from './commands'

export class PersonalAssistantService {
  private management?: (scope: AssistantScope, args: unknown) => Promise<unknown>
  configureManagement(handler: (scope: AssistantScope, args: unknown) => Promise<unknown>): void { this.management = handler }
  readonly store = createAssistantStore()
  readonly commands: AssistantCommands
  private review: AssistantReview
  private stopInbox = () => {}
  private inboxReady: Promise<void>
  private closing = false
  private pending = Promise.resolve()
  private turns = new Map<string, { key: string; seq: number; failed: boolean }>()
  private projections = new Map<string, { session: Session; message: import('../../shared/assistant').IndexedMessage }>()
  private projectionTimer?: ReturnType<typeof setTimeout>
  constructor(private orchestrator: Orchestrator, private getAgent: (id: string) => AgentDef | undefined, private changed: () => void,
    private onError: (error: unknown) => void, private resolveWorkspace: (workdir: string) => Project, defaultConfig: () => Promise<SessionConfig>) {
    this.commands = new AssistantCommands(orchestrator, () => this.snapshot(), () => this.invalidate(), defaultConfig)
    this.review = new AssistantReview(this.store, id => orchestrator.getSessionById(id), getAgent,
      () => orchestrator.listSessions().some(s => !!s.config.assistantSnapshot && isSessionBusy(s.status)), (scope,tool,args) => this.call(scope,tool,args), changed)
    this.inboxReady = watchAssistantInbox((scope,tool,args) => this.call(scope,tool,args), onError)
      .then(stop => { if (this.closing) stop(); else this.stopInbox = stop }).catch(onError)
    configureAssistantContext(async sessionId => {
      this.flushProjections()
      await this.pending
      try { return (await this.store.detail()).documents } catch (error) {
        this.onError(error)
        orchestrator.appendSystemNotice(sessionId, '本轮未加载助手记忆，请检查个人助手存储')
        return []
      }
    })
    const bind = (session: Session) => { if (this.inScope(session)) { bindAssistantScope(session.id); this.queue(() => this.store.transcript(assistantIndexedSession(session), [])) } }
    for (const session of orchestrator.listSessions()) bind(session)
    orchestrator.on('assistantSessionsLoaded', () => { for (const session of orchestrator.listSessions()) bind(session); this.queue(() => this.review.recover()) })
    orchestrator.on('sessionCreated', bind)
    orchestrator.on('sessionUpdated', ({ session }) => bind(session))
    orchestrator.on('beforeUserMessageCommit', ({ sessionId }) => {
      const session = orchestrator.getSessionById(sessionId)
      if (!session || !this.inScope(session)) return
      bindAssistantScope(sessionId); setAssistantScopeActive(sessionId, true)
      this.review.abort()
      this.queue(() => this.store.invalidate())
    })
    orchestrator.on('event', (event: UAEvent) => this.event(event))
    orchestrator.on('assistantTurnEnded', ({ sessionId, interrupted }) => {
      const session = orchestrator.getSessionById(sessionId), turn = this.turns.get(sessionId)
      this.flushProjections()
      setAssistantScopeActive(sessionId, false)
      if (session && this.inScope(session) && turn && !interrupted && !turn.failed) this.queue(async () => this.review.enqueue(session, turn.key, await this.store.lastSeq(session.id)))
    })
    orchestrator.on('sessionDeleted', (id: string) => {
      revokeAssistantScope(id); this.review.abort(); this.turns.delete(id)
      for (const [key, item] of this.projections) if (item.session.id === id) this.projections.delete(key)
      this.queue(() => this.store.removeSession(id))
    })
    orchestrator.on('statusChange', ({ sessionId, status }) => {
      if (['idle','completed','error','cancelled','cancelling'].includes(status)) setAssistantScopeActive(sessionId, false)
      if (status === 'cancelling' && orchestrator.getSessionById(sessionId)?.config.assistantSnapshot) { this.review.abort(); this.queue(() => this.store.invalidate()) }
    })
    orchestrator.on('assistantHistoryTruncated', ({ sessionId, after }) => {
      if (!orchestrator.getSessionById(sessionId)?.config.assistantSnapshot) return
      this.flushProjections(); this.review.abort(); this.queue(() => this.store.truncate(sessionId, after))
    })
    orchestrator.on('eventsReset', ({ sessionId, events }) => {
      const session = orchestrator.getSessionById(sessionId)
      if (session && this.inScope(session) && Array.isArray(events)) this.queue(() => this.store.transcript(assistantIndexedSession(session), (events as UAEvent[]).flatMap(event => { const message = assistantIndexedMessage(event); return message ? [message] : [] })))
    })
  }
  indexEvents(sessionId: string, events: UAEvent[]): void {
    const session = this.orchestrator.getSessionById(sessionId)
    if (session && this.inScope(session)) this.queue(() => this.store.transcript(assistantIndexedSession(session), events.flatMap(event => { const message = assistantIndexedMessage(event); return message ? [message] : [] })))
  }
  private inScope(session: Session): boolean { return !!session.config.assistantSnapshot && !session.teamBinding && !session.handoffId }
  private queue(work: () => Promise<unknown>): void { this.pending = this.pending.then(work).then(() => {}, error => this.onError(error)) }
  private flushProjections(): void {
    if (this.projectionTimer) clearTimeout(this.projectionTimer)
    this.projectionTimer = undefined
    for (const { session, message } of this.projections.values()) this.queue(() => this.store.transcript(assistantIndexedSession(session), [message]))
    this.projections.clear()
  }
  private event(event: UAEvent): void {
    const session = this.orchestrator.getSessionById(event.sessionId)
    if (!session || !this.inScope(session)) return
    const message = assistantIndexedMessage(event)
    if (message) {
      if (event.state === 'running' && message.role === 'assistant') {
        this.projections.set(message.id, { session, message })
        this.projectionTimer ||= setTimeout(() => this.flushProjections(), 300)
      } else {
        this.projections.delete(message.id)
        this.queue(() => this.store.transcript(assistantIndexedSession(session), [message]))
      }
      if (message.role === 'user' && !event.payload.zcodeProjection) {
        this.review.abort()
        this.queue(() => this.store.invalidate())
        this.turns.set(session.id, { key: message.id, seq: message.seq, failed: false })
      }
      else { const turn = this.turns.get(session.id); if (turn) turn.seq = Math.max(turn.seq, message.seq) }
    }
    if (event.type === 'error' || (event.type === 'turn_completed' && event.state !== 'success')) { const turn = this.turns.get(session.id); if (turn) turn.failed = true }
    if (event.type === 'turn_started') { bindAssistantScope(session.id); setAssistantScopeActive(session.id, true) }
    if (event.type === 'context_compaction' && event.state === 'success') this.queue(() => this.store.markCompacted(session.id))
  }
  async snapshot(): Promise<PersonalAssistantSnapshot> {
    const detail = await this.store.detail()
    if (!detail.assistant.enabled) throw new Error('个人助手已停用，请在设置中启用')
    const soul = detail.documents.find(d => d.type === 'soul')!, rules = detail.documents.find(d => d.type === 'working_rules')!
    return { assistantId: 'personal', soul: soul.content, soulRevision: soul.revision, workingRules: rules.content, workingRulesRevision: rules.revision }
  }
  async prepareConfig(input: SessionConfig): Promise<SessionConfig> {
    if (input.useAssistant !== undefined && typeof input.useAssistant !== 'boolean') throw new Error('invalid_assistant_selection')
    const { useAssistant, assistantSnapshot, ...config } = input
    if (!useAssistant) return config
    if (config.initializationTargetAgentId || config.roleSnapshot) throw new Error('当前任务模式不支持个人助手')
    const snapshot = await this.snapshot()
    if (!this.getAgent(config.agentId)?.capabilities.startupSystemPrompt) throw new Error('该 Agent 不支持启动时注入系统提示，无法承接个人助手')
    if (config.projectId || config.workdir || config.worktree) return { ...config, assistantSnapshot: snapshot }
    const project = await this.workspace()
    return { ...config, projectId: project.id, workdir: project.primaryDirectory, assistantSnapshot: snapshot }
  }
  async workspace(): Promise<Project> {
    const { assistant } = await this.store.detail()
    if (!assistant.enabled) throw new Error('个人助手已停用，请在设置中启用')
    const workdir = assistant.defaultWorkdir || homedir()
    try { if (!(await stat(workdir)).isDirectory()) throw new Error('not_directory') }
    catch { throw new Error(`个人助手运行目录不可用：${workdir}，请到设置重新选择`) }
    return this.resolveWorkspace(workdir)
  }
  async invalidate(): Promise<void> { this.flushProjections(); this.review.abort(); await this.pending; await this.store.invalidate(); this.changed() }
  async save(input: AssistantInput, edits: DocumentEdit[], expectedConfig?: PersonalAssistant) {
    const agent = this.getAgent(input?.defaultAgentId)
    if (!agent) throw new Error('所选默认 Agent 不存在')
    if (input.enabled && !agent.capabilities.startupSystemPrompt) throw new Error('所选默认 Agent 不支持启动时注入系统提示，无法承接个人助手')
    if (!agent.capabilities.permissionModes.length) throw new Error('所选默认 Agent 暂无可用权限模式')
    if (input.defaultPermissionMode !== undefined && !agent.capabilities.permissionModes.some(mode => mode.id === input.defaultPermissionMode)) throw new Error('所选默认 Agent 不支持该权限模式')
    if (input.reviewRuntime && !this.getAgent(input.reviewRuntime.agentId)) throw new Error('所选复盘 Agent 不存在')
    this.review.abort()
    this.flushProjections()
    await this.pending
    const value = await this.store.save(input, edits, expectedConfig)
    if (!value.assistant.enabled) for (const session of this.orchestrator.managedSessions()) if (session.config.assistantSnapshot) this.orchestrator.cancelManagementConfirmations(session.id)
    this.changed(); return value
  }
  /**
   * One-shot startup enforcement: assistant sessions whose agent cannot inject a
   * startup system prompt are detached from the assistant, and a stored default
   * agent without the capability is migrated to an available carrier (or the
   * assistant is disabled when none exists). Returns detached session ids so the
   * caller can drop their Feishu resident bindings.
   */
  async enforceAgentSupport(agents: AgentDef[]): Promise<string[]> {
    const detached = this.orchestrator.detachUnsupportedAssistantSessions().map(session => session.id)
    for (const id of detached) { revokeAssistantScope(id); this.queue(() => this.store.removeSession(id)) }
    const { assistant } = await this.store.detail()
    const migrated = migrateAssistantCarrier(assistant, agents)
    if (migrated) {
      this.review.abort()
      this.flushProjections()
      await this.pending
      await this.store.save(migrated, [])
      this.changed()
    }
    return detached
  }
  async call(scope: AssistantScope, tool: string, args: any): Promise<unknown> {
    this.flushProjections()
    if (!scope.active) throw new Error('assistant_scope_expired')
    if (scope.jobId && tool === 'assistant_memory' && !await this.store.job(scope.jobId)) throw new Error('stale_review')
    if (!scope.jobId) {
      const session = this.orchestrator.getSessionById(scope.sessionId)
      if (!session || !this.inScope(session)) throw new Error('assistant_session_required')
    }
    if (tool === 'uniagent_manage') {
      if (scope.jobId || !this.management || !(await this.store.detail()).assistant.enabled || !scope.active) throw new Error('assistant_management_unavailable')
      return this.management(scope, args)
    }
    if (tool === 'assistant_memory') {
      if (scope.jobId && scope.calls++ >= 8) throw new Error('review_tool_budget_exceeded')
      if (!scope.jobId && args?.action !== 'read') this.review.abort()
      await this.pending
      if (!scope.active) throw new Error('assistant_scope_expired')
      const value = await this.store.memory(args, scope.jobId ? { writer: 'auto_review', jobId: scope.jobId } : { writer: 'agent', sessionId: scope.sessionId })
      if (!scope.jobId && args?.action !== 'read') this.changed()
      return value
    }
    if (tool === 'session_search') {
      if (scope.jobId && scope.calls++ >= 8) throw new Error('review_tool_budget_exceeded')
      await this.pending
      if (!scope.active) throw new Error('assistant_scope_expired')
      const request = args as SessionSearchRequest
      if (request?.sessionId === scope.sessionId) throw new Error('当前会话已在上下文中，请搜索其它历史会话')
      return this.store.search({ ...request, excludeSessionIds: scope.jobId ? [] : [scope.sessionId] })
    }
    throw new Error('assistant_tool_not_allowed')
  }
  async close(): Promise<void> { this.closing = true; configureAssistantContext(undefined); this.stopInbox(); this.flushProjections(); await this.review.close(); await this.inboxReady; await this.pending; await this.store.close() }
}
