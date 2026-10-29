import { AppServerRpcClient, type AppServerRpc } from './appServerTransport.ts'
import { ClaudeSdkClient } from './claudeSdk'
import { nativeCredentialEnv } from './agentSetupCredentials'
import { agentForSession, type AgentDef, type ReasoningEffort, type Session } from '../shared/types.ts'
import {
  emptyNativeCapabilitySnapshot,
  withMcpStartupStatus,
  type McpStartupStatus,
  type NativeCommandCandidate,
  type NativeCapabilitySnapshot,
  type NativeCapabilityRequest,
  type NativeMcpCandidate,
  type NativeSkillCandidate,
  type NativeTurnSelectionRequest,
  type ResolvedNativeTurnContext
} from '../shared/nativeCapabilities.ts'

const SUCCESS_CACHE_MS = 30_000
const FAILURE_CACHE_MS = 5_000
const DEFAULT_MCP_SELECTION_SETTLE_MS = 5_000
const DEFAULT_MCP_SELECTION_POLL_MS = 100

type CachedSnapshot = { expiresAt: number; snapshot: NativeCapabilitySnapshot }
type ScopeState = { agentId: string; workdir: string; generation: number; latestRequest: number }
type CapabilityClientFactory = (agent: AgentDef, workdir: string) => AppServerRpc
type NativeCapabilityServiceOptions = {
  mcpSelectionSettleMs?: number
  mcpSelectionPollMs?: number
  discoverZCode?: (workdir: string, sessionId?: string) => Promise<NativeCapabilitySnapshot>
}

class McpSelectionSettleTimeout extends Error {}

export function resolveNativeCapabilityAgent(
  agent: AgentDef,
  request: NativeCapabilityRequest,
  getSession: (sessionId: string) => Session | undefined
): AgentDef {
  if (!request.sessionId) return agent
  const session = getSession(request.sessionId)
  if (
    !session ||
    session.config.agentId !== request.agentId ||
    session.config.workdir !== request.workdir
  ) {
    throw new Error('invalid_native_capability_session')
  }
  return agentForSession(agent, session)
}

/**
 * Reads the provider's own capability catalog. This is intentionally process-local:
 * candidates are a live provider view rather than session state.
 */
export class NativeCapabilityService {
  private cache = new Map<string, CachedSnapshot>()
  private inFlight = new Map<string, { generation: number; promise: Promise<NativeCapabilitySnapshot> }>()
  private scopes = new Map<string, ScopeState>()
  private mcpStatusOverlay = new Map<string, { status: McpStartupStatus; statusMessage?: string }>()

  constructor(
    private readonly createClient: CapabilityClientFactory = createCapabilityClient,
    private readonly options: NativeCapabilityServiceOptions = {}
  ) {}

  /** Read local CLI reports; no user message or model turn is submitted. */
  async queryClaudeUsage(agent: AgentDef, workdir: string, nativeSessionId?: string): Promise<{ contextUsage: any; usageReport: any }> {
    if (agent.adapter !== 'claude') throw new Error('Claude 原生用量查询需要 Claude 会话')
    const reports = await queryClaudeControls(agent, workdir, [
      { subtype: 'get_context_usage', detail: 'summary' },
      { subtype: 'get_usage', skip_behaviors: true }
    ], nativeSessionId)
    return { contextUsage: reports[1], usageReport: reports[2] }
  }

  async discover(
    agent: AgentDef,
    workdir: string,
    force = false,
    settleMcpIds: readonly string[] = [],
    sessionId?: string
  ): Promise<NativeCapabilitySnapshot> {
    if (agent.adapter === 'zcode') return this.options.discoverZCode?.(workdir, sessionId) ?? emptyNativeCapabilitySnapshot(agent.id, workdir)
    if (agent.adapter === 'grok' || agent.adapter === 'kimi' || agent.adapter === 'deepseek') {
      return normalizeGrokNativeSnapshot(agent, workdir)
    }
    if (agent.adapter !== 'codex' && agent.adapter !== 'traex' && agent.adapter !== 'claude') {
      return emptyNativeCapabilitySnapshot(agent.id, workdir)
    }
    const key = JSON.stringify([agent.id, agent.bin, agent.version || '', workdir])
    const cached = this.cache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot
    const scope = this.scopeFor(key, agent.id, workdir)
    const generation = scope.generation
    const flightKey = JSON.stringify([key, [...new Set(settleMcpIds)].sort()])
    const active = this.inFlight.get(flightKey)
    if (active) {
      if (active.generation === generation) return active.promise
      // An invalidation needs fresh data, but must not overlap another process.
      await active.promise.catch(() => undefined)
      return this.discover(agent, workdir, true, settleMcpIds, sessionId)
    }
    const promise = this.probe(agent, workdir, force, settleMcpIds, key, scope, generation)
      .then(snapshot => this.applyMcpOverlays(snapshot))
      .finally(() => {
        if (this.inFlight.get(flightKey)?.promise === promise) this.inFlight.delete(flightKey)
      })
    this.inFlight.set(flightKey, { generation, promise })
    return promise
  }

  private async probe(agent: AgentDef, workdir: string, force: boolean, settleMcpIds: readonly string[],
    key: string, scope: ScopeState, generation: number): Promise<NativeCapabilitySnapshot> {
    const request = ++scope.latestRequest

    if (agent.adapter === 'claude') {
      const snapshot = await discoverClaudeNativeSnapshot(agent, workdir)
      this.cacheIfCurrent(key, scope, generation, request, snapshot.errors.length ? FAILURE_CACHE_MS : SUCCESS_CACHE_MS, snapshot)
      return snapshot
    }

    const client = this.createClient(agent, workdir)
    try {
      await client.start()
      await client.request('initialize', {
        clientInfo: { name: 'uniagent-capability-probe', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      })
      client.notify('initialized', {})
      const [skills, mcpServers, modes] = await Promise.allSettled([
        client.request('skills/list', { cwds: [workdir], forceReload: force }),
        this.listAllMcpServers(client, new Set(settleMcpIds)),
        client.request('collaborationMode/list', {})
      ])
      const snapshot = this.applyMcpOverlays(
        normalizeNativeSnapshot(
          agent.id,
          workdir,
          skills.status === 'fulfilled' ? skills.value : undefined,
          mcpServers.status === 'fulfilled' ? mcpServers.value : [],
          modes.status === 'fulfilled' ? modes.value : undefined
        )
      )
      snapshot.errors = [skills, mcpServers, modes].flatMap((result) =>
        result.status === 'rejected'
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : []
      )
      this.cacheIfCurrent(key, scope, generation, request, snapshot.errors.length ? FAILURE_CACHE_MS : SUCCESS_CACHE_MS, snapshot)
      return snapshot
    } catch (error) {
      const snapshot = emptyNativeCapabilitySnapshot(agent.id, workdir)
      snapshot.errors = [error instanceof Error ? error.message : String(error)]
      this.cacheIfCurrent(key, scope, generation, request, FAILURE_CACHE_MS, snapshot)
      return snapshot
    } finally {
      await client.dispose()
    }
  }

  async resolveSelection(
    agent: AgentDef,
    workdir: string,
    request: NativeTurnSelectionRequest,
    sessionId?: string
  ): Promise<ResolvedNativeTurnContext | undefined> {
    if (request.candidateIds.length === 0) return undefined
    if (request.candidateIds.some((id) => id.startsWith('command:'))) {
      throw new Error('原生命令必须作为提示词发送')
    }
    const snapshot = await this.discover(
      agent,
      workdir,
      true,
      request.candidateIds.filter((id) => id.startsWith('mcp:')),
      sessionId
    )
    const byId = new Map(snapshot.candidates.map((candidate) => [candidate.id, candidate]))
    const selected = request.candidateIds.map((id) => {
      const candidate = byId.get(id)
      if (!candidate) throw new Error(`原生能力候选已失效：${id}`)
      if (candidate.kind === 'mcp' && candidate.startupStatus !== 'ready') {
        throw new Error(`MCP Server 当前不可用：${candidate.name}`)
      }
      return candidate
    })
    return {
      skills: selected
        .filter((candidate): candidate is NativeSkillCandidate => candidate.kind === 'skill')
        .map(({ name, path }) => ({ name, path })),
      mcpServers: selected
        .filter((candidate): candidate is NativeMcpCandidate => candidate.kind === 'mcp')
        .map(({ name }) => ({ name }))
    }
  }

  invalidate(agentId: string, workdir: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.snapshot.agentId === agentId && entry.snapshot.workdir === workdir) this.cache.delete(key)
    }
    for (const [key, scope] of this.scopes) {
      if (scope.agentId === agentId && scope.workdir === workdir) {
        scope.generation++
        this.cache.delete(key)
      }
    }
  }

  applyMcpStatus(
    agentId: string,
    workdir: string,
    name: string,
    status: McpStartupStatus,
    statusMessage?: string
  ): boolean {
    const serverName = name.trim()
    if (
      !serverName ||
      (status !== 'starting' && status !== 'ready' && status !== 'failed' &&
        status !== 'cancelled' && status !== 'auth-required')
    ) return false
    const key = JSON.stringify([agentId, workdir, serverName])
    const previous = this.mcpStatusOverlay.get(key)
    if (previous?.status === status && previous.statusMessage === statusMessage) return false
    this.mcpStatusOverlay.set(
      key,
      { status, ...(statusMessage ? { statusMessage } : {}) }
    )
    for (const entry of this.cache.values()) {
      if (entry.snapshot.agentId === agentId && entry.snapshot.workdir === workdir) {
        entry.snapshot = this.applyMcpOverlays(entry.snapshot)
      }
    }
    return true
  }

  private applyMcpOverlays(snapshot: NativeCapabilitySnapshot): NativeCapabilitySnapshot {
    return {
      ...snapshot,
      candidates: snapshot.candidates.map((candidate) => {
        if (candidate.kind !== 'mcp') return candidate
        const overlay = this.mcpStatusOverlay.get(
          JSON.stringify([snapshot.agentId, snapshot.workdir, candidate.name])
        )
        return overlay ? withMcpStartupStatus(candidate, { name: candidate.name, ...overlay }) : candidate
      })
    }
  }

  private scopeFor(key: string, agentId: string, workdir: string): ScopeState {
    let scope = this.scopes.get(key)
    if (!scope) {
      scope = { agentId, workdir, generation: 0, latestRequest: 0 }
      this.scopes.set(key, scope)
    }
    return scope
  }

  private cacheIfCurrent(
    key: string,
    scope: ScopeState,
    generation: number,
    request: number,
    ttl: number,
    snapshot: NativeCapabilitySnapshot
  ): void {
    if (scope.generation === generation && scope.latestRequest === request) {
      this.cache.set(key, { expiresAt: Date.now() + ttl, snapshot })
    }
  }

  private async listAllMcpServers(
    client: AppServerRpc,
    settleMcpIds: ReadonlySet<string>
  ): Promise<unknown[]> {
    const deadline = settleMcpIds.size > 0
      ? Date.now() + positiveDuration(this.options.mcpSelectionSettleMs, DEFAULT_MCP_SELECTION_SETTLE_MS)
      : undefined
    let servers = await this.listMcpServerPages(client, deadline)
    if (!deadline) return servers
    while (selectedMcpIsStarting(servers, settleMcpIds) && Date.now() < deadline) {
      const remainingMs = deadline - Date.now()
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(positiveDuration(this.options.mcpSelectionPollMs, DEFAULT_MCP_SELECTION_POLL_MS), remainingMs)
      ))
      try {
        servers = await this.listMcpServerPages(client, deadline)
      } catch (error) {
        if (error instanceof McpSelectionSettleTimeout) return servers
        throw error
      }
    }
    return servers
  }

  private async listMcpServerPages(client: AppServerRpc, deadline?: number): Promise<unknown[]> {
    const servers: unknown[] = []
    let cursor: string | null = null
    do {
      const page = asRecord(await requestBeforeDeadline(
        () => client.request<unknown>('mcpServerStatus/list', {
          cursor,
          limit: 100,
          detail: 'toolsAndAuthOnly'
        }),
        deadline
      ))
      if (Array.isArray(page?.data)) servers.push(...page.data)
      cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
    } while (cursor)
    return servers
  }
}

async function discoverClaudeNativeSnapshot(agent: AgentDef, workdir: string): Promise<NativeCapabilitySnapshot> {
  const empty = emptyNativeCapabilitySnapshot(agent.id, workdir)
  try {
    const reports = await queryClaudeControls(agent, workdir, [{ subtype: 'mcp_status' }])
    return normalizeClaudeNativeSnapshot(agent.id, workdir, reports[0], reports[1])
  } catch (error) {
    return { ...empty, errors: [error instanceof Error ? error.message : String(error)] }
  }
}

async function queryClaudeControls(
  agent: AgentDef, workdir: string, requests: Array<Record<string, unknown>>, nativeSessionId?: string
): Promise<any[]> {
  const client = new ClaudeSdkClient({ options: {
    pathToClaudeCodeExecutable: agent.bin, cwd: workdir,
    env: { ...process.env, ...nativeCredentialEnv('claude') },
    ...(nativeSessionId ? { resume: nativeSessionId } : {}),
    persistSession: false, settings: { disableAllHooks: true }, permissionMode: 'default'
  }, initializeTimeoutMs: 10_000 })
  try {
    const reports: any[] = [await client.ready]
    for (const request of requests) {
      const method = request.subtype === 'mcp_status' ? 'mcp'
        : request.subtype === 'get_context_usage' ? 'context' : request.subtype === 'get_usage' ? 'usage' : undefined
      if (!method) throw new Error('不支持的 Claude SDK 查询')
      let report = await client.request(method)
      const deadline = Date.now() + DEFAULT_MCP_SELECTION_SETTLE_MS
      while (method === 'mcp' && report.mcpServers?.some((server: any) => server.status === 'pending') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, DEFAULT_MCP_SELECTION_POLL_MS))
        report = await client.request(method)
      }
      reports.push(report)
    }
    return reports
  } finally { await client.close() }
}

export function normalizeClaudeNativeSnapshot(
  agentId: string, workdir: string, initialized: any, status: any
): NativeCapabilitySnapshot {
  const commands: NativeCommandCandidate[] = (Array.isArray(initialized?.commands) ? initialized.commands : [])
    .flatMap((item: any): NativeCommandCandidate[] => {
      const name = String(item?.name || '').replace(/^\/+/, '').trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) return []
      return [{
        id: `command:${name}`, kind: 'command', name, command: `/${name}`,
        description: typeof item.description === 'string' ? item.description : undefined
      }]
    })
  const servers = (Array.isArray(status?.mcpServers) ? status.mcpServers : [])
    .flatMap((item: any): NativeMcpCandidate[] => {
      if (typeof item?.name !== 'string' || !item.name || item.name === 'uniagent') return []
      const state = String(item.status || '').toLowerCase()
      return [{
        id: `mcp:${item.name}`, kind: 'mcp', name: item.name,
        authStatus: state === 'needs-auth' ? 'notLoggedIn' : 'unknown',
        startupStatus: state === 'connected' || state === 'ready' ? 'ready'
          : state === 'needs-auth' ? 'auth-required'
            : state === 'disabled' ? 'cancelled'
              : state === 'failed' ? 'failed' : 'starting',
        statusMessage: stringAt(item.error) || stringAt(item.statusMessage),
        toolNames: [...new Set<string>((Array.isArray(item.tools) ? item.tools : [])
          .flatMap((tool: any) => typeof tool?.name === 'string' && tool.name ? [tool.name] : []))].sort()
      }]
    })
  return {
    agentId, workdir, source: 'provider-native',
    candidates: [...commands, ...servers],
    actions: { goal: commands.some(command => command.name === 'goal'), review: commands.some(command => command.name === 'code-review'), plan: null }, errors: []
  }
}

export function normalizeGrokNativeSnapshot(
  agent: AgentDef,
  workdir: string
): NativeCapabilitySnapshot {
  const commands = [...new Set((agent.capabilities.commands || [])
    .map((command) => command.replace(/^\/+/, '').trim())
    .filter((command) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(command)))]
    .map((command): NativeCommandCandidate => ({
      id: `command:${command}`,
      kind: 'command',
      name: command,
      command: `/${command}`
    }))
  const currentModel = agent.models.find((model) => model.id === agent.defaultModel)
  const supportsPlan = agent.capabilities.collaborationModes?.includes('plan') === true
  return {
    agentId: agent.id,
    workdir,
    source: 'provider-native',
    candidates: commands,
    actions: {
      goal: agent.capabilities.nativeGoal === true,
      review: agent.capabilities.nativeReview === true,
      plan: supportsPlan
        ? {
            id: 'plan',
            name: 'Plan',
            model: agent.defaultModel || null,
            reasoningEffort: currentModel?.defaultEffort || null
          }
        : null
    },
    errors: []
  }
}

async function requestBeforeDeadline<T>(request: () => Promise<T>, deadline?: number): Promise<T> {
  if (deadline === undefined) return request()
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new McpSelectionSettleTimeout('MCP Server 启动状态检查超时')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new McpSelectionSettleTimeout('MCP Server 启动状态检查超时')),
          remainingMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function selectedMcpIsStarting(servers: unknown[], selectedIds: ReadonlySet<string>): boolean {
  return servers.some((server) => {
    const value = asRecord(server)
    if (!value || typeof value.name !== 'string' || !selectedIds.has(`mcp:${value.name}`)) return false
    return normalizeAuthStatus(value.authStatus) !== 'notLoggedIn' &&
      readStartupStatus(value).status === 'starting'
  })
}

function createCapabilityClient(agent: AgentDef, workdir: string): AppServerRpc {
  return new AppServerRpcClient({ bin: agent.bin, args: ['app-server'], cwd: workdir })
}

export function normalizeNativeSnapshot(
  agentId: string,
  workdir: string,
  skillsResult: unknown,
  mcpServers: unknown[],
  modesResult: unknown
): NativeCapabilitySnapshot {
  const skills = listOf(asRecord(skillsResult)?.data)
    .flatMap((entry) => listOf(asRecord(entry)?.skills))
    .flatMap((skill): NativeSkillCandidate[] => {
      const value = asRecord(skill)
      if (!value || value.enabled === false || typeof value.path !== 'string' || typeof value.name !== 'string') return []
      return [{
        id: `skill:${value.path}`,
        kind: 'skill',
        name: value.name,
        path: value.path,
        description: stringAt(value.shortDescription) || stringAt(value.description) || undefined,
        enabled: true
      }]
    })
  const mcp = mcpServers.flatMap((server): NativeMcpCandidate[] => {
    const value = asRecord(server)
    if (!value || typeof value.name !== 'string' || value.name === 'uniagent') return []
    const authStatus = normalizeAuthStatus(value.authStatus)
    const providerStatus = readStartupStatus(value)
    return [{
      id: `mcp:${value.name}`,
      kind: 'mcp',
      name: value.name,
      description: stringAt(asRecord(value.serverInfo)?.description) || undefined,
      authStatus,
      // Authentication is an explicit provider denial and must win over a stale
      // readiness field. Every other status comes from the provider; absent data
      // stays conservative (`starting`) rather than assuming ready.
      startupStatus: authStatus === 'notLoggedIn' ? 'auth-required' : providerStatus.status,
      statusMessage: providerStatus.message,
      toolNames: Object.keys(asRecord(value.tools) || {}).sort()
    }]
  })
  const rawPlan = listOf(asRecord(modesResult)?.data)
    .map(asRecord)
    .find((mode) => mode?.mode === 'plan')
  const plan = rawPlan
    ? {
        id: 'plan' as const,
        name: stringAt(rawPlan.name) || 'Plan',
        model: stringAt(rawPlan.model) || null,
        reasoningEffort: normalizeReasoningEffort(rawPlan.reasoning_effort)
      }
    : null
  return {
    agentId,
    workdir,
    source: 'provider-native',
    candidates: [...skills, ...mcp],
    actions: { goal: true, review: true, plan },
    errors: []
  }
}

function readStartupStatus(server: Record<string, unknown>): { status: McpStartupStatus; message?: string } {
  const raw = server.startupStatus ?? server.startup_status ?? server.startup ?? server.status
  const nested = asRecord(raw)
  const status = normalizeStartupStatus(
    typeof raw === 'string' ? raw : nested?.status ?? nested?.state ?? nested?.phase ?? nested?.value ?? server.state
  )
  const message = stringAt(nested?.message) || stringAt(nested?.statusMessage) ||
    stringAt(nested?.error) || stringAt(nested?.reason) || stringAt(server.statusMessage) || undefined
  return { status, message }
}

function normalizeStartupStatus(value: unknown): McpStartupStatus {
  switch (typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '') {
    case 'ready':
    case 'running':
    case 'started': return 'ready'
    case 'failed':
    case 'error': return 'failed'
    case 'cancelled':
    case 'canceled': return 'cancelled'
    case 'auth-required':
    case 'not-logged-in': return 'auth-required'
    case 'starting':
    case 'pending':
    case 'initializing': return 'starting'
    default: return 'starting'
  }
}

function normalizeAuthStatus(value: unknown): NativeMcpCandidate['authStatus'] {
  return value === 'unsupported' || value === 'notLoggedIn' || value === 'bearerToken' || value === 'oAuth'
    ? value
    : 'unknown'
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra'
    ? value
    : null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function listOf(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function stringAt(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }
