import assert from 'node:assert/strict'
import { latestLocalPlanRequest, withInteractionState, withPlanText } from '../src/shared/interactionRequests'
import type { UAEvent } from '../src/shared/types'

const event = (seq: number, type: UAEvent['type'], payload: UAEvent['payload'], state?: UAEvent['state']): UAEvent => ({ sessionId: 'fixture', seq, ts: seq, type, payload, state })
const plan = event(2, 'agent_message', { id: 'plan', kind: 'plan', text: 'Current plan' }, 'success')
const turn = [event(0, 'user_message', { text: 'Plan the change' }), event(1, 'turn_started', {}), plan]
assert.equal(latestLocalPlanRequest(turn), undefined, 'a plan still being executed cannot be confirmed')
assert.equal(latestLocalPlanRequest([...turn, event(3, 'turn_completed', {}, 'failed')]), undefined, 'a failed turn cannot offer implementation')
const completed = [...turn, event(3, 'turn_completed', {}, 'success')]
const request = latestLocalPlanRequest(completed)!
assert.equal(request.payload.requestId, 'plan-confirmation:plan')
const accepted = { ...request, state: 'success' as const, payload: { ...request.payload, submittedAnswer: { decision: 'cancelled' } } }
assert.equal(latestLocalPlanRequest([...completed, accepted]), accepted, 'a skipped plan must not reappear')
assert.equal(latestLocalPlanRequest([...completed, event(5, 'user_message', { text: 'New task' })]), undefined, 'new input invalidates the previous local plan')

const native = event(3, 'approval_request', { requestId: 'native', kind: 'planMode', method: 'mode/change/respond', params: {} }, 'pending')
assert.equal(withPlanText(native, turn).payload.params.plan, 'Current plan')
assert.equal(withPlanText({ ...native, seq: 6 }, [...turn, event(4, 'user_message', { text: 'Another task' }), event(5, 'turn_started', {})]).payload.params.plan, undefined, 'native approvals cannot borrow an older turn plan')

const question = event(7, 'agent_message', { id: 'question', delivery: 'async', questions: [{ id: 'q', question: 'Continue?' }] }, 'running')
const answer = { answers: { q: { answers: ['yes'] } } }
const answered = { ...question, payload: { ...question.payload, submittedAnswer: answer } }
assert.deepEqual(withInteractionState({ ...question, state: 'success' }, [answered]).payload.submittedAnswer, answer, 'the provider item completion retains an already accepted answer')
assert.equal(withInteractionState(question, [{ ...question, payload: { ...question.payload, interactionExpired: true } }]).payload.interactionExpired, true)
console.log('question-parity-state: ok')
