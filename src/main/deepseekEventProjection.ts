import { isAbsolute } from 'node:path'
import type { TurnUsage, UAEvent, UAEState } from '../shared/types.ts'
import { deepseekCost } from './deepseekPricing.ts'

export interface DeepSeekNativeEvent {
  type: string
  seq: number
  time: number
  data: Record<string, any>
}

export interface DeepSeekProjectionContext {
  sessionId?: string
  model?: string
  effort?: string
  contextWindow?: number
  turnId?: string
  usageBySeq?: Map<number, { turnId: string; usage: TurnUsage }>
  lastUsageSlot?: { turnId: string; step: number; seq: number }
  lastContextTokens?: number
  tools?: Map<string, Record<string, any>>
  compactions?: Map<string, Record<string, any>>
}

export interface DeepSeekHistoryProjection {
  events: UAEvent[]
  cwd?: string
  model?: string
  effort?: string
}

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (content: unknown): string => Array.isArray(content)
  ? content.filter(block => record(block) && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  : ''
const route = (config: any): string | undefined => typeof config?.provider === 'string' && typeof config?.model === 'string'
  ? JSON.stringify([config.provider, config.model]) : undefined
const streamUsage = (stream: unknown): unknown => Array.isArray(stream)
  ? stream.findLast(entry => entry?.type === 'chunk' && entry.chunk?.type === 'usage')?.chunk.usage : undefined

/** Read the first token's native time, including packed reasoning/tool-argument runs. */
function firstStreamTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const entry of stream) {
    if (!record(entry)) continue
    if (entry.type === 'chunk') {
      const chunk = entry.chunk
      if (record(chunk) && (['text-delta', 'reasoning-delta'].includes(chunk.type) && typeof chunk.text === 'string' && chunk.text !== '' ||
          chunk.type === 'tool-call-delta' && (typeof chunk.name === 'string' || typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '')) &&
          count(entry.time)) return entry.time
    } else if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(entry.type) && count(entry.time0)) {
      if (entry.type === 'tool-call-chunks' && typeof entry.name === 'string') return entry.time0
      const fragments = entry.type === 'tool-call-chunks' ? entry.args : entry.texts
      if (!Array.isArray(fragments)) continue
      let time = entry.time0
      for (let i = 0; i < fragments.length; i++) {
        if (i > 0) {
          if (!Array.isArray(entry.dt) || !count(entry.dt[i - 1])) break
          time += entry.dt[i - 1]
          if (!count(time)) break
        }
        if (typeof fragments[i] === 'string' && fragments[i] !== '') return time
      }
    }
  }
  return undefined
}
const endState = (kind: unknown): UAEState => ['aborted', 'interrupted', 'forked'].includes(String(kind))
  ? 'cancelled' : ['error', 'blocked'].includes(String(kind)) ? 'failed' : 'success'

/** MCP tool names arrive as `mcp__<server>__<name>`; the renderer keys MCP and
 * handoff presentation on structured provider/server/name fields. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/

/** Keep one context per native session so multi-step usage and item updates merge. */
export function projectDeepSeekNativeEvent(value: unknown, context: DeepSeekProjectionContext = {}): UAEvent[] {
  if (!record(value) || typeof value.type !== 'string' || !count(value.seq) || !Number.isFinite(value.time) || !record(value.data)) return []
  const event = value as DeepSeekNativeEvent
  const data = event.data
  const turnId = count(data.turn) ? String(data.turn) : context.turnId
  const output: UAEvent[] = []
  const push = (type: UAEvent['type'], payload: Record<string, any>, state: UAEState = 'success'): void => {
    output.push({ sessionId: context.sessionId || '', seq: event.seq, ts: event.time, type, state,
      payload: { ...payload, nativeEventSeq: event.seq, nativeEventType: event.type, ...(turnId ? { turnId } : {}) } })
  }
  const pushTool = (tool: Record<string, any>, state: UAEState): void => {
    if (tool.name === 'bash') push('command_exec', { ...tool,
      command: typeof tool.input?.command === 'string' ? tool.input.command : typeof tool.arguments === 'string' ? tool.arguments : 'bash',
      output: tool.output ?? '', ...(typeof tool.input?.workdir === 'string' ? { cwd: tool.input.workdir } : {}) }, state)
    else {
      const mcp = typeof tool.name === 'string' ? MCP_TOOL_NAME.exec(tool.name) : null
      push('tool_call', mcp ? { ...tool, provider: 'mcp', server: mcp[1], name: mcp[2] } : tool, state)
    }
  }
  const image = (block: any, index: number, message: any): void => {
    if (!record(block) || block.type !== 'image' || !record(block.attachment)) return
    push('tool_call', {
      id: `deepseek-image-${message.id || event.seq}-${index}`, name: 'image_generation', nativeMessageId: message.id,
      result: { status: 'completed', attachment: block.attachment,
        nativeImage: { eventSeq: event.seq, blockIndex: index } }
    }, data.interrupted === true ? 'cancelled' : 'success')
  }
  /** Images returned by a tool stay with that call: the row previews them inline
   * instead of splitting a standalone image card into the middle of the timeline. */
  const toolImages = (content: unknown): Array<{ eventSeq: number; blockIndex: number; toolResult: true }> =>
    Array.isArray(content) ? content.flatMap((block: any, index: number) =>
      record(block) && block.type === 'image' && record(block.attachment)
        ? [{ eventSeq: event.seq, blockIndex: index, toolResult: true as const }] : []) : []
  const usage = (source: any, usageId: string, usageTurnId: string, model = context.model): void => {
    if (!record(source) || !count(source.inputTokens) || !count(source.outputTokens) ||
        (source.cacheReadTokens !== undefined && !count(source.cacheReadTokens)) ||
        (source.cacheWriteTokens !== undefined && !count(source.cacheWriteTokens))) return
    const inputTokens = source.inputTokens + (source.cacheReadTokens ?? 0) + (source.cacheWriteTokens ?? 0)
    if (!count(inputTokens)) return
    if (event.type === 'assistant/message') context.lastContextTokens = inputTokens
    // DeepSeek reports only token buckets. Price each provider sample at the
    // time it settled so a turn that straddles a peak boundary is summed from
    // the tier that actually applied to each attempt.
    const cost = deepseekCost({
      uncachedInputTokens: source.inputTokens,
      cacheReadTokens: source.cacheReadTokens,
      cacheWriteTokens: source.cacheWriteTokens,
      outputTokens: source.outputTokens
    }, model, event.time)
    const current: TurnUsage = {
      inputTokens, outputTokens: source.outputTokens, cachedInputTokens: source.cacheReadTokens ?? 0,
      cacheCreationInputTokens: source.cacheWriteTokens ?? 0,
      ...(event.type === 'compaction/summary' || context.lastContextTokens === undefined ? {} : { contextTokens: context.lastContextTokens }),
      ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}), ...(model ? { modelId: model } : {}),
      cost
    }
    const bySeq = context.usageBySeq ??= new Map()
    if (event.type !== 'compaction/summary' && count(data.step)) {
      const previous = context.lastUsageSlot
      if (previous?.turnId === usageTurnId && previous.step === data.step && previous.seq !== event.seq) bySeq.delete(previous.seq)
      context.lastUsageSlot = { turnId: usageTurnId, step: data.step, seq: event.seq }
    }
    bySeq.set(event.seq, { turnId: usageTurnId, usage: current })
    const samples = [...bySeq.values()].filter(item => item.turnId === usageTurnId)
    const totals = samples.reduce((sum, item) => ({
      inputTokens: sum.inputTokens + item.usage.inputTokens, outputTokens: sum.outputTokens + item.usage.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + item.usage.cachedInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + (item.usage.cacheCreationInputTokens ?? 0)
    }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 })
    // A single unpriceable sample makes the turn total unknowable; never show a
    // partial amount as if it were the whole turn.
    const turnCost = samples.every(item => typeof item.usage.cost === 'number' && Number.isFinite(item.usage.cost))
      ? samples.reduce((sum, item) => sum + (item.usage.cost as number), 0)
      : null
    push('system_notice', { id: usageId, kind: 'usage', usage: { ...current, ...totals, cost: turnCost } })
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const first = firstStreamTokenTime(data.stream)
    const source = data.usage ?? streamUsage(data.stream)
    if (source !== undefined || first !== undefined) push('system_notice', { id: `deepseek-speed-${turnId ?? 'unknown'}-${data.step ?? event.seq}`, kind: 'token_speed',
      speed: { outputTokens: source?.outputTokens, durationMs: first === undefined ? undefined : event.time - first,
        metric: 'generation', source: 'DeepSeek 原生流式计时', model: route(data.message?.source) || context.model,
        incomplete: data.interrupted === true } })
  }
  switch (event.type) {
    case 'request/header': {
      const config = data.header?.config
      context.model = route(config) || context.model
      context.effort = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort : undefined
      break
    }
    case 'request/context':
      context.contextWindow = count(data.contextWindow) && data.contextWindow > 0 ? data.contextWindow : undefined
      break
    case 'turn/start':
      context.turnId = turnId
      push('turn_started', { id: `deepseek-turn-${turnId}`, turnId })
      break
    case 'turn/end':
      push('turn_completed', { id: `deepseek-turn-${turnId}`, reason: data.reason }, endState(data.reason?.kind))
      break
    case 'user/message': {
      const kind = data.source?.kind
      push(kind === 'user' ? 'user_message' : 'system_notice', {
        id: data.id || `deepseek-user-${event.seq}`, text: text(data.content), nativeMessageId: data.id,
        ...(kind === 'user' ? {} : { kind: 'native_context' }), content: data.content, source: data.source
      })
      break
    }
    case 'assistant/message': {
      const message = data.message
      if (!record(message) || !Array.isArray(message.content)) break
      message.content.forEach((block: any, index: number) => {
        if (record(block) && block.type === 'image') { image(block, index, message); return }
        if (record(block) && block.type === 'tool-call' && typeof block.id === 'string') {
          let input: unknown = block.arguments
          try { input = JSON.parse(block.arguments) } catch { /* keep raw arguments */ }
          const tools = context.tools ??= new Map()
          tools.set(block.id, { ...tools.get(block.id), id: block.id, name: block.name, input, arguments: block.arguments })
          return
        }
        if (!record(block) || !['text', 'reasoning'].includes(block.type) || typeof block.text !== 'string' || !block.text) return
        push(block.type === 'reasoning' ? 'reasoning' : 'agent_message', {
          id: `deepseek-${message.id || event.seq}-${index}`, nativeMessageId: message.id, text: block.text, content: message.content, interrupted: data.interrupted === true
        }, data.interrupted === true ? 'cancelled' : 'success')
      })
      usage(data.usage ?? streamUsage(data.stream), `deepseek-usage-turn-${turnId ?? event.seq}`, turnId ?? `event-${event.seq}`, route(message.source) || context.model)
      break
    }
    case 'assistant/attempt':
      push('system_notice', { id: `deepseek-attempt-${event.seq}`, kind: 'native_attempt', stream: data.stream })
      usage(streamUsage(data.stream), `deepseek-usage-turn-${turnId ?? event.seq}`, turnId ?? `event-${event.seq}`)
      break
    case 'llm/retry-started':
      if (context.lastUsageSlot && context.lastUsageSlot.turnId === turnId && context.lastUsageSlot.step === data.step) delete context.lastUsageSlot
      break
    case 'tool/call': {
      if (typeof data.callId !== 'string' || typeof data.name !== 'string') break
      let input: unknown = data.arguments
      try { input = JSON.parse(data.arguments) } catch { /* retain malformed model arguments verbatim */ }
      const tool = { id: data.callId, name: data.name, input, arguments: data.arguments }
      ;(context.tools ??= new Map()).set(data.callId, tool)
      pushTool(tool, 'running')
      break
    }
    case 'tool/result': {
      const message = data.message
      if (!record(message) || typeof message.toolCallId !== 'string') break
      const previous = context.tools?.get(message.toolCallId)
      const output = text(message.content)
      const hasNonText = Array.isArray(message.content) && message.content.some((block: any) => block?.type !== 'text')
      const nativeImages = toolImages(message.content)
      pushTool({ ...previous, id: message.toolCallId, output, content: message.content,
        result: hasNonText || data.meta !== undefined ? { ...(output ? { output } : {}), content: message.content, ...(data.meta !== undefined ? { meta: data.meta } : {}) } : output,
        ...(nativeImages.length > 0 ? { nativeImages } : {}),
        ...(data.error ? { error: data.error } : {}), ...(data.meta !== undefined ? { meta: data.meta } : {}) }, message.isError === true ? 'failed' : 'success')
      break
    }
    case 'todo/write':
      if (Array.isArray(data.todos)) push('plan_update', { id: `deepseek-plan-${turnId || 'session'}`, steps: data.todos.map((todo: any) => ({ text: todo.content, status: todo.status })) })
      break
    case 'plan/mode':
      if (typeof data.active === 'boolean') push('system_notice', { id: `deepseek-mode-${event.seq}`, kind: 'collaboration_mode', active: data.active })
      break
    case 'compaction/start':
    case 'compaction/summary':
    case 'compaction/end': {
      if (typeof data.compactionId !== 'string') break
      const id = `deepseek-compaction-${data.compactionId}`
      const previous = context.compactions?.get(id) || {}
      const payload = { ...previous, id, ...(event.type === 'compaction/summary' ? {
        summaryPreview: text(data.summary), summary: data.summary, shadowedRange: data.shadowedRange,
        shadowedSeqs: data.shadowedSeqs, shadowedTokenCount: data.shadowedTokenCount
      } : {}), ...(data.error ? { error: data.error } : {}) }
      ;(context.compactions ??= new Map()).set(id, payload)
      push('context_compaction', payload, event.type === 'compaction/end' ? data.error ? 'failed' : 'success' : 'running')
      if (event.type === 'compaction/summary') usage(data.usage, `deepseek-usage-${id}`, id, route(data))
      break
    }
    case 'compaction/prune':
      push('context_compaction', { id: `deepseek-prune-${event.seq}`, kind: 'prune', shadowedRange: data.shadowedRange, shadowedSeqs: data.shadowedSeqs, shadowedTokenCount: data.shadowedTokenCount })
      break
    case 'system/message':
    case 'developer/message':
      if (record(data.message)) push('system_notice', { id: `deepseek-context-${event.seq}`, kind: 'native_context', text: text(data.message.content), content: data.message.content, source: data.message.source })
      break
  }
  return output
}

/** Render the complete append-only log, including content hidden by compaction. */
export function normalizeDeepSeekHistory(snapshot: unknown): DeepSeekHistoryProjection {
  if (!record(snapshot) || !record(snapshot.session) || !Array.isArray(snapshot.events)) throw new Error('DeepSeek 原生历史格式无效')
  const context: DeepSeekProjectionContext = { sessionId: typeof snapshot.session.id === 'string' ? snapshot.session.id : '' }
  const events: UAEvent[] = []
  const positions = new Map<string, number>()
  for (const native of snapshot.events) {
    for (const event of projectDeepSeekNativeEvent(native, context)) {
      const key = `${event.type}:${event.payload.id}`
      const index = positions.get(key)
      if (index !== undefined) events[index] = { ...events[index], ...event, seq: index, payload: { ...events[index].payload, ...event.payload } }
      else { positions.set(key, events.length); events.push({ ...event, seq: events.length }) }
    }
  }
  const ended = new Map(events.filter(event => event.type === 'turn_completed').map(event => [event.payload.turnId, event.state]))
  for (const event of events) {
    if (['tool_call', 'command_exec'].includes(event.type) && event.state === 'running') event.state = ended.get(event.payload.turnId) === 'failed' ? 'failed' : 'cancelled'
    if (event.type === 'context_compaction' && event.state === 'running') event.state = 'cancelled'
  }
  const cwd = snapshot.session.cwd
  return { events, ...(typeof cwd === 'string' && isAbsolute(cwd) && !cwd.includes('\u0000') ? { cwd } : {}),
    ...(context.model ? { model: context.model } : {}), ...(context.effort ? { effort: context.effort } : {}) }
}
