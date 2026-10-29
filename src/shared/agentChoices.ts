import type { AgentDef, AgentPref, ModelDef, PermissionMode, ReasoningEffort, SessionConfig } from './types'

export function supportsModelImages(agent: AgentDef | undefined, modelId?: string): boolean {
  if (!agent) return false
  const advertised = agent.models.find(model => model.id === (modelId || agent.defaultModel))?.imageInput
  // Host modelCatalog omits modalities; session/prompt performs authoritative image admission.
  if (agent.adapter === 'deepseek' && agent.capabilities.protocol === 'web') return advertised !== false
  return !['kimi', 'grok', 'deepseek', 'zcode'].includes(agent.adapter) || advertised === true
}

export function resolveAgentModel(agent: AgentDef | undefined, ...choices: (string | undefined)[]): ModelDef | undefined {
  if (!agent?.capabilities.modelSelect) return undefined
  return [...choices, agent.defaultModel].map(id => agent.models.find(model => model.id === id)).find(Boolean)
    || (agent.adapter === 'codex' ? agent.models.find(model => !model.modelSource || model.modelSource.kind === 'native') : agent.models[0])
    || agent.models[0]
}

export function resolveModelEffort(model: ModelDef | undefined, ...choices: (string | undefined)[]): ReasoningEffort | undefined {
  return [...choices, model?.defaultEffort].find(value => model?.efforts.includes(value as ReasoningEffort)) as ReasoningEffort | undefined
    || model?.efforts[0]
}

export function resolveModelThinking(model: ModelDef | undefined, ...choices: (string | undefined)[]): string | undefined {
  return [...choices, model?.defaultThinking].find(value => value !== undefined && model?.thinkingOptions?.includes(value))
    || model?.thinkingOptions?.[0]
}

export function resolveAgentPermission(agent: AgentDef | undefined, ...choices: (string | undefined)[]): PermissionMode | undefined {
  return [...choices].find(value => agent?.capabilities.permissionModes.some(mode => mode.id === value)) as PermissionMode | undefined
    || agent?.capabilities.permissionModes[0]?.id
}

/** Fill omitted values without overriding explicit protocol presets. */
export function withAgentDefaults(agent: AgentDef | undefined, config: SessionConfig, pref?: AgentPref): SessionConfig {
  if (!agent) return config
  const model = config.model ? agent.models.find(model => model.id === config.model) : resolveAgentModel(agent, pref?.defaultModel)
  const modelId = config.model || model?.id
  const modelSource = config.model ? config.modelSource : model?.modelSource || config.modelSource
  const nativeThinking = agent.adapter === 'kimi' || agent.adapter === 'zcode'
  const effort = config.effort || (!nativeThinking && agent.capabilities.reasoningEffort ? resolveModelEffort(model, pref?.defaultEffort) : undefined)
  const kimiThinking = config.kimiThinking || (agent.adapter === 'kimi' ? resolveModelThinking(model, pref?.defaultThinking, pref?.defaultEffort) : undefined)
  let zcodeModelSelection = config.zcodeModelSelection
  if (agent.adapter === 'zcode' && model?.zcodeSelection && !zcodeModelSelection?.options?.reasoningLevel) {
    const reasoningLevel = resolveModelThinking(model, pref?.defaultThinking, pref?.defaultEffort)
    const selection = zcodeModelSelection || model.zcodeSelection
    if (!zcodeModelSelection || reasoningLevel) zcodeModelSelection = { ...selection, ...(reasoningLevel ? { options: { ...selection.options, reasoningLevel } } : {}) }
  }
  if (modelId === config.model && modelSource === config.modelSource && effort === config.effort && kimiThinking === config.kimiThinking && zcodeModelSelection === config.zcodeModelSelection) return config
  return { ...config, model: modelId, modelSource, effort, kimiThinking, zcodeModelSelection }
}
