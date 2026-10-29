import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainThread, Worker } from 'node:worker_threads'
import type { UAEvent } from '../shared/types.ts'
import { interactionRequestKey } from '../shared/interactionRequests'

interface SessionLogStoreOptions {
  maxFileBytes?: number
  maxEntryBytes?: number
  background?: boolean
}

/** Best-effort, rolling JSONL diagnostics kept separately for every session. */
export class SessionLogStore {
  private readonly maxFileBytes: number
  private readonly maxEntryBytes: number
  private worker?: Worker
  private workerError?: Error
  private nextFlush = 0
  private flushes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()

  constructor(
    private readonly root: string | undefined,
    options: SessionLogStoreOptions = {}
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
    this.maxEntryBytes = options.maxEntryBytes ?? 64 * 1024
    const writer = new URL('./sessionLogWriter.js', import.meta.url)
    if (root && options.background && isMainThread && existsSync(fileURLToPath(writer))) {
      const worker = new Worker(writer, { workerData: { root, options: { ...options, background: false } } })
      this.worker = worker
      worker.unref()
      worker.on('message', (id: number) => { this.flushes.get(id)?.resolve(); this.flushes.delete(id) })
      worker.on('error', (error) => {
        this.workerError = error
        this.worker = undefined
        for (const pending of this.flushes.values()) pending.reject(error)
        this.flushes.clear()
      })
      worker.on('exit', (code) => {
        if (this.worker !== worker) return
        this.worker = undefined
        if (code !== 0) this.workerError = new Error('Session log writer exited')
        for (const pending of this.flushes.values()) pending.reject(this.workerError || new Error('Session log writer closed'))
        this.flushes.clear()
      })
    }
  }

  flush(): Promise<void> {
    if (this.workerError) return Promise.reject(this.workerError)
    if (!this.worker) return Promise.resolve()
    const id = ++this.nextFlush
    return new Promise((resolve, reject) => {
      this.flushes.set(id, { resolve, reject })
      this.worker!.postMessage({ flush: id })
    })
  }

  get backgroundWrites(): boolean { return !!this.worker || !!this.workerError }

  async close(): Promise<void> {
    await this.flush()
    const worker = this.worker
    this.worker = undefined
    await worker?.terminate()
  }

  append(sessionId: string, kind: string, data: unknown): void {
    if (!this.root) return
    if (this.worker) {
      try { this.worker.postMessage({ sessionId, kind, data }) } catch {
        // Non-cloneable diagnostic payloads must never interrupt a live turn.
      }
      return
    }
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const file = join(this.root, `${safeSessionId(sessionId)}.jsonl`)
      const line = this.serialize(sessionId, kind, data) + '\n'
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > this.maxFileBytes) {
        const interruptedReplies = this.loadInterruptedReplies(sessionId)
        const interactions = this.loadReplayCheckpoints(sessionId)
        const rotated = `${file}.1`
        if (existsSync(rotated)) unlinkSync(rotated)
        renameSync(file, rotated)
        for (const event of [...interruptedReplies, ...interactions]) {
          appendFileSync(file, this.serialize(sessionId, 'ua_event', { channel: 'main', event }) + '\n', {
            encoding: 'utf8',
            mode: 0o600
          })
        }
      }
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Diagnostics must never disturb the session they are observing.
    }
  }

  loadInterruptedReplies(sessionId: string): UAEvent[] {
    if (!this.root) return []
    const latest = new Map<string, UAEvent>()
    try {
      for (const suffix of ['.1', '']) {
        const file = join(this.root, `${safeSessionId(sessionId)}.jsonl${suffix}`)
        if (!existsSync(file)) continue
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue
          let record: any
          try { record = JSON.parse(line) } catch { continue }
          const event = record?.kind === 'ua_event' && record.data?.channel === 'main'
            ? record.data.event
            : undefined
          const id = typeof event?.payload?.id === 'string' ? event.payload.id : ''
          const turnId = typeof event?.payload?.turnId === 'string' ? event.payload.turnId : ''
          if (event?.type !== 'agent_message' || !id || !turnId) continue
          const key = `${turnId}\0${id}`
          if (event.state === 'running' && typeof event.payload.text === 'string' && event.payload.text) {
            latest.set(key, event)
          } else {
            latest.delete(key)
          }
        }
      }
    } catch {
      return []
    }
    return [...latest.values()]
  }

  /** Keep local requests, accepted answers and Nika routing notices across native replay and rotation. */
  loadReplayCheckpoints(sessionId: string): UAEvent[] {
    if (!this.root) return []
    const latest = new Map<string, UAEvent>()
    for (const suffix of ['.1', '']) {
      const file = join(this.root, `${safeSessionId(sessionId)}.jsonl${suffix}`)
      if (!existsSync(file)) continue
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          let record: any
          try { record = JSON.parse(line) } catch { continue }
          const event: UAEvent | undefined = record?.kind === 'ua_event' && record.data?.channel === 'main'
            ? record.data.event : undefined
          if (!event || !Number.isFinite(event.ts)) continue
          const key = replayCheckpointKey(event)
          if (!key) continue
          const prior = latest.get(key)
          latest.set(key, {
            ...event,
            seq: prior?.seq ?? event.seq,
            ts: prior?.ts ?? event.ts,
            payload: { ...prior?.payload, ...event.payload },
          })
        }
      } catch { /* A missing diagnostic file must not prevent native replay. */ }
    }
    return [...latest.values()]
  }

  private serialize(sessionId: string, kind: string, data: unknown): string {
    const record = { ts: new Date().toISOString(), sessionId, kind, data }
    const full = safeJson(record)
    if (isReplyCheckpoint(kind, data) ||
      (kind === 'ua_event' && (data as any)?.channel === 'main' &&
        replayCheckpointKey((data as any)?.event))) return full
    if (Buffer.byteLength(full) <= this.maxEntryBytes) return full

    const dataJson = safeJson(data)
    let previewLength = Math.min(dataJson.length, this.maxEntryBytes)
    let bounded = ''
    do {
      const truncated = {
        ts: record.ts,
        sessionId,
        kind,
        truncated: true,
        originalBytes: Buffer.byteLength(full),
        data: { preview: dataJson.slice(0, previewLength) }
      }
      bounded = safeJson(truncated)
      previewLength = Math.max(0, previewLength - Math.max(1, Buffer.byteLength(bounded) - this.maxEntryBytes))
    } while (Buffer.byteLength(bounded) > this.maxEntryBytes && previewLength > 0)
    return bounded
  }
}

function replayCheckpointKey(event: UAEvent | undefined): string | undefined {
  if (event?.type === 'system_notice' && event.payload.kind === 'nika_auto' && typeof event.payload.id === 'string') return `nika-auto:${event.payload.id}`
  return event ? interactionRequestKey(event) : undefined
}

function isReplyCheckpoint(kind: string, data: unknown): boolean {
  const value = data as any
  return kind === 'ua_event' &&
    value?.channel === 'main' &&
    value.event?.type === 'agent_message' &&
    typeof value.event?.payload?.turnId === 'string'
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return JSON.stringify({ serializationError: true, value: String(value) })
  }
}
