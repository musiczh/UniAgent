import { Worker } from 'node:worker_threads'

/**
 * A different provider cannot reuse the old tokenizer's count for images or
 * encrypted items. Bound the active serialized history by one token per byte;
 * this is a conservative switching budget, never a reported token usage.
 * Parsing large image-bearing rollouts stays off Electron's main thread.
 */
export function codexContextHistoryBudget(file: string): Promise<{ tokens: number; opaqueCompaction: boolean } | undefined> {
  return new Promise(resolve => {
    const worker = new Worker(String.raw`
      const { parentPort, workerData } = require('node:worker_threads')
      const { createReadStream } = require('node:fs')
      const { createInterface } = require('node:readline')
      ;(async () => {
        let base = 0, bytes = 0, seen = false, valid = true, opaqueCompaction = false
        const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
        const opaque = value => {
          const item = value?.item || value
          return ['compaction', 'context_compaction'].includes(item?.type) && !!item.encrypted_content
        }
        for await (const line of createInterface({ input: createReadStream(workerData), crlfDelay: Infinity })) {
          if (!line.trim()) continue
          let row
          try { row = JSON.parse(line) } catch { valid = false; continue }
          const payload = row.payload
          if (row.type === 'session_meta') base = size(payload?.base_instructions || '')
          if (row.type === 'response_item') {
            if (!payload || typeof payload !== 'object') { valid = false; continue }
            bytes += size(payload)
            opaqueCompaction ||= opaque(payload)
            seen = true
          } else if (row.type === 'compacted') {
            if (!Array.isArray(payload?.replacement_history)) { valid = false; continue }
            bytes = payload.replacement_history.reduce((sum, item) => sum + size(item), 0)
            opaqueCompaction = payload.replacement_history.some(opaque)
            seen = true
            valid = true
          } else if (row.type === 'event_msg' && payload?.type === 'thread_rolled_back') {
            // Native rollback can cross a compaction boundary. Let native
            // compaction rebuild it rather than undercounting a partial replay.
            valid = false
          }
        }
        parentPort.postMessage(valid && seen ? { tokens: base + bytes, opaqueCompaction } : null)
      })().catch(() => parentPort.postMessage(null))
    `, { eval: true, workerData: file })
    let settled = false
    const finish = (value?: { tokens: number; opaqueCompaction: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
      void worker.terminate()
    }
    const timeout = setTimeout(() => finish(), 10_000)
    worker.once('message', value => finish(typeof value?.tokens === 'number' && Number.isFinite(value.tokens) ? value : undefined))
    worker.once('error', () => finish())
    worker.once('exit', () => finish())
  })
}
