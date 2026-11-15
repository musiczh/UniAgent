type Response = { handled: boolean; hasPendingRequests: boolean } | void
import type { TaskDecision, TaskDecisionAnswer } from '../shared/taskDecisions'

export class TaskDecisionResolver {
  private actions = new Map<string, { fingerprint: string; result: Promise<void> }>()
  resolve(taskId: string, input: TaskDecisionAnswer, current: () => TaskDecision[], respond: (id: string, answer: unknown) => Promise<void>): Promise<void> {
    if (!input || typeof input.id !== 'string' || typeof input.version !== 'string' || typeof input.actionId !== 'string' || !input.actionId || input.actionId.length > 128) return Promise.reject(new Error('无效的决策操作'))
    const key = JSON.stringify([taskId, input.actionId]), fingerprint = JSON.stringify(input)
    const existing = this.actions.get(key)
    if (existing) return existing.fingerprint === fingerprint ? existing.result : Promise.reject(new Error('操作身份冲突'))
    const decision = current().find(d => d.id === input.id)
    if (!decision?.requestId) return Promise.reject(new Error('该事项已处理或已失效'))
    if (decision.version !== input.version) return Promise.reject(new Error('决策材料或状态已更新，请刷新后处理'))
    if (decision.status !== 'open') return Promise.reject(new Error('该响应正在提交或结果待确认，请先刷新状态'))
    const result = Promise.resolve().then(() => respond(decision.requestId!, input.answer))
    this.actions.set(key, { fingerprint, result })
    if (this.actions.size > 500) this.actions.delete(this.actions.keys().next().value!)
    return result
  }
}

/** All entry points share the same in-flight request, including late native acknowledgements. */
export class RequestResponseGate {
  private pending = new Map<string, 'submitting' | 'unknown'>()
  constructor(private readonly timeoutMs = 30_000) {}
  hasPending(key: string): boolean { return this.pending.has(key) }

  run(key: string, dispatch: () => Response | Promise<Response>, update: (state?: 'submitting' | 'unknown') => void): Response | Promise<Response> {
    const current = this.pending.get(key)
    if (current) return Promise.reject(new Error(current === 'unknown' ? '处理结果待确认，请先刷新原请求状态；系统不会重复提交' : '回答正在提交，请稍候'))
    this.pending.set(key, 'submitting')
    let value: Response | Promise<Response>
    try { value = dispatch() } catch (error) { this.pending.delete(key); throw error }
    if (!value || typeof (value as Promise<Response>).then !== 'function') { this.pending.delete(key); return value }
    update('submitting')
    let timer: ReturnType<typeof setTimeout> | undefined
    const unknown = (): void => { this.pending.set(key, 'unknown'); update('unknown') }
    const response = Promise.resolve(value).then(result => {
      if (timer) clearTimeout(timer)
      this.pending.delete(key); update(); return result
    }, error => {
      if (timer) clearTimeout(timer)
      if (/timeout|timed out|unknown|socket|network|超时|断开|结果.*(未知|确认)/i.test(String(error))) unknown()
      else { this.pending.delete(key); update() }
      throw error
    })
    return Promise.race([response, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { unknown(); reject(new Error('响应超时，处理结果待确认；系统不会重复提交')) }, this.timeoutMs)
      timer.unref?.()
    })])
  }
}
