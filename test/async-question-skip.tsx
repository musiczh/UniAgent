import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalCard } from '../src/renderer/components/EventStream'
import { asInteractionRequest, asyncQuestionReply } from '../src/shared/interactionRequests'
import type { UAEvent } from '../src/shared/types'
import { renderEventStream } from './regression/render-event-stream.mjs'

const sessionId = 'async-skip'
const question: UAEvent = { sessionId, seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: {
  id: 'group', delivery: 'async', questions: [
    { id: 'device', question: '设备是否已解锁？', options: ['已解锁', '暂时无法解锁'] },
    { id: 'note', question: '补充说明？' },
  ],
} }
const skipped = { action: 'skip' }
const resolved = asInteractionRequest({ ...question, payload: { ...question.payload, submittedAnswer: skipped } })
const markup = renderToStaticMarkup(<ApprovalCard ev={resolved} readOnly />)
assert.match(markup, /已跳过/)
assert.doesNotMatch(markup, /已回答|去回答|interaction-step answered/, '跳过在时间线中不能显示成已回答')

const other: UAEvent = { ...question, seq: 3, ts: 3, payload: { id: 'other', delivery: 'async', questions: [{ id: 'other', question: '另一组提问？', options: ['继续'] }] } }
const events: UAEvent[] = [
  { sessionId, seq: 0, ts: 0, type: 'user_message', payload: { text: '准备测试' } },
  { sessionId, seq: 1, ts: 1, type: 'turn_started', payload: {} },
  question, other,
]
const result = await renderEventStream(events, 'running', sessionId, {
  setup: `
    window.__responses = [];
    window.__eventStreamProps = { onRespond: async (id, answer) => {
      window.__responses.push({id, answer});
      if (window.__responses.length === 1) await new Promise((resolve, reject) => {
        window.__rejectResponse = () => reject(new Error('发送失败，请重试'));
      });
    }};
  `,
  inspect: `(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 80));
    const panel = () => document.querySelector('[data-request-panel]:not([hidden])');
    const button = label => [...(panel()?.querySelectorAll('button') || [])].find(node => node.textContent.trim() === label);
    const initial = { nextDisabled: button('下一题')?.disabled, skipEnabled: !!button('跳过') && !button('跳过').matches(':disabled') };
    if (!button('跳过')) return {initial};
    const options = panel().querySelectorAll('.question-opt input[type=radio]');
    options[0].click();
    await wait();
    button('下一题').click();
    await wait();
    const input = panel().querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '保留草稿');
    input.dispatchEvent(new Event('input', {bubbles:true}));
    await wait();
    const actions = [...panel().querySelector('.approval-actions').children].map(node => node.textContent.trim());
    button('跳过').click();
    await wait();
    const disabledDuringSend = button('跳过').matches(':disabled') && button('提交回答').matches(':disabled');
    button('跳过').click();
    const callsDuringSend = window.__responses.length;
    window.__rejectResponse();
    await wait();
    const retry = { error: panel().querySelector('[role=alert]')?.textContent, draft: panel().querySelector('textarea')?.value, enabled: !button('跳过').matches(':disabled') };
    button('跳过').click();
    await wait();
    const after = { panels: document.querySelectorAll('[data-request-panel]').length, active: panel()?.textContent, states: [...document.querySelectorAll('.interaction-state')].map(node => node.textContent.trim()) };
    button('跳过').click();
    await wait();
    const details = [...document.querySelectorAll('.interaction-link')].filter(node => node.textContent.trim() === '详情');
    details[0]?.click();
    await wait();
    return { initial, actions, disabledDuringSend, callsDuringSend, retry, after, responses: window.__responses, remaining: document.querySelectorAll('[data-request-panel]').length, details: document.querySelector('.readonly-approval')?.textContent };
  })()`,
})
assert.deepEqual(result.initial, { nextDisabled: true, skipEnabled: true }, '必填内容为空时仍允许跳过')
assert.deepEqual(result.actions, ['上一题', '跳过', '提交回答'])
assert.equal(result.disabledDuringSend, true)
assert.equal(result.callsDuringSend, 1, '发送中禁止重复提交')
assert.deepEqual(result.retry, { error: '发送失败，请重试', draft: '保留草稿', enabled: true })
assert.equal(result.after.panels, 1)
assert.match(result.after.active, /另一组提问？/, '只处理当前整组，其它提问仍可操作')
assert.deepEqual(result.after.states, ['已跳过', '待回答'])
assert.deepEqual(result.responses, [
  { id: 'async-question:group', answer: skipped },
  { id: 'async-question:group', answer: skipped },
  { id: 'async-question:other', answer: skipped },
], '跳过提交独立结果，不发送已选答案或草稿')
assert.equal(result.remaining, 0)
assert.match(result.details, /已跳过/)
assert.doesNotMatch(result.details, /已回答|保留草稿/)

const native: UAEvent = { ...asInteractionRequest(question), payload: { ...asInteractionRequest(question).payload, requestId: 'native-question', delivery: undefined } }
const management: UAEvent = { ...native, seq: 3, payload: { ...native.payload, requestId: 'management-confirmation:1', delivery: 'async', method: 'local/assistantManage' } }
const unchanged = await renderEventStream([events[0], native, management], 'running', sessionId)
assert.doesNotMatch(unchanged, />跳过<\/button>/, '原生同步提问及管理操作确认不增加跳过')

const reply = asyncQuestionReply(question, skipped)
const history = await renderEventStream([
  events[0], events[1],
  { ...question, payload: { ...question.payload, submittedAnswer: skipped } },
  { sessionId, seq: 4, ts: 4, type: 'user_message', payload: { text: reply, appendedToTurn: true, asyncQuestion: true } },
], 'running', sessionId, { inspect: `(async () => {
  for (const node of document.querySelectorAll('.steps-fold-row[aria-expanded=false], .process-step-meta[aria-expanded=false]')) node.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const reply=document.querySelector('.async-question-reply');
  const initial={collapsed:reply instanceof HTMLDetailsElement && !reply.open,preview:reply.querySelector('.async-reply-preview')?.textContent};
  reply.querySelector('.user-append-head').click();
  return {initial,open:reply.open,questions:[...reply.querySelectorAll('.async-reply-question > div')].map(node=>node.textContent),answers:[...reply.querySelectorAll('.async-reply-answer > div')].map(node=>node.textContent),markup:document.body.innerHTML};
})()` })
assert.deepEqual(history.initial, { collapsed: true, preview: '设备是否已解锁？；补充说明？' }, '跳过的多题回答也默认折叠，摘要只展示问题')
assert.equal(history.open, true)
assert.deepEqual(history.questions, ['设备是否已解锁？', '补充说明？'])
assert.deepEqual(history.answers, ['已跳过', '已跳过'], '展开后保留每道题的跳过结果')
assert.match(history.markup, /跳过异步提问/)
assert.doesNotMatch(history.markup, /我的回答<\/span><div>未回答/)

console.log('async question skip: empty/grouped forms, retry, pending isolation and history verified')
