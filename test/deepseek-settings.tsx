import assert from 'node:assert/strict'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeepSeekSettings } from '../src/renderer/components/DeepSeekSettings'
import { DEEPSEEK_BASE_URL, type DeepSeekConnectionInput, type DeepSeekConnectionSnapshot } from '../src/shared/deepseek'
import type { AgentDef } from '../src/shared/types'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previousDispatcher = dispatcher.current
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const slots: any[] = []
let cursor = 0
let effects: (() => void)[] = []
let snapshot: DeepSeekConnectionSnapshot = { baseUrl: DEEPSEEK_BASE_URL, hasKey: false, source: 'none', installed: false, version: '', verified: false }
let readFails = false
let installs = 0
const checks: DeepSeekConnectionInput[] = []
let resolveInstall!: (value: DeepSeekConnectionSnapshot) => void
let rejectInstall!: (cause: Error) => void
let resolveCheck!: (value: DeepSeekConnectionSnapshot) => void
let rejectCheck!: (cause: Error) => void
let resolveLogin!: (value: DeepSeekConnectionSnapshot) => void
let rejectLogin!: (cause: Error) => void
let changed: ((value: DeepSeekConnectionSnapshot) => void) | undefined
let logins = 0
let cancelledLogins = 0
let cancelledInstalls = 0
const agent: AgentDef = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin: '/fixture/dsh', icon: 'deepseek', builtin: true,
  models: [], capabilities: { protocol: 'acp', modelSelect: true, reasoningEffort: true, permissionModes: [] } }
const installation = <section data-installation>安装信息</section>
const defaultParameters = <section data-defaults>该 Agent 默认参数</section>
const props = { agent, installation, defaultParameters, onRedetect: async () => { agent.incompatible = false; agent.lifecycle = { availability: snapshot.verified || snapshot.account?.signedIn ? 'available' : 'needs-auth' } as any } }
const flush = () => new Promise<void>(done => setImmediate(done))
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  getDeepSeekConnection: async () => { if (readFails) throw new Error('private backend detail'); return snapshot },
  installDeepSeek: () => { installs++; return new Promise<DeepSeekConnectionSnapshot>((resolve, reject) => { resolveInstall = resolve; rejectInstall = reject }).then(async value => { await props.onRedetect(); return value }) },
  onDeepSeekChanged: (callback: (value: DeepSeekConnectionSnapshot) => void) => { changed = callback; return () => { changed = undefined } },
  cancelDeepSeekInstall: async () => { cancelledInstalls++ },
  signInDeepSeek: () => { logins++; return new Promise<DeepSeekConnectionSnapshot>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject }).then(async value => { await props.onRedetect(); return value }) },
  cancelDeepSeekSignIn: async () => { cancelledLogins++ },
  signOutDeepSeek: async () => (snapshot = { ...snapshot, account: { supported: true, signedIn: false } }),
  checkDeepSeekConnection: (input: DeepSeekConnectionInput) => { checks.push(input); return new Promise<DeepSeekConnectionSnapshot>((resolve, reject) => { resolveCheck = resolve; rejectCheck = reject }).then(async value => { await props.onRedetect(); return value }) }
} } })

function elements(node: ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<any>(child)) return []
    if (typeof child.type === 'function') return elements((child.type as any)(child.props))
    return [child, ...elements(child.props.children)]
  })
}
function render() {
  cursor = 0
  const tree = DeepSeekSettings(props)
  const pendingEffects = effects; effects = []
  for (const effect of pendingEffects) effect()
  return tree
}
const markup = () => renderToStaticMarkup(render())
function button(text: string) {
  const result = elements(render()).find(element => element.type === 'button' && renderToStaticMarkup(element).includes(text))
  assert.ok(result, 'expected button: ' + text)
  return result
}
function field(label: string) {
  const result = elements(render()).find(element => element.props['aria-label'] === label)
  assert.ok(result, 'expected input: ' + label)
  return result
}
function unmount() {
  for (const slot of slots) slot?.cleanup?.()
  slots.length = 0; effects = []
}
dispatcher.current = {
  useState(initial: any) { const slot = cursor++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], (next: any) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }] },
  useRef(current: any) { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current }; return slots[slot] },
  useEffect(effect: () => (() => void), deps: unknown[]) { const slot = cursor++; const prior = slots[slot]
    if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) {
      prior?.cleanup?.(); slots[slot] = { deps }; effects.push(() => { slots[slot].cleanup = effect() })
    }
  }
}
try {
  assert.match(markup(), /正在读取配置/)
  await flush()
  const initial = markup()
  assert.match(initial, /第一步，安装 Harness/)
  assert.match(initial, /等待安装/)
  assert.doesNotMatch(initial, /aria-label="DeepSeek API Key"|data-defaults|data-installation/)
  assert.equal(installs, 0, 'entering setup must not install without a click')
  button('一键安装').props.onClick(); await flush()
  const installButton = button('安装中')
  assert.equal(button('安装中').props.disabled, true)
  installButton.props.onClick()
  assert.equal(installs, 1, 'duplicate clicks never start a second installation')
  changed?.({ ...snapshot, installation: { phase: 'verifying', cancellable: true } })
  assert.match(markup(), /下载完成，正在验证运行程序/)
  button('取消').props.onClick(); await flush()
  assert.equal(cancelledInstalls, 1)
  snapshot = { ...snapshot, installed: true, version: '0.2.1-rc.2', account: { supported: true, signedIn: false } }
  resolveInstall(snapshot)
  await flush()
  assert.equal(field('DeepSeek API Key').props.value, '')
  assert.equal(button('检查连接').props.disabled, true, 'empty keys cannot be checked')
  assert.doesNotMatch(markup(), /data-defaults/)
  assert.match(markup(), /<details class="deepseek-install-details"><summary>安装详情与更新/)
  field('DeepSeek API Key').props.onChange({ target: { value: '   ' } })
  assert.equal(button('检查连接').props.disabled, true)
  field('DeepSeek API Key').props.onChange({ target: { value: 'fixture-input-key' } })
  field('DeepSeek 服务地址').props.onChange({ target: { value: '' } })
  assert.equal(button('检查连接').props.disabled, true, 'the service address is required')
  field('DeepSeek 服务地址').props.onChange({ target: { value: DEEPSEEK_BASE_URL } })
  const checkButton = button('检查连接')
  assert.equal(checkButton.props.disabled, false)
  checkButton.props.onClick()
  assert.equal(field('DeepSeek API Key').props.disabled, true)
  assert.equal(button('检查中').props.disabled, true)
  checkButton.props.onClick()
  assert.equal(checks.length, 1, 'duplicate clicks cannot submit the key twice')
  rejectCheck(new Error("Error invoking remote method 'deepseek:check': Error: API Key 无效，请检查后重试"))
  await flush()
  assert.equal(field('DeepSeek API Key').props.value, 'fixture-input-key', 'failed checks preserve the user input')
  assert.match(markup(), /role="alert">API Key 无效/)
  assert.doesNotMatch(markup(), /Error invoking remote method/, 'connection errors show actionable copy without the IPC wrapper')
  assert.doesNotMatch(markup(), /data-defaults/)
  button('重新检查连接').props.onClick()
  snapshot = { ...snapshot, hasKey: true, source: 'harness', verified: true }
  resolveCheck(snapshot)
  await flush()
  const readyTree = render()
  assert.equal(readyTree.props.children[1], installation, 'success reuses the regular installation UI below the account group')
  assert.equal(readyTree.props.children[2], defaultParameters, 'success reuses the regular default parameter UI')
  const ready = markup()
  assert.match(ready, /已连接/)
  assert.doesNotMatch(ready, /deepseek-step|<details|aria-label="DeepSeek API Key"/)
  assert.ok(ready.indexOf('DeepSeek 连接') < ready.indexOf('安装信息') && ready.indexOf('安装信息') < ready.indexOf('该 Agent 默认参数'))
  button('管理登录').props.onClick()
  assert.equal(field('DeepSeek API Key').props.value, '', 'successful credentials are never copied back into the field')
  assert.equal(button('检查连接').props.disabled, false, 'an existing key can be checked without re-entry')
  button('检查连接').props.onClick()
  assert.deepEqual(checks.at(-1), { baseUrl: DEEPSEEK_BASE_URL })
  resolveCheck(snapshot)
  await flush()

  button('管理登录').props.onClick()
  button('浏览器登录').props.onClick()
  assert.doesNotMatch(markup(), /aria-label="DeepSeek API Key"/)
  const loginButton = button('打开浏览器登录')
  loginButton.props.onClick(); loginButton.props.onClick()
  assert.equal(logins, 1)
  changed?.({ ...snapshot, account: { supported: true, signedIn: false, phase: 'waiting-browser' } })
  assert.match(markup(), /等待浏览器完成登录/)
  assert.doesNotMatch(markup(), /登录成功/)
  button('取消登录').props.onClick(); await flush()
  assert.equal(cancelledLogins, 1)
  changed?.({ ...snapshot, account: { supported: true, signedIn: false, phase: 'cancelled' } })
  rejectLogin(new Error('已取消浏览器登录')); await flush()
  assert.match(markup(), /已取消浏览器登录/)
  button('打开浏览器登录').props.onClick()
  snapshot = { ...snapshot, hasKey: false, verified: false, account: { supported: true, signedIn: true, phase: 'succeeded' } }
  changed?.(snapshot); resolveLogin(snapshot); await flush()
  assert.match(markup(), /登录成功/)
  assert.match(markup(), /data-defaults/)
  assert.doesNotMatch(markup(), /aria-label="DeepSeek API Key"/)
  button('管理登录').props.onClick()
  button('退出登录').props.onClick(); await flush()
  assert.match(markup(), /打开浏览器登录/)
  snapshot = { ...snapshot, hasKey: true, verified: true, source: 'harness' }

  await props.onRedetect(); unmount(); render(); await flush()
  assert.match(markup(), /已连接/, 'reopening a verified connection keeps the standard layout')
  unmount(); snapshot = { ...snapshot, source: 'harness', verified: false, account: { supported: true, signedIn: true } }; agent.lifecycle = { availability: 'needs-auth' } as any; render(); await flush()
  assert.doesNotMatch(markup(), /data-defaults/, 'an account without usable models must not show ready')
  assert.equal(button('检查连接').props.disabled, false)
  unmount(); snapshot = { ...snapshot, verified: true, account: { supported: true, signedIn: false } }; agent.incompatible = true; agent.lifecycle = { availability: 'unhealthy' } as any; render(); await flush()
  assert.match(markup(), /程序已安装，连接检测未完成/)
  assert.doesNotMatch(markup(), /重新安装 Harness|一键安装/, 'service failures retain the installed runtime')
  const before = installs
  await props.onRedetect(); render(); await flush()
  assert.equal(installs, before)
  assert.match(markup(), /data-installation/)
  unmount(); agent.incompatible = false; readFails = true; render(); await flush()
  assert.match(markup(), /配置状态读取失败/)
  assert.doesNotMatch(markup(), /private backend detail/)
  readFails = false; button('重试').props.onClick(); render(); await flush()
  assert.match(markup(), /已连接/)
} finally {
  unmount()
  dispatcher.current = previousDispatcher
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete (globalThis as any).window
}
console.log('deepseek-settings: install/check ordering, failures, duplicate actions, saved credentials and standard success layout passed')
