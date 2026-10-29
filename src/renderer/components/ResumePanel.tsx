import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isCrossForkTargetAgent,
  isCrossForkSourceAgent,
  type AgentDef,
  type HistoryForkPoint,
  type HistoryLoadProgress,
  type SessionSummary,
  type UAEvent
} from '@shared/types'
import { AgentIcon } from './AgentIcon'
import { EventStream, subAgentsFromEvents } from './EventStream'
import { Chevron, RefreshIcon, UiIcon } from './Icons'

export type HistoryItemAccess =
  | { canPreview: true; canForkSame: boolean; mode: 'preview' }
  | { canPreview: false; canForkSame: true; mode: 'fork-only' }
  | { canPreview: false; canForkSame: false; mode: 'unavailable' }

const cachedHistoryByAgent = new Map<string, SessionSummary[]>()

/**
 * History resume panel (Doc2 需求3.2/3.3). 需求13: rendered INLINE in the main
 * chat area (codex-style), not a floating drawer. Lists each installed agent's
 * native CLI sessions.
 *
 * 修复#2（只读快照不再进侧栏）— clicking a row no longer imports the snapshot as a
 * sidebar Session. Instead it opens an inline READ-ONLY VIEWER that replays the
 * conversation (via `previewHistory`, which mints NO orchestrator Session). From
 * the viewer the user can choose a lossless same-Agent fork, directly import the
 * original native session, or rebuild it under another Agent. Previewing alone
 * still creates no orchestrator Session, so browsing never pollutes the sidebar.
 */
export function ResumePanel({
  agents,
  e2eFixtures = false,
  onForkSame,
  onImport,
  onForkCross,
  embedded = false
}: {
  agents: AgentDef[]
  e2eFixtures?: boolean
  /** 以嵌入形态挂进设置内容区：去掉独立 main-panel 外壳（与 AgentCapabilitiesPanel embedded 同款）。 */
  embedded?: boolean
  onForkSame: (
    agentId: string,
    nativeId: string,
    cwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode?: boolean
  ) => void | Promise<void>
  onImport: (
    agentId: string,
    nativeId: string,
    cwd?: string,
    historyTitle?: string
  ) => void | Promise<void>
  onForkCross: (
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    point?: HistoryForkPoint
  ) => void | Promise<void>
}): JSX.Element {
  const historyAgents = useMemo(
    () => agents.filter((agent) => supportsSessionCapability(agent, 'sessionList')),
    [agents]
  )
  const [agentId, setAgentId] = useState<string>(historyAgents[0]?.id || '')
  const [items, setItems] = useState<SessionSummary[]>(
    () => cachedHistoryByAgent.get(historyAgents[0]?.id || '') || []
  )
  const [loading, setLoading] = useState(
    () => !!historyAgents[0]?.id && !cachedHistoryByAgent.has(historyAgents[0].id)
  )
  const [query, setQuery] = useState('')
  // 修复#2 — which native session is open in the read-only viewer (null = list).
  const [viewing, setViewing] = useState<SessionSummary | null>(null)
  const historyGenerationRef = useRef(0)
  const activeAgent = historyAgents.find((a) => a.id === agentId)
  const historyItemAccess = describeHistoryItemAccess(activeAgent)
  const canLoadActiveHistory = historyItemAccess.canPreview
  const canForkActiveHistory = historyItemAccess.canForkSame
  const canReachHistoryItem = historyItemAccess.mode !== 'unavailable'

  // Capability negotiation can update live. Move to another eligible agent and
  // close a viewer immediately if the current provider loses history support.
  useEffect(() => {
    if (historyAgents.some((agent) => agent.id === agentId)) return
    historyGenerationRef.current += 1
    const nextAgentId = historyAgents[0]?.id || ''
    setAgentId(nextAgentId)
    setItems(cachedHistoryByAgent.get(nextAgentId) || [])
    setLoading(!!nextAgentId)
    setViewing(null)
  }, [agentId, historyAgents])

  useEffect(() => {
    if (!canLoadActiveHistory) setViewing(null)
  }, [canLoadActiveHistory])

  // 需求6 — a single reusable loader for the active agent's history. It bumps the
  // generation ref so any in-flight (or stale) request is ignored, then re-fetches
  // from disk. Used both by the open effect (below) and the manual 刷新 button, so
  // "打开面板即重新加载" and "手动刷新" share exactly one race-safe code path.
  const reload = useCallback((): void => {
    if (!agentId || !activeAgent) {
      historyGenerationRef.current += 1
      setItems([])
      setLoading(false)
      return
    }
    const generation = ++historyGenerationRef.current
    const isCurrent = (): boolean => generation === historyGenerationRef.current
    const requestedAgentId = agentId
    const cached = cachedHistoryByAgent.get(requestedAgentId)
    if (cached) setItems(cached)
    setLoading(true)
    void window.uniagent
      .listAgentHistory(requestedAgentId)
      .then((history) => {
        if (!isCurrent()) return
        cachedHistoryByAgent.set(requestedAgentId, history)
        setItems((current) =>
          JSON.stringify(current) === JSON.stringify(history) ? current : history
        )
      })
      .catch(() => {
        if (isCurrent() && !cachedHistoryByAgent.has(requestedAgentId)) setItems([])
      })
      .finally(() => {
        if (isCurrent()) setLoading(false)
      })
  }, [activeAgent, agentId])

  // 需求6 — reload on every panel open / active-agent switch, so newly-produced or
  // newly-independent sessions appear without restarting the app.
  useEffect(() => {
    reload()
    return () => {
      historyGenerationRef.current += 1
    }
  }, [reload])

  const selectAgent = (nextAgentId: string): void => {
    if (nextAgentId === agentId) return
    // Invalidate the old request synchronously, before the effect cleanup runs.
    historyGenerationRef.current += 1
    setItems(cachedHistoryByAgent.get(nextAgentId) || [])
    setViewing(null)
    setLoading(true)
    setAgentId(nextAgentId)
  }

  const visibleItems = e2eFixtures ? [e2eHistoryFixture(agentId), ...items] : items
  const filtered = visibleItems.filter((session) => matchesHistoryItem(session, query))
  const forkOnlyCount = historyItemAccess.mode === 'fork-only' ? filtered.length : 0
  const hasCachedHistory = cachedHistoryByAgent.has(agentId)

  // 修复#2 — the read-only viewer takes over the panel when a row is opened.
  if (viewing && activeAgent && canLoadActiveHistory) {
    return (
      <HistoryViewer
        agents={agents}
        summary={viewing}
        e2eFixtures={e2eFixtures}
        embedded={embedded}
        onBack={() => setViewing(null)}
        onForkSame={onForkSame}
        onImport={onImport}
        onForkCross={onForkCross}
      />
    )
  }

  return (
    <div className={embedded ? 'resume-panel resume-embedded' : 'main-panel resume-panel'}>
      <div className="main-panel-head">
        <span className="main-panel-title">历史会话 · 恢复</span>
        <button
          className="resume-refresh-btn"
          type="button"
          onClick={() => reload()}
          disabled={loading || !activeAgent}
          title="重新扫描该 Agent 的历史会话"
        >
          <RefreshIcon className={`resume-refresh-icon ${loading ? 'is-spinning' : ''}`} />
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {/* codex-style agent chips row */}
      <div className="drawer-agent-tabs">
        {historyAgents.map((a) => (
          <button
            key={a.id}
            className={`drawer-agent-tab ${a.id === agentId ? 'active' : ''}`}
            onClick={() => selectAgent(a.id)}
          >
            <AgentIcon agentId={a.id} adapter={a.adapter} size={14} />
            {a.name}
          </button>
        ))}
      </div>
      {historyAgents.length > 0 && (
        <div className="drawer-search-row">
          <input
            className="drawer-search"
            placeholder="搜索标题 / 目录…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="drawer-list resume-list">
        {historyAgents.length === 0 ? (
          <div className="drawer-empty">当前 Agent 均未提供历史会话列表能力</div>
        ) : loading && !hasCachedHistory ? (
          <div className="drawer-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="drawer-empty">没有找到历史会话</div>
        ) : (
          filtered.map((s) => (
            <div key={s.id} className="drawer-item resume-item">
              <div
                className={`resume-item-open ${canReachHistoryItem ? '' : 'is-disabled'}`}
                onClick={() => {
                  if (canLoadActiveHistory) setViewing(s)
                }}
                aria-disabled={!canReachHistoryItem}
                title={
                  canLoadActiveHistory
                    ? '查看只读快照'
                    : historyItemAccess.mode === 'fork-only'
                      ? '该 Agent 仅支持分叉此历史会话，不支持加载只读快照'
                      : '该 Agent 不支持加载或分叉历史会话'
                }
              >
                <span className="drawer-item-icon">
                  <AgentIcon
                    agentId={s.agentId}
                    adapter={agents.find((a) => a.id === s.agentId)?.adapter}
                    size={15}
                  />
                </span>
                <div className="drawer-item-main">
                  <div className="drawer-item-title resume-item-title">{s.title}</div>
                  <div className="drawer-item-meta resume-item-meta">
                    {s.cwd && <span className="resume-cwd">{shortPath(s.cwd)}</span>}
                    <span className="resume-time">{fmtTime(s.updatedAt)}</span>
                  </div>
                  {!canLoadActiveHistory && canForkActiveHistory && (
                    <div className="drawer-item-meta resume-item-meta">
                      <span>不可预览</span>
                      <span>可原 Agent 分叉</span>
                    </div>
                  )}
                </div>
                <div className="resume-item-actions">
                  {canLoadActiveHistory ? (
                    <span className="resume-item-chevron"><Chevron size={14} /></span>
                  ) : canForkActiveHistory ? (
                    <button
                      className="fork-btn fork-btn-primary"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void onForkSame(agentId, s.id, s.cwd)
                      }}
                      title="直接分叉为新的可写会话，不会尝试加载历史内容"
                    >
                      <UiIcon name="fork" size={14} /> 分叉续跑
                    </button>
                  ) : (
                    <span className="resume-item-chevron"><Chevron size={14} /></span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="drawer-foot">
        {historyAgents.length === 0
          ? '历史功能不可用'
          : canLoadActiveHistory
            ? `共 ${filtered.length} 个会话 · 点击任意条目查看只读快照`
            : canForkActiveHistory
              ? `共 ${forkOnlyCount} 个会话 · 该 Agent 不支持预览，但可直接分叉续跑`
              : `共 ${filtered.length} 个会话 · 该 Agent 不支持加载或分叉历史会话`}
      </div>
    </div>
  )
}

export function matchesHistoryItem(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [session.title, session.firstUserMessage, session.cwd, session.id].some(
    (value) => value?.toLowerCase().includes(needle)
  )
}

/**
 * 修复#2 — the inline READ-ONLY viewer for a single history session. Replays the
 * normalized transcript (no orchestrator Session is created) and offers the fork
 * actions to continue, or 返回 to go back to the list.
 */
export type HistoryAction =
  | { kind: 'same'; point?: HistoryForkPoint; compatibilityMode?: boolean }
  | { kind: 'cross'; targetAgentId: string; point?: HistoryForkPoint }
  | { kind: 'import' }

const historyLoadLabels: Record<HistoryLoadProgress['phase'], string> = {
  preparing: '正在准备会话加载',
  locating: '正在查找历史文件',
  reading: '正在读取当前历史文件',
  'reading-parent': '正在读取父会话历史文件',
  rollbacks: '正在整理会话历史',
  scanning: '正在分析会话结构',
  parsing: '正在解析会话记录',
  subagents: '正在整理子 Agent 状态',
  'fork-points': '正在查找可分叉位置',
  replaying: '正在等待 Agent 回放会话',
  rendering: '正在显示会话内容',
  complete: '会话加载完成'
}

type PreviewProgress = HistoryLoadProgress & { percent: number }

function HistoryLoading({ progress, onComplete }: { progress: PreviewProgress; onComplete: () => void }): JSX.Element {
  const displayed = useRef(0)
  const [percent, setPercent] = useState(0)
  useEffect(() => {
    const from = displayed.current
    const target = Math.max(from, progress.percent)
    const start = performance.now()
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240
    let frame: number
    const animate = (now: number): void => {
      const fraction = duration ? Math.min(1, Math.max(0, (now - start) / duration)) : 1
      const next = from + (target - from) * (1 - (1 - fraction) ** 3)
      displayed.current = next
      setPercent(next)
      if (fraction < 1) frame = requestAnimationFrame(animate)
      else if (target === 100) frame = requestAnimationFrame(onComplete)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [progress.percent, onComplete])
  const label = historyLoadLabels[progress.phase]
  return (
    <div className="history-loading">
      <div className="history-loading-content">
        <div className="history-loading-label">
          <span role="status">{label}</span>
          <span className="history-loading-percent">{Math.floor(percent)}%</span>
        </div>
        <div
          className="history-loading-track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(percent)}
        >
          <div
            className="history-loading-fill"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
      </div>
    </div>
  )
}

function HistoryViewer({
  agents,
  summary,
  e2eFixtures,
  embedded = false,
  onBack,
  onForkSame,
  onImport,
  onForkCross
}: {
  agents: AgentDef[]
  summary: SessionSummary
  e2eFixtures: boolean
  embedded?: boolean
  onBack: () => void
  onForkSame: (
    agentId: string,
    nativeId: string,
    cwd?: string,
    point?: HistoryForkPoint,
    compatibilityMode?: boolean
  ) => void | Promise<void>
  onImport: (
    agentId: string,
    nativeId: string,
    cwd?: string,
    historyTitle?: string
  ) => void | Promise<void>
  onForkCross: (
    sourceAgentId: string,
    nativeId: string,
    targetAgentId: string,
    point?: HistoryForkPoint
  ) => void | Promise<void>
}): JSX.Element {
  const [events, setEvents] = useState<UAEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadProgress, setLoadProgress] = useState<PreviewProgress>({ phase: 'preparing', percent: 0 })
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [pickCross, setPickCross] = useState(false)
  const [busy, setBusy] = useState(false)
  const [forkPoints, setForkPoints] = useState<HistoryForkPoint[]>([])
  const [actionError, setActionError] = useState('')
  const [confirmation, setConfirmation] = useState<HistoryAction | null>(null)
  const busyRef = useRef(false)
  const sourceAgentId = summary.agentId
  const sourceAgent = agents.find((agent) => agent.id === sourceAgentId)
  const canForkSame = supportsSessionCapability(sourceAgent, 'sessionFork')
  const canImportDirect =
    supportsSessionCapability(sourceAgent, 'sessionLoad') &&
    supportsSessionCapability(sourceAgent, 'sessionResume')
  const canCrossFromSource = isCrossForkSourceAgent(sourceAgent) && supportsSessionCapability(sourceAgent, 'sessionLoad')
  const others = agents.filter(
    (agent) =>
      agent.id !== sourceAgentId &&
      canCrossFromSource &&
      supportsCrossAgentImportTarget(agent)
  )

  useEffect(() => {
    let live = true
    setEvents([])
    setForkPoints([])
    setActionError('')
    setConfirmation(null)
    setLoading(true)
    setHistoryLoaded(false)
    setLoadProgress({ phase: 'preparing', percent: 0 })
    if (summary.id === '__ua_e2e_history__' && e2eFixtures) {
      setEvents([{ sessionId: '', seq: 0, ts: Date.now(), type: 'agent_message', state: 'success', payload: { text: 'E2E history fixture' } }])
      setLoading(false)
      return () => { live = false }
    }
    const requestId = crypto.randomUUID()
    const unsubscribe = window.uniagent.onHistoryPreviewProgress((progress) => {
      if (live && progress.requestId === requestId) setLoadProgress(progress)
    })
    void window.uniagent
      .previewHistory(sourceAgentId, summary.id, summary.cwd, requestId)
      .then((res) => {
        if (live) {
          setEvents(res.events || [])
          setForkPoints(res.forkPoints || [])
          setLoadProgress({ phase: 'rendering', percent: 98 })
          setHistoryLoaded(true)
        }
      })
      .catch(() => {
        if (live) {
          setEvents([])
          setLoading(false)
        }
      })
      .finally(() => {
        unsubscribe()
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [e2eFixtures, sourceAgentId, summary.id, summary.cwd])

  useEffect(() => {
    if (!historyLoaded || !loading) return
    const frame = requestAnimationFrame(() => setLoadProgress({ phase: 'complete', percent: 100 }))
    return () => cancelAnimationFrame(frame)
  }, [historyLoaded, loading])
  const finishLoading = useCallback(() => setLoading(false), [])

  const run = async (fn: () => void | Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    try {
      await fn()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败，请重试')
    } finally {
      busyRef.current = false
      setBusy(false)
      setPickCross(false)
    }
  }

  const requestConfirmation = (action: HistoryAction): void => {
    if (busyRef.current) return
    setPickCross(false)
    setActionError('')
    setConfirmation(action)
  }

  const confirmAction = (): void => {
    if (!confirmation) return
    const action = confirmation
    setConfirmation(null)
    void run(async () => {
      if (action.kind === 'same') {
        if (!canForkSame || (action.point && !forkPoints.includes(action.point))) {
          throw new Error('所选分叉位置已不可用，请重新预览后选择')
        }
        await onForkSame(
          sourceAgentId,
          summary.id,
          summary.cwd,
          action.point,
          action.compatibilityMode === true
        )
      } else if (action.kind === 'cross') {
        if (!others.some((agent) => agent.id === action.targetAgentId) ||
            (action.point && !forkPoints.includes(action.point))) {
          throw new Error('所选 Agent 当前不可用，请重新选择')
        }
        await onForkCross(sourceAgentId, summary.id, action.targetAgentId, action.point)
      } else {
        if (!canImportDirect) throw new Error('当前 Agent 不支持直接导入')
        await onImport(sourceAgentId, summary.id, summary.cwd, summary.title)
      }
    })
  }

  return (
    <div className={embedded ? 'resume-panel resume-embedded history-viewer' : 'main-panel resume-panel history-viewer'}>
      <div className="main-panel-head history-viewer-head">
        <button className="history-back-btn" onClick={onBack} title="返回历史列表">
          <UiIcon name="back" size={14} /> 返回列表
        </button>
        <span className="main-panel-title history-viewer-title" title={summary.title}>
          {summary.title}
        </span>
        <span className="fork-bar-badge">只读快照</span>
      </div>
      <div className="history-viewer-body" aria-busy={loading}>
        {loading && <HistoryLoading key={`${sourceAgentId}:${summary.id}`} progress={loadProgress} onComplete={finishLoading} />}
        {(historyLoaded || !loading) && (events.length === 0 ? (
          <div className="drawer-empty">该会话没有可回放的内容</div>
        ) : (
          <EventStream
            events={events}
            status="idle"
            subagents={subAgentsFromEvents(events)}
            historyFork={sourceAgent && canForkSame && forkPoints.length ? {
              agentName: sourceAgent.name,
              points: forkPoints,
              busy,
              onFork: (point) => requestConfirmation({ kind: 'same', point })
            } : undefined}
          />
        ))}
      </div>
      {/* Continue actions: independent same-Agent fork first, then direct native
          import, followed by cross-Agent rebuild when supported. */}
      <div className="fork-bar history-viewer-fork">
        {actionError && <div className="history-fork-error" role="alert">{actionError}</div>}
        <div className="fork-bar-note">
          {canImportDirect ? (
            <>这是<strong>只读预览</strong>。可分叉出独立会话，或直接导入并续写原生会话；直接导入后请勿在 TUI/其它窗口中并发使用。</>
          ) : (
            <>这是<strong>只读预览</strong>。当前 Agent 不支持直接导入，请选择可用的分叉操作。</>
          )}
        </div>
        <div className="fork-bar-actions">
          {canForkSame && (
            <button
              className="fork-btn fork-btn-primary"
              disabled={busy}
              title="复制原生会话为可恢复的新分支"
              onClick={() => requestConfirmation({ kind: 'same' })}
            >
              <UiIcon name="fork" size={14} /> 原 Agent 分叉续跑
            </button>
          )}
          {canImportDirect && (
            <button
              className="fork-btn"
              disabled={busy}
              title="复用原生会话直接续跑；请勿与 TUI 或其它窗口并发使用"
              onClick={() => requestConfirmation({ kind: 'import' })}
            >
              <UiIcon name="history" size={14} /> 原生 Agent 直接导入
            </button>
          )}
          {others.length > 0 && (
            <div className="fork-cross">
              <button
                className="fork-btn"
                disabled={busy}
                title="把会话归一化重建到另一个 Agent 后续跑（可能有损）"
                onClick={() => setPickCross((v) => !v)}
              >
                <UiIcon name="fork" size={14} /> 换 Agent 分叉…
              </button>
              {pickCross && (
                <div className="fork-cross-menu">
                  <div className="fork-cross-hint">
                    归一化重建，可能丢失推理/工具细节
                  </div>
                  {others.map((a) => (
                    <button
                      key={a.id}
                      className="fork-cross-target"
                      disabled={busy}
                      onClick={() => requestConfirmation({ kind: 'cross', targetAgentId: a.id })}
                    >
                      <AgentIcon agentId={a.id} adapter={a.adapter} size={13} />
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {confirmation && (
        <HistoryConfirmation
          action={confirmation}
          agentName={confirmation.kind === 'cross'
            ? others.find((agent) => agent.id === confirmation.targetAgentId)?.name || confirmation.targetAgentId
            : sourceAgent?.name || sourceAgentId}
          title={summary.title}
          sourceAgentId={sourceAgentId}
          targetAgents={sourceAgent && canForkSame ? [sourceAgent, ...others] : others}
          onChangeAction={setConfirmation}
          selectedEvent={confirmation.kind !== 'import' && confirmation.point
            ? events.find((event) => event.seq === confirmation.point?.eventSeq)
            : undefined}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmAction}
        />
      )}
    </div>
  )
}

export function HistoryConfirmation({
  action, agentName, title, selectedEvent, sourceAgentId, targetAgents, chooseTarget = false, onChangeAction, onCancel, onConfirm
}: {
  action: HistoryAction
  agentName: string
  title: string
  selectedEvent?: UAEvent
  sourceAgentId: string
  targetAgents: AgentDef[]
  chooseTarget?: boolean
  onChangeAction: (action: HistoryAction) => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialogRef.current?.showModal() }, [])
  const point = action.kind !== 'import' ? action.point : undefined
  const isImport = action.kind === 'import'
  const isCross = action.kind === 'cross'
  const rebuildsSameAgentHistory = chooseTarget && !point && sourceAgentId === 'claude'
  const sourceAgent = targetAgents.find((agent) => agent.id === sourceAgentId)
  const canUseCompatibilityMode = action.kind === 'same' && (
    (sourceAgent?.id === 'codex' && sourceAgent.adapter === 'codex') ||
    (sourceAgent?.id === 'traex' && sourceAgent.adapter === 'traex')
  )
  const compatibilityMode = action.kind === 'same' && action.compatibilityMode === true
  const targetId = isCross ? action.targetAgentId : sourceAgentId
  const canChooseTarget = chooseTarget || !!point
  const position = point?.kind === 'after-turn' ? '所选回复所在轮次结束（包含补充信息）'
    : point ? '所选消息之后（包含该条）' : chooseTarget ? '当前会话末尾' : '会话末尾'
  const range = compatibilityMode ? '部分推理、工具及原生上下文可能无法保留。'
    : point?.kind === 'after-turn' ? '完整继承本轮全部回复及补充信息；之后的轮次不继承。'
    : point ? '继承至所选消息，包含该条；之后的消息不继承。'
      : isCross ? '迁移完整会话中可恢复的内容，可能丢失推理、工具及原生上下文。'
        : isImport ? '直接续写完整原生会话，后续对话会保存到原会话。'
          : rebuildsSameAgentHistory ? '重建可恢复的历史内容；部分推理、工具及原生上下文可能无法保留。'
            : '继承完整原生会话历史。'
  const selectedText = typeof selectedEvent?.payload.text === 'string' ? selectedEvent.payload.text : ''
  const quote = selectedText.replace(/\s+/g, ' ').trim()
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay history-confirm-overlay"
      aria-labelledby="history-confirm-title"
      aria-describedby="history-confirm-range"
      onCancel={(event) => { event.preventDefault(); onCancel() }}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div className="loading-modal history-confirm-modal">
        <div className="loading-modal-title" id="history-confirm-title">
          {isImport ? '确认直接导入原会话' : chooseTarget ? '分叉新会话' : point ? '确认从此处分叉' : isCross ? '确认换 Agent 分叉' : '确认分叉完整会话'}
        </div>
        <div className="loading-modal-note">
          {isImport ? '使用原 Agent 继续原会话。' : isCross || canChooseTarget ? '创建独立会话，使用所选 Agent 继续。' : '创建独立会话，使用原 Agent 继续。'}
        </div>
        {canChooseTarget && (
          <label className="history-confirm-target">
            <span>目标 Agent</span>
            <select
              className="settings-select"
              value={targetId}
              onChange={(event) => onChangeAction(event.target.value === sourceAgentId
                ? { kind: 'same', point }
                : { kind: 'cross', targetAgentId: event.target.value, point })}
            >
              {targetAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}{agent.id === sourceAgentId ? '（当前 Agent）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {canUseCompatibilityMode && (
          <div className="history-confirm-compat">
            <div className="settings-toggle-copy">
              <span className="settings-toggle-label">兼容模式</span>
              <span className="settings-toggle-description">重建历史，便于切换模型来源</span>
            </div>
            <button
              type="button"
              className="ui-switch"
              role="switch"
              aria-label="兼容模式"
              aria-checked={compatibilityMode}
              onClick={() => onChangeAction({ kind: 'same', point, compatibilityMode: !compatibilityMode })}
            >
              <span className="ui-switch-thumb" />
            </button>
          </div>
        )}
        <div className="history-confirm-summary">
          <div><span>继承方式</span><strong>{isImport ? '原生 Agent 直接导入' : isCross ? '换 Agent 重建' : compatibilityMode ? '兼容模式' : rebuildsSameAgentHistory ? '原 Agent 历史重建' : '原 Agent 原生记录分叉'}</strong></div>
          {!canChooseTarget && <div><span>Agent</span><strong>{agentName}</strong></div>}
          <div><span>{isImport ? '续写位置' : '分叉位置'}</span><strong>{position}</strong></div>
          <p className="history-confirm-quote">
            {point ? `${point.kind === 'after-turn' ? '本轮最后回复' : '所选回复'}：${quote.slice(0, 180)}${quote.length > 180 ? '…' : ''}` : `来源会话：${title}`}
          </p>
        </div>
        <p className="loading-modal-note" id="history-confirm-range">{range}</p>
        {isCross && point && (
          <p className="loading-modal-note">跨 Agent 转换可能丢失推理、工具及原生上下文。</p>
        )}
        <p className="loading-modal-note">
          {isImport ? '导入后请勿在 TUI 或其它窗口中并发使用此会话。' : '原会话保留，新分支中的后续对话独立保存。'}
        </p>
        <div className="rewind-actions">
          <button className="loading-modal-cancel" autoFocus onClick={onCancel}>取消</button>
          <button className="fork-btn fork-btn-primary" disabled={canChooseTarget && !targetAgents.some((agent) => agent.id === targetId)} onClick={onConfirm}>{isImport ? '确认导入' : '确认分叉'}</button>
        </div>
      </div>
    </dialog>
  )
}

type SessionCapability = 'sessionList' | 'sessionLoad' | 'sessionResume' | 'sessionFork'

export function describeHistoryItemAccess(agent: AgentDef | undefined): HistoryItemAccess {
  const canPreview = supportsSessionCapability(agent, 'sessionLoad')
  const canForkSame = supportsSessionCapability(agent, 'sessionFork')
  if (canPreview) return { canPreview: true, canForkSame, mode: 'preview' }
  if (canForkSame) return { canPreview: false, canForkSame: true, mode: 'fork-only' }
  return { canPreview: false, canForkSame: false, mode: 'unavailable' }
}

/** Optional fields default to enabled for legacy providers; protocol agents set them explicitly. */
function supportsSessionCapability(
  agent: AgentDef | undefined,
  capability: SessionCapability
): boolean {
  if (!agent || agent.installed === false || agent.incompatible) return false
  const advertised = agent.capabilities[capability]
  return (agent.capabilities.protocol === 'acp' || agent.capabilities.protocol === 'web') ? advertised === true : advertised !== false
}

export function currentSessionForkTargets(source: AgentDef | undefined, agents: AgentDef[]): AgentDef[] {
  if (!source || !isCrossForkSourceAgent(source)) return []
  return [
    ...(supportsSessionCapability(source, 'sessionFork') ? [source] : []),
    ...agents.filter((agent) =>
      agent.id !== source.id &&
      isCrossForkTargetAgent(agent) &&
      supportsSessionCapability(source, 'sessionLoad') &&
      supportsSessionCapability(agent, 'sessionLoad') &&
      supportsSessionCapability(agent, 'sessionResume')
    )
  ]
}

/** Normalized cross-agent import needs a target that can load and resume native sessions. */
function supportsCrossAgentImportTarget(agent: AgentDef): boolean {
  return (
    isCrossForkTargetAgent(agent) &&
    supportsSessionCapability(agent, 'sessionLoad') &&
    supportsSessionCapability(agent, 'sessionResume')
  )
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = Date.now()
  const diff = now - ms
  if (diff < 86400000 && d.getDate() === new Date().getDate()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 3 ? p : '…/' + parts.slice(-3).join('/')
}

function e2eHistoryFixture(agentId: string): SessionSummary {
  return {
    id: '__ua_e2e_history__',
    title: 'E2E history fixture',
    updatedAt: Date.now(),
    cwd: '',
    agentId
  }
}
