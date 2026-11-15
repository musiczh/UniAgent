import { useRef, useState, type ReactNode } from 'react'
import type { AppSettings, AppSettingsPatch } from '@shared/types'
import { settingSection, validateSetting } from '@shared/settingsDefinition'
import { SetGroup, SetRow, SetSelect } from './SettingsPrimitives'
import { ToggleSwitch } from './Icons'

/** Simple controls come directly from the same definitions exposed by MCP. */
export function DefinedSettingsGroup({ path, settings, onSaved, children }: {
  path: string; settings: AppSettings | null; onSaved: (settings: AppSettings) => void; children?: ReactNode
}): JSX.Element {
  const section = settingSection(path)
  const flight = useRef(false)
  const [saving,setSaving] = useState(false), [error,setError] = useState('')
  async function save(key: string, value: unknown): Promise<void> {
    if (!settings || flight.current) return
    flight.current = true; setSaving(true); setError('')
    try {
      validateSetting(section.fields[key],value,key)
      const patch = section.key ? { [section.key]:{[key]:value} } : { [key]:value }
      onSaved(await window.uniagent.setAppSettings(patch as AppSettingsPatch))
    } catch { setError(section.title+'设置保存失败，请重试。') }
    finally { flight.current = false; setSaving(false) }
  }
  const source = section.key ? (settings as unknown as Record<string,unknown> | null)?.[section.key] : settings
  const values = source as Record<string,unknown> | undefined
  return <SetGroup title={section.title}>
    {children}
    {Object.entries(section.fields).map(([key,field]) => {
      if (field.readOnly || field.sensitive) return null
      const value = values?.[key] ?? field.default
      const disabled = !settings || saving
      let control: ReactNode
      if (field.type === 'boolean') control = <ToggleSwitch checked={value === true} disabled={disabled} label={field.label} onChange={checked => { void save(key,checked) }} />
      else if (field.enum) control = <SetSelect ariaLabel={field.label} value={String(value ?? '')} disabled={disabled} onChange={selected => { void save(key,field.type === 'integer' ? Number(selected) : selected) }}>
        {field.enum.map(option => <option key={option} value={option}>{field.enumLabels?.[String(option)] || option}</option>)}
      </SetSelect>
      else if (field.type === 'string' || field.type === 'integer') control = <input key={String(value)} className="set-input" aria-label={field.label} disabled={disabled}
        type={field.type === 'integer' ? 'number' : 'text'} defaultValue={String(value ?? '')} min={field.minimum} max={field.maximum} maxLength={field.maxLength}
        onBlur={event => { const next = field.type === 'integer' ? Number(event.target.value) : event.target.value; if (next !== value) void save(key,next) }} />
      else return null // Composite editors bind the same field schema in their existing view.
      return <SetRow key={key} label={field.label} sub={field.description} control={control} />
    })}
    {error && <p className="set-detail-sub" role="alert">{error}</p>}
  </SetGroup>
}
