import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Attachment, Session, SessionConfig, UAEvent } from '../../shared/types'
import type { ResolvedNativeTurnContext } from '../../shared/nativeCapabilities'
import { resolveUserDataHome } from '../userData'
import { handoffMcpServers } from '../handoff'
import { ZCodeRunner } from './runner'
import type { ZCodeRuntimePool } from './runtimePool'
import { sanitizeZCodeSelection, sanitizeZCodeState, writeZCodeJson } from './store'
import { zcodeAttachmentRefs } from './attachments'
import { zcodeContextPrompt } from './capabilities'
import { zcodeModelKey, ZCODE_PERMISSION_VALUES } from './catalog'

/** The existing side UI consumes this runner; its durable receipts remain separate from the main conversation. */
export class ZCodeSideRunner extends EventEmitter {
  private runner?: ZCodeRunner
  private session?: Session
  private preparation?: Promise<ZCodeRunner>
  private config: SessionConfig
  private nativeId?: string
  private pendingConfig = Promise.resolve()
  private running = false
  private disposed = false
  private generation = 0
  private disposal?: Promise<void>
  private readonly ledgerPath: string
  constructor(private sessionId: string, private seqRef: { n: number }, config: SessionConfig,
    private sourceNativeId: string, private parent: () => Promise<ZCodeRunner>, private pool: ZCodeRuntimePool,
    resumeNativeId?: string, private previousDisposal?: Promise<void>) {
    super(); this.config = structuredClone(config); this.nativeId = resumeNativeId
    this.ledgerPath = join(resolveUserDataHome(), 'zcode', 'side-ledger', encodeURIComponent(sessionId) + '.json')
    if (resumeNativeId === sourceNativeId) throw new Error('ZCode 侧边对话不能使用主会话 ID')
  }
  processId(): undefined { return undefined }
  isRunning(): boolean { return this.running || this.runner?.isRunning() === true }
  supportsSteer(): boolean { return false }
  pendingPlanModeExitRequestId(): undefined { return undefined }
  setForkTranscript(_events: Pick<UAEvent, 'type' | 'payload'>[]): void {}
  private persist = (): void => {
    if (!this.session) throw new Error('ZCode 侧边会话尚未准备')
    writeZCodeJson(this.ledgerPath, { schemaVersion: 1, nativeSessionId: this.session.nativeSessionId,
      state: this.session.zcodeState, selection: this.session.config.zcodeModelSelection, permissionMode: this.session.config.permissionMode })
  }
  private ensureRunner(): Promise<ZCodeRunner> {
    if (this.disposed) return Promise.reject(new Error('ZCode 侧边对话已关闭'))
    if (this.runner) return this.runner.ensureSession().then(() => this.runner!)
    if (this.preparation) return this.preparation
    const operation = (async () => {
      await this.previousDisposal
      const parent = await this.parent()
      let saved: any
      try { saved = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) }
      catch (error: any) { if (error.code !== 'ENOENT') throw new Error('ZCode 侧边输入账本无法读取，禁止重新创建或重发') }
      const state = saved && !saved.closed ? sanitizeZCodeState(saved.state) : undefined
      if (saved && !saved.closed && (!state || saved.schemaVersion !== 1 || typeof saved.nativeSessionId !== 'string')) throw new Error('ZCode 侧边输入账本损坏，禁止重新创建或重发')
      if (!saved && this.nativeId) throw new Error('ZCode 侧边会话缺少输入账本，禁止重新创建')
      const nativeId = saved && !saved.closed ? saved.nativeSessionId : await parent.forkSideNative()
      if (nativeId === this.sourceNativeId || this.nativeId && this.nativeId !== nativeId && !saved?.closed) throw new Error('ZCode 侧边会话身份不一致')
      if (this.disposed) throw new Error('ZCode 侧边对话已关闭')
      this.nativeId = nativeId
      const selection = sanitizeZCodeSelection(saved?.selection)
      if (selection) this.config = { ...this.config, model: zcodeModelKey(selection), zcodeModelSelection: selection, effort: undefined,
        ...(Object.hasOwn(ZCODE_PERMISSION_VALUES, saved.permissionMode) ? { permissionMode: saved.permissionMode } : {}) }
      this.session = { id: this.sessionId, title: 'Side', config: this.config, nativeSessionId: nativeId, createdAt: Date.now(), status: 'idle',
        zcodeState: state ?? { schemaVersion: 1, dataRootId: parent.scope!.dataRootId, workspaceKey: parent.scope!.workspaceKey,
          runtimeFingerprint: parent.scope!.runtimeFingerprint, deliveries: [] } }
      this.session.pendingQueue = this.session.zcodeState!.deliveries.filter(record => ['prepared', 'sent', 'acknowledged', 'uncertain'].includes(record.phase))
        .map(record => ({ id: record.queueItemId, prompt: record.submission.text, acceptedAt: record.issuedAt, state: 'pending', attempts: 1 }))
      this.persist()
      const runner = new ZCodeRunner({ session: this.session, runtime: parent.runtime, pool: this.pool, clientId: `uniagent:side:${this.sessionId}`,
        nextSeq: () => this.seqRef.n++, persist: this.persist, mcpServers: () => handoffMcpServers(this.sessionId) })
      this.runner = runner
      const relay = (event: UAEvent) => {
        if (this.disposed || event.type === 'user_message' || event.type === 'goal_message') return
        const commands = new Set(this.session!.zcodeState!.deliveries.map(record => record.commandId))
        const turns = new Set([...this.session!.zcodeState!.deliveries.map(record => record.turnId), ...(runner.snapshot?.rows.window.filter(row => commands.has(row.sourceCommandId)).map(row => row.turnId) ?? [])])
        if (event.payload.turnId && !turns.has(event.payload.turnId)) return
        this.emit('event', event)
      }
      runner.on('event', relay); runner.on('eventsReset', (events: UAEvent[]) => events.forEach(relay))
      runner.on('contract', contract => {
        this.session!.agentContract = contract
        const model = contract.models.find((model: any) => model.id === contract.currentModelId)
        this.config = { ...this.config, model: contract.currentModelId, zcodeModelSelection: model?.zcodeSelection, effort: undefined }
        this.session!.config = this.config; this.persist(); this.emit('configCorrection', this.config)
      })
      runner.on('done', result => {
        this.running = false
        if (result.delivery === 'observed') this.session!.pendingQueue = this.session!.pendingQueue?.filter(item => item.id !== this.session!.zcodeState!.deliveries.find(record => record.commandId === result.commandId)?.queueItemId)
        this.persist()
        if (!result.recovered) this.emit('done', result)
      })
      await runner.ensureSession()
      this.emit('nativeThreadReady', nativeId)
      return runner
    })().finally(() => { if (this.preparation === operation) this.preparation = undefined })
    this.preparation = operation
    return operation
  }
  async startTurn(prompt: string, attachments?: Attachment[], context?: ResolvedNativeTurnContext): Promise<void> {
    if (this.disposed || this.running) return
    this.running = true
    const generation = ++this.generation
    try {
      await this.pendingConfig
      const runner = await this.ensureRunner()
      if (this.disposed || generation !== this.generation) return
      if (prompt.startsWith('/goal ')) throw new Error('ZCode 侧边对话不支持原生 Goal，请在主会话设置')
      const text = context ? zcodeContextPrompt(prompt, context, await runner.discoverCapabilities()) : prompt
      this.running = true
      const id = 'side-' + randomUUID()
      this.session!.pendingQueue = [...(this.session!.pendingQueue ?? []), { id, prompt: text, acceptedAt: Date.now(), state: 'pending', attempts: 1 }]
      const refs = await zcodeAttachmentRefs(attachments, this.session!.agentContract?.imageAttachments ?? runner.runtime.models.find(model => model.id === this.config.model)?.imageInput)
      await runner.submit(runner.prepare(id, text, refs))
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.running = false
      this.emit('event', { sessionId: this.sessionId, seq: this.seqRef.n++, ts: Date.now(), type: 'error', state: 'failed', payload: { message: error instanceof Error ? error.message : 'ZCode 侧边任务失败' } } as UAEvent)
      this.emit('done', { failed: true })
    }
  }
  updateConfig(config: SessionConfig): void {
    const requested = structuredClone(config), previous = this.config
    this.pendingConfig = this.pendingConfig.then(async () => {
      if (this.runner) await this.runner.updateConfig(requested)
      this.config = requested
      if (this.session) { this.session.config = requested; this.persist() }
    }).catch(error => { this.emit('configCorrection', previous); this.emit('event', { sessionId: this.sessionId, seq: this.seqRef.n++, ts: Date.now(), type: 'error', state: 'failed', payload: { message: String(error) } } as UAEvent) })
  }
  async setCollaborationMode(mode: 'default' | 'plan'): Promise<void> {
    if (this.isRunning()) throw new Error('ZCode 侧边对话仍在运行')
    await this.pendingConfig
    const runner = await this.ensureRunner()
    await runner.updateConfig({ ...this.config, collaborationMode: mode })
    this.config = { ...this.config, collaborationMode: mode }; this.session!.config = this.config; this.persist()
    this.emit('collaborationModeChanged', mode)
  }
  respond(requestId: string, answer: any) { return this.runner?.respondResult(requestId, answer) ?? { handled: false, hasPendingRequests: false } }
  async steer(_prompt: string, _attachments?: Attachment[], _context?: ResolvedNativeTurnContext): Promise<never> { throw new Error('ZCode 侧边对话不支持运行中强制追加') }
  interrupt(): void {
    ++this.generation; this.running = false
    if (!this.runner?.isRunning()) { this.emit('done', { interrupted: true }); return }
    void this.runner.interrupt().catch(error => this.emit('done', { failed: true, message: String(error) }))
  }
  async compact(): Promise<void> { await this.startTurn('/compact') }
  async clearGoal(): Promise<never> { throw new Error('ZCode 侧边对话不支持原生 Goal') }
  async setGoal(_goal: unknown): Promise<never> { throw new Error('ZCode 侧边对话不支持原生 Goal') }
  async startReview(_draft: unknown): Promise<never> { throw new Error('ZCode 没有对应的原生 Review 接口') }
  async forkPersistent(_events: Pick<UAEvent, 'type' | 'payload'>[], _targetSessionId?: string): Promise<string> {
    if (this.isRunning()) throw new Error('ZCode 侧边对话仍在运行')
    return (await this.ensureRunner()).forkNative()
  }
  async deleteThread(nativeId: string): Promise<void> {
    if (nativeId === this.sourceNativeId) throw new Error('禁止关闭侧边对话的源会话')
    await this.runner?.closeNative(nativeId)
  }
  disposeFork(keepCache = false): void { void this.disposeForkAndWait(keepCache).catch(() => undefined) }
  disposeForkAndWait(keepCache = false): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true; ++this.generation
    this.disposal = (async () => {
      await this.preparation?.catch(() => undefined); await this.pendingConfig
      await this.runner?.dispose()
      if (!keepCache) writeZCodeJson(this.ledgerPath, { schemaVersion: 1, closed: true })
    })()
    return this.disposal
  }
}
