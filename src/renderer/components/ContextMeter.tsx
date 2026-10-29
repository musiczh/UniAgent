import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

const HOVER_CLOSE_GRACE_MS = 260

/**
 * Context-load meter (Doc1 需求3 / Doc5 T1 §4.1). The bar + percentage + token
 * count reflect *context occupancy* — how full the window is right now
 * (last call's input ÷ window). When the window is unknown we degrade to just
 * the token count (no bar / percentage).
 */
export function ContextMeter({
  used,
  window: ctx,
  onCompact,
  canCompact,
  compacting,
  disabledReason
}: {
  used: number
  window?: number
  onCompact: () => Promise<void>
  canCompact: boolean
  compacting: boolean
  disabledReason?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [compactRequested, setCompactRequested] = useState(false)
  const [popShift, setPopShift] = useState(0)
  const meterRef = useRef<HTMLDivElement>(null)
  const requestPending = useRef(false)
  const pointerInside = useRef(false)
  const openedByHover = useRef(false)
  const pinnedOpen = useRef(false)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popoverId = useId()
  const pct = ctx && ctx > 0 ? Math.min(100, Math.round((used / ctx) * 100)) : null
  const level = pct == null ? '' : pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : ''
  const compactBusy = compacting || compactRequested

  useEffect(() => {
    if (!open) return
    const closeFromOutside = (event: PointerEvent): void => {
      if (!meterRef.current?.contains(event.target as Node)) closePopover()
    }
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    document.addEventListener('pointerdown', closeFromOutside, true)
    document.addEventListener('keydown', closeFromEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true)
      document.removeEventListener('keydown', closeFromEscape, true)
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (hoverCloseTimer.current != null) clearTimeout(hoverCloseTimer.current)
    }
  }, [])

  // Keep the popover inside the viewport when the window is narrow. The panel is
  // centered above the trigger by CSS (translateX(-50%)); if that would push it
  // past either edge we nudge it back with a horizontal shift so it is never
  // clipped or occluded by the window frame (Doc5 问题3).
  useLayoutEffect(() => {
    if (!open) {
      if (popShift !== 0) setPopShift(0)
      return
    }
    const pop = meterRef.current?.querySelector<HTMLElement>('.ctx-pop')
    if (!pop) return
    const measure = (): void => {
      const rect = pop.getBoundingClientRect()
      const margin = 8
      // rect already reflects the currently-applied translateX(popShift); recover
      // the natural (un-shifted) box first, otherwise the shift is computed against
      // a position we just moved and the value oscillates (0 → S → 0 …), spinning
      // the effect into an infinite update loop (React #185) that crashes the view.
      const naturalLeft = rect.left - popShift
      const naturalRight = rect.right - popShift
      let shift = 0
      if (naturalLeft < margin) shift = margin - naturalLeft
      else if (naturalRight > window.innerWidth - margin) shift = window.innerWidth - margin - naturalRight
      setPopShift((prev) => (Math.abs(prev - shift) < 0.5 ? prev : shift))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, popShift])

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

  function keepPopoverOpen(): void {
    pointerInside.current = true
    cancelHoverClose()
  }

  function scheduleHoverClose(): void {
    pointerInside.current = false
    cancelHoverClose()
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null
      const meter = meterRef.current
      if (
        pinnedOpen.current ||
        pointerInside.current ||
        meter?.matches(':hover')
      ) return
      openedByHover.current = false
      setOpen(false)
    }, HOVER_CLOSE_GRACE_MS)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const anchor = meterRef.current?.querySelector<HTMLElement>('.ctx-pop-anchor')
    if (!anchor || !pointerInside.current) return
    const { clientX, clientY } = event
    const meterRect = meterRef.current?.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const inCorridor = clientX >= anchorRect.left && clientX <= anchorRect.right &&
      clientY >= anchorRect.top && clientY <= Math.max(anchorRect.bottom, meterRect?.bottom ?? anchorRect.bottom)
    if (!inCorridor) scheduleHoverClose()
  }

  function closePopover(): void {
    cancelHoverClose()
    pinnedOpen.current = false
    openedByHover.current = false
    setOpen(false)
  }

  function togglePopover(): void {
    cancelHoverClose()
    setOpen((current) => {
      // A real pointer enters before its click. Treat that first click as taking
      // ownership of the already-visible popover instead of immediately hiding it.
      if (current && openedByHover.current) {
        pinnedOpen.current = true
        openedByHover.current = false
        return true
      }
      pinnedOpen.current = !current
      openedByHover.current = false
      return !current
    })
  }

  async function handleCompact(): Promise<void> {
    if (!canCompact || compactBusy || requestPending.current) return
    requestPending.current = true
    setCompactRequested(true)
    try {
      await onCompact()
    } finally {
      requestPending.current = false
      setCompactRequested(false)
    }
  }

  return (
    <div
      ref={meterRef}
      className={`ctx-meter${level}`}
      onPointerEnter={openFromPointer}
      onPointerMove={handlePointerMove}
      onPointerLeave={scheduleHoverClose}
      onBlurCapture={() => scheduleHoverClose()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closePopover()
      }}
      title="上下文负载"
    >
      <button
        type="button"
        className="ctx-meter-trigger"
        aria-label={`查看上下文负载${pct != null ? `，已使用 ${pct}%` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(event) => {
          event.stopPropagation()
          togglePopover()
        }}
      >
        <span
          className="ctx-bar"
          style={pct != null ? { background: `conic-gradient(var(--ctx-color) ${pct}%, var(--border) 0)` } : undefined}
          aria-hidden
        >
          <span className="ctx-bar-fill" />
        </span>
        <span className="ctx-nums">
          {pct != null && <b className="ctx-pct">{pct}%</b>}
          <span className="ctx-tok">{fmtTokens(used)}{ctx ? ` / ${fmtTokens(ctx)}` : ''} tok</span>
        </span>
      </button>
      {open && (
        <div
          className="ctx-pop-anchor"
          onPointerEnter={keepPopoverOpen}
          onPointerLeave={scheduleHoverClose}
        >
          <div
            id={popoverId}
            className="ctx-pop"
            role="dialog"
            aria-label="上下文负载详情"
            style={popShift ? { transform: `translateX(${popShift}px)` } : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ctx-pop-row">
              <span>上下文占用</span>
              <span>{used.toLocaleString()} token{pct != null ? ` · ${pct}%` : ''}</span>
            </div>
            {ctx != null && (
              <div className="ctx-pop-row">
                <span>上下文窗口</span>
                <span>{ctx.toLocaleString()} token</span>
              </div>
            )}
            <div className="ctx-pop-action">
              <button
                type="button"
                className="ctx-compact-btn"
                disabled={!canCompact || compactBusy}
                title={disabledReason || '立即压缩当前会话的上下文'}
                onClick={() => void handleCompact()}
              >
                {compactBusy ? '压缩中…' : '压缩上下文'}
              </button>
              {disabledReason && <div className="ctx-compact-reason">{disabledReason}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
