import { readFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { atomicWriteFile } from './sessionStore'
import { interruptCommentEvents, type CommentThread } from '../shared/comments'
import type { SessionConfig, UAEvent } from '../shared/types'

export interface StoredComment extends CommentThread { context: UAEvent[]; sourceContent: string; parentConfig: SessionConfig }

/** JSON serialization runs off the Electron thread; fsync uses asynchronous I/O. */
export class CommentStore {
  private worker?: Worker
  private serial = 0
  private pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private writes = new Map<string, Promise<void>>()
  constructor(private root: string) {}
  private path(sessionId: string): string { return join(this.root, createHash('sha256').update(sessionId).digest('hex') + '.json') }
  async load(sessionId: string): Promise<StoredComment[]> {
    let rows: unknown
    try { rows = JSON.parse(await readFile(this.path(sessionId), 'utf8')) }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw new Error('评论记录读取失败') }
    if (!Array.isArray(rows)) throw new Error('评论记录格式无效')
    return rows.filter((row): row is StoredComment => row?.sessionId === sessionId && typeof row.id === 'string' &&
      row.anchor && typeof row.anchor.quote === 'string' && Array.isArray(row.events) && Array.isArray(row.context) && row.config && row.parentConfig)
      .map(row => ['running', 'awaiting-approval'].includes(row.status)
        ? { ...row, status: 'interrupted', events: interruptCommentEvents(row.events) } : row)
  }
  async save(sessionId: string, rows: StoredComment[]): Promise<void> {
    const path = this.path(sessionId)
    const serialized = this.serialize(rows)
    const next = Promise.all([this.writes.get(path)?.catch(() => {}), serialized]).then(async ([, text]) => {
      await mkdir(this.root, { recursive: true })
      await atomicWriteFile(path, text)
    })
    this.writes.set(path, next)
    try { await next } finally { if (this.writes.get(path) === next) this.writes.delete(path) }
  }
  private serialize(value: unknown): Promise<string> {
    if (!this.worker) {
      const worker = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',({id,value})=>{try{parentPort.postMessage({id,text:JSON.stringify(value)})}catch(e){parentPort.postMessage({id,error:String(e)})}})`, { eval: true })
      this.worker = worker
      worker.on('message', ({ id, text, error }) => {
        const request = this.pending.get(id); this.pending.delete(id)
        if (error) request?.reject(new Error(error)); else request?.resolve(text)
        if (!this.pending.size) worker.unref()
      })
      worker.on('error', error => { this.worker = undefined; for (const request of this.pending.values()) request.reject(error); this.pending.clear() })
    }
    return new Promise((resolve, reject) => { const id = ++this.serial; this.pending.set(id, { resolve, reject }); this.worker!.ref(); this.worker!.postMessage({ id, value }) })
  }
  async close(): Promise<void> { await Promise.allSettled([...this.writes.values()]); await this.worker?.terminate(); this.worker = undefined }
}
