import { useLayoutEffect, type RefObject } from 'react'

export function usePickerMenuPlacement(
  open: boolean,
  anchorRef: RefObject<HTMLDetailsElement>,
  menuRef: RefObject<HTMLDivElement>
): void {
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    const list = menu?.querySelector<HTMLElement>('.project-picker-list')
    if (!open || !anchor || !menu || !list) return
    const reposition = (): void => {
      const rect = anchor.getBoundingClientRect()
      const listScroll = list.scrollTop, menuScroll = menu.scrollTop
      menu.style.maxHeight = 'none'
      const naturalHeight = menu.getBoundingClientRect().height
      const fixedHeight = naturalHeight - list.getBoundingClientRect().height
      const above = Math.max(0, rect.top - 40 - 6)
      const below = Math.max(0, window.innerHeight - rect.bottom - 12 - 6)
      const up = above >= naturalHeight || above >= below
      const available = up ? above : below
      const limit = available < fixedHeight + 40 ? Math.max(1, window.innerHeight - 52) : available
      menu.style.maxHeight = `${limit}px`
      const { width, height } = menu.getBoundingClientRect()
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - 12 - width))
      const top = Math.max(40, Math.min(up ? rect.top - 6 - height : rect.bottom + 6, window.innerHeight - 12 - height))
      menu.style.left = `${left - rect.left}px`
      menu.style.top = `${top - rect.top}px`
      list.scrollTop = listScroll
      menu.scrollTop = menuScroll
      menu.dataset.positioned = 'true'
    }
    const onScroll = (event: Event): void => {
      if (!(event.target instanceof Node) || !menu.contains(event.target)) reposition()
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(menu)
    observer.observe(anchor)
    const composer = anchor.closest('.composer-box')
    if (composer) observer.observe(composer)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', onScroll, true)
    }
  })
}
