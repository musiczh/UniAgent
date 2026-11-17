import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { AgentDef, Attachment, Session, SessionConfig, UAEvent } from '../../shared/types'
import { isSessionBusy } from '../../shared/sessionStatus'
import { ROUTER_SYSTEM_PROMPT, routerConfig, resolveRouterConfig, parseRouterDecision, routerInputId, routerObjectScope, routerScopeKey, routerScanFor, type RouterConfig, type RouterDecision, type RouterInput, type RouterObject, type RouterRequest, type RouterResolution, type RouterSnapshot, type RouterQuery, type RouterReading, type RouterScan } from '../../shared/router'
import { parseRouterFeedback, parseRouterReviewDeletion, type RouterFeedback, type RouterFeedbackInput, type RouterReviewQuery, type RouterReviewTarget, type RouterReviewDeletionItem } from '../../shared/routerReview'
import type { RouterStore } from './store'
import { RouterMcpBridge, projectMemoryCliGuide, runtimeContextCliGuide } from './mcp'
import { routerTargetVersion } from './target'
import type { Orchestrator } from '../orchestrator'
import { taskRequestFingerprint } from '../../shared/taskRequest'
import { RouterSummaryService } from './summary'
import { DeepSeekHostError } from '../deepseekHostClient'
import { RequirementRoutingService } from '../requirementRouting'
import type { RequirementStore } from '../requirementStore'
import { assertRouterScope, RouterToolError, routerError } from './errors'
import { canRetryRouterRequest, routerBusinessInput, routerRoutingInput } from '../../shared/router'
import { submittedTextHash } from '../submittedUserMessages'
import { PROJECT_MEMORY_GUIDE } from '../../shared/projectMemory'

interface RouterDependencies {
  runtimeContext?: (sessionId: string, tool: string, args: unknown) => Promise<unknown>
  projectMemory?: (sessionId: string, args: unknown) => Promise<unknown>
  agents: () => AgentDef[]
  config: () => RouterConfig | undefined
  saveConfig: (config: RouterConfig) => void
  orchestrator: Pick<Orchestrator,'getSessionById'|'getEvents'|'getQueue'|'sendMessage'|'createRouterDraft'|'updateSessionConfig'|'acceptRoutedInput'|'setInitialRequirementContext'|'appendSystemNotice'|'interrupt'|'managedSessions'|'disposeSession'>
  objects: () => Promise<RouterObject[]>
  newTask: (request: RouterRequest, decision: RouterDecision, execution: SessionConfig) => Promise<Session>
  recoverTask: (request: RouterRequest) => Promise<Session | undefined>
  beforeDispatch?: (request: RouterRequest, session: Session) => Promise<void>
  changed: () => void
  error: (error: unknown) => void
  appVersion?: () => string
  reviewSaved?: (feedback: RouterFeedback) => Promise<void>
  generateDescription?: (config: RouterConfig, prompt: string, signal: AbortSignal) => Promise<string>
  generateRouting?: (config: RouterConfig, prompt: string, signal: AbortSignal) => Promise<string>
  routing?: Pick<RequirementStore, 'routingSources' | 'saveRouting'>
  taskObject?: (sessionId: string) => Promise<RouterObject | undefined>
}
export class RouterController {
  private bridge: RouterMcpBridge
  private active?: string
  private traceStartSeq = -1
  private completedSeq = -1
  private session?: string
  private opening?: Promise<Session>
  private switching?: Promise<Session>
  private savingConfig = false
  private switchSource?: string
  private pumping?: Promise<void>
  private pumpAgain=false
  private recovering?: Promise<void>
  private closed = false
  private mutations = new Map<string,Promise<unknown>>()
  private summaries?: RouterSummaryService
  private refreshing?: Promise<void>
  private routingViews?: RequirementRoutingService
  private sourceRefreshTimer?: ReturnType<typeof setTimeout>
  private refreshAgain = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryAt?: number
  private restoreComplete = true
  constructor(readonly store: RouterStore, private deps: RouterDependencies, directory: string) {
    this.bridge = new RouterMcpBridge(directory,(tool,args,sessionId)=>this.call(tool,args,sessionId),deps.projectMemory,deps.runtimeContext)
    if (deps.generateDescription) this.summaries = new RouterSummaryService({ store, config: () => routerConfig(deps.config()), busy: () => !!this.active,
      refresh: () => this.refreshObjects(), generate: deps.generateDescription, error: deps.error })
    if (deps.routing && deps.generateDescription) this.routingViews = new RequirementRoutingService({ enabled: () => routerConfig(deps.config()).enabled, busy: () => !!this.active,
      sources: id => deps.routing!.routingSources(id), save: (id, view) => deps.routing!.saveRouting(id, view), chunks: text => store.routingChunks(text),
      generate: (prompt, signal) => (deps.generateRouting || deps.generateDescription)!(routerConfig(deps.config()), prompt, signal), changed: () => { void this.refreshObjects().catch(deps.error) }, error: deps.error })
  }
  private refreshObjects(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing }
    this.refreshing = (async () => {
      do { this.refreshAgain = false; const objects = await this.deps.objects(); await this.store.index(objects)
        for (const object of objects) if (object.routing && !object.archived) this.routingViews?.schedule(object.id, object.routing)
      } while (this.refreshAgain && !this.closed)
      this.summaries?.schedule()
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  sourcesChanged(): void {
    if (this.closed || this.sourceRefreshTimer || !routerConfig(this.deps.config()).enabled) return
    this.sourceRefreshTimer = setTimeout(() => { this.sourceRefreshTimer = undefined; void this.refreshObjects().catch(this.deps.error) }, 1500)
    this.sourceRefreshTimer.unref?.()
  }
  async snapshot(): Promise<RouterSnapshot> {
    const config = routerConfig(this.deps.config())
    const [recent, pending] = await Promise.all([this.store.requests(), this.store.pending()])
    const requests = [...new Map([...recent, ...pending].map(request => [request.requestId, request])).values()].sort((a,b)=>a.createdAt-b.createdAt)
    return {config,...resolveRouterConfig(config,this.deps.agents()),sessionId:this.session,activeRequestId:this.active,switchingSession:!!this.switching,
      sessionNotice:await this.store.sessionNotice(),conversationSessions:await this.store.conversationSessions(),requests,feedbackPrompts:await this.store.reviewPrompts()}
  }
  reviewList(query?: RouterReviewQuery) { return this.store.reviewList(query) }
  reviewDeletion(ids?: string[]) { return this.store.reviewDeletion(ids) }
  async deleteReviews(items: RouterReviewDeletionItem[]) { const result = await this.store.reviewDelete(parseRouterReviewDeletion(items)); this.deps.changed(); return result }
  async reviewDetail(id: string, attemptId?: string, includeTrace = false) {
    const detail = await this.store.reviewDetail(id, attemptId, includeTrace)
    if (!includeTrace || detail.traceAvailable) return detail
    const sessionId = this.session || await this.store.sessionId()
    await this.store.reviewLinkLegacy(id, sessionId, await this.deps.orchestrator.getEvents(sessionId))
    return this.store.reviewDetail(id, attemptId, includeTrace)
  }
  async reviewTargets(): Promise<RouterReviewTarget[]> { return (await this.deps.objects()).map(({ id, kind, title, projectId, requirementId, archived }) => ({ id, kind, title, projectId, requirementId, archived })) }
  async saveReview(raw: RouterFeedbackInput) {
    const input = parseRouterFeedback(raw), expected = input.expected
    if (expected && expected.kind !== 'create_requirement') {
      const objects = await this.reviewTargets(), previous = (await this.store.reviewDetail(input.requestId, input.attemptId)).feedback?.expected
      const name = (key: 'projectId' | 'requirementId' | 'taskId', kind: RouterReviewTarget['kind'], label: 'projectName' | 'requirementName' | 'taskTitle') => {
        const id = expected[key]; if (!id) return undefined
        const object = objects.find(row => row.id === id && row.kind === kind)
        if (object) return object.title
        if (previous?.[key] === id) return previous[label]
        throw new Error('预期目标已不存在，请重新选择或只保存判断')
      }
      expected.projectName = name('projectId', 'space', 'projectName'); expected.requirementName = name('requirementId', 'requirement', 'requirementName'); expected.taskTitle = name('taskId', 'task', 'taskTitle')
      const task = objects.find(row => row.kind === 'task' && row.id === expected.taskId), requirement = objects.find(row => row.kind === 'requirement' && row.id === expected.requirementId)
      if (task && (expected.projectId && task.projectId !== expected.projectId || expected.requirementId && task.requirementId !== expected.requirementId || expected.kind === 'reuse_task' && expected.scope === 'space' && task.requirementId) || requirement && expected.projectId && requirement.projectId !== expected.projectId) throw new Error('预期任务与选择的空间或需求不一致')
      if (!expected.projectName && requirement?.projectId) expected.projectName = objects.find(row => row.id === requirement.projectId && row.kind === 'space')?.title
    }
    const result = await this.store.reviewSave(input)
    if (result.feedback) { try { await this.deps.reviewSaved?.(result.feedback) } catch { /* Local feedback stays saved; the monitoring worker recovers its durable history. */ } }
    this.deps.changed(); return result
  }
  async dismissReview(id: string, attemptId: string) { await this.store.reviewDismiss(id, attemptId); this.deps.changed() }
  async copyReview(id?: string) { const sessionId = this.session || await this.store.sessionId(); return this.store.reviewExport(id, sessionId, await this.deps.orchestrator.getEvents(sessionId)) }
  private async reviewStep(id: string, kind: string, data: unknown): Promise<void> { try { await this.store.reviewStep(id, kind, data) } catch (error) { this.deps.error(error) } }
  private async finishReview(request: RouterRequest, endSeq?: number, error?: string): Promise<void> {
    try { const events = this.session ? await this.deps.orchestrator.getEvents(this.session) : []
      await this.store.reviewFinish(request, events.filter(event => event.seq > this.traceStartSeq && (endSeq === undefined || event.seq <= endSeq)), error); this.deps.changed()
    } catch (reason) { this.deps.error(reason) }
  }
  async saveConfig(config: RouterConfig, expectedVersion: number): Promise<RouterSnapshot> {
    if (this.savingConfig) throw new Error('Router 配置正在保存，请稍后重试')
    const previous=routerConfig(this.deps.config())
    if (previous.version!==expectedVersion) throw new Error('Router 配置已变化，请重新读取后保存')
    const next=routerConfig({...config,version:previous.version+1})
    const availability=resolveRouterConfig(next,this.deps.agents())
    if (next.enabled && !availability.available) throw new Error(availability.reason)
    const deferred = !!this.active || !!this.pumping || !!this.opening || !!this.switching || isSessionBusy(this.deps.orchestrator.getSessionById(this.session || '')?.status)
    this.savingConfig = true
    try {
      this.deps.saveConfig(next);this.deps.changed()
      if (next.enabled) {
        try { if (!deferred) await this.open() }
        catch (error) { this.deps.saveConfig(previous); this.deps.changed(); throw error }
        for(const session of this.deps.orchestrator.managedSessions())this.trackSession(session)
      }
      return await this.snapshot()
    } finally { this.savingConfig = false; this.pump() }
  }
  async open(runConfig?: RouterConfig): Promise<Session | undefined> {
    const savedConfig = routerConfig(this.deps.config())
    const config=runConfig || (savedConfig.enabled ? (await this.store.pending()).find(row => row.state === 'queued' && row.autoRecovery)?.config : undefined) || savedConfig
    if (!config.enabled) return this.session?this.deps.orchestrator.getSessionById(this.session):undefined
    const availability=resolveRouterConfig(config,this.deps.agents())
    if (!availability.available) throw new Error(availability.reason)
    if (this.opening) return this.opening
    const operation=(async()=>{
      const id=await this.store.sessionId()
      const previous = this.deps.orchestrator.getSessionById(id)
      if (previous && (this.active || isSessionBusy(previous.status))) { this.session = id; return previous }
      if (previous && previous.config.agentId !== config.agentId) {
        this.session = id
        return this.switchSession(id, undefined, { fromAgentId: previous.config.agentId, toAgentId: config.agentId, switchedAt: Date.now() }, config)
      }
      await this.bridge.bind(id)
      const session=this.deps.orchestrator.createRouterDraft({agentId:config.agentId,model:config.model,effort:config.effort,
        workdir:homedir(),permissionMode:'full-access',managedPurpose:'router'},id)
      this.session=id
      if (!isSessionBusy(session.status) && (session.config.model!==config.model||session.config.effort!==config.effort)) {
        try { await this.deps.orchestrator.updateSessionConfig(id,{model:config.model,effort:config.effort}) }
        catch (error) {
          if (!(error instanceof DeepSeekHostError) || error.code !== 'connection-lost-reopen-session') throw error
          this.deps.error(error) // Keep history accessible; pump verifies delivery before replacing this Session.
        }
      }
      return session
    })()
    this.opening=operation
    try {return await operation} finally {if(this.opening===operation)this.opening=undefined}
  }
  newSession(expectedId: string): Promise<Session> { return this.switchSession(expectedId) }
  private switchSession(expectedId: string, retry?: RouterRequest, agentSwitch?: { fromAgentId: string; toAgentId: string; switchedAt: number }, runConfig?: RouterConfig): Promise<Session> {
    if (!expectedId || expectedId !== this.session) return Promise.reject(new Error('Router 会话已变化，请刷新后重试'))
    if (this.switching) return this.switchSource === expectedId ? this.switching : Promise.reject(new Error('Router 会话已变化，请刷新后重试'))
    const operation = (async () => {
      const config = runConfig || retry?.config || routerConfig(this.deps.config()), availability = resolveRouterConfig(config, this.deps.agents())
      if (!config.enabled || !availability.available) throw new Error(availability.reason || 'RouterAgent 尚未启用')
      if (!retry) {
        if (this.active || isSessionBusy(this.deps.orchestrator.getSessionById(expectedId)?.status)) throw new Error('正在分配任务，请等待处理结束后新建会话')
        if (!agentSwitch) await this.pumping
        if (this.active || isSessionBusy(this.deps.orchestrator.getSessionById(expectedId)?.status)) throw new Error('正在分配任务，请等待处理结束后新建会话')
      }
      if (!agentSwitch) await this.opening?.catch(() => {})
      if (this.closed || expectedId !== this.session) throw new Error('Router 会话已变化，请刷新后重试')
      const id = 's_' + randomUUID()
      const next = this.deps.orchestrator.createRouterDraft({ agentId: config.agentId, model: config.model, effort: config.effort,
        workdir: homedir(), permissionMode: 'full-access', managedPurpose: 'router' }, id)
      await this.store.replaceSession(expectedId, id, retry ? { requestId: retry.requestId, version: retry.version } : undefined, agentSwitch)
      this.session = id
      this.completedSeq = -1
      await this.bridge.bind(id)
      this.deps.orchestrator.disposeSession(expectedId, true)
      return next
    })().finally(() => {
      if (this.switching === operation) { this.switching = undefined; this.switchSource = undefined }
      this.deps.changed(); this.pump()
    })
    this.switchSource = expectedId; this.switching = operation; this.deps.changed()
    return operation
  }
  private async failRouting(id: string, sessionId: string, error: unknown, beforePrompt: boolean): Promise<void> {
    await this.serial(id, async () => {
      if (sessionId !== this.session || this.active !== id) return
      let request = await this.store.request(id)
      if (!request || request.state !== 'routing') return
      const safe = beforePrompt && request.delivery === 'pending' && !request.decision && !request.targetId
      await this.finishReview(request, undefined, String(error))
      const reconnect = safe && !request.recovery?.attempts && (request.autoRecovery?.attempts || 0) < 2
      if (reconnect) {
        try { await this.switchSession(sessionId, request); return }
        catch (failure) { error = failure; request = await this.store.request(id) || request }
      }
      if (request.state === 'routing') await this.change(request, { state: 'failed', error: String(error),
        failure: safe ? { code: 'connection-lost-reopen-session', sessionId } : undefined,
        ...(safe ? { recovery: request.recovery || { attempts: 1, previousSessionId: sessionId },
          autoRecovery: { attempts: (request.autoRecovery?.attempts || 0) + Number(reconnect) || 1,
            total: (request.autoRecovery?.total || 0) + Number(reconnect) || 1, phase: 'routing', reason: String(error) } } : {}) })
    })
    if (this.active === id && (this.session === sessionId || (await this.store.request(id))?.state === 'queued')) { this.active = undefined; this.deps.changed() }
    this.pumpAgain = true; this.pump()
  }
  async submit(input: RouterInput): Promise<RouterRequest> {
    const config=routerConfig(this.deps.config())
    if (!config.enabled) throw new Error('RouterAgent 尚未启用')
    const availability=resolveRouterConfig(config,this.deps.agents())
    if (!availability.available) throw new Error(availability.reason)
    if (input.execution?.managedPurpose || input.execution?.assistantSnapshot || input.execution?.roleSnapshot || input.execution?.initializationTargetAgentId) throw new Error('该任务模式请使用原新建入口')
    const scope=input.scope||{kind:'global'}
    if (!['global','space','requirement'].includes(scope.kind) || scope.kind==='space'&&!scope.projectId || scope.kind==='requirement'&&!scope.requirementId) throw new Error('invalid_router_scope')
    const request=await this.store.register({...input,scope},config)
    this.deps.changed();this.pump()
    return request
  }
  private serial<T>(id: string, operation: ()=>Promise<T>): Promise<T> {
    const result=(this.mutations.get(id)||Promise.resolve()).catch(()=>{}).then(operation)
    this.mutations.set(id,result)
    void result.finally(()=>{if(this.mutations.get(id)===result)this.mutations.delete(id)}).catch(()=>{})
    return result
  }
  private async change(request: RouterRequest,patch: Partial<RouterRequest>): Promise<RouterRequest> {
    const next=await this.store.update(request.requestId,request.version,patch)
    this.deps.changed();return next
  }
  private wakeAt(at: number): void {
    if (this.closed || this.retryTimer && this.retryAt! <= at) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryAt = at
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.retryAt = undefined; this.pump() }, Math.max(0, at - Date.now()))
    this.retryTimer.unref?.()
  }
  private async automatic(request: RouterRequest, reason: string, phase: 'routing' | 'delivery'): Promise<RouterRequest> {
    const previous = request.autoRecovery, attempts = previous?.attempts || 0
    if (attempts >= 2) return this.change(request, { ...(phase === 'routing' ? { state: 'failed' as const } : {}), error: phase === 'routing' ? '自动恢复后仍未完成分配：' + reason : reason,
      autoRecovery: previous && { ...previous, nextAt: undefined } })
    const nextAt = Date.now() + (attempts ? 8000 : 2000)
    const next = await this.change(request, { ...(phase === 'routing' ? { state: 'queued' as const, delivery: 'pending' as const, decision: undefined, question: undefined } : {}),
      error: undefined, autoRecovery: { attempts: attempts + 1, total: (previous?.total || 0) + 1, phase, reason, nextAt } })
    this.wakeAt(nextAt); return next
  }
  private transient(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code
    return typeof code === 'string' && ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','connection-lost','rate_limit_exceeded','server_error','service_unavailable','router-tool-recovery','429','503'].includes(code) || code === 429 || code === 503
  }
  private async routingFailed(request: RouterRequest, error: unknown, retryable: boolean): Promise<RouterRequest> {
    if (request.targetId || !['pending','failed'].includes(request.delivery)) return this.automatic(await this.change(request, {
      state: request.targetId ? 'bound' : 'failed', delivery: 'unknown', error: String(error) }), String(error), 'delivery')
    return retryable ? this.automatic(request, String(error), 'routing') : this.change(request, { state: 'failed', error: String(error),
      autoRecovery: request.autoRecovery && { ...request.autoRecovery, nextAt: undefined } })
  }
  private async checkDelivery(request: RouterRequest): Promise<RouterRequest> {
    try {
      const target = request.targetId ? this.deps.orchestrator.getSessionById(request.targetId) : await this.deps.recoverTask(request)
      if (!target) return this.automatic(request, '暂时无法读取原目标，投递结果仍待核对。', 'delivery')
      await this.deps.orchestrator.getEvents(target.id)
      const input = routerBusinessInput(request), queued = this.deps.orchestrator.getQueue?.(target.id)?.find(row => row.id === request.requestId)
      const submitted = target.submittedUserMessages?.find(row => row.routedInputId === request.requestId)
      // Older releases delivered the combined routing input. Recognize that exact
      // receipt for reconciliation only; new deliveries always use the original.
      const receipts = [input, routerRoutingInput(request)]
      if (queued && !receipts.some(row => queued.prompt === row.prompt && JSON.stringify(queued.attachments || []) === JSON.stringify(row.attachments || [])) ||
          submitted && !receipts.some(row => submitted.textHash === submittedTextHash(row.prompt) && JSON.stringify(submitted.attachments || []) === JSON.stringify(row.attachments || []))) throw new Error('原输入与接收记录不一致，请检查原任务。')
      const status = submitted ? 'accepted' : queued ? queued.deliveryUncertain ? 'unknown' : queued.state === 'pending' ? 'queued' : 'accepted' : undefined
      if (status && status !== 'unknown') return this.change(request, { state: 'bound', delivery: status, targetId: target.id, targetTitle: target.taskMetadata?.title || target.title,
        error: undefined, autoRecovery: request.autoRecovery && { ...request.autoRecovery, nextAt: undefined } })
      // Reusing acceptRoutedInput is safe only when the durable queue is readable
      // and neither ledger records a send. Existing uncertain entries stay blocked.
      if (!queued && !submitted && request.targetVersion && request.decision?.action === 'reuse_task') {
        await this.deps.beforeDispatch?.(request, target)
        const receipt = await this.deps.orchestrator.acceptRoutedInput(target.id, request.requestId, input.prompt, input.attachments, request.targetVersion, request.feishu ? 'feishu' : 'app')
        if (receipt.status !== 'unknown') return this.change(request, { state: 'bound', delivery: receipt.status, error: undefined,
          autoRecovery: request.autoRecovery && { ...request.autoRecovery, nextAt: undefined } })
      }
      request = await this.change(request, { targetId: target.id, targetTitle: target.taskMetadata?.title || target.title })
      return this.automatic(request, '暂时无法确认目标是否已接收，未重复发送；可再次核对或查看原任务。', 'delivery')
    } catch (error) { return this.automatic(request, String(error), 'delivery') }
  }
  private supplement(request: RouterRequest, answer?: string, attachments?: Attachment[], sourceId?: string): Pick<RouterRequest, 'resolution' | 'supplements'> {
    if (answer !== undefined && (typeof answer !== 'string' || answer.length > 4000) || sourceId !== undefined && (typeof sourceId !== 'string' || sourceId.length > 200)) throw new Error('补充信息无效或过长')
    const text = answer?.trim() || ''
    if (answer !== undefined && !text && !attachments?.length) throw new Error('请填写补充信息')
    if (!text && !attachments?.length) return { resolution: request.resolution, supplements: request.supplements }
    if (request.supplements?.length && request.supplements.length >= 30) throw new Error('补充记录过多，请检查原请求')
    const resolution = [request.resolution, text, attachments?.map(row => '[补充附件] ' + row.name).join('\n')].filter(Boolean).join('\n')
    if (resolution.length > 32000) throw new Error('补充信息过长')
    return { resolution, supplements: [...request.supplements || [], { text, ...(request.question ? { question: request.question } : {}), ...(attachments?.length ? { attachments } : {}), ...(sourceId ? { sourceId } : {}) }] }
  }
  private pump(): void {
    if(this.closed||!this.restoreComplete||this.active||this.switching||this.savingConfig)return
    if(this.pumping){this.pumpAgain=true;return}
    this.pumpAgain=false
    this.pumping=(async()=>{
      const savedConfig=routerConfig(this.deps.config())
      if(!savedConfig.enabled)return
      const pending = await this.store.pending()
      for (const row of pending) if (row.delivery === 'unknown' && row.autoRecovery?.nextAt && row.autoRecovery.nextAt <= Date.now()) await this.serial(row.requestId, async () => {
        const current = await this.store.request(row.requestId)
        if (current?.delivery === 'unknown' && current.autoRecovery?.nextAt && current.autoRecovery.nextAt <= Date.now()) await this.checkDelivery(current)
      })
      for (const row of pending) if (row.autoRecovery?.nextAt && row.autoRecovery.nextAt > Date.now() && (row.state === 'queued' || row.delivery === 'unknown')) this.wakeAt(row.autoRecovery.nextAt)
      const next=pending.find(row=>row.state==='queued')
      if (next?.autoRecovery?.nextAt && next.autoRecovery.nextAt > Date.now()) { this.wakeAt(next.autoRecovery.nextAt); return }
      if(!next||this.switching||this.closed||this.savingConfig)return
      const config = next.autoRecovery ? next.config : savedConfig
      const availability = resolveRouterConfig(config, this.deps.agents())
      if (!availability.available) {
        await this.serial(next.requestId, async () => { const current = await this.store.request(next.requestId); if (current?.state === 'queued') await this.routingFailed(current, availability.reason || 'RouterAgent 当前不可用', false) })
        this.pumpAgain = true; return
      }
      let session: Session | undefined
      try { session = await this.open(config) }
      catch (error) {
        await this.serial(next.requestId, async () => { const current = await this.store.request(next.requestId); if (current?.state === 'queued') await this.routingFailed(current, error, this.transient(error)) })
        this.deps.error(error); this.pumpAgain = true; return
      }
      if(!session||this.savingConfig||this.switching||isSessionBusy(session.status))return
      let history: UAEvent[]
      try { history = await this.deps.orchestrator.getEvents(session.id) }
      catch (error) {
        await this.serial(next.requestId, async () => { const current = await this.store.request(next.requestId); if (current?.state === 'queued') await this.routingFailed(current, error, this.transient(error)) })
        this.deps.error(error); this.pumpAgain = true; return
      }
      this.traceStartSeq = history.reduce((seq, event) => Math.max(seq, event.seq), -1)
      let attemptId: string | undefined
      try { attemptId = await this.store.reviewBegin({ ...next, state: 'routing', config }, session.id, ROUTER_SYSTEM_PROMPT, history, this.deps.appVersion?.() || 'unknown') } catch (error) { this.deps.error(error) }
      if (this.savingConfig || savedConfig.version !== routerConfig(this.deps.config()).version) {
        if (attemptId) await this.store.reviewFinish(next, [], '运行配置已变化，本次准备尚未发送。', true)
        this.pumpAgain = true; return
      }
      let request = await this.serial(next.requestId, async () => { const current = await this.store.request(next.requestId); return current?.state === 'queued' ? this.change(current, { state: 'routing', routerSessionId: session.id, roundId: attemptId || randomUUID(), roundStartedAt: Date.now(), error: undefined, failure: undefined, config,
        context: { protocolVersion: 2, objects: current.context?.objects || [], reading: current.context?.reading || { scannedTaskIds: [], details: [], catalogs: [] }, evidence: current.context?.evidence },
        autoRecovery: current.autoRecovery && { ...current.autoRecovery, nextAt: undefined } }) : undefined })
      if (!request) {
        const current = await this.store.request(next.requestId)
        if (current && attemptId) await this.store.reviewFinish(current, [], '路由开始前输入已取消。', true)
        this.pumpAgain = true; return
      }
      this.active=request.requestId
      try {
        await this.deps.orchestrator.updateSessionConfig(session.id,{model:request.config.model,effort:request.config.effort})
        if (this.closed || this.session !== session.id || (await this.store.request(request.requestId))?.state !== 'routing') return
        await this.refreshObjects()
        const context = { requestId: request.requestId, version: request.version, catalogRevision: await this.store.catalogRevision(), asOf: Date.now(),
          inputSource: request.supplements?.length ? 'clarification_reply' : 'new_input', input: request.prompt, attachments: request.attachments || [],
          hardScope: request.scope, clarification: request.resolution, clarificationHistory: request.supplements || [], reading: request.context?.reading,
          executionPolicy: { reuse: 'original', create: 'submitted' }, recovery: request.autoRecovery }
        if (this.closed || this.session !== session.id || (await this.store.request(request.requestId))?.state !== 'routing') return
        await this.reviewStep(request.requestId, 'request_context', context)
        await this.deps.orchestrator.sendMessage(session.id,'本轮路由请求：\n'+JSON.stringify(context),routerRoutingInput(request).attachments,undefined,false,{source:'app',displayText:request.prompt,routedInputId:request.requestId},false)
      } catch(error) {
        if (error instanceof DeepSeekHostError && error.code === 'connection-lost-reopen-session') await this.failRouting(request.requestId, session.id, error, true)
        else {
          await this.serial(request.requestId, async () => { const current = await this.store.request(request.requestId); if (current?.state === 'routing') await this.routingFailed(current, error, this.transient(error)) })
          if (this.active === request.requestId) { this.active = undefined; this.deps.changed() }
          this.pumpAgain = true
        }
        this.deps.error(error)
      }
    })().catch(this.deps.error).finally(()=>{this.pumping=undefined;const again=this.pumpAgain;this.pumpAgain=false;if(again&&!this.active&&!this.closed)this.pump()})
  }
  async event(event: UAEvent): Promise<void> {
    if (event.sessionId === this.session && ['error','turn_completed'].includes(event.type) && event.seq <= this.completedSeq) return
    if (event.sessionId === this.session && event.type === 'error' && event.payload.code === 'connection-lost-reopen-session' &&
        event.payload.nativeSubmission === 'not-submitted' && typeof event.payload.routedInputId === 'string' && event.payload.routedInputId === this.active) {
      await this.failRouting(event.payload.routedInputId, event.sessionId, new DeepSeekHostError(event.payload.code), true)
      return
    }
    if (event.sessionId === this.session && event.type === 'error' && this.active && !event.payload.recoveryIntermediate) {
      const id = this.active
      await this.serial(id, async () => { const request = await this.store.request(id)
        if (request?.state === 'routing' && (!event.payload.routedInputId || event.payload.routedInputId === id)) await this.change(request, {
          error: String(event.payload.message || 'Router 执行失败'), failure: { code: String(event.payload.code || ''), sessionId: event.sessionId } })
      })
    }
    const owner=this.deps.orchestrator.getSessionById(event.sessionId)
    if(owner&&!owner.config.managedPurpose){
      if (routerConfig(this.deps.config()).enabled && ['user_message','goal_message','turn_completed','error'].includes(event.type) && !event.payload.automaticRecovery && !event.payload.recoveryIntermediate) void this.refreshObjects().catch(this.deps.error)
      if(event.type==='user_message'||event.type==='turn_started')this.trackSession(owner)
      if(event.type==='turn_completed')this.bridge.setMemoryActive(owner.id,false)
    }
    if(event.sessionId===this.session&&event.type==='turn_completed'&&this.active&&event.seq>this.traceStartSeq&&(!event.payload.routedInputId||event.payload.routedInputId===this.active)){
      this.completedSeq = event.seq
      const id=this.active
      await this.serial(id,async()=>{
        if (event.sessionId !== this.session || this.active !== id) return
        const request=await this.store.request(id)
        if(request?.state==='routing') await this.routingFailed(request, request.error || '本轮没有返回有效分配结果。',
          event.state !== 'failed' || this.transient({ code: request.failure?.code }))
        const completed = await this.store.request(id)
        if (completed) await this.finishReview(completed, event.seq, event.state === 'failed' ? completed.error || 'Router 回合失败' : undefined)
      })
      if(event.sessionId===this.session&&this.active===id){this.active=undefined;this.deps.changed()}
      this.pump()
      this.summaries?.schedule()
    }
    if(event.sessionId===this.session&&event.type==='turn_completed'&&!this.active)this.pump()
    if(event.type==='user_message'&&typeof event.payload.routedInputId==='string'){
      const id=event.payload.routedInputId
      await this.serial(id,async()=>{const request=await this.store.request(id);if(request&&request.targetId===event.sessionId)await this.change(request,{delivery:'running'})})
    }
    if(event.type==='turn_completed'&&event.sessionId!==this.session){
      for(const request of await this.store.requests())if(request.targetId===event.sessionId&&request.delivery==='running')await this.serial(request.requestId,async()=>{
        const current=await this.store.request(request.requestId)
        if(current?.delivery==='running')await this.change(current,{delivery:event.state==='failed'?'failed':'finished'})
      })
    }
  }
  private async call(tool: string,raw: unknown,sessionId: string): Promise<unknown> {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid_router_arguments')
    const args=raw as Record<string,unknown>;routerInputId(args.requestId)
    return this.serial(args.requestId,async()=>{
      let request=await this.store.request(args.requestId as string)
      if(!request||this.session!==sessionId||this.active!==request.requestId)throw new Error('router_scope_expired')
      if(tool==='router_query'){
        const started = Date.now()
        if (Object.keys(args).some(key => !['requestId','mode','kind','projectId','objectId','taskId','selectedScope','cursor','sourceRef','refresh','scanId'].includes(key)) || request.state !== 'routing') throw new Error('invalid_router_arguments')
        const query = args as unknown as RouterQuery
        if (!['catalog','object_detail','task_briefs','task_detail'].includes(query.mode) ||
          ['projectId','objectId','taskId','cursor','sourceRef','scanId'].some(key => args[key] !== undefined && (typeof args[key] !== 'string' || !(args[key] as string).trim())) ||
          query.refresh !== undefined && typeof query.refresh !== 'boolean' ||
          query.sourceRef !== undefined && !['object_detail','task_detail'].includes(query.mode)) throw new Error('invalid_router_arguments')
        await this.refreshObjects()
        let page: any, reading: RouterReading = request.context?.reading || { scannedTaskIds: [], details: [], catalogs: [] }
        if (query.mode === 'catalog') {
          if (!['space','requirement'].includes(query.kind || '')) throw new Error('invalid_router_arguments')
          page = await this.store.catalog(request.requestId, query.kind!, query.projectId, query.cursor)
          const key = query.kind + ':' + (query.projectId || '')
          reading = { ...reading, catalogs: [...(reading.catalogs || []).filter(row => row.key !== key), { key, complete: page.coverage.complete, catalogRevision: page.catalogRevision, asOf: page.asOf }] }
        } else if (query.mode === 'task_briefs') {
          if (!query.selectedScope || !['space','requirement'].includes(query.selectedScope.kind)) throw new Error('invalid_router_scope')
          const scopeKeys = query.selectedScope.kind === 'space' ? ['kind','projectId'] : ['kind','requirementId']
          if (Object.keys(query.selectedScope).some(key => !scopeKeys.includes(key)) || typeof (query.selectedScope as any)[scopeKeys[1]] !== 'string' || !(query.selectedScope as any)[scopeKeys[1]].trim()) throw new Error('invalid_router_scope')
          page = await this.store.taskBriefs(request.requestId, query.selectedScope, query.cursor, query.refresh)
          const previous = routerScanFor(reading, query.selectedScope), scan: RouterScan = { selectedScope: query.selectedScope as RouterScan['selectedScope'], scanId: page.snapshotId, scanComplete: page.coverage.complete,
            catalogRevision: page.catalogRevision, asOf: page.asOf,
            scannedTaskIds: page.readTaskIds, details: previous && page.snapshotId === previous.scanId ? previous.details : [] }
          reading = { ...reading, ...scan, scans: { ...reading.scans, [routerScopeKey(query.selectedScope)]: scan } }
        } else {
          const id = query.mode === 'task_detail' ? query.taskId : query.objectId
          if (!id) throw new Error('invalid_router_arguments')
          if (query.mode === 'task_detail') {
            const hydrated = await this.deps.taskObject?.(id)
            if (hydrated) await this.store.index([hydrated], false)
          }
          const object = await this.store.object(id)
          if (query.mode === 'task_detail' ? object.kind !== 'task' : object.kind === 'task') throw new Error('router_target_kind_conflict')
          page = await this.store.detail(request.requestId, id, query.sourceRef, query.cursor, query.scanId)
          if (query.mode === 'task_detail') {
            const scope = routerObjectScope(object), scan: RouterScan = routerScanFor(reading, scope) || { selectedScope: scope, scanComplete: false, scannedTaskIds: [], details: [] },
              previous = scan.details.find(row => row.taskId === id && row.sourceRevision === page.sourceRevision)
            const updated = { ...scan, details: [...scan.details.filter(row => row.taskId !== id), { taskId: id, sourceRevision: page.sourceRevision,
              evidenceRefs: [...new Set([...(previous?.evidenceRefs || []), ...page.evidenceRefs])] }] }
            reading = { ...reading, ...updated, scans: { ...reading.scans, [routerScopeKey(scope)]: updated } }
          }
        }
        const versions = new Map((request.context?.objects || []).map(row => [row.id, row]))
        for (const object of page.objects) versions.set(object.id, object)
        const evidence = new Map((request.context?.evidence || []).map(row => [row.ref, row]))
        for (const item of page.objects as Array<{ id: string; version: string }>) {
          const object = await this.store.object(item.id)
          if (object.version !== item.version) throw new Error('object_revision_changed')
          const issue = (sourceRef?: string) => {
            const ref = 'e_' + createHash('sha256').update(JSON.stringify([request!.requestId, item.id, item.version, object.sourceRevision, sourceRef])).digest('hex').slice(0, 40)
            evidence.set(ref, { ref, objectId: item.id, version: item.version, sourceRevision: object.sourceRevision, sourceRef }); return ref
          }
          const ref = issue()
          for (const row of page.items || []) if (row.id === item.id) row.evidenceRef = ref
          if (page.target) page.target.evidenceRef = ref
          if (page.item) page.item.evidenceRef = ref
          for (const row of page.sources || []) row.evidenceRef = issue(row.ref)
        }
        request = await this.change(request, { ...(request.failure?.code === 'router-tool-recovery' ? { error: undefined, failure: undefined } : {}),
          context: { protocolVersion: 2, objects: [...versions.values()], reading, evidence: [...evidence.values()] } })
        const { objects: _objects, readTaskIds: _ids, evidenceRefs: _refs, ...value } = page
        const progress = { selectedScope: reading.selectedScope, scanId: reading.scanId, scanComplete: reading.scanComplete, scanned: reading.scannedTaskIds.length,
          details: reading.details.slice(-8).map(row => ({ taskId: row.taskId, sourceRevision: row.sourceRevision })), detailsTotal: reading.details.length, catalogs: reading.catalogs,
          scans: Object.values(reading.scans || {}).map(row => ({ selectedScope: row.selectedScope, scanId: row.scanId, catalogRevision: row.catalogRevision, asOf: row.asOf, complete: row.scanComplete, scanned: row.scannedTaskIds.length })) }
        const result = { ...value, catalogRevision: page.catalogRevision || await this.store.catalogRevision(), requestId: request.requestId, version: request.version, reading: progress }
        await this.reviewStep(request.requestId, 'query', { arguments: args, result, durationMs: Date.now() - started }); return result
      }
      if(tool!=='router_assign_task')throw new Error('unknown_router_tool')
      const {requestId:_id,version:_version,...value}=args
      const decision=parseRouterDecision(value)
      if(request.state==='bound'||request.state==='needs_input'){
        if(taskRequestFingerprint(request.decision)!==taskRequestFingerprint(decision))throw new Error('router_already_bound')
        return this.receipt(request)
      }
      if(request.state!=='routing'||request.version!==args.version)throw new Error('router_revision_conflict')
      await this.reviewStep(request.requestId, 'assignment', { arguments: args })
      request=await this.assign(request,decision)
      await this.reviewStep(request.requestId, 'receipt', this.receipt(request))
      return this.receipt(request)
    }).catch(error => this.serial(args.requestId as string, async () => {
      const id = args.requestId as string, request = await this.store.request(id), data = routerError(error)
      const nestedTaskId = (args.reuseAssessment as RouterDecision['reuseAssessment'])?.taskId
      const rawScope = args.selectedScope as RouterQuery['selectedScope']
      const targetId = typeof args.taskId === 'string' ? args.taskId : typeof args.requirementId === 'string' ? args.requirementId : typeof args.objectId === 'string' ? args.objectId : typeof args.projectId === 'string' ? args.projectId : typeof nestedTaskId === 'string' ? nestedTaskId :
        rawScope?.kind === 'space' ? rawScope.projectId : rawScope?.kind === 'requirement' ? rawScope.requirementId : undefined
      const target = targetId ? await this.store.object(targetId).catch(() => undefined) : undefined
      if (!data.recovery) {
        if (data.code === 'invalid_clarification_options') {
          data.message = '必要澄清必须给出至少一个有依据的候选或可行处理选项，通常2至4个；请补齐 clarificationOptions 后重提。工具格式错误不需要询问用户。'
          data.recovery = { action: 'retry' }
        }
        else if (data.code === 'router_target_required') {
          data.message = '顶层目标字段缺失：reuse_task 须填 taskId；需求新建填 requirementId；空间新建填 projectId；clarify 填 clarification。工具格式错误不是业务归属不明确，请补齐字段。'
          data.recovery = target ? { action: 'query', arguments: { requestId: id, ...(target.kind === 'task' ? { mode: 'task_detail', taskId: target.id } : { mode: 'object_detail', objectId: target.id }) } } : { action: 'retry' }
        }
        else if (data.code === 'invalid_router_scope' && rawScope && (rawScope.kind === 'requirement' && typeof rawScope.requirementId === 'string' || rawScope.kind === 'space' && typeof rawScope.projectId === 'string')) {
          const selectedScope = rawScope.kind === 'requirement' ? { kind: 'requirement' as const, requirementId: rawScope.requirementId } : { kind: 'space' as const, projectId: rawScope.projectId }
          data.message = '范围字段互斥：需求只填 kind/requirementId，空间只填 kind/projectId；请按 recovery.arguments 重读同一目标。'
          data.recovery = { action: 'query', arguments: { requestId: id, mode: 'task_briefs', selectedScope } }
        }
        else if (['invalid_scope_assessment','invalid_reuse_assessment'].includes(data.code)) {
          data.message = '可选判断记录结构无效；可省略 scopeAssessment 和 reuseAssessment，读取当前 version 后重提同一目标。'
          data.recovery = { action: 'retry' }
        }
        else if (tool === 'router_query' && (['invalid_reading_cursor','reading_snapshot_expired'].includes(data.code) ||
          data.code === 'object_revision_changed' && ['catalog','task_briefs'].includes(String(args.mode)))) {
          const { cursor: _cursor, scanId: _scanId, ...query } = args as unknown as RouterQuery
          data.message = '读取快照已失效，请从同一查询重新读取，不改变业务目标。'
          data.recovery = { action: 'query', arguments: { ...query, ...(query.mode === 'task_briefs' ? { refresh: true } : {}) } }
        }
        else if (['object_revision_changed','scan_scope_mismatch','context_unavailable','router_target_kind_conflict'].includes(data.code) && target) {
          data.message = '请直接重读当前目标；scanId 可省略，无需重新扫描目录。'
          data.recovery = { action: 'query', arguments: { requestId: id, ...(target.kind === 'task' ? { mode: 'task_detail', taskId: target.id } : { mode: 'object_detail', objectId: target.id }) } }
        }
        else if (data.code === 'task_not_eligible' && target) {
          data.message = '目标或所属范围已归档／只读。可查阅其资料，再判断可写目标；只有必要核查后仍有业务歧义才澄清。'
          data.recovery = { action: 'query', arguments: { requestId: id, ...(target.kind === 'task' ? { mode: 'task_detail', taskId: target.id } : { mode: 'object_detail', objectId: target.id }) } }
        }
        else {
          if (data.code === 'invalid_router_arguments') data.message = '请按工具声明修正参数；router_query 仅支持 catalog、object_detail、task_briefs、task_detail。本轮基础信息已随输入提供。'
          if (data.code === 'router_revision_conflict') data.message = '请求状态或版本已变化，请使用 current 中的最新版本修正本次提交；已结束的请求不得重投。'
          data.recovery = { action: 'retry' }
        }
      }
      let current = request
      if (request?.state === 'routing' && request.context?.protocolVersion === 2 && this.session === sessionId && this.active === id) {
        const signature = createHash('sha256').update(JSON.stringify([args, data.code, request.context.objects])).digest('hex')
        if (await this.store.recordToolFailure(id, signature) > 1) current = await this.change(request, { error: data.message, failure: { code: 'router-tool-recovery', sessionId } })
      }
      if (current && this.session === sessionId && this.active === id) data.current = { requestId: id, version: current.version, state: current.state, hardScope: current.scope }
      await this.reviewStep(id, 'error', { tool, arguments: args, error: String(error), details: data })
      throw new RouterToolError(data)
    }))
  }
  private receipt(request: RouterRequest): object {
    return {requestId:request.requestId,version:request.version,state:request.state,delivery:request.delivery,taskId:request.targetId,
      title:request.targetTitle,project:request.projectName,requirement:request.requirementName,reason:request.decision?.reason,question:request.question,error:request.error}
  }
  private async assign(request: RouterRequest,decision: RouterDecision): Promise<RouterRequest> {
    if (decision.initialRequirementContext) await this.store.validateInitialRequirementContext(decision.initialRequirementContext)
    if(decision.action==='clarify'){
      return this.change(request,{state:'needs_input',decision:{...decision,clarificationOptions:decision.clarificationOptions || []},question:decision.clarification,error:undefined,failure:undefined})
    }
    const id=decision.action==='reuse_task'?decision.taskId:decision.action==='create_task_in_requirement'?decision.requirementId:decision.projectId
    await this.refreshObjects()
    const objects=await this.deps.objects(), rawObject=objects.find(row=>row.id===id)
    if (!rawObject) throw new Error('object_not_found')
    const object=await this.store.object(id!)
    const names={projectName:objects.find(row=>row.kind==='space'&&row.id===object?.projectId)?.title,
      requirementName:object?.kind==='requirement'?object.title:objects.find(row=>row.kind==='requirement'&&row.id===object?.requirementId)?.title}
    if(object.kind!==(decision.action==='reuse_task'?'task':decision.action==='create_task_in_requirement'?'requirement':'space'))throw new Error('router_target_kind_conflict')
    if(decision.action==='reuse_task'&&(decision.projectId&&decision.projectId!==object.projectId||decision.requirementId&&decision.requirementId!==object.requirementId)||decision.action==='create_task_in_requirement'&&decision.projectId&&decision.projectId!==object.projectId)throw new Error('router_scope_conflict')
    assertRouterScope(request, object)
    if(object.archived||object.readOnly||objects.some(row=>row.kind!=='task'&&(row.id===object.projectId||row.id===object.requirementId)&&(row.archived||row.readOnly)))throw new Error('task_not_eligible')
    if(decision.action==='reuse_task'){
      const target=this.deps.orchestrator.getSessionById(decision.taskId!)
      if(!target||target.config.managedPurpose||target.config.assistantSnapshot||target.teamBinding||target.readOnly||target.archived)throw new Error('router_target_not_writable')
      request=await this.change(request,{...names,state:'committing',decision,targetId:target.id,targetTitle:target.taskMetadata?.title||target.title,targetVersion:routerTargetVersion(target),delivery:'dispatching',error:undefined,failure:undefined})
      try {
        await this.deps.beforeDispatch?.(request,target)
        if (decision.initialRequirementContext) this.deps.orchestrator.setInitialRequirementContext(target.id, decision.initialRequirementContext)
        const input = routerBusinessInput(request)
        const receipt=await this.deps.orchestrator.acceptRoutedInput(target.id,request.requestId,input.prompt,input.attachments,request.targetVersion!,request.feishu?'feishu':'app')
        const next = await this.change(request,{...names,state:'bound',delivery:receipt.status})
        return next.delivery === 'unknown' ? this.automatic(next, '接收回执待确认，正在核对原任务。', 'delivery') : next
      }catch(error){return this.automatic(await this.change(request,{state:'bound',delivery:'unknown',error:String(error)}), String(error), 'delivery')}
    }
    if(!request.execution)return this.change(request,{...names,state:'needs_input',decision,question:'已确定归属，请选择本次任务的 Agent、模型与权限。',error:undefined,failure:undefined})
    const execution = request.execution
    request=await this.change(request,{state:'committing',decision,delivery:'dispatching',error:undefined,failure:undefined})
    try {
      const target=await this.deps.newTask({...request,...routerBusinessInput(request)},decision,execution)
      const next = await this.change(request,{...names,state:'bound',targetId:target.id,targetTitle:target.taskMetadata?.title||target.title,delivery:target.taskRegistration?.delivery==='unknown'?'unknown':'accepted',projectName:object.kind==='space'?object.title:names.projectName,requirementName:decision.action==='create_requirement_and_task'?decision.requirementName:names.requirementName})
      return next.delivery === 'unknown' ? this.automatic(next, '任务接收结果暂时未知，正在核对原任务。', 'delivery') : next
    }catch(error){
      let target: Session | undefined
      try { target = await this.deps.recoverTask(request) }
      catch (failure) { return this.automatic(await this.change(request, { state: 'failed', delivery: 'unknown', error: String(failure) }), String(failure), 'delivery') }
      const next = await this.change(request,{state:target?'bound':'failed',delivery:target?'unknown':'failed',targetId:target?.id,targetTitle:target?.taskMetadata?.title||target?.title,error:String(error)})
      return target ? this.automatic(next, String(error), 'delivery') : this.routingFailed(next, error, this.transient(error))
    }
  }
  async resolve(resolution: RouterResolution): Promise<RouterRequest> {
    routerInputId(resolution.requestId)
    if (resolution.action === 'retry') return this.retry(resolution.requestId, resolution.expectedVersion, resolution.answer, resolution.attachments, resolution.sourceId)
    if (resolution.action === 'cancel') return this.cancel(resolution.requestId, resolution.expectedVersion)
    if (resolution.action === 'verify') return this.serial(resolution.requestId, async () => {
      const request = await this.store.request(resolution.requestId)
      if (!request || request.version !== resolution.expectedVersion || request.delivery !== 'unknown') throw new Error('router_revision_conflict')
      return this.checkDelivery({ ...request, autoRecovery: { attempts: 0, total: request.autoRecovery?.total || 0, phase: 'delivery', reason: '正在核对原任务' } })
    })
    if(resolution.execution?.managedPurpose||resolution.execution?.assistantSnapshot||resolution.execution?.roleSnapshot||resolution.execution?.initializationTargetAgentId)throw new Error('该任务模式请使用原新建入口')
    return this.serial(resolution.requestId,async()=>{
      let request=await this.store.request(resolution.requestId)
      if(!request||request.version!==resolution.expectedVersion||request.state!=='needs_input')throw new Error('router_revision_conflict')
      if(resolution.action==='answer'){
        let answer = resolution.answer
        if (resolution.optionId !== undefined) {
          const option = request.decision?.clarificationOptions?.find(row => row.objectId === resolution.optionId)
          if (!option) throw new Error('澄清候选已变化，请重新选择')
          answer = option.label
        }
        if(!answer?.trim()&&!resolution.attachments?.length)throw new Error('请填写补充信息')
        const addition = this.supplement(request,answer,resolution.attachments,resolution.sourceId)
        if (resolution.optionId && addition.supplements?.length) addition.supplements[addition.supplements.length - 1].optionId = resolution.optionId
        const { clarifications, context: _context, ...snapshot } = request
        const completed = { id: request.roundId || request.requestId + ':' + request.version, answeredAt: Date.now(), answer: answer?.trim() || '', ...(resolution.attachments?.length ? { attachments: resolution.attachments } : {}), snapshot }
        request=await this.change(request,{...addition,clarifications:[...clarifications || [],completed],roundId:undefined,roundStartedAt:undefined,state:'queued',question:undefined,error:undefined,decision:undefined,
          autoRecovery: { attempts: 0, total: request.autoRecovery?.total || 0, phase: 'routing', reason: '已补充信息，继续原请求' }})
        this.pump();return request
      }
      let decision=request.decision!
      if(resolution.action==='continue_original'){
        if(decision.action!=='reuse_task')throw new Error('invalid_router_resolution')
        request=await this.change(request,{execution:undefined,state:'routing',question:undefined})
      }else{
        if(!resolution.execution)throw new Error('请选择执行配置')
        if(decision.action==='reuse_task'){
          const target=this.deps.orchestrator.getSessionById(decision.taskId!)
          if(!target)throw new Error('目标任务已不存在')
          const scope=decision.scopeAssessment?.selectedScope || routerObjectScope(await this.store.object(target.id))
          const originalAssessment=decision.scopeAssessment, scanId=routerScanFor(request.context?.reading,scope)?.scanId
          decision=scope?.kind==='requirement'?{action:'create_task_in_requirement',requirementId:scope.requirementId,reason:'按用户本次确认的配置新建任务。'}:
            {action:'create_task_in_space',projectId:scope?.kind==='space'?scope.projectId:target.config.projectId,reason:'按用户本次确认的配置新建任务。'}
          decision={...decision,scanId,scopeAssessment:originalAssessment}
        }
        request=await this.change(request,{execution:resolution.execution,state:'routing',question:undefined})
      }
      try {
        const result = await this.assign(request,decision)
        await this.reviewStep(request.requestId, 'user_resolution', { resolution, result: this.receipt(result) }); return result
      } catch (error) {
        if ((error instanceof Error ? error.message : String(error)) === 'object_revision_changed') {
          const preference = resolution.action === 'continue_original' ? '用户已确认按原任务配置继续；重新读取资料并判断任务是否仍可复用。' : '用户已确认按本次执行配置新建任务；重新读取资料并确定归属。'
          request = await this.change(request, { state: 'queued', context: undefined, decision: undefined, targetId: undefined, targetTitle: undefined,
            targetVersion: undefined, error: undefined, resolution: [request.resolution, preference].filter(Boolean).join('\n') })
          await this.reviewStep(request.requestId, 'user_resolution', { resolution, reread: true, error: String(error) })
          this.pump(); return request
        }
        await this.change(request, { state: 'needs_input', question: String(error), error: String(error) })
        throw error
      }
    })
  }
  async cancel(id: string,expectedVersion: number): Promise<RouterRequest> {
    return this.serial(id,async()=>{
      const request=await this.store.request(id)
      const routing = !!request?.feishu && request.state === 'routing' && this.active === id
      if(!request||request.version!==expectedVersion||!routing&&!['queued','needs_input','failed'].includes(request.state))throw new Error('当前输入已开始分配，不能取消')
      const next = await this.change(request,{state:'cancelled',autoRecovery:request.autoRecovery&&{...request.autoRecovery,nextAt:undefined}})
      if (routing && this.session) this.deps.orchestrator.interrupt(this.session)
      this.pump()
      return next
    })
  }
  async retry(id: string, expectedVersion: number, answer?: string, attachments?: Attachment[], sourceId?: string): Promise<RouterRequest> {
    return this.serial(id, async () => {
      const request = await this.store.request(id), config = routerConfig(this.deps.config())
      if (!config.enabled || !resolveRouterConfig(config, this.deps.agents()).available) throw new Error('RouterAgent 当前不可用')
      if (!request || request.version !== expectedVersion || !canRetryRouterRequest(request)) throw new Error('投递结果待确认，不能重新路由')
      const next = await this.change(request, { ...this.supplement(request,answer,attachments,sourceId), state: 'queued', delivery: 'pending', decision: undefined, question: undefined, error: undefined, failure: undefined,
        autoRecovery: { attempts: 0, total: request.autoRecovery?.total || 0, phase: 'routing', reason: '正在重试原请求' } })
      this.pump()
      return next
    })
  }
  async interrupt():Promise<void>{
    const id=this.active
    if(!id||!this.session)return
    await this.serial(id,async()=>{
      const request=await this.store.request(id)
      if(request?.state==='committing')throw new Error('任务分配正在提交，请等待实际回执')
      if(request?.state==='routing'||request?.state==='queued')await this.change(request,{state:'cancelled',autoRecovery:request.autoRecovery&&{...request.autoRecovery,nextAt:undefined}})
      if(this.active===id&&this.session)this.deps.orchestrator.interrupt(this.session)
    })
  }
  recover(): Promise<void> {
    return this.recovering ||= (async()=>{
      this.restoreComplete = false
      this.session=await this.store.sessionId()
      await this.bridge.bind(this.session)
      for(const session of this.deps.orchestrator.managedSessions())this.trackSession(session)
      for(const request of await this.store.pending()){
        if(request.state==='needs_input'&&request.decision?.action==='reuse_task'&&request.question==='本次执行配置与原任务不同。按原任务配置继续，还是按本次配置新建？'){
          await this.change(request,{state:'queued',context:undefined,decision:undefined,targetId:undefined,targetTitle:undefined,targetVersion:undefined,question:undefined,error:undefined,
            resolution:[request.resolution,'复用已有任务时默认按原任务配置继续；重新读取资料并判断任务是否仍可复用。'].filter(Boolean).join('\n')})
        }
        if(request.state==='routing')await this.routingFailed(request,'上次分配已中断。',true)
        if(request.state==='committing'){
          const target=request.targetId?this.deps.orchestrator.getSessionById(request.targetId):await this.deps.recoverTask(request)
          const next = await this.change(request,{state:target?'bound':'failed',targetId:target?.id,delivery:'unknown',error:'上次投递结果待确认，未自动重发。'})
          await this.checkDelivery(next)
        }
        if(request.delivery==='unknown'&&!request.autoRecovery?.nextAt)await this.checkDelivery(request)
      }
      await this.store.reviewRecover()
      this.restoreComplete = true
      this.pump()
    })()
  }
  trackSession(session:Session):void{
    if(!session.config.managedPurpose&&(session.config.projectId&&this.deps.projectMemory||this.deps.runtimeContext))void this.prepareProjectMemory(session).catch(this.deps.error)
  }
  async prepareProjectMemory(session: Session): Promise<void> {
    const project = !!session.config.projectId&&!!this.deps.projectMemory
    if (!session.config.managedPurpose && (project || this.deps.runtimeContext)) await this.bridge.bindMemory(session.id,true,{project})
  }
  async projectContext(sessionId:string,config:SessionConfig):Promise<string>{
    if(config.managedPurpose)return ''
    const session=this.deps.orchestrator.getSessionById(sessionId)
    if(session)await this.prepareProjectMemory(session)
    const agent=this.deps.agents().find(agent=>agent.id===config.agentId),adapter=agent?.adapter||config.agentId
    const mcp=['codex','traex','claude','qoder'].includes(adapter)||['acp','zcode-protocol'].includes(agent?.capabilities.protocol||'')||adapter==='deepseek'
    const guide=config.projectId&&this.deps.projectMemory?(mcp?PROJECT_MEMORY_GUIDE:projectMemoryCliGuide(sessionId)):''
    return [guide, !mcp ? runtimeContextCliGuide(sessionId) : ''].filter(Boolean).join('\n\n')
  }
  async close(): Promise<void> {
    this.closed=true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.sourceRefreshTimer) clearTimeout(this.sourceRefreshTimer)
    await this.routingViews?.close()
    await this.summaries?.close()
    await this.refreshing?.catch(() => {})
    await this.pumping?.catch(()=>{})
    await this.switching?.catch(()=>{})
    await this.bridge.close()
    await Promise.allSettled(this.mutations.values())
    await this.store.close()
  }
}
