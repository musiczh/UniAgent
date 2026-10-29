import { EventEmitter } from 'node:events'
import { TurnRunner } from './adapter'
import { claudeSdkSessionOperation, claudeReviewPrompt, claudeGoal, claudeTurnPrompt } from './claudeSdk'
import { nativeCredentialEnv } from './agentSetupCredentials'
import type { AgentDef, Attachment, SessionConfig, UAEvent } from '../shared/types'
import type { ResolvedNativeTurnContext, NativeReviewDraft } from '../shared/nativeCapabilities'

/** Owns an SDK-created native fork. The parent is never prompted, resumed or deleted. */
export class ClaudeSdkSideRunner extends EventEmitter {
  private runner: TurnRunner
  private nativeId?: string
  private preparation?: Promise<string>
  private running = false
  private disposed = false
  private keepCache = false
  private disposal?: Promise<void>
  private goalPrompt?: string

  constructor(private sessionId: string, private seqRef: { n: number }, private agent: AgentDef,
    private config: SessionConfig, private sourceNativeId: string, resumeNativeId?: string) {
    super()
    if (resumeNativeId === sourceNativeId) throw new Error('侧边对话不能使用源会话 ID')
    this.nativeId = resumeNativeId
    this.runner = new TurnRunner(sessionId, seqRef)
    this.runner.on('event', event => this.emit('event', event))
    this.runner.on('done', result => { this.running = false; this.emit('done', result) })
  }

  private operation(method: 'forkSession' | 'deleteSession', args: unknown): Promise<any> {
    return claudeSdkSessionOperation(this.agent.bin, this.config.workdir, method, args, { ...process.env, ...nativeCredentialEnv('claude') })
  }

  private ensureFork(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Claude 分支已关闭'))
    if (this.nativeId) return Promise.resolve(this.nativeId)
    return this.preparation ??= this.operation('forkSession', { sessionId: this.sourceNativeId }).then(async result => {
      if (!result.sessionId || result.sessionId === this.sourceNativeId) throw new Error('Claude SDK 未创建独立分支')
      if (this.disposed) {
        if (!this.keepCache) await this.deleteThread(result.sessionId)
        throw new Error('Claude 分支已关闭')
      }
      this.nativeId = result.sessionId
      this.emit('nativeThreadReady', this.nativeId)
      return this.nativeId!
    }).finally(() => { this.preparation = undefined })
  }

  async startTurn(prompt: string, attachments?: Attachment[], nativeContext?: ResolvedNativeTurnContext): Promise<void> {
    if (this.disposed || this.running) throw new Error('Claude 分支当前无法发送消息')
    this.running = true
    try {
      const nativeId = await this.ensureFork()
      if (this.disposed || !this.running) return
      const content = this.goalPrompt || claudeTurnPrompt(prompt, nativeContext)
      this.goalPrompt = undefined
      this.runner.start(this.agent, this.config, content, nativeId, attachments)
    } catch (error) {
      if (this.disposed) return
      this.running = false
      this.emit('event', { sessionId: this.sessionId, seq: this.seqRef.n++, ts: Date.now(), type: 'error', state: 'failed', payload: { message: String(error) } } satisfies UAEvent)
      this.emit('done', { failed: true })
    }
  }

  nativeThreadId(): string | undefined { return this.nativeId }
  processId(): number | undefined { return this.runner.processId() }
  isRunning(): boolean { return this.running }
  supportsSteer(): boolean { return true }
  updateConfig(config: SessionConfig): void { this.config = structuredClone(config) }
  async setCollaborationMode(mode: 'default' | 'plan'): Promise<void> {
    if (this.running && mode !== 'default') throw new Error('Claude 分支运行中，无法切换模式')
    await this.runner.setClaudePermissionMode(mode === 'plan' ? 'plan' : 'default')
    this.config = { ...this.config, collaborationMode: mode, permissionMode: mode === 'plan' ? 'plan' : 'ask' }
    this.emit('collaborationModeChanged', mode)
  }
  respond(requestId: string, answer: any): { handled: boolean; hasPendingRequests: boolean } { return this.runner.respond(requestId, answer) }
  hasPendingRequests(): boolean { return this.runner.hasPendingRequests() }
  pendingPlanModeExitRequestId(): string | undefined { return this.runner.pendingPlanModeExitRequestId() }
  steer(prompt: string, attachments?: Attachment[], nativeContext?: ResolvedNativeTurnContext): Promise<void> {
    if (nativeContext) return Promise.reject(new Error('原生上下文选择需要在下一轮应用'))
    return this.runner.steer(prompt, attachments)
  }
  async compact(): Promise<void> { await this.startTurn('/compact') }
  async startReview(draft: NativeReviewDraft): Promise<void> {
    await this.startTurn(claudeReviewPrompt(draft, this.config))
  }
  async setGoal(input: { objective: string; tokenBudget?: number }): Promise<void> {
    const goal = claudeGoal(input.objective, input.tokenBudget)
    this.runner.configureClaudeGoal(goal)
    this.goalPrompt = `/goal ${goal.objective}`
  }
  async clearGoal(): Promise<void> {
    if (this.runner.hasClaudeSdkConnection()) await this.runner.clearClaudeGoal()
    else await this.startTurn('/goal clear')
  }
  interrupt(): void {
    if (!this.running) return
    this.runner.interrupt()
    if (this.preparation) { this.running = false; this.emit('done', { interrupted: true }) }
  }
  async forkPersistent(_events: Pick<UAEvent, 'type' | 'payload'>[], _targetSessionId?: string): Promise<string> {
    if (this.running) throw new Error('Claude 分支运行中，无法转换为会话')
    const result = await this.operation('forkSession', { sessionId: await this.ensureFork() })
    if (!result.sessionId || [this.sourceNativeId, this.nativeId].includes(result.sessionId)) throw new Error('Claude SDK 未创建独立持久会话')
    return result.sessionId
  }
  async deleteThread(nativeId: string): Promise<void> {
    if (nativeId === this.sourceNativeId) throw new Error('禁止删除 Claude 源会话')
    await this.operation('deleteSession', nativeId)
  }
  disposeFork(keepCache = false): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true; this.keepCache = keepCache
    this.runner.removeAllListeners(); this.runner.interrupt()
    this.disposal = this.runner.disposeClaudeSdk().then(async () => {
      await this.preparation?.catch(() => {})
      if (!keepCache && this.nativeId) await this.deleteThread(this.nativeId)
    })
    void this.disposal.catch(() => {})
    return this.disposal
  }
}
