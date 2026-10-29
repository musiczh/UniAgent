import assert from 'node:assert/strict'
import { createElement } from 'react'
import DOMPurify from 'dompurify'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream.tsx'
import type { UAEvent } from '../src/shared/types.ts'
import { renderEventStream } from './regression/render-event-stream.mjs'

// DOMPurify needs a browser DOM; this test exercises EventStream's grouping and
// disclosure markup, so keep Markdown's sanitizer boundary inert.
;(DOMPurify as unknown as { sanitize: (html: string) => string }).sanitize = (html) => html

const events: UAEvent[] = [
  { sessionId: 's', seq: 1, ts: 1, type: 'user_message', payload: { text: '开始' } },
  { sessionId: 's', seq: 2, ts: 2, type: 'turn_started', payload: { turnId: 'main-turn' } },
  { sessionId: 's', seq: 3, ts: 3, type: 'agent_message', state: 'success', payload: { id: 'final', text: '主要最终回复', phase: 'final_answer' } },
  { sessionId: 's', seq: 4, ts: 4, type: 'turn_started', payload: { turnId: 'follow-up-turn' } },
  { sessionId: 's', seq: 5, ts: 5, type: 'agent_message', state: 'success', payload: { id: 'extra', text: '后台任务补充', phase: 'final_answer' } },
  { sessionId: 's', seq: 6, ts: 6, type: 'turn_completed', state: 'success', payload: { turnId: 'follow-up-turn' } },
]

const markup = renderToStaticMarkup(createElement(EventStream, { events, status: 'idle' }))

assert.match(markup, /主要最终回复/, 'the reply before completion remains the visible final answer')
assert.match(markup, /<details class="reply-supplements">/, 'post-completion replies use one collapsed disclosure')
assert.match(markup, /补充信息 · 1 条/)
assert.match(markup, /后台任务补充/)
assert.ok(
  markup.indexOf('主要最终回复') < markup.indexOf('reply-supplements'),
  'supplemental information renders below the final answer',
)
for (const status of ['completed', 'interrupted'] as const) {
  const child = { agentThreadId: 'native-child', parentThreadId: 'native-parent', name: 'Nika child', tool: 'spawnAgent', generation: 1, dispatchId: 'bg-child' }
  const late: UAEvent[] = [
    { sessionId: 's', seq: 1, ts: 1000, type: 'user_message', payload: { text: '等待后台任务' } },
    { sessionId: 's', seq: 2, ts: 1100, type: 'subagent', state: 'running', payload: { id: 'child-start', agents: [{ ...child, status: 'running' }] } },
    { sessionId: 's', seq: 3, ts: 1200, type: 'agent_message', state: 'success', payload: { id: 'waiting', text: '后台任务仍在执行。' } },
    { sessionId: 's', seq: 4, ts: 1300, type: 'subagent', state: 'success', payload: { id: 'child-terminal', agents: [{ ...child, status, endedAt: 1300 }] } },
    { sessionId: 's', seq: 5, ts: 1400, type: 'turn_completed', state: status === 'interrupted' ? 'cancelled' : 'success', payload: { id: 'turn' } }
  ]
  const phases = await renderEventStream(late, status === 'interrupted' ? 'cancelled' : 'idle', 's', { inspect: `(async () => {
    document.querySelectorAll('.processed-fold.closed > .processed-head').forEach(node => node.click());
    await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelectorAll('.process-step-meta[aria-expanded="false"]').forEach(node => node.click());
    await new Promise(resolve => setTimeout(resolve, 100));
    return [...document.querySelectorAll('.sa-line .st')].map(node => node.textContent);
  })()` })
  assert.ok(phases.includes(status === 'interrupted' ? '已中断' : '已完成'), 'child terminal activity after the last assistant reply must remain visible in the existing process')
}

console.log('post-completion supplement: ok')
