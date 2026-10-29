import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, link, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { acquireKimiWebService } from './kimiWebService.ts'
import { startKimiLogin } from './kimiAuth.ts'
import { configureKimiPlatformKey } from './kimiPlatformKey.ts'
import type { KimiSetupSnapshot } from '../shared/kimiOnboarding.ts'

// Qualified separately from the npm distribution. Never execute the remote installer:
// it also rewrites shell profiles and migrates old Python command shims.
export const KIMI_NATIVE_RELEASE = {
  version: '2.4.0', platform: 'darwin', arch: 'arm64',
  url: 'https://code.kimi.com/kimi-code/binaries/2.4.0/kimi-code-darwin-arm64',
  sha256: '39ebd6b434447574876bc66b05ae409c8e99b239494b3fef62b3a34ecceb9fd8'
} as const
const osHome = (env: NodeJS.ProcessEnv) => env.HOME || homedir()
export const managedKimiPath = (env: NodeJS.ProcessEnv = process.env): string => join(osHome(env), '.uniagent', 'runtimes', 'kimi-code', KIMI_NATIVE_RELEASE.version, 'kimi')
export const sharedKimiPath = (env: NodeJS.ProcessEnv = process.env): string => join(osHome(env), '.local', 'bin', 'kimi')
export async function findKimiExecutable(bin = 'kimi', env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const candidates: string[] = []
  if (isAbsolute(bin)) { try { await access(bin, constants.X_OK); return bin } catch { return undefined } }
  else {
    const result = await promisify(execFile)('/usr/bin/which', [bin], { env, timeout: 5000 }).catch(() => undefined)
    if (result?.stdout.trim()) candidates.push(result.stdout.trim().split('\n')[0])
  }
  candidates.push(join(env.KIMI_CODE_HOME || join(osHome(env), '.kimi-code'), 'bin/kimi'), join(osHome(env), '.local/bin/kimi'), '/opt/homebrew/bin/kimi', '/usr/local/bin/kimi', managedKimiPath(env))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate } catch {}
  }
}

export async function downloadKimiBinary(file: string, signal: AbortSignal, progress: (received: number, total?: number) => void, request: typeof fetch = fetch): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(300_000)])
  let url: string = KIMI_NATIVE_RELEASE.url
  let response = await request(url, { redirect: 'manual', signal: bounded })
  for (let count = 0; response.status >= 300 && response.status < 400; count++) {
    await response.body?.cancel()
    const next = new URL(response.headers.get('location') || '', url)
    if (count >= 2 || next.protocol !== 'https:' || !['code.kimi.com', 'cdn.kimi.com'].includes(next.hostname) || next.port || next.username || next.password || next.search || next.hash || next.pathname !== new URL(KIMI_NATIVE_RELEASE.url).pathname) throw new Error('官方安装包重定向地址不受信任，已停止下载。')
    url = next.href; response = await request(url, { redirect: 'manual', signal: bounded })
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('官方安装包下载失败，请检查网络后重试。') }
  const total = Number(response.headers.get('content-length')) || undefined
  const reader = response.body.getReader(), handle = await open(file, 'wx', 0o600)
  const digest = createHash('sha256')
  let received = 0, published = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > 350 * 1024 * 1024) throw new Error('安装包大小超出限制，已停止安装。')
      digest.update(value)
      await handle.writeFile(value)
      if (Date.now() - published >= 200) { progress(received, total); published = Date.now() }
    }
    if (digest.digest('hex') !== KIMI_NATIVE_RELEASE.sha256) throw new Error('官方安装包校验失败，未启用下载内容。请重试。')
    await handle.sync()
    progress(received, total)
  } finally { await handle.close(); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function verifyBinary(bin: string, sandbox: string, signal: AbortSignal): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, KIMI_CODE_HOME: join(sandbox, '.kimi-code'), XDG_CONFIG_HOME: sandbox, XDG_DATA_HOME: sandbox, XDG_CACHE_HOME: sandbox, TMPDIR: sandbox }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(bin, ['--version'], { env, cwd: sandbox, timeout: 15000, signal, maxBuffer: 8192 })
  if (!/(?:^|\s)2\.2\.0(?:\s|$)/.test(result.stdout)) throw new Error('下载的 CLI 版本与支持版本不一致。')
  signal.throwIfAborted()
  const lease = await acquireKimiWebService({ bin, cwd: sandbox, env, timeoutMs: 15000 })
  try { signal.throwIfAborted() } finally { await lease.release() }
}
type Dependencies = {
  env: () => NodeJS.ProcessEnv
  find: typeof findKimiExecutable
  download: typeof downloadKimiBinary
  verify: typeof verifyBinary
  probe: (bin?: string) => Promise<{ status: NonNullable<KimiSetupSnapshot['status']>; version?: string; reason?: string }>
  login: typeof startKimiLogin
  platformKey: typeof configureKimiPlatformKey
}
export class KimiOnboarding {
  private state: KimiSetupSnapshot = { phase: 'idle', cancellable: false }
  private flight?: Promise<KimiSetupSnapshot>
  private abort?: AbortController
  private stopLogin?: () => Promise<void>
  private loginUrl?: string
  onChanged: (value: KimiSetupSnapshot) => void = () => {}
  private readonly deps: Dependencies
  constructor(overrides: Partial<Dependencies> = {}) {
    this.deps = { env: () => process.env, find: findKimiExecutable, download: downloadKimiBinary, verify: verifyBinary,
      probe: async bin => (await import('./kimiWebContract.ts')).probeKimiWeb(bin, osHome(this.deps.env()), this.deps.env()), login: startKimiLogin, platformKey: configureKimiPlatformKey, ...overrides }
  }
  get busy(): boolean { return !!this.flight }
  snapshot(): KimiSetupSnapshot { return { ...this.state } }
  private publish(patch: Partial<KimiSetupSnapshot>): void { this.state = { ...this.state, ...patch }; this.onChanged(this.snapshot()) }
  private async inspect(bin?: string): Promise<KimiSetupSnapshot> {
    const result = await this.deps.probe(bin)
    this.publish({ status: result.status, version: result.version, message: result.reason })
    return this.snapshot()
  }
  check(): Promise<KimiSetupSnapshot> { return this.perform(async () => { await this.inspect() }) }
  private perform(action: (signal: AbortSignal) => Promise<void>): Promise<KimiSetupSnapshot> {
    if (this.flight) return this.flight
    const controller = this.abort = new AbortController()
    this.publish({ phase: 'checking', message: undefined, receivedBytes: undefined, totalBytes: undefined, cancellable: true })
    this.flight = action(controller.signal).then(() => {
      controller.signal.throwIfAborted()
      this.publish({ phase: 'completed' }); return this.snapshot()
    }).catch(error => {
      this.publish({ phase: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '已取消，可稍后重试。' : error instanceof Error && !('cmd' in error) && error.name !== 'TypeError' ? error.message : '操作失败，请检查网络与 CLI 状态后重试。' })
      return this.snapshot()
    }).finally(() => { this.abort = undefined; this.flight = undefined; this.stopLogin = undefined; this.loginUrl = undefined; this.publish({ cancellable: false, canReopen: false }) })
    return this.flight.then(() => this.snapshot())
  }
  install(): Promise<KimiSetupSnapshot> {
    return this.perform(async signal => {
      const env = this.deps.env(), existing = await this.deps.find('kimi', env)
      signal.throwIfAborted()
      if (existing) { await this.inspect(existing); return }
      if (process.platform !== KIMI_NATIVE_RELEASE.platform || process.arch !== KIMI_NATIVE_RELEASE.arch) throw new Error('当前平台暂不支持一键安装，请使用下方备用安装方式。')
      const target = sharedKimiPath(env), directory = join(target, '..')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(directory, '.install-'))
      try {
        const candidate = join(staging, 'kimi')
        this.publish({ phase: 'downloading' })
        await this.deps.download(candidate, signal, (receivedBytes, totalBytes) => this.publish({ receivedBytes, totalBytes }))
        signal.throwIfAborted()
        this.publish({ phase: 'verifying' })
        await chmod(candidate, 0o700)
        const sandbox = join(staging, 'probe-' + randomUUID()); await mkdir(sandbox, { mode: 0o700 })
        await this.deps.verify(candidate, sandbox, signal)
        signal.throwIfAborted()
        // Recheck immediately before activation; another installer may have won.
        const appeared = await this.deps.find('kimi', env)
        if (appeared) { await this.inspect(appeared); return }
        this.publish({ phase: 'activating', cancellable: false })
        await link(candidate, target) // atomic create; never overwrite any existing executable
      } finally { await rm(staging, { recursive: true, force: true }) }
      await this.inspect(target)
    })
  }
  signIn(input: { region?: 'cn' | 'global'; apiKey?: string } = {}): Promise<KimiSetupSnapshot> {
    if (!input || input.region !== undefined && !['cn', 'global'].includes(input.region) || input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !input.apiKey.trim())) return Promise.reject(new Error('Kimi 登录参数无效'))
    return this.perform(async signal => {
      const bin = await this.deps.find('kimi', this.deps.env())
      if (!bin) throw new Error('请先安装官方 Kimi Code CLI。')
      await this.inspect(bin)
      if (this.state.status === 'ready') return
      if (this.state.status !== 'needs-auth' && this.state.status !== 'needs-config') throw new Error('CLI 服务未通过检测，请先处理版本或服务错误。')
      signal.throwIfAborted()
      const region = input.region || 'cn'
      this.publish({ phase: input.apiKey ? 'verifying' : 'login', region, canReopen: false, message: undefined })
      if (input.apiKey) {
        await this.deps.platformKey(bin, region, input.apiKey.trim(), signal, this.deps.env())
        const checked = await this.inspect(bin)
        if (checked.status !== 'ready') throw new Error('配置已提交，但模型检测未通过，请重新检测')
        return
      }
      const attempt = this.deps.login(bin, this.deps.env().KIMI_CODE_HOME || join(osHome(this.deps.env()), '.kimi-code'), region === 'cn' ? 'mainland-cn' : 'global')
      this.stopLogin = () => attempt.stop()
      await new Promise<void>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined
        let settled = false
        const cancelled = () => { void attempt.stop(); finish(new Error('已取消登录')) }
        const timer = setTimeout(() => { void attempt.stop(); finish(new Error('登录超时，请重试。')) }, 600_000)
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancelled); unsubscribe?.(); error ? reject(error) : resolve() }
        signal.addEventListener('abort', cancelled, { once: true })
        unsubscribe = attempt.subscribe(value => {
          if (value.url) { this.loginUrl = value.url; this.publish({ canReopen: true }) }
          if (value.status === 'success') finish()
          else if (value.status === 'failed') finish(new Error('Kimi 登录未完成，请重试。'))
        })
        if (settled) unsubscribe()
        if (signal.aborted) cancelled()
      })
      signal.throwIfAborted()
      const checked = await this.inspect(bin)
      if (checked.status !== 'ready') throw new Error('授权已结束，但模型检测未通过，请重新检测')
    })
  }
  async reopen(openBrowser: (url: string) => Promise<unknown>): Promise<void> {
    if (!this.loginUrl || this.state.phase !== 'login' || !this.busy) throw new Error('授权页面尚未就绪或已过期')
    try { await openBrowser(this.loginUrl) } catch { throw new Error('无法打开默认浏览器，请重试') }
  }
  async cancel(): Promise<void> { if (this.state.cancellable) { this.abort?.abort(); await this.stopLogin?.() } }
  async close(): Promise<void> { await this.cancel(); await this.flight }
}
export const kimiOnboarding = new KimiOnboarding()
