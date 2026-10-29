import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'vite'

// 需求3（回退关联）— covers the two app-server contract additions:
//   1. every turn boundary event (turn_started / turn_completed) and the
//      per-turn artifacts (diff_update / file_change) carry the stable native
//      `turnId`, so the orchestrator can bind changes to the exact turn.
//   2. forkBeforeTurn opens a NON-ephemeral fork (persistent, resumable),
//      prefers `beforeTurnId`, falls back to `lastTurnId` ONLY for an
//      unsupported-field rejection, never mutates the live runner state, and
//      propagates genuine errors instead of degrading.
const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

class RecordingTransport extends EventEmitter {
  calls = []
  interruptCalls = 0
  disposeCalls = 0
  handler = async (method) => {
    if (method === 'initialize') return { ok: true }
    if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
    if (method === 'turn/start') return { turn: { id: 'nturn-1' } }
    return {}
  }

  async start() {}
  async request(method, params) {
    this.calls.push({ method, params })
    return this.handler(method, params)
  }
  notify() {}
  respond() {}
  interrupt() { this.interruptCalls += 1 }
  async dispose() { this.disposeCalls += 1 }
}

function makeRunner(AppServerRunner, resumeThreadId, forkFromThreadId, adapter = 'codex') {
  const transport = new RecordingTransport()
  const runner = new AppServerRunner(
    'fork-fixture',
    { n: 1 },
    {
      id: adapter,
      name: adapter === 'traex' ? 'TraeX' : 'Codex',
      bin: adapter === 'traex' ? 'traecli' : 'codex',
      adapter,
      icon: '',
      builtin: true,
      capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [{ id: 'read-only' }], streaming: true },
      models: []
    },
    { agentId: adapter, workdir: process.cwd(), permissionMode: 'read-only', model: 'm' },
    resumeThreadId,
    forkFromThreadId,
    () => transport
  )
  const events = []
  runner.on('event', (event) => events.push(event))
  return { runner, events, transport }
}

try {
  const { AppServerRunner } = await server.ssrLoadModule('/src/main/appServerAdapter.ts')

  // --- 1. native turn id flows through the boundary + artifact events ---
  {
    const { runner, events, transport } = makeRunner(AppServerRunner, 'thread-1')
    await runner.startTurn('hi')
    assert.equal(transport.calls.find((call) => call.method === 'thread/resume').params.excludeTurns, true)
    assert.ok(transport.calls.some(({ method }) => method === 'thread/goal/get'), 'persistent threads must still refresh their Goal')
    runner.onNotification('deprecationNotice', { summary: 'Protocol guidance', details: null })
    assert.ok(events.some((event) => event.type === 'system_notice' && event.payload.text === 'Protocol guidance'))

    const started = events.find((e) => e.type === 'turn_started' && e.payload?.turnId)
    assert.ok(started, 'turn/start must emit a turn_started carrying the native turnId')
    assert.equal(started.payload.turnId, 'nturn-1')
    assert.equal(started.payload.threadId, 'thread-1')

    // diff_update + file_change during the turn carry the same turnId.
    runner.onNotification('turn/diff/updated', { threadId: 'thread-1', turnId: 'nturn-1', diff: 'diff --git a/a b/a' })
    const diff = events.find((e) => e.type === 'diff_update')
    assert.equal(diff.payload.turnId, 'nturn-1', 'diff_update must carry turnId')

    runner.onNotification('item/completed', {
      threadId: 'thread-1',
      item: { type: 'fileChange', id: 'fc1', status: 'completed', changes: [{ kind: 'update', path: 'a.ts', diff: 'd' }] }
    })
    const fc = events.find((e) => e.type === 'file_change')
    assert.equal(fc.payload.turnId, 'nturn-1', 'file_change must carry turnId')

    // turn/completed closes the turn with the same id.
    runner.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'nturn-1', status: 'completed' } })
    const completed = events.find((e) => e.type === 'turn_completed')
    assert.equal(completed.payload.turnId, 'nturn-1', 'turn_completed must carry the native turnId')
  }

  // --- 1b. interrupt during turn/start waits for a resumable native turn ---
  {
    const { runner, transport } = makeRunner(AppServerRunner)
    let releaseTurnStart
    const turnStartPending = new Promise((resolve) => { releaseTurnStart = resolve })
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/start') return { thread: { id: 'new-thread' } }
      if (method === 'turn/start') {
        await turnStartPending
        return { turn: { id: 'new-turn' } }
      }
      return {}
    }

    const starting = runner.startTurn('hi')
    while (!transport.calls.some(({ method }) => method === 'turn/start')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    runner.interrupt()
    assert.equal(transport.interruptCalls, 0, 'startup interrupt must not kill the resumable thread')
    releaseTurnStart()
    await starting
    assert.deepEqual(
      transport.calls.find(({ method }) => method === 'turn/interrupt')?.params,
      { threadId: 'new-thread', turnId: 'new-turn' }
    )
  }

  // --- 2a. forkBeforeTurn prefers beforeTurnId, ephemeral:false, no side effects ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, 'thread-1')
    runner.curTurnId = 'live-turn'
    runner.activeTurnToken = 'live-token'
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'thread/fork') return { thread: { id: 'fork-1' } }
      return {}
    }
    const forked = await runner.forkBeforeTurn('nturn-4')
    const calls = transport.calls.filter((call) => call.method === 'thread/fork')
    assert.equal(forked, 'fork-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'thread/fork')
    assert.equal(calls[0].params.threadId, 'thread-1')
    assert.equal(calls[0].params.ephemeral, false, 'rewind fork must be persistent (non-ephemeral)')
    assert.equal(calls[0].params.excludeTurns, true)
    assert.equal(calls[0].params.beforeTurnId, 'nturn-4')
    assert.ok(!('lastTurnId' in calls[0].params), 'must not send lastTurnId when beforeTurnId works')
    // Live runner state must be untouched — orchestrator switches sessions later.
    assert.equal(runner.threadId, 'thread-1')
    assert.equal(runner.curTurnId, 'live-turn')
  }

  // --- 2b. fallback to lastTurnId only for an unsupported-field rejection ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, 'thread-1')
    let forks = 0
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'thread/fork') {
        forks++
        if (forks === 1) throw new Error('unknown field `beforeTurnId`')
        return { thread: { id: 'fork-2' } }
      }
      return {}
    }
    const forked = await runner.forkBeforeTurn('nturn-4', 'nturn-3')
    const calls = transport.calls.filter((call) => call.method === 'thread/fork').map((call) => call.params)
    assert.equal(forked, 'fork-2')
    assert.equal(calls.length, 2)
    assert.equal(calls[1].lastTurnId, 'nturn-3', 'fallback must send lastTurnId=previousTurnId')
    assert.equal(calls[1].ephemeral, false)
    assert.ok(!('beforeTurnId' in calls[1]))
  }

  // --- 2c. genuine errors propagate; no fallback even with previousTurnId ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, 'thread-1')
    let count = 0
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'thread/fork') {
        count++
        throw new Error('thread not found')
      }
      return {}
    }
    await assert.rejects(
      () => runner.forkBeforeTurn('nturn-4', 'nturn-3'),
      /thread not found/,
      'a real fork failure must not silently degrade'
    )
    assert.equal(count, 1, 'must not retry on a non-unsupported-field error')
  }

  // --- 2d. no previousTurnId → an unsupported-field error still propagates ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, 'thread-1')
    let count = 0
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'thread/fork') {
        count++
        throw new Error('unknown field `beforeTurnId`')
      }
      return {}
    }
    await assert.rejects(() => runner.forkBeforeTurn('nturn-4'), /beforeTurnId/)
    assert.equal(count, 1, 'without previousTurnId there is nothing to fall back to')
  }

  // --- 3. side chat injects Codex's hidden boundary before the first real prompt ---
  {
    const { runner, events, transport } = makeRunner(AppServerRunner, undefined, 'main-thread')
    runner.setForkTranscript([
      { type: 'user_message', payload: { text: '重启前的问题' } },
      { type: 'agent_message', payload: { text: '重启前的回答' } }
    ])
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/fork') return { thread: { id: 'ephemeral-side-thread' } }
      if (method === 'thread/inject_items') return {}
      if (method === 'turn/start') return { turn: { id: 'side-turn' } }
      return {}
    }
    await runner.startTurn('侧边问题')
    const methods = transport.calls.map((call) => call.method)
    const forkIndex = methods.indexOf('thread/fork')
    const injectIndex = methods.indexOf('thread/inject_items')
    const turnIndex = methods.indexOf('turn/start')
    const injected = transport.calls[injectIndex]?.params.items
    assert.ok(forkIndex < injectIndex && injectIndex < turnIndex, 'boundary must be injected before the first side turn')
    assert.equal(injected?.[0]?.type, 'message')
    assert.equal(injected?.[0]?.role, 'user')
    assert.equal(injected?.[0]?.content?.[0]?.type, 'input_text')
    assert.match(injected?.[0]?.content?.[0]?.text || '', /It is not your current task/)
    assert.match(injected?.[0]?.content?.[0]?.text || '', /Only messages submitted after this boundary are active user instructions/)
    assert.match(injected?.[0]?.content?.[0]?.text || '', /Do not modify files/)
    assert.deepEqual(injected?.slice(1), [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重启前的问题' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '重启前的回答' }] }
    ])
    assert.equal(events.some((event) => event.type === 'error'), false)
  }

  // --- 4. missing boundary isolation must abort instead of silently continuing ---
  {
    const { runner, events, transport } = makeRunner(AppServerRunner, undefined, 'main-thread')
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/fork') return { thread: { id: 'ephemeral-side-thread' } }
      if (method === 'thread/inject_items') throw new Error('boundary rejected')
      if (method === 'turn/start') return { turn: { id: 'must-not-start' } }
      return {}
    }
    await runner.startTurn('侧边问题')
    assert.equal(
      transport.calls.some((call) => call.method === 'turn/start'),
      false,
      'the first side turn must not run without its boundary'
    )
    assert.match(events.find((event) => event.type === 'error')?.payload?.message || '', /boundary rejected/)
  }

  // --- 4b. side/detail startup must not query Goals on an ephemeral thread ---
  for (const adapter of ['codex', 'traex']) {
    const { runner, events, transport } = makeRunner(AppServerRunner, undefined, undefined, adapter)
    runner.setForkPreparation(() => Promise.resolve({ threadId: 'prepared-side-thread', cleanup: async () => {} }))
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'prepared-side-thread' } }
      if (method === 'thread/goal/get') throw new Error('ephemeral thread does not support goals: prepared-side-thread')
      if (method === 'turn/start') return { turn: { id: 'prepared-side-turn' } }
      return {}
    }
    await runner.startTurn('侧边问题')
    const methods = transport.calls.map((call) => call.method)
    assert.equal(methods.includes('thread/fork'), false)
    assert.equal(methods.includes('thread/inject_items'), false)
    assert.equal(methods.includes('thread/goal/get'), false)
    assert.ok(methods.indexOf('thread/resume') < methods.indexOf('turn/start'))
    assert.equal(transport.calls.find(({ method }) => method === 'thread/resume')?.params.ephemeral, true)
    assert.equal(events.some((event) => event.type === 'error'), false)
  }

  // --- 4c. TraeX reconnect resumes the original base and restores only side history ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, undefined, undefined, 'traex')
    const preparedHistories = []
    const cleaned = []
    runner.setForkTranscript([{ type: 'user_message', payload: { text: 'restored question' } }])
    runner.setForkPreparation(async (events) => {
      preparedHistories.push(structuredClone(events))
      return { threadId: 'prepared-base', cleanup: async () => { cleaned.push('prepared-base') } }
    })
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: params.threadId, ephemeral: true } }
      if (method === 'thread/goal/get') throw new Error('ephemeral thread does not support goals: prepared-base')
      return {}
    }
    await runner.ensureThreadReady()
    runner.setForkTranscript([
      { type: 'user_message', payload: { text: 'restored question' } },
      { type: 'user_message', payload: { text: 'hidden detail context', hidden: true } },
      { type: 'agent_message', payload: { text: 'answer before disconnect' } }
    ])
    transport.emit('disconnect', 'connection lost')
    await runner.ensureThreadReady()
    runner.setForkTranscript([
      { type: 'user_message', payload: { text: 'restored question' } },
      { type: 'user_message', payload: { text: 'hidden detail context', hidden: true } },
      { type: 'agent_message', payload: { text: 'answer before disconnect' } },
      { type: 'user_message', payload: { text: 'question after reconnect' } }
    ])
    transport.emit('disconnect', 'connection lost again')
    await runner.ensureThreadReady()

    assert.deepEqual(preparedHistories, [
      [{ type: 'user_message', payload: { text: 'restored question' } }]
    ], 'reconnect must not fork again from a main thread that may have advanced')
    assert.deepEqual(cleaned, [])
    assert.deepEqual(
      transport.calls.filter(({ method }) => method === 'thread/resume').map(({ params }) => params.threadId),
      ['prepared-base', 'prepared-base', 'prepared-base']
    )
    const rehydrated = transport.calls.filter(({ method, params }) =>
      method === 'thread/inject_items' && params.threadId === 'prepared-base'
    )
    assert.deepEqual(rehydrated.map(({ params }) => params.items.map((item) => item.content[0].text)), [
      ['hidden detail context', 'answer before disconnect'],
      ['hidden detail context', 'answer before disconnect', 'question after reconnect']
    ])
  }

  // --- 4d. a failed first resume can prepare a new branch on retry ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, undefined, undefined, 'traex')
    const prepared = []
    const cleaned = []
    runner.setForkPreparation(async () => {
        const threadId = `retry-prepared-${prepared.length + 1}`
        prepared.push(threadId)
        return { threadId, cleanup: async () => { cleaned.push(threadId) } }
      })
    let resumes = 0
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') {
        resumes += 1
        if (resumes === 1) throw new Error('resume rejected')
        return { thread: { id: params.threadId, ephemeral: true } }
      }
      return {}
    }
    await assert.rejects(() => runner.ensureThreadReady(), /resume rejected/)
    await runner.ensureThreadReady()
    assert.deepEqual(prepared, ['retry-prepared-1', 'retry-prepared-2'])
    assert.deepEqual(cleaned, ['retry-prepared-1'])
    assert.equal(runner.threadId, 'retry-prepared-2')
  }

  // --- 4e. closing while preparation is in flight cleans up through the parent owner ---
  {
    const { runner, transport } = makeRunner(AppServerRunner)
    let releasePreparation
    const preparationPending = new Promise((resolve) => { releasePreparation = resolve })
    const cleaned = []
    runner.setForkPreparation(async () => {
      const threadId = await preparationPending
      return { threadId, cleanup: async () => { cleaned.push(threadId) } }
    })
    transport.handler = async (method) => method === 'initialize' ? { ok: true } : {}
    const ready = runner.ensureThreadReady()
    while (!transport.calls.some(({ method }) => method === 'initialize')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    runner.disposeFork()
    releasePreparation('prepared-after-close')
    await assert.rejects(() => ready, /失效|关闭/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(cleaned, ['prepared-after-close'])
  }

  // --- 4f. an established prepared branch is also cleaned through its parent owner ---
  {
    const { runner, transport } = makeRunner(AppServerRunner)
    const cleaned = []
    runner.setForkPreparation(() => Promise.resolve({
      threadId: 'prepared-before-close',
      cleanup: async () => { cleaned.push('prepared-before-close') }
    }))
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      return {}
    }
    await runner.ensureThreadReady()
    runner.disposeFork()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(cleaned, ['prepared-before-close'])
  }

  // --- 4g. parent teardown waits for an already-started prepared-branch delete ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, 'main-thread')
    let releaseDelete
    const deletePending = new Promise((resolve) => { releaseDelete = resolve })
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'main-thread' } }
      if (method === 'thread/delete') {
        await deletePending
        return {}
      }
      return {}
    }
    await runner.ensureThreadReady()
    const deleting = runner.deleteThread('prepared-child')
    while (!transport.calls.some(({ method }) => method === 'thread/delete')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    runner.dispose()
    assert.equal(transport.disposeCalls, 0, 'parent transport must remain alive until delete settles')
    releaseDelete()
    await deleting
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(transport.disposeCalls, 1)
  }

  // --- 5. promotion forks the durable parent, then injects the ephemeral side transcript ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, undefined, 'main-thread')
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/fork' && params.threadId === 'main-thread' && params.ephemeral) {
        return { thread: { id: 'ephemeral-side-thread' } }
      }
      if (method === 'thread/fork' && params.threadId === 'ephemeral-side-thread') {
        throw new Error('no rollout found for thread id ephemeral-side-thread')
      }
      if (method === 'thread/fork' && params.threadId === 'main-thread' && !params.ephemeral) {
        return { thread: { id: 'durable-side-thread' } }
      }
      return {}
    }
    await runner.ensureThreadReady()
    assert.equal(typeof runner.forkPersistent, 'function')
    const forked = await runner.forkPersistent([
      { type: 'user_message', payload: { text: '内部详情上下文', hidden: true } },
      { type: 'user_message', payload: { text: '侧边问题' } },
      { type: 'agent_message', payload: { text: '侧边回答' } }
    ])
    const call = transport.calls.find(
      (item) => item.method === 'thread/fork' && item.params.ephemeral === false
    )
    const injected = transport.calls.find(
      (item) => item.method === 'thread/inject_items' && item.params.threadId === 'durable-side-thread'
    )
    assert.equal(forked, 'durable-side-thread')
    assert.deepEqual(call?.params, { threadId: 'main-thread', ephemeral: false, excludeTurns: true, model: 'm', modelProvider: 'openai' })
    assert.deepEqual(injected?.params.items, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '侧边问题' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '侧边回答' }] }
    ])
  }

  // --- 5b. a prepared side promotes from its current branch without replaying it ---
  {
    const { runner, transport } = makeRunner(AppServerRunner)
    runner.setForkPreparation(() => Promise.resolve({ threadId: 'prepared-side-thread', cleanup: async () => {} }))
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'prepared-side-thread' } }
      if (method === 'thread/fork' && params.threadId === 'prepared-side-thread') {
        return { thread: { id: 'durable-side-thread' } }
      }
      return {}
    }
    await runner.ensureThreadReady()
    const forked = await runner.forkPersistent([
      { type: 'user_message', payload: { text: 'already in prepared branch' } }
    ])
    assert.equal(forked, 'durable-side-thread')
    assert.equal(
      transport.calls.some(({ method, params }) => method === 'thread/inject_items' && params.threadId === forked),
      false,
      'promotion must not duplicate transcript already present in the side branch'
    )
  }

  // --- 5c. TraeX promotion replays only side turns created after ephemeral resume ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, undefined, undefined, 'traex')
    const priorEvents = [
      { type: 'user_message', payload: { text: 'restored question' } },
      { type: 'agent_message', payload: { text: 'restored answer' } }
    ]
    runner.setForkTranscript(priorEvents)
    runner.setForkPreparation(() => Promise.resolve({ threadId: 'prepared-side-thread', cleanup: async () => {} }))
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'prepared-side-thread', ephemeral: true } }
      if (method === 'thread/fork' && params.threadId === 'prepared-side-thread') {
        return { thread: { id: 'durable-side-thread' } }
      }
      return {}
    }
    await runner.ensureThreadReady()
    const forked = await runner.forkPersistent([
      ...priorEvents,
      { type: 'user_message', payload: { text: 'new ephemeral question' } },
      { type: 'agent_message', payload: { text: 'new ephemeral answer' } }
    ])
    const injected = transport.calls.find(
      ({ method, params }) => method === 'thread/inject_items' && params.threadId === forked
    )
    assert.deepEqual(injected?.params.items.map((item) => item.content[0].text), [
      'new ephemeral question',
      'new ephemeral answer'
    ])
  }

  // --- 5d. a failed promotion replay removes the newly-created durable branch ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, undefined, undefined, 'traex')
    runner.setForkPreparation(() => Promise.resolve({ threadId: 'prepared-side-thread', cleanup: async () => {} }))
    transport.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'prepared-side-thread', ephemeral: true } }
      if (method === 'thread/fork') return { thread: { id: 'broken-durable-thread' } }
      if (method === 'thread/inject_items') throw new Error('promotion replay rejected')
      return {}
    }
    await runner.ensureThreadReady()
    await assert.rejects(
      () => runner.forkPersistent([{ type: 'user_message', payload: { text: 'side prompt' } }]),
      /promotion replay rejected/
    )
    assert.deepEqual(
      transport.calls.find(({ method }) => method === 'thread/delete')?.params,
      { threadId: 'broken-durable-thread' }
    )
  }

  // --- 6. a live parent owns the fork; the side process only resumes it ---
  for (const adapter of ['codex', 'traex']) {
    const { runner: main, events: mainEvents, transport: mainTransport } = makeRunner(
      AppServerRunner, 'main-thread', undefined, adapter
    )
    mainTransport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'main-thread' } }
      if (method === 'turn/start') return { turn: { id: 'live-turn' } }
      if (method === 'thread/fork') return { thread: { id: `${adapter}-side-thread` } }
      return {}
    }
    mainEvents.push({ type: 'user_message', payload: { text: '正在执行的用户问题' } })
    await main.startTurn('正在执行的用户问题')
    main.onNotification('item/agentMessage/delta', {
      threadId: 'main-thread', turnId: 'live-turn', itemId: 'answer', delta: '已生成的回答'
    })
    main.onNotification('item/reasoning/summaryTextDelta', {
      threadId: 'main-thread', turnId: 'live-turn', itemId: 'thought', delta: '已产生的推理'
    })
    main.onNotification('item/completed', {
      threadId: 'main-thread', turnId: 'live-turn',
      item: { type: 'commandExecution', id: 'done-tool', command: 'pwd', aggregatedOutput: '/repo', status: 'completed', exitCode: 0 }
    })
    main.onNotification('item/started', {
      threadId: 'main-thread', turnId: 'live-turn',
      item: { type: 'mcpToolCall', id: 'pending-tool', server: 'demo', tool: 'wait', arguments: { seconds: 5 }, status: 'inProgress' }
    })
    main.onNotification('item/completed', {
      threadId: 'main-thread', turnId: 'live-turn',
      item: { type: 'dynamicToolCall', id: 'still-running-tool', name: 'demo_pending', arguments: {}, status: 'inProgress' }
    })
    main.onNotification('item/completed', {
      threadId: 'main-thread', turnId: 'live-turn',
      item: { type: 'dynamicToolCall', id: 'done-dynamic-tool', name: 'lookup', arguments: { key: 'answer' }, result: { value: 42 }, status: 'completed' }
    })
    main.onNotification('item/completed', {
      threadId: 'main-thread', turnId: 'previous-turn',
      item: { type: 'commandExecution', id: 'stale-tool', command: 'echo stale', aggregatedOutput: 'old result', status: 'completed', exitCode: 0 }
    })

    let releaseFork
    const forkPending = new Promise((resolve) => { releaseFork = resolve })
    mainTransport.handler = async (method) => {
      if (method === 'thread/fork') {
        main.onNotification('item/started', {
          threadId: `${adapter}-side-thread`,
          turnId: 'side-turn',
          item: { type: 'agentMessage', id: 'side-noise', text: 'must stay out of the main timeline' }
        })
        await forkPending
        return { thread: { id: `${adapter}-side-thread` } }
      }
      return {}
    }
    const forking = main.forkSideSnapshot(mainEvents)
    while (!mainTransport.calls.some(({ method }) => method === 'thread/fork')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    // Arrives after the snapshot boundary and must not leak into the child.
    main.onNotification('item/agentMessage/delta', {
      threadId: 'main-thread', turnId: 'live-turn', itemId: 'answer', delta: '（分叉后的增量）'
    })
    releaseFork()
    const forkedThreadId = await forking

    const forkCall = mainTransport.calls.find(({ method }) => method === 'thread/fork')
    const injectCall = mainTransport.calls.find(({ method }) => method === 'thread/inject_items')
    assert.equal(forkedThreadId, `${adapter}-side-thread`)
    assert.deepEqual(forkCall.params, {
      threadId: 'main-thread',
      ephemeral: false,
      excludeTurns: true,
      model: 'm',
      developerInstructions: forkCall.params.developerInstructions,
      ...(adapter === 'codex' ? { modelProvider: 'openai' } : {}),
      threadSource: 'side'
    })
    assert.equal(typeof forkCall.params.developerInstructions, 'string')
    const snapshot = injectCall.params.items[1]?.content?.[0]?.text || ''
    assert.match(injectCall.params.items[0]?.content?.[0]?.text || '', /Side conversation boundary/)
    assert.match(snapshot, /正在执行的用户问题/)
    assert.match(snapshot, /已生成的回答/)
    assert.match(snapshot, /已产生的推理/)
    assert.match(snapshot, /pwd/)
    assert.match(snapshot, /\/repo/)
    assert.match(snapshot, /lookup/)
    assert.match(snapshot, /"value": 42/)
    assert.doesNotMatch(snapshot, /pending-tool|still-running-tool|demo_pending|stale-tool|echo stale|old result|wait/)
    assert.doesNotMatch(snapshot, /分叉后的增量/)
    assert.equal(mainEvents.some(({ payload }) => payload?.id === 'side-noise'), false)
    assert.deepEqual(
      mainTransport.calls.find(({ method }) => method === 'thread/unsubscribe')?.params,
      { threadId: `${adapter}-side-thread` }
    )
    main.onNotification('item/started', {
      threadId: `${adapter}-side-thread`,
      turnId: 'late-side-turn',
      item: { type: 'agentMessage', id: 'late-side-noise', text: 'late side notification' }
    })
    assert.equal(mainEvents.some(({ payload }) => payload?.id === 'late-side-noise'), false)

  }

  // --- 6b. Codex side threads share one physical app-server and route by thread id ---
  {
    const { runner: main, events: mainEvents, transport: physical } = makeRunner(
      AppServerRunner, 'shared-main-thread'
    )
    const { runner: side, events: sideEvents, transport: unusedSideProcess } = makeRunner(AppServerRunner)
    physical.handler = async (method, params) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'config/read') return { config: { model_provider: 'openai' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'thread/goal/get') return { goal: null }
      if (method === 'thread/fork') return { thread: { id: 'shared-side-thread' } }
      if (method === 'turn/start') return { turn: { id: 'shared-side-turn' } }
      return {}
    }
    await main.ensureThreadReady()
    side.setForkPreparation(async (events) => {
      const threadId = await main.forkSideSnapshot([], events, {
        agentId: 'codex', workdir: process.cwd(), permissionMode: 'read-only', model: 'm'
      })
      return { threadId, cleanup: () => side.deleteThread(threadId) }
    }, main)
    await side.startTurn('shared side prompt')

    assert.equal(unusedSideProcess.calls.length, 0, 'Codex side runner must not start a second app-server')
    assert.ok(physical.calls.some(({ method, params }) =>
      method === 'thread/resume' && params.threadId === 'shared-side-thread'
    ))
    physical.emit('notification', 'deprecationNotice', {
      threadId: 'shared-main-thread', summary: 'main-routed'
    })
    physical.emit('notification', 'deprecationNotice', {
      threadId: 'shared-side-thread', summary: 'side-routed'
    })
    assert.equal(mainEvents.some(({ payload }) => payload?.text === 'main-routed'), true)
    assert.equal(mainEvents.some(({ payload }) => payload?.text === 'side-routed'), false)
    assert.equal(sideEvents.some(({ payload }) => payload?.text === 'side-routed'), true)
    assert.equal(sideEvents.some(({ payload }) => payload?.text === 'main-routed'), false)

    side.disposeFork()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(physical.disposeCalls, 0, 'closing the side thread must keep the main process alive')
    main.dispose()
  }

  // --- 6c. an early child notification survives an overlapping side fork ---
  {
    const { runner: main, events, transport } = makeRunner(AppServerRunner, 'main-thread')
    let releaseFork
    const forkPending = new Promise((resolve) => { releaseFork = resolve })
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'main-thread' } }
      if (method === 'thread/fork') {
        await forkPending
        return { thread: { id: 'side-thread' } }
      }
      return {}
    }
    await main.ensureThreadReady()
    const forking = main.forkSideSnapshot([])
    while (!transport.calls.some(({ method }) => method === 'thread/fork')) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    main.onNotification('thread/tokenUsage/updated', {
      threadId: 'child-before-registration',
      tokenUsage: { total: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 } }
    })
    assert.equal(events.some((event) => event.type === 'subagent'), false)
    assert.equal(events.some((event) => event.type === 'system_notice' && event.payload?.kind === 'context'), false)

    main.onNotification('item/completed', {
      threadId: 'main-thread',
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-child',
        tool: 'spawnAgent',
        receiverThreadIds: ['child-before-registration'],
        agentsStates: { 'child-before-registration': { status: 'running' } }
      }
    })
    releaseFork()
    await forking

    const childTokenEvent = events.find((event) =>
      event.type === 'subagent' &&
      event.payload?.agents?.some((agent) =>
        agent.agentThreadId === 'child-before-registration' && agent.tokens?.totalTokens === 15
      )
    )
    assert.ok(childTokenEvent, 'deferred child notification must replay after its registration arrives')
    assert.equal(
      events.some((event) => event.type === 'system_notice' && event.payload?.kind === 'context'),
      false,
      'deferred child token usage must not leak into the main context meter'
    )
  }

  // --- 6d. restored hidden detail context remains model-visible in a prepared fork ---
  {
    const { runner: main, transport } = makeRunner(AppServerRunner, 'main-thread')
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'main-thread' } }
      if (method === 'thread/fork') return { thread: { id: 'side-with-hidden-context' } }
      return {}
    }
    const threadId = await main.forkSideSnapshot([], [{
      type: 'user_message',
      payload: { text: 'selected code context', hidden: true }
    }])
    const injected = transport.calls.find(({ method, params }) =>
      method === 'thread/inject_items' && params.threadId === threadId
    )
    assert.equal(injected.params.items[1].content[0].text, 'selected code context')
  }

  // --- 7. connection startup failure is terminal, never reported as success ---
  {
    const { runner, events, transport } = makeRunner(AppServerRunner, 'missing-thread')
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') throw new Error('thread not found')
      return {}
    }
    let done
    runner.on('done', (result) => { done = result })
    await runner.startTurn('must fail')
    assert.equal(events.findLast((event) => event.type === 'turn_completed')?.state, 'failed')
    assert.equal(done?.failed, true)
  }

  // --- 8. a failed post-fork injection cleans up the prepared branch ---
  {
    const { runner, transport } = makeRunner(AppServerRunner, 'main-thread')
    transport.handler = async (method) => {
      if (method === 'initialize') return { ok: true }
      if (method === 'thread/resume') return { thread: { id: 'main-thread' } }
      if (method === 'thread/fork') return { thread: { id: 'broken-side-thread' } }
      if (method === 'thread/inject_items') throw new Error('snapshot rejected')
      return {}
    }
    await assert.rejects(() => runner.forkSideSnapshot([]), /snapshot rejected/)
    assert.deepEqual(
      transport.calls.find(({ method }) => method === 'thread/delete')?.params,
      { threadId: 'broken-side-thread' }
    )
  }

  console.log('appserver-turn-fork: ok')
} finally {
  await server.close()
}
