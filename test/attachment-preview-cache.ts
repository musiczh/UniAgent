import assert from 'node:assert/strict'
import { cacheAttachmentPreview, getCachedAttachmentPreview } from '../src/renderer/hooks'

const image = 'data:image/png;base64,' + 'x'.repeat(1024 * 1024)
cacheAttachmentPreview('recent', image)
for (let index = 0; index < 40; index++) {
  cacheAttachmentPreview(`image-${index}`, image)
  getCachedAttachmentPreview('recent')
}
assert.equal(getCachedAttachmentPreview('image-0'), undefined, 'old images must be evicted')
assert.equal(getCachedAttachmentPreview('recent'), image, 'access refreshes recency')
assert.equal(getCachedAttachmentPreview('image-39'), image)
cacheAttachmentPreview('oversized', 'x'.repeat(32 * 1024 * 1024))
assert.equal(getCachedAttachmentPreview('oversized'), undefined, 'one large image cannot flush the cache')
assert.equal(getCachedAttachmentPreview('recent'), image)
