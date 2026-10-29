import assert from 'node:assert/strict'
import type { NativeImage } from 'electron'
import { copyClipboardImage } from '../src/main/clipboardImage'

const source = 'data:image/png;base64,private-image-bytes'
const image = { isEmpty: () => false, getSize: () => ({ width: 320, height: 240 }) } as NativeImage
for (const outcome of ['copied', 'invalid-input', 'empty-image', 'decode-failed', 'write-failed']) {
  const samples: Record<string, unknown>[] = []
  let writes = 0
  const copied = copyClipboardImage(outcome === 'invalid-input' ? null : source, {
    decode() {
      if (outcome === 'decode-failed') throw new Error('secret decode detail')
      return outcome === 'empty-image' ? { isEmpty: () => true } as NativeImage : image
    },
    write(value) {
      assert.equal(value, image)
      writes++
      if (outcome === 'write-failed') throw new Error('secret clipboard detail')
    }
  }, sample => samples.push(sample))
  assert.equal(copied, outcome === 'copied')
  assert.equal(samples.length, 1)
  assert.equal(samples[0].outcome, outcome)
  assert.equal(writes, ['copied', 'write-failed'].includes(outcome) ? 1 : 0)
  assert.ok(Number.isFinite(samples[0].durationMs))
  assert.doesNotMatch(JSON.stringify(samples), /private-image-bytes|secret/)
  if (outcome === 'copied') assert.deepEqual([samples[0].width, samples[0].height, samples[0].mime], [320, 240, 'image/png'])
}
assert.equal(copyClipboardImage(source, { decode: () => image, write() {} }, () => { throw new Error('diagnostic unavailable') }), true)
console.log('clipboard-image: copy outcomes, dimensions, timings and content-free diagnostics passed')
