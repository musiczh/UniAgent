import { randomUUID } from 'node:crypto'
import type { Session, SessionConfig } from '../shared/types'
import type { RequirementContextRequest } from '../shared/requirementTypes'
import { hasProjectMemoryContext, prepareProjectMemory } from './projectMemoryRuntime'

let lookup: (id: string) => Session | undefined = () => undefined
const bindings = new Map<string, { token: string; requirementId: string }>()
let contextProvider: ((sessionId: string, request: RequirementContextRequest) => Promise<any>) | undefined
const preparations = new Map<string, symbol>()
export const REQUIREMENT_CONTEXT_PREFIX = '[uniagent_requirement_context]'
const INPUT_MARKER = '\n\n当前用户输入：\n'
// 需求功能总开关：模块级懒读，供 RequirementStore（构造早于 AppSettingsStore）等处实时查询。
let requirementsEnabled = false
export function setRequirementsEnabled(enabled: boolean): void { requirementsEnabled = enabled }
export function isRequirementsEnabled(): boolean { return requirementsEnabled }
export function configureRequirementRuntime(resolve: typeof lookup, provider?: typeof contextProvider): void {
  lookup = resolve; contextProvider = provider; preparations.clear()
}
export function hasRequirementContext(config: SessionConfig): boolean { return !!config.requirementId && requirementsEnabled && !!contextProvider }
export async function requirementContextForCaller(sessionId: string, request: RequirementContextRequest): Promise<unknown> {
  requirementCaller(sessionId, requirementMcpEnv(sessionId).UNIAGENT_REQUIREMENT_TOKEN || '')
  if (!contextProvider) throw new Error('requirement_context_unavailable')
  return contextProvider(sessionId, request)
}
export function cancelRequirementPreparation(sessionId: string): boolean { return preparations.delete(sessionId) }
export function stripRequirementContext(text: string): string {
  return text.startsWith(REQUIREMENT_CONTEXT_PREFIX) && text.includes(INPUT_MARKER) ? text.slice(text.indexOf(INPUT_MARKER) + INPUT_MARKER.length) : text
}
export async function initialRequirementSnapshot(session: Session): Promise<object | undefined> {
  if (!hasRequirementContext(session.config)) return undefined
  const value = await contextProvider!(session.id, { action: 'bootstrap' })
  return { id: session.config.requirementId, name: value.requirement?.name || session.config.requirementName,
    overview: value.overview ? { goal: value.overview.goal, scope: value.overview.scope } : undefined, readingStatus: value.readingStatus }
}
export function prepareRequirementTurn(session: Session, prompt: string): { current: () => boolean; complete: () => void; ready: Promise<string> } {
  const ticket = Symbol(session.id)
  preparations.set(session.id, ticket)
  const current = () => preparations.get(session.id) === ticket
  const ready = (async () => {
    if (hasProjectMemoryContext(session.config)) await prepareProjectMemory(session)
    return prompt
  })()
  return { current, complete: () => { if (current()) preparations.delete(session.id) }, ready }
}
export function requirementInstructions(config: SessionConfig): string {
  return config.requirementId && requirementsEnabled
    ? `关联需求时用 requirement_context：
无概述、压缩恢复或切换任务时 bootstrap；概述缺失或过期读 core/state。按需 read 相关规范、记忆和任务成果；实施前完整读取相关正文及依赖，按 nextOffset 续读。
仅有实质变化时同步：写前 check，使用当前 revision 和真实来源 commit；建议或未核实内容 propose，冲突后重读合并。
参考资料记 source，重要交付产物记 artifact，保留标题、用途和真实入口；未读原文须注明。
阶段收尾有新信息时 sync_task，更新同一任务的标题、简介、实际工作、结果、验证、未完成项及来源；无变化不写。维护细节按工具说明及 read(documentId="guide")，不直接改受管上下文文件。`
    : ''
}
export function requirementMcpEnv(sessionId?: string): Record<string, string> {
  const requirementId = sessionId ? lookup(sessionId)?.config.requirementId : undefined
  if (!requirementsEnabled || !sessionId || !requirementId) return {}
  let binding = bindings.get(sessionId)
  if (!binding || binding.requirementId !== requirementId) {
    binding = { token: randomUUID(), requirementId }
    bindings.set(sessionId, binding)
  }
  return { UNIAGENT_REQUIREMENT_TOKEN: binding.token }
}
export function requirementCaller(sessionId: string, token: string): Session {
  function reject(code: string, message: string, hint: string, retryable = false): never {
    throw Object.assign(new Error(message), { details: { code, hint, retryable } })
  }
  if (!requirementsEnabled) reject('requirement_disabled', '需求功能已停用。', '重新启用需求功能后再调用需求工具。')
  const binding = bindings.get(sessionId)
  const session = lookup(sessionId)
  if (!session) reject('requirement_session_not_found', '需求工具的调用会话不存在。', '确认原任务仍存在，并从该任务的当前会话调用需求工具。')
  if (!session.config.requirementId) reject('requirement_not_bound', '当前会话未绑定需求。', '先为当前任务绑定需求，再重新建立需求工具连接。')
  if (!token) reject('requirement_token_missing', '需求工具调用缺少会话凭证。', '从当前 App 的关联需求会话重新建立工具连接。')
  if (!binding) reject('requirement_binding_missing', '当前 App 实例尚未建立该会话的需求工具连接。', '在当前 App 继续会话一轮，重新建立需求工具连接后重试。', true)
  if (session.config.requirementId !== binding.requirementId) reject('requirement_binding_changed', '会话绑定的需求已变更，工具仍关联原需求。', '重新建立工具连接，读取当前需求后再提交；不要将原需求内容直接写入新需求。')
  if (binding.token !== token) reject('requirement_token_mismatch', '需求工具凭证与当前会话不匹配。', '从当前会话重新建立工具连接后重试。')
  return session
}
