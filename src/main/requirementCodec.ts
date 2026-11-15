import { Worker } from 'node:worker_threads'

// Static worker code: no imported project code, filesystem, model calls or credentials.
const code = `
const { parentPort } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { gzipSync, gunzipSync } = require('node:zlib')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
parentPort.on('message', ({ id, action, value }) => {
  try {
    let result
    if (action === 'pack') {
      const documents = {}, bodies = {}
      for (const [id, doc] of Object.entries(value.documents)) {
        const { content, ...metadata } = doc
        if (typeof content !== 'string' || hash(content) !== metadata.contentHash) throw new Error('需求正文校验失败')
        documents[id] = metadata; bodies[metadata.contentHash] = content
      }
      const revision = hash(documents)
      const text = JSON.stringify({ formatVersion: 2, revision, documents, bodies, operations: value.operations })
      if (Buffer.byteLength(text) > 32000000) throw new Error('需求内容超过存储预算，请归档历史资料')
      result = { revision, text: gzipSync(text).toString('base64') }
    } else if (action === 'unpack') {
      const packed = JSON.parse(gunzipSync(Buffer.from(value.text, 'base64'), { maxOutputLength: 32000000 }).toString())
      if (packed.formatVersion !== 2 || packed.revision !== value.revision || hash(packed.documents) !== value.revision) throw new Error('需求修订损坏')
      for (const doc of Object.values(packed.documents)) {
        const content = packed.bodies[doc.contentHash]
        if (typeof content !== 'string' || hash(content) !== doc.contentHash) throw new Error('需求正文校验失败')
        doc.content = content
      }
      delete packed.bodies
      result = packed
    } else if (action === 'hash') result = hash(value)
    else if (action === 'encode') {
      const revision = hash(value.documents)
      const text = JSON.stringify({ formatVersion: 2, revision, documents: value.documents, operations: value.operations })
      if (Buffer.byteLength(text) > 5000000) throw new Error('需求登记过大，请缩短引用；详细材料使用文件链接')
      result = { revision, text }
    } else if (action === 'decode') {
      if (Buffer.byteLength(value.text) > 5000000) throw new Error('需求登记超过读取预算')
      result = JSON.parse(value.text)
      if (result.formatVersion !== 2 || result.revision !== value.revision || hash(result.documents) !== value.revision) throw new Error('需求修订损坏，未读取到一致快照')
    } else throw new Error('requirement_invalid_codec_action')
    parentPort.postMessage({ id, result })
  } catch (error) { parentPort.postMessage({ id, error: error instanceof SyntaxError ? '需求登记 JSON 损坏' : error.message }) }
})`
let worker: Worker | undefined
let sequence = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

export function requirementCodec<T = any>(action: 'hash' | 'encode' | 'decode' | 'pack' | 'unpack', value: unknown): Promise<T> {
  if (!worker) {
    const next = new Worker(code, { eval: true })
    worker = next
    next.on('message', message => {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result)
      if (!pending.size) next.unref()
    })
    const fail = () => {
      if (worker !== next) return
      worker = undefined
      for (const request of pending.values()) request.reject(new Error('需求后台编解码进程退出，请重试'))
      pending.clear()
    }
    next.on('error', fail); next.on('exit', fail)
    next.unref()
  }
  const target = worker
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    target.ref()
    try { target.postMessage({ id, action, value }) }
    catch (error) { pending.delete(id); if (!pending.size) target.unref(); reject(error) }
  })
}
