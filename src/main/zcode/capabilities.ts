import type { NativeCapabilitySnapshot, ResolvedNativeTurnContext } from '../../shared/nativeCapabilities'
import { ZCodeRpcError, type ZCodeConnection } from './connection'
import { isRecord, scrubZCodeDiagnostic } from './protocol'

export async function readZCodeCapabilities(connection: ZCodeConnection, workdir: string, sessionId?: string,
  mcpServers?: Record<string, unknown>[], plan = false): Promise<NativeCapabilitySnapshot> {
  const snapshot: NativeCapabilitySnapshot = { agentId: 'zcode', workdir, source: 'provider-native', candidates: [],
    actions: { goal: false, review: false, plan: plan ? { id: 'plan', name: 'Plan', model: null, reasoningEffort: null } : null }, errors: [] }
  const workspace = { workspacePath: workdir, workspaceKey: workdir }
  const results = await Promise.allSettled([
    connection.request<any>('skills/referenceCatalog', { workspace, ...(sessionId ? { sessionId } : {}) }),
    connection.request<any>('mcp/list', { workspace, ...(mcpServers ? { mcpServers } : {}), mode: 'connect' }),
    connection.request<any>('workspace/readPresentation', { workspace })
  ])
  for (const result of results) if (result.status === 'rejected') {
    snapshot.errors.push(result.reason instanceof ZCodeRpcError && result.reason.code === -32601
      ? '此 ZCode 版本缺少部分原生能力清单接口' : scrubZCodeDiagnostic(result.reason instanceof Error ? result.reason.message : 'ZCode 能力读取失败'))
  }
  const skills = results[0]
  if (skills.status === 'fulfilled' && Array.isArray(skills.value?.skills)) for (const skill of skills.value.skills) {
    if (isRecord(skill) && typeof skill.name === 'string' && typeof skill.path === 'string' && skill.enabled === true) snapshot.candidates.push({
      id: `skill:${skill.path}`, kind: 'skill', name: skill.name, path: skill.path, description: typeof skill.description === 'string' ? skill.description : undefined, enabled: true })
  }
  const mcp = results[1]
  if (mcp.status === 'fulfilled' && isRecord(mcp.value?.statuses)) for (const [name, status] of Object.entries(mcp.value.statuses)) {
    if (!isRecord(status)) continue
    snapshot.candidates.push({ id: `mcp:${name}`, kind: 'mcp', name, authStatus: status.failureKind === 'not_authenticated' ? 'notLoggedIn' : 'unknown',
      startupStatus: status.status === 'connected' ? 'ready' : status.status === 'connecting' ? 'starting' : 'failed',
      ...(status.error ? { statusMessage: scrubZCodeDiagnostic(String(status.error)) } : {}), toolNames: [] })
  }
  const presentation = results[2]
  if (presentation.status === 'fulfilled' && Array.isArray(presentation.value?.slashCommands)) for (const item of presentation.value.slashCommands) {
    const name = typeof item === 'string' ? item.replace(/^\//, '') : item?.name?.replace(/^\//, '')
    if (typeof name === 'string' && /^[a-zA-Z0-9][\w.:-]*$/.test(name)) snapshot.candidates.push({ id: `command:${name}`, kind: 'command', name, command: `/${name}` })
  }
  snapshot.actions.goal = snapshot.candidates.some(candidate => candidate.kind === 'command' && candidate.name === 'goal')
  return snapshot
}

export function zcodeContextPrompt(text: string, context: ResolvedNativeTurnContext | undefined, snapshot: NativeCapabilitySnapshot): string {
  if (!context || !context.skills?.length && !context.mcpServers?.length) return text
  const mentions: string[] = []
  for (const skill of context.skills ?? []) {
    if (!snapshot.candidates.some(candidate => candidate.kind === 'skill' && candidate.enabled && candidate.name === skill.name && candidate.path === skill.path)) throw new Error('ZCode 所选 Skill 已失效')
    const label = ('$' + skill.name).replace(/([\\\[\]])/g, '\\$1')
    const path = skill.path.replace(/([\\>])/g, '\\$1')
    mentions.push(`[${label}](<${path}>)`)
  }
  for (const server of context.mcpServers ?? []) {
    if (!snapshot.candidates.some(candidate => candidate.kind === 'mcp' && candidate.name === server.name && candidate.startupStatus === 'ready')) throw new Error('ZCode 所选 MCP Server 当前不可用')
    mentions.push(`请使用 MCP 服务 ${JSON.stringify(server.name)}。`)
  }
  return mentions.join('\n') + '\n\n' + text
}
