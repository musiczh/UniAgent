import { useEffect, useMemo, useRef, useState } from 'react'
import type { UAEvent, UASubAgent } from '@shared/types'
import { EventStream } from './EventStream'
import { SubAgentIcon } from './SubAgentIcon'
import { Chevron, UiIcon } from './Icons'
import { formatSubAgentElapsed, readableSubAgentInput, subAgentDisplayName, subAgentTaskSummary } from '@shared/subAgentLifecycle'

/**
 * 子 Agent v3 — the sub-agent side panel (复刻 codex). A right-side, width-resizable
 * drawer with TWO pages:
 *  · list  — every child grouped 已开启 / 完成; click a row → detail.
 *  · detail — the selected child's FULL output, rendered with the SAME components
 *    as the main chat (reuses <EventStream>): call-chain fold, commands, replies,
 *    token footer. Header carries the 子智能体 badge + name + terminal state + tokens.
 * Its width is drag-adjustable at the left edge (clamped 320–640px, persisted).
 * Opening an item / a summary-card avatar jumps straight to the detail page.
 */
export function SubAgentPanel({
  open,
  sessionId,
  subagents,
  canCancel = false,
  activeThreadId,
  initialView = 'detail',
  onSelect,
  onClose
}: {
  open: boolean
  sessionId: string
  subagents: UASubAgent[]
  canCancel?: boolean
  activeThreadId: string
  /** 修复#4 — which page to boot to: inline row → detail, 摘要卡 entry → list. */
  initialView?: 'list' | 'detail'
  onSelect: (agentThreadId: string) => void
  onClose: () => void
}): JSX.Element | null {
  const [rendered, setRendered] = useState(open)
  const [closing, setClosing] = useState(false)

  // 改动3 — width is drag-adjustable at the panel's left edge, persisted.
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('ua.subPanelWidth'))
    return v >= 320 && v <= 640 ? v : 400
  })
  const dragRef = useRef(false)
  useEffect(() => {
    localStorage.setItem('ua.subPanelWidth', String(width))
  }, [width])
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      // Panel is anchored to the right edge; width grows as the pointer moves left.
      setWidth(Math.min(640, Math.max(320, window.innerWidth - e.clientX)))
    }
    const onUp = (): void => {
      dragRef.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 改动4 / 修复#3 — internal routing between the list page and a child's detail
  // page. The panel boots to `initialView` (inline row → detail, 摘要卡 → list).
  // We track the last activeThreadId so we only auto-switch to detail when a
  // GENUINELY NEW child is selected (a real click), never on the frequent parent
  // re-renders driven by the roster poll — that spurious re-force is what made
  // "‹ 返回列表" appear to do nothing (it flipped back to detail immediately).
  const [view, setView] = useState<'list' | 'detail'>(activeThreadId ? initialView : 'list')
  const lastThreadRef = useRef<string>(activeThreadId)
  const displayedThreadId = activeThreadId || lastThreadRef.current
  const wasOpenRef = useRef(open)
  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current) {
        setView(activeThreadId ? initialView : 'list')
        lastThreadRef.current = activeThreadId
      }
      setRendered(true)
      setClosing(false)
    } else if (rendered) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setRendered(false)
      else setClosing(true)
    }
    wasOpenRef.current = open
  }, [open, rendered, activeThreadId, initialView])
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setRendered(false)
      setClosing(false)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [closing])
  useEffect(() => {
    if (activeThreadId && activeThreadId !== lastThreadRef.current) {
      lastThreadRef.current = activeThreadId
      setView('detail')
    }
  }, [activeThreadId])

  const active = subagents.find((a) => a.agentThreadId === displayedThreadId) || subagents[0]
  const [cancelRequest, setCancelRequest] = useState<{ threadId: string; pending: boolean; failed?: boolean }>()
  const cancelInFlight = useRef(false)
  useEffect(() => { setCancelRequest(undefined) }, [sessionId, active?.agentThreadId])
  const cancelActive = async (): Promise<void> => {
    if (!canCancel || active?.status !== 'running' || cancelInFlight.current) return
    cancelInFlight.current = true
    const threadId = active.agentThreadId
    setCancelRequest({ threadId, pending: true })
    try {
      await window.uniagent.cancelSubAgent(sessionId, threadId)
      setCancelRequest({ threadId, pending: false })
    } catch {
      setCancelRequest({ threadId, pending: false, failed: true })
    } finally { cancelInFlight.current = false }
  }
  const currentCancel = cancelRequest?.threadId === active?.agentThreadId ? cancelRequest : undefined
  const [items, setItems] = useState<UAEvent[]>([])
  const [loadedThreadId, setLoadedThreadId] = useState('')
  const [loading, setLoading] = useState(false)
  // Tick once per second so the "已处理 N 秒" timers advance while running.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!rendered) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [rendered])

  // Lazy-load the active child's own rollout for the detail page; refresh when it
  // changes and poll while it's still running so incremental output shows up.
  useEffect(() => {
    if (!rendered || !active || view !== 'detail') return
    let cancelled = false
    const load = (first: boolean): void => {
      if (first) setLoading(true)
      window.uniagent
        .getSubAgentItems(sessionId, active.agentThreadId)
        .then((its) => {
          if (!cancelled) {
            setItems(Array.isArray(its) ? (its as UAEvent[]) : [])
            setLoadedThreadId(active.agentThreadId)
          }
        })
        .finally(() => {
          if (!cancelled && first) setLoading(false)
        })
    }
    load(true)
    const poll =
      active.status === 'running' || active.status === 'pendingInit'
        ? setInterval(() => load(false), 1500)
        : null
    return () => {
      cancelled = true
      if (poll) clearInterval(poll)
    }
  }, [sessionId, active?.agentThreadId, active?.status, view, rendered]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusLabel: Record<string, string> = {
    pendingInit: '准备中',
    running: '进行中',
    interrupted: '已中断',
    completed: '已完成',
    errored: '出错',
    shutdown: '已结束',
    notFound: '未找到'
  }
  const statusClass: Record<string, string> = {
    running: 'run',
    pendingInit: 'run',
    interrupted: 'intr',
    errored: 'err',
    completed: 'done',
    shutdown: 'done',
    notFound: 'err'
  }

  const elapsed = (a: UASubAgent): string => {
    return formatSubAgentElapsed(a, now)
  }

  // Group the roster for the list page: running/pending first (已开启), then done.
  const grouped = useMemo(() => {
    const open = subagents.filter((a) => a.status === 'running' || a.status === 'pendingInit')
    const finished = subagents.filter((a) => a.status !== 'running' && a.status !== 'pendingInit')
    return { open, finished }
  }, [subagents])

  // Prepend the child's dispatched task as a synthetic user turn so the detail
  // stream reads exactly like a main chat (输入任务 → 调用链路 → 输出 → token).
  // Keep the rollout's real user-message order. Only synthesize the initial task
  // when the child history has no user message to order for us.
  const detailEvents = useMemo(
    () => subAgentDetailEvents(active, items),
    [active?.agentThreadId, active?.prompt, items] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const detailStatus = active && (active.status === 'running' || active.status === 'pendingInit')
    ? 'running'
    : 'idle'

  if (!rendered) return null

  return (
    <div
      className="subagent-overlay"
      data-closing={closing || undefined}
      aria-hidden={closing}
      onClick={onClose}
    >
      <div
        className="subagent-panel"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="subagent-panel-grip"
          title="拖动调整宽度"
          onMouseDown={() => {
            dragRef.current = true
          }}
        />
        {view === 'list' ? (
          <>
            <div className="subagent-panel-head">
              <span className="subagent-panel-title"><UiIcon name="users" size={15} /> 子智能体</span>
              <button className="close-x" title="关闭" aria-label="关闭子智能体面板" onClick={onClose}>
                <UiIcon name="close" size={14} />
              </button>
            </div>
            <div className="subagent-listpage">
              {grouped.open.length > 0 && (
                <>
                  <div className="side-grouph">已开启 · {grouped.open.length}</div>
                  {grouped.open.map((a) => (
                    <SideItem
                      key={a.agentThreadId}
                      a={a}
                      statusText={
                        statusLabel[a.status] +
                        (a.status === 'running' ? ` · ${elapsed(a)}` : '')
                      }
                      onOpen={() => {
                        onSelect(a.agentThreadId)
                        setView('detail')
                      }}
                    />
                  ))}
                </>
              )}
              {grouped.finished.length > 0 && (
                <>
                  <div className="side-grouph">完成 · {grouped.finished.length}</div>
                  {grouped.finished.map((a) => (
                    <SideItem
                      key={a.agentThreadId}
                      a={a}
                      statusText={statusLabel[a.status] || a.status}
                      onOpen={() => {
                        onSelect(a.agentThreadId)
                        setView('detail')
                      }}
                    />
                  ))}
                </>
              )}
              {subagents.length === 0 && (
                <div className="subagent-empty">暂无子智能体</div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="subagent-panel-head">
              <button className="subagent-back" onClick={() => setView('list')}>
                <UiIcon name="back" size={15} /> 返回列表
              </button>
              {canCancel && active?.status === 'running' && (
                <button className="subagent-back subagent-cancel" aria-label="取消子智能体"
                  disabled={currentCancel?.pending} onClick={cancelActive}>
                  {currentCancel?.pending ? '正在取消…' : '取消子智能体'}
                </button>
              )}
              <button className="close-x" title="关闭" aria-label="关闭子智能体面板" onClick={onClose}>
                <UiIcon name="close" size={14} />
              </button>
            </div>
            {active && (
              <div className="subagent-detailpage">
                <div className="detail-hd">
                  <SubAgentIcon threadId={active.agentThreadId} size={34} />
                  <span className="detail-badge">子智能体</span>
                  <span className="detail-nm" title={[subAgentDisplayName(active), subAgentTaskSummary(active.prompt)].filter(Boolean).join(' · ')}>
                    {subAgentDisplayName(active)}
                    {subAgentTaskSummary(active.prompt) && <span className="sa-task"> · {subAgentTaskSummary(active.prompt)}</span>}
                  </span>
                </div>
                <div className="detail-sub">
                  <span className={`st ${statusClass[active.status] || ''}`}>
                    {statusLabel[active.status] || active.status}
                  </span>
                  {/* 修复#6 — the header shows TIME consumption (用时), never tokens:
                      the child's token total already renders in the stream's token
                      footer below, so a second tokens figure here was redundant. */}
                  {(active.startedAt || 0) > 0 && (
                    <>
                      {' · '}
                      {active.status === 'running' || active.status === 'pendingInit'
                        ? `已处理 ${elapsed(active)}`
                        : `用时 ${elapsed(active)}`}
                    </>
                  )}
                </div>
                {canCancel && currentCancel?.failed && active.status === 'running' && (
                  <div className="detail-sub subagent-cancel-error" role="alert">取消失败，请重试。子智能体仍在运行。</div>
                )}
                <div className="subagent-detail-stream">
                  {loading || loadedThreadId !== active.agentThreadId ? (
                    <div className="subagent-empty">加载中…</div>
                  ) : detailEvents.length > 0 ? (
                    <EventStream
                      events={detailEvents}
                      status={detailStatus}
                      manageProcessedFoldScroll
                    />
                  ) : (
                    <div className="subagent-empty">
                      {active.status === 'running' ? '正在思考…' : '暂无更多内容'}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** One row in the sub-agent list page (icon · name · status · elapsed). */
function SideItem({
  a,
  statusText,
  onOpen
}: {
  a: UASubAgent
  statusText: string
  onOpen: () => void
}): JSX.Element {
  return (
    <button className="side-item" onClick={onOpen} title={[subAgentDisplayName(a), subAgentTaskSummary(a.prompt)].filter(Boolean).join(' · ')}>
      <SubAgentIcon threadId={a.agentThreadId} size={22} />
      <span className="txt">
        <span className="nm">
          {subAgentDisplayName(a)}
          {subAgentTaskSummary(a.prompt) && <span className="sa-task"> · {subAgentTaskSummary(a.prompt)}</span>}
        </span>
        <span className="st">{statusText}</span>
      </span>
      <span className="chev"><Chevron size={12} /></span>
    </button>
  )
}

export function subAgentDetailEvents(active: UASubAgent | undefined, items: UAEvent[]): UAEvent[] {
  const visible = items.flatMap((event) => {
    if (event.type !== 'user_message' || readableSubAgentInput(event.payload.text)) return [event]
    return event.payload.attachments?.length
      ? [{ ...event, payload: { ...event.payload, text: '' } }]
      : []
  })
  const prompt = readableSubAgentInput(active?.prompt)
  if (!prompt || visible.some((event) => event.type === 'user_message')) return visible
  return [{
    sessionId: '',
    seq: -1,
    ts: active?.startedAt || Date.now(),
    type: 'user_message',
    payload: { text: prompt }
  } as UAEvent, ...visible]
}
