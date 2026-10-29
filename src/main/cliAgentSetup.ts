import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef } from '../shared/types.ts'
import { isCliSetupId, type CliSetupId, type CliSetupInput, type CliSetupSnapshot } from '../shared/agentSetup.ts'
import { findAgentExecutable, runSetupCommand } from './agentSetupProcess.ts'
import { loadNativeCredentials, nativeCredentialEnv, saveNativeCredential } from './agentSetupCredentials.ts'

const binaries = { codex: 'codex', traex: 'traecli', claude: 'claude', grok: 'grok' }
const installers: Partial<Record<CliSetupId, string>> = {
  codex: 'https://chatgpt.com/codex/install.sh', claude: 'https://claude.ai/install.sh',
  grok: 'https://x.ai/cli/install.sh'
}
export function trustedAgentLoginUrl(id: CliSetupId, value: string): string | undefined {
  try {
    const url = new URL(value)
    const suffixes = ({ codex: ['openai.com', 'chatgpt.com'], claude: ['claude.ai', 'claude.com', 'anthropic.com'],
      grok: ['x.ai', 'grok.com'] } as Partial<Record<CliSetupId, string[]>>)[id] || []
    if (url.protocol !== 'https:' || url.username || url.password || !suffixes.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return
    return url.href
  } catch { return }
}
type Dependencies = {
  inspect: (id: CliSetupId) => Promise<AgentDef>
  openBrowser: (url: string) => Promise<unknown>
  find: typeof findAgentExecutable
  run: typeof runSetupCommand
  request: typeof fetch
  saveKey: typeof saveNativeCredential
}
type Attempt = { snapshot: CliSetupSnapshot; controller?: AbortController; flight?: Promise<CliSetupSnapshot>; url?: string }
export class CliAgentSetup {
  private attempts = new Map<CliSetupId, Attempt>()
  onChanged: (id: CliSetupId, snapshot: CliSetupSnapshot) => void = () => {}
  private readonly deps: Dependencies
  constructor(options: Pick<Dependencies, 'inspect' | 'openBrowser'> & Partial<Dependencies>) {
    this.deps = { find: findAgentExecutable, run: runSetupCommand, request: fetch, saveKey: saveNativeCredential, ...options }
  }
  private attempt(id: CliSetupId): Attempt {
    if (!isCliSetupId(id)) throw new Error('不支持的 Agent')
    let value = this.attempts.get(id)
    if (!value) { value = { snapshot: { phase: 'idle', cancellable: false } }; this.attempts.set(id, value) }
    return value
  }
  snapshot(id: CliSetupId): CliSetupSnapshot { return { ...this.attempt(id).snapshot } }
  busy(id: string): boolean { return isCliSetupId(id) && !!this.attempt(id).flight }
  private publish(id: CliSetupId, patch: Partial<CliSetupSnapshot>) {
    const attempt = this.attempt(id)
    attempt.snapshot = { ...attempt.snapshot, ...patch }
    this.onChanged(id, this.snapshot(id))
  }
  private perform(id: CliSetupId, phase: CliSetupSnapshot['phase'], run: (signal: AbortSignal) => Promise<void>): Promise<CliSetupSnapshot> {
    const attempt = this.attempt(id)
    if (attempt.flight) return Promise.reject(new Error('该 Agent 正在准备，请完成或取消后重试'))
    const controller = attempt.controller = new AbortController()
    this.publish(id, { phase, cancellable: true, message: undefined, canReopen: false, deviceCode: undefined })
    const flight = (async () => {
      try {
        await run(controller.signal)
        controller.signal.throwIfAborted()
        this.publish(id, { phase: 'checking', canReopen: false })
        const detected = await this.deps.inspect(id)
        controller.signal.throwIfAborted()
        if (!detected.installed || detected.incompatible || detected.lifecycle?.detectionStatus === 'failed') throw new Error('程序或连接检测未通过，请重新检测；已有配置已保留')
        if (phase !== 'installing' && detected.lifecycle?.availability !== 'available') throw new Error('授权操作已结束，但连接尚未就绪，请检查账号与模型配置后重试')
        this.publish(id, { phase: 'idle', message: undefined })
      } catch (error) {
        this.publish(id, { phase: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted
          ? '已取消，可重新检测或重试' : error instanceof Error ? error.message : '操作未完成，请重试' })
      } finally { attempt.url = undefined; attempt.controller = undefined; attempt.flight = undefined; this.publish(id, { cancellable: false, canReopen: false, deviceCode: undefined }) }
      return this.snapshot(id)
    })()
    attempt.flight = flight
    return flight
  }
  install(id: CliSetupId): Promise<CliSetupSnapshot> {
    if (!isCliSetupId(id)) return Promise.reject(new Error('当前发行版不支持此 Agent'))
    return this.perform(id, 'installing', async signal => {
      const existing = await this.deps.inspect(id)
      if (existing.installed) return
      if (existing.lifecycle?.detectionStatus === 'failed') throw new Error('程序检测未完成，请先重新检测，不重复安装')
      if (await this.deps.find(binaries[id])) return
      if (process.platform === 'win32') throw new Error('当前平台请使用提示词安装官方程序')
      const directory = await mkdtemp(join(tmpdir(), 'uniagent-cli-install-'))
      try {
        const response = await this.deps.request(installers[id]!, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
        if (!response.ok) throw new Error('下载官方安装器失败，请检查网络或使用提示词安装')
        const content = await response.text()
        if (content.length > 2 * 1024 * 1024 || !/^#!/.test(content)) throw new Error('官方安装器内容无效，请使用提示词安装')
        const file = join(directory, 'install.sh')
        await writeFile(file, content, { mode: 0o700 })
        if (await this.deps.find(binaries[id])) return
        await this.deps.run('/bin/bash', [file], { signal, env: { ...process.env, NO_COLOR: '1' } })
        if (!await this.deps.find(binaries[id])) throw new Error('安装器已结束，但未找到程序，请重新检测或使用提示词安装')
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  }
  signIn(id: CliSetupId, input: CliSetupInput = {}): Promise<CliSetupSnapshot> {
    if (!isCliSetupId(id) || !input || !['browser', 'sso', 'key'].includes(input.method || 'browser')) return Promise.reject(new Error('登录参数无效'))
    if (input.method === 'key' && (id === 'traex' || typeof input.apiKey !== 'string' || !input.apiKey.trim())) return Promise.reject(new Error('请填写 API Key；TraeX 使用企业身份登录'))
    return this.perform(id, input.method === 'key' ? 'verifying' : 'login', async signal => {
      await loadNativeCredentials()
      const existing = await this.deps.inspect(id)
      if (existing.lifecycle?.availability === 'available') return
      if (!existing.installed || existing.incompatible || existing.lifecycle?.detectionStatus === 'failed') throw new Error('请先完成程序与连接检测，再开始登录')
      const bin = existing.bin
      const env = { ...process.env, ...nativeCredentialEnv(id), NO_COLOR: '1' }
      if (input.method === 'key') {
        const key = input.apiKey!.trim()
        if (id === 'codex') await this.deps.run(bin, ['login', '--with-api-key'], { env, signal, input: key + '\n', timeoutMs: 60_000 })
        else if (id === 'claude' || id === 'grok') {
          const headers: Record<string, string> = id === 'claude'
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` }
          const response = await this.deps.request(id === 'claude' ? 'https://api.anthropic.com/v1/models' : 'https://api.x.ai/v1/models', {
            redirect: 'error',
            headers,
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          }).catch(() => { throw new Error('连接验证失败，请检查网络后重试；原配置已保留') })
          if (!response.ok) { await response.body?.cancel(); throw new Error('API Key 或模型访问权限校验失败；原配置已保留') }
          const catalog = await response.json().catch(() => { throw new Error('模型目录格式无效；原配置已保留') }) as { data?: unknown[] }
          if (!Array.isArray(catalog.data) || !catalog.data.some(model => model && typeof model === 'object' && 'id' in model && typeof model.id === 'string' && model.id.length > 0)) throw new Error('该连接未提供可用模型；原配置已保留')
          signal.throwIfAborted()
          await this.deps.saveKey(id, key)
        }
        return
      }
      const attempt = this.attempt(id)
      let buffer = ''
      const output = (chunk: string) => {
        buffer = (buffer + chunk).slice(-65536).replace(/\x1b\[[0-9;]*m/g, '')
        for (const match of buffer.matchAll(/https:\/\/[^\s<>"']+/g)) {
          const url = trustedAgentLoginUrl(id, match[0])
          if (!url || attempt.url === url) continue
          attempt.url = url; this.publish(id, { canReopen: true })
          
        }
        const code = buffer.match(/(?:user[_ ]code|verification code|device code|验证码|Code)\s*[:：]\s*([A-Z0-9-]{4,16})\b/i)?.[1]
        if (code) this.publish(id, { deviceCode: code })
      }
      let args = id === 'claude' ? ['auth', 'login'] : ['login']
      
      await this.deps.run(bin, args, { env, signal, output })
    })
  }
  async reopen(id: CliSetupId): Promise<void> {
    const url = this.attempt(id).url
    if (!url || !this.busy(id)) throw new Error('授权页面尚未就绪或已过期，请重新登录')
    try { await this.deps.openBrowser(url) } catch { throw new Error('浏览器未打开，请检查默认浏览器后重试') }
  }
  async cancel(id: CliSetupId): Promise<void> { const attempt = this.attempt(id); attempt.controller?.abort(); await attempt.flight }
  async close(): Promise<void> { await Promise.all([...this.attempts.keys()].map(id => this.cancel(id))) }
}
