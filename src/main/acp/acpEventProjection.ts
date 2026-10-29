import type { UAEvent, UAEState, TurnUsage } from '../../shared/types.ts'

export function acpContentText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(acpContentText).join('')
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'content') return acpContentText(value.content)
  return typeof value.text === 'string' ? value.text : typeof value.output === 'string' ? value.output : ''
}

/** ACP camelCase input is inclusive; headless snake_case input is uncached. */
export function projectGrokUsage(usage: any, includeModels = true): Partial<TurnUsage> {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return { usageIsIncomplete: true }
  const token = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
  const cachedInputTokens = token(usage.cachedReadTokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens)
  const cacheCreationInputTokens = token(usage.cacheCreationTokens ?? usage.cache_creation_input_tokens ?? usage.cacheWriteInputTokens ?? usage.cacheCreationInputTokens)
  const uncached = token(usage.input_tokens)
  const inputTokens = token(usage.inputTokens) ?? (uncached !== undefined && cachedInputTokens !== undefined && cacheCreationInputTokens !== undefined
    ? token(uncached + cachedInputTokens + cacheCreationInputTokens) : undefined)
  const outputTokens = token(usage.outputTokens ?? usage.output_tokens)
  const result: Partial<TurnUsage> = Object.fromEntries(Object.entries({ inputTokens, outputTokens, cachedInputTokens,
    cacheCreationInputTokens, totalTokens:token(usage.totalTokens ?? usage.total_tokens),
    reasoningTokens:token(usage.reasoningTokens ?? usage.reasoning_tokens), modelCalls:token(usage.modelCalls) }).filter(([,value]) => value !== undefined))
  if (usage.usageIsIncomplete === true || inputTokens === undefined || outputTokens === undefined || cachedInputTokens === undefined || cachedInputTokens > inputTokens) result.usageIsIncomplete = true
  if (includeModels && usage.modelUsage && typeof usage.modelUsage === 'object' && !Array.isArray(usage.modelUsage)) {
    result.modelUsage = Object.fromEntries(Object.entries(usage.modelUsage).slice(0,100).filter(([id]) => id.length > 0 && id.length <= 256).map(([id,value]) => [id,projectGrokUsage(value,false)]))
  }
  return result
}

/**
 * MiniMax Code does not emit ACP `diff` blocks. A write tool call carries the
 * target path and the new content in `rawInput` instead, plus a `locations`
 * hint. Without this branch the file-change card would always be empty.
 */
function projectMCodeFileChanges(merged: any): Array<{ path: string; kind: string; oldText?: string; newText?: string }> {
  const changes: Array<{ path: string; kind: string; oldText?: string; newText?: string }> = []
  const diffs = (Array.isArray(merged.content) ? merged.content : []).filter((entry: any) => entry?.type === 'diff')
  for (const entry of diffs) {
    changes.push({ path: entry.path, kind: entry.oldText == null ? 'add' : entry.newText === '' ? 'delete' : 'modify', oldText: entry.oldText, newText: entry.newText })
  }
  if (changes.length) return changes
  const path = typeof merged.rawInput?.path === 'string' ? merged.rawInput.path
    : typeof merged.locations?.[0]?.path === 'string' ? merged.locations[0].path
    : ''
  if (!path) return changes
  const newText = typeof merged.rawInput?.content === 'string' ? merged.rawInput.content
    : typeof merged.rawInput?.newText === 'string' ? merged.rawInput.newText
    : undefined
  const oldText = typeof merged.rawInput?.oldText === 'string' ? merged.rawInput.oldText : undefined
  const deleted = merged.rawInput?.deleted === true || merged.kind === 'delete'
  changes.push({ path, kind: deleted ? 'delete' : oldText == null ? 'add' : 'modify', oldText, newText })
  return changes
}

export function projectACPTool(merged: any, provider: string): Pick<UAEvent, 'type' | 'state' | 'payload'> | undefined {
  if (provider === 'deepseek' && merged.kind === 'other' && merged.title === 'bash') merged = { ...merged, kind: 'execute' }
  if (!merged.kind && merged.status == null && merged.content == null && merged.rawInput == null && merged.rawOutput == null) return
  const state: UAEState = merged.status === 'completed' ? 'success' : merged.status === 'failed' ? 'failed' : merged.status === 'pending' ? 'pending' : 'running'
  const id = merged.toolCallId
  const output = acpContentText(merged.content) || acpContentText(merged.rawOutput)
  if (merged.kind === 'execute') return { type: 'command_exec', state, payload: { id, command: merged.rawInput?.command || merged.title, output, raw: merged } }
  if (merged.kind === 'edit' || merged.kind === 'delete' || merged.kind === 'move') {
    if (provider === 'mcode') {
      // MiniMax Code announces the tool kind in the first frame and only
      // reveals the target path in a later update. Emitting the empty first
      // frame would put a blank "文件改动" card into the event log.
      const changes = projectMCodeFileChanges(merged)
      if (!changes.length) return
      return { type: 'file_change', state, payload: { id, raw: merged, changes } }
    }
    return {
      type: 'file_change', state, payload: { id, raw: merged, changes: (Array.isArray(merged.content) ? merged.content : []).filter((entry: any) => entry?.type === 'diff').map((entry: any) => ({
        path: entry.path, kind: entry.oldText == null ? 'add' : entry.newText === '' ? 'delete' : 'modify', oldText: entry.oldText, newText: entry.newText
      })) }
    }
  }
  return { type: 'tool_call', state, payload: { id, name: merged.title || merged.kind || `${provider} tool`, input: merged.rawInput, output, raw: merged } }
}

/** A read-only replay shares the live tool projection and merges chunk updates. */
export class ACPHistoryProjection {
  readonly events: UAEvent[] = []
  private tools = new Map<string, any>()
  private textType?: UAEvent['type']
  private textId?: string
  constructor(private readonly provider: string) {}

  private upsert(event: Pick<UAEvent, 'type' | 'state' | 'payload'>, timestamp?: number): void {
    const index = this.events.findIndex(e => e.payload.id === event.payload.id)
    if (index >= 0) this.events[index] = { ...this.events[index], ...event }
    else this.events.push({ sessionId: '', seq: this.events.length, ts: typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(), ...event })
  }

  push(update: any, timestamp?: number): void {
    const kind = update?.sessionUpdate
    const type = kind === 'user_message_chunk' ? 'user_message' : kind === 'agent_message_chunk' ? 'agent_message' : kind === 'agent_thought_chunk' ? 'reasoning' : undefined
    if (type) {
      const text = acpContentText(update.content)
      const image = this.provider === 'grok' && type === 'user_message' && update.content?.type === 'image' && typeof update.content.data === 'string'
        ? {data:update.content.data,mime:update.content.mimeType,name:'Grok 历史图片'} : undefined
      if (!text && !image) return
      const id = this.textType === type ? this.textId! : `${this.provider}-history-${type}-${this.events.length}`
      const previous = this.events.find(e => e.payload.id === id)?.payload || {}
      this.upsert({ type, state: 'success', payload: { ...previous,id,text:(previous.text || '') + text,
        ...(image ? {grokImages:[...(previous.grokImages || []),image].slice(0,17)} : {}) } }, timestamp)
      this.textType = type
      this.textId = id
      return
    }
    this.textType = undefined
    this.textId = undefined
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(update.toolCallId || `${this.provider}-history-tool-${this.events.length}`)
      const merged = { ...(this.tools.get(id) || {}), ...update, toolCallId: id }
      this.tools.set(id, merged)
      const event = projectACPTool(merged, this.provider)
      if (event) this.upsert(event, timestamp)
    } else if (kind === 'plan') {
      this.upsert({ type: 'plan_update', state: 'success', payload: { id: `${this.provider}-history-plan-${this.events.length}`, steps: (update.entries || []).map((entry: any) => ({ text: String(entry.content || ''), status: entry.status })) } }, timestamp)
    } else if (kind === 'usage_update') {
      this.upsert({ type: 'system_notice', payload: { id: `${this.provider}-history-context-${this.events.length}`, kind: 'context', usage: { contextTokens: Math.max(0, Number(update.used) || 0), contextWindow: Math.max(0, Number(update.size) || 0) || undefined } } }, timestamp)
    } else if (kind === 'turn_completed' && this.provider === 'grok' && typeof update.prompt_id === 'string' && update.prompt_id && ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(update.stop_reason)) {
      if (update.usage) {
        const usage = projectGrokUsage(update.usage)
        this.upsert({type:'system_notice',payload:{id:`grok-history-usage-${update.prompt_id}`,
          ...(usage.usageIsIncomplete ? {kind:'warning',text:'Grok 此回合用量不完整。',nativeUsage:usage} : {kind:'usage',usage})}},timestamp)
      }
      this.upsert({ type: 'turn_completed', state: update.stop_reason === 'cancelled' ? 'cancelled' : 'success', payload: { id: `grok-history-turn-${update.prompt_id}` } }, timestamp)
    } else if (kind === 'image_dropped' && this.provider === 'grok') {
      const notes = Array.isArray(update.notes) ? update.notes.filter((note:unknown) => typeof note === 'string').join('；').slice(0,1000) : ''
      this.upsert({type:'system_notice',payload:{id:`grok-history-image-dropped-${this.events.length}`,kind:'warning',text:`Grok 未接收部分图片${notes ? `：${notes}` : '。'}`}},timestamp)
    }
  }
}
