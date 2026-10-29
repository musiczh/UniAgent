import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'

// DOMPurify 依赖浏览器 DOM；SSR 下直透（同 test/process-timeline.tsx）。
Object.assign(DOMPurify, { sanitize: (html: string) => html })

// 展开的工作步骤，其旁白标题（Markdown）也可点击收起；拖选文字时不收起。
// SSR 下保留 EventStream/ProcessStepRow 的 useState 槽位，直接调用标题 div 的
// onClick 后重新渲染断言（harness 参照 test/regression/open-chain.tsx）。

let selectionCollapsed = true
;(globalThis as any).window = { getSelection: () => ({ isCollapsed: selectionCollapsed }) }

const events: UAEvent[] = [
  { sessionId: 'step-title-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: '排查折叠交互' } },
  {
    sessionId: 'step-title-session', seq: 1, ts: 1_001, type: 'agent_message', state: 'success',
    payload: { id: 'narr-1', phase: 'commentary', text: '找到了两种渲染路径：`LiveTurn` 与 `ProcessedFold`。' },
  },
  {
    sessionId: 'step-title-session', seq: 2, ts: 1_002, type: 'tool_call', state: 'success',
    payload: { id: 'tool-1', name: 'read_file', result: { ok: true } },
  },
  {
    sessionId: 'step-title-session', seq: 3, ts: 1_003, type: 'tool_call', state: 'success',
    payload: { id: 'tool-2', name: 'write_file', result: { ok: true } },
  },
]

function renderStream(states: Map<string, any[]>, collect: (item: React.ReactElement<any>) => void): string {
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const wrap = (node: React.ReactNode, path = 'root'): React.ReactNode => {
    if (Array.isArray(node)) return node.map((child, i) => wrap(child, `${path}/${i}`))
    if (!React.isValidElement<any>(node)) return node
    const Original: any = node.type
    const props = { ...node.props, children: wrap(node.props.children, `${path}/children`) }
    if (typeof Original !== 'function') return React.cloneElement(node, props)
    const Component = (): React.ReactNode => {
      const previous = dispatcher.current
      const slots = states.get(path) || []
      states.set(path, slots)
      let index = 0
      if (['EventStream', 'ProcessStepRow'].includes(Original.name)) dispatcher.current = {
        ...previous,
        useState(initial: any) {
          const slot = index++
          if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
          return [slots[slot], (next: any) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }]
        },
      }
      let tree: React.ReactNode
      try { tree = Original(props) } finally { dispatcher.current = previous }
      const walk = (child: React.ReactNode): void => {
        React.Children.forEach(child, (item) => {
          if (!React.isValidElement<any>(item)) return
          collect(item)
          walk(item.props.children)
        })
      }
      walk(tree)
      return wrap(tree, `${path}/output`)
    }
    return React.createElement(Component, { key: node.key })
  }
  return renderToStaticMarkup(wrap(createElement(EventStream, {
    sessionId: 'step-title-session', status: 'running', events,
  })) as React.ReactElement)
}

function clickMarkdownTitle(): { before: string; after: string } {
  const states = new Map<string, any[]>()
  let titleClick: (() => void) | undefined
  const collect = (item: React.ReactElement<any>): void => {
    if (item.type === 'div' && item.props.className === 'process-step-markdown' && typeof item.props.onClick === 'function') {
      titleClick = item.props.onClick
    }
  }
  const before = renderStream(states, collect)
  assert.ok(titleClick, '展开态旁白标题必须可点击收起')
  titleClick!()
  const after = renderStream(states, collect)
  return { before, after }
}

// 旁白标题 + 两次工具调用构成一个默认展开的活动步骤。
selectionCollapsed = true
const collapsed = clickMarkdownTitle()
assert.match(collapsed.before, /class="process-step active open"/, '活动步骤默认展开')
assert.match(collapsed.before, /process-step-markdown/, '展开态标题渲染为 Markdown')
assert.match(collapsed.before, /aria-label="收起工作步骤" aria-expanded="true"/, '展开态 meta 按钮可收起')
assert.match(collapsed.before, /2 工具/, 'meta 汇总工具调用次数')
assert.doesNotMatch(collapsed.after, /process-step-markdown/, '点击标题后步骤收起，标题回到单行按钮')
assert.match(collapsed.after, /class="process-step active"/, '收起后步骤保留 active 但去掉 open')
assert.doesNotMatch(collapsed.after, /class="process-step active open"/)
assert.match(collapsed.after, /process-step-title" type="button" aria-expanded="false"/, '收起态标题按钮可重新展开')
assert.match(collapsed.after, /aria-label="展开工作步骤" aria-expanded="false"/, '收起态 meta 按钮同步')

// 拖选文字（selection 非折叠）时点击不收起，避免打断复制/评论选区。
selectionCollapsed = false
const selecting = clickMarkdownTitle()
assert.match(selecting.after, /class="process-step active open"/, '拖选文字时点击不收起步骤')
assert.match(selecting.after, /aria-label="收起工作步骤" aria-expanded="true"/)

console.log('process step title collapse: ok')
