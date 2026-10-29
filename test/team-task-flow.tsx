import DOMPurify from 'dompurify'
import assert from 'node:assert/strict'
import React from 'react'
import { renderOpenChains } from './regression/open-chain'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionConversation } from '../src/renderer/components/SessionConversation'
import { TeamSessionProvider, TeamSummary } from '../src/renderer/components/TeamSessionExtras'
import { teamSessionEvents } from '../src/renderer/teamTimeline'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

const assignment = {
  id: 'assignment-1', runId: 1, memberId: 'designer', requestId: 'dispatch-1', requestFingerprint: 'fp',
  title: '设计三阶段任务卡', prompt: '保持现有视觉', contextRefs: [], expectedOutput: 'HTML 和 PNG', permissionMode: 'full-access',
  status: 'succeeded', attempt: 1, history: [], turnId: 'turn-1', result: '已完成设计并交付。', summary: '已完成',
  artifactRefs: ['artifact-1'], createdAt: 200, startedAt: 300, endedAt: 700, activeMs: 400,
}
const communication = {
  id: 'communication-1', requestId: 'message-1', requestFingerprint: 'fp', runId: 1,
  memberId: 'designer', sessionId: 'designer-session', assignmentId: assignment.id, attempt: 1, turnId: 'turn-1',
  message: '补充一个边缘状态。', state: 'sent', createdAt: 500, settledAt: 510,
}
const project: any = {
  id: 'project-1', revision: 1, name: '专家团信息流', sessionMode: 'leader', goal: '优化信息流', spaceId: 'space-1', spaceRoots: ['/repo'], teamId: 'team-1',
  team: { id: 'team-1', revision: 1, name: '专家团', description: '', rules: '', leaderMemberId: 'leader', status: 'active', createdAt: 1, updatedAt: 1, limits: { concurrency: 0, maxAssignments: 0, taskMinutes: 0, runMinutes: 0 }, members: [
    { id: 'leader', role: { id: 'leader-role', name: '开发一号位', agentId: 'traex', permissionMode: 'full-access' } },
    { id: 'designer', role: { id: 'designer-role', name: 'UI 设计师', agentId: 'traex', model: 'gpt-5', permissionMode: 'full-access' } },
  ] },
  memberSessions: { leader: 'leader-session', designer: 'designer-session' }, runId: 1, status: 'waiting_user', phase: '汇总', summary: '', sharedContext: { brief: '', decisions: [], openQuestions: [] },
  assignments: [assignment], inbox: [], inboxSeq: 0, handledInboxSeq: 0, interactions: [], artifacts: [{ id: 'artifact-1', title: '03-team-task-flow-cards.png', path: '/repo/03-team-task-flow-cards.png', assignmentId: assignment.id, createdAt: 650 }],
  communications: [communication], messages: [{ id: 'request-1', kind: 'user', text: '优化信息流', createdAt: 100, runId: 1 }], previousResults: [], createdAt: 1, updatedAt: 700, activeMs: 600,
}
const agent: any = { id: 'traex', name: 'TraeX', adapter: 'traex', installed: true, models: [], capabilities: { permissionModes: [{ id: 'full-access', label: '完全访问' }], modelSelect: true } }

const sessions: any[] = [{ id: 'leader-session', status: 'idle' }, { id: 'designer-session', status: 'idle' }]
const events: any[] = [
  { sessionId: 'leader-session', seq: 1, ts: 100, type: 'user_message', payload: { text: '优化信息流' } },
  { sessionId: 'leader-session', seq: 2, ts: 110, type: 'turn_started', payload: { turnId: 'leader-turn' } },
  { sessionId: 'leader-session', seq: 3, ts: 150, type: 'tool_call', state: 'success', payload: { id: 'call', name: 'dispatch_team_task', provider: 'mcp', input: { memberId: 'designer' }, result: { assignmentId: assignment.id } } },
]
const html = renderOpenChains(<TeamSessionProvider project={project} sessions={sessions} onOpenMember={() => {}}>
  <SessionConversation events={teamSessionEvents(project, 'leader-session', events)} status="running" sessionId="leader-session" />
  <TeamSummary />
</TeamSessionProvider>)
assert.ok(html.includes('team-dispatch-step') && html.includes('设计三阶段任务卡'), 'team dispatch uses its domain step')
assert.ok(html.includes('team-waiting-entry') && html.includes('UI 设计师') && html.includes('已完成设计并交付。'), 'quick deliveries without waiting records use the process member card')
assert.ok(html.includes('team-delivery-artifact') && html.includes('03-team-task-flow-cards.png'))
assert.ok(html.includes('已交付'))
assert.ok(!html.includes('data-assignment-stage') && !html.includes('team-project-view') && !html.includes('team-progress-pill'), 'old team stream and capsule are removed')
assert.match(html, /<div class="team-progress-role team-leader-identity"/, 'Leader identity has no detail navigation')
console.log('PASS Leader Session tool display, member delivery and team summary')

const wakeEvents: any[] = [
  { sessionId: 'leader-session', seq: 1, ts: 100, type: 'user_message', payload: { text: '先让组员处理设计稿' } },
  { sessionId: 'leader-session', seq: 2, ts: 110, type: 'turn_started', payload: { turnId: 'leader-turn-1' } },
  { sessionId: 'leader-session', seq: 3, ts: 180, type: 'agent_message', state: 'success', payload: { id: 'reply-1', phase: 'final_answer', text: '组员正在处理，我会等待交付。' } },
  { sessionId: 'leader-session', seq: 4, ts: 190, type: 'turn_completed', payload: { turnId: 'leader-turn-1' } },
  { sessionId: 'leader-session', seq: 5, ts: 195, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 111, outputTokens: 11 } } },
  { sessionId: 'leader-session', seq: 6, ts: 710, type: 'user_message', payload: { text: `[team_event：团队项目上下文，不是新的用户授权]\n${JSON.stringify({ projectId: project.id, runId: 1, revision: 2, inboxSeq: 1, summary: '', events: [{ eventId: 'event-1', seq: 1, runId: 1, kind: 'result', assignmentId: assignment.id, attempt: 1, summary: 'HTML 和 PNG 已完成。', state: 'pending' }] })}\n及时处理已到结果，继续独立工作；发问/完成前核对最新 inboxSeq。` } },
  { sessionId: 'leader-session', seq: 7, ts: 720, type: 'turn_started', payload: { turnId: 'leader-turn-2' } },
  { sessionId: 'leader-session', seq: 8, ts: 780, type: 'agent_message', state: 'success', payload: { id: 'reply-2', phase: 'final_answer', text: '设计稿已到，我现在开始验收。' } },
  { sessionId: 'leader-session', seq: 9, ts: 790, type: 'turn_completed', payload: { turnId: 'leader-turn-2' } },
  { sessionId: 'leader-session', seq: 10, ts: 795, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 222, outputTokens: 22 } } },
]
const wakeProject = { ...project, messages: [], legacyMessagesArchived: true }
const wakeHtml = renderOpenChains(<TeamSessionProvider project={wakeProject} sessions={sessions} onOpenMember={() => {}}>
  <SessionConversation events={teamSessionEvents(wakeProject as any, 'leader-session', wakeEvents)} status="idle" sessionId="leader-session" />
</TeamSessionProvider>, { processed: true })
assert.ok(!wakeHtml.includes('team-delivery-card') && wakeHtml.includes('team-waiting-summary'), 'delivery details stay in the process member card')
assert.equal((wakeHtml.match(/class="team-waiting-entry"/g) || []).length, 1, 'a completed waiting row and its delivery share one card')
assert.match(wakeHtml, /<\/button><div class="team-waiting-summary">.*?<details class="team-waiting-details">/, 'report and artifact controls are siblings of the member navigation button')
assert.ok(wakeHtml.includes('第 1 次交付') && wakeHtml.includes('交付材料 · 1 份'), 'the card retains report materials and review status')
assert.ok(wakeHtml.includes('data-member-session-id="designer-session"'), 'delivery card keeps the member Session jump target')
assert.equal((wakeHtml.match(/class="turn-response/g) || []).length, 1, 'internal team wake-up continues the same user task')
assert.equal((wakeHtml.match(/class="card system-notice usage/g) || []).length, 1, 'internal Leader wake-ups produce one usage card for the completed user task')
assert.ok(wakeHtml.indexOf('team-waiting-entry') < wakeHtml.indexOf('输入 333') && wakeHtml.includes('输出 33'), 'the final footer sums native turn usage after the member delivery')
assert.ok(!wakeHtml.includes('补充信息') && !wakeHtml.includes('[team_event：'), 'wake-up reply is not hidden as supplemental information and raw protocol stays hidden')

const retryAssignment = { ...assignment, attempt: 2, title: '补做设计边界', result: '第二次交付内容', summary: '第二次摘要', artifactRefs: [], startedAt: 820, dispatchedAt: 810, endedAt: 900,
  history: [{ attempt: 1, status: 'succeeded', title: assignment.title, result: '第一次交付内容', artifactRefs: ['artifact-1'], dispatchedAt: 200, endedAt: 700 }] }
const historyHtml = renderOpenChains(<TeamSessionProvider project={{ ...wakeProject, assignments: [retryAssignment] } as any} sessions={sessions} onOpenMember={() => {}}>
  <SessionConversation events={teamSessionEvents({ ...wakeProject, assignments: [retryAssignment] } as any, 'leader-session', wakeEvents)} status="idle" sessionId="leader-session" />
</TeamSessionProvider>, { processed: true })
assert.equal((historyHtml.match(/class="team-waiting-entry"/g) || []).length, 2, 'rework preserves one process card per delivery attempt')
assert.match(historyHtml, /data-attempt="1"[\s\S]*?第一次交付内容[\s\S]*?data-attempt="2"[\s\S]*?第二次交付内容/, 'historical reports resolve their own attempt instead of the latest delivery')

const reviewerAssignment = { ...assignment, id: 'assignment-2', memberId: 'reviewer', title: '审核交互边界', result: '边界审核已完成。', summary: '审核完成', artifactRefs: [] }
const batchProject: any = {
  ...wakeProject,
  team: { ...wakeProject.team, members: [...wakeProject.team.members, { id: 'reviewer', role: { id: 'reviewer-role', name: '交互审核员', agentId: 'traex', permissionMode: 'full-access' } }] },
  memberSessions: { ...wakeProject.memberSessions, reviewer: 'reviewer-session' },
  assignments: [assignment, reviewerAssignment],
}
const batchWakeEvents = wakeEvents.map(event => event.seq !== 6 ? event : { ...event, payload: { text: `[team_event：团队项目上下文，不是新的用户授权]\n${JSON.stringify({ projectId: project.id, runId: 1, revision: 3, inboxSeq: 2, summary: '', events: [
  { eventId: 'event-1', seq: 1, runId: 1, kind: 'result', assignmentId: assignment.id, attempt: 1, summary: 'HTML 和 PNG 已完成。', state: 'pending' },
  { eventId: 'event-2', seq: 2, runId: 1, kind: 'result', assignmentId: reviewerAssignment.id, attempt: 1, summary: '交互边界审核完成。', state: 'pending' },
] })}\n及时处理已到结果，继续独立工作；发问/完成前核对最新 inboxSeq。` } })
const batchHtml = renderOpenChains(<TeamSessionProvider project={batchProject} sessions={[...sessions, { id: 'reviewer-session', status: 'idle' }] as any} onOpenMember={() => {}}>
  <SessionConversation events={teamSessionEvents(batchProject, 'leader-session', batchWakeEvents)} status="idle" sessionId="leader-session" />
</TeamSessionProvider>, { processed: true })
assert.equal((batchHtml.match(/class="team-waiting-entry"/g) || []).length, 2, 'each batch member appears once in the completed waiting group')
assert.ok(batchHtml.indexOf('查看UI 设计师') < batchHtml.indexOf('查看交互审核员') && batchHtml.indexOf('查看交互审核员') < batchHtml.indexOf('设计稿已到'), 'batch member cards stay ordered before the Leader reply')

const waitingAssignment = { ...assignment, status: 'running', result: undefined, summary: '正在制作增量设计稿', artifactRefs: [], endedAt: undefined }
const waitingProject = { ...project, status: 'waiting_members', phase: '等待组员', assignments: [waitingAssignment], artifacts: [], updatedAt: 900 }
const opened: string[] = []
const waitingHtml = renderToStaticMarkup(<TeamSessionProvider project={waitingProject as any} sessions={[{ id: 'leader-session', status: 'idle' }, { id: 'designer-session', status: 'running' }] as any} onOpenMember={id => opened.push(id)}>
  <SessionConversation events={[...events, ...wakeEvents.slice(2, 5).map(event => ({ ...event, seq: event.seq + 1 }))]} status="waiting_members" sessionId="leader-session" />
</TeamSessionProvider>)
assert.ok(waitingHtml.includes('team-waiting-members-step') && waitingHtml.includes('等待组员交付') && !waitingHtml.includes('processed-fold'), 'waiting member work stays expanded after the native Leader turn ends')
assert.ok(waitingHtml.includes('1 位待返回') && waitingHtml.includes('设计三阶段任务卡'), 'waiting step identifies the team and pending task')
assert.ok(waitingHtml.includes('data-member-session-id="designer-session"'), 'waiting member row keeps the detail Session jump target')
assert.match(waitingHtml, /class="sa-ic sa-ic-plain"[^>]*style="width:24px;height:24px"/, 'waiting member avatar uses the smaller transparent glyph instead of the tinted plate')
assert.ok(!waitingHtml.includes('team-waiting-summary') && !waitingHtml.includes('team-waiting-details'), 'running members keep their compact row until a delivery arrives')
assert.ok(!waitingHtml.includes('card system-notice usage'), 'waiting for members must not display a native turn usage footer')

const waitingWithHooks: any[] = [
  { sessionId: 'leader-session', seq: 1, ts: 100, type: 'user_message', payload: { text: '先让组员处理设计稿' } },
  { sessionId: 'leader-session', seq: 2, ts: 150, type: 'agent_message', state: 'success', payload: { id: 'work', phase: 'commentary', text: '交付前的执行步骤' } },
  { sessionId: 'leader-session', seq: 3, ts: 160, type: 'command_exec', state: 'success', payload: { id: 'verify', command: 'pwd' } },
  { sessionId: 'leader-session', seq: 4, ts: 170, type: 'hook', state: 'success', payload: { id: 'before-hook', eventName: 'PostToolUse', durationMs: 100 } },
  { sessionId: 'leader-session', seq: 5, ts: 210, type: 'agent_message', state: 'success', payload: { id: 'waiting-reply', phase: 'final_answer', text: '组员正在处理，我会等待交付。' } },
  { sessionId: 'leader-session', seq: 6, ts: 220, type: 'turn_completed', payload: { turnId: 'waiting-turn' } },
  { sessionId: 'leader-session', seq: 7, ts: 230, type: 'hook', state: 'success', payload: { id: 'stop-hook', eventName: 'Stop', durationMs: 100 } },
  { sessionId: 'leader-session', seq: 8, ts: 240, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 111, outputTokens: 11 } } },
]
const hooksHtml = renderOpenChains(<TeamSessionProvider project={waitingProject as any} sessions={[{ id: 'leader-session', status: 'idle' }, { id: 'designer-session', status: 'running' }] as any} onOpenMember={() => {}}>
  <SessionConversation events={teamSessionEvents(waitingProject as any, 'leader-session', waitingWithHooks)} status="waiting_members" sessionId="leader-session" />
</TeamSessionProvider>)
const waitPosition = hooksHtml.indexOf('team-waiting-members-step')
assert.equal((hooksHtml.match(/data-step-id=/g) || []).length, 1, 'late Stop hooks must not create a new execution step')
assert.doesNotMatch(hooksHtml, /hook-batch|hook-row|本轮 Hook/, 'Hooks stay hidden while the team is waiting for members')
assert.ok(!hooksHtml.slice(waitPosition).includes('data-step-id=') && !hooksHtml.includes('card system-notice usage'), 'the waiting node remains the last step without a usage footer')

const continuingHtml = renderToStaticMarkup(<TeamSessionProvider project={wakeProject} sessions={[{ id: 'leader-session', status: 'running' }, { id: 'designer-session', status: 'idle' }] as any} onOpenMember={() => {}}>
  <SessionConversation events={teamSessionEvents(wakeProject as any, 'leader-session', wakeEvents)} status="running" sessionId="leader-session" />
</TeamSessionProvider>)
assert.ok(!continuingHtml.includes('card system-notice usage'), 'Leader continuation keeps all native turn usage hidden until the user task finishes')
console.log('PASS team waiting card, hidden running Hooks and completed task usage aggregation')

// Queue waits are per native turn: a Leader wake-up continues the same visual
// turn but opens a new queue id. Each wait keeps its own node/duration at its
// chronological position, so the live wait is visible at the bottom instead of
// being folded into the first wait near the start of the task.
const queueWakeEvents: any[] = [
  { sessionId: 'leader-session', seq: 1, ts: 1000, type: 'user_message', payload: { text: '先开始独立复核' } },
  { sessionId: 'leader-session', seq: 2, ts: 1010, type: 'turn_started', payload: { turnId: 'queue-turn-1' } },
  { sessionId: 'leader-session', seq: 3, ts: 1100, type: 'queue_status', state: 'running', payload: {
    id: 'native-wait-1', queue: { state: 'waiting', turnId: 'queue-turn-1', startedAt: 1100, waitedMs: 0, position: 30 },
  } },
  { sessionId: 'leader-session', seq: 4, ts: 2000, type: 'queue_status', state: 'success', payload: {
    id: 'native-wait-1', queue: { state: 'ready', turnId: 'queue-turn-1', waitedMs: 900, acquired: true },
  } },
  { sessionId: 'leader-session', seq: 5, ts: 2100, type: 'agent_message', state: 'success', payload: { id: 'queue-reply-1', phase: 'final_answer', text: '组员还在审查，我先做独立复核。' } },
  { sessionId: 'leader-session', seq: 6, ts: 3000, type: 'turn_completed', payload: { turnId: 'queue-turn-1' } },
  { sessionId: 'leader-session', seq: 7, ts: 3500, type: 'user_message', payload: { text: `[team_event：团队项目上下文，不是新的用户授权]\n${JSON.stringify({
    projectId: waitingProject.id, runId: 1, revision: 2, inboxSeq: 1, summary: '', events: [{
      eventId: 'event-queue', seq: 1, runId: 1, kind: 'result', assignmentId: waitingAssignment.id, attempt: 1,
      summary: '审查完成。', state: 'pending',
    }],
  })}\n及时处理已到结果，继续独立工作；发问/完成前核对最新 inboxSeq。` } },
  { sessionId: 'leader-session', seq: 8, ts: 3510, type: 'turn_started', payload: { turnId: 'queue-turn-2' } },
  { sessionId: 'leader-session', seq: 9, ts: 3520, type: 'hook', state: 'success', payload: { id: 'queue-hook', eventName: 'UserPromptSubmit', durationMs: 50 } },
  { sessionId: 'leader-session', seq: 10, ts: 4000, type: 'queue_status', state: 'running', payload: {
    id: 'native-wait-2', queue: { state: 'waiting', turnId: 'queue-turn-2', startedAt: 4000, waitedMs: 0, position: 11 },
  } },
]
const queueProject: any = { ...waitingProject, status: 'running' }
const queueSessions: any[] = [{ id: 'leader-session', status: 'running' }, { id: 'designer-session', status: 'running' }]
const realNow = Date.now
try {
  Date.now = () => 10_000
  const queueHtml = renderToStaticMarkup(<TeamSessionProvider project={queueProject} sessions={queueSessions} onOpenMember={() => {}}>
    <SessionConversation events={teamSessionEvents(queueProject, 'leader-session', queueWakeEvents)} status="running" sessionId="leader-session" />
  </TeamSessionProvider>)
  const metas = [...queueHtml.matchAll(/等待算力<\/span><span class="process-step-meta">([^<]*)</g)].map(match => match[1])
  assert.deepEqual(metas, ['1 秒 · 已结束', '第 12 位 · 已等待 6 秒'], 'each native queue wait keeps its own node and duration')
  assert.ok(queueHtml.indexOf('team-waiting-members-step') < queueHtml.indexOf('第 12 位'), 'the live wait follows the waiting card instead of the first wait position')
  assert.doesNotMatch(queueHtml, /hook-batch|hook-row|本轮 Hook/, 'wake-up Hooks stay hidden without adding an empty process step')

  const completedQueueEvents = queueWakeEvents.map(event => event.seq !== 10 ? event : { ...event, ts: 5000, state: 'success', payload: {
    id: 'native-wait-2', queue: { state: 'ready', turnId: 'queue-turn-2', waitedMs: 5000, acquired: true },
  } }).concat([
    { sessionId: 'leader-session', seq: 11, ts: 5100, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 300, outputTokens: 30 } } },
    { sessionId: 'leader-session', seq: 12, ts: 5200, type: 'turn_completed', payload: { turnId: 'queue-turn-2' } },
  ])
  Date.now = () => 6_000
  const completedQueueHtml = renderOpenChains(<TeamSessionProvider project={{ ...queueProject, status: 'completed' }} sessions={[{ id: 'leader-session', status: 'idle' }, { id: 'designer-session', status: 'idle' }]} onOpenMember={() => {}}>
    <SessionConversation events={teamSessionEvents({ ...queueProject, status: 'completed' }, 'leader-session', completedQueueEvents)} status="idle" sessionId="leader-session" />
  </TeamSessionProvider>, { processed: true })
  const completedMetas = [...completedQueueHtml.matchAll(/等待算力<\/span><span class="process-step-meta">([^<]*)</g)].map(match => match[1])
  assert.deepEqual(completedMetas, ['1 秒 · 已结束', '5 秒 · 已结束'], 'a completed wake-up wait reports only its own phase')
  assert.match(completedQueueHtml, /等待算力 6s/, 'the usage footer sums every native wait in the user task')
} finally {
  Date.now = realNow
}
console.log('PASS per-native queue waits stay visible after a Leader wake-up')
