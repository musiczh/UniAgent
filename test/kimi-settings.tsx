import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KimiSettings } from '../src/renderer/components/KimiSettings'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import { kimiErrorCopy } from '../src/shared/kimiErrors'
import type { KimiSetupSnapshot } from '../src/shared/kimiOnboarding'
const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const slots: any[] = []; let cursor = 0, effects: (() => void)[] = []
let snapshot: KimiSetupSnapshot = { phase: 'idle', status: 'uninstalled', cancellable: false }
let installs = 0, cancels = 0, refreshes = 0, copied = '', copyFails = false
let changed: ((value: KimiSetupSnapshot) => void) | undefined, finish!: (value: KimiSetupSnapshot) => void
const agent: any = { id: 'kimi', adapter: 'kimi', name: 'Kimi Code', bin: 'kimi', builtin: true, installed: false, models: [], capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] }, lifecycle: { availability: 'not-installed' } }
const noop = () => {}
// Machine codes share one translation across the list row, the runtime card and this panel.
assert.equal(kimiErrorCopy('kimi_web_server_source_unverified')?.label, '本地服务未完成校验')
assert.equal(kimiErrorCopy('kimi_web_version_unsupported')?.label, '版本不兼容')
assert.equal(kimiErrorCopy('kimi_web_version_unsupported: 3')?.hint, '当前 Kimi Code CLI 版本不受支持，请更新官方 CLI 后重新检测。')
assert.equal(kimiErrorCopy('网络异常，请重试。'), undefined, 'plain messages stay untranslated')
assert.equal(kimiErrorCopy(undefined), undefined)
const panel = renderToStaticMarkup(<SettingsPanel {...({ agents: [agent], initialCategory: 'agent', onRedetect: noop, onInitialize: noop, onBack: noop, onAgentsChanged: noop, onOpenSync: noop, onViewAppUpdates: noop, onViewAgentUpdates: noop, onViewDiagnostics: noop } as any)} />)
assert.match(panel, /<button class="set-mini-btn">配置与安装<\/button>/, 'zero usable agents still have an enabled setup entry')
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  getKimiSetup: async () => snapshot, onKimiSetupChanged: (callback: typeof changed) => { changed = callback; return () => { changed = undefined } },
  installKimi: () => { installs++; return new Promise<KimiSetupSnapshot>(resolve => { finish = resolve }).then(value => { agent.installed = true; agent.lifecycle = { availability: 'needs-auth' }; return value }) },
  checkKimiSetup: async () => snapshot, signInKimi: async () => snapshot, cancelKimiSetup: async () => { cancels++ }
} } })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { if (copyFails) throw new Error('denied'); copied = text } } } })
const props = { agent, onRedetect: () => { refreshes++ } }
function render(): React.ReactElement {
  cursor = 0
  const materialize = (node: any): any => React.Children.map(node, child => {
    if (!React.isValidElement<any>(child)) return child
    if (typeof child.type === 'function') return materialize((child.type as any)(child.props))
    return React.cloneElement(child, {}, materialize(child.props.children))
  })
  const tree = <>{materialize(KimiSettings(props))}</>, pending = effects; effects = []; pending.forEach(effect => effect()); return tree
}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<any>(child)) return []
    if (typeof child.type === 'function') return elements((child.type as any)(child.props))
    return [child, ...elements(child.props.children)]
  })
}
const button = (label: string) => { const result = elements(render()).find(item => item.type === 'button' && renderToStaticMarkup(item).includes(label)); assert.ok(result, label); return result }
const flush = () => new Promise(resolve => setImmediate(resolve))
dispatcher.current = {
  useState(initial: any) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], (value: any) => { slots[id] = typeof value === 'function' ? value(slots[id]) : value }] },
  useRef(current: any) { const id = cursor++; if (!(id in slots)) slots[id] = { current }; return slots[id] },
  useEffect(effect: () => (() => void), deps: unknown[]) { const id = cursor++; if (!(id in slots)) { slots[id] = { deps }; effects.push(() => { slots[id].cleanup = effect() }) } }
}
try {
  render(); await flush()
  assert.equal(installs, 0, 'opening setup must not silently install')
  assert.ok(!button('一键安装').props.disabled, 'install action is clickable')
  button('备用方式：提示词安装').props.onClick();
  button('复制安装提示词').props.onClick(); await flush()
  assert.match(copied, /kimi web/); assert.equal(installs, 0)
  copyFails = true; button('复制安装提示词').props.onClick(); await flush()
  assert.match(renderToStaticMarkup(render()), /复制失败/)
  assert.ok(elements(render()).some(item => item.type === 'textarea' && item.props.readOnly && item.props.value === copied))
  const install = button('一键安装'); install.props.onClick(); install.props.onClick()
  assert.equal(installs, 1, 'single click must not double-start the install')
  assert.doesNotMatch(renderToStaticMarkup(render()), />一键安装</, 'busy state replaces the install action')
  assert.equal(button('安装中…').props.disabled, true)
  changed?.({ phase: 'downloading', status: 'uninstalled', cancellable: true, receivedBytes: 1, totalBytes: 5 })
  button('取消').props.onClick(); await flush(); assert.equal(cancels, 1)
  snapshot = { phase: 'completed', status: 'needs-auth', version: '2.2.0', cancellable: false }; finish(snapshot); await flush()
  assert.equal(refreshes, 0); assert.ok(!button('一键登录').props.disabled, 'login action is clickable')
  assert.doesNotMatch(renderToStaticMarkup(render()), />一键安装</)
  // Result-first: completed phases must not appear beside a failure, and the
  // machine code must be translated in the status line.
  agent.incompatible = true; agent.lifecycle = { availability: 'unhealthy', detectionStatus: 'failed' }
  snapshot = { phase: 'failed', status: 'incompatible', message: 'kimi_web_server_source_unverified', cancellable: false }; changed?.(snapshot); await flush()
  const failed = renderToStaticMarkup(render())
  assert.match(failed, /检测未完成/)
  assert.match(failed, /检测到正在运行的 Kimi 服务未完成校验，请点「重试」重新检测。/)
  assert.doesNotMatch(failed, /检测完成/, 'phase text is never a result')
  assert.ok(!button('重新检测').props.disabled, 'redetect stays available after a failure')
  button('重新检测').props.onClick(); await flush()
  agent.incompatible = false; agent.lifecycle = { availability: 'available' }
  snapshot = { phase: 'completed', status: 'ready', cancellable: false }; changed?.(snapshot); await flush()
  assert.doesNotMatch(renderToStaticMarkup(render()), /deepseek-step|API Key|一键登录|一键安装/)
  agent.lifecycle = { availability: 'needs-auth' }
  assert.match(renderToStaticMarkup(render()), /一键登录/, 'a fresh auth failure must override an old ready setup snapshot')
  console.log('Kimi settings: error copy map, zero-agent entry, explicit install, single click, progress/cancel, copy fallback, login transition and result-first failure state passed')
} finally {
  for (const slot of slots) slot?.cleanup?.()
  dispatcher.current = previous
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as any).window
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete (globalThis as any).navigator
}
