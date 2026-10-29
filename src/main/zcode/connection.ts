import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isId, isRecord, scrubZCodeDiagnostic, ZCODE_LIMITS } from './protocol'
import type { ZCodeAssembledFrame } from './protocol'
import { ZCodeWireAssembler } from './wireAssembler'

interface ConnectionOptions { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }
interface Pending { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class ZCodeRpcError extends Error {
  constructor(public code: number, message: string) { super(scrubZCodeDiagnostic(message)); this.name = 'ZCodeRpcError' }
}

export class ZCodeConnection extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private assembler = new ZCodeWireAssembler()
  private bound = new Set<string>()
  private frames: ZCodeAssembledFrame[] = []
  private counter = 0
  private frameBytes = 0
  private buffered = ''
  private decoder = new StringDecoder('utf8')
  private failure?: Error
  private closing = false
  private exited = false
  private closePromise?: Promise<void>
  private expiryTimer?: ReturnType<typeof setInterval>
  private startPromise?: Promise<void>
  private exitPromise?: Promise<void>
  private ready?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  private diagnostic = ''
  constructor(private options: ConnectionOptions) { super() }
  get connected(): boolean { return !!this.child && !this.failure && !this.closing && !this.exited }
  get stderrTail(): string { return this.diagnostic }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise((resolve, reject) => {
      this.ready = { resolve, reject, timer: setTimeout(() => this.fail(new Error('ZCode storage startup timed out')), this.options.timeoutMs ?? 30_000) }
      try {
        this.child = spawn(this.options.executable, this.options.args, { cwd: this.options.cwd, env: this.options.env,
          shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
        this.exitPromise = new Promise(done => this.child!.once('close', (code, signal) => {
          this.exited = true
          if (this.expiryTimer) clearInterval(this.expiryTimer)
          this.fail(new Error('ZCode process exited'))
          this.emit('exit', { code, signal, expected: this.closing })
          done()
        }))
        this.child.stdout.on('data', bytes => this.receiveBytes(bytes))
        this.child.stdout.on('end', () => {
          if (!this.closing) this.fail(new Error(this.buffered.length ? 'ZCode truncated protocol line' : 'ZCode protocol EOF'))
        })
        this.child.stderr.on('data', bytes => { this.diagnostic = scrubZCodeDiagnostic(this.diagnostic + bytes.toString('utf8')).slice(-8192) })
        this.child.on('error', error => this.fail(error))
        this.child.stdin.on('error', error => { if (!this.closing) this.fail(error) })
        this.expiryTimer = setInterval(() => {
          for (const fault of this.assembler.expire()) this.emit('fault', fault)
        }, 1000)
        this.expiryTimer.unref()
      } catch (error) { this.fail(error instanceof Error ? error : new Error('ZCode spawn failed')) }
    })
    return this.startPromise
  }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    if (this.ready) { clearTimeout(this.ready.timer); this.ready.reject(error); this.ready = undefined }
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    if (!this.closing) this.emit('fault', { kind: 'fault', reason: scrubZCodeDiagnostic(error.message), fatal: true })
  }
  private receiveBytes(bytes: Buffer): void {
    if (this.failure) return
    try {
      this.buffered += this.decoder.write(bytes)
      let newline: number
      while ((newline = this.buffered.indexOf('\n')) !== -1) {
        const line = this.buffered.slice(0, newline).replace(/\r$/, '')
        this.buffered = this.buffered.slice(newline + 1)
        if (Buffer.byteLength(line) > ZCODE_LIMITS.line) throw new Error('ZCode protocol line exceeds limit')
        if (line.length) this.receive(JSON.parse(line))
      }
      if (Buffer.byteLength(this.buffered) > ZCODE_LIMITS.line) throw new Error('ZCode protocol line exceeds limit')
    } catch (error) { this.fail(error instanceof Error ? error : new Error('ZCode invalid NDJSON')) }
  }
  private receive(message: unknown): void {
    if (!isRecord(message)) throw new Error('ZCode invalid RPC envelope')
    const validRpcId = (id: unknown) => isId(id) || (typeof id === 'number' && Number.isSafeInteger(id))
    if (typeof message.method === 'string') {
      if (message.method.length > 256 || (message.id !== undefined && !validRpcId(message.id))) throw new Error('ZCode invalid RPC request')
      if (message.id !== undefined) {
        if (!this.emit('request', message.id, message.method, message.params)) this.respondError(message.id, { code: -32601, message: 'Host method unavailable' })
        return
      }
      if (message.method === 'startup/storageState' && isRecord(message.params)) {
        if (message.params.phase === 'ready' && this.ready) { clearTimeout(this.ready.timer); this.ready.resolve(); this.ready = undefined }
        if (message.params.phase === 'failed') this.fail(new Error(`ZCode storage failed: ${scrubZCodeDiagnostic(String(message.params.errorCode ?? 'unknown'))}`))
      }
      if (message.method === 'v4/conversation/frame') {
        for (const item of this.assembler.accept(message.params)) {
          if (item.kind === 'fault') this.emit('fault', item)
          else {
            if (!this.bound.has(this.route(item.frame.topic, item.frame.subscriptionId))) {
              this.frameBytes += Buffer.byteLength(JSON.stringify(item))
              if (this.frames.length >= 256 || this.frameBytes > ZCODE_LIMITS.staged) throw new Error('ZCode unclaimed frame budget exceeded')
              this.frames.push(item)
            }
            this.emit('frame', item)
          }
        }
      } else this.emit('notification', message.method, message.params)
      return
    }
    if (!validRpcId(message.id)) throw new Error('ZCode invalid RPC response ID')
    const pending = this.pending.get(String(message.id))
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(String(message.id))
    if (isRecord(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
      pending.reject(new ZCodeRpcError(message.error.code, message.error.message))
    } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
    else pending.reject(new Error('ZCode invalid RPC response'))
  }
  private write(value: unknown): void {
    if (!this.connected || !this.child) throw this.failure ?? new Error('ZCode connection is closed')
    const line = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(line) > ZCODE_LIMITS.line) throw new Error('ZCode outgoing RPC exceeds limit')
    this.child.stdin.write(line)
  }
  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = `ua-zcode-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ZCode RPC timed out: ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  respond(id: string | number, result: unknown): void { this.write({ id, result }) }
  respondError(id: string | number, error: { code: number; message: string }): void { this.write({ id, error }) }
  private route(topic: string, subscriptionId: string): string { return `${topic}\0${subscriptionId}` }
  // Subscribe may deliver its snapshot in the same stdout chunk as its ACK.
  drainFrames(topic: string, subscriptionId: string): ZCodeAssembledFrame[] {
    this.bound.add(this.route(topic, subscriptionId))
    const result = this.frames.filter(item => item.frame.topic === topic && item.frame.subscriptionId === subscriptionId)
    this.frames = this.frames.filter(item => item.frame.topic !== topic || item.frame.subscriptionId !== subscriptionId)
    this.frameBytes = this.frames.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
    return result
  }
  forgetRoute(topic: string, subscriptionId: string): void {
    this.bound.delete(this.route(topic, subscriptionId)); this.assembler.forget(topic, subscriptionId)
    this.frames = this.frames.filter(item => item.frame.topic !== topic || item.frame.subscriptionId !== subscriptionId)
    this.frameBytes = this.frames.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
  }
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeOwnedProcess()
    return this.closePromise
  }
  private async closeOwnedProcess(): Promise<void> {
    this.closing = true
    if (this.expiryTimer) clearInterval(this.expiryTimer)
    this.fail(new Error('ZCode connection closed'))
    this.assembler.reset(); this.frames = []; this.bound.clear()
    if (!this.child || this.exited) return
    const wait = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([this.exitPromise!.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
      if (timer) clearTimeout(timer)
      return exited
    }
    this.child.stdin.end()
    if (await wait()) return
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) { this.child.kill(signal); if (await wait()) return }
    throw new Error('ZCode owned process cleanup timed out')
  }
}
