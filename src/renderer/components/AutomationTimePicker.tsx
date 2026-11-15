import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClockIcon } from './Icons'

export function AutomationTimePicker({ value, disabled, onChange }: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const [hour, minute] = value.split(':').map(Number)
  const pad = (number: number): string => String(number).padStart(2, '0')
  const close = (): void => { setOpen(false); trigger.current?.focus() }

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      const popup = menu.current?.getBoundingClientRect()
      if (!anchor || !popup) return
      const below = window.innerHeight - anchor.bottom - 12
      setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - popup.width - 12)),
        top: Math.max(12, Math.min(below >= popup.height ? anchor.bottom + 6 : anchor.top - popup.height - 6,
          window.innerHeight - popup.height - 12)) })
    }
    const scroll = (event: Event): void => { if (!menu.current?.contains(event.target as Node)) place() }
    place()
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  useLayoutEffect(() => {
    if (open) menu.current?.querySelectorAll<HTMLButtonElement>('[aria-selected="true"]').forEach(option => {
      const list = option.parentElement!
      list.scrollTop += option.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - option.offsetHeight) / 2
    })
  }, [open, hour, minute])

  function select(column: 'hour' | 'minute', number: number): void {
    onChange(column === 'hour' ? `${pad(number)}:${pad(minute)}` : `${pad(hour)}:${pad(number)}`)
  }

  return <div className="sched-time-input" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node) && !menu.current?.contains(event.relatedTarget as Node)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="settings-inp sched-time-picker" aria-label="触发时间"
      aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-expanded={open} disabled={disabled}
      onClick={() => setOpen(current => !current)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
      }}><span>{value}</span><ClockIcon size={15} /></button>
    {open && createPortal(<div ref={menu} id={id} role="dialog" aria-label="选择触发时间" className="sched-time-popover" style={position}>
      <div className="sched-time-heading"><span>选择时间</span><span>{value}</span></div>
      <div className="sched-time-columns">
        {(['hour', 'minute'] as const).map(column => <div key={column} className="sched-time-column">
          <div className="sched-time-column-label">{column === 'hour' ? '小时' : '分钟'}</div>
          <div className="sched-time-options" role="listbox" aria-label={column === 'hour' ? '小时' : '分钟'}>
            {Array.from({ length: column === 'hour' ? 24 : 60 }, (_, number) => {
              const selected = number === (column === 'hour' ? hour : minute)
              return <button key={number} type="button" role="option" aria-selected={selected} tabIndex={selected ? 0 : -1}
                onClick={() => select(column, number)} onKeyDown={event => {
                  const last = column === 'hour' ? 23 : 59
                  const next = event.key === 'ArrowDown' ? Math.min(last, number + 1) : event.key === 'ArrowUp' ? Math.max(0, number - 1) :
                    event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined
                  if (next === undefined) return
                  event.preventDefault(); event.stopPropagation(); select(column, next)
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true })
                }}>{pad(number)}</button>
            })}
          </div>
        </div>)}
      </div>
      <div className="sched-time-footer"><span>24 小时制</span><button type="button" className="settings-btn primary" onClick={close}>完成</button></div>
    </div>, document.body)}
  </div>
}
