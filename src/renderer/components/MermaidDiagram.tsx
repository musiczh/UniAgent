import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | undefined
let renderQueue: Promise<void> = Promise.resolve()
let renderSequence = 0

async function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
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
    })
  }
  return mermaidPromise
}

function renderMermaid(source: string): Promise<string> {
  const id = `ua-mermaid-${renderSequence++}`
  const render = renderQueue.then(async () => {
    try {
      const mermaid = await loadMermaid()
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
  const [rendered, setRendered] = useState<{ source: string; dataUrl: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void renderMermaid(source)
      .then((svg) => {
        if (!cancelled) setRendered({ source, dataUrl: svgDataUrl(svg) })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [source])

  if (rendered?.source !== source) return <SourceCode source={source} />

  return (
    <div className="md-mermaid">
      <pre className="md-mermaid-source" aria-hidden="true">
        <code>{`${source}\n`}</code>
      </pre>
      <img src={rendered.dataUrl} alt="Mermaid 图表" />
    </div>
  )
}
