import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { resolveUserDataHome } from '../userData'
import type { AssistantDatabase } from './database'

export type AssistantStore = { [K in keyof AssistantDatabase]: AssistantDatabase[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never }
export function createAssistantStore(path = join(resolveUserDataHome(), 'assistants', 'assistant.sqlite')): AssistantStore {
  const worker = new Worker(join(__dirname, 'assistantWorker.js'), { workerData: { path } })
  let sequence = 0, failed: Error | undefined, closing = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let resolveReady: () => void, rejectReady: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const fail = (error: Error) => { failed = error; rejectReady(error); for (const request of pending.values()) request.reject(error); pending.clear() }
  worker.on('error', fail)
  worker.on('exit', code => { if (!closing || code !== 0 || pending.size) fail(new Error('assistant_store_unavailable')) })
  worker.on('message', message => {
    if (message.ready) return resolveReady()
    if (message.fatal) return fail(new Error(message.fatal))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.value)
  })
  return new Proxy({} as AssistantStore, {
    get(_, method: string) {
      if (method === 'then') return undefined
      return async (...args: unknown[]) => {
        await ready
        if (failed) throw failed
        if (closing) throw new Error('assistant_store_closed')
        const id = ++sequence
        if (method === 'close') closing = true
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          try { worker.postMessage({ id, method, args }) } catch (error) { pending.delete(id); reject(error) }
        })
      }
    }
  })
}
