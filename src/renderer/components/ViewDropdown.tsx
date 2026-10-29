/**
 * Shared sidebar view/grouping switcher (需求G2-5). A horizontal segmented
 * control — every view is one click, current one inlined-highlighted — reused
 * by the session list (全部/执行方/空间/需求). Mockup: 方案 B.
 */
export function ViewDropdown<T extends string>({
  ariaLabel,
  value,
  onChange,
  options
}: {
  ariaLabel: string
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
}): JSX.Element {
  return (
    <div className="sl-view">
      <div className="sl-seg" role="group" aria-label={ariaLabel}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            data-view={o.value}
            className={o.value === value ? 'is-on' : ''}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
