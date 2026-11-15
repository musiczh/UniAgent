import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskTitleIntegration, TaskTitleTrials } from '../src/main/taskTitleIntegration'
import { TaskMetadataStore } from '../src/main/taskMetadataStore'
import { TaskTitleService } from '../src/main/taskTitleService'
import { atomicWriteFile } from '../src/main/sessionStore'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'

const session = { id: 'one', title: 'old', config: { agentId: 'codex' } } as Session
const calls: any[] = []
const service = { accepted: (...args: any[]) => calls.push(['accepted', ...args]), responded: (id: string, response: string) => calls.push(['responded', id, response]), cancel: (id: string) => calls.push(['cancel', id]) }
const bridge = new TaskTitleIntegration(service as any, id => id === session.id ? session : undefined)
const event = (type: UAEvent['type'], payload: any = {}, seq = 1): UAEvent => ({ sessionId: 'one', seq, ts: 1, type, payload })
bridge.observe(event('turn_started', { threadId: 'connect' }))
bridge.observe(event('user_message', { text: '修复图片漏显', attachments: [{ name: 'sample.png', path: '/secret/path' }] }))
assert.equal(calls.length, 0, 'record alone is not input acceptance')
bridge.observe(event('turn_started', { threadId: 'thread', turnId: 'turn' }, 2))
assert.equal(calls.length, 0, 'execution before acceptance is latched')
bridge.accepted('one')
assert.equal(calls[0][0], 'accepted')
assert.deepEqual(calls[0][3].attachments, ['sample.png'])
assert.equal(calls.length, 1, 'native start cannot name a task before the main AI outputs text')
bridge.observe(event('agent_message', { id: 'reply', text: '先检查图片' }, 3))
assert.deepEqual(calls[1], ['responded', 'one', '先检查图片'], 'first Agent output must trigger naming before the final reply')
bridge.observe(event('reasoning', { text: 'private reasoning' }, 4))
bridge.observe(event('tool_call', { result: 'private tool log' }, 5))
bridge.observe(event('agent_message', { id: 'final', text: '图片显示任务历史页的图片预览丢失，需要恢复附件显示。', phase: 'final_answer' }, 6))
assert.equal(calls.length, 2, 'later final text cannot replace the initial output')
bridge.observe(event('turn_completed', { turnId: 'turn' }, 7))
assert.deepEqual(calls[1], ['responded', 'one', '先检查图片'])
calls.length = 0
bridge.observe(event('user_message', { text: 'recover', automaticRecovery: true }, 3))
bridge.accepted('one')
assert.equal(calls.length, 0, 'automatic recovery cannot reseed title')
bridge.observe(event('user_message', { text: 'new scope' }, 4))
bridge.accepted('one')
assert.equal(calls.length, 1)
bridge.observe(event('turn_started', { threadId: 'connect' }, 5))
assert.equal(calls.length, 1, 'connect-time event cannot start generation')
bridge.observe(event('agent_message', { text: 'working' }, 6))
assert.equal(calls.length, 2, 'live provider output names the task before completion')
bridge.observe(event('turn_completed', {}, 7))
assert.equal(calls[1][0], 'responded')
calls.length = 0
bridge.observe(event('user_message', { text: 'steer', appendedToTurn: true }, 7))
bridge.accepted('one')
assert.deepEqual(calls.map(call => call[0]), ['accepted'], 'steered input also waits for a new response')
bridge.observe(event('agent_message', { text: 'steered result' }, 8))
bridge.observe(event('turn_completed', {}, 9))
assert.deepEqual(calls.map(call => call[0]), ['accepted', 'responded'])
bridge.remove('one')
assert.equal(calls.at(-1)[0], 'cancel')

for (const agentId of ['codex', 'traex', 'claude', 'deepseek', 'grok', 'kimi', 'mcode', 'zcode', 'generic']) {
  session.config.agentId = agentId
  calls.length = 0
  bridge.observe(event('user_message', { text: '这个是怎么来的？', attachments: [{ kind: 'image', name: 'screenshot.png', path: '/unread-image.png' }] }, 20))
  bridge.accepted('one')
  bridge.observe(event('turn_started', { turnId: 'current' }, 21))
  bridge.observe(event('agent_message', { id: 'opening', text: '我会先查看截图。', turnId: 'current' }, 22))
  bridge.observe(event('agent_message', { id: 'wrong-turn', text: '错误轮次', turnId: 'previous', phase: 'final_answer' }, 23))
  bridge.observe(event('agent_message', { id: 'async', text: '异步消息', delivery: 'async', phase: 'final_answer' }, 24))
  bridge.observe(event('agent_message', { id: 'thinking', text: '思考内容', kind: 'thinking' }, 25))
  assert.equal(calls.length, 2, `${agentId} names from the first output`)
  bridge.observe(event('agent_message', { id: 'final', text: '截图里的交付与验证材料由 task_delivery 工具写入任务记录。', phase: 'final_answer' }, 26))
  bridge.observe(event('agent_message', { id: 'later-commentary', text: '补充过程说明' }, 27))
  bridge.observe(event('turn_completed', { turnId: 'previous' }, 28))
  assert.equal(calls.length, 2, 'later output and other turns cannot name again')
  bridge.observe(event('turn_completed', { turnId: 'current' }, 29))
  assert.deepEqual(calls[1], ['responded', 'one', '我会先查看截图。'])
  bridge.observe(event('turn_completed', { turnId: 'current' }, 30))
  assert.equal(calls.length, 2, 'duplicate completion cannot name twice')
  bridge.remove('one')
}

for (const state of ['failed', 'cancelled', 'success'] as const) {
  calls.length = 0
  bridge.observe(event('user_message', { text: '图片里的问题' }, 40))
  bridge.accepted('one')
  if (state !== 'success') bridge.observe({ ...event('agent_message', { text: '无效的失败输出' }, 41), state })
  bridge.observe({ ...event('turn_completed', {}, 42), state })
  assert.deepEqual(calls.map(call => call[0]), ['accepted'], 'failed, cancelled and empty turns preserve the provisional title')
  bridge.remove('one')
}

calls.length = 0
bridge.observe(event('user_message', { text: '', attachments: [{ kind: 'image', name: 'only.png' }] }, 50))
bridge.observe({ ...event('agent_message', { id: 'stream', text: '截图显示' }, 51), state: 'running' })
bridge.observe({ ...event('agent_message', { id: 'stream', text: '截图显示任务详情页的' }, 52), state: 'running' })
bridge.observe({ ...event('agent_message', { id: 'stream', delta: '交付材料。' }, 53), state: 'running' })
bridge.observe(event('turn_completed', {}, 54))
assert.equal(calls.length, 0, 'completion before acceptance is latched')
bridge.accepted('one')
assert.deepEqual(calls[1], ['responded', 'one', '截图显示任务详情页的交付材料。'], 'unphased stream snapshots replace text; deltas append once')
bridge.remove('one')

calls.length = 0
bridge.observe(event('user_message', { text: '检查任务标题' }, 60))
bridge.accepted('one')
bridge.observe({ ...event('agent_message', { delta: '只含增量' }, 61), state: 'running' })
bridge.observe({ ...event('agent_message', { delta: '的回复' }, 62), state: 'running' })
bridge.observe(event('turn_completed', {}, 63))
assert.deepEqual(calls[2], ['responded', 'one', '只含增量的回复'], 'the first delta may have no previous snapshot or message ID')
bridge.remove('one')

const agent = { id: 'codex', name: 'Codex', adapter: 'codex', installed: true, bin: '/fixture', models: [{ id: 'small', efforts: ['low'] }], capabilities: { modelSelect: true, startupSystemPrompt: true } } as AgentDef
let finish!: (text: string) => void
const trials = new TaskTitleTrials(() => [agent], async (_agent, config, prompt, signal) => {
  assert.equal(config.model, 'small')
  assert.ok(prompt.includes('修复图片'))
  return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
})
const request = { requestId: '11111111-1111-4111-8111-111111111111', config: { enabled: false, agentId: 'codex', model: 'small' }, prompt: '修复图片' }
const run = trials.run(1, request)
await new Promise(resolve => setImmediate(resolve))
trials.cancel(2, request.requestId)
finish('{"title":"修复图片漏显","description":"任务描述夹具","needsClarification":false}')
assert.equal((await run).title, '修复图片漏显', 'another sender cannot cancel')
const cancel = trials.run(1, request)
await new Promise(resolve => setImmediate(resolve))
trials.cancel(1, request.requestId)
await assert.rejects(cancel, /cancelled|取消/)
await assert.rejects(trials.run(1, { ...request, requestId: 'invalid' }), /请求/)
await assert.rejects(trials.run(1, { ...request, config: { enabled: true, agentId: 'codex', model: 'gone' } }), /模型/)
await trials.close()
console.log('PASS title integration waits for main AI response, recovery exclusion, attachment names, sender-owned draft trials and cancellation')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Keep the bridge, service, store and atomic writer real. Only external model
// completion and a selected write boundary are controlled by this fixture.
async function overlapFixture(mode: 'valid' | 'invalid' | 'reject' | 'not-started' | 'delayed-seed' | 'failed-seed' | 'queue') {
  const root = await mkdtemp(join(tmpdir(), 'title-live-overlap-'))
  const sessions = ['latest', 'queued', 'overflow'].map(id => ({ id, title: '临时', createdAt: 1, status: 'idle', config: { agentId: 'codex', workdir: '/fixture' } } as Session))
  const gate = deferred<void>()
  let blocked = false, failSeed = mode === 'failed-seed'
  const store = new TaskMetadataStore(root, async (file, data) => {
    const metadata = JSON.parse(data)
    if (metadata.taskId === 'latest' && metadata.generationState === 'pending' && metadata.seed?.clarifications?.length) {
      if (mode === 'delayed-seed') { blocked = true; await gate.promise }
      if (failSeed) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
    }
    await atomicWriteFile(file, data)
  })
  for (const value of sessions) store.initialize(value, false)
  const pending: Array<ReturnType<typeof deferred<string>> & { signal: AbortSignal; prompt: string }> = []
  const titles = new TaskTitleService(store, {
    validateDescription: async () => {},
    session: id => sessions.find(value => value.id === id), agents: () => [agent],
    config: () => ({ enabled: true, agentId: 'codex', model: 'small' }),
    generate: async (_agent, _config, prompt, signal) => {
      const value = { ...deferred<string>(), signal, prompt }
      pending.push(value)
      return value.promise
    }
  }, { debounceMs: 0, concurrency: 1, maxQueue: 1 })
  const live = new TaskTitleIntegration(titles, id => sessions.find(value => value.id === id))
  let seq = 1
  const observe = (id: string, type: UAEvent['type'], payload: UAEvent['payload']) => {
    const value = { sessionId: id, type, payload, seq: seq++, ts: seq }
    live.observe(value)
    return value
  }
  const accept = (id: string, text: string) => { const value = observe(id, 'user_message', { text }); live.accepted(id); return value }
  const respond = (id: string) => {
    const turnId = `turn-${seq}`
    observe(id, 'turn_started', { threadId: 'thread', turnId })
    observe(id, 'agent_message', { id: `reply-${turnId}`, text: '主 AI 已分析任务历史页的图片显示问题。', phase: 'final_answer', turnId })
    observe(id, 'turn_completed', { turnId })
  }
  const turns = async () => { for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve)) }
  const drain = async () => { for (let n = 0; n < 15; n++) { await turns(); await store.flush() } }
  const until = async (check: () => boolean) => {
    for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail(`live overlap did not settle: ${mode}, calls=${pending.length}`)
  }
  try {
    const firstInput = accept('latest', '修复重启后的图片漏显'); respond('latest')
    await until(() => pending.length === 1)
    live.accepted('latest')
    titles.accepted('latest', '修复重启后的图片漏显', { inputId: `latest:${firstInput.seq}:${firstInput.ts}` })
    assert.equal(pending[0].signal.aborted, false, 'same accepted identity does not cancel its active request')
    const runningVersion = store.current(sessions[0]).version
    live.observe(firstInput); live.accepted('latest')
    await drain()
    assert.equal(pending[0].signal.aborted, false, 'replayed accepted identity does not cancel the request')
    assert.equal(store.current(sessions[0]).version, runningVersion)
    if (mode === 'queue') {
      accept('queued', '修复队列任务'); respond('queued')
      await drain()
      accept('overflow', '修复溢出任务'); respond('overflow')
      await until(() => store.current(sessions[2]).generationState === 'deferred')
      assert.equal(store.current(sessions[2]).generationState, 'deferred')
    }
    accept('latest', '补充：只处理任务历史页')
    if (mode !== 'not-started') respond('latest')
    if (mode === 'delayed-seed') {
      await until(() => blocked)
    }
    else await drain()
    assert.equal(pending[0].signal.aborted, true, 'new accepted material aborts the superseded title request')
    assert.equal(pending.length, 1, 'an ignored abort keeps the owned slot until the old request settles')
    if (mode === 'reject') pending[0].reject(Object.assign(new Error('late network rejection'), { code: 'ECONNRESET' }))
    else pending[0].resolve(mode === 'invalid' ? 'invalid late output' : '{"title":"旧输入标题","description":"任务描述夹具","needsClarification":false}')
    if (mode === 'delayed-seed') {
      await turns()
      assert.equal(pending.length, 1, 'latest start still waits for its durable seed')
      assert.equal(store.current(sessions[0]).title, undefined, 'old output cannot commit while the latest write is blocked')
      gate.resolve()
    }
    await drain()
    assert.equal(store.current(sessions[0]).title, undefined, 'late valid, invalid or rejected old output cannot commit')
    if (mode === 'delayed-seed') assert.equal(pending.length, 2, 'latest generation starts only after its own seed is durable')
    if (mode === 'not-started' || mode === 'failed-seed') {
      assert.equal(pending.length, 1, `${mode}: an earlier response or a failed latest seed cannot authorize generation`)
      if (mode === 'failed-seed') {
        failSeed = false
        accept('latest', '补充：只处理任务历史页')
      }
      observe('latest', 'turn_started', { threadId: 'connection-only' })
      await drain()
      assert.equal(pending.length, 1)
      respond('latest')
    }
    if (mode === 'queue') {
      await until(() => pending.length === 2)
      assert.match(pending[1].prompt, /修复队列任务/, 'already queued task runs before the superseding context')
      pending[1].resolve('{"title":"队列任务标题","description":"任务描述夹具","needsClarification":false}')
      await until(() => pending.length === 3)
      assert.match(pending[2].prompt, /修复溢出任务/, 'older deferred task retains priority over the superseding context')
      pending[2].resolve('{"title":"溢出任务标题","description":"任务描述夹具","needsClarification":false}')
    }
    const latestIndex = mode === 'queue' ? 3 : 1
    await until(() => pending.length === latestIndex + 1)
    assert.match(pending[latestIndex].prompt, /修复重启后的图片漏显/)
    assert.match(pending[latestIndex].prompt, /补充：只处理任务历史页/)
    assert.equal(store.current(sessions[0]).clarificationCount, 1)
    accept('latest', '第三份补充继续更新整体任务'); respond('latest')
    await drain()
    assert.equal(pending[latestIndex].signal.aborted, true, 'each new accepted turn supersedes the old generation without a clarification cap')
    assert.equal(pending.length, latestIndex + 1)
    pending[latestIndex].resolve('{"title":"修复任务历史图片漏显","description":"任务描述夹具","needsClarification":false}')
    await until(() => pending.length === latestIndex + 2)
    assert.match(pending[latestIndex + 1].prompt, /第三份补充继续更新整体任务/)
    pending[latestIndex + 1].resolve('{"title":"修复任务历史图片漏显","description":"包含第三轮补充范围","needsClarification":false}')
    await drain()
    assert.equal(store.current(sessions[0]).title, '修复任务历史图片漏显')
    assert.equal(store.current(sessions[0]).description, '包含第三轮补充范围')
    const version = store.current(sessions[0]).version
    accept('latest', '普通继续输入'); respond('latest')
    await drain()
    assert.ok(store.current(sessions[0]).version > version, 'generated ready metadata accepts ordinary continuation input')
    assert.equal(pending.length, latestIndex + 3)
    pending[latestIndex + 2].resolve('{"title":"继续修复任务历史图片","description":"保留整体目标并吸收继续输入","needsClarification":false}')
    await drain()
    assert.equal(store.current(sessions[0]).description, '保留整体目标并吸收继续输入')
  } finally {
    gate.resolve()
    const closing = titles.close()
    for (const value of pending) value.resolve('{"title":"清理夹具","description":"任务描述夹具","needsClarification":false}')
    await closing
    await rm(root, { recursive: true, force: true })
  }
}
for (const mode of ['valid', 'invalid', 'reject', 'not-started', 'delayed-seed', 'failed-seed', 'queue'] as const) await overlapFixture(mode)
console.log('PASS real bridge/service/durable metadata live overlap, latest start/seed gates, ignored abort, late rejection, per-turn updates and queue fairness')
