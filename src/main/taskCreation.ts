import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Attachment } from '../shared/types'
import type { TaskInputState, TaskRegistration } from '../shared/task'
import { taskRequestFingerprint } from '../shared/taskRequest'
import { atomicWriteFile } from './sessionStore'

export interface TaskCreationRecord {
  version: 1
  requestId: string
  inputId: string
  kind: 'message' | 'native' | 'team'
  fingerprint: string
  sessionId: string
  teamProjectId: string
  state: TaskInputState
  payload: unknown
  inputText: string
  events: TaskRegistration['events']
}
export interface TaskCreationContext { record: TaskCreationRecord; beforeDispatch: () => Promise<void> }

export function taskRegistration(record: TaskCreationRecord): TaskRegistration {
  return { requestId: record.requestId, inputId: record.inputId, phase: record.state === 'dispatched' || record.state === 'unknown' ? 'active' : 'provisioning',
    delivery: record.state, inputText: record.inputText, events: structuredClone(record.events) }
}

/** Per-intent async files bound metadata writes; no startup-wide receipt scan or replay. */
export class TaskCreation {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<unknown> }>()
  constructor(private readonly directory: string, private readonly write = atomicWriteFile) {}

  private path(id: string): string {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('创建请求 ID 无效')
    return join(this.directory, id.toLowerCase() + '.json')
  }

  async get(id: string): Promise<TaskCreationRecord | undefined> {
    this.path(id)
    id = id.toLowerCase()
    let value: TaskCreationRecord
    try { value = JSON.parse(await readFile(this.path(id), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('创建回执损坏或无法读取，已停止投递', { cause: error }) }
    if (!value || typeof value !== 'object' || value.version !== 1 || value.requestId !== id || value.inputId !== id || !['message','native','team'].includes(value.kind) ||
      !['registered','accepted','dispatching','dispatched','unknown'].includes(value.state) || typeof value.fingerprint !== 'string' ||
      typeof value.sessionId !== 'string' || typeof value.teamProjectId !== 'string' || typeof value.inputText !== 'string' ||
      createHash('sha256').update(taskRequestFingerprint({ kind: value.kind, payload: value.payload })).digest('hex') !== value.fingerprint ||
      !Array.isArray(value.events) || value.events.length > 6 || value.events.some(item => !item || !Number.isSafeInteger(item.ts) || item.ts < 0 || !['registered','accepted','dispatching','dispatched','unknown'].includes(item.state))) {
      throw new Error('创建回执损坏，已停止投递；请保留记录后检查')
    }
    return value
  }

  private async save(record: TaskCreationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.write(this.path(record.requestId), JSON.stringify(record))
  }

  run<T>(requestId: string, kind: TaskCreationRecord['kind'], payload: unknown, inputText: string, hooks: {
    execute: (record: TaskCreationRecord, beforeDispatch: () => Promise<void>) => Promise<T>
    existing: (record: TaskCreationRecord) => Promise<T>
  }): Promise<T> {
    this.path(requestId)
    if (typeof inputText !== 'string') return Promise.reject(new Error('任务输入无效'))
    requestId = requestId.toLowerCase()
    const fingerprint = createHash('sha256').update(taskRequestFingerprint({ kind, payload })).digest('hex')
    const prior = this.pending.get(requestId)
    if (prior) return prior.fingerprint === fingerprint ? prior.promise as Promise<T> : Promise.reject(new Error('相同输入 ID 对应不同内容，请重新提交'))
    const promise = this.execute(requestId, kind, payload, inputText, fingerprint, hooks)
    this.pending.set(requestId, { fingerprint, promise })
    void promise.finally(() => { if (this.pending.get(requestId)?.promise === promise) this.pending.delete(requestId) }).catch(() => {})
    return promise
  }

  private async execute<T>(requestId: string, kind: TaskCreationRecord['kind'], payload: unknown, inputText: string, fingerprint: string,
    hooks: { execute: (record: TaskCreationRecord, beforeDispatch: () => Promise<void>) => Promise<T>; existing: (record: TaskCreationRecord) => Promise<T> }): Promise<T> {
    let record = await this.get(requestId)
    if (record && record.fingerprint !== fingerprint) throw new Error('相同输入 ID 对应不同内容，请重新提交')
    if (!record) {
      record = { version: 1, requestId, inputId: requestId, kind, fingerprint, sessionId: 's_' + randomUUID(), teamProjectId: 'tp_' + randomUUID(),
        state: 'registered', payload: structuredClone(payload), inputText, events: [{ state: 'registered', ts: Date.now() }] }
      await this.save(record)
    }
    const receipt = record
    const advance = async (state: TaskInputState): Promise<void> => {
      const next = { ...receipt, state, events: [...receipt.events, { state, ts: Date.now() }] }
      await this.save(next)
      Object.assign(receipt, next)
    }
    if (receipt.state === 'dispatching') await advance('unknown')
    if (receipt.state === 'unknown' || receipt.state === 'dispatched') return hooks.existing(receipt)
    let dispatchStarted = false
    let acceptanceStarted = false
    try {
      const result = await hooks.execute(receipt, async () => {
        if (acceptanceStarted) throw new Error('首条输入已经接受，不得重复投递')
        acceptanceStarted = true
        if (receipt.state === 'registered') await advance('accepted')
        // Even a failed/uncertain write at this boundary must prevent another send.
        dispatchStarted = true
        await advance('dispatching')
      })
      if (!dispatchStarted) throw new Error('创建链路未登记输入接受回执')
      await advance('dispatched')
      return result
    } catch (error) {
      if (!dispatchStarted) throw error
      // Never erase a prior dispatch marker, even if recording unknown also fails.
      try { await advance('unknown') } catch { /* durable dispatch marker remains authoritative */ }
      throw new Error('任务创建结果待确认，请使用相同内容重试查询原任务；不会自动重发首条输入', { cause: error })
    }
  }
}

export async function validateTaskAttachments(attachments?: Attachment[]): Promise<void> {
  for (const item of attachments || []) {
    const file = await open(item.path, 'r').catch(() => { throw new Error('附件已失效或不可读：' + item.name) })
    try { if (!(await file.stat()).isFile()) throw new Error('附件不是文件：' + item.name) }
    finally { await file.close() }
  }
}
