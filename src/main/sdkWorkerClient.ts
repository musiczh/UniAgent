import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

/** The SDK is loaded only in a worker; SDK types never cross the public IPC bridge. */
export class SdkWorkerClient extends EventEmitter {
  private worker?: Worker
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private closing?: Promise<void>
  private childPid?: number
  private label: string
  private closeTimeoutMs: number
  private initialized = false
  private startupAbort = new AbortController()
  readonly ready: Promise<any>

  constructor(launch: { options: { env?: NodeJS.ProcessEnv }; initializeTimeoutMs?: number; closeTimeoutMs?: number }, label: string, workerName: string) {
    super()
    this.label = label
    this.closeTimeoutMs = launch.closeTimeoutMs ?? 5_000
    const packaged = new URL(`./${workerName}.js`, import.meta.url)
    const source = resolve(`src/main/${workerName}.ts`)
    const workerPath = existsSync(packaged) || import.meta.url.includes('.asar/') ? packaged : source
    if (typeof workerPath === 'string' && !existsSync(workerPath)) throw new Error(`${label} SDK 后台运行文件缺失，请重新安装 UniAgent`)
    this.ready = this.initialize(launch, workerPath)
    // Consumers may subscribe before awaiting ready; never leave a rejected startup unobserved.
    void this.ready.catch(error => { this.initialized = true; this.fail(error) })
  }

  private async initialize(launch: { options: { env?: NodeJS.ProcessEnv }; initializeTimeoutMs?: number }, workerPath: string | URL): Promise<any> {
    const deadline = Date.now() + (launch.initializeTimeoutMs ?? 30_000)
    const filename = typeof workerPath === 'string' ? workerPath : fileURLToPath(workerPath)
    while (!this.closed) {
      try {
        if (!existsSync(workerPath)) throw Object.assign(new Error(`${this.label} SDK 后台运行文件缺失，请重新安装 UniAgent`), { code: 'ENOENT', path: filename })
        this.startWorker(launch, workerPath)
        const result = await this.request('initialize', undefined, Math.max(1, deadline - Date.now()))
        this.initialized = true
        return result
      } catch (error) {
        if (this.closed) throw error
        const missing = error as NodeJS.ErrnoException
        // Repacking a running bundle can briefly remove its path. Retry only
        // that startup failure, never a missing task file or an initialized turn.
        if (missing.code !== 'ENOENT' || !missing.path ||
          !(filename === missing.path || filename.startsWith(missing.path + sep)) || Date.now() >= deadline) throw error
        const worker = this.worker
        this.worker = undefined
        worker?.removeAllListeners()
        await worker?.terminate()
        if (this.closed || Date.now() >= deadline) throw error
        await delay(Math.min(100, deadline - Date.now()), undefined, { signal: this.startupAbort.signal })
      }
    }
    throw new Error(`${this.label} SDK 会话已关闭`)
  }

  private startWorker(launch: { options: { env?: NodeJS.ProcessEnv } }, workerPath: string | URL): void {
    const worker = this.worker = new Worker(workerPath, {
      workerData: launch,
      env: launch.options.env,
      ...(typeof workerPath === 'string' ? { execArgv: ['--experimental-strip-types'] } : {})
    })
    worker.on('message', message => {
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value)
      } else if (message.type === 'process') this.childPid = message.value
      else if (message.type === 'fatal') this.fail(new Error(message.error))
      else this.emit(message.type, message.value)
    })
    worker.on('error', error => this.fail(error))
    worker.on('exit', code => {
      if (!this.closed) this.fail(new Error(`${this.label} SDK 后台进程已退出（${code}）`))
    })
  }

  request(method: string, args?: any, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`${this.label} SDK 会话已关闭`))
    const worker = this.worker
    if (!worker) return Promise.reject(new Error(`${this.label} SDK 后台进程尚未就绪`))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label} SDK ${method} 超时`))
        if (method === 'initialize') void this.close()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, method, args })
    })
  }

  respond(requestId: string, response: unknown): void {
    if (!this.closed) this.worker?.postMessage({ method: 'respond', args: { requestId, response } })
  }

  processId(): number | undefined { return this.closed ? undefined : this.childPid }

  private fail(error: Error): void {
    if (this.closed) return
    if (!this.initialized) { this.rejectPending(error); return }
    this.emit('failure', error)
    void this.close(error)
  }

  close(reason = new Error(`${this.label} SDK 会话已关闭`)): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.startupAbort.abort()
    this.rejectPending(reason)
    const worker = this.worker
    this.closing = (worker ? new Promise<void>(resolveClose => {
      const timer = setTimeout(() => { void worker.terminate().then(() => resolveClose()) }, this.closeTimeoutMs)
      worker.once('exit', () => { clearTimeout(timer); resolveClose() })
      worker.postMessage({ method: 'close' })
    }) : Promise.resolve()).then(() => { this.emit('closed') })
    return this.closing
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason) }
    this.pending.clear()
  }
}
