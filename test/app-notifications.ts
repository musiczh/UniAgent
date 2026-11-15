import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import React from 'react'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { appNotificationBody, SessionAttentionBadge, shouldShowAppNotification } from '../src/main/appNotifications'
import { useSessionAttention } from '../src/renderer/hooks'
import type { Session, UAEvent } from '../src/shared/types'
import type { SessionAttentionSnapshot } from '../src/shared/sessionAttention'

const session = (id = 'session-1', patch: Partial<Session> = {}): Session => ({
  id, title: id, status: 'idle', createdAt: 1,
  config: { agentId: 'codex', workdir: '/repo' }, ...patch
})
const attentionEvent = (type: UAEvent['type'], state: UAEvent['state'], patch: Partial<UAEvent> = {}): UAEvent => ({
  sessionId: 'session-1', seq: 1, ts: 1, type, state, payload: {}, ...patch
})

function badgeFixture(onChange?: (snapshot: SessionAttentionSnapshot) => void) {
  let focused = false
  let text = ''
  const updates: string[] = []
  const badge = new SessionAttentionBadge(value => { text = value; updates.push(value) }, () => focused, onChange)
  return { badge, updates, text: () => text, focus: (value: boolean) => { focused = value } }
}

test('Dock badge counts questions, approvals, completion and failures once per session', () => {
  for (const event of [
    attentionEvent('approval_request', 'pending', { payload: { kind: 'question' } }),
    attentionEvent('approval_request', 'pending', { payload: { kind: 'elicitation' } }),
    attentionEvent('approval_request', 'pending', { payload: { kind: 'command' } }),
    attentionEvent('agent_message', 'running', { payload: { id: 'async-q1', delivery: 'async', questions: [{ id: 'q1', question: '继续吗？' }] } }),
    attentionEvent('turn_completed', 'success'),
    attentionEvent('turn_completed', 'failed'),
    attentionEvent('turn_completed', 'cancelled'),
    attentionEvent('error', 'failed')
  ]) {
    const f = badgeFixture()
    f.badge.handleEvent(event, session())
    assert.equal(f.text(), '1', `${event.type}/${event.state} requires attention`)
    f.badge.handleEvent({ ...event, seq: 2 }, session())
    f.badge.handleStatus(session(), 'error')
    assert.deepEqual(f.updates, ['1'], 'multiple reminders in one session still count once')
    f.badge.handleEvent({ ...event, sessionId: 'session-2' }, session('session-2'))
    assert.equal(f.text(), '2')
  }
})

test('accepted answers clear their question without changing execution or approval state', () => {
  const f = badgeFixture()
  const owner = session('session-1', { status: 'awaiting-approval' })
  const event = attentionEvent('approval_request', 'pending', { payload: { kind: 'question', requestId: 'q1' } })
  const before = structuredClone({ owner, event })
  f.badge.handleEvent(event, owner)
  f.badge.handleEvent(attentionEvent('turn_started', 'running'), owner)
  f.badge.handleEvent({ ...event, state: 'success' }, owner)
  assert.equal(f.text(), '1', 'an unconfirmed provider update does not clear the question')
  f.badge.handleEvent({ ...event, state: 'success', payload: { ...event.payload, submittedAnswer: {} } }, owner)
  assert.equal(f.text(), '', 'a confirmed answer clears attention from any entry point')
  f.focus(true)
  f.badge.setVisibleSession(owner.id)
  assert.equal(f.text(), '', 'zero unread sessions removes the badge instead of displaying 0')
  f.badge.setVisibleSession(owner.id)
  assert.deepEqual(f.updates, ['1', ''], 'reading twice cannot decrement below zero')
  assert.deepEqual({ owner, event }, before)
  f.badge.setVisibleSession(null)
  f.badge.handleEvent(event, owner)
  assert.equal(f.text(), '', 'replaying the same pending request cannot make a read session unread')
  f.badge.handleEvent({ ...event, seq: 2, payload: { ...event.payload, requestId: 'q2' } }, owner)
  assert.equal(f.text(), '1', 'a new question after reading becomes unread again')
})

test('answering one of several questions preserves other questions and new main/side results', () => {
  const f = badgeFixture(), owner = session()
  const question = (requestId: string, seq: number) => attentionEvent('approval_request', 'pending', {
    seq, payload: { kind: 'question', requestId }
  })
  const first = question('q1', 1), second = question('q2', 2)
  const answer = (event: UAEvent) => ({ ...event, state: 'success' as const, payload: { ...event.payload, submittedAnswer: {} } })
  f.badge.handleEvent(first, owner)
  f.badge.handleEvent(second, owner)
  f.badge.handleEvent(answer(second), owner)
  assert.equal(f.text(), '1', 'answering the newest question cannot hide another pending question')
  f.badge.handleEvent(answer(first), owner)
  assert.equal(f.text(), '', 'answering every question clears the session')
  f.badge.handleEvent(first, owner)
  assert.equal(f.text(), '', 'late pending snapshots cannot revive answered questions')
  f.badge.handleEvent(attentionEvent('turn_completed', 'success', { seq: 3 }), owner)
  f.badge.handleEvent(attentionEvent('turn_completed', 'success', { seq: 4 }), owner, 'side')
  f.badge.handleEvent(answer(first), owner)
  assert.equal(f.text(), '1', 'replayed answers preserve new results')
  f.badge.handleEvent(attentionEvent('user_message', 'success', { seq: 5, payload: { text: '继续', source: 'feishu' } }), owner)
  assert.equal(f.text(), '1', 'main input preserves an unread side result')
  f.badge.handleEvent(attentionEvent('user_message', 'success', { seq: 6, payload: { text: '继续', source: 'app' } }), owner, 'side')
  assert.equal(f.text(), '', 'accepted side input clears its own result')
})

test('foreground session is read while background and hidden-page sessions remain unread', () => {
  const f = badgeFixture()
  const event = attentionEvent('turn_completed', 'success')
  f.focus(true)
  f.badge.setVisibleSession('session-1')
  f.badge.handleEvent(event, session())
  assert.equal(f.text(), '', 'a new event in the foreground session is already read')
  f.badge.handleEvent({ ...event, sessionId: 'session-2' }, session('session-2'))
  assert.equal(f.text(), '1', 'other sessions remain unread even while the app is focused')
  f.badge.readVisibleSession()
  assert.equal(f.text(), '1', 'focusing the app does not clear other sessions')
  f.focus(false)
  f.badge.handleEvent({ ...event, seq: 2 }, session())
  assert.equal(f.text(), '2', 'a selected session is unread when the app is unfocused or minimized')
  f.badge.setVisibleSession('session-1')
  assert.equal(f.text(), '2', 'background navigation cannot read a session')
  f.focus(true)
  f.badge.readVisibleSession()
  assert.equal(f.text(), '1', 'returning to the visible session clears only that session')
  f.badge.setVisibleSession(null)
  f.badge.handleEvent({ ...event, seq: 3 }, session())
  assert.equal(f.text(), '2', 'settings, startup, a closed window and new-task pages display no session')
  f.badge.readVisibleSession()
  assert.equal(f.text(), '2')
  f.badge.setVisibleSession('session-2')
  assert.equal(f.text(), '1')
})

test('only main-frame document navigation stops reading the visible session', () => {
  const f = badgeFixture()
  f.focus(true)
  f.badge.setVisibleSession('session-1')
  f.badge.handleNavigation(false, false)
  f.badge.handleEvent(attentionEvent('turn_completed', 'success'), session())
  assert.equal(f.text(), '', 'loading an HTML preview iframe keeps the session visible')
  f.badge.handleNavigation(true, true)
  f.badge.handleEvent(attentionEvent('turn_completed', 'success', { seq: 2 }), session())
  assert.equal(f.text(), '', 'same-document navigation keeps the session visible')
  f.badge.handleNavigation(true, false)
  f.badge.handleEvent(attentionEvent('turn_completed', 'success', { seq: 3 }), session())
  assert.equal(f.text(), '1', 'reloading the document no longer counts as reading the session')
})

test('archiving a real session clears its unread badge after persistence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-session-badge-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.saveOrThrow([session()])
  const orchestrator = new Orchestrator(() => undefined, store, join(directory, 'artifacts'))
  orchestrator.loadPersisted()
  const f = badgeFixture()
  orchestrator.on('sessionArchived', id => f.badge.archiveSession(id))
  const completed = attentionEvent('turn_completed', 'success')
  f.badge.handleEvent(completed, orchestrator.getSessionById('session-1'))
  assert.equal(f.text(), '1')
  orchestrator.setArchived('session-1', true)
  assert.equal(store.load()[0].archived, true)
  assert.equal(f.text(), '', 'an archived session cannot leave an unreachable unread count')
  orchestrator.setArchived('session-1', false)
  f.badge.handleEvent(completed, orchestrator.getSessionById('session-1'))
  assert.equal(f.text(), '', 'restoring an archived session cannot unread its previous completion')
})

test('side events share the session count and keep separate event identities', () => {
  const f = badgeFixture()
  const event = attentionEvent('turn_completed', 'success')
  f.badge.handleEvent(event, session())
  f.badge.handleEvent(event, session(), 'side')
  assert.equal(f.text(), '1')
  f.focus(true)
  f.badge.setVisibleSession('session-1')
  f.badge.setVisibleSession(null)
  f.badge.handleEvent(event, session())
  f.badge.handleEvent(event, session(), 'side')
  assert.equal(f.text(), '', 'replayed main and side events remain read')
  f.badge.handleEvent({ ...event, seq: 2 }, session(), 'side')
  assert.equal(f.text(), '1', 'a new side reply marks its owning session unread')
})

test('async question snapshots stay read until a different question arrives', () => {
  const f = badgeFixture()
  const event = attentionEvent('agent_message', 'running', { payload: {
    id: 'async-q1', delivery: 'async', questions: [{ id: 'q1', question: '继续吗？' }]
  } })
  f.badge.handleEvent(event, session())
  assert.equal(f.text(), '1')
  f.focus(true)
  f.badge.setVisibleSession('session-1')
  f.badge.handleEvent(attentionEvent('turn_completed', 'success'), session())
  f.badge.setVisibleSession(null)
  f.badge.handleEvent({ ...event, seq: 3, state: 'success' }, session())
  assert.equal(f.text(), '', 'a streamed update of the read question is not a new question')
  f.badge.handleEvent({ ...event, seq: 4, payload: { ...event.payload, id: 'async-q2' } }, session())
  assert.equal(f.text(), '1', 'a new async question becomes unread')
})

test('terminal status changes cover failures without events and interrupted sessions', () => {
  for (const status of ['idle', 'completed', 'cancelled', 'interrupted', 'error'] as const) {
    const f = badgeFixture()
    const owner = session()
    f.badge.handleStatus(owner, 'running')
    f.badge.handleStatus(owner, status)
    assert.equal(f.text(), '1', `running -> ${status} requires attention`)
    f.focus(true)
    f.badge.setVisibleSession(owner.id)
    f.badge.setVisibleSession(null)
    f.badge.handleStatus(owner, status)
    assert.equal(f.text(), '', 'a repeated terminal status cannot unread a read session')
  }
  const f = badgeFixture()
  f.badge.handleStatus(session(), 'idle')
  assert.equal(f.text(), '', 'loading an idle session is not a new completion')
  f.badge.handleStatus(session(), 'error')
  assert.equal(f.text(), '1', 'an error status alone is sufficient')
})

test('team member attention belongs to the Leader row the sidebar can show', () => {
  const f = badgeFixture()
  const owner = session('leader')
  const member = session('member')
  f.badge.handleStatus(member, 'running', owner)
  f.badge.handleStatus(member, 'error', owner)
  assert.equal(f.text(), '1', 'a member failure counts once for its team row')
  f.badge.handleStatus(member, 'error', owner)
  assert.equal(f.text(), '1', 'a repeated member error cannot add another unread row')
  f.focus(true)
  f.badge.setVisibleSession('leader')
  assert.equal(f.text(), '', 'reading the Leader row clears member attention')

  f.focus(false)
  f.badge.handleStatus(member, 'running', owner)
  f.badge.handleStatus(member, 'idle', owner)
  assert.equal(f.text(), '1', 'a later member completion becomes new attention again')
  f.badge.handleEvent(attentionEvent('turn_completed', 'success', { sessionId: 'member', seq: 3 }), owner)
  assert.equal(f.text(), '1', 'events on the same team row stay deduplicated')
  f.badge.removeSession('leader')
  assert.equal(f.text(), '', 'archiving the team clears the row')
})

test('non-attention events and unavailable/tool sessions do not inflate the Dock badge', () => {
  const f = badgeFixture()
  for (const event of [
    attentionEvent('agent_message', 'running'), attentionEvent('reasoning', 'success'),
    attentionEvent('approval_request', 'success'), attentionEvent('approval_request', 'cancelled'),
    attentionEvent('turn_started', 'running'), attentionEvent('turn_completed', 'running'),
    attentionEvent('error', 'running'), attentionEvent('system_notice', undefined),
    attentionEvent('agent_message', 'success', { payload: { id: 'answered', delivery: 'async', questions: [{}], submittedAnswer: {} } })
  ]) f.badge.handleEvent(event, session())
  assert.equal(f.text(), '')
  const event = attentionEvent('turn_completed', 'success')
  f.badge.handleEvent(event, undefined)
  f.badge.handleEvent({ ...event, seq: 2 }, session('session-1', { archived: true }))
  f.badge.handleEvent({ ...event, seq: 3 }, session('session-1', { handoffId: 'mcp-task' }))
  assert.equal(f.text(), '')
  f.badge.handleEvent({ ...event, seq: 4 }, session('session-1', { handoffId: 'mcp-task', handoffUserContinued: true }))
  assert.equal(f.text(), '1', 'explicitly enabled tool sessions behave as ordinary sessions')
  f.badge.removeSession('missing')
  assert.equal(f.text(), '1')
  f.badge.removeSession('session-1')
  assert.equal(f.text(), '', 'deleting or archiving a session removes stale attention')
})

test('renderer reports the visible session and clears it when the session page is hidden', async () => {
  let sidebarUnread = true
  const f = badgeFixture(snapshot => { sidebarUnread = !!snapshot.unreadBySession['session-1'] })
  f.focus(true)
  f.badge.handleEvent(attentionEvent('approval_request', 'pending'), session())
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previousDispatcher = dispatcher.current
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const effects: Array<() => void | (() => void)> = []
  const calls: Array<string | null> = []
  const browserWindow = new EventTarget()
  const browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused })
  let focused = true
  let cleanup: (() => void) | undefined
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(browserWindow, { uniagent: {
      setBadgeVisibleSession: async (id: string | null) => { calls.push(id); f.badge.setVisibleSession(id) }
    } }) })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument })
    dispatcher.current = { useEffect(effect: () => void | (() => void)) { effects.push(effect) }, useRef: (value: unknown) => ({ current: value }) }
    useSessionAttention('session-1')
    assert.equal(f.text(), '1', 'rendering alone does not read before the effect commits')
    cleanup = effects.pop()!() || undefined
    await Promise.resolve()
    assert.equal(f.text(), '', 'showing the session reads it through the preload bridge')
    assert.equal(sidebarUnread, false, 'showing the session clears the shared sidebar snapshot too')

    focused = false
    f.focus(false)
    f.badge.handleNavigation(true, false)
    f.badge.handleEvent(attentionEvent('turn_completed', 'success'), session())
    sidebarUnread = true
    browserWindow.dispatchEvent(new Event('focus'))
    assert.equal(f.text(), '1', 'a focus notification cannot read while the document is still unfocused')
    assert.equal(sidebarUnread, true)
    focused = true
    f.focus(true)
    browserWindow.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    assert.equal(f.text(), '', 'returning to the same session resynchronizes its Dock read state')
    assert.equal(sidebarUnread, false, 'focus reads the same session in the sidebar')

    browserDocument.visibilityState = 'hidden'
    f.focus(false)
    f.badge.handleEvent(attentionEvent('turn_completed', 'success', { seq: 2 }), session())
    sidebarUnread = true
    browserWindow.dispatchEvent(new Event('focus'))
    assert.equal(f.text(), '1', 'a hidden document cannot read a session')
    assert.equal(sidebarUnread, true)
    browserDocument.visibilityState = 'visible'
    f.focus(true)
    browserDocument.dispatchEvent(new Event('visibilitychange'))
    assert.equal(f.text(), '', 'restoring visibility reads the visible session')
    assert.equal(sidebarUnread, false)

    cleanup?.()
    useSessionAttention(null)
    cleanup = effects.pop()!() || undefined
    await Promise.resolve()
    f.badge.handleEvent(attentionEvent('turn_completed', 'success', { seq: 3 }), session())
    assert.equal(f.text(), '1', 'hiding the session prevents future events from being read')
    assert.deepEqual(calls, ['session-1', 'session-1', 'session-1', null])
    cleanup?.()
    cleanup = undefined
    browserWindow.dispatchEvent(new Event('focus'))
    browserDocument.dispatchEvent(new Event('visibilitychange'))
    assert.deepEqual(calls, ['session-1', 'session-1', 'session-1', null], 'unmount removes the read listeners')
  } finally {
    cleanup?.()
    dispatcher.current = previousDispatcher
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('notification mode defaults to unfocused and only accepts known modes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-notifications-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new AppSettingsStore(directory)

  assert.equal(store.get().notificationMode, 'unfocused')
  assert.equal(store.set({ notificationMode: 'always' }).notificationMode, 'always')

  await writeFile(join(directory, 'app-settings.json'), JSON.stringify({
    schemaVersion: 1,
    autoUpdateAgentsOnLaunch: false,
    autoCheckUpdate: true,
    notificationMode: 'sometimes'
  }))
  assert.equal(store.get().notificationMode, 'unfocused')
})

test('notification gate and event copy cover completion, failure, questions, and approvals', async () => {
  assert.equal(shouldShowAppNotification('off', false), false)
  assert.equal(shouldShowAppNotification('unfocused', true), false)
  assert.equal(shouldShowAppNotification('unfocused', false), true)
  assert.equal(shouldShowAppNotification('always', true), true)

  const event = (type: string, state: string, payload: Record<string, unknown> = {}) => ({
    sessionId: 'session-1', seq: 1, ts: 1, type, state, payload
  })
  assert.equal(appNotificationBody(event('turn_completed', 'success') as any), '任务已完成')
  assert.equal(appNotificationBody(event('turn_completed', 'failed') as any), '任务失败，点击查看详情')
  assert.equal(appNotificationBody(event('error', 'failed') as any), '任务失败，点击查看详情')
  assert.equal(appNotificationBody(event('turn_completed', 'cancelled') as any), null)
  assert.equal(appNotificationBody(event('approval_request', 'pending', { kind: 'question' }) as any), 'Agent 正在等待你的回答')
  assert.equal(appNotificationBody(event('approval_request', 'pending', { kind: 'elicitation' }) as any), 'Agent 正在等待你的回答')
  assert.equal(appNotificationBody(event('approval_request', 'pending', { kind: 'command' }) as any), 'Agent 正在等待你的批准')
  assert.equal(appNotificationBody(event('approval_request', 'success', { kind: 'command' }) as any), null)

  const failed = new Set<string>()
  assert.equal(appNotificationBody(event('error', 'failed') as any, failed), '任务失败，点击查看详情')
  assert.equal(appNotificationBody(event('turn_completed', 'success') as any, failed), null)
  assert.equal(appNotificationBody(event('turn_started', 'running') as any, failed), null)
  assert.equal(appNotificationBody(event('turn_completed', 'success') as any, failed), '任务已完成')
})
