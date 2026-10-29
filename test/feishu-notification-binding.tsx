import assert from 'node:assert/strict'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FeishuNotificationSettings } from '../src/renderer/components/FeishuNotificationSettings'
import type { FeishuNotificationBinding, FeishuStatus } from '../src/shared/types'

const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const slots: any[] = []
let cursor = 0
let effects: (() => void)[] = []
let status: FeishuStatus = { enabled: true, connected: true, phase: 'connected', appId: 'cli_fixture' }
let scans: () => Promise<unknown[]> = async () => [{ chatId: 'oc_group', name: '项目群' }, { chatId: 'oc_other', name: '' }]
let failBegin = false
let failSelection = false
let selectionPending: Promise<void> | undefined
const starts: FeishuNotificationBinding[] = []
const opened: string[] = []
const onStatus = (next: FeishuStatus) => { status = next }
const flush = () => new Promise<void>(done => setImmediate(done))
Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
  feishuBeginNotificationBinding: async (input: FeishuNotificationBinding) => {
    starts.push(input)
    if (failBegin) throw new Error("Error invoking remote method 'feishu:beginNotificationBinding': Error: 飞书 Bot 未连接")
    if (input.kind === 'group' && input.chatId) {
      if (failSelection) throw new Error('绑定未能保存，请重试')
      await selectionPending
      return { ...status, notificationBinding: undefined, notificationTarget: { kind: 'group', chatId: input.chatId, name: input.name } }
    }
    return { ...status, notificationBinding: input }
  },
  feishuCancelNotificationBinding: async () => ({ ...status, notificationBinding: undefined }),
  feishuUnbindNotificationTarget: async () => ({ ...status, notificationTarget: undefined, notificationBinding: undefined }),
  feishuScanGroups: () => scans(),
  openExternal: async (url: string) => { opened.push(url) }
} } })
dispatcher.current = {
  useState(initial: any) {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = initial
    return [slots[slot], (next: any) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }]
  },
  useRef(current: any) { const slot = cursor++; return slots[slot] ||= { current } },
  useEffect(effect: () => unknown, deps: unknown[]) {
    const slot = cursor++, prior = slots[slot]
    if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) {
      prior?.cleanup?.(); slots[slot] = { deps }; effects.push(() => { slots[slot].cleanup = effect() })
    }
  }
}
function render() {
  cursor = 0
  const tree = FeishuNotificationSettings({ status, onStatus })
  const pending = effects; effects = []; pending.forEach(effect => effect())
  return tree
}
function elements(node: ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<any>(child)) return []
    if (typeof child.type === 'function') return elements((child.type as any)(child.props))
    return [child, ...elements(child.props.children)]
  })
}
const markup = () => renderToStaticMarkup(render())
function button(text: string) {
  const found = elements(render()).find(element => element.type === 'button' && renderToStaticMarkup(element).includes(text))
  assert.ok(found, 'expected button: ' + text)
  return found
}
try {
  assert.match(markup(), /尚未绑定/)
  assert.equal(button('绑定到私人聊天').props.disabled, false)
  assert.equal(button('绑定到群聊').props.disabled, false)
  button('绑定到私人聊天').props.onClick()
  await flush()
  assert.deepEqual(starts.at(-1), { kind: 'private' })
  assert.match(markup(), /等待你发送消息/)
  assert.doesNotMatch(markup(), />绑定成功</)
  button('打开机器人私聊').props.onClick()
  await flush()
  assert.equal(opened.at(-1), 'https://applink.feishu.cn/client/bot/open?appId=cli_fixture')
  status = { ...status, notificationBinding: { kind: 'private', error: '绑定未完成，请重试' } }
  assert.match(markup(), /role="alert">绑定未完成/)
  status = { ...status, notificationBinding: undefined, notificationTarget: { kind: 'private', chatId: 'oc_dm' } }
  assert.match(markup(), /已绑定到私人聊天/)
  assert.match(markup(), /绑定成功/)
  assert.doesNotMatch(markup(), /等待你发送消息/)

  button('更换目标').props.onClick()
  button('绑定到群聊').props.onClick()
  await flush()
  assert.match(markup(), /原通知目标保持生效/)
  assert.match(markup(), /选择后立即完成绑定/)
  const heading = elements(render()).find(element => element.props.className === 'feishu-notification-group-heading')
  assert.ok(heading, 'the scan action belongs beside the group-selection heading')
  assert.match(renderToStaticMarkup(heading), /扫描并选择要绑定的群聊/)
  assert.ok(elements(heading).some(element => element.type === 'button' && renderToStaticMarkup(element).includes('扫描群聊')))
  button('扫描群聊').props.onClick()
  await flush()
  assert.match(markup(), /项目群/)
  const groupItems = elements(render()).filter(element => element.props.className === 'feishu-notification-group')
  assert.equal(groupItems.length, 2, 'each scanned group has its own item')
  const groupItem = groupItems[0]
  assert.match(renderToStaticMarkup(groupItem), /项目群/)
  assert.ok(elements(groupItem).some(element => element.type === 'button' && renderToStaticMarkup(element).includes('选择')))
  assert.match(renderToStaticMarkup(groupItems[1]), /oc_other/, 'a missing group name falls back to its chat ID')
  assert.ok(elements(groupItems[1]).some(element => element.type === 'button' && element.props['aria-label'] === '绑定到oc_other'))
  failSelection = true
  button('选择').props.onClick()
  await flush()
  assert.equal(status.notificationTarget?.chatId, 'oc_dm', 'failed selection keeps the existing target')
  assert.match(markup(), /role="alert">绑定未能保存/)
  assert.match(markup(), /项目群/, 'the group stays available for retry')
  failSelection = false
  let resolveSelection!: () => void
  selectionPending = new Promise(resolve => { resolveSelection = resolve })
  button('选择').props.onClick()
  assert.equal(button('选择').props.disabled, true)
  assert.equal(button('重新扫描').props.disabled, true)
  assert.doesNotMatch(markup(), />绑定成功</, 'the UI must wait for persistence before reporting success')
  resolveSelection()
  await flush()
  selectionPending = undefined
  assert.deepEqual(starts.at(-1), { kind: 'group', chatId: 'oc_group', name: '项目群' })
  assert.match(markup(), /已绑定到群聊/)
  assert.match(markup(), /绑定成功/)
  assert.doesNotMatch(markup(), /等待该群|在该群中|绑定通知|扫描并选择要绑定的群聊/)

  button('更换目标').props.onClick()
  button('绑定到群聊').props.onClick()
  await flush()
  let resolveScan!: (groups: unknown[]) => void
  scans = () => new Promise(resolve => { resolveScan = resolve })
  button('扫描群聊').props.onClick()
  button('取消').props.onClick()
  await flush()
  markup()
  resolveScan([{ chatId: 'oc_stale', name: '过期群聊' }])
  await flush()
  assert.match(markup(), /已绑定到群聊/)
  assert.doesNotMatch(markup(), /过期群聊|等待该群/)
  button('解绑').props.onClick()
  await flush()
  assert.match(markup(), /尚未绑定/)

  failBegin = true
  button('绑定到私人聊天').props.onClick()
  await flush()
  assert.match(markup(), /role="alert">飞书 Bot 未连接/)
  assert.doesNotMatch(markup(), /Error invoking remote method/)
  failBegin = false
  button('绑定到群聊').props.onClick()
  await flush()
  scans = async () => []
  button('扫描群聊').props.onClick()
  await flush()
  assert.match(markup(), /未找到群聊/)
  scans = async () => { throw new Error('transport failure') }
  button('重新扫描').props.onClick()
  await flush()
  assert.match(markup(), /扫描失败/)
  button('取消').props.onClick()
  await flush()
  assert.doesNotMatch(markup(), /等待该群|请先扫描/)
  status = { ...status, connected: false }
  assert.equal(button('绑定到私人聊天').props.disabled, true)
  assert.equal(button('绑定到群聊').props.disabled, true)
  assert.match(markup(), /请先连接会话机器人/)
  status = { ...status, notificationTarget: { kind: 'private', chatId: 'oc_dm' } }
  assert.match(markup(), /机器人未连接，恢复后继续通知/)
  console.log('feishu-notification-binding: ok')
} finally {
  slots.forEach(slot => slot?.cleanup?.())
  dispatcher.current = previous
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}
