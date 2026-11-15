import { useRef, useState } from 'react'
import { COLOR_THEMES, resolveColorTheme, type ColorThemeId } from '../../shared/colorThemes'
import type { AppSettings } from '../../shared/types'
import { applyColorTheme } from '../colorTheme'
import { UiIcon } from './Icons'
import { settingSection } from '@shared/settingsDefinition'

export function ColorThemePicker({ settings, onSaved }: {
  settings: AppSettings | null
  onSaved: (settings: AppSettings) => void
}): JSX.Element {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const selected = resolveColorTheme(settings?.theme)
  const field = settingSection('/general/appearance').fields.theme

  async function select(theme: ColorThemeId): Promise<void> {
    if (!settings || pending.current || theme === selected) return
    pending.current = true
    setSaving(true)
    setError('')
    try {
      const next = await window.uniagent.setAppSettings({ theme })
      applyColorTheme(next.theme)
      onSaved(next)
    } catch {
      setError('颜色风格保存失败，请重试。')
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return <>
    <div className="color-theme-heading">
      <div><div className="r-label">{field.label}</div><div className="r-sub">{field.description}</div></div>
      <span className="color-theme-current"><UiIcon name="check" size={13} />{COLOR_THEMES.find(theme => theme.id === selected)?.name}</span>
    </div>
    <div className="color-theme-options" role="group" aria-label="颜色风格" aria-busy={saving}>
      {COLOR_THEMES.map(theme => <button key={theme.id} type="button" className="color-theme-option"
        aria-label={theme.name} aria-pressed={selected === theme.id} title={theme.description}
        disabled={!settings || saving} onClick={() => { void select(theme.id) }}>
        <span className="color-theme-preview" data-color-theme={theme.id} aria-hidden="true">
          <span className="color-theme-side"><i /><i /><i /></span>
          <span className="color-theme-main"><i className="color-theme-bubble" /><i /><i /><i className="color-theme-input" /></span>
        </span>
        <span className="color-theme-label">{theme.name}<span className="color-theme-check"><UiIcon name="check" size={13} /></span></span>
      </button>)}
    </div>
    {error && <p className="color-theme-error" role="alert">{error}</p>}
  </>
}
