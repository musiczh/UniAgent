import assert from 'node:assert/strict'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FeishuRoutingSettings } from '../src/renderer/components/FeishuRoutingSettings'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import type { FeishuSettings } from '../src/shared/types'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current, previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const slots: any[] = [], effects: (() => void)[] = [], patches: unknown[] = []
let cursor = 0, openCount = 0, changed: () => void = () => {}, subscribed = true, fail = false
let snapshot = { config: { ...DEFAULT_ROUTER_CONFIG, enabled: true }, available: true, requests: [] }
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  getRouterSnapshot: async () => { if (fail) throw new Error('worker unavailable'); return snapshot },
  onRouterChanged: (listener: () => void) => { changed = listener; return () => { subscribed = false } }
} } })
dispatcher.current = {
  useState(initial: any) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], (value: any) => { slots[id] = typeof value === 'function' ? value(slots[id]) : value }] },
  useEffect(effect: () => unknown, deps: unknown[]) { const id = cursor++; if (!slots[id]) { slots[id] = { deps }; effects.push(() => { slots[id].cleanup = effect() }) } }
}
let config = {} as FeishuSettings
const render = () => { cursor = 0; return FeishuRoutingSettings({ config, onPatch: patch => patches.push(patch), onOpenRouter: () => { openCount++ } }) }
function elements(node: ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => !React.isValidElement<any>(child) ? [] : typeof child.type === 'function' ? elements((child.type as any)(child.props)) : [child, ...elements(child.props.children)])
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
try {
  let tree = render()
  const control = () => elements(render()).find(element => element.props.role === 'switch')!
  assert.equal(control().props['aria-label'], '自动路由新对话')
  assert.equal(control().props['aria-checked'], false)
  assert.match(renderToStaticMarkup(tree), /开启后不再弹出选择卡片，由 RouterAgent/)
  control().props.onClick()
  assert.deepEqual(patches.at(-1), { autoRouteNewConversations: true }, 'enabling the positive switch skips the card')
  config = { ...config, autoRouteNewConversations: true }
  assert.equal(control().props['aria-checked'], true)
  effects.splice(0).forEach(effect => effect()); await flush()
  assert.match(renderToStaticMarkup(render()), /已启用/)
  elements(render()).find(element => element.type === 'button' && renderToStaticMarkup(element).includes('查看配置'))!.props.onClick()
  assert.equal(openCount, 1)
  snapshot = { ...snapshot, config: { ...snapshot.config, enabled: false } }; changed(); await flush()
  assert.match(renderToStaticMarkup(render()), /尚未启用；新话题仍可手动选择/)
  assert.equal(control().props.disabled, false, 'the saved preference remains editable when Router is unavailable')
  fail = true; changed(); await flush()
  assert.match(renderToStaticMarkup(render()), /状态读取失败/)
  control().props.onClick()
  assert.deepEqual(patches.at(-1), { autoRouteNewConversations: false })
  slots.forEach(slot => slot?.cleanup?.())
  assert.equal(subscribed, false)
  console.log('feishu-routing-settings: positive toggle, explanation, status refresh, configuration navigation and failure state passed')
} finally {
  dispatcher.current = previous
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete (globalThis as any).window
}
