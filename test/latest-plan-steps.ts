import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UAEvent } from '../src/shared/types.ts'
import { isSessionBusy } from '../src/shared/sessionStatus'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
import {
  changeCardVisualTurnIndexes,
  deriveActivity,
  EventStream,
  groupChainEvents,
  isReconnectActive,
  latestPlanSteps,
  PlanStatusBar,
  planCurrentIndex,
  rewindableVisualTurnIndexes,
  replyHasLiveCursor
} from '../src/renderer/components/EventStream.tsx'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const event = (seq: number, type: UAEvent['type'], payload: Record<string, unknown> = {}): UAEvent => ({
  sessionId: 'session', seq, ts: seq, type, state: 'success', payload
})
const oldSteps = [{ text: 'old step', status: 'in_progress' as const }]
const newSteps = [{ text: 'new step', status: 'pending' as const }]

assert.deepEqual(latestPlanSteps([
  event(1, 'user_message'),
  event(2, 'plan_update', { steps: oldSteps }),
  event(3, 'turn_completed')
]), oldSteps, 'a completed turn keeps its last plan inspectable')

assert.deepEqual(latestPlanSteps([
  event(1, 'plan_update', { steps: oldSteps }),
  event(2, 'turn_completed'),
  event(3, 'user_message')
]), [], 'a new turn never revives the previous plan')

assert.deepEqual(latestPlanSteps([
  event(1, 'plan_update', { steps: oldSteps }),
  event(2, 'user_message'),
  event(3, 'plan_update', { steps: newSteps })
]), newSteps, 'the current turn uses its own newest plan')

let merged: UAEvent[] = []
merged = mergeSessionEvent(merged, event(1, 'user_message'))
merged = mergeSessionEvent(merged, event(2, 'plan_update', { id: 'plan-session', steps: oldSteps }))
merged = mergeSessionEvent(merged, event(3, 'turn_completed'))
merged = mergeSessionEvent(merged, event(4, 'user_message'))
merged = mergeSessionEvent(merged, event(5, 'plan_update', { id: 'plan-session', steps: newSteps }))
assert.deepEqual(latestPlanSteps(merged), newSteps, 'a reused plan id appends within the new turn')
assert.equal(merged.filter((item) => item.type === 'plan_update').length, 2)

assert.equal(planCurrentIndex([
  { text: 'stale running step', status: 'in_progress' },
  { text: 'newer running step', status: 'in_progress' }
]), 1, 'an anomalous snapshot with multiple running steps highlights the latest one')

assert.equal(isSessionBusy('queued'), true, 'queued keeps the current generation live')
assert.equal(isReconnectActive([
  event(1, 'user_message'),
  { ...event(2, 'system_notice', { kind: 'reconnect' }), state: 'running' }
]), true, 'retry state replaces the normal thinking activity')
assert.equal(isReconnectActive([
  { ...event(4, 'agent_message', { id: 'reply', text: 'resumed' }), state: 'running' },
  { ...event(3, 'system_notice', { kind: 'reconnect' }), state: 'running' }
]), false, 'newer provider activity clears reconnect even when a merge keeps it earlier in the array')
assert.equal(isReconnectActive([
  { ...event(2, 'system_notice', { kind: 'reconnect' }), state: 'running' },
  event(3, 'turn_completed')
]), false, 'completed turns never retain reconnect state')
assert.equal(
  deriveActivity([
    { ...event(1, 'reasoning'), state: 'running' },
    event(2, 'agent_message')
  ]),
  '正在思考…',
  'a completed reply cannot hide activity while the native session is still busy'
)
assert.equal(replyHasLiveCursor('running', false, true, true), true)
assert.equal(
  replyHasLiveCursor('running', true, true, true),
  false,
  'a completed or interrupted turn cannot keep blinking'
)
assert.equal(
  replyHasLiveCursor('running', false, false, true),
  false,
  'an old running reply cannot relight when a later turn becomes active'
)
assert.equal(
  replyHasLiveCursor('running', false, true, false),
  false,
  'an earlier running reply in the active turn cannot keep blinking'
)

assert.deepEqual(
  [...rewindableVisualTurnIndexes([
    { nativeTurnId: 'shared', user: {} },
    { nativeTurnId: 'shared', user: {} },
    { nativeTurnId: 'next', user: {} },
    { user: {} }
  ])],
  [0, 2],
  'only the first visual turn per native turn is rewindable; id-less turns are not'
)

assert.deepEqual(
  [...changeCardVisualTurnIndexes([
    { nativeTurnId: 'shared', done: true },
    { nativeTurnId: 'shared', done: true },
    { nativeTurnId: 'running', done: true },
    { nativeTurnId: 'running', done: false },
    { done: true }
  ])],
  [1, 4],
  'a shared native turn owns one card at its last completed visual turn'
)

const activePlanMarkup = renderToStaticMarkup(createElement(PlanStatusBar, {
  steps: [{ text: 'visible current step', status: 'in_progress' }],
  status: 'queued'
}))
assert.match(
  activePlanMarkup,
  /plan-step plan-in_progress[\s\S]*plan-pill-spin/,
  'the current plan row uses a visible spinner while queued'
)

const renderStream = (events: UAEvent[]): string =>
  renderToStaticMarkup(createElement(EventStream, { events, status: 'running' }))

const latestReasoning = renderStream([
  event(1, 'user_message', { text: 'question' }),
  event(2, 'reasoning', { id: 'reasoning-1', text: 'older reasoning' }),
  event(3, 'command_exec', { id: 'command-1', command: 'pwd' }),
  event(4, 'reasoning', { id: 'reasoning-2', text: 'latest reasoning' })
])
// Active work stays open; earlier reasoning remains folded inside its own row.
assert.match(latestReasoning, /process-step active open/)
assert.match(latestReasoning, /older reasoning/)
assert.match(latestReasoning, /latest reasoning/)
assert.doesNotMatch(latestReasoning, /status-line-elapsed/)
assert.match(latestReasoning, /reasoning-preview[^>]*title="older reasoning"/)
assert.match(latestReasoning, /is-open reasoning-disclosure[\s\S]*reasoning-body[\s\S]*latest reasoning/)

const latestCommand = renderStream([
  event(1, 'user_message', { text: 'question' }),
  event(2, 'reasoning', { id: 'reasoning-1', text: 'older reasoning' }),
  event(3, 'reasoning', { id: 'reasoning-2', text: 'latest reasoning' }),
  event(4, 'command_exec', { id: 'command-1', command: 'pwd' })
])
assert.match(latestCommand, /process-step active open/)
assert.match(latestCommand, /step-call-row/)
assert.match(latestCommand, /latest reasoning/)

const appendedUserMessage = renderStream([
  event(1, 'user_message', { text: 'initial request' }),
  event(2, 'reasoning', { id: 'reasoning-1', text: 'first work' }),
  event(3, 'command_exec', { id: 'command-1', command: 'pwd' }),
  event(5, 'user_message', { text: 'change the icon too', appendedToTurn: true }),
  event(6, 'reasoning', { id: 'reasoning-2', text: 'continued work' }),
  event(7, 'command_exec', { id: 'command-2', command: 'rg icon' })
])
assert.equal(
  (appendedUserMessage.match(/process-timeline-head/g) || []).length,
  1,
  'a running follow-up stays in the current work-process group'
)
assert.equal(
  (appendedUserMessage.match(/class="card user-msg/g) || []).length,
  1,
  'only the original request remains a standalone user bubble'
)
assert.match(appendedUserMessage, /user-append-step/)
assert.match(appendedUserMessage, /用户追加消息/)
assert.doesNotMatch(appendedUserMessage, /继续当前任务/)
assert.match(appendedUserMessage, /change the icon too/)
assert.match(appendedUserMessage, /continued work/)
assert.match(appendedUserMessage, /rg icon/)

for (const appendedToTurn of [undefined, true]) {
  const queuedUserMessage = renderStream([
    event(1, 'user_message', { text: 'initial request' }),
    event(2, 'reasoning', { id: 'previous-work', text: 'previous work' }),
    event(3, 'agent_message', { id: 'previous-reply', phase: 'final_answer', text: 'previous reply' }),
    event(4, 'turn_completed'),
    event(5, 'user_message', { text: 'queued request', appendedToTurn }),
    event(6, 'reasoning', { id: 'queued-work', text: 'new turn work' }),
    event(7, 'command_exec', { id: 'queued-command', command: 'rg icon' })
  ])
  assert.equal(
    (queuedUserMessage.match(/class="card user-msg/g) || []).length,
    2,
    'a queued follow-up starts a standalone user bubble, including legacy messages marked as appended'
  )
  assert.equal(
    (queuedUserMessage.match(/class="turn-response"/g) || []).length,
    2,
    'the queued message owns a separate response and work process'
  )
  assert.match(queuedUserMessage, /processed-fold closed/, 'the previous completed turn stays closed')
  assert.doesNotMatch(queuedUserMessage, /user-append-step|用户追加消息|继续当前任务/)
  assert.ok(queuedUserMessage.indexOf('previous reply') < queuedUserMessage.indexOf('queued request'))
  assert.ok(queuedUserMessage.indexOf('queued request') < queuedUserMessage.indexOf('new turn work'))
}

const consecutiveReasoning = [
  event(2, 'reasoning', { id: 'reasoning-1', text: 'older reasoning' }),
  event(3, 'reasoning', { id: 'reasoning-2', text: 'latest reasoning' })
]
assert.deepEqual(
  groupChainEvents(consecutiveReasoning).map((entry) => entry.kind),
  ['reasoning'],
  'consecutive reasoning events must share one batch'
)
const consecutiveReasoningMarkup = renderStream([
  event(1, 'user_message', { text: 'question' }),
  ...consecutiveReasoning
])
assert.match(consecutiveReasoningMarkup, /process-step active open/)
assert.match(consecutiveReasoningMarkup, /older reasoning/)
assert.match(consecutiveReasoningMarkup, /latest reasoning/)
assert.match(consecutiveReasoningMarkup, /reasoning-preview[^>]*title="older reasoning"/)
assert.match(consecutiveReasoningMarkup, /is-open reasoning-disclosure/)
assert.deepEqual(
  groupChainEvents([
    consecutiveReasoning[0],
    event(4, 'command_exec', { id: 'command-1', command: 'pwd' }),
    consecutiveReasoning[1]
  ]).map((entry) => entry.kind),
  ['reasoning', 'commands', 'reasoning'],
  'other output must split reasoning batches'
)

const pendingQuestion = event(6, 'approval_request', {
  requestId: 'question-1',
  kind: 'question',
  params: { questions: [{ id: 'answer', prompt: 'Answer?' }] },
  submittedAnswer: { answers: { answer: { answers: ['Yes'] } } }
})
const resolvedQuestion = {
  ...event(7, 'approval_request', { requestId: 'question-1', resolved: true }),
  state: 'success' as const
}
const mergedQuestion = mergeSessionEvent([pendingQuestion], resolvedQuestion)[0]
assert.equal(mergedQuestion.payload.kind, 'question')
assert.deepEqual(mergedQuestion.payload.params, pendingQuestion.payload.params)
assert.deepEqual(mergedQuestion.payload.submittedAnswer, pendingQuestion.payload.submittedAnswer)

console.log('latest plan steps: ok')
