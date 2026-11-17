import type { SessionConfig } from '../shared/types'
import { assistantIdentity } from '../shared/assistant'
import { assistantInitialization, assistantFixedRules, configureAssistantRules } from './assistant/context'
import { uniAgentSessionInstructions } from './handoff'
import { requirementInstructions } from './requirementRuntime'
import { worktreeInstructions } from './worktreeService'
import { teamRuntime } from './teamRuntime'
import { ROUTER_SYSTEM_PROMPT } from '../shared/router'

function fixedRules(config: SessionConfig, sessionId?: string, sync = true): string {
  return [config.managedPurpose === 'router' ? ROUTER_SYSTEM_PROMPT : uniAgentSessionInstructions(),
    assistantIdentity(config.assistantSnapshot), worktreeInstructions(config),
    sync ? requirementInstructions(config) : '', config.managedPurpose === 'router' ? '' : config.roleSnapshot?.instructions?.trim(),
    sync ? teamRuntime(sessionId)?.instructions : '',
    '通道以宿主提供的本轮信息为准。飞书通道下，图片、文件用 send_to_feishu；微信通道下，用 send_to_weixin。这两种通道的正文不放本地路径或本地链接，附件发送成功后才告知已发送。'
  ].filter(Boolean).join('\n\n')
}
configureAssistantRules((config, sessionId) => fixedRules(config, sessionId))
export function sessionInstructions(config: SessionConfig, sessionId?: string, sync = true): string {
  const rules = config.managedPurpose === 'router' || !sync ? fixedRules(config, sessionId, sync)
    : assistantFixedRules(sessionId) ?? fixedRules(config, sessionId)
  return [rules, assistantInitialization(sessionId)].filter(Boolean).join('\n\n')
}
