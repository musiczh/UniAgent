import { useEffect, useRef } from 'react'
import type { NativeCandidate } from '@shared/nativeCapabilities'
import { filterNativeCandidates } from '../hooks'

/**
 * The `/` command palette (Doc4 需求1 / G2-6). Opens when the word under the
 * caret starts with `/`; shows provider-native Skill, MCP, and command candidates filtered
 * by the token after the slash. Pick with the mouse or ↑/↓ + Enter.
 */
export function SlashMenu({
  hits,
  totalCount,
  onPick,
  onClose,
  activeIndex,
  setActiveIndex
}: {
  hits: NativeCandidate[]
  totalCount: number
  onPick: (c: NativeCandidate) => void
  onClose: () => void
  activeIndex: number
  setActiveIndex: (n: number) => void
}): JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector('.slash-item.active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (hits.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-empty">无匹配的 Skill / MCP / Command（{totalCount} 个可用）</div>
      </div>
    )
  }

  const kindLabel = (k: NativeCandidate['kind']): string =>
    k === 'mcp' ? 'MCP' : k === 'command' ? 'Command' : 'Skill'
  const groupLabel = kindLabel

  return (
    <div className="slash-menu" ref={listRef} onMouseDown={(e) => e.preventDefault()}>
      {hits.map((c, i) => {
        const prev = hits[i - 1]
        const showGroup = !prev || prev.kind !== c.kind
        return (
          <div key={c.id}>
            {showGroup && <div className="slash-group">{groupLabel(c.kind)}</div>}
            <div
              className={`slash-item slash-kind-${c.kind} ${i === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onPick(c)}
            >
              <span className={`slash-kind slash-${c.kind}`}>{kindLabel(c.kind)}</span>
              <span className="slash-name">{c.name}</span>
              {c.description && <span className="slash-desc">{c.description}</span>}
            </div>
          </div>
        )
      })}
      <div className="slash-hint" onClick={onClose}>
        ↑↓ 选择 · ⏎ 确认 · Esc 关闭
      </div>
    </div>
  )
}

/** Back-compat filter export (kept for any external callers). */
export const filterCandidates = filterNativeCandidates
