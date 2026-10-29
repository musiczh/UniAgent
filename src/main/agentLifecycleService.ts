import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { AgentDef, AgentLifecycleProgress, AgentLifecycleState } from '../shared/types.ts'
import { pendingAgentDetection } from '../shared/agentReadiness.ts'
import { DEEPSEEK_PACKAGE, DEEPSEEK_VERIFIED_VERSION } from '../shared/deepseek.ts'
import { BUILTIN_AGENTS, detectAgents, failedAgentDetection, matchesAgentDetectionScope } from './agents.ts'
import type { AgentDetectionObserver, AgentDetectionScope } from './agents.ts'
import { updateDeepSeekRuntime } from './deepseekService.ts'
import { compareSemver, parseSemver } from './semver.ts'
import { nativeCredentialEnv } from './agentSetupCredentials.ts'
import { checkZCodeUpdate, getZCodeUpdateSource, updateZCodeRuntime } from './zcode/updater'

type CommandAdapterId = 'codex' | 'traex' | 'claude' | 'grok' | 'kimi' | 'deepseek' | 'mcode'
type AdapterId = CommandAdapterId | 'zcode'
type CommandSpec = { args: readonly string[]; timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }
type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type DeepSeekUpdater = (version?: string) => Promise<RunResult>
export type LifecycleRunner = (bin: string, spec: CommandSpec) => Promise<RunResult>
export type AgentDetector = (scope?: AgentDetectionScope, agentId?: string, onDetected?: AgentDetectionObserver) => Promise<AgentDef[]>
export type ExecutableResolver = (path: string) => Promise<string>
export type FileMover = (source: string, destination: string) => Promise<void>
export interface StartupDetection {
  core: Promise<AgentDef[]>
  /** Resolves to the complete core + ACP provider snapshot after slow probes settle. */
  protocol: Promise<AgentDef[]>
}

const COMMANDS: Record<CommandAdapterId, { auth: CommandSpec; health: CommandSpec; checkUpdate: CommandSpec; update: CommandSpec }> = {
  codex: {
    auth: { args: ['login', 'status'], timeoutMs: 8000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    checkUpdate: { args: ['view', '@openai/codex', 'version', '--json'], timeoutMs: 20_000 },
    update: { args: ['update'], timeoutMs: 120_000 }
  },
  traex: {
    auth: { args: ['login', 'status'], timeoutMs: 8000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    checkUpdate: { args: ['update', 'check'], timeoutMs: 20_000 },
    update: { args: ['update'], timeoutMs: 120_000 }
  },
  claude: {
    auth: { args: ['auth', 'status'], timeoutMs: 8000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    checkUpdate: { args: ['view', '@anthropic-ai/claude-code', 'version', '--json'], timeoutMs: 20_000 },
    update: { args: ['update'], timeoutMs: 120_000 }
  },
  grok: {
    auth: { args: ['login'], timeoutMs: 120_000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    checkUpdate: { args: ['update', '--check', '--json'], timeoutMs: 20_000 },
    update: { args: ['update'], timeoutMs: 120_000 }
  },
  kimi: {
    auth: { args: ['login'], timeoutMs: 120_000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    // execFile uses pipes: without --yes, Kimi only reports the update in non-interactive mode.
    // GUI launches may use cwd=/, where Kimi rejects every package manager as inside the workspace.
    checkUpdate: { args: ['upgrade'], timeoutMs: 20_000, cwd: tmpdir() },
    update: { args: ['upgrade', '--yes'], timeoutMs: 300_000, cwd: tmpdir() }
  },
  deepseek: {
    // Auth/health/update run through UniAgent-managed flows (ACP probe and
    // installDeepSeek); only the registry version check uses this table.
    auth: { args: ['--version'], timeoutMs: 8000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    // Ask for the qualified release, not the `latest` dist-tag: DeepSeek ships
    // newer pre-releases that have not passed the Host contract gate yet.
    checkUpdate: { args: ['view', `${DEEPSEEK_PACKAGE}@${DEEPSEEK_VERIFIED_VERSION}`, 'version', '--json', '--registry=https://registry.npmjs.org'], timeoutMs: 20_000 },
    update: { args: [], timeoutMs: 300_000 }
  },
  mcode: {
    // Use the same external executable for runtime operations and updates.
    auth: { args: ['--version'], timeoutMs: 8000 },
    health: { args: ['--version'], timeoutMs: 8000 },
    checkUpdate: { args: ['view', '@minimax-ai/code', 'version', '--json', '--registry=https://registry.npmjs.org'], timeoutMs: 20_000 },
    update: { args: ['update'], timeoutMs: 300_000 }
  }
}

const defaultRunner: LifecycleRunner = (bin, spec) => new Promise((resolve) => {
  execFile(bin, [...spec.args], { timeout: spec.timeoutMs, windowsHide: true, cwd: spec.cwd, env: { ...process.env, ...spec.env } }, (error, stdout, stderr) => {
    const detail = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string } | null
    const code = typeof detail?.code === 'number' ? detail.code : error ? 1 : 0
    const timedOut = !!error && (detail?.killed === true || detail?.code === 'ETIMEDOUT' || detail?.signal === 'SIGTERM')
    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut })
  })
})

function adapterFor(agent: AgentDef): AdapterId | undefined {
  return agent.adapter === 'codex' || agent.adapter === 'traex' || agent.adapter === 'claude' || agent.adapter === 'grok' || agent.adapter === 'kimi' || agent.adapter === 'deepseek' || agent.adapter === 'mcode' || agent.adapter === 'zcode'
    ? agent.adapter : undefined
}

function checkExecutable(adapter: CommandAdapterId, agent: AgentDef): string {
  if (adapter === 'codex' || adapter === 'claude' || adapter === 'deepseek' || adapter === 'mcode') return process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return agent.bin
}

type UpdateCommand = { bin: string; spec: CommandSpec; npmPrefix?: string }

function claudeNpmGlobalUpdate(
  resolvedBin: string,
  availableVersion: string | undefined
): UpdateCommand | undefined {
  const normalized = resolvedBin.replace(/\\/g, '/')
  const marker = process.platform === 'win32'
    ? '/node_modules/@anthropic-ai/claude-code/'
    : '/lib/node_modules/@anthropic-ai/claude-code/'
  const markerAt = normalized.indexOf(marker)
  if (markerAt <= 0) return undefined
  const prefix = normalized.slice(0, markerAt)
  const version = parseSemver(availableVersion) ? availableVersion : 'latest'
  return {
    bin: process.platform === 'win32' ? join(prefix, 'npm.cmd') : join(prefix, 'bin', 'npm'),
    npmPrefix: prefix,
    spec: {
      args: ['install', '--global', '--prefix', prefix, `@anthropic-ai/claude-code@${version}`],
      timeoutMs: COMMANDS.claude.update.timeoutMs
    }
  }
}

function staleClaudeNpmDirectory(prefix: string, result: RunResult): string | undefined {
  if (result.code === 0) return undefined
  const output = `${result.stdout}\n${result.stderr}`
  if (!/\bENOTEMPTY\b/i.test(output)) return undefined
  const rawDestination = output.match(/^(?:npm\s+)?(?:error|ERR!)?\s*dest\s+(.+?)\s*$/im)?.[1]
  const destination = rawDestination?.trim().replace(/^['"]|['"]$/g, '')
  if (!destination) return undefined
  const parent = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@anthropic-ai')
  const child = relative(parent, destination)
  if (!child || isAbsolute(child) || child.startsWith('..') || !/^\.claude-code-[A-Za-z0-9]+$/.test(child)) return undefined
  return destination
}

function versionText(value: string): string | undefined {
  const match = value.match(/(?:v)?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/i)
  return match?.[1]
}

function latestVersionText(value: string): string | undefined {
  const field = value.match(/^\s*latest\b[^\r\n:]*\bversion\s*:\s*(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\s*$/im)
  return parseSemver(field?.[1]) ? field?.[1] : undefined
}

function registryVersionText(value: string): string | undefined {
  const trimmed = value.trim()
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === 'string' && parseSemver(parsed) ? parsed : undefined
  } catch {
    return parseSemver(trimmed) ? trimmed : undefined
  }
}

function grokUpdateVersions(value: string): { current?: string; latest?: string } | undefined {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const current = parsed.currentVersion ?? parsed.current
    const latest = parsed.latestVersion ?? parsed.latest
    if (typeof current !== 'string' || !parseSemver(current)) return undefined
    if (typeof latest !== 'string' || !parseSemver(latest)) return undefined
    if (typeof parsed.channel !== 'string' || parsed.channel.length > 64) return undefined
    if (parsed.updateAvailable !== undefined && typeof parsed.updateAvailable !== 'boolean') return undefined
    return { current, latest }
  } catch {
    return undefined
  }
}

function kimiUpdateVersions(value: string): { current: string; latest: string; selfUpdateSupported?: boolean } | undefined {
  const current = value.match(/^Kimi Code is already up to date \(v?([^()\s]+)\)\.\s*$/m)?.[1]
  if (current && parseSemver(current)) return { current, latest: current }
  const versions = value.match(/^A newer version of @moonshot-ai\/kimi-code is available \(([^()\s]+) -> ([^()\s]+)\)\.\s*$/m)
  const source = value.match(/^Detected install source: (.+)$/m)?.[1].trim()
  if (!versions || !parseSemver(versions[1]) || !parseSemver(versions[2]) || !source) return undefined
  return {
    current: versions[1], latest: versions[2],
    selfUpdateSupported: ['npm-global', 'pnpm-global', 'yarn-global', 'bun-global', 'native installer'].includes(source)
  }
}

function updateCheckFailure(result: RunResult): string {
  if (result.timedOut) return '检查更新超时，请检查网络后重试'
  const text = `${result.stdout} ${result.stderr}`.toLowerCase()
  if (/authentication failed|permission denied|publickey|could not read username|ssh key/.test(text)) {
    return '更新源认证失败，请检查账号或 SSH Key'
  }
  if (/could not resolve|unable to access|network error|enotfound|fetch failed|timed? out/.test(text)) {
    return '无法连接更新源，请检查网络或代理'
  }
  return '无法确认可用版本或安装来源'
}

function updateFailure(adapter: AdapterId, result: RunResult): string {
  if (result.timedOut) return '更新超时，请重试'
  const text = `${result.stdout} ${result.stderr}`
  if (adapter === 'claude' && /\bENOTEMPTY\b/i.test(text)) return 'Claude 更新目录存在旧版残留，自动隔离失败，请重试'
  if ((adapter === 'deepseek' || adapter === 'zcode') && result.stderr.trim()) return result.stderr.trim().split('\n')[0]
  return '更新失败'
}

function authRequired(result: RunResult): boolean {
  const text = `${result.stdout} ${result.stderr}`.toLowerCase()
  return /not logged|not authenticated|unauthenticated|login required|请.*登录|"loggedin"\s*:\s*false/.test(text)
}

export class AgentLifecycleService extends EventEmitter {
  private readonly runner: LifecycleRunner
  private readonly detect: AgentDetector
  private readonly resolveExecutable: ExecutableResolver
  private readonly moveFile: FileMover
  private readonly deepseekUpdate: DeepSeekUpdater
  private readonly zcodeSource: typeof getZCodeUpdateSource
  private readonly zcodeCheck: typeof checkZCodeUpdate
  private readonly zcodeUpdate: typeof updateZCodeRuntime
  private readonly beforeZCodeRuntimeSwitch: () => Promise<void>
  private cache: AgentDef[] = []
  private detectedAt = 0
  private detectGeneration = 0
  private detectFlight?: Promise<AgentDef[]>
  private startupFlight?: StartupDetection
  private readonly detectionVersions = new Map<string, number>()
  private readonly singleDetectFlights = new Map<string, Promise<AgentDef>>()
  private checkAllFlight?: { generation: number; flight: Promise<AgentDef[]> }
  private updateFlight?: Promise<AgentDef[]>
  private readonly checkFlights = new Map<string, { generation: number; flight: Promise<AgentDef> }>()
  private readonly updateFlights = new Map<string, Promise<AgentDef>>()
  private batchFailures: string[] = []

  constructor(options: {
    runner?: LifecycleRunner
    detect?: AgentDetector
    resolveExecutable?: ExecutableResolver
    moveFile?: FileMover
    deepseekUpdate?: DeepSeekUpdater
    zcodeSource?: typeof getZCodeUpdateSource
    zcodeCheck?: typeof checkZCodeUpdate
    zcodeUpdate?: typeof updateZCodeRuntime
    beforeZCodeRuntimeSwitch?: () => Promise<void>
  } = {}) {
    super()
    this.runner = options.runner || defaultRunner
    this.detect = options.detect || detectAgents
    this.resolveExecutable = options.resolveExecutable || realpath
    this.moveFile = options.moveFile || rename
    this.deepseekUpdate = options.deepseekUpdate || updateDeepSeekRuntime
    this.zcodeSource = options.zcodeSource || getZCodeUpdateSource
    this.zcodeCheck = options.zcodeCheck || checkZCodeUpdate
    this.zcodeUpdate = options.zcodeUpdate || updateZCodeRuntime
    this.beforeZCodeRuntimeSwitch = options.beforeZCodeRuntimeSwitch || (async () => {})
    if (!options.detect) this.cache = BUILTIN_AGENTS.map(pendingAgentDetection)
  }

  snapshot(): AgentDef[] { return this.cache }

  detectOne(agentId: string): Promise<AgentDef> {
    const existing = this.singleDetectFlights.get(agentId)
    if (existing) return existing
    const agent = this.cache.find(item => item.id === agentId)
    if (!agent) return Promise.reject(new Error('unknown_agent'))
    if (this.updateFlights.has(agentId)) return Promise.reject(new Error('agent_update_in_progress'))
    return this.startDetectOne(agent)
  }

  private startDetectOne(agent: AgentDef): Promise<AgentDef> {
    const agentId = agent.id
    const version = (this.detectionVersions.get(agentId) || 0) + 1
    this.detectionVersions.set(agentId, version)
    const flight = this.performDetectOne(agent, this.detectGeneration, version)
    this.singleDetectFlights.set(agentId, flight)
    void flight.finally(() => {
      if (this.singleDetectFlights.get(agentId) === flight) this.singleDetectFlights.delete(agentId)
    }).catch(() => { /* callers observe the original flight */ })
    return flight
  }

  private async performDetectOne(agent: AgentDef, generation: number, version: number): Promise<AgentDef> {
    this.replace(pendingAgentDetection(agent))
    this.progress(agent.id, 'detecting', '正在检测 Agent', agent)
    let detected: AgentDef
    try {
      const candidate = (await this.detect('all', agent.id)).find(item => item.id === agent.id)
      if (!candidate) throw new Error('未返回该 Agent 的检测结果，请重试。')
      const [verified] = await this.enrich([candidate])
      detected = verified
    } catch (error) { detected = this.retainReadyDetails(failedAgentDetection(agent, error)) }
    if (generation !== this.detectGeneration || this.detectionVersions.get(agent.id) !== version) return this.requireAgent(agent.id)
    this.replace(detected)
    this.progress(agent.id, detected.lifecycle?.detectionStatus === 'failed' ? 'failed' : 'completed', detected.lifecycle?.detectionError || detected.lifecycle?.message || 'Agent 检测完成', detected)
    return detected
  }

  detectAll(force = false): Promise<AgentDef[]> {
    if (this.detectFlight) return this.detectFlight
    if (this.updateFlights.size) return Promise.allSettled([...this.updateFlights.values()]).then(() => this.detectAll(force))
    if (!force && this.cache.length && Date.now() - this.detectedAt < 5000) return Promise.resolve(this.cache)
    const generation = ++this.detectGeneration
    const flight = this.performDetect(generation)
    this.detectFlight = flight
    void flight.finally(() => {
      if (this.detectFlight === flight) this.detectFlight = undefined
    }).catch(() => { /* callers observe the original flight */ })
    return flight
  }

  /**
   * Cold-start detection keeps slow ACP handshakes off the critical
   * path. Both scopes start immediately; core is published as soon as it is
   * ready, then protocol providers are merged without re-running core probes.
   */
  detectStartup(): StartupDetection {
    if (this.startupFlight) return this.startupFlight

    const generation = ++this.detectGeneration
    const versions = new Map(this.detectionVersions)
    this.beginDetection()
    // Invoke both detectors before awaiting either one. runDetect also turns a
    // synchronous custom-detector throw into an ordinary rejected flight.
    const enrichedCore = this.detectScope('core', generation, versions)
    const enrichedProtocol = this.detectScope('protocol', generation, versions)

    const core = enrichedCore.then((agents) => this.commitMergedDetection(generation, agents, versions))
    const protocol = Promise.all([enrichedCore, enrichedProtocol]).then(([, protocolAgents]) =>
      this.commitMergedDetection(generation, protocolAgents, versions)
    )
    const flight = { core, protocol } satisfies StartupDetection
    this.startupFlight = flight
    void Promise.allSettled([core, protocol]).then(() => {
      if (this.startupFlight === flight) this.startupFlight = undefined
    })
    return flight
  }

  private runDetect(scope: AgentDetectionScope, onDetected?: AgentDetectionObserver): Promise<AgentDef[]> {
    try {
      return Promise.resolve(this.detect(scope, undefined, onDetected))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private beginDetection(): void {
    this.cache = this.cache.map(pendingAgentDetection)
    this.progress('*', 'detecting', '正在准备 Agent，已就绪的 Agent 可正常使用')
  }

  private publishDetection(agent: AgentDef, generation: number, versions: Map<string, number>): AgentDef {
    if (generation !== this.detectGeneration || this.updateFlights.has(agent.id) ||
      (versions.get(agent.id) || 0) !== (this.detectionVersions.get(agent.id) || 0)) return this.cache.find(item => item.id === agent.id) || agent
    if (this.cache.some(item => item.id === agent.id)) this.replace(agent)
    else this.cache = [...this.cache, agent]
    this.progress(agent.id, agent.lifecycle?.detectionStatus === 'failed' ? 'failed' : 'completed', agent.lifecycle?.detectionError || 'Agent 检测完成', agent)
    return agent
  }

  private detectScope(scope: AgentDetectionScope, generation: number, versions: Map<string, number>): Promise<AgentDef[]> {
    const verified = new Map<string, Promise<AgentDef>>()
    const finish = (agent: AgentDef): Promise<AgentDef> => {
      let flight = verified.get(agent.id)
      if (!flight) {
        flight = this.enrich([agent]).then(([result]) => this.publishDetection(result, generation, versions))
        verified.set(agent.id, flight)
      }
      return flight
    }
    return this.runDetect(scope, async agent => { await finish(agent) })
      .then(detected => {
        if (generation === this.detectGeneration) {
          for (const agent of detected) if (!this.cache.some(item => item.id === agent.id)) this.cache = [...this.cache, pendingAgentDetection(agent)]
        }
        return Promise.all(detected.map(finish))
      })
      .catch(error => {
        for (const agent of this.cache) {
          if (matchesAgentDetectionScope(agent, scope) && agent.lifecycle?.detectionStatus === 'detecting') {
            this.publishDetection(this.retainReadyDetails(failedAgentDetection(agent, error)), generation, versions)
          }
        }
        throw error
      })
  }

  private async enrich(detected: AgentDef[]): Promise<AgentDef[]> {
    return Promise.all(detected.map(async (agent) => {
      if (agent.lifecycle?.detectionStatus === 'failed') return this.retainReadyDetails(agent)
      try {
        const lifecycle = await this.verify(agent)
        return this.retainReadyDetails({ ...agent, lifecycle: lifecycle.availability === 'unhealthy'
          ? { ...lifecycle, detectionStatus: 'failed' as const, detectionError: lifecycle.message || 'CLI 健康检查失败，请重试。' }
          : lifecycle })
      } catch (error) { return this.retainReadyDetails(failedAgentDetection(agent, error)) }
    }))
  }

  private retainReadyDetails(agent: AgentDef): AgentDef {
    const previous = this.cache.find(item => item.id === agent.id)
    const checked = previous?.lifecycle
    const lifecycle = agent.lifecycle
    if (lifecycle?.currentVersion && checked && previous?.bin === agent.bin &&
      lifecycle.currentVersion === checked.currentVersion && lifecycle.currentRevision === checked.currentRevision &&
      lifecycle.selfUpdateSupported !== false && ['current', 'available', 'failed'].includes(checked.updateStatus)) {
      agent = { ...agent, lifecycle: { ...lifecycle, updateStatus: checked.updateStatus,
        availableVersion: checked.availableVersion, availableRevision: checked.availableRevision,
        ...(checked.updateStatus === 'failed' && !lifecycle.message ? { message: checked.message } : {}) } }
    }
    if (agent.lifecycle?.detectionStatus !== 'failed') return agent
    const lastReadyAt = previous?.lifecycle?.availability === 'available' ? previous.lifecycle.checkedAt : previous?.lifecycle?.lastReadyAt
    if (!previous || !lastReadyAt) return agent
    return { ...agent, installed: previous.installed, models: previous.models, defaultModel: previous.defaultModel,
      capabilities: previous.capabilities, version: agent.version || previous.version, bin: agent.bin || previous.bin,
      lifecycle: { ...agent.lifecycle, lastReadyAt } }
  }

  private commitDetection(generation: number, detected: AgentDef[], versions: Map<string, number>): AgentDef[] {
    if (generation !== this.detectGeneration) return this.cache
    this.cache = detected.map(agent => !this.updateFlights.has(agent.id) && (versions.get(agent.id) || 0) === (this.detectionVersions.get(agent.id) || 0)
      ? agent : this.cache.find(item => item.id === agent.id) || agent)
    this.detectedAt = Date.now()
    return this.cache
  }

  private mergeAgents(core: AgentDef[], protocol: AgentDef[]): AgentDef[] {
    const updates = new Map(protocol.map(agent => [agent.id, agent]))
    const existing = new Set(core.map(agent => agent.id))
    return [...core.map(agent => updates.get(agent.id) || agent), ...protocol.filter(agent => !existing.has(agent.id))]
  }

  private commitMergedDetection(generation: number, protocol: AgentDef[], versions: Map<string, number>): AgentDef[] {
    if (generation !== this.detectGeneration) return this.cache
    // Merge into the latest cache, not the original core array. A lifecycle
    // check/update may have enriched a core row while ACP providers were probing;
    // the late background result must preserve that newer core state.
    return this.commitDetection(generation, this.mergeAgents(this.cache, protocol), versions)
  }

  private async performDetect(generation: number): Promise<AgentDef[]> {
    const versions = new Map(this.detectionVersions)
    this.beginDetection()
    const enriched = await this.detectScope('all', generation, versions)
    return this.commitDetection(generation, enriched, versions)
  }

  private async verify(agent: AgentDef): Promise<AgentLifecycleState> {
    const checkedAt = Date.now()
    
    if (agent.adapter === 'zcode') {
      const source = agent.installed ? await this.zcodeSource() : undefined
      return {
        availability: agent.incompatible ? 'unhealthy' : !agent.installed ? 'not-installed' : !agent.models.length ? 'needs-auth' : 'available',
        auth: agent.installed && !agent.models.length ? 'required' : 'unknown', health: agent.installed ? 'healthy' : agent.incompatible ? 'unhealthy' : 'unknown',
        selfUpdateSupported: !!source, updateStatus: 'idle', currentVersion: agent.version, currentRevision: source?.revision, checkedAt,
        ...(agent.unavailableReason ? { message: agent.unavailableReason } : {})
      }
    }
    if (!agent.installed) return {
      availability: agent.incompatible ? 'unhealthy' : 'not-installed',
      auth: 'unknown',
      health: agent.incompatible ? 'unhealthy' : 'unknown',
      selfUpdateSupported: undefined,
      updateStatus: 'idle',
      ...(agent.unavailableReason ? { message: agent.unavailableReason } : {}),
      checkedAt
    }
    if (agent.adapter === 'claude' && agent.incompatible) return {
      availability: 'unhealthy', auth: 'unknown', health: 'unhealthy', updateStatus: 'idle',
      currentVersion: agent.version, checkedAt, message: agent.unavailableReason || 'Claude SDK 初始化失败'
    }
    // Grok authentication and protocol health are established by the ACP
    // initialize + session/new probe. There is no non-interactive login-status
    // command, so lifecycle verification must not invoke the interactive login.
    if (agent.adapter === 'grok' || agent.adapter === 'kimi' || agent.adapter === 'deepseek' || agent.adapter === 'mcode') {
      const updateHelp = agent.adapter === 'kimi'
        ? await this.runner(agent.bin, { args: ['upgrade', '--help'], timeoutMs: 8000, cwd: tmpdir() })
        : undefined
      return {
        availability: agent.authenticationRequired ? 'needs-auth' : agent.incompatible ? 'unhealthy' : 'available',
        auth: agent.authenticationRequired ? 'required' : agent.incompatible ? 'unknown' : 'authenticated',
        health: agent.incompatible ? 'unhealthy' : 'healthy',
        // DeepSeek 使用受管安装；其它 CLI 使用原生更新入口。
        selfUpdateSupported: !updateHelp || (updateHelp.code === 0 && /--yes\b/.test(updateHelp.stdout)),
        currentVersion: versionText(agent.version || '') || agent.version,
        updateStatus: 'idle',
        ...(agent.unavailableReason ? { message: agent.unavailableReason } : {}),
        checkedAt
      }
    }
    const adapter = adapterFor(agent)
    if (!adapter || adapter === 'zcode') return {
      availability: 'unhealthy', auth: 'unknown', health: 'unhealthy', updateStatus: 'idle',
      message: '不支持的 Agent 适配器', checkedAt
    }
    const [auth, health] = await Promise.all([
      this.runner(agent.bin, { ...COMMANDS[adapter].auth, env: nativeCredentialEnv(agent.adapter) }),
      this.runner(agent.bin, COMMANDS[adapter].health)
    ])
    const configuredSource = agent.adapter === 'claude' && agent.models.some(model => model.modelSource?.kind === 'third-party')
      || agent.adapter === 'codex' && (agent.authenticationRequired === false || agent.models.some(model => model.modelSource?.kind === 'third-party' || model.modelSource?.kind === 'local'))
    if ((auth.code !== 0 || auth.timedOut) && !authRequired(auth) && !configuredSource) return {
      availability: 'unhealthy', auth: 'unknown', health: health.code === 0 ? 'healthy' : 'unhealthy',
      currentVersion: versionText(agent.version || '') || agent.version, updateStatus: 'idle', checkedAt,
      message: '认证检测失败，请检查网络、配置与程序权限后重试；原连接已保留'
    }
    if (authRequired(auth) && !configuredSource) return {
      availability: 'needs-auth', auth: 'required',
      health: health.code === 0 ? 'healthy' : 'unhealthy',
      currentVersion: versionText(agent.version || '') || agent.version,
      updateStatus: 'idle', message: 'CLI 已安装，需要登录', checkedAt
    }
    const healthVersion = versionText(`${health.stdout} ${health.stderr}`)
    const healthy = health.code === 0 && !!healthVersion
    return {
      availability: healthy ? 'available' : 'unhealthy', auth: authRequired(auth) ? 'unknown' : 'authenticated',
      health: healthy ? 'healthy' : 'unhealthy',
      currentVersion: healthVersion || versionText(agent.version || '') || agent.version,
      updateStatus: 'idle', ...(healthy ? {} : { message: 'CLI 健康检查失败' }), checkedAt
    }
  }

  async checkUpdate(agentId: string): Promise<AgentDef> {
    return this.startCheckUpdate(agentId, false, this.detectGeneration)
  }

  /** Check supported CLI versions without re-running availability probes. */
  async checkAllUpdates(): Promise<AgentDef[]> {
    const generation = this.detectGeneration
    if (this.checkAllFlight?.generation === generation) return this.checkAllFlight.flight
    const flight = this.performCheckAllUpdates(generation)
    const entry = { generation, flight }
    this.checkAllFlight = entry
    void flight.finally(() => {
      if (this.checkAllFlight === entry) this.checkAllFlight = undefined
    }).catch(() => { /* callers observe the original flight */ })
    return flight
  }

  private async performCheckAllUpdates(generation: number): Promise<AgentDef[]> {
    const targets = this.cache
      .filter((agent) => {
        if (agent.lifecycle?.availability !== 'available' && !(agent.adapter === 'deepseek' && agent.installed)) return false
        if (agent.lifecycle?.selfUpdateSupported === false) return false
        return !!adapterFor(agent)
      })
      .map((agent) => agent.id)
    await Promise.allSettled(targets.map((id) => this.startCheckUpdate(id, true, generation)))
    return this.cache
  }

  private startCheckUpdate(agentId: string, silent: boolean, generation: number): Promise<AgentDef> {
    const detecting = this.singleDetectFlights.get(agentId)
    if (detecting) return detecting.then(() => this.startCheckUpdate(agentId, silent, this.detectGeneration))
    const updating = this.updateFlights.get(agentId)
    if (updating) return updating
    const existing = this.checkFlights.get(agentId)
    if (existing?.generation === generation) return existing.flight
    const flight = this.performCheckUpdate(this.requireAgent(agentId), silent, generation)
    const entry = { generation, flight }
    this.checkFlights.set(agentId, entry)
    void flight.finally(() => {
      if (this.checkFlights.get(agentId) === entry) this.checkFlights.delete(agentId)
    }).catch(() => { /* callers observe the original flight */ })
    return flight
  }

  private async performCheckUpdate(agent: AgentDef, silent: boolean, generation: number): Promise<AgentDef> {
    const agentId = agent.id
    const detectionVersion = this.detectionVersions.get(agentId)
    if (agent.lifecycle?.selfUpdateSupported === false) {
      throw new Error('agent_update_unsupported')
    }
    const adapter = adapterFor(agent)
    if (!adapter || !agent.installed) throw new Error('agent_not_available')
    const { availableVersion: _checkingAvailableVersion, availableRevision: _checkingAvailableRevision, message: _checkingMessage, ...checkingLifecycle } = agent.lifecycle || await this.verify(agent)
    const checking = this.replace({
      ...agent,
      lifecycle: { ...checkingLifecycle, updateStatus: 'checking', checkedAt: Date.now() }
    })
    if (!silent) this.progress(agentId, 'checking-update', '正在检查更新', checking)
    if (adapter === 'zcode') {
      let lifecycle: AgentLifecycleState
      try {
        const info = await this.zcodeCheck()
        lifecycle = { ...checkingLifecycle, currentRevision: info.currentRevision, availableRevision: info.availableRevision,
          availableVersion: info.availableVersion, updateStatus: info.updateAvailable ? 'available' : 'current', checkedAt: Date.now() }
      } catch (error) {
        lifecycle = { ...checkingLifecycle, updateStatus: 'failed', checkedAt: Date.now(),
          message: error instanceof Error ? error.message : 'ZCode 检查更新失败，请重试' }
      }
      if (generation !== this.detectGeneration || detectionVersion !== this.detectionVersions.get(agentId) || this.updateFlights.has(agentId)) return this.requireAgent(agentId)
      const updated = this.replace({ ...agent, lifecycle })
      if (!silent) this.progress(agentId, lifecycle.updateStatus === 'failed' ? 'failed' : 'completed', lifecycle.message || '检查更新完成', updated)
      return updated
    }
    const result = await this.runner(checkExecutable(adapter, agent), COMMANDS[adapter].checkUpdate)
    if (generation !== this.detectGeneration || detectionVersion !== this.detectionVersions.get(agentId)) return this.requireAgent(agentId)
    const parsedGrok = adapter === 'grok' && result.code === 0 ? grokUpdateVersions(result.stdout) : undefined
    const parsedKimi = adapter === 'kimi' && result.code === 0 ? kimiUpdateVersions(result.stdout) : undefined
    const parsedRegistry = (adapter === 'codex' || adapter === 'claude' || adapter === 'deepseek' || adapter === 'mcode') && result.code === 0
      ? registryVersionText(result.stdout)
      : undefined
    const parsedOutput = adapter === 'grok' || adapter === 'kimi'
      ? !!(parsedGrok || parsedKimi)
      : adapter === 'codex' || adapter === 'claude' || adapter === 'deepseek' || adapter === 'mcode'
        ? !!parsedRegistry
        : true
    const current = parsedGrok?.current || parsedKimi?.current || versionText(agent.lifecycle?.currentVersion || '') || versionText(agent.version || '')
    const text = `${result.stdout} ${result.stderr}`
    const available = adapter === 'grok' || adapter === 'kimi'
      ? parsedGrok?.latest || parsedKimi?.latest
      : adapter === 'codex' || adapter === 'claude' || adapter === 'deepseek' || adapter === 'mcode'
        ? parsedRegistry
        : latestVersionText(text)
    const updateAvailable = compareSemver(available, current) === 1 ||
      (adapter === 'deepseek' && agent.incompatible === true && available === DEEPSEEK_VERIFIED_VERSION && current !== available)
    const success = result.code === 0 && parsedOutput
    const { availableVersion: _staleAvailableVersion, message: _staleMessage, ...previousLifecycle } = agent.lifecycle || await this.verify(agent)
    const lifecycle: AgentLifecycleState = {
      ...previousLifecycle, currentVersion: current,
      ...(parsedKimi?.selfUpdateSupported !== undefined ? { selfUpdateSupported: parsedKimi.selfUpdateSupported } : {}),
      ...(available ? { availableVersion: available } : {}),
      updateStatus: success ? (updateAvailable ? 'available' : 'current') : 'failed',
      ...(success ? {} : { message: updateCheckFailure(result) }), checkedAt: Date.now()
    }
    const updated = this.replace({ ...agent, lifecycle })
    if (!silent) this.progress(agentId, success ? 'completed' : 'failed', success ? '检查更新完成' : lifecycle.message || '检查更新失败', updated)
    return updated
  }

  updateAll(agentIds: string[], isActive: (id: string) => boolean): Promise<AgentDef[]> {
    if (this.updateFlight) return this.updateFlight
    this.updateFlight = this.performUpdates(agentIds, isActive).finally(() => { this.updateFlight = undefined })
    return this.updateFlight
  }

  private async performUpdates(agentIds: string[], isActive: (id: string) => boolean): Promise<AgentDef[]> {
    this.batchFailures = []
    for (const id of agentIds) {
      try { await this.updateOne(id, isActive) } catch {
        this.batchFailures.push(id)
        this.progress(id, 'failed', '启动更新失败')
      }
    }
    return this.checkAllUpdates()
  }

  lastBatchFailures(): string[] { return [...this.batchFailures] }

  updateOne(agentId: string, isActive: (id: string) => boolean): Promise<AgentDef> {
    if (isActive(agentId)) return Promise.reject(new Error('agent_has_active_session'))
    if (this.singleDetectFlights.has(agentId)) return Promise.reject(new Error('agent_detection_in_progress'))
    const existing = this.updateFlights.get(agentId)
    if (existing) return existing
    const flight = this.performUpdateOne(agentId, isActive).finally(() => { this.updateFlights.delete(agentId) })
    this.updateFlights.set(agentId, flight)
    return flight
  }

  isUpdating(agentId: string): boolean { return this.updateFlights.has(agentId) }

  private async performUpdateOne(agentId: string, isActive: (id: string) => boolean): Promise<AgentDef> {
    if (isActive(agentId)) throw new Error('agent_has_active_session')
    let agent = this.requireAgent(agentId)
    if (agent.lifecycle?.selfUpdateSupported === false) {
      throw new Error('agent_update_unsupported')
    }
    const adapter = adapterFor(agent)
    if (!adapter || !agent.lifecycle || (agent.lifecycle.availability !== 'available' && !(adapter === 'deepseek' && agent.installed))) throw new Error('agent_not_available')
    let kimiAlreadyCurrent = false
    if (adapter === 'kimi') {
      // Batch updates may arrive without a prior check. The official command
      // exits successfully even when it only prints manual install instructions.
      await this.checkFlights.get(agentId)?.flight
      agent = await this.performCheckUpdate(this.requireAgent(agentId), false, this.detectGeneration)
      if (agent.lifecycle?.selfUpdateSupported === false) throw new Error('agent_update_unsupported')
      if (agent.lifecycle?.updateStatus === 'failed') throw new Error(agent.lifecycle.message || '检查更新失败')
      kimiAlreadyCurrent = agent.lifecycle?.updateStatus === 'current'
      if (!agent.lifecycle || !['available', 'current'].includes(agent.lifecycle.updateStatus)) throw new Error('agent_not_available')
      if (isActive(agentId)) throw new Error('agent_has_active_session')
    }
    const { availableVersion: _updatingAvailableVersion, availableRevision: _updatingAvailableRevision, message: _updatingMessage, ...updatingLifecycle } = agent.lifecycle
    const updating = this.replace({
      ...agent,
      lifecycle: { ...updatingLifecycle, ...(adapter === 'zcode' ? { availableVersion: agent.lifecycle.availableVersion, availableRevision: agent.lifecycle.availableRevision } : {}),
        updateStatus: 'updating', checkedAt: Date.now() }
    })
    this.progress(agentId, 'updating', '正在更新 CLI', updating)
    let result: RunResult
    let updatedRevision: string | undefined
    let updatedKimiVersion: string | undefined
    if (adapter === 'zcode') {
      try {
        updatedRevision = await this.zcodeUpdate(agent.lifecycle.availableRevision, async () => {
          if (isActive(agentId)) throw new Error('agent_has_active_session')
          await this.beforeZCodeRuntimeSwitch()
        }, (message) => {
          const current = this.requireAgent(agentId)
          const next = this.replace({ ...current, lifecycle: { ...current.lifecycle!, updateStatus: 'updating', message, checkedAt: Date.now() } })
          this.progress(agentId, 'updating', message, next)
        })
        result = { code: 0, stdout: '', stderr: '' }
      } catch (error) {
        result = { code: 1, stdout: '', stderr: error instanceof Error ? error.message : 'ZCode 更新失败，请重试' }
      }
    } else if (adapter === 'deepseek') {
      // DeepSeek Harness 没有自带的自更新命令；更新就是把 UniAgent 托管的
      // runtime 重新安装到 UniAgent 已验证的 registry 版本。
      result = await this.deepseekUpdate(agent.lifecycle?.availableVersion)
    } else {
      let update: UpdateCommand = { bin: agent.bin, spec: COMMANDS[adapter].update }
      if (adapter === 'claude') {
        const resolvedBin = await this.resolveExecutable(agent.bin).catch(() => agent.bin)
        update = claudeNpmGlobalUpdate(resolvedBin, agent.lifecycle.availableVersion) || update
      }
      result = kimiAlreadyCurrent ? { code: 0, stdout: '', stderr: '' } : await this.runner(update.bin, update.spec)
      const staleDirectory = update.npmPrefix && staleClaudeNpmDirectory(update.npmPrefix, result)
      if (staleDirectory) {
        const quarantine = `${staleDirectory}.uniagent-stale-${Date.now()}`
        const moved = await this.moveFile(staleDirectory, quarantine).then(() => true, () => false)
        if (moved) result = await this.runner(update.bin, update.spec)
      }
    }
    if (adapter === 'kimi' && result.code === 0) {
      // Native upgrades stage a binary until the next CLI launch. Verify that
      // executable even if detection reuses an already-running Web service.
      const health = await this.runner(agent.bin, { ...COMMANDS.kimi.health, cwd: tmpdir() })
      updatedKimiVersion = versionText(health.stdout)
      if (health.code !== 0 || !parseSemver(updatedKimiVersion)) result = { ...health, code: 1 }
    }
    if (result.code !== 0) {
      const message = updateFailure(adapter, result)
      const failed = this.replace({ ...updating, lifecycle: { ...updatingLifecycle, updateStatus: 'failed', message, checkedAt: Date.now() } })
      this.progress(agentId, 'failed', message, failed)
      throw new Error(message)
    }
    this.progress(agentId, 'verifying', '正在重新验证 CLI', agent)
    // Other agents may still be checking versions or replacing executables.
    // Reuse scoped detection so verification cannot reset their lifecycle state.
    const verified = await this.startDetectOne(this.requireAgent(agentId))
    if (verified.lifecycle?.availability !== 'available') {
      if (adapter !== 'deepseek' && adapter !== 'kimi') throw new Error('agent_verification_failed')
      const message = verified.unavailableReason || '更新后验证失败，请重新检查 Agent 状态'
      const failed = this.replace({ ...verified, lifecycle: { ...verified.lifecycle!, updateStatus: 'failed', message, checkedAt: Date.now() } })
      this.progress(agentId, 'failed', message, failed)
      throw new Error(message)
    }
    const currentVersion = verified.lifecycle.currentVersion
    if ((adapter === 'codex' || adapter === 'kimi' || adapter === 'deepseek' || adapter === 'mcode') && compareSemver(currentVersion, agent.lifecycle.availableVersion) === -1 ||
      adapter === 'kimi' && currentVersion !== updatedKimiVersion) {
      const message = `更新未生效，当前版本仍为 ${currentVersion}${adapter === 'kimi' ? '；如另有 Kimi 服务运行，请结束其任务并重启该服务后刷新状态' : ''}`
      const failed = this.replace({ ...verified, lifecycle: {
        ...verified.lifecycle, updateStatus: 'failed', availableVersion: agent.lifecycle.availableVersion, message, checkedAt: Date.now()
      } })
      this.progress(agentId, 'failed', message, failed)
      throw new Error(message)
    }
    if (adapter === 'zcode' && verified.lifecycle.currentRevision !== updatedRevision) {
      const message = 'ZCode 更新未生效，请重新检查运行时'
      const failed = this.replace({ ...verified, lifecycle: { ...verified.lifecycle, updateStatus: 'failed', message, checkedAt: Date.now() } })
      this.progress(agentId, 'failed', message, failed)
      throw new Error(message)
    }
    const completed = this.replace({
      ...verified,
      lifecycle: {
        ...verified.lifecycle,
        updateStatus: 'current',
        availableVersion: undefined,
        availableRevision: undefined,
        message: undefined,
        checkedAt: Date.now()
      }
    })
    this.progress(agentId, 'completed', '更新完成', completed)
    return completed
  }

  private requireAgent(id: string): AgentDef {
    const agent = this.cache.find((item) => item.id === id)
    if (!agent) throw new Error('unknown_agent')
    return agent
  }

  private replace(agent: AgentDef): AgentDef {
    this.cache = this.cache.map((item) => item.id === agent.id ? agent : item)
    return agent
  }

  private progress(agentId: string, phase: AgentLifecycleProgress['phase'], message: string, agent?: AgentDef): void {
    this.emit('progress', { agentId, phase, message, currentVersion: agent?.lifecycle?.currentVersion, availableVersion: agent?.lifecycle?.availableVersion } satisfies AgentLifecycleProgress)
  }
}

export function lifecycleCommandWhitelist(): Readonly<typeof COMMANDS> { return COMMANDS }
