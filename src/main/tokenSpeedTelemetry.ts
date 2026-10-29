import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { TokenSpeedSample } from '../shared/tokenSpeed'

export interface NativeTokenSpeed {
  threadId: string
  id: string
  ts: number
  speed: TokenSpeedSample
}

type Agent = 'codex' | 'traex' | 'claude'
type Attributes = Record<string, unknown>
type Timing = { key: string; kind: 'start' | 'complete' | 'error' | 'boundary'; ts: number; startedAt?: number; model?: string; outputTokens?: number }
const allowed = new Set(['event.name', 'event.kind', 'event.timestamp', 'event.sequence', 'conversation.id',
  'session.id', 'model', 'duration_ms', 'http.response.status_code', 'success', 'error.message',
  'endpoint', 'output_token_count', 'output_tokens', 'query_source', 'request_id', 'client_request_id', 'agent_id'])

function number(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

/** Only performance fields survive decoding; prompts, tools, headers and bodies are discarded. */
function attributes(log: any): Attributes {
  const result: Attributes = {}
  for (const attribute of Array.isArray(log?.attributes) ? log.attributes : []) {
    if (!allowed.has(attribute?.key)) continue
    const value = attribute.value
    result[attribute.key] = value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue
  }
  return result
}

/** Native timestamps, rather than collector arrival times, keep batched export out of the denominator. */
export class TokenSpeedTelemetryDecoder {
  private threads = new Map<string, Map<string, Timing>>()
  private emitted = new Map<string, string>()

  constructor(private agent: Agent, private emit: (sample: NativeTokenSpeed) => void) {}

  endTurn(threadId: string, ts = Date.now()): void {
    this.record(threadId, { key: `boundary-${ts}`, kind: 'boundary', ts })
    this.replay(threadId)
  }

  ingest(body: unknown): void {
    const changed = new Set<string>()
    for (const resource of Array.isArray((body as any)?.resourceLogs) ? (body as any).resourceLogs : []) {
      for (const scope of Array.isArray(resource?.scopeLogs) ? resource.scopeLogs : []) {
        for (const log of Array.isArray(scope?.logRecords) ? scope.logRecords : []) {
          const a = attributes(log)
          const ts = typeof a['event.timestamp'] === 'string' ? Date.parse(a['event.timestamp']) : NaN
          if (!Number.isSafeInteger(ts) || ts < 0) continue
          const threadId = this.agent === 'claude' ? a['session.id'] : a['conversation.id']
          if (typeof threadId !== 'string' || !threadId) continue
          if (this.agent === 'claude') {
            if (a['event.name'] !== 'api_request' || !['sdk', 'repl_main_thread'].includes(String(a.query_source)) || a.agent_id) continue
            const requestId = a.request_id || a.client_request_id || a['event.sequence']
            if (typeof requestId !== 'string' && typeof requestId !== 'number') continue
            const duration = number(a.duration_ms)
            this.publish(threadId, `claude-${threadId}-${requestId}`, ts, number(a.output_tokens), duration,
              duration === undefined ? undefined : ts - duration, a.model)
            continue
          }
          const event = String(a['event.name'])
          const stream = ['codex.sse_event', 'codex.websocket_event', 'traecli.sse_event', 'traecli.websocket_event'].includes(event)
          const request = ['codex.api_request', 'codex.websocket_request', 'traecli.api_request', 'traecli.websocket_request'].includes(event)
          const modelRequest = request && (event.endsWith('websocket_request') || a.endpoint === '/responses')
          const failed = a.success === false || a.success === 'false' || !!a['error.message']
          let timing: Timing | undefined
          if (modelRequest && !failed &&
              (a['http.response.status_code'] == null || number(a['http.response.status_code']) === 200)) {
            const duration = number(a.duration_ms)
            if (duration !== undefined && ts >= duration) timing = { key: `${event}-${ts}`, kind: 'start', ts, startedAt: ts - duration }
          } else if (stream && a['event.kind'] === 'response.completed' && number(a.output_token_count) !== undefined) {
            timing = { key: `complete-${ts}-${a.output_token_count}`, kind: 'complete', ts, outputTokens: number(a.output_token_count) }
          } else if ((stream || modelRequest) && failed) {
            timing = { key: `error-${event}-${ts}`, kind: 'error', ts }
          }
          if (!timing) continue
          if (typeof a.model === 'string') timing.model = a.model
          this.record(threadId, timing)
          changed.add(threadId)
        }
      }
    }
    for (const threadId of changed) this.replay(threadId)
  }

  private record(threadId: string, timing: Timing): void {
    let records = this.threads.get(threadId)
    if (!records) this.threads.set(threadId, records = new Map())
    records.set(timing.key, timing)
    // Keep request boundaries, never every text chunk, and bound long-lived shared servers.
    if (records.size > 64) records.delete([...records.values()].sort((a, b) => a.ts - b.ts)[0].key)
    while (this.threads.size > 128) this.threads.delete(this.threads.keys().next().value!)
  }

  private replay(threadId: string): void {
    const priority = { start: 0, complete: 1, error: 2, boundary: 3 }
    const records = [...this.threads.get(threadId)?.values() || []].sort((a, b) => a.ts - b.ts || priority[a.kind] - priority[b.kind])
    const pending: Array<Timing & { ambiguous?: boolean }> = []
    for (const record of records) {
      if (record.kind === 'start') {
        if (pending.length) for (const request of pending) request.ambiguous = true
        pending.push({ ...record, ambiguous: pending.length > 0 })
      } else if (record.kind === 'error' || record.kind === 'boundary') {
        for (const request of pending) this.publish(threadId, `${this.agent}-${threadId}-${request.key}`,
          record.ts, undefined, undefined, request.startedAt, request.model)
        pending.length = 0
      } else {
        const request = pending.shift()
        if (!request) continue
        const duration = !request.ambiguous && request.model === record.model && record.ts > request.startedAt!
          ? record.ts - request.startedAt! : undefined
        this.publish(threadId, `${this.agent}-${threadId}-${request.key}`, record.ts, record.outputTokens,
          duration, request.startedAt, record.model)
      }
    }
    for (const request of pending) this.publish(threadId, `${this.agent}-${threadId}-${request.key}`,
      request.ts, undefined, undefined, request.startedAt, request.model)
  }

  private publish(threadId: string, id: string, ts: number, outputTokens: number | undefined,
    durationMs: number | undefined, startedAt: number | undefined, model: unknown): void {
    if (outputTokens !== undefined && (!Number.isSafeInteger(outputTokens) || outputTokens < 0)) return
    const sample: NativeTokenSpeed = { threadId, id, ts, speed: { outputTokens, durationMs, startedAt,
      metric: 'request', source: `${this.agent === 'codex' ? 'Codex' : this.agent === 'traex' ? 'TraeX' : 'Claude Code'} 原生请求计时`,
      ...(typeof model === 'string' ? { model } : {}) } }
    const signature = JSON.stringify(sample)
    if (this.emitted.get(id) === signature) return
    this.emitted.set(id, signature)
    while (this.emitted.size > 512) this.emitted.delete(this.emitted.keys().next().value!)
    this.emit(sample)
  }
}

export interface TokenSpeedTelemetry {
  args: string[]
  env: NodeJS.ProcessEnv
  endTurn(threadId: string): void
  close(): Promise<void>
}

/** One private loopback receiver per native process; never changes on-disk Agent settings. */
export async function startTokenSpeedTelemetry(agent: Agent, emit: (sample: NativeTokenSpeed) => void,
  environment: NodeJS.ProcessEnv = process.env): Promise<TokenSpeedTelemetry | undefined> {
  const path = `/${randomUUID()}/v1/logs`
  const decoder = new TokenSpeedTelemetryDecoder(agent, emit)
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== path) { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 1024 * 1024) chunks.push(chunk)
      else { response.writeHead(413).end(); request.destroy() }
    })
    request.on('error', () => {})
    request.on('end', () => {
      try {
        decoder.ingest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      } catch { response.writeHead(400).end() }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch { server.close(); return undefined }
  server.on('error', () => {})
  server.unref()
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`
  const noProxy = [environment.NO_PROXY, environment.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  return {
    args: agent === 'claude' ? [] : ['-c', `otel.exporter={otlp-http={endpoint="${endpoint}",protocol="json"}}`, '-c', 'otel.log_user_prompt=false'],
    env: { NO_PROXY: noProxy, no_proxy: noProxy, ...(agent === 'claude' ? {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_LOGS_EXPORT_INTERVAL: '250',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '0', OTEL_LOG_TOOL_DETAILS: '0',
      OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_RAW_API_BODIES: '0'
    } : { OTEL_BLRP_SCHEDULE_DELAY: '250' }) },
    endTurn: threadId => decoder.endTurn(threadId),
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}
