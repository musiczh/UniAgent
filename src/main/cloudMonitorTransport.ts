import { decryptLocalSecretAsync, encryptLocalSecretAsync } from './localSecretStore'
import { MonitorHttpError, type MonitorQueue, type MonitorReceipt } from './cloudMonitorQueue'
import type { MonitorRecord } from '../shared/cloudMonitor'

interface Session { access_token: string; refresh_token: string; expires_at: number; user: { id: string } }
interface Config { url: string; publishableKey: string }

export class MonitorTransport {
  private session?: Session
  constructor(private config: Config, private queue: MonitorQueue, private send: typeof fetch = fetch, private now = Date.now,
    private encrypt = encryptLocalSecretAsync, private decrypt = decryptLocalSecretAsync) {}
  private async request(path: string, body?: unknown, token?: string): Promise<Response> {
    const response = await this.send(this.config.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: this.config.publishableKey, ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) })
    if (!response.ok) {
      const value = response.headers.get('retry-after')
      const seconds = value ? /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - this.now()) / 1000) : undefined
      throw new MonitorHttpError(response.status, seconds && Number.isFinite(seconds) ? Math.max(1, seconds) : undefined,
        path.startsWith('/functions/v1/') && [400, 413, 415, 422].includes(response.status))
    }
    return response
  }
  private async storeSession(response: Response): Promise<Session> {
    const value = await response.json()
    const expiresAt = value.expires_at ?? (Number.isFinite(value.expires_in) ? Math.floor(this.now() / 1000) + value.expires_in : undefined)
    if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' || !value.user?.id ||
      !Number.isFinite(expiresAt) || expiresAt * 1000 <= this.now() || value.user.is_anonymous !== true) throw new Error('invalid_monitor_identity')
    const session: Session = { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expiresAt, user: { id: value.user.id } }
    await this.queue.saveSession(await this.encrypt(JSON.stringify(session)))
    this.session = session
    return session
  }
  private async identity(): Promise<Session> {
    if (!this.session && this.queue.snapshot().session) {
      const parsed = JSON.parse(await this.decrypt(this.queue.snapshot().session!))
      if (typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string' || !Number.isFinite(parsed.expires_at) || typeof parsed.user?.id !== 'string') throw new Error('invalid_monitor_identity')
      this.session = parsed
    }
    if (this.session && this.session.expires_at * 1000 > this.now() + 60_000) return this.session
    if (this.session) {
      try { return await this.storeSession(await this.request('/auth/v1/token?grant_type=refresh_token', { refresh_token: this.session.refresh_token })) }
      catch (error) { if (!(error instanceof MonitorHttpError) || ![400, 401].includes(error.status)) throw error }
    }
    return this.storeSession(await this.request('/auth/v1/signup', { data: {} }))
  }
  async upload(records: MonitorRecord[]): Promise<MonitorReceipt> {
    const session = await this.identity()
    try { return await (await this.request('/functions/v1/monitor-ingest', records, session.access_token)).json() }
    catch (error) {
      if (error instanceof MonitorHttpError && error.status === 401 && this.session) this.session.expires_at = 0
      throw error
    }
  }
}
