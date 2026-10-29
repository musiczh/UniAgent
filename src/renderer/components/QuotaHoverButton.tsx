import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentDef, CodexRateLimits } from '@shared/types'
import type { CodexSourceBalance, CodexSourceQuota } from '@shared/codexSources'
import { accountQuota, hasQuotaData, type AgentQuotaSnapshot } from '@shared/agentQuota'
import { orderedSourceWindows, quotaResetText } from '../codexRateLimits'
import { AgentIcon } from './AgentIcon'
import { UiIcon } from './Icons'

/**
 * 侧栏底部「模型额度」速览按钮：hover/点击弹出一个固定定位的悬浮窗，汇总展示
 * 当前可用且已启用的 Agent 账号额度。
 * 打开时并行查询各 Agent；只展示有效窗口或余额，查询失败保留并标记上次结果。
 */

const HOVER_CLOSE_GRACE_MS = 260

function quotaIdentity(agent: AgentDef, providerId?: string): string {
  return JSON.stringify([agent.id, agent.adapter, agent.bin, agent.adapter === 'zcode' ? providerId : undefined])
}

function clock(value?: number): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

function money(balance: CodexSourceBalance): string {
  const value = Number(balance.total)
  if (!Number.isFinite(value)) return `${balance.currency} ${balance.total}`
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency }).format(value) }
  catch { return `${balance.currency} ${balance.total}` }
}

/** 展示账号的有效套餐窗口或余额。 */
function QuotaContent({ quota, agent }: { quota: CodexSourceQuota; agent: AgentDef }): JSX.Element {
  let body: ReactNode
  if (quota.kind === 'balance' && quota.balances?.length) {
    body = quota.balances.map((balance) => (
      <div className="qp-balance" key={balance.currency}>
        <span className="qp-balance-amt">余额 {money(balance)}</span>
        <span className="qp-balance-sub">含充值与赠送余额</span>
      </div>
    ))
  } else if (quota.kind === 'windows' && quota.windows?.length) {
    body = orderedSourceWindows(quota.windows).filter(win => Number.isFinite(win.usedPercent)).map((win) => {
      const usedPercent = Math.max(0, Math.min(100, win.usedPercent))
      const remainPercent = Math.max(0, Math.min(100, 100 - usedPercent))
      const cls = remainPercent <= 5 ? ' danger' : remainPercent <= 20 ? ' warn' : ''
      return (
        <div className={`quota-win${cls}`} key={win.label}>
          <div className="quota-head">
            <span className="quota-name">{win.label}</span>
            <span className={`quota-remain${cls}`}>剩余 {agent.adapter === 'grok' ? Math.ceil(remainPercent) : Math.round(remainPercent)}%</span>
          </div>
          <div className="quota-bar"><i style={{ width: `${remainPercent}%` }} /></div>
          {win.resetsAt ? <div className="quota-reset">{quotaResetText(win.resetsAt)}</div> : null}
        </div>
      )
    })
  } else {
    body = null
  }
  return <>{body}</>
}

export function QuotaHoverButton({ agents, enabledAgentIds, zcodeProviderId }: { agents: AgentDef[]; enabledAgentIds: string[]; zcodeProviderId?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [quotas, setQuotas] = useState<Record<string, { identity: string; quota: AgentQuotaSnapshot | null }>>({})
  const [scanning, setScanning] = useState(false)
  const scanVersion = useRef(0)
  const availableAgents = useMemo(() => agents.filter(agent => agent.installed !== false && agent.lifecycle?.availability === 'available' && enabledAgentIds.includes(agent.id)), [agents, enabledAgentIds])
  const agentKey = JSON.stringify(availableAgents.map(agent => quotaIdentity(agent, zcodeProviderId)))
  const [popPos, setPopPos] = useState<{ left: number; bottom: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const openedByHover = useRef(false)
  const pinned = useRef(false)
  const popoverId = useId()

  useEffect(() => {
    const remember = (adapter: AgentDef['adapter'], limits: CodexRateLimits): void => {
      const quota = accountQuota(limits)
      if (!quota) return
      for (const agent of availableAgents.filter(agent => agent.adapter === adapter)) storeQuota(agent, { ...quota, agentId: agent.id })
    }
    const offCodex = window.uniagent.onCodexRateLimits(limits => remember('codex', limits))
    const offClaude = window.uniagent.onClaudeRateLimits(limits => remember('claude', limits))
    return () => { offCodex(); offClaude() }
  }, [agentKey])

  useEffect(() => {
    if (open) void scanQuotas()
    return () => { scanVersion.current++ }
  }, [open, agentKey])

  // 悬浮窗用 fixed 定位以越过 .sidebar 的 overflow:hidden；打开时按按钮位置锚定，
  // 窗口尺寸变化时重算，避免侧栏拖宽后悬浮窗漂移。
  useEffect(() => {
    if (!open) return
    const measure = (): void => {
      const btn = btnRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const footer = btn.closest('.sidebar-footer')
      const left = footer ? footer.getBoundingClientRect().left + 12 : Math.max(8, rect.left - 268)
      setPopPos({ left, bottom: window.innerHeight - rect.top + 8 })
    }
    measure()
    window.addEventListener('resize', measure)
    const closeFromOutside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (btnRef.current?.contains(target)) return
      if (document.getElementById(popoverId)?.contains(target)) return
      closePopover()
    }
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    document.addEventListener('pointerdown', closeFromOutside, true)
    document.addEventListener('keydown', closeFromEscape, true)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('pointerdown', closeFromOutside, true)
      document.removeEventListener('keydown', closeFromEscape, true)
    }
  }, [open, popoverId])

  useEffect(() => () => {
    if (hoverCloseTimer.current != null) clearTimeout(hoverCloseTimer.current)
  }, [])

  function cancelHoverClose(): void {
    if (hoverCloseTimer.current == null) return
    clearTimeout(hoverCloseTimer.current)
    hoverCloseTimer.current = null
  }

  function openFromPointer(): void {
    pointerInside.current = true
    cancelHoverClose()
    setOpen((current) => {
      if (!current) openedByHover.current = true
      return true
    })
  }

  function scheduleHoverClose(): void {
    pointerInside.current = false
    cancelHoverClose()
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null
      if (pinned.current || pointerInside.current) return
      if (btnRef.current?.matches(':hover')) return
      openedByHover.current = false
      setOpen(false)
    }, HOVER_CLOSE_GRACE_MS)
  }

  function closePopover(): void {
    cancelHoverClose()
    pinned.current = false
    openedByHover.current = false
    setOpen(false)
  }

  function handleClick(): void {
    cancelHoverClose()
    setOpen((current) => {
      // 与 ContextMeter 一致：hover 已展开时的首次点击视为「固定」，再次点击关闭。
      if (current && openedByHover.current) {
        pinned.current = true
        openedByHover.current = false
        return true
      }
      pinned.current = !current
      openedByHover.current = false
      return !current
    })
  }

  const shownQuotas = availableAgents.flatMap(agent => {
    const entry = quotas[agent.id]
    return entry?.identity === quotaIdentity(agent, zcodeProviderId) && hasQuotaData(entry.quota) ? [{ agent, quota: entry.quota! }] : []
  })
  const hasAny = shownQuotas.length > 0
  const latestAt = Math.max(
    0,
    ...shownQuotas.map(({ quota }) => quota.capturedAt ?? 0)
  )
  const canRefresh = availableAgents.length > 0
  const cachedVendors = shownQuotas.filter(({ agent }) => agent.adapter !== 'codex' && agent.adapter !== 'claude').map(({ agent }) => agent.name).join(' 与')
  const staleVendors = shownQuotas.filter(({ quota }) => quota.stale).map(({ agent }) => agent.name)

  function storeQuota(agent: AgentDef, quota: AgentQuotaSnapshot | null): void {
    const identity = quotaIdentity(agent, zcodeProviderId)
    setQuotas(current => {
      const previous = current[agent.id]
      if (quota && previous?.identity === identity && (previous.quota?.capturedAt ?? 0) > (quota.capturedAt ?? 0)) {
        return quota.stale ? { ...current, [agent.id]: { identity, quota: { ...previous.quota!, stale: true } } } : current
      }
      return { ...current, [agent.id]: { identity, quota } }
    })
  }

  async function scanQuotas(force = false): Promise<void> {
    const version = ++scanVersion.current
    setScanning(true)
    try {
      await Promise.allSettled(availableAgents.map(async agent => {
        try {
          const quota = await window.uniagent.getAgentQuota(agent.id, force, agent.adapter === 'zcode' ? zcodeProviderId : undefined)
          if (version === scanVersion.current) storeQuota(agent, quota)
        } catch {
          if (version !== scanVersion.current) return
          const identity = quotaIdentity(agent, zcodeProviderId)
          setQuotas(current => {
            const previous = current[agent.id]
            return previous?.identity === identity && previous.quota
              ? { ...current, [agent.id]: { identity, quota: { ...previous.quota, stale: true } } } : current
          })
        }
      }))
    } finally {
      if (version === scanVersion.current) setScanning(false)
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`quota-entry${open ? ' open' : ''}`}
        title="模型额度"
        aria-label="查看各模型厂商额度使用情况"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onPointerEnter={openFromPointer}
        onPointerLeave={scheduleHoverClose}
        onClick={handleClick}
      >
        <UiIcon name="gauge" size={16} />
      </button>
      {open && popPos && createPortal(
        <div
          id={popoverId}
          className="quota-pop"
          role="dialog"
          aria-label="模型额度"
          style={{ left: popPos.left, bottom: popPos.bottom }}
          onPointerEnter={() => { pointerInside.current = true; cancelHoverClose() }}
          onPointerLeave={scheduleHoverClose}
        >
          <div className="qp-title">
            <span>模型额度</span>
            {latestAt > 0 && <span className="qp-title-time">{clock(latestAt)} 更新</span>}
          </div>
          {shownQuotas.map(({ agent, quota }) => (
            <div className="qp-vendor" key={agent.id}>
              <span className="qp-vendor-ic"><AgentIcon agentId={agent.id} adapter={agent.adapter} size={12} /></span>
              <span className="qp-vendor-name">{agent.name}</span>
              {quota.planType && <span className="qp-vendor-plan">{quota.planType}</span>}
              <div className="qp-vendor-body"><QuotaContent quota={quota} agent={agent} /></div>
            </div>
          ))}
          {!hasAny && <div className="qp-hint qp-empty">{scanning ? '正在查询额度…' : '当前可用 Agent 暂未返回额度数据'}</div>}
          {(hasAny || canRefresh) && (
            <div className="qp-foot">
              <span className="qp-note">{staleVendors.length ? `${staleVendors.join('、')} 额度刷新失败，显示上次结果` : `账号额度随会话运行自动更新${cachedVendors ? `，${cachedVendors}额度缓存 5 分钟` : ''}`}</span>
              {canRefresh && (
                <button type="button" className="qp-refresh" disabled={scanning} onClick={() => void scanQuotas(true)}>
                  <UiIcon name="refresh" size={11} /> {scanning ? '刷新中…' : '刷新'}
                </button>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
