import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import DOMPurify from 'dompurify'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeAnswer, normalizeQuestions, questionAnswerKind, questionAnswerValues, validateQuestionAnswer } from '../src/shared/questions'
import { mergeZCodeEvent, mergeZCodeSnapshot } from '../src/renderer/zcodeEvents'
import { projectZCodeEvents } from '../src/main/zcode/projection'
import { ApprovalCard, QuestionForm } from '../src/renderer/components/EventStream'
import { redactInteractionAnswer } from '../src/shared/interactionRequests'
import type { UAEvent } from '../src/shared/types'

// Replay actual local-engine interactions without starting an App, engine or model.
Object.assign(DOMPurify, { sanitize: (html: string) => html })
const frames = JSON.parse(readFileSync('test/fixtures/zcode/local-contract/physical-frames.json', 'utf8'))
const interactions: any[] = []
function collect(value: any): void {
  if (!value || typeof value !== 'object') return
  if (value.interactionId && value.payload?.kind) interactions.push(value)
  for (const child of Object.values(value)) collect(child)
}
collect(frames)
const question = interactions.find(item => item.kind === 'userInput' && item.payload.questions?.length)
const permission = interactions.find(item => item.kind === 'permission' && item.payload.toolName === 'Write')
assert.ok(question && permission)
const state: any = { sessionId: 'native', logEpoch: 'epoch', seq: 10, revision: 1, control: {}, config: {},
  rows: { window: [], totalCount: 2000, firstRowId: 1 }, pendingInteractions: [question, permission] }
let seq = 0
const events = projectZCodeEvents(state, { sessionId: 'ua', generation: 2, nextSeq: () => seq++ })
const questionEvent = events.find(event => event.payload.method === 'zcode/userInput')!
const permissionEvent = events.find(event => event.payload.method === 'zcode/permission')!
assert.equal(questionEvent.payload.kind, 'question', 'native questions use the existing question UI')
assert.equal(permissionEvent.payload.kind, 'fileChange', 'native Write approval uses the existing file card')
assert.deepEqual(permissionEvent.payload.params.changes, [{ path: permission.payload.detail.file_path }])
assert.equal(questionEvent.payload.nativeHasEarlier, true)
const kind = questionAnswerKind(questionEvent.payload.kind, questionEvent.payload.method)
const fields = normalizeQuestions(kind, questionEvent.payload.params)
assert.equal(fields[0].id, question.payload.questions[0].question)
assert.equal(fields[0].type, 'multi')
const input = { [fields[0].id]: { choice: fields[0].options.map(option => option.value), text: '', other: '' } }
const answer = encodeAnswer(kind, fields, input)
assert.deepEqual(answer, { action: 'accept', content: { answers: { [fields[0].id]: ['Alpha', 'Beta'] } } })
validateQuestionAnswer(kind, fields, answer)
assert.deepEqual(questionAnswerValues(kind, fields[0], answer), ['Alpha', 'Beta'])
const custom = normalizeQuestions('zcode', { freeText: false, questions: [
  { id: 'ignored', question: ' Exact question? ', options: [{ label: 'Shown label', value: 'opaque-value' }] }
] })
const customAnswer = encodeAnswer('zcode', custom, { [custom[0].id]: { choice: ['opaque-value'], text: '', other: '' } })
assert.deepEqual(customAnswer, { action: 'accept', content: { answers: { ' Exact question? ': 'opaque-value' } } })
validateQuestionAnswer('zcode', custom, customAnswer)
assert.throws(() => validateQuestionAnswer('zcode', custom, { action: 'accept', content: { answers: { ' Exact question? ': 'invented' } } }))
assert.throws(() => validateQuestionAnswer('zcode', custom, { action: 'accept', content: { answers: { ' Exact question? ': 'Shown label' } } }), 'display labels cannot replace native option values')
assert.deepEqual(normalizeQuestions('zcode', { questions: [{ question: 'Same' }, { question: 'Same' }] }), [])
assert.deepEqual(normalizeQuestions('zcode', { prompt: 'missing original question' }), [])
const secret = { ...questionEvent, payload: { ...questionEvent.payload, params: { questions: [{ question: 'Credential', isSecret: true }] },
  submittedAnswer: { action: 'accept', content: { answers: { Credential: 'SENSITIVE_ZCODE_SENTINEL' } } } } }
const masked = redactInteractionAnswer(secret)
assert.equal(JSON.stringify(masked).includes('SENSITIVE_ZCODE_SENTINEL'), false, 'native secret answers must not persist')
assert.equal(secret.payload.submittedAnswer.content.answers.Credential, 'SENSITIVE_ZCODE_SENTINEL', 'redaction preserves the native delivery payload')
const form = renderToStaticMarkup(<QuestionForm kind="question" method="zcode/userInput" params={questionEvent.payload.params} answer={answer} readOnly />)
assert.ok(form.includes('Alpha、Beta'), 'existing read-only QuestionForm displays the actual native answer')
const card = renderToStaticMarkup(<ApprovalCard ev={permissionEvent} onRespond={() => {}} />)
assert.ok(card.includes('Allow once') && card.includes('Always allow in this project'), 'offered scope labels are retained')
assert.ok(!card.includes('本会话都批准') && !card.includes('>取消</button>'), 'no additional permission options are fabricated')
assert.ok(card.includes(permission.payload.detail.file_path))

const event = (id: string, sequence: number, generation: number, type: UAEvent['type'] = 'agent_message'): UAEvent => ({
  sessionId: 'ua', seq: sequence, ts: sequence, type, payload: { id, text: id, zcodeProjection: true, projectionGeneration: generation }
})
const old = event('old-row', 1, 1)
const native = event('row', 10, 2)
const fresh = { ...native, seq: 11, payload: { ...native.payload, text: 'new text' } }
const obsoletePermission = event('old-request', 3, 1, 'approval_request')
const reset = { sessionId: 'ua', generation: 2, upToEventSeq: 10, events: [native] }
const merged = mergeZCodeSnapshot(reset, [old, obsoletePermission, fresh])
assert.deepEqual(merged.map(item => item.payload.text), ['new text'], 'authoritative reset removes obsolete rows and retains subsequent deltas')
assert.equal(mergeZCodeSnapshot({ ...reset, generation: 1 }, merged, { generation: 2, upToEventSeq: 10 }), merged)
assert.equal(mergeZCodeEvent(merged, old, { generation: 2, upToEventSeq: 10 }), merged)
assert.equal(mergeZCodeEvent(merged, native, { generation: 2, upToEventSeq: 10 }), merged)
assert.equal(mergeZCodeEvent(merged, native), merged, 'late rows cannot overwrite newer native text')
assert.equal(mergeZCodeSnapshot(reset, [event('new-generation', 12, 3)])[0].payload.id, 'new-generation')
assert.equal(mergeZCodeEvent([native, event('later-turn', 12, 2, 'user_message')], fresh).length, 2, 'stable native row ids update across turn boundaries')
const optimistic = { ...event('optimistic', Number.MAX_SAFE_INTEGER, 2, 'user_message'), ts: 30,
  payload: { optimistic: true, text: 'repeat' } }
const oldPrompt = { ...event('old-prompt', 5, 2, 'user_message'), payload: { text: 'repeat' } }
assert.equal(mergeZCodeSnapshot({ ...reset, events: [oldPrompt] }, [optimistic]).length, 2, 'repeating an old prompt must retain the new optimistic input')
assert.equal(mergeZCodeEvent([optimistic], oldPrompt).length, 2, 'late historical input cannot consume a new optimistic message')
const resolved = { ...permissionEvent, seq: 20, state: 'success' as const, payload: { id: permissionEvent.payload.id, submittedAnswer: { optionId: 'allowOnce' }, resolved: true } }
assert.equal(mergeZCodeEvent([permissionEvent], resolved)[0].payload.method, 'zcode/permission', 'bare native resolution preserves the original card')
console.log('zcode-ui-contract: official fixture questions/approval, existing components, opaque values, history/reset and stale delta boundaries passed')
