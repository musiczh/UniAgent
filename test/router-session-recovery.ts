import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterController } from '../src/main/router/controller'
import { RouterDatabase } from '../src/main/router/database'
import { routerMcpServers } from '../src/main/router/mcp'
import { DeepSeekHostError } from '../src/main/deepseekHostClient'
import { DeepSeekHostRunner } from '../src/main/deepseekHostRunner'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import { routerTargetVersion } from '../src/main/router/target'
import type { RouterStore } from '../src/main/router/store'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'
import { readRouterTarget } from './fixtures/router-reading'

const wait = async (check: () => boolean | Promise<boolean>) => {
  // The confirmed recovery policy waits two seconds before its first retry.
  for (let i = 0; i < 650; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('Router session recovery timed out')
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ua-router-session-'))
  const db = new RouterDatabase(join(root, 'router.sqlite'))
  const store = new Proxy({} as RouterStore, { get: (_, key: string) => async (...args: unknown[]) => { if (key === 'reviewBegin') await controls.beforeReview(); return (db[key as keyof RouterDatabase] as Function).apply(db, args) } })
  const config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }
  const target: Session = { id: 'target', title: '原任务', config: { agentId: 'codex', projectId: 'space', workdir: root }, status: 'running', createdAt: 1 }
  const sessions = new Map([[target.id, target]])
  const sent: Array<{ sessionId: string; attachments: unknown; bubble: any }> = [], disposed: string[] = [], errors: unknown[] = []
  const controls = { failCreate: false, beforeUpdate: async (_id: string) => {}, beforeReview: async () => {}, deliveries: 0 }
  const agent = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', installed: true, models: [{ id: config.model, label: 'Flash', efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef
  const orchestrator = {
    getSessionById: (id: string) => sessions.get(id), managedSessions: () => [...sessions.values()], getEvents: async () => [],
    createRouterDraft: (value: Session['config'], id: string) => {
      if (controls.failCreate && !sessions.has(id)) throw new Error('fixture-create-failed')
      if (!sessions.has(id)) sessions.set(id, { id, title: 'RouterAgent', config: value, status: 'draft', createdAt: Date.now() })
      return sessions.get(id)!
    },
    updateSessionConfig: async (id: string, patch: Partial<Session['config']>) => { await controls.beforeUpdate(id); Object.assign(sessions.get(id)!.config, patch); return sessions.get(id)! },
    sendMessage: async (sessionId: string, _prompt: string, attachments: unknown, _context: unknown, _plan: boolean, bubble: unknown) => { sent.push({ sessionId, attachments, bubble }); sessions.get(sessionId)!.status = 'running' },
    acceptRoutedInput: async () => { controls.deliveries++; return { status: 'queued' as const } },
    appendSystemNotice: () => {}, interrupt: (id: string) => { sessions.get(id)!.status = 'idle' }, disposeSession: (id: string) => { disposed.push(id) }
  }
  const agents = [agent, { ...agent, id: 'other-deepseek', name: 'Codex', adapter: 'codex' as const, capabilities: { ...agent.capabilities, streaming: true } }]
  const dependencies = { agents: () => agents, config: () => config, saveConfig: (next: typeof config) => { Object.assign(config, next) }, orchestrator: orchestrator as any,
    objects: async () => [{ id: 'space', kind: 'space' as const, title: '空间', summary: '', projectId: 'space', version: '1' },
      { id: target.id, kind: 'task' as const, title: target.title, summary: '继续原任务', projectId: 'space', version: routerTargetVersion(target), lastBusinessUpdatedAt: Date.now(), execution: target.config,
        sources: [{ ref: 'input:target', title: '原目标', text: '继续原任务，保留原有方案与上下文。', at: 1 }] }],
    newTask: async () => { throw new Error('must not create another business task') }, recoverTask: async () => undefined,
    changed: () => {}, error: (error: unknown) => { errors.push(error) } }
  const controller = new RouterController(store, dependencies, root)
  await controller.recover()
  const initial = await controller.open()
  const credentials = (id: string) => Object.fromEntries(routerMcpServers(id)![0].env.map(row => [row.name, row.value]))
  const callWith = async (env: Record<string, string>, name: string, args: unknown) => {
    const response = await fetch(env.UNIAGENT_ROUTER_ENDPOINT, { method: 'POST', headers: { authorization: 'Bearer ' + env.UNIAGENT_ROUTER_TOKEN }, body: JSON.stringify({ name, arguments: args }) })
    return { status: response.status, ...(await response.json()) }
  }
  const call = async (name: string, args: unknown) => callWith(credentials((await controller.snapshot()).sessionId!), name, args)
  let completionSeq = 100
  const end = async (id: string) => {
    // Configuration-switch fixtures finish a successful allocation. A native
    // turn without a receipt is now retried and has separate outcome coverage.
    const request = db.pending().find(row => row.state === 'routing' && row.routerSessionId === id)
    if (request) db.update(request.requestId, request.version, { state: 'bound', delivery: 'accepted', targetId: target.id })
    sessions.get(id)!.status = 'idle'; await controller.event({ sessionId: id, seq: completionSeq++, ts: Date.now(), type: 'turn_completed', state: 'success', payload: {} })
  }
  return { root, db, store, controller, dependencies, config, agents, sessions, initial: initial!, controls, sent, disposed, errors, credentials, callWith, call, end }
}

test('switching Agent creates fresh Sessions and persists ordered conversation segments without changing old receipts', async () => {
  const f = await fixture()
  try {
    f.initial.nativeSessionId = 'original-native-session'
    const input = await f.store.register({ requestId: randomUUID(), prompt: '已分配的原任务' }, f.config)
    await f.store.update(input.requestId, input.version, { state: 'bound', targetId: 'target', routerSessionId: f.initial.id, delivery: 'accepted' })
    const before = f.credentials(f.initial.id)
    const changed = await f.controller.saveConfig({ ...f.config, agentId: 'other-deepseek' }, f.config.version)
    const second = f.sessions.get(changed.sessionId!)!
    assert.notEqual(second.id, f.initial.id)
    assert.equal(second.config.agentId, 'other-deepseek')
    assert.equal(second.nativeSessionId, undefined)
    assert.equal(changed.conversationSessions?.length, 2)
    assert.deepEqual(changed.conversationSessions?.map(row => [row.sessionId, row.agentId]), [[f.initial.id, 'deepseek'], [second.id, 'other-deepseek']])
    assert.ok(changed.conversationSessions?.[1].switchedAt)
    assert.equal((await f.callWith(before, 'router_query', { requestId: input.requestId, mode: 'catalog', kind: 'space' })).status, 403)
    assert.equal(f.db.request(input.requestId)!.targetId, 'target')
    const back = await f.controller.saveConfig({ ...f.config, agentId: 'deepseek' }, f.config.version)
    assert.notEqual(back.sessionId, f.initial.id, 'switching back must not resume the earlier native Session')
    assert.equal(back.conversationSessions?.length, 3)
    assert.deepEqual(f.db.conversationSessions(), back.conversationSessions)
    const reopened = new RouterDatabase(join(f.root, 'router.sqlite'))
    try { assert.deepEqual(reopened.conversationSessions(), back.conversationSessions) } finally { reopened.close() }
    const unchanged = await f.controller.saveConfig({ ...f.config, effort: undefined }, f.config.version)
    assert.equal(unchanged.sessionId, back.sessionId, 'changing effort does not add an Agent switch')
    assert.equal(unchanged.conversationSessions?.length, 3)
    await f.controller.newSession(back.sessionId!)
    assert.deepEqual(f.db.conversationSessions(), [], 'manual creation keeps its existing separate-conversation behavior')
  } finally { await f.controller.close() }
})

test('failed idle Agent switches preserve the previous configuration, Session and conversation', async () => {
  const f = await fixture()
  try {
    const previous = { ...f.config }
    f.controls.failCreate = true
    await assert.rejects(f.controller.saveConfig({ ...f.config, agentId: 'other-deepseek' }, f.config.version), /fixture-create-failed/)
    assert.deepEqual(f.config, previous)
    assert.equal(f.db.sessionId(), f.initial.id)
    assert.deepEqual(f.db.conversationSessions(), [])
    assert.ok(routerMcpServers(f.initial.id))
  } finally { await f.controller.close() }
})

test('saving during a routing turn returns immediately and applies the latest saved Agent to the next queued input', async () => {
  const f = await fixture()
  try {
    f.agents[1].models = [{ id: 'vision', label: 'Vision', efforts: ['max', 'high'], imageInput: true }]
    const current = await f.controller.submit({ requestId: randomUUID(), prompt: '当前分配继续使用原配置' })
    await wait(() => f.sent.length === 1)
    const receipt = structuredClone(f.db.request(current.requestId)!), native = structuredClone(f.initial.config)
    const credentials = f.credentials(f.initial.id)
    const attachments = [{ kind: 'image' as const, name: 'next.png', path: join(f.root, 'next.png') }]
    const queued = await f.controller.submit({ requestId: randomUUID(), prompt: '下一项使用新配置', attachments })
    const saved = await f.controller.saveConfig({ ...f.config, agentId: 'other-deepseek', model: 'vision' }, f.config.version)
    assert.equal(saved.config.agentId, 'other-deepseek')
    assert.equal(saved.sessionId, f.initial.id)
    assert.deepEqual(f.disposed, [])
    assert.deepEqual(f.db.request(current.requestId), receipt, 'saving must not alter the active request or its config')
    assert.deepEqual(f.initial.config, native)
    assert.equal((await f.controller.open())!.id, f.initial.id, 'opening the Router during a turn must not apply the pending switch')
    assert.equal((await f.callWith(credentials, 'router_query', { requestId: current.requestId, mode: 'catalog', kind: 'space' })).ok, true)
    await assert.rejects(f.controller.saveConfig(saved.config, saved.config.version - 1), /已变化/)
    await f.controller.saveConfig({ ...f.config, effort: 'high' }, f.config.version)
    assert.equal(f.sent.length, 1)
    await f.end(f.initial.id)
    await wait(() => f.sent.length === 2)
    const next = f.sessions.get(f.sent[1].sessionId)!
    assert.notEqual(next.id, f.initial.id)
    assert.equal(next.config.agentId, 'other-deepseek')
    assert.equal(next.config.model, 'vision'); assert.equal(next.config.effort, 'high')
    assert.deepEqual(f.sent[1].attachments, attachments)
    assert.deepEqual(f.db.request(queued.requestId)!.config, f.config)
    assert.deepEqual(f.db.request(current.requestId)!.config, receipt.config)
    assert.equal(f.db.conversationSessions().length, 2, 'multiple saves before the turn ends create only the actual Agent boundary')
    assert.equal((await f.callWith(credentials, 'router_query', { requestId: current.requestId, mode: 'catalog', kind: 'space' })).status, 403)
  } finally { await f.controller.close() }
})

test('queued inputs use new model and effort even when the Agent does not change', async () => {
  const f = await fixture()
  try {
    f.agents[0].models.push({ id: 'next-model', label: 'Next', efforts: ['high'] })
    await f.controller.submit({ requestId: randomUUID(), prompt: '当前分配' })
    await wait(() => f.sent.length === 1)
    const queued = await f.controller.submit({ requestId: randomUUID(), prompt: '排队时切换模型' })
    const native = structuredClone(f.initial.config)
    await f.controller.saveConfig({ ...f.config, model: 'next-model', effort: 'high' }, f.config.version)
    assert.deepEqual(f.initial.config, native)
    await f.end(f.initial.id)
    await wait(() => f.sent.length === 2)
    assert.equal(f.sent[1].sessionId, f.initial.id)
    assert.equal(f.initial.config.model, 'next-model'); assert.equal(f.initial.config.effort, 'high')
    assert.deepEqual(f.db.request(queued.requestId)!.config, f.config)
    assert.deepEqual(f.db.conversationSessions(), [])
  } finally { await f.controller.close() }
})

test('saving during asynchronous routing preparation does not wait and restarts preparation with the saved configuration', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    let entered = false
    f.controls.beforeReview = async () => { entered = true; await new Promise<void>(resolve => { release = resolve }) }
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '准备时保存配置' })
    await wait(() => entered)
    const saved = await f.controller.saveConfig({ ...f.config, agentId: 'other-deepseek' }, f.config.version)
    assert.equal(saved.config.agentId, 'other-deepseek')
    assert.equal(f.sent.length, 0)
    f.controls.beforeReview = async () => {}; release()
    await wait(() => f.sent.length === 1)
    assert.equal(f.sessions.get(f.sent[0].sessionId)!.config.agentId, 'other-deepseek')
    assert.deepEqual(f.db.request(input.requestId)!.config, f.config)
    const attempts = (await f.controller.reviewDetail(input.requestId)).attempts
    assert.ok(attempts[0].endedAt, 'superseded preparation must not leave an unfinished diagnostic attempt')
  } finally { release?.(); await f.controller.close() }
})

test('disabling during a turn preserves it and keeps queued input paused until re-enabled', async () => {
  const f = await fixture()
  try {
    await f.controller.submit({ requestId: randomUUID(), prompt: '继续当前分配' })
    await wait(() => f.sent.length === 1)
    const queued = await f.controller.submit({ requestId: randomUUID(), prompt: '等待重新启用' })
    await f.controller.saveConfig({ ...f.config, enabled: false }, f.config.version)
    assert.equal(f.initial.status, 'running'); assert.deepEqual(f.disposed, [])
    await f.end(f.initial.id)
    assert.equal(f.sent.length, 1); assert.equal(f.db.request(queued.requestId)!.state, 'queued')
    await f.controller.saveConfig({ ...f.config, enabled: true }, f.config.version)
    await wait(() => f.sent.length === 2)
    assert.deepEqual(f.db.request(queued.requestId)!.config, f.config)
  } finally { await f.controller.close() }
})

test('concurrent saves create one boundary and queued inputs use the new Agent model without changing attachments', async () => {
  const f = await fixture()
  try {
    const model = 'codex-vision'
    f.agents[1].models = [{ id: model, label: 'Vision', efforts: ['max'] }]
    const attachments = [{ kind: 'image' as const, name: 'queued.png', path: join(f.root, 'queued.png') }]
    const input = await f.store.register({ requestId: randomUUID(), prompt: '切换后继续分配', attachments }, f.config)
    const first = f.controller.saveConfig({ ...f.config, agentId: 'other-deepseek', model }, f.config.version)
    await assert.rejects(f.controller.saveConfig({ ...f.config, agentId: 'other-deepseek', model }, f.config.version), /正在保存/)
    const snapshot = await first
    await wait(() => f.sent.length === 1)
    assert.equal(snapshot.conversationSessions?.length, 2)
    assert.equal(f.sent[0].sessionId, snapshot.sessionId)
    assert.deepEqual(f.sent[0].attachments, attachments)
    assert.equal(f.db.request(input.requestId)!.config.agentId, 'other-deepseek')
    assert.equal(f.db.request(input.requestId)!.config.model, model)
  } finally { await f.controller.close() }
})

for (const state of ['routing', 'needs_input', 'bound', 'unknown'] as const) test(`Host failure releases the Router slot while preserving ${state} receipts`, async () => {
  const f = await fixture()
  const runner = new DeepSeekHostRunner(f.initial.id, { n: 0 }, f.dependencies.agents()[0], f.initial.config, undefined, undefined,
    async () => { throw new DeepSeekHostError('transport-failed') })
  const pending: Promise<void>[] = []
  runner.on('event', event => { pending.push(f.controller.event(event)) })
  runner.on('done', () => { f.initial.status = 'error' })
  try {
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '断连时保留原请求和回执' })
    await wait(() => f.sent.length === 1)
    if (state !== 'routing') {
      const request = f.db.request(input.requestId)!
      await f.store.update(request.requestId, request.version, state === 'needs_input'
        ? { state, question: '请选择执行配置' }
        : { state: 'bound', targetId: 'target', delivery: state === 'unknown' ? 'unknown' : 'accepted' })
    }
    const receipt = f.db.request(input.requestId)!
    await runner.startTurn('route')
    await Promise.all(pending)
    if (state === 'routing') {
      const failed = f.db.request(input.requestId)!
      assert.equal(failed.state, 'failed')
      await f.controller.cancel(failed.requestId, failed.version)
    } else assert.deepEqual(f.db.request(input.requestId), receipt, 'settling the Router must not overwrite business delivery or user decisions')
    const replacement = await f.controller.newSession(f.initial.id)
    assert.notEqual(replacement.id, f.initial.id)
    assert.equal(f.sent.length, 1, 'failed and uncertain inputs are not automatically replayed')
    assert.equal(f.controls.deliveries, 0)
    await f.controller.submit({ requestId: randomUUID(), prompt: '后续新任务' })
    await wait(() => f.sent.length === 2)
    assert.equal(f.sent[1].sessionId, replacement.id)
  } finally { await runner.disposeAndWait(); await Promise.all(pending); await f.controller.close() }
})

test('manual creation coalesces clicks, persists the new identity and revokes only the old Router tools', async () => {
  const f = await fixture()
  try {
    const old = f.initial, credentials = f.credentials(old.id)
    const [a, b] = await Promise.all([f.controller.newSession(old.id), f.controller.newSession(old.id)])
    assert.equal(a.id, b.id)
    assert.notEqual(a.id, old.id)
    assert.equal(f.db.sessionId(), a.id)
    assert.deepEqual(a.config, old.config)
    assert.equal(a.nativeSessionId, undefined, 'the new draft cannot adopt the old native Session')
    assert.equal(f.sessions.get(old.id), old, 'old conversation is retained')
    assert.deepEqual(f.disposed, [old.id])
    assert.equal(routerMcpServers(old.id), undefined)
    assert.equal((await f.callWith(credentials, 'router_query', { requestId: randomUUID(), mode: 'catalog' })).status, 403)
    assert.equal((await f.controller.snapshot()).sessionNotice?.kind, 'manual')
    await assert.rejects(f.controller.newSession(old.id), /会话已变化/)
    f.controls.failCreate = true
    await assert.rejects(f.controller.newSession(a.id), /fixture-create-failed/)
    assert.equal(f.db.sessionId(), a.id)
    assert.ok(routerMcpServers(a.id), 'failed creation retains the current working tool scope')
  } finally { await f.controller.close() }
})

test('a pre-submission disconnect changes Session once and preserves input, attachments, FIFO and delivery identity', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let first = true
  f.controls.beforeUpdate = async () => { if (first) { first = false; await gate; throw new DeepSeekHostError('connection-lost-reopen-session') } }
  try {
    const requestId = randomUUID(), attachments = [{ path: '/fixture/image.png', name: 'image.png', kind: 'image' as const }]
    await f.controller.submit({ requestId, prompt: '继续原任务', attachments, scope: { kind: 'space', projectId: 'space' } })
    await wait(() => f.db.request(requestId)?.state === 'routing')
    const second = await f.controller.submit({ requestId: randomUUID(), prompt: '下一条输入' })
    await assert.rejects(f.controller.newSession(f.initial.id), /分配|处理/)
    release()
    await wait(() => f.sent.length === 1)
    const id = f.db.sessionId(), current = f.db.request(requestId)!
    assert.notEqual(id, f.initial.id)
    assert.equal(f.sent[0].sessionId, id)
    assert.equal(f.sent[0].bubble.routedInputId, requestId)
    assert.deepEqual(f.sent[0].attachments, attachments)
    assert.equal(current.prompt, '继续原任务')
    assert.equal(current.routerSessionId, id)
    assert.equal(current.recovery?.attempts, 1)
    assert.equal((await f.controller.snapshot()).sessionNotice?.kind, 'recovery')
    await f.controller.event({ sessionId: f.initial.id, seq: 999, ts: 1, type: 'turn_completed', state: 'failed', payload: {} })
    assert.equal(f.db.request(requestId)!.state, 'routing', 'late completion cannot end the new attempt')
    const query = await readRouterTarget(f.call, requestId, { kind: 'space', projectId: 'space' }, 'target')
    const args = { requestId, version: query.value.version, action: 'reuse_task', taskId: 'target', reason: '原任务继续', ...query.assignment, reuseAssessment: query.assessment }
    assert.equal((await f.call('router_assign_task', args)).value.delivery, 'queued')
    assert.equal((await f.call('router_assign_task', args)).ok, true)
    assert.equal(f.controls.deliveries, 1)
    await f.end(id)
    await wait(() => f.sent.length === 2)
    assert.equal(f.sent[1].bubble.routedInputId, second.requestId)
    assert.equal(f.sent[1].sessionId, id)
  } finally { release(); await f.controller.close() }
})

test('structured before-prompt errors recover; unknown submission and unrelated requests cannot trigger rotation', async () => {
  const f = await fixture()
  try {
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '继续原任务' })
    await wait(() => f.sent.length === 1)
    const error: UAEvent = { sessionId: f.initial.id, seq: 8, ts: Date.now(), type: 'error', state: 'failed', payload: {
      code: 'connection-lost-reopen-session', nativeSubmission: 'unknown', routedInputId: input.requestId } }
    await f.controller.event(error)
    await f.controller.event({ ...error, payload: { ...error.payload, nativeSubmission: 'not-submitted', routedInputId: randomUUID() } })
    assert.equal(f.db.sessionId(), f.initial.id)
    f.sessions.get(f.initial.id)!.status = 'error'
    await f.controller.event({ ...error, payload: { ...error.payload, nativeSubmission: 'not-submitted' } })
    await wait(() => f.sent.length === 2)
    assert.notEqual(f.db.sessionId(), f.initial.id)
    assert.equal(f.sent[1].bubble.routedInputId, input.requestId)
  } finally { await f.controller.close() }
})

test('consecutive failures stop after one automatic creation and manual creation can continue the retained input', async () => {
  const f = await fixture()
  let failures = 2
  f.controls.beforeUpdate = async () => { if (failures-- > 0) throw new DeepSeekHostError('connection-lost-reopen-session') }
  try {
    const request = await f.controller.submit({ requestId: randomUUID(), prompt: '保留失败输入' })
    await wait(() => f.db.request(request.requestId)?.state === 'failed')
    const stopped = f.db.request(request.requestId)!, id = f.db.sessionId()
    assert.equal(stopped.recovery?.attempts, 1)
    assert.notEqual(id, f.initial.id)
    assert.equal(f.sessions.size, 3, 'one task plus the original and one replacement Router Session')
    assert.equal(f.sent.length, 0)
    const replacement = await f.controller.newSession(id)
    await wait(() => f.sent.length === 1)
    assert.equal(f.sent[0].sessionId, replacement.id)
    assert.equal(f.sent[0].bubble.routedInputId, request.requestId)
    assert.equal(f.db.request(request.requestId)!.recovery?.attempts, 1, 'manual creation never resets the automatic budget')
  } finally { await f.controller.close() }
})

test('cancellation during configuration prevents a late disconnect from retrying the cancelled input', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.controls.beforeUpdate = async () => { await gate; throw new DeepSeekHostError('connection-lost-reopen-session') }
  try {
    const request = await f.controller.submit({ requestId: randomUUID(), prompt: '配置中取消' })
    await wait(() => f.db.request(request.requestId)?.state === 'routing')
    await f.controller.interrupt()
    release()
    await wait(async () => !(await f.controller.snapshot()).switchingSession)
    assert.equal(f.db.request(request.requestId)!.state, 'cancelled')
    assert.equal(f.db.sessionId(), f.initial.id)
    assert.equal(f.sent.length, 0)
  } finally { release(); await f.controller.close() }
})

test('atomic replacement rejects stale versions and retains the automatic allowance across restart', async () => {
  const f = await fixture()
  const input = f.db.register({ requestId: randomUUID(), prompt: '重启后接续' }, f.dependencies.config())
  const request = f.db.update(input.requestId, input.version, { state: 'routing', routerSessionId: f.initial.id })
  const id = 's_' + randomUUID()
  f.dependencies.orchestrator.createRouterDraft(f.initial.config, id)
  assert.throws(() => f.db.replaceSession(f.initial.id, id, { requestId: request.requestId, version: request.version - 1 }), /revision_conflict/)
  assert.equal(f.db.sessionId(), f.initial.id)
  assert.equal(f.db.request(request.requestId)!.recovery, undefined)
  f.db.replaceSession(f.initial.id, id, { requestId: request.requestId, version: request.version })
  await f.controller.close()
  const db = new RouterDatabase(join(f.root, 'router.sqlite'))
  const store = new Proxy({} as RouterStore, { get: (_, key: string) => async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) })
  const restored = new RouterController(store, f.dependencies, f.root)
  try {
    await restored.recover()
    await wait(() => f.sent.length === 1)
    assert.equal(f.sent[0].sessionId, id)
    assert.equal(f.sent[0].bubble.routedInputId, request.requestId)
    assert.equal(db.request(request.requestId)!.recovery?.attempts, 1)
    assert.equal(db.sessionNotice()!.kind, 'recovery')
    f.sessions.get(id)!.status = 'error'
    await restored.event({ sessionId: id, seq: 10, ts: 1, type: 'error', payload: { code: 'connection-lost-reopen-session', nativeSubmission: 'not-submitted', routedInputId: request.requestId } })
    assert.equal(db.request(request.requestId)!.state, 'failed')
    assert.equal(db.sessionId(), id, 'restart must not grant another automatic replacement')
  } finally { await restored.close() }
})

test('opening a broken Session with changed model settings still allows the queued request to recover', async () => {
  const f = await fixture()
  f.initial.config.model = 'previous-model'
  f.controls.beforeUpdate = async id => { if (id === f.initial.id) throw new DeepSeekHostError('connection-lost-reopen-session') }
  try {
    assert.equal((await f.controller.open())!.id, f.initial.id, 'the broken transport cannot hide history or the manual action')
    await f.controller.submit({ requestId: randomUUID(), prompt: '换模型后的原任务' })
    await wait(() => f.sent.length === 1)
    assert.notEqual(f.sent[0].sessionId, f.initial.id)
    assert.equal(f.sessions.get(f.sent[0].sessionId)!.config.model, DEFAULT_ROUTER_CONFIG.model)
  } finally { await f.controller.close() }
})

test('failed replacement retains the original Session and input without resetting the automatic allowance', async () => {
  const f = await fixture()
  f.controls.failCreate = true
  f.controls.beforeUpdate = async () => { throw new DeepSeekHostError('connection-lost-reopen-session') }
  try {
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '新建失败仍保留' })
    await wait(() => f.db.request(input.requestId)?.state === 'failed')
    assert.equal(f.db.sessionId(), f.initial.id)
    assert.equal(f.db.request(input.requestId)!.recovery?.attempts, 1)
    assert.equal(f.db.request(input.requestId)!.autoRecovery?.attempts, 1, 'failed replacement still consumes the shared recovery allowance')
    assert.match(f.db.request(input.requestId)!.error!, /fixture-create-failed/)
    assert.ok(routerMcpServers(f.initial.id))
    assert.equal(f.sent.length, 0)
    f.controls.failCreate = false
    await f.controller.newSession(f.initial.id)
    await wait(() => f.db.request(input.requestId)?.state === 'failed')
    assert.equal(f.db.request(input.requestId)!.recovery?.attempts, 1)
    assert.equal(f.sessions.size, 3, 'only the explicit manual creation is added after the failed automatic attempt')
  } finally { await f.controller.close() }
})
