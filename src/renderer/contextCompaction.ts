import type { AgentDef } from '@shared/types'
import { isSessionBusy } from '@shared/sessionStatus'

export interface ContextCompactionEvent {
  type: string
  state?: string
  payload?: { reason?: string }
}

export interface ContextCompactionAvailability {
  canCompact: boolean
  compacting: boolean
  providerSwitchCompacting: boolean
  disabledReason?: string
}

export function supportsManualContextCompaction(
  agent: Pick<AgentDef, 'adapter' | 'capabilities'> | null | undefined
): boolean {
  return !!agent &&
    (agent.adapter === 'codex' || agent.adapter === 'traex' || agent.adapter === 'claude' || (['kimi', 'grok', 'deepseek', 'mcode'].includes(agent.adapter) && agent.capabilities.commands?.some(command => command.replace(/^\//, '') === 'compact') === true)) &&
    agent.capabilities.streaming === true
}

/**
 * Keep the manual-compaction affordance aligned with the main-process
 * `usesAppServer` gate. The renderer still shows the action when unavailable so
 * users can see why it cannot be used for the current session.
 */
export function contextCompactionAvailability(
  supportsCompact: boolean,
  status: string,
  events: readonly ContextCompactionEvent[],
  hasLiveStreamer: boolean,
  preparingModel = false
): ContextCompactionAvailability {
  const compacting = events.some(
    (event) => event.type === 'context_compaction' && event.state === 'running'
  )
  const providerSwitchCompacting = events.some(
    (event) => event.type === 'context_compaction' && event.state === 'running' && event.payload?.reason === 'provider-switch'
  )

  let disabledReason: string | undefined
  if (!supportsCompact) disabledReason = '当前 Agent 不支持手动压缩上下文。'
  else if (compacting) disabledReason = '上下文正在压缩，请等待完成。'
  else if (preparingModel) disabledReason = '正在切换模型，请等待准备完成。'
  else if (isSessionBusy(status)) {
    disabledReason = 'Agent 运行中，请等待当前回合结束。'
  } else if (!hasLiveStreamer) {
    disabledReason = '当前会话尚未建立实时连接，请先发送一条消息。'
  } else if (status !== 'idle' && status !== 'completed') {
    disabledReason = '当前会话尚未空闲，暂时不能压缩上下文。'
  }

  return { canCompact: disabledReason === undefined, compacting, providerSwitchCompacting, disabledReason }
}
