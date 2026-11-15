export const MONITOR_MAX_RECORD_BYTES = 16 * 1024
export const MONITOR_MAX_BATCH_BYTES = 256 * 1024
export const MONITOR_MAX_BATCH_RECORDS = 50
export const MONITOR_MAX_QUEUE_BYTES = 10 * 1024 * 1024

export interface MonitorRecord {
  schemaVersion: 1
  eventId: string
  category: 'diagnostic' | 'performance' | 'router_feedback'
  occurredAt: number
  distribution: 'internal' | 'public'
  appVersion: string
  agentId: string
  code: string
  level: 'info' | 'warn' | 'error'
  payload: Record<string, string | number | boolean>
}

const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const key = /^[a-zA-Z0-9_.:-]{1,80}$/
const hash = /^[a-f0-9]{64}$/
const topKeys = new Set(['schemaVersion', 'eventId', 'category', 'occurredAt', 'distribution', 'appVersion', 'agentId', 'code', 'level', 'payload'])
const payloadKeys = {
  diagnostic: new Set(['message', 'source', 'count']),
  performance: new Set(['cpuPercent', 'rssBytes', 'heapBytes', 'mainHeartbeatAgeMs', 'eventLoopDelayMs', 'longestMs', 'totalMs', 'count', 'windowShownMs', 'uiReadyMs', 'initializedMs', 'durationMs']),
  router_feedback: new Set(['requestKey', 'attemptKey', 'revision', 'matches', 'reason', 'actualAction', 'expectedKind'])
}
const actions = new Set(['reuse_task', 'create_task_in_requirement', 'create_task_in_space', 'create_requirement_and_task', 'clarify', 'unknown'])
const expectedKinds = new Set(['create_task', 'reuse_task', 'create_requirement'])

export function monitorBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length }

export function redactMonitorText(text: string, maxLength = 2000): string {
  return text.slice(0, 24_000)
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]+|github_pat_[\w]+|sb_(?:secret|publishable)_[\w-]+|eyJ[\w-]{12,}\.[\w-]+\.[\w-]+)/g, '[redacted]')
    .replace(/\b(authorization|cookie|set-cookie|(?:access[_-]?|refresh[_-]?)?token|app[_-]?secret|api[_-]?key|password|passwd)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b[A-Z]:[\\/][^\s<>"']+|(?:~\/|\/(?:Users|home|private|tmp|var|Volumes|Applications|opt|usr|etc|workspace|workspaces)\/)[^\s<>"']+/g, '[path]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .slice(0, maxLength)
}

export function validateMonitorRecord(value: unknown, now = Date.now()): value is MonitorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as MonitorRecord
  if (Object.keys(row).some(name => !topKeys.has(name)) || row.schemaVersion !== 1 || !id.test(row.eventId || '') ||
    !['diagnostic', 'performance', 'router_feedback'].includes(row.category) || !['internal', 'public'].includes(row.distribution) ||
    !Number.isSafeInteger(row.occurredAt) || row.occurredAt < Date.UTC(2020, 0, 1) || row.occurredAt > now + 300_000 ||
    typeof row.appVersion !== 'string' || !/^[\w.+-]{1,64}$/.test(row.appVersion) || typeof row.agentId !== 'string' || !key.test(row.agentId) || typeof row.code !== 'string' || !key.test(row.code) ||
    !['info', 'warn', 'error'].includes(row.level) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return false
  if ([row.appVersion, row.agentId, row.code].some(value => redactMonitorText(value) !== value)) return false
  for (const [name, item] of Object.entries(row.payload)) {
    if (!payloadKeys[row.category].has(name)) return false
    if (typeof item === 'number') { if (!Number.isFinite(item) || item < 0 || item > 1024 ** 5) return false }
    else if (typeof item === 'string') { if (item.length > 2000 || redactMonitorText(item) !== item) return false }
    else if (typeof item !== 'boolean') return false
  }
  if (row.category === 'diagnostic' && (typeof row.payload.message !== 'string' || typeof row.payload.source !== 'string' || !Number.isSafeInteger(row.payload.count) || Number(row.payload.count) < 1)) return false
  if (row.category === 'performance' && (Object.keys(row.payload).length === 0 || Object.values(row.payload).some(item => typeof item !== 'number'))) return false
  if (row.category === 'router_feedback' && (!hash.test(String(row.payload.requestKey)) || !hash.test(String(row.payload.attemptKey)) ||
    !Number.isSafeInteger(row.payload.revision) || Number(row.payload.revision) < 1 || Number(row.payload.revision) > 2147483647 || typeof row.payload.matches !== 'boolean' ||
    typeof row.payload.actualAction !== 'string' || !actions.has(row.payload.actualAction) ||
    row.payload.expectedKind !== undefined && (typeof row.payload.expectedKind !== 'string' || !expectedKinds.has(row.payload.expectedKind)) ||
    row.payload.reason !== undefined && typeof row.payload.reason !== 'string')) return false
  return monitorBytes(row) <= MONITOR_MAX_RECORD_BYTES
}

export function monitorMachineKey(value: unknown, fallback: string): string { return typeof value === 'string' && key.test(value) && redactMonitorText(value) === value ? value : fallback }

export function monitorPerformancePayload(data: Record<string, any>): MonitorRecord['payload'] {
  const candidates = {
    cpuPercent: data.tree?.cpuPercent ?? data.cpuPercent, rssBytes: data.tree?.rssSumBytes ?? data.rssBytes,
    heapBytes: data.main?.heapBytes ?? data.heapBytes, mainHeartbeatAgeMs: data.mainHeartbeatAgeMs,
    eventLoopDelayMs: data.main?.maxDelayMs ?? data.maxDelayMs ?? data.main?.eventLoopDelayMs ?? data.eventLoopDelayMs, longestMs: data.longestMs, totalMs: data.totalMs, count: data.count,
    windowShownMs: data.windowShownMs, uiReadyMs: data.uiReadyMs, initializedMs: data.initializedMs, durationMs: data.durationMs
  }
  return Object.fromEntries(Object.entries(candidates).filter(([, item]) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1024 ** 5))
}
