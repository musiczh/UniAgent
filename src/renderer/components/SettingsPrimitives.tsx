import type { ReactNode } from 'react'
import { UiIcon } from './Icons'

export function SetGroup({ title, action, pad, children }: { title?: string; action?: ReactNode; pad?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className="set-group">
      {(title || action) && (
        <div className="set-group-t">
          {title && <span className="set-group-t-label">{title}</span>}
          {action && <span className="set-group-t-action">{action}</span>}
        </div>
      )}
      <div className={`set-card${pad ? ' pad' : ''}`}>{children}</div>
    </div>
  )
}
export function SetRow({
  label,
  sub,
  icon,
  control,
  onClick,
  ariaLabel
}: {
  label: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  control?: ReactNode
  onClick?: () => void
  ariaLabel?: string
}): JSX.Element {
  const body = (
    <>
      <div className="r-main">
        <div className="r-label">{icon}{label}</div>
        {sub && <div className="r-sub">{sub}</div>}
      </div>
      <div className="r-control">
        {control}
        {onClick && <span className="set-caret"><UiIcon name="chevron-right" size={16} /></span>}
      </div>
    </>
  )
  if (onClick) {
    return (
      <button type="button" className="row rowlink" aria-label={ariaLabel} onClick={onClick}>{body}</button>
    )
  }
  return <div className="row">{body}</div>
}

/** A read-only "select-looking" chip that wraps a native <select> for real choice. */
export function SetSelect({
  value,
  disabled,
  ariaLabel,
  onChange,
  children,
  leading
}: {
  value: string
  disabled?: boolean
  ariaLabel: string
  onChange: (value: string) => void
  children: ReactNode
  leading?: ReactNode
}): JSX.Element {
  return (
    <span className={`set-select ${disabled ? 'is-disabled' : ''}`} style={{ position: 'relative' }}>
      {leading}
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ appearance: 'none', background: 'transparent', border: 0, color: 'inherit', font: 'inherit', outline: 'none', cursor: disabled ? 'default' : 'pointer', flex: 1, width: '100%', minWidth: 0, paddingRight: 22 }}
      >
        {children}
      </select>
      <span className="set-caret" style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><UiIcon name="chevron-right" size={14} /></span>
    </span>
  )
}
