import type { GoalState, NativeGoalUpdate } from '../shared/nativeCapabilities.ts'
import { buildGrokGoalCommand, projectGrokGoal, type GrokGoalCommand } from './grokGoalProjection.ts'

interface NativeConnection { request(method: string, params?: any, timeoutMs?: number): Promise<any> }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)

/** One native session owns Goal notifications and commands; state replies can lag accepted epochs. */
export class GrokNativeControls {
  private state?: GoalState
  private notificationEpoch = 0
  private readonly acknowledgements = new Set<() => void>()
  private readonly clearedGoalIds = new Set<string>()
  private liveGoalId?: string
  private pendingCommands = 0

  constructor(private readonly connection: NativeConnection, private readonly sessionId: string, private readonly cwd: string,
    private readonly changed: (goal: GoalState | undefined) => void,
    private readonly failed: (error: Error) => void = () => {}) {}

  get goal(): GoalState | undefined { return this.state }
  get hasPendingCommand(): boolean { return this.pendingCommands > 0 }

  acceptNotification(value: unknown): boolean {
    if (!record(value)) return false
    const params = record(value.params) ? value.params : value
    if (params.sessionId !== this.sessionId || !record(params.update) || params.update.sessionUpdate !== 'goal_updated') return false
    if (this.clearedGoalIds.has(params.update.goal_id)) return false
    if (params.update.status === 'cleared') {
      if (this.liveGoalId) this.clearedGoalIds.add(this.liveGoalId)
      this.liveGoalId = undefined
    } else if (typeof params.update.goal_id === 'string') this.liveGoalId = params.update.goal_id
    ++this.notificationEpoch
    this.accept(params)
    for (const acknowledge of this.acknowledgements) acknowledge()
    return true
  }

  private accept(value: unknown): void {
    this.state = projectGrokGoal(value, { previous: this.state })
    const envelope = record(value) && record(value.result) ? value.result : value
    if (record(envelope) && record(envelope.goal) && typeof envelope.goal.goal_id === 'string') this.liveGoalId = envelope.goal.goal_id
    this.changed(this.state)
  }

  async getGoal(timeoutMs?: number): Promise<GoalState | undefined> {
    const epoch = this.notificationEpoch
    const value = await this.connection.request('_x.ai/session/state', { sessionId: this.sessionId, cwd: this.cwd }, timeoutMs)
    const envelope = record(value?.result) ? value.result : value
    if (!record(envelope) || !Object.hasOwn(envelope,'goal') && !record(envelope.summary)) throw new Error('Grok 返回了无效会话状态')
    if (epoch === this.notificationEpoch && !this.clearedGoalIds.has(envelope?.goal?.goal_id) &&
        !(this.state && this.notificationEpoch > 0 && !record(envelope?.goal))) this.accept(value)
    return this.state
  }

  async setGoal(request: { objective: string; tokenBudget?: number; maxRounds?: number }): Promise<GoalState> {
    await this.command(request)
    if (!this.state) throw new Error('Grok 未确认创建目标')
    return this.state
  }

  async updateGoal(request: NativeGoalUpdate): Promise<GoalState | undefined> {
    if (!['pause', 'resume', 'clear'].includes(request.action) || Object.keys(request).some(key => key !== 'action')) {
      throw new Error('Grok 不支持此目标操作')
    }
    await this.command(request.action as 'pause' | 'resume' | 'clear')
    if (request.action === 'clear' ? !!this.state : request.action === 'pause' ? this.state?.status !== 'paused' : this.state?.status !== 'active') {
      throw new Error('Grok 未确认此目标操作')
    }
    return this.state
  }

  private async command(request: GrokGoalCommand): Promise<void> {
    const command = buildGrokGoalCommand(request)
    const epoch = this.notificationEpoch
    const previousGoalId = this.liveGoalId
    let acknowledge!: () => void
    const acknowledged = new Promise<void>(resolve => {
      acknowledge = () => {
        if (typeof request === 'object' ? this.state?.objective === request.objective.trim() && this.liveGoalId !== previousGoalId
          : request === 'clear' ? !this.state : request === 'pause' ? this.state?.status === 'paused'
            : request === 'resume' ? this.state?.status === 'active' : true) resolve()
      }
    })
    this.acknowledgements.add(acknowledge)
    ++this.pendingCommands
    const execution = (async () => {
      const response = await this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: command }] }, 0)
      if (!record(response) || !['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(response.stopReason)) {
        throw new Error('Grok 返回了无效目标命令结果')
      }
      if (epoch === this.notificationEpoch) await this.getGoal()
    })().finally(() => { --this.pendingCommands })
    // Goal slash RPC lasts through the native workflow; its notification releases host controls.
    try {
      const winner = await Promise.race([acknowledged.then(() => 'acknowledgement'), execution.then(() => 'execution')])
      if (winner === 'acknowledgement') void execution.catch(error => this.failed(error instanceof Error ? error : new Error(String(error))))
    }
    finally { this.acknowledgements.delete(acknowledge) }
  }

  async steer(text: string, running: boolean): Promise<void> {
    if (!running || typeof text !== 'string' || !text.trim()) throw new Error('当前 Grok 会话没有可引导的运行回合')
    const result = await this.connection.request('_x.ai/interject', { sessionId: this.sessionId, text })
    if (result?.result?.status !== 'queued') throw new Error('Grok 未接收引导消息')
  }
}
