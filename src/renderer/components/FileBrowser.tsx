import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {
  FileBrowserEntry,
  FileBrowserListResult,
  FilePreviewOptions,
  FilePreviewResult
} from '@shared/types'
import { Chevron, FolderIcon, RefreshIcon, UiIcon } from './Icons'
import { Markdown } from './Markdown'
import { highlightedLine } from './CodeHighlight'
import { ImmersiveReader } from './ImmersiveReader'
import type { Annotation } from '../textAnnotations'

interface DirectoryState {
  entries: FileBrowserEntry[]
  loading?: boolean
  error?: string
}

type NodeAction = 'absolute' | 'relative' | 'name' | 'reveal'

const TREE_MIN = 220
const TREE_MAX = 520
const TREE_DEFAULT = 300
const FORCE_LINE_LIMIT = 1_000
const MAX_FOCUS_LINE = 1_000_000
const NODE_ACTIONS: Array<{ id: NodeAction; label: string }> = [
  { id: 'absolute', label: '复制绝对路径' },
  { id: 'relative', label: '复制相对路径' },
  { id: 'name', label: '复制文件名' },
  { id: 'reveal', label: '在访达中显示' }
]

export function focusedLinePreviewError(
  line: number,
  text: string | undefined,
  previewLineLimit = FORCE_LINE_LIMIT
): string | undefined {
  if (text === undefined) {
    return line > previewLineLimit
      ? `无法定位第 ${line} 行：大文件预览仅支持前 ${previewLineLimit} 行`
      : undefined
  }
  const lineCount = text.split('\n').length
  return line > lineCount ? `无法定位第 ${line} 行：当前预览只有 ${lineCount} 行` : undefined
}

function initialTreeWidth(): number {
  try {
    const saved = Number(localStorage.getItem('ua.fileTreeWidth'))
    return saved >= TREE_MIN && saved <= TREE_MAX ? saved : TREE_DEFAULT
  } catch {
    return TREE_DEFAULT
  }
}

function safeError(error: unknown, fallback: string): string {
  return typeof error === 'string' && error.trim() ? error : fallback
}

function absolutePath(root: string, relativePath: string): string {
  if (!root) return relativePath
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${relativePath.split('/').join(separator)}`
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path || '工作目录'
}

function formatBytes(bytes?: number): string {
  if (!Number.isFinite(bytes)) return ''
  if ((bytes || 0) < 1024) return `${bytes} B`
  if ((bytes || 0) < 1024 * 1024) return `${((bytes || 0) / 1024).toFixed(1)} KB`
  return `${((bytes || 0) / 1024 / 1024).toFixed(1)} MB`
}

function extension(entry: FileBrowserEntry): string {
  return (entry.ext || entry.name.split('.').pop() || '').toLowerCase()
}

function isMarkdown(entry: FileBrowserEntry | null): boolean {
  return !!entry && ['md', 'mdx', 'markdown'].includes(extension(entry))
}

function isHtml(entry: FileBrowserEntry | null): boolean {
  return !!entry && ['html', 'htm'].includes(extension(entry))
}

function fileIcon(entry: FileBrowserEntry): JSX.Element {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(extension(entry))) return <UiIcon name="image" size={14} />
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'swift'].includes(extension(entry))) return <UiIcon name="code" size={14} />
  return <UiIcon name="file" size={14} />
}

/**
 * Turn a clicked prose path (需求8) into a workdir-relative path the confined
 * fs IPC accepts. Absolute paths must live inside `root`; `~/` expands against
 * the home dir. Returns null for anything outside the workdir or containing
 * `..` — the caller shows a toast instead of opening.
 */
export function toWorkdirRelative(
  root: string,
  home: string,
  raw: string
): string | null {
  if (!raw) return null
  let p = raw.trim()
  if (/^file:/i.test(p) || p.includes('\0')) return null
  if (p.startsWith('~/') && home) p = `${home.replace(/\/+$/, '')}/${p.slice(2)}`
  else if (p === '~' && home) p = home
  const isAbs = p.startsWith('/')
  if (isAbs) {
    if (!root) return null
    const base = root.replace(/\/+$/, '')
    if (p === base) return ''
    if (!p.startsWith(`${base}/`)) return null
    p = p.slice(base.length + 1)
  }
  // Normalize ./ and reject any .. escape (relative or resolved-absolute).
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  return parts.join('/')
}

export function resolveFileBrowserFocus(
  root: string,
  home: string,
  raw: string
): { root: string; path: string } | null {
  const relativePath = toWorkdirRelative(root, home, raw)
  if (relativePath !== null) return { root, path: relativePath }

  let path = raw.trim()
  if (/^file:/i.test(path) || path.includes('\0')) return null
  if (path.startsWith('~/') && home) path = home.replace(/\/+$/, '') + '/' + path.slice(2)
  else if (path === '~' && home) path = home
  if (!path.startsWith('/')) return null

  const parts = path.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return null
  return {
    root: parts.length === 1 ? '/' : '/' + parts.slice(0, -1).join('/'),
    path: parts[parts.length - 1]
  }
}

export function FileBrowser({
  sessionId,
  workdir,
  rootPath,
  focusPath,
  focusLine,
  onClose,
  annotations = [],
  onAddComment,
  onUpdateComment,
  onRemoveComment,
  editRequest,
  onEditRequestHandled,
  onOpenFile,
  coverSidebar = false,
  onToggleCover
}: {
  sessionId: string
  workdir: string
  /**
   * Absolute directory to browse when there is no session workdir (工具能力 →
   * 在文件浏览器中打开）。When set, it is handed straight back to the fs IPC as the
   * confined root; the path guard keeps all navigation inside it.
   */
  rootPath?: string
  focusPath?: string
  focusLine?: number
  onClose: () => void
  annotations?: Annotation[]
  onAddComment?: (annotation: Omit<Annotation, 'id'>) => void
  onUpdateComment?: (id: string, comment: string) => void
  onRemoveComment?: (id: string) => void
  editRequest?: { annotation: Annotation; nonce: number }
  onEditRequestHandled?: (nonce: number) => void
  onOpenFile?: (path: string, line?: number) => void
  /** 需求补9 — 铺满全窗（覆盖左侧侧栏）当前是否开启。 */
  coverSidebar?: boolean
  /** 需求补9 — 切换铺满全窗 / 保留侧栏。 */
  onToggleCover?: () => void
}): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const readerButtonRef = useRef<HTMLButtonElement>(null)
  const [readerOpen, setReaderOpen] = useState(false)
  const dragging = useRef(false)
  const treeGeneration = useRef(0)
  const previewRequest = useRef(0)
  const [treeWidth, setTreeWidth] = useState(initialTreeWidth)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [root, setRoot] = useState('')
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [activeFile, setActiveFile] = useState<FileBrowserEntry | null>(null)
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [markdownView, setMarkdownView] = useState<'source' | 'render'>('render')
  const [htmlView, setHtmlView] = useState<'source' | 'render'>('render')
  const [imageMode, setImageMode] = useState<'fit' | 'actual'>('fit')
  const [imageZoom, setImageZoom] = useState(1)
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 })
  const [toast, setToast] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileBrowserEntry } | null>(null)
  const [closing, setClosing] = useState(false)
  const onCloseRef = useRef(onClose)
  // 需求8 — a line to scroll to once the focused file's preview lands.
  const pendingLine = useRef<number | undefined>(undefined)
  const [highlightLine, setHighlightLine] = useState<number | undefined>(undefined)
  const [focusIssue, setFocusIssue] = useState('')
  const readerVisible = readerOpen && isMarkdown(activeFile)
  const focus = useMemo(
    () => focusPath ? resolveFileBrowserFocus(rootPath || workdir, window.uniagent.homeDir || '', focusPath) : null,
    [focusPath, workdir, rootPath]
  )
  // An explicit absolute rootPath (工具能力 → Skill 文件夹) is browsed directly as
  // the confined root; otherwise a focused external file supplies its own parent.
  const rootOverride = rootPath || (focus && focus.root !== workdir ? focus.root : undefined)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => onCloseRef.current(), 160)
    return () => window.clearTimeout(timer)
  }, [closing])

  const requestClose = useCallback((): void => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) onClose()
    else setClosing(true)
  }, [onClose])

  useEffect(() => {
    try {
      localStorage.setItem('ua.fileTreeWidth', String(treeWidth))
    } catch {
      // A disabled storage backend should not make the browser unusable.
    }
  }, [treeWidth])

  useEffect(() => {
    const generation = ++treeGeneration.current
    ++previewRequest.current
    setRoot('')
    setDirectories({})
    setExpanded(new Set())
    setActiveFile(null)
    setPreview(null)
    setReaderOpen(false)
    void loadDirectory('', generation)
    return () => {
      if (treeGeneration.current === generation) ++treeGeneration.current
      ++previewRequest.current
    }
    // The refresh counter deliberately resets the lazy cache and selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refreshTick, rootOverride])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || readerVisible || event.defaultPrevented) return
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [requestClose, readerVisible])

  useEffect(() => {
    if (overlayRef.current) overlayRef.current.inert = readerVisible
  }, [readerVisible])

  useEffect(() => {
    if (editRequest?.annotation.filePath && activeFile && isMarkdown(activeFile)
      && absolutePath(root, activeFile.path) === editRequest.annotation.filePath) {
      setReaderOpen(true)
    }
  }, [editRequest, activeFile, root])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragging.current) return
      const left = overlayRef.current?.getBoundingClientRect().left || 0
      setTreeWidth(Math.min(TREE_MAX, Math.max(TREE_MIN, event.clientX - left)))
    }
    const onUp = (): void => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 1600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  // 需求8 — resolve the focus against the current browser root, lazily expand
  // its ancestors, select the file, and remember the line to scroll to once the
  // preview lands. Runs once the root is known.
  useEffect(() => {
    if (!focusPath || !root) return
    const rel = focus?.path
    if (rel == null || rel === '') {
      if (rel == null) setToast('无法打开该文件路径')
      return
    }
    const segments = rel.split('/')
    const name = segments[segments.length - 1]
    const ancestors: string[] = []
    for (let i = 0; i < segments.length - 1; i++) {
      ancestors.push(segments.slice(0, i + 1).join('/'))
    }
    setExpanded((current) => {
      const next = new Set(current)
      ancestors.forEach((path) => next.add(path))
      return next
    })
    ancestors.forEach((path) => {
      if (!directories[path]) void loadDirectory(path)
    })
    pendingLine.current = Number.isSafeInteger(focusLine) && focusLine! > 0 && focusLine! <= MAX_FOCUS_LINE
      ? focusLine
      : undefined
    setHighlightLine(undefined)
    setFocusIssue('')
    selectFile({ name, path: rel, kind: 'file', isSymlink: false }, true)
    // Ancestors/selection are derived from the incoming focus only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, focusLine, focusPath, root])

  // Scroll to (and briefly highlight) the focused line after its preview loads.
  useEffect(() => {
    if (pendingLine.current == null || !preview?.ok || preview.kind !== 'text') return
    const line = pendingLine.current
    const issue = focusedLinePreviewError(line, preview.text)
    if (issue) {
      pendingLine.current = undefined
      setHighlightLine(undefined)
      setFocusIssue(issue)
      return
    }
    if (preview.text === undefined) return
    pendingLine.current = undefined
    setFocusIssue('')
    setHighlightLine(line)
    const timer = window.setTimeout(() => setHighlightLine(undefined), 1800)
    requestAnimationFrame(() => {
      const row = overlayRef.current?.querySelector(`.fb-code-line[data-line="${line}"]`)
      row?.scrollIntoView({ block: 'center' })
    })
    return () => window.clearTimeout(timer)
  }, [preview])

  async function loadDirectory(path: string, generation = treeGeneration.current): Promise<void> {
    setDirectories((current) => ({
      ...current,
      [path]: { entries: current[path]?.entries || [], loading: true }
    }))
    try {
      const result: FileBrowserListResult = await window.uniagent.fsListDir(sessionId, path, rootOverride)
      if (generation !== treeGeneration.current) return
      if (result.root) setRoot(result.root)
      setDirectories((current) => ({
        ...current,
        [path]: result.ok
          ? { entries: Array.isArray(result.entries) ? result.entries : [] }
          : { entries: [], error: safeError(result.error, '无法读取目录') }
      }))
    } catch {
      if (generation !== treeGeneration.current) return
      setDirectories((current) => ({
        ...current,
        [path]: { entries: [], error: '无法读取目录' }
      }))
    }
  }

  function toggleDirectory(entry: FileBrowserEntry): void {
    const opening = !expanded.has(entry.path)
    setExpanded((current) => {
      const next = new Set(current)
      opening ? next.add(entry.path) : next.delete(entry.path)
      return next
    })
    const state = directories[entry.path]
    if (opening && !state?.loading && (!state || state.error)) void loadDirectory(entry.path)
  }

  async function fetchPreview(
    entry: FileBrowserEntry,
    options?: FilePreviewOptions
  ): Promise<void> {
    const request = ++previewRequest.current
    setPreviewLoading(true)
    try {
      const result: FilePreviewResult = await window.uniagent.fsReadFile(sessionId, entry.path, options, rootOverride)
      if (request === previewRequest.current) setPreview(result)
    } catch {
      if (request === previewRequest.current) {
        setPreview({ ok: false, path: entry.path, kind: 'binary', size: entry.size || 0, error: '无法读取文件' })
      }
    } finally {
      if (request === previewRequest.current) setPreviewLoading(false)
    }
  }

  function selectFile(entry: FileBrowserEntry, preserveFocus = false): void {
    if (!isMarkdown(entry)) setReaderOpen(false)
    if (!preserveFocus) {
      pendingLine.current = undefined
      setHighlightLine(undefined)
      setFocusIssue('')
    }
    setActiveFile(entry)
    setPreview(null)
    setMarkdownView(preserveFocus && pendingLine.current ? 'source' : 'render')
    setHtmlView(preserveFocus && pendingLine.current ? 'source' : 'render')
    setImageMode('fit')
    setImageZoom(1)
    setImageSize({ width: 0, height: 0 })
    void fetchPreview(entry)
  }

  async function copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setToast(`已复制${label}`)
    } catch {
      setToast('复制失败')
    }
  }

  async function runNodeAction(action: NodeAction, entry: FileBrowserEntry): Promise<void> {
    setContextMenu(null)
    if (action === 'absolute') return copy(absolutePath(root, entry.path), '绝对路径')
    if (action === 'relative') return copy(entry.path, '相对路径')
    if (action === 'name') return copy(entry.name, '文件名')
    try {
      await window.uniagent.fsReveal(sessionId, entry.path, rootOverride)
    } catch {
      setToast('无法在访达中显示')
    }
  }

  async function openHtml(entry: FileBrowserEntry): Promise<void> {
    try {
      await window.uniagent.fsOpenHtml(sessionId, entry.path, rootOverride)
    } catch {
      setToast('无法在浏览器中打开')
    }
  }

  function showContextMenu(event: React.MouseEvent, entry: FileBrowserEntry): void {
    event.preventDefault()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 150),
      entry
    })
  }

  function zoomImage(delta: number): void {
    setImageMode('actual')
    setImageZoom((current) => Math.min(4, Math.max(0.1, Math.round((current + delta) * 10) / 10)))
  }

  const textLines = useMemo(
    () => preview?.kind === 'text' && preview.text !== undefined ? preview.text.split('\n') : [],
    [preview]
  )
  const markdown = isMarkdown(activeFile)
  const html = isHtml(activeFile)
  const rootState = directories['']

  function closeReader(): void {
    setReaderOpen(false)
    requestAnimationFrame(() => readerButtonRef.current?.focus())
  }

  function openReaderFile(path: string, line?: number): void {
    const relative = toWorkdirRelative(root, window.uniagent.homeDir || '', path)
    if (relative === null || !relative) {
      if (onOpenFile) {
        setReaderOpen(false)
        onOpenFile(path, line)
      } else setToast('无法打开该文件路径')
      return
    }
    const name = basename(relative)
    const parts = relative.split('/')
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    setExpanded((current) => new Set([...current, ...ancestors]))
    ancestors.forEach((ancestor) => { if (!directories[ancestor]) void loadDirectory(ancestor) })
    pendingLine.current = Number.isSafeInteger(line) && line! > 0 && line! <= MAX_FOCUS_LINE ? line : undefined
    selectFile({ name, path: relative, kind: 'file', isSymlink: false }, true)
  }

  function renderTreeContents(): ReactNode {
    if (rootState?.loading) return <div className="fb-tree-empty">正在读取目录…</div>
    if (rootState?.error) return <div className="fb-tree-empty is-error">
      <span>{rootState.error}</span>
      <button onClick={() => setRefreshTick((value) => value + 1)}>重试</button>
    </div>
    if (rootState && rootState.entries.length === 0) return <div className="fb-tree-empty">目录为空</div>
    return renderEntries('', 0)
  }

  function renderEntries(path: string, depth: number): ReactNode {
    return (directories[path]?.entries || []).map((entry) => {
      const open = entry.kind === 'dir' && expanded.has(entry.path)
      const child = directories[entry.path]
      return (
        <div className="fb-tree-branch" key={entry.path}>
          <div
            className={`fb-tree-row ${activeFile?.path === entry.path ? 'is-active' : ''}`}
            onContextMenu={(event) => showContextMenu(event, entry)}
            role="treeitem"
            aria-expanded={entry.kind === 'dir' ? open : undefined}
          >
            <button
              className="fb-tree-node"
              style={{ paddingLeft: 8 + depth * 16 }}
              title={entry.path}
              onClick={() => entry.kind === 'dir' ? toggleDirectory(entry) : selectFile(entry)}
            >
              <span className="fb-tree-chevron">
                {entry.kind === 'dir' ? <Chevron open={open} size={12} /> : null}
              </span>
              <span className={`fb-file-glyph is-${entry.kind}`}>
                {entry.kind === 'dir' ? <FolderIcon size={15} /> : fileIcon(entry)}
              </span>
              <span className="fb-file-name">{entry.name}</span>
              {entry.isSymlink && <span className="fb-file-badge">链接</span>}
              {entry.kind === 'file' && <span className="fb-file-size">{formatBytes(entry.size)}</span>}
            </button>
          </div>
          {open && (
            <div className="fb-tree-children" role="group">
              {child?.loading ? (
                <div className="fb-tree-status" style={{ paddingLeft: 28 + depth * 16 }}>加载中…</div>
              ) : child?.error ? (
                <button
                  className="fb-tree-status is-error"
                  style={{ paddingLeft: 28 + depth * 16 }}
                  onClick={() => void loadDirectory(entry.path)}
                >
                  {child.error} · 重试
                </button>
              ) : child && child.entries.length === 0 ? (
                <div className="fb-tree-status" style={{ paddingLeft: 28 + depth * 16 }}>空目录</div>
              ) : (
                renderEntries(entry.path, depth + 1)
              )}
            </div>
          )}
        </div>
      )
    })
  }

  function renderPreview(): ReactNode {
    if (!activeFile) return <div className="fb-empty"><span>📄</span>从左侧选择文件预览</div>
    if (previewLoading) return <div className="fb-empty">正在读取 {activeFile.name}…</div>
    if (!preview) return null
    if (!preview.ok) return <div className="fb-empty is-error">{safeError(preview.error, '无法读取文件')}</div>

    if (preview.kind === 'image') {
      if (preview.tooLarge || !preview.dataUrl) {
        return (
          <div className="fb-empty">
            <span>▧</span>
            <strong>图片过大，未加载</strong>
            <small>{formatBytes(preview.size)}</small>
            <button onClick={() => void runNodeAction('reveal', activeFile)}>在访达中显示</button>
          </div>
        )
      }
      const actualStyle = imageSize.width
        ? { width: imageSize.width * imageZoom, height: imageSize.height * imageZoom, maxWidth: 'none', maxHeight: 'none' }
        : undefined
      return (
        <div className={`fb-image-stage ${imageMode === 'fit' ? 'is-fit' : 'is-actual'}`}>
          <img
            src={preview.dataUrl}
            alt={activeFile.name}
            style={imageMode === 'actual' ? actualStyle : undefined}
            onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          />
        </div>
      )
    }

    if (preview.kind === 'binary') {
      return (
        <div className="fb-empty">
          <span>◈</span>
          <strong>二进制文件不支持预览</strong>
          <small>{formatBytes(preview.size)}</small>
          <button onClick={() => void runNodeAction('reveal', activeFile)}>在访达中显示</button>
        </div>
      )
    }

    if (preview.tooLarge && preview.text === undefined) {
      return (
        <div className="fb-empty">
          <span>⚠</span>
          <strong>文件过大，未自动打开</strong>
          <small>{formatBytes(preview.size)} · {focusIssue || `最多读取前 ${FORCE_LINE_LIMIT} 行`}</small>
          <button onClick={() => void fetchPreview(activeFile, { force: true, maxLines: FORCE_LINE_LIMIT })}>
            仍要打开
          </button>
        </div>
      )
    }

    if (markdown && markdownView === 'render') {
      return (
        <div className="fb-markdown">
          {preview.truncated && <div className="fb-preview-warning">文件过大，仅显示前 {preview.lineLimit || FORCE_LINE_LIMIT} 行</div>}
          <Markdown text={preview.text || ''} />
        </div>
      )
    }

    if (html && htmlView === 'render') {
      return <iframe className="fb-html-preview" src={preview.htmlUrl} title={`${activeFile.name} 预览`} />
    }

    return (
      <div className={`fb-code-scroll ${wrap ? 'is-wrap' : ''}`}>
        {focusIssue && <div className="fb-preview-warning">{focusIssue}</div>}
        {preview.truncated && <div className="fb-preview-warning">文件过大，仅显示前 {preview.lineLimit || FORCE_LINE_LIMIT} 行</div>}
        <div className={`fb-code language-${(preview.language || 'plaintext').replace(/[^a-z0-9_-]/gi, '')}`}>
          {textLines.map((line, index) => (
            <div
              className={`fb-code-line ${highlightLine === index + 1 ? 'is-focus-line' : ''}`}
              data-line={index + 1}
              key={index}
            >
              <span className="fb-line-number">{index + 1}</span>
              <code style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>
                {highlightedLine(line, preview.language)}
              </code>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const browserNotices = <>
    {contextMenu && (
      <div className="fb-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}
        onPointerDown={(event) => event.stopPropagation()}>
        {NODE_ACTIONS.map((item) => (
          <button key={item.id} role="menuitem" onClick={() => void runNodeAction(item.id, contextMenu.entry)}>
            <span><UiIcon name={item.id === 'reveal' ? 'external-link' : 'copy'} size={13} /></span>{item.label}
          </button>
        ))}
      </div>
    )}
    {toast && <div className="fb-toast" role="status">{toast}</div>}
  </>

  return (
    <div
      className={`filebrowser-overlay ${coverSidebar ? 'is-cover' : ''} ${closing ? 'is-closing' : ''}`}
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="文件浏览器"
    >
      <header className="scene-head">
        <div className="titles">
          <h1>文件浏览器</h1>
          <p title={root}>{root || '工作目录'}</p>
        </div>
        <div className="head-actions">
          {onToggleCover && (
            <button
              className="scene-icon-btn overlay-toggle"
              data-overlay
              title={coverSidebar ? '恢复左侧侧栏' : '铺满全窗（覆盖左侧侧栏）'}
              aria-label={coverSidebar ? '恢复左侧侧栏' : '铺满全窗'}
              onClick={onToggleCover}
            >
              <UiIcon name={coverSidebar ? 'collapse' : 'expand'} size={16} />
            </button>
          )}
          <button
            className="scene-back-btn"
            title="关闭文件浏览器 (Esc)"
            aria-label="关闭文件浏览器"
            onClick={requestClose}
          >
            <UiIcon name="back" size={15} /> 返回会话
          </button>
        </div>
      </header>
      <div
        className={`filebrowser ${treeCollapsed ? 'is-tree-collapsed' : ''}`}
        style={{ gridTemplateColumns: treeCollapsed ? '0 minmax(0, 1fr)' : `${treeWidth}px minmax(0, 1fr)` }}
      >
        {!treeCollapsed && (
          <aside className="fb-tree">
            <div className="fb-tree-head">
              <span className="fb-tree-title" title={root}>{root ? basename(root) : '文件'}</span>
              <span className="fb-tree-count">{rootState?.entries.length || 0}</span>
              <button title="刷新目录" aria-label="刷新目录" onClick={() => setRefreshTick((value) => value + 1)}><RefreshIcon size={14} /></button>
              <button title="折叠目录树" aria-label="折叠目录树" onClick={() => setTreeCollapsed(true)}><UiIcon name="back" size={15} /></button>
            </div>
            <div className="fb-tree-list" role="tree">
              {renderTreeContents()}
            </div>
            <div
              className="fb-tree-grip"
              title="拖动调整目录宽度"
              onMouseDown={(event) => { event.preventDefault(); dragging.current = true }}
            />
          </aside>
        )}

        <main className="fb-preview">
          <div className="fb-toolbar">
            {treeCollapsed && (
              <button className="fb-toolbar-btn" title="展开目录树" aria-label="展开目录树" onClick={() => setTreeCollapsed(false)}><Chevron size={15} /></button>
            )}
            <span
              className="fb-preview-path"
              title={activeFile ? absolutePath(root, activeFile.path) : root}
            >
              {activeFile?.path || root || '文件浏览器'}
            </span>
            {preview?.ok && preview.kind === 'text' && (
              <span className="fb-language">{preview.language || 'plaintext'}</span>
            )}
            <span className="fb-toolbar-spacer" />

            {markdown && !previewLoading && preview?.ok && preview.kind === 'text' && preview.text !== undefined && (
              <button ref={readerButtonRef} className="fb-toolbar-btn fb-reader-btn" onClick={() => setReaderOpen(true)}
                title="全屏阅读 Markdown" aria-label="阅读模式"><UiIcon name="book-open" size={14} />阅读模式</button>
            )}

            {preview?.ok && preview.kind === 'image' && preview.dataUrl && !preview.tooLarge && (
              <div className="fb-toolbar-group" aria-label="图片缩放">
                <button className={imageMode === 'fit' ? 'is-on' : ''} onClick={() => setImageMode('fit')}>适应</button>
                <button className={imageMode === 'actual' && imageZoom === 1 ? 'is-on' : ''} onClick={() => { setImageMode('actual'); setImageZoom(1) }}>1:1</button>
                <button title="缩小" aria-label="缩小" onClick={() => zoomImage(-0.1)}><UiIcon name="minus" size={13} /></button>
                <span>{imageMode === 'fit' ? '适应' : `${Math.round(imageZoom * 100)}%`}</span>
                <button title="放大" aria-label="放大" onClick={() => zoomImage(0.1)}><UiIcon name="plus" size={13} /></button>
              </div>
            )}

            {preview?.ok && preview.kind === 'text' && preview.text !== undefined && (
              <>
                {markdown && (
                  <div className="fb-toolbar-group" aria-label="Markdown 查看方式">
                    <button className={markdownView === 'source' ? 'is-on' : ''} onClick={() => setMarkdownView('source')}>源码</button>
                    <button className={markdownView === 'render' ? 'is-on' : ''} onClick={() => setMarkdownView('render')}>渲染</button>
                  </div>
                )}
                {((markdown && markdownView === 'source') || (html && htmlView === 'source') || (!markdown && !html)) && (
                  <button className={`fb-toolbar-btn ${wrap ? 'is-on' : ''}`} onClick={() => setWrap((value) => !value)}>自动换行</button>
                )}
                {html && (
                  <button
                    className="fb-toolbar-btn fb-html-toggle"
                    aria-label={htmlView === 'source' ? '切换到预览' : '切换到源码'}
                    aria-pressed={htmlView === 'source'}
                    title={htmlView === 'source' ? '切换到预览' : '切换到源码'}
                    onClick={() => setHtmlView((value) => value === 'source' ? 'render' : 'source')}
                  >
                    {htmlView === 'source' ? '预览' : '源码'}
                  </button>
                )}
              </>
            )}

            {activeFile && isHtml(activeFile) && (
              <button
                className="fb-toolbar-btn fb-path-action"
                title="在浏览器中打开"
                aria-label="在浏览器中打开"
                onClick={() => void openHtml(activeFile)}
              >
                <svg className="fb-chrome-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#ea4335" d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 2.5L4.78 4.5A9.96 9.96 0 0 1 12 2Z" />
                  <path fill="#fbbc05" d="M4.78 4.5 9.1 12a3 3 0 0 0 2.9 3.75L9.11 20.8A10 10 0 0 1 4.78 4.5Z" />
                  <path fill="#34a853" d="M9.11 20.8 13.44 13.3A3 3 0 0 0 15 12h5.77A10 10 0 0 1 9.11 20.8Z" />
                  <circle cx="12" cy="12" r="3" fill="#4285f4" />
                  <circle cx="12" cy="12" r="3.7" fill="none" stroke="#fff" strokeWidth="1" opacity=".9" />
                </svg>
              </button>
            )}
          </div>
          <div className="fb-preview-body">{renderPreview()}</div>
        </main>
      </div>

      {readerOpen && markdown && activeFile && createPortal(
        <ImmersiveReader
          key={absolutePath(root, activeFile.path)}
          file={{
            sessionId,
            name: activeFile.name,
            path: absolutePath(root, activeFile.path),
            text: preview?.ok && preview.kind === 'text' ? preview.text || '' : '',
            loading: previewLoading,
            error: preview && !preview.ok ? safeError(preview.error, '无法读取文件')
              : preview?.tooLarge && preview.text === undefined ? '文件过大，未自动读取。请退出阅读后选择“仍要打开”。' : undefined,
            warning: preview?.truncated ? `文件过大，仅显示前 ${preview.lineLimit || FORCE_LINE_LIMIT} 行` : undefined,
            navigation: <>
              <div className="fb-tree-head"><span className="fb-tree-title" title={root}>{basename(root)}</span></div>
              <div className="fb-tree-list" role="tree">{renderTreeContents()}</div>
            </>,
          }}
          annotations={annotations}
          readOnly={!onAddComment || previewLoading || !preview?.ok || preview.kind !== 'text' || preview.text === undefined}
          onAddComment={(annotation) => onAddComment?.(annotation)}
          onUpdateComment={(id, comment) => onUpdateComment?.(id, comment)}
          onRemoveComment={(id) => onRemoveComment?.(id)}
          editRequest={editRequest}
          onEditRequestHandled={onEditRequestHandled}
          onOpenFile={openReaderFile}
          onClose={closeReader}
        />, document.body,
      )}

      {readerVisible ? createPortal(browserNotices, document.body) : browserNotices}
    </div>
  )
}
