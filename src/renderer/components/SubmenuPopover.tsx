import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const VIEWPORT_MARGIN = 12
const SUBMENU_GAP = 12
const TOP_NUDGE = -6

interface SubmenuPlacementInput {
  anchor: { top: number; left: number; right: number }
  popover: { width: number; height: number }
  viewport: { width: number; height: number }
}

export interface SubmenuPlacement {
  left: number
  top: number
  placement: 'right' | 'left' | 'viewport'
}

export function computeSubmenuPlacement({
  anchor,
  popover,
  viewport
}: SubmenuPlacementInput): SubmenuPlacement {
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - popover.height)
  const absoluteTop = Math.min(
    Math.max(anchor.top + TOP_NUDGE, VIEWPORT_MARGIN),
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
    const next = computeSubmenuPlacement({
      anchor: { top: anchorRect.top, left: anchorRect.left, right: anchorRect.right },
      popover: { width: menuRect.width, height: menuRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    })
    setPosition((current) => (
      current?.left === next.left &&
      current.top === next.top &&
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
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      {children}
    </div>
  )
}
