import type { PersonalAssistant } from './assistant'
import { resolveAgentModel, resolveAgentPermission, withAgentDefaults } from './agentChoices'
import type { AgentDef, AgentPref, ReasoningEffort, SessionConfig } from './types'

/** Overrides for one new assistant conversation; never saved as preferences. */
export interface AssistantConversationSelection {
  agentId: string
  model?: string
  effort?: ReasoningEffort
  thinking?: string
}

export function parseAssistantConversationSelection(value: unknown): AssistantConversationSelection | undefined {
  if (value === undefined) return undefined
  const text = (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 500
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('新对话参数无效')
  const selection = value as AssistantConversationSelection
  if (Object.keys(value).some(key => !['agentId', 'model', 'effort', 'thinking'].includes(key)) || !text(selection.agentId) ||
    [selection.model, selection.effort, selection.thinking].some(item => item !== undefined && !text(item))) throw new Error('新对话参数无效')
  return { agentId: selection.agentId, ...(selection.model !== undefined ? { model: selection.model } : {}),
    ...(selection.effort !== undefined ? { effort: selection.effort } : {}), ...(selection.thinking !== undefined ? { thinking: selection.thinking } : {}) }
}

/** Shared by the creation boundary and its preview, using the live model catalog. */
export function resolveAssistantConversationConfig(assistant: PersonalAssistant, agent: AgentDef | undefined, pref?: AgentPref, input?: AssistantConversationSelection): SessionConfig {
  const selection = parseAssistantConversationSelection(input)
  if (!assistant.enabled) throw new Error('个人助手已停用，请在设置中启用')
  if (!agent || agent.id !== (selection?.agentId || assistant.defaultAgentId) || agent.lifecycle?.availability !== 'available') throw new Error('所选 Agent 当前不可用，请重新选择')
  if (!agent.capabilities.startupSystemPrompt) throw new Error('该 Agent 无法承接个人助手')
  const modelId = selection?.model ?? (agent.id === assistant.defaultAgentId ? assistant.defaultModel : undefined)
  if (modelId !== undefined && (!agent.capabilities.modelSelect || !agent.models.some(model => model.id === modelId))) throw new Error('所选模型已不可用，请重新选择')
  const config = withAgentDefaults(agent, { agentId: agent.id, model: modelId, workdir: '' }, pref)
  const model = resolveAgentModel(agent, config.model)
  if (agent.capabilities.modelSelect && !model) throw new Error('所选 Agent 暂无可用模型')
  const nativeThinking = agent.adapter === 'kimi' || agent.adapter === 'zcode'
  if (selection?.effort !== undefined) {
    if (nativeThinking || !agent.capabilities.reasoningEffort || !model?.efforts.includes(selection.effort)) throw new Error('所选模型不支持该思考强度')
    config.effort = selection.effort
  }
  if (selection?.thinking !== undefined) {
    if (!nativeThinking || !model?.thinkingOptions?.includes(selection.thinking)) throw new Error('所选模型不支持该 Thinking 选项')
    if (agent.adapter === 'kimi') config.kimiThinking = selection.thinking
  }
  if (agent.adapter === 'zcode' && model?.zcodeSelection) {
    config.zcodeModelSelection = { ...model.zcodeSelection, options: { ...model.zcodeSelection.options,
      ...(config.zcodeModelSelection?.options || {}), ...(selection?.thinking ? { reasoningLevel: selection.thinking } : {}) } }
  }
  if (!selection && assistant.defaultPermissionMode && !agent.capabilities.permissionModes.some(mode => mode.id === assistant.defaultPermissionMode)) throw new Error('个人助手默认权限已不可用，请到设置重新选择')
  return { ...config, useAssistant: true, modelSource: model?.modelSource,
    permissionMode: resolveAgentPermission(agent, assistant.defaultPermissionMode, 'ask') }
}
