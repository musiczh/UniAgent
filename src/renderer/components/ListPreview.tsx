import { useMemo } from 'react'
import { Markdown } from './Markdown'

/**
 * Detect whether `text` contains Markdown *list* syntax — the only construct
 * Doc1 需求2 asks us to preview. We look for ordered (`1.`) or unordered
 * (`-`, `*`, `+`) markers at the start of a (optionally indented) line.
 */
export function hasListSyntax(text: string): boolean {
  if (!text) return false
  return text.split('\n').some((line) => /^\s*([-*+]|\d+[.)])\s+\S/.test(line))
}

/**
 * Live Markdown preview for list input (Doc1 需求2). Rendered *only* when the
 * current text actually contains list syntax, so plain prose typing is
 * unaffected. Uses the shared sanitized Markdown renderer (preview approach,
 * not a contentEditable), so ordered/unordered lists render in real time as the
 * user types.
 */
export function ListPreview({ text }: { text: string }): JSX.Element | null {
  const show = useMemo(() => hasListSyntax(text), [text])
  if (!show) return null
  return (
    <div className="list-preview" aria-label="列表预览">
      <div className="list-preview-tag">列表预览</div>
      <Markdown text={text} />
    </div>
  )
}
