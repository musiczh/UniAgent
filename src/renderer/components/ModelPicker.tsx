import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelDef } from '@shared/types'
import { UiIcon } from './Icons'

/**
 * Doc1 — model selector with a server-side load badge. A native <select> can't
 * render per-option colored badges, so this is a light custom dropdown: a button
 * showing the current model + its load pill, and a popup list of options each
 * with their own pill. Only TraeX's model cache carries `loadPercent`; codex/
 * claude models leave it undefined so no pill shows (graceful degrade).
 *
 * Load thresholds (Doc1): <80% green (空闲), 80–100% yellow (较忙), >100% red
 * (过载, the CLI reports raw percentages that can exceed 100 under pressure).
 */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  portal = false
}: {
  models: ModelDef[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  portal?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const previousValue = useRef(value)

  const commitSelection = (id: string): void => {
    setOpen(false)
    onChange(id)
  }

  // A parent update can disable the picker or commit a new value without going
  // through this instance's option click (session switch, streamed status update).
  // Never leave a stale popup mounted in either case.
  useEffect(() => {
    if (disabled || previousValue.current !== value) setOpen(false)
    previousValue.current = value
  }, [disabled, value])

  // Close on outside click / Escape so it behaves like a real menu.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !portal) return
    const place = (): void => {
      const anchor = rootRef.current?.getBoundingClientRect()
      const menu = menuRef.current?.getBoundingClientRect()
      if (anchor && menu) setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - menu.width - 12)),
        top: Math.max(12, Math.min(anchor.top - menu.height - 6, window.innerHeight - menu.height - 12)) })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(rootRef.current!); observer.observe(menuRef.current!)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, portal])

  const current = models.find((m) => m.id === value) || models[0]
  const label = current?.label || '无可用模型'
  const noModels = models.length === 0
  const menu = open ? <div ref={menuRef} className={`mp-menu${portal ? ' mp-menu-portal' : ''}`} role="listbox"
    style={portal ? { position: 'fixed', bottom: 'auto', ...position, maxHeight: 'min(320px, calc(100vh - 24px))' } : undefined}>
    {models.map(m => <button key={m.id} type="button" className={`mp-opt ${m.id === current?.id ? 'is-sel' : ''}`}
      role="option" aria-selected={m.id === current?.id} onClick={() => commitSelection(m.id)}>
      <span className="mp-opt-label">{m.label}</span><LoadBadge percent={m.loadPercent} />
    </button>)}
  </div> : null

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="mp-trigger"
        aria-label="模型"
        disabled={disabled || noModels}
        onClick={() => setOpen((o) => !o)}
        title="模型（轮次间可调）"
      >
        <span className="mp-label">{label}</span>
        {current && <LoadBadge percent={current.loadPercent} />}
        <span className="mp-caret"><UiIcon name="chevron-down" size={12} /></span>
      </button>
      {portal && menu ? createPortal(menu, document.body) : menu}
    </div>
  )
}

/**
 * Server-load pill. Hidden when the model cache omits load (codex/claude). The
 * band colors follow Doc1: idle (<80) green, busy (80–100) yellow, overloaded
 * (>100) red. The raw percentage is shown so operators can read the exact figure.
 */
export function LoadBadge({ percent }: { percent?: number }): JSX.Element | null {
  if (typeof percent !== 'number') return null
  const band = percent > 100 ? 'over' : percent >= 80 ? 'busy' : 'idle'
  const title =
    band === 'over' ? '服务端过载' : band === 'busy' ? '服务端较忙' : '服务端空闲'
  return (
    <span className={`mp-load mp-load-${band}`} title={`${title} · 负载 ${percent}%`}>
      {percent}%
    </span>
  )
}
