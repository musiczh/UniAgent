import { useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { ToggleSwitch } from './Icons'
import { settingSection } from '@shared/settingsDefinition'

export function SidebarStyleSetting({ settings, onSaved }: { settings?: AppSettings; onSaved: (settings: AppSettings) => void }): JSX.Element {
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const field = settingSection('/general/sidebar').fields.spaceRequirementSidebar
  async function save(checked: boolean): Promise<void> {
    if (busy.current || !settings) return
    busy.current = true; setSaving(true); setError('')
    try { onSaved(await window.uniagent.setAppSettings({ spaceRequirementSidebar: checked })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { busy.current = false; setSaving(false) }
  }
  return <SetGroup title="侧栏样式">
    <SetRow label={field.label} sub={field.description}
      control={<ToggleSwitch label={field.label} checked={settings?.spaceRequirementSidebar !== false} disabled={!settings || saving} onChange={checked => { void save(checked) }} />} />
    {error && <p className="requirement-error" role="alert">{error}</p>}
  </SetGroup>
}
