import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionAttentionBadge } from '../src/main/appNotifications'
import { SessionAttentionStore } from '../src/main/sessionAttentionStore'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { Session, UAEvent } from '../src/shared/types'

const owner: Session = { id: 'task', title: 'task', status: 'idle', createdAt: 1, config: { agentId: 'codex', workdir: '/fixture' } }
const question = (id: string, seq = 1): UAEvent => ({ sessionId: owner.id, seq, ts: seq, type: 'approval_request', state: 'pending', payload: { kind: 'question', requestId: id } })
const answer = (event: UAEvent): UAEvent => ({ ...event, state: 'success', payload: { ...event.payload, submittedAnswer: { answers: { private: 'answer-content-must-not-be-persisted' } } } })
const result: UAEvent = { sessionId: owner.id, seq: 10, ts: 10, type: 'turn_completed', state: 'success', payload: {} }
const create = () => new SessionAttentionBadge(() => {}, () => false)

test('the real response entry settles async questions for App, Feishu, Weixin and MCP only after acceptance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-attention-responses-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.saveOrThrow([owner])
  const orchestrator = new Orchestrator(() => undefined, store, join(directory, 'artifacts'))
  await orchestrator.loadPersisted()
  t.after(() => orchestrator.closeSessionLogs())
  const runtime = orchestrator as any, badge = create()
  orchestrator.on('event', event => badge.handleEvent(event, orchestrator.getSessionById(event.sessionId)))
  let reject = true
  runtime.forceSend = async (_id: string, text: string, _a: unknown, _s: unknown, bubble: { source?: string }) => {
    if (reject) throw new Error('fixture dispatch failed')
    runtime.record(owner.id, { type: 'user_message', payload: { text, source: bubble.source } })
  }
  for (const source of ['app', 'feishu', 'weixin', 'mcp'] as const) {
    runtime.record(owner.id, { type: 'agent_message', state: 'success', payload: { id: source, delivery: 'async', questions: [{ id: 'choice', question: '是否继续？', options: [{ label: '继续' }] }] } })
    const response = { answers: { choice: { answers: ['继续'] } } }
    reject = true
    await assert.rejects(Promise.resolve(orchestrator.respondToRequest(owner.id, 'async-question:' + source, response, { source })), /fixture dispatch failed/)
    assert.equal(badge.snapshot().unreadBySession.task, 'main', `${source}: failure keeps the question unread`)
    reject = false
    const accepted = await orchestrator.respondToRequest(owner.id, 'async-question:' + source, response, { source })
    assert.equal(accepted?.handled, true)
    assert.deepEqual(badge.snapshot().unreadBySession, {}, `${source}: the confirmed response clears the original question`)
    assert.deepEqual(orchestrator.pendingSessionRequests(owner.id), [])
  }
})

test('disk round trip preserves separate questions/results without storing answer content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-attention-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'attention.json'), store = new SessionAttentionStore(file), badge = create()
  badge.restore(await store.load(), [owner])
  badge.handleEvent(question('answered'), owner)
  badge.handleEvent(answer(question('answered')), owner)
  badge.handleEvent(question('pending'), owner)
  badge.handleEvent(result, owner, 'side')
  await store.save(badge.serialize())
  const restored = create()
  restored.restore(await store.load(), [owner])
  assert.deepEqual(restored.snapshot().unreadBySession, { task: 'main' })
  restored.handleEvent(answer(question('pending')), owner)
  assert.deepEqual(restored.snapshot().unreadBySession, { task: 'side' }, 'answering a restored question preserves the side result')
  restored.handleEvent(question('answered'), owner)
  assert.deepEqual(restored.snapshot().unreadBySession, { task: 'side' }, 'an answered question stays settled after restart')
  assert.ok(!(await readFile(file, 'utf8')).includes('answer-content-must-not-be-persisted'))
  const latest = restored.serialize()
  await Promise.all([store.save(badge.serialize()), store.save(latest)])
  await store.flush()
  assert.deepEqual(await store.load(), latest, 'concurrent saves finish in revision order')
  await writeFile(file, '{')
  await assert.rejects(store.load(), SyntaxError)
  await writeFile(file, JSON.stringify({ version: 1, legacyImported: true, channels: [{ source: 'invalid' }] }))
  await assert.rejects(store.load(), /未读状态记录无效/)
})

test('restoration merges live answers and new questions with other saved pending questions', () => {
  const saved = create()
  saved.handleEvent(question('old-a'), owner)
  saved.handleEvent(question('old-b', 2), owner)
  saved.handleEvent(result, owner, 'side')
  const live = create()
  live.handleEvent(answer(question('old-a')), owner)
  live.handleEvent(question('new', 3), owner)
  live.restore(saved.serialize(), [owner])
  live.handleEvent(answer(question('new', 3)), owner)
  assert.equal(live.snapshot().unreadBySession.task, 'main', 'the other saved pending question is still unread')
  live.handleEvent(answer(question('old-b', 2)), owner)
  assert.equal(live.snapshot().unreadBySession.task, 'side')
  live.handleEvent(question('old-a'), owner)
  assert.equal(live.snapshot().unreadBySession.task, 'side', 'a live accepted answer wins over its saved pending copy')
})

test('accepted input during asynchronous restoration clears only the previous result', () => {
  const saved = create()
  saved.handleEvent(result, owner)
  saved.handleEvent(question('still-pending'), owner)
  const live = create()
  live.handleEvent({ ...result, type: 'user_message', payload: { text: '继续', source: 'feishu' } }, owner)
  live.restore(saved.serialize(), [owner])
  live.handleEvent(answer(question('still-pending')), owner)
  assert.deepEqual(live.snapshot().unreadBySession, {}, 'the old result cannot come back after accepted input')
})

test('startup reconciliation removes answered/expired requests and keeps real pending requests', () => {
  const badge = create(), first = question('one'), second = question('two', 2)
  badge.handleEvent(first, owner); badge.handleEvent(second, owner)
  badge.reconcileRequests(owner.id, [answer(first), second], 'main')
  assert.equal(badge.snapshot().unreadBySession.task, 'main')
  badge.reconcileRequests(owner.id, [answer(first), { ...second, state: 'cancelled', payload: { ...second.payload, interactionExpired: true } }], 'main')
  assert.deepEqual(badge.snapshot().unreadBySession, {})
})

test('legacy markers are checked against actual answered history and imported only once', () => {
  const resolved = answer(question('old')), pending = question('new', 2)
  for (const savedPending of [{}, { task: ['request:old'] }]) {
    const badge = create()
    badge.importLegacy({ unread: { task: 'main' }, pending: savedPending }, [owner], () => [resolved])
    assert.deepEqual(badge.snapshot().unreadBySession, {}, 'an old answered question is not a result unread')
    badge.importLegacy({ unread: { task: 'main' }, pending: {} }, [owner], () => [pending])
    assert.deepEqual(badge.snapshot().unreadBySession, {}, 'another renderer cannot reimport stale local storage')
  }
  const badge = create()
  badge.importLegacy({ unread: { task: 'main' }, pending: { task: ['request:new'] } }, [owner], () => [resolved, pending])
  assert.equal(badge.snapshot().unreadBySession.task, 'main')
  badge.handleEvent(answer(pending), owner)
  assert.deepEqual(badge.snapshot().unreadBySession, {})
})

test('restoration drops removed/archived/tool sessions and maps team members to their visible row', () => {
  const badge = create()
  badge.handleEvent(result, owner)
  for (const sessions of [[], [{ ...owner, archived: true }], [{ ...owner, config: { ...owner.config, managedPurpose: 'router' } }]]) {
    const restored = create(); restored.restore(badge.serialize(), sessions as Session[])
    assert.deepEqual(restored.snapshot().unreadBySession, {})
  }
  const leader = { ...owner, id: 'leader' }, restored = create()
  restored.restore(badge.serialize(), [owner, leader], () => leader.id)
  assert.deepEqual(restored.snapshot().unreadBySession, { leader: 'main' })
  restored.removeSession(leader.id)
  assert.deepEqual(restored.snapshot().unreadBySession, {})
})

test('remapping and removing a team member preserve other member reminders in the same visible row', () => {
  const badge = create(), first = { ...owner, id: 'first' }, second = { ...owner, id: 'second' }
  for (const member of [first, second]) badge.handleEvent({ ...question(member.id), sessionId: member.id }, member)
  badge.remapOwners(() => 'leader')
  assert.deepEqual(badge.snapshot().unreadBySession, { leader: 'main' })
  badge.removeSession(first.id)
  assert.deepEqual(badge.snapshot().unreadBySession, { leader: 'main' }, 'removing one member cannot read another member question')
  badge.removeSession(second.id)
  assert.deepEqual(badge.snapshot().unreadBySession, {})
})

test('archiving reads every branch and old events stay read after restoration and unarchiving', () => {
  const badge = create(), pending = question('before-archive')
  badge.handleEvent(pending, owner)
  badge.handleEvent(result, owner, 'side')
  const archived = { ...owner, archived: true }
  badge.handleSession(archived)
  assert.deepEqual(badge.snapshot().unreadBySession, {}, 'archiving reads both main and side reminders')
  const restored = create()
  restored.restore(badge.serialize(), [archived])
  assert.deepEqual(restored.snapshot().unreadBySession, {}, 'archived reminders stay read after restarting')
  restored.handleSession(owner)
  restored.handleEvent(pending, owner)
  restored.handleEvent(result, owner, 'side')
  assert.deepEqual(restored.snapshot().unreadBySession, {}, 'unarchiving and replaying old events cannot create unread')
  restored.handleEvent(question('after-archive', 20), owner)
  assert.deepEqual(restored.snapshot().unreadBySession, { task: 'main' }, 'a genuinely new question remains unread')
  restored.removeSession(owner.id)
  assert.deepEqual(restored.serialize().channels, [], 'deleting removes the retained read identities')
})

test('unarchiving an error task does not turn the same old error into a new unread result', () => {
  const badge = create(), failed = { ...owner, status: 'error' as const }
  badge.handleStatus(owner, 'running')
  badge.handleSession(failed)
  assert.deepEqual(badge.snapshot().unreadBySession, { task: 'main' })
  badge.handleSession({ ...failed, archived: true })
  assert.deepEqual(badge.snapshot().unreadBySession, {})
  badge.handleSession(failed)
  assert.deepEqual(badge.snapshot().unreadBySession, {}, 'restoring a task is not another failed turn')
})

test('events arriving while archived are retained as read when the task is restored', () => {
  const badge = create(), archived = { ...owner, archived: true }, pending = question('during-archive')
  badge.handleEvent(pending, archived)
  badge.handleEvent(result, archived, 'side')
  assert.deepEqual(badge.snapshot().unreadBySession, {})
  const restored = create()
  restored.restore(badge.serialize(), [owner])
  restored.handleEvent(pending, owner)
  restored.handleEvent(result, owner, 'side')
  assert.deepEqual(restored.snapshot().unreadBySession, {}, 'late delivery during archiving is already read')
})
