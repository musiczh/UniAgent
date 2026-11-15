import { buildTaskTitlePrompt, isTaskTitleEligible, parseTaskTitleResult, resolveTaskTitleConfig, type TaskTitleResult } from '../shared/taskTitle'
import type { AgentDef, CodexModelSourceRef, Session, TaskTitleGenerationConfig, TaskTitleGeneratorRef, UAEvent } from '../shared/types'
import type { TaskTitleService } from './taskTitleService'
import type { EventEmitter } from 'node:events'
import { parseCodexModelKey } from '../shared/codexModelIdentity'
import type { LocalModelsSnapshot } from '../shared/localModels'
import { taskTitleHistory } from './taskTitleContext'

export interface TaskTitleSelectionChange { agentId: string; modelSource?: CodexModelSourceRef; model?: string }
type TitleSelection = Pick<TaskTitleGenerationConfig, 'agentId' | 'model' | 'modelSource'>

/** Missing source means all connections for this program; an explicit native source is narrower. */
export function taskTitleSelectionMatches(selection: TitleSelection | undefined, change: TaskTitleSelectionChange): boolean {
  if (selection?.agentId !== change.agentId) return false
  if (change.model && (selection.model ? parseCodexModelKey(selection.model)?.model ?? selection.model : undefined) !== change.model) return false
  if (!change.modelSource) return true
  const source = selection.modelSource ?? (selection.model ? parseCodexModelKey(selection.model)?.source : undefined) ?? { kind: 'native' }
  return source.kind === change.modelSource.kind && (source.kind === 'native' || source.sourceId === change.modelSource.sourceId)
}

/** Compare only the requested model, never unrelated source catalogs or quota snapshots. */
export function taskTitleGeneratorSignature(selection: TitleSelection | undefined, agents: AgentDef[]): string {
  const agent = agents.find(value => value.id === selection?.agentId)
  const source = selection?.modelSource ?? { kind: 'native' }
  return JSON.stringify(agent ? { id: agent.id, bin: agent.bin, adapter: agent.adapter, installed: agent.installed,
    authenticationRequired: agent.authenticationRequired, incompatible: agent.incompatible,
    model: agent.models.find(model => {
      const modelSource = model.modelSource ?? { kind: 'native' }
      return model.id === selection?.model && source.kind === modelSource.kind
        && (source.kind === 'native' || source.sourceId === modelSource.sourceId)
    }), version: agent.version,
    currentVersion: agent.lifecycle?.currentVersion, availability: agent.lifecycle?.availability,
    health: agent.lifecycle?.health, auth: agent.lifecycle?.auth, capabilities: agent.capabilities } : null)
}

/** Keep source UI status forwarding separate from naming invalidation. */
export function bindTaskTitleSourceChanges(source: EventEmitter, agentId: string, invalidate: (change: TaskTitleSelectionChange) => void): void {
  source.on('connectionChanged', (change: { sourceIds: string[] }) => {
    for (const sourceId of change.sourceIds) invalidate({ agentId, modelSource: { kind: 'third-party', sourceId } })
  })
}

export function bindTaskTitleLocalSourceChanges(source: EventEmitter, invalidate: (change: TaskTitleSelectionChange) => void): void {
  let signature: string | undefined
  let operation: string | undefined
  const connection = { agentId: 'codex', modelSource: { kind: 'local' as const, sourceId: 'bonsai' } }
  source.on('changed', (snapshot: LocalModelsSnapshot) => {
    const active = snapshot.models.find(model => model.id === snapshot.activeModelId)
    const next = JSON.stringify({ availability: snapshot.availability, packageVersion: snapshot.packageVersion,
      activeModelId: snapshot.activeModelId, connection: snapshot.connection,
      active: active && { id: active.id, healthy: active.healthy, deploymentState: active.deploymentState, catalogEntry: active.catalogEntry } })
    const changed = signature !== undefined && next !== signature
    signature = next
    // A same-model redeploy may keep the endpoint unchanged. Invalidate once at
    // its explicit operation boundary; repeated progress/log updates do nothing.
    const command = snapshot.operation
    const currentOperation = command && ['deploy', 'stop', 'remove'].includes(command.operation)
      ? JSON.stringify([command.operation, command.modelId]) : undefined
    const starting = currentOperation !== undefined && currentOperation !== operation
    operation = currentOperation
    if (changed) invalidate(connection)
    else if (starting) invalidate({ ...connection, ...(command?.operation === 'remove' && command.modelId ? { model: command.modelId } : {}) })
  })
}

type PendingInput = {
  event: UAEvent
  accepted: boolean
  completed: boolean
  turnId?: string
  reply?: { id?: string; text: string }
  latestReply?: { id?: string; text: string }
  finalResponse?: string
  previousResponse?: string
}

/** Ordinary managed tasks use the independent service, even while unconfigured or disabled. */
export function taskTitleSessionPolicy(session: Session): boolean {
  return !isTaskTitleEligible(session) || !!session.readOnly || session.origin === 'imported'
}

/** Main live stream only. Stored history, side streams and init do not call this bridge. */
export class TaskTitleIntegration {
  private readonly inputs = new Map<string, PendingInput>()
  constructor(private readonly service: Pick<TaskTitleService, 'accepted' | 'responded' | 'cancel'> & Partial<Pick<TaskTitleService, 'completed'>>,
    private readonly session: (id: string) => Session | undefined,
    private readonly history?: (id: string) => readonly UAEvent[]) {}

  observe(event: UAEvent): void {
    const session = this.session(event.sessionId)
    if (!session || !isTaskTitleEligible(session) || session.archived) return
    if (event.type === 'user_message' || event.type === 'goal_message') {
      const previous = this.inputs.get(event.sessionId)
      if (previous?.event.seq === event.seq && previous.event.ts === event.ts) return
      if (event.payload.automaticRecovery || event.payload.recoveryIntermediate || event.payload.source === 'mcp') {
        this.inputs.delete(event.sessionId)
        return
      }
      this.inputs.set(event.sessionId, { event, accepted: false, completed: false,
        previousResponse: previous?.finalResponse || previous?.latestReply?.text,
        ...(event.payload.appendedToTurn === true ? { turnId: previous?.turnId } : {}) })
      return
    }
    if (event.payload.automaticRecovery || event.payload.recoveryIntermediate || event.payload.delivery === 'async') return
    const input = this.inputs.get(event.sessionId)
    if (!input) return
    const turnId = typeof event.payload.turnId === 'string' && event.payload.turnId.trim() || undefined
    if (event.type === 'turn_started') {
      if (turnId && input.turnId && input.turnId !== turnId) input.reply = undefined
      if (turnId) input.turnId = turnId
      return
    }
    if (turnId && input.turnId && turnId !== input.turnId) return
    if (event.type === 'agent_message' && event.payload.kind !== 'thinking' && !['failed', 'cancelled'].includes(event.state || '')) {
      const id = typeof event.payload.id === 'string' ? event.payload.id : undefined
      const latest = input.latestReply
      const latestText = typeof event.payload.text === 'string' ? event.payload.text
        : typeof event.payload.delta === 'string' ? (latest && latest.id === id ? latest.text : '') + event.payload.delta : ''
      if (latestText.trim()) {
        input.latestReply = { id, text: latestText }
        if (event.payload.phase === 'final_answer') input.finalResponse = latestText
      }
      if (input.completed) return
      const text = typeof event.payload.text === 'string' ? event.payload.text
        : typeof event.payload.delta === 'string' ? (input.reply && input.reply.id === id ? input.reply.text : '') + event.payload.delta : ''
      if (!text.trim()) return
      if (input.reply && input.reply.id !== id) { input.completed = true; return }
      input.reply = { id, text }
      if (event.state !== 'running') input.completed = true
      if (input.accepted) this.responded(event.sessionId, input)
      return
    }
    if (event.type === 'turn_completed' || input.reply && ['tool_call', 'command_exec', 'file_change', 'approval_request', 'reasoning'].includes(event.type)) input.completed = true
    if (event.type === 'turn_completed' && input.accepted && !['failed', 'cancelled'].includes(event.state || '')) {
      const response = input.finalResponse || input.latestReply?.text
      if (response) this.service.completed?.(event.sessionId, response, `${event.sessionId}:${input.event.seq}:${input.event.ts}`)
    }
  }

  accepted(id: string): void {
    const input = this.inputs.get(id)
    if (!input || input.accepted) return
    input.accepted = true
    const event = input.event
    let previousResponse = input.previousResponse
    let history: NonNullable<Parameters<TaskTitleService['accepted']>[2]['history']> = []
    if (this.history) {
      history = taskTitleHistory(this.history(id), id, event.seq)
      previousResponse = history.at(-1)?.finalResponse || previousResponse
    }
    this.service.accepted(id, String(event.payload.displayText || event.payload.text || ''), {
      inputId: `${id}:${event.seq}:${event.ts}`,
      inputSequence: event.seq,
      previousAssistantResponse: previousResponse,
      history,
      attachments: Array.isArray(event.payload.attachments)
        ? event.payload.attachments.map((item: any) => typeof item?.name === 'string' ? item.name : '').filter(Boolean) : undefined,
      images: Array.isArray(event.payload.attachments) ? event.payload.attachments.filter((item: any) => item?.kind === 'image') : undefined
    })
    if (input.reply) this.responded(id, input)
  }

  private responded(id: string, input: PendingInput): void {
    this.service.responded(id, input.reply!.text, `${id}:${input.event.seq}:${input.event.ts}`)
  }

  remove(id: string): void { this.inputs.delete(id); this.service.cancel(id) }
}

interface Trial { id: string; controller: AbortController; flight: Promise<TaskTitleResult>; selection: TaskTitleGeneratorRef; signature: string }
export interface TaskTitleTrialInput { requestId: string; config: TaskTitleGenerationConfig; prompt: string }

/** Explicit unsaved-draft probes share no Session, lifecycle or task transcript. */
export class TaskTitleTrials {
  private readonly requests = new Map<number, Trial>()
  constructor(private readonly agents: () => AgentDef[], private readonly generate:
    (agent: AgentDef, config: TaskTitleGeneratorRef, prompt: string, signal: AbortSignal) => Promise<string>) {}

  async run(owner: number, value: TaskTitleTrialInput): Promise<TaskTitleResult> {
    if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.requestId)
      || typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 8192
      || !value.config || typeof value.config !== 'object') throw new Error('无效标题试生成请求')
    const selection = resolveTaskTitleConfig({ ...value.config, enabled: true }, this.agents())
    if (!selection.enabled || !selection.agent || !selection.config) throw new Error(selection.reason || '标题模型不可用')
    if (!this.requests.has(owner) && this.requests.size >= 4) throw new Error('标题试生成繁忙，请稍后重试')
    this.requests.get(owner)?.controller.abort()
    const controller = new AbortController()
    const prompt = buildTaskTitlePrompt({ primaryIntent: value.prompt })
    const operation = this.generate(selection.agent, selection.config, prompt, controller.signal)
    const flight = operation.then(text => {
      if (controller.signal.aborted) throw new Error('标题试生成已取消')
      return parseTaskTitleResult(text)
    })
    const entry = { id: value.requestId, controller, flight, selection: structuredClone(selection.config),
      signature: taskTitleGeneratorSignature(selection.config, this.agents()) }
    this.requests.set(owner, entry)
    try { return await flight }
    finally { if (this.requests.get(owner) === entry) this.requests.delete(owner) }
  }

  cancel(owner: number, id?: string): void {
    const request = this.requests.get(owner)
    if (request && (id === undefined || request.id === id)) request.controller.abort()
  }
  cancelAll(): void { for (const request of this.requests.values()) request.controller.abort() }
  selectionChanged(change: TaskTitleSelectionChange): void {
    for (const request of this.requests.values()) if (taskTitleSelectionMatches(request.selection, change)) request.controller.abort()
  }
  agentsChanged(): void {
    const agents = this.agents()
    for (const request of this.requests.values()) {
      if (request.signature !== taskTitleGeneratorSignature(request.selection, agents)) request.controller.abort()
    }
  }
  async close(): Promise<void> { this.cancelAll(); await Promise.allSettled([...this.requests.values()].map(value => value.flight)) }
}
