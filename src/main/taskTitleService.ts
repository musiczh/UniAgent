import { randomUUID } from 'node:crypto'
import { buildTaskTitlePrompt, isTaskTitleEligible, parseTaskTitleResult, resolveTaskTitleConfig, sanitizeTaskTitleSeed, taskTitleContextVersion, taskTitleSupportsImages } from '../shared/taskTitle'
import type { AgentDef, Attachment, Session, TaskTitleGenerationConfig, TaskTitleGeneratorRef, TaskTitleMetadata, TaskTitleSeed, UAEvent } from '../shared/types'
import { TaskMetadataStore } from './taskMetadataStore'
import { taskTitleHistory, taskTitleReplay } from './taskTitleContext'
import type { TaskTitleContextTurn } from './taskTitleContext'
import { validateTaskDescription } from './taskTitleTokens'

export interface TaskTitleAcceptedIdentity {
  inputId: string
  inputSequence?: number
  attachments?: string[]
  assistantResponse?: string
  previousAssistantResponse?: string
  history?: TaskTitleContextTurn[]
  images?: Attachment[]
}

export interface TaskTitleServiceDeps {
  session(id: string): Session | undefined
  agents(): AgentDef[]
  config(): TaskTitleGenerationConfig | undefined
  history?(id: string): Promise<readonly UAEvent[]>
  generate(agent: AgentDef, config: TaskTitleGeneratorRef, prompt: string, signal: AbortSignal, images?: Attachment[], sessionId?: string, options?: { summary: true }, taskId?: string): Promise<string>
  validateDescription?(text: string): Promise<void>
  release?(conversationId: string): void | Promise<void>
  publish?(session: Session): void
  now?(): number
  setTimeout?(fn: () => void, ms?: number): ReturnType<typeof setTimeout>
  clearTimeout?(timer: ReturnType<typeof setTimeout>): void
}

export interface TaskTitleServiceOptions {
  debounceMs?: number
  timeoutMs?: number
  retryBackoffMs?: number
  maxAttempts?: number
  concurrency?: number
  maxQueue?: number
}

interface RuntimeEntry {
  accepted?: { key: string; inputId: string; seed: TaskTitleSeed; inputSequence?: number }
  responseReady: boolean
  retryCount: number
  queued: boolean
  deferred: boolean
  runToken?: symbol
  seedWrite?: Promise<void>
  pendingSeed?: Pick<TaskTitleMetadata, 'seed' | 'clarificationCount'>
  seedError?: string
  retryTimer?: ReturnType<typeof setTimeout>
  debounceTimer?: ReturnType<typeof setTimeout>
  debounceDueAt?: number
  controller?: AbortController
  generationId?: string
  abortReason?: string
  cancelledInputId?: string
  rescheduleAfterRelease?: boolean
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'timeout', 'task_description_too_long'])

export class TaskTitleService {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly active = new Map<string, symbol>()
  private readonly flights = new Set<Promise<void>>()
  private readonly queue: string[] = []
  private readonly deferred: string[] = []
  private closed = false
  private readonly debounceMs: number
  private readonly timeoutMs: number
  private readonly retryBackoffMs: number
  private readonly maxAttempts: number
  private readonly concurrency: number
  private readonly maxQueue: number
  private readonly now: () => number
  private readonly defer: (fn: () => void, ms?: number) => ReturnType<typeof setTimeout>
  private readonly clearDeferred: (timer: ReturnType<typeof setTimeout>) => void

  constructor(readonly store: TaskMetadataStore, private readonly deps: TaskTitleServiceDeps, options: TaskTitleServiceOptions = {}) {
    this.debounceMs = options.debounceMs ?? 800
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.retryBackoffMs = options.retryBackoffMs ?? 30_000
    this.maxAttempts = options.maxAttempts ?? 2
    this.concurrency = options.concurrency ?? 1
    this.maxQueue = options.maxQueue ?? 128
    this.now = deps.now ?? (() => Date.now())
    this.defer = deps.setTimeout ?? setTimeout
    this.clearDeferred = deps.clearTimeout ?? clearTimeout
  }

  accepted(id: string, input: string, identity: TaskTitleAcceptedIdentity): void {
    if (this.closed) return
    const session = this.deps.session(id)
    if (!session) return
    const entry = this.entry(id)
    const seed = sanitizeTaskTitleSeed({
      primaryIntent: input,
      inputId: identity.inputId,
      currentInput: input,
      previousAssistantResponse: identity.previousAssistantResponse,
      assistantResponse: identity.assistantResponse,
      images: identity.images,
      attachmentHints: identity.attachments
    })
    const key = JSON.stringify([identity.inputId, seed])
    if (entry.accepted?.key === key && !entry.seedError) return
    const current = this.current(session)
    if (!current) return
    if (entry.cancelledInputId === identity.inputId) return
    if (current.generatedInputId === identity.inputId) return
    const acceptedContext = entry.seedWrite && entry.pendingSeed ? { ...current, ...entry.pendingSeed } : current
    const nextSeed = this.mergeAcceptedSeed(acceptedContext, seed)
    if (!nextSeed) {
      return
    }
    entry.accepted = { key, inputId: identity.inputId, seed, inputSequence: identity.inputSequence }
    entry.cancelledInputId = undefined
    entry.responseReady = false
    entry.retryCount = 0
    entry.debounceDueAt = this.now() + this.debounceMs
    entry.seedError = undefined
    entry.pendingSeed = {
      seed: nextSeed.seed,
      clarificationCount: Math.min(1, acceptedContext.clarificationCount + (nextSeed.usedClarification ? 1 : 0))
    }
    if (entry.retryTimer) this.clearDeferred(entry.retryTimer)
    if (entry.debounceTimer) this.clearDeferred(entry.debounceTimer)
    entry.retryTimer = undefined
    entry.debounceTimer = undefined
    if (this.active.has(id)) {
      // The superseded flight keeps its slot until settlement, even if the
      // generator ignores abort. Revisit the latest input through both gates.
      entry.rescheduleAfterRelease = true
      entry.abortReason = 'context-change'
      entry.controller?.abort()
    }
    let persisted = false
    const pending = this.store.contexts.update(id, async context => {
      if (!context.turns.length) {
        const history = this.deps.history ? taskTitleHistory(await this.deps.history(id), id, identity.inputSequence) : identity.history || []
        context.turns = history.filter(turn => turn.inputId !== identity.inputId).map(turn => {
          const clean = sanitizeTaskTitleSeed({ primaryIntent: turn.input, assistantResponse: turn.finalResponse || turn.initialResponse })
          return { inputId: turn.inputId, input: clean.primaryIntent, initialResponse: clean.assistantResponse, finalResponse: clean.assistantResponse }
        })
      }
      let turn = context.turns.find(turn => turn.inputId === identity.inputId)
      if (!turn) {
        const previous = context.turns.at(-1)
        if (previous && seed.previousAssistantResponse) previous.finalResponse = seed.previousAssistantResponse
        turn = { inputId: identity.inputId, input: seed.primaryIntent }
        context.turns.push(turn)
      }
      if (seed.assistantResponse) turn.initialResponse = seed.assistantResponse
    }).then(context => this.store.update(session, metadata => {
      if (entry.cancelledInputId === identity.inputId || this.closed) return false
      if (!metadata.seed && context.turns[0]?.inputId !== identity.inputId) metadata.seed = { primaryIntent: context.turns[0].input }
      const merged = this.mergeAcceptedSeed(metadata, seed)
      if (!merged) return false
      metadata.seed = merged.seed
      metadata.conversationId = context.id
      metadata.contextGeneration += 1
      metadata.contextVersion = taskTitleContextVersion(metadata.seed, metadata.contextGeneration)
      metadata.generationId = undefined
      metadata.generator = undefined
      metadata.lastErrorCode = undefined
      metadata.nextEligibleAt = undefined
      metadata.attempts = 0
      if (merged.usedClarification) metadata.clarificationCount = Math.min(1, metadata.clarificationCount + 1)
      metadata.generationState = 'pending'
    })).then(() => {
      persisted = true
      entry.seedError = undefined
    }).catch(error => {
      entry.seedError = this.classify(error).code
      throw error
    }).finally(() => {
      if (entry.seedWrite === pending) {
        entry.seedWrite = undefined
        entry.pendingSeed = undefined
      }
      if (persisted && entry.accepted?.key === key) this.schedule(id)
    })
    entry.seedWrite = pending
    void pending.catch(() => {})
  }

  responded(id: string, response: string, inputId: string): void {
    if (this.closed) return
    const entry = this.entries.get(id)
    if (!entry?.accepted || !response.trim() || inputId !== entry.accepted.inputId) return
    if (entry.responseReady && (this.active.has(id) || entry.debounceDueAt !== undefined && this.now() >= entry.debounceDueAt)) return
    const dueAt = entry.responseReady ? entry.debounceDueAt : undefined
    const { seed } = entry.accepted
    this.accepted(id, seed.primaryIntent, { inputId: entry.accepted.inputId, attachments: seed.attachmentHints, images: seed.images,
      inputSequence: entry.accepted.inputSequence, previousAssistantResponse: seed.previousAssistantResponse, assistantResponse: response })
    if (dueAt !== undefined) entry.debounceDueAt = dueAt
    entry.responseReady = true
    if (entry.seedWrite) {
      void entry.seedWrite.then(() => {
        if (this.closed || entry.seedWrite || entry.seedError) return
        this.schedule(id)
      }).catch(() => {})
    }
    this.schedule(id)
  }

  completed(id: string, response: string, inputId: string): void {
    if (this.closed || !response.trim()) return
    const clean = sanitizeTaskTitleSeed({ primaryIntent: '', assistantResponse: response }).assistantResponse
    if (!clean) return
    void this.store.contexts.update(id, context => {
      const turn = context.turns.find(turn => turn.inputId === inputId)
      if (turn) turn.finalResponse = clean
    }).catch(() => {})
  }

  async rename(id: string, title: string): Promise<void> {
    const session = this.deps.session(id)
    if (!session) return
    const entry = this.entries.get(id)
    if (entry) {
      entry.rescheduleAfterRelease = false
      entry.cancelledInputId = entry.accepted?.inputId
      entry.responseReady = false
    }
    this.abortEntry(id, entry, 'rename')
    await this.store.update(session, metadata => {
      metadata.title = title.trim() || session.title || undefined
      metadata.source = 'manual'
      metadata.generationState = 'ready'
      metadata.generationId = undefined
      metadata.lastErrorCode = undefined
      metadata.nextEligibleAt = undefined
      metadata.generatedAt = undefined
      metadata.generator = undefined
    })
    this.publish(session)
  }

  cancel(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      entry.rescheduleAfterRelease = false
      entry.cancelledInputId = entry.accepted?.inputId
      entry.responseReady = false
    }
    this.abortEntry(id, entry, 'cancel')
    if (this.deps.release) void this.store.contexts.current(id).then(context => this.deps.release?.(context.id)).catch(() => {})
  }

  async recover(sessions: Session[]): Promise<void> {
    if (this.closed) return
    const resumable: Array<{ session: Session; metadata: TaskTitleMetadata; seed: TaskTitleSeed }> = []
    for (const session of sessions) {
      if (this.closed) return
      if (!this.canGenerate(session)) continue
      const metadata = this.current(session)
      const seed = metadata?.seed ? sanitizeTaskTitleSeed(metadata.seed) : undefined
      if (!metadata || !seed?.assistantResponse) continue
      if (metadata.generationState === 'ready') continue
      if (metadata.generationState !== 'running' && metadata.generationState !== 'deferred' && metadata.generationState !== 'pending') continue
      let recovered = metadata
      if (metadata.generationState === 'running') {
        const countedAttempts = Math.max(metadata.attempts, 1)
        recovered = await this.store.update(session, current => {
          if (current.generationState === 'ready') return false
          if (current.generationState !== 'running') return false
          current.generationId = undefined
          current.attempts = countedAttempts
          if (countedAttempts >= this.maxAttempts) {
            current.generationState = 'failed'
            current.lastErrorCode = 'attempts-exhausted'
            current.nextEligibleAt = undefined
          } else {
            current.generationState = 'deferred'
            current.lastErrorCode = 'recovered-running'
            current.nextEligibleAt = Math.max(current.nextEligibleAt || 0, this.now() + this.retryBackoffMs)
          }
        }).catch(() => metadata)
      } else if (metadata.attempts >= this.maxAttempts) {
        recovered = await this.store.update(session, current => {
          if (current.generationState !== 'deferred') return false
          current.generationId = undefined
          current.generationState = 'failed'
          current.lastErrorCode = 'attempts-exhausted'
          current.nextEligibleAt = undefined
        }).catch(() => metadata)
      }
      if (recovered.generationState !== 'deferred') continue
      resumable.push({ session, metadata: recovered, seed })
    }
    await this.store.flush()
    for (const { session, metadata: recovered, seed } of resumable) {
      if (this.closed) return
      const entry = this.entry(session.id)
      entry.accepted = {
        key: JSON.stringify(['recover', recovered.contextVersion || recovered.version, seed.primaryIntent, seed.attachmentHints || []]),
        inputId: `recover:${session.id}`,
        seed
      }
      entry.responseReady = true
      entry.retryCount = recovered.attempts
      entry.seedError = undefined
      entry.debounceDueAt = this.now()
      if (recovered.nextEligibleAt && recovered.nextEligibleAt > this.now()) this.scheduleRetry(session.id, recovered.nextEligibleAt)
      else this.schedule(session.id)
    }
  }

  configurationChanged(): void {
    if (this.closed) return
    for (const id of this.entries.keys()) {
      const session = this.deps.session(id)
      const entry = this.entries.get(id)
      if (!session || !entry) continue
      entry.rescheduleAfterRelease = this.active.has(id)
      this.abortEntry(id, entry, 'config-change')
      void this.store.update(session, metadata => {
        metadata.configVersion += 1
        metadata.generationId = undefined
        metadata.generator = undefined
        metadata.lastErrorCode = undefined
        if (metadata.generationState === 'ready') return
        metadata.generationState = this.canGenerate(session) ? 'deferred' : metadata.generationState
      }).then(() => {
        this.publish(session)
      }).catch(() => {
      }).finally(() => {
        const latest = this.entries.get(id)
        if (!latest || this.active.has(id)) return
        latest.rescheduleAfterRelease = false
        this.schedule(id)
      })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const [id, entry] of this.entries) {
      entry.rescheduleAfterRelease = false
      this.abortEntry(id, entry, 'close')
    }
    this.queue.length = 0
    this.deferred.length = 0
    await Promise.all([...this.flights].map(flight => flight.catch(() => {})))
    await this.store.flush()
  }

  private entry(id: string): RuntimeEntry {
    const existing = this.entries.get(id)
    if (existing) return existing
    const created: RuntimeEntry = { responseReady: false, retryCount: 0, queued: false, deferred: false }
    this.entries.set(id, created)
    return created
  }

  private publish(session: Session | undefined): void {
    if (session) this.deps.publish?.(session)
  }

  private canGenerate(session: Session): boolean {
    return isTaskTitleEligible(session) && !session.readOnly && !session.archived
  }

  private current(session: Session): TaskTitleMetadata | undefined {
    try { return this.store.current(session) } catch { return undefined }
  }

  private mergeAcceptedSeed(metadata: TaskTitleMetadata, accepted: TaskTitleSeed): { seed: TaskTitleSeed; usedClarification: boolean } | undefined {
    if (!metadata.seed) return { seed: accepted, usedClarification: false }
    if (metadata.seed.inputId === accepted.inputId) {
      if (!accepted.assistantResponse || metadata.seed.assistantResponse === accepted.assistantResponse) return undefined
      return { seed: sanitizeTaskTitleSeed({ ...metadata.seed, assistantResponse: accepted.assistantResponse }), usedClarification: false }
    }
    const intent = accepted.primaryIntent.trim()
    const clarification = sanitizeTaskTitleSeed({ primaryIntent: '', clarifications: [intent] }).clarifications?.[0] || ''
    const currentClarifications = metadata.seed.clarifications || []
    const nextClarifications = [...currentClarifications]
    let usedClarification = false
    if (clarification && intent !== metadata.seed.primaryIntent && !currentClarifications.includes(clarification)) {
      nextClarifications.push(clarification)
      usedClarification = true
    }
    const attachmentHints = [...new Set([...(metadata.seed.attachmentHints || []), ...(accepted.attachmentHints || [])])]
    const images = [...new Map([...(metadata.seed.images || []), ...(accepted.images || [])].map(image => [image.path, image])).values()]
    const assistantResponse = accepted.assistantResponse
    const merged = sanitizeTaskTitleSeed({
      primaryIntent: metadata.seed.primaryIntent,
      inputId: accepted.inputId,
      currentInput: accepted.currentInput ?? accepted.primaryIntent,
      previousAssistantResponse: accepted.previousAssistantResponse,
      ...(assistantResponse ? { assistantResponse } : {}),
      ...(nextClarifications.length ? { clarifications: nextClarifications } : {}),
      ...(attachmentHints.length ? { attachmentHints } : {}),
      ...(images.length ? { images } : {})
    })
    if (JSON.stringify(merged) === JSON.stringify(metadata.seed)) return undefined
    return { seed: merged, usedClarification }
  }

  private schedule(id: string): void {
    if (this.closed) return
    const session = this.deps.session(id)
    if (!session) return
    const entry = this.entry(id)
    if (!entry.responseReady || !entry.accepted || entry.seedWrite || entry.seedError || this.active.has(id)) return
    if (entry.cancelledInputId === entry.accepted.inputId) return
    const metadata = this.current(session)
    if (!metadata) return
    if (metadata.generationState === 'ready') return
    if (metadata.generationState === 'needs-context' && metadata.clarificationCount >= 1) return
    if (metadata.nextEligibleAt && metadata.nextEligibleAt > this.now()) {
      this.scheduleRetry(id, metadata.nextEligibleAt)
      return
    }
    if (!this.canGenerate(session)) return
    const resolved = resolveTaskTitleConfig(this.deps.config(), this.deps.agents())
    if (!resolved.enabled || !resolved.agent || !resolved.config) {
      this.startRun(id)
      return
    }
    if (entry.debounceTimer) this.clearDeferred(entry.debounceTimer)
    const dueAt = entry.debounceDueAt ?? (this.now() + this.debounceMs)
    const delay = dueAt - this.now()
    if (delay <= 0) {
      entry.debounceTimer = undefined
      this.startOrQueue(id)
      return
    }
    entry.debounceTimer = this.defer(() => {
      entry.debounceTimer = undefined
      this.startOrQueue(id)
    }, delay)
  }

  private enqueue(id: string): boolean {
    const entry = this.entry(id)
    if (entry.queued) return true
    if (this.queue.length >= this.maxQueue) return false
    entry.queued = true
    entry.deferred = false
    this.queue.push(id)
    return true
  }

  private deferQueue(id: string): void {
    const session = this.deps.session(id)
    const entry = this.entry(id)
    if (!session || entry.deferred || entry.queued) return
    entry.deferred = true
    this.deferred.push(id)
    void this.store.update(session, metadata => {
      if (metadata.generationState === 'ready') return false
      metadata.generationState = 'deferred'
      metadata.generationId = undefined
    }).then(() => this.publish(session)).catch(() => {})
  }

  private refillDeferred(): void {
    if (this.closed) return
    while (this.deferred.length && this.queue.length < this.maxQueue) {
      const id = this.deferred.shift()!
      const entry = this.entries.get(id)
      const session = this.deps.session(id)
      if (!entry || !session || !entry.deferred) continue
      entry.deferred = false
      if (!entry.responseReady || !entry.accepted || entry.seedWrite || entry.seedError) continue
      if (!this.canGenerate(session)) continue
      const metadata = this.current(session)
      if (!metadata) continue
      if (metadata.generationState === 'ready') continue
      if (this.active.size < this.concurrency && this.queue.length === 0) this.startRun(id)
      else {
        entry.queued = true
        this.queue.push(id)
      }
    }
  }

  private dequeue(): void {
    if (this.closed || this.active.size >= this.concurrency) return
    while (this.queue.length) {
      const id = this.queue.shift()!
      const entry = this.entries.get(id)
      if (!entry) continue
      entry.queued = false
      if (!entry.responseReady || !entry.accepted || entry.seedWrite || entry.seedError) continue
      this.startRun(id)
      if (this.active.size >= this.concurrency) break
    }
  }

  private startOrQueue(id: string): void {
    if (this.closed) return
    if (this.active.size < this.concurrency) this.startRun(id)
    else this.enqueue(id) || this.deferQueue(id)
  }

  private scheduleRetry(id: string, retryAt: number): void {
    const entry = this.entries.get(id)
    if (!entry || this.closed) return
    if (entry.retryTimer) this.clearDeferred(entry.retryTimer)
    const delay = retryAt - this.now()
    if (delay <= 0) {
      entry.retryTimer = undefined
      this.startOrQueue(id)
      return
    }
    entry.retryTimer = this.defer(() => {
      entry.retryTimer = undefined
      if (this.closed) return
      this.scheduleRetry(id, retryAt)
    }, delay)
  }

  private startRun(id: string): void {
    if (this.closed) return
    if (this.active.has(id)) return
    const token = Symbol(id)
    this.active.set(id, token)
    const entry = this.entry(id)
    entry.runToken = token
    entry.abortReason = undefined
    const flight = this.run(id, token).catch(() => {}).finally(() => this.flights.delete(flight))
    this.flights.add(flight)
  }

  private abortEntry(id: string, entry: RuntimeEntry | undefined, reason: string): void {
    if (!entry) return
    if (entry.retryTimer) this.clearDeferred(entry.retryTimer)
    if (entry.debounceTimer) this.clearDeferred(entry.debounceTimer)
    entry.retryTimer = undefined
    entry.debounceTimer = undefined
    entry.abortReason = reason
    entry.controller?.abort()
    entry.controller = undefined
    entry.queued = false
    entry.deferred = false
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    const deferredIndex = this.deferred.indexOf(id)
    if (deferredIndex >= 0) this.deferred.splice(deferredIndex, 1)
    if (this.active.delete(id)) {
      this.refillDeferred()
      this.dequeue()
    }
  }

  private classify(error: unknown): { code: string; transient: boolean } {
    const code = typeof (error as any)?.code === 'string' ? (error as any).code
      : typeof (error as any)?.name === 'string' ? (error as any).name
      : 'unknown'
    return { code, transient: TRANSIENT_CODES.has(code) }
  }

  private async run(id: string, token: symbol): Promise<void> {
    const entry = this.entries.get(id)
    let controller: AbortController | undefined
    let generationId: string | undefined
    try {
      if (this.closed) return
      const session = this.deps.session(id)
      if (!session || !entry?.accepted || !entry.responseReady || entry.runToken !== token) return
      if (entry.seedWrite) {
        try {
          await entry.seedWrite
        } catch {
          return
        }
      }
      if (entry.runToken !== token) return
      if (entry.abortReason && entry.abortReason !== 'timeout') return
      const liveSession = this.deps.session(id)
      if (!liveSession || !entry.accepted || !entry.responseReady || entry.seedError || entry.runToken !== token) return
      const resolved = resolveTaskTitleConfig(this.deps.config(), this.deps.agents())
      if (!resolved.enabled || !resolved.agent || !resolved.config) {
        await this.store.update(liveSession, metadata => {
          if (metadata.generationState === 'ready') return false
          metadata.generationId = undefined
          metadata.generator = undefined
          metadata.generationState = 'deferred'
          metadata.lastErrorCode = resolved.reason
        }).catch(() => {})
        this.publish(liveSession)
        return
      }
      const metadata = this.current(liveSession)
      const seed = metadata?.seed
      if (!metadata || !seed?.assistantResponse) return
      generationId = randomUUID()
      const contextVersion = taskTitleContextVersion(seed, metadata.contextGeneration)
      const configVersion = metadata.configVersion
      controller = new AbortController()
      if (entry.runToken !== token) return
      entry.controller = controller
      entry.generationId = generationId
      const running = await this.store.update(liveSession, current => {
        if (current.generationState === 'ready') return false
        if (current.configVersion !== configVersion) return false
        if (current.contextVersion !== metadata.contextVersion) return false
        current.seed = seed
        current.contextVersion = contextVersion
        current.generationId = generationId
        current.generationState = 'running'
        current.generator = resolved.config
        current.lastErrorCode = undefined
        current.nextEligibleAt = undefined
        current.attempts = entry.retryCount + 1
      })
      if (running.generationId !== generationId) {
        entry.rescheduleAfterRelease = true
        return
      }
      if (controller.signal.aborted || (entry.abortReason && entry.abortReason !== 'timeout')) return
      this.publish(liveSession)
      const timeout = this.defer(() => {
        if (controller?.signal.aborted) return
        if (entry.runToken === token) entry.abortReason = 'timeout'
        controller?.abort()
      }, this.timeoutMs)
      let raw = ''
      try {
        const context = await this.store.contexts.current(id)
        const replay = await taskTitleReplay(context, prompt => this.deps.generate(resolved.agent!, resolved.config!, prompt, controller!.signal,
          undefined, undefined, { summary: true }, id))
        if (controller.signal.aborted) return
        const previous = context.turns.at(-2)
        raw = await this.deps.generate(resolved.agent, resolved.config, buildTaskTitlePrompt({ ...seed,
          previousAssistantResponse: seed.previousAssistantResponse || previous?.finalResponse || previous?.initialResponse,
          taskHistory: replay.history }), controller.signal,
          taskTitleSupportsImages(resolved.agent, resolved.modelDef!) ? seed.images : undefined, context.id, undefined, id)
        if (controller.signal.aborted) return
        const result = parseTaskTitleResult(raw)
        if (result.description) await (this.deps.validateDescription || validateTaskDescription)(result.description)
        if (controller.signal.aborted) return
        await this.store.contexts.update(id, current => {
          const turn = current.turns.find(turn => turn.inputId === seed.inputId)
          if (turn) turn.result = result
          if (replay.checkpoint) current.checkpoint = replay.checkpoint
        })
      } finally {
        this.clearDeferred(timeout)
      }
      if (entry.runToken !== token || (controller.signal.aborted && entry.abortReason !== 'timeout')) return
      const parsed = parseTaskTitleResult(raw)
      const latestSession = this.deps.session(id)
      if (!latestSession) return
      await this.store.update(latestSession, current => {
        if (entry.runToken !== token || (controller?.signal.aborted && entry.abortReason !== 'timeout')) return false
        if (current.generationId !== generationId || current.contextVersion !== contextVersion || current.configVersion !== configVersion) return false
        if (latestSession.archived || latestSession.readOnly) return false
        current.attempts = Math.max(current.attempts, entry.retryCount + 1)
        current.lastErrorCode = undefined
        current.generatedAt = this.now()
        current.nextEligibleAt = undefined
        current.generationId = undefined
        if (parsed.title) {
          if (current.source !== 'manual' && current.source !== 'legacy-preserved') {
            current.title = parsed.title
            current.source = 'generated'
          }
          current.description = parsed.description!
          current.generatedInputId = seed.inputId
          current.generationState = 'ready'
        } else if (current.clarificationCount >= 1) {
          current.generationState = 'failed'
          current.lastErrorCode = 'needs-context-limit'
        } else {
          current.generationState = 'needs-context'
        }
      })
      this.publish(latestSession)
    } catch (error) {
      if (!entry || entry.runToken !== token) return
      const latestSession = this.deps.session(id)
      if (!latestSession) return
      if (controller?.signal.aborted && entry.abortReason && entry.abortReason !== 'timeout') return
      const failure = entry.abortReason === 'timeout'
        ? { code: 'timeout', transient: true }
        : this.classify(error)
      const willRetry = failure.transient && entry.retryCount + 1 < this.maxAttempts
      const retryAt = this.now() + this.retryBackoffMs
      await this.store.update(latestSession, current => {
        if (current.generationId !== generationId) return false
        current.generationId = undefined
        current.lastErrorCode = failure.code
        current.attempts = Math.max(current.attempts, entry.retryCount + 1)
        if (willRetry) {
          current.generationState = 'deferred'
          current.nextEligibleAt = retryAt
        } else {
          current.generationState = 'failed'
          current.nextEligibleAt = undefined
        }
      }).catch(() => {})
      this.publish(latestSession)
      if (willRetry) {
        entry.retryCount += 1
        this.scheduleRetry(id, retryAt)
      }
    } finally {
      if (entry?.runToken === token && entry.controller === controller) entry.controller = undefined
      if (entry?.runToken === token) {
        entry.abortReason = undefined
        entry.generationId = undefined
        entry.runToken = undefined
      }
      if (this.active.get(id) === token) this.active.delete(id)
      this.refillDeferred()
      this.dequeue()
      if (entry?.rescheduleAfterRelease && entry.runToken === undefined) {
        entry.rescheduleAfterRelease = false
        this.refillDeferred()
        this.schedule(id)
      }
    }
  }
}
