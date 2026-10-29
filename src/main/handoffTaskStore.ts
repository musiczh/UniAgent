import { appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { UAEvent } from '../shared/types.ts'
import type { HandoffResult } from './handoff.ts'
import { handoffTaskAction, handoffTaskIdFromResult, handoffTerminalStatus, isHandoffEndEvent } from '../shared/handoffEvents.ts'

const TERMINAL = new Set(['idle', 'completed', 'error', 'cancelled', 'interrupted', 'archived'])
const TEXT_FIELDS = ['text', 'output', 'diff'] as const

interface TaskSnapshot extends HandoffResult {
  callerSessionId?: string
  endedAt?: number
  schemaVersion: 1
  statusFile: string
  eventsFile: string
  followupTaskId?: string
  ts: number
  done: boolean
  latestReply: string
  lastSeq: number
  logBytes: number
  logComplete: boolean
  logError?: string
  staleAfterMs: number
}

interface TaskLog {
  snapshot: TaskSnapshot
  seq: number
  pending: string[]
  pendingBytes: number
  fields: Map<string, string>
  turn: string
  timer?: ReturnType<typeof setTimeout>
}

/** One main-process writer; task logs are never rotated or truncated. */
export class HandoffTaskStore extends EventEmitter {
  private readonly tasks = new Map<string, TaskLog>()
  private readonly deletedSessions = new Set<string>()
  private readonly root: string

  constructor(root: string) {
    super()
    this.root = resolve(root)
  }

  private paths(id: string): { statusFile: string; eventsFile: string } {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('invalid_handoff_task_id')
    return { statusFile: join(this.root, id + '.json'), eventsFile: join(this.root, id + '.events.jsonl') }
  }

  begin(id: string, followupTaskId?: string, sessionId = '', callerSessionId?: string): boolean {
    const paths = this.paths(id)
    if (this.tasks.has(id)) return false
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    // Reserve the log before execution. Failure here must not start an unobservable task.
    try { writeFileSync(paths.eventsFile, '', { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    const task: TaskLog = {
      snapshot: {
        schemaVersion: 1, taskId: id, status: 'queued', text: '', latestReply: '', sessionId,
        ...paths, ...(followupTaskId ? { followupTaskId } : {}),
        ...(callerSessionId ? { callerSessionId } : {}),
        ts: Date.now(), done: false, lastSeq: 0, logBytes: 0, logComplete: false, staleAfterMs: 60_000
      },
      seq: 0, pending: [], pendingBytes: 0, fields: new Map(), turn: ''
    }
    this.tasks.set(id, task)
    this.append(task, 'status', { status: 'queued' })
    this.flush(task)
    if (task.snapshot.logError) throw new Error(task.snapshot.logError)
    return true
  }

  isActive(id: string): boolean { return this.tasks.has(id) }

  latestReply(id: string): string | undefined { return this.tasks.get(id)?.snapshot.text }

  recordEvent(id: string, event: UAEvent): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.snapshot.sessionId = event.sessionId
    if (event.type === 'turn_started') {
      task.turn = String(event.payload.turnId || event.seq)
      task.fields.clear()
    }
    if (event.type === 'agent_message' && typeof event.payload.text === 'string') {
      task.snapshot.text = event.payload.text
    }
    if (task.snapshot.logError) return
    const payload = { ...event.payload }
    const fieldOps: Record<string, 'append' | 'replace'> = {}
    // UAEvent contains cumulative snapshots. Store only new text, preserving edits as replacements.
    if (typeof payload.id === 'string' || typeof payload.id === 'number') {
      if (typeof payload.text === 'string') delete payload.delta
      for (const field of TEXT_FIELDS) {
        const value = payload[field]
        if (typeof value !== 'string') continue
        const key = JSON.stringify([task.turn, event.type, payload.id, field])
        const previous = task.fields.get(key)
        if (previous === value) { delete payload[field]; continue }
        const append = previous !== undefined && value.startsWith(previous)
        payload[field] = append ? value.slice(previous.length) : value
        fieldOps[field] = append ? 'append' : 'replace'
        task.fields.set(key, value)
      }
    }
    this.append(task, 'event', { ...event, payload, ...(Object.keys(fieldOps).length ? { fieldOps } : {}) })
    if (task.pendingBytes >= 256 * 1024 || event.type === 'turn_completed' || event.type === 'error') {
      this.flush(task)
    } else if (!task.timer) {
      task.timer = setTimeout(() => this.flush(task), 750)
      task.timer.unref()
    }
  }

  /** Receipts still use the existing result format; tracked tasks also publish log watermarks. */
  writeResult(id: string, result: HandoffResult): void {
    if (this.deletedSessions.has(result.sessionId)) return
    const task = this.tasks.get(id)
    if (!task) {
      try {
        const { statusFile } = this.paths(id)
        const previous = this.read(statusFile)
        // A late delivery receipt must not turn a finished task back into a live one.
        const next = previous?.done && result.delivery
          ? { ...previous, delivery: result.delivery }
          : { ...previous, ...result }
        this.publish(statusFile, { ...next, ts: Date.now() })
      } catch (error) { this.report(error) }
      return
    }
    const previousStatus = task.snapshot.status
    const sessionId = result.sessionId || task.snapshot.sessionId
    Object.assign(task.snapshot, result)
    task.snapshot.sessionId = sessionId
    if (previousStatus !== result.status) this.append(task, 'status', {
      status: result.status, stoppedBy: result.stoppedBy,
      ...(result.status === 'error' ? { error: result.text } : {})
    })
    task.snapshot.done = TERMINAL.has(result.status)
    if (task.snapshot.done) task.snapshot.endedAt = Date.now()
    this.flush(task)
    if (task.snapshot.done) {
      this.tasks.delete(id)
      if (task.snapshot.callerSessionId && task.snapshot.sessionId) {
        this.emit('end', this.endEvent(task.snapshot.callerSessionId, task.snapshot))
      }
    }
  }

  /** Restore per-task terminal facts without consulting the reusable Session status. */
  async loadCallerEvents(sessionId: string, events: UAEvent[]): Promise<UAEvent[]> {
    const ids = new Set(events.filter(event => event.type === 'tool_call' &&
      ['create', 'followup'].includes(handoffTaskAction(event) || '')).map(event => handoffTaskIdFromResult(event.payload.result)).filter(Boolean))
    for (const event of events) if (isHandoffEndEvent(event)) ids.delete(event.payload.taskId)
    const saved = await Promise.all([...ids].map(async id => {
      try {
        const snapshot: TaskSnapshot = JSON.parse(await readFile(this.paths(id).statusFile, 'utf8'))
        if (snapshot.done !== true || !handoffTerminalStatus(snapshot.status) || !snapshot.sessionId ||
          snapshot.callerSessionId && snapshot.callerSessionId !== sessionId) return undefined
        return this.endEvent(sessionId, { ...snapshot, taskId: id })
      } catch { return undefined }
    }))
    return saved.filter((event): event is UAEvent => !!event)
  }

  private endEvent(sessionId: string, snapshot: TaskSnapshot): UAEvent {
    const status = handoffTerminalStatus(snapshot.status)!
    return {
      sessionId, seq: 0, ts: snapshot.endedAt ?? snapshot.ts, type: 'system_notice',
      state: status === 'failed' ? 'failed' : status === 'stopped' ? 'cancelled' : 'success',
      payload: {
        id: `handoff-end:${snapshot.taskId}`, kind: 'handoff_end', taskId: snapshot.taskId,
        targetSessionId: snapshot.sessionId, status, reply: snapshot.latestReply || snapshot.text,
        agentId: snapshot.targetAgent?.id, agentName: snapshot.targetAgent?.name,
        stoppedBy: snapshot.stoppedBy,
      },
    }
  }

  /** Freeze interrupted runs on restart; never mistake a restored idle Session for success. */
  recover(): void {
    for (const [id, snapshot] of this.saved()) {
      if (snapshot.schemaVersion !== 1 || snapshot.done) continue
      try {
        this.publish(this.paths(id).statusFile, {
          ...snapshot, status: 'interrupted', done: true, ts: Date.now(), endedAt: Date.now(), logComplete: false,
          logError: 'UniAgent restarted before the task finished; the log may be incomplete.'
        })
      } catch (error) { this.report(error) }
    }
  }

  removeSession(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    for (const [id, task] of this.tasks) {
      if (task.snapshot.sessionId !== sessionId) continue
      if (task.timer) clearTimeout(task.timer)
      this.tasks.delete(id)
    }
    for (const [id, snapshot] of this.saved()) {
      if (snapshot.sessionId !== sessionId) continue
      const paths = this.paths(id)
      for (const path of [paths.statusFile, paths.eventsFile, paths.statusFile + '.tmp']) {
        try { unlinkSync(path) } catch (error: any) { if (error.code !== 'ENOENT') this.report(error) }
      }
    }
  }

  close(): void {
    for (const [id, task] of this.tasks) {
      this.writeResult(id, { ...task.snapshot, status: 'interrupted' })
    }
  }

  private append(task: TaskLog, kind: 'event' | 'status', data: unknown): void {
    if (task.snapshot.logError) return
    try {
      const line = JSON.stringify({ seq: task.seq + 1, ts: Date.now(), kind, data }) + '\n'
      task.seq++
      task.pending.push(line)
      task.pendingBytes += Buffer.byteLength(line)
    } catch (error) { this.logFailure(task, error) }
  }

  private flush(task: TaskLog): void {
    if (task.timer) clearTimeout(task.timer)
    task.timer = undefined
    if (task.pending.length) {
      try {
        // ponytail: one synchronous batch per 750 ms; use an async writer if measured disk latency affects UI.
        const fd = openSync(task.snapshot.eventsFile, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
        try { appendFileSync(fd, task.pending.join(''), 'utf8') }
        finally { closeSync(fd) }
        task.snapshot.lastSeq = task.seq
        task.snapshot.logBytes += task.pendingBytes
      } catch (error) { this.logFailure(task, error) }
      task.pending = []
      task.pendingBytes = 0
    }
    task.snapshot.ts = Date.now()
    task.snapshot.latestReply = task.snapshot.text
    task.snapshot.logComplete = task.snapshot.done && !task.snapshot.logError
    try { this.publish(task.snapshot.statusFile, task.snapshot) }
    catch (error) { this.logFailure(task, error) }
  }

  private logFailure(task: TaskLog, error: unknown): void {
    task.snapshot.logError = error instanceof Error ? error.message : String(error)
    task.snapshot.logComplete = false
    this.report(error)
  }

  private publish(path: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    writeFileSync(path + '.tmp', JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    renameSync(path + '.tmp', path)
  }

  private read(path: string): Record<string, any> | undefined {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
    } catch { return undefined }
  }

  private saved(): Array<[string, Record<string, any>]> {
    try {
      if (!existsSync(this.root)) return []
      return readdirSync(this.root).flatMap((name) => {
        if (!/^[a-zA-Z0-9_-]{1,160}\.json$/.test(name)) return []
        const snapshot = this.read(join(this.root, name))
        return snapshot ? [[name.slice(0, -5), snapshot] as [string, Record<string, any>]] : []
      })
    } catch (error) { this.report(error); return [] }
  }

  private report(error: unknown): void { console.error('[handoff-task-files]', error) }
}
