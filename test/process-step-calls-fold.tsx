import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'

// DOMPurify 依赖浏览器 DOM；SSR 下直透（同 test/process-step-title-collapse.tsx）。
Object.assign(DOMPurify, { sanitize: (html: string) => html })

// 同一工作步骤内的调用/思考条目超过 12 条时，默认只直读最后 12 条，更早的
// 收进「更早的 N 条」折叠行；点击展开全部，再点收起。harness 同
// test/process-step-title-collapse.tsx（SSR 下保留 EventStream/ProcessStepRow 的
// useState 槽位，直接调用折叠行的 onClick 后重新渲染断言）。

;(globalThis as any).window = { getSelection: () => ({ isCollapsed: true }) }

function toolEvents(sessionId: string, count: number, fromSeq: number): UAEvent[] {
  // name 互不相同，避免相邻同名片被 stepEntries 合并为一个 ×N 条目。
  return Array.from({ length: count }, (_, i) => ({
    sessionId,
    seq: fromSeq + i,
    ts: 1_100 + i,
    type: 'tool_call',
    state: 'success',
    payload: { id: `tool-${fromSeq + i}`, name: `tool_${fromSeq + i}`, result: { ok: true } },
  }))
}

function sessionEvents(sessionId: string, callCount: number): UAEvent[] {
  return [
    { sessionId, seq: 0, ts: 1_000, type: 'user_message', payload: { text: '批量调用' } },
    {
      sessionId, seq: 1, ts: 1_001, type: 'agent_message', state: 'success',
      payload: { id: 'narr-1', phase: 'commentary', text: '开始执行。' },
    },
    ...toolEvents(sessionId, callCount, 2),
  ]
}

function renderStream(
  events: UAEvent[],
  sessionId: string,
  states: Map<string, any[]>,
  collect?: (item: React.ReactElement<any>) => void,
): string {
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
          collect?.(item)
          walk(item.props.children)
        })
      }
      walk(tree)
      return wrap(tree, `${path}/output`)
    }
    return React.createElement(Component, { key: node.key })
  }
  return renderToStaticMarkup(wrap(createElement(EventStream, {
    sessionId, status: 'running', events,
  })) as React.ReactElement)
}

// CompactCallRow 根节点在无修饰时序列化为 class="step-call"；折叠行按钮是
// class="step-call-row step-calls-fold"，不会被误计。
const countCallRows = (html: string): number => (html.match(/class="step-call"/g) || []).length

// 26 条调用：默认直读最后 12 条，折叠行提示「更早的 14 条」。
const states = new Map<string, any[]>()
let foldClick: (() => void) | undefined
const collectFold = (item: React.ReactElement<any>): void => {
  if (item.type === 'button' && typeof item.props.className === 'string' &&
    item.props.className.includes('step-calls-fold') && typeof item.props.onClick === 'function') {
    foldClick = item.props.onClick
  }
}
const before = renderStream(sessionEvents('calls-fold-session', 26), 'calls-fold-session', states, collectFold)
assert.equal(countCallRows(before), 12, '超过阈值时只直读最后 12 条')
assert.match(before, /class="step-call-row step-calls-fold" type="button" aria-expanded="false"/, '折叠行默认收起态')
assert.match(before, /更早的/, '折叠行提示存在更早条目')
assert.match(before, /更早的[\s\S]{0,30}?14[\s\S]{0,10}?条/, '折叠行统计隐藏条数')
assert.match(before, /26 工具/, 'meta 汇总不受折叠影响')
assert.ok(foldClick, '折叠行必须可点击')

// 点击折叠行展开全部 26 条，再点收起回到 12 条。
foldClick!()
const expanded = renderStream(sessionEvents('calls-fold-session', 26), 'calls-fold-session', states, collectFold)
assert.equal(countCallRows(expanded), 26, '展开后渲染全部条目')
assert.match(expanded, /收起[\s\S]{0,10}?更早的/, '展开后折叠行可再收起')
assert.match(expanded, /class="step-call-row step-calls-fold" type="button" aria-expanded="true"/)
foldClick!()
const collapsedAgain = renderStream(sessionEvents('calls-fold-session', 26), 'calls-fold-session', states, collectFold)
assert.equal(countCallRows(collapsedAgain), 12, '再点收起恢复直读最后 12 条')

// 5 条调用：不超阈值，全部直读，无折叠行。
const few = renderStream(sessionEvents('calls-fold-few', 5), 'calls-fold-few', new Map())
assert.equal(countCallRows(few), 5, '未超阈值全部直读')
assert.doesNotMatch(few, /step-calls-fold/, '未超阈值不渲染折叠行')

// 恰好 12 条：不触发折叠。
const exact = renderStream(sessionEvents('calls-fold-exact', 12), 'calls-fold-exact', new Map())
assert.equal(countCallRows(exact), 12, '恰好阈值全部直读')
assert.doesNotMatch(exact, /step-calls-fold/, '恰好阈值不渲染折叠行')

console.log('process step calls fold: ok')
