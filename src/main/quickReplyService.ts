import { buildQuickReplyPrompt, parseQuickReplies } from '../shared/quickReplies'
import { isTaskTitleEligible, resolveTaskTitleConfig, sanitizeTaskTitleSeed } from '../shared/taskTitle'
import type { AgentDef, Session, TaskTitleGenerationConfig, TaskTitleGeneratorRef, UAEvent } from '../shared/types'

interface Round {
  input: string; inputKey: string; accepted: boolean; ended: boolean; scheduled: boolean; turnId?: string
  finalId?: string
  replies: Map<string, string>; controller: AbortController
}
interface Dependencies {
  session(id: string): Session | undefined
  agents(): AgentDef[]
  config(): { enabled: boolean; model?: TaskTitleGenerationConfig }
  generate(agent: AgentDef, config: TaskTitleGeneratorRef, prompt: string, signal: AbortSignal, id: string): Promise<string>
  publish(session: Session): void
}

/** Live main rounds only; suggestion state never changes the task lifecycle. */
export class QuickReplyService {
  private readonly rounds = new Map<string, Round>()
  private readonly queue: Array<{ id: string; round: Round }> = []
  private readonly flights = new Set<Promise<void>>()
  private active = false
  private closed = false
  constructor(private readonly deps: Dependencies) {}

  observe(event: UAEvent): void {
    if (this.closed) return
    const session = this.deps.session(event.sessionId)
    if (!session || !isTaskTitleEligible(session) || session.readOnly || session.archived) return
    if (event.payload.automaticRecovery || event.payload.recoveryIntermediate || event.payload.delivery === 'async') return
    if (event.type === 'user_message' || event.type === 'goal_message') {
      const inputKey = `${event.seq}:${event.ts}`
      if (this.rounds.get(session.id)?.inputKey === inputKey) return
      this.remove(session.id)
      const text = event.payload.displayText || event.payload.text || (event.payload.attachments?.length ? '用户发送了附件，请结合最终回复判断下一步。' : '')
      if (typeof text !== 'string' || !text.trim()) return
      this.rounds.set(session.id, { input: sanitizeTaskTitleSeed({ primaryIntent: text }).primaryIntent, inputKey,
        accepted: false, ended: false, scheduled: false, replies: new Map(), controller: new AbortController() })
      return
    }
    const round = this.rounds.get(session.id)
    if (!round || round.ended) return
    const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : undefined
    if (event.type === 'turn_started') { if (round.turnId && turnId !== round.turnId) { round.replies.clear(); round.finalId = undefined }; round.turnId = turnId; return }
    if (round.turnId && turnId && round.turnId !== turnId) return
    if (event.type === 'agent_message' && event.payload.kind !== 'thinking' && !['failed','cancelled'].includes(event.state || '')) {
      const key = event.payload.messageId || event.payload.id || 'last'
      const text = typeof event.payload.text === 'string' ? event.payload.text
        : typeof event.payload.delta === 'string' ? (round.replies.get(key) || '') + event.payload.delta : ''
      if (text.trim()) round.replies.set(key, sanitizeTaskTitleSeed({ primaryIntent: '', assistantResponse: text }).assistantResponse || '')
      if (event.payload.phase === 'final_answer') round.finalId = key
    }
    if (event.type === 'turn_completed') {
      round.ended = true
      if (['failed','cancelled'].includes(event.state || '') || !this.response(round).trim()) return
      this.schedule(session.id, round)
    }
  }

  accepted(id: string): void {
    const round = this.rounds.get(id)
    if (!round) return
    round.accepted = true
    if (round.ended) this.schedule(id, round)
  }
  private schedule(id: string, round: Round): void {
    if (!round.accepted || round.scheduled || round.controller.signal.aborted) return
    if (!this.deps.config().enabled || this.queue.length >= 128) return
    round.scheduled = true
    this.queue.push({ id, round }); this.pump()
  }
  private pump(): void {
    if (this.closed || this.active) return
    const next = this.queue.shift()
    if (!next) return
    this.active = true
    const flight = this.generate(next.id, next.round).finally(() => { this.active = false; this.flights.delete(flight); this.pump() })
    this.flights.add(flight)
  }
  private async generate(id: string, round: Round): Promise<void> {
    const selection = resolveTaskTitleConfig({ ...this.deps.config().model, enabled: true }, this.deps.agents())
    if (!this.current(id, round) || !selection.enabled || !selection.agent || !selection.config) return
    try {
      const text = await this.deps.generate(selection.agent, selection.config,
        buildQuickReplyPrompt(round.input, this.response(round)), round.controller.signal, id)
      if (!this.current(id, round)) return
      const session = this.deps.session(id)!
      const replies = parseQuickReplies(text)
      session.quickReplies = replies.length ? replies : undefined
      this.deps.publish(session)
    } catch { /* Suggestions are optional; leave the original input available. */ }
  }
  private response(round: Round): string { return (round.finalId ? round.replies.get(round.finalId) : [...round.replies.values()].at(-1)) || '' }
  private current(id: string, round: Round): boolean {
    const session = this.deps.session(id)
    return !this.closed && !round.controller.signal.aborted && this.rounds.get(id) === round && this.deps.config().enabled && !!session && !session.archived && !session.readOnly
  }
  remove(id: string): void {
    this.rounds.get(id)?.controller.abort()
    this.rounds.delete(id)
    const session = this.deps.session(id)
    if (session?.quickReplies) { session.quickReplies = undefined; this.deps.publish(session) }
  }
  configurationChanged(): void { for (const id of this.rounds.keys()) this.remove(id) }
  async close(): Promise<void> { this.closed = true; this.configurationChanged(); this.queue.length = 0; await Promise.allSettled(this.flights) }
}
