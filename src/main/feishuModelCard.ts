import { resolveAgentModel, resolveModelEffort, resolveModelThinking } from '../shared/agentChoices'
import type { AgentDef, ModelDef, Session, SessionConfig } from '../shared/types'

export interface FeishuModelSelection {
  model: string
  depth?: string
}

const DEPTH_LABEL: Record<string, string> = {
  low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: 'Ultra', on: '开启', off: '关闭'
}

export function modelDepth(config: SessionConfig, agent: AgentDef): string | undefined {
  return agent.adapter === 'kimi' ? config.kimiThinking
    : agent.adapter === 'zcode' ? config.zcodeModelSelection?.options?.reasoningLevel : config.effort
}

function modelDepthOptions(agent: AgentDef, model: ModelDef): string[] {
  return agent.adapter === 'kimi' || agent.adapter === 'zcode' ? model.thinkingOptions || []
    : agent.capabilities.reasoningEffort ? model.efforts : []
}

export function selectFeishuModel(agent: AgentDef, modelId?: string, depth?: string): FeishuModelSelection {
  const model = resolveAgentModel(agent, modelId)
  if (!model) throw new Error('当前 Agent 暂无可选模型，请先在 UniAgent 中检查模型配置。')
  return {
    model: model.id,
    depth: agent.adapter === 'kimi' || agent.adapter === 'zcode' ? resolveModelThinking(model, depth)
      : agent.capabilities.reasoningEffort ? resolveModelEffort(model, depth) : undefined
  }
}

export function feishuModelPatch(agent: AgentDef, selection: FeishuModelSelection): Partial<SessionConfig> {
  const model = agent.capabilities.modelSelect && agent.models.find(model => model.id === selection.model)
  if (!model) throw new Error('所选模型已不可用，请重新发送 /model。')
  const depths = modelDepthOptions(agent, model)
  if (depths.length ? !depths.includes(selection.depth || '') : selection.depth !== undefined) {
    throw new Error('所选思考深度已不可用，请重新选择模型。')
  }
  return {
    model: model.id, modelSource: model.modelSource,
    effort: agent.adapter !== 'kimi' && agent.adapter !== 'zcode' ? selection.depth as SessionConfig['effort'] : undefined,
    ...(agent.adapter === 'kimi' ? { kimiThinking: selection.depth } : {}),
    ...(agent.adapter === 'zcode' ? { zcodeModelSelection: model.zcodeSelection && {
      ...model.zcodeSelection, options: { ...model.zcodeSelection.options, reasoningLevel: selection.depth }
    } } : {})
  }
}

export function feishuModelSummary(agent: AgentDef, config: SessionConfig): string {
  const model = agent.models.find(model => model.id === config.model)
  const depth = modelDepth(config, agent)
  return [model?.label || config.model || '默认模型', depth ? DEPTH_LABEL[depth] || depth : undefined].filter(Boolean).join(' · ')
}

export function feishuModelCard(id: string, session: Session, agent: AgentDef, selection: FeishuModelSelection): object {
  const model = agent.models.find(model => model.id === selection.model)!
  const callback = (act: string): object[] => [{ type: 'callback', value: { sessionId: session.id, modelCardId: id, act } }]
  const option = (value: string, label: string): object => ({ value, text: { tag: 'plain_text', content: label.slice(0, 120) } })
  const depths = modelDepthOptions(agent, model)
  const elements: object[] = [
    { tag: 'div', text: { tag: 'plain_text', content: `Agent：${agent.name}\n当前配置：${feishuModelSummary(agent, session.config)}` } },
    { tag: 'markdown', content: '**模型**' },
    { tag: 'select_static', name: 'model', initial_option: selection.model,
      options: agent.models.map(model => option(model.id, model.label)), behaviors: callback('selectModel') },
    { tag: 'markdown', content: '**思考深度**' },
    depths.length ? { tag: 'select_static', name: 'depth', initial_option: selection.depth,
      options: depths.map(depth => option(depth, DEPTH_LABEL[depth] || depth)), behaviors: callback('selectDepth') }
      : { tag: 'markdown', content: '此模型不支持设置思考深度。' },
    { tag: 'markdown', content: session.config.assistantSnapshot
      ? '仅修改当前助手对话。应用后从下一轮生效，助手身份、记忆和历史上下文保留。'
      : '仅修改当前对话。应用后从下一轮生效，保留历史上下文。' },
    { tag: 'column_set', columns: [
      { tag: 'column', width: 'auto', elements: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '应用' }, behaviors: callback('applyModel') }] },
      { tag: 'column', width: 'auto', elements: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: '取消' }, behaviors: callback('cancelModel') }] }
    ] }
  ]
  return { schema: '2.0', config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '⚙️ 模型与思考深度' } }, body: { elements } }
}
