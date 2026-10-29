import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Session, UAEvent } from '@shared/types'
import { isVisibleDetailEvent } from '@shared/detailQuickChat'
import { EventStream } from './EventStream'
import { UiIcon } from './Icons'

/**
 * 选中即评论 / 解释 — a lightweight floating fork chat explaining a text selection.
 * Independent of the 侧边对话 drawer: it drives its own ephemeral detail branch
 * (forked off the main rollout) on the parallel `detail:*` IPC channel, so the two
 * can coexist. Opening sends one hidden contextual explanation turn and renders
 * only the answer, like Codex Quick Chat; the user can keep asking follow-ups.
 * Closing discards the branch unless promoted to the side drawer or a session.
 */
export function DetailChatPopover({
  sessionId,
  quote,
  selectedMessageText,
  nonce,
  onClose,
  onPromoted,
  onSessionCreated,
  detached = false,
}: {
  sessionId: string
  /** the selected text this popover explains (drives the auto-sent first turn) */
  quote: string
  /** plain text of the complete agent reply containing the selection */
  selectedMessageText: string
  /** bumped by App each time 解释 is triggered, so the same quote re-opens fresh */
  nonce: number
  onClose: () => void
  /** 保留为侧边对话 — promote succeeded; App opens the side drawer */
  onPromoted: () => void
  onSessionCreated: (session: Session, open: boolean) => void
  detached?: boolean
}): JSX.Element {
  const [events, setEvents] = useState<UAEvent[]>([])
  const [status, setStatus] = useState<'idle' | 'running'>('running')
  const [text, setText] = useState('')
  const [displayTitle, setDisplayTitle] = useState(quote)
  const [generatedTitle, setGeneratedTitle] = useState(false)
  const [titleMotion, setTitleMotion] = useState<'idle' | 'out' | 'in'>('idle')
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [error, setError] = useState('')
  const popRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const promotingRef = useRef(false)
  const mountedRef = useRef(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Guard the auto-send so React 18 StrictMode's double-effect (or an unrelated
  // re-render) can't fire the explain turn twice for the same open.
  const autoSentNonceRef = useRef<number | null>(null)

  // Each nonce is a fresh explanation branch. Clear the previous local snapshot
  // before subscribing so a rapid re-selection never flashes the old answer.
  useEffect(() => {
    mountedRef.current = true
    setEvents([])
    setStatus('running')
    setError('')
    setText('')
    const offEv = window.uniagent.onDetailEvent((p) => {
      if (p.sessionId !== sessionId) return
      setEvents((prev) => {
        const id = (p.event.payload as { id?: string } | undefined)?.id
        if (id) {
          const idx = prev.findIndex(
            (e) => e.type === p.event.type && (e.payload as { id?: string } | undefined)?.id === id
          )
          if (idx >= 0) {
            const next = prev.slice()
            next[idx] = p.event
            return next
          }
        }
        return [...prev, p.event]
      })
    })
    const offSt = window.uniagent.onDetailStatus((p) => {
      if (p.sessionId === sessionId) setStatus(p.status)
    })
    return () => {
      mountedRef.current = false
      offEv()
      offSt()
    }
  }, [sessionId, nonce])

  // Auto-send the explain turn once per open (keyed on nonce).
  useEffect(() => {
    if (autoSentNonceRef.current === nonce) return
    autoSentNonceRef.current = nonce
    setDisplayTitle(quote)
    setGeneratedTitle(false)
    setTitleMotion('idle')
    void window.uniagent.explainDetailSelection(sessionId, {
      selectedText: quote,
      selectedMessageText,
      sourceConversationId: sessionId,
      targetedReplyLabel: '所选文本',
    }).then(async () => {
      if (!detached || !mountedRef.current) return
      const [snapshot, current] = await Promise.all([window.uniagent.getDetailEvents(sessionId), window.uniagent.getDetailStatus(sessionId)])
      if (mountedRef.current) { setEvents(snapshot); setStatus(current) }
    }).catch((err) => {
      setStatus('idle')
      setError(err instanceof Error ? err.message : '解释失败，请重试')
    })
  }, [sessionId, quote, selectedMessageText, nonce])

  function moveWithinWindow(left: number, top: number): void {
    if (detached) return
    const pop = popRef.current
    if (!pop) return
    setPosition({
      left: Math.max(12, Math.min(left, window.innerWidth - pop.offsetWidth - 12)),
      top: Math.max(12, Math.min(top, window.innerHeight - pop.offsetHeight - 12)),
    })
  }
  useEffect(() => {
    const onResize = (): void => {
      const rect = popRef.current?.getBoundingClientRect()
      if (rect) moveWithinWindow(rect.left, rect.top)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const visibleEvents = events.filter(isVisibleDetailEvent)
  const nextGeneratedTitle = events.findLast(
    (event) => event.type === 'agent_message' && typeof event.payload?.detailTitle === 'string'
  )?.payload.detailTitle as string | undefined
  useEffect(() => {
    if (!nextGeneratedTitle || nextGeneratedTitle === displayTitle) return
    setTitleMotion('out')
    const swap = window.setTimeout(() => {
      setDisplayTitle(nextGeneratedTitle)
      setGeneratedTitle(true)
      setTitleMotion('in')
      requestAnimationFrame(() => requestAnimationFrame(() => setTitleMotion('idle')))
    }, 160)
    return () => window.clearTimeout(swap)
  }, [displayTitle, nextGeneratedTitle])

  function send(): void {
    const v = text.trim()
    if (!v || status === 'running' || promotingRef.current) return
    setText('')
    if (taRef.current) taRef.current.style.height = ''
    setStatus('running')
    setError('')
    void window.uniagent.sendDetailMessage(sessionId, v).catch((err) => {
      setText(v)
      setStatus('idle')
      setError(err instanceof Error ? err.message : '发送失败，请重试')
    })
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }
  function discardAndClose(): void {
    if (promotingRef.current) return
    void window.uniagent.closeDetail(sessionId)
    onClose()
  }
  async function preserve(target: 'side' | 'session'): Promise<void> {
    if (status === 'running' || promotingRef.current) return
    promotingRef.current = true
    setPromoting(true)
    setError('')
    try {
      if (target === 'session') {
        const session = await window.uniagent.promoteDetailToSession(sessionId)
        onSessionCreated(session, mountedRef.current)
      } else {
        if (!await window.uniagent.promoteDetailToSide(sessionId)) throw new Error('解释暂无可保存的内容')
        if (mountedRef.current) onPromoted()
      }
      if (mountedRef.current) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      promotingRef.current = false
      setPromoting(false)
    }
  }

  return createPortal(
      <div ref={popRef} className="detail-pop" role="dialog" aria-label="解释" style={position ? { ...position, right: 'auto' } : undefined}>
        <div
          className="detail-head"
          tabIndex={0}
          role="group"
          aria-label="移动解释窗口：拖动或使用方向键"
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
            e.preventDefault()
            const rect = popRef.current!.getBoundingClientRect()
            moveWithinWindow(rect.left + (e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0),
              rect.top + (e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0))
          }}
          onPointerDown={(e) => {
            if (detached) return
            if (e.button !== 0 || (e.target as Element).closest('button')) return
            const rect = popRef.current!.getBoundingClientRect()
            dragRef.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top }
            e.currentTarget.setPointerCapture(e.pointerId)
            e.preventDefault()
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current
            if (drag) moveWithinWindow(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y)
          }}
          onPointerUp={(e) => {
            dragRef.current = null
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onLostPointerCapture={() => { dragRef.current = null }}
          onPointerCancel={() => { dragRef.current = null }}
        >
          <span className="detail-drag-handle" title="拖动以移动窗口" aria-hidden />
          <div className="detail-heading">
            <span className="detail-kicker"><UiIcon name="search" size={12} /> 解释</span>
            <span
              className={`detail-title-text ${generatedTitle ? 'as-name' : 'as-quote'} is-${titleMotion}`}
              title={displayTitle}
            >
              {displayTitle}
            </span>
          </div>
          <button
            className="detail-icon-btn primary"
            title="添加到侧边对话"
            aria-label="添加到侧边对话"
            onClick={() => { void preserve('side') }}
            disabled={status === 'running' || promoting}
          >
            <UiIcon name="message-square" size={17} />
          </button>
          <button
            className="detail-icon-btn primary"
            title={promoting ? '正在保存…' : status === 'running' ? '生成结束后可添加为 Session' : '添加为 Session'}
            aria-label="添加为 Session"
            onClick={() => { void preserve('session') }}
            disabled={status === 'running' || promoting}
          >
            <UiIcon name="plus" size={17} />
          </button>
          <button className="detail-icon-btn" title="关闭并丢弃" aria-label="关闭并丢弃" onClick={discardAndClose} disabled={promoting}>
            <UiIcon name="close" size={16} />
          </button>
        </div>
        {error && <div className="detail-error" role="alert">{error}</div>}
        <div className="detail-stream">
          {visibleEvents.some((event) =>
            (event.type === 'agent_message' && event.payload?.text) ||
            event.type === 'error' ||
            (event.type === 'system_notice' && event.payload?.kind !== 'usage')
          ) ? (
            <EventStream events={visibleEvents} status={status} sessionId={sessionId} />
          ) : status === 'running' ? (
            <div className="detail-loading" role="status" aria-label="正在生成解释">
              <span className="detail-skeleton w9" />
              <span className="detail-skeleton w8" />
              <span className="detail-skeleton w7" />
              <span className="detail-skeleton w9" />
              <span className="detail-skeleton w5" />
              <span className="detail-loading-tip"><i />正在就选中内容生成解释…</span>
            </div>
          ) : null}
        </div>
        <div className="detail-foot">
          <textarea
            ref={taRef}
            className="detail-foot-input"
            placeholder="继续追问…（⌘⏎ 发送）"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              e.currentTarget.style.height = 'auto'
              e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 96)}px`
            }}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={promoting}
          />
          {status === 'running' ? (
            <button className="detail-send stop" onClick={() => window.uniagent.interruptDetail(sessionId)}>
              中止
            </button>
          ) : (
            <button className="detail-send" onClick={send} disabled={!text.trim() || promoting}>
              发送
            </button>
          )}
        </div>
      </div>,
    document.body,
  )
}
