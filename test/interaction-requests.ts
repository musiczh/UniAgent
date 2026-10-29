import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCodexLikeEvents } from '../src/main/history'
import { SessionLogStore } from '../src/main/sessionLogStore'
import { asInteractionRequest, asyncQuestionReply, interactionRequestKey, isPendingInteraction, redactInteractionAnswer, withInteractionState } from '../src/shared/interactionRequests'
import { normalizeQuestions } from '../src/shared/questions'
import type { UAEvent } from '../src/shared/types'

const question: UAEvent = {
  sessionId: 'fixture', seq: 4, ts: 1000, type: 'agent_message', state: 'success',
  payload: { id: 'ask-1', turnId: 'turn-1', phase: 'final_answer', delivery: 'async',
    text: '是否发布？', questions: [{ title: '是否发布？', options: ['不发布', '发布'] }] },
}
const request = asInteractionRequest(question)
assert.equal(request.type, 'approval_request', 'async final_answer must not occupy the final reply')
assert.equal(request.state, 'pending')
assert.equal(request.seq, question.seq, 'the question stays at its original timeline position')
assert.equal(question.type, 'agent_message', 'presentation must not mutate the provider event')
assert.equal(interactionRequestKey(question), request.payload.requestId)
const fields = normalizeQuestions('question', request.payload.params)
assert.equal(fields[0].prompt, '是否发布？', 'title-only async prompts must remain visible')
assert.equal(fields[0].allowOther, true, 'async questions also accept a typed answer')
assert.throws(() => asyncQuestionReply(question, { answers: {} }), /完整填写/)
assert.throws(() => asyncQuestionReply(question, { answers: { q0: { answers: ['发布', '不发布'] } } }), /完整填写/)
const answer = { answers: { q0: { answers: ['不发布'] } } }
assert.match(asyncQuestionReply(question, answer), /回答：不发布/)
const answered = { ...question, payload: { ...question.payload, submittedAnswer: answer } }
assert.equal(asInteractionRequest(answered).state, 'success')
const skippedAnswer = { action: 'skip' }
const skipped = { ...question, payload: { ...question.payload, submittedAnswer: skippedAnswer } }
const grouped = { ...question, payload: { ...question.payload, questions: [
  ...question.payload.questions,
  { id: 'note', question: '补充说明？', isSecret: true },
] } }
const skippedReply = asyncQuestionReply(grouped, skippedAnswer)
assert.match(skippedReply, /是否发布？[\s\S]*补充说明？/, '跳过反馈保留整组题目上下文')
assert.match(skippedReply, /用户跳过[\s\S]*未提供答案/)
assert.match(skippedReply, /不代表同意、授权或确认前置条件/)
assert.doesNotMatch(skippedReply, /回答：发布/, '跳过不能被编码为提供的答案或授权')
assert.equal(asInteractionRequest(skipped).state, 'success')
assert.equal(isPendingInteraction(skipped), false, '跳过后不再占用待处理状态')
assert.deepEqual(withInteractionState(question, [skipped]).payload.submittedAnswer, skippedAnswer, '后到的流式消息保留跳过状态')
assert.deepEqual(redactInteractionAnswer({ ...grouped, payload: { ...grouped.payload, submittedAnswer: skippedAnswer } }).payload.submittedAnswer, skippedAnswer)
const skipWithDraft = { action: 'skip', answers: { note: { answers: ['private draft'] } } }
assert.deepEqual(redactInteractionAnswer({ ...grouped, payload: { ...grouped.payload, submittedAnswer: skipWithDraft } }).payload.submittedAnswer, skippedAnswer, '跳过的持久化结果不保留草稿')
assert.equal(asyncQuestionReply(grouped, skipWithDraft), skippedReply, '跳过反馈不包含草稿')
assert.throws(() => asyncQuestionReply({ ...question, payload: { ...question.payload, questions: [] } }, skippedAnswer), /提问内容无效/)
assert.throws(() => asyncQuestionReply(question, { action: 'unknown' }), /完整填写/)
assert.equal(asInteractionRequest({ ...question, payload: { ...question.payload, interactionExpired: true } }).state, 'cancelled')
const ordinary: UAEvent = { ...question, payload: { id: 'reply', phase: 'final_answer', text: '完成' } }
assert.equal(asInteractionRequest(ordinary), ordinary)

const secretRequest: UAEvent = { ...request, payload: { ...request.payload,
  params: { questions: [{ id: 'token', question: '输入凭据', isSecret: true }] },
  submittedAnswer: { answers: { token: { answers: ['fixture-secret'] } } },
} }
assert.equal(JSON.stringify(redactInteractionAnswer(secretRequest)).includes('fixture-secret'), false)
assert.equal(secretRequest.payload.submittedAnswer.answers.token.answers[0], 'fixture-secret', 'redaction must not change the wire answer')
const grokSecret={...secretRequest,payload:{...secretRequest.payload,method:'_x.ai/ask_user_question',params:{questions:[{question:'Credential',isSecret:true}]},submittedAnswer:{outcome:'accepted',answers:{Credential:['fixture-secret']}}}}
assert.deepEqual(redactInteractionAnswer(grokSecret).payload.submittedAnswer.answers,{Credential:['已填写']})
assert.equal(grokSecret.payload.submittedAnswer.answers.Credential[0],'fixture-secret')

const root = mkdtempSync(join(tmpdir(), 'uniagent-interaction-fixture-'))
try {
  const logs = new SessionLogStore(root, { maxFileBytes: 2000, maxEntryBytes: 300 })
  logs.append('fixture', 'ua_event', { channel: 'main', event: question })
  logs.append('fixture', 'ua_event', { channel: 'main', event: answered })
  for (let i = 0; i < 20; i++) logs.append('fixture', 'notice', { text: 'x'.repeat(200) })
  const restored = logs.loadReplayCheckpoints('fixture')
  assert.equal(restored.length, 1, 'rotation must retain only the latest request snapshot')
  assert.deepEqual(restored[0].payload.submittedAnswer, answer)
  assert.deepEqual(restored[0].payload.questions, question.payload.questions)
  logs.append('fixture', 'ua_event', { channel: 'main', event: skipped })
  const restoredSkipped = logs.loadReplayCheckpoints('fixture')
  assert.equal(restoredSkipped.length, 1)
  assert.deepEqual(restoredSkipped[0].payload.submittedAnswer, skippedAnswer, '历史恢复保留跳过结果')
  assert.equal(isPendingInteraction(restoredSkipped[0]), false)
  const routing = { sessionId: 'fixture', seq: 8, ts: 100, type: 'system_notice' as const, payload: { id: 'auto-route', kind: 'nika_auto', text: 'native models '.repeat(60) } }
  logs.append('fixture', 'ua_event', { channel: 'main', event: routing })
  for (let i = 0; i < 30; i++) logs.append('fixture', 'notice', { text: 'x'.repeat(200) })
  const checkpoints = logs.loadReplayCheckpoints('fixture')
  assert.equal(checkpoints.length, 2, 'rotation keeps questions and complete Auto routing metadata together')
  assert.equal(checkpoints.find(event => event.payload.kind === 'nika_auto')?.payload.text, routing.payload.text, 'Auto metadata is not truncated by the diagnostic entry limit')
} finally {
  rmSync(root, { recursive: true, force: true })
}

const replay = [
  { timestamp: '2026-10-09T01:00:00Z', type: 'session_meta', payload: { id: 'fixture' } },
  { timestamp: '2026-10-09T01:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '检查发布' } },
  { timestamp: '2026-10-09T01:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: '是否发布？', phase: 'final_answer' } },
  { timestamp: '2026-10-09T01:00:02Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: {
    type: 'AgentMessage', ...question.payload, content: [{ type: 'Text', text: '是否发布？' }],
  } } },
  { timestamp: '2026-10-09T01:00:03Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '检查完成' } },
].map(record => JSON.stringify(record)).join('\n')
const history = await loadCodexLikeEvents('fixture.jsonl', 'codex', 'fixture', async () => new Map(), replay)
const replayRequests = history.events.map(asInteractionRequest).filter(event => event.type === 'approval_request')
assert.equal(replayRequests.length, 1, 'native event and completed item must not duplicate a question')
assert.deepEqual(replayRequests[0].payload.questions, question.payload.questions)
assert.equal(history.events.filter(event => event.type === 'agent_message' && event.payload.text === '是否发布？').length, 1)
assert.ok(history.events.some(event => event.type === 'agent_message' && event.payload.text === '检查完成'))
const repeatedTurns = [1, 2].flatMap(turn => [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${turn}` } },
  { type: 'event_msg', payload: { type: 'agent_message', message: '相同回复', turn_id: `turn-${turn}` } },
  { type: 'event_msg', payload: { type: 'item_completed', turn_id: `turn-${turn}`, item: {
    type: 'AgentMessage', id: `reply-${turn}`, content: [{ type: 'Text', text: '相同回复' }],
  } } },
]).map(record => JSON.stringify(record)).join('\n')
const repeatedHistory = await loadCodexLikeEvents('repeated.jsonl', 'codex', 'fixture', async () => new Map(), repeatedTurns)
assert.equal(repeatedHistory.events.filter(event => event.type === 'agent_message' && event.payload.text === '相同回复').length, 2,
  'equal text in distinct native turns must remain two replies')
console.log('interaction request regression passed')
