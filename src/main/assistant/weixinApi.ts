import { randomBytes, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { WeixinAccount } from './weixinStore'

// Reference: Tencent/openclaw-weixin docs/protocol_zh_CN.md and src/api/api.ts (2.4.10).
export const WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CLIENT_VERSION = '2.4.10'
const MAX_MEDIA_SIZE = 25 * 1024 * 1024
export interface WeixinMedia { encrypt_query_param?: string; aes_key?: string; full_url?: string }
export interface WeixinItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { media?: WeixinMedia; aeskey?: string; mid_size?: number }
  file_item?: { media?: WeixinMedia; file_name?: string; len?: string }
  voice_item?: { text?: string }
}
export interface WeixinMessage {
  message_id?: string; from_user_id?: string; to_user_id?: string; group_id?: string
  message_type?: number; context_token?: string; item_list?: WeixinItem[]
}
export interface WeixinQrStatus {
  status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string
}
export class WeixinApiError extends Error {
  constructor(readonly code: number) { super(code === -14 ? '微信授权已失效，请重新扫码绑定' : `微信请求失败（${code}）`) }
}
export function weixinUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new Error('微信服务返回了不受信任的地址')
  return url.toString()
}

/** uint64 message IDs must survive JavaScript's number precision limit. */
export function parseWeixinJson(raw: string): any {
  return JSON.parse(raw.replace(/("message_id"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'))
}
export class WeixinApi {
  constructor(private request: typeof fetch = fetch) {}
  private async call(path: string, body: unknown, signal: AbortSignal, account?: WeixinAccount, base = WEIXIN_BASE_URL): Promise<any> {
    const headers: Record<string,string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers.AuthorizationType = 'ilink_bot_token'
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')
      if (account) headers.Authorization = `Bearer ${account.token}`
    }
    const url = new URL(path, weixinUrl(account?.baseUrl || base))
    let response: Response
    try {
      response = await this.request(url, { method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(account ? { ...body as object, base_info: { channel_version: CLIENT_VERSION, bot_agent: 'UniAgent/1.0' } } : body),
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]) })
    } catch (error) { if (signal.aborted) throw signal.reason; throw new Error('微信网络请求失败，请检查网络后重试') }
    if (!response.ok) throw new Error(`微信服务暂不可用（HTTP ${response.status}）`)
    let value: any
    try { value = parseWeixinJson(await response.text()) } catch { throw new Error('微信服务返回了无效响应') }
    const code = value.ret || value.errcode
    if (code) throw new WeixinApiError(Number(code))
    return value
  }
  qr(signal: AbortSignal): Promise<{ qrcode: string; qrcode_img_content: string }> {
    return this.call('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, signal)
  }
  qrStatus(qrcode: string, base: string, signal: AbortSignal, code?: string): Promise<WeixinQrStatus> {
    const query = new URLSearchParams({ qrcode, ...(code ? { verify_code: code } : {}) })
    return this.call(`ilink/bot/get_qrcode_status?${query}`, undefined, signal, undefined, base)
  }
  updates(account: WeixinAccount, cursor: string, signal: AbortSignal): Promise<{ msgs?: WeixinMessage[]; get_updates_buf?: string }> {
    return this.call('ilink/bot/getupdates', { get_updates_buf: cursor }, signal, account)
  }
  async send(account: WeixinAccount, contextToken: string, item: WeixinItem, signal: AbortSignal, clientId = randomUUID()): Promise<void> {
    if (!contextToken) throw new Error('尚未收到微信消息，请先在微信中发送一条消息')
    await this.call('ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: account.userId, client_id: clientId,
      message_type: 2, message_state: 2, context_token: contextToken, item_list: [item] } }, signal, account)
  }
  async upload(account: WeixinAccount, bytes: Uint8Array, name: string, image: boolean, signal: AbortSignal): Promise<WeixinItem> {
    if (!bytes.length || bytes.length > MAX_MEDIA_SIZE) throw new Error('微信附件须为非空文件且不超过 25 MB')
    const key = randomBytes(16).toString('hex')
    const encrypted = await mediaCrypto(bytes, key, false)
    const filekey = randomUUID()
    const result = await this.call('ilink/bot/getuploadurl', { filekey, media_type: image ? 1 : 3, to_user_id: account.userId,
      rawsize: bytes.length, rawfilemd5: encrypted.md5, filesize: encrypted.data.length, no_need_thumb: true, aeskey: key }, signal, account)
    const url = result.upload_full_url || `${CDN_URL}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param || '')}&filekey=${encodeURIComponent(filekey)}`
    if (!result.upload_full_url && !result.upload_param) throw new Error('微信未返回附件上传地址')
    const response = await this.request(weixinUrl(url), { method: 'POST', body: new Uint8Array(encrypted.data), headers: { 'Content-Type': 'application/octet-stream' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'error' })
    const param = response.headers.get('x-encrypted-param')
    if (response.status !== 200 || !param) throw new Error('微信附件上传失败，请重试')
    const media = { encrypt_query_param: param, aes_key: Buffer.from(key).toString('base64'), encrypt_type: 1 }
    return image ? { type: 2, image_item: { media, mid_size: encrypted.data.length } } : { type: 4, file_item: { media, file_name: name, len: String(bytes.length) } }
  }
  async download(item: WeixinItem, signal: AbortSignal): Promise<Uint8Array> {
    const media = item.image_item?.media || item.file_item?.media
    if (!media || !media.full_url && !media.encrypt_query_param) throw new Error('微信附件缺少下载信息')
    const url = media.full_url || `${CDN_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param!)}`
    const response = await this.request(weixinUrl(url), { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'error' })
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_MEDIA_SIZE + 16) throw new Error('微信附件下载失败或超过 25 MB')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('微信附件内容为空')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_MEDIA_SIZE + 16) throw new Error('微信附件超过 25 MB')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = Buffer.concat(chunks)
    const key = item.image_item?.aeskey || (media.aes_key ? decodeMediaKey(media.aes_key) : '')
    if (!key && item.image_item) return bytes
    if (!key) throw new Error('微信附件缺少解密信息')
    return (await mediaCrypto(bytes, key, true)).data
  }
}
function decodeMediaKey(value: string): string {
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 16 ? bytes.toString('hex') : bytes.toString('utf8')
}
function mediaCrypto(bytes: Uint8Array, key: string, decrypt: boolean): Promise<{ data: Uint8Array; md5: string }> {
  if (!/^[a-f\d]{32}$/i.test(key)) return Promise.reject(new Error('微信附件密钥无效'))
  // Encryption/hash for large attachments runs off the Electron foreground thread.
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const { createCipheriv, createDecipheriv, createHash } = require('node:crypto');
      try { const bytes = Buffer.from(workerData.bytes); const cipher = (workerData.decrypt ? createDecipheriv : createCipheriv)('aes-128-ecb', Buffer.from(workerData.key, 'hex'), null);
        const data = Buffer.concat([cipher.update(bytes), cipher.final()]); parentPort.postMessage({ data, md5: createHash('md5').update(bytes).digest('hex') });
      } catch { parentPort.postMessage({ error: true }); }`, { eval: true, workerData: { bytes, key, decrypt } })
    worker.once('message', result => result.error ? reject(new Error('微信附件加解密失败')) : resolve(result))
    worker.once('error', () => reject(new Error('微信附件处理失败')))
    worker.once('exit', code => { if (code) reject(new Error('微信附件处理进程退出')) })
  })
}
