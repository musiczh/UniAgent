import { useEffect, useRef } from 'react'

export function AutoRoutingLabel({ active }: { active: boolean }): JSX.Element {
  const titleRef = useRef<HTMLElement>(null)
  const layerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const title = titleRef.current, layer = layerRef.current
    if (!active || !title || !layer) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      const style = getComputedStyle(title), rect = title.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const mask = document.createElement('canvas')
      mask.width = Math.ceil(rect.width * ratio)
      mask.height = Math.ceil(rect.height * ratio)
      const context = mask.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.font = `${style.fontWeight} ${parseFloat(style.fontSize) * ratio}px ${style.fontFamily}`
      const metrics = context.measureText(title.textContent || '')
      const baseline = (mask.height - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent
      context.fillText(title.textContent || '', 0, baseline)
      const pixels = context.getImageData(0, 0, mask.width, mask.height).data
      const inkTop = Math.max(0, Math.floor(baseline - metrics.actualBoundingBoxAscent))
      const inkBottom = Math.min(mask.height, Math.ceil(baseline + metrics.actualBoundingBoxDescent))
      const height = (inkBottom - inkTop) / ratio
      const maxSize = 2.25, step = Math.max(1, Math.round(ratio))
      const points: Array<{ x: number; y: number }> = []
      for (let y = inkTop; y <= inkBottom - maxSize * ratio; y += step) {
        for (let x = 1; x <= mask.width - maxSize * ratio; x += step) {
          if (pixels[(y * mask.width + x) * 4 + 3] > 180) points.push({ x: x / ratio, y: (y - inkTop) / ratio })
        }
      }
      points.sort((a, b) => a.x - b.x)
      const leftPoints = points.filter(point => point.x < rect.width / 2)
      const rightPoints = points.filter(point => point.x >= rect.width / 2)
      if (!leftPoints.length || !rightPoints.length) return
      layer.style.top = `${inkTop / ratio}px`
      layer.style.height = `${height}px`
      const colors = ['#42e8ff', '#ff65ce', '#aa86ff']
      const count = 40, leftCount = 32
      const fragment = document.createDocumentFragment()
      for (let index = 0; index < count; index++) {
        const group = index < leftCount ? leftPoints : rightPoints
        const fraction = index < leftCount ? Math.pow((index + .5) / leftCount, 1.35) : (index - leftCount + .5) / (count - leftCount)
        const point = group[Math.floor(fraction * group.length)]
        const size = index % 4 === 0 ? maxSize : maxSize - .5
        const dx = Math.min(4 + index % 4, rect.width + 2 - size - point.x)
        const dy = Math.max(-point.y, Math.min((index % 2 ? 1 : -1) * (1 + index % 3 * .5), height - size - point.y))
        const duration = 1.6 + index % 5 * .17
        const particle = document.createElement('i')
        particle.className = 'scope-picker-auto-particle'
        particle.style.cssText = `left:${point.x}px;top:${point.y}px;--size:${size}px;--color:${colors[index % colors.length]};--dx:${dx}px;--dy:${dy}px;--duration:${duration}s;--delay:${-(index * .151 % duration)}s`
        fragment.append(particle)
      }
      layer.replaceChildren(fragment)
    })
    return () => { cancelled = true; layer.replaceChildren() }
  }, [active])

  return <span className="scope-picker-auto-label"><strong ref={titleRef}>自动归属</strong><span className="scope-picker-auto-particles" ref={layerRef} aria-hidden="true" /></span>
}
