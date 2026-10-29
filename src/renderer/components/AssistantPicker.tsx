import type { ReactNode } from 'react'
import { UiIcon } from './Icons'
import './assistant.css'
export function AssistantPicker({ enabled, available, disabled, visible = true, onChange, onManage, children }: { enabled: boolean; available: boolean; disabled?: boolean; visible?: boolean; onChange(enabled: boolean): void; onManage(): void; children: ReactNode }): JSX.Element {
  if (!visible) return <>{children}</>
  return <>
    <button type="button" role="option" aria-selected={enabled} className={'sb-menu-item sb-sub-opt ' + (enabled ? 'is-sel' : '')} disabled={disabled || !available} title={available ? undefined : '请先在设置中启用个人助手'} onClick={() => onChange(true)}>
      <span className="sb-sub-radio" aria-hidden /><span className="sb-entry-body"><span className="sb-agent-name"><UiIcon name="identity" size={14} /><span className="sb-agent-name-label">个人助手</span></span></span><UiIcon name="check" size={13} className="sb-sub-check" />
    </button><div className="sb-menu-sep" />{children}<div className="sb-menu-sep" />
    <button type="button" className="sb-menu-item" disabled={disabled} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); onManage() }}><UiIcon name="settings" size={14} />个人助手设置</button>
  </>
}
