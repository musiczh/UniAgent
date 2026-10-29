import type { ReactNode } from 'react'
import { codeLanguageFromPath } from '@shared/codeLanguage'

const SIMPLE_TOKEN =
  /(\/\/.*|#.*|\/\*.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|(\b(?:true|false|null|undefined|nil|None)\b)|(\b(?:abstract|async|await|break|case|catch|char|class|const|continue|data|def|default|delete|do|double|else|end|enum|export|extends|final|finally|float|fn|for|from|fun|func|function|if|implements|import|in|int|interface|internal|let|long|match|module|namespace|new|of|open|override|package|private|protected|public|record|require|return|sealed|static|struct|switch|template|throw|trait|try|type|typeof|using|val|var|virtual|void|when|while|with|yield)\b)/gi

const HASH_COMMENT_LANGUAGES = new Set(['python', 'ruby', 'shell', 'yaml', 'toml'])
const LANGUAGE_ONLY_KEYWORDS: Record<string, Set<string>> = {
  data: new Set(['kotlin']),
  fun: new Set(['kotlin']),
  internal: new Set(['kotlin', 'csharp']),
  open: new Set(['kotlin', 'swift']),
  override: new Set(['kotlin', 'swift', 'csharp']),
  sealed: new Set(['java', 'kotlin', 'csharp']),
  val: new Set(['kotlin', 'scala']),
  when: new Set(['kotlin', 'sql'])
}

export { codeLanguageFromPath }

export function highlightedLine(line: string, language?: string): ReactNode {
  if (!language || language === 'plaintext' || language === 'text') return line || '\u200b'
  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of line.matchAll(SIMPLE_TOKEN)) {
    const index = match.index || 0
    if (index > cursor) parts.push(line.slice(cursor, index))
    const restrictedLanguages = match[5] && LANGUAGE_ONLY_KEYWORDS[match[5]]
    if ((match[1]?.startsWith('#') && !HASH_COMMENT_LANGUAGES.has(language)) ||
        (restrictedLanguages && !restrictedLanguages.has(language))) {
      parts.push(match[0])
      cursor = index + match[0].length
      continue
    }
    const kind = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'number' : match[4] ? 'literal' : 'keyword'
    parts.push(<span className={`fb-syn-${kind}`} key={`${index}-${kind}`}>{match[0]}</span>)
    cursor = index + match[0].length
  }
  if (cursor < line.length) parts.push(line.slice(cursor))
  return parts.length ? parts : '\u200b'
}
