import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { taskTitleImageBlocks } from '../src/main/taskTitleImages'

const root = await mkdtemp(join(tmpdir(), 'title-images-'))
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const image = { kind: 'image' as const, path: join(root, 'screenshot.png'), name: 'screenshot.png' }
try {
  await writeFile(image.path, Buffer.from(data, 'base64'))
  assert.deepEqual(await taskTitleImageBlocks([image], new AbortController().signal), [{ type: 'image', data, mimeType: 'image/png' }])
  assert.deepEqual(await taskTitleImageBlocks([], new AbortController().signal), [])
  await assert.rejects(taskTitleImageBlocks([{ ...image, path: join(root, 'missing.png') }], new AbortController().signal), /图片/)
  const invalid = { ...image, path: join(root, 'invalid.png') }
  await writeFile(invalid.path, 'not an image')
  await assert.rejects(taskTitleImageBlocks([invalid], new AbortController().signal), /图片/)
  const oversized = { ...image, path: join(root, 'oversized.png') }
  await writeFile(oversized.path, Buffer.alloc(8 * 1024 * 1024 + 1))
  await assert.rejects(taskTitleImageBlocks([oversized], new AbortController().signal), /图片/)
  await assert.rejects(taskTitleImageBlocks(Array(17).fill(image), new AbortController().signal), /图片/)
  const cancelled = new AbortController()
  const pending = taskTitleImageBlocks([image], cancelled.signal)
  cancelled.abort(new Error('fixture cancelled'))
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(taskTitleImageBlocks([image], cancelled.signal), /cancelled/)
} finally { await rm(root, { recursive: true, force: true }) }
console.log('PASS title image worker: raster bytes, empty input, missing/invalid/oversized files, count limit and cancellation')
