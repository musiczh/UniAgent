import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function forkContextWork<T>(operation: 'read' | 'save' | 'write' | 'prepare' | 'finish' | 'measure' | 'catalog', input: unknown): Promise<T> {
  const packaged = new URL('./forkContextWorker.js', import.meta.url)
  const workerPath = existsSync(packaged) || import.meta.url.includes('.asar/') ? packaged : resolve('src/main/forkContextWorker.ts')
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { operation, input },
      ...(typeof workerPath === 'string' ? { execArgv: ['--experimental-strip-types'] } : {}) })
    let settled = false
    const finish = (error?: Error, result?: T): void => {
      if (settled) return
      settled = true; clearTimeout(timeout)
      error ? reject(error) : resolve(result!)
      void worker.terminate()
    }
    const timeout = setTimeout(() => finish(new Error('读取或保存历史资料超时，可重试导出')), 120_000)
    worker.once('message', value => finish(value.error ? new Error(value.error) : undefined, value.result))
    worker.once('error', error => finish(error))
    worker.once('exit', code => { if (!settled) finish(new Error(`历史资料后台任务提前退出（${code}）`)) })
  })
}
