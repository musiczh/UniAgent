import type { AgentDef } from '@shared/types'
import { agentVersionWarning } from '@shared/agentCompatibility'
import { UiIcon } from './Icons'

export function AgentVersionWarning({ agent }: { agent?: AgentDef }): JSX.Element | null {
  const warning = agentVersionWarning(agent)
  if (!warning) return null
  return <div className="agent-version-warning" role="status"><UiIcon name="alert-circle" size={14}/><span>{warning.message}{warning.testedVersion && <small>此版已验证：{warning.testedVersion}</small>}</span></div>
}
