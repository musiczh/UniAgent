import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ZCodeSettings } from '../src/renderer/components/ZCodeSettings'
import { SettingsPanel, ZCodeConfigurationGroup } from '../src/renderer/components/SettingsPanel'
import type { ZCodeInstallationSnapshot } from '../src/shared/zcode'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const slots: any[] = []
let cursor = 0, effects: (() => void)[] = [], installs = 0, cancels = 0, fallback = 0, refreshes = 0
let snapshot: ZCodeInstallationSnapshot = { phase: 'idle', installed: false, cancellable: false }
let finish!: (snapshot: ZCodeInstallationSnapshot) => void
const noop = () => {}
const agent: any = { id: 'zcode', name: 'ZCode', adapter: 'zcode', bin: 'zcode', builtin: true, models: [], installed: false,
  capabilities: { modelSelect: true, permissionModes: [] }, lifecycle: { availability: 'not-installed' } }
const panel = renderToStaticMarkup(<SettingsPanel agents={[agent]} initialCategory="agent" onRedetect={noop} onInitialize={noop} onAgentsChanged={noop} onOpenSync={noop} onBack={noop} />)
assert.match(panel, /<button class="set-mini-btn">配置与安装<\/button>/, 'setup is accessible without another available agent')
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  getZCodeInstallation: async () => snapshot,
  installZCode: () => { installs++; return new Promise<ZCodeInstallationSnapshot>(resolve => { finish = resolve }) },
  cancelZCodeInstall: async () => { cancels++; snapshot = { phase: 'cancelled', installed: false, cancellable: false }; finish(snapshot) }
} } })
const props = { onRedetect: () => { refreshes++ }, onInitialize: () => { fallback++ }, canUseAgent: false,
  children: (ready: boolean) => <input aria-label="model-key" disabled={!ready} /> }
dispatcher.current = {
  useState(initial: any) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], (value: any) => { slots[id] = value }] },
  useRef(current: any) { const id = cursor++; if (!(id in slots)) slots[id] = { current }; return slots[id] },
  useEffect(effect: () => (() => void), deps: unknown[]) {
    const id = cursor++
    if (!(id in slots) || deps.some((value, i) => value !== slots[id].deps[i])) {
      slots[id]?.cleanup?.(); slots[id] = { deps }; effects.push(() => { slots[id].cleanup = effect() })
    }
  }
}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<any>(child)) return []
    if (typeof child.type === 'function') return elements((child.type as any)(child.props))
    return [child, ...elements(child.props.children)]
  })
}
let component = () => ZCodeSettings(props)
const render = () => { cursor = 0; const tree = component(); const pending = effects; effects = []; pending.forEach(effect => effect()); return elements(tree) }
const button = (label: string) => { const result = render().find(element => element.type === 'button' && renderToStaticMarkup(element).includes(label)); assert.ok(result, label); return result }
const flush = () => new Promise(resolve => setImmediate(resolve))
try {
  render(); await flush()
  assert.equal(installs, 0)
  assert.equal(button('一键安装').props.disabled, false)
  assert.ok(button('备用方式：提示词安装'), 'copy fallback is available without another agent')
  assert.equal(render().find(element => element.type === 'input')?.props.disabled, true)
  assert.equal(fallback, 0)
  button('一键安装').props.onClick()
  snapshot = { phase: 'building', installed: false, cancellable: true }
  render(); await flush()
  assert.equal(installs, 1)
  assert.equal(button('重新检测').props.disabled, true)
  assert.equal(button('取消').props.disabled, false)
  button('取消').props.onClick(); await flush()
  assert.equal(cancels, 1)
  assert.equal(button('重试安装').props.disabled, false)
  button('重试安装').props.onClick()
  snapshot = { phase: 'failed', installed: false, cancellable: false, message: 'ZCode 源码下载失败' }
  finish(snapshot); await flush(); render(); await flush()
  assert.equal(button('重试安装').props.disabled, false)
  button('重试安装').props.onClick()
  snapshot = { phase: 'completed', installed: true, cancellable: false, version: '0.16.9' }
  finish(snapshot); await flush(); render(); await flush()
  assert.equal(refreshes, 0)
  assert.equal(render().find(element => element.type === 'input')?.props.disabled, false)
  assert.ok(!render().some(element => element.type === 'button' && /验证安装|使用 Agent 初始化|一键安装/.test(renderToStaticMarkup(element))))
  assert.ok(render().some(element => element.props.role === 'status' && renderToStaticMarkup(element).includes('已安装')))
  for (const slot of slots) slot?.cleanup?.()
  slots.length = 0
  let complete!: (value: any) => void
  Object.assign(window.uniagent, {
    getZCodeConfiguration: async () => ({ service: 'bigmodel-coding', hasKey: false, phase: 'unconfigured' }),
    checkZCodeConfiguration: (input: any) => {
      assert.equal(input.service, 'bigmodel-coding')
      assert.equal(input.apiKey, 'test-fixture')
      return new Promise(resolve => { complete = resolve })
    }
  })
  component = () => ZCodeConfigurationGroup({ onRedetect: () => { refreshes++ } })
  render(); await flush()
  const keyInput = () => render().find(element => element.props['aria-label'] === 'ZCode API Key')!
  assert.equal(button('检测配置').props.disabled, true)
  keyInput().props.onChange({ target: { value: 'test-fixture' } })
  button('检测配置').props.onClick()
  assert.equal(button('检测中').props.disabled, true)
  assert.ok(!render().some(element => element.props.role === 'status'), 'checking is represented by the button only')
  assert.equal(keyInput().props.disabled, true)
  complete({ service: 'bigmodel-coding', hasKey: false, phase: 'failed', message: 'API Key 无效' }); await flush()
  assert.equal(keyInput().props.value, 'test-fixture', 'failed validation keeps the key for retry')
  assert.ok(render().some(element => element.props.role === 'status' && renderToStaticMarkup(element).includes('检测失败')))
  button('检测配置').props.onClick()
  complete({ service: 'bigmodel-coding', hasKey: true, phase: 'ready', message: '模型列表获取成功' }); await flush()
  assert.equal(keyInput().props.value, '')
  assert.equal(refreshes, 1, 'successful validation refreshes agent models and default settings')
  assert.ok(render().some(element => element.props.role === 'status' && renderToStaticMarkup(element).includes('配置完成')))
  assert.ok(render().some(element => element.props.className === 'r-sub' && element.props.children === '模型列表获取成功'))
  component = () => ZCodeConfigurationGroup({ onRedetect: () => { throw new Error('fixture refresh failure') } })
  keyInput().props.onChange({ target: { value: 'test-fixture' } })
  button('检测配置').props.onClick()
  complete({ service: 'bigmodel-coding', hasKey: true, phase: 'ready', message: '模型列表获取成功' }); await flush()
  assert.ok(render().some(element => element.props.role === 'status' && renderToStaticMarkup(element).includes('配置完成')))
  assert.ok(render().some(element => element.props.className === 'r-sub' && String(element.props.children).includes('默认配置刷新失败')))
  console.log('zcode-settings: install/cancel/retry, installed-only state, fallback gating, single checking status, key retry and model refresh passed')
} finally {
  for (const slot of slots) slot?.cleanup?.()
  dispatcher.current = previous
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}
