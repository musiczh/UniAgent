import { UiIcon } from './Icons'

export function ModelSourceCheckbox({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange?: (checked: boolean) => void }): JSX.Element {
  return <span className={`model-source-checkbox${disabled ? ' disabled' : ''}`}>
    <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={event => onChange?.(event.target.checked)} />
    <span aria-hidden="true"><UiIcon name="check" size={12} /></span>
  </span>
}
