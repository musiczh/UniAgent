import assert from 'node:assert/strict'
import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import { MCodeSettings } from '../src/renderer/components/MCodeSettings'
import type { MCodeConnectionSnapshot } from '../src/shared/mcode'
import type { AgentDef } from '../src/shared/types'

/**
 * The MiniMax Code setup has to be reachable from the Agent settings page.
 *
 * A managed CLI that is not installed yet is the interesting case: the row
 * must open the install flow instead of a generic "初始化" hint, otherwise
 * the user can never install MiniMax Code from the App.
 */

const notInstalledAgent: AgentDef = {
  id: 'mcode', name: 'MiniMax Code', bin: 'mcode', adapter: 'mcode', icon: 'mcode', builtin: true,
  installed: false, models: [],
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  lifecycle: {
    availability: 'not-installed', auth: 'unknown', health: 'unknown',
    selfUpdateSupported: true, updateStatus: 'idle', checkedAt: 1
  }
} as never

/** Render the Agent settings page without running effects. */
function renderAgentPage(renderedAgent: AgentDef): ReactElement {
  const dispatcher = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous = dispatcher.current
  let stateIndex = 0
  dispatcher.current = {
    useState(initial: unknown) {
      const index = stateIndex++
      const value = index === 0 ? 'agent' : typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useRef(initial: unknown) { return { current: initial } },
    useEffect() {}
  }
  try {
    return SettingsPanel({
      agents: [renderedAgent], detecting: false, onRedetect: () => {},
      onInitialize: () => {}, onAgentsChanged: () => {}, onOpenSync: () => {}, onBack: () => {}
    })
  } finally {
    dispatcher.current = previous
  }
}

// Break caught: a not installed MiniMax Code would only offer the generic
// "初始化" hint, so the installer would be unreachable from the App.
const listMarkup = renderToStaticMarkup(renderAgentPage(notInstalledAgent))
assert.match(listMarkup, /MiniMax Code/)
assert.match(listMarkup, /配置与安装/)
assert.doesNotMatch(listMarkup, /未安装[\s\S]{0,400}>初始化</)

const missing: MCodeConnectionSnapshot = {
  installed: false, version: '', dataDir: '/native/.minimax', status: 'uninstalled',
  phase: 'idle', cancellable: false, region: 'cn', needsLogin: false
}
const needsAuth: MCodeConnectionSnapshot = { ...missing, installed: true, bin: '/native/bin/mcode', version: '0.6.12', status: 'needs-auth', needsLogin: true }
const ready: MCodeConnectionSnapshot = { ...needsAuth, status: 'ready', needsLogin: false }

function harness(snapshot: MCodeConnectionSnapshot, api: Record<string, unknown> = {}) {
  const values: unknown[] = [snapshot]
  const refs: Array<{ current: unknown }> = []
  let redetects = 0
  globalThis.window = { uniagent: { getMCodeConnection: async () => snapshot, ...api } } as never
  const render = () => {
    const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
    const previous = dispatcher.current
    let index = 0, refIndex = 0
    dispatcher.current = {
      useState(initial: unknown) {
        const key = index++
        if (!(key in values)) values[key] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        return [values[key], (value: any) => { values[key] = typeof value === 'function' ? value(values[key]) : value }]
      },
      useRef(initial: unknown) { return refs[refIndex++] ||= { current: initial } },
      useEffect() {}
    }
    try {
      return MCodeSettings({ agent: notInstalledAgent, onRedetect: () => { redetects++ }, installation: <div>installation-details</div>, defaultParameters: <div>default-parameters</div> })
    } finally { dispatcher.current = previous }
  }
  const elements = (): ReactElement<any>[] => {
    const result: ReactElement<any>[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return }
      if (!React.isValidElement(value)) return
      const element = value as ReactElement<any>
      result.push(element); walk(element.props.children); walk(element.props.control)
    }
    walk(render()); return result
  }
  const button = (label: string) => elements().find(element => element.type === 'button' && element.props.children === label)!
  return { markup: () => renderToStaticMarkup(render()), elements, button, redetects: () => redetects, snapshot: (value: MCodeConnectionSnapshot) => { values[0] = value } }
}
const originalWindow = globalThis.window
try {
  const readyPage = harness(ready)
  const available = readyPage.markup()
  assert.match(available, /installation-details/)
  assert.match(available, /default-parameters/)
  assert.doesNotMatch(available, /deepseek-step|登录方式|type="password"/)
  readyPage.snapshot({ ...ready, status: 'failed', message: '连接检测超时' })
  assert.match(readyPage.markup(), /default-parameters/)
  assert.match(readyPage.markup(), /连接检测超时/)
  assert.doesNotMatch(readyPage.markup(), /deepseek-step/)

  const absent = harness(missing)
  assert.match(absent.markup(), /一键安装/)
  assert.doesNotMatch(absent.markup(), /UniAgent 独立目录|内网镜像|type="password"/)
  const toggle = absent.elements().find(element => element.props.className === 'mcode-prompt-toggle')!
  toggle.props.onClick()
  assert.match(absent.markup(), /完整安装提示词/)
  assert.match(absent.markup(), /aria-expanded="true"/)
  assert.equal((absent.markup().match(/>重新检测<\/button>/g) || []).length, 1)
  assert.doesNotMatch(absent.markup(), /安装完成，重新检测/)

  let chosenRegion = ''
  const browser = harness(needsAuth, { signInMCode: async (region: string) => { chosenRegion = region; return ready } })
  assert.match(browser.markup(), /MiniMax 账号区域/)
  assert.doesNotMatch(browser.markup(), /<select/)
  browser.button('Global').props.onClick()
  browser.button('一键登录').props.onClick()
  await new Promise(done => setTimeout(done, 0))
  assert.equal(chosenRegion, 'global')
  assert.match(browser.markup(), /default-parameters/)
  assert.equal(browser.redetects(), 1)

  let submitted: unknown
  const key = harness(needsAuth, { checkMCodeConnection: async (input: unknown) => { submitted = input; return ready } })
  key.button('API Key 登录').props.onClick()
  let input = key.elements().find(element => element.type === 'input' && element.props.type === 'password')!
  input.props.onChange({ target: { value: '   ' } })
  assert.equal(key.button('使用 API Key 登录').props.disabled, true)
  input.props.onChange({ target: { value: ' fixture-key ' } })
  assert.equal(key.button('使用 API Key 登录').props.disabled, false)
  key.button('使用 API Key 登录').props.onClick()
  await new Promise(done => setTimeout(done, 0))
  assert.deepEqual(submitted, { apiKey: 'fixture-key', region: 'cn' })
  assert.match(key.markup(), /default-parameters/)

  let attempts = 0
  const failed = harness(missing, { installMCode: async () => { attempts++; throw new Error('下载失败') } })
  const startInstall = failed.button('一键安装').props.onClick
  startInstall()
  startInstall()
  await new Promise(done => setTimeout(done, 0))
  assert.equal(attempts, 1)
  assert.match(failed.markup(), /下载失败/)
  assert.match(failed.markup(), /完整安装提示词/)

  const broken = harness({ ...needsAuth, status: 'failed', needsLogin: false, message: '检测超时' }).markup()
  assert.match(broken, /检测超时/)
  assert.doesNotMatch(broken, /一键安装|一键登录/)
} finally { globalThis.window = originalWindow }
console.log('mcode-settings-ui: native reuse, detail view, installation fallback and both authentication paths passed')
