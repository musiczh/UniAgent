import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { withHtmlPreviewBase, type HtmlPreviewReference } from '../htmlPreview'
import { UiIcon } from './Icons'
import { HtmlPreviewFrame } from './HtmlPreviewFrame'
import './HtmlPreview.css'

export const HtmlPreviewSessionContext = createContext<string | undefined>(undefined)

type PreviewState = { key: string; html?: string; htmlBaseUrl?: string; error?: string }

function previewLocation(path: string): { path: string; root?: string } {
  const expanded = path.startsWith('~/') ? `${window.uniagent.homeDir}/${path.slice(2)}` : path
  const separator = expanded.lastIndexOf('/')
  return expanded.startsWith('/')
    ? { path: expanded.slice(separator + 1), root: expanded.slice(0, separator) || '/' }
    : { path: expanded }
}

export function HtmlPreview({ reference, onOpenFile }: {
  reference: HtmlPreviewReference
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const sessionId = useContext(HtmlPreviewSessionContext)
  const { path, title, pending, error } = reference
  const key = JSON.stringify([sessionId, path])
  const [state, setState] = useState<PreviewState>({ key: '' })

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const location = previewLocation(path)
        const result = await window.uniagent.fsReadFile(
          sessionId || '',
          location.path,
          undefined,
          location.root,
        )
        if (cancelled) return
        const failure = !result.ok ? result.error || '无法读取文件'
          : result.tooLarge || result.truncated ? '文件过大，请打开文件查看'
            : result.kind !== 'text' || result.text === undefined ? '文件不是可预览的 HTML 文本'
              : undefined
        setState({
          key,
          html: failure ? undefined : result.text,
          htmlBaseUrl: failure ? undefined : result.htmlBaseUrl,
          error: failure
        })
      } catch {
        if (!cancelled) setState({ key, error: '无法读取文件' })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [key, path, sessionId])

  const current = state.key === key ? state : undefined
  const failure = error || current?.error
  const label = title || path?.split('/').pop() || 'HTML 预览'
  return <HtmlPreviewCard key={key} label={label} path={path} sessionId={sessionId}
    html={current?.html} baseUrl={current?.htmlBaseUrl} onOpenFile={onOpenFile}
    status={failure || (pending ? '等待预览引用完成…' : current?.html === undefined ? '正在加载预览…' : undefined)} />
}

function HtmlPreviewCard({ label, path, sessionId, html, baseUrl, status, onOpenFile }: {
  label: string
  path?: string
  sessionId?: string
  html?: string
  baseUrl?: string
  status?: string
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const [fit, setFit] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [width, setWidth] = useState(0)
  const [overflowWidth, setOverflowWidth] = useState(0)
  const [height, setHeight] = useState(460)
  const [openError, setOpenError] = useState('')
  const documentHtml = useMemo(() => html === undefined ? undefined : withHtmlPreviewBase(html, baseUrl), [html, baseUrl])

  function collapse(): void {
    dialogRef.current?.close()
    dialogRef.current?.show()
    setExpanded(false)
    expandRef.current?.focus()
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let previousWidth = -1
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.floor(entry.contentRect.width)
      if (nextWidth === previousWidth) return
      previousWidth = nextWidth
      // Keep measured content width when scrollbars resize the viewport to avoid a fit/resize loop.
      setWidth(nextWidth)
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  async function openInBrowser(): Promise<void> {
    if (!path) return
    setOpenError('')
    const location = previewLocation(path)
    try {
      await window.uniagent.fsOpenHtml(sessionId || '', location.path, location.root)
    } catch {
      setOpenError('无法在浏览器中打开')
    }
  }

  const frameWidth = Math.max(width, overflowWidth)
  const scale = fit && frameWidth > 0 && width > 0 ? Math.min(1, width / frameWidth) : 1
  const fitLabel = fit ? '切换为原始大小' : '适应宽度'
  const expandLabel = expanded ? '收起' : '放大'
  return (
    <dialog ref={dialogRef} open className="html-preview" aria-label={label}
      onCancel={(event) => { event.preventDefault(); collapse() }}>
      <div className="html-preview-toolbar">
        <span className="html-preview-name" title={path}>{label}</span>
        <div className="html-preview-actions">
          <button type="button" title={fitLabel} aria-label={fitLabel} aria-pressed={fit}
            onClick={() => setFit((current) => !current)}><UiIcon name="swap-horizontal" /></button>
          <button ref={expandRef} type="button" title={expandLabel} aria-label={expandLabel} aria-expanded={expanded}
            onClick={() => {
              if (expanded) return collapse()
              dialogRef.current?.close()
              dialogRef.current?.showModal()
              setExpanded(true)
            }}><UiIcon name={expanded ? 'collapse' : 'expand'} /></button>
          <button type="button" title="在浏览器打开" aria-label="在浏览器打开" disabled={!path}
            onClick={() => void openInBrowser()}><UiIcon name="globe" /></button>
          {path && onOpenFile && (
            <button type="button" title="打开文件" aria-label="打开文件"
              onClick={() => { if (expanded) collapse(); onOpenFile(path) }}><UiIcon name="code" /></button>
          )}
        </div>
      </div>
      {openError && <div className="html-preview-status" role="status">{openError}</div>}
      <div ref={viewportRef} className="html-preview-viewport">
        {status ? <div className="html-preview-status" role="status">{status}</div>
          : <div className="html-preview-stage" style={{ width: frameWidth ? frameWidth * scale : '100%', height: height * scale }}>
            <HtmlPreviewFrame
              html={documentHtml || ''}
              className="html-preview-frame"
              onEscape={() => { if (dialogRef.current?.matches(':modal')) collapse() }}
              onSize={({ height: nextHeight, overflowWidth: nextOverflowWidth }) => {
                if (nextHeight !== undefined) setHeight(Math.min(2400, Math.max(160, nextHeight)))
                if (nextOverflowWidth !== undefined && nextOverflowWidth > 0) {
                  setOverflowWidth((current) => Math.max(current, Math.min(12000, nextOverflowWidth)))
                }
              }}
              style={{ width: frameWidth || '100%', height, transform: `scale(${scale})` }}
              title={label}
            />
          </div>}
      </div>
    </dialog>
  )
}
