import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../src/renderer/components/EventStream'
import { TeamSessionProvider } from '../src/renderer/components/TeamSessionExtras'
import type { UAEvent } from '../src/shared/types.ts'
import { renderEventStream } from './regression/render-event-stream.mjs'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (
  seq: number,
  type: UAEvent['type'],
  payload: Record<string, unknown>,
  state: UAEvent['state'] = 'success',
): UAEvent => ({ sessionId: 'timeline', seq, ts: seq * 1_000, type, state, payload })

const markup = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  sessionId: 'timeline',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'agent_message', { id: 'step-1', phase: 'commentary', text: '第一步' }),
    event(3, 'command_exec', { id: 'command-1', command: 'pwd' }),
    event(4, 'agent_message', { id: 'step-2', phase: 'commentary', text: '第二步' }),
    event(5, 'command_exec', { id: 'command-2', command: 'ls' }),
    event(6, 'reasoning', { id: 'reasoning-2', text: '正在核对最终结果' }, 'running'),
  ],
}))

assert.match(markup, /process-step-node[^>]*><span class="process-step-done-dot"/,
  '完成步骤使用绿色圆点，而不是勾选图标')
assert.match(markup, /process-step active open[\s\S]*process-step-live-dot/,
  '当前步骤使用运行态圆点')
assert.doesNotMatch(markup, /ui-icon-check/,
  '步骤时间线不再渲染完成勾选图标')
assert.match(markup, /<svg width="14"[^>]*ui-icon-lightbulb/,
  '思考与调用行的主图标统一为 14px')
assert.match(markup, /reasoning-title">思考<\/span>[\s\S]*reasoning-preview"[^>]*>正在核对最终结果<\/span>[\s\S]*reasoning-caret[\s\S]*<svg width="12"[^>]*ui-icon-chevron is-open/,
  '思考标题后显示正文预览，并以 12px 向下箭头表示展开状态')
assert.match(markup, /reasoning-body[\s\S]*正在核对最终结果/,
  '最新 item 为思考时默认展开完整正文')
assert.match(markup, /animated-collapse is-open process-step-disclosure" data-collapse-state="open" aria-hidden="false"><div class="animated-collapse-inner"><div class="process-step-calls/,
  '展开的工作步骤通过可动画的内容容器呈现调用明细')
assert.match(markup, /animated-collapse is-open reasoning-disclosure" data-collapse-state="open" aria-hidden="false"[\s\S]*reasoning-body/,
  '自动展开的思考详情也使用同一动效容器')
assert.match(markup, /step-call-row" type="button" aria-expanded="false"[\s\S]*animated-collapse is-closed step-call-disclosure" data-collapse-state="closed" aria-hidden="true"[\s\S]*<pre>ls<\/pre>/,
  '由 details 改造的调用详情在收起时保留内容状态，并从可访问树隐藏')

const streamingBeforePhase = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  sessionId: 'timeline',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'agent_message', { id: 'streaming-step', text: '首个字符开始就在步骤节点内' }, 'running'),
  ],
}))

assert.match(streamingBeforePhase, /process-step active open[\s\S]*process-step-live-dot[\s\S]*首个字符开始就在步骤节点内/,
  '阶段尚未到达时，流式过程文本从首字开始就在活动圆形节点内')
assert.doesNotMatch(streamingBeforePhase, /card agent-msg/,
  '阶段尚未到达的流式过程文本不先渲染为裸回复')

const emptyReasoningAfterTitle = renderToStaticMarkup(createElement(EventStream, {
  status: 'running',
  sessionId: 'timeline',
  events: [
    event(1, 'user_message', { text: 'run' }),
    event(2, 'agent_message', { id: 'step-with-empty-reasoning', phase: 'commentary', text: '准备开始' }),
    event(3, 'reasoning', { id: 'empty-reasoning', text: '' }, 'running'),
  ],
}))

assert.doesNotMatch(emptyReasoningAfterTitle, /process-step-calls/,
  '步骤内没有可见事件时不渲染空白明细容器')

const finalTeamTurn = renderToStaticMarkup(createElement(
  TeamSessionProvider,
  {
    project: {
      id: 'team-project', runId: 1, status: 'waiting_user', archivedAt: undefined,
      assignments: [], interactions: [], artifacts: [], memberSessions: { leader: 'timeline' },
      team: { leaderMemberId: 'leader', members: [{ id: 'leader', role: { name: 'Leader' } }] },
    },
    sessions: [{ id: 'timeline', status: 'idle' }],
    onOpenMember: () => {},
  } as any,
  createElement(EventStream, {
    status: 'idle',
    sessionId: 'timeline',
    events: [
      event(20, 'user_message', { text: 'finish the work' }),
      event(21, 'agent_message', { id: 'work', phase: 'commentary', text: '正在收尾' }),
      event(22, 'command_exec', { id: 'verify', command: 'git status' }),
      event(23, 'agent_message', { id: 'final', phase: 'final_answer', text: '已经完成。' }),
      event(24, 'turn_completed', { turnId: 'team-turn' }),
    ],
  })
))
assert.match(finalTeamTurn, /processed-fold closed/,
  'a final Leader reply closes the timeline even while the team project remains live')
assert.match(finalTeamTurn, /已经完成。/,
  'the closed timeline keeps the final Leader reply visible')

const planEvents = [
  event(1, 'user_message', { text: '先制定计划' }),
  event(2, 'command_exec', { id: 'before-plan', command: 'echo before-plan' }),
  event(3, 'agent_message', { id: 'plan-body', kind: 'plan', text: '# 当前计划\n\n核对当前工作区。' }),
  event(4, 'approval_request', {
    requestId: 'plan-approval', kind: 'planMode', method: 'kimi/web/approval', params: {},
    submittedAnswer: { decision: 'approved' },
  }),
  event(5, 'command_exec', { id: 'after-plan', command: 'echo after-plan' }),
]
const planMarkup = renderToStaticMarkup(createElement(EventStream, {
  status: 'running', sessionId: 'timeline', events: planEvents,
}))
assert.doesNotMatch(planMarkup, /plan-message|当前计划/,
  '计划正文不再作为时间轴外的回复卡片重复展示')
const planIndex = planMarkup.indexOf('data-interaction-seq="4"')
assert.ok(planIndex > planMarkup.indexOf('before-plan') && planIndex < planMarkup.indexOf('after-plan'),
  '计划确认节点按发生顺序位于前后工具调用之间')
assert.ok(planIndex < planMarkup.indexOf('status-line'), '计划确认节点显示在实时状态行上方')
assert.match(planMarkup, /interaction-state">已确认/)

for (const [state, submittedAnswer, label] of [
  ['success', { decision: 'rejected' }, '已反馈'],
  ['cancelled', { decision: 'cancelled' }, '已取消'],
] as const) {
  const history = await renderEventStream([
    ...planEvents.slice(0, 3),
    { ...planEvents[3], state, payload: { ...planEvents[3].payload, submittedAnswer } },
    event(5, 'agent_message', { id: 'final', phase: 'final_answer', text: '保留正常的最终回复' }),
    event(6, 'turn_completed', {}),
  ], 'completed', 'timeline', {
    inspect: `(async()=>{
      const stream=document.querySelector('.event-stream');
      stream.querySelector('.processed-head').click();
      await new Promise(resolve=>setTimeout(resolve,100));
      const row=stream.querySelector('[data-interaction-seq="4"]');
      const initial={nodes:stream.querySelectorAll('[data-interaction-seq="4"]').length,outcome:row.querySelector('.interaction-state').textContent,body:stream.textContent.includes('核对当前工作区。'),final:stream.textContent.includes('保留正常的最终回复')};
      row.querySelector('.interaction-link').click();
      await new Promise(resolve=>setTimeout(resolve,100));
      return {initial,detail:row.querySelector('.readonly-approval')?.textContent};
    })()`,
  })
  assert.deepEqual(history.initial, { nodes: 1, outcome: label, body: false, final: true },
    '已完成时间轴保留一个计划节点及审批结果，正常最终回复仍然可见')
  assert.match(history.detail, /核对当前工作区。/, '历史计划详情仍可展开')
}

const nativePlan = await renderEventStream(planEvents.map(item => item.seq === 4
  ? { ...item, state: 'pending', payload: { ...item.payload, submittedAnswer: undefined } }
  : item).slice(0, 4), 'awaiting-approval', 'timeline', {
  setup: `window.__answers=[];window.__eventStreamProps={onRespond:async(requestId,answer)=>window.__answers.push({requestId,answer})};`,
  inspect: `(async()=>{
    const wait=()=>new Promise(resolve=>setTimeout(resolve,100));
    const stream=document.querySelector('.event-stream');
    const row=stream.querySelector('[data-interaction-seq="4"]');
    const dock=document.querySelector('.interaction-dock');
    const initial={nodes:stream.querySelectorAll('[data-interaction-seq="4"]').length,cards:stream.querySelectorAll('.plan-message').length,bodyInStream:stream.textContent.includes('核对当前工作区。'),bodyInDock:dock.textContent.includes('核对当前工作区。'),beforeStatus:!!(row.compareDocumentPosition(stream.querySelector('.status-line'))&Node.DOCUMENT_POSITION_FOLLOWING)};
    dock.querySelector('.plan-decision-actions button').click();await wait();
    row.querySelector('.interaction-link').click();await wait();
    return {initial,answers:window.__answers,dockClosed:!document.querySelector('.interaction-dock'),outcome:row.querySelector('.interaction-state').textContent,detail:row.querySelector('.readonly-approval')?.textContent,cards:stream.querySelectorAll('.plan-message').length};
  })()`,
})
assert.deepEqual(nativePlan.initial, { nodes: 1, cards: 0, bodyInStream: false, bodyInDock: true, beforeStatus: true },
  '待审批计划只在输入框上方显示正文，时间轴保留一个状态节点')
assert.deepEqual(nativePlan.answers, [{ requestId: 'plan-approval', answer: { decision: 'approved' } }])
assert.equal(nativePlan.dockClosed, true)
assert.equal(nativePlan.outcome, '已确认')
assert.match(nativePlan.detail, /核对当前工作区。/, '审批后仍可通过节点详情查看计划正文')
assert.equal(nativePlan.cards, 0)

const localPlan = await renderEventStream([
  ...planEvents.slice(0, 3), event(4, 'turn_completed', { turnId: 'local-plan' }),
], 'completed', 'timeline', {
  setup: `window.__implementations=0;window.__eventStreamProps={onImplementPlan:async()=>{window.__implementations++},onRevisePlan:async()=>{}};`,
  inspect: `(async()=>{
    const stream=document.querySelector('.event-stream');
    const row=stream.querySelector('.interaction-step');
    const initial={nodes:stream.querySelectorAll('.interaction-step').length,cards:stream.querySelectorAll('.plan-message').length,bodyInDock:document.querySelector('.interaction-plan-content')?.textContent.includes('核对当前工作区。')};
    document.querySelector('.interaction-dock .plan-decision-actions button').click();
    await new Promise(resolve=>setTimeout(resolve,100));
    row.querySelector('.interaction-link').click();
    await new Promise(resolve=>setTimeout(resolve,100));
    return {initial,implementations:window.__implementations,outcome:row.querySelector('.interaction-state').textContent,detail:row.querySelector('.readonly-approval')?.textContent,dockClosed:!document.querySelector('.interaction-dock')};
  })()`,
})
assert.deepEqual(localPlan.initial, { nodes: 1, cards: 0, bodyInDock: true },
  '没有原生审批请求的计划仍生成一个本地确认节点和现有审批弹窗')
assert.equal(localPlan.implementations, 1)
assert.equal(localPlan.outcome, '已确认')
assert.match(localPlan.detail, /核对当前工作区。/)
assert.equal(localPlan.dockClosed, true)

console.log('process timeline: ok')
