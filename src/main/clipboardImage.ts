import { performance } from 'node:perf_hooks'
import type { NativeImage } from 'electron'

export function copyClipboardImage(dataUrl: unknown, clipboard: {
  decode: (dataUrl: string) => NativeImage
  write: (image: NativeImage) => void
}, report: (sample: Record<string, unknown>) => void): boolean {
  const startedAt = performance.now()
  const sample: Record<string, unknown> = {
    outcome: 'invalid-input', dataUrlChars: typeof dataUrl === 'string' ? dataUrl.length : 0
  }
  let stage = 'decode'
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false
    sample.mime = /^data:(image\/[a-z0-9.+-]{1,64})[;,]/i.exec(dataUrl)?.[1]
    const image = clipboard.decode(dataUrl)
    sample.decodeMs = Math.round(performance.now() - startedAt)
    if (image.isEmpty()) { sample.outcome = 'empty-image'; return false }
    const { width, height } = image.getSize()
    Object.assign(sample, { width, height })
    stage = 'write'
    const writeStartedAt = performance.now()
    clipboard.write(image)
    sample.writeMs = Math.round(performance.now() - writeStartedAt)
    sample.outcome = 'copied'
    return true
  } catch {
    sample.outcome = stage === 'decode' ? 'decode-failed' : 'write-failed'
    return false
  } finally {
    sample.durationMs = Math.round(performance.now() - startedAt)
    try { report(sample) } catch { /* Diagnostics must not change the clipboard result. */ }
  }
}
