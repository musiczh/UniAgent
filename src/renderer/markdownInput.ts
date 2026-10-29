export interface MarkdownSlashMatch {
  start: number
  end: number
  query: string
}

export interface MarkdownInputHandle {
  focus: (position?: 'end') => void
  clear: () => void
  replaceSlash: (match: MarkdownSlashMatch, replacement: string) => void
}

// Also recognize Chinese keyboard variants at word boundaries.
export function detectSlash(text: string, caret: number): MarkdownSlashMatch | null {
  const match = text.slice(0, caret).match(/(^|\s)[/、$¥]([^\s/、$¥]*)$/)
  if (!match) return null
  return { start: match.index! + match[1].length, end: caret, query: match[2] }
}

export type ComposerKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'preventDefault'>
export type ComposerPasteEvent = Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>
