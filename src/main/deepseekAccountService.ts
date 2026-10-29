import type { DeepSeekAccountSnapshot } from '../shared/deepseek.ts'

interface AccountView {
  status: 'signed-out' | 'credential-stored'
  attempt: null | { id: string; phase: NonNullable<DeepSeekAccountSnapshot['phase']>; authorizeUrl?: string; errorCode?: string }
}
export interface DeepSeekAccountClient {
  readonly callbackOrigin: string
  call<T>(method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>
  stream<T>(endpoint: string, args?: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<T>
}
interface Options {
  client: () => Promise<DeepSeekAccountClient>
  metadata: () => { version: string; locale: string; timezoneOffsetSeconds: number }
  openBrowser: (url: string) => Promise<void>
  changed: () => void
  authenticated: () => void
}
const active = new Set(['initializing', 'waiting-browser', 'exchanging', 'committing'])

/** Uses the native PKCE flow. Neither account grants nor authorization URLs cross IPC. */
export class DeepSeekAccountService {
  #view?: AccountView
  #flight?: Promise<DeepSeekAccountSnapshot>
  #cancelled = false
  #lifetime?: AbortController
  #signingOut = false
  constructor(private readonly options: Options) {}

  get busy(): boolean { return !!this.#flight || this.#signingOut }
  snapshot(): DeepSeekAccountSnapshot {
    return { supported: !!this.#view, signedIn: this.#view?.status === 'credential-stored', phase: this.#view?.attempt?.phase }
  }
  async refresh(): Promise<DeepSeekAccountSnapshot> {
    if (this.busy) return this.snapshot()
    const client = await this.options.client()
    const view = await client.call<AccountView>('account/getState')
    if (!this.busy) this.accept(view)
    return this.snapshot()
  }
  start(): Promise<DeepSeekAccountSnapshot> {
    if (this.#signingOut) return Promise.reject(new Error('正在退出 DeepSeek，请稍后登录'))
    if (this.#flight) return this.#flight
    this.#cancelled = false
    const lifetime = this.#lifetime = new AbortController()
    const flight = this.run(lifetime.signal).finally(() => {
      if (this.#flight === flight) { this.#flight = undefined; this.#lifetime = undefined }
    })
    this.#flight = flight
    return flight
  }
  async cancel(): Promise<void> {
    this.#cancelled = true
    // startSignIn may still be creating the attempt. run() checks cancellation before opening the browser.
    const attempt = this.#view?.attempt
    if (attempt && active.has(attempt.phase)) {
      const client = await this.options.client()
      this.accept(await client.call<AccountView>('account/cancelSignIn', { attemptId: attempt.id }))
    }
  }
  async signOut(): Promise<DeepSeekAccountSnapshot> {
    if (this.busy) throw new Error('请先完成或取消浏览器登录')
    this.#signingOut = true
    try {
      const client = await this.options.client()
      if (await client.call<boolean>('account/hasRunningAccountTasks')) throw new Error('DeepSeek 正在执行任务，请结束后退出登录')
      this.accept(await client.call<AccountView>('account/signOut', { client: this.options.metadata() }))
      return this.snapshot()
    } finally { this.#signingOut = false }
  }
  async reopen(): Promise<void> {
    const attempt = this.#view?.attempt
    if (!this.#flight || attempt?.phase !== 'waiting-browser') throw new Error('授权页面尚未就绪或已过期')
    let url: URL
    try { url = new URL(attempt.authorizeUrl!) } catch { throw new Error('DeepSeek 授权地址无效') }
    if (url.origin !== 'https://platform.deepseek.com' || url.pathname !== '/dsh/authorize' || url.username || url.password || url.hash) throw new Error('DeepSeek 授权地址无效')
    try { await this.options.openBrowser(url.href) } catch { throw new Error('无法打开默认浏览器，请重试') }
  }
  async close(): Promise<void> {
    try { if (this.busy) await this.cancel() }
    finally { this.#lifetime?.abort(); await this.#flight?.catch(() => undefined); this.#view = undefined }
  }
  private accept(view: AccountView): void {
    if (!view || !['signed-out', 'credential-stored'].includes(view.status)
      || (view.attempt && (typeof view.attempt.id !== 'string' || !['initializing', 'waiting-browser', 'exchanging', 'committing', 'succeeded', 'cancelled', 'expired', 'failed'].includes(view.attempt.phase)))) {
      throw new Error('DeepSeek 登录状态无效，请重试')
    }
    this.#view = view
    this.options.changed()
  }
  private async run(signal: AbortSignal): Promise<DeepSeekAccountSnapshot> {
    const client = await this.options.client()
    let attemptId: string | undefined
    let opened = false
    const observe = async (view: AccountView): Promise<boolean> => {
      this.accept(view)
      if (!view.attempt || (attemptId && view.attempt.id !== attemptId)) throw new Error('DeepSeek 登录请求已变化，请重试')
      attemptId = view.attempt.id
      const phase = view.attempt.phase
      if (this.#cancelled && active.has(phase)) {
        const cancelled = await client.call<AccountView>('account/cancelSignIn', { attemptId })
        // Native commit can already have won the race. Report that result instead of inventing cancellation.
        if (cancelled.attempt?.phase === 'succeeded') return observe(cancelled)
        this.accept(cancelled)
        throw new Error('已取消浏览器登录')
      }
      if (phase === 'waiting-browser' && !opened) {
        let url: URL
        try { url = new URL(view.attempt.authorizeUrl!) } catch { throw new Error('DeepSeek 授权地址无效，请重试') }
        if (url.origin !== 'https://platform.deepseek.com' || url.pathname !== '/dsh/authorize'
          || url.username || url.password || url.hash) throw new Error('DeepSeek 授权地址无效，请重试')
        opened = true
        // Keep the official attempt alive so the user can reopen its page.
        try { await this.options.openBrowser(url.href) } catch { this.options.changed() }
      }
      if (phase === 'succeeded') {
        if (view.status !== 'credential-stored') throw new Error('授权已返回，但登录凭据未保存，请重试')
        if (!this.#cancelled) this.options.authenticated()
        return true
      }
      if (phase === 'cancelled') throw new Error('已取消浏览器登录')
      if (phase === 'expired') throw new Error('浏览器授权已超时，请重新登录')
      if (phase === 'failed') throw new Error(view.attempt.errorCode === 'network' ? '无法连接 DeepSeek 授权服务，请检查网络后重试' : 'DeepSeek 浏览器授权失败，请重试')
      return false
    }
    try {
      const initial = await client.call<AccountView>('account/startSignIn', {
        client: this.options.metadata(), callbackOrigin: client.callbackOrigin, loginSource: 'desktop'
      }, signal)
      if (await observe(initial)) return this.snapshot()
      // Native watch replays the current state; a fast callback between start and subscribe is not lost.
      for await (const view of client.stream<AccountView>('account/watch', {}, AbortSignal.any([signal, AbortSignal.timeout(11 * 60_000)]))) {
        if (await observe(view)) return this.snapshot()
      }
      throw new Error('DeepSeek 登录连接已断开，请重新登录')
    } catch (error) {
      if (attemptId && active.has(this.#view?.attempt?.phase || '')) {
        await client.call<AccountView>('account/cancelSignIn', { attemptId }).then(view => this.accept(view), () => {
          this.accept({ status: this.#view?.status || 'signed-out', attempt: { id: attemptId!, phase: 'failed' } })
        })
      }
      throw error
    }
  }
}
