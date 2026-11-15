import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { consumeSignInCallback, DashboardClient, expectedRate } from '../monitor/client'
import { Dashboard, FeedbackTable, LogTable, StatsCards } from '../monitor/dashboard'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

assert.equal(expectedRate({ feedback: 0, good: 0 }), '—')
assert.equal(expectedRate({ feedback: 48, good: 45 }), '93.8%')
const storage = new Map<string, string>()
const adapter = { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } }
const requested: string[] = []
const requests: Array<{ url: URL; init: RequestInit }> = []
let allowed = false
const user = { id: 'maintainer-fixture', is_anonymous: false }
const send = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const path = new URL(String(url)).pathname; requested.push(path)
  requests.push({ url: new URL(String(url)), init })
  if (path.endsWith('/user')) return new Response(JSON.stringify(user))
  if (path.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'fixture-refreshed', refresh_token: 'fixture-next', expires_in: 3600, user }))
  if (path.endsWith('/otp') || path.endsWith('/logout')) return new Response('{}')
  if (path.endsWith('/monitor_is_admin')) return new Response(JSON.stringify(allowed))
  if (path.endsWith('/monitor_stats')) return new Response(JSON.stringify({ installations: 1, errors: 0, feedback: 0, good: 0, bad: 0, daily: [] }))
  return new Response(JSON.stringify({ rows: [], total: 0 }))
}) as typeof fetch
const config = { url: 'https://fixture.supabase.co', publishableKey: 'public-fixture' }
const nativeFetch = globalThis.fetch
let browserRequests = 0
try {
  globalThis.fetch = (function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    browserRequests++
    return Promise.resolve(new Response('{}'))
  }) as typeof fetch
  await new DashboardClient(config).sendLink('maintainer@example.com')
  assert.equal(browserRequests, 1, 'default transport calls fetch with its browser global receiver')
} finally { globalThis.fetch = nativeFetch }
const client = new DashboardClient(config, adapter, send)
const query = { days: 7, distribution: '', version: '', search: '', filter: '', offset: 0 }
const callback = () => new URLSearchParams({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: '3600', token_type: 'bearer', type: 'magiclink' })
await assert.rejects(client.load(query), /登录已失效/)
assert.deepEqual(requested, [], 'an unauthenticated page must not request monitoring data')
await assert.rejects(client.sendLink('invalid'), /有效邮箱/)
await assert.rejects(client.sendLink('a'.repeat(250) + '@example.com'), /有效邮箱/)
await client.sendLink(' maintainer@example.com ')
assert.equal(requests[0].url.pathname, '/auth/v1/otp')
assert.deepEqual(JSON.parse(String(requests[0].init.body)), { email: 'maintainer@example.com', create_user: true })
let cleaned = ''
const consumed = consumeSignInCallback(new URL('https://fixture.test/monitor/?view=logs#' + callback() + '&provider_token=provider-fixture'), url => { cleaned = url })!
assert.equal(cleaned, '/monitor/?view=logs', 'credentials must be removed before authentication requests start')
assert.equal(requested.length, 1)
await client.completeSignIn(consumed)
assert.equal(consumed.has('access_token') || consumed.has('refresh_token') || consumed.has('provider_token'), false, 'callback props do not retain credential copies')
assert.equal(requests[1].url.pathname, '/auth/v1/user')
assert.equal(requests[1].init.method, 'GET')
assert.equal(requests[1].init.body, undefined)
assert.equal(new Headers(requests[1].init.headers).get('Authorization'), 'Bearer fixture-access')
assert.equal(client.signedIn(), true)
await assert.rejects(client.load(query), /没有监控看板权限/)
assert.equal(requested.some(path => /monitor_(stats|feedback_page|log_page)$/.test(path)), false, 'non-administrators never fetch private records')
allowed = true
const loaded = await client.load(query)
assert.equal(loaded.stats.installations, 1)
assert.equal(loaded.feedback.total, 0)
assert.equal(new DashboardClient(config, adapter, send).signedIn(), true)
await client.signOut()
assert.equal(client.signedIn(), false); assert.equal(storage.size, 0)
assert.equal(consumeSignInCallback(new URL('https://fixture.test/monitor/#router'), () => assert.fail('normal navigation must be unchanged')), undefined)
const queryCredentials = consumeSignInCallback(new URL('https://fixture.test/?access_token=fixture-access&refresh_token=fixture-refresh#expires_in=3600&token_type=bearer'), url => { cleaned = url })!
assert.equal(cleaned, '/')
assert.equal(queryCredentials.get('error'), 'invalid_callback', 'credential query parameters are not accepted')
const blockedCleanup = consumeSignInCallback(new URL('https://fixture.test/#' + callback()), () => { throw new Error('blocked') })!
assert.equal(blockedCleanup.get('error'), 'url_cleanup_failed')
const failedLink = consumeSignInCallback(new URL('https://fixture.test/?keep=1#error=access_denied&error_code=otp_expired&error_description=untrusted-message'), url => { cleaned = url })!
assert.equal(cleaned, '/?keep=1')
const invalid: URLSearchParams[] = [queryCredentials, blockedCleanup, failedLink]
for (const [name, value] of [['expires_in', '0'], ['expires_in', 'invalid'], ['expires_in', '1.5'], ['expires_at', '1'], ['token_type', 'invalid'], ['type', 'invite'], ['access_token', 'bad\r\nheader']] as const) {
  const params = callback(); params.set(name, value); invalid.push(params)
}
for (const name of ['access_token', 'refresh_token', 'expires_in']) { const params = callback(); params.delete(name); invalid.push(params) }
for (const params of invalid) {
  const before = requested.length
  await assert.rejects(client.completeSignIn(params), error => error instanceof Error && /链接已失效或无效/.test(error.message) && !error.message.includes('untrusted-message'))
  assert.equal(requested.length, before, 'invalid callbacks must not contact Auth or fetch monitoring data')
  assert.equal(client.signedIn(), false); assert.equal(storage.size, 0)
}
const signup = callback(); signup.set('type', 'signup')
await client.completeSignIn(signup)
assert.equal(client.signedIn(), true, 'first-time confirmation links are supported')
await assert.rejects(client.completeSignIn(failedLink), /链接已失效/)
assert.equal(client.signedIn(), false, 'an invalid callback cannot fall back to a previously signed-in account')
for (const authUser of [{ id: 'anonymous-fixture', is_anonymous: true }, { is_anonymous: false }]) {
  const anonymous = new DashboardClient(config, adapter, (async () => new Response(JSON.stringify(authUser))) as typeof fetch)
  await assert.rejects(anonymous.completeSignIn(callback()), /未能建立维护者登录/)
  assert.equal(anonymous.signedIn(), false); assert.equal(storage.size, 0)
}
const forged = new DashboardClient(config, adapter, (async () => new Response(JSON.stringify({ error_description: 'untrusted-response' }), { status: 401 })) as typeof fetch)
await assert.rejects(forged.completeSignIn(callback()), error => error instanceof Error && /链接已失效/.test(error.message) && !error.message.includes('untrusted-response'))
assert.equal(forged.signedIn(), false)
const throttled = new DashboardClient(config, undefined, (async () => new Response('{}', { status: 429 })) as typeof fetch)
await assert.rejects(throttled.sendLink('maintainer@example.com'), /请求过于频繁/)
const unauthorizedMail = new DashboardClient(config, undefined, (async () => new Response('{}', { status: 422 })) as typeof fetch)
await assert.rejects(unauthorizedMail.sendLink('maintainer@example.com'), /邮箱是否具有看板访问资格/)
const brokenStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
const memoryOnly = new DashboardClient(config, brokenStorage, send)
await memoryOnly.completeSignIn(callback())
assert.equal(memoryOnly.signedIn(), true)
await memoryOnly.signOut(); assert.equal(memoryOnly.signedIn(), false)
const renewing = new DashboardClient(config, adapter, send)
const nearExpiry = callback(); nearExpiry.set('expires_at', String(Math.floor(Date.now() / 1000) + 30))
await renewing.completeSignIn(nearExpiry)
assert.equal((await renewing.load(query)).stats.installations, 1)
assert.equal(JSON.parse(adapter.getItem('uniagent-monitor-session-v1')!).access_token, 'fixture-refreshed', 'email-link sessions refresh normally')
await renewing.signOut()
let completeUser!: (response: Response) => void
const slow = new DashboardClient(config, adapter, (() => new Promise<Response>(resolve => { completeUser = resolve })) as typeof fetch)
const pendingSignIn = slow.completeSignIn(callback())
await slow.signOut()
completeUser(new Response(JSON.stringify(user)))
await assert.rejects(pendingSignIn, /登录已失效/)
assert.equal(slow.signedIn(), false); assert.equal(storage.size, 0)
let completeRefresh!: (response: Response) => void
const refreshRace = new DashboardClient(config, adapter, (async (url, init) => String(url).includes('/token?')
  ? new Promise<Response>(resolve => { completeRefresh = resolve }) : send(url, init)) as typeof fetch)
const expiring = callback(); expiring.set('expires_at', String(Math.floor(Date.now() / 1000) + 30))
await refreshRace.completeSignIn(expiring)
const pendingLoad = refreshRace.load(query)
await refreshRace.signOut()
completeRefresh(new Response(JSON.stringify({ access_token: 'fixture-refreshed', refresh_token: 'fixture-next', expires_in: 3600, user })))
await assert.rejects(pendingLoad, /登录已失效/)
assert.equal(refreshRace.signedIn(), false); assert.equal(storage.size, 0)
let finishOldRequest!: (response: Response) => void
const staleRequest = new DashboardClient(config, adapter, (async (url, init) => String(url).endsWith('/monitor_is_admin')
  ? new Promise<Response>(resolve => { finishOldRequest = resolve }) : send(url, init)) as typeof fetch)
await staleRequest.completeSignIn(callback())
const oldLoad = staleRequest.load(query)
const replacement = callback(); replacement.set('access_token', 'fixture-replacement')
await staleRequest.completeSignIn(replacement)
finishOldRequest(new Response('{}', { status: 401 }))
await assert.rejects(oldLoad, /登录已失效/)
assert.equal(staleRequest.signedIn(), true, 'a late 401 from an older session cannot clear the newer login')
await staleRequest.signOut()
const offline = new DashboardClient(config, undefined, (async () => { throw new Error('offline') }) as typeof fetch)
assert.equal(offline.signedIn(), false)
// Independent tab stores communicate through the real BroadcastChannel implementation.
const tabStore = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const passwordStore = tabStore(), persistentStore = tabStore()
const passwordCalls: Array<{ url: URL; method: string; body: any; authorization: string | null }> = []
let passwordNow = 1_000_000
let invalidPasswordUpdate = false
const passwordSend = (async (input, init = {}) => {
  const url = new URL(String(input)), body = JSON.parse(String(init.body || '{}'))
  passwordCalls.push({ url, method: init.method || 'GET', body, authorization: new Headers(init.headers).get('Authorization') })
  if (url.pathname.endsWith('/token')) return new Response(JSON.stringify({ access_token: url.searchParams.get('grant_type') === 'password' ? 'fixture-password-access' : 'fixture-password-refreshed', refresh_token: 'fixture-password-refresh', expires_in: 3600, user }))
  if (url.pathname.endsWith('/user') && init.method === 'PUT' && invalidPasswordUpdate) return new Response('{}')
  return send(input, init)
}) as typeof fetch
const passwordClient = new DashboardClient(config, passwordStore, passwordSend, () => passwordNow, persistentStore)
await passwordClient.signInPassword(' maintainer@example.com ', ' fixture-password ', true)
assert.equal(passwordCalls[0].url.search, '?grant_type=password')
assert.deepEqual(passwordCalls[0].body, { email: 'maintainer@example.com', password: ' fixture-password ' }, 'password whitespace is significant')
assert.equal(passwordCalls.some(call => /\/(otp|recover)$/.test(call.url.pathname)), false, 'ordinary password login never sends mail')
assert.ok(persistentStore.getItem('uniagent-monitor-session-v1'))
assert.equal(persistentStore.getItem('uniagent-monitor-session-v1')!.includes(' fixture-password '), false, 'remember login stores tokens, never the password')
passwordNow += 3700_000
const reopened = new DashboardClient(config, tabStore(), passwordSend, () => passwordNow, persistentStore)
assert.equal(reopened.signedIn(), true, 'closing every tab still allows the remembered session to be restored')
await reopened.load(query)
assert.equal(passwordCalls.some(call => call.url.searchParams.get('grant_type') === 'refresh_token'), true, 'expired remembered sessions refresh before private reads')
await reopened.signOut()
assert.equal(persistentStore.getItem('uniagent-monitor-session-v1'), null)
assert.equal(new DashboardClient(config, passwordStore, passwordSend, () => passwordNow, persistentStore).signedIn(), false, 'a stale tab store cannot resurrect a remembered login after logout')
await passwordClient.signInPassword('maintainer@example.com', 'fixture-password', false)
assert.equal(persistentStore.getItem('uniagent-monitor-session-v1'), null)
assert.equal(new DashboardClient(config, tabStore(), passwordSend, () => passwordNow, persistentStore).signedIn(), false, 'unchecked remember login stays within the current tab')
await passwordClient.signOut()
await passwordClient.sendRecovery(' maintainer@example.com ')
assert.equal(passwordCalls.at(-1)!.url.pathname, '/auth/v1/recover')
assert.deepEqual(passwordCalls.at(-1)!.body, { email: 'maintainer@example.com' })
const recovery = callback(); recovery.set('type', 'recovery')
await passwordClient.completeSignIn(recovery)
assert.equal(passwordClient.needsPassword(), true)
assert.equal(persistentStore.getItem('uniagent-monitor-session-v1'), null, 'recovery sessions are never kept across browser restarts')
const recoveryReload = new DashboardClient(config, passwordStore, passwordSend, () => passwordNow, persistentStore)
assert.equal(recoveryReload.needsPassword(), true, 'refreshing a recovery page must retain the password setup step')
const beforeSetup = passwordCalls.length
await assert.rejects(passwordClient.load(query), /先完成密码设置/)
await assert.rejects(passwordClient.updatePassword('short', 'short'), /至少/)
await assert.rejects(passwordClient.updatePassword('fixture-new-password', 'different'), /一致/)
assert.equal(passwordCalls.length, beforeSetup, 'private queries and invalid password submissions never leave the client during recovery')
const setupMarkup = renderToStaticMarkup(<Dashboard client={passwordClient}/>)
assert.ok(setupMarkup.includes('设置登录密码')); assert.ok(!setupMarkup.includes('反馈原因'))
invalidPasswordUpdate = true
await assert.rejects(passwordClient.updatePassword('fixture-new-password', 'fixture-new-password'), /未能建立维护者登录/)
assert.equal(passwordClient.needsPassword(), true, 'an invalid update response cannot skip password setup')
invalidPasswordUpdate = false
await passwordClient.updatePassword('fixture-new-password', 'fixture-new-password')
assert.equal(passwordCalls.at(-1)!.method, 'PUT')
assert.equal(passwordCalls.at(-1)!.url.pathname, '/auth/v1/user')
assert.deepEqual(passwordCalls.at(-1)!.body, { password: 'fixture-new-password' })
assert.ok(passwordCalls.at(-1)!.authorization?.startsWith('Bearer '))
assert.equal(passwordClient.needsPassword(), false)
assert.equal(passwordStore.getItem('uniagent-monitor-session-v1')!.includes('fixture-new-password'), false)
await passwordClient.load(query)
await passwordClient.signOut()
const revokedStore = tabStore()
revokedStore.setItem('uniagent-monitor-session-v1', JSON.stringify({ access_token: 'fixture-revoked', refresh_token: 'fixture-revoked-refresh', expires_at: 1, remember: true }))
const revoked = new DashboardClient(config, tabStore(), (async () => new Response('{}', { status: 400 })) as typeof fetch, Date.now, revokedStore)
await assert.rejects(revoked.load(query), /登录已失效/)
assert.equal(revoked.signedIn(), false, 'a rejected refresh returns remembered sessions to the login screen')
assert.equal(revokedStore.getItem('uniagent-monitor-session-v1'), null)
const peerPersistent = tabStore()
const rememberedPeer = new DashboardClient(config, tabStore(), passwordSend, Date.now, peerPersistent)
await rememberedPeer.signInPassword('maintainer@example.com', 'fixture-password', true)
const oldTab = new BroadcastChannel('uniagent-monitor-auth-v1:' + config.url)
let stopRememberedPeer = () => {}
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('peer logout did not settle')), 3000)
    stopRememberedPeer = rememberedPeer.connectSync(checking => { if (!checking) { clearTimeout(timeout); resolve() } })
    oldTab.postMessage({ type: 'sign-out' })
  })
  assert.equal(peerPersistent.getItem('uniagent-monitor-session-v1'), null, 'logout from a tab without persistent storage also clears remembered peer credentials')
} finally { stopRememberedPeer(); oldTab.close() }
for (const status of [400, 401]) {
  const wrongPassword = new DashboardClient(config, tabStore(), (async () => new Response('{}', { status })) as typeof fetch)
  await assert.rejects(wrongPassword.signInPassword('maintainer@example.com', 'fixture-wrong-password', true), /邮箱或密码/)
  assert.equal(wrongPassword.signedIn(), false)
}
let finishPassword!: (response: Response) => void
const passwordRace = new DashboardClient(config, passwordStore, (() => new Promise<Response>(resolve => { finishPassword = resolve })) as typeof fetch, Date.now, persistentStore)
const pendingPassword = passwordRace.signInPassword('maintainer@example.com', 'fixture-password', true)
await passwordRace.signOut()
finishPassword(new Response(JSON.stringify({ access_token: 'fixture-password-access', refresh_token: 'fixture-password-refresh', expires_in: 3600, user })))
await assert.rejects(pendingPassword, /登录已失效/)
assert.equal(passwordRace.signedIn(), false); assert.equal(persistentStore.getItem('uniagent-monitor-session-v1'), null)
const waitingStore = tabStore(), callbackStore = tabStore()
let expiredRemote = false
const tabSend = (async (url, init) => expiredRemote && String(url).endsWith('/monitor_is_admin') ? new Response('{}', { status: 401 }) : send(url, init)) as typeof fetch
const waitingTab = new DashboardClient(config, waitingStore, tabSend), callbackTab = new DashboardClient(config, callbackStore, tabSend)
let changed!: (verifying: boolean, error?: Error) => void
const stopWaiting = waitingTab.connectSync((verifying, error) => changed?.(verifying, error))
const stopCallback = callbackTab.connectSync(() => {})
const settled = (action: () => void | Promise<void>) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('cross-tab state did not settle')), 3000)
  changed = (verifying, error) => { if (!verifying) { clearTimeout(timeout); error ? reject(error) : resolve() } }
  Promise.resolve(action()).catch(error => { clearTimeout(timeout); reject(error) })
})
try {
  await waitingTab.sendLink('maintainer@example.com')
  assert.equal(waitingTab.signedIn(), false)
  const beforeSync = requests.length
  await settled(() => callbackTab.completeSignIn(callback()))
  assert.equal(waitingTab.signedIn(), true, 'the original waiting tab receives the verified email-link session')
  assert.equal(JSON.parse(waitingStore.getItem('uniagent-monitor-session-v1')!).access_token, 'fixture-access')
  assert.ok(requests.slice(beforeSync).filter(request => request.url.pathname.endsWith('/user')).length >= 2, 'the receiving tab independently checks Auth')
  assert.ok(requests.slice(beforeSync).some(request => request.url.pathname.endsWith('/monitor_is_admin')), 'the receiving tab checks administrator access before becoming signed in')
  assert.equal((await waitingTab.load(query)).stats.installations, 1)
  const soon = callback(); soon.set('access_token', 'fixture-soon'); soon.set('expires_at', String(Math.floor(Date.now() / 1000) + 30))
  await settled(() => callbackTab.completeSignIn(soon))
  await settled(() => callbackTab.load(query).then(() => {}))
  assert.equal(JSON.parse(waitingStore.getItem('uniagent-monitor-session-v1')!).access_token, 'fixture-refreshed', 'refreshed credentials reach the waiting tab without a broadcast loop')
  const lateTab = new DashboardClient(config, tabStore(), send)
  let stopLate = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('late tab did not find the active session')), 3000)
      stopLate = lateTab.connectSync((verifying, error) => { if (!verifying) { clearTimeout(timeout); error ? reject(error) : resolve() } })
    })
    assert.equal(lateTab.signedIn(), true, 'a tab opened after verification requests the existing peer session')
  } finally { stopLate() }
  expiredRemote = true
  await settled(() => assert.rejects(callbackTab.load(query), /登录已失效/))
  assert.equal(waitingTab.signedIn(), false, 'server rejection invalidates the peer session as well')
  assert.equal(callbackTab.signedIn(), false)
  expiredRemote = false
  await settled(() => callbackTab.completeSignIn(callback()))
  await settled(() => callbackTab.signOut())
  assert.equal(waitingTab.signedIn(), false, 'logout clears all connected tabs')
  assert.equal(waitingStore.getItem('uniagent-monitor-session-v1'), null)
} finally { stopWaiting(); stopCallback() }
const isolatedConfig = { ...config, url: 'https://sync-validation.supabase.co' }
let rejectAdmin = true, anonymousPeer = false, finishPeerUser: ((response: Response) => void) | undefined
const peerPaths: string[] = []
const peerSend = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname; peerPaths.push(path)
  if (path.endsWith('/user')) return finishPeerUser === undefined
    ? new Response(JSON.stringify({ ...user, is_anonymous: anonymousPeer }))
    : new Promise<Response>(resolve => { finishPeerUser = resolve })
  if (path.endsWith('/monitor_is_admin')) return new Response(JSON.stringify(!rejectAdmin))
  throw new Error('private data must not be requested during session verification')
}) as typeof fetch
const peerStore = tabStore(), peer = new DashboardClient(isolatedConfig, peerStore, peerSend)
const publisher = new BroadcastChannel('uniagent-monitor-auth-v1:' + isolatedConfig.url)
let peerChanged!: (verifying: boolean, error?: Error) => void
const stopPeer = peer.connectSync((verifying, error) => peerChanged?.(verifying, error))
const peerEvent = (action: () => void, checking = false) => new Promise<Error | undefined>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('peer validation did not settle')), 3000)
  peerChanged = (verifying, error) => { if (verifying === checking) { clearTimeout(timeout); resolve(error) } }
  action()
})
const shared = { access_token: 'fixture-peer', refresh_token: 'fixture-peer-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }
try {
  const denied = await peerEvent(() => {
    for (const session of [{ ...shared, expires_at: 1 }, { ...shared, access_token: 'bad\r\nheader' }, { ...shared, refresh_token: 1 }, {}]) publisher.postMessage({ type: 'session', session })
    publisher.postMessage({ type: 'session', session: shared })
  })
  assert.match(denied!.message, /没有监控看板权限/)
  assert.deepEqual(peerPaths, ['/auth/v1/user', '/rest/v1/rpc/monitor_is_admin'], 'malformed/expired messages never contact Auth and only the valid candidate is checked')
  assert.equal(peer.signedIn(), false); assert.equal(peerStore.getItem('uniagent-monitor-session-v1'), null)
  anonymousPeer = true; peerPaths.length = 0
  assert.match((await peerEvent(() => publisher.postMessage({ type: 'session', session: shared })))!.message, /未能建立维护者登录/)
  assert.deepEqual(peerPaths, ['/auth/v1/user'], 'anonymous sessions never reach administrator or record queries')
  anonymousPeer = false; rejectAdmin = false
  finishPeerUser = () => {}
  await peerEvent(() => publisher.postMessage({ type: 'session', session: shared }), true)
  await peerEvent(() => publisher.postMessage({ type: 'sign-out' }))
  finishPeerUser!(new Response(JSON.stringify(user)))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peer.signedIn(), false, 'logout prevents a late peer Auth response from restoring the session')
  assert.equal(peerStore.getItem('uniagent-monitor-session-v1'), null)
} finally { stopPeer(); publisher.close() }
const unsafe = '<img src=x onerror=alert(1)>'
const feedback = renderToStaticMarkup(<FeedbackTable rows={[{ owner_id: 'installation', event_id: 'event', request_key: 'request', attempt_key: 'attempt', revision: 1, saved_at: new Date().toISOString(), distribution: 'public', app_version: '1.1.0', matches: false, reason: unsafe, actual_action: 'reuse_task' }]} open={() => {}}/>)
assert.ok(feedback.includes('&lt;img')); assert.ok(!feedback.includes('<img'))
const log = renderToStaticMarkup(<LogTable rows={[{ owner_id: 'installation', event_id: 'event', occurred_at: new Date().toISOString(), category: 'diagnostic', distribution: 'public', app_version: '1.1.0', agent_id: 'codex', level: 'error', code: unsafe, payload: { message: unsafe } }]}/>)
assert.ok(log.includes('&lt;img')); assert.ok(!log.includes('<img'))
const signedOut = renderToStaticMarkup(<Dashboard client={client}/>)
assert.ok(signedOut.includes('登录监控看板')); assert.ok(!signedOut.includes('反馈原因'))
assert.ok(signedOut.includes('current-password')); assert.ok(signedOut.includes('保持登录')); assert.ok(signedOut.includes('使用邮件链接登录')); assert.ok(!signedOut.includes('邮件验证码'))
const pending = renderToStaticMarkup(<Dashboard client={client} callback={callback()}/>)
assert.ok(pending.includes('正在验证登录')); assert.ok(!pending.includes('反馈原因'))
assert.ok(renderToStaticMarkup(<StatsCards stats={loaded.stats}/>).includes('—'))
const root = await mkdtemp(join(tmpdir(), 'uniagent-monitor-site-'))
try {
  const { buildMonitor } = await import(pathToFileURL(resolve('scripts/build-monitor.mjs')).href)
  const first = await buildMonitor(root), html = await readFile(join(root, 'index.html'), 'utf8')
  assert.equal(first.files.length, 3)
  for (const file of first.files) assert.ok((await readFile(join(root, file))).length > 0)
  assert.ok(!html.includes('./dashboard.js')); assert.ok(html.includes("script-src 'self'"))
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.files.sort(), first.files.sort())
  assert.ok(!html.includes('fixture-access'))
} finally { await rm(root, { recursive: true, force: true }) }
console.log('cloud monitor dashboard: authentication, permissions, escaping, build passed')
