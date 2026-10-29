import type { AgentDef } from './types'

export type AgentStatusView = {
  label: string
  tone: 'ok' | 'warn' | 'off'
}

/** 运行态：Agent 本身是否可用（与版本更新无关）。 */
export function agentRuntimeStatus(agent: AgentDef): AgentStatusView {
  if (agent.lifecycle?.detectionStatus === 'detecting') return { label: '检测中…', tone: 'off' }
  if (agent.lifecycle?.detectionStatus === 'failed') return { label: '检测失败', tone: 'warn' }
  if (agent.incompatible) {
    return { label: '已安装但不兼容', tone: 'warn' }
  }
  if (agent.lifecycle?.availability === 'needs-auth') {
    return { label: '待登录', tone: 'warn' }
  }
  if (agent.lifecycle?.availability === 'unhealthy') {
    return { label: '异常', tone: 'warn' }
  }
  if (agent.lifecycle?.availability === 'available' || agent.installed) {
    return { label: '可用', tone: 'ok' }
  }
  return { label: '未安装', tone: 'off' }
}

/**
 * 外部列表只暴露三种稳态：可用 / 异常 / 可更新。
 * 更新检查在后台进行，列表不再展示「尚未检查」「不支持应用内更新」这类过程态。
 */
export function agentExternalStatus(agent: AgentDef): AgentStatusView {
  // 用户主动发起的更新仍在进行中，属于进行态，需要明确反馈。
  if (agent.lifecycle?.updateStatus === 'updating') return { label: '更新中', tone: 'warn' }
  const runtime = agentRuntimeStatus(agent)
  if (runtime.label === '检测中…') return runtime
  if (runtime.label === '可用') {
    const updatable = agent.lifecycle?.updateStatus === 'available' && agent.lifecycle.selfUpdateSupported !== false
    return updatable ? { label: '可更新', tone: 'warn' } : { label: '可用', tone: 'ok' }
  }
  return { label: '异常', tone: 'warn' }
}
