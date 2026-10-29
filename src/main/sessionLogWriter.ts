import { parentPort, workerData } from 'node:worker_threads'
import { SessionLogStore } from './sessionLogStore'

const logs = new SessionLogStore(workerData.root, workerData.options)
type Entry = { sessionId: string; kind: string; data: any }
const pending = new Map<string, Entry>()
const lastWritten = new Map<string, number>()
const keyOf = (entry: Entry): string => `${entry.sessionId}\0${entry.data?.channel}\0${entry.data?.event?.payload?.turnId}\0${entry.data?.event?.payload?.id}`

function flush(sessionId?: string): void {
  for (const [key, entry] of pending) {
    if (sessionId && entry.sessionId !== sessionId) continue
    logs.append(entry.sessionId, entry.kind, entry.data)
    pending.delete(key)
    lastWritten.set(key, Date.now())
  }
  if (sessionId) for (const key of lastWritten.keys()) if (key.startsWith(`${sessionId}\0`)) lastWritten.delete(key)
}

setInterval(() => flush(), 1000).unref()
parentPort!.on('message', (entry: Entry & { flush?: number }) => {
  if (entry.flush) { flush(); parentPort!.postMessage(entry.flush); return }
  const event = entry.kind === 'ua_event' ? entry.data?.event : undefined
  if (event?.type === 'agent_message' && event.payload?.id && event.payload?.turnId) {
    const key = keyOf(entry)
    if (event.state === 'running' && Date.now() - (lastWritten.get(key) || 0) < 1000) {
      pending.set(key, entry)
      return
    }
    pending.delete(key)
    if (event.state === 'running') lastWritten.set(key, Date.now())
    else lastWritten.delete(key)
  }
  if (event?.type === 'turn_completed' || entry.kind === 'runner_done' || entry.kind === 'status_changed') flush(entry.sessionId)
  logs.append(entry.sessionId, entry.kind, entry.data)
})
