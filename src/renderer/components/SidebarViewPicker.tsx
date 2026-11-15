import { useEffect, useRef, useState } from 'react'
import { UiIcon } from './Icons'

export const SIDEBAR_VIEWS = { space: '项目', requirement: '需求', task: '任务' } as const
export type SidebarView = keyof typeof SIDEBAR_VIEWS

export function SidebarViewPicker({ value, onChange }: { value: SidebarView; onChange: (value: SidebarView) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    container.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const dismiss = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])
  return <div className="scope-view-picker" ref={container} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      const buttons = [...(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || [])]
      const index = buttons.findIndex(button => button === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="scope-view-trigger" aria-label="切换侧栏视图" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>{SIDEBAR_VIEWS[value]}<UiIcon name="chevron-down" size={11}/></button>
    {open && <div className="scope-view-menu" role="menu" aria-label="侧栏视图">
      {(Object.keys(SIDEBAR_VIEWS) as SidebarView[]).map(view => <button key={view} type="button" role="menuitemradio" aria-checked={value === view} data-sidebar-view={view} onClick={() => { onChange(view); setOpen(false); trigger.current?.focus() }}>
        <UiIcon name={view === 'space' ? 'folder' : view === 'requirement' ? 'file' : 'bot'} size={14}/><span>{SIDEBAR_VIEWS[view]}</span>{value === view && <UiIcon name="check" size={13}/>}</button>)}
    </div>}
  </div>
}
