import { parentPort, workerData } from 'node:worker_threads'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MonitorQueue } from './cloudMonitorQueue'
import { MonitorRecordFactory, type MonitorFeedback } from './cloudMonitorRecords'
import { MonitorTransport } from './cloudMonitorTransport'

const port = parentPort!
const queue = new MonitorQueue(join(workerData.root, 'cloud-monitor'))
let factory: MonitorRecordFactory
let transport: MonitorTransport
let stopped = false
let timer: ReturnType<typeof setTimeout> | undefined
let commands: Promise<unknown> = Promise.resolve()
let flight: Promise<void> | undefined

async function recoverFeedback(): Promise<void> {
  const before = queue.snapshot(), started = Date.now()
  let directories
  try { directories = await readdir(join(workerData.root, 'router', 'reviews'), { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await queue.scanned(started); return }; throw error }
  let complete = true
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^[\w-]{1,200}$/.test(directory.name)) continue
    const file = join(workerData.root, 'router', 'reviews', directory.name, 'review.json')
    try {
      const metadata = await stat(file)
      if (metadata.mtimeMs < before.feedbackScannedAt) continue
      if (metadata.size > 16 * 1024 * 1024) { complete = false; continue }
      const document = JSON.parse(await readFile(file, 'utf8'))
      if (document.schemaVersion !== 1 || !Array.isArray(document.feedbacks)) continue
      for (const row of document.feedbacks) {
        if (row.savedAt < before.enabledAt || row.savedAt < before.feedbackScannedAt) continue
        const record = factory.feedback({ requestId: row.requestId, attemptId: row.attemptId, savedAt: row.savedAt,
          revision: row.revision, matches: row.matches, reason: row.reason, actualAction: row.actual?.decision?.action, expectedKind: row.expected?.kind })
        if (record && !await queue.enqueue(record)) complete = false
      }
    } catch { complete = false }
  }
  if (complete) await queue.scanned(started)
}

function status(): void {
  const state = queue.snapshot()
  port.postMessage({ kind: 'status', queued: state.records.length, dropped: state.dropped, nextAttemptAt: state.nextAttemptAt, lastError: state.lastError })
}
function schedule(): void {
  if (!stopped) timer = setTimeout(() => {
    flight = (async () => { await recoverFeedback(); await queue.flush(rows => transport.upload(rows)); status() })()
      .catch(() => port.postMessage({ kind: 'status', lastError: 'monitor_storage_unavailable' }))
      .finally(schedule)
  }, workerData.intervalMs || 30_000)
}
const ready = (async () => {
  await queue.init(workerData.enabledAt)
  factory = new MonitorRecordFactory(workerData.appVersion, workerData.distribution, queue.snapshot().salt)
  transport = new MonitorTransport(workerData.config, queue)
  await recoverFeedback()
  status(); schedule()
})()
void ready.catch(() => { stopped = true; port.postMessage({ kind: 'unavailable' }); port.close() })

port.on('message', message => {
  commands = commands.then(async () => {
    await ready
    if (message.kind === 'close') {
      stopped = true
      if (timer) clearTimeout(timer)
      await flight
      await queue.drain()
      port.close(); return
    }
    if (stopped) return
    let record
    if (message.kind === 'diagnostic') record = factory.diagnostic(message.data)
    else if (message.kind === 'performance') record = factory.performance(message.code, message.data, message.at)
    else if (message.kind === 'feedback') record = factory.feedback(message.data as MonitorFeedback)
    const stored = record ? await queue.enqueue(record) : false
    port.postMessage({ kind: 'ack', id: message.id, stored })
    status()
  }).catch(() => { port.postMessage({ kind: 'ack', id: message.id, stored: false }) })
})
