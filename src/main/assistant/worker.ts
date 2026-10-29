import { parentPort, workerData } from 'node:worker_threads'
import { AssistantDatabase } from './database'

let database: AssistantDatabase
try {
  database = new AssistantDatabase(workerData.path)
  parentPort!.postMessage({ ready: true })
} catch (error) {
  parentPort!.postMessage({ fatal: `assistant_store_unavailable: ${String(error)}` })
  throw error
}
const methods = new Set(['detail','save','versions','rollback','memory','transcript','search','lastSeq','markCompacted','truncate','removeSession','generation','invalidate','invalidateAndForgetPast','jobs','job','enqueue','setReviewState','commitReview','reviewTranscript','close'])
parentPort!.on('message', ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw new Error('invalid_store_method')
    const value = (database[method as keyof AssistantDatabase] as (...args: any[]) => unknown).apply(database, args)
    parentPort!.postMessage({ id, value })
    if (method === 'close') parentPort!.close()
  } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
})
