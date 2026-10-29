import { isCliSetupId } from '../src/shared/agentSetup'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CliAgentSettings } from '../src/renderer/components/CliAgentSettings'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import type { CliSetupSnapshot } from '../src/shared/agentSetup'
const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
let slots: any[] = [], cursor = 0, effects: (() => void)[] = [], copied = '', installed = 0, loginInput: any, changed: any
let snapshot: CliSetupSnapshot = { phase: 'idle', cancellable: false }
let finish!: (value: CliSetupSnapshot) => void
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  getAgentSetup: async () => snapshot, onAgentSetupChanged: (callback: any) => { changed = callback; return () => {} },
  installAgent: () => { installed++; return new Promise(resolve => { finish = resolve }) },
  signInAgent: async (_id: string, input: any) => { loginInput = input; return snapshot },
  cancelAgentSetup: async () => {}, reopenAgentSignIn: async () => {}
} } })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text } } } })
dispatcher.current = {
  useState(initial: any) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], (next: any) => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }] },
  useRef(current: any) { const id = cursor++; if (!(id in slots)) slots[id] = { current }; return slots[id] },
  useEffect(effect: any, deps: any[] = []) { const id = cursor++, before = slots[id]; if (!before || deps.some((x, i) => !Object.is(x, before.deps[i]))) { before?.cleanup?.(); slots[id] = { deps }; effects.push(() => { slots[id].cleanup = effect() }) } }
}
let agent: any
const reset = (id: string, present = false, ready = false) => {
  for (const slot of slots) slot?.cleanup?.(); slots = []; effects = []
  snapshot = { phase: 'idle', cancellable: false }
  agent = { id, name: id, adapter: id, bin: '/fixture/' + id, installed: present, models: [], capabilities: { permissionModes: [] }, lifecycle: { availability: ready ? 'available' : present ? 'needs-auth' : 'not-installed' } }
}
function expand(node: any): any {
  return React.Children.map(node, child => {
    if (!React.isValidElement<any>(child)) return child
    if (typeof child.type === 'function') return expand((child.type as any)(child.props))
    return React.cloneElement(child, {}, expand(child.props.children))
  })
}
const render = () => { cursor = 0; const tree = <>{expand(CliAgentSettings({ agent, onRedetect: () => {}, installation: <section>安装信息</section>, defaultParameters: <section>默认参数</section>, onOpenModels: () => {} }))}</>; const pending = effects; effects = []; pending.forEach(effect => effect()); return tree }
const nodes = (node: any): any[] => React.Children.toArray(node).flatMap((child: any) => React.isValidElement<any>(child) ? [child, ...nodes(child.props.children)] : [])
const button = (text: string) => { const found = nodes(render()).find(item => item.type === 'button' && renderToStaticMarkup(item).includes(text)); assert.ok(found, text); return found }
const flush = () => new Promise(done => setImmediate(done))
try {
  for (const id of ['codex', 'traex', 'claude', 'grok'].filter(isCliSetupId)) {
    reset(id)
    const row = renderToStaticMarkup(<SettingsPanel agents={[agent]} initialCategory="agent" onRedetect={() => {}} onInitialize={() => {}} onAgentsChanged={() => {}} onOpenSync={() => {}} onBack={() => {}} />)
    assert.match(row, /配置与安装/, id + ' setup is reachable with zero usable agents')
    render(); await flush()
    assert.equal(button('一键安装').props.disabled, false)
    assert.equal(nodes(render()).filter(item => item.type === 'button' && renderToStaticMarkup(item).includes('重新检测')).length, 1)
    button('备用方式：提示词安装').props.onClick()
    const fallback = nodes(render()).find(item => item.type === 'button' && item.props.className === 'mcode-prompt-toggle')
    assert.equal(nodes(fallback).find(item => item.type === 'svg')?.props.width, 12, 'disclosure icon matches the text size')
    button('复制安装提示词').props.onClick(); await flush(); assert.ok(copied.includes(id === 'claude' ? 'claude' : id))
    const install = button('一键安装'); install.props.onClick(); install.props.onClick()
    assert.equal(installed, ['codex', 'traex', 'claude', 'grok'].filter(isCliSetupId).indexOf(id) + 1)
    finish({ phase: 'failed', cancellable: false, message: '下载失败' }); await flush()
    assert.match(renderToStaticMarkup(render()), /下载失败/)
    assert.ok(button('重试安装'))
    reset(id, true)
    render(); await flush()
    if (id === 'traex') {
      assert.ok(button('SSO 登录')); assert.match(renderToStaticMarkup(render()), /未提供已确认的 API Key/)
      assert.equal(nodes(render()).some(item => item.type === 'input'), false)
    } else {
      button('API Key 登录').props.onClick()
      assert.equal(button('使用 API Key 登录').props.disabled, true)
      const input = nodes(render()).find(item => item.type === 'input')
      assert.equal(input.props.type, 'password'); input.props.onChange({ target: { value: 'offline-fixture' } })
      button('使用 API Key 登录').props.onClick(); await flush()
      assert.deepEqual(loginInput, { method: 'key', apiKey: 'offline-fixture' })
    }
    changed({ id, snapshot: { phase: 'login', cancellable: true, canReopen: true } })
    assert.ok(button('重新打开浏览器')); assert.ok(button('取消等待'))
    reset(id, true, true); render(); await flush()
    const ready = renderToStaticMarkup(render())
    assert.match(ready, /安装信息/); assert.match(ready, /默认参数/)
    assert.doesNotMatch(ready, /deepseek-step|一键安装|API Key|提示词安装/)
  }
  console.log('Agent setup UI: all four zero-agent entries, one detection action, text-sized disclosure, copy/retry, password gating, auth methods, waiting controls and standard ready detail passed')
} finally {
  for (const slot of slots) slot?.cleanup?.(); dispatcher.current = previous
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
  if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else Reflect.deleteProperty(globalThis, 'navigator')
}
