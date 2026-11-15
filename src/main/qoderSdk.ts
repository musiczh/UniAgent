import type { Options, ModelInfo, Daemon, Query } from '@qoder-ai/qoder-agent-sdk'
import type { AgentRole, ModelDef, PermissionMode, SessionConfig } from '../shared/types'
import { SdkWorkerClient } from './sdkWorkerClient.ts'
import { routerRole } from '../shared/router.ts'

export type QoderRegion = 'cn' | 'global'
export interface QoderSdkLaunch {
  region: QoderRegion
  options: Omit<Options, 'daemon' | 'canUseTool' | 'hooks' | 'onElicitation'>
  role?: Pick<AgentRole, 'skills' | 'toolPolicy'>
  operationOnly?: boolean
  initializeTimeoutMs?: number
}

export class QoderSdkClient extends SdkWorkerClient {
  constructor(launch: QoderSdkLaunch) { super({ ...launch, closeTimeoutMs: 15_000 }, 'Qoder', 'qoderSdkWorker') }
}

export function qoderAuth(sdk: Pick<typeof import('@qoder-ai/qoder-agent-sdk'), 'DEFAULT_ACCESS_TOKEN_ENV_VAR' | 'accessToken' | 'qodercliAuth'>, env: NodeJS.ProcessEnv) {
  const token = env[sdk.DEFAULT_ACCESS_TOKEN_ENV_VAR]
  return token ? sdk.accessToken(token) : sdk.qodercliAuth()
}

export function qoderToolCall(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  if (name === 'mcp_call' && typeof input.toolName === 'string' && /^mcp__[^\s]+__[^\s]+$/.test(input.toolName) &&
      (input.arguments === undefined || input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments))) {
    return { name: input.toolName, input: (input.arguments || {}) as Record<string, unknown> }
  }
  return { name, input }
}

type QoderMcpInitialization = Pick<Query, 'initializationResult' | 'setModel' | 'mcpServerStatus'> & {
  setMcpServers?: (servers: Record<string, import('@qoder-ai/qoder-agent-sdk').McpServerConfigForProcessTransport>) => Promise<unknown>
}

export async function initializeQoderQuery(query: QoderMcpInitialization,
  model?: string, mcpServers?: Options['mcpServers'], strictMcpConfig = false): Promise<Awaited<ReturnType<Query['initializationResult']>>> {
  const result = await query.initializationResult()
  if (model) await query.setModel(model)
  if (model || mcpServers && Object.keys(mcpServers).length || strictMcpConfig) {
    if (typeof query.setMcpServers !== 'function') throw new Error('当前 Qoder SDK 无法在初始化后连接支持提问的 MCP 服务')
    const native = strictMcpConfig ? {} : Object.fromEntries((await query.mcpServerStatus())
      .filter(server => server.status !== 'disabled' && server.config && server.config.type !== 'sdk')
      .map(server => [server.name, server.config!]))
    await query.setMcpServers({ ...native, ...mcpServers })
  }
  return result
}

export async function qoderDaemonRequest(daemon: Daemon, method: string, args?: any): Promise<unknown> {
  switch (method) {
    case 'auth': return daemon.auth()
    case 'account': return daemon.accountInfo()
    case 'models': return daemon.getModels({ fetchStrategy: 'live' })
    case 'usage': return daemon.getUsageInfo()
    case 'byok.list': return daemon.listByokConfigs()
    case 'byok.providers': return daemon.getByokConfig()
    case 'byok.create': return daemon.createByokConfig(args)
    case 'byok.update': return daemon.updateByokConfig(args)
    case 'byok.delete': return daemon.deleteByokConfig(args)
    case 'byok.check': return daemon.checkByokConfig(args)
    default: throw new Error(`不支持的 Qoder 账号操作：${method}`)
  }
}

export function qoderRegionForBin(bin: string): QoderRegion {
  return /qodercn|qoderclicn|qoder-cn/.test(bin) ? 'cn' : 'global'
}


export function qoderPermission(mode: PermissionMode | undefined): Options['permissionMode'] {
  switch (mode) {
    case 'ask': return 'default'
    case 'auto-edit': return 'acceptEdits'
    case 'approve-for-me': return 'auto'
    case 'deny-unapproved': return 'dontAsk'
    case 'full-access': return 'bypassPermissions'
    default: throw new Error('Qoder 不提供 OS 只读沙箱，请选择实际支持的工具审批策略')
  }
}

export function projectQoderModels(models: ModelInfo[]): ModelDef[] {
  return models.filter(m => m.isEnabled !== false && !!m.value).map(m => {
    const enabled = m.thinking_config?.enabled
    const levels = m.efforts || Object.keys(enabled?.efforts || {})
    const efforts = levels.filter((e): e is NonNullable<ModelDef['defaultEffort']> => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e))
    const preferred = m.defaultEffort || Object.entries(enabled?.efforts || {}).find(([, value]) => value.is_default)?.[0]
    return { id: m.value, label: m.displayName || m.value, efforts,
      defaultEffort: efforts.find(e => e === preferred) || efforts[0], imageInput: m.isVl === true,
      contextWindow: m.defaultContextWindow || Object.values(m.context_config || {}).find(v => v.is_default)?.token_count || m.maxInputTokens,
      qoderContextWindows: m.availableContextWindows || Object.values(m.context_config || {}).map(v => v.token_count),
      qoderThinkingDisabled: m.supportsDisabled === true || !!m.thinking_config?.disabled }
  })
}

export function qoderLaunch(bin: string, config: SessionConfig, instructions: string, mcpServers: Options['mcpServers'], resume?: string, credentials: NodeJS.ProcessEnv = {}, review = false): QoderSdkLaunch {
  const region = qoderRegionForBin(bin)
  const original = config.roleSnapshot?.toolPolicy
  const reviewTools = ['Read', 'Glob', 'Grep'].filter(tool => original?.mode === 'allow-only' ? original.tools.includes(tool) : original?.mode !== 'deny-only' || !original.tools.includes(tool))
  const router = routerRole(config)
  const role = router || (review ? { skills: [], toolPolicy: { mode: 'allow-only' as const, tools: reviewTools } } : config.roleSnapshot)
  const policy = role?.toolPolicy
  return { region, role, options: {
    pathToQoderCLIExecutable: bin, cwd: config.workdir, env: { ...process.env, ...credentials },
    includePartialMessages: true, includeHookEvents: true, includeShellProgress: true,
    settingSources: review ? [] : ['user', 'project', 'local'], enableFileCheckpointing: true,
    ...(review ? { settings: { disableAllHooks: true }, strictMcpConfig: true } : {}),
    permissionMode: qoderPermission(config.permissionMode), allowDangerouslySkipPermissions: config.permissionMode === 'full-access',
    systemPrompt: { type: 'preset', preset: 'qodercli', append: instructions },
    model: config.model, resume, additionalDirectories: config.additionalDirectories,
    planMode: config.collaborationMode === 'plan', skills: role?.skills,
    ...(policy?.mode === 'allow-only' ? { tools: policy.tools } : {}),
    ...(policy?.mode === 'deny-only' ? { disallowedTools: policy.tools } : {}),
    mcpServers: review ? {} : mcpServers, extraArgs: { ...(config.effort && !config.qoderThinkingDisabled ? { 'reasoning-effort': config.effort } : {}),
      ...(config.qoderContextWindow ? { 'context-window': String(config.qoderContextWindow) } : {}),
      ...(config.qoderThinkingDisabled ? { thinking: 'disabled' } : {}) }
  } }
}

export async function qoderOperation(bin: string, method: string, args?: unknown, cwd?: string, env?: NodeJS.ProcessEnv): Promise<any> {
  const region = qoderRegionForBin(bin)
  const { nativeCredentialEnv } = await import('./agentSetupCredentials.ts')
  const client = new QoderSdkClient({ region, operationOnly: method !== 'mcp', options: {
    pathToQoderCLIExecutable: bin, cwd, tools: [], persistSession: false, settingSources: ['user'], env: { ...process.env, ...nativeCredentialEnv(region === 'cn' ? 'qoder-cn' : 'qoder'), ...env }
  }, initializeTimeoutMs: 30_000 })
  try { await client.ready; return await client.request(method, args) } finally { await client.close() }
}
