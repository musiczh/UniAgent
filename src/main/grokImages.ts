import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { resolveUserDataHome } from './userData.ts'
import type { Attachment, UAEvent } from '../shared/types.ts'

export const GROK_PROMPT_MAX_BYTES = 7.5 * 1024 * 1024

type ImageInput = { path?: string; data?: string; mime?: string; name: string }
type StoredImage = { attachment: Attachment; block: { type:'image'; data:string; mimeType:string } }
let storageOperations: Promise<unknown> = Promise.resolve()
function withImageStorage<T>(action: () => Promise<T>): Promise<T> {
  const pending = storageOperations.catch(() => {}).then(action)
  storageOperations = pending
  return pending
}

// Self-contained worker uses macOS ImageIO through sips. Neither decoding nor encoding blocks Electron.
function imageWorker(load: (name: string) => any): void {
  const { parentPort, workerData } = load('node:worker_threads')
  const fs = load('node:fs')
  const path = load('node:path')
  const os = load('node:os')
  const { execFileSync } = load('node:child_process')
  const { createHash } = load('node:crypto')
  let temporary: string | undefined
  try {
    if (process.platform !== 'darwin') throw new Error('当前平台尚未验证 Grok 图片解码')
    const inputs: ImageInput[] = workerData.inputs
    if (inputs.length > 16) throw new Error('单条消息最多支持 16 张 Grok 图片')
    const images: StoredImage[] = []
    let encodedBytes = 0
    temporary = fs.mkdtempSync(path.join(os.tmpdir(),'uniagent-grok-image-'))
    for (const input of inputs) {
      let bytes: Buffer
      if (input.data !== undefined) {
        if (typeof input.data !== 'string' || input.data.length > 4 * Math.ceil(4 * 1024 * 1024 / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new Error('Grok 历史图片编码无效或超过 4 MiB')
        bytes = Buffer.from(input.data,'base64')
      } else {
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.includes('\0')) throw new Error('Grok 图片路径无效')
        const fd = fs.openSync(input.path,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
        try {
          const before = fs.fstatSync(fd)
          if (!before.isFile() || before.size > 4 * 1024 * 1024 || before.size === 0) throw new Error('Grok 图片必须是 4 MiB 以内的普通文件')
          bytes = fs.readFileSync(fd)
          const after = fs.fstatSync(fd)
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) throw new Error('Grok 图片读取期间已变化，请重新选择')
        } finally { fs.closeSync(fd) }
      }
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Grok 单张图片不能超过 4 MiB')
      const format = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
        : ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) ? 'gif'
        : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'webp' : undefined
      if (!format) throw new Error('Grok 图片仅支持 PNG、JPEG、WebP 或 GIF，文件内容与格式必须一致')
      const mime = `image/${format}`
      if (input.mime && input.mime !== mime) throw new Error('Grok 图片 MIME 与实际文件格式不一致')
      const source = path.join(temporary,'source')
      fs.writeFileSync(source,bytes,{mode:0o600})
      const metadata = String(execFileSync('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',source],{timeout:5000,maxBuffer:65536,stdio:['ignore','pipe','pipe']}))
      const width = Number(/pixelWidth:\s*(\d+)/.exec(metadata)?.[1]), height = Number(/pixelHeight:\s*(\d+)/.exec(metadata)?.[1])
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 8 || height < 8 || width * height < 512 || width * height > 16_000_000) throw new Error('Grok 图片边长至少 8 像素，总像素须在 512 到 1600 万之间')
      // Metadata alone can accept a truncated file. Force a complete raster decode before admission.
      execFileSync('/usr/bin/sips',['-s','format','png',source,'--out',path.join(temporary,'decoded.png')],{timeout:10000,maxBuffer:65536,stdio:['ignore','pipe','pipe']})
      const data = bytes.toString('base64')
      encodedBytes += data.length
      if (encodedBytes > 7 * 1024 * 1024) throw new Error('Grok 图片编码总量超过 7 MiB，请减少图片或压缩后重试')
      const digest = createHash('sha256').update(bytes).digest('hex')
      fs.mkdirSync(workerData.root,{recursive:true,mode:0o700})
      const target = path.join(workerData.root,`${digest}.${format}`)
      try { fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600}) }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error
        const fd = fs.openSync(target,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        try { if (!fs.fstatSync(fd).isFile() || !fs.readFileSync(fd).equals(bytes)) throw new Error('Grok 图片存储校验失败') }
        finally { fs.closeSync(fd) }
      }
      fs.utimesSync(target,new Date(),new Date())
      images.push({attachment:{kind:'image',path:target,name:input.name || `image.${format}`,mime},block:{type:'image',data,mimeType:mime}})
    }
    parentPort.postMessage({images})
  } catch (error: any) {
    parentPort.postMessage({error: error?.code ? 'Grok 图片无法读取或解码，请重新选择有效图片' : String(error?.message || error)})
  } finally { if (temporary) fs.rmSync(temporary,{recursive:true,force:true}) }
}

export function grokImageRoot(env: NodeJS.ProcessEnv = {}): string {
  return join(env.UNIAGENT_USER_DATA || (env.HOME ? join(env.HOME,'.uniagent-public') : resolveUserDataHome()),'grok-images')
}

function processImages(inputs: ImageInput[], env: NodeJS.ProcessEnv = {}): Promise<StoredImage[]> {
  if (!inputs.length) return Promise.resolve([])
  return withImageStorage(() => new Promise((resolve,reject) => {
    const worker = new Worker(`(${imageWorker.toString()})(require)`,{eval:true,workerData:{inputs,root:grokImageRoot(env)}})
    worker.once('message',value => value.error ? reject(new Error(value.error)) : resolve(value.images))
    worker.once('error',reject)
    worker.once('exit',code => { if (code) reject(new Error('Grok 图片校验 worker 退出')) })
  }))
}

export async function prepareGrokAttachments(attachments: Attachment[] | undefined, env: NodeJS.ProcessEnv = {}): Promise<Attachment[] | undefined> {
  const images = await processImages((attachments || []).filter(item => item.kind === 'image'),env)
  let index = 0
  return attachments?.map(item => item.kind === 'image' ? images[index++].attachment : item)
}

export async function grokImageBlocks(attachments: Attachment[], env: NodeJS.ProcessEnv = {}): Promise<any[]> {
  return (await processImages(attachments,env)).map(image => image.block)
}

export function assertGrokPromptSize(prompt: any[], sessionId: string): void {
  const bytes = Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:Number.MAX_SAFE_INTEGER,method:'session/prompt',params:{sessionId,prompt}})) + 1
  if (bytes > GROK_PROMPT_MAX_BYTES) throw new Error('Grok 消息编码超过 7.5 MiB，请减少文字或图片后重试')
}

export async function materializeGrokHistoryImages(events: UAEvent[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  for (const event of events) {
    const images = event.payload.grokImages
    if (!Array.isArray(images)) continue
    delete event.payload.grokImages
    try {
      const stored = await processImages(images,env)
      event.payload.attachments = stored.map(image => image.attachment)
    } catch {
      event.payload.text = `${event.payload.text || ''}\n[历史图片无法验证或已超限，未加载预览]`
    }
  }
}

/** Conservative GC: only our content-addressed copies, after a seven-day grace period. */
export async function collectGrokImages(references: ReadonlySet<string>, env: NodeJS.ProcessEnv = {}, now = Date.now()): Promise<void> {
  await withImageStorage(async () => {
  const root = grokImageRoot(env)
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.(png|jpeg|gif|webp)$/.test(name)) continue
    const path = join(root,name)
    if (references.has(path)) continue
    const metadata = await lstat(path).catch(() => undefined)
    if (!metadata?.isFile() || now - metadata.mtimeMs < 7*24*60*60*1000) continue
    const current = await lstat(path).catch(() => undefined)
    if (current?.ino === metadata.ino && current?.mtimeMs === metadata.mtimeMs) await unlink(path).catch(() => {})
  }
  })
}
