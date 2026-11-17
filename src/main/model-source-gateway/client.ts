import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { GatewayState } from './gateway'
import type { ModelSourceQuota, QuotaProviderId, QuotaQueryContext } from '../../shared/modelSourceQuota'

export class ModelGatewayClient {
  private child?: ChildProcess
  port = 0
  constructor(private changed: (running: boolean) => void = () => {}) {}
  private call<T>(input: Record<string, unknown>): Promise<T> {
    if (!this.child) {
      const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'modelSourceGateway.js')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
      this.child = child
      child.on('error', () => {})
      child.once('exit', () => { if (this.child === child) { this.child = undefined; if (this.port) this.changed(false) } })
    }
    const child = this.child, id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: Error, value?: T) => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); error ? reject(error) : resolve(value!) }
      const failed = () => finish(new Error('模型网关不可用'))
      const receive = (message: any) => { if (message.id === id) finish(message.error ? new Error(message.error) : undefined, message.result ?? message.port) }
      const timer = setTimeout(() => finish(new Error('模型网关响应超时')), 10_000)
      child.on('message', receive); child.once('exit', failed); child.once('error', failed)
      child.send({ id, ...input }, error => { if (error) failed() })
    })
  }
  async update(state: GatewayState, port = this.port): Promise<number> {
    const actual = await this.call<number>({ port, state })
    this.port = actual; this.changed(true); return actual
  }
  queryQuota(preset: QuotaProviderId, baseUrl: string, apiKey: string, context?: QuotaQueryContext): Promise<ModelSourceQuota> { return this.call({ action: 'quota', preset, baseUrl, apiKey, context }) }
  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000); child.once('exit', () => { clearTimeout(timer); resolve() }); child.kill('SIGTERM') })
    if (this.port) this.changed(false)
  }
}
