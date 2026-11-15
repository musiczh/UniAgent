import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import './sessionInfo.css'

/** The header's information panels share placement, dismissal and focus behavior. */
export function AnchoredPopover({ anchor, id, labelledBy, onClose, children, className = '' }: {
  anchor: RefObject<HTMLElement>; id: string; labelledBy: string; onClose: (restoreFocus?: boolean) => void; children: ReactNode; className?: string
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  useLayoutEffect(() => {
    const place = (): void => {
      if (!anchor.current || !panel.current) return
      const a = anchor.current.getBoundingClientRect(), p = panel.current.getBoundingClientRect()
      const left = Math.max(12, Math.min(a.left, window.innerWidth - p.width - 12))
      const top = Math.max(12, Math.min(a.bottom + 8, window.innerHeight - p.height - 12))
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    if (anchor.current) observer.observe(anchor.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor])
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); onClose(true)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [anchor, onClose])
  return createPortal(<div ref={panel} id={id} className={`session-info-popover ${className}`} role="dialog" aria-labelledby={labelledBy} tabIndex={-1} style={position}>{children}</div>, document.body)
}
