import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Chevron, UiIcon } from './Icons'

function dateKey(date: Date): string {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

export function AutomationDatePicker({ value, disabled, invalid, onChange }: {
  value: string
  disabled: boolean
  invalid: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date(value ? value + 'T00:00:00' : Date.now()))
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const today = dateKey(new Date(Date.now()))
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false)
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
      const rect = popup.current?.getBoundingClientRect()
      if (!anchor || !rect) return
      setPosition({ left: Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12)),
        top: Math.max(12, Math.min(anchor.bottom + 6 + rect.height <= innerHeight - 12 ? anchor.bottom + 6 : anchor.top - rect.height - 6, innerHeight - rect.height - 12)) })
    }
    place()
    popup.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]:not(:disabled), [data-date]:not(:disabled)')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  function select(day: string): void { onChange(day); close() }
  return <>
    <button ref={trigger} type="button" className="settings-inp auto-date-picker" disabled={disabled} aria-label="执行日期"
      aria-invalid={invalid} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setMonth(new Date(value ? value + 'T00:00:00' : Date.now())); setOpen(current => !current) }}>
      <span>{value || '选择日期'}</span><UiIcon name="calendar" size={15} />
    </button>
    {open && createPortal(<div ref={popup} id={id} role="dialog" aria-label="选择执行日期" className="auto-date-popover" style={position}>
      <div className="auto-date-heading"><span>{month.getFullYear()} 年 {month.getMonth() + 1} 月</span><div>
        <button type="button" aria-label="上个月" disabled={dateKey(first).slice(0, 7) <= today.slice(0, 7)} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><UiIcon name="back" size={14} /></button>
        <button type="button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Chevron size={14} /></button>
      </div></div>
      <div className="auto-date-grid">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}
        {Array.from({ length: 42 }, (_, i) => {
          const date = new Date(month.getFullYear(), month.getMonth(), i - offset + 1)
          const day = dateKey(date)
          return <button key={day} type="button" data-date={day} aria-label={day} aria-pressed={day === value}
            className={date.getMonth() !== month.getMonth() ? 'other-month' : ''} disabled={day < today}
            onClick={() => select(day)}>{date.getDate()}</button>
        })}</div>
      <div className="auto-date-footer"><span>按本机时区选择日期</span><button type="button" onClick={() => select(today)}>今天</button></div>
    </div>, document.body)}
  </>
}
