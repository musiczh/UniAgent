import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { startTokenSpeedTelemetry, type TokenSpeedTelemetry } from './tokenSpeedTelemetry'

export interface AppServerRpcClientOptions {
  bin: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  tokenSpeed?: 'codex' | 'traex'
}

export interface AppServerRpc extends EventEmitter {
  start(): Promise<void>
  request<T>(method: string, params: unknown): Promise<T>
  requestSequenced?<T>(method: string, params: unknown): Promise<SequencedRpcResult<T>>
  notify(method: string, params: unknown): void
  respond(id: number | string, result: unknown): void
  interrupt(): void
  dispose(waitForThreadClose?: boolean): Promise<void>
  processId?(): number | undefined
  claimThread?(threadId: string): void
}

export interface SequencedRpcResult<T> {
  result: T
  sequence: number
}

export type AppServerRpcFactory = (options: AppServerRpcClientOptions) => AppServerRpc

/** One process and initialization handshake, with separately owned thread connections. */
export class SharedAppServerRpc {
  private clients = new Set<AppServerThreadRpc>()
  private primary?: AppServerThreadRpc
  private owners = new Map<string, AppServerThreadRpc | null>()
  private transport?: AppServerRpc
  private options?: AppServerRpcClientOptions
  private starting?: Promise<void>
  private initializing?: Promise<SequencedRpcResult<unknown>>
  private initialized = false
  private closing: Promise<void> = Promise.resolve()
  private sequence = 0

  constructor(private readonly factory: AppServerRpcFactory) {}

  acquire(options?: AppServerRpcClientOptions): AppServerRpc {
    const client = new AppServerThreadRpc(this, options)
    this.clients.add(client)
    if (options || !this.primary) this.primary = client
    return client
  }

  claim(client: AppServerThreadRpc, threadId: string): void {
    this.owners.set(threadId, client)
  }

  async start(options?: AppServerRpcClientOptions): Promise<void> {
    await this.closing
    if (this.starting) return this.starting
    this.options = options || this.options
    if (!this.options) throw new Error('共享 app-server 尚未启动')
    const transport = this.factory(this.options)
    this.transport = transport
    this.sequence = 0
    transport.on('notification', (method: string, params: any, sequence?: number) => {
      if (this.transport !== transport) return
      if (sequence !== undefined) this.sequence = sequence
      const threadId = params?.threadId || params?.thread?.id
      if (method === 'thread/started' && threadId && !this.owners.has(threadId)) {
        const source = params?.thread?.source?.subAgent?.thread_spawn
        const parentId = source?.parent_thread_id || params?.thread?.forkedFromId
        const parent = parentId && this.owners.get(parentId)
        if (parent) this.owners.set(threadId, parent)
      }
      if (!threadId) {
        for (const client of this.clients) client.emit('notification', method, params, sequence)
      } else {
        this.owner(threadId)?.emit('notification', method, params, sequence)
      }
    })
    transport.on('serverRequest', (message: any) => {
      if (this.transport !== transport) return
      this.owner(message.params?.threadId)?.emit('serverRequest', message)
    })
    transport.on('message', (message: any, sequence?: number) => {
      if (this.transport !== transport) return
      if (sequence !== undefined) this.sequence = sequence
      this.primary?.emit('message', message, sequence)
    })
    transport.on('disconnect', (message?: string) => {
      if (this.transport !== transport) return
      this.transport = undefined
      this.starting = undefined
      this.initializing = undefined
      this.initialized = false
      this.owners.clear()
      const clients = [...this.clients]
      this.clients.clear()
      this.primary = undefined
      for (const client of clients) client.disconnected(message)
    })
    this.starting = transport.start()
    return this.starting
  }

  async request<T>(method: string, params: unknown): Promise<SequencedRpcResult<T>> {
    const transport = this.transport
    if (!transport) throw new Error('app-server 未连接')
    const request = (): Promise<SequencedRpcResult<T>> => transport.requestSequenced
      ? transport.requestSequenced<T>(method, params)
      : transport.request<T>(method, params).then(result => ({ result, sequence: this.sequence }))
    if (method !== 'initialize') return request()
    this.initializing ||= request().catch(error => {
      this.initializing = undefined
      throw error
    })
    return this.initializing as Promise<SequencedRpcResult<T>>
  }

  notify(method: string, params: unknown): void {
    if (method === 'initialized') {
      if (this.initialized) return
      this.initialized = true
    }
    this.transport?.notify(method, params)
  }

  respond(id: number | string, result: unknown): void {
    this.transport?.respond(id, result)
  }

  processId(): number | undefined {
    return this.transport?.processId?.()
  }

  private owner(threadId?: string): AppServerThreadRpc | undefined {
    if (threadId && this.owners.has(threadId)) return this.owners.get(threadId) || undefined
    return this.primary
  }

  async release(client: AppServerThreadRpc, waitForThreadClose = false): Promise<void> {
    if (!this.clients.delete(client)) return
    if (this.primary === client) this.primary = this.clients.values().next().value
    const transport = this.transport
    const threadIds = [...this.owners].filter(([, owner]) => owner === client).map(([id]) => id)
    for (const threadId of threadIds) this.owners.set(threadId, null)
    if (this.clients.size) {
      await Promise.all(threadIds.map(async threadId => {
        if (this.owners.get(threadId) !== null) return
        if (!transport) return
        if (!waitForThreadClose) {
          await transport.request('thread/unsubscribe', { threadId }).catch(() => {})
          return
        }
        let complete!: () => void
        const closed = new Promise<void>(resolve => { complete = resolve })
        const onClosed = (method: string, params: any): void => {
          if (method === 'thread/closed' && params?.threadId === threadId) complete()
        }
        transport.on('notification', onClosed)
        transport.once('disconnect', complete)
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await transport.request<{ status?: string }>('thread/unsubscribe', { threadId })
          if (result?.status === 'unsubscribed') {
            await Promise.race([closed, new Promise<void>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('等待 Codex 释放原会话超时')), 10_000)
            })])
          }
        } finally {
          if (timeout) clearTimeout(timeout)
          transport.off('notification', onClosed)
          transport.off('disconnect', complete)
        }
      }))
      return
    }
    this.transport = undefined
    this.starting = undefined
    this.initializing = undefined
    this.initialized = false
    this.owners.clear()
    this.closing = this.closing.then(() => transport?.dispose()).then(() => {}, () => {})
    await this.closing
  }
}

class AppServerThreadRpc extends EventEmitter implements AppServerRpc {
  private disposed = false
  private pending = new Set<(error: Error) => void>()

  constructor(private readonly shared: SharedAppServerRpc, private readonly options?: AppServerRpcClientOptions) {
    super()
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('app-server 已关闭')
    await this.shared.start(this.options)
    if (this.disposed) throw new Error('app-server 已关闭')
  }

  claimThread(threadId: string): void {
    if (!this.disposed) this.shared.claim(this, threadId)
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    return (await this.requestSequenced<T>(method, params)).result
  }

  requestSequenced<T>(method: string, params: unknown): Promise<SequencedRpcResult<T>> {
    if (this.disposed) return Promise.reject(new Error('app-server 已关闭'))
    if (method === 'thread/resume') this.claimThread((params as { threadId: string }).threadId)
    return new Promise((resolve, reject) => {
      this.pending.add(reject)
      this.shared.request<T>(method, params).then(response => {
        if (!this.disposed && (method === 'thread/start' || method === 'thread/fork' || method === 'thread/resume')) {
          const threadId = (response.result as { thread?: { id?: string } })?.thread?.id
          if (threadId) this.claimThread(threadId)
        }
        resolve(response)
      }, reject).finally(() => this.pending.delete(reject))
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.disposed) this.shared.notify(method, params)
  }

  respond(id: number | string, result: unknown): void {
    if (!this.disposed) this.shared.respond(id, result)
  }

  interrupt(): void {
    // Interrupting a connection must never signal another thread's process.
  }

  processId(): number | undefined {
    return this.shared.processId()
  }

  disconnected(message?: string): void {
    this.disposed = true
    for (const reject of this.pending) reject(new Error(message || 'app-server 连接已断开'))
    this.pending.clear()
    this.emit('disconnect', message)
    this.removeAllListeners()
  }

  async dispose(waitForThreadClose = false): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const reject of this.pending) reject(new Error('app-server 已关闭'))
    this.pending.clear()
    this.removeAllListeners()
    await this.shared.release(this, waitForThreadClose)
  }
}

type PendingRequest = {
  resolve: (value: SequencedRpcResult<unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** JSONL transport shared by Codex and TraeX app-server adapters. */
export class AppServerRpcClient extends EventEmitter implements AppServerRpc {
  private tokenSpeed?: TokenSpeedTelemetry
  private child?: ChildProcessWithoutNullStreams
  private disposed = false
  private buffer = ''
  private nextId = 1
  private stderrTail = ''
  private pending = new Map<number, PendingRequest>()
  private wireSequence = 0
  private starting?: Promise<void>

  constructor(private readonly options: AppServerRpcClientOptions) {
    super()
  }

  processId(): number | undefined {
    return this.child?.pid
  }

  async start(): Promise<void> {
    if (this.child) return
    this.starting ||= this.startProcess().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async startProcess(): Promise<void> {
    this.disposed = false
    this.buffer = ''
    this.wireSequence = 0
    const tokenSpeed = this.options.tokenSpeed && await startTokenSpeedTelemetry(this.options.tokenSpeed,
      sample => this.emit('notification', 'uniagent/tokenSpeed', sample), this.options.env || process.env)
    if (this.disposed) { await tokenSpeed?.close(); return }
    this.tokenSpeed = tokenSpeed || undefined
    const child = spawn(this.options.bin, [...this.options.args, ...(tokenSpeed?.args || [])], {
      cwd: this.options.cwd,
      env: { ...(this.options.env || process.env), ...tokenSpeed?.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onChunk(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
      this.emit('stderr', chunk)
    })
    child.on('error', (error) => this.disconnect(new Error(`进程启动失败: ${error.message}`)))
    child.on('close', (code) => {
      void tokenSpeed?.close()
      const error = code && code !== 0
        ? new Error(`app-server 退出，code=${code}${this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : ''}`)
        : undefined
      this.disconnect(error)
    })
  }

  request<T>(method: string, params: unknown): Promise<T> {
    return this.requestSequenced<T>(method, params).then(({ result }) => result)
  }

  requestSequenced<T>(method: string, params: unknown): Promise<SequencedRpcResult<T>> {
    if (!this.child) return Promise.reject(new Error('app-server 未连接'))
    const id = this.nextId++
    return new Promise<SequencedRpcResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, this.options.timeoutMs || 60_000)
      this.pending.set(id, {
        resolve: resolve as (value: SequencedRpcResult<unknown>) => void,
        reject,
        timer
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  interrupt(): void {
    try {
      this.child?.kill('SIGINT')
    } catch {
      /* ignore */
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    if (!child) { await this.starting?.catch(() => {}); await this.tokenSpeed?.close(); return }
    this.disconnect(new Error('app-server 已关闭'))
    const closed = once(child, 'close')
    let killTimer: NodeJS.Timeout | undefined
    try {
      child.kill('SIGTERM')
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
            resolve()
          }, 1_000)
        })
      ])
    } finally {
      if (killTimer) clearTimeout(killTimer)
      this.child = undefined
    }
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim()) {
        try {
          this.onMessage(JSON.parse(line))
        } catch {
          /* ignore non-JSON banner lines */
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private onMessage(message: any): void {
    const sequence = ++this.wireSequence
    if (message.method === 'turn/completed' && typeof message.params?.threadId === 'string') {
      this.tokenSpeed?.endTurn(message.params.threadId)
    }
    this.emit('message', message, sequence)
    if (message.method) {
      if (message.id === undefined) {
        this.emit('notification', message.method, message.params || {}, sequence)
      }
      else this.emit('serverRequest', message)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(Object.assign(new Error(extractErrorMessage(message.error)), {
      code: message.error.code, deliveryState: 'failed'
    }))
    else pending.resolve({ result: message.result, sequence })
  }

  private write(message: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* ignore */
    }
  }

  private disconnect(error?: Error): void {
    this.child = undefined
    const disconnectError = error || new Error('app-server 连接已断开')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(disconnectError)
    }
    this.pending.clear()
    if (!this.disposed) this.emit('disconnect', error?.message)
  }
}

function extractErrorMessage(error: any): string {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const raw = error.message || error.error?.message || error.reason
  if (raw) return raw
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
