import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import { routerMcpServers } from '../src/main/router/mcp'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import { routerTargetVersion } from '../src/main/router/target'
import type { RouterStore } from '../src/main/router/store'
import type { AgentDef, Session } from '../src/shared/types'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'router-outcomes-'))
  const db = new RouterDatabase(join(directory, 'router.sqlite'))
  const store = new Proxy({} as RouterStore, { get: (_, key: string) => async (...args: unknown[]) => (db[key as keyof RouterDatabase] as Function).apply(db, args) })
  const config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }
  const agent = { id: config.agentId, installed: true, adapter: 'deepseek', models: [{ id: config.model, efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef
  const sessions = new Map<string, Session>(), sent: any[] = [], accepted: any[] = [], queue: any[] = []
  let failOpen = false
  const deps = { agents: () => [agent], config: () => config, saveConfig() {}, objects: async () => [], changed() {}, error() {},
    newTask: async () => { throw Error('must not recreate task') }, recoverTask: async () => undefined,
    orchestrator: { getSessionById: (id: string) => sessions.get(id), managedSessions: () => [...sessions.values()], getEvents: async () => [], getQueue: () => queue,
      createRouterDraft: (config: Session['config'], id: string) => { if (failOpen) throw Error('fixture startup failure'); if (!sessions.has(id)) sessions.set(id, { id, title: 'Router', config, status: 'idle', createdAt: 1 }); return sessions.get(id)! },
      updateSessionConfig: async () => {}, sendMessage: async (...args: any[]) => { sent.push(args); sessions.get(args[0])!.status = 'running' },
      interrupt: (id: string) => { sessions.get(id)!.status = 'idle' }, disposeSession() {}, appendSystemNotice() {},
      acceptRoutedInput: async (...args: any[]) => { accepted.push(args); return { status: 'accepted' as const } }
    } as any }
  const controller = new RouterController(store, deps, directory)
  await controller.recover()
  const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw Error('outcome timeout') }
  const finish = async (state: 'success' | 'failed' = 'success') => { const id = (await controller.snapshot()).sessionId!; sessions.get(id)!.status = 'idle'; await controller.event({ sessionId: id, seq: sent.length * 100, ts: Date.now(), type: 'turn_completed', state, payload: {} }) }
  const due = async (id: string) => { const row = db.request(id)!; await store.update(id, row.version, { autoRecovery: { ...(row as any).autoRecovery, nextAt: Date.now() - 1 } } as any); (controller as any).pump() }
  return { directory, db, store, controller, deps, config, sessions, sent, accepted, queue, wait, finish, due, failOpen: () => { failOpen = true } }
}

test('a failed request accepts supplemental retry without replacing its identity or original input', async () => {
  const f = await fixture()
  try {
    const input = f.db.register({ requestId: randomUUID(), prompt: '原任务', attachments: [{ kind: 'image', name: 'original.png', path: '/fixture/original.png' }] }, f.config)
    const failed = f.db.update(input.requestId, input.version, { state: 'failed', error: 'failed' })
    const result = await f.controller.resolve({ requestId: input.requestId, expectedVersion: failed.version, action: 'retry', answer: '属于 UniAgent 项目' } as any)
    assert.equal(result.requestId, input.requestId); assert.equal(result.prompt, input.prompt)
    assert.deepEqual(result.attachments, input.attachments)
    assert.match(result.resolution!, /属于 UniAgent 项目/)
    assert.equal(result.state, 'queued')
    await assert.rejects(f.controller.resolve({ requestId: input.requestId, expectedVersion: failed.version, action: 'retry' } as any))
    assert.equal(f.accepted.length, 0)
  } finally { await f.controller.close() }
})

test('a completed Router turn without a decision retries twice, persists its budget and then leaves a final failure', async () => {
  const f = await fixture()
  try {
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '请分配任务' })
    await f.wait(() => f.sent.length === 1)
    await f.finish()
    let row = f.db.request(input.requestId)! as any
    assert.equal(row.state, 'queued'); assert.equal(row.autoRecovery.attempts, 1)
    assert.ok(row.autoRecovery.nextAt > Date.now()); assert.equal(f.sent.length, 1)
    const reopened = new RouterDatabase(join(f.directory, 'router.sqlite'))
    try { assert.deepEqual((reopened.request(input.requestId)! as any).autoRecovery, row.autoRecovery) } finally { reopened.close() }
    await f.due(input.requestId); await f.wait(() => f.sent.length === 2); await f.finish()
    row = f.db.request(input.requestId)! as any; assert.equal(row.autoRecovery.attempts, 2)
    await f.due(input.requestId); await f.wait(() => f.sent.length === 3); await f.finish()
    row = f.db.request(input.requestId)! as any; assert.equal(row.state, 'failed'); assert.equal(row.autoRecovery.attempts, 2)
    assert.equal(f.sent.length, 3); assert.equal(f.accepted.length, 0)
  } finally { await f.controller.close() }
})

test('startup failure produces a final recoverable request and cancellation stops scheduled recovery', async () => {
  const f = await fixture()
  try {
    f.failOpen()
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '启动失败也有结果' })
    await f.wait(() => f.db.request(input.requestId)!.state === 'failed')
    assert.match(f.db.request(input.requestId)!.error!, /fixture startup failure/)
    const row = f.db.register({ requestId: randomUUID(), prompt: '取消后不能恢复' }, f.config)
    const queued = f.db.update(row.requestId, row.version, { autoRecovery: { attempts: 1, total: 1, phase: 'routing', reason: 'transient', nextAt: Date.now() + 2000 } } as any)
    await f.controller.cancel(row.requestId, queued.version)
    ;(f.controller as any).pump(); await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.db.request(row.requestId)!.state, 'cancelled'); assert.equal(f.sent.length, 0)
  } finally { await f.controller.close() }
})

test('unknown delivery is reconciled from the original queue without submitting again', async () => {
  const f = await fixture()
  try {
    const target: Session = { id: 'target', title: '目标任务', status: 'running', config: { agentId: 'codex', workdir: '/fixture' }, createdAt: 1 }
    f.sessions.set(target.id, target)
    const input = f.db.register({ requestId: randomUUID(), prompt: '原任务' }, f.config)
    const uncertain = f.db.update(input.requestId, input.version, { state: 'bound', targetId: target.id, delivery: 'unknown' })
    f.queue.push({ id: input.requestId, prompt: input.prompt, state: 'pending' })
    const result = await f.controller.resolve({ requestId: input.requestId, expectedVersion: uncertain.version, action: 'verify' } as any)
    assert.equal(result.state, 'bound'); assert.equal(result.delivery, 'queued')
    assert.equal(f.accepted.length, 0); assert.equal(f.sent.length, 0)
    const failed = f.db.update(input.requestId, result.version, { state: 'failed', delivery: 'unknown' })
    await assert.rejects(f.controller.retry(input.requestId, failed.version), /不能重新路由/)
  } finally { await f.controller.close() }
})

test('a real delivery failure replaces the recovered tool error and remains unknown', async () => {
  const f = await fixture()
  try {
    const target: Session = { id: 'target', title: '原任务', status: 'running', config: { agentId: 'codex', workdir: '/fixture' }, createdAt: 1 }
    f.sessions.set(target.id, target)
    Object.assign(f.deps, { objects: async () => [{ id: target.id, kind: 'task', title: target.title, summary: '', version: routerTargetVersion(target) }] })
    f.deps.orchestrator.acceptRoutedInput = async () => { throw new Error('receipt connection lost') }
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '继续原任务' })
    await f.wait(() => f.sent.length === 1)
    const env = Object.fromEntries(routerMcpServers(f.db.sessionId())![0].env.map(row => [row.name, row.value]))
    const call = async (name: string, args: unknown) => (await fetch(env.UNIAGENT_ROUTER_ENDPOINT, { method: 'POST',
      headers: { authorization: 'Bearer ' + env.UNIAGENT_ROUTER_TOKEN }, body: JSON.stringify({ name, arguments: args }) })).json()
    const current = f.db.request(input.requestId)!
    const failed = f.db.update(input.requestId, current.version, { error: 'object_not_read', failure: { code: 'router-tool-recovery', sessionId: f.db.sessionId() },
      autoRecovery: { attempts: 2, total: 2, phase: 'delivery', reason: 'previous attempts exhausted' } })
    const result = await call('router_assign_task', { requestId: input.requestId, version: failed.version, action: 'reuse_task', taskId: target.id, reason: '同一目标' })
    assert.equal(result.value.state, 'bound')
    assert.equal(result.value.delivery, 'unknown')
    assert.match(result.value.error, /receipt connection lost/, 'real delivery errors must survive cleanup')
    assert.equal(f.db.request(input.requestId)!.failure, undefined)
    await f.finish('failed')
    assert.equal(f.sent.length, 1, 'uncertain delivery must not restart routing or resend business input')
  } finally { await f.controller.close() }
})

test('manual retry resets its group allowance, rejects blank supplements and still serializes concurrent clicks', async () => {
  const f = await fixture()
  try {
    const input = f.db.register({ requestId: randomUUID(), prompt: '原任务' }, f.config)
    const failed = f.db.update(input.requestId, input.version, { state: 'failed', autoRecovery: { attempts: 2, total: 4, phase: 'routing', reason: 'exhausted' } })
    await assert.rejects(f.controller.retry(input.requestId, failed.version, '   '), /填写补充信息/)
    const results = await Promise.allSettled([f.controller.retry(input.requestId, failed.version), f.controller.retry(input.requestId, failed.version)])
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
    assert.equal(f.db.request(input.requestId)!.autoRecovery?.attempts, 0)
    assert.equal(f.db.request(input.requestId)!.autoRecovery?.total, 4)
  } finally { await f.controller.close() }
})

test('temporary failure retries preserve configuration and late completions cannot terminate the next attempt', async () => {
  const f = await fixture()
  try {
    const input = await f.controller.submit({ requestId: randomUUID(), prompt: '原任务' })
    await f.wait(() => f.sent.length === 1); await f.finish()
    f.config.version++
    await f.due(input.requestId); await f.wait(() => f.sent.length === 2)
    assert.equal(f.db.request(input.requestId)!.config.version, 1, 'saved configuration only applies to the next task')
    const before = f.db.request(input.requestId)!
    await f.controller.event({ sessionId: before.routerSessionId!, seq: 100, ts: Date.now(), type: 'turn_completed', state: 'success', payload: { routedInputId: input.requestId } })
    assert.deepEqual(f.db.request(input.requestId), before, 'duplicate old completion cannot consume another retry')
    await f.controller.event({ sessionId: before.routerSessionId!, seq: 200, ts: Date.now(), type: 'error', state: 'failed', payload: { code: 'ECONNRESET', message: 'connection reset', routedInputId: input.requestId } })
    await f.finish('failed')
    assert.equal(f.db.request(input.requestId)!.state, 'queued')
    assert.equal(f.db.request(input.requestId)!.autoRecovery?.attempts, 2)
  } finally { await f.controller.close() }
})

test('only a readable absent receipt may resume delivery and routing answers stay inside Router', async () => {
  const f = await fixture()
  try {
    const target: Session = { id: 'target', title: '原任务', status: 'idle', config: { agentId: 'codex', workdir: '/fixture' }, createdAt: 1 }
    f.sessions.set(target.id, target)
    const input = f.db.register({ requestId: randomUUID(), prompt: '原始输入' }, f.config)
    const uncertain = f.db.update(input.requestId, input.version, { state: 'bound', delivery: 'unknown', targetId: target.id, targetVersion: routerTargetVersion(target),
      decision: { action: 'reuse_task', taskId: target.id, reason: '继续原任务' }, supplements: [{ text: '放到日常迭代', attachments: [{ kind: 'image', path: '/fixture/scope.png', name: 'scope.png' }] }] })
    const result = await f.controller.resolve({ requestId: input.requestId, expectedVersion: uncertain.version, action: 'verify' })
    assert.equal(result.delivery, 'accepted'); assert.equal(result.prompt, '原始输入')
    assert.equal(f.accepted.length, 1); assert.equal(f.accepted[0][1], input.requestId)
    assert.equal(f.accepted[0][2], '原始输入')
    assert.equal(f.accepted[0][3], undefined)
    await assert.rejects(f.controller.resolve({ requestId: input.requestId, expectedVersion: uncertain.version, action: 'verify' }))
    assert.equal(f.accepted.length, 1)
  } finally { await f.controller.close() }
})

test('an existing legacy receipt containing routing answers is recognized without resending the input', async () => {
  const f = await fixture()
  try {
    const target: Session = { id: 'target', title: '原任务', status: 'idle', config: { agentId: 'codex', workdir: '/fixture' }, createdAt: 1 }
    f.sessions.set(target.id, target)
    const input = f.db.register({ requestId: randomUUID(), prompt: '原始输入' }, f.config)
    const uncertain = f.db.update(input.requestId, input.version, { state: 'bound', delivery: 'unknown', targetId: target.id,
      supplements: [{ text: '放到日常迭代' }] })
    f.queue.push({ id: input.requestId, prompt: '与本请求无关的内容', state: 'pending' })
    const mismatch = await f.controller.resolve({ requestId: input.requestId, expectedVersion: uncertain.version, action: 'verify' })
    assert.equal(mismatch.delivery, 'unknown', 'receipt matching must still reject unrelated payloads')
    f.queue[0].prompt = '原始输入\n\n补充信息：\n放到日常迭代'
    const result = await f.controller.resolve({ requestId: input.requestId, expectedVersion: mismatch.version, action: 'verify' })
    assert.equal(result.delivery, 'queued')
    assert.equal(f.accepted.length, 0, 'previous delivery is not sent again after the clarification policy changes')
  } finally { await f.controller.close() }
})

test('session replacement shares the second eight-second backoff and cannot exceed the persisted allowance', async () => {
  const f = await fixture()
  try {
    const id = f.db.sessionId(), input = f.db.register({ requestId: randomUUID(), prompt: '第二次恢复换会话' }, f.config)
    const routing = f.db.update(input.requestId, input.version, { state: 'routing', routerSessionId: id,
      autoRecovery: { attempts: 1, total: 1, phase: 'routing', reason: 'first retry' } })
    const started = Date.now()
    f.db.replaceSession(id, 'replacement', { requestId: input.requestId, version: routing.version })
    const result = f.db.request(input.requestId)!
    assert.equal(result.autoRecovery?.attempts, 2)
    assert.ok(result.autoRecovery!.nextAt! >= started + 8000)
    assert.ok(result.autoRecovery!.nextAt! <= Date.now() + 8000)
    const exhausted = f.db.register({ requestId: randomUUID(), prompt: '额度已耗尽' }, f.config)
    const blocked = f.db.update(exhausted.requestId, exhausted.version, { state: 'routing', routerSessionId: 'replacement',
      autoRecovery: { attempts: 2, total: 2, phase: 'routing', reason: 'exhausted' } })
    assert.throws(() => f.db.replaceSession('replacement', 'unexpected', { requestId: blocked.requestId, version: blocked.version }), /router_revision_conflict/)
    assert.equal(f.db.sessionId(), 'replacement')
  } finally { await f.controller.close() }
})
