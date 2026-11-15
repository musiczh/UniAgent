import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const VIEWPORT_MARGIN = 12
const VIEWPORT_TOP = 40
const MAX_HEIGHT = 520
const SUBMENU_GAP = 12
const TOP_NUDGE = -6

interface SubmenuPlacementInput {
  anchor: { top: number; left: number; right: number }
  popover: { width: number; height: number }
  viewport: { width: number; height: number; top?: number; bottom?: number }
}

export interface SubmenuPlacement {
  left: number
  top: number
  maxHeight: number
  placement: 'right' | 'left' | 'viewport'
}

export function computeSubmenuPlacement({
  anchor,
  popover,
  viewport
}: SubmenuPlacementInput): SubmenuPlacement {
  const visibleTop = viewport.top ?? VIEWPORT_TOP
  const visibleBottom = viewport.bottom ?? viewport.height - VIEWPORT_MARGIN
  const maxHeight = Math.min(MAX_HEIGHT, Math.max(0, visibleBottom - visibleTop))
  const maxTop = Math.max(visibleTop, visibleBottom - Math.min(popover.height, maxHeight))
  const absoluteTop = Math.min(
    Math.max(anchor.top + TOP_NUDGE, visibleTop),
    maxTop
  )

  const rightLeft = anchor.right + SUBMENU_GAP
  const leftLeft = anchor.left - SUBMENU_GAP - popover.width
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - popover.width)
  let absoluteLeft = rightLeft
  let placement: SubmenuPlacement['placement'] = 'right'

  if (rightLeft + popover.width > viewport.width - VIEWPORT_MARGIN) {
    if (leftLeft >= VIEWPORT_MARGIN) {
      absoluteLeft = leftLeft
      placement = 'left'
    } else {
      absoluteLeft = Math.min(Math.max(rightLeft, VIEWPORT_MARGIN), maxLeft)
      placement = 'viewport'
    }
  }

  return {
    left: absoluteLeft - anchor.left,
    top: absoluteTop - anchor.top,
    maxHeight,
    placement
  }
}

export function SubmenuPopover({ children, wide = false }: { children: ReactNode; wide?: boolean }): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<SubmenuPlacement | null>(null)

  const reposition = useCallback(() => {
    const menu = menuRef.current
    const anchor = menu?.parentElement
    if (!menu || !anchor) return

    const anchorRect = anchor.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    let top = VIEWPORT_TOP
    let bottom = window.innerHeight - VIEWPORT_MARGIN
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY === 'visible') continue
      const rect = parent.getBoundingClientRect()
      top = Math.max(top, rect.top)
      bottom = Math.min(bottom, rect.bottom)
    }
    const next = computeSubmenuPlacement({
      anchor: { top: anchorRect.top, left: anchorRect.left, right: anchorRect.right },
      popover: { width: menuRect.width, height: menuRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight, top, bottom }
    })
    setPosition((current) => (
      current?.left === next.left &&
      current.top === next.top &&
      current.maxHeight === next.maxHeight &&
      current.placement === next.placement
        ? current
        : next
    ))
  }, [])

  useLayoutEffect(() => {
    const menu = menuRef.current
    const anchor = menu?.parentElement
    if (!menu || !anchor) return

    reposition()
    const resizeObserver = new ResizeObserver(reposition)
    resizeObserver.observe(menu)
    resizeObserver.observe(anchor)
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) resizeObserver.observe(parent)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [reposition])

  return (
    <div
      ref={menuRef}
      className={wide ? 'sb-sub-menu sb-sub-menu-wide' : 'sb-sub-menu'}
      role="listbox"
      onMouseOver={(event) => {
        const option = (event.target as Element).closest<HTMLElement>('.sb-sub-opt')
        const label = option?.querySelector<HTMLElement>('.sb-agent-name-label')
          ?? option?.querySelector<HTMLElement>('.sb-entry-body')
        if (option && label) {
          option.title = label.scrollWidth > label.clientWidth ? label.textContent || '' : ''
        }
      }}
      data-placement={position?.placement || 'right'}
      style={position ? { left: position.left, top: position.top, maxHeight: position.maxHeight } : undefined}
    >
      {children}
    </div>
  )
}
