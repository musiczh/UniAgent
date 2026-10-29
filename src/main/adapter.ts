import { prepareClaudeSourceRuntime, type ClaudeSourceRuntime } from './claudeSourceRuntime'
import { assistantMcpEnv } from './assistant/mcp'
import { assistantIdentity } from '../shared/assistant'
import { assistantPrompt } from './assistant/context'
import { requirementInstructions } from './requirementRuntime'
import { worktreeInstructions } from './worktreeService'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { computeCost } from './pricing'
import { nativeCredentialEnv } from './agentSetupCredentials.ts'
import { handoffMcpArgs, uniAgentSessionInstructions } from './handoff'
import { teamRuntime } from './teamRuntime'
import { traexMaxConfigFlags } from './maxMode'
import { normalizeClaudeRateLimits } from './claudeRateLimits'
import { claudeFileChange } from './claudeFileChanges'
import { claudeRoleUnavailableReason, supportsClaudeRoleProtocol } from './claudeRoleConfig'
import { filesFromTurnChanges } from './turnFileChanges'
import type {
  AgentDef,
  Attachment,
  ClaudeForkOrigin,
  PermissionMode,
  ReasoningEffort,
  SessionConfig,
  UAEvent,
  UASubAgent
} from '../shared/types'
import { isHiddenAgentWarning } from '../shared/agentWarnings'
import { startTokenSpeedTelemetry, type TokenSpeedTelemetry } from './tokenSpeedTelemetry'
import { ClaudeSdkClient, claudeSdkLaunch } from './claudeSdk'
import { updateClaudeTaskPlan } from './claudeTaskPlan'
import type { GoalState } from '../shared/nativeCapabilities'

/**
 * Streams Unified Agent Events; Claude keeps one SDK Query across turns.
 * Emits 'event' (UAEvent) and 'done' ({ nativeSessionId? }).
 */
export class TurnRunner extends EventEmitter {
  private sdk?: ClaudeSdkClient
  private sdkKey?: string
  private sdkActive = false
  private sdkSerial = 0
  private sdkIdleTimer?: ReturnType<typeof setTimeout>
  private sdkTelemetry?: TokenSpeedTelemetry
  private sdkLastCost?: number
  private sdkGoal?: GoalState
  private sdkGoalClear = false
  private sdkGoalTurn = false
  private sdkPendingMessages = new Set<string>()
  private sdkDisposing?: Promise<void>
  private sdkStopping?: Promise<void>
  private sdkTasks = new Map<string, { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>()
  private child: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private seqRef: { n: number }
  private nativeSessionId?: string
  private forkSourceId?: string
  // Set when the user interrupts, so the terminal 'done' is flagged as a hard
  // stop and the orchestrator won't auto-drain the queue (G2-9).
  private interrupted = false

  // ---- Claude SDK token-level streaming ----
  // SDK partial messages emit per-token
  // `content_block_delta` events. We accumulate them per content block and
  // coalesce into ~1 UI update per frame, mirroring AppServerRunner, so replies
  // grow in place instead of arriving in one shot.
  private claudePartial = false
  private claudeMsgId = ''
  // Streamed text block ids of the current message, consumed in order by the
  // completed assistant text blocks (the CLI may split them one per message).
  private claudeTextIds: string[] = []
  private claudeReplyOrdinal = 0
  private claudeFinalCandidate?: { id: string; text: string }
  private claudeTools = new Map<string, { name: string; input: any }>()
  private claudeRequests = new Map<string, { wireId: string; toolName: string; input: any; suggestions?: any[]; kind?: string }>()
  private claudeCompact = false
  private claudeCompactDone = false
  private claudeWorkdir = ''
  private claudeFileEvents: UAEvent[] = []
  private assistantConfig?: SessionConfig
  private preparingAssistant = false
  private claudeSourceRuntime?: ClaudeSourceRuntime
  private claudeResultFailed = false
  private claudeRole?: SessionConfig['roleSnapshot']
  private claudeBuiltinCommands = new Set<string>()
  private claudeSubagents = new Map<string, UASubAgent>()
  private claudeTaskRuns = new Map<string, string>()
  private claudeChildTools = new Map<string, string>()
  private claudeChildRunners = new Map<string, TurnRunner>()
  private claudeChildEvents = new Map<string, UAEvent[]>()
  private textBuf = new Map<string, string>()
  private itemType = new Map<string, 'agent' | 'reasoning'>()
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly FLUSH_MS = 50
  // Model id for this turn (Doc5 T1) — used to price the usage footer.
  private modelId?: string
  // Latest main-thread Claude API call; its input is the real context occupancy.
  private claudeLastCall?: { usage: any; model?: string }

  constructor(
    private sessionId: string,
    seqRef: { n: number }
  ) {
    super()
    this.seqRef = seqRef
  }

  private emitEvent(e: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'>): void {
    const ev: UAEvent = {
      sessionId: this.sessionId,
      seq: this.seqRef.n++,
      ts: Date.now(),
      ...e
    }
    if (ev.type === 'file_change') this.claudeFileEvents.push(ev)
    this.emit('event', ev)
  }

  interrupt(): void {
    if (this.sdk || this.sdkActive) {
      void this.stopClaudeSdk()
      return
    }
    if (this.preparingAssistant) {
      this.interrupted = true
      this.preparingAssistant = false
      this.emit('done', { interrupted: true })
      return
    }
    if (this.child) {
      this.interrupted = true
      try {
        this.child.kill('SIGINT')
      } catch {
        /* ignore */
      }
      // Escalate to SIGKILL if the CLI ignores SIGINT within a short grace
      // window, so the turn genuinely stops (G2-9).
      const child = this.child
      setTimeout(() => {
        try {
          if (child && !child.killed) child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 2000)
    }
  }

  stopClaudeSdk(): Promise<void> {
    if (this.sdkStopping) return this.sdkStopping
    this.interrupted = true
    const serial = this.sdkSerial
    this.sdkStopping = (async () => {
      if (this.sdk) await this.sdk.request('interrupt', undefined, 2_000).catch(() => {})
      if (this.sdk && this.sdkGoal) await this.sdk.request('command', '/goal clear', 5_000).catch(() => {})
      await this.disposeClaudeSdk()
      await this.finishClaudeSdk(serial)
    })().finally(() => { this.sdkStopping = undefined })
    return this.sdkStopping
  }

  /** Append through the SDK's streaming input and wait for its native receipt. */
  async steer(prompt: string, attachments?: Attachment[]): Promise<void> {
    if (!this.sdk || !this.sdkActive || this.interrupted || this.preparingAssistant) throw new Error('Claude 当前没有可插话的回合')
    this.assertClaudeCommand(prompt)
    const uuid = randomUUID()
    const content = this.assistantConfig && !prompt.trimStart().startsWith('/')
      ? await assistantPrompt(this.sessionId, this.assistantConfig, prompt, '', false) : prompt
    if (!this.sdk || this.interrupted) throw new Error('Claude 回合已停止')
    this.sdkPendingMessages.add(uuid)
    try { await this.sdk.request('send', { uuid, content, attachments, waitForReplay: true }) }
    catch (error) { this.sdkPendingMessages.delete(uuid); throw error }
  }

  respond(requestId: string, answer: any): { handled: boolean; hasPendingRequests: boolean } {
    const pending = this.claudeRequests.get(requestId)
    if (!pending || !this.sdk) {
      return { handled: false, hasPendingRequests: this.claudeRequests.size > 0 }
    }
    const decision = String(answer?.decision || '')
    const allow = decision === 'accept' || decision === 'approved' || decision === 'acceptForSession' || decision === 'approved_for_session'
    const input = pending.toolName === 'AskUserQuestion'
      ? {
          ...pending.input,
          answers: Object.fromEntries((Array.isArray(pending.input?.questions) ? pending.input.questions : [])
            .map((question: any, index: number) => {
              const id = question.id || question.questionId || `q${index}`
              const values = answer?.answers?.[id]?.answers
              return [String(question.question || ''), Array.isArray(values) ? values.join(', ') : '']
            })
            .filter(([question]: string[]) => question))
        }
      : pending.input
    const response: any = pending.toolName === 'AskUserQuestion' || allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: '用户拒绝了此操作' }
    if (this.sdk) {
      if (pending.kind === 'elicitation') {
        const cancelled = ['cancel', 'decline'].includes(answer?.action)
        this.sdk.respond(pending.wireId, cancelled ? { action: answer.action === 'decline' ? 'decline' : 'cancel' } : {
          action: 'accept', content: answer?.content ?? answer?.values ?? Object.fromEntries(Object.entries(answer?.answers || {}).map(([key, value]: [string, any]) => [key, value?.answers?.length === 1 ? value.answers[0] : value?.answers]))
        })
      } else {
        if (allow && ['acceptForSession', 'approved_for_session'].includes(decision)) {
          response.updatedPermissions = (pending.suggestions || []).map(suggestion => ({ ...suggestion, destination: 'session' }))
        }
        if (pending.toolName === 'AskUserQuestion' && ['cancel', 'decline'].includes(answer?.action)) {
          response.behavior = 'deny'; response.message = '用户取消了提问'; delete response.updatedInput
        }
        this.sdk.respond(pending.wireId, response)
      }
    }
    this.claudeRequests.delete(requestId)
    this.emitEvent({ type: 'approval_request', state: 'success', payload: { requestId, resolved: true } })
    return { handled: true, hasPendingRequests: this.claudeRequests.size > 0 }
  }

  hasPendingRequests(): boolean {
    return this.claudeRequests.size > 0
  }

  getSubAgentItems(agentThreadId: string): UAEvent[] {
    return (this.claudeChildEvents.get(agentThreadId) || []).map((event) => structuredClone(event))
  }

  private claudeChildRunner(threadId: string): TurnRunner {
    let runner = this.claudeChildRunners.get(threadId)
    if (!runner) {
      runner = new TurnRunner(this.sessionId, { n: 0 })
      runner.claudeSourceRuntime = this.claudeSourceRuntime
      const detailEvents: UAEvent[] = []
      this.claudeChildEvents.set(threadId, detailEvents)
      runner.on('event', (event: UAEvent) => detailEvents.push(event))
      this.claudeChildRunners.set(threadId, runner)
    }
    return runner
  }

  private onClaudeTask(event: any): void {
    if (typeof event.task_id !== 'string' || !event.task_id) return
    const id = event.task_id
    if (typeof event.run_id === 'string' && event.run_id) {
      const previousRun = this.claudeTaskRuns.get(id)
      if (previousRun && event.run_id < previousRun) return
      if (previousRun !== event.run_id) {
        this.claudeTaskRuns.set(id, event.run_id)
        const previous = this.claudeSubagents.get(id)
        if (previous) this.claudeSubagents.set(id, { ...previous, status: 'running', endedAt: undefined, startedAt: Date.now() })
      }
    }
    if (typeof event.tool_use_id === 'string' && event.tool_use_id) {
      const previousId = this.claudeChildTools.get(event.tool_use_id)
      this.claudeChildTools.set(event.tool_use_id, id)
      if (previousId && previousId !== id && this.claudeChildRunners.has(previousId)) {
        this.claudeChildRunners.set(id, this.claudeChildRunners.get(previousId)!)
        this.claudeChildEvents.set(id, this.claudeChildEvents.get(previousId) || [])
        this.claudeChildRunners.delete(previousId)
        this.claudeChildEvents.delete(previousId)
      }
    }
    const previous = this.claudeSubagents.get(id)
    const patch = event.subtype === 'task_updated' ? event.patch || {} : {}
    const nativeStatus = event.status || patch.status
    const status: UASubAgent['status'] = nativeStatus === 'completed' ? 'completed'
      : nativeStatus === 'failed' ? 'errored'
        : nativeStatus === 'stopped' || nativeStatus === 'killed' ? 'interrupted'
          : nativeStatus === 'pending' || nativeStatus === 'paused' ? 'pendingInit'
            : nativeStatus === 'running' || event.subtype === 'task_started' ? 'running'
              : previous?.status || 'running'
    const terminal = ['completed', 'errored', 'interrupted'].includes(status)
    const usage = event.usage
    const agent: UASubAgent = {
      ...previous, agentThreadId: id, parentThreadId: event.parent_task_id || previous?.parentThreadId || this.nativeSessionId,
      dispatchId: event.tool_use_id || previous?.dispatchId,
      name: patch.description || event.description || previous?.name || id, status,
      tool: event.subagent_type || event.task_type || previous?.tool || 'Agent',
      message: patch.error || event.summary || patch.description || event.description || previous?.message,
      prompt: event.prompt || previous?.prompt,
      startedAt: previous?.startedAt || Date.now(),
      endedAt: terminal ? patch.end_time || previous?.endedAt || Date.now() : undefined,
      ...(typeof usage?.total_tokens === 'number' ? {
        tokens: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, totalTokens: usage.total_tokens }
      } : {})
    }
    this.claudeSubagents.set(id, agent)
    this.emitEvent({ type: 'subagent', state: status === 'running' ? 'running' : status === 'completed' ? 'success' : 'failed', payload: { id: `claude-task-${id}`, agents: [agent] } })
  }

  getClaudeContextUsage(): Promise<any> {
    return this.sdk ? this.sdk.request('context') : Promise.reject(new Error('Claude 当前没有已初始化的 SDK 会话'))
  }

  getClaudeUsage(): Promise<any> {
    return this.sdk ? this.sdk.request('usage') : Promise.reject(new Error('Claude 当前没有已初始化的 SDK 会话'))
  }

  async setClaudePermissionMode(mode: string): Promise<void> {
    await this.sdk?.request('setPermissionMode', mode)
  }

  private onClaudeControlRequest(event: any): void {
    const request = event.request
    if (request?.subtype !== 'can_use_tool' || event.request_id == null) return
    const toolName = String(request.tool_name || '')
    const input = request.input || {}
    const requestId = `claude-${String(event.request_id)}`
    this.claudeRequests.set(requestId, { wireId: String(event.request_id), toolName, input })
    const kind = toolName === 'AskUserQuestion' ? 'question'
      : toolName === 'ExitPlanMode' ? 'planMode'
        : toolName === 'Bash' ? 'command'
          : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName) ? 'fileChange' : 'approval'
    const params = kind === 'question' ? input
      : kind === 'command' ? { command: input.command, cwd: input.cwd }
        : kind === 'fileChange' ? { changes: [{ path: input.file_path || input.notebook_path }] }
          : input
    this.emitEvent({
      type: 'approval_request', state: 'pending',
      payload: { requestId, method: 'claude/canUseTool', kind, params }
    })
  }

  /**
   * Start the turn. `resumeId` continues a prior native session when supported.
   * `attachments` (images/files) are passed to the CLI via `-i`/argv (Doc4 需求3).
   */
  start(
    agent: AgentDef,
    config: SessionConfig,
    prompt: string,
    resumeId?: string,
    attachments?: Attachment[],
    fork?: ClaudeForkOrigin
  ): void {
    if (agent.adapter === 'claude') {
      void this.startClaudeSdk(agent, config.collaborationMode === 'plan' ? { ...config, permissionMode: 'plan' } : config, prompt, resumeId, attachments, fork)
      return
    }
    if (config.assistantSnapshot && ['codex','traex'].includes(agent.adapter)) {
      this.preparingAssistant = true
      void assistantPrompt(this.sessionId, config, prompt, '', false).then(effective => {
        this.preparingAssistant = false
        if (!this.interrupted) this.startPrepared(agent, config, effective, resumeId, attachments, fork)
      }).catch(error => {
        this.preparingAssistant = false
        if (this.interrupted) return
        this.emitEvent({ type: 'error', state: 'failed', payload: { message: `助手上下文加载失败：${String(error)}` } })
        this.emit('done', { failed: true })
      })
      return
    }
    this.startPrepared(agent, config, prompt, resumeId, attachments, fork)
  }

  private assertClaudeCommand(prompt: string): void {
    if (this.claudeRole?.skills === undefined) return
    const command = prompt.trimStart().match(/^\/(\S+)(?=\s|$)/)?.[1]
    const args = command ? prompt.trimStart().slice(command.length + 1).trimStart() : ''
    if (command && (args.startsWith('/') || /^\(MCP\)(?:\s|$)/.test(args) || !this.claudeRole.skills.includes(command) && !this.claudeBuiltinCommands.has(command))) {
      throw new Error(`命令 /${command} 不在角色技能白名单内`)
    }
  }

  private async startClaudeSdk(agent: AgentDef, config: SessionConfig, prompt: string, resumeId?: string, attachments?: Attachment[], fork?: ClaudeForkOrigin): Promise<void> {
    if (this.sdkActive) throw new Error('Claude 当前已有回合正在运行')
    const serial = ++this.sdkSerial
    this.sdkActive = true
    this.interrupted = false
    this.preparingAssistant = true
    this.claudeResultFailed = false
    this.claudePartial = true
    this.claudeCompact = prompt.trim() === '/compact'
    this.claudeCompactDone = false
    this.sdkGoalClear = prompt.trim() === '/goal clear'
    this.sdkGoalTurn = this.sdkGoal?.status === 'active'
    this.sdkPendingMessages.clear()
    this.claudeFileEvents = []
    this.claudeFinalCandidate = undefined
    this.claudeLastCall = undefined
    this.claudeTextIds = []
    this.claudeWorkdir = config.workdir
    this.assistantConfig = config
    this.claudeRole = config.roleSnapshot
    this.modelId = config.model || agent.defaultModel
    if (this.sdkIdleTimer) clearTimeout(this.sdkIdleTimer)
    let runtime: ClaudeSourceRuntime | undefined
    try {
      runtime = await prepareClaudeSourceRuntime(config)
      await this.sdkDisposing
      if (serial !== this.sdkSerial || this.interrupted) { await runtime?.dispose(); return }
      const launch = buildCommand(agent, runtime ? { ...config, model: runtime.model } : config, prompt, resumeId, attachments, this.sessionId, fork, true)
      const key = JSON.stringify({ bin: agent.bin, version: agent.version, config: { ...config, model: runtime?.model || config.model }, env: runtime?.env, instructions: launch.appendedPrompt })
      if (this.sdk && (key !== this.sdkKey || fork)) await this.disposeClaudeSdk()
      if (!this.sdk) {
        this.claudeSourceRuntime = runtime
        runtime = undefined
        this.sdkTelemetry = await startTokenSpeedTelemetry('claude', sample => {
          if (sample.threadId === this.nativeSessionId) this.emitEvent({ type: 'system_notice', payload: { id: sample.id, kind: 'token_speed', speed: sample.speed } })
        })
        if (serial !== this.sdkSerial || this.interrupted) { await this.disposeClaudeSdk(); return }
        const source = this.claudeSourceRuntime
        const args = [...launch.args, ...(source?.args || [])]
        const sdkLaunch = claudeSdkLaunch(agent.bin, config.workdir, args,
          { ...process.env, ...nativeCredentialEnv('claude'), ...launch.env, ...source?.env, ...this.sdkTelemetry?.env }, config.roleSnapshot)
        sdkLaunch.initializeTimeoutMs = 10_000
        this.sdk = new ClaudeSdkClient(sdkLaunch)
        const sdk = this.sdk
        this.sdkLastCost = resumeId || fork ? undefined : 0
        this.sdkKey = key
        sdk.on('message', message => {
          if (this.sdk !== sdk) return
          const safe = source ? JSON.parse(source.redact(JSON.stringify(message))) : message
          if (safe.type === 'result' && this.interrupted) return
          if (safe.type === 'result') {
            const replies = safe.user_message_uuids || (safe.user_message_uuid ? [safe.user_message_uuid] : undefined)
            if (this.sdkActive && replies && !replies.some((id: string) => this.sdkPendingMessages.has(id))) return
            if (replies) for (const id of replies) this.sdkPendingMessages.delete(id)
            else if (!safe.queued_turn_count) this.sdkPendingMessages.clear()
            const cumulative = safe.total_cost_usd
            const perModel = safe.model_usage_since_last_result
            const costs = perModel && Object.values(perModel).map((usage: any) => usage.costUSD)
            safe.total_cost_usd = costs?.length && costs.every((cost: unknown) => typeof cost === 'number')
              ? costs.reduce((sum: number, cost: number) => sum + cost, 0)
              : typeof cumulative === 'number' && this.sdkLastCost !== undefined && cumulative >= this.sdkLastCost ? cumulative - this.sdkLastCost : undefined
            if (typeof cumulative === 'number') this.sdkLastCost = cumulative
            if (this.sdkGoalTurn && this.sdkGoal && !this.sdkGoalClear) {
              const usage = safe.usage
              const tokens = [usage?.input_tokens, usage?.output_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens]
                .reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
              this.sdkGoal = { ...this.sdkGoal, tokensUsed: this.sdkGoal.tokensUsed + tokens,
                timeUsedSeconds: this.sdkGoal.timeUsedSeconds + Math.max(0, Number(safe.duration_ms) || 0) / 1000, updatedAt: Date.now() }
              this.emit('goalChanged', this.sdkGoal)
            }
            if (this.sdkGoalClear && /^(?:No goal set|Goal cleared:)/.test(safe.result || '')) {
              this.sdkGoal = undefined; this.emit('goalChanged', undefined)
            } else if (/^(?:Not logged in · Please run \/login|\/(?:goal|code-review) can't run|Goal condition is limited)/.test(safe.result || '')) {
              safe.is_error = true
              safe.subtype = 'error_during_execution'
              safe.errors = [safe.result]
            }
          }
          this.parseClaude(safe)
          if (safe.type === 'result' && this.sdkActive && (!this.sdkPendingMessages.size && !safe.queued_turn_count && !(this.sdkGoal?.autonomous && this.sdkGoal.status === 'active') || this.claudeResultFailed)) {
            const serial = this.sdkSerial
            void this.confirmClaudeGoal(sdk, safe).then(() => { if (!this.interrupted) return this.finishClaudeSdk(serial) })
          }
          if (safe.type === 'system' && safe.subtype === 'api_retry' && source && [401, 402, 403].includes(safe.error_status)) {
            this.claudeResultFailed = true
            void this.disposeClaudeSdk().then(() => this.finishClaudeSdk(this.sdkSerial))
          }
        })
        sdk.on('approval', request => {
          if (this.sdk !== sdk) return
          if (request.kind === 'elicitation') {
            const requestId = `claude-${request.requestId}`
            this.claudeRequests.set(requestId, { wireId: request.requestId, toolName: 'McpElicitation', input: request.input, kind: 'elicitation' })
            this.emitEvent({ type: 'approval_request', state: 'pending', payload: { requestId, method: 'claude/mcpElicitation', kind: 'elicitation', params: request.input } })
          } else {
            this.onClaudeControlRequest({ request_id: request.requestId, request: { subtype: 'can_use_tool', tool_name: request.toolName, input: request.input } })
            const pending = this.claudeRequests.get(`claude-${request.requestId}`)
            if (pending) pending.suggestions = request.suggestions
          }
        })
        sdk.on('approvalCancelled', wireId => {
          const requestId = `claude-${wireId}`
          if (this.claudeRequests.delete(requestId)) this.emitEvent({ type: 'approval_request', state: 'cancelled', payload: { requestId, resolved: true, interactionExpired: true } })
        })
        sdk.on('failure', error => {
          if (this.sdk !== sdk || this.interrupted) return
          this.claudeResultFailed = true
          this.emitEvent({ type: 'error', state: 'failed', payload: { message: source?.redact(String(error)) ?? String(error) } })
          void this.disposeClaudeSdk().then(() => this.finishClaudeSdk(this.sdkSerial))
        })
        sdk.on('ended', () => {
          if (this.sdk !== sdk) return
          if (this.sdkActive) this.claudeResultFailed = true
          void this.disposeClaudeSdk().then(() => this.finishClaudeSdk(this.sdkSerial))
        })
        this.forkSourceId = fork?.sessionId
        const initialized = await sdk.ready
        this.claudeBuiltinCommands = new Set((initialized.commands || []).filter((command: any) => command.builtin === true).map((command: any) => command.name))
      } else {
        await runtime?.dispose()
        const reloaded = await this.sdk.request('reloadPlugins')
        this.claudeBuiltinCommands = new Set((reloaded.commands || []).filter((command: any) => command.builtin === true).map((command: any) => command.name))
      }
      if (serial !== this.sdkSerial || this.interrupted || !this.sdk) return
      if (this.sdkGoal && !['active', 'complete'].includes(this.sdkGoal.status)) {
        const cleared = await this.sdk.request('command', '/goal clear')
        if (cleared.is_error || !/^(?:No goal set|Goal cleared:)/.test(cleared.result || '')) throw new Error('Claude 未确认暂停目标已停止，当前消息未发送')
      }
      const nativeAction = prompt.match(/^\/(goal|code-review)(?:\s|$)/)?.[1]
      if (nativeAction && !this.claudeBuiltinCommands.has(nativeAction)) throw new Error(`当前 Claude Code 未声明原生 /${nativeAction}，请更新本机程序后重试`)
      this.assertClaudeCommand(prompt)
      const content = !prompt.trimStart().startsWith('/') ? await assistantPrompt(this.sessionId, config, prompt, '', false) : prompt
      if (serial !== this.sdkSerial || this.interrupted || !this.sdk) return
      this.preparingAssistant = false
      this.emitEvent({ type: 'system_notice', payload: { kind: 'launch', label: agent.name, model: config.model || agent.defaultModel,
        effort: config.effort, appendedPrompt: launch.appendedPrompt, text: `启动: Claude Agent SDK · ${agent.bin}` } })
      const uuid = randomUUID()
      this.sdkPendingMessages.add(uuid)
      this.emitEvent({ type: 'turn_started', payload: { turnId: uuid, sessionId: this.nativeSessionId, model: config.model } })
      await this.sdk.request('send', { uuid, content, attachments })
    } catch (error) {
      await runtime?.dispose()
      if (serial !== this.sdkSerial || this.interrupted) return
      this.claudeResultFailed = true
      this.emitEvent({ type: 'error', state: 'failed', payload: { message: `Claude SDK 初始化或执行失败：${this.claudeSourceRuntime?.redact(String(error)) ?? String(error)}` } })
      await this.disposeClaudeSdk()
      await this.finishClaudeSdk(serial)
    }
  }

  private async finishClaudeSdk(serial: number): Promise<void> {
    if (!this.sdkActive || serial !== this.sdkSerial) return
    this.sdkActive = false
    this.sdkGoalTurn = false
    this.preparingAssistant = false
    this.flushDeltas()
    if (this.sdkGoal && this.interrupted) {
      this.sdkGoal = { ...this.sdkGoal, status: 'paused', autonomous: false, updatedAt: Date.now() }
      this.emit('goalChanged', this.sdkGoal)
    } else if (this.sdkGoal && this.claudeResultFailed) {
      this.sdkGoal = { ...this.sdkGoal, status: 'blocked', autonomous: false, updatedAt: Date.now() }
      this.emit('goalChanged', this.sdkGoal)
    }
    if (this.claudeCompact && !this.claudeCompactDone) {
      this.emitEvent({ type: 'context_compaction', state: 'failed', payload: { id: 'claude-compact', error: 'Claude 未报告压缩完成' } })
      this.claudeResultFailed = true
    }
    if (this.nativeSessionId) this.sdkTelemetry?.endTurn(this.nativeSessionId)
    for (const [requestId] of this.claudeRequests) this.emitEvent({ type: 'approval_request', state: 'cancelled', payload: { requestId, resolved: true, interactionExpired: true } })
    this.claudeRequests.clear()
    if (this.claudeFileEvents.length) {
      try {
        const files = await filesFromTurnChanges(this.claudeFileEvents, this.claudeWorkdir)
        const diff = files.map(file => file.unifiedDiff).filter(Boolean).join('')
        if (diff) this.emitEvent({ type: 'diff_update', payload: { diff } })
      } catch { /* File cards retain their individual evidence. */ }
    }
    this.emitEvent({ type: 'turn_completed', state: this.interrupted ? 'cancelled' : this.claudeResultFailed ? 'failed' : 'success', payload: {} })
    this.emit('done', { nativeSessionId: this.nativeSessionId, interrupted: this.interrupted, failed: this.claudeResultFailed })
    this.scheduleClaudeIdleClose()
  }

  private async confirmClaudeGoal(sdk: ClaudeSdkClient, result: any): Promise<void> {
    if (!this.sdkGoal || this.sdkGoal.status !== 'active' || this.sdkGoal.autonomous || this.claudeResultFailed || !(result.num_turns > 0 || result.usage?.output_tokens > 0)) return
    try {
      const state = await sdk.request('command', '/goal')
      if (this.sdk !== sdk || this.interrupted || !this.sdkGoal) return
      if (/^No goal set\./.test(state.result || '')) this.sdkGoal = { ...this.sdkGoal, status: 'complete', autonomous: false, updatedAt: Date.now() }
      else if (/^Goal active:/.test(state.result || '')) {
        this.sdkGoal = { ...this.sdkGoal, status: 'paused', autonomous: false, updatedAt: Date.now() }
        this.emitEvent({ type: 'system_notice', payload: { kind: 'warning', text: 'Claude 原生 Goal 尚未完成，当前回合已结束；目标已暂停，可手动继续。' } })
      } else throw new Error('Claude 未返回可确认的原生 Goal 状态')
      this.emit('goalChanged', this.sdkGoal)
    } catch (error) {
      if (this.sdk !== sdk || this.interrupted) return
      this.claudeResultFailed = true
      this.emitEvent({ type: 'error', state: 'failed', payload: { message: `Claude Goal 状态确认失败：${String(error)}` } })
    }
  }

  private scheduleClaudeIdleClose(): void {
    if (this.sdkIdleTimer) clearTimeout(this.sdkIdleTimer)
    this.sdkIdleTimer = setTimeout(() => {
      if (this.sdkActive) return
      if (this.claudeRequests.size || [...this.claudeSubagents.values()].some(agent => ['running', 'pendingInit'].includes(agent.status))) this.scheduleClaudeIdleClose()
      else void this.disposeClaudeSdk()
    }, 60_000)
    this.sdkIdleTimer.unref()
  }

  disposeClaudeSdk(): Promise<void> {
    if (this.sdkDisposing) return this.sdkDisposing
    if (this.sdkIdleTimer) clearTimeout(this.sdkIdleTimer)
    const sdk = this.sdk
    const telemetry = this.sdkTelemetry
    const source = this.claudeSourceRuntime
    this.sdk = undefined
    this.sdkKey = undefined
    this.sdkTelemetry = undefined
    this.claudeSourceRuntime = undefined
    this.sdkDisposing = (async () => {
      await sdk?.close()
      await telemetry?.close()
      await source?.dispose()
    })().finally(() => { this.sdkDisposing = undefined })
    return this.sdkDisposing
  }

  pendingPlanModeExitRequestId(): string | undefined {
    return [...this.claudeRequests].find(([, request]) => request.toolName === 'ExitPlanMode')?.[0]
  }

  hasClaudeSdkConnection(): boolean { return !!this.sdk }
  processId(): number | undefined { return this.sdk?.processId() ?? this.child?.pid }
  configureClaudeGoal(goal: GoalState | undefined): void { this.sdkGoal = goal ? structuredClone(goal) : undefined }
  async clearClaudeGoal(): Promise<void> {
    if (!this.sdk) throw new Error('Claude SDK 会话尚未恢复')
    const result = await this.sdk.request('command', '/goal clear')
    if (result.is_error || !/^(?:No goal set|Goal cleared:)/.test(result.result || '')) throw new Error(result.result || 'Claude 未确认清除 Goal')
    this.sdkGoal = undefined
    this.emit('goalChanged', undefined)
  }

  private startPrepared(agent: AgentDef, config: SessionConfig, prompt: string, resumeId?: string, attachments?: Attachment[], fork?: ClaudeForkOrigin, telemetry?: TokenSpeedTelemetry | null): void {
    if (['codex', 'traex'].includes(agent.adapter) && telemetry === undefined) {
      this.preparingAssistant = true
      void startTokenSpeedTelemetry(agent.adapter as 'codex' | 'traex', sample => {
        if (sample.threadId === this.nativeSessionId) this.emitEvent({ type: 'system_notice', payload: { id: sample.id, kind: 'token_speed', speed: sample.speed } })
      }).then(async receiver => {
        this.preparingAssistant = false
        if (this.interrupted) { await receiver?.close(); return }
        try { this.startPrepared(agent, config, prompt, resumeId, attachments, fork, receiver ?? null) }
        catch (error) { await receiver?.close(); throw error }
      }).catch(error => {
        this.emitEvent({ type: 'error', state: 'failed', payload: { message: `${agent.name} 启动失败：${String(error)}` } })
        this.emit('done', { failed: true })
      })
      return
    }
    const { cmd, args, env, appendedPrompt } = buildCommand(agent, config, prompt, resumeId, attachments, this.sessionId, fork)
    this.modelId = config.model || agent.defaultModel
    this.emitEvent({ type: 'system_notice', payload: {
      text: `启动: ${cmd} ${args.map(arg => {
        const token = teamRuntime(this.sessionId)?.token
        const memoryToken = assistantMcpEnv(this.sessionId).UNIAGENT_ASSISTANT_TOKEN
        const safe = token ? arg.split(token).join('[team capability]') : arg
        return memoryToken ? safe.split(memoryToken).join('[assistant capability]') : safe
      }).join(' ')}`, kind: 'launch', label: agent.name, model: config.model || agent.defaultModel, effort: config.effort, appendedPrompt
    } })
    args.push(...(telemetry?.args || []))
    const child = spawn(cmd, args, { cwd: config.workdir, env: { ...process.env, ...nativeCredentialEnv(agent.adapter), ...env, ...telemetry?.env }, stdio: ['pipe','pipe','pipe'] })
    this.child = child
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(agent.adapter, chunk))
    let stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4000) })
    child.on('error', error => this.emitEvent({ type: 'error', state: 'failed', payload: { message: `进程启动失败: ${error.message}` } }))
    child.on('close', async code => {
      await telemetry?.close()
      if (this.buf.trim()) this.onLine(agent.adapter, this.buf)
      this.buf = ''
      this.flushDeltas()
      if (this.interrupted) this.emitEvent({ type: 'system_notice', payload: { kind: 'interrupted', text: '本轮已中断。' } })
      else if (code !== 0 && code !== null) this.emitEvent({ type: 'error', state: 'failed', payload: { message: `进程退出，code=${code}`, detail: stderrTail.trim() || undefined } })
      this.emitEvent({ type: 'turn_completed', state: this.interrupted ? 'cancelled' : 'success', payload: {} })
      this.emit('done', { nativeSessionId: this.nativeSessionId, interrupted: this.interrupted, failed: false })
    })
    child.stdin.end()
  }

  private onStdout(adapter: AgentDef['adapter'], chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (line.trim()) this.onLine(adapter, line)
    }
  }

  private onLine(adapter: AgentDef['adapter'], line: string): void {
    if (this.claudeSourceRuntime) line = this.claudeSourceRuntime.redact(line)
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      // Non-JSON line -> raw output (fidelity fallback, never dropped).
      this.emitEvent({ type: 'raw_output', payload: { text: line } })
      return
    }
    if (adapter === 'claude') this.parseClaude(obj)
    else this.parseCodexLike(obj) // codex & traex share the exec --json schema
  }

  // ---- Codex / TraeX exec --json (JSONL) ----
  private parseCodexLike(o: any): void {
    switch (o.type) {
      case 'thread.started':
        this.nativeSessionId = o.thread_id
        this.emitEvent({ type: 'turn_started', payload: { threadId: o.thread_id } })
        break
      case 'turn.started':
        break
      case 'turn.completed':
        this.emitEvent({
          type: 'system_notice',
          payload: { usage: normalizeExecUsage(o.usage, this.modelId), kind: 'usage' }
        })
        break
      case 'error':
      case 'turn.failed':
        this.emitEvent({
          type: 'error',
          state: 'failed',
          payload: { message: extractErrMessage(o) }
        })
        break
      case 'item.started':
      case 'item.completed': {
        const done = o.type === 'item.completed'
        this.mapCodexItem(o.item, done)
        break
      }
      default:
        break
    }
  }

  private mapCodexItem(item: any, done: boolean): void {
    if (!item) return
    const state = codexState(item.status, done)
    switch (item.type) {
      case 'agent_message':
        // Only emit final assistant text (on completion) to avoid dupes.
        if (done && item.text) {
          this.emitEvent({
            type: 'agent_message',
            payload: { text: item.text, ...(item.phase ? { phase: item.phase } : {}) }
          })
        }
        break
      case 'reasoning':
        if (done && (item.text || item.summary)) {
          this.emitEvent({
            type: 'reasoning',
            payload: { text: item.text || item.summary }
          })
        }
        break
      case 'command_execution':
        this.emitEvent({
          type: 'command_exec',
          state,
          payload: {
            id: item.id,
            command: item.command,
            output: item.aggregated_output || '',
            exitCode: item.exit_code ?? null
          }
        })
        break
      case 'file_change':
        this.emitEvent({
          type: 'file_change',
          state,
          payload: { id: item.id, changes: item.changes || [] }
        })
        break
      case 'mcp_tool_call':
      case 'tool_call':
        // Doc4 — codex one-shot exec surfaces its plan via an `update_plan` tool
        // call. Map it to a plan_update event instead of a generic tool card.
        if (item.name === 'update_plan' || item.tool === 'update_plan') {
          const args = parsePlanArgs(item.arguments ?? item.input ?? item.args)
          if (args) {
            this.emitEvent({
              type: 'plan_update',
              state: 'running',
              payload: {
                id: `plan-${this.nativeSessionId || 't'}`,
                steps: args.steps,
                explanation: args.explanation
              }
            })
            break
          }
        }
        const exactDurationMs = durationMs(item.durationMs ?? item.duration)
        this.emitEvent({
          type: 'tool_call',
          state,
          payload: {
            id: item.id,
            ...(item.type === 'mcp_tool_call'
              ? {
                  provider: 'mcp',
                  server: item.server,
                  input: item.arguments,
                  ...(exactDurationMs === undefined ? {} : { durationMs: exactDurationMs })
                }
              : {}),
            name: item.name || item.tool,
            raw: item
          }
        })
        break
      case 'error':
        // Inline `error` items in the exec JSONL stream are advisory diagnostics
        // (e.g. "loading hooks from both...", "Skill descriptions were shortened",
        // "Ignoring malformed agent role definition..."). They do NOT fail the
        // turn — the CLI still exits 0 and the definitive outcome comes from the
        // top-level `turn.failed` event or a non-zero exit code. Surface them as
        // non-fatal warnings, mirroring how the native TUIs render them —
        // 修复#5 except the noisy "Ignoring …" definition-loader chatter, which is
        // pure config noise the user asked to never see.
        if (isIgnorableNotice(item.message)) break
        this.emitEvent({
          type: 'system_notice',
          payload: { id: item.id, kind: 'warning', text: item.message }
        })
        break
      default:
        this.emitEvent({ type: 'raw_output', payload: { text: JSON.stringify(item) } })
    }
  }

  // ---- Claude Code --output-format stream-json (NDJSON) ----
  private parseClaude(o: any): void {
    if (typeof o.parent_tool_use_id === 'string' && o.parent_tool_use_id &&
        ['assistant', 'user', 'stream_event'].includes(o.type)) {
      const id = this.claudeChildTools.get(o.parent_tool_use_id) || o.parent_tool_use_id
      this.claudeChildTools.set(o.parent_tool_use_id, id)
      this.claudeChildRunner(id).parseClaude({ ...o, parent_tool_use_id: null })
      return
    }
    switch (o.type) {
      case 'active_goal': {
        const now = Date.now()
        if (o.value && typeof o.value.condition === 'string') this.sdkGoal = {
          objective: o.value.condition, status: 'active', tokenBudget: null,
          tokensUsed: this.sdkGoal?.tokensUsed || 0, timeUsedSeconds: this.sdkGoal?.timeUsedSeconds || 0,
          createdAt: this.sdkGoal?.createdAt || now, updatedAt: now, continuation: 'native', autonomous: true
        }
        else if (o.value === null && this.sdkGoal) this.sdkGoal = { ...this.sdkGoal, status: 'complete', autonomous: false, updatedAt: now }
        else break
        this.emit('goalChanged', this.sdkGoal)
        if (o.value === null && !this.interrupted && this.sdkActive && !this.sdkPendingMessages.size) void this.finishClaudeSdk(this.sdkSerial)
        break
      }
      case 'control_request':
        this.onClaudeControlRequest(o)
        break
      case 'system':
        if (['hook_started', 'hook_progress', 'hook_response'].includes(o.subtype)) {
          this.emitEvent({ type: 'hook', state: o.subtype === 'hook_response' ? o.outcome === 'cancelled' ? 'cancelled' : o.exit_code || o.outcome === 'error' ? 'failed' : 'success' : 'running',
            payload: { id: o.hook_id, name: o.hook_name, eventName: o.hook_event, output: o.output || o.stdout || o.stderr, exitCode: o.exit_code } })
          break
        }
        if (this.claudeSourceRuntime && o.subtype === 'api_retry' && [401, 402, 403].includes(o.error_status)) {
          if (this.interrupted || this.claudeResultFailed) break
          this.claudeResultFailed = true
          this.emitEvent({ type: 'error', state: 'failed', payload: {
            message: `第三方模型请求失败（HTTP ${o.error_status}），请检查 API Key、模型权限及账户余额；已停止本轮重试`
          } })
          break
        }
        if (['task_started', 'task_updated', 'task_progress', 'task_notification'].includes(o.subtype)) {
          this.onClaudeTask(o)
          break
        }
        if (o.subtype === 'init') {
          if (this.forkSourceId && (typeof o.session_id !== 'string' || !o.session_id || o.session_id === this.forkSourceId)) {
            this.emitEvent({ type: 'error', state: 'failed', payload: { message: 'Claude 未创建独立分支，已停止续写' } })
            this.claudeResultFailed = true
            void this.disposeClaudeSdk().then(() => this.finishClaudeSdk(this.sdkSerial))
            return
          }
          this.nativeSessionId = o.session_id
          this.emitEvent({
            type: 'turn_started',
            payload: { sessionId: o.session_id, model: o.model }
          })
          if (this.claudeCompact) this.emitEvent({ type: 'context_compaction', state: 'running', payload: { id: 'claude-compact' } })
        }
        if (o.subtype === 'compact_boundary' && this.claudeCompact) {
          this.claudeCompactDone = true
          this.emitEvent({ type: 'context_compaction', state: 'success', payload: { id: 'claude-compact' } })
        }
        // thinking_tokens/hook chatter is intentionally ignored for noise control.
        break
      case 'stream_event':
        // Token-level deltas (only present with --include-partial-messages).
        if (this.claudePartial) this.onClaudeStreamEvent(o.event)
        break
      case 'assistant': {
        if (!this.claudeSourceRuntime && o.context_usage && typeof o.context_usage === 'object') {
          this.emitEvent({ type: 'system_notice', payload: { kind: 'context_usage', contextUsage: o.context_usage } })
          this.emit('contextUsage', o.context_usage)
        }
        if (!this.claudeSourceRuntime && o.usage_report && typeof o.usage_report === 'object') {
          this.emitEvent({ type: 'system_notice', payload: { kind: 'usage_report', usageReport: o.usage_report } })
          this.emit('usageReport', o.usage_report)
        }
        if (!o.parent_tool_use_id && o.message?.usage) {
          this.claudeLastCall = { usage: o.message.usage, model: o.message.model }
        }
        const content = o.message?.content || []
        for (const [index, block] of content.entries()) {
          // In partial mode the completed text reuses the streamed block id, so
          // it updates that reply with terminal metadata instead of duplicating it.
          // Tool calls still come from the completed message since their full
          // input isn't known until the block finishes.
          if (block.type === 'text' && block.text) {
            const id = this.claudePartial
              ? this.claudeTextIds.shift() ?? this.claudeBlockId(index)
              : `${o.message?.id || 'claude-reply'}-${this.claudeReplyOrdinal++}`
            this.claudeFinalCandidate = o.message?.stop_reason === 'end_turn'
              ? undefined
              : { id, text: block.text }
            this.emitEvent({
              type: 'agent_message',
              payload: {
                id,
                text: block.text,
                ...(o.message?.stop_reason === 'end_turn' ? { phase: 'final_answer' } : {})
              }
            })
          } else if (block.type === 'thinking' && block.thinking) {
            if (!this.claudePartial) {
              this.emitEvent({ type: 'reasoning', payload: { text: block.thinking } })
            }
          } else if (block.type === 'tool_use') {
            this.claudeFinalCandidate = undefined
            if (typeof block.id === 'string') this.claudeTools.set(block.id, { name: block.name, input: block.input })
            // Doc4 — claude surfaces its todo list via a TodoWrite tool call.
            // Map it to plan_update rather than a generic tool card.
            if (block.name === 'TodoWrite') {
              const steps = parseTodoWrite(block.input)
              if (steps.length) {
                this.emitEvent({
                  type: 'plan_update',
                  state: 'running',
                  payload: { id: `plan-${this.nativeSessionId || 't'}`, steps }
                })
                continue
              }
            }
            this.emitEvent({
              type: block.name === 'Bash' ? 'command_exec' : 'tool_call',
              state: 'running',
              payload: {
                id: block.id,
                name: block.name,
                command: block.input?.command,
                input: block.input
              }
            })
          }
        }
        break
      }
      case 'user': {
        // tool_result echoes: surface as command/tool output.
        const content = o.message?.content || []
        for (const block of content) {
          if (block.type === 'tool_result') {
            const tool = this.claudeTools.get(block.tool_use_id)
            this.claudeTools.delete(block.tool_use_id)
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text || '').join('')
              : block.content
            this.emitEvent({
              type: tool?.name === 'Bash' ? 'command_exec' : 'tool_call',
              state: block.is_error ? 'failed' : 'success',
              payload: { id: block.tool_use_id, output: text }
            })
            if (!block.is_error && tool) {
              const steps = updateClaudeTaskPlan(this.sdkTasks, tool.name, tool.input, o.tool_use_result ?? o.toolUseResult)
              if (steps) this.emitEvent({ type: 'plan_update', state: steps.every(step => step.status === 'completed') ? 'success' : 'running',
                payload: { id: `plan-${this.nativeSessionId || 't'}`, steps } })
              const change = claudeFileChange(tool.name, tool.input, o.tool_use_result ?? o.toolUseResult)
              if (change) this.emitEvent({
                type: 'file_change', state: 'success',
                payload: { id: `${block.tool_use_id}-change`, changes: [change] }
              })
            }
          }
        }
        break
      }
      case 'result':
        this.claudeResultFailed = o.is_error === true || o.subtype !== 'success'
        if (this.claudeResultFailed) {
          const message = typeof o.result === 'string' && o.result || (Array.isArray(o.errors) ? o.errors.filter((value: unknown) => typeof value === 'string').join('\n') : '')
          this.emitEvent({ type: 'error', state: 'failed', payload: { message: (message || 'Claude 回合未成功完成，请检查模型权限、额度或网络').slice(0, 2000) } })
        }
        if (o.subtype === 'success' && o.is_error !== true && this.claudeFinalCandidate) {
          this.emitEvent({
            type: 'agent_message',
            payload: { ...this.claudeFinalCandidate, phase: 'final_answer' }
          })
        }
        this.claudeFinalCandidate = undefined
        this.emitEvent({
          type: 'system_notice',
          payload: {
            kind: 'usage',
            usage: normalizeClaudeUsage(o.usage, this.modelId, this.claudeSourceRuntime ? undefined : o.total_cost_usd, this.claudeLastCall, this.claudeSourceRuntime ? undefined : o.modelUsage),
            cost: this.claudeSourceRuntime ? undefined : o.total_cost_usd,
            durationMs: o.duration_ms
          }
        })
        break
      case 'rate_limit_event': {
        if (this.claudeSourceRuntime) break
        // Account-global quota, not a transcript item: surfaced to the popover only.
        const snapshot = normalizeClaudeRateLimits(o.rate_limit_info)
        if (snapshot) this.emit('rateLimits', snapshot)
        break
      }
      default:
        break
    }
  }

  /**
   * Handle one Claude `stream_event`. Text/thinking arrive as per-token
   * `content_block_delta`s; we accumulate per content block (keyed by the
   * message id + block index so re-emits update the same reply node) and flush
   * a coalesced running snapshot ~once per frame, then a final snapshot on
   * `content_block_stop`. Tool blocks are deferred to the completed message.
   */
  private onClaudeStreamEvent(ev: any): void {
    if (!ev) return
    switch (ev.type) {
      case 'message_start':
        this.claudeMsgId = ev.message?.id || this.claudeMsgId || `msg-${Date.now()}`
        this.claudeTextIds = []
        break
      case 'content_block_start': {
        const t = ev.content_block?.type
        if (t === 'text' || t === 'thinking') {
          const id = this.claudeBlockId(ev.index)
          if (t === 'text') this.claudeTextIds.push(id)
          this.itemType.set(id, t === 'text' ? 'agent' : 'reasoning')
          if (!this.textBuf.has(id)) this.textBuf.set(id, '')
        }
        break
      }
      case 'content_block_delta': {
        const id = this.claudeBlockId(ev.index)
        const d = ev.delta
        if (d?.type === 'text_delta' && d.text) {
          this.itemType.set(id, 'agent')
          this.textBuf.set(id, (this.textBuf.get(id) || '') + d.text)
          this.markDirty(id)
        } else if (d?.type === 'thinking_delta' && d.thinking) {
          this.itemType.set(id, 'reasoning')
          this.textBuf.set(id, (this.textBuf.get(id) || '') + d.thinking)
          this.markDirty(id)
        }
        break
      }
      case 'content_block_stop':
        this.flushBlockFinal(this.claudeBlockId(ev.index))
        break
      default:
        break
    }
  }

  private claudeBlockId(index: number): string {
    return `${this.claudeMsgId || 'm'}-${index}`
  }

  // ---- delta coalescing (shared by claude partial streaming) ----

  private markDirty(id: string): void {
    this.dirty.add(id)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushRunning(), TurnRunner.FLUSH_MS)
    }
  }

  /** Emit a `state:'running'` snapshot for every dirty block, then reset. */
  private flushRunning(): void {
    this.clearFlushTimer()
    for (const id of this.dirty) {
      const type = this.itemType.get(id)
      const text = this.textBuf.get(id) || ''
      if (type === 'agent') {
        this.emitEvent({ type: 'agent_message', state: 'running', payload: { id, text } })
      } else if (type === 'reasoning') {
        this.emitEvent({ type: 'reasoning', state: 'running', payload: { id, text } })
      }
    }
    this.dirty.clear()
  }

  /** Emit the final (non-running) snapshot for a completed block. */
  private flushBlockFinal(id: string): void {
    this.dirty.delete(id)
    const type = this.itemType.get(id)
    const text = this.textBuf.get(id) || ''
    if (type === 'agent' && text) {
      this.emitEvent({ type: 'agent_message', payload: { id, text } })
    } else if (type === 'reasoning' && text) {
      this.emitEvent({ type: 'reasoning', payload: { id, text } })
    }
  }

  /** Finalize any blocks still pending when the process closes. */
  private flushDeltas(): void {
    this.clearFlushTimer()
    for (const id of [...this.dirty]) this.flushBlockFinal(id)
    this.dirty.clear()
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}

function durationMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : undefined
  if (!value || typeof value !== 'object') return undefined
  const secs = Number((value as any).secs ?? 0)
  const nanos = Number((value as any).nanos ?? 0)
  return Number.isFinite(secs) && Number.isFinite(nanos)
    ? Math.max(0, secs * 1_000 + nanos / 1_000_000)
    : undefined
}

function codexState(status: string | undefined, done: boolean): UAEvent['state'] {
  if (status === 'failed') return 'failed'
  if (status === 'completed') return 'success'
  if (status === 'in_progress') return 'running'
  return done ? 'success' : 'running'
}

/**
 * Doc4 — parse a codex `update_plan` tool-call's arguments into normalized plan
 * steps. Arguments come as a JSON string (or already-object) with a `plan` array
 * of `{ step, status }`. Returns null when there's no usable plan.
 */
function parsePlanArgs(
  raw: any
): { steps: { text: string; status: 'pending' | 'in_progress' | 'completed' }[]; explanation?: string } | null {
  let obj = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const plan = obj?.plan ?? obj?.steps
  if (!Array.isArray(plan) || !plan.length) return null
  const steps = plan.map((s: any) => ({
    text: typeof s === 'string' ? s : s?.step ?? s?.text ?? s?.content ?? '',
    status: normPlanStatus(s?.status)
  }))
  return { steps, explanation: typeof obj?.explanation === 'string' ? obj.explanation : undefined }
}

/**
 * Doc4 — parse a claude `TodoWrite` tool-call's `todos` into normalized plan
 * steps. Each todo carries `{ content, status, activeForm }`; we keep activeForm
 * so the in-progress step can show its present-tense phrasing.
 */
function parseTodoWrite(
  input: any
): { text: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[] {
  const todos = input?.todos
  if (!Array.isArray(todos)) return []
  return todos.map((t: any) => ({
    text: t?.content ?? t?.text ?? '',
    status: normPlanStatus(t?.status),
    activeForm: typeof t?.activeForm === 'string' ? t.activeForm : undefined
  }))
}

/** Normalize a plan/todo status into pending | in_progress | completed. */
function normPlanStatus(s: any): 'pending' | 'in_progress' | 'completed' {
  const v = String(s ?? '').toLowerCase()
  if (v === 'completed' || v === 'complete' || v === 'done') return 'completed'
  if (v === 'in_progress' || v === 'inprogress' || v === 'active' || v === 'running') return 'in_progress'
  return 'pending'
}

/** Pull a human-readable message out of a codex/traex error/turn.failed event. */
function extractErrMessage(o: any): string {
  const raw = o.message ?? o.error?.message ?? JSON.stringify(o)
  try {
    const parsed = JSON.parse(raw)
    return parsed?.error?.message || raw
  } catch {
    return raw
  }
}

/**
 * Map the selected reasoning effort to per-agent CLI flags.
 * codex/traex: `-c model_reasoning_effort="<effort>"`.
 * claude:      `--effort <effort>`.
 * `effort` is only ever a value the model advertised (validated in the UI),
 * so no mapping/clamping is needed here — we pass it through verbatim.
 */
function effortFlags(agent: AgentDef, effort: ReasoningEffort | undefined): string[] {
  if (!effort) return []
  if (agent.adapter === 'codex' || agent.adapter === 'traex') {
    return ['-c', `model_reasoning_effort="${effort}"`]
  }
  if (agent.adapter === 'claude') {
    return ['--effort', effort]
  }
  return []
}

/**
 * 需求9 — Codex 快速模式 on the one-shot `exec` path. Codex reads the "Fast"
 * (1.5× priority) tier from `service_tier`; the app-server path sends it as a
 * turn param, but `exec` takes it as a config override. Only codex honors it;
 * traex/claude get nothing so their commands are unchanged.
 */
function fastFlags(agent: AgentDef, fastMode: boolean | undefined): string[] {
  if (agent.adapter !== 'codex') return []
  return ['-c', `service_tier="${fastMode ? 'priority' : 'default'}"`]
}

/** TraeX one-shot Max variant. Off is represented by absence (the CLI default). */
export function traexMaxFlags(agent: AgentDef, maxMode: boolean | undefined): string[] {
  return traexMaxConfigFlags(agent.adapter, maxMode)
}

/**
 * Map a logical permission-mode id to a codex/traex sandbox policy (`-s`).
 * Values are exactly the CLI's accepted enum: read-only | workspace-write |
 * danger-full-access. Shared with the app-server (streaming) adapter, which
 * derives its approvalPolicy/reviewer separately. `plan` is read-only (its
 * plan-ness is applied out-of-band: streaming via thread/settings/update, exec
 * via a plan-oriented instruction prefix).
 */
export function codexSandbox(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
    case 'read-only':
      return 'read-only'
    case 'ask':
    case 'approve-for-me':
    case 'auto-edit':
      return 'workspace-write'
    case 'full-access':
      return 'danger-full-access'
    default:
      return 'read-only'
  }
}

function requirePermissionMode(config: SessionConfig, agent: AgentDef): PermissionMode {
  const mode = config.permissionMode
  if (!mode) throw new Error(`${agent.name} 缺少有效权限模式`)
  if (!agent.capabilities.permissionModes.some((entry) => entry.id === mode)) {
    throw new Error(`${agent.name} 不支持权限模式：${mode}`)
  }
  return mode
}

/**
 * One-shot `exec` permission flags for codex/traex. The exec path is HEADLESS —
 * it cannot surface interactive approvals — so `ask`/`approve-for-me` degrade to
 * a workspace-write sandbox that just proceeds (real approval routing only
 * exists on the streaming app-server path). Runtime-verified constraints:
 *  - codex: `--approve-for-me` cannot be combined with `-s`; there is no `-a` on
 *    exec; full-access needs `--dangerously-bypass-approvals-and-sandbox`.
 *  - traex: exec rejects `--permission-mode plan|default|auto`; only sandbox
 *    flags (+ `-y` for full bypass) work headlessly.
 */
function execPermissionFlags(adapter: AgentDef['adapter'], mode: PermissionMode): string[] {
  if (adapter === 'codex') {
    // approve-for-me is a standalone flag (mutually exclusive with -s) that runs
    // the workspace-write sandbox behind an automatic reviewer.
    if (mode === 'approve-for-me') return ['--approve-for-me']
    if (mode === 'full-access') {
      return ['-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox']
    }
    return ['-s', codexSandbox(mode)]
  }
  // traex
  if (mode === 'full-access') {
    return ['-s', 'danger-full-access', '-y']
  }
  return ['-s', codexSandbox(mode)]
}

/**
 * A plan-oriented instruction prefix for the one-shot exec path (codex/traex),
 * which has no native plan mode there. It constrains the turn to read-only
 * analysis + a written plan, mirroring the spirit of codex's built-in Plan Mode
 * developer instructions without the interactive request_user_input protocol.
 */
const PLAN_EXEC_PREFIX =
  '【计划模式】只读探索，不要修改任何文件、不要执行有副作用的命令。请先分析现状，' +
  '然后输出一份清晰、分步、可执行的实施计划（每步说明目的与涉及的文件/改动），供人工审阅后再实施。\n\n'

/** Map a logical permission-mode id to a claude `--permission-mode` preset. */
function claudePermission(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
    case 'read-only':
      // claude has no pure read-only档; plan is its read-only-style analysis mode.
      return 'plan'
    case 'ask':
      return 'manual'
    case 'auto-edit':
      return 'acceptEdits'
    case 'approve-for-me':
      return 'auto'
    case 'deny-unapproved':
      return 'dontAsk'
    case 'full-access':
      return 'bypassPermissions'
    default:
      return 'plan'
  }
}

function developerInstructions(config: SessionConfig, sessionId?: string): string {
  return [
    uniAgentSessionInstructions(),
    assistantIdentity(config.assistantSnapshot),
    worktreeInstructions(config),
    requirementInstructions(config),
    config.roleSnapshot?.instructions?.trim(),
    teamRuntime(sessionId)?.instructions
  ].filter(Boolean).join('\n\n')
}

function roleToolPolicy(config: SessionConfig):
  | { mode: 'allow-only' | 'deny-only'; tools: string[] }
  | undefined {
  const policy = config.roleSnapshot?.toolPolicy
  if (!policy) return undefined
  const tools = [...new Set(policy.tools.map((tool) => tool.trim()).filter(Boolean))]
  return tools.length > 0 || policy.mode === 'allow-only' ? { mode: policy.mode, tools } : undefined
}

function traexRoleToolFlags(config: SessionConfig): string[] {
  const policy = roleToolPolicy(config)
  if (!policy) return []
  const flag = policy.mode === 'allow-only' ? '--allowed-tool' : '--disallowed-tool'
  return policy.tools.flatMap((tool) => [flag, tool])
}

/** CLI flags for project roots beyond the primary working directory. */
export function additionalDirectoryArgs(primary: string, directories: readonly string[] | undefined): string[] {
  return normalizedAdditionalDirectories(primary, directories).flatMap((directory) => ['--add-dir', directory])
}

export function appServerAdditionalDirectoryArgs(
  primary: string,
  directories: readonly string[] | undefined
): string[] {
  const roots = normalizedAdditionalDirectories(primary, directories)
  return roots.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`] : []
}

function normalizedAdditionalDirectories(primary: string, directories: readonly string[] | undefined): string[] {
  return [...new Set((directories || []).filter((directory) => !!directory && directory !== primary))]
}

/** Build the argv + env for a given agent + config + prompt. */
export function buildCommand(
  agent: AgentDef,
  config: SessionConfig,
  prompt: string,
  resumeId?: string,
  attachments?: Attachment[],
  callerSessionId?: string,
  fork?: ClaudeForkOrigin,
  interactiveClaude = false
): { cmd: string; args: string[]; env: Record<string, string>; appendedPrompt?: string } {
  if (fork && (agent.adapter !== 'claude' || resumeId || !fork.sessionId || !fork.messageId)) {
    throw new Error('原生消息分叉参数不匹配，已停止续写')
  }
  const permissionMode = requirePermissionMode(config, agent)
  const env: Record<string, string> = {}
  // Images are attached via `-i <FILE>` on codex/traex/claude. Non-image files
  // are inlined into the prompt as a path reference the agent can open.
  const images = (attachments || []).filter((a) => a.kind === 'image').map((a) => a.path)
  const files = (attachments || []).filter((a) => a.kind === 'file')
  const promptWithFiles =
    files.length > 0
      ? `${prompt}\n\n附件文件:\n${files.map((f) => `- ${f.path}`).join('\n')}`
      : prompt

  if (agent.adapter === 'codex' || agent.adapter === 'traex') {
    // Plan mode has no native exec equivalent (codex Plan Mode lives on the
    // streaming app-server; traex exec rejects --permission-mode plan). Degrade
    // gracefully by constraining the turn with a plan-oriented instruction
    // prefix on top of a read-only sandbox (see execPermissionFlags).
    const execPrompt =
      permissionMode === 'plan' ? PLAN_EXEC_PREFIX + promptWithFiles : promptWithFiles
    const instructions = developerInstructions(config, callerSessionId)
    // exec resume keeps the native thread. It re-accepts -m and -i, but not the
    // sandbox flag (the thread's policy is fixed at creation); effort still
    // rides on -c model_reasoning_effort.
    if (resumeId) {
      const args = ['exec', 'resume', resumeId, '--json', '--skip-git-repo-check']
      args.push(...additionalDirectoryArgs(config.workdir, config.additionalDirectories))
      if (agent.capabilities.modelSelect && config.model) args.push('-m', config.model)
      if (agent.capabilities.reasoningEffort) args.push(...effortFlags(agent, config.effort))
      args.push(...fastFlags(agent, config.fastMode))
      args.push(...traexMaxFlags(agent, config.maxMode))
      args.push('-c', `developer_instructions=${JSON.stringify(instructions)}`)
      if (agent.adapter === 'traex') args.push(...traexRoleToolFlags(config))
      if (permissionMode === 'full-access') {
        args.push('--dangerously-bypass-approvals-and-sandbox')
      }
      // Doc11: inject the handoff MCP server so a resumed turn can also 交接 tasks.
      args.push(...handoffMcpArgs(agent.adapter, callerSessionId))
      for (const img of images) args.push('-i', img)
      args.push(execPrompt)
      return { cmd: agent.bin, args, env, appendedPrompt: instructions }
    }
    const args = ['exec', '--json', '--skip-git-repo-check']
    // Per-mode sandbox/approval flags (codex & traex differ; see execPermissionFlags).
    args.push(...execPermissionFlags(agent.adapter, permissionMode))
    if (agent.capabilities.modelSelect && config.model) {
      args.push('-m', config.model)
    }
    if (agent.capabilities.reasoningEffort) {
      args.push(...effortFlags(agent, config.effort))
    }
    args.push(...fastFlags(agent, config.fastMode))
    args.push(...traexMaxFlags(agent, config.maxMode))
    args.push('-c', `developer_instructions=${JSON.stringify(instructions)}`)
    if (agent.adapter === 'traex') args.push(...traexRoleToolFlags(config))
    // Doc11: inject the handoff MCP server (create_uniagent_task) into the turn.
    args.push(...handoffMcpArgs(agent.adapter, callerSessionId))
    args.push('-C', config.workdir)
    args.push(...additionalDirectoryArgs(config.workdir, config.additionalDirectories))
    for (const img of images) args.push('-i', img)
    args.push(execPrompt)
    return { cmd: agent.bin, args, env, appendedPrompt: instructions }
  }

  if (agent.adapter === 'claude') {
    const args = ['--print', '--output-format', 'stream-json', '--verbose']
    if (config.roleSnapshot) {
      const unavailable = claudeRoleUnavailableReason(agent, config.roleSnapshot)
      if (unavailable) throw new Error(unavailable)
      if (!interactiveClaude && (config.roleSnapshot.skills !== undefined || config.roleSnapshot.toolPolicy)) {
        throw new Error('Claude 角色限制必须通过交互 stream-json 初始化后执行')
      }
      if (config.roleSnapshot.skills !== undefined || config.roleSnapshot.toolPolicy) {
        // Simple mode skips SDK hooks, which enforce the MCP and child-agent policy.
        env.CLAUDE_CODE_SIMPLE = '0'
      }
    }
    if (interactiveClaude) args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--replay-user-messages')
    // Token-level streaming: emit per-token content_block deltas when the CLI
    // supports it (detected at startup → capabilities.streaming).
    if (agent.capabilities.streaming) args.push('--include-partial-messages')
    if (supportsClaudeRoleProtocol(agent.version)) args.push('--forward-subagent-text')
    if (config.model) args.push('--model', config.model)
    if (agent.capabilities.reasoningEffort && config.effort) {
      args.push('--effort', config.effort)
    }
    const instructions = developerInstructions(config, callerSessionId)
    args.push('--append-system-prompt', instructions)
    const toolPolicy = roleToolPolicy(config)
    if (toolPolicy) {
      if (toolPolicy.mode === 'allow-only') args.push('--tools', toolPolicy.tools.filter((tool) => !tool.startsWith('mcp__')).join(','))
      else args.push('--disallowedTools', toolPolicy.tools.join(','))
    }
    const deniedTools = [
      ...(config.roleSnapshot?.skills !== undefined ? ['Agent', 'Task'] : []),
      ...(toolPolicy?.mode === 'allow-only' && !toolPolicy.tools.some((tool) => tool.startsWith('mcp__')) ? ['mcp__*'] : [])
    ]
    if (deniedTools.length) {
      const index = args.indexOf('--disallowedTools')
      if (index >= 0) args[index + 1] += `,${deniedTools.join(',')}`
      else args.push('--disallowedTools', deniedTools.join(','))
    }
    if (config.roleSnapshot?.skills?.length === 0) args.push('--disable-slash-commands')
    args.push('--permission-mode', claudePermission(permissionMode))
    if (resumeId) args.push('--resume', resumeId)
    if (fork) args.push('--resume', fork.sessionId, '--fork-session', '--resume-session-at', fork.messageId)
    const additionalDirectories = normalizedAdditionalDirectories(config.workdir, config.additionalDirectories)
    if (additionalDirectories.length) args.push('--add-dir', ...additionalDirectories)
    // Doc11: inject the handoff MCP server so claude turns can 交接 tasks too.
    args.push(...handoffMcpArgs(agent.adapter, callerSessionId))
    // Claude Code has no image flag on the print path; it reads attachments by
    // path from the prompt text, so fold both images and files into the prompt.
    const claudePrompt =
      attachments && attachments.length > 0
        ? `${prompt}\n\n附件:\n${attachments.map((a) => `- ${a.path}`).join('\n')}`
        : prompt
    if (!interactiveClaude) args.push('--', claudePrompt)
    return { cmd: agent.bin, args, env, appendedPrompt: instructions }
  }

  // generic fallback: run as a plain command (unused for built-ins).
  return { cmd: agent.bin, args: [promptWithFiles], env }
}

/**
 * 修复#5 — drop noisy, purely-advisory config-loader notices the user never wants
 * to see (they aren't actionable and clutter the timeline / call chain). Currently
 * the "Ignoring malformed agent role definition: duplicate agent role name …"
 * chatter emitted while the CLI de-dupes bundled agent roles.
 */
function isIgnorableNotice(text?: unknown): boolean {
  if (typeof text !== 'string') return false
  return isHiddenAgentWarning(text) ||
    /Ignoring malformed agent role definition|duplicate agent role name/i.test(text)
}

/**
 * Normalize a Codex/TraeX `exec --json` turn.completed usage into TurnUsage
 * (Doc5 T1). Non-streaming exec already reports per-turn totals, so we use them
 * directly (input_tokens / cached_input_tokens / output_tokens).
 */
function normalizeExecUsage(u: any, modelId?: string): any {
  if (!u) return undefined
  const inputTokens = u.input_tokens ?? u.inputTokens ?? 0
  const outputTokens = u.output_tokens ?? u.outputTokens ?? 0
  const cachedInputTokens = u.cached_input_tokens ?? u.cachedInputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    contextTokens: inputTokens,
    modelId,
    cost: computeCost({ inputTokens, outputTokens, cachedInputTokens }, modelId),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: u.total_tokens ?? inputTokens + outputTokens,
    cached_input_tokens: cachedInputTokens
  }
}

/**
 * Normalize a Claude `result.usage` into TurnUsage (Doc5 T1). Claude reports
 * per-turn totals with cache read + creation split out; cache_read counts as
 * the cached-hit input subset. Claude also gives an authoritative dollar figure
 * (total_cost_usd) which we trust over our own price table when present.
 * The totals sum every API call in the turn, so occupancy comes from the last
 * main-thread call and the window from the CLI-reported `modelUsage`.
 */
function normalizeClaudeUsage(
  u: any,
  modelId?: string,
  costUsd?: number,
  lastCall?: { usage: any; model?: string },
  modelUsage?: Record<string, any>
): any {
  if (!u) return undefined
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheCreate = u.cache_creation_input_tokens ?? 0
  const inputTokens = (u.input_tokens ?? 0) + cacheRead + cacheCreate
  const outputTokens = u.output_tokens ?? 0
  const cachedInputTokens = cacheRead
  const cost =
    typeof costUsd === 'number'
      ? costUsd
      : computeCost({ inputTokens, outputTokens, cachedInputTokens }, modelId)
  const last = lastCall?.usage
  const usedModels = Object.values(modelUsage ?? {})
  const callModel = (lastCall?.model && modelUsage?.[lastCall.model]) ||
    (usedModels.length === 1 ? usedModels[0] : undefined)
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    contextTokens: last
      ? (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0)
      : inputTokens,
    contextWindow: callModel?.contextWindow,
    modelId,
    cost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cached_input_tokens: cachedInputTokens
  }
}
