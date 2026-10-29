import assert from 'node:assert/strict'
import { DeepSeekAccountService, type DeepSeekAccountClient } from '../src/main/deepseekAccountService.ts'

const view = (phase: string, status = 'signed-out', extra = {}) => ({ status, attempt: { id: 'attempt-1', phase, ...extra } })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
  let current: any = { status: 'signed-out', attempt: null }
  let initial: any = view('initializing')
  let releaseStart: (() => void) | undefined
  let waitStart = false
  let failOpen = false
  let failCancel = false
  let focused = 0
  let changed = 0
  const opened: string[] = []
  const calls: { method: string; args: any }[] = []
  const queue: any[] = []
  let wake: (() => void) | undefined
  const publish = (value: any) => { current = value; queue.push(value); wake?.() }
  const client: DeepSeekAccountClient = {
    callbackOrigin: 'http://127.0.0.1:12345',
    async call<T>(method: string, args?: any): Promise<T> {
      calls.push({ method, args })
      if (method === 'account/startSignIn') {
        if (waitStart) await new Promise<void>(resolve => { releaseStart = resolve })
        return (current = initial) as T
      }
      if (method === 'account/cancelSignIn') { if (failCancel) throw new Error('fixture transport closed'); publish(view('cancelled')); return current }
      if (method === 'account/hasRunningAccountTasks') return false as T
      if (method === 'account/signOut') current = { status: 'signed-out', attempt: null }
      return current as T
    },
    async *stream<T>(_method: string, _args?: any, signal?: AbortSignal): AsyncGenerator<T> {
      yield current as T
      const abort = () => wake?.()
      signal?.addEventListener('abort', abort)
      try {
        while (!signal?.aborted) {
          if (queue.length) {
            const value = queue.shift()
            if (value instanceof Error) throw value
            yield value as T
          }
          else await new Promise<void>(resolve => { wake = resolve })
        }
      } finally { signal?.removeEventListener('abort', abort) }
    }
  }
  const service = new DeepSeekAccountService({
    client: async () => client,
    metadata: () => ({ version: '1.0.9', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }),
    openBrowser: async url => { if (failOpen) throw new Error('private failure'); opened.push(url) },
    changed: () => { changed++ }, authenticated: () => { focused++ }
  })
  return { service, publish, opened, calls, focused: () => focused, changed: () => changed,
    initial: (value: any) => { initial = value }, blockStart: () => { waitStart = true }, release: () => releaseStart!(), failOpen: () => { failOpen = true },
    disconnect: () => { failCancel = true; queue.push(new Error('fixture stream closed')); wake?.() } }
}

{
  const f = fixture()
  assert.deepEqual(await f.service.refresh(), { supported: true, signedIn: false, phase: undefined })
  const login = f.service.start()
  assert.equal(f.service.start(), login, 'double clicks share one native attempt')
  await tick()
  assert.equal(f.service.snapshot().signedIn, false)
  f.publish(view('waiting-browser', 'signed-out', { authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?id=fixture' }))
  await tick()
  assert.equal(f.opened.length, 1)
  await f.service.reopen(); assert.equal(f.opened.length, 2)
  assert.equal(f.focused(), 0, 'opening the browser cannot signal authentication')
  assert.equal(f.service.snapshot().signedIn, false)
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /authorize|fixture|attempt-1/, 'IPC projection contains no authorization URL or private attempt ID')
  f.publish(view('exchanging')); await tick()
  assert.equal(f.focused(), 0)
  f.publish(view('succeeded', 'credential-stored'))
  assert.equal((await login).signedIn, true)
  assert.equal(f.focused(), 1)
  assert.deepEqual(f.calls.find(call => call.method === 'account/startSignIn')?.args, {
    client: { version: '1.0.9', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }, callbackOrigin: 'http://127.0.0.1:12345', loginSource: 'desktop'
  })
  assert.equal((await f.service.signOut()).signedIn, false)
  await f.service.close()
}
{
  const f = fixture()
  f.blockStart()
  const login = f.service.start()
  const rejected = assert.rejects(login, /取消/)
  await tick(); await f.service.cancel(); f.release()
  await rejected
  assert.equal(f.opened.length, 0, 'cancel while initialization is pending prevents the browser opening')
  f.publish(view('succeeded', 'credential-stored')); await tick()
  assert.equal(f.focused(), 0, 'a late event after cancellation cannot report success')
  assert.equal(f.service.snapshot().phase, 'cancelled')
  await f.service.close()
}
for (const [phase, expected] of [['failed', /授权失败/], ['expired', /超时/], ['cancelled', /取消/]] as const) {
  const f = fixture(); f.initial(view(phase))
  await assert.rejects(f.service.start(), expected)
  assert.equal(f.focused(), 0)
  await f.service.close()
}
for (const url of ['javascript:alert(1)', 'https://evil.example/dsh/authorize', 'https://platform.deepseek.com.evil.example/dsh/authorize', 'https://user:pass@platform.deepseek.com/dsh/authorize', 'https://platform.deepseek.com/other']) {
  const f = fixture(); f.initial(view('waiting-browser', 'signed-out', { authorizeUrl: url }))
  await assert.rejects(f.service.start(), /授权地址无效/)
  assert.equal(f.opened.length, 0)
  assert.ok(f.calls.some(call => call.method === 'account/cancelSignIn'))
  await f.service.close()
}
{
  const f = fixture(); f.initial(view('waiting-browser', 'signed-out', { authorizeUrl: 'https://platform.deepseek.com/dsh/authorize' })); f.failOpen()
  const login = f.service.start(); const cancelled = assert.rejects(login, /取消/); await tick()
  assert.equal(f.service.snapshot().phase, 'waiting-browser', 'failed browser launch retains the attempt')
  await assert.rejects(f.service.reopen(), /无法打开默认浏览器/)
  await f.service.cancel(); await cancelled
  assert.equal(f.service.snapshot().phase, 'cancelled')
  await assert.rejects(f.service.reopen(), /尚未就绪|过期/)
  await f.service.close()
}
{
  const f = fixture(); f.initial(view('succeeded'))
  await assert.rejects(f.service.start(), /未保存/)
  assert.equal(f.focused(), 0)
  await f.service.close()
}
{
  const f = fixture()
  const login = f.service.start()
  const failure = assert.rejects(login, /stream closed/)
  await tick(); f.disconnect(); await failure
  assert.equal(f.service.snapshot().phase, 'failed', 'a dead Host must not leave a permanent waiting-browser state')
  assert.equal(f.service.busy, false)
  assert.equal(f.focused(), 0)
  await f.service.close()
}
console.log('deepseek-account: native login, singleflight, callback success, cancellation, expiry, failed browser and URL boundary passed')
