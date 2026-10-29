import type { Attachment } from '@shared/types'
import { ImageLightbox } from './ImageLightbox'
import { UiIcon } from './Icons'

export function AttachmentThumbnail({ name, src, onOpen, onRemove }: {
  name: string
  src?: string
  /** Open the shared image detail view; without it the thumb is not clickable. */
  onOpen?: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <span className="attach-thumb" title={name}>
      {onOpen ? (
        <button
          type="button"
          className="attach-thumb-preview"
          aria-label={`预览 ${name}`}
          onClick={onOpen}
        >
          {src ? (
            <img src={src} alt="" />
          ) : (
            <span className="attach-thumb-ph" aria-hidden="true">🖼</span>
          )}
        </button>
      ) : (
        <span className="attach-thumb-preview">
          {src ? (
            <img src={src} alt="" />
          ) : (
            <span className="attach-thumb-ph" aria-hidden="true">🖼</span>
          )}
        </span>
      )}
      <button
        type="button"
        className="attach-thumb-x"
        aria-label={`移除 ${name}`}
        onClick={onRemove}
      >
        <UiIcon name="close" size={12} />
      </button>
    </span>
  )
}

/**
 * Composer-side image detail (需求: 图片详情左右切换). Thumbnails stay plain
 * previews; the shared lightbox is rendered once for the whole attach bar so it
 * can page through every attached image instead of only the one clicked, and so
 * right-clicking the big image offers 复制图片.
 */
export function AttachmentImagePreview({
  entries,
  index,
  onIndexChange,
  onClose
}: {
  entries: { attachment: Attachment; src?: string }[]
  index: number
  onIndexChange: (next: number) => void
  onClose: () => void
}): JSX.Element | null {
  if (index < 0 || index >= entries.length) return null
  return (
    <ImageLightbox
      images={entries.map((entry) => ({ src: entry.src || '', alt: entry.attachment.name }))}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
      label={entries[index].attachment.name}
    />
  )
}
