import { parentPort, workerData } from 'node:worker_threads'
import { readForkContext, saveForkContext, writeForkTarget, appServerContextEstimate, appServerModelBudget } from './forkContext.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const { operation, input } = workerData
;(async () => {
  if (operation === 'catalog') { parentPort!.postMessage({ result: await appServerModelBudget(input) }); return }
  if (operation === 'prepare') {
    const context = await readForkContext({ ...input, archive: undefined })
    if (context.revision !== input.revision) throw new Error('临时分支已变化，不能复用原压缩凭据')
    const body = JSON.stringify(context)
    await writeFile(join(input.archive, 'prepared-context.json'), body, { mode: 0o600 })
    parentPort!.postMessage({ result: { hash: createHash('sha256').update(body).digest('hex'), needsHandoff: context.needsHandoff } })
    return
  }
  if (operation === 'finish') {
    const body = await readFile(join(input.archive, 'prepared-context.json'), 'utf8')
    if (createHash('sha256').update(body).digest('hex') !== input.hash) throw new Error('已保存的压缩上下文校验失败')
    await saveForkContext(input.archive, JSON.parse(body), input.handoff)
    const exported = await readFile(join(input.archive, 'context.json'))
    parentPort!.postMessage({ result: { hash: createHash('sha256').update(exported).digest('hex') } })
    return
  }
  if (operation === 'measure') {
    const raw = await readFile(join(input.archive, 'context.json'), 'utf8')
    if (!input.hash || createHash('sha256').update(raw).digest('hex') !== input.hash) throw new Error('导出的上下文校验失败，请重新导出')
    const body = JSON.parse(raw)
    parentPort!.postMessage({ result: input.model ? appServerContextEstimate(body.messages, input.model) : Buffer.byteLength(JSON.stringify(body.messages)) })
    return
  }
  const result = operation === 'read' ? await readForkContext(input)
    : operation === 'save' ? await saveForkContext(input.archive, input.context, input.handoff)
      : await writeForkTarget(input)
  if (operation === 'read' && input.summaryOnly) (result as any).messages = []
  parentPort!.postMessage({ result })
})().catch(error => parentPort!.postMessage({ error: error.message || String(error) }))
