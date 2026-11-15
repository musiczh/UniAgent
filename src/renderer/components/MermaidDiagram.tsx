import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import mermaidModuleUrl from 'virtual:uniagent-mermaid-runtime-url'

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | undefined
let renderQueue: Promise<void> = Promise.resolve()
let renderSequence = 0
let loadAttempt = 0

class MermaidLoadError extends Error {}

async function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  if (!mermaidPromise) {
    const url = new URL(mermaidModuleUrl, window.location.href)
    url.searchParams.set('attempt', String(loadAttempt++))
    mermaidPromise = import(/* @vite-ignore */ url.href).then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'base',
        darkMode: true,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
        themeVariables: {
          background: '#16171a',
          primaryColor: '#202225',
          primaryTextColor: '#ececed',
          primaryBorderColor: '#3a3d42',
          secondaryColor: '#1b1c1e',
          tertiaryColor: '#17181a',
          lineColor: '#6a6d73',
          textColor: '#ececed',
          edgeLabelBackground: '#16171a',
          clusterBkg: '#17181a',
          clusterBorder: '#2a2c30',
          fontSize: '14px',
        },
        flowchart: {
          useMaxWidth: false,
        },
      })
      return mermaid
    }).catch((cause) => {
      mermaidPromise = undefined
      throw new MermaidLoadError('图表组件加载失败', { cause })
    })
  }
  return mermaidPromise
}

function renderMermaid(source: string, cancelled: () => boolean): Promise<string | null> {
  const id = `ua-mermaid-${renderSequence++}`
  const render = renderQueue.then(async () => {
    try {
      if (cancelled()) return null
      const mermaid = await loadMermaid()
      if (cancelled()) return null
      return (await mermaid.render(id, source)).svg
    } finally {
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })
  renderQueue = render.then(() => undefined, () => undefined)
  return render
}

function svgDataUrl(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  })
  const document = new DOMParser().parseFromString(sanitized, 'image/svg+xml')
  const root = document.documentElement
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    root.setAttribute('width', String(viewBox[2]))
    root.setAttribute('height', String(viewBox[3]))
  }
  const normalized = new XMLSerializer().serializeToString(root)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized)}`
}

function SourceCode({ source }: { source: string }): JSX.Element {
  return (
    <pre><code className="language-mermaid">{`${source}\n`}</code></pre>
  )
}

export function MermaidDiagram({ source }: { source: string }): JSX.Element {
  const [rendered, setRendered] = useState<{ source: string; dataUrl: string } | { source: string; error: unknown } | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRendered(null)
    void renderMermaid(source, () => cancelled)
      .then((svg) => {
        if (!cancelled && svg !== null) setRendered({ source, dataUrl: svgDataUrl(svg) })
      })
      .catch((error) => {
        if (!cancelled) setRendered({ source, error })
      })
    return () => { cancelled = true }
  }, [source, retry])

  if (rendered?.source !== source) return <SourceCode source={source} />

  if ('error' in rendered) {
    const loadFailed = rendered.error instanceof MermaidLoadError ||
      rendered.error instanceof TypeError && /dynamic.*import|import.*module/i.test(rendered.error.message)
    const detail = loadFailed ? '暂时显示源码，可重试加载。'
      : rendered.error instanceof Error && rendered.error.message
        ? rendered.error.message.split('\n')[0].slice(0, 160) : '请检查图表内容后重试。'
    return (
      <div className="md-mermaid md-mermaid-failed">
        <div className="md-mermaid-error" role="alert">
          <div><strong>{loadFailed ? '图表组件加载失败' : '图表渲染失败'}</strong><p>{detail}</p></div>
          <button type="button" onClick={() => setRetry(value => value + 1)}>重试渲染</button>
        </div>
        <SourceCode source={source} />
      </div>
    )
  }

  return (
    <div className="md-mermaid">
      <pre className="md-mermaid-source" aria-hidden="true">
        <code>{`${source}\n`}</code>
      </pre>
      <img src={rendered.dataUrl} alt="Mermaid 图表" />
    </div>
  )
}
