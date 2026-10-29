/**
 * Small inline UI glyphs (需求7/需求8). The CSP forbids remote images and icon
 * fonts render inconsistently across the built-in agents' themes, so each icon
 * is a single-color SVG that inherits `currentColor`. Keep them stroke-based and
 * on a 24×24 grid so `size` scales crisply.
 */

/**
 * Sidebar toggle glyph (需求7) — a panel outline with a divider, matching the
 * codex "collapse sidebar" affordance. Replaces the old `‹`/`›` chevrons which
 * read as generic back/forward arrows. `filled` marks the collapsed pane so the
 * expand and collapse buttons stay visually distinct.
 */
export function SidebarIcon({
  size = 16,
  className = '',
  filled = false
}: {
  size?: number
  className?: string
  filled?: boolean
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-sidebar ${className}`.trim()}
      aria-hidden
      focusable={false}
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9" y1="4" x2="9" y2="20" />
      {filled && <rect x="3.6" y="4.6" width="4.8" height="14.8" rx="1.4" fill="currentColor" stroke="none" />}
    </svg>
  )
}

export function FolderIcon({
  size = 16,
  className = ''
}: {
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-folder ${className}`.trim()}
      aria-hidden
      focusable={false}
    >
      <path
        d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"
        fill="currentColor"
        fillOpacity="0.14"
      />
      <path d="M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2" />
    </svg>
  )
}

/**
 * Refresh / re-detect glyph — replaces the tiny `⟳` character in the settings
 * "重新探测" button, which rendered inconsistently and too small across themes.
 */
export function RefreshIcon({
  size = 14,
  className = ''
}: {
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-refresh ${className}`.trim()}
      aria-hidden
      focusable={false}
    >
      <path d="M20 11a8 8 0 1 0-.6 3" />
      <polyline points="20 4 20 11 13 11" />
    </svg>
  )
}

/**
 * Clock glyph for the automation "触发时间" field — pairs with the native time
 * input in place of a bare Unicode clock character.
 */
export function ClockIcon({
  size = 14,
  className = ''
}: {
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-clock ${className}`.trim()}
      aria-hidden
      focusable={false}
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  )
}

export type UiIconName =
  | 'back'
  | 'history'
  | 'automations'
  | 'tokens'
  | 'settings'
  | 'agent'
  | 'user-circle'
  | 'question'
  | 'capabilities'
  | 'templates'
  | 'feishu'
  | 'diagnostics'
  | 'plus'
  | 'close'
  | 'search'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'check'
  | 'checkbox'
  | 'lock'  | 'minus'
  | 'archive'
  | 'trash'
  | 'restore'
  | 'pin'
  | 'edit'
  | 'paperclip'
  | 'rewind'
  | 'copy'
  | 'book-open'
  | 'table-of-contents'
  | 'chevrons-left'
  | 'chevrons-right'
  | 'external-link'
  | 'globe'
  | 'swap-horizontal'
  | 'dispatch'
  | 'flag'
  | 'message-square'
  | 'file-diff'
  | 'fork'
  | 'zap'
  | 'file'
  | 'image'
  | 'code'
  | 'sparkles'
  | 'bot'
  | 'users'
  | 'identity'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'sliders'
  | 'model'
  | 'diff'
  | 'lightbulb'
  | 'plug'
  | 'shield'
  | 'warn'
  | 'folder'
  | 'eye'
  | 'refresh'
  | 'expand'
  | 'collapse'
  | 'target'
  | 'alert-circle'
  | 'gauge'

/** Shared navigation glyphs, kept on the same 24px stroke grid. */
export function UiIcon({
  name,
  size = 16,
  className = ''
}: {
  name: UiIconName
  size?: number
  className?: string
}): JSX.Element {
  const paths: Record<UiIconName, JSX.Element> = {
    globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M12 8v4l2.8 1.8" /></>,
    automations: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2" /><path d="M9 3h6" /></>,
    tokens: <><path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M3 19h18" /></>,
    gauge: <><path d="M5 19a9 9 0 1 1 14 0" /><path d="M12 13l3.6-4.3" /><circle cx="12" cy="13.6" r="1.3" fill="currentColor" stroke="none" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.7-1.6l.9-1.9-2.1-2.1-1.9.9a7 7 0 0 0-1.7-.7L10.5 2h-3l-.7 2a7 7 0 0 0-1.6.7l-1.9-.9-2.1 2.1.9 1.9a7 7 0 0 0-.7 1.7L0 10.5v3l2 .7a7 7 0 0 0 .7 1.6l-.9 1.9 2.1 2.1 1.9-.9a7 7 0 0 0 1.7.7l1 2.4h3l.7-2a7 7 0 0 0 1.6-.7l1.9.9 2.1-2.1-.9-1.9a7 7 0 0 0 .7-1.7z" transform="translate(1.5) scale(.875)" /></>,
    agent: <><circle cx="12" cy="8" r="3" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></>,
    'user-circle': <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="8" r="3" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></>,
    question: <><path d="M21 14a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /><path d="M9.5 8a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.8-2.5 3" /><circle cx="12" cy="14" r=".5" fill="currentColor" stroke="none" /></>,
    capabilities: <><path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-3 3-4-4z" /></>,
    templates: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    feishu: <><path d="m3 11 18-8-7 18-3.5-7z" /><path d="m10.5 14 4-4" /></>,
    diagnostics: <><path d="M3 12h4l2-5 4 10 2-5h6" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></>,
    'arrow-right': <><path d="M5 12h14M14 7l5 5-5 5" /></>,
    'arrow-up': <><path d="M12 19V5M7 10l5-5 5 5" /></>,
    'arrow-down': <><path d="M12 5v14M7 14l5 5 5-5" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    checkbox: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    minus: <><path d="M5 12h14" /></>,
    archive: <><rect x="3" y="5" width="18" height="4" rx="1" /><path d="M5 9v10h14V9M9 13h6" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" /></>,
    restore: <><path d="M4 9v6h6" /><path d="M5.5 14.5A8 8 0 1 0 7 6.5L4 9" /></>,
    pin: <><path d="M14 4l6 6-4 2-4 4-2 4-6-6 4-2 4-4zM8 16l-5 5" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></>,
    paperclip: <><path d="m20.5 11.5-8.8 8.8a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></>,
    rewind: <><path d="M9 7 4 12l5 5" /><path d="M4 12h9a7 7 0 0 1 7 7" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    'book-open': <><path d="M3 5.5A9 9 0 0 1 12 7v12a9 9 0 0 0-9-1.5z" /><path d="M21 5.5A9 9 0 0 0 12 7v12a9 9 0 0 1 9-1.5z" /></>,
    'table-of-contents': <path d="M4 6h16M4 12h16M4 18h11" />,
    'chevrons-left': <path d="m11 6-6 6 6 6M19 6l-6 6 6 6" />,
    'chevrons-right': <path d="m5 6 6 6-6 6M13 6l6 6-6 6" />,
    'external-link': <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    'swap-horizontal': <><path d="M7 7h13M16 3l4 4-4 4" /><path d="M17 17H4M8 13l-4 4 4 4" /></>,
    dispatch: <><circle cx="5" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><path d="M5 7v10M5 12h8a5 5 0 0 0 5-5V4m-3 3 3-3 3 3" /></>,
    'flag': <><path d="M5 21V3M5 4h6l2 3h7v10h-7l-2-3H5" /></>,
    'message-square': <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></>,
    'file-diff': <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h3M9.5 11.5v3M14 17h3" /></>,
    fork: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5a9 9 0 0 0 6 7M18 8.5a9 9 0 0 1-6 7" /></>,
    zap: <><path d="M13 2 4 14h8l-1 8 9-12h-8z" /></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4.5-4.5 3 3 2-2L19 18" /></>,
    code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" /></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2zM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8zM19 13l.7 1.8 1.8.7-1.8.7L19 18l-.7-1.8-1.8-.7 1.8-.7z" /></>,
    bot: <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c.5-4 2.5-6 6-6s5.5 2 6 6M16 5.5a3 3 0 0 1 0 5.5M17 14c2.3.5 3.6 2.5 4 5" /></>,
    identity: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="8" cy="10" r="2" /><path d="M5 16c.3-2 1.3-3 3-3s2.7 1 3 3M14 9h4M14 13h4" /></>,
    'chevron-down': <><path d="m6 9 6 6 6-6" /></>,
    'chevron-left': <><path d="m15 6-6 6 6 6" /></>,
    'chevron-right': <><path d="m9 6 6 6-6 6" /></>,
    sliders: <><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2" /><circle cx="9" cy="16" r="2" /></>,
    model: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>,
    diff: <><path d="M12 3v18" /><path d="M6 8H3M4.5 6.5v3M6 16H3M21 8h-3M21 16h-3" /></>,
    lightbulb: <><path d="M9 18h6M10 22h4M8.5 15.5A7 7 0 1 1 15.5 15.5c-.9.7-1.3 1.4-1.5 2.5h-4c-.2-1.1-.6-1.8-1.5-2.5z" /></>,
    plug: <><path d="M8 3v6M16 3v6M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6" /></>,
    shield: <><path d="M12 3 20 6v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
    warn: <><path d="M12 3 2 20h20z" /><path d="M12 10v5M12 17.5v.5" /></>,
    folder: <><path d="M4 6h5l2 2h9a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" transform="translate(1) scale(.9)" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-.6 3" /><path d="M20 4v7h-7" /></>,
    expand: <><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" /></>,
    collapse: <><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5" /></>,
    target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    'alert-circle': <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.5" /></>
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-${name} ${className}`.trim()}
      aria-hidden
      focusable={false}
    >
      {paths[name]}
    </svg>
  )
}

/** Native-button semantics with a custom visual track. */
export function ToggleSwitch({
  checked,
  label,
  disabled = false,
  onChange
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="ui-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  )
}

export function SendIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ui-icon ui-icon-send"
      aria-hidden
      focusable={false}
    >
      <path d="M12 19V5" />
      <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
    </svg>
  )
}

/** codex-style stop glyph — a filled rounded square, used for the interrupt button. */
export function StopIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className="ui-icon ui-icon-stop"
      aria-hidden
      focusable={false}
    >
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.6" />
    </svg>
  )
}

/**
 * Diff-layout glyph for the Review toolbar's single view toggle — two red/green
 * panes side-by-side (`split`) or stacked (`unified`), mirroring the codex diff
 * button. The fill is intentionally not `currentColor`: the red/green is the
 * whole affordance.
 */
export function DiffLayoutIcon({ view, size = 17 }: { view: 'split' | 'unified'; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`ui-icon ui-icon-diff-layout is-${view}`}
      aria-hidden
      focusable={false}
    >
      {view === 'split' ? (
        <>
          <rect x="3" y="4.5" width="8" height="15" rx="1.8" fill="var(--red)" />
          <rect x="13" y="4.5" width="8" height="15" rx="1.8" fill="var(--green)" />
        </>
      ) : (
        <>
          <rect x="3.5" y="4" width="17" height="7" rx="1.8" fill="var(--red)" />
          <rect x="3.5" y="13" width="17" height="7" rx="1.8" fill="var(--green)" />
        </>
      )}
    </svg>
  )
}

/**
 * Fold-rows glyph for the Review toolbar's single "完整 / 只看变更" toggle —
 * arrows fanning out (`full`, showing all context) or pulling in (`changed`,
 * collapsed to edits only), matching the codex collapse affordance.
 */
export function FoldRowsIcon({ mode, size = 17 }: { mode: 'full' | 'changed'; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-fold-rows is-${mode}`}
      aria-hidden
      focusable={false}
    >
      <path d="M4 12h4M16 12h4" />
      {mode === 'full' ? (
        <><path d="M8 9l4-4 4 4" /><path d="M8 15l4 4 4-4" /></>
      ) : (
        <><path d="M8 5l4 4 4-4" /><path d="M8 19l4-4 4 4" /></>
      )}
    </svg>
  )
}

/**
 * Disclosure chevron (需求8) — replaces the tiny `▸`/`▾` triangles used for
 * collapsible groups and turn chains. Rotates via CSS transform when `open`, so
 * a single glyph covers both states and the hit target stays generous.
 */
export function Chevron({
  open = false,
  size = 14,
  className = ''
}: {
  open?: boolean
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ui-icon-chevron ${open ? 'is-open' : ''} ${className}`.trim()}
      aria-hidden
      focusable={false}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}
