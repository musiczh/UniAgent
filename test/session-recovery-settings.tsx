import assert from 'node:assert/strict'
import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionRecoverySettings } from '../src/renderer/components/SessionRecoverySettings'
import { SessionRecoveryStatus } from '../src/renderer/components/SessionRecoveryStatus'
import { SetRow, SetSelect, SetGroup } from '../src/renderer/components/SettingsPrimitives'
import { ToggleSwitch } from '../src/renderer/components/Icons'
import { defaultRecoverySettings } from '../src/shared/sessionRecovery'
import type { AppSettings } from '../src/shared/types'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const state: any[] = []
let cursor = 0, failSave = false
let settings = { sessionRecovery: { ...defaultRecoverySettings(), agentId: 'codex', model: 'judge' } } as AppSettings
const errors = [
  { key: 'codex:capacity', agentId: 'codex', label: '模型容量不足', message: 'Selected model is at capacity.', count: 8, firstSeenAt: 1, lastSeenAt: 2 },
  { key: 'codex:timeout', agentId: 'codex', label: '请求超时', message: 'Request timed out.', count: 2, firstSeenAt: 1, lastSeenAt: 2 }
]
;(globalThis as any).window = { uniagent: {
  getRecoveryErrors: async () => errors,
  setAppSettings: async (patch: Partial<AppSettings>) => { if (failSave) throw new Error('保存失败'); return { ...settings, ...patch } }
} }
const hooks = {
  useState(initial: any) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === 'function' ? next(state[index]) : next }] },
  useRef(initial: any) { const index = cursor++; return state[index] ||= { current: initial } },
  useEffect() {}
}
function render() {
  cursor = 0; dispatcher.current = hooks
  try { return SessionRecoverySettings({ agents: [], settings, onSaved: next => { settings = next }, onBack() {} }) }
  finally { dispatcher.current = previous }
}
function nodes(node: any): ReactElement<any>[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...['children', 'control', 'action', 'sub'].flatMap(key => nodes(node.props?.[key]))]
}
function find(type: any, predicate: (props: any) => boolean): ReactElement<any> {
  const found = nodes(render()).find(node => node.type === type && predicate(node.props))
  assert.ok(found, 'expected rendered control')
  return found
}
async function flush() { await new Promise(resolve => setImmediate(resolve)) }
try {
  assert.ok(nodes(render()).some(node => node.type === SetGroup && node.props.title === '重试规则'))
  assert.ok(nodes(render()).some(node => node.type === SetGroup && node.props.title === '不重试规则'))
  find(ToggleSwitch, props => props.label === '自动恢复失败会话').props.onChange(true)
  await flush()
  assert.equal(settings.sessionRecovery!.enabled, true)
  find('button', props => props.children?.[0] === '选择错误类型').props.onClick()
  await find('button', props => props.children === '刷新').props.onClick()
  await flush()
  assert.equal(nodes(render()).filter(node => node.type === SetRow).length, 2)
  const checkbox = find('input', props => props.type === 'checkbox')
  checkbox.props.onChange({ target: { checked: true } })
  await flush()
  assert.deepEqual(settings.sessionRecovery!.selectedErrors, ['codex:capacity'])
  find('button', props => props.className === 'set-back').props.onClick()
  const main = renderToStaticMarkup(render())
  assert.match(main, /模型容量不足/)
  assert.doesNotMatch(main, /Request timed out/)
  const denyGroup = find(SetGroup, props => props.title === '不重试规则')
  denyGroup.props.action.props.onClick()
  find('textarea', () => true).props.onChange({ target: { value: '需要重新登录时不重试' } })
  await find('button', props => props.className === 'set-save-btn').props.onClick()
  assert.equal(settings.sessionRecovery!.rules[0].effect, 'no-retry')
  assert.equal(settings.sessionRecovery!.rules[0].description, '需要重新登录时不重试')
  failSave = true
  find(SetSelect, props => props.ariaLabel === '最大自动重试次数').props.onChange('9')
  await flush()
  assert.equal(settings.sessionRecovery!.maxRetries, 3, 'failed saves retain the last committed settings')
  assert.match(renderToStaticMarkup(render()), /保存失败/)
  const status = renderToStaticMarkup(<SessionRecoveryStatus sessionId="test" recovery={{ chainId: 'a', phase: 'waiting', attempts: 1, maxRetries: 3, nextRetryAt: Date.now() + 30000, reason: '容量不足', matchedRuleIds: [] }} />)
  assert.match(status, /取消自动恢复/)
  assert.match(status, /已重试 1 \/ 3 次/)
  console.log('PASS recovery settings: selected errors, child picker, rule types, failed saves and cancellation feedback')
} finally { dispatcher.current = previous; delete (globalThis as any).window }
