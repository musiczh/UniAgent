import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UiIcon } from './Icons'

export interface LightboxImage {
  src: string
  alt: string
}

/**
 * Full-screen image detail view shared by every image surface in the app
 * (user message bubbles, composer attachments, generated-image cards).
 *
 * 需求(图片详情): 在图片上右键弹出「复制图片」写入系统剪贴板；多图时支持左右
 * 切换（按钮 + ←/→ 键）并显示序号，Esc 或点击遮罩关闭。单图时不显示切换控件，
 * 既有视觉（遮罩底色、关闭按钮位置、大图尺寸）保持不变。
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  label
}: {
  images: LightboxImage[]
  index: number
  onIndexChange: (next: number) => void
  onClose: () => void
  label?: string
}): JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const total = images.length
  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0
  const current = images[safeIndex]
  const many = total > 1

  const constrainView = useCallback((scale: number, x: number, y: number) => {
    const maxX = Math.max(0, (imageRef.current?.offsetWidth || 0) * (scale - 1) / 2)
    const maxY = Math.max(0, (imageRef.current?.offsetHeight || 0) * (scale - 1) / 2)
    return { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
  }, [])

  const resetView = useCallback((): void => {
    drag.current = null
    setDragging(false)
    setView({ scale: 1, x: 0, y: 0 })
  }, [])

  const zoom = useCallback((factor: number, anchor?: { x: number; y: number }): void => {
    const rect = overlayRef.current?.getBoundingClientRect()
    const x = anchor && rect ? anchor.x - rect.left - rect.width / 2 : 0
    const y = anchor && rect ? anchor.y - rect.top - rect.height / 2 : 0
    drag.current = null
    setDragging(false)
    setMenu(null)
    setView((previous) => {
      const scale = Math.max(0.25, Math.min(5, previous.scale * factor))
      const ratio = scale / previous.scale
      return constrainView(scale, x - (x - previous.x) * ratio, y - (y - previous.y) * ratio)
    })
  }, [constrainView])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? overlay.clientHeight : 1)
      if (delta === 0) return
      zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), { x: event.clientX, y: event.clientY })
    }
    const onResize = (): void => setView((previous) => constrainView(previous.scale, previous.x, previous.y))
    // React 的 wheel 委托监听为 passive，原生监听才能阻止底层页面滚动。
    overlay.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('resize', onResize)
    return () => {
      overlay.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', onResize)
    }
  }, [current?.src, constrainView, zoom])

  const step = useCallback((delta: number): void => {
    if (total < 2) return
    // Wrap around: 左右切换在多图之间循环，避免到头后按键没有反馈。
    onIndexChange((safeIndex + delta + total) % total)
  }, [onIndexChange, safeIndex, total])

  const close = useCallback((): void => {
    setMenu(null)
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Esc 先关右键菜单，再关预览：一次只退一层。
        if (menu) {
          setMenu(null)
          return
        }
        close()
        return
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      // 焦点在输入控件里时，方向键仍归输入本身（弹层可能盖在输入框之上）。
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close, menu, step])

  // Arrow keys drive the image view only when focus is not inside a text field.
  useEffect(() => {
    const focused = document.activeElement
    if (focused instanceof HTMLButtonElement) focused.blur()
  }, [])

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
  }, [])

  // 切换图片后恢复初始尺寸，上一张的菜单与复制反馈也不再适用。
  useEffect(() => {
    setMenu(null)
    setCopyState('idle')
    resetView()
  }, [safeIndex, current?.src, resetView])

  // A menu opened near an edge would otherwise hang off screen.
  const menuLeft = menu ? Math.max(8, Math.min(menu.x, window.innerWidth - 156)) : 0
  const menuTop = menu ? Math.max(8, Math.min(menu.y, window.innerHeight - 48)) : 0

  if (!current) return null

  function copyImage(): void {
    const dataUrl = current!.src
    void window.uniagent.copyImageToClipboard(dataUrl)
      .then((ok) => setCopyState(ok ? 'copied' : 'failed'))
      .catch(() => setCopyState('failed'))
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopyState('idle'), 1600)
  }

  return createPortal(
    <div
      ref={overlayRef}
      className="modal-overlay bubble-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={label || current.alt}
      onMouseDown={(event) => {
        setMenu(null)
        if (event.target === event.currentTarget) close()
      }}
    >
      <button
        type="button"
        className="bubble-image-preview-close"
        aria-label="关闭图片预览"
        onClick={close}
      >
        <UiIcon name="close" size={18} />
      </button>
      {many && (
        <>
          <button
            type="button"
            className="image-lightbox-nav image-lightbox-prev"
            aria-label="上一张图片"
            title="上一张"
            onClick={() => step(-1)}
          >
            <UiIcon name="chevron-left" size={20} />
          </button>
          <button
            type="button"
            className="image-lightbox-nav image-lightbox-next"
            aria-label="下一张图片"
            title="下一张"
            onClick={() => step(1)}
          >
            <UiIcon name="chevron-right" size={20} />
          </button>
        </>
      )}
      <img
        ref={imageRef}
        src={current.src}
        alt={current.alt}
        draggable={false}
        className={view.scale > 1 ? dragging ? 'is-dragging' : 'is-zoomed' : undefined}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onPointerDown={(event) => {
          if (event.button !== 0 || view.scale <= 1) return
          event.preventDefault()
          setMenu(null)
          drag.current = { x: event.clientX, y: event.clientY, offsetX: view.x, offsetY: view.y }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const origin = drag.current
          if (!origin) return
          setView((previous) => constrainView(previous.scale, origin.offsetX + event.clientX - origin.x, origin.offsetY + event.clientY - origin.y))
        }}
        onPointerUp={(event) => {
          drag.current = null
          setDragging(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => { drag.current = null; setDragging(false) }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      />
      {many && (
        <span className="image-lightbox-count" role="status">
          {safeIndex + 1} / {total}
        </span>
      )}
      <div className="image-lightbox-tools">
        <div className="image-lightbox-toolbar" role="toolbar" aria-label="图片缩放">
          <button type="button" aria-label="缩小图片" title="缩小" disabled={view.scale <= 0.25} onClick={() => zoom(1 / 1.25)}>
            <UiIcon name="minus" size={16} />
          </button>
          <span className="image-lightbox-scale" aria-label="相对于初始预览尺寸的缩放比例">{Math.round(view.scale * 100)}%</span>
          <button type="button" aria-label="放大图片" title="放大" disabled={view.scale >= 5} onClick={() => zoom(1.25)}>
            <UiIcon name="plus" size={16} />
          </button>
          <button type="button" className="image-lightbox-reset" title="恢复初始尺寸并居中" onClick={resetView}>重置</button>
        </div>
        <span className="image-lightbox-hint">滚轮缩放 · 放大后拖动</span>
      </div>
      {menu && (
        <>
          <div
            className="ctx-backdrop image-lightbox-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="ctx-menu image-lightbox-menu"
            role="menu"
            style={{ left: menuLeft, top: menuTop }}
          >
            <button type="button" role="menuitem" className="ctx-item" onClick={copyImage}>
              <UiIcon name={copyState === 'copied' ? 'check' : 'copy'} size={15} />
              {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制图片'}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  )
}
