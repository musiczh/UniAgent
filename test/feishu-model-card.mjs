import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { normalizeCardAction } from '@larksuiteoapi/node-sdk'

const directory = await mkdtemp(join(tmpdir(), 'uniagent-model-card-'))
globalThis.__feishuModelNormalize = normalizeCardAction
after(async () => {
  delete globalThis.__feishuModelNormalize
  await rm(directory, { recursive: true, force: true })
})
await build({
  entryPoints: ['src/main/feishuBridge.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(directory, 'bridge.mjs'),
  plugins: [{ name: 'transport', setup(builder) {
    builder.onResolve({ filter: /^(electron|@larksuiteoapi\/node-sdk)$/ }, args => ({ path: args.path, namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'electron'
      ? 'export const powerMonitor={on(){},off(){}}; export const systemPreferences={subscribeWorkspaceNotification(){},unsubscribeWorkspaceNotification(){}}'
      : 'export class Client {}; export class WSClient {}; export class EventDispatcher {}; export const defaultHttpInstance={}; export const normalizeCardAction=globalThis.__feishuModelNormalize;' }))
  } }]
})
const { FeishuBridge } = await import(pathToFileURL(join(directory, 'bridge.mjs')).href)
const codex = () => ({
  id: 'codex', name: 'Codex', adapter: 'codex', defaultModel: 'm1',
  capabilities: { modelSelect: true, reasoningEffort: true },
  models: [
    { id: 'm1', label: 'Model 1', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'm2', label: 'Model 2', efforts: ['low', 'medium'], defaultEffort: 'medium', modelSource: { kind: 'native' } },
    { id: 'plain', label: 'Plain model', efforts: [] }
  ]
})
function fixture(t, { assistant = false, group = false, agent = codex(), config = {} } = {}) {
  const session = { id: 's1', status: 'idle', config: { agentId: agent.id, model: agent.models[0].id,
    effort: 'high', permissionMode: 'ask', workdir: '/project', ...(assistant ? { assistantSnapshot: { name: 'Assistant' } } : {}), ...config } }
  const sessions = new Map([[session.id, session]])
  const link = { sessionId: session.id, chatId: 'chat', rootMessageId: 'root', threadId: 'thread',
    replyInThread: !assistant || group, botAppId: 'app', lastPushedSeq: 0 }
  const links = new Map([[session.id, link]])
  const sent = [], patches = [], updates = [], snapshots = [], errors = []
  const settings = { enabled: true, appId: 'app' }
  const orchestrator = {
    getSessionById: id => sessions.get(id),
    forceSend() { assert.fail('/model must not reach an Agent') },
    respondToRequest() { assert.fail('/model must not answer pending questions') },
    async updateSessionConfig(id, patch) {
      updates.push(patch)
      Object.assign(sessions.get(id).config, patch)
      return sessions.get(id)
    }
  }
  const store = {
    bySession: id => links.get(id), all: () => [...links.values()],
    byThread: id => [...links.values()].find(link => link.threadId === id),
    byRootMessage: id => [...links.values()].find(link => link.rootMessageId === id),
    patch(id, value) { Object.assign(links.get(id), value); return links.get(id) }
  }
  const bridge = new FeishuBridge({ orchestrator, threadStore: store, getAgents: () => [agent], getSettings: () => settings,
    onStatus() {}, onSessionUpdated: session => snapshots.push(session), onError: error => errors.push(error),
    ...(assistant ? { createAssistantSession() { assert.fail('/model must not create an assistant session') }, acceptsSession: s => !!s.config.assistantSnapshot } : {}) })
  bridge.clientAppId = 'app'
  const send = async (request, method) => {
    const id = 'msg-' + (sent.length + 1)
    sent.push({ id, method, request, content: JSON.parse(request.data.content) })
    return { code: 0, data: { message_id: id, thread_id: 'thread' } }
  }
  bridge.client = { im: { v1: { message: {
    reply: request => send(request, 'reply'), create: request => send(request, 'create'),
    patch: async request => { patches.push(JSON.parse(request.data.content)); return {} }
  } } } }
  t.after(() => bridge.dispose())
  const inbound = (overrides = {}) => bridge.onInboundMessage({ sender: { sender_type: 'user' }, message: {
    message_id: 'user', chat_id: 'chat', chat_type: group ? 'group' : 'p2p', message_type: 'text',
    content: JSON.stringify({ text: group ? '@_user_1 /model' : ' /model ' }),
    thread_id: 'thread', ...(group ? { mentions: [{ key: '@_user_1' }] } : {}), ...overrides
  } })
  const action = (card, act, option, overrides = {}) => {
    const values = []
    const walk = node => { if (!node || typeof node !== 'object') return; if (node.value?.act === act) values.push(node.value); Object.values(node).forEach(walk) }
    walk(card.content || card)
    assert.equal(values.length, 1, 'card supplies one action for ' + act)
    return bridge.onCardAction({ context: { open_message_id: card.id || sent.at(-1).id, open_chat_id: 'chat' },
      operator: { open_id: 'user' }, action: { value: values[0], option }, ...overrides })
  }
  return { session, sessions, links, link, agent, bridge, sent, patches, updates, snapshots, errors, settings, orchestrator, inbound, action }
}
const tick = () => new Promise(setImmediate)
const named = (card, name) => card.body.elements.find(element => element.name === name)

for (const assistant of [false, true]) for (const group of [false, true]) {
  test(`/model routes ${assistant ? 'assistant' : 'ordinary'} ${group ? 'group topic' : 'private chat'} without answering questions`, async t => {
    const f = fixture(t, { assistant, group })
    f.bridge.pending.set('s1/question', { sessionId: 's1', fields: [{}, {}] })
    await f.inbound()
    const card = f.sent[0]
    assert.equal(card.method, assistant && !group ? 'create' : 'reply')
    assert.equal(card.content.header.title.content, '⚙️ 模型与思考深度')
    assert.equal(named(card.content, 'model').initial_option, 'm1')
    assert.equal(named(card.content, 'depth').initial_option, 'high')
    assert.ok(!JSON.stringify(card.content).includes('当前对话：'), 'approved design omits the conversation row')
    assert.equal(f.updates.length, 0)
    const changed = await f.action(card, 'selectModel', 'm2')
    assert.deepEqual(named(changed.card.data, 'depth').options.map(option => option.value), ['low', 'medium'])
    assert.equal(named(changed.card.data, 'depth').initial_option, 'medium')
    await f.action(card, 'selectDepth', 'low')
    assert.equal(f.session.config.model, 'm1', 'selection is not saved until Apply')
    assert.equal((await f.action(card, 'applyModel')).toast.type, 'info')
    await tick()
    assert.equal(f.session.config.model, 'm2')
    assert.equal(f.session.config.effort, 'low')
    assert.deepEqual(f.session.config.modelSource, { kind: 'native' })
    assert.equal(f.session.config.permissionMode, 'ask')
    assert.equal(f.session.config.workdir, '/project')
    assert.equal(!!f.session.config.assistantSnapshot, assistant)
    assert.equal(f.snapshots.length, 1, 'App receives the saved session')
    assert.match(JSON.stringify(f.patches[0]), /Model 2 · 低/)
    await f.action(card, 'applyModel')
    assert.equal(f.updates.length, 1, 'duplicate Apply is idempotent')
  })
}

test('capability linkage removes unsupported depth and preserves negotiated Kimi / ZCode options', async t => {
  const f = fixture(t)
  await f.inbound()
  const card = f.sent[0]
  const changed = await f.action(card, 'selectModel', 'plain')
  assert.equal(named(changed.card.data, 'depth'), undefined)
  assert.match(JSON.stringify(changed.card.data), /此模型不支持设置思考深度/)
  await f.action(card, 'applyModel'); await tick()
  assert.equal(f.session.config.effort, undefined)
  for (const adapter of ['kimi', 'zcode']) {
    const agent = { ...codex(), id: adapter, adapter, capabilities: { modelSelect: false, reasoningEffort: false } }
    if (adapter === 'kimi') agent.capabilities.modelSelect = true
    const g = fixture(t, { agent, config: { model: 'negotiated', effort: undefined, kimiThinking: 'off',
      zcodeModelSelection: { providerId: 'native-provider', modelId: 'native-id', options: { reasoningLevel: 'off' } } } })
    g.session.agentContract = { models: [{ id: 'negotiated', label: 'Negotiated', efforts: [], thinkingOptions: ['off', 'on'],
      defaultThinking: 'off', zcodeSelection: { providerId: 'native-provider', modelId: 'native-id', options: { reasoningLevel: 'off' } } }], currentModelId: 'negotiated' }
    await g.inbound()
    assert.deepEqual(named(g.sent[0].content, 'depth').options.map(option => option.value), ['off', 'on'])
    await g.action(g.sent[0], 'selectDepth', 'on')
    await g.action(g.sent[0], 'applyModel'); await tick()
    assert.equal(g.session.config.effort, undefined)
    if (adapter === 'kimi') assert.equal(g.session.config.kimiThinking, 'on')
    else assert.deepEqual(g.session.config.zcodeModelSelection, { providerId: 'native-provider', modelId: 'native-id', options: { reasoningLevel: 'on' } })
  }
})

test('busy sessions retain selection; asynchronous apply ACKs before completion and rejects concurrent actions', async t => {
  const f = fixture(t)
  f.session.status = 'running'
  await f.inbound()
  const card = f.sent[0]
  await f.action(card, 'selectModel', 'm2')
  for (const status of ['running', 'queued', 'awaiting-approval', 'cancelling']) {
    f.session.status = status
    assert.match((await f.action(card, 'applyModel')).toast.content, /等待本轮结束/)
  }
  assert.equal(f.updates.length, 0)
  f.session.status = 'idle'
  let finish
  f.orchestrator.updateSessionConfig = async (_id, patch) => {
    f.updates.push(patch)
    await new Promise(resolve => { finish = resolve })
    Object.assign(f.session.config, patch)
    return f.session
  }
  assert.match((await f.action(card, 'applyModel')).toast.content, /正在保存/)
  assert.equal(f.session.config.model, 'm1')
  assert.match((await f.action(card, 'applyModel')).toast.content, /正在保存/)
  assert.match((await f.action(card, 'selectModel', 'plain')).toast.content, /正在保存/)
  assert.match((await f.action(card, 'cancelModel')).toast.content, /正在保存/)
  await f.inbound()
  assert.equal(f.bridge.modelCards.get('s1').messageId, card.id, 'a second /model cannot replace an in-flight save')
  assert.equal(f.updates.length, 1)
  finish(); await tick()
  assert.equal(f.session.config.model, 'm2')
  assert.equal(f.session.config.effort, 'medium')
})

test('cancel, invalid options, missing capabilities, attachments and unbound commands never change configuration', async t => {
  const f = fixture(t)
  await f.inbound()
  const card = f.sent[0]
  assert.equal((await f.action(card, 'selectModel', 'missing')).toast.type, 'error')
  assert.equal((await f.action(card, 'selectDepth', 'ultra')).toast.type, 'error')
  await f.action(card, 'cancelModel')
  await f.action(card, 'applyModel')
  assert.equal(f.updates.length, 0)
  for (const assistant of [true, false]) {
    const g = fixture(t, { assistant })
    g.links.clear()
    await g.inbound({ root_id: 'missing-root' })
    assert.match(JSON.stringify(g.sent[0].content), /先建立对话/)
    assert.equal(g.bridge.modelCards.size, 0)
  }
  const unavailable = fixture(t)
  unavailable.agent.capabilities.modelSelect = false
  await unavailable.inbound()
  assert.match(JSON.stringify(unavailable.sent[0].content), /暂无可选模型/)
  const images = fixture(t)
  await images.inbound({ message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'text', text: '/model' }, { tag: 'img', image_key: 'image' }]] }) })
  assert.match(JSON.stringify(images.sent[0].content), /不支持附件/)
  assert.equal(images.bridge.modelCards.size, 0)
})

test('stale, cross-chat, rebound, forbidden and disconnected cards cannot save', async t => {
  const f = fixture(t)
  await f.inbound()
  const card = f.sent[0]
  assert.equal((await f.action(card, 'applyModel', undefined, { context: { open_message_id: card.id, open_chat_id: 'other' } })).toast.type, 'error')
  assert.equal((await f.action(card, 'applyModel', undefined, { context: { open_message_id: 'other', open_chat_id: 'chat' } })).toast.type, 'error')
  for (const prop of ['archived', 'readOnly']) {
    f.session[prop] = true
    assert.equal((await f.action(card, 'applyModel')).toast.type, 'error')
    f.session[prop] = false
  }
  f.session.config.roleSnapshot = { id: 'role' }
  assert.match((await f.action(card, 'applyModel')).toast.content, /角色/)
  delete f.session.config.roleSnapshot
  await f.inbound()
  assert.equal((await f.action(card, 'applyModel')).toast.type, 'error', 'new card supersedes old selection')
  const latest = f.sent.at(-1)
  f.link.rootMessageId = 'new-root'
  assert.equal((await f.action(latest, 'applyModel')).toast.type, 'error')
  f.link.rootMessageId = 'root'
  await f.bridge.stopNow(true)
  assert.equal((await f.action(latest, 'applyModel')).toast.type, 'error')
  assert.equal(f.updates.length, 0)
  const assistant = fixture(t, { assistant: true })
  await assistant.inbound()
  assistant.links.delete('s1')
  assert.equal((await assistant.action(assistant.sent[0], 'applyModel')).toast.type, 'error', '/new invalidates the old session card')
  assert.equal(assistant.updates.length, 0)
})

test('failed or ignored updates report failure and allow retry; patch failure does not repeat a successful save', async t => {
  const f = fixture(t)
  await f.inbound()
  const card = f.sent[0]
  await f.action(card, 'selectModel', 'm2')
  const save = f.orchestrator.updateSessionConfig
  f.orchestrator.updateSessionConfig = async () => { throw new Error('provider rejected') }
  await f.action(card, 'applyModel'); await tick()
  assert.match(JSON.stringify(f.sent.at(-1).content), /provider rejected/)
  assert.equal(f.session.config.model, 'm1')
  assert.equal(f.patches.length, 0)
  f.orchestrator.updateSessionConfig = async () => f.session
  await f.action(card, 'applyModel'); await tick()
  assert.match(JSON.stringify(f.sent.at(-1).content), /未生效/)
  assert.equal(f.patches.length, 0)
  f.orchestrator.updateSessionConfig = save
  f.bridge.client.im.v1.message.patch = async () => ({ code: 999, msg: 'unavailable' })
  await f.action(card, 'applyModel'); await tick()
  assert.equal(f.session.config.model, 'm2')
  assert.match(JSON.stringify(f.sent.at(-1).content), /已保存/)
  const retry = await f.action(card, 'applyModel')
  assert.match(JSON.stringify(retry.card.data), /Model 2 · 中/)
  assert.equal(f.updates.length, 1)
})
