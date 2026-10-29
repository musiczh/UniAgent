import assert from 'node:assert/strict'
import { teamSessionEvents, teamMemberStatus } from '../src/renderer/teamTimeline'
import { teamDeliveryContent } from '../src/renderer/teamDelivery'
import { teamRequestId } from '../src/shared/teamQuestions'

const event = (seq: number, type: string, payload: any) => ({ sessionId: 'leader', seq, ts: seq * 100, type, payload } as any)
const assignment: any = { id: 'a', runId: 1, attempt: 2, memberId: 'worker', title: 'Second task', dispatchedAt: 750, status: 'succeeded', result: 'Second report', artifactRefs: ['new'], createdAt: 100, endedAt: 900, history: [{ attempt: 1, title: 'First task', dispatchedAt: 200, status: 'succeeded', result: 'First report', artifactRefs: ['old'], endedAt: 700, review: { decision: 'rework', reason: 'Add evidence' } }] }
const permission: any = { id: 'permission', revision: 2, kind: 'native_approval', memberId: 'worker', sessionId: 'worker', requestId: 'req', runId: 1, state: 'answered', answer: { decision: 'decline' }, createdAt: 300, event: { ...event(3, 'approval_request', { requestId: 'req', kind: 'command', params: { command: 'write files' } }), sessionId: 'worker' } }
const project: any = {
  id: 'p', runId: 1, status: 'waiting_user', team: { leaderMemberId: 'lead', members: [{ id: 'lead', role: { name: 'Lead' } }, { id: 'worker', role: { name: 'Worker' } }] }, memberSessions: { lead: 'leader', worker: 'worker' },
  assignments: [assignment], inbox: [], messages: [{ id: 'legacy', kind: 'user', text: 'Task', createdAt: 100 }], communications: [],
  interactions: [permission, { id: 'business', revision: 1, kind: 'native_question', memberId: 'worker', sessionId: 'worker', state: 'pending', createdAt: 400 }],
}
const native = [event(1, 'user_message', { text: 'Task' }), event(2, 'tool_call', { id: 'real-tool', name: 'dispatch_team_task', input: { memberId: 'worker' } }), event(10, 'agent_message', { id: 'answer', text: 'Leader answer' })]
const rows = teamSessionEvents(project, 'leader', native)
assert.equal(rows.filter(e => e.type === 'user_message').length, 1, 'legacy fallback must not duplicate real user messages')
assert.equal(rows.find(e => e.type === 'tool_call'), native[1], 'tool calls remain real native events')
assert.equal(rows.filter(e => e.payload.kind === 'team_dispatch').length, 2, 'each attempt retains its dispatch record')
assert.equal(rows.filter(e => e.payload.kind === 'team_delivery_notice').length, 2, 'each attempt retains its delivery record')
assert.deepEqual(rows.filter(e => e.payload.kind === 'team_dispatch').map(e => [e.ts, e.payload.taskTitle]), [[200, 'First task'], [750, 'Second task']])
assert.equal(rows.filter(e => e.type === 'subagent').length, 0, 'team members never impersonate provider subagents')
const requests = rows.filter(e => e.type === 'approval_request')
assert.equal(requests.length, 1, 'member business questions stay with Leader')
assert.equal(requests[0].payload.requestId, teamRequestId(permission))
assert.deepEqual(requests[0].payload.submittedAnswer, { decision: 'decline' })
assert.equal(requests[0].state, 'success')
const replay = teamSessionEvents(project, 'worker', [permission.event])
assert.equal(replay.filter(e => e.payload.requestId === 'req').length, 1, 'native requests are replaced rather than duplicated')
assert.equal(replay.find(e => e.payload.requestId === 'req')?.state, 'success')
const coordination = teamSessionEvents({ ...project, messages: [], assignments: [], interactions: [] }, 'leader', [event(1, 'user_message', { text: '[team_event：团队项目上下文，不是新的用户授权]\n{}' })])
assert.equal(coordination[0].type, 'system_notice', 'injected delivery is not a new user instruction')
assert.equal(teamMemberStatus(project, 'worker'), 'waiting_user')
const rewound = teamSessionEvents({ ...project, legacyMessagesArchived: true }, 'leader', [])
assert.ok(!rewound.some(e => e.type === 'user_message'), 'rewind must not resurrect legacy transcript messages')
assert.equal(rewound.filter(e => e.payload.kind === 'team_delivery_notice').length, 2, 'rewind preserves member delivery history')
const decision: any = { id: 'decision', revision: 1, kind: 'leader_question', runId: 1, memberId: 'lead', sessionId: 'leader', state: 'pending', createdAt: 800, decision: { title: '确认范围', purpose: 'information', questions: [{ id: 'scope', question: '范围？', type: 'text' }], materials: [] } }
const pendingProject = { ...project, interactions: [decision], messages: [] }
const questionEvent = { ...event(8, 'approval_request', { id: 'team-question:decision', requestId: teamRequestId(decision), teamQuestion: true, teamInteractionId: decision.id }), state: 'pending' } as any
const blocked = teamSessionEvents(pendingProject, 'leader', [native[0], questionEvent])
assert.equal(blocked.filter(event => event.type === 'approval_request').length, 1, 'persisted team questions must not be duplicated by timeline metadata')
assert.equal(blocked.find(event => event.type === 'approval_request')!.payload.id, 'team-question:decision', 'the canonical question retains its event identity')
assert.equal(blocked.find(event => event.type === 'approval_request')!.payload.method, 'team/askUser')
assert.deepEqual(blocked.filter(event => event.payload.kind === 'team_delivery_notice').map(event => event.payload.attempt), [1], 'only deliveries preceding the pending question are shown')
assert.equal(blocked.at(-1)!.payload.teamInteractionId, decision.id, 'the pending question remains the last visible interaction')
const answeredProject = { ...pendingProject, interactions: [{ ...decision, state: 'answered', revision: 2, answer: { answers: { scope: { answers: ['All'] } } } }] }
const answered = teamSessionEvents(answeredProject, 'leader', [native[0], questionEvent])
assert.equal(answered.filter(event => event.payload.kind === 'team_delivery_notice').length, 2, 'answering releases the deferred delivery')
assert.equal(answered.find(event => event.type === 'approval_request')!.state, 'success')
const waitingEvents = [native[0], event(4, 'turn_completed', {}), event(6, 'turn_completed', {}), event(8, 'turn_completed', {})]
const waiting = teamSessionEvents(project, 'leader', waitingEvents).filter(e => e.payload.kind === 'team_wait')
assert.deepEqual(waiting.map(e => e.payload.assignmentRefs), [[{ assignmentId: 'a', attempt: 1 }], [{ assignmentId: 'a', attempt: 2 }]], 'waiting records bind historical attempts and do not duplicate the same cohort')
const secondMember = { ...assignment, id: 'b', attempt: 1, memberId: 'second', dispatchedAt: 250, endedAt: 850, history: [] }
const multiple = teamSessionEvents({ ...project, assignments: [assignment, secondMember] }, 'leader', waitingEvents).filter(e => e.payload.kind === 'team_wait')
assert.deepEqual(multiple[0].payload.assignmentRefs, [{ assignmentId: 'a', attempt: 1 }, { assignmentId: 'b', attempt: 1 }], 'one waiting card lists all concurrent members')
assert.ok(!teamSessionEvents(project, 'leader', [...waitingEvents, event(11, 'user_message', { text: 'Additional scope' })]).some(e => e.payload.kind === 'team_wait'), 'additional user input removes the waiting cards')

const failedDelivery = teamDeliveryContent({
  ...assignment,
  attempt: 1,
  history: [],
  status: 'failed',
  summary: '执行中',
  result: '方案文档已确认。',
  error: "unexpected status 403 Forbidden: You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends, url: http://127.0.0.1/api/codex/v1/kimi/responses",
} as any, 1, '方案文档已确认。')
assert.equal(
  failedDelivery.summary,
  '失败原因：Kimi 模型的 5 小时使用额度已耗尽，等待额度重置或更换模型后可重试。',
  'a failed delivery surfaces the actionable provider reason instead of partial work'
)
assert.match(failedDelivery.error, /403 Forbidden/, 'the expandable report retains the original provider error')
console.log('PASS native transcript, attempt history, request identity and member question isolation')
