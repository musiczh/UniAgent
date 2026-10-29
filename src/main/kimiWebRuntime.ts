import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionConfig } from '../shared/types.ts'
import type { GoalState } from '../shared/nativeCapabilities.ts'
import { assertKimiWebConfig, kimiSessionRuntimeEnv, KIMI_PERMISSION_VALUES } from './kimiRoleConfig.ts'
import type { KimiWebMcpServer } from './kimiWebRuntimeHome.ts'
import { kimiWebTranscriptEvents } from './kimiWebEventProjection.ts'
import { readKimiTranscript } from './kimiHistory.ts'
import { KimiWebError, type KimiWebTransport, type KimiWebSnapshot, type KimiWebStreamHandlers, type KimiWebSubscription } from './kimiWebTransport.ts'
import { acquireKimiWebService, type KimiWebLease } from './kimiWebService.ts'

/** Kimi Code 2.2.0 official REST surface; budgets remain model-controlled. */
export const kimiWebCapabilities = Object.freeze({ goal: true, steer: true, goalBudget: false, approvals: true, questions: true })

/** Times are caller-provided native event/first-observation times, never budgets. */
export function projectKimiWebGoal(goal: KimiWebGoal | null, timestamps: { createdAt: number; updatedAt: number }): GoalState | undefined {
  if (!goal) return undefined
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.budget.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.wallClockMs / 1000,
    ...timestamps,
    continuation: 'native',
    autonomous: goal.status === 'active',
    nativeActivation: goal.status === 'active' ? 'armed' : 'disarmed',
    roundLimit: { maxRounds: goal.budget.turnBudget, roundsStarted: goal.turnsUsed },
    ...(goal.status === 'blocked' && goal.terminalReason ? { blockedReason: { code: goal.terminalReason } } : {})
  }
}

export interface KimiWebGoal {
  goalId: string
  objective: string
  completionCriterion?: string
  status: 'active' | 'paused' | 'blocked' | 'complete'
  turnsUsed: number
  tokensUsed: number
  wallClockMs: number
  budget: {
    tokenBudget: number | null
    turnBudget: number | null
    wallClockBudgetMs: number | null
    remainingTokens: number | null
    remainingTurns: number | null
    remainingWallClockMs: number | null
    tokenBudgetReached: boolean
    turnBudgetReached: boolean
    wallClockBudgetReached: boolean
    overBudget: boolean
  }
  terminalReason?: string
}
export interface KimiWebPrompt {
  prompt_id: string
  user_message_id?: string
  status: 'running' | 'queued' | 'blocked'
  content: unknown[]
  created_at?: string
}
export interface KimiWebAgentProfile {
  model?: string
  thinking?: string
  permission_mode?: 'manual' | 'yolo' | 'auto'
  plan_mode?: boolean
  swarm_mode?: boolean
}
export type KimiWebContent = { type: 'text'; text: string } | { type: 'image'; source: { kind: 'base64'; media_type: string; data: string } } | { type: 'file'; path: string; name?: string; media_type?: string; size?: number }
export type KimiWebQuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' }
export interface KimiWebRuntimeOptions {
  bin: string
  /** Test harness/CLI launcher prefix only. Production passes the resolved kimi binary. */
  argsPrefix?: string[]
  sessionId: string
  config: SessionConfig
  nativeSessionId?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  mcpServers?: KimiWebMcpServer[]
  onUnexpectedExit?(): void
  /** Must await the previous ACP/web writer's closeAndWait before returning. */
  acquireWritableRuntime(): Promise<() => void | Promise<void>>
}

const ownedSessions = new Set<string>()

/** Owns one native session and a lease on the authenticated loopback service. */
export class KimiWebRuntime {
  nativeSessionId = ''
  get dataHome(): string | undefined { return this.lease?.home }
  get serviceReplaced(): boolean { return this.lease?.replaced === true }
  private lease?: KimiWebLease
  private subscriptions = new Set<KimiWebSubscription>()
  private transport?: KimiWebTransport
  private closing?: Promise<void>
  private closed = false
  private release?: () => void | Promise<void>
  private operations = Promise.resolve()
  private ownershipKeys: string[] = []
  private subagentTasks = new Map<string, any>()
  private constructor(private readonly options: KimiWebRuntimeOptions, private readonly ownershipKey: string) {}

  static async start(options: KimiWebRuntimeOptions): Promise<KimiWebRuntime> {
    if (!options.sessionId || options.config.agentId !== 'kimi' || typeof options.acquireWritableRuntime !== 'function') throw new KimiWebError('runtime_options_invalid')
    assertKimiWebConfig(options.config)
    const sourceHome = resolve(options.env?.KIMI_CODE_HOME || process.env.KIMI_CODE_HOME || join(options.env?.HOME || process.env.HOME || homedir(), '.kimi-code'))
    const key = sourceHome + '\0' + (options.nativeSessionId || options.sessionId)
    if (ownedSessions.has(key)) throw new KimiWebError('runtime_already_owned')
    ownedSessions.add(key)
    const runtime = new KimiWebRuntime(options, key)
    runtime.ownershipKeys.push(key)
    try {
      runtime.release = await options.acquireWritableRuntime()
      if (typeof runtime.release !== 'function') throw new KimiWebError('runtime_lease_invalid')
      if (options.mcpServers?.length) throw new KimiWebError('session_mcp_unsupported')
      const roleEnv = kimiSessionRuntimeEnv(options.sessionId, options.config)
      const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, ...roleEnv, KIMI_CODE_WATCH: 'false', NO_COLOR: '1' }
      runtime.lease = await acquireKimiWebService({ bin: options.bin, cwd: options.config.workdir, env, argsPrefix: options.argsPrefix, timeoutMs: options.timeoutMs })
      const storageKey = runtime.lease.home + '\0' + (options.nativeSessionId || options.sessionId)
      if (storageKey !== key) {
        if (ownedSessions.has(storageKey)) throw new KimiWebError('runtime_already_owned')
        ownedSessions.add(storageKey); runtime.ownershipKeys.push(storageKey)
      }
      runtime.transport = runtime.lease.transport
      const openapi = await runtime.transport.specification('/openapi.json')
      for (const [path, method] of [
        ['/api/v1/sessions/{session_id}/goal', 'get'],
        ['/api/v1/sessions/{session_id}/profile', 'post'],
        ['/api/v1/sessions/{session_id}/prompts', 'post'],
        ['/api/v1/sessions/{session_id}/prompts/{tail}', 'post']
      ]) if (!openapi.paths?.[path]?.[method]) throw new KimiWebError('official_api_unsupported')
      const asyncapi = await runtime.transport.specification('/asyncapi.json')
      if (typeof asyncapi.asyncapi !== 'string') throw new KimiWebError('official_events_unsupported')
      if (options.nativeSessionId) runtime.nativeSessionId = options.nativeSessionId
      else {
        const session = await runtime.transport.request<any>('POST', '/api/v1/sessions', { metadata: { cwd: options.config.workdir } })
        if (typeof session?.id !== 'string' || !session.id) throw new KimiWebError('session_id_invalid')
        runtime.nativeSessionId = session.id
      }
      const nativeKey = runtime.lease.home + '\0' + runtime.nativeSessionId
      if (!runtime.ownershipKeys.includes(nativeKey)) {
        if (ownedSessions.has(nativeKey)) throw new KimiWebError('runtime_already_owned')
        ownedSessions.add(nativeKey); runtime.ownershipKeys.push(nativeKey)
      }
      runtime.lease.trackSession(runtime.nativeSessionId)
      const status = await runtime.status() // Cold native sessions are loaded through the official service.
      if (options.nativeSessionId) await runtime.transport.request('POST', runtime.path('runtime'), { runtime_id: 'local' })
      if (!status.busy) await runtime.setProfile(profileFromConfig(options.config))
      return runtime
    } catch (error) {
      await runtime.closeAndWait()
      if (error instanceof KimiWebError) throw error
      throw new KimiWebError('startup')
    }
  }

  private path(resource: string): string { return `/api/v1/sessions/${encodeURIComponent(this.nativeSessionId)}/${resource}` }
  private api(): KimiWebTransport { if (this.closed || !this.transport) throw new KimiWebError('runtime_closed'); return this.transport }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => {}, () => {})
    return task
  }

  status(): Promise<any> { return this.api().request('GET', this.path('status')) }
  tools(): Promise<{ tools: any[] }> { return this.api().request('GET', `/api/v1/tools?session_id=${encodeURIComponent(this.nativeSessionId)}`) }
  snapshot(): Promise<KimiWebSnapshot> { return this.api().request('GET', this.path('snapshot')) }
  transcript(knownTurns?: ReadonlySet<string>): Promise<{ items: any[]; meta: any }> { return readKimiTranscript(this.api(), this.nativeSessionId, 'main', knownTurns) }
  async recoverySnapshot(snapshot: KimiWebSnapshot, baseline: Set<string>): Promise<KimiWebSnapshot> {
    const messages = snapshot.messages as any
    const items: any[] = [...(messages?.items || [])]
    let more = messages?.has_more === true
    const cursors = new Set<string>()
    while (more && items.length && !items.some(message => baseline.has(message.id))) {
      const before = items[0].id
      if (cursors.has(before)) throw new KimiWebError('message_cursor_repeated')
      cursors.add(before)
      const page = await this.api().request<any>('GET', this.path(`messages?before_id=${encodeURIComponent(before)}&page_size=100`))
      items.unshift(...(page.items || []).reverse())
      more = page.has_more === true
    }
    return { ...snapshot, messages: { items, has_more: more } }
  }
  models(): Promise<{ items: Array<{ model: string; capabilities?: string[]; max_context_size?: number }> }> { return this.api().request('GET', '/api/v1/models') }
  tasks(): Promise<{ items: any[] }> { return this.api().request('GET', this.path('tasks')) }
  async listSubagentTasks(): Promise<any[]> {
    const { items } = await this.tasks()
    const rows = items.filter(row => row?.session_id === this.nativeSessionId && row.kind === 'subagent' && typeof row.id === 'string' && typeof row.agent_id === 'string')
    this.subagentTasks = new Map(rows.map(row => [row.id, row]))
    return rows
  }
  async getSubagentTask(agentId: string): Promise<any> {
    const rows = (await this.listSubagentTasks()).filter(row => row.agent_id === agentId)
    if (rows.length !== 1) throw new KimiWebError('subagent_not_owned')
    const owner = rows[0]
    const task = await this.api().request<any>('GET', this.path(`tasks/${encodeURIComponent(owner.id)}?with_output=true&output_bytes=32768`))
    if (task.id !== owner.id || task.session_id !== this.nativeSessionId || task.kind !== 'subagent' || task.agent_id !== agentId || !this.subagentTasks.has(task.id)) throw new KimiWebError('subagent_identity_invalid')
    return task
  }
  async cancelSubagentTask(agentId: string): Promise<void> {
    const task = await this.getSubagentTask(agentId)
    const result = await this.api().request<any>('POST', this.path(`tasks/${encodeURIComponent(task.id)}:cancel`))
    if (result.cancelled !== true) throw new KimiWebError('subagent_cancel_unconfirmed')
  }
  async getSubagentTranscript(agentId: string, trusted?: { nativeTaskId: string; parentNativeSessionId: string }): Promise<ReturnType<typeof kimiWebTranscriptEvents>> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(agentId) || agentId === 'main') throw new KimiWebError('subagent_identity_invalid')
    const tasks = (await this.listSubagentTasks()).filter(row => row.agent_id === agentId)
    if (tasks.length) await this.getSubagentTask(agentId)
    else if (trusted?.parentNativeSessionId !== this.nativeSessionId || !/^[A-Za-z0-9._-]{1,128}$/.test(trusted?.nativeTaskId || '')) throw new KimiWebError('subagent_not_owned')
    const transcript = await readKimiTranscript(this.api(), this.nativeSessionId, agentId)
    return kimiWebTranscriptEvents(transcript.items)
  }
  prompts(): Promise<{ active: KimiWebPrompt | null; queued: KimiWebPrompt[] }> { return this.api().request('GET', this.path('prompts')) }
  getGoal(): Promise<KimiWebGoal | null> { return this.api().request('GET', this.path('goal')) }
  compact(instruction = ''): Promise<unknown> { return this.api().request('POST', `/api/v1/sessions/${encodeURIComponent(this.nativeSessionId)}:compact`, instruction ? { instruction } : {}) }
  async submitSlash(line: string, commands: string[] = []): Promise<{ kind: 'notice'; text: string } | { kind: 'started' }> {
    const match = /^\/(?:skill:)?([^\s]+)(?:\s+([\s\S]*))?$/.exec(line)
    if (!match) throw new KimiWebError('slash_invalid')
    const name = match[1]
    if (name === 'help') return { kind: 'notice', text: ['Available commands:', ...commands.map(command => '/' + command)].join('\n') }
    if (name === 'status' || name === 'usage') {
      const state = await this.status()
      const usage = name === 'usage' ? (await this.snapshot()).session as any : undefined
      const total = usage?.usage || {}
      return { kind: 'notice', text: name === 'status' ? `Session: ${this.nativeSessionId}\nModel: ${state.model || '(unbound)'}\nMode: ${state.plan_mode ? 'plan' : state.permission || 'manual'}\nWorking directory: ${this.options.config.workdir}` : `Context: ${state.context_tokens || 0} / ${state.max_context_tokens || '?'} tokens\nSession total: ${(total.input_tokens || 0) + (total.cache_read_tokens || 0) + (total.cache_creation_tokens || 0)} input, ${total.output_tokens || 0} output` }
    }
    if (name === 'mcp' || name === 'tasks') {
      const rows = name === 'mcp' ? (await this.api().request<any>('GET', '/api/v1/mcp/servers')).servers : (await this.tasks()).items.filter(task => task.status === 'running')
      return { kind: 'notice', text: rows?.length ? rows.map((row: any) => `- ${row.name || row.id}: ${row.description || row.transport || ''} (${row.status})`).join('\n') : name === 'mcp' ? 'No MCP servers configured for this session.' : 'No background tasks.' }
    }
    if (name.includes(':')) throw new KimiWebError('plugin_command_unsupported')
    await this.api().request('POST', this.path(`skills/${encodeURIComponent(name)}:activate`), { args: match[2] || '' })
    return { kind: 'started' }
  }
  async subscribe(handlers: KimiWebStreamHandlers, initialCursor?: { seq: number; epoch: string }): Promise<KimiWebSubscription> {
    const subscription = await this.api().subscribe(this.nativeSessionId, handlers, initialCursor)
    this.subscriptions.add(subscription)
    return subscription
  }

  setProfile(profile: KimiWebAgentProfile): Promise<unknown> {
    const allowed = ['model', 'thinking', 'permission_mode', 'plan_mode', 'swarm_mode']
    if (Object.keys(profile).some((key) => !allowed.includes(key))) return Promise.reject(new KimiWebError('profile_fields_unsupported'))
    return this.serialize(async () => {
      const result = await this.api().request('POST', this.path('profile'), { agent_config: profile })
      const status = await this.status()
      if (profile.model !== undefined && status.model !== profile.model ||
          profile.thinking !== undefined && status.thinking_level !== profile.thinking ||
          profile.permission_mode !== undefined && status.permission !== profile.permission_mode ||
          profile.plan_mode !== undefined && status.plan_mode !== profile.plan_mode ||
          profile.swarm_mode !== undefined && status.swarm_mode !== profile.swarm_mode) throw new KimiWebError('profile_not_applied')
      return result
    })
  }

  /** Creates the native goal. Subscribe before submitting its first prompt. */
  createGoal(input: { objective: string; tokenBudget?: number; turnBudget?: number; wallClockBudgetMs?: number }): Promise<KimiWebGoal | null> {
    if (input.tokenBudget !== undefined || input.turnBudget !== undefined || input.wallClockBudgetMs !== undefined) return Promise.reject(new KimiWebError('goal_budget_unsupported'))
    if (!input.objective?.trim()) return Promise.reject(new KimiWebError('goal_objective_empty'))
    return this.serialize(async () => {
      await this.api().request('POST', this.path('profile'), { agent_config: { goal_objective: input.objective } })
      return this.getGoal()
    })
  }

  controlGoal(action: 'pause' | 'resume' | 'cancel'): Promise<KimiWebGoal | null> {
    if (!['pause', 'resume', 'cancel'].includes(action)) return Promise.reject(new KimiWebError('goal_control_invalid'))
    return this.serialize(async () => {
      try { await this.api().request('POST', this.path('profile'), { agent_config: { goal_control: action } }) }
      catch (error) {
        if (action !== 'cancel' || !(error instanceof KimiWebError) || error.code !== 40914 || await this.getGoal() !== null) throw error
      }
      return this.getGoal()
    })
  }

  submitPrompt(text: string, promptId: string = randomUUID()): Promise<KimiWebPrompt> {
    return this.serialize(() => this.enqueue(text, promptId))
  }
  submitContent(content: KimiWebContent[], promptId: string = randomUUID()): Promise<KimiWebPrompt> {
    if (!content.length) return Promise.reject(new KimiWebError('prompt_empty'))
    return this.serialize(() => this.api().request('POST', this.path('prompts'), { content, prompt_id: promptId }))
  }
  private enqueue(text: string, promptId: string): Promise<KimiWebPrompt> {
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(new KimiWebError('prompt_empty'))
    // Callers cannot inject model/tool-policy/permission/profile overrides.
    return this.api().request('POST', this.path('prompts'), { content: [{ type: 'text', text }], prompt_id: promptId })
  }

  steer(text: string): Promise<{ steered: boolean; prompt_ids: string[]; prompt_id: string }> {
    return this.steerContent([{ type: 'text', text }])
  }
  steerContent(content: KimiWebContent[]): Promise<{ steered: boolean; prompt_ids: string[]; prompt_id: string }> {
    return this.serialize(async () => {
      const before = await this.prompts()
      if (!before.active) throw new KimiWebError('no_active_turn')
      if (!content.length) throw new KimiWebError('prompt_empty')
      const prompt = await this.api().request<KimiWebPrompt>('POST', this.path('prompts'), { content, prompt_id: randomUUID() })
      // The server accepted a new turn if the previous one ended during enqueue.
      if (prompt.status !== 'queued') return { steered: false, prompt_ids: [prompt.prompt_id], prompt_id: prompt.prompt_id }
      let result: { steered: boolean; prompt_ids: string[] }
      try { result = await this.api().request('POST', this.path(`prompts/${encodeURIComponent(prompt.prompt_id)}:steer`)) }
      catch {
        // Enqueue already acknowledged delivery; a late steer conflict cannot undo it.
        return { steered: false, prompt_ids: [prompt.prompt_id], prompt_id: prompt.prompt_id }
      }
      return { ...result, prompt_id: prompt.prompt_id }
    })
  }
  abortPrompt(promptId: string): Promise<{ aborted: boolean }> { return this.api().request('POST', this.path(`prompts/${encodeURIComponent(promptId)}:abort`)) }
  abortSession(): Promise<{ aborted: boolean }> { return this.api().request('POST', `/api/v1/sessions/${encodeURIComponent(this.nativeSessionId)}:abort`) }
  async pendingApprovals(): Promise<{ items: any[] }> {
    const rows = (await this.snapshot()).pending_approvals
    if (!Array.isArray(rows)) throw new KimiWebError('snapshot_invalid')
    return { items: rows }
  }
  async pendingQuestions(): Promise<{ items: any[] }> {
    const rows = (await this.snapshot()).pending_questions
    if (!Array.isArray(rows)) throw new KimiWebError('snapshot_invalid')
    return { items: rows }
  }
  resolveApproval(approvalId: string, answer: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string; selected_label?: string }): Promise<unknown> {
    return this.lease?.interactionResponses
      ? this.api().request('POST', this.path(`interactions/${encodeURIComponent(approvalId)}`), { kind: 'approval', ...answer })
      : this.api().request('POST', this.path(`approvals/${encodeURIComponent(approvalId)}`), answer)
  }
  answerQuestion(questionId: string, answers: Record<string, KimiWebQuestionAnswer>): Promise<unknown> {
    return this.lease?.interactionResponses
      ? this.api().request('POST', this.path(`interactions/${encodeURIComponent(questionId)}`), { kind: 'question', answers, method: 'click' })
      : this.api().request('POST', this.path(`questions/${encodeURIComponent(questionId)}`), { answers, method: 'click' })
  }
  dismissQuestion(questionId: string): Promise<unknown> {
    return this.lease?.interactionResponses
      ? this.api().request('POST', this.path(`interactions/${encodeURIComponent(questionId)}`), { kind: 'question', dismissed: true }, [0, 40909])
      : this.api().request('POST', this.path(`questions/${encodeURIComponent(questionId)}:dismiss`), undefined, [0, 40909])
  }

  closeAndWait(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      await Promise.all([...this.subscriptions].map(subscription => subscription.closeAndWait()))
      await this.lease?.release()
      // The writer lease remains held if owned descendants cannot be confirmed gone.
      await this.release?.()
      for (const key of this.ownershipKeys) ownedSessions.delete(key)
    })()
    return this.closing
  }
}

export function profileFromConfig(config: SessionConfig): KimiWebAgentProfile {
  const permission = config.permissionMode || 'ask'
  if (!Object.hasOwn(KIMI_PERMISSION_VALUES, permission)) throw new KimiWebError('permission_mode_unsupported')
  return {
    ...(config.model && config.model !== 'default' ? { model: config.model } : {}),
    ...(config.kimiThinking ? { thinking: config.kimiThinking } : {}),
    permission_mode: KIMI_PERMISSION_VALUES[permission as keyof typeof KIMI_PERMISSION_VALUES],
    plan_mode: config.collaborationMode === 'plan'
  }
}
