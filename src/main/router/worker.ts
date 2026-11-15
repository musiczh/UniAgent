import { parentPort, workerData } from 'node:worker_threads'
import { RouterDatabase } from './database'
import { routerError } from './errors'

let database: RouterDatabase
try { database = new RouterDatabase(workerData.path, workerData.tokenizerDirectory); parentPort!.postMessage({ ready: true }) }
catch (error) { parentPort!.postMessage({ fatal: String(error) }); throw error }
const methods = new Set(['sessionId','sessionNotice','replaceSession','request','replaceFeishuCard','register','update','requests','feishuTopic','pending','index','object','catalog','taskBriefs','detail','descriptionJobs','descriptionAttempt','saveDescription','routingChunks','memoryPage','recordToolFailure','memories','writeMemory','memoryItem','manifest','enqueueMemory','memoryJobs','updateMemoryJob','reviewList','reviewDeletion','reviewDelete','reviewDetail','reviewSave','reviewBegin','reviewStep','reviewLinkLegacy','reviewFinish','reviewDismiss','reviewPrompts','reviewExport','reviewRecover','close'])
let tail = Promise.resolve()
methods.add('conversationSessions')
methods.add('draftImages')
methods.add('memoryHistory')
methods.add('memoryReferences')
parentPort!.on('message', ({ id, method, args }) => {
  tail = tail.then(async () => {
    try {
      if (!methods.has(method)) throw new Error('invalid_router_store_method')
      const value = await (database[method as keyof RouterDatabase] as (...args: any[]) => unknown).apply(database,args)
      parentPort!.postMessage({ id, value })
      if (method === 'close') parentPort!.close()
    } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error), errorDetails: routerError(error) }) }
  })
})
