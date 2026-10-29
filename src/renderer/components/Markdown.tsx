import { useContext, useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent, type KeyboardEvent } from 'react'
import DOMPurify from 'dompurify'
import type { FileBrowserListResult } from '@shared/types'
import { applyAnnotations, type Annotation } from '../textAnnotations'
import { parsePreviewMarkdown } from '../htmlPreview'
import { HtmlPreview, HtmlPreviewSessionContext } from './HtmlPreview'
import { MermaidDiagram } from './MermaidDiagram'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * A local file reference detected in agent prose (需求8). `path` is the raw
 * matched text (relative or absolute); `line` is the 1-based line when the ref
 * carried a `:line` / `:line:col` / `#Lline` suffix. The renderer only proposes
 * candidates; guarded file-browser listing verifies them before they look clickable.
 */
export interface LocalPathMatch {
  index: number
  length: number
  path: string
  line?: number
}

// A path body is a run of path-ish chars. We only accept it as a local path
// when it either contains a separator OR ends in a file extension, so plain
// prose words ("hello", "v1.0") don't turn blue. Trailing sentence punctuation
// is trimmed off by the caller.
const ASCII_PATH_PART = String.raw`[\w.@+%\\-]+`
const PATH_PART = String.raw`[\p{L}\p{N}\p{M}_.@+%\\-]+`
const SPACED_PATH_PART = String.raw`${PATH_PART}(?:[ \t]+${PATH_PART})*`
// An unprefixed first segment may contain ASCII spaces (for example,
// "My Project/file.ts"). Keeping its spaced form ASCII-only prevents prose
// such as "见 src/main/index.ts" from absorbing the leading Chinese word.
const FIRST_PATH_PART = String.raw`(?:${ASCII_PATH_PART}(?:[ \t]+${ASCII_PATH_PART})*|${PATH_PART})`
const PATH_BODY = String.raw`(?:` +
  String.raw`(?:~\/|\.{1,2}\/|\/|${FIRST_PATH_PART}\/)(?:${SPACED_PATH_PART}\/)*${SPACED_PATH_PART}\.[A-Za-z][A-Za-z0-9]{0,7}` +
  String.raw`|(?:~\/|\.{1,2}\/|\/)?${PATH_PART}(?:\/${PATH_PART})*` +
  String.raw`)`
const PATH_SUFFIX = String.raw`(?::(\d+)(?::\d+)?|#L(\d+))?`
const PATH_RE = new RegExp(
  // Not preceded by a path/url char so we don't slice inside https://… or a/b/c.
  String.raw`(?<![\p{L}\p{N}\p{M}_/~.@:+-])(${PATH_BODY})${PATH_SUFFIX}`,
  'gu'
)
const HAS_SEP = /\//
const HAS_EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/
// A bare "1.2" / "3.14" reads as a version/number, never a path.
const NUMERIC_ONLY = /^[\d.]+$/
export const MAX_LOCAL_PATH_LINE = 1_000_000
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\d+(?::\d+)?$)/
const DANGEROUS_URI = /^(?:file|javascript|data|vbscript|blob):/i
// DOMPurify consults this allowlist for every href/src. The escaped hyphens are
// load-bearing: an unescaped `.-:` inside the negated class parses as the range
// U+002E–U+003A, which contains `/`, so ordinary relative paths such as
// `docs/report.html` would be stripped before the local-file resolver sees them.
const MARKDOWN_URI_ALLOWLIST =
  /^(?:(?:https?|mailto|tel|uniagent-session):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
const unescapeMarkdownPath = (value: string): string =>
  value.replace(/\\([\s!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-])/g, '$1')

function isDangerousHref(raw: string): boolean {
  try {
    return DANGEROUS_URI.test(decodeURIComponent(unescapeMarkdownPath(raw)))
  } catch {
    return false
  }
}

function normalizeLocalPath(raw: string): string | null {
  let path = unescapeMarkdownPath(raw)
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  return !path || path.includes('\0') || URI_SCHEME.test(path) ? null : path
}

function parseLine(value?: string): number | undefined {
  if (!value) return undefined
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 && line <= MAX_LOCAL_PATH_LINE
    ? line
    : undefined
}

/**
 * Find local-path references in a plain-text string (需求8). Exported for unit
 * testing without a DOM. Skips numeric-only tokens and anything that is neither
 * a multi-segment path nor an extensioned filename.
 */
export function matchLocalPaths(text: string): LocalPathMatch[] {
  const out: LocalPathMatch[] = []
  for (const m of text.matchAll(PATH_RE)) {
    let body = m[1]
    const index = m.index ?? 0
    // Trim a trailing dot that belongs to the sentence, not the filename
    // (e.g. "见 src/a.ts。" or "…foo/bar."). Keep it only if an extension needs it.
    let trimmed = 0
    while (body.length > 1 && /[.,;:]$/.test(body) && !HAS_EXT.test(body)) {
      body = body.slice(0, -1)
      trimmed++
    }
    if (!body || NUMERIC_ONLY.test(body)) continue
    const path = normalizeLocalPath(body)
    if (!path || (!HAS_SEP.test(path) && !HAS_EXT.test(path))) continue
    const lineStr = m[2] || m[3]
    const line = parseLine(lineStr)
    if (lineStr && line == null) continue
    out.push({
      index,
      length: body.length + (trimmed ? 0 : (m[0].length - m[1].length)),
      path,
      line
    })
  }
  return out
}

// Hrefs that are genuinely external and must open in the shell, not the file
// browser. Everything else written as a markdown link is treated as a local
// path candidate (workdir confinement is enforced later by fileBrowser.ts).
const EXTERNAL_HREF = /^(?:\/\/|https?:|mailto:|tel:|ftp:|data:|vscode:|#)/i
export function classifyExternalHref(raw: string): string | null {
  const href = raw.trim()
  const resolved = href.startsWith('//') ? `https:${href}` : href
  try {
    const url = new URL(resolved)
    return url.protocol === 'http:' || url.protocol === 'https:' ? resolved : null
  } catch {
    return null
  }
}
/**
 * Classify a raw markdown-link href (需求8). Returns a local-path candidate
 * (relative or absolute, optional `:line` / `:line:col` / `#Lline` suffix) when
 * the href is not an external URL, otherwise `null` so the caller falls back to
 * `openExternal`. Exported for unit testing without a DOM.
 */
export function classifyAnchorHref(raw: string): { path: string; line?: number } | null {
  let href = raw.trim()
  if (!href || URI_SCHEME.test(href) || EXTERNAL_HREF.test(href)) return null
  href = normalizeLocalPath(href) || ''
  if (!href) return null
  const m = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+))?$/.exec(href)
  if (!m) return null
  const path = m[1]
  if (!path || NUMERIC_ONLY.test(path)) return null
  if (!HAS_SEP.test(path) && !HAS_EXT.test(path)) return null
  const lineStr = m[2] || m[3]
  const line = parseLine(lineStr)
  if (lineStr && line == null) return null
  return { path, line }
}

/** Wrap detected local paths inside a text node with clickable spans. */
function linkifyTextNode(node: Text): void {
  const text = node.nodeValue || ''
  const matches = matchLocalPaths(text)
  if (!matches.length) return
  const frag = document.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    if (match.index > cursor) frag.append(text.slice(cursor, match.index))
    const span = document.createElement('span')
    span.className = 'md-path-candidate'
    span.dataset.path = match.path
    if (match.line != null) span.dataset.line = String(match.line)
    span.textContent = text.slice(match.index, match.index + match.length)
    frag.append(span)
    cursor = match.index + match.length
  }
  if (cursor < text.length) frag.append(text.slice(cursor))
  node.parentNode?.replaceChild(frag, node)
}

// Never linkify inside links or fenced code blocks. Inline code may be a file path.
const SKIP_TAGS = new Set(['A', 'PRE'])

// A markdown `![](src)` whose src is a local path (relative / absolute / ~) can't
// load in the sandboxed renderer. Swap those to data URLs read over IPC (same
// image path fsReadFile already serves for the file browser). Remote/data URLs
// are left untouched.
const REMOTE_IMG_SRC = /^(?:https?:|data:|blob:)/i
/**
 * Classify a raw `<img src>` for `fsReadFile` (需求8-图片). Returns `null` for
 * remote/data/blob srcs (left untouched) and for empty input. For a local ref
 * it returns the `{ path, rootOverride }` fsReadFile expects: `~/` expands via
 * `homeDir`; an absolute path is split into its directory (`rootOverride`) and
 * filename (`path`) because fileBrowser rejects absolute paths directly; a
 * relative path is passed through unchanged. Exported for unit tests (no DOM).
 */
export function classifyImageSrc(
  raw: string,
  homeDir: string
): { path: string; rootOverride?: string } | null {
  if (!raw || REMOTE_IMG_SRC.test(raw)) return null
  const expanded = raw.startsWith('~/') ? `${homeDir}/${raw.slice(2)}` : raw
  const absolute = expanded.startsWith('/')
  const sep = expanded.lastIndexOf('/')
  return {
    path: absolute ? expanded.slice(sep + 1) : expanded,
    rootOverride: absolute ? expanded.slice(0, sep) || '/' : undefined
  }
}
function documentPath(raw: string, filePath?: string): string {
  if (!raw || !filePath || raw.startsWith('/') || raw.startsWith('~') || URI_SCHEME.test(raw)) return raw
  try {
    const base = new URL('file:///')
    base.pathname = filePath
    return decodeURIComponent(new URL(raw, base).pathname)
  } catch {
    return raw
  }
}

function resolveLocalImages(root: HTMLElement, sessionId: string | undefined, filePath?: string): void {
  root.querySelectorAll('img').forEach((img) => {
    if (img.dataset.localResolved) return
    const raw = img.getAttribute('src') || ''
    const resolved = classifyImageSrc(REMOTE_IMG_SRC.test(raw) ? raw : documentPath(raw, filePath), window.uniagent.homeDir)
    if (!resolved) return
    img.dataset.localResolved = '1'
    void window.uniagent.fsReadFile(sessionId || '', resolved.path, undefined, resolved.rootOverride)
      .then((result) => {
        if (result.ok && result.kind === 'image' && result.dataUrl) img.src = result.dataUrl
      })
      .catch(() => undefined)
  })
}

function linkifyContainer(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement
      while (el && el !== root) {
        if (SKIP_TAGS.has(el.tagName) || el.classList.contains('md-path-candidate') || el.classList.contains('html-preview')) {
          return NodeFilter.FILTER_REJECT
        }
        el = el.parentElement
      }
      return node.nodeValue && node.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP
    }
  })
  const targets: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text)
  targets.forEach(linkifyTextNode)
}

type ListDirectory = (
  sessionId: string,
  path: string,
  root?: string
) => Promise<FileBrowserListResult>

/** A candidate is actionable only when the guarded file browser can list it as a file. */
export async function canOpenLocalPath(
  sessionId: string,
  rawPath: string,
  homeDir: string,
  listDirectory: ListDirectory = window.uniagent.fsListDir
): Promise<boolean> {
  let path = rawPath.trim()
  if (!path || path.includes('\0') || /^file:/i.test(path)) return false
  if (path.startsWith('~/') && homeDir) path = `${homeDir.replace(/\/+$/, '')}/${path.slice(2)}`
  else if (path === '~' && homeDir) path = homeDir

  const absolute = path.startsWith('/')
  const parts = path.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return false
  const name = parts.pop()!
  const parent = parts.join('/')
  const root = absolute ? `/${parent}`.replace(/\/$/, '') || '/' : undefined

  try {
    const result = await listDirectory(sessionId, absolute ? '' : parent, root)
    return result.ok && result.entries.some((entry) =>
      entry.kind === 'file' && entry.size !== undefined && entry.name === name
    )
  } catch {
    return false
  }
}

function verifyLocalPaths(
  root: HTMLElement,
  sessionId: string,
  homeDir: string,
  verifyFiles: boolean,
  filePath?: string
): () => void {
  let current = true
  const listings = new Map<string, Promise<FileBrowserListResult>>()
  const listDirectory: ListDirectory = (id, path, requestedRoot) => {
    const key = `${requestedRoot || ''}\0${path}`
    const pending = listings.get(key) || window.uniagent.fsListDir(id, path, requestedRoot)
    listings.set(key, pending)
    return pending
  }

  const candidates = Array.from(root.querySelectorAll<HTMLElement>('.md-path-candidate'))
  root.querySelectorAll<HTMLAnchorElement>('a[href], a[data-local-href]').forEach((anchor) => {
    const rawHref = anchor.getAttribute('href') || anchor.dataset.localHref || ''
    if (/^uniagent-session:s_[A-Za-z0-9_-]+$/.test(rawHref)) return
    const local = classifyAnchorHref(rawHref)
    if (!local && classifyExternalHref(rawHref)) return
    anchor.classList.add('md-local-path')
    anchor.dataset.localHref = rawHref
    anchor.removeAttribute('href')
    if (!local || !verifyFiles) return
    anchor.dataset.path = local.path
    if (local.line != null) anchor.dataset.line = String(local.line)
    candidates.push(anchor)
  })

  candidates.forEach((candidate) => {
    candidate.classList.remove('md-path')
    const rawPath = candidate.dataset.path
    if (!rawPath) return
    const path = documentPath(rawPath, filePath)
    candidate.dataset.path = path
    void canOpenLocalPath(sessionId, path, homeDir, listDirectory).then((openable) => {
      if (!current || !openable) return
      candidate.classList.add('md-path')
      if (candidate instanceof HTMLAnchorElement && candidate.dataset.localHref) {
        candidate.setAttribute('href', candidate.dataset.localHref)
      }
    })
  })
  return () => { current = false }
}

/**
 * Render Markdown text into sanitized HTML for agent replies. When `onOpenFile`
 * is provided, verified local files in prose become clickable and open in the
 * built-in file browser instead of the external shell (需求8). When
 * `annotations` is provided, matching char ranges are re-highlighted with a
 * numbered badge after each reply re-render (选中即评论).
 */
export function Markdown({
  text,
  onOpenFile,
  annotations,
  onEditAnnotation,
  filePath,
}: {
  text: string
  onOpenFile?: (path: string, line?: number) => void
  annotations?: Annotation[]
  onEditAnnotation?: (id: string) => void
  filePath?: string
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const sessionId = useContext(HtmlPreviewSessionContext)
  const supportsFileLinks = !!onOpenFile
  const editableAnnotations = !!onEditAnnotation
  const parts = useMemo(() => parsePreviewMarkdown(text || '').map((part) => (
    'html' in part ? { html: DOMPurify.sanitize(part.html, { ADD_ATTR: ['target', 'rel'], ALLOWED_URI_REGEXP: MARKDOWN_URI_ALLOWLIST }) } : part
  )), [text])

  useBrowserLayoutEffect(() => {
    if (!bodyRef.current) return
    if (supportsFileLinks) linkifyContainer(bodyRef.current)
    return verifyLocalPaths(bodyRef.current, sessionId || '', window.uniagent.homeDir || '', supportsFileLinks, filePath)
  }, [parts, supportsFileLinks, sessionId, filePath])

  // Local `![](path)` images can't load from the sandbox — resolve to data URLs.
  useEffect(() => {
    if (bodyRef.current) resolveLocalImages(bodyRef.current, sessionId, filePath)
  }, [parts, sessionId, filePath])

  // 选中即评论 — (re)apply persistent highlights after each render / annotation
  // change. Same DOM-mutation pattern as linkifyContainer; applyAnnotations
  // strips its own marks first, so it stays idempotent and leaves `.md-path`
  // spans intact. No-op (and cleans up) when there are no annotations.
  useEffect(() => {
    if (bodyRef.current) applyAnnotations(bodyRef.current, annotations || [], editableAnnotations)
  }, [parts, annotations, editableAnnotations])

  const openLink = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const annotation = onEditAnnotation ? target.closest<HTMLElement>('[data-anno-id]') : null
    if (annotation?.dataset.annoId && window.getSelection()?.isCollapsed !== false) {
      event.preventDefault()
      event.stopPropagation()
      onEditAnnotation?.(annotation.dataset.annoId)
      return
    }
    const pathSpan = onOpenFile ? target.closest('.md-path') : null
    if (pathSpan instanceof HTMLElement && pathSpan.dataset.path) {
      event.preventDefault()
      event.stopPropagation()
      const line = pathSpan.dataset.line ? Number(pathSpan.dataset.line) : undefined
      onOpenFile?.(pathSpan.dataset.path, line)
      return
    }
    const anchor = target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement)) return
    event.preventDefault()
    event.stopPropagation()
    // A markdown link may point at a local file (需求8) — the browser resolves
    // `anchor.href` to an absolute URL, so classify the *raw* attribute instead.
    const rawHref = anchor.getAttribute('href') || ''
    if (/^uniagent-session:s_[A-Za-z0-9_-]+$/.test(rawHref)) { window.dispatchEvent(new CustomEvent('uniagent-open-assistant-session', { detail: rawHref.slice('uniagent-session:'.length) })); return }
    if (isDangerousHref(rawHref.trim())) return
    const local = onOpenFile ? classifyAnchorHref(rawHref) : null
    if (local) {
      if (anchor.classList.contains('md-path')) onOpenFile?.(local.path, local.line)
      return
    }
    const external = classifyExternalHref(rawHref)
    if (external) void window.uniagent.openExternal(external).catch(() => undefined)
  }

  const editWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!onEditAnnotation || !(target instanceof HTMLElement) || !target.matches('[data-anno-id][role="button"]')) return
    if ((event.key === 'Enter' || event.key === ' ') && target.dataset.annoId) {
      event.preventDefault()
      event.stopPropagation()
      onEditAnnotation(target.dataset.annoId)
    }
  }

  if (parts.length === 1 && 'html' in parts[0]) return (
    <div
      ref={bodyRef}
      className="agent-md"
      onClick={openLink}
      onKeyDown={editWithKeyboard}
      dangerouslySetInnerHTML={{ __html: parts[0].html }}
    />
  )

  return (
    <div ref={bodyRef} className="agent-md" onClick={openLink} onKeyDown={editWithKeyboard}>
      {parts.map((part, index) => 'html' in part
        ? <div key={index} className="md-fragment" dangerouslySetInnerHTML={{ __html: part.html }} />
        : 'preview' in part
          ? <HtmlPreview key={index} reference={part.preview} onOpenFile={onOpenFile} />
          : <MermaidDiagram key={index} source={part.mermaid} />)}
    </div>
  )
}
