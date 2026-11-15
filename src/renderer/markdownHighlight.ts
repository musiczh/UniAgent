import { code, type HighlightOptions, type HighlightResult } from '@streamdown/code'
import workerUrl from 'virtual:uniagent-markdown-worker-url'

let worker: Worker | undefined
let nextId = 0
let cacheSize = 0
const cache = new Map<string, HighlightResult>()
const pending = new Map<string, { id: number; callbacks: Array<(result: HighlightResult) => void> }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(workerUrl)
  worker.onmessage = ({ data }: MessageEvent<{ id: number; result: HighlightResult }>) => {
    for (const [key, request] of pending) {
      if (request.id !== data.id) continue
      pending.delete(key)
      if (key.length <= 200_000) {
        cache.set(key, data.result)
        cacheSize += key.length
        while (cacheSize > 256_000 || cache.size > 32) {
          const oldest = cache.keys().next().value!
          cache.delete(oldest)
          cacheSize -= oldest.length
        }
      }
      request.callbacks.forEach(callback => callback(data.result))
      break
    }
  }
  worker.onerror = () => {
    worker?.terminate()
    worker = undefined
    pending.clear()
  }
  return worker
}

/** The official plugin's language registry, with expensive highlighting isolated in a worker. */
export const markdownCode = {
  ...code,
  highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void): HighlightResult | null {
    if (typeof Worker === 'undefined' || options.code.length > 200_000) return null
    const key = JSON.stringify([options.language, options.themes, options.code])
    const existing = cache.get(key)
    if (existing) return existing
    const active = pending.get(key)
    if (active) { if (callback) active.callbacks.push(callback); return null }
    const id = ++nextId
    pending.set(key, { id, callbacks: callback ? [callback] : [] })
    try { getWorker().postMessage({ id, options }) }
    catch { pending.delete(key) }
    return null
  },
}
