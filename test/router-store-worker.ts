import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { DEFAULT_ROUTER_CONFIG, routerInitialRequirementContext } from '../src/shared/router'
import { loadRouterTokenizer } from '../src/main/router/tokenizer'
import { RouterController } from '../src/main/router/controller'
import type { RouterStore } from '../src/main/router/store'
import type { AgentDef, Session } from '../src/shared/types'

const directory = await mkdtemp(resolve('out/test/router-worker-')), entry = join(directory, 'worker.mjs')
await build({ entryPoints: ['src/main/router/worker.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry })
const worker = new Worker(entry, { workerData: { path: join(directory, 'router.sqlite') } })
let sequence = 0
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
const ready = new Promise<void>((resolveReady, rejectReady) => {
  worker.on('error', rejectReady)
  worker.on('message', message => {
    if (message.ready) return resolveReady()
    if (message.fatal) return rejectReady(new Error(message.fatal))
    const result = pending.get(message.id)
    if (result) { pending.delete(message.id); message.error ? result.reject(new Error(message.error)) : result.resolve(message.value) }
  })
})
const request = (method: string, args: unknown[] = []) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args }) })
try {
  await ready
  const tokenizer = await loadRouterTokenizer()
  let tokens = 2000 - tokenizer.count(routerInitialRequirementContext(''))
  while (tokenizer.count(routerInitialRequirementContext(' a'.repeat(tokens))) < 2000) tokens++
  const exact = ' a'.repeat(tokens)
  assert.equal(tokenizer.count(routerInitialRequirementContext(exact)), 2000)
  await request('validateInitialRequirementContext', [exact])
  assert.equal(tokenizer.count(routerInitialRequirementContext(exact + ' a')), 2001)
  await assert.rejects(request('validateInitialRequirementContext', [exact + ' a']), /router_initial_context_too_large/)
  const image={kind:'image',path:'/fixture/worker-draft.png',name:'worker-draft.png',previewDataUrl:'data:image/png;base64,preview'}
  await request('draftImages',['save',[image]])
  assert.deepEqual(await request('draftImages',['read']),[image],'actual worker dispatch supports image drafts')
  await request('draftImages',['submitted',[image]])
  assert.deepEqual(await request('draftImages',['read']),[])
  const id = await request('sessionId'), input = { requestId: randomUUID(), prompt: '历史图片' }
  assert.equal(await request('sessionNotice'), undefined, 'a fresh worker must serve the snapshot notice route')
  const rows = await Promise.all(Array.from({ length: 10 }, () => request('register', [input, DEFAULT_ROUTER_CONFIG])))
  assert.equal(new Set(rows.map(row => row.requestId)).size, 1)
  await request('index', [[{ id: 'images', title: '历史图片', summary: '图片漏显', kind: 'task', version: '1', projectId: 'ua', lastBusinessUpdatedAt: Date.now() },
    { id: 'ua', title: 'UniAgent', summary: '应用', kind: 'space', version: '1', projectId: 'ua' }]])
  const catalog=await request('catalog',[input.requestId,'space'])
  assert.equal(catalog.catalogRevision, await request('catalogRevision'), 'catalog revision is served through the real worker')
  const reading=await request('update',[input.requestId,rows[0].version,{context:{objects:catalog.objects,memories:[],reading:{scannedTaskIds:[],details:[],catalogs:[{key:'requirement:ua',complete:true}]}}}])
  assert.equal((await request('taskBriefs',[input.requestId,{kind:'space',projectId:'ua'}])).items[0].id,'images')
  assert.equal((await request('requests')).length, 1)
  assert.equal(await request('sessionId'), id)
  const routed = await request('update', [input.requestId, reading.version, { state: 'bound', delivery: 'accepted', targetId: 'images' }])
  const attempt = await request('reviewBegin', [routed, id, 'Router rules', [], 'test-version'])
  await request('reviewStep', [input.requestId, 'query', { objects: [{ id: 'images', title: '历史图片' }] }])
  await request('reviewFinish', [routed, []])
  const saved = await request('reviewSave', [{ requestId: input.requestId, attemptId: attempt, expectedRevision: 0, matches: false }])
  assert.equal(saved.feedback.matches, false)
  assert.equal((await request('request', [input.requestId])).version, routed.version)
  assert.equal((await request('reviewList', [{ filter: 'bad' }])).total, 1)
  assert.equal((await request('reviewDetail', [input.requestId, attempt, true])).diagnostics.sections[2].text.includes('历史图片'), true)
  assert.deepEqual(await request('reviewPrompts'), [])
  const exported = await request('reviewExport', [input.requestId])
  assert.equal(JSON.parse(await readFile(join(exported.directory, 'index.json'), 'utf8')).records[0].traces.length, 1)
  const replacement = 's_' + randomUUID()
  await request('replaceSession', [id, replacement])
  assert.equal(await request('sessionId'), replacement)
  assert.deepEqual(await request('sessionNotice'), { sessionId: replacement, kind: 'manual' })
  const switched = 's_' + randomUUID()
  await request('replaceSession', [replacement, switched, undefined, { fromAgentId: 'deepseek', toAgentId: 'codex', switchedAt: 123 }])
  assert.deepEqual(await request('conversationSessions'), [{ sessionId: replacement, agentId: 'deepseek' }, { sessionId: switched, agentId: 'codex', switchedAt: 123 }])
  await assert.rejects(request('replaceSession', [replacement, 'stale-switch', undefined, { fromAgentId: 'codex', toAgentId: 'claude', switchedAt: 124 }]), /会话已变化/)
  assert.equal((await request('conversationSessions')).length, 2)
  await request('replaceSession', [switched, replacement])
  assert.deepEqual(await request('conversationSessions'), [])
  assert.equal((await request('request', [input.requestId])).delivery, 'accepted', 'switching preserves the previous business receipt')
  const retryInput = await request('register', [{ requestId: randomUUID(), prompt: '待接续输入' }, DEFAULT_ROUTER_CONFIG])
  const retry = await request('update', [retryInput.requestId, retryInput.version, { state: 'routing', routerSessionId: replacement }])
  const recovered = 's_' + randomUUID()
  await assert.rejects(request('replaceSession', [replacement, recovered, { requestId: retry.requestId, version: retry.version - 1 }]), /router_revision_conflict/)
  assert.equal(await request('sessionId'), replacement)
  await request('replaceSession', [replacement, recovered, { requestId: retry.requestId, version: retry.version }])
  const queued = await request('request', [retry.requestId])
  assert.equal(queued.state, 'queued')
  assert.equal(queued.recovery.attempts, 1)
  assert.equal(queued.routerSessionId, recovered)
  assert.deepEqual(await request('sessionNotice'), { sessionId: recovered, kind: 'recovery' })
  await request('update', [retry.requestId, queued.version, { state: 'cancelled' }])
  await assert.rejects(request('invalid_method'), /invalid_router_store_method/)
  const config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }
  const sessions = new Map<string, Session>()
  const agent = { id: config.agentId, name: 'DeepSeek', adapter: 'deepseek', installed: true,
    models: [{ id: config.model, label: 'Flash', efforts: ['max'], imageInput: true }], capabilities: { protocol: 'web', startupSystemPrompt: true } } as AgentDef
  const store = new Proxy({} as RouterStore, { get: (_, method: string) => (...args: unknown[]) => request(method, args) })
  const controller = new RouterController(store, { agents: () => [agent], config: () => config, saveConfig() {}, objects: async () => [],
    changed() {}, error(error) { throw error }, newTask: async () => { throw new Error('unexpected task creation') }, recoverTask: async () => undefined,
    orchestrator: { getSessionById: (key: string) => sessions.get(key), managedSessions: () => [...sessions.values()], getEvents: async () => [],
      createRouterDraft: (value: Session['config'], key: string) => {
        if (!sessions.has(key)) sessions.set(key, { id: key, title: 'Router', config: value, status: 'draft', createdAt: 1 })
        return sessions.get(key)!
      }, disposeSession() {}, updateSessionConfig() {}, sendMessage: async () => { throw new Error('unexpected send') } } as any }, directory)
  try {
    const topicInput = await store.register({ requestId: randomUUID(), prompt: 'Feishu worker lookup', feishu: { botAppId: 'worker-bot', chatId: 'worker-chat', rootMessageId: 'worker-root', cardMessageId: 'worker-card', threadId: 'worker-thread' } }, config)
    assert.equal((await store.feishuTopic('worker-bot', 'worker-chat', undefined, undefined, 'worker-thread'))?.requestId, topicInput.requestId)
    assert.equal(await store.feishuTopic('other-bot', 'worker-chat', 'worker-root'), undefined)
    const replacementCard = await store.replaceFeishuCard(topicInput.requestId, 'worker-card', 'worker-card-new')
    assert.equal(replacementCard.version, topicInput.version, 'transport updates cannot invalidate an in-flight allocation')
    assert.equal(replacementCard.feishu?.cardMessageId, 'worker-card-new')
    assert.equal((await store.replaceFeishuCard(topicInput.requestId, 'worker-card', 'stale-card')).feishu?.cardMessageId, 'worker-card-new')
    assert.equal((await store.feishuTopic('worker-bot', 'worker-chat', undefined, 'worker-card-new'))?.requestId, topicInput.requestId)
    assert.equal(await store.feishuTopic('worker-bot', 'worker-chat', undefined, 'worker-card'), undefined)
    const overlapping = await store.register({ requestId: randomUUID(), prompt: 'another request', feishu: { botAppId: 'worker-bot', chatId: 'worker-chat', rootMessageId: 'another-root', cardMessageId: 'another-card', threadId: 'worker-thread' } }, config)
    assert.equal((await store.feishuTopic('worker-bot', 'worker-chat', 'another-root', 'worker-card-new', 'worker-thread'))?.requestId, topicInput.requestId, 'replying to a card takes precedence over a broader topic match')
    await assert.rejects(store.feishuTopic('worker-bot', 'worker-chat', undefined, undefined, 'worker-thread'), /router_topic_ambiguous/)
    await store.update(overlapping.requestId, overlapping.version, { state: 'cancelled' })
    await store.update(topicInput.requestId, topicInput.version, { state: 'cancelled' })
    const deletion = await controller.reviewDeletion([input.requestId])
    assert.equal(deletion.items.length, 1, 'deletion preview crosses Controller and worker RPC')
    assert.deepEqual((await controller.deleteReviews(deletion.items)).deletedIds, [input.requestId])
    await assert.rejects(controller.reviewDetail(input.requestId), /该路由记录已删除/)
    assert.equal((await store.request(input.requestId))?.targetId, 'images', 'review deletion preserves the business target')
    assert.ok(!(await controller.reviewList()).rows.some(row => row.request.requestId === input.requestId))
    await assert.rejects(request('reviewDelete', [[{ requestId: '../invalid', requestVersion: 1, reviewRevision: 0 }]]), /request_id/)
    await controller.open()
    assert.equal((await controller.snapshot()).sessionNotice?.kind, 'recovery', 'the real snapshot path crosses the worker boundary')
    const session = await controller.newSession(recovered)
    assert.notEqual(session.id, recovered)
    const snapshot = await controller.snapshot()
    assert.equal(snapshot.sessionId, session.id)
    assert.deepEqual(snapshot.sessionNotice, { sessionId: session.id, kind: 'manual' })
  } finally { await controller.close() }
  console.log('PASS Router worker: actual snapshot/session replacement RPC, atomic retry, scoped reading, review persistence and method rejection')
} finally { await worker.terminate() }
