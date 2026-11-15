import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { RouterDatabase } from './database'
import { RouterToolError } from './errors'

export type RouterStore = { [K in keyof RouterDatabase]: RouterDatabase[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never }
export function createRouterStore(path: string, tokenizerDirectory?: string): RouterStore {
  const worker = new Worker(join(__dirname,'routerWorker.js'), { workerData: { path, tokenizerDirectory } })
  let id = 0, failure: Error | undefined, closing = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let resolveReady: () => void, rejectReady: (error: Error) => void
  const ready = new Promise<void>((resolve,reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const fail = (error: Error) => { failure = error; rejectReady(error); for (const entry of pending.values()) entry.reject(error); pending.clear() }
  worker.on('error',fail)
  worker.on('exit',code => { if (!closing || code || pending.size) fail(new Error('router_store_unavailable')) })
  worker.on('message',message => {
    if (message.ready) return resolveReady()
    if (message.fatal) return fail(new Error(message.fatal))
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(message.errorDetails ? new RouterToolError(message.errorDetails) : new Error(message.error)) : entry.resolve(message.value)
  })
  return new Proxy({} as RouterStore, { get(_,method: string) {
    if (method === 'then') return undefined
    return async (...args: unknown[]) => {
      await ready
      if (failure) throw failure
      if (closing) throw new Error('router_store_closed')
      const requestId = ++id
      if (method === 'close') closing = true
      return new Promise((resolve,reject) => {
        pending.set(requestId,{resolve,reject})
        try { worker.postMessage({ id: requestId, method, args }) } catch (error) { pending.delete(requestId); reject(error) }
      })
    }
  } })
}
