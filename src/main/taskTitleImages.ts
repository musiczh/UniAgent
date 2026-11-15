import { Worker } from 'node:worker_threads'
import type { Attachment } from '../shared/types'

export interface TaskTitleImageBlock { type: 'image'; data: string; mimeType: string }

function encodeImages(load: (name: string) => any): void {
  const { parentPort, workerData } = load('node:worker_threads')
  const fs = load('node:fs')
  try {
    if (workerData.length > 16) throw new Error('标题图片最多支持 16 张')
    let total = 0
    const blocks = workerData.map((image: Attachment) => {
      const file = fs.openSync(image.path, 'r')
      try {
        const metadata = fs.fstatSync(file)
        total += metadata.size
        if (!metadata.isFile() || !metadata.size || total > 8 * 1024 * 1024) throw new Error('标题图片须为合计不超过 8 MiB 的普通文件')
        const bytes = fs.readFileSync(file)
        if (bytes.length !== metadata.size) throw new Error('标题图片读取期间已变化')
        const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
          : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : undefined
        if (!mimeType) throw new Error('标题图片仅支持 PNG、JPEG、GIF 和 WebP')
        return { type: 'image', data: bytes.toString('base64'), mimeType }
      } finally { fs.closeSync(file) }
    })
    parentPort.postMessage({ blocks })
  } catch { parentPort.postMessage({ error: '标题图片无法读取、格式无效或超过大小限制' }) }
}

/** Image reads and base64 encoding stay off Electron's foreground thread. */
export async function taskTitleImageBlocks(images: Attachment[], signal: AbortSignal): Promise<TaskTitleImageBlock[]> {
  signal.throwIfAborted()
  if (!images.length) return []
  const worker = new Worker(`(${encodeImages.toString()})(require)`, { eval: true, workerData: images })
  let abort: () => void = () => {}
  try {
    return await new Promise<TaskTitleImageBlock[]>((resolve, reject) => {
      abort = () => { reject(signal.reason || new Error('标题图片读取已取消')); void worker.terminate() }
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', value => value.error ? reject(new Error(value.error)) : resolve(value.blocks))
      worker.once('error', reject)
      worker.once('exit', code => { if (code !== 0) reject(new Error('标题图片读取进程已退出')) })
      if (signal.aborted) abort()
    })
  } finally { signal.removeEventListener('abort', abort); await worker.terminate() }
}
