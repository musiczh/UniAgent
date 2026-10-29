import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const RESTART_WAIT = '等待会话结束后重启（推荐）'
export const RESTART_NOW = '立即重启并续聊'
export const RESTART_CANCEL = '取消重启'
export const RESTART_ARG = '--uniagent-resume-restart='
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export interface RestartTarget { bundle: string; executable: string; sha256: string; version: string }
export interface RestartActivity { id: string; title: string; status: string; revision: string }
export interface RestartCaller {
  available: boolean
  busy: boolean
  lastSeq: number
  completed?: { seq: number; success: boolean }
}
export interface RestartJob {
  id: string
  sessionId: string
  prompt: string
  requestedBundle: string
  target: RestartTarget
  state: 'awaiting_confirmation' | 'waiting' | 'restarting' | 'resuming' | 'completed' | 'failed' | 'cancelled'
  mode?: 'wait' | 'now'
  afterSeq: number
  approved: RestartActivity[]
  createdAt: number
  updatedAt: number
  error?: string
}
export interface AppRestartDeps {
  inspectTarget(bundle: string): Promise<RestartTarget>
  caller(sessionId: string): RestartCaller
  activities(excludeSessionId: string): RestartActivity[]
  ask(sessionId: string, requestId: string, summary: string, options: string[], answer: (choice?: string) => Promise<void>): void
  dismiss(sessionId: string, requestId: string): void
  replyDelivered(sessionId: string, completedSeq: number): boolean
  flush(): Promise<void>
  relaunch(target: RestartTarget, jobId: string): void
  resume(job: RestartJob): Promise<void>
  notice(sessionId: string, text: string): void
  now?: () => number
}

/** Durable one-shot restart intent; Electron and session access stay in the host. */
export class AppRestartService {
  private jobs: RestartJob[] = []
  private loaded?: Promise<void>
  private writes = Promise.resolve()
  private mutations = Promise.resolve()
  private flight?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private confirmation = new Map<string, string>()
  private sequence = 0
  private replyWait?: { id: string; seq: number; since: number }
  private readonly now: () => number

  constructor(private file: string, private deps: AppRestartDeps) { this.now = deps.now || Date.now }

  private load(): Promise<void> {
    return this.loaded ||= (async () => {
      try {
        const rows = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(rows) || rows.some(j => !UUID.test(j.id) || !j.sessionId || !j.target?.sha256 || !['awaiting_confirmation','waiting','restarting','resuming','completed','failed','cancelled'].includes(j.state))) throw new Error('重启记录损坏，未执行重启')
        this.jobs = rows
      } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    })()
  }
  private persist(): Promise<void> {
    const content = JSON.stringify(this.jobs)
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await writeFile(this.file + '.tmp', content, { mode: 0o600 })
      await rename(this.file + '.tmp', this.file)
    })
    this.writes = write.catch(() => {})
    return write
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(run)
    this.mutations = result.then(() => {}, () => {})
    return result
  }
  private active(): RestartJob | undefined { return this.jobs.find(j => !TERMINAL.has(j.state)) }
  private changed(job: RestartJob): void { job.updatedAt = this.now(); this.sequence++ }
  private dismiss(job: RestartJob): void {
    const requestId = this.confirmation.get(job.id)
    this.confirmation.delete(job.id)
    if (requestId) this.deps.dismiss(job.sessionId, requestId)
  }
  private async fail(job: RestartJob, message: string): Promise<void> {
    job.state = 'failed'; job.error = message; this.changed(job); this.dismiss(job)
    await this.persist()
    this.deps.notice(job.sessionId, `重启并续聊未完成：${message}`)
  }
  private async ask(job: RestartJob): Promise<void> {
    try {
      this.dismiss(job)
      job.state = 'awaiting_confirmation'; job.mode = undefined
      job.approved = structuredClone(this.deps.activities(job.sessionId))
      this.changed(job)
      await this.persist()
      const requestId = `${job.id}:${this.sequence}`
      this.confirmation.set(job.id, requestId)
      const summary = `启动已准备好的 UniAgent ${job.target.version}，随后继续当前助手对话。\n目标：${job.target.bundle}\n包校验：${job.target.sha256}\n\n` +
        (job.approved.length ? `其他活动会话：\n${job.approved.map(s => `• ${s.title}（${s.status}，${s.id}）`).join('\n')}\n\n立即重启会中断这些任务，不能保证无损续跑；仅自动继续当前助手对话。` : '当前没有其他活动会话。确认后会先等待本轮回复发送完成，再正常退出。')
      this.deps.ask(job.sessionId, requestId, summary, job.approved.length ? [RESTART_WAIT, RESTART_NOW, RESTART_CANCEL] : [RESTART_NOW, RESTART_CANCEL],
        choice => this.serial(async () => {
          if (this.closed || this.confirmation.get(job.id) !== requestId || job.state !== 'awaiting_confirmation') return
          this.confirmation.delete(job.id)
          if (!choice || choice === RESTART_CANCEL) { job.state = 'cancelled'; this.changed(job); await this.persist(); return }
          if (choice !== RESTART_WAIT && choice !== RESTART_NOW) throw new Error('无效的重启选择')
          if (choice === RESTART_NOW && this.hasNewWork(job)) { await this.ask(job); return }
          job.mode = choice === RESTART_WAIT ? 'wait' : 'now'; job.state = 'waiting'; this.changed(job)
          await this.persist()
          this.deps.notice(job.sessionId, job.mode === 'wait' ? '已安排：等待所有活动会话结束后重启并续聊；可取消或重新选择重启时机。' : '已确认：本轮回复发送完成后，重启并继续当前助手对话。')
        }))
    } catch (error) {
      await this.fail(job, error instanceof Error ? error.message : '无法显示重启确认')
      throw error
    }
  }
  private hasNewWork(job: RestartJob): boolean {
    return this.deps.activities(job.sessionId).some(s => !job.approved.some(p => p.id === s.id && p.revision === s.revision))
  }

  async status(id?: string): Promise<RestartJob | null> {
    await this.load()
    const job = id ? this.jobs.find(j => j.id === id) : this.active() || this.jobs.at(-1)
    return job ? structuredClone(job) : null
  }
  request(id: string, sessionId: string, bundle: string, prompt: string): Promise<RestartJob> {
    return this.serial(async () => {
      await this.load()
      if (this.closed || !UUID.test(id) || !bundle || !prompt.trim() || prompt.length > 16000) throw new Error('无效的重启请求')
      const previous = this.jobs.find(j => j.id === id)
      if (previous) {
        if (previous.sessionId !== sessionId || previous.prompt !== prompt || previous.requestedBundle !== bundle) throw new Error('restart_id_conflict')
        return structuredClone(previous)
      }
      if (this.active()) throw new Error('已有重启请求，请先查询或取消')
      const caller = this.deps.caller(sessionId)
      if (!caller.available) throw new Error('当前助手会话不可续聊')
      const target = await this.deps.inspectTarget(bundle)
      if (this.closed) throw new Error('应用正在退出，未安排新的重启')
      const job: RestartJob = { id, sessionId, prompt, requestedBundle: bundle, target, state: 'awaiting_confirmation', afterSeq: caller.lastSeq,
        approved: [], createdAt: this.now(), updatedAt: this.now() }
      this.jobs.push(job)
      await this.ask(job)
      return structuredClone(job)
    })
  }
  cancel(id: string, sessionId: string): Promise<RestartJob> {
    return this.serial(async () => {
      await this.load()
      const job = this.jobs.find(j => j.id === id && j.sessionId === sessionId)
      if (!job) throw new Error('未找到当前会话的重启请求')
      if (['restarting','resuming'].includes(job.state)) throw new Error('重启已开始，不能取消')
      if (!TERMINAL.has(job.state)) { job.state = 'cancelled'; this.changed(job); this.dismiss(job); await this.persist() }
      return structuredClone(job)
    })
  }
  reconsider(id: string, sessionId: string): Promise<RestartJob> {
    return this.serial(async () => {
      await this.load()
      const job = this.jobs.find(j => j.id === id && j.sessionId === sessionId)
      if (!job || !['waiting','awaiting_confirmation'].includes(job.state)) throw new Error('重启请求已结束或已开始退出')
      await this.ask(job)
      return structuredClone(job)
    })
  }
  start(): void {
    if (this.closed || this.timer) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 1000)
    this.timer.unref?.()
  }
  tick(): Promise<void> {
    if (this.flight) return this.flight
    const flight = this.advance().catch(async error => {
      const job = this.active()
      if (!this.closed && job) await this.fail(job, error instanceof Error ? error.message : '检查重启条件失败')
      else throw error
    }).finally(() => { if (this.flight === flight) this.flight = undefined })
    this.flight = flight
    return flight
  }
  private async advance(): Promise<void> {
    await this.load()
    const job = this.active()
    if (this.closed || !job || job.state !== 'waiting') return
    const caller = this.deps.caller(job.sessionId)
    if (!caller.available) { await this.fail(job, '助手会话已停用、归档或不可写'); return }
    if (caller.busy || !caller.completed || caller.completed.seq <= job.afterSeq) return
    if (!caller.completed.success) { await this.fail(job, '当前助手回合未成功结束，未自动退出'); return }
    if (!this.deps.replyDelivered(job.sessionId, caller.completed.seq)) {
      if (this.replyWait?.id !== job.id || this.replyWait.seq !== caller.completed.seq) this.replyWait = { id: job.id, seq: caller.completed.seq, since: this.now() }
      if (this.now() - this.replyWait.since >= 120000) await this.fail(job, '本轮回复两分钟内未确认送达，已停止重启；请检查消息通道后重新发起')
      return
    }
    this.replyWait = undefined
    if (job.mode === 'wait' && this.deps.activities(job.sessionId).length) return
    if (job.mode === 'now' && this.hasNewWork(job)) { await this.serial(() => job.state === 'waiting' ? this.ask(job) : Promise.resolve()); return }
    const sequence = this.sequence
    const unchanged = () => !this.closed && sequence === this.sequence && job.state === 'waiting'
    try {
      const target = await this.deps.inspectTarget(job.target.bundle)
      if (!unchanged()) return
      if (JSON.stringify(target) !== JSON.stringify(job.target)) throw new Error('目标程序已变化，请重新发起并确认')
      await this.deps.flush()
      if (!unchanged()) return
      const current = this.deps.caller(job.sessionId)
      if (current.busy || !current.available || current.completed?.seq !== caller.completed.seq) return
      job.state = 'restarting'; this.changed(job)
      await this.persist()
      // No await between the final activity check and native quit: a new turn
      // cannot be admitted in the middle of that decision on the main loop.
      const finalCaller = this.deps.caller(job.sessionId)
      if (this.closed) return
      if (!finalCaller.available || finalCaller.busy || finalCaller.completed?.seq !== caller.completed.seq ||
          (job.mode === 'wait' ? this.deps.activities(job.sessionId).length > 0 : this.hasNewWork(job))) {
        job.state = 'waiting'; this.changed(job); await this.persist(); return
      }
      this.deps.relaunch(job.target, job.id)
    } catch (error) {
      if (job.state !== 'restarting' && !unchanged()) return
      await this.fail(job, error instanceof Error ? error.message : '重启失败')
    }
  }

  /** Called once after hydration/Agent readiness; never blocks the first window. */
  recover(restartId: string | undefined, executable: string): Promise<void> {
    return this.serial(() => this.recoverOnce(restartId, executable))
  }
  private async recoverOnce(restartId: string | undefined, executable: string): Promise<void> {
    await this.load()
    if (this.closed) return
    const job = this.active()
    if (!job) return
    if (!restartId || job.id !== restartId || job.state !== 'restarting') {
      await this.fail(job, job.state === 'resuming' ? '上次续聊提交结果不确定，请核对原会话；未自动重发' : '上次重启流程被中断；未再次重启或发送消息')
      return
    }
    try {
      if (this.now() - job.updatedAt > 10 * 60_000) throw new Error('重启恢复请求已过期，未自动续聊')
      const target = await this.deps.inspectTarget(job.target.bundle)
      if (this.closed) return
      if (target.executable !== executable || JSON.stringify(target) !== JSON.stringify(job.target)) throw new Error('当前启动程序与确认的目标包不一致')
      const caller = this.deps.caller(job.sessionId)
      if (!caller.available || caller.busy) throw new Error('原助手会话不可用或已有新任务，未自动插入续聊')
      job.state = 'resuming'; this.changed(job)
      await this.persist()
      if (this.closed) return
      await this.deps.resume(structuredClone(job))
      job.state = 'completed'; this.changed(job); await this.persist()
    } catch (error) { await this.fail(job, error instanceof Error ? error.message : '恢复对话失败') }
  }
  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.mutations
    await this.writes
  }
}
