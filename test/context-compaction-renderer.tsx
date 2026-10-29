import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'
import { renderOpenChains } from './regression/open-chain'
import { renderEventStream } from './regression/render-event-stream.mjs'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (seq: number, type: UAEvent['type'], payload: Record<string, unknown>, state: UAEvent['state'] = 'success'): UAEvent =>
  ({ sessionId: 'compaction-renderer', seq, ts: seq * 1000, type, payload, state })
const history = [
  event(1, 'user_message', { text: 'hello' }),
  event(2, 'agent_message', { id: 'reply', text: 'done', phase: 'final_answer' }),
  event(3, 'turn_completed', { id: 'completion' }),
]

function turnKeys(events: UAEvent[]): string[] {
  const keys: string[] = []
  function Probe(): null {
    const visit = (node: React.ReactNode): void => {
      React.Children.forEach(node, child => {
        if (!React.isValidElement<any>(child)) return
        if (typeof child.type === 'function' && child.type.name === 'TurnBlock') keys.push(String(child.key))
        visit(child.props.children)
      })
    }
    visit(EventStream({ events, status: 'idle' }))
    return null
  }
  renderToStaticMarkup(React.createElement(Probe))
  return keys
}

const running = turnKeys([...history, event(4, 'context_compaction', { id: 'compact-a' }, 'running')])
const completed = turnKeys([...history, event(5, 'context_compaction', { id: 'compact-a' })])
assert.equal(running.length, 2, 'idle compaction must have its own turn after the completed reply')
assert.deepEqual(completed, running, 'terminal event sequence must not remount the compaction turn and reset its expanded step')
const next = turnKeys([...history, event(5, 'context_compaction', { id: 'compact-a' }), event(6, 'user_message', { text: 'next' }), event(7, 'turn_completed', {}), event(8, 'context_compaction', { id: 'compact-a' })])
assert.equal(new Set(next).size, next.length, 'a rebuilt runner may reuse compaction IDs after a different completed turn')

const work = [
  event(1, 'user_message', { text: 'continue' }),
  event(2, 'agent_message', { id: 'work', text: '核对结果', phase: 'commentary' }),
  event(3, 'command_exec', { id: 'before', command: 'before-compaction' }),
  event(4, 'context_compaction', { id: 'compact' }, 'running'),
  event(5, 'context_compaction', { id: 'compact' }, 'running'),
  { ...event(6, 'context_compaction', { id: 'compact' }), ts: 9500 },
  event(10, 'tool_call', { id: 'after', name: 'after-compaction', input: {} }),
]
const live = work.reduce<UAEvent[]>((events, update) => mergeSessionEvent(events, update), [])
for (const events of [work, live]) {
  const markup = renderToStaticMarkup(React.createElement(EventStream, { events, status: 'running' }))
  assert.equal((markup.match(/data-step-id=/g) || []).length, 1,
    '压缩前后工具调用继续追加到同一个工作 item')
  assert.doesNotMatch(markup, /process-runtime|执行调用/,
    '压缩不单独创建时间线节点，也不截断当前步骤')
  assert.match(markup, /工作过程<\/b> · 1 步 · 2 次调用/)
  assert.equal((markup.match(/data-compaction-id="compact"/g) || []).length, 1,
    '重复的开始与完成快照只显示一条压缩记录')
  assert.ok(markup.indexOf('before-compaction') < markup.indexOf('data-compaction-id="compact"') &&
    markup.indexOf('data-compaction-id="compact"') < markup.indexOf('after-compaction'),
    'item 内按调用、压缩、后续调用的发生顺序展示')
  assert.match(markup, /context-compaction-duration[^>]*>5\.5s</,
    '耗时从第一次压缩开始计算，实时合并和历史恢复结果一致')
}

const anotherStep = [
  ...live,
  event(11, 'agent_message', { id: 'next-work', text: '继续验证', phase: 'commentary' }),
  event(12, 'command_exec', { id: 'next-command', command: 'next-work-command' }),
]
const collapsed = renderToStaticMarkup(React.createElement(EventStream, { events: anotherStep, status: 'running' }))
assert.equal((collapsed.match(/data-step-id=/g) || []).length, 2, '新的旁白仍开启新的工作 item')
assert.doesNotMatch(collapsed, /data-compaction-id=/, '收起前一个 item 时压缩记录随调用明细隐藏')
const expanded = renderOpenChains(React.createElement(EventStream, { events: anotherStep, status: 'running' }))
assert.match(expanded, /data-compaction-id="compact"/, '展开后可以回看压缩记录与耗时')

for (const state of ['failed', 'cancelled'] as const) {
  const events = [...work.slice(0, 5), event(6, 'context_compaction', { id: 'compact', error: '压缩请求失败' }, state)]
  const markup = renderToStaticMarkup(React.createElement(EventStream, { events, status: 'running' }))
  assert.equal((markup.match(/data-step-id=/g) || []).length, 1)
  assert.match(markup, state === 'failed' ? /压缩请求失败/ : /已取消/)
  assert.match(markup, /context-compaction-duration[^>]*>2\.0s</, '失败或取消也保留真实压缩耗时')
}

const onlyCompletion = renderToStaticMarkup(React.createElement(EventStream, {
  events: [work[0], work[1], work[2], event(4, 'context_compaction', { id: 'legacy' })], status: 'running',
}))
assert.match(onlyCompletion, /data-compaction-id="legacy"/)
assert.doesNotMatch(onlyCompletion, /context-compaction-duration/, '缺少开始记录的历史压缩不编造耗时')

const leadingCompaction = renderToStaticMarkup(React.createElement(EventStream, {
  events: [work[0], work[3], work[5], work[6]], status: 'running',
}))
assert.equal((leadingCompaction.match(/data-step-id=/g) || []).length, 1,
  '回合开始就压缩时，由任务开始 item 承载压缩与后续调用')
assert.doesNotMatch(leadingCompaction, /process-runtime|执行调用/)

const finished = renderOpenChains(React.createElement(EventStream, {
  events: [...live, event(11, 'agent_message', { id: 'final', text: '完成', phase: 'final_answer' }), event(12, 'turn_completed', {})],
  status: 'idle',
}), { processed: true })
assert.equal((finished.match(/data-step-id=/g) || []).length, 1, '完成回合也沿用相同归并结果')
assert.match(finished, /context-compaction-duration[^>]*>5\.5s</)

const manual = renderToStaticMarkup(React.createElement(EventStream, {
  events: [...history, event(4, 'context_compaction', { id: 'manual' }, 'running'), event(7, 'context_compaction', { id: 'manual' })],
  status: 'idle',
}))
assert.match(manual, /data-compaction-id="manual"/, '空闲时手动压缩的记录保持可见')
assert.match(manual, /context-compaction-duration[^>]*>3\.0s</)

const progress = await renderEventStream(work.slice(0, 5), 'running', 'compaction-renderer', {
  setup: `window.compactionNow = 10000; Date.now = () => window.compactionNow;`,
  inspect: `(async () => {
    const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
    const snapshot = () => ({
      steps: document.querySelectorAll('[data-step-id]').length,
      elapsed: document.querySelector('.context-compaction-duration')?.textContent,
      inside: !!document.querySelector('.context-compaction')?.closest('.process-step-calls'),
      state: document.querySelector('.context-compaction-status')?.textContent,
    });
    const initial = snapshot();
    window.compactionNow = 12000; await tick(1100);
    const advanced = snapshot();
    document.querySelector('.process-step-meta').click(); await tick(240);
    const collapsed = snapshot();
    document.querySelector('.process-step-meta').click(); await tick(40);
    const reopened = snapshot();
    return { initial, advanced, collapsed, reopened };
  })()`,
})
assert.equal(progress.initial.steps, 1)
assert.equal(progress.initial.inside, true, '真实 DOM 中压缩行位于 item 的调用列表内')
assert.match(progress.initial.state, /压缩中/)
assert.equal(progress.initial.elapsed, '6.0s')
assert.equal(progress.advanced.elapsed, '8.0s', '压缩中耗时随时钟更新')
assert.equal(progress.collapsed.elapsed, undefined, '点击收起后压缩明细一起隐藏')
assert.equal(progress.reopened.elapsed, '8.0s', '重新展开仍从首次开始计时')

console.log('context compaction renderer: stable identity, owned item, continuation and elapsed time ok')
