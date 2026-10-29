export interface ListContinuation {
  value: string
  caret: number
}

/** Continue the Markdown list item before the caret, or remove an empty marker. */
export function continueMarkdownList(
  value: string,
  selectionStart: number,
  selectionEnd: number
): ListContinuation | null {
  if (selectionStart !== selectionEnd) return null
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  const nextLine = value.indexOf('\n', selectionStart)
  const lineEnd = nextLine < 0 ? value.length : nextLine
  const match = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(.*)$/.exec(
    value.slice(lineStart, lineEnd)
  )
  if (!match) return null

  const [, indent, marker, number, separator, gap, rest] = match
  if (selectionStart - lineStart < indent.length + marker.length + gap.length) return null
  if (!rest.trim()) {
    return {
      value: value.slice(0, lineStart) + value.slice(lineEnd),
      caret: lineStart
    }
  }

  const nextMarker = number ? `${Number(number) + 1}${separator}` : marker
  const insert = `\n${indent}${nextMarker}${gap}`
  const suffix = value.slice(selectionStart, lineEnd).replace(/^[ \t]+/, '')
  return {
    value: value.slice(0, selectionStart) + insert + suffix + value.slice(lineEnd),
    caret: selectionStart + insert.length
  }
}
