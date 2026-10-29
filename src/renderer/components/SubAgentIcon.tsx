/**
 * 子 Agent v3 — deterministic per-child glyph (改动4). A sub-agent's thread id is
 * hashed to one of 12 distinct colored marks so the SAME child shows the SAME
 * icon everywhere it appears: the inline status rows, the summary card avatar
 * stack, the side-panel list, and the detail header. The CSP forbids remote
 * images, so each mark is an inline single-file SVG injected verbatim.
 */

/** The 12-glyph library (ported 1:1 from the approved v3 mockup). */
const GLYPHS: Record<string, string> = {
  dots: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#f0616d"><circle cx="12" cy="5.5" r="2.6"/><circle cx="12" cy="18.5" r="2.6"/><circle cx="5.8" cy="9" r="2.6"/><circle cx="18.2" cy="9" r="2.6"/><circle cx="5.8" cy="15" r="2.6"/><circle cx="18.2" cy="15" r="2.6"/></g><circle cx="12" cy="12" r="2.9" fill="#ff98a1"/></svg>`,
  flower: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#e3b341"><ellipse cx="12" cy="5" rx="2.4" ry="4"/><ellipse cx="12" cy="19" rx="2.4" ry="4"/><ellipse cx="5" cy="12" rx="4" ry="2.4"/><ellipse cx="19" cy="12" rx="4" ry="2.4"/></g><circle cx="12" cy="12" r="3.1" fill="#f6d365"/></svg>`,
  pinwheel: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#5b9dff"><path d="M12 12 L12 3 A9 9 0 0 1 21 12 Z" opacity=".95"/><path d="M12 12 L21 12 A9 9 0 0 1 12 21 Z" opacity=".7"/><path d="M12 12 L12 21 A9 9 0 0 1 3 12 Z" opacity=".95"/><path d="M12 12 L3 12 A9 9 0 0 1 12 3 Z" opacity=".7"/></g></svg>`,
  diamond: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#a371f7"><path d="M12 3l4 9-4 9-4-9z"/><path d="M3 12l9-4 9 4-9 4z" opacity=".65"/></g></svg>`,
  globe: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#5b9dff" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="4" ry="8.5"/><line x1="3.5" y1="12" x2="20.5" y2="12"/></g></svg>`,
  globe2: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#39c5cf" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="4" ry="8.5"/><path d="M4 9.5h16M4 14.5h16"/></g></svg>`,
  hourglass: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#39c5cf"><path d="M6 4h12l-6 8z"/><path d="M6 20h12l-6-8z" opacity=".7"/></g></svg>`,
  burst: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g stroke="#e3934a" stroke-width="2" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/><line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/></g><circle cx="12" cy="12" r="2.6" fill="#e3934a"/></svg>`,
  hex: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#d05ce3"><circle cx="12" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><circle cx="6.8" cy="9" r="2.4"/><circle cx="17.2" cy="9" r="2.4"/><circle cx="6.8" cy="15" r="2.4"/><circle cx="17.2" cy="15" r="2.4"/></g></svg>`,
  trefoil: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="#3fb950"><circle cx="12" cy="7" r="4"/><circle cx="6.5" cy="16" r="4" opacity=".85"/><circle cx="17.5" cy="16" r="4" opacity=".85"/></g></svg>`,
  spiral: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 12 m0 -8 a8 8 0 1 1 -5.6 2.3 a5.5 5.5 0 1 0 4 -1.6 a3 3 0 1 1 -2 1" fill="none" stroke="#2fc7a6" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  star: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.7 6.3 6.8.6-5.1 4.5 1.5 6.7L12 17.9 6.1 20.6l1.5-6.7-5.1-4.5 6.8-.6z" fill="#6f7cf7"/></svg>`
}

const GLYPH_KEYS = Object.keys(GLYPHS)

/** Soft translucent backgrounds keyed by glyph, matching each mark's hue. */
const BG: Record<string, string> = {
  dots: 'rgba(240,97,109,.14)',
  flower: 'rgba(227,179,65,.14)',
  pinwheel: 'rgba(91,157,255,.14)',
  diamond: 'rgba(163,113,247,.14)',
  globe: 'rgba(91,157,255,.14)',
  globe2: 'rgba(57,197,207,.14)',
  hourglass: 'rgba(57,197,207,.14)',
  burst: 'rgba(227,147,74,.14)',
  hex: 'rgba(208,92,227,.14)',
  trefoil: 'rgba(63,185,80,.14)',
  spiral: 'rgba(47,199,166,.14)',
  star: 'rgba(111,124,247,.14)'
}

/** Stable 32-bit string hash so a thread id always maps to the same glyph. */
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Deterministically resolve a child's glyph key + tinted background. */
export function subAgentGlyph(threadId: string): { key: string; bg: string } {
  const key = GLYPH_KEYS[hashStr(threadId || '') % GLYPH_KEYS.length]
  return { key, bg: BG[key] }
}

/** A sub-agent's colored avatar mark, sized by `size` (px). */
export function SubAgentIcon({
  threadId,
  size = 20,
  className = '',
  plain = false
}: {
  threadId: string
  size?: number
  className?: string
  /** Render the vector glyph directly, without the tinted rounded-square plate. */
  plain?: boolean
}): JSX.Element {
  const { key, bg } = subAgentGlyph(threadId)
  return (
    <span
      className={`sa-ic${plain ? ' sa-ic-plain' : ''} ${className}`.trim()}
      style={plain ? { width: size, height: size } : { width: size, height: size, background: bg }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: GLYPHS[key] }}
    />
  )
}
