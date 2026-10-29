import DOMPurify from 'dompurify'
// SSR checks layout only; browser sanitization is covered by engine acceptance.
DOMPurify.sanitize = (html: string) => html
import assert from 'node:assert/strict'
import { createElement, type ReactElement } from 'react'
import type { UAEvent } from '../src/shared/types.ts'
import { renderOpenChains } from './regression/open-chain'
import { EventStream } from '../src/renderer/components/EventStream.tsx'

const renderHints = (element: ReactElement): string => renderOpenChains(element, { processed: true })

const hints = [
  'Heads up: Long threads and multiple compactions can cause the model to be less accurate.',
  'Skill descriptions were shortened to fit the 2% skills context budget.',
  'This session was recorded with model `gpt-6-astra` but is resuming with `gpt-5.6-sol`. Consider switching back to `gpt-6-astra` as it may affect Codex performance.'
]
const events: UAEvent[] = [
  { sessionId: 's-hints', seq: 1, ts: 1, type: 'user_message', payload: { text: '继续' } },
  ...[hints[0], hints[0], hints[1], hints[0], hints[1], hints[2], hints[2]].map((text, index): UAEvent => ({
    sessionId: 's-hints', seq: index + 2, ts: index + 2,
    type: 'system_notice', payload: { kind: 'warning', text, ...(index > 0 ? { id: `hint-${index}` } : {}) }
  })),
  { sessionId: 's-hints', seq: 9, ts: 9, type: 'agent_message', state: 'success', payload: { text: '已完成', phase: 'final_answer' } },
  { sessionId: 's-hints', seq: 10, ts: 10, type: 'turn_completed', payload: {} }
]

for (const status of ['running', 'completed'] as const) {
  const markup = renderHints(createElement(EventStream, {
    events: status === 'running' ? events.slice(0, -2) : events,
    status
  }))
  for (const hint of hints) {
    assert.equal((markup.match(/class="process-notice-preview">([^]*?)<\/span>/g) || []).filter(preview => preview.includes(hint)).length, 1, `${status}: repeated hint must be visible exactly once`)
  }
  assert.equal((markup.match(/class="process-notice warning"/g) || []).length, 3)
  assert.equal((markup.match(/class="process-timeline-head"/g) || []).length, 1, `${status}: notices must stay under one work-process heading`)
  const headAt = markup.indexOf('class="process-timeline-head"')
  const firstNoticeAt = markup.indexOf('class="process-notice')
  assert.ok(headAt >= 0 && headAt < firstNoticeAt, `${status}: work-process heading must precede the notices`)
  assert.doesNotMatch(markup, /0 步 · 0 次调用/, `${status}: heading must not show empty work statistics`)
}

const nativeContextEvents: UAEvent[] = [
  { sessionId: 's-native-context', seq: 1, ts: 1, type: 'user_message', payload: { text: 'hi' } },
  { sessionId: 's-native-context', seq: 2, ts: 2, type: 'system_notice', payload: { kind: 'native_context', text: 'You are an AI agent powered by DeepSeek Harness.' } },
  { sessionId: 's-native-context', seq: 3, ts: 3, type: 'system_notice', payload: { kind: 'native_context', text: 'The approval policy changed from "ask" to "never" (changed by the user).' } }
]
const nativeContextMarkup = renderHints(createElement(EventStream, { events: nativeContextEvents, status: 'running' }))
assert.equal((nativeContextMarkup.match(/class="process-timeline-head"/g) || []).length, 1, 'native context notices must not render as a bare block')
assert.ok(nativeContextMarkup.indexOf('class="process-timeline-head"') < nativeContextMarkup.indexOf('class="process-notice'), 'native context notices must follow the heading')
assert.equal((nativeContextMarkup.match(/class="process-notice"/g) || []).length, 2)
assert.match(nativeContextMarkup, /<b>工作过程<\/b>/)

const workWithHint = renderHints(createElement(EventStream, { status: 'running', events: [
  { sessionId: 's-hints', seq: 1, ts: 1, type: 'user_message', payload: { text: '继续' } },
  { sessionId: 's-hints', seq: 2, ts: 2, type: 'system_notice', payload: { kind: 'native_context', text: 'Current runtime context.' } },
  { sessionId: 's-hints', seq: 3, ts: 3, type: 'command_exec', state: 'running', payload: { id: 'cmd-1', command: 'pwd' } }
] }))
assert.equal((workWithHint.match(/class="process-timeline-head"/g) || []).length, 1, 'work must not add a second process heading')
assert.match(workWithHint, /<b>工作过程<\/b> · 1 步 · 1 次调用/)

// 步骤进行中的「提示」不再独立成段：通知就地并入当前步骤的中间，后续调用继续
// 留在同一步骤，不会凭空多出一个「执行调用」。
const midStepNotices = renderHints(createElement(EventStream, { status: 'running', events: [
  { sessionId: 's-mid', seq: 1, ts: 1, type: 'user_message', payload: { text: '继续' } },
  { sessionId: 's-mid', seq: 2, ts: 2, type: 'command_exec', state: 'success', payload: { id: 'cmd-1', command: 'echo first' } },
  { sessionId: 's-mid', seq: 3, ts: 3, type: 'system_notice', payload: { kind: 'native_context', text: 'Time sampled while preparing turn 5, step 80.' } },
  { sessionId: 's-mid', seq: 4, ts: 4, type: 'system_notice', payload: { kind: 'warning', text: hints[0] } },
  { sessionId: 's-mid', seq: 5, ts: 5, type: 'command_exec', state: 'success', payload: { id: 'cmd-2', command: 'echo second' } }
] }))
assert.equal((midStepNotices.match(/data-step-id=/g) || []).length, 1, '提示不得切断工作过程')
assert.match(midStepNotices, /<b>工作过程<\/b> · 1 步 · 2 次调用/)
assert.doesNotMatch(midStepNotices, /执行调用/, '提示不再切出新的执行调用步骤')
assert.equal((midStepNotices.match(/class="process-notice["> ]/g) || []).length, 2, '两条提示都保留披露入口')
const firstCallAt = midStepNotices.indexOf('echo first')
const firstNoticeAt = midStepNotices.indexOf('class="process-notice"')
const secondCallAt = midStepNotices.indexOf('echo second')
assert.ok(firstCallAt >= 0 && firstCallAt < firstNoticeAt && firstNoticeAt < secondCallAt,
  '提示按时间顺序显示在上一个步骤中间')

const replyOnly = renderHints(createElement(EventStream, { status: 'running', events: [
  { sessionId: 's-reply', seq: 1, ts: 1, type: 'user_message', payload: { text: '你好' } },
  { sessionId: 's-reply', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { id: 'reply-1', text: '你好', phase: 'final_answer' } }
] }))
assert.doesNotMatch(replyOnly, /process-timeline-head/, 'a plain reply without process events keeps no work heading')

const nextTurn = events.map((event) => ({ ...event, seq: event.seq + events.length, ts: event.ts + events.length }))
const twoTurns = renderHints(createElement(EventStream, { events: [...events, ...nextTurn], status: 'completed' }))
for (const hint of hints) {
  assert.equal((twoTurns.match(/class="process-notice-preview">([^]*?)<\/span>/g) || []).filter(preview => preview.includes(hint)).length, 2, 'the same hint must remain visible in each turn')
}

const changedHint = hints[1].replace('2%', '3%')
const changedEvents: UAEvent[] = [
  ...events,
  { sessionId: 's-hints', seq: 11, ts: 11, type: 'system_notice', payload: { kind: 'warning', text: changedHint } }
]
const changedMarkup = renderHints(createElement(EventStream, { events: changedEvents, status: 'completed' }))
assert.equal((changedMarkup.match(/class="process-notice warning"/g) || []).length, 4, 'different guidance must not be deduplicated by category')
assert.ok(changedMarkup.includes(changedHint))

const trustWarning = 'Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted.'
const trustMarkup = renderHints(createElement(EventStream, {
  events: [
    ...events,
    { sessionId: 's-hints', seq: 11, ts: 11, type: 'system_notice', payload: { kind: 'warning', text: trustWarning } }
  ],
  status: 'completed'
}))
assert.doesNotMatch(trustMarkup, /Project-local config/, 'project trust warnings stay out of restored conversations')

console.log('conversation-hints: ok')
