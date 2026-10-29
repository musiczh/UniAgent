import type { AgentDef } from './types'

export function pendingAgentDetection(agent: AgentDef): AgentDef {
  const detectionPhase = agent.lifecycle?.detectionStatus === 'failed' ? 'recovering'
    : !agent.lifecycle?.checkedAt ? 'preparing' : undefined
  return { ...agent, lifecycle: {
    availability: 'unhealthy', auth: 'unknown', health: 'unknown', updateStatus: 'idle', checkedAt: 0,
    ...agent.lifecycle, detectionStatus: 'detecting', detectionPhase, detectionError: undefined
  } }
}
