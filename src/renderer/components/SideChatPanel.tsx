import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, Session, SideChatState, UAEvent } from '@shared/types'
import type { NativeCapabilitySnapshot } from '@shared/nativeCapabilities'
import { withCompactionTiming } from '@shared/eventSnapshots'
import { isTaskTurnInput } from '@shared/tokenSpeed'
import { contextCompactionAvailability, supportsManualContextCompaction } from '../contextCompaction'
import { displayedContextWindow } from '../contextWindow'
import { useNativeCapabilities } from '../hooks'
import { Composer } from './Composer'
import { EventStream, TurnStatusBar } from './EventStream'
import { UiIcon } from './Icons'
import type { Annotation } from '../textAnnotations'

export function sideComposerAgent(agent?: AgentDef): AgentDef | undefined {
  return agent && ['kimi', 'grok', 'deepseek', 'zcode'].includes(agent.adapter)
    ? { ...agent, capabilities: { ...agent.capabilities, nativeGoal: false, nativeReview: false } }
    : agent
}

export function sideComposerCapabilities(agent: AgentDef | undefined, snapshot: NativeCapabilitySnapshot): NativeCapabilitySnapshot {
  return agent && ['kimi', 'grok', 'deepseek', 'zcode'].includes(agent.adapter)
    ? { ...snapshot, actions: { ...snapshot.actions, goal: false, review: false } }
    : snapshot
}

export function SideChatPanel({
  open,
  sessionId,
  agent,
  onClose,
  onPromote,
  pendingComments,
  onRemovePendingComment,
  onClearComments
}: {
  open: boolean
  sessionId: string
  agent?: AgentDef
  onClose: () => void
  onPromote: (session: Session) => void
  pendingComments?: Annotation[]
  onRemovePendingComment?: (id: string) => void
  onClearComments?: () => void
}): JSX.Element | null {
  const [rendered, setRendered] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setRendered(true)
      setClosing(false)
    } else if (rendered) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setRendered(false)
      else setClosing(true)
    }
  }, [open, rendered])
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setRendered(false)
      setClosing(false)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [closing])

  const [width, setWidth] = useState<number>(() => {
    const value = Number(localStorage.getItem('ua.sidePanelWidth'))
    return value >= 320 && value <= 640 && value !== 420 ? value : 460
  })
  const dragRef = useRef(false)
  useEffect(() => {
    localStorage.setItem('ua.sidePanelWidth', String(width))
  }, [width])
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragRef.current) return
      setWidth(Math.min(640, Math.max(320, window.innerWidth - event.clientX)))
    }
    const onUp = (): void => { dragRef.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const [events, setEvents] = useState<UAEvent[]>([])
  const [sideState, setSideState] = useState<SideChatState | null>(null)
  const [conversationGeneration, setConversationGeneration] = useState(0)
  const requestDockRef = useRef<HTMLDivElement>(null)
  const [promoting, setPromoting] = useState(false)
  const [panelError, setPanelError] = useState('')

  useEffect(() => {
    if (!rendered) return
    let cancelled = false
    void window.uniagent.getSideEvents(sessionId).then((hydrated) => {
      if (!cancelled) setEvents((current) => mergeSideEvents(hydrated, current))
    })
    void window.uniagent.getSideState(sessionId).then((state) => {
      if (!cancelled) setSideState(state)
    })
    const offEvent = window.uniagent.onSideEvent((push) => {
      if (push.sessionId === sessionId) setEvents((current) => appendSideEvent(current, push.event))
    })
    const offState = window.uniagent.onSideState((push) => {
      if (push.sessionId === sessionId) setSideState(push.state)
    })
    return () => {
      cancelled = true
      offEvent()
      offState()
    }
  }, [sessionId, rendered])

  const config = sideState?.config
  const { snapshot: capabilities, ready: capabilitiesReady } = useNativeCapabilities(
    config?.agentId,
    config?.workdir
  )
  const composerAgent = useMemo(() => sideComposerAgent(agent), [agent])
  const composerCapabilities = useMemo(() => sideComposerCapabilities(agent, capabilities), [agent, capabilities])
  const contextInfo = useMemo(() => computeSideContext(events), [events])
  const contextWindow = useMemo(() => {
    const model = agent?.models.find((entry) => entry.id === config?.model)
    const configured = config?.maxMode ? model?.maxContextWindow : model?.contextWindow
    return displayedContextWindow(
      events,
      sideState?.status || 'idle',
      configured
    )
  }, [agent, config?.maxMode, config?.model, events, sideState?.status])
  const compactAvailability = contextCompactionAvailability(
    supportsManualContextCompaction(agent),
    sideState?.status || 'idle',
    events,
    sideState?.hasLiveStreamer === true
  )

  async function startNew(): Promise<void> {
    if (promoting) return
    await window.uniagent.closeSideChat(sessionId)
    const state = await window.uniagent.getSideState(sessionId)
    setEvents([])
    setSideState(state)
    setConversationGeneration((current) => current + 1)
    setPanelError('')
  }

  async function promote(): Promise<void> {
    if (promoting || sideState?.status !== 'idle' || !events.some((event) => event.type === 'user_message')) return
    setPromoting(true)
    setPanelError('')
    try {
      onPromote(await window.uniagent.promoteSideToSession(sessionId))
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : '转换失败，请重试')
    } finally {
      setPromoting(false)
    }
  }

  if (!rendered) return null

  const status = sideState?.status || 'idle'
  const hasConversation = events.some((event) => event.type === 'user_message')
  const lastTurnOutcome = status === 'idle'
    ? events.findLast((event) => event.type === 'turn_completed' || event.type === 'error' || isTaskTurnInput(event))
    : undefined
  const timerStatus = lastTurnOutcome?.type === 'error' || (lastTurnOutcome?.type === 'turn_completed' && lastTurnOutcome.state === 'failed')
    ? 'error'
    : status

  return (
    <aside
      className="subagent-panel side-panel"
      data-closing={closing || undefined}
      style={{ width }}
      aria-label="侧边对话"
      aria-hidden={closing}
    >
      <div
        className="subagent-panel-grip"
        title="拖动调整宽度"
        onMouseDown={() => { dragRef.current = true }}
      />
      <div className="subagent-panel-head">
        <span className="subagent-panel-title"><UiIcon name="message-square" size={15} /> 侧边对话</span>
        <span className="side-panel-hint">独立支线 · 配置互不影响</span>
        <button
          className="side-promote-btn"
          title="将当前侧边对话转为独立会话"
          onClick={() => void promote()}
          disabled={promoting || status !== 'idle' || !hasConversation}
        >
          <UiIcon name="fork" size={13} /> {promoting ? '转换中…' : '独立会话'}
        </button>
        <button className="side-new-btn" title="清空并开始新的侧边对话" onClick={() => void startNew()} disabled={promoting}>
          新对话
        </button>
        <button className="close-x" title="关闭" aria-label="关闭侧边对话" onClick={onClose} disabled={promoting}>
          <UiIcon name="close" size={14} />
        </button>
      </div>
      {panelError && <div className="side-panel-error" role="alert">{panelError}</div>}
      <div className="side-panel-stream">
        {events.length > 0 ? (
          <EventStream
            key={`side-stream:${sessionId}:${conversationGeneration}`}
            events={events}
            status={status}
            sessionId={sessionId}
            requestDockRef={requestDockRef}
            onRespond={(requestId, answer) => window.uniagent.respondSideRequest(sessionId, requestId, answer)}
            onImplementPlan={async () => {
              await window.uniagent.setSideCollaborationMode(sessionId, 'default')
              await window.uniagent.sendSideMessage(sessionId, 'Implement the plan.')
            }}
            onRevisePlan={async (feedback) => {
              await window.uniagent.sendSideMessage(sessionId, feedback)
            }}
          />
        ) : (
          <div className="subagent-empty">
            创建时会复制主会话配置与上下文；之后侧边对话独立运行，不会同步回主会话。
          </div>
        )}
      </div>
      <TurnStatusBar events={events} status={timerStatus} showPlan={false} />
      <div className="interaction-dock-slot" ref={requestDockRef} />
      <div className="side-composer">
        {config ? (
          <Composer
            key={`side-composer:${sessionId}:${conversationGeneration}`}
            sessionId={`side:${sessionId}:${conversationGeneration}`}
            status={status}
            agent={composerAgent}
            config={config}
            onSend={(prompt, attachments, selection, activatePlan, bubble) => {
              void window.uniagent.sendSideMessage(sessionId, prompt, attachments, selection, activatePlan, bubble)
              if (bubble?.comments?.length) onClearComments?.()
            }}
            onForceSend={(prompt, attachments, selection, bubble) => {
              void window.uniagent.forceSendSideMessage(sessionId, prompt, attachments, selection, bubble)
              if (bubble?.comments?.length) onClearComments?.()
            }}
            onInterrupt={() => { void window.uniagent.interruptSide(sessionId) }}
            onUpdateConfig={(patch) => {
              setPanelError('')
              void window.uniagent.updateSideConfig(sessionId, patch).then(setSideState).catch((error) => {
                setPanelError(error instanceof Error ? error.message : '配置更新失败，请重试')
              })
            }}
            onSetCollaborationMode={async (mode) => {
              setSideState(await window.uniagent.setSideCollaborationMode(sessionId, mode))
            }}
            onRunNativeAction={(action) => window.uniagent.runSideNativeAction(sessionId, action)}
            queue={sideState.queue}
            onDequeue={(itemId) => window.uniagent.dequeueSideMessage(sessionId, itemId)}
            onPromoteQueue={(itemId) => { void window.uniagent.promoteSideMessage(sessionId, itemId) }}
            onEditQueueItem={(itemId, prompt, attachments, selection) => {
              void window.uniagent.editSideMessage(sessionId, itemId, prompt, attachments, selection)
            }}
            onQueueEditingChange={(itemId) => {
              void window.uniagent.setSideQueueEditing(sessionId, itemId)
            }}
            capabilities={composerCapabilities}
            capabilitiesReady={capabilitiesReady}
            contextUsed={contextInfo.used}
            contextWindow={contextWindow}
            onCompact={async () => {
              await window.uniagent.compactSideChat(sessionId)
            }}
            canCompact={compactAvailability.canCompact}
            compacting={compactAvailability.compacting}
            providerSwitchCompacting={compactAvailability.providerSwitchCompacting}
            disabledReason={compactAvailability.disabledReason}
            disabled={promoting || !agent?.installed || !!agent.incompatible}
            pendingComments={pendingComments}
            onRemovePendingComment={onRemovePendingComment}
          />
        ) : (
          <div className="side-composer-loading">正在准备输入框…</div>
        )}
      </div>
    </aside>
  )
}

function appendSideEvent(events: UAEvent[], event: UAEvent): UAEvent[] {
  const existing = events.findIndex(item => item.seq === event.seq)
  if (existing >= 0) {
    const next = [...events]
    next[existing] = withCompactionTiming(event, next[existing])
    return next
  }
  if (event.type === 'approval_request' && event.state !== 'pending') {
    const pending = events.findLastIndex(item => item.type === 'approval_request' && item.payload.requestId === event.payload.requestId && item.state === 'pending')
    if (pending >= 0) {
      const next = [...events]
      next[pending] = { ...event, seq: next[pending].seq, ts: next[pending].ts, payload: { ...next[pending].payload, ...event.payload } }
      return next
    }
  }
  const id = event.payload?.id
  // A force-send message does not end an in-flight compaction.
  const turnStart = events.findLastIndex(
    (item) => event.type === 'context_compaction'
      ? item.type === 'turn_completed'
      : item.type === 'user_message' || item.type === 'goal_message'
  )
  const index = id
    ? events.findLastIndex((item, itemIndex) =>
        (itemIndex > turnStart || event.payload?.delivery === 'async') && item.type === event.type && item.payload?.id === id)
    : -1
  if (index < 0) return [...events, event]
  const next = [...events]
  next[index] = event.payload?.delivery === 'async'
    ? { ...event, seq: next[index].seq, payload: { ...next[index].payload, ...event.payload } }
    : withCompactionTiming(event, next[index])
  return next
}

function mergeSideEvents(hydrated: UAEvent[], live: UAEvent[]): UAEvent[] {
  return live.reduce(appendSideEvent, Array.isArray(hydrated) ? hydrated : [])
}

function computeSideContext(events: UAEvent[]): { used: number } {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type !== 'system_notice' || !event.payload?.usage) continue
    const usage = event.payload.usage
    if (event.payload.kind === 'context') return { used: usage.contextTokens ?? 0 }
    if (event.payload.kind === 'usage') {
      const input = usage.inputTokens ?? usage.input_tokens ?? 0
      const output = usage.outputTokens ?? usage.output_tokens ?? 0
      return { used: usage.contextTokens ?? usage.total_tokens ?? usage.totalTokens ?? input + output }
    }
  }
  return { used: 0 }
}
