import { useEffect, useState } from 'react'
import type { UAEvent } from '@shared/types'
import type { NativeImageSelector } from '@shared/viewImage'
import { cacheAttachmentPreview, getCachedAttachmentPreview } from '../hooks'
import { ImageLightbox } from './ImageLightbox'
import { UiIcon } from './Icons'

/** Inline preview for an image a tool returned; the bytes are read back from the
 * provider log through the same selector IPC the standalone card used. */
export function NativeImageThumbnail({ event, selector, name, path }: {
  event: UAEvent
  selector: NativeImageSelector
  name: string
  path?: string
}): JSX.Element {
  const cacheKey = `native-image-row:${event.sessionId}:${selector.childSessionId ?? ''}:${selector.eventSeq}:${selector.blockIndex}:${selector.toolResult === true ? 1 : 0}`
  const [src, setSrc] = useState<string | null | undefined>(() =>
    event.state === 'success' ? getCachedAttachmentPreview(cacheKey) : event.state === 'running' ? undefined : null
  )
  const [open, setOpen] = useState(false)

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
    void window.uniagent.fsReadNativeImage(event.sessionId, {
      eventSeq: selector.eventSeq, blockIndex: selector.blockIndex, ...(selector.toolResult ? { toolResult: true } : {}),
      ...(selector.childSessionId ? { childSessionId: selector.childSessionId } : {})
    })
      .then((dataUrl) => {
        if (!active) return
        cacheAttachmentPreview(cacheKey, dataUrl || undefined)
        setSrc(dataUrl)
      })
      .catch(() => { if (active) setSrc(null) })
    return () => { active = false }
  }, [cacheKey, event.sessionId, event.state, selector.eventSeq, selector.blockIndex, selector.toolResult, selector.childSessionId])

  return (
    <span className="tool-image-preview" onClick={(e) => e.stopPropagation()}>
      {src ? (
        <button type="button" className="tool-image-thumbnail" aria-label={`查看图片 ${name}`} title={`查看图片：${path || name}`} onClick={() => setOpen(true)}>
          <img src={src} alt="" onError={() => setSrc(null)} />
        </button>
      ) : (
        <span
          className={`tool-image-thumbnail tool-image-placeholder${src === null ? ' unavailable' : ''}`}
          role="img"
          aria-label={src === null ? `图片不可用：${name}` : `正在加载图片：${name}`}
          title={src === null ? `图片暂时无法读取：${path || name}` : `正在加载图片：${path || name}`}
        >
          <UiIcon name="image" size={13} />
        </span>
      )}
      {src && open && <ImageLightbox images={[{ src, alt: name }]} index={0} onIndexChange={() => {}} onClose={() => setOpen(false)} label={name} />}
    </span>
  )
}
