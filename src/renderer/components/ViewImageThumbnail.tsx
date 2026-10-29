import { useEffect, useState } from 'react'
import type { UAEvent } from '@shared/types'
import { cacheAttachmentPreview, getCachedAttachmentPreview } from '../hooks'
import { ImageLightbox } from './ImageLightbox'
import { UiIcon } from './Icons'

export function ViewImageThumbnail({ event, path }: { event: UAEvent; path: string }): JSX.Element {
  const cacheKey = `view-image:${event.sessionId}:${event.seq}:${path}`
  const [src, setSrc] = useState<string | null | undefined>(() =>
    event.state === 'success' ? getCachedAttachmentPreview(cacheKey) : event.state === 'running' ? undefined : null
  )
  const [open, setOpen] = useState(false)
  const name = path.split(/[\\/]/).pop() || path

  useEffect(() => {
    if (event.state !== 'success') {
      setSrc(event.state === 'running' ? undefined : null)
      return
    }
    const cached = getCachedAttachmentPreview(cacheKey)
    if (cached) {
      setSrc(cached)
      return
    }
    let active = true
    setSrc(undefined)
    void window.uniagent.fsReadAttachmentImage(event.sessionId, path)
      .then((dataUrl) => {
        if (!active) return
        cacheAttachmentPreview(cacheKey, dataUrl || undefined)
        setSrc(dataUrl)
      })
      .catch(() => { if (active) setSrc(null) })
    return () => { active = false }
  }, [cacheKey, event.sessionId, event.state, path])

  return (
    <span className="tool-image-preview" onClick={(e) => e.stopPropagation()}>
      {src ? (
        <button type="button" className="tool-image-thumbnail" aria-label={`查看图片 ${name}`} title={`查看图片：${path}`} onClick={() => setOpen(true)}>
          <img src={src} alt="" onError={() => setSrc(null)} />
        </button>
      ) : (
        <span
          className={`tool-image-thumbnail tool-image-placeholder${src === null ? ' unavailable' : ''}`}
          role="img"
          aria-label={src === null ? `图片不可用：${name}` : `正在加载图片：${name}`}
          title={src === null ? `图片暂时无法读取：${path}` : `正在加载图片：${path}`}
        >
          <UiIcon name="image" size={13} />
        </span>
      )}
      {src && open && <ImageLightbox images={[{ src, alt: name }]} index={0} onIndexChange={() => {}} onClose={() => setOpen(false)} label={name} />}
    </span>
  )
}
