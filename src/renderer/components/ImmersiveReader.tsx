import { createPortal } from 'react-dom'
import { Marked, type Token, type Tokens } from 'marked'
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { UAEvent } from '@shared/types'
import { captureSelection, type Annotation, type CapturedSelection } from '../textAnnotations'
import { HtmlPreviewSessionContext } from './HtmlPreview'
import { UiIcon } from './Icons'
import { Markdown } from './Markdown'
import { COMMENT_ANNOTATION_PREFIX, useComments } from '../comments'
import { CommentPanel } from './CommentPanel'

interface MarkdownHeading {
  depth: number
  label: string
}

type ReaderSelection = CapturedSelection & { range: Range }

interface ReaderFile {
  sessionId: string
  name: string
  path: string
  text: string
  navigation: ReactNode
  loading: boolean
  error?: string
  warning?: string
}

export function formatMessageTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '--:--'
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatMessageFullTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '消息时间未知'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function inlineTokenText(tokens: Token[] | undefined): string {
  return (tokens || []).map((token) => {
    const nested = (token as Token & { tokens?: Token[] }).tokens
    if (nested?.length) return inlineTokenText(nested)
    return typeof (token as Token & { text?: string }).text === 'string'
      ? (token as Token & { text: string }).text
      : ''
  }).join('')
}

function extractHeadings(text: string): MarkdownHeading[] {
  const parser = new Marked({ gfm: true, breaks: true })
  return parser.lexer(text).flatMap((token) => {
    if (token.type !== 'heading') return []
    const heading = token as Tokens.Heading
    const label = inlineTokenText(heading.tokens).trim() || heading.text.trim()
    return label ? [{ depth: heading.depth, label }] : []
  })
}

function ReaderSelectionLayer({
  containerRef,
  onComment,
  onSideComment,
}: {
  containerRef: RefObject<HTMLDivElement>
  onComment?: (selection: ReaderSelection) => void
  onSideComment?: (selection: ReaderSelection) => void
}): JSX.Element | null {
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [copied, setCopied] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onMouseUp = (event: MouseEvent): void => {
      if (popRef.current?.contains(event.target as Node)) return
      window.setTimeout(() => {
        const captured = captureSelection()
        const nativeSelection = window.getSelection()
        const range = nativeSelection?.rangeCount ? nativeSelection.getRangeAt(0).cloneRange() : null
        if (captured && range) {
          setCopied(false)
          setSelection({ ...captured, range })
        }
      }, 0)
    }
    container.addEventListener('mouseup', onMouseUp)
    return () => container.removeEventListener('mouseup', onMouseUp)
  }, [containerRef])

  useEffect(() => {
    if (!selection) return
    const dismiss = (): void => setSelection(null)
    const onMouseDown = (event: MouseEvent): void => {
      if (!popRef.current?.contains(event.target as Node)) dismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    const container = containerRef.current
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKeyDown)
    container?.addEventListener('scroll', dismiss, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKeyDown)
      container?.removeEventListener('scroll', dismiss)
    }
  }, [containerRef, selection])

  if (!selection) return null

  const clear = (): void => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(selection.quote)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Keep the selection available so the user can retry.
    }
  }
  const anchor = {
    left: selection.rect.left + selection.rect.width / 2,
    top: selection.rect.top,
    transform: 'translate(-50%, calc(-100% - 10px))',
  } as const

  return createPortal(
    <div
      ref={popRef}
      className="sel-pop reader-selection-pop"
      style={anchor}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {onComment && <><button
        className="sel-btn"
        onClick={() => {
          onComment(selection)
          clear()
        }}
      >
        <UiIcon name="message-square" size={14} /> 评论
      </button>
      <span className="sel-sep" /></>}
      <button className={`sel-btn${copied ? ' copied' : ''}`} onClick={() => void copy()}>
        <UiIcon name={copied ? 'check' : 'copy'} size={14} /> {copied ? '已复制' : '复制'}
      </button>
      {onSideComment && <><span className="sel-sep" /><button className="sel-btn" onClick={() => { onSideComment(selection); clear() }}>
        <UiIcon name="message-square" size={14} /> 侧边评论
      </button></>}
    </div>,
    document.body,
  )
}

export function ImmersiveReader({
  event, file, sessionTitle, agentName, annotations,
  onAddComment, onUpdateComment, onRemoveComment, onOpenFile, onClose, readOnly = false,
  editRequest, onEditRequestHandled,
}: {
  sessionTitle?: string
  agentName?: string
  annotations: Annotation[]
  onAddComment: (annotation: Omit<Annotation, 'id'>) => void
  onUpdateComment: (id: string, comment: string) => void
  onRemoveComment: (id: string) => void
  onOpenFile: (path: string, line?: number) => void
  onClose: () => void
  readOnly?: boolean
  editRequest?: { annotation: Annotation; nonce: number }
  onEditRequestHandled?: (nonce: number) => void
} & ({ event: UAEvent; file?: never } | { file: ReaderFile; event?: never })): JSX.Element {
  const comments = useComments()
  const ownerId = file?.sessionId || event?.sessionId
  const text = file ? file.text : typeof event.payload.text === 'string' ? event.payload.text : ''
  const seq = event?.seq ?? -1
  const highlightedAnnotations = (comments?.annotations(annotations, ownerId) || annotations)
    .filter(annotation => file ? annotation.filePath === file.path : !annotation.filePath && annotation.seq === seq)
  const headings = useMemo(() => extractHeadings(text), [text])
  const messageAnnotations = useMemo(
    () => annotations.filter((annotation) => file
      ? annotation.filePath === file.path
      : !annotation.filePath && annotation.seq === seq),
    [annotations, file?.path, seq],
  )
  const [navigationTab, setNavigationTab] = useState<'files' | 'outline'>('files')
  const [tocCollapsed, setTocCollapsed] = useState(true)
  const [tocPreview, setTocPreview] = useState(false)
  const [availableWidth, setAvailableWidth] = useState(0)
  const [commentsOpen, setCommentsOpen] = useState(!!file)
  const [commentsWidth, setCommentsWidth] = useState(file ? 276 : 312)
  const [commentsMaxWidth, setCommentsMaxWidth] = useState(520)
  const [resizing, setResizing] = useState(false)
  const [activeHeading, setActiveHeading] = useState(0)
  const [draft, setDraft] = useState<(CapturedSelection & { annotationId?: string; range?: Range; scrollTop: number }) | null>(null)
  const [draftComment, setDraftComment] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const tocRef = useRef<HTMLElement>(null)
  const tocTriggerRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  const restoreTocFocus = useRef(false)
  const suppressTocFocus = useRef(false)
  const canDock = availableWidth >= 900
  const docked = canDock && !tocCollapsed
  const tocVisible = headings.length > 0 && (docked || tocPreview)
  const width = Math.min(commentsWidth, commentsMaxWidth)

  useLayoutEffect(() => {
    setTocPreview(false)
    if (restoreTocFocus.current && !docked) {
      suppressTocFocus.current = true
      tocTriggerRef.current?.focus()
      suppressTocFocus.current = false
      restoreTocFocus.current = false
    }
  }, [canDock, docked])

  useLayoutEffect(() => {
    const area = areaRef.current
    const body = bodyRef.current
    if (!area || !body) return
    const measure = (): void => {
      setAvailableWidth(area.clientWidth)
      setCommentsMaxWidth(Math.max(260, Math.min(520, body.clientWidth - (file ? 580 : 360))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  // Measure the actual content-sized TOC. Only its overlap with the document
  // is masked, with a 12px feather instead of dimming a fixed-width column.
  useLayoutEffect(() => {
    const toc = tocRef.current
    const scroller = scrollRef.current
    if (!toc || !scroller || docked || !tocPreview) return
    const measure = (): void => {
      const nav = toc.getBoundingClientRect()
      const content = scroller.getBoundingClientRect()
      scroller.style.setProperty('--toc-mask-width', Math.max(0, nav.right - content.left) + 'px')
      scroller.style.setProperty('--toc-mask-height', Math.max(0, nav.bottom - content.top) + 'px')
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(toc)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [docked, tocPreview, availableWidth, headings])

  // Keep the same inline editor as chat, clamped inside the reading viewport.
  useLayoutEffect(() => {
    const editor = editorRef.current
    const scroller = scrollRef.current
    if (file || !draft || !editor || !scroller) return
    const position = (): void => {
      const bounds = scroller.getBoundingClientRect()
      const shift = scroller.scrollTop - draft.scrollTop
      const mark = draft.annotationId ? Array.from(documentRef.current?.querySelectorAll<HTMLElement>('mark[data-anno-id]') || [])
        .find((node) => node.dataset.annoId === draft.annotationId) : undefined
      const rect = mark?.getBoundingClientRect() || draft.range?.getBoundingClientRect()
      const top = rect ? rect.top : draft.rect.top - shift
      const bottom = rect ? rect.bottom : draft.rect.bottom - shift
      const anchor = rect || draft.rect
      const left = anchor.left + anchor.width / 2 - editor.offsetWidth / 2
      const preferredTop = top - editor.offsetHeight - 10 >= bounds.top + 8
        ? top - editor.offsetHeight - 10 : bottom + 10
      editor.style.left = Math.max(bounds.left + 8, Math.min(bounds.right - editor.offsetWidth - 8, left)) + 'px'
      editor.style.top = Math.max(bounds.top + 8, Math.min(bounds.bottom - editor.offsetHeight - 8, preferredTop)) + 'px'
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(scroller)
    observer.observe(editor)
    scroller.addEventListener('scroll', position, { passive: true })
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', position)
      window.removeEventListener('resize', position)
    }
  }, [draft, availableWidth, file?.path])

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape' || keyEvent.defaultPrevented) return
      if (document.querySelector('.reader-selection-pop')) return
      keyEvent.preventDefault()
      if (draft) setDraft(null)
      else if (tocPreview && !docked) setTocPreview(false)
      else onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft, tocPreview, docked, onClose])

  const syncActiveHeading = useCallback((): void => {
    const scroller = scrollRef.current
    const root = documentRef.current
    if (!scroller || !root || headings.length === 0) return
    const scrollerTop = scroller.getBoundingClientRect().top
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
    let next = 0
    nodes.forEach((node, index) => {
      if (node.getBoundingClientRect().top <= scrollerTop + 88) next = index
    })
    setActiveHeading(Math.min(next, headings.length - 1))
  }, [headings.length])

  useEffect(() => {
    const frame = requestAnimationFrame(syncActiveHeading)
    return () => cancelAnimationFrame(frame)
  }, [syncActiveHeading, text])

  const jumpToHeading = (index: number): void => {
    const scroller = scrollRef.current
    const target = documentRef.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[index]
    if (!scroller || !target) return
    scroller.scrollTo({
      top: target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 28,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
    setActiveHeading(index)
  }
  const startDraft = (selection: ReaderSelection): void => {
    if (readOnly) return
    comments?.setTab('pending')
    if (file) setCommentsOpen(true)
    setDraft({ ...selection, scrollTop: scrollRef.current?.scrollTop || 0 })
    setDraftComment('')
  }
  const editComment = (id: string): void => {
    if (id.startsWith(COMMENT_ANNOTATION_PREFIX)) { comments?.select(id.slice(COMMENT_ANNOTATION_PREFIX.length)); return }
    if (readOnly) return
    const annotation = messageAnnotations.find((item) => item.id === id)
    const mark = Array.from(documentRef.current?.querySelectorAll<HTMLElement>('mark[data-anno-id]') || [])
      .find((node) => node.dataset.annoId === id)
    const scroller = scrollRef.current
    if (!annotation || !scroller || (!file && !mark)) return
    const bounds = scroller.getBoundingClientRect()
    const rect = mark?.getBoundingClientRect() || bounds
    if (mark && (rect.top < bounds.top + 20 || rect.bottom > bounds.bottom - 20)) {
      scroller.scrollTop += rect.top - bounds.top - 70
    }
    window.getSelection()?.removeAllRanges()
    setDraft({ ...annotation, annotationId: id, selectedMessageText: text,
      rect: mark?.getBoundingClientRect() || bounds, scrollTop: scroller.scrollTop })
    setDraftComment(annotation.comment)
    if (file) setCommentsOpen(true)
  }
  useEffect(() => {
    if (!file || file.loading || !editRequest || readOnly) return
    if (!messageAnnotations.some((annotation) => annotation.id === editRequest.annotation.id)) return
    editComment(editRequest.annotation.id)
    onEditRequestHandled?.(editRequest.nonce)
  }, [editRequest, file?.loading, readOnly])
  const confirmDraft = (): void => {
    if (!draft || readOnly) return
    if (file && !draftComment.trim()) return
    if (draft.annotationId) onUpdateComment(draft.annotationId, draftComment.trim())
    else onAddComment({ seq: draft.seq, start: draft.start, end: draft.end, quote: draft.quote, comment: draftComment.trim(),
      ...(file ? { filePath: file.path } : {}) })
    setDraft(null)
  }
  const closeToc = (): void => {
    if (docked) {
      restoreTocFocus.current = true
      setTocCollapsed(true)
    } else {
      suppressTocFocus.current = true
      tocTriggerRef.current?.focus()
      suppressTocFocus.current = false
    }
    setTocPreview(false)
  }
  const resizeComments = (next: number): void => setCommentsWidth(Math.max(260, Math.min(commentsMaxWidth, next)))

  const commentEditor = draft && <div ref={editorRef} className={file ? 'file-reader-draft' : 'sel-cmt-pop reader-comment-pop'}
    role="dialog" aria-label={draft.annotationId ? '修改评论' : '添加评论'}
    style={file ? undefined : { maxWidth: Math.max(160, availableWidth - 60) }}>
    <div className="sel-cmt-quote">{draft.quote}</div>
    <textarea autoFocus rows={3} className="sel-cmt-ta" aria-label="评论内容" value={draftComment} placeholder="添加评论…"
      onChange={(e) => setDraftComment(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirmDraft() }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null) }
      }} />
    <div className="sel-cmt-actions">
      <span className="sel-cmt-hint">⌘⏎ {file || draft.annotationId ? '保存' : '评论'}</span>
      <button className="sel-cmt-ghost" onClick={() => setDraft(null)}>取消</button>
      <button className="sel-cmt-primary" disabled={!!file && !draftComment.trim()} onClick={confirmDraft}>
        {file ? '保存评论' : draft.annotationId ? '保存' : '评论'}
      </button>
    </div>
  </div>

  const outline = <div className="immersive-reader-toc-list">
    {headings.map((heading, index) => (
      <button key={index} className={activeHeading === index ? 'active' : ''}
        style={{ paddingLeft: 6 + Math.max(0, heading.depth - 1) * 14 }}
        onClick={() => jumpToHeading(index)} title={heading.label} aria-current={activeHeading === index ? 'location' : undefined}>
        {heading.label}
      </button>
    ))}
  </div>

  return (
    <HtmlPreviewSessionContext.Provider value={file?.sessionId || event?.sessionId}>
      <div className={'immersive-reader-overlay' + (file ? ' is-file-reader' : '')} role="dialog" aria-modal="true" aria-label={file ? 'Markdown 阅读模式' : '沉浸阅读'}>
        <header className="scene-head immersive-reader-head">
          {!file && <button className="immersive-reader-back" onClick={onClose} title="返回对话（Esc）" aria-label="返回对话">
            <UiIcon name="back" size={18} />
          </button>}
          {file && <UiIcon name="book-open" size={17} />}
          <div className="immersive-reader-heading">
            <strong>{file?.name || '沉浸阅读'}</strong>
            <span>{file ? '阅读模式 · ' + file.path : `${agentName} · ${sessionTitle} · 本条回复`}</span>
          </div>
          {file && !readOnly && <span className="file-reader-sync"><UiIcon name="check" size={13} />评论同步到当前会话</span>}
          <button className="immersive-reader-comments-toggle" onClick={() => {
            if (comments?.open || commentsOpen) { comments?.close(); setCommentsOpen(false) }
            else if (comments?.threads.length) { comments.setTab('ai'); comments.show() }
            else setCommentsOpen(true)
          }}
            title={commentsOpen || comments?.open ? '收起评论' : '展开评论'} aria-label={commentsOpen || comments?.open ? '收起评论' : '展开评论'} aria-expanded={commentsOpen || !!comments?.open}>
            <UiIcon name="message-square" size={14} /> 评论 <b>{messageAnnotations.length}</b>
          </button>
          {file && <button className="scene-back-btn" onClick={onClose} title="退出阅读（Esc）"><UiIcon name="back" size={15} />退出阅读</button>}
        </header>

        <div ref={bodyRef} className={'immersive-reader-body' + (resizing ? ' resizing' : '')}>
          {file && <aside className="file-reader-navigation" aria-label="文件与大纲">
            <div className="file-reader-tabs" role="tablist" aria-label="阅读导航">
              <button id="reader-files-tab" role="tab" aria-selected={navigationTab === 'files'} aria-controls="reader-files-panel"
                className={navigationTab === 'files' ? 'active' : ''} onClick={() => setNavigationTab('files')}>文件</button>
              <button id="reader-outline-tab" role="tab" aria-selected={navigationTab === 'outline'} aria-controls="reader-outline-panel"
                className={navigationTab === 'outline' ? 'active' : ''} onClick={() => setNavigationTab('outline')}>大纲</button>
            </div>
            <div id="reader-files-panel" role="tabpanel" aria-labelledby="reader-files-tab" hidden={navigationTab !== 'files'}>{file.navigation}</div>
            <nav id="reader-outline-panel" role="tabpanel" aria-labelledby="reader-outline-tab" className="immersive-reader-toc" hidden={navigationTab !== 'outline'}>
              {headings.length ? outline : <p className="immersive-reader-comments-empty">当前文档没有标题</p>}
            </nav>
          </aside>}
          <div ref={areaRef} className="immersive-reader-reading-area" style={{ '--reader-width': availableWidth + 'px' } as CSSProperties}>
            {!file && headings.length > 0 && <div className={'immersive-reader-toc-slot ' + (docked ? 'docked' : 'floating')}
              onMouseLeave={() => {
                // Mouse navigation must collapse on leave; keyboard focus stays
                // usable until Tab leaves the menu or Escape closes it.
                if (!tocRef.current?.querySelector(':focus-visible')) {
                  if (tocRef.current?.contains(document.activeElement)) {
                    suppressTocFocus.current = true
                    tocTriggerRef.current?.focus()
                    suppressTocFocus.current = false
                  }
                  setTocPreview(false)
                }
              }}
              onBlur={(e) => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setTocPreview(false) }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToc() } }}>
              {!docked && <button ref={tocTriggerRef} className="immersive-reader-toc-trigger"
                title={canDock ? '点击常驻目录' : '目录'} aria-label="展开目录" aria-expanded={tocVisible}
                onMouseEnter={() => { if (!canDock) setTocPreview(true) }}
                onFocus={() => { if (!canDock && !suppressTocFocus.current) setTocPreview(true) }}
                onClick={() => { if (canDock) setTocCollapsed(false); else setTocPreview(true) }}>
                <UiIcon name="table-of-contents" size={18} />
              </button>}
              <nav ref={tocRef} className="immersive-reader-toc" aria-label="目录" hidden={!tocVisible}>
                <div className="immersive-reader-toc-head">
                  <button onClick={closeToc} title="收起目录" aria-label="收起目录"><UiIcon name="chevrons-left" size={18} /></button>
                  <span>目录</span>
                </div>
                {outline}
              </nav>
            </div>}
            <main ref={scrollRef} className={'immersive-reader-scroll' + (!docked && tocVisible ? ' toc-preview' : '')} onScroll={syncActiveHeading}>
              <div ref={documentRef} className="immersive-reader-document" data-seq={seq}>
                <div className="immersive-reader-meta">
                  {file ? `${file.name} · Markdown` : `回复于 ${formatMessageTime(event.ts)}`} · 约 {text.trim().length} 字 · {Math.max(1, Math.ceil(text.trim().length / 400))} 分钟阅读
                </div>
                {file?.warning && <div className="fb-preview-warning">{file.warning}</div>}
                {file?.loading ? <div className="fb-empty">正在读取 {file.name}…</div>
                  : file?.error ? <div className="fb-empty is-error">{file.error}</div>
                  : <Markdown text={text} filePath={file?.path} onOpenFile={onOpenFile} annotations={highlightedAnnotations} onEditAnnotation={readOnly && !comments ? undefined : editComment} />}
              </div>
            </main>
          </div>
          {comments?.open ? <CommentPanel embedded pending={messageAnnotations} pendingContent={<div className="immersive-reader-comments-list">
            {messageAnnotations.map(annotation => <button key={annotation.id} className="ai-pending" onClick={() => editComment(annotation.id)}>
              <blockquote>{annotation.quote}</blockquote><p>{annotation.comment || '待补充评论'}</p></button>)}
            {file && commentEditor}
            {!messageAnnotations.length && !draft && <p className="ai-comment-empty">暂无待发送批注</p>}
          </div>} /> : commentsOpen && <aside className="immersive-reader-comments" aria-label="评论" style={{ width }}>
            <div className="immersive-reader-comments-resizer" role="separator" tabIndex={0}
              aria-label="调整评论栏宽度" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={commentsMaxWidth} aria-valuenow={Math.round(width)}
              title="拖动调整评论栏宽度"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                resizeStart.current = { x: e.clientX, width }
                e.currentTarget.setPointerCapture(e.pointerId)
                setResizing(true)
              }}
              onPointerMove={(e) => { if (resizeStart.current) resizeComments(resizeStart.current.width + resizeStart.current.x - e.clientX) }}
              onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
              onLostPointerCapture={() => { resizeStart.current = null; setResizing(false) }}
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                e.preventDefault()
                resizeComments(e.key === 'Home' ? 260 : e.key === 'End' ? commentsMaxWidth : width + (e.key === 'ArrowLeft' ? 20 : -20))
              }} />
            <div className="immersive-reader-comments-head">
              <UiIcon name="message-square" size={14} /><span>{file ? '评论' : '待评论'}</span><b>{messageAnnotations.length}</b><span>条</span>
              <button onClick={() => setCommentsOpen(false)} title="收起评论" aria-label="收起评论"><UiIcon name="chevrons-right" size={16} /></button>
            </div>
            <div className="immersive-reader-comments-list">
              {messageAnnotations.map((annotation, index) => (
                <div key={annotation.id} className="immersive-reader-comment">
                  <span className="immersive-reader-comment-index">{index + 1}</span>
                  <div><blockquote>{annotation.quote}</blockquote><p>{annotation.comment || '待补充评论'}</p>
                    {file && <span className="file-reader-comment-status"><UiIcon name="check" size={11} />已同步到会话 · 待发送</span>}
                  </div>
                  {!readOnly && <div className="immersive-reader-comment-tools">
                    <button onClick={() => editComment(annotation.id)} title="编辑评论" aria-label={'编辑评论 ' + (index + 1)}><UiIcon name="edit" size={12} /></button>
                    <button onClick={() => { if (draft?.annotationId === annotation.id) setDraft(null); onRemoveComment(annotation.id) }} title="删除评论" aria-label={'删除评论 ' + (index + 1)}><UiIcon name="close" size={12} /></button>
                  </div>}
                </div>
              ))}
              {file && commentEditor}
              {messageAnnotations.length === 0 && !draft && <p className="immersive-reader-comments-empty">选中正文内容后点击“评论”，评论会显示在这里。</p>}
            </div>
            {file && <div className="file-reader-comments-foot">{readOnly ? '当前文件仅供阅读。' : '保存后同步到当前会话的待发送评论区，返回会话后可统一发送给 Agent。'}</div>}
          </aside>}
        </div>
        {!draft && <ReaderSelectionLayer containerRef={scrollRef} onComment={readOnly ? undefined : startDraft}
          onSideComment={readOnly || !comments || ownerId !== comments.session?.id ? undefined : selection => {
            void comments.begin({ ...selection, filePath: file?.path, sourceText: text })
          }} />}
        {!file && commentEditor && createPortal(commentEditor, document.body)}
      </div>
    </HtmlPreviewSessionContext.Provider>
  )
}
