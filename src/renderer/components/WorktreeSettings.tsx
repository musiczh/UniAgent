import type { AppSettings } from '@shared/types'
import { DefinedSettingsGroup } from './DefinedSettingsGroup'

export function WorktreeSettings({ settings, onSaved }: { settings: AppSettings | null; onSaved: (settings: AppSettings) => void }): JSX.Element {
  return <DefinedSettingsGroup path="/general/worktree" settings={settings} onSaved={onSaved} />
}
