import { MONITOR_MAX_BATCH_BYTES, MONITOR_MAX_BATCH_RECORDS, validateMonitorRecord } from '../../../src/shared/cloudMonitor.ts'

interface Options { url: string; secretKey: string; fetch?: typeof fetch; now?: () => number }
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
function reply(status: number, body: unknown, extra?: Record<string, string>): Response { return new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } }) }

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('invalid_body')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MONITOR_MAX_BATCH_BYTES) { await reader.cancel(); throw new Error('body_too_large') }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally { reader.releaseLock() }
}

export function createMonitorHandler(options: Options): (request: Request) => Promise<Response> {
  const send = options.fetch || fetch
  return async request => {
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return reply(415, { error: 'json_required' })
    if (Number(request.headers.get('content-length')) > MONITOR_MAX_BATCH_BYTES) return reply(413, { error: 'body_too_large' })
    const authorization = request.headers.get('authorization')
    if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)) return reply(401, { error: 'authentication_required' })
    let records: unknown
    try { records = JSON.parse(await readBody(request)) }
    catch (error) { return reply(error instanceof Error && error.message === 'body_too_large' ? 413 : 400, { error: 'invalid_batch' }) }
    if (!Array.isArray(records) || !records.length || records.length > MONITOR_MAX_BATCH_RECORDS || records.some(row => !validateMonitorRecord(row, options.now?.() ?? Date.now()))) return reply(400, { error: 'invalid_batch' })
    try {
      const userResponse = await send(options.url + '/auth/v1/user', { headers: { apikey: options.secretKey, Authorization: authorization }, signal: AbortSignal.timeout(8000) })
      if (userResponse.status === 429) return reply(429, { error: 'authentication_rate_limited' }, { 'Retry-After': userResponse.headers.get('retry-after') || '60' })
      if (!userResponse.ok) return reply(userResponse.status >= 500 ? 503 : 401, { error: 'authentication_unavailable' })
      const user = await userResponse.json()
      if (!user?.id || typeof user.id !== 'string') return reply(401, { error: 'authentication_required' })
      const saved = await send(options.url + '/rest/v1/rpc/monitor_ingest', { method: 'POST',
        headers: { apikey: options.secretKey, Authorization: 'Bearer ' + options.secretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_owner: user.id, p_records: records }), signal: AbortSignal.timeout(8000) })
      if (saved.status === 429) return reply(429, { error: 'storage_rate_limited' }, { 'Retry-After': saved.headers.get('retry-after') || '60' })
      if (!saved.ok) return reply(503, { error: 'storage_unavailable' })
      const result = await saved.json()
      if (!['accepted', 'duplicates', 'rejected', 'limited'].every(name => Array.isArray(result[name]))) return reply(503, { error: 'storage_unavailable' })
      return reply(200, result, result.limited.length ? { 'Retry-After': String(result.retryAfter) } : undefined)
    } catch { return reply(503, { error: 'service_unavailable' }) }
  }
}
