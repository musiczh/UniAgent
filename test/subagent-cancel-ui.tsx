import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubAgentPanel } from '../src/renderer/components/SubAgentPanel.tsx'
import type { UASubAgent } from '../src/shared/types.ts'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const slots: any[] = []
let index = 0
let nativeCalls = 0
let rejectNative: ((error: Error) => void) | undefined
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  cancelSubAgent(sessionId: string, childId: string) {
    assert.equal(sessionId, 'owner')
    assert.equal(childId, 'child')
    nativeCalls++
    return new Promise<void>((_resolve, reject) => { rejectNative = reject })
  }
} } })
const child: UASubAgent = { agentThreadId: 'child', name: 'Review', status: 'running' }
let canCancel = true
let initialView: 'detail' | 'list' = 'detail'
const noop = () => {}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => React.isValidElement<any>(child)
    ? [child, ...elements(child.props.children)] : [])
}
function render() {
  index = 0
  return SubAgentPanel({ open: true, sessionId: 'owner', subagents: [child], activeThreadId: child.agentThreadId,
    initialView, canCancel, onSelect: noop, onClose: noop })
}
function cancelButton() { return elements(render()).find(element => element.props['aria-label'] === '取消子智能体') }
try {
  dispatcher.current = {
    useState(initial: any) { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next: any) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }] },
    useRef(current: any) { const slot = index++; if (!(slot in slots)) slots[slot] = { current }; return slots[slot] },
    useMemo(read: () => unknown) { return read() }, useEffect() {}, useLayoutEffect() {}
  }
  assert.ok(cancelButton(), 'a supported running child exposes its cancellation action')
  const markup = renderToStaticMarkup(render())
  assert.match(markup, /取消子智能体/)
  assert.match(markup, /返回列表/)
  assert.match(markup, /aria-label="关闭子智能体面板"/)
  canCancel = false
  assert.equal(cancelButton(), undefined, 'unsupported or managed sessions never expose cancellation')
  canCancel = true
  for (const status of ['pendingInit', 'completed', 'interrupted', 'errored', 'shutdown'] as UASubAgent['status'][]) {
    child.status = status
    assert.equal(cancelButton(), undefined, 'only active running children can be cancelled')
  }
  child.status = 'running'
  const original = cancelButton()!
  const pending = original.props.onClick()
  assert.equal(cancelButton()?.props.disabled, true)
  assert.match(renderToStaticMarkup(render()), /正在取消…/)
  await original.props.onClick()
  assert.equal(nativeCalls, 1, 'repeated clicks do not issue duplicate native mutations')
  rejectNative!(new Error('Remote secret details must not be displayed'))
  await pending
  assert.equal(cancelButton()?.props.disabled, false)
  const failed = renderToStaticMarkup(render())
  assert.match(failed, /role="alert"[^>]*>取消失败，请重试。子智能体仍在运行。/)
  assert.doesNotMatch(failed, /Remote secret/)
  assert.equal(child.status, 'running')
  const delayedFailure = cancelButton()!.props.onClick()
  child.agentThreadId = 'other-child'
  rejectNative!(new Error('Late rejection for the previous child'))
  await delayedFailure
  assert.equal(elements(render()).some(element => element.props.role === 'alert'), false, 'a delayed failure never appears on another child')
  child.agentThreadId = 'child'
  canCancel = false
  assert.equal(elements(render()).some(element => element.props.role === 'alert'), false, 'a revoked cancellation permission also hides prior cancellation feedback')
  canCancel = true
  child.agentThreadId = 'other-child'
  assert.equal(elements(render()).some(element => element.props.role === 'alert'), false, 'a failure belongs only to its selected child')
  slots.length = 0
  child.agentThreadId = 'child'
  initialView = 'list'
  assert.equal(cancelButton(), undefined, 'list layout does not acquire per-child actions')
} finally {
  dispatcher.current = previous
  if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete (globalThis as any).localStorage
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete (globalThis as any).window
}
console.log('subagent-cancel-ui: supported running detail, duplicate guard, failure feedback and existing controls passed')
