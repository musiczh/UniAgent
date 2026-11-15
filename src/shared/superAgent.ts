import type { AgentDef, ModelDef } from './types'
import { supportsModelImages } from './agentChoices.ts'

export function superAgentModels(agent: AgentDef): ModelDef[] {
  if (agent.capabilities.attachments === false || agent.capabilities.imageAttachments === false) return []
  return agent.models.filter(model => model.imageInput !== false &&
    (model.modelSource && model.modelSource.kind !== 'native' ? model.imageInput === true : supportsModelImages(agent, model.id)))
}

export function superAgentUnavailable(agent: AgentDef | undefined): string | undefined {
  if (!agent) return '未找到所选 Agent'
  if (agent.installed === false || agent.lifecycle?.availability === 'not-installed') return `${agent.name} 未安装`
  if (agent.authenticationRequired || agent.lifecycle?.auth === 'required' || agent.lifecycle?.availability === 'needs-auth') return `${agent.name} 需要先登录`
  if (agent.incompatible || agent.lifecycle?.health === 'unhealthy' || agent.lifecycle?.availability && agent.lifecycle.availability !== 'available') return `${agent.name} 当前检测不可用，请刷新状态后重试`
  if (!agent.capabilities.startupSystemPrompt && !agent.capabilities.auxiliarySystemPrompt) return `${agent.name} 当前接入不支持系统提示词`
  if (!superAgentModels(agent).length) return `${agent.name} 当前没有支持图片输入的模型`
}
