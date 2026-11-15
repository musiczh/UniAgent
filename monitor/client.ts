export interface DashboardConfig { url: string; publishableKey: string }
interface Session { access_token: string; refresh_token: string; expires_at: number }
export interface MonitorStats { installations: number; errors: number; feedback: number; good: number; bad: number; daily: Array<{ day: string; count: number }> }
export interface FeedbackRow { owner_id: string; event_id: string; request_key: string; attempt_key: string; revision: number; saved_at: string; distribution: string; app_version: string; matches: boolean; reason?: string; actual_action: string; expected_kind?: string }
export interface LogRow { owner_id: string; event_id: string; occurred_at: string; category: string; distribution: string; app_version: string; agent_id: string; level: string; code: string; payload: Record<string, string | number> }
export interface Page<T> { rows: T[]; total: number }
export interface Query { days: number; distribution: string; version: string; search: string; filter: string; offset: number }

export class DashboardError extends Error { constructor(readonly status: number) { super(status === 401 ? '登录已失效，请重新登录。' : status === 403 ? '当前账号没有监控看板权限，请联系项目维护者。' : status === 429 ? '请求过于频繁，请稍后重试。' : '暂时无法完成请求，请稍后重试。') } }
const sessionKey = 'uniagent-monitor-session-v1'
const callbackKeys = ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'provider_token', 'provider_refresh_token', 'error', 'error_description', 'error_code']
const invalidLink = '登录链接已失效或无效，请重新发送登录链接。'
type AuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
function emailAddress(value: string): string {
  value = value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) throw new Error('请填写有效邮箱。')
  return value
}

/** Consume the URL before rendering or starting requests so credentials do not remain in browser history. */
export function consumeSignInCallback(url: URL, replace: (url: string) => void): URLSearchParams | undefined {
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (!callbackKeys.some(key => fragment.has(key) || url.searchParams.has(key))) return undefined
  const credentialsInQuery = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token'].some(key => url.searchParams.has(key))
  const params = new URLSearchParams(fragment)
  for (const key of [...callbackKeys, 'type']) {
    if (!params.has(key) && url.searchParams.has(key)) params.set(key, url.searchParams.get(key)!)
    url.searchParams.delete(key); fragment.delete(key)
  }
  // Successful implicit callbacks carry credentials in the fragment, never the query string.
  if (credentialsInQuery || !params.has('access_token')) params.set('error', 'invalid_callback')
  url.hash = fragment.toString()
  try { replace(url.pathname + url.search + url.hash) } catch { params.set('error', 'url_cleanup_failed') }
  return params
}

export class DashboardClient {
  private session?: Session
  private generation = 0
  private channel?: BroadcastChannel
  private remember = false
  private recovery = false
  constructor(private config: DashboardConfig, private storage?: AuthStorage, private send: typeof fetch = (input, init) => globalThis.fetch(input, init), private now = Date.now, private persistentStorage?: AuthStorage) {
    const read = (source?: AuthStorage) => { try { return JSON.parse(source?.getItem(sessionKey) || 'null') } catch { return null } }
    const temporary = read(storage), persistent = read(persistentStorage)
    const value = temporary?.recovery ? temporary : persistent || (temporary?.remember ? null : temporary)
    if (typeof value?.access_token === 'string' && value.access_token && typeof value.refresh_token === 'string' && value.refresh_token && Number.isSafeInteger(value.expires_at)) {
      this.session = { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at }
      this.remember = value.remember === true && !value.recovery
      this.recovery = value.recovery === true
    }
  }
  configured(): boolean { return this.config.url.startsWith('https://') && !!this.config.publishableKey }
  signedIn(): boolean { return !!this.session }
  needsPassword(): boolean { return this.recovery && this.signedIn() }
  private broadcast(message: unknown): void { try { this.channel?.postMessage(message) } catch { /* The current tab remains usable if messaging is unavailable. */ } }
  connectSync(changed: (verifying: boolean, error?: Error) => void): () => void {
    let channel: BroadcastChannel
    try { channel = new BroadcastChannel('uniagent-monitor-auth-v1:' + this.config.url) } catch { return () => {} }
    this.channel = channel
    const share = () => { if (!this.recovery && this.session && this.session.expires_at * 1000 > this.now()) this.broadcast({ type: 'session', session: this.session, remember: this.remember }) }
    const receive = (event: MessageEvent) => {
      const message = event.data
      if (message?.type === 'request') { share(); return }
      if (message?.type === 'sign-out') { this.clear(false, true); changed(false); return }
      if (this.recovery) return
      const value = message?.session
      if (message?.type !== 'session' || typeof value?.access_token !== 'string' || !value.access_token || value.access_token.length > 8192 || /\s/.test(value.access_token) ||
        typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 8192 || !Number.isSafeInteger(value.expires_at) || value.expires_at * 1000 <= this.now()) return
      if (value.access_token === this.session?.access_token && value.refresh_token === this.session?.refresh_token) return
      this.clear()
      const generation = this.generation
      changed(true)
      void (async () => {
        const user = await this.request('/auth/v1/user', undefined, value.access_token, 'GET')
        if (generation !== this.generation || this.channel !== channel) return
        if (typeof user?.id !== 'string' || !user.id || user.is_anonymous !== false) throw new Error('未能建立维护者登录，请重试。')
        if (await this.request('/rest/v1/rpc/monitor_is_admin', {}, value.access_token) !== true) throw new DashboardError(403)
        if (generation !== this.generation || this.channel !== channel) return
        this.remember = message.remember === true
        this.save({ ...value, user }, false)
        changed(false)
      })().catch(error => { if (generation === this.generation && this.channel === channel) changed(false, error instanceof Error ? error : new Error('登录验证失败，请重试。')) })
    }
    channel.addEventListener('message', receive)
    share()
    if (!this.recovery) this.broadcast({ type: 'request' })
    return () => { channel.removeEventListener('message', receive); channel.close(); if (this.channel === channel) this.channel = undefined }
  }
  private async request(path: string, body?: unknown, token?: string, method: 'GET' | 'POST' | 'PUT' = 'POST'): Promise<any> {
    if (!this.configured()) throw new Error('监控服务尚未完成配置。')
    const generation = this.generation, session = this.session
    const response = await this.send(this.config.url + path, { method, cache: 'no-store',
      headers: { apikey: this.config.publishableKey, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(15000) })
    if (!response.ok) { if (response.status === 401 && session && this.session === session && generation === this.generation && (!token || token === session.access_token)) this.clear(true); throw new DashboardError(response.status) }
    if (response.status === 204) return undefined
    return response.json()
  }
  private save(value: any, broadcast = true, recovery = this.recovery): void {
    const expires = value.expires_at ?? (Number.isFinite(value.expires_in) ? Math.floor(this.now() / 1000) + value.expires_in : undefined)
    if (typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token ||
      !Number.isSafeInteger(expires) || expires * 1000 <= this.now() || value.user?.is_anonymous !== false || typeof value.user?.id !== 'string' || !value.user.id) throw new Error('未能建立维护者登录，请重试。')
    this.session = { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expires }
    this.recovery = recovery
    const stored = () => JSON.stringify({ ...this.session, remember: this.remember, recovery: this.recovery })
    try {
      if (this.remember && !this.recovery && this.persistentStorage) this.persistentStorage.setItem(sessionKey, stored())
      else { this.remember = false; this.persistentStorage?.removeItem(sessionKey) }
    } catch { this.remember = false }
    try { this.storage?.setItem(sessionKey, stored()) } catch { /* Keep the verified session in memory when browser storage is unavailable. */ }
    if (broadcast && !this.recovery) this.broadcast({ type: 'session', session: this.session, remember: this.remember })
  }
  async signInPassword(email: string, password: string, remember: boolean): Promise<void> {
    email = emailAddress(email)
    if (!password || password.length > 1024) throw new Error('请填写有效密码。')
    this.clear(true); this.remember = remember
    const generation = this.generation
    try {
      const value = await this.request('/auth/v1/token?grant_type=password', { email, password })
      if (generation !== this.generation) throw new DashboardError(401)
      this.save(value)
    } catch (error) {
      if (generation === this.generation && error instanceof DashboardError && [400, 401, 422].includes(error.status)) throw new Error('邮箱或密码不正确，或账号尚未设置密码。')
      throw error
    }
  }
  async sendRecovery(email: string): Promise<void> { await this.request('/auth/v1/recover', { email: emailAddress(email) }) }
  async updatePassword(password: string, confirmation: string): Promise<void> {
    if (!this.needsPassword()) throw new DashboardError(401)
    if (password.length < 8 || password.length > 1024) throw new Error('密码至少需要 8 个字符，请使用更长的密码。')
    if (password !== confirmation) throw new Error('两次输入的密码不一致。')
    const generation = this.generation, token = await this.accessToken()
    const user = await this.request('/auth/v1/user', { password }, token, 'PUT')
    if (generation !== this.generation) throw new DashboardError(401)
    this.save({ ...this.session, user }, true, false)
  }
  async sendLink(email: string): Promise<void> {
    email = emailAddress(email)
    try { await this.request('/auth/v1/otp', { email, create_user: true }) }
    catch (error) {
      if (error instanceof DashboardError && [400, 422].includes(error.status)) throw new Error('无法发送登录邮件，请检查邮箱是否具有看板访问资格。')
      throw error
    }
  }
  async completeSignIn(params: URLSearchParams): Promise<void> {
    this.clear()
    const generation = this.generation, access = params.get('access_token'), refresh = params.get('refresh_token')
    const lifetime = Number(params.get('expires_in')), expires = params.has('expires_at') ? Number(params.get('expires_at')) : Math.floor(this.now() / 1000) + lifetime
    for (const key of ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token']) params.delete(key)
    if (params.has('error') || params.has('error_code') || params.has('error_description') || !access || access.length > 8192 || /\s/.test(access) || !refresh || refresh.length > 8192 ||
      params.get('token_type') !== 'bearer' || !Number.isSafeInteger(lifetime) || lifetime <= 0 || !Number.isSafeInteger(expires) || expires * 1000 <= this.now() ||
      params.has('type') && !['magiclink', 'signup', 'recovery'].includes(params.get('type')!)) throw new Error(invalidLink)
    let user
    try { user = await this.request('/auth/v1/user', undefined, access, 'GET') }
    catch (error) { if (error instanceof DashboardError && error.status === 401) throw new Error(invalidLink); throw error }
    if (generation !== this.generation) throw new DashboardError(401)
    if (typeof user?.id !== 'string' || !user.id) throw new Error('未能建立维护者登录，请重试。')
    this.recovery = params.get('type') === 'recovery'
    this.save({ access_token: access, refresh_token: refresh, expires_at: expires, user })
  }
  private async accessToken(): Promise<string> {
    if (!this.session) throw new DashboardError(401)
    if (this.session.expires_at * 1000 <= this.now() + 60_000) {
      const generation = this.generation, refresh = this.session.refresh_token
      let value
      try { value = await this.request('/auth/v1/token?grant_type=refresh_token', { refresh_token: refresh }) }
      catch (error) {
        if (error instanceof DashboardError && [400, 401, 403, 422].includes(error.status)) {
          if (generation === this.generation && this.session?.refresh_token === refresh) this.clear(true)
          throw new DashboardError(401)
        }
        throw error
      }
      if (generation !== this.generation) throw new DashboardError(401)
      this.save(value)
    }
    return this.session!.access_token
  }
  async assertAdmin(): Promise<void> {
    if (this.needsPassword()) throw new Error('请先完成密码设置。')
    if (await this.request('/rest/v1/rpc/monitor_is_admin', {}, await this.accessToken()) !== true) throw new DashboardError(403)
  }
  private params(query: Query): Record<string, unknown> {
    return { p_since: new Date(this.now() - query.days * 86400_000).toISOString(), p_distribution: query.distribution || null, p_version: query.version || null }
  }
  async load(query: Query): Promise<{ stats: MonitorStats; feedback: Page<FeedbackRow>; logs: Page<LogRow> }> {
    await this.assertAdmin()
    const token = await this.accessToken(), params = this.params(query)
    const [stats, feedback, logs] = await Promise.all([
      this.request('/rest/v1/rpc/monitor_stats', params, token),
      this.request('/rest/v1/rpc/monitor_feedback_page', { ...params, p_verdict: ['good', 'bad'].includes(query.filter) ? query.filter : null, p_search: query.search, p_offset: query.offset }, token),
      this.request('/rest/v1/rpc/monitor_log_page', { ...params, p_category: ['diagnostic', 'performance'].includes(query.filter) ? query.filter : null, p_search: query.search, p_offset: query.offset }, token)
    ])
    if (!stats || !['installations', 'errors', 'feedback', 'good', 'bad'].every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0) || !Array.isArray(stats.daily) ||
      !feedback || !Array.isArray(feedback.rows) || !Number.isSafeInteger(feedback.total) || !logs || !Array.isArray(logs.rows) || !Number.isSafeInteger(logs.total)) throw new Error('监控服务返回了无法读取的数据，请稍后重试。')
    return { stats, feedback, logs }
  }
  async history(row: FeedbackRow): Promise<FeedbackRow[]> {
    await this.assertAdmin()
    const result = await this.request('/rest/v1/rpc/monitor_feedback_history', { p_owner: row.owner_id, p_request: row.request_key, p_attempt: row.attempt_key }, await this.accessToken())
    if (!Array.isArray(result)) throw new Error('反馈版本暂时无法读取，请稍后重试。')
    return result
  }
  clear(broadcast = false, forgetPersistent = broadcast): void {
    this.generation++; this.session = undefined; this.recovery = false; this.remember = false
    try { this.storage?.removeItem(sessionKey) } catch { /* No session storage is available. */ }
    if (forgetPersistent) { try { this.persistentStorage?.removeItem(sessionKey) } catch { /* No persistent storage is available. */ } }
    if (broadcast) this.broadcast({ type: 'sign-out' })
  }
  async signOut(): Promise<void> {
    const token = this.session?.access_token
    this.clear(true)
    if (token) await this.request('/auth/v1/logout?scope=local', {}, token).catch(() => {})
  }
}

export function expectedRate(stats: Pick<MonitorStats, 'good' | 'feedback'>): string { return stats.feedback ? (stats.good * 100 / stats.feedback).toFixed(1) + '%' : '—' }
