import type { UASubAgent } from './types'

export const SUB_AGENT_TERMINAL_STATUSES = new Set<UASubAgent['status']>([
  'completed',
  'interrupted',
  'errored',
  'shutdown',
  'notFound'
])

const DISPATCH_TOOLS = new Set(['spawnAgent', 'sendInput', 'resumeAgent'])

export function isSubAgentTerminal(status: UASubAgent['status']): boolean {
  return SUB_AGENT_TERMINAL_STATUSES.has(status)
}

export function subAgentDisplayName(agent: Pick<UASubAgent, 'agentThreadId' | 'name'>): string {
  const name = agent.name?.trim()
  return !name || name === agent.agentThreadId || name === agent.agentThreadId.slice(0, 8)
    ? '子智能体'
    : name
}

/** Native thread metadata uses camelCase over RPC and snake_case on disk. */
export function nativeSubAgentName(value: any): string | undefined {
  const spawn = (value?.source?.subAgent ?? value?.source?.subagent)?.thread_spawn
  for (const name of [value?.agentNickname, value?.agent_nickname, spawn?.agent_nickname]) {
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  for (const path of [value?.agentPath, value?.agent_path, value?.name, value?.agent, spawn?.agent_path]) {
    if (typeof path !== 'string' || !path.trim()) continue
    const segment = path.trim().split('/').filter(Boolean).pop() || path.trim()
    return segment.replace(/\.(md|json|ya?ml)$/i, '')
  }
  return undefined
}

/** Codex may persist Fernet ciphertext in ordinary message/prompt fields. */
export function readableSubAgentInput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || /^gAAAA[A-Za-z0-9_-]{93,}={0,2}$/u.test(text)) return undefined
  return value
}

/** Keep summaries local and deterministic; constraints after the first sentence stay in details. */
export function subAgentTaskSummary(prompt?: string): string {
  const sentence = readableSubAgentInput(prompt)?.trim().split(/[。\r\n]/u, 1)[0].replace(/\s+/gu, ' ').trim() || ''
  const characters = Array.from(sentence)
  return characters.length > 32 ? characters.slice(0, 32).join('') + '…' : sentence
}

export function isSubAgentDispatchTool(tool: unknown): boolean {
  return typeof tool === 'string' && DISPATCH_TOOLS.has(tool)
}

function grokText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function grokTokenCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(count) && count >= 0 ? count : 0
}

function grokSubagentStatus(type: string, value: unknown): UASubAgent['status'] {
  const status = String(value ?? '').toLowerCase()
  if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') return 'interrupted'
  if (status === 'errored' || status === 'error' || status === 'failed') return 'errored'
  if (status === 'shutdown') return 'shutdown'
  if (status === 'not_found' || status === 'notfound') return 'notFound'
  if (type === 'subagent_finished' || status === 'completed' || status === 'done' || status === 'success') {
    return 'completed'
  }
  return 'running'
}

/** Normalize Grok's verified `_x.ai/session_notification` child lifecycle payload. */
export function normalizeGrokSubagentNotification(
  payload: unknown,
  observedAt: number
): UASubAgent | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Record<string, any>
  const type = grokText(value.sessionUpdate) || grokText(value.type)
  if (!type || !['subagent_spawned', 'subagent_progress', 'subagent_finished'].includes(type)) {
    return undefined
  }

  const agentThreadId = grokText(value.child_session_id) || grokText(value.subagent_id)
  if (!agentThreadId) return undefined

  const status = grokSubagentStatus(type, value.status)
  const result: UASubAgent = {
    agentThreadId,
    ...(grokText(value.subagent_id) ? { nativeTaskId: value.subagent_id } : {}),
    status,
    tool: 'spawn_subagent'
  }
  const parentThreadId = grokText(value.parent_session_id)
  const dispatchId = grokText(value.parent_prompt_id)
  const name = grokText(value.description) || grokText(value.name)
  const message = grokText(value.output) || grokText(value.message)
  if (parentThreadId) result.parentThreadId = parentThreadId
  if (dispatchId) result.dispatchId = dispatchId
  if (name) result.name = name
  if (message) result.message = message
  if (type === 'subagent_spawned') result.startedAt = observedAt
  if (isSubAgentTerminal(status)) result.endedAt = observedAt

  const usage = value.tokens ?? value.usage
  if (usage && typeof usage === 'object') {
    const inputTokens = grokTokenCount(usage.input_tokens ?? usage.inputTokens)
    const outputTokens = grokTokenCount(usage.output_tokens ?? usage.outputTokens)
    result.tokens = {
      inputTokens,
      outputTokens,
      totalTokens: grokTokenCount(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens
    }
  }
  return result
}

/** Parse an on-disk timestamp without consulting the wall clock. */
export function historicalTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function generationOf(agent: UASubAgent | undefined): number | undefined {
  return typeof agent?.generation === 'number' && Number.isFinite(agent.generation)
    ? agent.generation
    : undefined
}

function terminalTime(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (endedAt === undefined) return undefined
  return startedAt === undefined ? endedAt : Math.max(startedAt, endedAt)
}

/**
 * Merge one child snapshot. Only an explicitly newer dispatch generation may
 * reopen a terminal thread; unversioned/equal-generation running ticks remain
 * unable to resurrect it. This is shared by main persistence and renderer replay.
 */
export function mergeSubAgentSnapshot(
  previous: UASubAgent | undefined,
  incoming: UASubAgent,
  observedAt?: number
): UASubAgent {
  if (!previous) {
    const startedAt = incoming.startedAt ?? observedAt
    const endedAt = isSubAgentTerminal(incoming.status)
      ? terminalTime(startedAt, incoming.endedAt ?? observedAt)
      : undefined
    return { ...incoming, startedAt, endedAt }
  }

  const previousGeneration = generationOf(previous)
  const incomingGeneration = generationOf(incoming)
  const newerGeneration =
    incomingGeneration !== undefined &&
    (previousGeneration === undefined || incomingGeneration > previousGeneration)
  const staleGeneration =
    incomingGeneration !== undefined &&
    previousGeneration !== undefined &&
    incomingGeneration < previousGeneration

  // A delayed snapshot from an older dispatch must not alter the active generation.
  if (staleGeneration) return previous

  if (newerGeneration) {
    const startedAt = incoming.startedAt ?? observedAt
    const endedAt = isSubAgentTerminal(incoming.status)
      ? terminalTime(startedAt, incoming.endedAt ?? observedAt)
      : undefined
    return {
      ...previous,
      ...incoming,
      startedAt,
      endedAt,
      // A dispatch owns its task/message. Do not leak the prior generation's text.
      prompt: incoming.prompt,
      message: incoming.message
    }
  }
  // Once a thread has versioned dispatches, an unversioned delayed snapshot is
  // legacy/stale input and cannot safely mutate the current generation.
  if (previousGeneration !== undefined && incomingGeneration === undefined) return previous

  // The first terminal observation owns the generation's outcome. Parent-turn
  // cleanup and delayed activity/token snapshots are only reconciliation; they
  // must not turn an interrupted/errored/not-found child into completed (or back
  // into running). A genuinely newer explicit dispatch took the branch above.
  const status = isSubAgentTerminal(previous.status) ? previous.status : incoming.status
  const startedAt = previous.startedAt ?? incoming.startedAt ?? observedAt
  const endedAt = isSubAgentTerminal(status)
    ? terminalTime(
        startedAt,
        isSubAgentTerminal(previous.status)
          ? previous.endedAt ?? incoming.endedAt ?? observedAt
          : incoming.endedAt ?? observedAt
      )
    : undefined

  return {
    ...previous,
    ...incoming,
    status,
    startedAt,
    endedAt,
    generation: incomingGeneration ?? previousGeneration,
    dispatchId: incoming.dispatchId ?? previous.dispatchId,
    name: incoming.name || previous.name,
    prompt: incoming.prompt || previous.prompt,
    tokens: incoming.tokens || previous.tokens,
    message: incoming.message || previous.message
  }
}

export interface SubAgentDispatchStamp {
  dispatchId: string
  generation: number
  startedAt?: number
}

/** Assigns one monotonic generation per (thread, collaboration item id). */
export class SubAgentDispatchTracker {
  private generationByThread = new Map<string, number>()
  private stampByDispatch = new Map<string, SubAgentDispatchStamp>()
  private stampByActivity = new Map<string, SubAgentDispatchStamp>()
  private rejectedDispatches = new Set<string>()
  private currentByThread = new Map<string, SubAgentDispatchStamp>()

  activate(threadId: string, dispatchId: string, startedAt?: number): SubAgentDispatchStamp | undefined {
    const key = `${threadId}\u0000${dispatchId}`
    const existing = this.stampByDispatch.get(key)
    if (existing) return existing
    if (this.rejectedDispatches.has(key)) return undefined

    // History files are normally chronological, but delayed records do occur.
    // An unseen dispatch whose persisted timestamp predates the current dispatch
    // is not a new generation merely because we happened to encounter it later.
    const current = this.currentByThread.get(threadId)
    if (
      startedAt !== undefined &&
      current?.startedAt !== undefined &&
      startedAt < current.startedAt
    ) {
      this.rejectedDispatches.add(key)
      return undefined
    }
    const generation = (this.generationByThread.get(threadId) ?? 0) + 1
    const stamp = { dispatchId, generation, startedAt }
    this.generationByThread.set(threadId, generation)
    this.stampByDispatch.set(key, stamp)
    this.currentByThread.set(threadId, stamp)
    return stamp
  }

  current(threadId: string): SubAgentDispatchStamp | undefined {
    return this.currentByThread.get(threadId)
  }

  forDispatch(threadId: string, dispatchId: string): SubAgentDispatchStamp | undefined {
    return this.stampByDispatch.get(`${threadId}\u0000${dispatchId}`)
  }

  isCurrent(threadId: string, stamp: SubAgentDispatchStamp | undefined): boolean {
    return !!stamp && this.currentByThread.get(threadId) === stamp
  }

  /**
   * Correlate a persisted non-dispatch activity id with the generation that was
   * current when it first appeared. Replayed duplicates then remain attached to
   * that original generation instead of terminating a later re-dispatch.
   */
  observeActivity(
    threadId: string,
    activityId: string,
    occurredAt?: number
  ): SubAgentDispatchStamp | undefined {
    const key = `${threadId}\u0000${activityId}`
    const dispatch = this.stampByDispatch.get(key)
    if (dispatch) return dispatch
    const existing = this.stampByActivity.get(key)
    if (existing) return existing
    const current = this.currentByThread.get(threadId)
    if (!current) return undefined
    if (
      occurredAt !== undefined &&
      current.startedAt !== undefined &&
      occurredAt < current.startedAt
    ) {
      return undefined
    }
    this.stampByActivity.set(key, current)
    return current
  }
}

export interface HistoricalSubAgentActivity {
  agentThreadId: string
  kind: unknown
  occurredAt?: unknown
  eventId?: unknown
  name?: string
}

function historicalStatus(kind: unknown): UASubAgent['status'] {
  const value = String(kind ?? '').toLowerCase()
  if (value === 'interrupted') return 'interrupted'
  if (value === 'errored' || value === 'error' || value === 'failed') return 'errored'
  if (value === 'shutdown') return 'shutdown'
  if (value === 'notfound' || value === 'not_found') return 'notFound'
  if (value === 'completed' || value === 'done') return 'completed'
  return 'running'
}

/** Fold one persisted activity while latching the first timestamp per generation. */
export function reduceHistoricalSubAgent(
  previous: UASubAgent | undefined,
  activity: HistoricalSubAgentActivity,
  recordTimestamp?: unknown,
  dispatches?: SubAgentDispatchTracker
): UASubAgent {
  const occurredAt = historicalTimestamp(activity.occurredAt)
  const recordAt = historicalTimestamp(recordTimestamp)
  const observedAt = occurredAt ?? recordAt
  const kind = String(activity.kind ?? '').toLowerCase()
  const eventId =
    typeof activity.eventId === 'string' && activity.eventId
      ? activity.eventId
      : undefined
  // While a child is running, `interacted` is an appended question inside the
  // same lifecycle. It only reopens a new generation after a true terminal.
  const dispatchActivity = kind === 'started' ||
    (kind === 'interacted' && isSubAgentTerminal(previous?.status ?? 'running'))
  const trackedDispatch = dispatchActivity && eventId
    ? dispatches?.activate(activity.agentThreadId, eventId, observedAt)
    : undefined
  const trackedActivity = !dispatchActivity && eventId
    ? dispatches?.observeActivity(activity.agentThreadId, eventId, observedAt)
    : undefined
  const previousGeneration = generationOf(previous) ?? 0
  // A known old dispatch/activity, or an unseen dispatch rejected because its
  // timestamp predates the current generation, must be ignored wholesale.
  if (dispatchActivity && eventId && dispatches && !trackedDispatch) return previous ?? {
    agentThreadId: activity.agentThreadId,
    status: 'running',
    name: activity.name
  }
  if (previous && trackedDispatch && !dispatches?.isCurrent(activity.agentThreadId, trackedDispatch)) {
    return previous
  }
  if (previous && trackedActivity && trackedActivity.generation < previousGeneration) return previous
  if (
    previous &&
    !dispatchActivity &&
    observedAt !== undefined &&
    previous.startedAt !== undefined &&
    observedAt < previous.startedAt
  ) {
    return previous
  }
  const trackedGenerationIsCurrentOrNew =
    !!trackedDispatch && trackedDispatch.generation >= previousGeneration
  const startsGeneration =
    !previous ||
    (trackedDispatch
      ? trackedGenerationIsCurrentOrNew && trackedDispatch.dispatchId !== previous.dispatchId
      : dispatchActivity &&
        (eventId ? eventId !== previous.dispatchId : kind === 'interacted' || isSubAgentTerminal(previous.status)))
  const generation = trackedDispatch?.generation ?? trackedActivity?.generation ??
    (startsGeneration ? previousGeneration + 1 : generationOf(previous))
  const dispatchId = startsGeneration
    ? trackedDispatch?.dispatchId ?? eventId ?? `history-${activity.agentThreadId}-${generation ?? 1}`
    : trackedDispatch?.dispatchId ?? trackedActivity?.dispatchId ?? previous?.dispatchId
  const status = historicalStatus(activity.kind)
  const incoming: UASubAgent = {
    agentThreadId: activity.agentThreadId,
    status,
    name: activity.name || previous?.name,
    dispatchId,
    generation,
    startedAt: startsGeneration
      ? trackedDispatch?.startedAt ?? observedAt
      : trackedDispatch?.startedAt ?? previous?.startedAt,
    endedAt: isSubAgentTerminal(status) ? observedAt : undefined
  }
  if (kind === 'interacted') incoming.tool = 'interacted'
  return mergeSubAgentSnapshot(previous, incoming, observedAt)
}

/** Does a versioned snapshot represent a fresh dispatch after an already seen legacy/versioned one? */
export function isSubAgentGenerationAdvance(
  hasSeen: boolean,
  seenGeneration: number | undefined,
  incomingGeneration: number | undefined
): boolean {
  return hasSeen && incomingGeneration !== undefined &&
    (seenGeneration === undefined || incomingGeneration > seenGeneration)
}

/** Settle a dangling historical child at the final real rollout timestamp. */
export function finalizeHistoricalSubAgent(
  state: UASubAgent,
  lastRolloutTimestamp?: unknown
): UASubAgent | null {
  if (isSubAgentTerminal(state.status)) return null
  const last = historicalTimestamp(lastRolloutTimestamp)
  const endedAt = terminalTime(state.startedAt, last ?? state.startedAt)
  return mergeSubAgentSnapshot(
    state,
    { ...state, status: 'completed', endedAt },
    endedAt
  )
}

/** User-facing elapsed time used by both live and restored child details. */
export function formatSubAgentElapsed(agent: Pick<UASubAgent, 'startedAt' | 'endedAt'>, now: number): string {
  const start = agent.startedAt
  const end = agent.endedAt !== undefined && start !== undefined && agent.endedAt >= start
    ? agent.endedAt
    : now
  const ms = start === undefined ? 0 : Math.max(0, end - start)
  const seconds = Math.floor(ms / 1000)
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toString().padStart(2, '0')} 秒`
}
