import { useEffect, useMemo, useRef, type CSSProperties } from 'react'

type PreviewSize = { height?: number; overflowWidth?: number }

export function HtmlPreviewFrame({ html, title, className, style, onSize, onEscape }: {
  html: string
  title: string
  className: string
  style?: CSSProperties
  onSize?: (size: PreviewSize) => void
  onEscape?: () => void
}): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const id = useMemo(() => crypto.randomUUID(), [html])

  function initialize(): void {
    frameRef.current?.contentWindow?.postMessage({ type: 'html-preview:init', id, html }, '*')
  }

  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== 'null') return
      const data = event.data
      if (data?.type === 'html-preview:ready') {
        initialize()
        return
      }
      if (data?.id !== id) return
      if (data.type === 'html-preview:escape') onEscape?.()
      if (data.type === 'html-preview:size') {
        onSize?.({
          height: typeof data.height === 'number' && Number.isFinite(data.height) ? data.height : undefined,
          overflowWidth: typeof data.overflowWidth === 'number' && Number.isFinite(data.overflowWidth)
            ? data.overflowWidth : undefined
        })
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [html, id, onSize, onEscape])

  return <iframe
    key={id}
    ref={frameRef}
    className={className}
    sandbox="allow-scripts allow-forms"
    src={window.uniagent.htmlPreviewUrl}
    onLoad={initialize}
    style={style}
    title={title}
  />
}
