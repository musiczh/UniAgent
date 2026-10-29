import type { CodexSourceQuota } from './codexSources'
import type { AgentDef, CodexRateLimits, CodexRateWindow } from './types'
import type { ZCodeModelService } from './zcode'

export interface AgentQuotaSnapshot extends CodexSourceQuota {
  agentId: string
}

/** 无有效百分比时，在浏览器中查看厂商额度。 */
export interface AgentQuotaConsole {
  /** 按钮文案。 */
  label: string
  /** 无障碍描述，说明去哪里看额度。 */
  ariaLabel: string
  url: string
}

export function hasQuotaData(quota: CodexSourceQuota | null | undefined): boolean {
  return quota?.kind === 'windows' && !!quota.windows?.some(win => Number.isFinite(win.usedPercent))
    || quota?.kind === 'balance' && !!quota.balances?.some(balance => balance.total.trim() !== '' && Number.isFinite(Number(balance.total)))
}

/** Account windows use seconds; provider quota reset timestamps use milliseconds. */
export function accountQuota(limits: CodexRateLimits | null): CodexSourceQuota | null {
  const windows = [limits?.primary, limits?.secondary]
    .filter((win): win is CodexRateWindow => !!win && Number.isFinite(win.usedPercent))
    .sort((a, b) => a.windowMinutes - b.windowMinutes)
    .map(win => ({
      label: win.windowMinutes === 300 ? '5 小时限额' : win.windowMinutes === 10080 ? '周限额' : `${Math.round(win.windowMinutes / 60)} 小时限额`,
      usedPercent: Math.max(0, Math.min(100, win.usedPercent)),
      resetsAt: win.resetsAt * 1000
    }))
  return windows.length ? { status: 'ready', kind: 'windows', windows, capturedAt: limits!.capturedAt, planType: limits!.planType ?? undefined } : null
}

/** 多窗口额度取剩余最少的一项；余额没有分母，不能换算为百分比。 */
export function quotaRemainingWindow(quota: CodexSourceQuota | null | undefined): { label: string; remainPercent: number } | null {
  if (quota?.kind !== 'windows') return null
  const tightest = quota.windows?.filter(win => Number.isFinite(win.usedPercent))
    .sort((a, b) => b.usedPercent - a.usedPercent)[0]
  return tightest ? { label: tightest.label, remainPercent: Math.max(0, Math.min(100, 100 - tightest.usedPercent)) } : null
}

/** 额度摘要用于悬停说明，余额型取余额，窗口型取最紧张的窗口。 */
export function quotaSummaryText(quota: CodexSourceQuota | null | undefined): string | null {
  if (!quota) return null
  if (quota.kind === 'balance' && quota.balances?.length) {
    const balance = quota.balances[0]
    const value = Number(balance.total)
    if (!Number.isFinite(value)) return `余额 ${balance.currency} ${balance.total}`
    try {
      return `余额 ${new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency }).format(value)}`
    } catch {
      return `余额 ${balance.currency} ${balance.total}`
    }
  }
  const window = quotaRemainingWindow(quota)
  return window ? `剩余 ${Math.round(window.remainPercent)}%` : null
}

/**
 * 原生查询没有有效百分比时使用网页控制台；Nika 与内网 TraeX 不跳转。
 */
export function agentQuotaConsole(agent: AgentDef, mcodeRegion = agent.mcode?.region, zcodeService?: ZCodeModelService): AgentQuotaConsole | null {
  let url: string
  switch (agent.adapter) {
    case 'codex': url = 'https://chatgpt.com/codex/settings/usage'; break
    case 'claude': url = 'https://claude.ai/settings/usage'; break
    case 'grok': url = 'https://console.x.ai/'; break
    case 'kimi': url = 'https://www.kimi.com/code/console'; break
    case 'deepseek': url = 'https://platform.deepseek.com/'; break
    case 'mcode': {
      const host = mcodeRegion === 'global' ? 'https://platform.minimax.io' : 'https://platform.minimaxi.com'
      url = `${host}/user-center/payment/coding-plan`
      break
    }
    case 'zcode':
      url = zcodeService?.startsWith('zai-') ? 'https://z.ai/manage-apikey/billing'
        : zcodeService === 'bigmodel-api' ? 'https://bigmodel.cn/finance/overview'
          : 'https://www.bigmodel.cn/coding-plan/personal/usage'
      break
    default: return null
  }
  return { label: '控制台', ariaLabel: `打开 ${agent.name} 控制台查看额度`, url }
}
