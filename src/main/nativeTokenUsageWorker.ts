import { parentPort } from 'node:worker_threads'
import { getNativeTokenUsage, refreshNativeTokenUsage } from './nativeTokenUsage'

// Serialize requests so a refresh cannot race an in-flight cache update.
let pending = Promise.resolve()
parentPort!.on('message', ({ id, value, refresh }) => {
  pending = pending.then(async () => {
    if (refresh) refreshNativeTokenUsage()
    const result = await getNativeTokenUsage(value)
    parentPort!.postMessage({ id, result })
  })
})
