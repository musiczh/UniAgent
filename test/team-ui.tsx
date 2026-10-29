import DOMPurify from 'dompurify'
// Node SSR has no browser DOM; assertions cover card structure, not sanitization.
Object.assign(DOMPurify, { sanitize: (html: string) => html })
import { EventStream, TurnStatusBar } from '../src/renderer/components/EventStream'
import { SessionConversation } from '../src/renderer/components/SessionConversation'
import { formatTeamAssignmentPrompt, parseTeamAssignmentPrompt } from '../src/shared/teamAssignmentPrompt'
import { teamCanArchive, teamSessionRows } from '../src/renderer/teamSessions'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from '../src/renderer/components/Composer'
import { TeamSessionContext } from '../src/renderer/components/TeamSessionExtras'
import { ApprovalCard, QuestionForm } from '../src/renderer/components/EventStream'
import { emptyNativeCapabilitySnapshot } from '../src/shared/nativeCapabilities'

const noop = () => {}
const props: any = {
  status: 'running', agent: {id:'traex',name:'TraeX',adapter:'traex',installed:true,models:[],capabilities:{permissionModes:[{id:'read-only',label:'只读'}],modelSelect:true}},
  config:{agentId:'traex',workdir:'/tmp',permissionMode:'read-only'}, onSend:noop,onForceSend:noop,onInterrupt:noop,onUpdateConfig:noop,onSetCollaborationMode:noop,onRunNativeAction:noop,
  queue:[],onDequeue:noop,onPromoteQueue:noop,onEditQueueItem:noop,capabilities:emptyNativeCapabilitySnapshot('traex','/tmp'),capabilitiesReady:true,
  contextUsed:0,onCompact:async()=>{},canCompact:false,compacting:false,
  interruptsTeam: true, allowRoleConfig: true
}
const team = renderToStaticMarkup(<Composer {...props} />)
assert.ok(team.includes('sb-agent') && team.includes('sb-cfg') && team.includes('ctx-meter'), 'Leader retains ordinary Session controls')
assert.ok(team.includes('aria-label="中止全部 Agent"'))
const ordinary = renderToStaticMarkup(<Composer {...props} interruptsTeam={false} />)
assert.ok(ordinary.includes('aria-label="中止"') && ordinary.includes('sb-agent'))
const idleTeam = renderToStaticMarkup(<Composer {...props} status="idle" />)
assert.ok(!idleTeam.includes('composer-stop-btn'), 'team identity alone cannot show a stop button')
const waitingTeam = renderToStaticMarkup(<Composer {...props} status="waiting_members" runtimeStatus="idle" />)
assert.ok(waitingTeam.includes('composer-stop-btn') && waitingTeam.includes('继续对话'), 'member wait keeps Stop available while the idle native Leader accepts direct input')
const timerEvents: any[] = [
  { sessionId: 's', seq: 1, ts: 1000, type: 'user_message', payload: { text: 'Task' } },
  { sessionId: 's', seq: 2, ts: 2000, type: 'turn_completed', payload: {} },
  { sessionId: 's', seq: 3, ts: 3000, type: 'system_notice', payload: { kind: 'team_wakeup' } },
  { sessionId: 's', seq: 4, ts: 4000, type: 'user_message', payload: { text: 'Follow-up', appendedToTurn: true } },
  { sessionId: 's', seq: 5, ts: 5000, type: 'turn_completed', payload: {} }
]
assert.ok(renderToStaticMarkup(<TurnStatusBar events={timerEvents} status="waiting_members" />).includes('st-running'), 'member wait cannot display a green completed timer')
const finishedTimer = renderToStaticMarkup(<TurnStatusBar events={timerEvents} status="idle" />)
assert.ok(finishedTimer.includes('st-done') && finishedTimer.includes('4s'), 'internal continuations keep the full task duration')

const configuredProps: any = {
  ...props,
  agent: {
    ...props.agent,
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', supportsFast: true, supportsMax: true, efforts: ['high'] }],
    capabilities: { ...props.agent.capabilities, reasoningEffort: true }
  },
  config: {
    ...props.config,
    model: 'gpt-5.6-sol', effort: 'high', fastMode: true, maxMode: true,
    roleSnapshot: { name: '开发一号位' }
  }
}
const teamNameOnly = renderToStaticMarkup(
  <TeamSessionContext.Provider value={{ project: { team: { name: '开发团队' } }, sessions: [], onOpenMember: noop, openArtifact: noop } as any}>
    <Composer {...configuredProps} />
  </TeamSessionContext.Provider>
)
assert.ok(teamNameOnly.includes('专家团 · 开发团队'), 'team Composer shows the expert group name')
assert.ok(!teamNameOnly.includes('角色 · 开发一号位') && !teamNameOnly.includes('GPT-5.6-Sol') && !teamNameOnly.includes('sb-agent'), 'team Composer hides role and runtime controls')
const configuredOrdinary = renderToStaticMarkup(<Composer {...configuredProps} />)
assert.ok(configuredOrdinary.includes('角色 · 开发一号位') && configuredOrdinary.includes('GPT-5.6-Sol') && configuredOrdinary.includes('sb-agent'), 'ordinary Composer keeps role and runtime controls')

const ev:any={sessionId:'s',seq:1,ts:1,type:'approval_request',state:'pending',payload:{requestId:'q',kind:'question',method:'item/tool/requestUserInput',params:{questions:[{id:'scope',question:'Include supplemental data?',options:[{label:'Include'},{label:'Exclude'}]}]}}}
const readonly = renderToStaticMarkup(<ApprovalCard ev={ev} {...{readOnly:true} as any} />)
assert.ok(readonly.includes('Include supplemental data?'), 'read-only transcript must retain question content')
assert.ok(readonly.includes('interaction-compact') && readonly.includes('详情') && !readonly.includes('去回答'), 'read-only question exposes compact history details')
assert.ok(!readonly.includes('<input') && !readonly.includes('<textarea') && !readonly.includes('<fieldset'), 'read-only transcript must not contain approval or answer controls')
const undockedQuestion = renderToStaticMarkup(<ApprovalCard ev={ev} onRespond={noop} />)
assert.ok(undockedQuestion.includes('interaction-compact') && !undockedQuestion.includes('<fieldset') && !undockedQuestion.includes('去回答'), 'question content stays out of the timeline and requires a dock to answer')
const teamQuestion = renderToStaticMarkup(<ApprovalCard ev={{ ...ev, payload: { ...ev.payload, teamQuestion: true } }} readOnly />)
assert.ok(teamQuestion.includes('team-question-step') && teamQuestion.includes('interaction-compact') && !teamQuestion.includes('<fieldset'), 'team questions use the same compact timeline node')
console.log('PASS team Composer and read-only approval contracts')

const partial:any={...ev,payload:{...ev.payload,params:{questions:[{id:'first',question:'First pending group'},{id:'second',question:'Second pending group'}]},submittedAnswer:{answers:{first:{answers:['One']},second:{answers:[]}}}}}
const partialHtml=renderToStaticMarkup(<ApprovalCard ev={partial} readOnly />)
assert.ok(partialHtml.includes('待回答') && !partialHtml.includes('已回答'), 'partial business answers cannot resolve the whole read-only question group')
const answeredQuestion = renderToStaticMarkup(<ApprovalCard ev={{ ...partial, state: 'success' }} readOnly />)
assert.ok(answeredQuestion.includes('interaction-step answered') && answeredQuestion.includes('ui-icon-question') && answeredQuestion.includes('已回答'), 'answered questions retain their question icon and update the existing timeline outcome')
const allAnswers = renderToStaticMarkup(<QuestionForm kind="question" method={partial.payload.method} params={partial.payload.params} answer={{ answers: { first: { answers: ['One'] }, second: { answers: ['Two'] } } }} readOnly />)
assert.ok(allAnswers.includes('First pending group') && allAnswers.includes('Second pending group') && allAnswers.includes('One') && allAnswers.includes('Two'), 'read-only history shows every question and answer')
assert.ok(!allAnswers.includes('question-pager') && !allAnswers.includes('<button') && !allAnswers.includes('<input') && !allAnswers.includes('<textarea'), 'read-only history has no answer controls or paging')
const decision:any={...ev,state:'success',payload:{requestId:'permission',kind:'command',params:{command:'echo verification'},submittedAnswer:{decision:'decline'}}}
const decisionHtml=renderToStaticMarkup(<ApprovalCard ev={decision} readOnly />)
assert.ok(decisionHtml.includes('echo verification') && decisionHtml.includes('拒绝'), 'role session must retain the original permission request and decision')

const receipt: any = { id: 'direct', message: 'Only read files', state: 'unknown', attempt: 1, createdAt: 2 }
const transcript: any[] = [
  { sessionId: 'member', seq: 1, ts: 1, type: 'turn_started', payload: {} },
  { sessionId: 'member', seq: 2, ts: 2, type: 'system_notice', payload: { kind: 'team_communication', teamCommunicationId: receipt.id, communication: receipt, sender: 'Leader', recipient: 'Reviewer' } },
  { sessionId: 'member', seq: 3, ts: 3, type: 'agent_message', state: 'success', payload: { text: 'Acknowledged' } },
  { sessionId: 'member', seq: 4, ts: 4, type: 'turn_completed', state: 'success', payload: {} }
]
const completed = renderToStaticMarkup(<EventStream events={transcript} status="idle" sessionId="member" />)
assert.ok(completed.includes('processed-fold'), 'completed member communication remains traceable in the processed disclosure')
const running = renderToStaticMarkup(<EventStream events={transcript.slice(0, 2)} status="running" sessionId="member" />)
assert.ok(running.includes('Only read files'), 'running member communication is visible')
const rows = teamSessionRows([{ id:'tp', name:'Team conversation', spaceId:'space', requirementId:'req', memberSessions:{ leader:'l', worker:'w' }, team:{ leaderMemberId:'leader', members:[{id:'leader',role:{agentId:'removed'}}] }, spaceRoots:['/repo'], status:'waiting_members', interactions:[], createdAt:1, updatedAt:2 } as any], [{ id: 'l', status: 'idle', config: { agentId: 'removed', requirementId: 'req' } }, { id: 'w', status: 'running', config: { agentId: 'removed' } }] as any)
assert.equal(rows.length, 1); assert.equal(rows[0].id, 'l'); assert.equal(rows[0].status, 'idle'); assert.equal(rows[0].config.requirementId, 'req')
const interrupted = { id:'orphan', status:'interrupted', archivedAt:undefined, interactions:[], assignments:[{ status:'running' }] } as any
assert.equal(teamCanArchive(interrupted), true, 'interrupted orphan projects can be archived despite stale assignment status')
console.log('PASS team-only sidebar projection and live/completed direct communication cards')

const assignmentPayload = {
  assignmentId: 'assignment-1', attempt: 2, title: 'Review the long task',
  goal: 'Read every requirement.\nKeep this entire long goal visible.',
  permissionMode: 'read-only' as const, expectedOutput: 'A structured review',
  contextRefs: [], projectSummary: '',
  sharedContext: { brief: 'Shared background', decisions: ['Keep history'], openQuestions: [] },
  revision: 6,
}
const assignmentPrompt = formatTeamAssignmentPrompt(assignmentPayload)
const parsedAssignment = parseTeamAssignmentPrompt(assignmentPrompt)
assert.equal(parsedAssignment.kind, 'parsed')
assert.deepEqual(parsedAssignment.kind === 'parsed' ? parsedAssignment.payload : undefined, assignmentPayload)
assert.equal(parseTeamAssignmentPrompt('ordinary message').kind, 'not-assignment')
assert.equal(parseTeamAssignmentPrompt('[团队派单]\n{broken json').kind, 'invalid')

const assignmentEvent: any = { sessionId: 'member', seq: 10, ts: 10, type: 'user_message', payload: { text: assignmentPrompt } }
const assignmentContext: any = { sender: 'Coordinator', recipient: 'Reviewer', statusByAssignmentKey: { 'assignment-1:2': 'running' } }
const assignmentHtml = renderToStaticMarkup(<SessionConversation readOnly events={[assignmentEvent]} status="running" sessionId="member" teamAssignmentContext={assignmentContext} />)
assert.ok(assignmentHtml.includes('team-assignment') && !assignmentHtml.includes('user-msg'), 'recognized member assignment renders as a system card')
assert.ok(assignmentHtml.includes('Coordinator') && assignmentHtml.includes('你 · Reviewer'), 'assignment route is explicit')
assert.ok(assignmentHtml.includes('Keep this entire long goal visible.') && assignmentHtml.includes('任务上下文 / 技术详情'), 'long goal and technical disclosure remain available')
assert.ok(assignmentHtml.includes('完全访问') === false && assignmentHtml.includes('只读'), 'logical permission is readable')
assert.ok(!assignmentHtml.includes('team-assignment-state') && !assignmentHtml.includes('执行中'), 'assignment header does not duplicate status')
assert.ok(assignmentHtml.includes('ui-icon-chevron-right') && !assignmentHtml.includes('ui-icon-chevron-down'), 'collapsed assignment details point right')
const fallbackHtml = renderToStaticMarkup(<SessionConversation readOnly events={[{ ...assignmentEvent, payload: { text: '[团队派单] 旧格式但缺少 JSON' } }]} status="idle" sessionId="member" teamAssignmentContext={assignmentContext} />)
assert.ok(fallbackHtml.includes('无法解析为结构化派单') && fallbackHtml.includes('旧格式但缺少 JSON'), 'malformed historical assignment preserves its raw text')
const ordinaryMemberHtml = renderToStaticMarkup(<SessionConversation readOnly events={[{ ...assignmentEvent, payload: { text: 'ordinary member note' } }]} status="idle" sessionId="member" teamAssignmentContext={assignmentContext} />)
assert.ok(ordinaryMemberHtml.includes('user-msg') && !ordinaryMemberHtml.includes('team-assignment'), 'ordinary member messages remain user bubbles')
console.log('PASS structured team assignment parsing, card, fallback and ordinary-message isolation')
