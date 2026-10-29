import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinStore } from '../src/main/assistant/weixinStore'
import { WeixinBridge } from '../src/main/assistant/weixinBridge'
import type { WeixinApi } from '../src/main/assistant/weixinApi'

const root = await mkdtemp(join(tmpdir(),'uniagent-weixin-login-'))
const original = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const wait = async (condition: () => boolean) => { for (let i = 0; i < 600; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve,5)) } throw new Error('login state timed out') }
const bridges: WeixinBridge[] = []
try {
  const statuses: string[] = []
  const store = new WeixinStore(join(root,'account.json'))
  const api = {
    async qr() { return { qrcode: 'qr-id',qrcode_img_content: 'qr-content' } },
    async qrStatus(qrcode: string, _base: string, _signal: AbortSignal, code?: string) {
      assert.equal(qrcode,'qr-id')
      return code ? { status: 'confirmed',bot_token: 'test-secret-token',ilink_bot_id: 'bot',ilink_user_id: 'owner',baseurl: 'https://ilinkai.weixin.qq.com' } : { status: 'need_verifycode' }
    },
    async updates(_account: unknown, _cursor: string, signal: AbortSignal) {
      if (!statuses.includes('connected')) return { msgs: [] }
      return new Promise((_, reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}))
    }
  } as unknown as WeixinApi
  const create = (store: WeixinStore, api: WeixinApi) => {
    const bridge = new WeixinBridge({ store,api,orchestrator: { getEvents: async () => [] } as any,
      attachmentsDirectory: root, async createSession() { throw new Error('not used') }, async command() { throw new Error('not used') },
      onState() { statuses.push(bridge.getState().phase) }, onError(error) { throw new Error(error) } })
    bridges.push(bridge); return bridge
  }
  const bridge = create(store,api)
  assert.equal((await bridge.login()).qrContent,'qr-content')
  await wait(() => bridge.getState().phase === 'awaiting-code')
  assert.throws(() => bridge.verify(''), /配对码/)
  bridge.verify('123456')
  await wait(() => bridge.getState().phase === 'connected')
  assert.equal(bridge.getState().qrContent,undefined)
  assert.equal(store.get().account?.token,'test-secret-token')
  assert.ok(!JSON.stringify(bridge.getState()).includes('test-secret-token'),'renderer never receives the token')
  await bridge.disconnect()

  let resolveQr!: (value: unknown) => void
  const delayedStore = new WeixinStore(join(root,'delayed.json'))
  const delayed = create(delayedStore,{ qr: () => new Promise(resolve => { resolveQr = resolve }) } as unknown as WeixinApi)
  const login = delayed.login()
  await wait(() => !!resolveQr)
  await delayed.disconnect()
  resolveQr({ qrcode: 'stale',qrcode_img_content: 'stale-content' })
  await login
  assert.equal(delayed.getState().phase,'idle','cancelled QR responses cannot revive login')
  assert.equal(delayedStore.get().account,undefined)
  console.log('weixin-login: pairing code, credential privacy and cancellation races passed')
} finally {
  await Promise.all(bridges.map(bridge => bridge.close()))
  if (original === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = original
  await rm(root,{recursive:true,force:true})
}
