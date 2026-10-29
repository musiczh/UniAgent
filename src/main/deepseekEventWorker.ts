/** Self-contained worker entry: bundling its function keeps packaged and test workers identical. */
export async function deepseekEventWorker(): Promise<void> {
  const { parentPort, workerData } = await import('node:worker_threads')
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { createInterface } = await import('node:readline')
  type Event = import('../shared/types').UAEvent
  let tail = Promise.resolve()
  parentPort!.on('message', (request: { id: number; kind: string; sessionId?: string; events?: Event[] }) => {
    tail = tail.then(async () => {
      try {
        const { kind, sessionId, events = [] } = request
        if (sessionId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('invalid_session_id')
        const file = sessionId === undefined ? '' : join(workerData.directory, sessionId + '.jsonl')
        let result: Event[] | undefined
        if (kind === 'append' || kind === 'replace') {
          fs.mkdirSync(workerData.directory, { recursive: true, mode: 0o700 })
          const data = events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
          if (kind === 'append') fs.appendFileSync(file, data, { mode: 0o600 })
          else {
            const temporary = file + `.${process.pid}.tmp`
            try { fs.writeFileSync(temporary, data, { mode: 0o600 }); fs.renameSync(temporary, file) }
            catch (error) { fs.rmSync(temporary, { force: true }); throw error }
          }
        } else if (kind === 'delete') fs.rmSync(file, { force: true })
        else if (kind === 'load') {
          const latest = new Map<string, Event>()
          try {
            const input = fs.createReadStream(file, { encoding: 'utf8' })
            const lines = createInterface({ input, crlfDelay: Infinity })
            try {
              for await (const line of lines) {
                let event: Event
                try { event = JSON.parse(line) } catch { continue }
                if (!event || event.sessionId !== sessionId || !Number.isFinite(event.seq) || typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object') continue
                const id = typeof event.payload.id === 'string' ? event.payload.id : event.payload.requestId
                const key = id ? `${event.payload.turnId || ''}:${event.type}:${id}` : `seq:${event.seq}`
                const previous = latest.get(key)
                latest.set(key, previous ? { ...previous, ...event, payload: { ...previous.payload, ...event.payload } } : event)
              }
            } finally { lines.close(); input.destroy() }
          } catch (error: any) { if (error.code !== 'ENOENT') throw error }
          result = [...latest.values()].map(event => event.type === 'approval_request' && event.state === 'pending'
            ? { ...event, state: 'cancelled' as const, payload: { ...event.payload, resolved: true, interactionExpired: true } } : event).sort((a, b) => a.seq - b.seq)
        }
        parentPort!.postMessage({ id: request.id, result })
      } catch (error) {
        parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}
