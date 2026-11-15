import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The SDK is loaded only in a worker; SDK types never cross the public IPC bridge. */
export class SdkWorkerClient extends EventEmitter {
  private worker: Worker
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private closing?: Promise<void>
  private childPid?: number
  private label: string
  private closeTimeoutMs: number
  readonly ready: Promise<any>

  constructor(launch: { options: { env?: NodeJS.ProcessEnv }; initializeTimeoutMs?: number; closeTimeoutMs?: number }, label: string, workerName: string) {
    super()
    this.label = label
    this.closeTimeoutMs = launch.closeTimeoutMs ?? 5_000
    const packaged = new URL(`./${workerName}.js`, import.meta.url)
    const source = resolve(`src/main/${workerName}.ts`)
    const workerPath = existsSync(packaged) || import.meta.url.includes('.asar/') ? packaged : source
    if (!existsSync(workerPath)) throw new Error(`${label} SDK 后台运行文件缺失，请重新安装 UniAgent`)
    this.worker = new Worker(workerPath, {
      workerData: launch,
      env: launch.options.env,
      ...(typeof workerPath === 'string' ? { execArgv: ['--experimental-strip-types'] } : {})
    })
    this.ready = this.request('initialize', undefined, launch.initializeTimeoutMs ?? 30_000)
    // Consumers may subscribe before awaiting ready; never leave a rejected startup unobserved.
    void this.ready.catch(() => {})
    this.worker.on('message', message => {
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
    this.worker.on('error', error => this.fail(error))
    this.worker.on('exit', code => {
      if (!this.closed) this.fail(new Error(`${this.label} SDK 后台进程已退出（${code}）`))
    })
  }

  request(method: string, args?: any, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`${this.label} SDK 会话已关闭`))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label} SDK ${method} 超时`))
        if (method === 'initialize') void this.close()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, method, args })
    })
  }

  respond(requestId: string, response: unknown): void {
    if (!this.closed) this.worker.postMessage({ method: 'respond', args: { requestId, response } })
  }

  processId(): number | undefined { return this.closed ? undefined : this.childPid }

  private fail(error: Error): void {
    if (this.closed) return
    this.emit('failure', error)
    void this.close(error)
  }

  close(reason = new Error(`${this.label} SDK 会话已关闭`)): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason) }
    this.pending.clear()
    const worker = this.worker
    this.closing = new Promise<void>(resolveClose => {
      const timer = setTimeout(() => { void worker.terminate().then(() => resolveClose()) }, this.closeTimeoutMs)
      worker.once('exit', () => { clearTimeout(timer); resolveClose() })
      worker.postMessage({ method: 'close' })
    }).then(() => { this.emit('closed') })
    return this.closing
  }
}
