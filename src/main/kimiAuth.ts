import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isProviderQuotaExceeded } from '../shared/providerErrors.ts'

export const kimiHome = (): string => process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')

export type KimiLoginState = {
  status: 'starting' | 'awaiting' | 'success' | 'failed'
  url?: string
  message?: string
}

const loginAttempts = new Map<string, KimiLoginAttempt>()

export const isKimiAuthorizationError = (value: unknown): boolean => {
  const message = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof (value as any).message === 'string'
      ? (value as any).message
      : String(value || '')
  return !isProviderQuotaExceeded(message) && /provided authorization grant is invalid|auth\.login_required|requires login before it can be used|authentication required/i.test(message)
}

const trustedKimiLoginUrl = (raw: string): string | undefined => {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)kimi\.(?:com|ai)$/.test(url.hostname)) return undefined
    return url.href
  } catch {
    return undefined
  }
}

class KimiLoginAttempt extends EventEmitter {
  private child?: ChildProcess
  private state: KimiLoginState = { status: 'starting' }
  private settled = false
  private resolveDone!: () => void
  private done = new Promise<void>((resolve) => { this.resolveDone = resolve })

  constructor(private readonly bin: string, private readonly home: string, private readonly key: string, private readonly region?: 'mainland-cn' | 'global') {
    super()
  }

  subscribe(listener: (state: KimiLoginState) => void): () => void {
    listener({ ...this.state })
    this.on('state', listener)
    return () => this.off('state', listener)
  }

  start(): void {
    const env: NodeJS.ProcessEnv = { ...process.env, KIMI_CODE_HOME: this.home, NO_COLOR: '1' }
    for (const key of Object.keys(env)) if (key.startsWith('UNIAGENT_')) delete env[key]
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(this.bin, ['login', ...(this.region ? ['--region', this.region] : [])], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    let output = ''
    child.stderr?.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-64 * 1024)
      const match = /Opening browser for Kimi device login:\s*(https:\/\/\S+)/i.exec(output)
      const url = match && trustedKimiLoginUrl(match[1])
      if (url && this.state.url !== url) this.publish({ status: 'awaiting', url })
    })
    child.once('error', (error) => this.finish({ status: 'failed', message: error.message }))
    child.once('exit', (code) => this.finish(code === 0
      ? { status: 'success', url: this.state.url }
      : { status: 'failed', url: this.state.url, message: 'Kimi Code 登录未完成，请点击链接后重试。' }))
  }

  async stop(): Promise<void> {
    if (this.child?.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
    await Promise.race([this.done, new Promise((resolve) => setTimeout(resolve, 2000))])
    if (this.child?.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }

  private publish(state: KimiLoginState): void {
    this.state = state
    this.emit('state', { ...state })
  }

  private finish(state: KimiLoginState): void {
    if (this.settled) return
    this.settled = true
    this.publish(state)
    if (loginAttempts.get(this.key) === this) loginAttempts.delete(this.key)
    this.resolveDone()
  }
}

/** Reuse one device login per CLI/home; the CLI opens the system browser itself. */
export function startKimiLogin(
  bin: string,
  home = kimiHome(),
  region?: 'mainland-cn' | 'global'
): { subscribe(listener: (state: KimiLoginState) => void): () => void; stop(): Promise<void> } {
  const key = home + '\0' + bin + '\0' + (region || '')
  let attempt = loginAttempts.get(key)
  if (!attempt) {
    attempt = new KimiLoginAttempt(bin, home, key, region)
    loginAttempts.set(key, attempt)
    attempt.start()
  }
  return attempt
}

export const hasKimiLoginAttempts = (): boolean => loginAttempts.size > 0

export async function closeKimiLoginAttempts(): Promise<void> {
  await Promise.allSettled([...loginAttempts.values()].map((attempt) => attempt.stop()))
}
