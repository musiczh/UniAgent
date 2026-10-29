import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WeixinApi, WeixinApiError, parseWeixinJson, weixinUrl } from '../src/main/assistant/weixinApi'

const calls: Array<{ url: URL; init: RequestInit }> = []
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
let reply: unknown = { ret: 0 }
let encrypted: Uint8Array | undefined
const api = new WeixinApi((async (url, init = {}) => {
  const target = new URL(String(url)); calls.push({ url: target, init })
  if (target.pathname.endsWith('/getuploadurl')) return response({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' })
  if (target.pathname.endsWith('/upload')) { encrypted = init.body as Uint8Array; return new Response('', { headers: { 'x-encrypted-param': 'media-param' } }) }
  if (target.pathname.endsWith('/download')) return new Response(encrypted)
  return response(reply)
}) as typeof fetch)
const signal = new AbortController().signal
const account = { token: 'test-token', botId: 'bot', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' }

reply = { qrcode: 'qr-id', qrcode_img_content: 'https://example.invalid/qr' }
await api.qr(signal)
assert.equal(calls[0].init.method, 'POST')
assert.equal(calls[0].url.searchParams.get('bot_type'), '3')
assert.deepEqual(JSON.parse(String(calls[0].init.body)), { local_token_list: [] })
assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false)
assert.equal(new Headers(calls[0].init.headers).get('AuthorizationType'), 'ilink_bot_token')
await api.qrStatus('qr &?', account.baseUrl, signal, '123456')
assert.equal(calls[1].init.method, 'GET')
assert.equal(calls[1].url.searchParams.get('qrcode'), 'qr &?')
assert.equal(calls[1].url.searchParams.get('verify_code'), '123456')
assert.equal(new Headers(calls[1].init.headers).has('AuthorizationType'), false)
reply = { ret: 0 }
await api.updates(account, 'cursor-1', signal)
assert.equal(new Headers(calls[2].init.headers).get('Authorization'), 'Bearer test-token')
assert.equal(JSON.parse(String(calls[2].init.body)).get_updates_buf, 'cursor-1')
assert.equal(JSON.parse(String(calls[2].init.body)).base_info.bot_agent, 'UniAgent/1.0')
await api.send(account, 'reply-context', { type: 1, text_item: { text: '你好' } }, signal, 'stable-client-id')
const body = JSON.parse(String(calls[3].init.body))
assert.equal(body.msg.to_user_id, 'owner')
assert.equal(body.msg.context_token, 'reply-context')
assert.equal(body.msg.client_id, 'stable-client-id')
await assert.rejects(api.send(account, '', { type: 1 }, signal), /尚未收到/)
assert.equal(parseWeixinJson('{"message_id":18446744073709551615,"text":"hello"}').message_id, '18446744073709551615')
assert.equal(parseWeixinJson('{"text":"\\\"message_id\\\":123"}').text, '"message_id":123')
for (const url of ['http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.invalid','https://user:pass@ilinkai.weixin.qq.com','https://127.0.0.1']) assert.throws(() => weixinUrl(url))
reply = { ret: -14, errmsg: 'sensitive server content' }
await assert.rejects(api.updates(account, '', signal), error => error instanceof WeixinApiError && error.code === -14 && !error.message.includes('sensitive'))

const bytes = Buffer.from('微信附件 round trip')
const item = await api.upload(account, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), 'example.txt', false, signal)
const upload = calls.find(call => call.url.pathname.endsWith('/getuploadurl'))!
assert.equal(JSON.parse(String(upload.init.body)).rawfilemd5, createHash('md5').update(bytes).digest('hex'))
assert.equal(item.file_item?.file_name, 'example.txt')
assert.notDeepEqual(Buffer.from(encrypted!), bytes)
assert.deepEqual(Buffer.from(await api.download(item, signal)), bytes)
await assert.rejects(api.upload(account, new Uint8Array(), 'empty', false, signal), /非空/)
console.log('weixin-api: protocol headers, uint64 IDs, endpoint validation and media round trip passed')
