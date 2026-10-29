import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ALL_EFFORTS, PERMISSION_MODE_IDS, type AutomationDetail, type AutomationEditPatch, type NativeAutomationInput, type Session, type SessionStatus } from '../shared/types'
import { nextScheduleRuns, parseScheduleExpression } from '../shared/automationSchedule'
import { atomicWrite } from './projectStore'
import { resolveUserDataHome } from './userData'

interface AutomationRuntime {
  run: (task: AutomationDetail, isCurrent: () => boolean) => Promise<Session | null>
  getSession: (id: string) => Session | undefined
  getError: (id: string) => Promise<string | undefined>
  changed: () => void
  onError: (error: unknown) => void
}

const BUSY = new Set<AutomationDetail['lastRunStatus']>(['running', 'awaiting-approval'])

function validateInput(input: NativeAutomationInput): NativeAutomationInput {
  if (!input || !['name', 'prompt', 'schedule', 'agentId', 'projectId', 'permissionMode'].every(key =>
    typeof input[key as keyof NativeAutomationInput] === 'string' && String(input[key as keyof NativeAutomationInput]).trim()) ||
    (input.model !== undefined && typeof input.model !== 'string') ||
    (input.reasoningEffort !== undefined && !ALL_EFFORTS.includes(input.reasoningEffort))) {
    throw new Error('原生定时任务配置无效')
  }
  if (!PERMISSION_MODE_IDS.includes(input.permissionMode)) throw new Error('权限模式无效')
  if (!parseScheduleExpression(input.schedule).ok) throw new Error('请选择有效的执行计划')
  return {
    name: input.name.trim(), prompt: input.prompt.trim(), schedule: input.schedule,
    agentId: input.agentId, projectId: input.projectId, permissionMode: input.permissionMode,
    model: input.model || undefined, reasoningEffort: input.reasoningEffort
  }
}

function nextRun(schedule: string, now = Date.now()): number {
  const next = nextScheduleRuns(parseScheduleExpression(schedule), 1, new Date(now))[0]
  if (!next) throw new Error('无法计算下一次执行时间')
  return next.getTime()
}

export class NativeAutomations {
  private readonly file: string
  private items: AutomationDetail[] = []
  private loaded = false
  private timer: ReturnType<typeof setInterval> | undefined
  private started = false
  private pending = new Map<string, object>()

  constructor(private readonly runtime: AutomationRuntime, fileOverride?: string) {
    this.file = fileOverride || join(resolveUserDataHome(), 'native-automations.json')
  }

  load(): void {
    if (this.loaded) return
    if (!existsSync(this.file)) { this.loaded = true; return }
    let rows: unknown
    try { rows = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch { throw new Error('原生定时任务文件无法读取，请检查 native-automations.json') }
    if (!Array.isArray(rows)) throw new Error('原生定时任务文件格式无效')
    const ids = new Set<string>()
    let recovered = false
    const next = rows.map(raw => {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.startsWith('uniagent:') ||
          ids.has(raw.id) || !['active', 'paused'].includes(raw.status) ||
          !Number.isFinite(raw.nextRunAt) || raw.nextRunAt <= 0 ||
          typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string' ||
          (raw.lastRunAt !== undefined && !Number.isFinite(raw.lastRunAt)) ||
          (raw.lastSessionId !== undefined && typeof raw.lastSessionId !== 'string') ||
          (raw.lastRunStatus !== undefined && !['success', 'error', 'running', 'awaiting-approval', 'unknown'].includes(raw.lastRunStatus))) {
        throw new Error('原生定时任务文件包含无效配置')
      }
      ids.add(raw.id)
      const item: AutomationDetail = {
        ...validateInput(raw), id: raw.id, source: 'uniagent', status: raw.status,
        nextRunAt: raw.nextRunAt, createdAt: raw.createdAt, updatedAt: raw.updatedAt,
        lastRunAt: raw.lastRunAt, lastSessionId: raw.lastSessionId,
        lastRunStatus: raw.lastRunStatus, lastRunError: typeof raw.lastRunError === 'string' ? raw.lastRunError : undefined
      }
      if (BUSY.has(item.lastRunStatus)) {
        recovered = true
        item.lastRunStatus = 'error'
        item.lastRunError = 'UniAgent 已重启，上次执行被中断'
      }
      return item
    })
    if (recovered) atomicWrite(this.file, JSON.stringify(next, null, 2))
    this.items = next
    this.loaded = true
  }

  list(): AutomationDetail[] { this.load(); return structuredClone(this.items) }
  get(id: string): AutomationDetail | null { this.load(); return structuredClone(this.items.find(item => item.id === id) ?? null) }

  private commit(next: AutomationDetail[]): void {
    atomicWrite(this.file, JSON.stringify(next, null, 2))
    this.items = next
    try { this.runtime.changed() } catch (error) { this.runtime.onError(error) }
  }

  create(input: NativeAutomationInput): AutomationDetail {
    this.load()
    const fields = validateInput(input)
    const now = Date.now()
    const item: AutomationDetail = {
      ...fields, id: `uniagent:${randomUUID()}`, source: 'uniagent', status: 'active',
      createdAt: String(now), updatedAt: String(now), nextRunAt: nextRun(fields.schedule, now)
    }
    this.commit([...this.items, item])
    return structuredClone(item)
  }

  update(id: string, patch: AutomationEditPatch): boolean {
    this.load()
    const current = this.items.find(item => item.id === id)
    if (!current) return false
    const fields = validateInput({ ...current, ...patch } as NativeAutomationInput)
    const now = Date.now()
    this.commit(this.items.map(item => item.id === id ? {
      ...item, ...fields, updatedAt: String(now),
      nextRunAt: fields.schedule !== current.schedule ? nextRun(fields.schedule, now) : item.nextRunAt
    } : item))
    return true
  }

  setStatus(id: string, status: 'active' | 'paused'): boolean {
    this.load()
    if (status !== 'active' && status !== 'paused') throw new Error('计划状态无效')
    const current = this.items.find(item => item.id === id)
    if (!current) return false
    if (current.status === status) return true
    this.commit(this.items.map(item => item.id === id ? {
      ...item, status, updatedAt: String(Date.now()),
      nextRunAt: status === 'active' ? nextRun(item.schedule!) : item.nextRunAt
    } : item))
    return true
  }

  delete(id: string): boolean {
    this.load()
    if (!this.items.some(item => item.id === id)) return false
    this.commit(this.items.filter(item => item.id !== id))
    return true
  }

  start(): void {
    if (this.started) return
    this.load()
    this.started = true
    this.timer = setInterval(() => this.tick(), 15_000)
    this.timer.unref?.()
    this.tick()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.pending.clear()
  }

  private tick(): void {
    if (!this.started) return
    const now = Date.now()
    for (const item of [...this.items]) {
      if (item.status !== 'active' || !item.nextRunAt || item.nextRunAt > now) continue
      try {
        const occupied = BUSY.has(item.lastRunStatus) || this.pending.has(item.id)
        const next = { ...item, nextRunAt: nextRun(item.schedule!, now) }
        if (!occupied) {
          next.lastRunAt = now
          next.lastRunStatus = 'running'
          next.lastSessionId = undefined
          next.lastRunError = undefined
        }
        this.commit(this.items.map(row => row.id === item.id ? next : row))
        if (!occupied) {
          const token = {}
          this.pending.set(item.id, token)
          void this.execute(structuredClone(next), token)
        }
      } catch (error) { this.runtime.onError(error) }
    }
  }

  private async execute(task: AutomationDetail, token: object): Promise<void> {
    let spawned = false
    const isCurrent = (): boolean => {
      const item = this.items.find(item => item.id === task.id)
      return this.started && this.pending.get(task.id) === token && item?.status === 'active' && item.updatedAt === task.updatedAt
    }
    try {
      const session = await this.runtime.run(task, isCurrent)
      if (!session) {
        this.finishPending(task, '执行开始前计划已暂停或更改')
        return
      }
      spawned = true
      const current = this.items.find(item => item.id === task.id)
      if (!current || current.lastRunAt !== task.lastRunAt) return
      this.commit(this.items.map(item => item.id === task.id ? { ...item, lastSessionId: session.id } : item))
      const status = this.runtime.getSession(session.id)?.status ?? session.status
      this.handleStatus(session.id, status)
      if (status === 'error') this.handleStatus(session.id, status, await this.runtime.getError(session.id))
    } catch (error) {
      try { if (!spawned) this.finishPending(task, error instanceof Error ? error.message : String(error)) }
      catch (writeError) { this.runtime.onError(writeError) }
      this.runtime.onError(error)
    } finally {
      if (this.pending.get(task.id) === token) this.pending.delete(task.id)
    }
  }

  private finishPending(task: AutomationDetail, error: string): void {
    if (!this.items.some(item => item.id === task.id && item.lastRunAt === task.lastRunAt)) return
    this.commit(this.items.map(item => item.id === task.id ? { ...item, lastRunStatus: 'error', lastRunError: error } : item))
  }

  handleStatus(sessionId: string, status: SessionStatus, error?: string): void {
    const current = this.items.find(item => item.lastSessionId === sessionId)
    if (!current) return
    if (!BUSY.has(current.lastRunStatus) && !(current.lastRunStatus === 'error' && status === 'error' && error)) return
    const succeeded = status === 'idle' || status === 'completed'
    const failed = ['error', 'cancelled', 'interrupted', 'archived'].includes(status)
    const lastRunStatus = succeeded ? 'success' : failed ? 'error' : status === 'awaiting-approval' ? 'awaiting-approval' : 'running'
    const lastRunError = failed ? error || current.lastRunError || (status === 'error' ? 'Agent 执行失败，请查看执行会话' : '执行已中断') : undefined
    if (current.lastRunStatus === lastRunStatus && current.lastRunError === lastRunError) return
    this.commit(this.items.map(item => item.id === current.id ? { ...item, lastRunStatus, lastRunError } : item))
  }
}
