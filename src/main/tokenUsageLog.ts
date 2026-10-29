import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Diagnostic trail for the Token panel. The source/date/profile relationships
 * here are hard to reconstruct from a screenshot alone, so every query, cache
 * decision and fetched profile is appended as one JSONL line. The file sits next
 * to the token cache, is size-capped, and never contains credentials.
 */
const LOG_PATH = process.env.UNIAGENT_TOKEN_LOG_PATH ||
  join(homedir(), '.uniagent-public', 'token-usage.log')
const MAX_BYTES = 8 * 1024 * 1024
const MAX_LINE_CHARS = 16_000
const MAX_STRING_CHARS = 4_000
const MAX_ARRAY_ITEMS = 200
const SECRET_KEY = /^(?:token|access_?token|refresh_?token|jwt|secret|password|authorization|api[_-]?key|cookie)$/i

function sanitize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value
  }
  if (depth >= 4) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1)
    }
    return out
  }
  return String(value)
}

let queue: Promise<void> = Promise.resolve()

export function tokenUsageLogPath(): string {
  return LOG_PATH
}

/** Fire-and-forget; a diagnostics failure must never break the panel. */
export function logTokenUsage(scope: string, event: string, data?: unknown): void {
  let line: string
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      scope,
      event,
      ...(data === undefined ? {} : { data: sanitize(data) })
    })
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), scope, event, data: '[unserializable]' })
  }
  if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…`
  const entry = `${line}\n`
  queue = queue.then(async () => {
    try {
      await mkdir(dirname(LOG_PATH), { recursive: true })
      try {
        const info = await stat(LOG_PATH)
        if (info.size > MAX_BYTES) await rename(LOG_PATH, `${LOG_PATH}.1`).catch(() => undefined)
      } catch {
        /* first write */
      }
      await appendFile(LOG_PATH, entry, 'utf8')
    } catch {
      /* best effort */
    }
  })
}

/** Await pending appends (tests and clean shutdown). */
export function flushTokenUsageLog(): Promise<void> {
  return queue
}
