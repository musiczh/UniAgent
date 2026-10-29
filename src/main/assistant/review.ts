import type { AgentDef, Session, SessionConfig } from '../../shared/types'
import type { ReviewJob } from '../../shared/assistant'
import type { AssistantStore } from './store'
import { bindAssistantScope, revokeAssistantScope, type AssistantScope } from './mcp'
import { MEMORY_REVIEW_PROMPT } from './prompts'
import { reviewCapability, runReviewRuntime } from './reviewRuntime'

export class AssistantReview {
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private closed = false
  private running?: Promise<void>
  constructor(private store: AssistantStore, private getSession: (id: string) => Session | undefined,
    private getAgent: (id: string) => AgentDef | undefined, private busy: () => boolean,
    private call: (scope: AssistantScope, tool: string, args: any) => Promise<unknown>, private changed: () => void) {}
  async recover(): Promise<void> { if ((await this.store.jobs()).some(job => job.state === 'queued')) this.schedule() }
  abort(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.controller?.abort() }
  async enqueue(session: Session, turnKey: string, throughSeq: number): Promise<void> {
    const { assistant } = await this.store.detail()
    if (!assistant.enabled || !assistant.autoReviewEnabled || this.closed) return
    const runtime = assistant.reviewRuntime
    const agentId = runtime?.agentId || session.config.agentId
    const job = await this.store.enqueue({ sessionId: session.id, turnKey, throughSeq, agentId, model: runtime ? runtime.model || this.getAgent(agentId)?.defaultModel : session.config.model || this.getAgent(agentId)?.defaultModel })
    const capability = reviewCapability(this.getAgent(job.agentId))
    if (!capability.supported) await this.store.setReviewState(job.id, 'unsupported', 0, capability.reason)
    else this.schedule()
    this.changed()
  }
  private schedule(delay = 15000): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.busy() || this.running) { this.schedule(); return }
      this.running = this.run().catch(() => {}).finally(async () => {
        this.running = undefined
        if (!this.closed && !this.timer && (await this.store.jobs()).some(job => job.state === 'queued')) this.schedule()
      }).catch(() => {})
    }, delay)
    this.timer.unref()
  }
  private async run(): Promise<void> {
    const jobs = (await this.store.jobs()).filter(job => job.state === 'queued')
    const job = jobs.at(-1)
    if (!job || this.closed) return
    for (const old of jobs.slice(0,-1).filter(old => old.sessionId === job.sessionId)) await this.store.setReviewState(old.id, 'stale', old.attempt, '已合并到最新回合')
    const source = this.getSession(job.sessionId), agent = this.getAgent(job.agentId)
    if (!source?.config.assistantSnapshot || !agent) { await this.store.setReviewState(job.id, 'unsupported', job.attempt, '复盘来源或执行方已不可用'); this.changed(); return }
    const capability = reviewCapability(agent)
    if (!capability.supported) { await this.store.setReviewState(job.id, 'unsupported', job.attempt, capability.reason); this.changed(); return }
    let config: SessionConfig
    try { config = resolveReviewConfig(source, agent, job) } catch (error) { await this.store.setReviewState(job.id, 'unsupported', job.attempt, String(error)); this.changed(); return }
    if ((await this.store.job(job.id))?.state !== 'queued' || this.closed || this.busy()) return
    const controller = new AbortController()
    this.controller = controller
    const scope = bindAssistantScope(`assistant-review-${job.id}`, job.id)
    controller.signal.addEventListener('abort', () => { scope.active = false; revokeAssistantScope(scope.sessionId) }, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 120000)
    try {
      await this.store.setReviewState(job.id, 'running', job.attempt + 1)
      this.changed()
      const transcript = await this.store.reviewTranscript(job.id)
      const memory = await this.store.memory({ action: 'read' }, { writer: 'auto_review', jobId: job.id })
      await runReviewRuntime(agent, config, [MEMORY_REVIEW_PROMPT, JSON.stringify({ memory: memory.documents, transcript })].join('\n\n'), scope, controller.signal,
        (tool,args) => this.call(scope, tool, args))
      if (!controller.signal.aborted) await this.store.commitReview(job.id)
    } catch (error) {
      const current = await this.store.job(job.id)
      if (current && current.state !== 'stale') {
        const reason = error instanceof Error ? error.message : String(error)
        const unsupported = /unexpected_tool|runtime_unsupported/.test(reason)
        const retry = (!controller.signal.aborted || timedOut) && !unsupported && current.attempt < 3
        const cancelled = controller.signal.aborted && !timedOut
        await this.store.setReviewState(job.id, cancelled ? 'stale' : unsupported ? 'unsupported' : retry ? 'queued' : 'failed', current.attempt, timedOut ? '复盘超时' : reason)
        if (retry) this.schedule(current.attempt === 1 ? 30000 : 120000)
      }
    } finally {
      clearTimeout(timeout); revokeAssistantScope(scope.sessionId)
      if (this.controller === controller) this.controller = undefined
      this.changed()
    }
  }
  async close(): Promise<void> { this.closed = true; this.abort(); await this.running }
}
export function resolveReviewConfig(source: Session, agent: AgentDef, job: ReviewJob): SessionConfig {
  const same = source.config.agentId === job.agentId && source.config.model === job.model
  const model = job.model || agent.defaultModel
  const modelDef = agent.models.find(entry => entry.id === model)
  if (job.model && agent.capabilities.modelSelect && !modelDef) throw new Error('所选复盘模型已不可用，请重新配置')
  return { agentId: job.agentId, workdir: '', model, modelSource: modelDef?.modelSource || (same ? source.config.modelSource : undefined),
    permissionMode: 'read-only' }
}
