import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SessionAttentionBadge } from '../src/main/appNotifications'
import { StatusIndicator } from '../src/renderer/components/SessionList.tsx'
import { teamRowSessionId, teamRowSessionIds } from '../src/shared/teamAttention'
import { isSessionBusy, sessionActivityStatus } from '../src/shared/sessionStatus'
import type { Session, SessionStatus } from '../src/shared/types'

for (const status of ['draft', 'idle', 'completed', 'cancelled', 'interrupted', 'archived'] as const) {
  assert.equal(StatusIndicator({ status }), null, `${status} stays unmarked when read`)
}
for (const source of ['main', 'side'] as const) {
  for (const terminal of ['idle', 'completed', 'error', 'cancelled', 'interrupted']) {
    const owner = { id: 'reply', status: 'idle', config: {} } as Session
    const attention = new SessionAttentionBadge(() => {}, () => false)
    attention.handleStatus(owner, 'running', owner, source)
    attention.handleStatus(owner, terminal, owner, source)
    assert.equal(attention.snapshot().unreadBySession.reply, source, `${source} -> ${terminal} produces its original marker`)
    attention.handleStatus(owner, 'running', owner, source)
    assert.deepEqual(attention.snapshot().unreadBySession, {}, 'resuming clears the corresponding result')
  }
}

const teamRows = teamRowSessionIds([
  { team: { leaderMemberId: 'lead' }, memberSessions: { lead: 'leader', worker: 'worker', empty: '' } },
  { team: { leaderMemberId: 'missing' }, memberSessions: { other: 'other' } }
] as any)
assert.equal(teamRows.get('leader'), 'leader', 'the Leader owns its own row')
assert.equal(teamRows.get('worker'), 'leader', 'a member reply belongs to the team row')
assert.equal(teamRows.get('other'), undefined, 'a project without a Leader session cannot claim a row')
assert.equal(teamRows.get('empty'), undefined, 'unassigned members are not rows')
assert.equal(teamRowSessionId(teamRows, 'worker'), 'leader')
assert.equal(teamRowSessionId(teamRows, 'plain'), 'plain', 'standalone sessions keep their own row')
const mainReply = StatusIndicator({ status: 'completed', unread: 'main' })
assert.equal(mainReply?.props.className, 'si-unread ', 'a completed main reply keeps its unread dot')
const sideReply = StatusIndicator({ status: 'idle', unread: 'side' })
assert.equal(sideReply?.props.className, 'si-unread side', 'a completed side reply keeps its cyan unread dot')
const error = StatusIndicator({ status: 'error' })
assert.equal(error?.props.className, 'si-error', 'an error remains visible')
assert.equal(error?.props.children, undefined, 'an error restores its red status dot')
const pending = StatusIndicator({ status: 'running', hasPendingInteraction: true })
assert.equal(pending?.props.className, 'si-ask', 'pending user interaction keeps priority over the running spinner')
const waitingMembers = StatusIndicator({ status: 'waiting_members' })
assert.equal(waitingMembers?.props.className, 'si-spinner', 'team waiting uses the same blue spinner as every running session')

const statuses: SessionStatus[] = ['draft', 'running', 'queued', 'awaiting-approval', 'cancelling', 'cancelled', 'interrupted', 'error', 'completed', 'idle', 'archived']
for (const status of statuses) {
  const session = { id: 'leader', status } as Session
  assert.equal(sessionActivityStatus(session), status, 'ordinary Sessions preserve every native state')
  assert.equal(isSessionBusy(status), ['running', 'queued', 'awaiting-approval', 'cancelling'].includes(status))
}
const leader = { id: 'leader', status: 'idle' } as Session
const project: any = {
  team: { leaderMemberId: 'lead' }, memberSessions: { lead: 'leader', worker: 'worker' },
  runId: 2, status: 'waiting_user', assignments: [], interactions: [], inbox: []
}
assert.equal(sessionActivityStatus(leader, project), 'idle', 'an unclosed empty team is not busy')
const task = { runId: 2, status: 'running' }
assert.equal(sessionActivityStatus(leader, { ...project, assignments: [task] }), 'waiting_members', 'awaiting a current member reply keeps the team Session active')
assert.equal(sessionActivityStatus(leader, { ...project, assignments: [{ ...task, runId: 1 }] }), 'idle', 'old-run tasks cannot restart the Session')
assert.equal(sessionActivityStatus(leader, { ...project, assignments: [{ ...task, endedAt: 1 }] }), 'idle', 'ended tasks cannot restart the Session')
assert.equal(sessionActivityStatus(leader, project, [{ id: 'worker', status: 'running' } as Session]), 'waiting_members', 'live member status covers task metadata delays')
assert.equal(sessionActivityStatus(leader, { ...project, inbox: [{ runId: 2, state: 'pending', kind: 'result' }] }), 'waiting_members', 'the result delivery boundary stays active')
assert.equal(sessionActivityStatus(leader, { ...project, inbox: [{ runId: 2, state: 'delivered', kind: 'result' }] }), 'idle', 'already delivered results do not keep a stopped Session busy')
assert.equal(sessionActivityStatus(leader, { ...project, interactions: [{ runId: 2, state: 'pending', kind: 'native_approval' }] }), 'awaiting-approval', 'a real user approval drives the same waiting state everywhere')
assert.equal(sessionActivityStatus(leader, { ...project, status: 'stopping', assignments: [task] }), 'cancelling', 'team cancellation stays active until work ends')
for (const status of ['completed', 'interrupted', 'failed']) {
  assert.equal(sessionActivityStatus(leader, { ...project, status, assignments: [task] }), 'idle', 'terminal projects ignore stale active tasks')
}
assert.equal(sessionActivityStatus(leader, { ...project, archivedAt: 1, assignments: [task] }), 'idle', 'archived team records cannot restart the Session')
assert.equal(isSessionBusy('waiting_user'), false, 'project state cannot masquerade as Session activity')
assert.match(readFileSync('src/renderer/styles.css', 'utf8'), /\.si-unread\.side\s*\{[^}]*background:\s*var\(--cyan\)/s,
  'side replies use the existing cyan color')
console.log('session reply unread: ok')
