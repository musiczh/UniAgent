import { EventEmitter } from 'node:events'
import { ACPRunner, assertACPProviderConfig, deleteKimiSession, forkDeepSeekSession } from './acp/acpRunner.ts'
import { forkBetaSession, deleteOwnedGrokFork, retainGrokFork, cacheGrokFork } from './betaSessionFork.ts'
import { handoffMcpServers } from './handoff.ts'
import { deepseekSessionRuntimeEnv } from './deepseekService.ts'
import { kimiSessionRuntimeEnv } from './kimiRoleConfig.ts'
import type { AgentDef, Attachment, SessionConfig, SessionAgentContract, UAEvent } from '../shared/types.ts'
import type { ResolvedNativeTurnContext } from '../shared/nativeCapabilities.ts'

/** ACP Side owns a native fork; it never resumes or prompts the source. */
export class BetaSideRunner extends EventEmitter {
  private runner?: ACPRunner
  private preparation?: Promise<ACPRunner>
  private nativeId?: string
  private config: SessionConfig
  private pendingConfig = Promise.resolve()
  private running = false
  private nativeTurnRunning = false
  private disposed = false
  private keepCache = false
  private generation = 0
  private disposal?: Promise<void>
  private contract?: SessionAgentContract

  constructor(
    private readonly sessionId: string,
    private readonly seqRef: { n: number },
    private readonly agent: AgentDef,
    config: SessionConfig,
    private readonly sourceNativeId: string,
    resumeSideNativeId?: string,
    private readonly extraEnv?: () => NodeJS.ProcessEnv
  ) {
    super()
    if (!['kimi', 'grok', 'deepseek'].includes(agent.adapter)) throw new Error('不支持当前 Agent 的侧边对话')
    if (resumeSideNativeId === sourceNativeId) throw new Error('侧边对话不能使用源会话 ID')
    this.config = { ...config }
    this.nativeId = resumeSideNativeId
    assertACPProviderConfig(this.provider, this.config)
  }

  private get provider(): 'kimi' | 'grok' | 'deepseek' {
    return this.agent.adapter as 'kimi' | 'grok' | 'deepseek'
  }

  private runtimeEnv = (): NodeJS.ProcessEnv => this.extraEnv?.() || (
    this.provider === 'deepseek' ? deepseekSessionRuntimeEnv(`side:${this.sessionId}`, this.config)
      : this.provider === 'kimi' ? kimiSessionRuntimeEnv(this.sessionId, this.config) : {}
  )

  processId(): number | undefined { return undefined }
  isRunning(): boolean { return this.running || this.runner?.isRunning() === true }
  supportsSteer(): boolean { return this.provider === 'deepseek' || ['kimi', 'grok'].includes(this.provider) && (this.contract?.steer ?? this.agent.capabilities.steer) === true }
  pendingPlanModeExitRequestId(): undefined { return undefined }
  setForkTranscript(_events: Pick<UAEvent, 'type' | 'payload'>[]): void {}

  private async fork(sourceId: string): Promise<string> {
    const result = this.provider === 'deepseek'
      ? await forkDeepSeekSession(sourceId, this.agent.bin, this.config.workdir, this.runtimeEnv(), undefined,
        { model: this.config.model, effort: this.config.effort, mcpServers: handoffMcpServers(this.sessionId) })
      : await forkBetaSession(this.provider, sourceId, this.agent.bin, this.config.workdir, this.runtimeEnv())
    if (result.nativeId === sourceId || result.nativeId === this.sourceNativeId) throw new Error('侧边对话必须创建独立原生会话')
    return result.nativeId
  }

  private ensureRunner(): Promise<ACPRunner> {
    if (this.disposed) return Promise.reject(new Error('侧边对话已关闭'))
    if (this.runner) return Promise.resolve(this.runner)
    if (this.preparation) return this.preparation
    const preparation = (async () => {
      const nativeId = this.nativeId || await this.fork(this.sourceNativeId)
      if (this.disposed) {
        if (!this.keepCache) await this.deleteThread(nativeId).catch(() => {})
        throw new Error('侧边对话已关闭')
      }
      this.nativeId = nativeId
      const runner = new ACPRunner(this.sessionId, this.seqRef, this.agent, this.config, nativeId, this.runtimeEnv)
      this.runner = runner
      runner.on('event', event => this.emit('event', event))
      runner.on('nativeSession', ({ nativeSessionId }: { nativeSessionId: string }) => {
        if (nativeSessionId !== this.nativeId || nativeSessionId === this.sourceNativeId) {
          runner.dispose()
          return
        }
        this.emit('nativeThreadReady', nativeSessionId)
      })
      runner.on('done', result => { this.running = false; this.nativeTurnRunning = false; this.emit('done', result) })
      runner.on('collaborationModeChanged', (mode: 'default' | 'plan') => {
        this.config = { ...this.config, collaborationMode: mode }
        this.emit('collaborationModeChanged', mode)
      })
      runner.on('contract', contract => { this.contract = contract; this.emit('contract',contract) })
      for (const event of ['mcpStatusChanged', 'skillsChanged']) runner.on(event, value => this.emit(event, value))
      this.emit('nativeThreadReady', nativeId)
      return runner
    })().finally(() => { if (this.preparation === preparation) this.preparation = undefined })
    this.preparation = preparation
    return preparation
  }

  async startTurn(prompt: string, attachments?: Attachment[], nativeContext?: ResolvedNativeTurnContext): Promise<void> {
    if (this.disposed || this.running) return
    this.running = true
    const generation = ++this.generation
    try {
      if (nativeContext) throw new Error('当前 ACP 侧边对话不支持原生上下文选择')
      await this.pendingConfig
      const runner = await this.ensureRunner()
      if (this.disposed || this.generation !== generation) return
      this.nativeTurnRunning = true
      await runner.startTurn(prompt, attachments)
    } catch (error: any) {
      if (this.disposed || this.generation !== generation) return
      this.running = false
      this.emit('event', { sessionId: this.sessionId, seq: this.seqRef.n++, ts: Date.now(), type: 'error', state: 'failed', payload: { message: error?.message || String(error) } } satisfies UAEvent)
      this.emit('done', { nativeSessionId: this.nativeId, failed: true })
    }
  }

  updateConfig(config: SessionConfig): void {
    assertACPProviderConfig(this.provider, config)
    const previous = this.config
    const requested = { ...config }
    this.config = requested
    this.pendingConfig = this.pendingConfig.then(async () => {
      if (this.runner) await this.runner.updateConfig(requested)
    }).catch((error: any) => {
      if (this.config === requested) this.config = previous
      this.emit('configCorrection', previous)
      this.emit('event', { sessionId:this.sessionId, seq:this.seqRef.n++, ts:Date.now(), type:'error', state:'failed', payload:{ message:error?.message || String(error) } } satisfies UAEvent)
    })
  }

  async setCollaborationMode(mode: 'default' | 'plan'): Promise<void> {
    if (this.running) throw new Error('侧边对话运行中，无法切换模式')
    await this.pendingConfig
    const runner = await this.ensureRunner()
    await runner.setCollaborationMode(mode)
    this.config = { ...this.config, collaborationMode: mode }
  }

  respond(requestId: string, answer: any): { handled: boolean; hasPendingRequests: boolean } | Promise<{ handled: boolean; hasPendingRequests: boolean }> {
    return this.runner?.respondResult(requestId, answer) || { handled: false, hasPendingRequests: false }
  }

  async steer(prompt: string, attachments?: Attachment[], nativeContext?: ResolvedNativeTurnContext): Promise<void | { appendedToTurn: boolean; nativePromptId?: string }> {
    if (!this.supportsSteer() || nativeContext || !this.runner) throw new Error('当前 Agent 不支持运行中原生引导 steer')
    return this.runner.steer(prompt, attachments)
  }

  interrupt(): void {
    if (!this.running) return
    if (this.runner && this.nativeTurnRunning) this.runner.interrupt()
    else {
      ++this.generation
      this.running = false
      this.emit('done', { nativeSessionId:this.nativeId, interrupted:true })
    }
  }

  async compact(): Promise<void> {
    const runner = await this.ensureRunner()
    if (!runner.supportsCommand('compact')) throw new Error('当前 Agent 未声明原生 compact 命令')
    await this.startTurn('/compact')
  }

  async forkPersistent(_events: Pick<UAEvent, 'type' | 'payload'>[], _targetSessionId?: string): Promise<string> {
    if (this.running) throw new Error('侧边对话运行中，无法转换为会话')
    await this.pendingConfig
    await this.ensureRunner()
    return this.fork(this.nativeId!)
  }

  async deleteThread(nativeId: string): Promise<void> {
    if (nativeId === this.sourceNativeId) throw new Error('禁止删除侧边对话的源会话')
    if (this.provider === 'kimi') await deleteKimiSession(nativeId, this.agent.bin, this.config.workdir, this.runtimeEnv())
    else if (this.provider === 'grok') await deleteOwnedGrokFork(nativeId, this.agent.bin, this.runtimeEnv())
    // shortcut: Harness exposes close but no durable deletion API; retain its native fork until one is available.
  }

  async retainThread(nativeId: string): Promise<void> {
    if (this.provider === 'grok') await retainGrokFork(nativeId,this.agent.bin,this.runtimeEnv())
  }

  disposeFork(keepCache = false): void {
    void this.disposeForkAndWait(keepCache).catch(() => {})
  }

  /** Finish owned transports and native deletion before removing runtime files. */
  disposeForkAndWait(keepCache = false): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.keepCache = keepCache
    ++this.generation
    this.runner?.removeAllListeners()
    this.disposal = (async () => {
      await this.preparation?.catch(() => {})
      await this.pendingConfig
      await this.runner?.disposeAndWait()
      if (!keepCache && this.nativeId) await this.deleteThread(this.nativeId)
      if (keepCache && this.nativeId && this.provider === 'grok') await cacheGrokFork(this.nativeId,this.agent.bin,this.runtimeEnv())
    })()
    return this.disposal
  }

  async clearGoal(): Promise<never> { throw new Error('当前 Agent 不支持原生 Goal') }
  async setGoal(_goal: unknown): Promise<never> { throw new Error('当前 Agent 不支持原生 Goal') }
  async startReview(_draft: unknown): Promise<never> { throw new Error('当前 Agent 不支持原生 Review') }
}
