import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AgentDef, Attachment, SessionAgentContract, SessionConfig, TurnUsage, UAEvent } from '../shared/types.ts'
import type { GoalState, NativeGoalUpdate } from '../shared/nativeCapabilities.ts'
import { assistantPrompt } from './assistant/context'
import { requirementInstructions } from './requirementRuntime'
import { worktreeInstructions } from './worktreeService'
import { projectACPTool } from './acp/acpEventProjection.ts'
import { assertKimiWebConfig } from './kimiRoleConfig.ts'
import { kimiWebContract } from './kimiWebContract.ts'
import { KimiWebRuntime, profileFromConfig, projectKimiWebGoal, type KimiWebGoal } from './kimiWebRuntime.ts'
import { KimiWebError, type KimiWebFrame, type KimiWebSnapshot } from './kimiWebTransport.ts'
import { buildKimiWebContent, kimiWebQuestionAnswers, kimiWebQuestionParams, kimiWebTranscriptEvents, projectKimiWebUsage } from './kimiWebEventProjection.ts'

type Event = Pick<UAEvent, 'type' | 'state' | 'payload'>
type Segment = { id: string; kind: 'agent_message' | 'reasoning'; text: string; step: number }
const unsupported = (): Error => new Error('Kimi Web 2.2.0 尚未开放此能力。')
// Wire events use numeric clock IDs; Transcript addresses the same turn as t<N>.
const transcriptTurnId = (id: string | number): string => typeof id === 'number' ? `t${id}` : id

/** Native REST/WS execution. No ACP connection, role-home copy or private RPC. */
export class KimiWebRunner extends EventEmitter {
  private runtime?: KimiWebRuntime
  private ready?: Promise<void>
  private closing?: Promise<void>
  private disposed = false
  private running = false
  private cancelling = false
  private nativeSessionId?: string
  private contract?: SessionAgentContract
  private config: SessionConfig
  private turnId?: number | string
  private step = 0
  private segments: Segment[] = []
  private tools = new Map<string, any>()
  private stepUsage = new Map<number, TurnUsage>()
  private baseline = new Set<string>()
  private transcriptEpoch?: string
  private initializedHistory = false
  private pending = new Map<string, { kind: 'approval' | 'question'; row: any }>()
  private goal?: GoalState
  private completeTurn?: () => void
  private poll?: ReturnType<typeof setTimeout>
  private readonly instance = randomUUID()

  constructor(private readonly sessionId: string, private readonly seqRef: { n: number }, private readonly agent: AgentDef, config: SessionConfig, resumeSessionId?: string, private readonly extraEnv: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = {}) {
    super(); this.config = { ...config }; this.nativeSessionId = resumeSessionId
  }
  isRunning(): boolean { return this.running }
  supportsCommand(name: string): boolean { return this.contract?.commands.includes(name.replace(/^\//, '')) === true }
  private event(event: Event): void { if (!this.disposed) this.emit('event', { ...event, sessionId: this.sessionId, seq: this.seqRef.n++, ts: Date.now() }) }
  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new KimiWebError('runner_closed'))
    if (this.runtime) return Promise.resolve()
    if (this.ready) return this.ready
    const ready = (async () => {
      await this.closing
      assertKimiWebConfig(this.config)
      const runtime = await KimiWebRuntime.start({ bin: this.agent.bin, sessionId: this.sessionId, config: this.config, nativeSessionId: this.nativeSessionId,
        env: typeof this.extraEnv === 'function' ? this.extraEnv() : this.extraEnv, acquireWritableRuntime: async () => () => {} })
      if (this.disposed) { await runtime.closeAndWait(); throw new KimiWebError('runner_closed') }
      this.runtime = runtime; this.nativeSessionId = runtime.nativeSessionId
      this.emit('nativeSession', { nativeSessionId: this.nativeSessionId, kimiDataHome: runtime.dataHome })
      await this.refreshContract()
      const transcript = await runtime.transcript()
      if (!this.initializedHistory) {
        this.baseline = new Set(transcript.items.filter(row => row.kind === 'turn' && row.state !== 'running' && row.state !== 'queued').map(row => String(row.turnId)))
        this.initializedHistory = true
      }
      const snapshot = await runtime.snapshot()
      await runtime.subscribe({ onEvent: frame => this.onFrame(frame), onSnapshot: value => this.recover(value),
        onError: error => { this.event({ type: 'system_notice', payload: { id: 'kimi-connection', message: `Kimi 连接正在恢复：${error.message}` } }); this.scheduleRecovery() }
      }, { seq: snapshot.as_of_seq, epoch: snapshot.epoch })
      this.acceptGoal(await runtime.getGoal())
      if (snapshot.in_flight_turn || this.running) await this.recover(snapshot)
    })().catch(async error => {
      const runtime = this.runtime; this.runtime = undefined
      await runtime?.closeAndWait()
      throw error
    }).finally(() => { if (this.ready === ready) this.ready = undefined })
    this.ready = ready; return ready
  }
  private async refreshContract(): Promise<void> {
    const [models, status] = await Promise.all([this.runtime!.models(), this.runtime!.status()])
    this.contract = kimiWebContract(models.items, status, this.config)
    this.emit('contract', structuredClone(this.contract))
  }
  async startTurn(prompt: string, attachments?: Attachment[]): Promise<void> {
    if (this.disposed || this.running) throw new KimiWebError('runner_busy')
    this.running = true; this.cancelling = false; this.turnId = undefined; this.step = 0; this.segments = []; this.tools.clear(); this.stepUsage.clear()
    const done = new Promise<void>(resolve => { this.completeTurn = resolve })
    try {
      await this.ensureReady()
      if (this.disposed) return
      if (this.cancelling) {
        if ((await this.runtime!.status()).busy) {
          await this.runtime!.abortSession(); this.scheduleRecovery(); await done
        } else this.finish('cancelled')
        return
      }
      if (prompt.trimStart().startsWith('/')) {
        if (attachments?.length) throw new KimiWebError('slash_attachments_unsupported')
        if (/^\/compact(?:\s|$)/.test(prompt)) {
          await this.runtime!.compact(prompt.replace(/^\/compact\s*/, '')); this.finish('success'); return
        }
        const result = await this.runtime!.submitSlash(prompt, this.contract?.commands)
        if (result.kind === 'notice') { this.event({ type: 'system_notice', payload: { message: result.text } }); this.finish('success'); return }
      } else {
        const text = await assistantPrompt(this.sessionId, this.config, prompt, [worktreeInstructions(this.config), requirementInstructions(this.config)].filter(Boolean).join('\n\n'))
        const content = await buildKimiWebContent(text, attachments)
        if (this.disposed) return
        if (this.cancelling) { this.finish('cancelled'); return }
        if (content.some(part => part.type === 'image') && !this.contract?.imageAttachments) throw new KimiWebError('image_input_unsupported')
        await this.runtime!.submitContent(content, randomUUID())
      }
      this.scheduleRecovery()
      await done
    } catch (error) {
      this.event({ type: 'error', state: 'failed', payload: { message: error instanceof KimiWebError && error.recovered ? 'Kimi 本地服务已恢复；本次请求结果待确认，未自动重发。' : error instanceof Error ? error.message : 'Kimi Web 请求失败；未自动重发。' } })
      this.finish('failed')
    }
  }
  private scheduleRecovery(): void {
    if (this.poll || !this.running || this.disposed) return
    this.poll = setTimeout(() => {
      this.poll = undefined
      void (this.runtime ? this.runtime.snapshot().then(snapshot => this.recover(snapshot)) : this.ensureReady()).catch(async () => {
        this.event({ type: 'system_notice', payload: { id: 'kimi-connection', message: 'Kimi 服务暂不可达，任务结果待确认；不会自动重发输入。' } })
        const runtime = this.runtime; this.runtime = undefined
        await runtime?.closeAndWait()
        await this.ensureReady()
        if (runtime?.serviceReplaced) {
          this.event({ type: 'system_notice', payload: { id: 'kimi-connection', message: 'Kimi 本地服务已恢复，已按原会话重新连接；未重发输入。' } })
          await this.verifyRecoveredTurn()
        }
      }).catch(error => {
        if (error instanceof KimiWebError && ['recovery_limit', 'recovery_failed', 'shutdown_incomplete'].includes(error.kind)) {
          this.event({ type: 'error', state: 'failed', payload: { message: `${error.message}：本地服务自动恢复已停止，会话已保留，未重发任务。` } })
          this.finish('failed')
        }
      }).finally(() => this.scheduleRecovery())
    }, 3000)
    this.poll.unref()
  }
  private async verifyRecoveredTurn(): Promise<void> {
    const runtime = this.runtime, turnId = this.turnId
    if (!runtime || !this.running || !turnId) return
    const [status, prompts, transcript] = await Promise.all([runtime.status(), runtime.prompts(), runtime.transcript()])
    if (runtime !== this.runtime || !this.running || this.turnId !== turnId || status.busy || prompts.active || prompts.queued.length) return
    const turn = transcript.items.find(row => row.kind === 'turn' && transcriptTurnId(row.turnId) === turnId)
    if (turn && !['running', 'queued'].includes(turn.state)) return
    this.event({ type: 'error', state: 'failed', payload: { code: 'recovery_turn_unconfirmed', message: 'Kimi 服务已恢复，但原回合结果无法确认；已有记录已保留，未重发任务，请核对后继续。' } })
    this.finish('failed')
  }
  private begin(turnId: string | number): void {
    turnId = transcriptTurnId(turnId)
    if (this.turnId === turnId) return
    this.turnId = turnId; this.step = 0; this.segments = []; this.tools.clear(); this.stepUsage.clear(); this.running = true
    this.emit('goalTurn', { state: 'running', autonomous: this.goal?.autonomous === true })
    this.event({ type: 'turn_started', payload: { id: `kimi-turn-${turnId}`, nativeTurnId: turnId, threadId: this.nativeSessionId } })
  }
  private text(kind: Segment['kind'], text: string, replace = false): void {
    let segment = this.segments.at(-1)
    if (!segment || segment.kind !== kind || segment.step !== this.step) {
      // 快照重放（replace）时，服务端 in-flight 文本可能滞后于步骤推进或夹在思
      // 考段之后；按内容归并到既有同 kind 段，避免同一文本被重复成新事件。
      const reused = replace
        ? [...this.segments].reverse().find(item => item.kind === kind && item.step === this.step)
          ?? [...this.segments].reverse().find(item => item.kind === kind && item.text !== '' && text.startsWith(item.text))
        : undefined
      segment = reused ?? { id: `kimi-${this.instance}-${this.turnId}-${this.segments.length}`, kind, step: this.step, text: '' }
      if (!reused) this.segments.push(segment)
    }
    segment.text = replace ? text : segment.text + text
    this.event({ type: kind, state: 'running', payload: { id: segment.id, text: segment.text } })
  }
  private tool(update: any): void {
    const current = { ...this.tools.get(update.toolCallId), ...update }
    this.tools.set(update.toolCallId, current)
    const event = projectACPTool(current, 'kimi')
    if (event) this.event(event)
  }
  private register(kind: 'approval' | 'question', row: any): void {
    const nativeId = kind === 'approval' ? row.approval_id : row.question_id
    if (!nativeId) return
    const requestId = `kimi-web-${kind}-${nativeId}`
    if (this.pending.has(requestId)) return
    this.pending.set(requestId, { kind, row })
    const display = row.display || row.tool_input_display
    if (kind === 'question') this.event({ type: 'approval_request', state: 'pending', payload: { id: requestId, requestId, kind: 'question', method: 'kimi/web/question', params: kimiWebQuestionParams(row) } })
    else if (display?.kind === 'plan_review') {
      // ExitPlanMode 计划审批映射为统一的计划决策按钮（实施/反馈修改/跳过），决策经原生 resolveApproval 契约回传
      this.event({ type: 'agent_message', state: 'success', payload: { id: `kimi-plan-${nativeId}`, kind: 'plan', text: display.plan } })
      this.event({ type: 'approval_request', state: 'pending', payload: { id: requestId, requestId, kind: 'planMode', method: 'kimi/web/approval', params: { plan: display.plan } } })
    } else {
      this.event({ type: 'approval_request', state: 'pending', payload: { id: requestId, requestId, kind: 'permission', method: 'session/request_permission', params: { toolCallId: row.tool_call_id, title: row.tool_name, rawInput: display, action: row.action }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: '允许一次' }, { optionId: 'allow_always', kind: 'allow_always', name: '本会话允许' }, { optionId: 'reject_once', kind: 'reject_once', name: '拒绝' }] } })
    }
  }
  async respondResult(id: string, answer: any): Promise<{ handled: boolean; hasPendingRequests: boolean }> {
    const pending = this.pending.get(id), runtime = this.runtime
    if (!pending || !runtime) return { handled: false, hasPendingRequests: this.pending.size > 0 }
    if (pending.kind === 'question') {
      const answers = kimiWebQuestionAnswers(pending.row, answer)
      if (!answers) return { handled: false, hasPendingRequests: true }
      await runtime.answerQuestion(pending.row.question_id, answers)
    } else {
      const decision = answer?.decision
      const option = answer?.outcome?.optionId
      const feedback = typeof answer?.feedback === 'string' && answer.feedback.trim() ? answer.feedback.trim() : undefined
      // 带反馈的 rejected 即原生修订通道（Agent 留在计划模式按反馈修改）；cancelled 仅关闭审批
      await runtime.resolveApproval(pending.row.approval_id, typeof decision === 'string' && decision ? {
        decision: decision === 'approved' || decision === 'accept' ? 'approved' : decision === 'cancelled' || decision === 'cancel' ? 'cancelled' : 'rejected',
        ...(feedback ? { feedback } : {})
      } : {
        decision: ['allow_once', 'allow_always'].includes(option) ? 'approved' : 'rejected',
        ...(option === 'allow_always' ? { scope: 'session' as const } : {})
      })
    }
    this.resolveInteraction(id)
    return { handled: true, hasPendingRequests: this.pending.size > 0 }
  }
  private resolveInteraction(requestId: string): void {
    if (!this.pending.delete(requestId)) return
    this.event({ type: 'approval_request', state: 'success', payload: { requestId, resolved: true } })
  }
  private async onFrame(frame: KimiWebFrame): Promise<void> {
    if (this.disposed) return
    const value = frame.payload || {}, type = frame.type
    if (type === 'interaction') {
      const interaction = frame as any
      if (!['approval', 'question'].includes(interaction.kind) || typeof interaction.interaction_id !== 'string' || !interaction.interaction_id) return
      const kind = interaction.kind as 'approval' | 'question'
      if (interaction.status === 'pending' && interaction.request && typeof interaction.request === 'object') {
        this.register(kind, { ...interaction.request, [`${kind}_id`]: interaction.interaction_id, tool_call_id: interaction.tool_call_id })
      } else if (interaction.status === 'ended') this.resolveInteraction(`kimi-web-${kind}-${interaction.interaction_id}`)
      return
    }
    if (type === 'goal.updated') { this.acceptGoal(value.snapshot); return }
    if (type === 'event.approval.requested') { this.register('approval', value); return }
    if (type === 'event.question.requested') { this.register('question', value); return }
    if (['event.approval.resolved', 'event.question.answered', 'event.question.dismissed'].includes(type)) {
      this.resolveInteraction(`kimi-web-${value.approval_id ? 'approval' : 'question'}-${value.approval_id || value.question_id}`); return
    }
    if (type.startsWith('subagent.')) {
      for (const task of await this.runtime!.listSubagentTasks()) this.event({ type: 'subagent', state: task.status === 'running' ? 'running' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'success', payload: { id: `kimi-subagent-${task.id}`, agents: [{ agentThreadId: task.agent_id, parentThreadId: this.nativeSessionId, nativeTaskId: task.id, description: task.description, status: task.status === 'running' ? 'running' : task.status === 'failed' ? 'errored' : task.status === 'cancelled' ? 'interrupted' : 'completed' }] } })
      return
    }
    if (value.agentId && value.agentId !== 'main') return
    if (type === 'agent.status.updated' && typeof value.planMode === 'boolean') { this.config.collaborationMode = value.planMode ? 'plan' : 'default'; this.emit('collaborationModeChanged', this.config.collaborationMode) }
    if (type === 'turn.started') { this.begin(value.turnId); return }
    if (value.turnId !== undefined && this.turnId !== undefined && transcriptTurnId(value.turnId) !== this.turnId) return
    if (type === 'turn.step.started') { this.step = value.step ?? this.step + 1; return }
    if (type === 'assistant.delta' || type === 'thinking.delta') { this.text(type === 'assistant.delta' ? 'agent_message' : 'reasoning', value.delta || ''); return }
    if (type === 'tool.call.started') {
      const display = value.display
      this.tool({ toolCallId: value.toolCallId, title: value.name, rawInput: value.args,
        kind: value.name === 'Bash' ? 'execute' : ['Write', 'Edit'].includes(value.name) ? 'edit' : 'other',
        ...(display?.kind === 'diff' || display?.kind === 'file_io' ? { content: [{ type: 'diff', path: display.path, oldText: display.before, newText: display.after ?? display.content }] } : {}), status: 'in_progress' }); return
    }
    if (type === 'tool.result') { this.tool({ toolCallId: value.toolCallId, rawOutput: value.output, status: value.isError ? 'failed' : 'completed' }); return }
    if (type === 'turn.step.completed') {
      if (this.turnId !== undefined && Number.isSafeInteger(value.step) && value.step >= 0) this.event({ type: 'system_notice', payload: { id: `kimi-speed-${this.turnId}-${value.step}`, kind: 'token_speed',
        speed: { outputTokens: value.usage?.output, durationMs: value.llmStreamDurationMs, metric: 'generation',
          source: 'Kimi 原生流式计时', model: this.contract?.currentModelId } } })
      const usage = projectKimiWebUsage(value.usage)
      if (usage) {
        this.stepUsage.set(value.step, usage)
        this.event({ type: 'system_notice', payload: { id: `kimi-context-${this.turnId}`, kind: 'context', usage: { contextTokens: usage.inputTokens, contextWindow: this.contract?.models.find(model => model.id === this.contract?.currentModelId)?.contextWindow } } })
      }
    }
    if (type === 'turn.ended') { await this.recover(await this.runtime!.snapshot()); return }
    if (type.startsWith('compaction.')) this.event({ type: 'context_compaction', state: type === 'compaction.started' ? 'running' : type === 'compaction.completed' ? 'success' : 'failed', payload: { id: `kimi-compaction-${value.compactionId || value.turnId}`, ...value } })
    if (type === 'error') this.event({ type: 'error', state: 'failed', payload: { message: 'Kimi 原生模型请求失败', code: value.code } })
  }
  private async recover(snapshot: KimiWebSnapshot): Promise<void> {
    const runtime = this.runtime
    if (!runtime || this.disposed) return
    const epochChanged = this.transcriptEpoch !== undefined && this.transcriptEpoch !== snapshot.epoch
    const transcript = await runtime.transcript(epochChanged ? undefined : this.baseline)
    if (runtime !== this.runtime || this.disposed) return
    this.transcriptEpoch = snapshot.epoch
    for (const turn of transcript.items) {
      if (turn.kind !== 'turn' || this.baseline.has(String(turn.turnId))) continue
      this.begin(turn.turnId)
      const aliases = [...this.segments]
      for (const event of kimiWebTranscriptEvents([turn])) {
        if (['user_message', 'turn_started', 'turn_completed'].includes(event.type)) continue
        if (event.type === 'agent_message' || event.type === 'reasoning') {
          const index = aliases.findIndex(segment => segment.kind === event.type)
          if (index >= 0) event.payload = { ...event.payload, id: aliases.splice(index, 1)[0].id }
        }
        this.event(event)
      }
      if (turn.state !== 'running' && turn.state !== 'queued') {
        this.baseline.add(String(turn.turnId))
        this.acceptGoal(await runtime.getGoal())
        this.finish(turn.state === 'cancelled' ? 'cancelled' : turn.state === 'failed' ? 'failed' : 'success')
      }
    }
    const live = snapshot.in_flight_turn as any
    if (live && !this.baseline.has(transcriptTurnId(live.turn_id))) {
      this.begin(live.turn_id)
      if (live.thinking_text) this.text('reasoning', live.thinking_text, true)
      if (live.assistant_text) this.text('agent_message', live.assistant_text, true)
    }
    const ids = new Set<string>()
    for (const [kind, rows] of [['approval', snapshot.pending_approvals], ['question', snapshot.pending_questions]] as const) for (const row of (rows as any[]) || []) {
      ids.add(`kimi-web-${kind}-${kind === 'approval' ? row.approval_id : row.question_id}`); this.register(kind, row)
    }
    for (const id of this.pending.keys()) if (!ids.has(id)) this.resolveInteraction(id)
  }
  private finish(state: 'success' | 'failed' | 'cancelled'): void {
    if (!this.running) return
    this.running = false
    if (this.poll) clearTimeout(this.poll)
    this.poll = undefined
    if (this.stepUsage.size) {
      const steps = [...this.stepUsage.entries()].sort(([a], [b]) => a - b).map(([, usage]) => usage), last = steps.at(-1)!
      const total = steps.reduce((sum, usage) => ({ inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, cachedInputTokens: sum.cachedInputTokens + (usage.cachedInputTokens || 0) }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })
      this.event({ type: 'system_notice', payload: { id: `kimi-usage-${this.turnId}`, kind: 'usage', usage: { ...total, contextTokens: last.inputTokens, contextWindow: this.contract?.models.find(model => model.id === this.contract?.currentModelId)?.contextWindow } } })
    }
    this.event({ type: 'turn_completed', state, payload: { id: `kimi-turn-${this.turnId ?? this.instance}`, turnId: this.turnId } })
    this.completeTurn?.(); this.completeTurn = undefined
    this.emit('done', { nativeSessionId: this.nativeSessionId, interrupted: state === 'cancelled', failed: state === 'failed' })
  }
  interrupt(): void {
    this.cancelling = true
    if (this.runtime) void this.runtime.abortSession().then(() => this.runtime!.snapshot()).then(snapshot => this.recover(snapshot)).catch(() => this.scheduleRecovery())
  }
  async updateConfig(config: SessionConfig): Promise<{ config: SessionConfig; contract?: SessionAgentContract }> {
    assertKimiWebConfig(config)
    if (this.running) throw new KimiWebError('config_busy')
    if (this.runtime && config.workdir !== this.config.workdir) throw new KimiWebError('workdir_immutable')
    if (this.runtime && config.kimiDataHome && config.kimiDataHome !== this.runtime.dataHome) throw new KimiWebError('storage_home_immutable')
    if (this.runtime) {
      try { await this.runtime.setProfile(profileFromConfig(config)) }
      catch (error) {
        try { await this.runtime.setProfile(profileFromConfig(this.config)) }
        catch { const runtime = this.runtime; this.runtime = undefined; this.closing = runtime.closeAndWait(); await this.closing }
        throw error
      }
    }
    this.config = { ...config }
    if (this.runtime) await this.refreshContract()
    this.emit('configChanged', this.config)
    return { config: { ...this.config }, contract: this.contract && structuredClone(this.contract) }
  }
  restoreConfigAfterFailedCommit(config: SessionConfig, contract?: SessionAgentContract): void {
    this.config = { ...config }; this.contract = contract
    const runtime = this.runtime; this.runtime = undefined; this.closing = runtime?.closeAndWait()
  }
  async setCollaborationMode(mode: 'default' | 'plan'): Promise<void> { await this.ensureReady(); await this.updateConfig({ ...this.config, collaborationMode: mode }) }
  async steer(prompt: string, attachments?: Attachment[]): Promise<{ appendedToTurn: boolean; nativePromptId: string }> {
    if (!this.runtime || !this.running) throw new KimiWebError('no_active_turn')
    const result = await this.runtime.steerContent(await buildKimiWebContent(prompt, attachments))
    return { appendedToTurn: result.steered, nativePromptId: result.prompt_id }
  }
  private acceptGoal(goal: KimiWebGoal | null): void {
    // The host emits a confirmed terminal snapshot and then clears its current
    // endpoint. Preserve that result until an explicit user clear/new goal.
    if (!goal && this.goal?.status === 'complete') return
    const wasAutonomous = this.goal?.autonomous === true
    this.goal = projectKimiWebGoal(goal, { createdAt: this.goal?.createdAt || Date.now(), updatedAt: Date.now() })
    this.emit('goalChanged', this.goal)
    if (this.goal?.autonomous) this.emit('goalTurn', { state: 'running', autonomous: true })
    else if (!this.running && wasAutonomous) this.emit('done', { nativeSessionId: this.nativeSessionId })
  }
  async getGoal(): Promise<GoalState | undefined> { await this.ensureReady(); this.acceptGoal(await this.runtime!.getGoal()); return this.goal }
  async setGoal(input: { objective: string; tokenBudget?: number; maxRounds?: number }): Promise<GoalState> {
    if (input.tokenBudget !== undefined || input.maxRounds !== undefined) throw new KimiWebError('goal_budget_unsupported')
    await this.ensureReady(); this.acceptGoal(await this.runtime!.createGoal(input))
    if (!this.goal) throw new KimiWebError('goal_not_created')
    void this.startTurn(input.objective)
    return this.goal
  }
  async updateGoal(input: NativeGoalUpdate): Promise<GoalState | undefined> {
    if (input.tokenBudget !== undefined || input.maxRounds !== undefined || input.objective !== undefined) throw unsupported()
    const action = input.action === 'clear' ? 'cancel' : input.action === 'disarm' ? 'pause' : input.action
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') throw unsupported()
    await this.ensureReady()
    const goal = await this.runtime!.controlGoal(action)
    if (action === 'cancel') this.goal = undefined
    this.acceptGoal(goal); return this.goal
  }
  async getSubAgentItems(id: string, trusted?: { nativeTaskId: string; parentNativeSessionId: string }): Promise<UAEvent[]> {
    await this.ensureReady()
    const events = await this.runtime!.getSubagentTranscript(id, trusted)
    // Detail events share the UAEvent shape the detail stream depends on:
    // stable per-read sequence, owning session and a timestamp for elapsed rows.
    return events.map((event, seq) => ({ sessionId: this.sessionId, seq, ...event, ts: event.ts ?? Date.now() }))
  }
  async cancelSubAgent(id: string): Promise<void> { await this.ensureReady(); await this.runtime!.cancelSubagentTask(id) }
  async queryUsage(): Promise<TurnUsage | undefined> {
    await this.ensureReady(); const value = (await this.runtime!.snapshot()).session as any
    return value?.usage ? { inputTokens: (value.usage.input_tokens || 0) + (value.usage.cache_read_tokens || 0) + (value.usage.cache_creation_tokens || 0), outputTokens: value.usage.output_tokens || 0, cachedInputTokens: value.usage.cache_read_tokens || 0 } : undefined
  }
  async inventory(): Promise<unknown> { throw unsupported() }
  async pluginAction(_input: Record<string, unknown>): Promise<any> { throw unsupported() }
  async readNativeImage(_input: unknown): Promise<string | null> { throw unsupported() }
  dispose(): void {
    this.disposed = true; this.completeTurn?.(); this.completeTurn = undefined
    if (this.poll) clearTimeout(this.poll)
    const runtime = this.runtime; this.runtime = undefined; this.closing = runtime?.closeAndWait()
    void this.closing?.catch(() => {})
  }
  async disposeAndWait(): Promise<void> { this.dispose(); await this.ready?.catch(() => {}); await this.closing }
}
