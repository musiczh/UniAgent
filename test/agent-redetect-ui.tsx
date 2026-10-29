import assert from 'node:assert/strict'
import React, { type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentLifecycleService } from '../src/main/agentLifecycleService'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import type { AgentDef } from '../src/shared/types'

const agent: AgentDef = {
  id: 'codex', name: 'Codex', bin: '/safe/codex', adapter: 'codex', icon: '', builtin: true,
  installed: true, version: '1.2.3', models: [], defaultModel: undefined,
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  lifecycle: {
    availability: 'available', auth: 'authenticated', health: 'healthy',
    selfUpdateSupported: true, updateStatus: 'current', currentVersion: '1.2.3', checkedAt: 1
  }
}

function renderAgentPage(detail: boolean, detecting: boolean, renderedAgent: AgentDef = agent, siblings: AgentDef[] = [renderedAgent]): ReactElement {
  const dispatcher = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous = dispatcher.current
  let stateIndex = 0
  dispatcher.current = {
    useState(initial: unknown) {
      const index = stateIndex++
      const value = index === 0 ? 'agent' : index === 1 && detail ? renderedAgent.id : typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useRef(initial: unknown) { return { current: initial } },
    useEffect() {}
  }
  try {
    return SettingsPanel({
      agents: siblings, detecting, onRedetect: () => {},
      onInitialize: () => {}, onAgentsChanged: () => {}, onOpenSync: () => {}, onBack: () => {}
    })
  } finally {
    dispatcher.current = previous
  }
}

const updateAvailableAgent: AgentDef = {
  ...agent,
  lifecycle: { ...agent.lifecycle!, updateStatus: 'available', availableVersion: '1.2.4' }
}
const updateAvailableMarkup = renderToStaticMarkup(renderAgentPage(false, false, updateAvailableAgent))
assert.match(updateAvailableMarkup, /<button[^>]*class="set-mini-btn primary"[^>]*>[\s\S]*?更新全部（1）<\/button>/)
assert.doesNotMatch(renderToStaticMarkup(renderAgentPage(false, false)), /更新全部/)

function findByClass(node: ReactNode, className: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found) return found
    }
  } else if (React.isValidElement(node)) {
    if ((node.props as { className?: string }).className === className) return node
    return findByClass((node.props as { children?: ReactNode }).children, className)
  }
  return null
}

for (const detail of [false, true]) {
  const busyTree = renderAgentPage(detail, true)
  assert.match(renderToStaticMarkup(busyTree), /<button[^>]*class="set-mini-btn"[^>]*disabled=""[^>]*>[\s\S]*?is-spinning[\s\S]*?(?:检测中|刷新中)…<\/button>/)

  const idleTree = renderAgentPage(detail, false)
  assert.match(renderToStaticMarkup(idleTree), new RegExp(`<button[^>]*class="set-mini-btn"(?![^>]*disabled)[^>]*>[\\s\\S]*?${detail ? '刷新状态' : '重新探测'}<\\/button>`))
  if (detail) assert.doesNotMatch(renderToStaticMarkup(findByClass(idleTree, 'set-detail-title')!), /status-pill/)
}

const failedAgent: AgentDef = { ...agent, incompatible: true, unavailableReason: 'old connection error', lifecycle: {
  ...agent.lifecycle!, availability: 'unhealthy', detectionStatus: 'failed', detectionError: 'old connection error'
} }
const loadingList = renderToStaticMarkup(renderAgentPage(false, true, failedAgent))
assert.doesNotMatch(loadingList, /old connection error|重试检测 Codex|检测失败/)
assert.match(loadingList, /is-spinning/)

for (const phase of ['preparing', 'recovering'] as const) {
  const pendingAgent: AgentDef = { ...failedAgent, lifecycle: { ...failedAgent.lifecycle!, detectionStatus: 'detecting', detectionPhase: phase } }
  const expected = phase === 'preparing' ? '准备中…' : '恢复中…'
  const list = renderToStaticMarkup(renderAgentPage(false, false, pendingAgent))
  assert.match(list, new RegExp(expected))
  assert.doesNotMatch(list, /old connection error|重试检测 Codex|检测失败/)
  const detail = renderAgentPage(true, false, pendingAgent)
  const visible = findByClass(detail, 'settings-agent-pending')
  assert.ok(visible, 'a pending detail must show its standard installation status before any setup error')
  assert.match(renderToStaticMarkup(visible), new RegExp(expected))
  assert.doesNotMatch(renderToStaticMarkup(visible), /old connection error|role="alert"/)
}
const readySibling: AgentDef = { ...agent, id: 'grok', name: 'Grok' }
const pendingSibling: AgentDef = { ...failedAgent, lifecycle: { ...failedAgent.lifecycle!, detectionStatus: 'detecting', detectionPhase: 'recovering' } }
const mixed = renderAgentPage(false, true, pendingSibling, [readySibling, pendingSibling])
const readyRow = findByClass(mixed, 'row rowlink settings-agent-row')
assert.ok(readyRow)
assert.doesNotMatch(renderToStaticMarkup(readyRow), /is-spinning|恢复中|检测中/)
assert.match(renderToStaticMarkup(renderAgentPage(false, false, failedAgent)), /old connection error|检测失败/)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const first = deferred<{ code: number; stdout: string; stderr: string }>()
const second = deferred<{ code: number; stdout: string; stderr: string }>()
const started: string[] = []
const service = new AgentLifecycleService({
  detect: async () => [
    { ...agent, id: 'traex-one', bin: '/safe/traecli-one', adapter: 'traex' },
    { ...agent, id: 'traex-two', bin: '/safe/traecli-two', adapter: 'traex' }
  ],
  runner: async (bin, spec) => {
    if (spec.args[0] !== 'update') return { code: 0, stdout: '1.2.3', stderr: '' }
    started.push(bin)
    return bin.endsWith('-one') ? first.promise : second.promise
  }
})
await service.detectAll(true)
const checking = service.checkAllUpdates()
await new Promise((resolve) => setImmediate(resolve))
try {
  assert.deepEqual([...started].sort(), ['/safe/traecli-one', '/safe/traecli-two'])
} finally {
  first.resolve({ code: 0, stdout: 'Latest TraeCode CLI version: 1.2.3', stderr: '' })
  second.resolve({ code: 0, stdout: 'Latest TraeCode CLI version: 1.2.3', stderr: '' })
}
await checking

console.log('agent-redetect-ui: ok')
