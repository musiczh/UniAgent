import { createHash, randomUUID } from 'node:crypto'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Attachment, Session, UAEvent } from '../shared/types'
import { isTaskTitleEligible } from '../shared/taskTitle'
import { sanitizeRouterReview } from '../shared/routerReview'
import { TASK_GENERATION_IPC, TASK_GENERATION_LABELS, type TaskGenerationConversation, type TaskGenerationKind } from '../shared/taskGeneration'
import { DeepSeekEventStore } from './deepseekEventStore'

interface GenerationInput {
  task: Session
  kind: TaskGenerationKind
  contextId?: string
  agentName: string
  model?: string
  prompt: string
  images?: Attachment[]
  signal: AbortSignal
}
interface Recording { next: number; legacy: boolean }
interface Call { taskId: string; id: string; started: number; state: Recording }
const historyId = (id: string): string => 'generation-' + createHash('sha256').update(id).digest('hex')
const hadLegacyGeneration = (session: Session): boolean => !!session.taskMetadata?.generatedAt || !!session.quickReplies?.length || session.taskMetadata?.generationState === 'failed' && session.taskMetadata.attempts > 0

/** Reuse the worker-backed event ledger; recording never delays or rejects a model call. */
export class TaskGenerationConversations {
  private readonly history: DeepSeekEventStore
  private readonly states = new Map<string, Promise<Recording>>()
  private readonly removed = new Set<string>()
  private readonly starts = new Map<string, Set<Promise<unknown>>>()
  private readonly writes = new Set<Promise<unknown>>()
  private readonly running = new Map<string, number>()

  constructor(directory: string, private readonly changed: (taskId: string) => void = () => {}) {
    this.history = new DeepSeekEventStore(directory)
  }
  private publish(id: string): void { try { this.changed(id) } catch { /* Viewing notifications cannot affect generation. */ } }
  private state(task: Session): Promise<Recording> {
    let pending = this.states.get(task.id)
    if (!pending) {
      pending = this.history.load(historyId(task.id)).then(events => ({
        next: events.reduce((maximum, event) => Math.max(maximum, event.seq), -1) + 1,
        legacy: events.length ? events.some(event => event.payload.generationCoverage && event.payload.legacyHistory) : hadLegacyGeneration(task)
      }))
      this.states.set(task.id, pending)
      void pending.catch(() => { if (this.states.get(task.id) === pending) this.states.delete(task.id) })
    }
    return pending
  }
  private append(taskId: string, state: Recording, type: UAEvent['type'], payload: UAEvent['payload'], status: UAEvent['state'] = 'success'): void {
    if (this.removed.has(taskId)) return
    this.history.append(historyId(taskId), { sessionId: historyId(taskId), seq: state.next++, ts: Date.now(), type, state: status, payload: sanitizeRouterReview(payload) })
  }
  private async begin(input: GenerationInput): Promise<Call | undefined> {
    const state = await this.state(input.task)
    if (this.removed.has(input.task.id)) return
    if (state.next === 0) this.append(input.task.id, state, 'system_notice', {
      generationCoverage: true, legacyHistory: state.legacy,
      text: state.legacy ? '旧版本未保存完整的原始生成对话；以下为开始记录后的真实调用。' : '以下为当前任务的真实生成调用记录。'
    })
    const call = { taskId: input.task.id, id: randomUUID(), started: Date.now(), state }
    this.append(call.taskId, state, 'user_message', { turnId: call.id, text: input.prompt, attachments: input.images,
      generationKind: input.kind, generationContextId: input.contextId, generationModel: input.model })
    this.append(call.taskId, state, 'turn_started', { turnId: call.id }, 'running')
    this.append(call.taskId, state, 'system_notice', { turnId: call.id,
      text: [TASK_GENERATION_LABELS[input.kind], input.agentName, input.model].filter(Boolean).join(' · ') })
    this.publish(call.taskId)
    return call
  }
  private finish(call: Call | undefined, result: { text?: string; error?: unknown; cancelled: boolean }): void {
    if (!call || this.removed.has(call.taskId)) return
    if (result.text !== undefined) this.append(call.taskId, call.state, 'agent_message', { id: call.id,
      turnId: call.id, text: result.cancelled ? '此调用已取消，以下返回内容未作为有效生成结果应用。\n\n' + result.text : result.text,
      phase: 'final_answer' }, result.cancelled ? 'cancelled' : 'success')
    else this.append(call.taskId, call.state, 'error', { turnId: call.id,
      message: result.cancelled ? '生成调用已取消。' : String(result.error instanceof Error ? result.error.message : result.error || '生成调用失败') }, result.cancelled ? 'cancelled' : 'failed')
    this.append(call.taskId, call.state, 'turn_completed', { turnId: call.id, durationMs: Date.now() - call.started }, result.cancelled ? 'cancelled' : result.text === undefined ? 'failed' : 'success')
    this.publish(call.taskId)
  }
  async run(input: GenerationInput, generate: () => Promise<string>): Promise<string> {
    const id = input.task.id
    this.running.set(id, (this.running.get(id) || 0) + 1)
    const start = this.begin(input)
    const starts = this.starts.get(id) || new Set<Promise<unknown>>()
    this.starts.set(id, starts); starts.add(start)
    void start.catch(() => { this.publish(id) }).finally(() => { starts.delete(start); if (!starts.size) this.starts.delete(id) })
    let result: { text?: string; error?: unknown; cancelled: boolean }
    try {
      const text = await generate()
      result = { text, cancelled: input.signal.aborted }
      return text
    } catch (error) { result = { error, cancelled: input.signal.aborted }; throw error }
    finally {
      const count = (this.running.get(id) || 1) - 1
      count ? this.running.set(id, count) : this.running.delete(id)
      const write = start.then(call => this.finish(call, result!)).catch(() => { this.publish(id) })
      this.writes.add(write); void write.finally(() => { this.writes.delete(write) })
      this.publish(id)
    }
  }
  async read(task: Session): Promise<TaskGenerationConversation> {
    await Promise.allSettled([...(this.starts.get(task.id) || [])])
    const state = await this.state(task)
    const events = await this.history.load(historyId(task.id))
    const running = !!this.running.get(task.id)
    // The shared transcript expects contiguous turns; concurrent generators can finish out of order.
    const calls = new Map<string, UAEvent[]>()
    for (const event of events) {
      if (event.payload.generationCoverage) continue
      const id = String(event.payload.turnId || '')
      const rows = calls.get(id) || []
      if (!calls.has(id)) calls.set(id, rows)
      rows.push({ ...event, sessionId: task.id })
    }
    const rows = [...calls.values()].flatMap(call => {
      const start = call.find(event => event.type === 'turn_started')
      if (!running && start && !call.some(event => event.type === 'turn_completed')) {
        // This derived boundary explains interrupted history without inventing a model response.
        call.push({ ...start, seq: -start.seq - 1, type: 'error', state: 'cancelled', payload: { turnId: start.payload.turnId, message: '生成调用已中断，未保存返回结果。' } },
          { ...start, seq: -start.seq - 1, type: 'turn_completed', state: 'cancelled' })
      }
      return call
    })
    return { taskId: task.id, running, legacyHistory: state.legacy, events: rows }
  }
  async remove(id: string): Promise<void> {
    this.removed.add(id)
    await Promise.allSettled([...(this.starts.get(id) || [])])
    await this.history.delete(historyId(id)); this.states.delete(id)
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.writes, ...[...this.starts.values()].flatMap(values => [...values])])
    await this.history.close()
  }
}

export function registerTaskGenerationIpc(ipc: Pick<IpcMain, 'handle'>, records: Pick<TaskGenerationConversations, 'read'>, deps: {
  trusted: (event: IpcMainInvokeEvent) => void; hydrate: () => Promise<unknown>; session: (id: string) => Session | undefined
}): void {
  ipc.handle(TASK_GENERATION_IPC.read, async (event, id: string) => {
    deps.trusted(event)
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('无效的任务查询')
    await deps.hydrate()
    const task = deps.session(id)
    if (!task || !isTaskTitleEligible(task)) throw new Error('任务不存在或没有生成会话')
    return records.read(task)
  })
}
