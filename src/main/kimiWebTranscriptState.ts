import { KimiWebError, type KimiWebSnapshot } from './kimiWebTransport.ts'
import { kimiWebTranscriptEvents } from './kimiWebEventProjection.ts'

/** Map the official turns API to the transcript consumed by history and Runner. */
export function normalizeKimiWebTurns(turns: any[]): any[] {
  const state = (row: any) => row.status === 'running' ? 'running' : row.outcome === 'interrupted' ? 'cancelled' : row.outcome === 'failed' ? 'failed' : 'completed'
  const usage = (row: any) => row && ({ inputOther: row.input_other, inputCacheRead: row.input_cache_read, inputCacheCreation: row.input_cache_creation, output: row.output })
  return turns.flatMap(turn => {
    if (!turn?.turn_id || !Array.isArray(turn.items)) throw new KimiWebError('transcript_invalid')
    if (turn.kind === 'system') return turn.items.filter((item: any) => item.type === 'system' && item.kind === 'compaction').map((item: any) => ({
      kind: 'marker', marker: 'compaction', markerId: item.item_id, at: item.created_at,
      payload: { agentId: 'main', phase: item.status === 'running' ? 'started' : item.outcome === 'interrupted' ? 'cancelled' : item.outcome === 'failed' ? 'blocked' : 'completed' }
    }))
    const opener = turn.items.find((item: any) => item.type === 'user_message' && item.placement === 'opener')
    const steps = new Map<number, any>((turn.steps || []).map((step: any) => [step.index, { stepId: `${turn.turn_id}.${step.index}`, ordinal: step.index,
      state: step.outcome === 'failed' ? 'failed' : step.ended_at ? 'completed' : 'running', startedAt: step.started_at, endedAt: step.ended_at, usage: usage(step.usage), frames: [] }]))
    for (const item of turn.items) {
      if (item === opener) continue
      const index = item.step_index || 1
      if (!steps.has(index)) steps.set(index, { stepId: `${turn.turn_id}.${index}`, ordinal: index, state: state(turn), startedAt: turn.started_at, endedAt: turn.ended_at, frames: [] })
      const frames = steps.get(index).frames
      const base = { frameId: item.item_id }
      if (item.type === 'assistant_message' || item.type === 'reasoning') frames.push({ ...base, kind: item.type === 'reasoning' ? 'thinking' : 'text', role: 'assistant', text: item.text })
      else if (item.type === 'user_message') frames.push({ ...base, kind: 'text', role: 'user', origin: item.origin, text: item.text })
      else if (item.type === 'tool_call') frames.push({ ...base, kind: 'tool', toolCallId: item.item_id, name: item.name, input: item.input ?? item.input_text,
        output: item.output ?? item.error, state: item.status === 'running' ? 'running' : item.outcome === 'failed' ? 'error' : 'done' })
      else if (item.type === 'notification') frames.push({ ...base, kind: 'notice', level: item.severity, message: item.body, taskId: item.task_id })
    }
    return [{ kind: 'turn', turnId: turn.turn_id, ordinal: turn.ordinal, state: state(turn), startedAt: turn.started_at, endedAt: turn.ended_at,
      origin: opener?.origin, prompt: opener?.text, attachmentIds: opener?.attachments?.map((item: any) => item.file_id || item.ordinal),
      error: turn.error?.message, steps: [...steps.values()].sort((a, b) => a.ordinal - b.ordinal) }]
  })
}

/** The feed's agent_id owns the task; child_agent_id identifies the child. */
export function projectKimiWebTask(sessionId: string, ownerId: string, task: any): any {
  if (typeof ownerId !== 'string' || !ownerId || typeof task?.task_id !== 'string' || !task.task_id || !['running', 'ended'].includes(task.status)) throw new KimiWebError('task_invalid')
  if (task.status === 'ended' && !['completed', 'failed', 'timed_out', 'killed', 'lost'].includes(task.outcome)) throw new KimiWebError('task_invalid')
  return { ...task, id: task.task_id, session_id: sessionId, parent_agent_id: ownerId,
    agent_id: task.child_agent_id, status: task.status === 'running' ? 'running' : task.outcome === 'killed' ? 'cancelled'
      : ['failed', 'timed_out', 'lost'].includes(task.outcome) ? 'failed' : task.outcome }
}

/** State carried by the official subscribe_v2 feed, including transcript offsets. */
export class KimiWebTranscriptState {
  epoch = ''
  session: any
  private agent: any = {}
  private usage: any = {}
  private transcripts = new Map<string, any>()
  private interactions = new Map<string, any>()
  private taskRegistry = new Map<string, any>()
  private turns = new Map<string, any[]>()

  constructor(private readonly sessionId: string) { this.session = { id: sessionId } }
  get ready(): boolean { return this.transcripts.has('main') }

  reset(epoch = this.epoch): void {
    this.epoch = epoch
    this.transcripts.clear()
    this.interactions.clear()
    this.taskRegistry.clear()
    this.turns.clear()
  }

  apply(frame: any): boolean {
    if (frame.session_id !== this.sessionId) return false
    if (frame.type === 'turns' || frame.type.startsWith('turn.') || frame.type.startsWith('turns.') || frame.type.startsWith('item.')) return this.applyTurns(frame)
    if (frame.type === 'task.list' || frame.type === 'task') {
      const rows = frame.type === 'task.list' ? frame.tasks : [frame]
      if (!Array.isArray(rows)) throw new KimiWebError('task_list_invalid')
      const tasks = rows.map(row => projectKimiWebTask(this.sessionId, frame.agent_id, row))
      for (const task of tasks) this.taskRegistry.set(task.parent_agent_id + '\0' + task.id, task)
      return true
    }
    if (frame.type === 'agent' && frame.agent_id === 'main') { this.agent = frame; return true }
    if (frame.type === 'usage' && frame.agent_id === 'main') { this.usage = frame; return true }
    if (frame.type === 'interaction') {
      this.interactions.set(frame.interaction_id, { ...frame.request, kind: frame.kind,
        [`${frame.kind}_id`]: frame.interaction_id, tool_call_id: frame.tool_call_id, pending: frame.status === 'pending' })
      return true
    }
    const payload = frame.payload
    if (!['transcript.reset', 'transcript.ops'].includes(frame.type) || !payload?.agent_id) return false
    const id = payload.agent_id
    const previous = this.transcripts.get(id)
    if (frame.type === 'transcript.reset') {
      if (!Array.isArray(payload.snapshot?.items)) throw new KimiWebError('transcript_invalid')
      this.transcripts.set(id, { ...structuredClone(payload.snapshot), seq: payload.seq ?? 0 })
      if (id === 'main') this.syncInteractions(payload.snapshot)
      return true
    }
    if (!previous || !Array.isArray(payload.ops)) throw new KimiWebError('transcript_gap')
    if (Number.isSafeInteger(payload.seq) && payload.seq <= previous.seq) return false
    const next = structuredClone(previous)
    for (const operation of payload.ops) this.operation(next, operation)
    next.seq = payload.seq ?? previous.seq
    this.transcripts.set(id, next)
    if (id === 'main') this.syncInteractions(next)
    return true
  }

  private applyTurns(frame: any): boolean {
    const id = frame.agent_id
    if (typeof id !== 'string' || !id) throw new KimiWebError('transcript_invalid')
    if (frame.type === 'turns.failed') throw new KimiWebError('turns_failed', frame.code)
    const previous = this.turns.get(id)
    if (frame.type !== 'turns' && !previous) throw new KimiWebError('transcript_gap')
    const rows = structuredClone(frame.type === 'turns' ? frame.turns : previous)
    if (!Array.isArray(rows)) throw new KimiWebError('transcript_invalid')
    if (frame.type === 'turn.started' || frame.type === 'turn.ended') {
      const index = rows.findIndex((row: any) => row.turn_id === frame.turn?.turn_id)
      const turn = { ...frame.turn, items: index < 0 ? [] : rows[index].items }
      if (index < 0) rows.push(turn)
      else rows[index] = turn
    } else if (frame.type === 'turns.removed') {
      if (!Array.isArray(frame.turn_ids)) throw new KimiWebError('transcript_invalid')
      for (let index = rows.length - 1; index >= 0; index--) if (frame.turn_ids.includes(rows[index].turn_id)) rows.splice(index, 1)
    } else if (frame.type !== 'turns') {
      const turn = rows.find((row: any) => row.turn_id === frame.turn_id)
      if (!turn) throw new KimiWebError('transcript_gap')
      if (frame.type === 'turn.updated') {
        if (frame.step) { const index = turn.steps.findIndex((step: any) => step.index === frame.step.index); if (index < 0) turn.steps.push(frame.step); else turn.steps[index] = frame.step }
        turn.retry = frame.retry
      } else {
        const index = turn.items.findIndex((item: any) => item.item_id === (frame.item?.item_id || frame.item_id))
        if (frame.type === 'item.started' || frame.type === 'item.ended') {
          if (!frame.item?.item_id) throw new KimiWebError('transcript_invalid')
          if (index < 0) turn.items.push(frame.item)
          else turn.items[index] = frame.item
        } else if (index < 0) throw new KimiWebError('transcript_gap')
        else if (frame.type === 'item.removed') turn.items.splice(index, 1)
        else if (frame.type === 'item.updated') Object.assign(turn.items[index], frame.set)
        else if (frame.type === 'item.delta') {
          if (!['text', 'input_text', 'output'].includes(frame.field) || typeof frame.delta !== 'string') throw new KimiWebError('transcript_invalid')
          turn.items[index][frame.field] = (turn.items[index][frame.field] || '') + frame.delta
        } else throw new KimiWebError('transcript_operation_unsupported')
      }
    }
    rows.sort((a: any, b: any) => a.ordinal - b.ordinal)
    const items = normalizeKimiWebTurns(rows)
    this.turns.set(id, rows)
    const prior = this.transcripts.get(id)
    this.transcripts.set(id, { items, seq: (prior?.seq || 0) + 1, hasMoreOlder: frame.type === 'turns' ? frame.has_more === true : prior?.hasMoreOlder })
    return true
  }

  private syncInteractions(transcript: any): void {
    for (const row of transcript.interactions || []) this.interactions.set(row.interactionId, {
      ...row.request, kind: row.interactionKind, [`${row.interactionKind}_id`]: row.interactionId,
      tool_call_id: row.toolCallId, pending: row.state === 'pending'
    })
  }

  private turn(state: any, id: string): any {
    let turn = state.items.find((item: any) => item.kind === 'turn' && item.turnId === id)
    if (!turn) {
      turn = { kind: 'turn', turnId: id, ordinal: Number(id.replace(/^\D+/, '')) || 0, state: 'running', origin: { kind: 'other' }, steps: [] }
      state.items.push(turn)
      state.items.sort((a: any, b: any) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
    }
    return turn
  }

  private step(turn: any, id: string): any {
    let step = turn.steps.find((item: any) => item.stepId === id)
    if (!step) {
      step = { kind: 'step', stepId: id, turnId: turn.turnId, ordinal: Number(id.slice(turn.turnId.length + 1)) || 0, state: 'running', frames: [] }
      turn.steps.push(step)
      turn.steps.sort((a: any, b: any) => a.ordinal - b.ordinal)
    }
    return step
  }

  private operation(state: any, operation: any): void {
    if (operation.op === 'turn.upsert') {
      const turn = this.turn(state, operation.turn.turnId)
      Object.assign(turn, operation.turn)
    } else if (operation.op === 'step.upsert') {
      Object.assign(this.step(this.turn(state, operation.turnId), operation.step.stepId), operation.step)
    } else if (operation.op === 'frame.upsert') {
      const step = this.step(this.turn(state, operation.turnId), operation.stepId)
      const index = step.frames.findIndex((item: any) => item.frameId === operation.frame.frameId)
      if (index < 0) step.frames.push(operation.frame)
      else step.frames[index] = operation.frame
    } else if (operation.op === 'append') {
      const turn = state.items.find((item: any) => item.kind === 'turn' && item.turnId === operation.target.turnId)
      const step = turn?.steps.find((item: any) => item.stepId === operation.target.stepId)
      const frame = step?.frames.find((item: any) => item.frameId === operation.target.frameId)
      const offset = operation.offset, text = operation.text
      if (!frame || !['text', 'thinking'].includes(frame.kind) || !Number.isSafeInteger(offset) || offset < 0 || typeof text !== 'string' || offset > frame.text.length) throw new KimiWebError('transcript_gap')
      if (frame.text.slice(offset, offset + text.length) === text) return
      if (frame.text.slice(offset) !== text.slice(0, frame.text.length - offset)) throw new KimiWebError('transcript_gap')
      frame.text = frame.text.slice(0, offset) + text
    } else if (operation.op === 'marker.upsert') {
      const index = state.items.findIndex((item: any) => item.markerId === operation.item.markerId)
      if (index >= 0) state.items[index] = operation.item
      else {
        const before = state.items.findIndex((item: any) => item.kind === 'turn' && item.ordinal >= operation.beforeTurn)
        state.items.splice(before < 0 ? state.items.length : before, 0, operation.item)
      }
    } else if (['interaction.upsert', 'attachment.upsert', 'prompt.upsert'].includes(operation.op)) {
      const [key, value, identity] = operation.op === 'interaction.upsert' ? ['interactions', operation.interaction, 'interactionId']
        : operation.op === 'attachment.upsert' ? ['attachments', operation.attachment, 'attachmentId'] : ['prompts', operation.prompt, 'promptId']
      const rows = state[key] ||= []
      const index = rows.findIndex((row: any) => row[identity] === value[identity])
      if (index < 0) rows.push(value)
      else rows[index] = value
    } else if (operation.op === 'items.remove') {
      state.items = state.items.filter((item: any) => !operation.ids.includes(item.turnId || item.markerId))
    } else if (operation.op === 'reset') {
      Object.assign(state, operation.snapshot)
    } else throw new KimiWebError('transcript_operation_unsupported')
  }

  status(): any {
    return { ...this.agent, busy: this.agent.status === 'running', context_tokens: this.usage.context_tokens,
      max_context_tokens: this.usage.max_context_tokens, thinking_level: this.agent.thinking, permission: this.agent.permission_mode }
  }

  tasks(): any[] { return structuredClone([...this.taskRegistry.values()].filter(task => task.parent_agent_id === 'main')) }

  snapshot(): KimiWebSnapshot {
    const main = this.transcripts.get('main')
    const items = main?.items || []
    const live = items.findLast((item: any) => item.kind === 'turn' && ['running', 'queued'].includes(item.state))
    const pending = [...this.interactions.values()].filter(row => row.pending)
    const events = kimiWebTranscriptEvents(items)
    return structuredClone({ as_of_seq: main?.seq ?? 0, epoch: this.epoch, transcript: items,
      session: { ...this.session, agent_config: this.status() },
      in_flight_turn: live ? { turn_id: live.turnId } : null,
      pending_approvals: pending.filter(row => row.kind === 'approval'), pending_questions: pending.filter(row => row.kind === 'question'),
      messages: { items: events.filter(event => ['user_message', 'agent_message'].includes(event.type)).map(event => ({
        id: event.payload.id, role: event.type === 'user_message' ? 'user' : 'assistant', content: [{ type: 'text', text: event.payload.text }] })), has_more: main?.hasMoreOlder === true } })
  }
}
