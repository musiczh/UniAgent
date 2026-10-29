import type { Session, UAEvent } from '@shared/types'
import type { TeamProject, TeamAssignment } from '@shared/teamTypes'
import { pendingTeamQuestion, teamInteractionForUser, teamQuestionParams, teamRequestId } from '@shared/teamQuestions'
import { parseTeamEventPrompt, type ParsedTeamEventPrompt } from '@shared/teamEventPrompt'

/** Add domain metadata to the ordinary transcript; never manufacture tool calls. */
export function teamSessionEvents(project: TeamProject, sessionId: string, events: UAEvent[]): UAEvent[] {
  const leader = sessionId === project.memberSessions[project.team.leaderMemberId]
  const question = leader ? pendingTeamQuestion(project) : undefined
  const wakeups = new Map<UAEvent, Exclude<ParsedTeamEventPrompt, { kind: 'not-event' }>>()
  for (const event of events) {
    if (event.type !== 'user_message') continue
    const wakeup = parseTeamEventPrompt(event.payload.text)
    if (wakeup.kind === 'not-event') continue
    wakeups.set(event, wakeup)
  }
  const result = events.map(e => {
    if (e.type === 'system_notice' && e.payload.kind === 'team_communication') return {
      ...e, payload: { ...e.payload, kind: 'team_event', text: `Leader 补充（${e.payload.communication?.state || '已发送'}）：${e.payload.communication?.message || e.payload.text || ''}` },
    }
    const wakeup = wakeups.get(e)
    if (!wakeup) return e
    const payload = wakeup.kind === 'parsed' ? wakeup.payload : undefined
    return { ...e, type: 'system_notice' as const, payload: {
      ...e.payload, id: e.payload.id || `team-wakeup:${e.seq}`, kind: 'team_wakeup', source: 'team_event', text: '',
      teamRunId: payload?.runId, teamEvents: payload?.events || [], teamEventPrompt: wakeup,
    } }
  })
  let seq = Math.max(0, ...events.map(e => e.seq)) + 1
  // Old TeamStore messages are a fallback only where no matching real message exists.
  if (leader && !project.legacyMessagesArchived) for (const m of project.messages) {
    const type = m.kind === 'user' ? 'user_message' : 'agent_message'
    if (result.some(e => e.type === type && (e.payload.text === m.text || e.payload.displayText === m.text))) continue
    result.push({ sessionId, seq: seq++, ts: m.createdAt, type, state: 'success', payload: { id: 'legacy:' + m.id, text: m.text, attachments: m.attachments } })
  }
  if (leader) for (const a of project.assignments) {
    for (const attempt of [...a.history, a]) {
      result.push({ sessionId, seq: seq++, ts: attempt.dispatchedAt ?? a.createdAt, type: 'system_notice', payload: {
        id: `team-dispatch:${a.id}:${attempt.attempt}`, kind: 'team_dispatch', assignmentId: a.id, attempt: attempt.attempt, teamRunId: a.runId, taskTitle: attempt.title || a.title,
        memberSessionId: project.memberSessions[a.memberId], memberName: project.team.members.find(m => m.id === a.memberId)?.role.name || '成员',
      } })
      if (attempt.endedAt && (!question || attempt.endedAt < question.createdAt)) result.push({ sessionId, seq: seq++, ts: attempt.endedAt, type: 'system_notice', payload: {
        id: `team-delivery:${a.id}:${attempt.attempt}`, kind: 'team_delivery_notice', assignmentId: a.id, attempt: attempt.attempt, teamRunId: a.runId,
        summary: project.inbox.find(e => e.assignmentId === a.id && e.attempt === attempt.attempt && ['result', 'blocked'].includes(e.kind))?.summary || '',
      } })
    }
  }
  if (leader) {
    const latestInput = events.filter(e => e.type === 'user_message' && !wakeups.has(e)).at(-1)?.ts ?? 0
    const attempts = project.assignments.flatMap(a => [...a.history, a].map(attempt => ({ assignmentId: a.id, runId: a.runId, attempt: attempt.attempt, dispatchedAt: attempt.dispatchedAt ?? a.createdAt, endedAt: attempt.endedAt })))
    const covered = new Set<string>()
    for (const e of events) {
      if (e.type !== 'turn_completed' || e.state === 'failed' || e.state === 'cancelled' || e.ts < latestInput) continue
      const assignments = attempts.filter(a => a.dispatchedAt <= e.ts && (!a.endedAt || a.endedAt > e.ts))
      if (!assignments.some(a => !covered.has(`${a.assignmentId}:${a.attempt}`))) continue
      const refs = assignments.map(a => ({ assignmentId: a.assignmentId, attempt: a.attempt }))
      for (const a of assignments) covered.add(`${a.assignmentId}:${a.attempt}`)
      result.push({ sessionId, seq: seq++, ts: e.ts, type: 'system_notice', payload: { id: `team-wait:${e.seq}`, kind: 'team_wait', assignmentRefs: refs, teamRunId: assignments[0].runId } })
    }
  }
  for (const c of (project.communications || []).filter(c => c.sessionId === sessionId)) {
    if (result.some(e => e.payload.teamCommunicationId === c.id)) continue
    result.push({ sessionId, seq: seq++, ts: c.createdAt, type: 'system_notice', payload: { id: c.id, kind: 'team_event', text: `Leader 补充（${c.state}）：${c.message}` } })
  }
  for (const i of project.interactions.filter(i => leader ? teamInteractionForUser(i, project.team.leaderMemberId) : i.sessionId === sessionId)) {
    const state = i.state === 'pending' ? 'pending' : i.state === 'answered' ? 'success' : 'cancelled'
    // Replace the original request with its authoritative answered/expired state.
    const index = result.findIndex(e => e.type === 'approval_request' && (e.payload.teamInteractionId === i.id || e.payload.requestId === i.requestId && (!i.event || e.seq === i.event.seq && e.ts === i.event.ts)))
    const ev: UAEvent = { ...(i.event || {}), sessionId, seq: index >= 0 ? result[index].seq : seq++, ts: i.createdAt, type: 'approval_request', state, payload: {
      ...(index >= 0 ? result[index].payload : i.event?.payload || {}), requestId: leader ? teamRequestId(i) : i.requestId || i.id,
      ...(i.kind === 'leader_question' ? { kind: 'question', params: teamQuestionParams(i), method: 'team/askUser', teamQuestion: true, delivery: 'blocking' } : {}),
      teamInteractionId: i.id, teamRevision: i.revision, teamSource: project.team.members.find(m => m.id === i.memberId)?.role.name,
      submittedAnswer: i.answer ?? i.event?.payload.submittedAnswer ?? (i.state !== 'pending' && i.questions?.some(q => q.answer) ? { answers: Object.fromEntries(i.questions.map(q => [q.id, { answers: q.answer ? [q.answer] : [] }])) } : undefined)
    } }
    if (index >= 0) result[index] = ev; else result.push(ev)
  }
  return result.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
}

export function teamMemberTask(project: TeamProject, memberId: string): TeamAssignment | undefined {
  const assignments = project.assignments.filter(a => a.runId === project.runId && a.memberId === memberId)
  return assignments.find(a => !a.endedAt && ['running', 'blocked', 'cancelling'].includes(a.status)) || assignments.find(a => a.status === 'queued') || assignments.at(-1)
}

export function teamWaitingAssignments(project: TeamProject, sessionId?: string): TeamAssignment[] {
  if (project.archivedAt || !['ready', 'running', 'waiting_members', 'waiting_user'].includes(project.status) || sessionId !== project.memberSessions[project.team.leaderMemberId]) return []
  const active = project.assignments.filter(assignment => assignment.runId === project.runId && !assignment.endedAt &&
    ['queued', 'running', 'blocked', 'cancelling'].includes(assignment.status))
  return [...new Map(active.map(assignment => [assignment.memberId, assignment])).values()]
}

export function teamMemberStatus(project: TeamProject, memberId: string, session?: Session): string {
  const pending = project.interactions.find(i => i.memberId === memberId && i.state === 'pending')
  if (pending) return pending.kind === 'native_approval' ? 'awaiting-approval' : 'waiting_user'
  const assignment = teamMemberTask(project, memberId)
  if (assignment) return assignment.status
  if (memberId === project.team.leaderMemberId) {
    if (['stopping', 'failed', 'interrupted', 'completed'].includes(project.status)) return project.status
    if (session && ['running', 'queued', 'awaiting-approval'].includes(session.status)) return session.status
    return project.assignments.some(a => a.runId === project.runId && !a.endedAt && ['queued', 'running', 'blocked', 'cancelling'].includes(a.status)) ? 'waiting_members' : 'idle'
  }
  return 'idle'
}
