import type { FrameHealthReply } from '../shared/frameHealth'

/** Two consecutive frames distinguish a live source from a synthetic MISSED frame. */
export function createFrameProbe(
  window: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>,
  document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>,
  reply: (message: FrameHealthReply) => void
): { probe: (id: unknown) => void; dispose: () => void } {
  let frame: number | undefined
  let current: number | undefined
  const cancel = (): void => {
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    frame = undefined
  }
  const visibilityChanged = (): void => {
    if (!document.hidden) return
    cancel()
    if (current !== undefined) reply({ id: current, kind: 'hidden' })
  }
  document.addEventListener('visibilitychange', visibilityChanged)
  return {
    dispose() { cancel(); current = undefined; document.removeEventListener('visibilitychange', visibilityChanged) },
    probe(id) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return
      cancel()
      current = id
      reply({ id, kind: document.hidden ? 'hidden' : 'responsive' })
      if (document.hidden) return
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = undefined
          reply({ id, kind: document.hidden ? 'hidden' : 'painted' })
        })
      })
    }
  }
}
