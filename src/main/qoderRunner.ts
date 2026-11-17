import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentDef, Attachment, ClaudeForkOrigin, SessionConfig, TurnUsage, UAEvent } from '../shared/types'
import type { GoalState, NativeReviewDraft } from '../shared/nativeCapabilities'
import { TurnRunner, developerInstructions } from './adapter.ts'
import { nativeCredentialEnv } from './agentSetupCredentials'
import { QoderSdkClient, qoderLaunch, qoderRegionForBin, qoderToolCall } from './qoderSdk.ts'
import { handoffMcpArgs } from './handoff.ts'
import { prepareAssistantMessage, prepareAssistantInitializationForSession, assistantInitialization, serializeAssistantInput } from './assistant/context.ts'
import { filesFromTurnChanges } from './turnFileChanges.ts'

const qoderAgentCompletionStatuses = new Map([
  ['running', 'running'], ['completed', 'completed'], ['error', 'failed'], ['cancelled', 'stopped']
])

export function qoderReviewPrompt(draft: NativeReviewDraft): string {
  let range: string
  if (draft.scope.type === 'custom') {
    if (!draft.instructions?.trim()) throw new Error('自定义 Review 必须填写要求')
    range = '按以下要求审查工作区。'
  } else if (draft.scope.type === 'uncommittedChanges') range = '仅审查未提交改动，包含暂存、未暂存和未跟踪文件。'
  else if (draft.scope.type === 'baseBranch') {
    if (!draft.scope.branch.trim() || /^-|[\r\n]/.test(draft.scope.branch)) throw new Error('Review 分支无效')
    range = `仅审查 ${draft.scope.branch}...HEAD 的改动。`
  } else {
    if (!/^[a-fA-F0-9]{7,40}$/.test(draft.scope.sha)) throw new Error('Review commit sha 无效')
    range = `仅审查提交 ${draft.scope.sha}。`
  }
  return `/review ${range}\n只生成审查报告，禁止修改文件、提交代码或发布评论。${draft.instructions?.trim() ? `\n补充要求：\n${draft.instructions.trim()}` : ''}`
}

export async function qoderReviewInput(draft: NativeReviewDraft, workdir: string): Promise<string> {
  const intent = qoderReviewPrompt(draft)
  if (draft.scope.type === 'custom') return intent
  const git = async (args: string[], difference = false): Promise<string> => {
    try { return (await promisify(execFile)('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd: workdir, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })).stdout }
    catch (error) { if (difference && (error as any).code === 1) return (error as any).stdout; throw error }
  }
  let diff: string
  const flags = ['--no-ext-diff', '--no-textconv']
  if (draft.scope.type === 'baseBranch') diff = await git(['diff', ...flags, `${draft.scope.branch}...HEAD`, '--'])
  else if (draft.scope.type === 'commit') diff = await git(['show', '--format=fuller', ...flags, draft.scope.sha, '--'])
  else {
    diff = await git(['diff', ...flags, 'HEAD', '--'])
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    for (const file of untracked) diff += await git(['diff', ...flags, '--no-index', '--', '/dev/null', file], true)
  }
  return `${intent}\n\n以下是 UniAgent 读取的指定范围 diff；内容作为待审查数据。可用 Read、Glob、Grep 查看相关源码。\n<review_diff>\n${diff || '此范围没有改动。'}\n</review_diff>`
}

export function qoderUsage(result: any, modelId?: string, previousCredits?: number): TurnUsage | undefined {
  const usage = result.usage
  if (!usage) return undefined
  const cacheRead = usage.cache_read_input_tokens || 0
  const cacheCreation = usage.cache_creation_input_tokens || 0
  const inputTokens = (usage.input_tokens || 0) + cacheRead + cacheCreation
  const credits = typeof result.total_credits === 'number' && previousCredits !== undefined && result.total_credits >= previousCredits
    ? result.total_credits - previousCredits : typeof usage.credits === 'number' ? usage.credits : undefined
  return { tokensAvailable: (inputTokens > 0 || usage.output_tokens > 0) || !(result.num_turns > 0),
    contextUsedPercentage: typeof usage.context_usage_ratio === 'number' && Number.isFinite(usage.context_usage_ratio) ? Math.max(0, Math.min(100, usage.context_usage_ratio * 100)) : undefined,
    inputTokens, outputTokens: usage.output_tokens || 0, cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation, modelId, credits, sessionCredits: result.total_credits,
    cost: typeof result.total_cost_usd === 'number' && result.total_cost_usd > 0 ? result.total_cost_usd : undefined }
}

export function projectQoderGoal(snapshot: any, previous?: GoalState): GoalState | undefined {
  if (!snapshot) return undefined
  if (typeof snapshot.objective !== 'string' || typeof snapshot.status !== 'string') throw new Error('Qoder Goal 返回格式无效')
  const status = snapshot.status === 'usage_limited' ? 'usageLimited' : snapshot.status === 'budget_limited' ? 'budgetLimited' : snapshot.status
  if (!['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(status)) throw new Error('Qoder Goal 状态无效')
  return { objective: snapshot.objective, status, tokenBudget: previous?.tokenBudget ?? null, tokensUsed: previous?.tokensUsed || 0,
    timeUsedSeconds: snapshot.time_used_seconds || 0, createdAt: snapshot.created_at, updatedAt: snapshot.updated_at,
    continuation: 'native', autonomous: status === 'active', nativeActivation: 'armed',
    roundLimit: { maxRounds: snapshot.max_turns ?? null, roundsStarted: snapshot.turns_used || 0 },
    creditsBudget: snapshot.credits_budget, creditsUsed: snapshot.credits_used, tokensAvailable: previous?.tokensAvailable ?? false }
}

/** Qoder owns execution; Claude and Qoder share only the SDK message projection. */
export class QoderRunner extends TurnRunner {
  private active = false
  private serial = 0
  private key?: string
  private credits?: number
  private goal?: GoalState
  private finishing?: Promise<void>
  private initializing?: Promise<any>
  private stopped = false
  private sourceMessageId?: string
  private goalVersion = 0
  private reviewing = false
  private budgetStop?: GoalState
  private tasksByTool = new Map<string, string>()
  private agentCalls = new Map<string, { description?: string; prompt?: string; subagentType?: string; parentToolUseId?: string }>()
  private tasksByOutput = new Map<string, string>()
  private nativeTaskIds = new Map<string, string>()

  protected override emitEvent(event: Omit<UAEvent, 'sessionId' | 'seq' | 'ts'>): void {
    if (this.sourceMessageId && (event.type === 'agent_message' || event.type === 'reasoning')) event = { ...event, payload: { ...event.payload, nativeMessageId: this.sourceMessageId } }
    super.emitEvent(event)
  }

  protected override sdkResultUsage(result: any): TurnUsage | undefined {
    const usage = qoderUsage(result, this.modelId, this.credits)
    this.credits = result.total_credits
    return usage
  }

  async initialize(agent: AgentDef, config: SessionConfig, resumeId?: string): Promise<any> {
    if (this.mainContext) await prepareAssistantInitializationForSession(this.sessionId, config, resumeId)
    const key = JSON.stringify([agent.bin, agent.version, config, this.reviewing, assistantInitialization(this.sessionId)])
    if (this.sdk && this.key === key) {
      const sdk = this.sdk
      await sdk.request('reloadPlugins')
      await sdk.request('reloadSkills')
      return sdk.ready
    }
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      await this.disposeClaudeSdk()
      if (this.stopped) throw new Error('Qoder 会话已停止')
      const flags = handoffMcpArgs('qoder', this.sessionId)
      const mcpServers = flags.length ? JSON.parse(flags[1]).mcpServers : {}
      const sdk = this.sdk = new QoderSdkClient(qoderLaunch(agent.bin, config, developerInstructions(config, this.sessionId), mcpServers, resumeId, nativeCredentialEnv(qoderRegionForBin(agent.bin) === 'cn' ? 'qoder-cn' : 'qoder'), this.reviewing))
      this.key = key
      this.credits = resumeId ? undefined : 0
      sdk.on('message', message => { if (this.sdk === sdk) this.acceptMessage(message) })
      sdk.on('fileChange', payload => { if (this.sdk === sdk) this.emitEvent({ type: 'file_change', state: 'success', payload }) })
      sdk.on('approval', value => this.approve(value))
      sdk.on('approvalCancelled', wireId => {
        const requestId = `qoder-${wireId}`
        if (this.claudeRequests.delete(requestId)) this.emitEvent({ type: 'approval_request', state: 'cancelled', payload: { requestId, resolved: true, interactionExpired: true } })
      })
      sdk.on('failure', error => { if (this.sdk === sdk) { this.claudeResultFailed = true; this.emitEvent({ type: 'error', state: 'failed', payload: { message: String(error) } }); void this.finish() } })
      sdk.on('ended', () => { if (this.sdk === sdk && this.active) { this.claudeResultFailed = true; void this.finish() } })
      const initialized = await sdk.ready
      this.emit('capabilities', initialized)
      return initialized
    })().finally(() => { this.initializing = undefined })
    return this.initializing
  }

  override start(agent: AgentDef, config: SessionConfig, prompt: string, resumeId?: string, attachments?: Attachment[], fork?: ClaudeForkOrigin): void {
    if (this.active) throw new Error('Qoder 当前已有回合正在运行')
    if (fork) throw new Error('Qoder 分叉必须先通过原生 forkSession 创建独立会话')
    this.active = true; this.stopped = false
    this.reviewing = /^\/review(?:\s|$)/.test(prompt.trimStart())
    const serial = ++this.serial
    this.prepareSdkProjection(config, prompt.trim() === '/compact')
    void (async () => {
      try {
        await this.initialize(agent, config, resumeId)
        if (serial !== this.serial || this.interrupted || !this.sdk) return
        await serializeAssistantInput(this.messageDeliveryKey(), async () => {
          const delivery = await prepareAssistantMessage(this.sessionId, config, prompt, '', true, this.mainContext)
          const content = delivery.content
          if (serial !== this.serial || this.interrupted || !this.sdk) return
          const uuid = randomUUID()
          this.emitEvent({ type: 'system_notice', payload: { kind: 'launch', label: agent.name, model: config.model, text: `启动：Qoder SDK · ${agent.bin}` } })
          this.emitEvent({ type: 'turn_started', payload: { turnId: uuid, sessionId: this.nativeSessionId, model: config.model } })
          await this.sdk.request('send', { uuid, content, attachments, waitForReplay: true })
          delivery.accepted()
        })
      } catch (error) {
        if (serial !== this.serial || this.interrupted) return
        this.claudeResultFailed = true
        this.emitEvent({ type: 'error', state: 'failed', payload: { message: `Qoder 初始化或执行失败：${String(error)}` } })
        await this.disposeClaudeSdk(); await this.finish()
      }
    })()
  }

  private projectAgentMessage(message: any): any {
    const blocks: Array<Record<string, unknown>> = Array.isArray(message.message?.content)
      ? message.message.content.filter((block: unknown): block is Record<string, unknown> =>
        typeof block === 'object' && block !== null && !Array.isArray(block)) : []
    if (message.type === 'assistant') {
      for (const block of blocks) if (block.type === 'tool_use' && block.name === 'Agent' && typeof block.id === 'string') {
        const input = typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
          ? block.input as Record<string, unknown> : {}
        this.agentCalls.set(block.id, {
          description: typeof input.description === 'string' ? input.description : undefined,
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
          parentToolUseId: typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined
        })
      }
    } else if (message.type === 'system' && ['task_started', 'task_updated', 'task_progress', 'task_notification'].includes(message.subtype)) {
      const taskId = this.tasksByTool.get(message.tool_use_id) || this.tasksByOutput.get(message.output_file) || this.nativeTaskIds.get(message.task_id)
      if (typeof message.task_id === 'string' && message.task_id) {
        const id = taskId || message.task_id
        this.nativeTaskIds.set(message.task_id, id)
        if (message.tool_use_id) this.tasksByTool.set(message.tool_use_id, id)
        if (taskId) return { ...message, task_id: taskId }
      }
    } else if (message.type === 'user') {
      const receipt = message.tool_use_result
      if (typeof receipt?.agentId !== 'string' || !receipt.agentId) return message
      const results = blocks.filter(block => block.type === 'tool_result')
      if (results.length !== 1 || typeof results[0].tool_use_id !== 'string') return message
      const toolUseId = results[0].tool_use_id
      const previousTaskId = this.tasksByTool.get(toolUseId)
      const call = this.agentCalls.get(toolUseId)
      const background = receipt.isAsync === true && receipt.status === 'async_launched'
      const status = background ? 'running' : receipt.kind === 'agent-result'
        ? qoderAgentCompletionStatuses.get(receipt.state) : undefined
      if (call && status && !results[0].is_error) {
        // The real Agent receipt's agentId is accepted by native stopTask and history.
        // Keep an earlier task_started identity when present so its card stays unique.
        const taskId = previousTaskId || receipt.agentId
        this.tasksByTool.set(toolUseId, taskId)
        const output = background ? receipt.outputFile : receipt.outputPath
        if (typeof output === 'string' && output) this.tasksByOutput.set(output, taskId)
        if (!background || !previousTaskId) this.parseClaude({
          type: 'system', subtype: 'task_updated', task_id: taskId, tool_use_id: toolUseId,
          parent_task_id: call.parentToolUseId ? this.tasksByTool.get(call.parentToolUseId) : undefined,
          subagent_type: typeof receipt.agentType === 'string' ? receipt.agentType : call.subagentType,
          description: typeof receipt.description === 'string' ? receipt.description : call.description,
          prompt: typeof receipt.prompt === 'string' ? receipt.prompt : call.prompt,
          summary: typeof receipt.content === 'string' ? receipt.content : undefined,
          patch: { status }
        })
        this.setSdkSubagentHistoryId(taskId, receipt.agentId)
      } else if (previousTaskId) this.setSdkSubagentHistoryId(previousTaskId, receipt.agentId)
    }
    return message
  }

  // Public for transcript replay and behavior tests; does not submit model input.
  acceptMessage(message: any): void {
    this.sourceMessageId = message.type === 'assistant' ? message.uuid : undefined
    message = this.projectAgentMessage(message)
    if (message.type === 'system' && message.subtype === 'goal_updated') {
      this.goalVersion++
      this.goal = projectQoderGoal(message.goal, this.goal)
      if (this.budgetStop) this.goal = { ...this.budgetStop, ...this.goal, status: this.budgetStop.status, blockedReason: this.budgetStop.blockedReason, autonomous: false }
      this.emit('goalChanged', this.goal)
      if (this.goal?.status !== 'active' && this.goal?.status !== 'complete') void this.finish()
    } else if (message.type === 'system' && message.subtype === 'goal_cleared') {
      this.goalVersion++
      this.goal = this.budgetStop; this.emit('goalChanged', this.goal); void this.finish()
    } else if (message.type === 'system' && message.subtype === 'session_title_changed') this.emit('titleChanged', message.title)
    else if (message.type === 'system' && message.subtype === 'plan_mode_changed') this.emit('planModeChanged', message.plan_mode)
    else if (message.type === 'tool_progress' && message.tool_name === 'Bash' && !message.parent_tool_use_id && message.phase !== 'ended') this.emitEvent({ type: 'command_exec', state: 'running', payload: { id: message.tool_use_id, output: message.output } })
    else {
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) message = { ...message, message: { ...message.message,
        content: message.message.content.map((block: any) => block.type === 'tool_use' && block.input ? { ...block, ...qoderToolCall(block.name, block.input) } : block) } }
      this.parseClaude(message)
      if (message.type === 'result') {
        if (this.goal?.tokenBudget != null && message.num_turns > 0 && qoderUsage(message)?.tokensAvailable === false) {
          this.goal = { ...this.goal, status: 'blocked', tokensAvailable: false, autonomous: false, blockedReason: { code: 'token_usage_unavailable', message: 'Qoder 未提供可核验的 Token 计数，已停止预算任务' } }
          this.budgetStop = this.goal
          this.emit('goalChanged', this.goal)
          void this.stopBudgetGoal('blocked')
          return
        }
        if (this.goal?.status === 'active') {
          const usage = message.usage || {}
          this.goal = { ...this.goal, tokensAvailable: qoderUsage(message)?.tokensAvailable,
            tokensUsed: this.goal.tokensUsed + (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) }
          this.emit('goalChanged', this.goal)
          if (this.goal.tokenBudget !== null && this.goal.tokensUsed >= this.goal.tokenBudget) {
            this.goal = { ...this.goal, status: 'budgetLimited', autonomous: false, updatedAt: Date.now() }
            this.budgetStop = this.goal
            this.emit('goalChanged', this.goal)
            void this.stopBudgetGoal('paused')
          } else if (this.claudeResultFailed) void this.finish()
        } else void this.finish()
      }
    }
  }

  private approve(value: any): void {
    const requestId = `qoder-${value.requestId}`
    this.claudeRequests.set(requestId, { wireId: value.requestId, toolName: value.toolName || '', input: value.input, suggestions: value.suggestions, kind: value.kind })
    const kind = value.kind === 'elicitation' ? 'elicitation' : value.toolName === 'AskUserQuestion' ? 'question'
      : value.toolName === 'ExitPlanMode' ? 'planMode' : value.toolName === 'Bash' ? 'command' : ['Edit', 'Write', 'NotebookEdit'].includes(value.toolName) ? 'fileChange' : 'approval'
    this.emitEvent({ type: 'approval_request', state: 'pending', payload: { requestId, kind, method: 'qoder/canUseTool', params: kind === 'command'
      ? { command: value.input.command, cwd: this.claudeWorkdir } : kind === 'fileChange' ? { changes: [{ path: value.input.file_path }] } : value.input } })
  }

  private async stopBudgetGoal(status: 'blocked' | 'paused'): Promise<void> {
    const sdk = this.sdk
    try { await sdk?.request('setGoal', { status }); await sdk?.request('interrupt') }
    catch (error) { this.emitEvent({ type: 'error', state: 'failed', payload: { message: `Qoder 预算停止未确认：${String(error)}` } }); await sdk?.close() }
    finally { await this.finish() }
  }

  private finish(): Promise<void> {
    if (this.finishing) return this.finishing
    if (!this.active) return Promise.resolve()
    this.active = false
    this.finishing = (async () => {
      this.flushDeltas()
      for (const [requestId] of this.claudeRequests) this.emitEvent({ type: 'approval_request', state: 'cancelled', payload: { requestId, resolved: true, interactionExpired: true } })
      this.claudeRequests.clear()
      if (this.claudeCompact && !this.claudeCompactDone) { this.claudeResultFailed = true; this.emitEvent({ type: 'context_compaction', state: 'failed', payload: { id: 'qoder-compact', error: 'Qoder 未报告压缩完成' } }) }
      if (this.claudeFileEvents.length) {
        const files = await filesFromTurnChanges(this.claudeFileEvents, this.claudeWorkdir).catch(() => [])
        const diff = files.map(file => file.unifiedDiff).filter(Boolean).join('')
        if (diff) this.emitEvent({ type: 'diff_update', payload: { diff } })
      }
      this.emitEvent({ type: 'turn_completed', state: this.interrupted ? 'cancelled' : this.claudeResultFailed ? 'failed' : 'success', payload: {} })
      this.emit('done', { nativeSessionId: this.nativeSessionId, interrupted: this.interrupted, failed: this.claudeResultFailed })
      this.scheduleClaudeIdleClose(() => this.active)
    })().finally(() => { this.finishing = undefined })
    return this.finishing
  }

  override interrupt(): void { void this.stopClaudeSdk() }
  override async stopClaudeSdk(): Promise<void> {
    this.interrupted = true; this.stopped = true
    await this.sdk?.request('interrupt', undefined, 3_000).catch(() => {})
    if (this.goal?.status === 'active') { await this.sdk?.request('setGoal', { status: 'paused' }).catch(() => {}); this.goal = { ...this.goal, status: 'paused', autonomous: false }; this.emit('goalChanged', this.goal) }
    await this.disposeClaudeSdk(); await this.finish()
  }
  override async disposeClaudeSdk(): Promise<void> { this.key = undefined; await super.disposeClaudeSdk() }
  override async steer(): Promise<void> { throw new Error('Qoder next/now 不等同于 Codex 严格同回合插话，请使用立即转向或队列') }
  override configureClaudeGoal(goal: GoalState | undefined): void { this.goal = goal ? structuredClone(goal) : undefined; this.budgetStop = undefined }
  override async clearClaudeGoal(): Promise<void> { this.budgetStop = undefined; await this.control('clearGoal'); this.goal = undefined; this.emit('goalChanged', undefined) }
  async control(method: string, args?: unknown): Promise<any> {
    if (!this.sdk) throw new Error('Qoder 会话尚未初始化')
    return this.sdk.request(method, args)
  }
  async activateGoal(agent: AgentDef, config: SessionConfig, goal: GoalState, resumeId?: string, resume = false): Promise<GoalState> {
    this.stopped = false; this.reviewing = false; this.budgetStop = undefined; this.prepareSdkProjection(config)
    if (goal.tokenBudget != null) {
      this.goal = { ...goal, status: 'blocked', tokensAvailable: false, autonomous: false,
        blockedReason: { code: 'token_usage_unavailable', message: 'Qoder 未提供可核验的 Token 计数，预算任务未启动' } }
      this.budgetStop = this.goal; this.active = true
      this.emit('goalChanged', this.goal)
      if (this.sdk && await this.sdk.request('getGoal')) await this.stopBudgetGoal('blocked')
      else await this.finish()
      return this.goal
    }
    await this.initialize(agent, config, resumeId)
    this.goal = goal; this.active = true
    await this.control('setGoalMaxTurns', goal.roundLimit?.maxRounds ?? null)
    const version = this.goalVersion
    const snapshot = await this.control(resume ? 'resumeGoal' : 'setGoal', resume ? undefined : { objective: goal.objective, status: 'active' })
    if (version === this.goalVersion) this.goal = projectQoderGoal(snapshot, goal)
    if (!this.goal) throw new Error('Qoder 未确认目标已创建')
    this.emit('goalChanged', this.goal)
    return this.goal
  }
}
