import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { build } from 'esbuild'

const directory = await mkdtemp(join(tmpdir(), 'uniagent-feishu-dedup-'))
const output = join(directory, 'build')
const transport = { handler: undefined, clients: [], replies: [] }
globalThis.__UNIAGENT_FEISHU_DEDUP_TEST__ = transport
after(async () => {
  delete globalThis.__UNIAGENT_FEISHU_DEDUP_TEST__
  await rm(directory, { recursive: true, force: true })
})

await build({
  entryPoints: ['src/main/feishuBridge.ts', 'src/main/feishuThreadStore.ts', 'src/main/appSettingsStore.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: output,
  plugins: [{
    name: 'feishu-bridge-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      builder.onResolve({ filter: /^@larksuiteoapi\/node-sdk$/ }, () => ({ path: 'lark', namespace: 'stub' }))
      builder.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
        contents: 'export const powerMonitor={on(){},off(){}}; export const systemPreferences={subscribeWorkspaceNotification(){return 1},unsubscribeWorkspaceNotification(){}}'
      }))
      builder.onLoad({ filter: /^lark$/, namespace: 'stub' }, () => ({
        contents: `
          import { writeFile } from 'node:fs/promises';
          const transport = globalThis.__UNIAGENT_FEISHU_DEDUP_TEST__;
          export class EventDispatcher {
            register(handles) { this.handles = handles; return this; }
            async invoke(data) { return this.handles['im.message.receive_v1'](data); }
          }
          export class WSClient {
            constructor(options) { this.options = options; this.closed = false; transport.clients.push(this); }
            async start({ eventDispatcher }) {
              this.dispatcher = eventDispatcher;
              transport.handler = (data) => eventDispatcher.invoke(data);
              transport.cardHandler = (data) => eventDispatcher.handles['card.action.trigger'](data);
              if (!transport.deferReady) this.options.onReady?.();
            }
            close() { this.closed = true; }
          }
          export class Client {
            constructor() {
              this.cardkit = { v1: {
                card: {
                  create: async (request) => {
                    transport.cardCreates = [...(transport.cardCreates || []), request];
                    return { data: { card_id: 'card-' + transport.cardCreates.length } };
                  },
                  settings: async (request) => {
                    transport.cardSettings = [...(transport.cardSettings || []), request];
                    return transport.cardSettingsHook?.(request) ?? {};
                  },
                  update: async (request) => {
                    transport.cardUpdates = [...(transport.cardUpdates || []), request];
                    return transport.cardUpdateHook?.(request) ?? {};
                  }
                },
                cardElement: { content: async (request) => {
                  transport.cardContents = [...(transport.cardContents || []), request];
                  return {};
                } }
              } };
              this.im = { v1: {
                image: { create: async request => {
                  transport.iconUploads = [...(transport.iconUploads || []), request];
                  return { image_key: 'progress-icon-' + transport.iconUploads.length };
                } },
                message: {
                  get: async (request) => transport.rootMessages?.get(request) ?? { data: { items: [] } },
                  update: async (request) => transport.rootMessages?.update(request) ?? { code: 0 },
                  create: async (request) => transport.rootMessages?.create
                    ? transport.rootMessages.create(request) : { data: { message_id: 'bot-created', thread_id: 'thread-1' } },
                  reply: async (request) => {
                    transport.replyAttempts = (transport.replyAttempts || 0) + 1;
                    if (request.data.msg_type === 'interactive') transport.cardReplyAttempts = (transport.cardReplyAttempts || 0) + 1;
                    if (transport.failReplyOnce) { transport.failReplyOnce = false; throw new Error('temporary reply failure'); }
                    if (transport.replyHook) return transport.replyHook(request);
                    transport.replies.push(request); return { data: { message_id: 'bot-reply', thread_id: 'thread-1' } };
                  }
                },
                chat: { list: async ({ params }) => {
                  const page = transport.chatPages?.[params?.page_token || ''] || { items: [], has_more: false };
                  return { data: page };
                } },
                messageResource: { get: async (request) => {
                  transport.downloads = [...(transport.downloads || []), request];
                  return {
                    headers: { 'content-type': 'image/png' },
                    writeFile: (path) => writeFile(path, Buffer.from('image bytes'))
                  };
                } },
                messageReaction: {
                  create: async () => ({ data: { reaction_id: 'reaction-1' } }),
                  delete: async () => ({})
                }
              } };
            }
          }
          export const defaultHttpInstance = {
            defaults: {},
            interceptors: { response: { use() {} } }
          };
          export const normalizeCardAction = (value) => value;
        `
      }))
    }
  }]
})

const stamp = Date.now()
const { FeishuBridge } = await import(`${pathToFileURL(join(output, 'feishuBridge.js')).href}?${stamp}`)
const { FeishuThreadStore } = await import(`${pathToFileURL(join(output, 'feishuThreadStore.js')).href}?${stamp}`)
const { AppSettingsStore } = await import(`${pathToFileURL(join(output, 'appSettingsStore.js')).href}?${stamp}`)

test('team cards bind each native request and preserve partial business answers', async () => {
  const calls = []
  const p = { id: 'project', runId: 1, name: 'Team', status: 'waiting_user', summary: '', goal: 'Goal', team: { leaderMemberId: 'leader', members: [{ id: 'leader', role: { name: 'Leader' } }, { id: 'alpha', role: { name: 'Alpha' } }, { id: 'beta', role: { name: 'Beta' } }] }, memberSessions: { leader: 's-leader', alpha: 's-alpha', beta: 's-beta' }, assignments: [], interactions: [
    { id: 'native-alpha', revision: 1, runId: 1, memberId: 'alpha', sessionId: 's-alpha', requestId: 'req_1_0', kind: 'native_approval', state: 'pending', event: { payload: { kind: 'approval', method: 'mcpServer/elicitation/request', params: { message: 'Allow tool?' } } } },
    { id: 'native-beta', revision: 1, runId: 1, memberId: 'beta', sessionId: 's-beta', requestId: 'req_1_0', kind: 'native_question', state: 'pending', event: { payload: { kind: 'question', params: { questions: [{ id: 'q', question: 'Value?' }] } } } },
    { id: 'business', revision: 3, runId: 1, memberId: 'leader', sessionId: 's-leader', kind: 'leader_question', state: 'pending', questions: [{ id: 'answered', prompt: 'Old?', answer: 'Keep' }, { id: 'next', prompt: 'Next?' }] }
  ] }
  const bridge = new FeishuBridge({ orchestrator: { getSessionById: id => ({ id, status: 'idle', teamBinding: { teamProjectId: p.id } }) }, teams: { binding: () => ({ p }), respond: async (...args) => { calls.push(args); const i=p.interactions.find(i=>i.id===args[1]); i.state='answered'; i.revision++ } }, threadStore: {}, getAgents: () => [], getSettings: () => undefined, onStatus() {} })
  const sent = [], patched = []
  bridge.client = { im: { v1: { message: { reply: async r => { sent.push(r); return { data: { message_id: 'card-' + sent.length } } }, patch: async r => { patched.push(r); return {} } } } } }
  bridge.ensureThread = async () => ({ rootMessageId: 'leader-topic' })
  bridge.replyText = async () => {}
  bridge.clearAck = async () => {}
  await bridge.pushTeamProject(p)
  assert.equal(sent.length, 2, 'only Leader questions and member permissions reach users')
  assert.ok(sent[0].data.uuid, 'interaction delivery has a stable idempotency key')
  assert.ok(sent.every(r => r.path.message_id === 'leader-topic'), 'all members share the Leader topic')
  const actions = []
  const walk = v => { if (!v || typeof v !== 'object') return; if (v.value?.requestId) actions.push(v.value); Object.values(v).forEach(walk) }
  sent.forEach(r => walk(JSON.parse(r.data.content)))
  const approve = actions.find(a => a.teamInteractionId === 'native-alpha' && a.act === 'accept')
  assert.ok(approve, 'MCP permission has an actionable approval button')
  const answer = actions.find(a => a.teamInteractionId === 'native-beta')
  assert.equal(answer, undefined, 'member business question belongs to Leader')
  assert.equal((await bridge.onTeamCardAction('s-alpha', 'req_1_0', approve, {})).toast.type, 'info')
  await new Promise(setImmediate)
  assert.deepEqual(calls[0], ['project', 'native-alpha', 1, { decision: 'accept' }, false, 'feishu'])
  assert.equal((await bridge.onTeamCardAction('s-alpha', 'req_1_0', approve, {})).toast.type, 'error')
  assert.equal(calls.length, 1, 'duplicate card never responds twice')
  const business = actions.find(a => a.teamInteractionId === 'business')
  assert.equal((await bridge.onTeamCardAction('s-leader', 'business', business, { action: { form_value: { f0: 'New' } } })).toast.type, 'info')
  await new Promise(setImmediate)
  assert.deepEqual(calls[1][3], { next: 'New' }, 'already answered fields are not resent')
  await bridge.pushTeamProject(p)
  assert.equal(patched.length, 2, 'resolved requests patch their original cards')
  assert.equal(JSON.parse(patched[1].data.content).header.title.content, '✅ 已回答', 'team Feishu answers keep their source')
  const appQuestion = p.interactions.find(i => i.id === 'business')
  appQuestion.questions[1].answer = 'App answer'
  appQuestion.revision++
  bridge.teamCards.get(appQuestion.id).source = undefined
  bridge.deps.threadStore.bySession = () => ({ rootMessageId: 'leader-topic' })
  await bridge.pushTeamProject(p, true)
  const appCard = JSON.parse(patched.at(-1).data.content)
  assert.equal(appCard.header.title.content, '✅ 已在 UniAgent App 回复')
  assert.ok(appCard.body.elements[0].content.includes('App answer'))
  assert.ok(appCard.body.elements[0].content.includes('Keep'), 'all submitted team answers remain visible')
  assert.equal(sent.length, 2, 'gate-closed updates never send a new card')
  bridge.deps.teams.catalog = () => ({ projects: [p] })
  bridge.deps.orchestrator.getSessionById = () => undefined
  bridge.shouldPushFor = () => true
  bridge.handleTeamChanged()
  assert.equal(bridge.pushChains.size, 0, 'projects without a Leader session must not enqueue notifications')
  assert.equal(await bridge.pushTeamProject(p), false, 'a missing Leader also skips already-queued pushes')
  bridge.dispose()
})

test('team inbox injection preserves the Feishu conversation driver', () => {
  let driver = 'app'
  const bridge = new FeishuBridge({
    orchestrator: { getSessionById: id => ({ id, teamBinding: { teamProjectId: 'p' } }) },
    teams: { binding: () => ({ leader: true }) },
    threadStore: { patch: (_id, patch) => { driver = patch.driver } },
    getAgents: () => [], getSettings: () => ({ enabled: false }), onStatus() {}
  })
  const message = source => ({ sessionId: 'leader', seq: 1, ts: Date.now(), type: 'user_message', payload: { text: 'Input', source } })
  bridge.handleEvent(message('feishu'))
  assert.equal(driver, 'feishu')
  bridge.handleEvent(message('mcp'))
  assert.equal(driver, 'feishu', 'automatic member delivery cannot change the human input channel')
  bridge.handleEvent(message('app'))
  assert.equal(driver, 'app')
  bridge.dispose()
})

test('team interaction transport retries retain their request uuid', async () => {
  const p = { id: 'retry-project', runId: 1, name: 'Team', team: { leaderMemberId: 'leader', members: [{ id: 'leader', role: { name: 'Leader' } }] }, memberSessions: { leader: 's-leader' }, assignments: [], interactions: [{ id: 'question', revision: 1, runId: 1, memberId: 'leader', sessionId: 's-leader', kind: 'leader_question', state: 'pending', questions: [{ id: 'q', prompt: 'Continue?' }] }] }
  const attempts = []
  const bridge = new FeishuBridge({ orchestrator: { getSessionById: id => ({ id, status: 'idle' }) }, teams: { binding: () => ({ p }) }, threadStore: {}, getAgents: () => [], getSettings: () => undefined, onStatus() {} })
  bridge.client = { im: { v1: { message: { reply: async request => {
    attempts.push(request.data.uuid)
    if (attempts.length === 1) throw new Error('temporary transport failure')
    return { data: { message_id: 'question-card' } }
  } } } } }
  bridge.ensureThread = async () => ({ rootMessageId: 'leader-topic' })
  bridge.replyText = async () => {}
  bridge.clearAck = async () => {}
  await assert.rejects(bridge.pushTeamProject(p), /temporary transport/)
  assert.equal(await bridge.pushTeamProject(p), true)
  assert.equal(attempts[0], attempts[1])
  bridge.dispose()
})

const agent = {
  id: 'codex',
  name: 'Codex',
  adapter: 'codex',
  lifecycle: { availability: 'available' },
  capabilities: { permissionModes: [{ id: 'full-access' }], modelSelect: false },
  models: []
}
const message = (messageId, eventId = messageId) => ({
  event_id: eventId,
  sender: { sender_type: 'user' },
  message: {
    message_id: messageId,
    chat_id: 'chat-1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: 'hello' })
  }
})
const makeBridge = (threadStore, getAgents, createSession, orchestrator = {}) => new FeishuBridge({
  orchestrator: { createSession, listSessions: () => [], latestUserMessageText: () => '', ...orchestrator,
    getSessionById: (...args) => { const session = orchestrator.getSessionById?.(...args); return session && !session.config ? { ...session, config: { workdir: directory } } : session } },
  threadStore,
  getAgents,
  getSettings: () => ({ enabled: true, appId: 'cli_1234567890abcdef', appSecret: 'secret' }),
  onStatus: () => {},
  onLog: (sessionId, kind, data) => {
    transport.logs = [...(transport.logs || []), { sessionId, kind, data }]
  }
})
const emit = async (data) => {
  await transport.handler(data)
  await new Promise(setImmediate)
}
// 需求 — a new top-level message now offers a config card (im.message.reply) rather
// than creating a session blind; the session is created later when the user presses
// 开始 on the card. The inbound dedup/ACK machinery is unchanged, so these tests
// count the card offer (a reply anchored on the user's message) as the business
// action that must fire exactly once and stay retryable.
const offers = () => transport.replies.filter((r) => r?.path?.message_id?.startsWith('om-')).length
const offersFor = (id) => transport.replies.filter((r) => r?.path?.message_id === id).length

const notificationFixture = async (t, name, initial = {}) => {
  const settings = new AppSettingsStore(join(directory, name))
  settings.set({ feishu: { enabled: true, appId: 'cli_binding', appSecret: 'fixture', notifyOnlyWhenLocked: false, ...initial } })
  const store = new FeishuThreadStore(join(directory, name))
  const status = []
  const bridge = new FeishuBridge({
    orchestrator: { getSessionById: () => undefined, listSessions: () => [] },
    threadStore: store, getAgents: () => [], getSettings: () => settings.get().feishu,
    onStatus: value => status.push(value),
    saveNotificationTarget: target => settings.set({ feishu: {
      notifyChatId: target?.chatId || '', notifyChatType: target?.kind, notifyChatName: target?.name || ''
    } })
  })
  await bridge.start()
  t.after(() => bridge.dispose())
  return { bridge, settings, store, status }
}

test('private notification binding persists without creating a session or requiring an Agent', async t => {
  const { bridge, settings, store, status } = await notificationFixture(t, 'notification-private')
  bridge.beginNotificationBinding({ kind: 'private' })
  assert.equal(bridge.getStatus().notificationTarget, undefined, 'opening the guide is not a successful binding')
  await emit(message('om-notification-private'))
  assert.deepEqual(bridge.getStatus().notificationTarget, { kind: 'private', chatId: 'chat-1', name: undefined })
  assert.equal(bridge.getStatus().notificationBinding, undefined)
  assert.equal(status.at(-1).notificationTarget.chatId, 'chat-1', 'success is pushed to the renderer')
  assert.equal(offersFor('om-notification-private'), 0, 'binding text never offers a new task')
  assert.equal(store.all().length, 0, 'the target does not depend on a session')
  assert.equal(store.hasHandledInbound('om-notification-private'), true)
  assert.equal(new AppSettingsStore(join(directory, 'notification-private')).get().feishu.notifyChatType, 'private')
  assert.equal(bridge.fallbackChatId(), settings.get().feishu.notifyChatId)
  await bridge.start()
  assert.equal(bridge.getStatus().notificationTarget.chatId, 'chat-1', 'the saved target survives reconnects')
  let outbound
  bridge.client.im.v1.message.create = async request => {
    outbound = request
    return { data: { message_id: 'notification-root', thread_id: 'notification-thread' } }
  }
  const link = await bridge.ensureThread({ id: 'app-after-binding', config: {}, title: '新任务' })
  assert.equal(outbound.data.receive_id, 'chat-1', 'the next App task uses the saved DM destination')
  assert.equal(outbound.params.receive_id_type, 'chat_id')
  assert.equal(link.rootMessageId, 'notification-root')
})

test('selecting a group persists the notification target immediately without consuming a group message', async t => {
  const { bridge, settings } = await notificationFixture(t, 'notification-group', { notifyChatId: 'old-private', notifyChatType: 'private' })
  const existing = { id: 'existing-app-session', config: {}, title: '已有会话' }
  await bridge.ensureThread(existing)
  bridge.beginNotificationBinding({ kind: 'group' })
  assert.equal(settings.get().feishu.notifyChatId, 'old-private', 'opening the group picker preserves the old target')
  const result = bridge.beginNotificationBinding({ kind: 'group', chatId: 'group-selected', name: '项目群' })
  assert.deepEqual(result.notificationTarget, { kind: 'group', chatId: 'group-selected', name: '项目群' })
  assert.equal(result.notificationBinding, undefined, 'selecting a group finishes binding without waiting for a message')
  assert.equal(new AppSettingsStore(join(directory, 'notification-group')).get().feishu.notifyChatId, 'group-selected')
  bridge.deps.getAgents = () => [agent]
  const group = (id, chatId, mentions = [{ key: '@_user_1' }]) => ({ ...message(id), message: {
    ...message(id).message, chat_type: 'group', chat_id: chatId, mentions,
    content: JSON.stringify({ text: '@_user_1 绑定通知' })
  } })
  await emit(group('om-binding-no-mention', 'group-selected', []))
  assert.equal(offersFor('om-binding-no-mention'), 0)
  await emit(group('om-binding-other-group', 'group-other'))
  assert.equal(offersFor('om-binding-other-group'), 1, 'unrelated conversations retain their task flow')
  await emit(group('om-binding-selected', 'group-selected'))
  assert.deepEqual(bridge.getStatus().notificationTarget, { kind: 'group', chatId: 'group-selected', name: '项目群' })
  assert.equal(offersFor('om-binding-selected'), 1, 'the next group message follows the normal task flow')
  assert.equal(bridge.fallbackChatId(), 'group-selected')
  assert.equal((await bridge.ensureThread(existing)).chatId, 'old-private', 'switching destinations preserves existing topics')
  assert.equal((await bridge.ensureThread({ id: 'new-app-session', config: {}, title: '新会话' })).chatId, 'group-selected')
})

test('failed group selection preserves the original target and allows retry without a message', async t => {
  const { bridge, status } = await notificationFixture(t, 'notification-group-save-failure', { notifyChatId: 'old-private', notifyChatType: 'private' })
  bridge.beginNotificationBinding({ kind: 'group' })
  const save = bridge.deps.saveNotificationTarget
  for (const [persist, error] of [[() => { throw new Error('disk unavailable') }, /disk unavailable/], [() => {}, /绑定未能保存/]]) {
    bridge.deps.saveNotificationTarget = persist
    const before = status.length
    assert.throws(() => bridge.beginNotificationBinding({ kind: 'group', chatId: 'group-selected', name: '项目群' }), error)
    assert.equal(bridge.getStatus().notificationTarget.chatId, 'old-private')
    assert.deepEqual(bridge.getStatus().notificationBinding, { kind: 'group' })
    assert.equal(status.length, before, 'failed persistence must not publish a successful binding')
  }
  bridge.deps.saveNotificationTarget = save
  const result = bridge.beginNotificationBinding({ kind: 'group', chatId: 'group-selected', name: '项目群' })
  assert.equal(result.notificationBinding, undefined)
  assert.equal(result.notificationTarget.chatId, 'group-selected')
  assert.equal(status.at(-1).notificationTarget.chatId, 'group-selected')
})

test('cancel and unbind cannot silently reuse a previously learned notification target', async t => {
  const { bridge, settings } = await notificationFixture(t, 'notification-cancel', { notifyChatId: 'old-group' })
  bridge.beginNotificationBinding({ kind: 'private' })
  bridge.cancelNotificationBinding()
  assert.equal(settings.get().feishu.notifyChatId, 'old-group')
  bridge.deps.getAgents = () => [agent]
  await emit(message('om-binding-cancelled'))
  assert.equal(offersFor('om-binding-cancelled'), 1)
  assert.equal(settings.get().feishu.notifyChatId, 'old-group')
  bridge.unbindNotificationTarget()
  assert.equal(bridge.getStatus().notificationTarget, undefined)
  assert.equal(bridge.fallbackChatId(), undefined, 'explicit unbind must not fall back to an old DM')
  bridge.deps.orchestrator.getSessionById = id => ({ id, config: {} })
  bridge.handleEvent({ sessionId: 'unbound-app', seq: 1, type: 'turn_started', state: 'running', payload: {} })
  assert.equal(bridge.progressCards.size, 0, 'unbound App tasks do not retry delivery without a destination')
})

test('failed target persistence keeps the guide and original target and consumes only the binding message', async t => {
  const { bridge, store } = await notificationFixture(t, 'notification-save-failure', { notifyChatId: 'old-group' })
  bridge.beginNotificationBinding({ kind: 'private' })
  const save = bridge.deps.saveNotificationTarget
  bridge.deps.saveNotificationTarget = () => { throw new Error('disk unavailable') }
  await emit(message('om-binding-save-failure'))
  assert.equal(bridge.getStatus().notificationTarget.chatId, 'old-group')
  assert.match(bridge.getStatus().notificationBinding.error, /绑定未完成/)
  assert.equal(offersFor('om-binding-save-failure'), 0)
  assert.equal(store.hasHandledInbound('om-binding-save-failure'), true)
  bridge.deps.saveNotificationTarget = save
  await emit(message('om-binding-save-retry'))
  assert.equal(bridge.getStatus().notificationTarget.chatId, 'chat-1')
})

test('notification binding requires saved settings with the expected chat and type before reporting success', async t => {
  const { bridge, settings } = await notificationFixture(t, 'notification-save-verification')
  const getSettings = bridge.deps.getSettings
  const save = bridge.deps.saveNotificationTarget
  for (const saved of [undefined, { notifyChatId: 'other-chat', notifyChatType: 'private' }, { notifyChatId: 'chat-1', notifyChatType: 'group' }]) {
    bridge.deps.getSettings = getSettings
    bridge.beginNotificationBinding({ kind: 'private' })
    bridge.deps.saveNotificationTarget = () => { bridge.deps.getSettings = () => saved }
    assert.equal(bridge.completeNotificationBinding(message('om-binding-unverified')), true)
    assert.equal(bridge.getStatus().notificationBinding.kind, 'private')
    assert.match(bridge.getStatus().notificationBinding.error, /绑定未完成/)
    assert.equal(settings.get().feishu.notifyChatId, undefined)
  }
  bridge.deps.getSettings = getSettings
  bridge.deps.saveNotificationTarget = save
  await emit(message('om-binding-verified-retry'))
  assert.equal(bridge.getStatus().notificationBinding, undefined)
  assert.equal(bridge.getStatus().notificationTarget.chatId, 'chat-1')
})

test('notification binding validates input, ignores empty messages and resets when the bot changes', async t => {
  const { bridge, settings } = await notificationFixture(t, 'notification-validation')
  assert.throws(() => bridge.beginNotificationBinding({ kind: 'invalid' }), /绑定方式/)
  for (const chatId of ['', '   ', 'a'.repeat(201), null, 1]) {
    assert.throws(() => bridge.beginNotificationBinding({ kind: 'group', chatId }), /绑定方式/)
    assert.equal(bridge.getStatus().notificationTarget, undefined, 'an invalid selection cannot create a notification target')
  }
  bridge.beginNotificationBinding({ kind: 'group' })
  bridge.deps.getAgents = () => [agent]
  await emit({ ...message('om-binding-empty'), message: { ...message('om-binding-empty').message, content: JSON.stringify({ text: '   ' }) } })
  assert.equal(bridge.getStatus().notificationBinding.kind, 'group')
  settings.set({ feishu: { appId: 'cli_replacement' } })
  await bridge.start()
  assert.equal(bridge.getStatus().notificationBinding, undefined)
  assert.equal(bridge.fallbackChatId(), undefined)
  await bridge.stop()
  assert.throws(() => bridge.beginNotificationBinding({ kind: 'private' }), /未连接/)
})

const assertFeishuPrompt = (prompt, text) => {
  const marker = '\n\n<uniagent_feishu_context>\n'
  const offset = prompt.indexOf(marker)
  assert.ok(offset > 0, 'the bridge appends Feishu context after the user message')
  assert.equal(prompt.slice(0, offset), text || '[图片]')
  assert.equal(prompt.slice(offset + marker.length),
    '本条消息来自飞书；图片、文件用 send_to_feishu 回传当前话题，不带此context的消息为非飞书发送消息。 回复将发送到飞书，正文不得引用本地文件路径、file:// URL 或本地 Markdown 链接、图片；需要用户查看或下载的图片、设计稿、文档等文件，必须用 send_to_feishu 单独发送，正文只写文件名和必要说明。只有发送成功后才可声称附件已发送；失败时说明原因，不用本地链接替代。\n</uniagent_feishu_context>')
}

test('session titles edit only bot-owned roots, coalesce changes and survive reconnects', async () => {
  const stateDir = join(directory, 'title-sync-state')
  const store = new FeishuThreadStore(stateDir)
  const session = { id: 'session-title', title: '最新标题' }
  store.upsert({ sessionId: session.id, chatId: 'chat-1', rootMessageId: 'root-title', lastPushedSeq: 9, driver: 'feishu' })
  const bridge = makeBridge(store, () => [agent], () => {}, { getSessionById: () => session })
  const edits = []
  let reads = 0
  let failure
  let blockEdit
  const messages = {
    get: async ({ path }) => {
      reads++
      return { data: { items: [{
        message_id: path.message_id, msg_type: 'text',
        sender: { sender_type: 'app', id_type: 'app_id', id: 'cli_1234567890abcdef' },
        body: { content: JSON.stringify({ text: '🧵 初始标题' }) }
      }] } }
    },
    update: async (request) => {
      if (blockEdit) await blockEdit
      if (failure) return failure
      edits.push(request)
      return { code: 0 }
    }
  }
  transport.rootMessages = messages
  await bridge.start()
  const flush = async () => { await bridge.pushChains.get(session.id) }
  try {
    await flush()
    assert.equal(reads, 1, 'legacy roots are inspected even after Feishu takes over the session')
    assert.deepEqual(edits.map((edit) => [edit.path.message_id, JSON.parse(edit.data.content).text]),
      [['root-title', '🧵 最新标题']])
    assert.equal(store.bySession(session.id).lastPushedSeq, 9, 'title edits preserve reply deduplication')

    bridge.handleSessionUpdated(session)
    await flush()
    assert.equal(edits.length, 1, 'unchanged titles do not consume the twenty-edit quota')
    session.title = '中间标题'
    bridge.handleSessionUpdated(session)
    session.title = '最终标题'
    bridge.handleSessionUpdated(session)
    await flush()
    assert.equal(edits.length, 2)
    assert.equal(JSON.parse(edits.at(-1).data.content).text, '🧵 最终标题')
    assert.equal(new FeishuThreadStore(stateDir).bySession(session.id).rootTitle, '最终标题')

    failure = { code: 300120, msg: 'Server Internal Error' }
    session.title = '失败后重试'
    bridge.handleSessionUpdated(session)
    await flush()
    assert.equal(store.bySession(session.id).rootTitle, '最终标题', 'business errors must not mark a title as synced')
    assert.ok(store.bySession(session.id).rootTitleRetryAt > Date.now())
    const queued = bridge.pushChains.get(session.id)
    bridge.handleSessionUpdated(session)
    assert.equal(bridge.pushChains.get(session.id), queued, 'cooldown prevents another title push')
    failure = undefined
    await bridge.stop()
    session.title = '离线改名'
    await bridge.start()
    await flush()
    assert.equal(store.bySession(session.id).rootTitle, '最终标题', 'reconnect must preserve the cooldown')
    store.patch(session.id, { rootTitleRetryAt: Date.now() - 1 })
    bridge.handleSessionUpdated(session)
    await flush()
    assert.equal(reads, 1, 'persisted ownership avoids re-reading the root')
    assert.equal(JSON.parse(edits.at(-1).data.content).text, '🧵 离线改名')

    let releaseEdit
    blockEdit = new Promise((resolve) => { releaseEdit = resolve })
    session.title = '正在提交的标题'
    bridge.handleSessionUpdated(session)
    await new Promise(setImmediate)
    session.title = '离线改名'
    bridge.handleSessionUpdated(session)
    releaseEdit()
    await flush()
    blockEdit = undefined
    assert.equal(JSON.parse(edits.at(-1).data.content).text, '🧵 离线改名', 'reverting during an in-flight edit must also sync')

    const beforeForeign = edits.length
    store.patch(session.id, { rootAppId: 'cli_other_bot', rootTitle: '其他机器人的标题' })
    bridge.handleSessionUpdated(session)
    await flush()
    store.patch(session.id, { rootAppId: undefined, rootTitle: undefined })
    messages.get = async () => ({ data: { items: [{
      message_id: 'root-title', msg_type: 'text',
      sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_user' },
      body: { content: JSON.stringify({ text: '🧵 用户自己的消息' }) }
    }] } })
    bridge.handleSessionUpdated(session)
    await flush()
    assert.equal(store.bySession(session.id).rootAppId, null)
    assert.equal(edits.length, beforeForeign, 'user messages and another bot’s roots are never edited')

    store.remove(session.id)
    session.title = '创建时标题'
    let finishCreate
    messages.create = async () => new Promise((resolve) => { finishCreate = resolve })
    bridge.deps.getSettings = () => ({ enabled: true, appId: 'cli_1234567890abcdef', notifyChatId: 'chat-1' })
    const creating = bridge.ensureThread(session)
    await new Promise(setImmediate)
    session.title = '创建期间改名'
    bridge.handleSessionUpdated(session)
    finishCreate({ data: { message_id: 'new-root' } })
    await creating
    await flush()
    assert.equal(edits.at(-1).path.message_id, 'new-root')
    assert.equal(JSON.parse(edits.at(-1).data.content).text, '🧵 创建期间改名')
  } finally {
    delete transport.rootMessages
    await bridge.stop()
    bridge.dispose()
  }
})

test('expired or edit-exhausted title roots stop retrying across queued updates and restarts', async () => {
  for (const code of [230075, 230072]) {
    const stateDir = join(directory, `title-limit-${code}`)
    const session = { id: `title-limit-${code}`, title: 'New title' }
    const link = { sessionId: session.id, chatId: 'chat-1', rootMessageId: 'old-root',
      rootAppId: 'cli_1234567890abcdef', rootTitle: 'Old title', lastPushedSeq: 9, driver: 'feishu' }
    const store = new FeishuThreadStore(stateDir)
    store.upsert(link)
    let attempts = 0
    transport.rootMessages = { update: async () => {
      attempts++
      if (code === 230075) throw Object.assign(new Error('HTTP 400'), { response: { status: 400, data: { code } } })
      return { code, msg: 'edit limit' }
    } }
    const bridge = makeBridge(store, () => [agent], () => {}, { getSessionById: () => session })
    let restarted
    try {
      await bridge.start()
      for (let i = 0; i < 100; i++) bridge.handleSessionUpdated(session)
      await bridge.pushChains.get(session.id)
      assert.equal(attempts, 1, 'queued updates must not retry a permanent rejection')
      assert.deepEqual(store.bySession(session.id), { ...link, rootTitleSyncBlocked: true, rootTitleRetryAt: undefined })
      await bridge.replyText(store.bySession(session.id), 'Replies still work')
      assert.equal(transport.replies.at(-1).path.message_id, 'old-root', 'keep the original conversation')
      await bridge.stop()
      const restored = new FeishuThreadStore(stateDir)
      restarted = makeBridge(restored, () => [agent], () => {}, { getSessionById: () => session })
      await restarted.start()
      session.title = 'Another rename'
      restarted.handleSessionUpdated(session)
      await restarted.syncThreadTitle(session.id)
      assert.equal(attempts, 1, 'restart and another rename must preserve the stop flag')
      restored.upsert({ ...link, rootMessageId: 'new-root' })
      transport.rootMessages.update = async () => { attempts++; return { code: 0 } }
      restarted.handleSessionUpdated(session)
      await restarted.pushChains.get(session.id)
      assert.equal(attempts, 2, 'a new root has its own edit quota')
      assert.equal(restored.bySession(session.id).rootTitle, 'Another rename')
    } finally {
      delete transport.rootMessages
      await bridge.stop()
      bridge.dispose()
      await restarted?.stop()
      restarted?.dispose()
    }
  }
})

test('MCP sends require the current Feishu turn even after queuing or uploading', async () => {
  const sessionId = 'session-send-scope'
  const store = new FeishuThreadStore(join(directory, 'send-scope-state'))
  store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: 'om-send-scope', lastPushedSeq: 0, driver: 'feishu' })
  let turn
  const bridge = makeBridge(store, () => [agent], () => {}, {
    getSessionById: () => ({ id: sessionId, config: { workdir: directory } }),
    getFeishuSendTurn: () => turn
  })
  await bridge.start()
  const repliesBefore = transport.replies.length
  try {
    await assert.rejects(bridge.sendToSession(sessionId, '不可发送', [], 100), /当前消息不是飞书消息/)
    turn = { ts: 100 }
    await assert.rejects(bridge.sendToSession(sessionId, '过期请求', [], 99), /禁止发送到飞书/)
    assert.equal(transport.replies.length, repliesBefore)
    assert.deepEqual(await bridge.sendToSession(sessionId, '当前飞书轮次', [], 100), ['文案'])

    let releaseQueue
    bridge.pushChains.set(sessionId, new Promise((resolve) => { releaseQueue = resolve }))
    const pending = bridge.sendToSession(sessionId, '不能跨轮次发送', [], 100)
    const rejected = assert.rejects(pending, /禁止发送到飞书/)
    turn = { ts: 101 }
    releaseQueue()
    await rejected
    assert.equal(transport.replies.length, repliesBefore + 1)

    const imagePath = join(directory, 'send-scope.png')
    await writeFile(imagePath, 'fixture image')
    let releaseUpload
    let startedUpload
    const uploading = new Promise((resolve) => { startedUpload = resolve })
    bridge.client.im.v1.image = { create: async () => {
      startedUpload()
      return new Promise((resolve) => { releaseUpload = () => resolve({ image_key: 'img-scope' }) })
    } }
    const upload = bridge.sendToSession(sessionId, undefined, [imagePath], 101)
    const uploadRejected = assert.rejects(upload, /禁止发送到飞书/)
    await uploading
    turn = undefined
    releaseUpload()
    await uploadRejected
    assert.equal(transport.replies.length, repliesBefore + 1, 'a completed upload must not send after desktop takeover')

    bridge.handleEvent({ sessionId, seq: 1, ts: 1, type: 'user_message', payload: { text: 'desktop', source: 'app' } })
    assert.equal(store.bySession(sessionId).driver, 'app', 'desktop delivery removes sticky Feishu notification ownership')
  } finally {
    await bridge.stop()
  }
})

test('a card callback ACKs before forwarding the answer', async () => {
  let responses = 0
  const store = new FeishuThreadStore(join(directory, 'card-ack-state'))
  store.upsert({ sessionId: 'session-card', chatId: 'chat-1', rootMessageId: 'ack-root', lastPushedSeq: 0, driver: 'feishu' })
  const bridge = makeBridge(
    store,
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config }),
    { getSessionById: () => ({ id: 'session-card', status: 'awaiting-approval' }), respondToRequest: () => { responses += 1; return { handled: true } } }
  )
  await bridge.start()

  bridge.handleEvent({ sessionId: 'session-card', seq: 1, ts: Date.now(), type: 'approval_request', state: 'pending', payload: { requestId: 'request-card', kind: 'question', params: { questions: [{ id: 'q', question: 'Answer?' }] } } })
  await new Promise(setImmediate)
  const ack = await transport.cardHandler({
    action: {
      value: { sessionId: 'session-card', requestId: 'request-card', requestSeq: 1, kind: 'question', act: 'submitQuestion' },
      form_value: { f0: 'answer' }
    }
  })

  assert.equal(responses, 0, 'the Feishu ACK must settle before answer forwarding starts')
  assert.equal(ack.toast.content, '正在向 Agent 提交，请等待确认')
  assert.equal(ack.card, undefined, 'the ACK leaves the pending card interactive until provider confirmation')
  await new Promise(setImmediate)
  assert.equal(responses, 1)
})

test('question cards sync App answers in place, reject stale clicks and retain safe summaries', async () => {
  const cases = [
    {
      kind: 'question',
      params: { questions: [
        { id: 'mode', header: '展示方式', question: '如何展示调用链路？', options: [{ label: '默认折叠（推荐）' }] },
        { id: 'details', question: '保留哪些摘要？', multiSelect: true, options: [{ label: '名称' }, { label: '耗时' }] },
        { id: 'other', question: '其他要求？', allowOther: true, options: [{ label: '无' }] },
        { id: 'note', question: '补充说明？' },
        { id: 'optional', question: '可选备注？', required: false },
        { id: 'secret', question: '访问密钥？', isSecret: true }
      ] },
      form: { f0: '默认折叠（推荐）', f1: ['名称', '耗时'], f2: '__other__', o2: '<at id=all></at> **自定义** & 内容', f3: '第一行\n第二行', f5: 'private-token' },
      visible: ['展示方式', '如何展示调用链路？', '默认折叠（推荐）', '保留哪些摘要？', '名称、耗时', '其他要求？', '&lt;at id=all&gt;&lt;/at&gt; \\*\\*自定义\\*\\* &amp; 内容', '补充说明？', '第一行\n第二行', '可选备注？', '未填写', '访问密钥？', '已隐藏'],
      answer: { answers: {
        mode: { answers: ['默认折叠（推荐）'] }, details: { answers: ['名称', '耗时'] },
        other: { answers: ['<at id=all></at> **自定义** & 内容'] }, note: { answers: ['第一行\n第二行'] },
        optional: { answers: [] }, secret: { answers: ['private-token'] }
      } }
    },
    {
      kind: 'elicitation',
      params: { requestedSchema: { properties: {
        env: { title: '环境', description: '选择环境？', enum: ['dev', 'prod'], enumNames: ['开发', '生产'] },
        tags: { title: '标签', type: 'array', items: { enum: ['a', 'b'], enumNames: ['标签甲', '标签乙'] } },
        token: { title: '密钥', type: 'string', format: 'password' }
      } } },
      form: { f0: 'dev', f1: ['a', 'b'], f2: 'private-token' },
      visible: ['环境', '选择环境？', '开发', '标签甲、标签乙', '密钥', '已隐藏'],
      answer: { action: 'accept', content: { env: 'dev', tags: ['a', 'b'], token: 'private-token' } }
    }
  ]
  for (const fixture of cases) {
    const sessionId = `summary-${fixture.kind}`
    const requestId = `request-${fixture.kind}`
    const store = new FeishuThreadStore(join(directory, sessionId))
    store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: sessionId, lastPushedSeq: 0, driver: 'feishu' })
    const responses = []
    const bridge = makeBridge(store, () => [agent], () => {}, {
      getSessionById: () => ({ id: sessionId }),
      respondToRequest: (...args) => { responses.push(args); return { handled: true } }
    })
    await bridge.start()
    const patches = []
    bridge.client.im.v1.message.patch = async request => { patches.push(request); return {} }
    try {
      const event = { sessionId, seq: 1, type: 'approval_request', state: 'pending', payload: {
        requestId, kind: fixture.kind, params: fixture.params, method: 'item/tool/requestUserInput'
      } }
      bridge.handleEvent(event)
      await new Promise(setImmediate)
      const sent = JSON.parse(transport.replies.at(-1).data.content)
      const submit = sent.body.elements[0].elements.find((element) => element.name === 'submitQuestion')
      const ack = await transport.cardHandler({
        context: { open_message_id: 'bot-reply', open_chat_id: 'chat-1' },
        operator: { open_id: 'user-1' },
        action: { value: submit.behaviors[0].value, form_value: fixture.form }
      })
      assert.equal(responses.length, 0, 'card summary must not delay the ACK behind provider forwarding')
      assert.equal(ack.card, undefined, 'provider confirmation owns the final card')
      assert.equal(patches.length, 0, 'the callback must not patch before provider acceptance')
      await new Promise(setImmediate)
      await bridge.pushChains.get(sessionId)
      const resolvedCardData = JSON.parse(patches.at(-1).data.content)
      assert.equal(resolvedCardData.schema, '2.0')
      assert.equal(resolvedCardData.config.update_multi, true)
      const summary = resolvedCardData.body.elements.map((element) => element.content).join('\n')
      for (const text of fixture.visible) assert.ok(summary.includes(text), `missing summary content: ${text}`)
      assert.ok(!JSON.stringify(resolvedCardData).includes('private-token'), 'secret answers must not appear anywhere in the resolvedCardData card')
      assert.ok(!summary.includes('<at'), 'submitted text must not create mentions')
      assert.ok(resolvedCardData.body.elements.every((element) => element.tag === 'markdown'), 'submitted cards are read-only')
      const duplicate = await transport.cardHandler({ action: { value: submit.behaviors[0].value, form_value: fixture.form } })
      assert.equal(duplicate.card, undefined)
      await new Promise(setImmediate)
      assert.deepEqual(responses, [[sessionId, requestId, fixture.answer, { source: 'feishu' }]], 'a settled card forwards exactly one unchanged answer')
      bridge.handleEvent({ ...event, state: 'success', payload: { ...event.payload, submittedAnswer: fixture.answer } })
      await bridge.pushChains.get(sessionId)
      assert.deepEqual(JSON.parse(patches.at(-1).data.content), resolvedCardData, 'Feishu submission must retain its own source and summary')
      patches.length = 0

      const appEvent = { ...event, seq: 2, payload: { ...event.payload, requestId: requestId + '-app' } }
      bridge.handleEvent(appEvent)
      await bridge.pushChains.get(sessionId)
      const before = transport.replies.length
      const action = JSON.parse(transport.replies.at(-1).data.content).body.elements[0].elements.at(-1).behaviors[0].value
      bridge.shouldPushFor = () => false
      // Providers emit raw success before the merged event carrying the answer.
      bridge.handleEvent({ ...appEvent, state: 'success', payload: { requestId: appEvent.payload.requestId, resolved: true } })
      await bridge.pushChains.get(sessionId)
      assert.equal(patches.length, 0, 'raw success must not consume the question before its answer arrives')
      const resolved = { ...appEvent, state: 'success', payload: { ...appEvent.payload, submittedAnswer: fixture.answer } }
      bridge.handleEvent(resolved)
      assert.equal(bridge.pending.has(sessionId), false, 'the App answer immediately invalidates Feishu input')
      const stale = await transport.cardHandler({ action: { value: action, form_value: fixture.form } })
      assert.equal(stale.card, undefined, 'a stale callback must not replace the actual App answer')
      await bridge.pushChains.get(sessionId)
      assert.equal(patches.length, 1, 'the original card updates even with the notification gate closed')
      assert.equal(patches[0].path.message_id, 'bot-reply')
      const updated = JSON.parse(patches.at(-1).data.content)
      assert.equal(updated.schema, '2.0')
      assert.equal(updated.header.title.content, '✅ 已在 UniAgent App 回复')
      assert.deepEqual(updated.body, resolvedCardData.body, 'App and Feishu must display the same escaped, redacted answers')
      assert.equal(updated.config.update_multi, true)
      assert.equal(store.bySession(sessionId).pendingRequestId, undefined)
      bridge.handleEvent(resolved)
      await bridge.pushChains.get(sessionId)
      assert.equal(patches.length, 1, 'duplicate resolved events must not patch twice')
      assert.equal(transport.replies.length, before, 'do not send a second card')
      assert.equal(responses.length, 1, 'stale clicks never reach the provider')
    } finally {
      await bridge.stop()
    }
  }
})

test('App resolution waits for card delivery, preserves newer requests and retries failed patches on reconnect', async () => {
  const sessionId = 'app-answer-race'
  const store = new FeishuThreadStore(join(directory, sessionId))
  store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: sessionId, lastPushedSeq: 0, driver: 'feishu' })
  const bridge = makeBridge(store, () => [agent], () => {}, { getSessionById: () => ({ id: sessionId }) })
  await bridge.start()
  const patches = []
  let finishSend, sending
  const started = new Promise(resolve => { sending = resolve })
  bridge.client.im.v1.message.reply = async () => {
    sending()
    return new Promise(resolve => { finishSend = () => resolve({ data: { message_id: 'slow-question' } }) })
  }
  bridge.client.im.v1.message.patch = async request => { patches.push(request); return { code: 999, msg: 'temporary error' } }
  try {
    const event = { sessionId, seq: 1, type: 'approval_request', state: 'pending', payload: {
      requestId: 'old-question', kind: 'question', params: { questions: [{ id: 'q', question: 'Answer?' }] }
    } }
    bridge.handleEvent(event)
    await started
    bridge.handleEvent({ ...event, state: 'success', payload: { ...event.payload, submittedAnswer: { answers: { q: { answers: ['App answer'] } } } } })
    bridge.pending.set(sessionId, { requestId: 'new-question', kind: 'question' })
    finishSend()
    await bridge.pushChains.get(sessionId)
    assert.equal(bridge.pending.get(sessionId).requestId, 'new-question')
    assert.equal(patches.length, 1)
    assert.equal(patches[0].path.message_id, 'slow-question')
    assert.ok(patches[0].data.content.includes('App answer'))
    assert.ok(bridge.requestCards.get(`${sessionId}/old-question`).resolved, 'failed patch remains available for retry')
    bridge.client.im.v1.message.patch = async request => { patches.push(request); return {} }
    bridge.connectionReady('test-reconnect')
    await bridge.pushChains.get(sessionId)
    assert.equal(patches.length, 2)
    assert.equal(bridge.requestCards.has(`${sessionId}/old-question`), false)
    assert.equal(bridge.pending.get(sessionId).requestId, 'new-question')
    bridge.client.im.v1.message.reply = async () => ({ data: { message_id: 'cancelled-question' } })
    const cancelled = { ...event, seq: 2, payload: { ...event.payload, requestId: 'cancelled-question' } }
    bridge.handleEvent(cancelled)
    await bridge.pushChains.get(sessionId)
    bridge.handleEvent({ ...cancelled, state: 'cancelled', payload: { requestId: 'cancelled-question', resolved: true } })
    await bridge.pushChains.get(sessionId)
    assert.equal(JSON.parse(patches.at(-1).data.content).header.title.content, '✅ 已取消', 'cancelled requests must not claim an App reply')
  } finally {
    finishSend?.()
    await bridge.stop()
  }
})

test('an approval card lists the specific files and echoes them after a decision', async () => {
  const sessionId = 'appr-fileChange'
  const requestId = 'request-fileChange'
  const store = new FeishuThreadStore(join(directory, sessionId))
  store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: sessionId, lastPushedSeq: 0, driver: 'feishu' })
  const responses = []
  const bridge = makeBridge(store, () => [agent], () => {}, {
    getSessionById: () => ({ id: sessionId }),
    respondToRequest: (...args) => { responses.push(args); return { handled: true } }
  })
  await bridge.start()
  const patches = []
  bridge.client.im.v1.message.patch = async request => { patches.push(request); return {} }
  try {
    bridge.handleEvent({ sessionId, seq: 1, type: 'approval_request', state: 'pending', payload: {
      requestId, kind: 'fileChange', method: 'item/fileChange/requestApproval',
      params: { changes: [
        { kind: 'update', path: 'src/main/feishuBridge.ts' },
        { kind: 'add', path: 'src/main/approvalDetail.ts' },
        { kind: 'delete', path: 'src/legacy/oldCard.ts' }
      ] }
    } })
    await new Promise(setImmediate)
    // The pending card names each file with its change-type label and a count.
    const pending = JSON.parse(transport.replies.at(-1).data.content)
    const pendingText = pending.elements.map((element) => element.text?.content || '').join('\n')
    assert.ok(pendingText.includes('将修改 **3** 个文件'), 'the pending card must state the file count')
    for (const text of ['修改 src/main/feishuBridge.ts', '新增 src/main/approvalDetail.ts', '删除 src/legacy/oldCard.ts']) {
      assert.ok(pendingText.includes(text), `pending card missing: ${text}`)
    }
    // Approving locks the card and echoes the same files under the decision.
    const submit = pending.elements.find((element) => element.tag === 'action')
      .actions.find((action) => action.value.act === 'accept')
    const ack = await transport.cardHandler({
      context: { open_message_id: 'bot-reply', open_chat_id: 'chat-1' },
      operator: { open_id: 'user-1' },
      action: { value: submit.value }
    })
    assert.equal(ack.card, undefined)
    await new Promise(setImmediate)
    await bridge.pushChains.get(sessionId)
    const resolved = JSON.parse(patches.at(-1).data.content)
    const lockedText = JSON.stringify(resolved)
    assert.ok(!lockedText.includes('"button"') && !lockedText.includes('select_static'), 'the locked approval card has no interactive components')
    const locked = JSON.stringify(resolved)
    assert.ok(locked.includes(submit.value.actLabel), 'the locked card must show the selected decision label')
    assert.ok(locked.includes('将修改 **3** 个文件'), 'the locked card must echo the approved files count')
    assert.ok(locked.includes('修改 src/main/feishuBridge.ts'), 'the locked card must echo the approved files')
    await new Promise(setImmediate)
    assert.deepEqual(responses, [[sessionId, requestId, { decision: 'accept' }, { source: 'feishu' }]], 'the decision answer must be unchanged')
  } finally {
    await bridge.stop()
  }
})

test('a command approval card shows the working directory and echoes it after a decision', async () => {
  const sessionId = 'appr-command'
  const requestId = 'request-command'
  const store = new FeishuThreadStore(join(directory, sessionId))
  store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: sessionId, lastPushedSeq: 0, driver: 'feishu' })
  const responses = []
  const bridge = makeBridge(store, () => [agent], () => {}, {
    getSessionById: () => ({ id: sessionId }),
    respondToRequest: (...args) => { responses.push(args); return { handled: true } }
  })
  await bridge.start()
  const patches = []
  bridge.client.im.v1.message.patch = async request => { patches.push(request); return {} }
  try {
    bridge.handleEvent({ sessionId, seq: 1, type: 'approval_request', state: 'pending', payload: {
      requestId, kind: 'command', method: 'execCommandApproval',
      params: { command: 'pnpm run pack', cwd: '/repo/UniAgent' }
    } })
    await new Promise(setImmediate)
    const pending = JSON.parse(transport.replies.at(-1).data.content)
    const pendingText = pending.elements.map((element) => element.text?.content || '').join('\n')
    assert.ok(pendingText.includes('pnpm run pack'), 'the pending card must show the command')
    assert.ok(pendingText.includes('工作目录：`/repo/UniAgent`'), 'the pending card must show the working directory')
    const decline = pending.elements.find((element) => element.tag === 'action')
      .actions.find((action) => action.value.act === 'decline')
    const ack = await transport.cardHandler({
      context: { open_message_id: 'bot-reply', open_chat_id: 'chat-1' },
      operator: { open_id: 'user-1' },
      action: { value: decline.value }
    })
    assert.equal(ack.card, undefined)
    await new Promise(setImmediate)
    await bridge.pushChains.get(sessionId)
    const locked = JSON.stringify(JSON.parse(patches.at(-1).data.content))
    assert.ok(locked.includes(decline.value.actLabel), 'the locked card must show the selected decline label')
    assert.ok(locked.includes('pnpm run pack'), 'the locked card must echo the command')
    assert.ok(locked.includes('工作目录：`/repo/UniAgent`'), 'the locked card must echo the working directory')
    await new Promise(setImmediate)
    assert.deepEqual(responses, [[sessionId, requestId, { decision: 'denied' }, { source: 'feishu' }]], 'the decision answer must be unchanged')
  } finally {
    await bridge.stop()
  }
})

test('a received Feishu message stays handled across reconnects and app restarts', async () => {
  const stateDirectory = join(directory, 'state')
  const createSession = (config, text) => ({ id: 'unused', title: text, config })
  const first = makeBridge(new FeishuThreadStore(stateDirectory), () => [agent], createSession)
  await first.start()
  await emit(message('om-1', 'evt-1'))
  await emit(message('om-1', 'evt-redelivery'))
  assert.equal(offersFor('om-1'), 1, 'one delivery offers one config card')

  await first.stop()
  await first.start()
  await emit(message('om-1', 'evt-after-reconnect'))
  assert.equal(offersFor('om-1'), 1, 'reconnecting must not forget acknowledged messages')

  const restarted = makeBridge(new FeishuThreadStore(stateDirectory), () => [agent], createSession)
  await restarted.start()
  await emit(message('om-1', 'evt-after-restart'))
  assert.equal(offersFor('om-1'), 1, 'the stable message id must survive process restarts')
  await emit(message('om-2', 'evt-2'))
  assert.equal(offersFor('om-2'), 1, 'a genuinely new message is still accepted')
})

test('a Feishu message created before this app process is not replayed', async () => {
  const store = new FeishuThreadStore(join(directory, 'pre-start-redelivery-state'))
  store.upsert({
    sessionId: 'session-pre-start',
    chatId: 'chat-1',
    rootMessageId: 'om-pre-start-root',
    threadId: 'thread-pre-start',
    lastPushedSeq: 1,
    driver: 'feishu'
  })
  let sends = 0
  const bridge = makeBridge(
    store,
    () => [agent],
    () => { throw new Error('unexpected create') },
    {
      getSessionById: () => ({ id: 'session-pre-start' }),
      forceSend: async () => { sends += 1 }
    }
  )
  await bridge.start()
  const stale = message('om-pre-start-redelivery')
  stale.message.thread_id = 'thread-pre-start'
  stale.message.create_time = String(Date.now() - 60 * 60 * 1000)

  await emit(stale)

  assert.equal(sends, 0)
  assert.equal(store.hasHandledInbound('om-pre-start-redelivery'), true)
})

test('persistence failure prevents ACK and business side effects, then permits retry', async () => {
  const blockedDirectory = join(directory, 'not-a-directory')
  await writeFile(blockedDirectory, 'blocked')
  const store = new FeishuThreadStore(blockedDirectory)
  const bridge = makeBridge(store, () => [agent], (config, text) => ({ id: 'unused', title: text, config }))
  await bridge.start()

  await assert.rejects(transport.handler(message('om-write-failed')))
  assert.equal(store.hasHandledInbound('om-write-failed'), false)
  assert.equal(offersFor('om-write-failed'), 0)

  await rm(blockedDirectory)
  await emit(message('om-write-failed'))
  assert.equal(offersFor('om-write-failed'), 1)
})

test('a new private message is not acknowledged until an Agent can accept it', async () => {
  const stateDirectory = join(directory, 'agent-retry-state')
  let agents = []
  const bridge = makeBridge(
    new FeishuThreadStore(stateDirectory),
    () => agents,
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()

  await assert.rejects(transport.handler(message('om-agent-retry')))
  agents = [agent]
  await emit(message('om-agent-retry'))
  assert.equal(offersFor('om-agent-retry'), 1)
})

test('a failed business acceptance remains retryable', async () => {
  const stateDirectory = join(directory, 'business-retry-state')
  const bridge = makeBridge(
    new FeishuThreadStore(stateDirectory),
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()

  transport.failReplyOnce = true
  await assert.rejects(transport.handler(message('om-business-retry')))
  assert.equal(offersFor('om-business-retry'), 0, 'a failed card offer is not recorded')
  await emit(message('om-business-retry'))
  assert.equal(offersFor('om-business-retry'), 1, 'the retry offers the card once accepted')
})

test('a failed pending cleanup remains retryable without memory and disk divergence', async () => {
  const store = new FeishuThreadStore(join(directory, 'cleanup-retry-state'))
  store.reserveInbound('om-cleanup-retry')
  const persistInbound = store.persistInbound.bind(store)
  store.persistInbound = () => { throw new Error('temporary cleanup failure') }

  assert.throws(() => store.forgetInbound('om-cleanup-retry'))
  assert.equal(store.hasPendingInbound('om-cleanup-retry'), true)
  assert.equal(store.hasHandledInbound('om-cleanup-retry'), true)

  store.persistInbound = persistInbound
  store.forgetInbound('om-cleanup-retry')
  assert.equal(store.hasPendingInbound('om-cleanup-retry'), false)
  assert.equal(store.hasHandledInbound('om-cleanup-retry'), false)
})

test('a cleanup write failure remains retryable after Agent availability recovers', async () => {
  const store = new FeishuThreadStore(join(directory, 'cleanup-agent-retry-state'))
  const forget = store.forgetInbound.bind(store)
  store.forgetInbound = () => { throw new Error('temporary cleanup failure') }
  let agents = [agent]
  const bridge = makeBridge(
    store,
    () => agents,
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()

  transport.failReplyOnce = true
  await assert.rejects(transport.handler(message('om-cleanup-agent-retry')))
  agents = []
  await assert.rejects(transport.handler(message('om-cleanup-agent-retry')))
  store.forgetInbound = forget
  agents = [agent]
  await emit(message('om-cleanup-agent-retry'))
  assert.equal(offersFor('om-cleanup-agent-retry'), 1)
})

test('an ambiguous persisted in-flight id is not repeated after restart', async () => {
  const stateDirectory = join(directory, 'pending-restart-state')
  const store = new FeishuThreadStore(stateDirectory)
  store.reserveInbound('om-pending-restart')
  const restartedStore = new FeishuThreadStore(stateDirectory)
  const bridge = makeBridge(
    restartedStore,
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()

  await emit(message('om-pending-restart'))
  assert.equal(offersFor('om-pending-restart'), 0)
})

test('a completed-id write retry does not repeat the accepted business action', async () => {
  const store = new FeishuThreadStore(join(directory, 'commit-retry-state'))
  const remember = store.rememberInbound.bind(store)
  let writes = 0
  store.rememberInbound = (id) => {
    writes += 1
    if (writes === 1) throw new Error('temporary commit failure')
    remember(id)
  }
  const bridge = makeBridge(
    store,
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()

  await assert.rejects(transport.handler(message('om-commit-retry')))
  await emit(message('om-commit-retry'))
  assert.equal(offersFor('om-commit-retry'), 1)
  assert.equal(writes, 2)
})

test('a persisted in-flight id is not executed again after process restart', async () => {
  const stateDirectory = join(directory, 'crash-fence-state')
  const store = new FeishuThreadStore(stateDirectory)
  const remember = store.rememberInbound.bind(store)
  const first = makeBridge(
    store,
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  store.rememberInbound = () => { throw new Error('simulated process exit before commit') }
  await first.start()
  await assert.rejects(transport.handler(message('om-crash-fence')))
  store.rememberInbound = remember

  const restarted = makeBridge(
    new FeishuThreadStore(stateDirectory),
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await restarted.start()
  await emit(message('om-crash-fence'))
  assert.equal(offersFor('om-crash-fence'), 1, 'the persisted root mapping fences the card offer')
})

test('background starts reuse ready, connecting and reconnecting clients', async () => {
  const before = transport.clients.length
  const bridge = makeBridge(
    new FeishuThreadStore(join(directory, 'connection-state')),
    () => [agent],
    (config, text) => ({ id: 'session-connection', title: text, config })
  )

  await Promise.all([bridge.start(), bridge.start()])
  const clients = transport.clients.slice(before)
  assert.equal(clients.length, 1)
  const client = bridge.client
  clients[0].options.onReconnecting()
  await bridge.start()
  assert.equal(bridge.client, client, 'SDK reconnect must not be interrupted by Agent discovery')
  await bridge.stop()
  assert.equal(clients[0].closed, true)
  transport.deferReady = true
  try {
    await bridge.start()
    const pending = transport.clients.at(-1)
    await bridge.start()
    assert.equal(transport.clients.at(-1), pending, 'start() resolves before the WS handshake')
    assert.equal(pending.closed, false)
  } finally {
    transport.deferReady = false
    await bridge.stop()
    bridge.dispose()
  }
})

test('credential changes and terminal failures replace the client, notification changes do not', async () => {
  const bridge = makeBridge(new FeishuThreadStore(join(directory, 'connection-settings')), () => [agent], () => {})
  let settings = bridge.deps.getSettings()
  bridge.deps.getSettings = () => settings
  try {
    await bridge.start()
    const first = transport.clients.at(-1)
    settings = { ...settings, notifyChatId: 'another-chat' }
    await bridge.start()
    assert.equal(transport.clients.at(-1), first)
    settings = { ...settings, appSecret: 'rotated-fixture-secret' }
    await bridge.start()
    const second = transport.clients.at(-1)
    assert.notEqual(second, first)
    assert.equal(first.closed, true)
    second.options.onError(new Error('terminal failure'))
    await bridge.start()
    assert.notEqual(transport.clients.at(-1), second)
    assert.equal(second.closed, true)
    settings = { ...settings, enabled: false }
    await bridge.start()
    assert.equal(bridge.client, null)
  } finally { await bridge.stop(); bridge.dispose() }
})

test('retired connections cannot accept new messages or card actions', async () => {
  const bridge = makeBridge(new FeishuThreadStore(join(directory, 'retired-connection')), () => [agent], () => {})
  let messages = 0, actions = 0
  bridge.onInboundMessage = async () => { messages++ }
  bridge.onCardAction = async () => { actions++ }
  try {
    await bridge.start()
    const old = transport.clients.at(-1)
    await bridge.start({ force: true })
    await old.dispatcher.invoke(message('retired-message'))
    await old.dispatcher.handles['card.action.trigger']({})
    assert.equal(messages, 0)
    assert.equal(actions, 0)
    await transport.handler(message('current-message'))
    await transport.cardHandler({})
    assert.equal(messages, 1)
    assert.equal(actions, 1)
  } finally { await bridge.stop(); bridge.dispose() }
})

test('MCP HTTP uploads work while WS reconnects and stop when the Bot is disabled', async () => {
  const sessionId = 'session-http-reconnect', turn = { ts: 100 }
  const store = new FeishuThreadStore(join(directory, 'http-reconnect'))
  store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: 'om-http', lastPushedSeq: 0, driver: 'feishu' })
  const bridge = makeBridge(store, () => [agent], () => {}, {
    getSessionById: () => ({ id: sessionId, config: { workdir: directory } }), getFeishuSendTurn: () => turn
  })
  const image = join(directory, 'http-reconnect.png'), file = join(directory, 'http-reconnect.html')
  await writeFile(image, 'image fixture')
  await writeFile(file, '<p>file fixture</p>')
  try {
    await bridge.start()
    transport.clients.at(-1).options.onReconnecting()
    bridge.client.im.v1.file = { create: async () => ({ file_key: 'file-fixture' }) }
    const before = transport.replies.length
    assert.deepEqual(await bridge.sendToSession(sessionId, undefined, [image, file], 100), ['http-reconnect.png', 'http-reconnect.html'])
    assert.deepEqual(transport.replies.slice(before).map(r => r.data.msg_type), ['image', 'file'])
    assert.equal(bridge.getStatus().connected, false, 'sending does not pretend inbound WS is ready')
    await bridge.stop()
    await assert.rejects(bridge.sendToSession(sessionId, undefined, [image], 100), /未连接/)
    assert.equal(transport.replies.length, before + 2)
  } finally { await bridge.stop(); bridge.dispose() }
})

test('a failed thread continuation is not acknowledged and can retry', async () => {
  const stateDirectory = join(directory, 'thread-retry-state')
  const store = new FeishuThreadStore(stateDirectory)
  store.upsert({
    sessionId: 'session-thread',
    chatId: 'chat-1',
    rootMessageId: 'om-thread-root',
    threadId: 'thread-1',
    lastPushedSeq: 0,
    driver: 'feishu'
  })
  let attempts = 0
  const bridge = makeBridge(
    store,
    () => [agent],
    () => { throw new Error('unexpected create') },
    {
      getSessionById: () => ({ id: 'session-thread', status: 'running' }),
      forceSend: async (sessionId, text, attachments, nativeContext, bubble, queueIfBusy) => {
        assert.equal(sessionId, 'session-thread')
        assertFeishuPrompt(text, 'hello')
        assert.deepEqual(attachments, [])
        assert.equal(nativeContext, undefined)
        assert.deepEqual(bubble, { source: 'feishu' })
        assert.equal(queueIfBusy, false, 'a Feishu follow-up must never fall back to the task queue')
        attempts += 1
        if (attempts === 1) throw new Error('temporary send failure')
      }
    }
  )
  await bridge.start()
  const reply = {
    ...message('om-thread-reply'),
    message: { ...message('om-thread-reply').message, thread_id: 'thread-1' }
  }

  await assert.rejects(transport.handler(reply))
  assert.equal(store.hasHandledInbound('om-thread-reply'), false, 'a rejected steer stays retryable')
  await emit(reply)
  await emit(reply)
  assert.equal(attempts, 2)
})

test('a reply to the config card continues the topic bound to its root message', async () => {
  const store = new FeishuThreadStore(join(directory, 'topic-root-reply-state'))
  store.upsert({
    sessionId: 'session-topic-root',
    chatId: 'chat-1',
    rootMessageId: 'om-topic-root',
    lastPushedSeq: 0,
    driver: 'feishu'
  })
  let sent
  const bridge = makeBridge(
    store,
    () => [agent],
    () => { throw new Error('unexpected create') },
    {
      getSessionById: () => ({ id: 'session-topic-root' }),
      forceSend: async (sessionId, text) => { sent = { sessionId, text } }
    }
  )
  await bridge.start()
  const reply = message('om-topic-followup')
  reply.message.parent_id = 'bot-config-card'
  reply.message.root_id = 'om-topic-root'

  await emit(reply)

  assert.equal(sent.sessionId, 'session-topic-root')
  assertFeishuPrompt(sent.text, 'hello')
  assert.equal(offersFor('om-topic-followup'), 0, 'an existing topic must not show the config card again')
})

test('an unbound topic reply never falls back to a new-session config card', async () => {
  const bridge = makeBridge(
    new FeishuThreadStore(join(directory, 'unbound-topic-reply-state')),
    () => [agent],
    (config, text) => ({ id: 'unexpected', title: text, config })
  )
  await bridge.start()
  const reply = message('om-unbound-topic-reply')
  reply.message.thread_id = 'thread-missing-topic'
  reply.message.parent_id = 'bot-config-card'
  reply.message.root_id = 'om-missing-topic-root'

  await emit(reply)

  assert.equal(offersFor('om-unbound-topic-reply'), 0)
})

test('a new topic root with only a thread id still shows the config card', async () => {
  const bridge = makeBridge(
    new FeishuThreadStore(join(directory, 'new-topic-thread-state')),
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()
  const root = message('om-new-topic-root')
  root.message.thread_id = 'thread-new-topic'

  await emit(root)

  assert.equal(offersFor('om-new-topic-root'), 1)
})

test('a standalone Feishu image reaches a newly-created Agent session as an attachment', async () => {
  let created
  const bridge = makeBridge(
    new FeishuThreadStore(join(directory, 'image-topic-state')),
    () => [agent],
    (config, text, attachments) => {
      created = { text, attachments }
      return { id: 'session-image-topic', title: text, config }
    }
  )
  await bridge.start()
  await emit({
    ...message('om-image-topic'),
    message: {
      ...message('om-image-topic').message,
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img-standalone' })
    }
  })

  const offer = transport.replies.find((reply) => reply?.path?.message_id === 'om-image-topic')
  assert.ok(offer, 'an image-only message must offer session configuration')
  const card = JSON.parse(offer.data.content)
  const start = card.body.elements.find((element) => element.behaviors?.[0]?.value?.act === 'startTopic')
  await transport.cardHandler({
    action: { value: start.behaviors[0].value }
  })
  for (let i = 0; i < 200 && !created; i++) await new Promise((r) => setTimeout(r, 5))

  assert.ok(created, 'the card action must create the Agent session')
  assertFeishuPrompt(created.text, '')
  assert.equal(created.attachments.length, 1)
  assert.equal(created.attachments[0].kind, 'image')
  assert.equal(created.attachments[0].mime, 'image/png')
  assert.equal(await readFile(created.attachments[0].path, 'utf8'), 'image bytes')
})

// 统一 — the config card must (1) never create a session with a model that belongs
// to a DIFFERENT agent — each select is standalone, so switching Agent fires
// `agentChange` which resets 模型/推理强度 to the new agent's default — and (2) lock
// the card in place on 开始 so it can no longer be clicked. `codexA`/`codexB` share
// no model ids.
test('switching Agent resets its model and 开始 locks the card', async () => {
  const codexA = {
    id: 'agent-a', name: 'Agent A', adapter: 'codex', lifecycle: { availability: 'available' },
    capabilities: { permissionModes: [{ id: 'read-only' }], modelSelect: true, reasoningEffort: true },
    defaultModel: 'a-default', models: [{ id: 'a-default', label: 'A Default', efforts: ['low'] }]
  }
  const codexB = {
    id: 'agent-b', name: 'Agent B', adapter: 'codex', lifecycle: { availability: 'available' },
    capabilities: { permissionModes: [{ id: 'read-only' }], modelSelect: true, reasoningEffort: true },
    defaultModel: 'b-default', models: [{ id: 'b-default', label: 'B Default', efforts: ['high'] }]
  }
  let created
  const bridge = new FeishuBridge({
    orchestrator: {
      createSession: (config, text) => { created = { config, text }; return { id: 'session-mix', title: text, config } },
      getSessionById: () => undefined, listSessions: () => []
    },
    threadStore: new FeishuThreadStore(join(directory, 'mix-model-state')),
    getAgents: () => [codexA, codexB],
    getSettings: () => ({ enabled: true, appId: 'cli_1234567890abcdef', appSecret: 'secret' }),
    onStatus: () => {}
  })
  await bridge.start()
  await emit(message('om-mix'))
  const offer = transport.replies.find((reply) => reply?.path?.message_id === 'om-mix')
  assert.ok(offer, 'a new message offers a config card')
  const agentSelect = JSON.parse(offer.data.content).body.elements.find((e) => e.name === 'agentId')

  // Standalone Agent select fires agentChange with only its own option → resets model.
  await transport.cardHandler({
    action: { value: agentSelect.behaviors[0].value, option: 'agent-b' }
  })
  // 开始 carries no form_value — the session uses the accumulated offer selection.
  const start = { topicId: agentSelect.behaviors[0].value.topicId, act: 'startTopic' }
  const ack = await transport.cardHandler({ action: { value: start } })
  for (let i = 0; i < 200 && !created; i++) await new Promise((r) => setTimeout(r, 5))

  assert.equal(created.config.agentId, 'agent-b', 'the chosen agent is honored')
  assert.equal(created.config.model, 'b-default', 'switching to Agent B reset the model to its default')
  assert.equal(created.config.effort, 'high', 'Agent B uses the selected model default effort')
  assertFeishuPrompt(created.text, 'hello')
  // The 开始 response locks the card (2.0, no interactive components).
  assert.equal(ack.card.type, 'raw')
  assert.equal(ack.card.data.schema, '2.0')
  const locked = JSON.stringify(ack.card.data)
  assert.ok(!locked.includes('select_static') && !locked.includes('startTopic'), 'the locked card has no selects/buttons')
})

// 统一 — switching Agent on the card re-renders it (via the callback response card),
// so the 模型/推理强度 options follow the newly-chosen agent instead of staying stale.
test('changing Agent re-renders the card with that agent’s models', async () => {
  const codexA = {
    id: 'agent-a', name: 'Agent A', adapter: 'codex', lifecycle: { availability: 'available' },
    capabilities: { permissionModes: [{ id: 'read-only' }], modelSelect: true, reasoningEffort: true },
    defaultModel: 'a-default', models: [{ id: 'a-default', label: 'A Default', efforts: ['low'] }]
  }
  const codexB = {
    id: 'agent-b', name: 'Agent B', adapter: 'codex', lifecycle: { availability: 'available' },
    capabilities: { permissionModes: [{ id: 'read-only' }], modelSelect: true, reasoningEffort: true },
    defaultModel: 'b-default', models: [{ id: 'b-default', label: 'B Default', efforts: ['high'] }]
  }
  const bridge = new FeishuBridge({
    orchestrator: { createSession: (config, text) => ({ id: 'unused', title: text, config }), getSessionById: () => undefined, listSessions: () => [] },
    threadStore: new FeishuThreadStore(join(directory, 'agent-change-state')),
    getAgents: () => [codexA, codexB],
    getSettings: () => ({ enabled: true, appId: 'cli_1234567890abcdef', appSecret: 'secret' }),
    onStatus: () => {}
  })
  await bridge.start()
  await emit(message('om-change'))
  const offer = transport.replies.find((reply) => reply?.path?.message_id === 'om-change')
  const agentSelect = JSON.parse(offer.data.content).body.elements.find((e) => e.name === 'agentId')

  // A standalone select change carries only `action.option` (the new value) — no form.
  const ack = await transport.cardHandler({
    action: { value: agentSelect.behaviors[0].value, option: 'agent-b' }
  })
  assert.equal(ack.card.type, 'raw', 'an agent change returns a fresh card, not a message.patch')
  const model = ack.card.data.body.elements.find((e) => e.name === 'model')
  assert.deepEqual(model.options.map((o) => o.value), ['b-default'], 'model options now follow Agent B')
  assert.equal(model.initial_option, 'b-default', 'and default to Agent B’s model, not the stale A model')
})

test('a Feishu rich-text image reaches the bound Agent session with its caption', async () => {
  const store = new FeishuThreadStore(join(directory, 'rich-image-state'))
  store.upsert({
    sessionId: 'session-rich-image',
    chatId: 'chat-1',
    rootMessageId: 'om-rich-image-root',
    threadId: 'thread-rich-image',
    lastPushedSeq: 0,
    driver: 'feishu'
  })
  let sent
  const bridge = makeBridge(
    store,
    () => [agent],
    () => { throw new Error('unexpected create') },
    {
      getSessionById: () => ({ id: 'session-rich-image', status: 'running' }),
      forceSend: async (sessionId, text, attachments, _nativeContext, bubble, queueIfBusy) => {
        assert.deepEqual(bubble, { source: 'feishu' })
        assert.equal(queueIfBusy, false)
        sent = { sessionId, text, attachments }
      }
    }
  )
  await bridge.start()
  await emit({
    ...message('om-rich-image'),
    message: {
      ...message('om-rich-image').message,
      thread_id: 'thread-rich-image',
      message_type: 'post',
      content: JSON.stringify({
        title: '',
        content: [[
          { tag: 'text', text: '请识别这张图' },
          { tag: 'img', image_key: 'img-rich' }
        ]]
      })
    }
  })

  assert.equal(sent.sessionId, 'session-rich-image')
  assertFeishuPrompt(sent.text, '请识别这张图')
  assert.equal(sent.attachments.length, 1)
  assert.equal(sent.attachments[0].kind, 'image')
  assert.equal(await readFile(sent.attachments[0].path, 'utf8'), 'image bytes')
})

test('a Feishu continuation replies after a restart resets the event sequence', async () => {
  const store = new FeishuThreadStore(join(directory, 'sequence-reset-state'))
  store.upsert({
    sessionId: 'session-sequence-reset',
    chatId: 'chat-1',
    rootMessageId: 'om-sequence-reset-root',
    threadId: 'thread-sequence-reset',
    lastPushedSeq: 1175,
    driver: 'feishu'
  })
  const bridge = makeBridge(
    store,
    () => [agent],
    () => { throw new Error('unexpected create') },
    {
      getSessionById: () => ({ id: 'session-sequence-reset' }),
      latestAgentMessageText: () => 'reply after restart',
      forceSend: async (sessionId, text, _attachments, _nativeContext, bubble) => {
        bridge.handleEvent({ sessionId, seq: 248, ts: Date.now(), type: 'user_message', payload: { text, ...bubble } })
      }
    }
  )
  await bridge.start()
  const repliesBefore = transport.replies.length
  await emit({
    ...message('om-sequence-reset-reply'),
    message: { ...message('om-sequence-reset-reply').message, thread_id: 'thread-sequence-reset' }
  })

  bridge.handleEvent({
    sessionId: 'session-sequence-reset',
    seq: 249,
    ts: Date.now(),
    type: 'turn_completed',
    state: 'success',
    payload: {}
  })
  await new Promise(setImmediate)

  assert.equal(transport.replies.length, repliesBefore + 1)
  assert.equal(bridge.isTurnReplyDelivered('session-sequence-reset', 249), true)
})

test('a Feishu-driven turn folds its process card and sends a separate Markdown answer', async () => {
  const sessionId = 'session-progress-card'
  const store = new FeishuThreadStore(join(directory, 'progress-card-state'))
  store.upsert({
    sessionId, chatId: 'chat-1', rootMessageId: 'om-progress-root',
    threadId: 'thread-progress', lastPushedSeq: 0, driver: 'feishu'
  })
  const session = {
    id: sessionId, title: '优化问答卡片展示', status: 'running', createdAt: Date.now(),
    config: { agentId: 'codex', model: 'gpt-5', effort: 'high' }
  }
  const bridge = makeBridge(store, () => [agent], () => {}, {
    getSessionById: () => session,
    latestAgentMessageText: () => '已完成卡片展示。'
  })
  await bridge.start()
  const cardCreatesBefore = transport.cardCreates?.length || 0
  const repliesBefore = transport.replies.length
  const settingsBefore = transport.cardSettings?.length || 0
  const updatesBefore = transport.cardUpdates?.length || 0

  bridge.handleEvent({ sessionId, seq: 1, ts: Date.now(), type: 'turn_started', state: 'running', payload: { turnId: 'turn-progress' } })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(transport.cardCreates.length, cardCreatesBefore + 1)
  const initial = JSON.parse(transport.cardCreates.at(-1).data.data)
  assert.equal(initial.schema, '2.0')
  assert.equal(initial.config.streaming_mode, true)
  assert.ok(JSON.stringify(initial).includes('progress_stream'), 'the running card retains the complete history')
  assert.equal(initial.config.width_mode, 'compact')
  assert.equal(initial.header, undefined, 'the progress card has no large colored header')
  assert.ok(!JSON.stringify(initial).includes('工具调用'), 'the running card no longer shows a tool panel')
  assert.equal(transport.replies.length, repliesBefore + 1, 'the progress card is the only new thread reply')
  assert.deepEqual(JSON.parse(transport.replies.at(-1).data.content), { type: 'card', data: { card_id: 'card-' + transport.cardCreates.length } })

  // Two reasoning段 + one中间 agent_message段: each new id appends after the prior段,
  // and a growing snapshot for the SAME id replaces only its own段 (no overwrite).
  bridge.handleEvent({ sessionId, seq: 2, ts: Date.now(), type: 'reasoning', state: 'running', payload: { id: 'reason-1', text: '先核对原有卡片结构。' } })
  bridge.handleEvent({ sessionId, seq: 3, ts: Date.now(), type: 'reasoning', state: 'running', payload: { id: 'reason-1', text: '先核对原有卡片结构，确认改动落在桥接层。' } })
  bridge.handleEvent({ sessionId, seq: 4, ts: Date.now(), type: 'agent_message', state: 'running', payload: { id: 'msg-1', text: '正在按顺序累积每段输出。' } })
  bridge.handleEvent({ sessionId, seq: 5, ts: Date.now(), type: 'tool_call', state: 'running', payload: { id: 'tool-1', name: 'Read', input: { token: 'private-token' } } })
  bridge.handleEvent({ sessionId, seq: 6, ts: Date.now(), type: 'tool_call', state: 'success', payload: { id: 'tool-1', name: 'Read', result: 'private-result' } })
  await new Promise((resolve) => setTimeout(resolve, 1200))

  // The 1s ticker rebuilds the whole running card via a full update so the elapsed
  // time keeps counting; the body retains the accumulated reasoning (no tool calls).
  const running = transport.cardUpdates.slice(updatesBefore)
  assert.ok(running.length >= 1, 'the 1s ticker refreshes the running card at least once')
  const ticked = JSON.parse(running.at(-1).data.card.data)
  assert.equal(ticked.config.streaming_mode, true)
  assert.equal(ticked.body.elements[1].text.content, 'codex · gpt-5 · 高')
  assert.ok(!JSON.stringify(ticked).includes(session.title), 'the session title is absent')
  assert.ok(progressStatus(ticked).includes('执行中'))
  const controls = ticked.body.elements[0]
  assert.equal(controls.tag, 'column_set')
  assert.equal(controls.flex_mode, 'none', 'status and elapsed time stay on one row')
  assert.match(controls.columns[1].elements[0].text.content, /^\d+ 秒$/)
  assert.equal(controls.horizontal_spacing, '12px')
  assert.equal(controls.columns.at(-1).padding, '0px')
  assert.equal(ticked.body.elements[2].text.lines, 16, 'the preview capacity is four times the original four lines')
  assert.equal(progressButton(ticked).text.content, '中断对话')
  assert.equal(progressButton(ticked).margin, '0px')
  const runningHistory = ticked.body.elements.find(element => element.tag === 'collapsible_panel')
  assert.equal(runningHistory.expanded, false, 'running cards default to folded records')
  assert.equal(runningHistory.header.icon.token, 'right-small-ccm_outlined')
  assert.equal(runningHistory.header.icon_expanded_angle, 90)
  const stream = JSON.stringify(ticked.body)
  assert.ok(stream.includes('思考记录'), 'history is available in the folded record')
  assert.ok(stream.includes('确认改动落在桥接层'), 'the same-id段 grows in place to its latest snapshot')
  assert.ok(stream.includes('正在按顺序累积每段输出。'), 'a new段 is appended, not overwritten')
  assert.ok(!stream.includes('先核对原有卡片结构。\\n'), 'the earlier snapshot of the same id is replaced, only the latest survives')
  assert.ok(!stream.includes('Read'), 'tool calls are not shown in the stream')
  assert.ok(!JSON.stringify(running).includes('private-token'))
  assert.ok(!JSON.stringify(running).includes('private-result'))

  bridge.handleEvent({ sessionId, seq: 7, ts: Date.now(), type: 'agent_message', state: 'success', payload: { id: 'final-answer', phase: 'final_answer', text: '已完成卡片展示。' } })
  bridge.handleEvent({ sessionId, seq: 8, ts: Date.now(), type: 'turn_completed', state: 'success', payload: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(transport.replies.length, repliesBefore + 2, 'completion sends one answer after the process card')
  const finalReply = transport.replies.at(-1)
  assert.equal(finalReply.data.msg_type, 'post')
  assert.deepEqual(JSON.parse(finalReply.data.content), { zh_cn: { content: [[{ tag: 'md', text: '已完成卡片展示。' }]] } })
  assert.equal(finalReply.data.reply_in_thread, true)
  assert.equal(transport.cardSettings.length, settingsBefore + 1)
  assert.equal(JSON.parse(transport.cardSettings.at(-1).data.settings).config.streaming_mode, false)
  const completed = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.equal(completed.config.streaming_mode, false)
  assert.ok(progressStatus(completed).includes("color='green'"))
  assert.equal(progressButton(completed), undefined, 'completed cards cannot interrupt later turns')
  assert.ok(!JSON.stringify(completed).includes('已完成卡片展示。'), 'the answer is absent from the process card and summary')
  assert.ok(!JSON.stringify(completed).includes('最终回复'))
  const history = completed.body.elements.find(element => element.tag === 'collapsible_panel')
  assert.equal(history.expanded, false)
  assert.ok(JSON.stringify(history).includes('确认改动落在桥接层'))
  assert.ok(JSON.stringify(history).includes('正在按顺序累积每段输出。'), 'earlier process messages remain available')
  const sequences = [
    ...running.map((request) => request.data.sequence),
    transport.cardSettings.at(-1).data.sequence,
    transport.cardUpdates.at(-1).data.sequence
  ]
  for (let i = 1; i < sequences.length; i++) {
    assert.ok(sequences[i] > sequences[i - 1], 'every CardKit operation uses a strictly increasing sequence')
  }
  await bridge.stop()
})

function progressButton(card) {
  return card.body.elements[0].columns.flatMap(column => column.elements).find(element => element.tag === 'button')
}

function progressStatus(card) {
  return card.body.elements[0].columns[0].elements[0].content
}

test('restart delivery gate waits for the final answer, not a later approval-card watermark', async t => {
  const { bridge, sessionId, event, settle } = await progressFixture(t, 'restart-delivery')
  event('turn_started')
  await settle()
  bridge.deps.threadStore.patch(sessionId, { lastPushedSeq: 999 })
  assert.equal(bridge.isTurnReplyDelivered(sessionId, 2), false)
  let release
  const gate = new Promise(resolve => { release = resolve })
  transport.replyHook = async request => {
    if (request.data.msg_type === 'post') await gate
    return { data: { message_id: 'restart-delivered' } }
  }
  transport.clients.at(-1).options.onReconnecting()
  event('turn_completed', {}, 'success')
  await settle()
  assert.equal(bridge.isTurnReplyDelivered(sessionId, 2), false)
  release()
  await settle(); await settle()
  assert.equal(bridge.isTurnReplyDelivered(sessionId, 2), true)
  assert.equal(bridge.isTurnReplyDelivered(sessionId, 3), false)
})

async function progressFixture(t, name, { privateAssistant = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 })
  const sessionId = `session-${name}`
  const store = new FeishuThreadStore(join(directory, name))
  store.upsert({ sessionId, chatId: 'chat-1', rootMessageId: `root-${name}`, lastPushedSeq: 0, driver: 'feishu',
    replyInThread: privateAssistant ? false : undefined })
  const session = { id: sessionId, title: name, status: 'running', config: { agentId: 'codex' } }
  const turn = { ts: Date.now() }
  let answer = '第一轮的最终回复'
  const bridge = makeBridge(store, () => [agent], () => {}, {
    getSessionById: () => session,
    latestAgentMessageText: () => answer,
    getFeishuSendTurn: () => turn
  })
  const settle = () => new Promise(setImmediate)
  const advance = async (milliseconds) => {
    for (let remaining = milliseconds; remaining > 0; remaining -= 1000) {
      t.mock.timers.tick(Math.min(1000, remaining))
      await settle()
    }
  }
  let seq = 0
  const event = (type, payload = {}, state = 'running') => {
    bridge.handleEvent({ sessionId, seq: ++seq, ts: Date.now(), type, state, payload })
  }
  t.after(async () => {
    transport.cardUpdateHook = undefined
    transport.cardSettingsHook = undefined
    transport.replyHook = undefined
    transport.failReplyOnce = false
    await bridge.stop()
  })
  await bridge.start()
  const direct = []
  if (privateAssistant) {
    session.config.assistantSnapshot = {}
    bridge.deps.createAssistantSession = async () => { throw new Error('unexpected_session_creation') }
    bridge.client.im.v1.message.create = async request => {
      direct.push(request)
      return { data: { message_id: `${name}-direct-${direct.length}` } }
    }
  }
  return { sessionId, session, bridge, settle, advance, event, direct, setAnswer: (value) => { answer = value } }
}

test('compact assistant cards retain native reasoning selections without uploading icons', async t => {
  const { session, bridge, event, settle, advance } = await progressFixture(t, 'compact-icons', { privateAssistant: true })
  const uploadsBefore = transport.iconUploads?.length || 0
  event('turn_started')
  await settle()
  const initial = JSON.parse(transport.cardCreates.at(-1).data.data)
  assert.equal(initial.body.elements[1].text.content, 'codex')
  assert.equal(transport.iconUploads?.length || 0, uploadsBefore)
  for (const [config, label] of [
    [{ agentId: 'codex', model: 'gpt-5', effort: 'xhigh' }, 'codex · gpt-5 · 极高'],
    [{ agentId: 'kimi', model: 'kimi-k2', kimiThinking: 'adaptive', effort: 'high' }, 'kimi · kimi-k2 · adaptive'],
    [{ agentId: 'zcode', zcodeModelSelection: { modelId: 'gpt-5', options: { reasoningLevel: 'off' } }, effort: 'high' }, 'zcode · gpt-5 · 关闭']
  ]) {
    session.config = config
    await advance(1000)
    assert.ok(transport.cardUpdates.at(-1).data.card.data.includes(label))
  }
  event('approval_request', {
    requestId: 'compact-confirm', kind: 'question', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'q', question: '继续执行？' }] }
  }, 'pending')
  await advance(1000)
  const waiting = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.ok(progressStatus(waiting).includes('等待你的确认'))
  assert.ok(progressStatus(waiting).includes("color='orange'"))
  await bridge.start({ force: true })
  await settle()
  event('turn_completed', {}, 'failed')
  await advance(1000)
  const failed = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.match(progressStatus(failed), /未完成/)
  assert.ok(progressStatus(failed).includes("color='red'"))
  assert.equal(progressButton(failed), undefined)
  assert.equal(failed.body.elements.find(element => element.tag === 'collapsible_panel').expanded, false)
  event('turn_started')
  await settle()
  assert.equal(transport.iconUploads?.length || 0, uploadsBefore, 'reconnecting and later turns need no icon uploads')
})

test('accepted Feishu additions close only the old card and continue in a new card', async t => {
  const { sessionId, bridge, event, settle, advance } = await progressFixture(t, 'card-continued')
  let interrupts = 0
  bridge.deps.orchestrator.interrupt = () => { interrupts++ }
  event('turn_started', { turnId: 'provider-turn' })
  event('reasoning', { id: 'before', text: '补充前的思考记录' })
  await settle()
  const previous = bridge.progressCards.get(sessionId)
  const previousCard = previous.cardId
  const oldButton = progressButton(JSON.parse(transport.cardCreates.at(-1).data.data))
  const repliesBefore = transport.replies.length
  event('user_message', { source: 'feishu', text: '未接受的新输入' })
  event('user_message', { source: 'mcp', text: '内部追加', appendedToTurn: true })
  await settle()
  assert.equal(bridge.progressCards.get(sessionId), previous, 'only an accepted Feishu addition rotates the card')
  await advance(1000)
  event('user_message', { source: 'feishu', text: '补充要求', appendedToTurn: true })
  await settle()
  const next = bridge.progressCards.get(sessionId)
  assert.notEqual(next.replyUuid, previous.replyUuid)
  assert.equal(next.turnId, 'provider-turn', 'the new card keeps the active provider turn')
  assert.equal(next.startedAt, Date.now(), 'the new card resets elapsed time')
  assert.equal(interrupts, 0, 'changing the progress card does not stop the provider')
  assert.equal(transport.replies.length, repliesBefore + 1, 'the previous card sends no extra final answer')
  const stopped = JSON.parse(transport.cardUpdates.findLast(request => request.path.card_id === previousCard).data.card.data)
  assert.ok(progressStatus(stopped).includes('已中断'))
  assert.ok(JSON.stringify(stopped).includes('补充前的思考记录'))
  assert.equal(progressButton(stopped), undefined)
  assert.equal((await transport.cardHandler({
    messageId: 'bot-reply', chatId: 'chat-1', operator: { openId: 'user-1' },
    action: { tag: 'button', value: oldButton.behaviors[0].value }
  })).toast.type, 'error', 'the previous button cannot stop the continued conversation')
  event('reasoning', { id: 'after', text: '补充后的思考记录' })
  await advance(1000)
  const continued = JSON.parse(transport.cardUpdates.findLast(request => request.path.card_id === next.cardId).data.card.data)
  assert.ok(JSON.stringify(continued).includes('补充后的思考记录'))
  assert.ok(!JSON.stringify(continued).includes('补充前的思考记录'))
  const frozen = JSON.parse(transport.cardUpdates.findLast(request => request.path.card_id === previousCard).data.card.data)
  assert.ok(!JSON.stringify(frozen).includes('补充后的思考记录'))
  event('turn_completed', {}, 'success')
  await settle()
  assert.equal(transport.replies.length, repliesBefore + 2, 'only the latest card sends the completed turn answer')
  assert.equal(bridge.finishingCards.size, 0)
})

test('answering an async question preserves the running card, elapsed time and earlier history', async t => {
  const { sessionId, bridge, event, settle, advance } = await progressFixture(t, 'question-history')
  event('turn_started', { turnId: 'provider-turn' })
  event('agent_message', { id: 'first', phase: 'commentary', text: '答复前已核对任务状态。' }, 'success')
  await settle()
  const previous = bridge.progressCards.get(sessionId)
  const createdBefore = transport.cardCreates.length
  await advance(4000)
  event('user_message', { source: 'feishu', text: '回答 Agent 提问：继续', appendedToTurn: true, asyncQuestion: true })
  event('agent_message', { id: 'second', phase: 'commentary', text: '收到答复，继续查询已有数据。' }, 'success')
  await advance(1000)
  assert.equal(bridge.progressCards.get(sessionId), previous, 'a question answer must not supersede the running card')
  assert.equal(transport.cardCreates.length, createdBefore, 'answering does not create a second process card')
  const running = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.equal(running.body.elements[0].columns[1].elements[0].text.content, '5 秒', 'elapsed time continues from the original turn')
  assert.equal(running.body.elements[2].text.content, '收到答复，继续查询已有数据。')
  const history = running.body.elements.find(element => element.tag === 'collapsible_panel')
  assert.ok(history.header.title.content.includes('思考记录 · 2条'))
  assert.equal(history.elements[0].content, '答复前已核对任务状态。\n\n---\n\n收到答复，继续查询已有数据。')
  assert.equal(history.expanded, false)
  event('turn_completed', {}, 'success')
  await settle()
  const completed = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.equal(completed.body.elements.find(element => element.tag === 'collapsible_panel').elements[0].content, history.elements[0].content,
    'both process entries remain available after completion')
})

test('continued cards wait for the previous card message before appearing', async t => {
  const { bridge, sessionId, event, settle, advance } = await progressFixture(t, 'card-continued-order')
  const createdBefore = transport.cardCreates.length
  let acceptPrevious
  transport.replyHook = request => new Promise(resolve => {
    acceptPrevious = () => {
      transport.replies.push(request)
      resolve({ data: { message_id: 'previous-card-message' } })
    }
  })
  event('turn_started', { turnId: 'provider-turn' })
  await settle()
  const previous = bridge.progressCards.get(sessionId)
  event('user_message', { source: 'feishu', text: '补充要求', appendedToTurn: true })
  await advance(1000)
  assert.equal(transport.cardCreates.length, createdBefore + 1, 'the new card cannot overtake an unfinished send')
  transport.replyHook = undefined
  acceptPrevious()
  await settle()
  await advance(1000)
  assert.equal(previous.messageId, 'previous-card-message')
  assert.equal(transport.cardCreates.length, createdBefore + 2)
  assert.ok(bridge.progressCards.get(sessionId).messageId, 'the new card is sent after its predecessor')
})

test('assistant private final replies retry without rewriting the folded card or replaying answers', async t => {
  const { sessionId, session, bridge, event, settle, advance, direct, setAnswer } = await progressFixture(t, 'assistant-final-retry', { privateAssistant: true })
  event('turn_started')
  event('reasoning', { id: 'r', text: '正在核对任务状态。' })
  const answer = '# 任务进展\n\n- **已完成**：飞书回复\n\n' + '保留完整回答。'.repeat(600)
  setAnswer(answer)
  event('agent_message', { id: 'final', text: answer }, 'success')
  await settle()
  const create = bridge.client.im.v1.message.create
  const attempts = []
  bridge.client.im.v1.message.create = async request => {
    attempts.push(request.data.uuid)
    if (attempts.length === 1) throw new Error('temporary send failure')
    return create(request)
  }
  event('turn_completed', {}, 'success')
  await settle()
  const completed = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.equal(completed.body.elements.find(element => element.tag === 'collapsible_panel').expanded, false)
  assert.ok(JSON.stringify(completed).includes('正在核对任务状态。'))
  assert.ok(!JSON.stringify(completed).includes('保留完整回答。'))
  assert.equal(bridge.finishingCards.size, 1, 'the failed answer stays pending after the card completes')
  bridge.deps.threadStore.remove(sessionId)
  session.assistantEndReason = 'new'
  const updates = transport.cardUpdates.length
  await advance(5000)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0], attempts[1], 'retries share one final-message UUID')
  assert.equal(transport.cardUpdates.length, updates, 'a final-message retry does not rewrite the completed card')
  const reply = direct.at(-1)
  assert.equal(reply.params.receive_id_type, 'chat_id')
  assert.equal(reply.data.msg_type, 'post')
  assert.equal(JSON.parse(reply.data.content).zh_cn.content[0][0].text, answer, 'Markdown answers are not clipped to card limits')
  assert.equal(bridge.deps.threadStore.bySession(sessionId), undefined, 'a /new switch cannot replace the snapshotted reply target')
  assert.equal(bridge.finishingCards.size, 0)
  const sent = direct.length
  await bridge.start({ force: true })
  await advance(5000)
  assert.equal(direct.length, sent, 'reconnect does not resend a delivered answer')
})

test('the interrupt button stops only its bound active turn and remains safe during CardKit failures', async (t) => {
  const { sessionId, session, bridge, event, settle, advance } = await progressFixture(t, 'card-interrupt')
  let interrupts = 0
  let stopFailure = false
  bridge.deps.orchestrator.interrupt = (id) => {
    assert.equal(id, sessionId)
    if (stopFailure) throw new Error('interrupt transport unavailable')
    interrupts++
    session.status = 'cancelling'
    for (const requestId of ['question-1', 'approval-1']) event('approval_request', { requestId, kind: 'question' }, 'cancelled')
  }
  event('turn_started')
  await settle()
  const initial = JSON.parse(transport.cardCreates.at(-1).data.data)
  const button = progressButton(initial)
  assert.equal(button.tag, 'button', 'the stop control remains available outside the history panel')
  assert.equal(button.type, 'danger')
  assert.equal(button.size, 'tiny')
  assert.equal(button.disabled, false)
  const click = {
    messageId: 'bot-reply', chatId: 'chat-1', operator: { openId: 'user-1' },
    action: { tag: 'button', value: button.behaviors[0].value }
  }
  for (const invalid of [
    { ...click, messageId: 'another-message' },
    { ...click, chatId: 'another-chat' },
    { ...click, action: { ...click.action, value: { ...click.action.value, progressId: 'older-turn' } } },
    { ...click, action: { ...click.action, value: { ...click.action.value, sessionId: 'another-session' } } }
  ]) assert.equal((await transport.cardHandler(invalid)).toast.type, 'error')
  for (const status of ['idle', 'completed', 'error', 'archived']) {
    session.status = status
    assert.equal((await transport.cardHandler(click)).toast.type, 'error')
  }
  session.status = 'running'
  session.handoffId = 'unactivated-tool-session'
  assert.equal((await transport.cardHandler(click)).toast.type, 'error')
  delete session.handoffId
  stopFailure = true
  assert.equal((await transport.cardHandler(click)).toast.type, 'error', 'an interrupt failure is visible and retryable')
  assert.equal(interrupts, 0)
  stopFailure = false

  // A provider may report its formal turn ID after the card was already sent.
  event('turn_started', { turnId: 'provider-turn' })
  session.status = 'awaiting-approval'
  bridge.pending.set(sessionId + '/question-1', { sessionId, requestId: 'question-1' })
  bridge.pendingApprovals.set(sessionId + '/approval-1', { sessionId, requestId: 'approval-1' })
  bridge.deps.threadStore.patch(sessionId, { pendingRequestId: 'question-1' })
  transport.cardSettingsHook = () => ({ code: 99991400, msg: 'temporary service failure' })
  const ack = await transport.cardHandler(click)
  assert.equal(ack.toast.type, 'info')
  assert.equal(ack.card, undefined, 'the callback must not overwrite a streaming CardKit entity')
  assert.equal(interrupts, 1, 'stopping the session does not wait for CardKit')
  await settle()
  await transport.cardHandler(click)
  assert.equal(interrupts, 1, 'duplicate deliveries do not repeat the interrupt')
  assert.equal([...bridge.pending.values()].some(request => request.sessionId === sessionId), false)
  assert.equal([...bridge.pendingApprovals.values()].some(request => request.sessionId === sessionId), false)
  assert.equal(bridge.deps.threadStore.bySession(sessionId).pendingRequestId, undefined)

  transport.cardSettingsHook = undefined
  await advance(5000)
  const stopping = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.equal(stopping.config.streaming_mode, false, 'streaming closes before the button state changes')
  assert.equal(progressButton(stopping).disabled, true)
  assert.equal(progressButton(stopping).text.content, '中断中')
  assert.ok(progressStatus(stopping).includes('正在中断'))
  assert.ok(progressStatus(stopping).includes("color='orange'"))
  const closedSequence = transport.cardSettings.at(-1).data.sequence
  assert.ok(transport.cardUpdates.at(-1).data.sequence > closedSequence)
  event('reasoning', { id: 'late', text: '中断前已产生的输出' })
  await advance(1000)
  assert.equal(progressButton(JSON.parse(transport.cardUpdates.at(-1).data.card.data)).disabled, true)
  event('turn_completed', {}, 'cancelled')
  await settle()
  const stopped = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  assert.ok(progressStatus(stopped).includes('已中断'))
  assert.ok(progressStatus(stopped).includes("color='grey'"))
  assert.equal(progressButton(stopped), undefined)
  assert.ok(JSON.stringify(stopped).includes('中断前已产生的输出'))

  session.status = 'queued'
  event('turn_started', { turnId: 'next-turn' })
  await settle()
  assert.equal((await transport.cardHandler(click)).toast.type, 'error', 'an old card cannot stop the next turn')
  assert.equal(interrupts, 1)
  const next = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
  await transport.cardHandler({ ...click, action: { ...click.action, value: progressButton(next).behaviors[0].value } })
  assert.equal(interrupts, 2, 'the current card also stops a session with queued messages')
})

test('interrupting invalidates queued approvals and late approval delivery results', async (t) => {
  const { sessionId, session, bridge, event, settle } = await progressFixture(t, 'card-interrupt-approval')
  bridge.deps.orchestrator.interrupt = () => { session.status = 'cancelling' }
  for (const inFlight of [false, true]) {
    session.status = 'running'
    event('turn_started')
    await settle()
    const card = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
    let release
    if (inFlight) transport.replyHook = () => new Promise((resolve) => { release = resolve })
    else bridge.enqueuePush(sessionId, () => new Promise((resolve) => { release = resolve }))
    await settle()
    const attemptsBefore = transport.cardReplyAttempts
    event('approval_request', {
      requestId: `question-${inFlight}`, kind: 'question', method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', question: '继续执行？' }] }
    }, 'pending')
    await settle()
    try {
      await transport.cardHandler({
        messageId: 'bot-reply', chatId: 'chat-1',
        action: { tag: 'button', value: progressButton(card).behaviors[0].value }
      })
      event('turn_completed', {}, 'cancelled')
    } finally {
      release?.({ data: { message_id: 'late-approval', thread_id: 'thread-1' } })
      transport.replyHook = undefined
    }
    await settle()
    assert.equal(transport.cardReplyAttempts, attemptsBefore + Number(inFlight), 'an approval still queued at interruption must not be sent')
    assert.equal(bridge.pending.has(sessionId), false)
    assert.equal(bridge.deps.threadStore.bySession(sessionId).pendingRequestId, undefined, 'a late reply must not restore the cancelled request')
  }
})

test('connection reinitialization preserves the card, elapsed time, sequence and offline output', async (t) => {
  const fixture = await progressFixture(t, 'card-reconnect')
  const { bridge, event, settle, advance, sessionId } = fixture
  const repliesBefore = transport.replies.length
  const createsBefore = transport.cardCreates?.length || 0
  event('turn_started', { threadId: 'thread-reconnect' })
  await settle()
  const first = transport.cardUpdates.at(-1)
  event('turn_started', { turnId: 'turn-reconnect', threadId: 'thread-reconnect' })
  await settle()
  const previousWs = transport.clients.at(-1)
  previousWs.options.onReconnecting()
  event('reasoning', { id: 'offline', text: '断线期间继续产生的思考' })
  await advance(2000)
  await bridge.start({ force: true })
  await settle()
  previousWs.options.onError(new Error('obsolete connection'))
  await advance(1000)
  const resumed = transport.cardUpdates.at(-1)
  assert.equal(bridge.getStatus().connected, true, 'old callbacks cannot change the new connection')
  assert.equal(transport.cardCreates.length, createsBefore + 1)
  assert.equal(transport.replies.length, repliesBefore + 1)
  assert.equal(resumed.path.card_id, first.path.card_id)
  assert.ok(resumed.data.sequence > first.data.sequence)
  assert.ok(resumed.data.card.data.includes('断线期间继续产生的思考'))
  assert.ok(resumed.data.card.data.includes('3 秒'), 'restart preserves the original start time')
  const logs = transport.logs.filter((entry) => entry.sessionId === sessionId)
  const resumedLog = logs.find((entry) => entry.kind === 'feishu_progress_resumed' && entry.data.cardId === first.path.card_id)
  assert.equal(resumedLog.data.turnId, 'turn-reconnect', 'the formal start event fills in the missing turn ID')
  assert.equal(resumedLog.data.processId, process.pid)
  assert.equal(resumedLog.data.replyUuid, transport.replies.at(-1).data.uuid)
  assert.ok(resumed.data.sequence > resumedLog.data.sequence, 'card updates advance after the recorded reconnect state')
})

test('a blocked message send cannot block progress card ticks or completion', async (t) => {
  const { bridge, event, settle, advance, sessionId } = await progressFixture(t, 'card-independent')
  event('turn_started')
  await settle()
  const before = transport.cardUpdates.length
  let release
  transport.replyHook = request => {
    if (request.data.msg_type === 'text') return new Promise((resolve) => { release = resolve })
    transport.replies.push(request)
    return { data: { message_id: 'independent-final' } }
  }
  const sending = bridge.sendToSession(sessionId, 'caption', [], Date.now())
  await settle()
  try {
    assert.equal(typeof release, 'function', 'the ordinary reply is still in flight')
    await advance(2000)
    assert.ok(transport.cardUpdates.length >= before + 2)
    event('turn_completed', {}, 'success')
    await settle()
    const completed = JSON.parse(transport.cardUpdates.at(-1).data.card.data)
    assert.ok(progressStatus(completed).includes('已完成'))
    assert.equal(completed.body.elements.find(element => element.tag === 'collapsible_panel').expanded, false)
  } finally {
    release?.({ data: { message_id: 'caption-message' } })
    await sending
  }
})

test('a hung CardKit request times out, logs metadata and recovers without replaying late results', async (t) => {
  const { event, settle, advance, sessionId } = await progressFixture(t, 'card-timeout')
  event('turn_started')
  await settle()
  let resolveLate
  transport.cardUpdateHook = () => new Promise((resolve) => { resolveLate = resolve })
  event('reasoning', { id: 'private', text: 'private-prompt-and-token' })
  await advance(1000)
  const pending = transport.cardUpdates.at(-1)
  await advance(15_000)
  const logs = () => transport.logs.filter((entry) => entry.sessionId === sessionId)
  const failure = logs().find((entry) => entry.kind === 'feishu_progress_request_failed')
  assert.equal(failure.data.failureKind, 'timeout')
  assert.equal(failure.data.operation, 'update_card')
  assert.equal(failure.data.durationMs, 15_000)
  assert.equal(failure.data.cardId, pending.path.card_id)
  transport.cardUpdateHook = undefined
  await advance(5000)
  const recovered = transport.cardUpdates.at(-1)
  assert.ok(recovered.data.sequence > pending.data.sequence)
  assert.equal(recovered.path.card_id, pending.path.card_id)
  assert.ok(logs().some((entry) => entry.kind === 'feishu_progress_recovered'))
  assert.ok(!JSON.stringify(logs()).includes('private-prompt-and-token'))
  const count = transport.cardUpdates.length
  resolveLate({})
  await settle()
  assert.equal(transport.cardUpdates.length, count, 'a late response cannot restart the expired worker')
})

test('a failed card completion cannot block final messages or mix newer turns on reconnect', async (t) => {
  const { bridge, event, settle, advance, setAnswer } = await progressFixture(t, 'card-final-retry')
  event('turn_started', { turnId: 'first' })
  await settle()
  const firstCardId = transport.cardUpdates.at(-1).path.card_id
  await advance(2000)
  transport.clients.at(-1).options.onReconnecting()
  transport.cardUpdateHook = (request) => request.path.card_id === firstCardId
    ? { code: 99991400, msg: 'temporary service failure' } : {}
  event('turn_completed', {}, 'success')
  await settle()
  const firstReply = transport.replies.at(-1)
  assert.equal(firstReply.data.msg_type, 'post')
  assert.ok(firstReply.data.content.includes('第一轮的最终回复'), 'the answer does not wait for a CardKit retry')
  setAnswer('第二轮的回复')
  event('turn_started', { turnId: 'second' })
  await settle()
  transport.cardUpdateHook = undefined
  await bridge.start({ force: true })
  await settle()
  await advance(5000)
  const firstFinal = transport.cardUpdates.filter((request) => request.path.card_id === firstCardId).at(-1)
  assert.ok(!firstFinal.data.card.data.includes('第一轮的最终回复'))
  assert.ok(!firstFinal.data.card.data.includes('第二轮的回复'))
  assert.ok(firstFinal.data.card.data.includes('2 秒'))
  assert.equal(JSON.parse(firstFinal.data.card.data).config.streaming_mode, false)
  assert.equal(transport.replies.filter(request => request.data.uuid === firstReply.data.uuid).length, 1,
    'card retries do not send the final answer again')
  assert.equal(transport.cardSettings.filter((request) => request.path.card_id === firstCardId).length, 1,
    'successful stream closure is preserved across retries')
})

test('retrying a failed card send reuses the created card entity', async (t) => {
  const { event, settle, advance } = await progressFixture(t, 'card-send-retry')
  const createsBefore = transport.cardCreates?.length || 0
  transport.failReplyOnce = true
  event('turn_started')
  await settle()
  const cardId = `card-${transport.cardCreates.length}`
  await advance(5000)
  assert.equal(transport.cardCreates.length, createsBefore + 1)
  assert.equal(JSON.parse(transport.replies.at(-1).data.content).data.card_id, cardId)
  assert.equal(transport.cardUpdates.at(-1).path.card_id, cardId)
})

test('a card send receipt survives a deadline and same-Bot reconnect without rebinding', async (t) => {
  const { bridge, event, settle, advance, sessionId } = await progressFixture(t, 'card-late-receipt')
  let resolveSend
  let sends = 0
  transport.replyHook = () => { sends++; return new Promise(resolve => { resolveSend = resolve }) }
  event('turn_started')
  await settle()
  await advance(15_000)
  await bridge.start({ force: true })
  resolveSend({ data: { message_id: 'accepted-before-reconnect', thread_id: 'thread-1' } })
  await settle()
  await advance(5000)
  assert.equal(sends, 1, 'the accepted card entity must not be bound twice')
  assert.equal(bridge.progressCards.get(sessionId).messageId, 'accepted-before-reconnect')
  assert.ok(transport.cardUpdates.some(request => request.path.card_id === bridge.progressCards.get(sessionId).cardId))
})

test('stopping the Bot discards late card receipts', async (t) => {
  const { bridge, event, settle, sessionId } = await progressFixture(t, 'card-stopped-receipt')
  let resolveSend
  transport.replyHook = () => new Promise(resolve => { resolveSend = resolve })
  event('turn_started')
  await settle()
  const progress = bridge.progressCards.get(sessionId)
  await bridge.stop()
  resolveSend({ data: { message_id: 'obsolete-receipt', thread_id: 'thread-1' } })
  await settle()
  assert.equal(progress.messageId, undefined)
  assert.equal(bridge.progressCards.size, 0)
})

test('a permanent card binding rejection stops retries and sends the failed turn result once', async (t) => {
  const { bridge, event, settle, advance, sessionId } = await progressFixture(t, 'card-permanent')
  let sends = 0
  transport.replyHook = request => {
    if (request.data.msg_type === 'interactive') {
      sends++
      throw Object.assign(new Error('HTTP 400'), { response: {
        status: 400, data: { code: 230099, msg: 'Failed to create card content, ext=ErrCode: 200780; ErrMsg: card binding biz count over limit;' }
      } })
    }
    transport.replies.push(request)
    return { data: { message_id: 'fallback-final' } }
  }
  event('turn_started')
  await settle()
  await advance(120_000)
  assert.equal(sends, 1)
  assert.equal(bridge.progressCards.get(sessionId).timer, undefined)
  event('error', { message: '保留本轮失败原因' }, 'failed')
  event('turn_completed', {}, 'failed')
  await settle()
  const fallback = transport.replies.at(-1)
  assert.equal(fallback.data.msg_type, 'post')
  assert.ok(fallback.data.content.includes('保留本轮失败原因'))
  const count = transport.replies.length
  await bridge.start({ force: true })
  await advance(60_000)
  assert.equal(transport.replies.length, count)
})

test('transient CardKit failures have a finite retry budget and keep the original final result', async (t) => {
  const { bridge, event, settle, advance, setAnswer } = await progressFixture(t, 'card-retry-limit')
  const repliesBefore = transport.replies.length
  event('turn_started')
  await settle()
  const cardId = transport.cardUpdates.at(-1).path.card_id
  let failures = 0
  transport.cardUpdateHook = request => {
    if (request.path.card_id !== cardId) return {}
    failures++
    throw Object.assign(new Error('DNS unavailable'), { code: 'ENOTFOUND' })
  }
  event('turn_completed', {}, 'success')
  await settle()
  setAnswer('第二轮的内容不应出现在第一轮兜底回复')
  event('turn_started')
  await settle()
  event('turn_completed', {}, 'success')
  await settle()
  await advance(600_000)
  assert.equal(failures, 10)
  const fallback = transport.replies.slice(repliesBefore).find(request => request.data.msg_type === 'post' && request.data.content.includes('第一轮的最终回复'))
  assert.ok(fallback.data.content.includes('第一轮的最终回复'))
  assert.ok(!fallback.data.content.includes('第二轮的内容'))
  assert.equal(bridge.finishingCards.size, 0)
})

test('orphaned team sessions use their saved title without hiding unrelated binding errors', async (t) => {
  const { bridge, session } = await progressFixture(t, 'orphan-title')
  session.teamBinding = { teamProjectId: 'deleted-project', memberId: 'leader' }
  bridge.deps.teams = { binding() { throw new Error('team_project_not_found') } }
  assert.equal(bridge.threadTitle(session), session.title)
  bridge.deps.teams.binding = () => { throw new Error('team_session_binding_conflict') }
  assert.throws(() => bridge.threadTitle(session), /team_session_binding_conflict/)
})

test('a stale pending answer reports failure without sending a new turn', async () => {
  const stateDirectory = join(directory, 'stale-answer-state')
  const store = new FeishuThreadStore(stateDirectory)
  store.upsert({
    sessionId: 'session-stale',
    chatId: 'chat-1',
    rootMessageId: 'om-stale-root',
    threadId: 'thread-stale',
    lastPushedSeq: 0,
    driver: 'feishu'
  })
  let responses = 0
  let sends = 0
  const bridge = makeBridge(
    store,
    () => [agent],
    () => { throw new Error('unexpected create') },
    {
      getSessionById: () => ({ id: 'session-stale' }),
      respondToRequest: () => { responses += 1; return { handled: false, hasPendingRequests: false } },
      forceSend: async (_sessionId, text) => { assertFeishuPrompt(text, 'hello'); sends += 1 }
    }
  )
  await bridge.start()
  bridge.pending.set('session-stale/request-stale', { sessionId: 'session-stale', requestId: 'request-stale', kind: 'question', method: 'item/tool/request' })
  const reply = {
    ...message('om-stale-answer'),
    message: { ...message('om-stale-answer').message, thread_id: 'thread-stale' }
  }

  await emit(reply)
  await emit(reply)
  assert.equal(responses, 1)
  assert.equal(sends, 0, 'a rejected answer must never be retried as a new Agent turn')
  assert.ok(transport.replies.at(-1).data.content.includes('回答提交失败'))
})

test('continuing an archived session restores it then sends the message', async () => {
  const store = new FeishuThreadStore(join(directory, 'archived-continue-state'))
  store.upsert({
    sessionId: 'session-archived', chatId: 'chat-1', rootMessageId: 'om-archived-root',
    threadId: 'thread-archived', lastPushedSeq: 0, driver: 'feishu'
  })
  const session = { id: 'session-archived', archived: true }
  let unarchived
  let sent
  const bridge = makeBridge(store, () => [agent], () => { throw new Error('unexpected create') }, {
    getSessionById: () => session,
    setArchived: (id, archived) => { unarchived = { id, archived }; session.archived = archived },
    forceSend: async (sessionId, text) => { sent = { sessionId, text } }
  })
  await bridge.start()
  const reply = { ...message('om-archived-reply'), message: { ...message('om-archived-reply').message, thread_id: 'thread-archived' } }

  await emit(reply)

  assert.deepEqual(unarchived, { id: 'session-archived', archived: false }, 'the archived session is restored first')
  assert.equal(sent.sessionId, 'session-archived')
  assertFeishuPrompt(sent.text, 'hello')
})

test('continuing a deleted session replies a notice instead of failing', async () => {
  const store = new FeishuThreadStore(join(directory, 'deleted-continue-state'))
  store.upsert({
    sessionId: 'session-deleted', chatId: 'chat-1', rootMessageId: 'om-deleted-root',
    threadId: 'thread-deleted', lastPushedSeq: 0, driver: 'feishu'
  })
  let sends = 0
  const bridge = makeBridge(store, () => [agent], () => { throw new Error('unexpected create') }, {
    getSessionById: () => undefined,
    forceSend: async () => { sends += 1 }
  })
  await bridge.start()
  const repliesBefore = transport.replies.length
  const reply = { ...message('om-deleted-reply'), message: { ...message('om-deleted-reply').message, thread_id: 'thread-deleted' } }

  await emit(reply)

  assert.equal(sends, 0, 'a deleted session never runs a turn')
  const notice = transport.replies.slice(repliesBefore).map((r) => JSON.stringify(r.data.content)).join('\n')
  assert.ok(notice.includes('已被删除'), 'the user is told the session was deleted')
  assert.equal(store.hasHandledInbound('om-deleted-reply'), true, 'the notice path is handled, not left retryable')
})

test('the Feishu connection waits for core Agent discovery', async () => {
  const source = await readFile('src/main/index.ts', 'utf8')
  assert.match(source, /async function startFeishuBridgeWhenReady[\s\S]{0,380}await startupCoreReady[\s\S]{0,180}agents\.some[\s\S]{0,180}availability === 'available'[\s\S]{0,180}bridge\.start/)
  assert.match(source, /void startupCoreReady\?\.then\(async \(\) => {[\s\S]{0,300}startFeishuBridgeWhenReady/)
  assert.match(source, /IPC\.detectAgents[\s\S]{0,900}startupCoreReady = Promise\.resolve\(agents\)[\s\S]{0,180}restartConfiguredFeishuBridges/)
  assert.match(source, /next\.feishu\?\.enabled\) void startFeishuBridgeWhenReady\(\)\.catch/)
})

test('an existing thread root is treated as an already handled inbound message', async () => {
  const store = new FeishuThreadStore(join(directory, 'legacy-state'))
  store.upsert({
    sessionId: 'session-1',
    chatId: 'chat-1',
    rootMessageId: 'om-existing',
    lastPushedSeq: 1,
    driver: 'feishu'
  })
  store.rememberInbound('om-other')

  let created = 0
  const restarted = makeBridge(
    new FeishuThreadStore(join(directory, 'legacy-state')),
    () => [agent],
    (config, text) => ({ id: `new-${++created}`, title: text, config })
  )
  await restarted.start()
  await emit(message('om-existing'))
  assert.equal(created, 0)
})

test('scanGroups paginates groups and retains legacy entries without chat_mode', async () => {
  transport.chatPages = {
    '': { items: [
      { chat_id: 'oc_g1', name: '发布通知群' },
      { chat_id: 'oc_known_dm', name: '私人聊天', chat_mode: 'p2p' },
      { chat_id: 'oc_p1', name: '张三' }
    ], has_more: true, page_token: 'p2' },
    p2: { items: [
      { chat_id: 'oc_g2', name: '值班群' },
      { chat_id: 'oc_t1', name: '某话题' }
    ], has_more: false }
  }
  const bridge = makeBridge(
    new FeishuThreadStore(join(directory, 'scan-state')),
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  await bridge.start()
  const groups = await bridge.scanGroups()
  assert.deepEqual(groups, [
    { chatId: 'oc_g1', name: '发布通知群' },
    { chatId: 'oc_p1', name: '张三' },
    { chatId: 'oc_g2', name: '值班群' },
    { chatId: 'oc_t1', name: '某话题' }
  ], 'every chat, following pagination')
  delete transport.chatPages
})

test('scanGroups rejects when the bridge is not connected', async () => {
  const bridge = makeBridge(
    new FeishuThreadStore(join(directory, 'scan-disconnected-state')),
    () => [agent],
    (config, text) => ({ id: 'unused', title: text, config })
  )
  // never start() → not connected
  await assert.rejects(bridge.scanGroups(), /未连接/)
})

// 需求 — a group message offers a card whenever the bot is @-mentioned. Feishu
// only delivers @-bot群消息 by default, so the mention is the gate; the notify-
// group binding is outbound-only and must NOT decide which群 can start a话题.
test('a group message offers a card whenever the bot is @-mentioned', async () => {
  const groupMessage = (id, chatId, mentioned) => ({
    event_id: id,
    sender: { sender_type: 'user' },
    message: {
      message_id: id, chat_id: chatId, chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 跑个任务' }),
      mentions: mentioned ? [{ key: '@_user_1' }] : []
    }
  })
  const bound = { enabled: true, appId: 'cli_1234567890abcdef', appSecret: 'secret', notifyChatId: 'oc_bound' }
  const bridge = new FeishuBridge({
    orchestrator: { createSession: (config, text) => ({ id: 'unused', title: text, config }), getSessionById: () => undefined, listSessions: () => [] },
    threadStore: new FeishuThreadStore(join(directory, 'group-offer-state')),
    getAgents: () => [agent],
    getSettings: () => bound,
    onStatus: () => {}
  })
  await bridge.start()
  await emit(groupMessage('om-grp-nomention', 'oc_bound', false))
  assert.equal(offersFor('om-grp-nomention'), 0, 'no @-mention is ignored')
  await emit(groupMessage('om-grp-other', 'oc_other', true))
  assert.equal(offersFor('om-grp-other'), 1, 'an @-mention offers a card even outside the notify group')
  await emit(groupMessage('om-grp-ok', 'oc_bound', true))
  assert.equal(offersFor('om-grp-ok'), 1, 'an @-mention in the bound group offers a card')
})

const assistantFixture = async (t, name) => {
  const stateDir = join(directory, name)
  const store = new FeishuThreadStore(stateDir)
  const sessions = new Map()
  const created = [], sent = [], direct = [], threaded = [], commands = []
  const newSession = () => {
    const session = { id: `${name}-${sessions.size}`, status: 'idle', config: { assistantSnapshot: {} } }
    sessions.set(session.id, session)
    return session
  }
  const bridge = new FeishuBridge({
    orchestrator: {
      getSessionById: id => sessions.get(id), listSessions: () => [...sessions.values()],
      forceSend: async (sessionId, text) => { sent.push({ sessionId, text }) }
    },
    threadStore: store, getAgents: () => [agent],
    getSettings: () => ({ enabled: true, appId: 'cli_assistant', appSecret: 'fixture' }),
    onStatus() {},
    createAssistantSession: async (text, _attachments, bind, assertCurrent) => {
      await new Promise(setImmediate)
      assertCurrent()
      const session = newSession()
      created.push({ sessionId: session.id, text })
      bind(session)
      return session
    },
    assistantCommand: async (id, command) => {
      commands.push({ id, command })
      sessions.get(id).assistantEndReason = command
      return newSession()
    }
  })
  await bridge.start()
  bridge.client.im.v1.message.create = async request => {
    direct.push(request)
    return { data: { message_id: `${name}-direct-${direct.length}` } }
  }
  bridge.client.im.v1.message.reply = async request => {
    threaded.push(request)
    return { data: { message_id: `${name}-reply-${threaded.length}`, thread_id: `thread-${request.path.message_id}` } }
  }
  t.after(async () => { await bridge.stop(); bridge.dispose() })
  const input = (id, text, extra = {}) => ({
    ...message(id), message: { ...message(id).message, content: JSON.stringify({ text }), ...extra }
  })
  return { bridge, store, stateDir, sessions, newSession, created, sent, direct, threaded, commands, input }
}

test('assistant resident badge follows persisted private bindings, not App notification links or other bots', async t => {
  const { bridge, store, sessions, stateDir, newSession, created, input } = await assistantFixture(t, 'assistant-resident-badge')
  await emit(input('resident-first', 'hello'))
  const first = created[0].sessionId
  const notification = newSession()
  await bridge.ensureThread(notification)
  const group = newSession(), otherBot = newSession(), deleted = newSession()
  store.upsert({ sessionId: group.id, chatId: 'group', rootMessageId: 'group-root', replyInThread: true, botAppId: 'cli_assistant', lastPushedSeq: 0 })
  store.upsert({ sessionId: otherBot.id, chatId: 'chat-1', rootMessageId: 'other-root', replyInThread: false, botAppId: 'cli_other', lastPushedSeq: 0 })
  store.upsert({ sessionId: deleted.id, chatId: 'chat-1', rootMessageId: 'deleted-root', replyInThread: false, botAppId: 'cli_assistant', lastPushedSeq: 0 })
  sessions.delete(deleted.id)
  assert.deepEqual(bridge.getAssistantPrivateSessions().map(link => link.sessionId), [first])
  bridge.deps.threadStore = new FeishuThreadStore(stateDir)
  assert.deepEqual(bridge.getAssistantPrivateSessions().map(link => link.sessionId), [first], 'restart retains the same badge source')
  bridge.shouldPush = () => false
  assert.equal(bridge.shouldPushFor(first), true, 'App foreground does not mute a resident private conversation')
  assert.equal(bridge.shouldPushFor(notification.id), false)
  assert.equal(bridge.shouldPushFor(group.id), false)
})

test('assistant mirrors visible App input once, strips injected context and excludes Feishu and native replays', async t => {
  const { bridge, store, newSession, created, direct, input } = await assistantFixture(t, 'assistant-input-mirror')
  await emit(input('mirror-first', 'hello'))
  const id = created[0].sessionId, before = direct.length
  const event = { sessionId: id, seq: 10, ts: Date.now(), type: 'user_message', payload: {
    source: 'app', assistantMessageId: 'app-input',
    text: '[uniagent_personal_assistant_context]\nPRIVATE SOUL AND MEMORY\n\n当前用户输入：\n整理今天的待办'
  } }
  bridge.handleEvent(event)
  bridge.handleEvent({ ...event, seq: 11 })
  await bridge.pushChains.get(id)
  assert.equal(direct.length, before + 1)
  assert.equal(direct.at(-1).data.receive_id, 'chat-1')
  assert.equal(direct.at(-1).data.msg_type, 'text')
  assert.equal(JSON.parse(direct.at(-1).data.content).text, '来自 UniAgent 的输入：\n\n整理今天的待办')
  assert.match(direct.at(-1).data.uuid, /^[a-f0-9]{32}$/)
  assert.equal(store.bySession(id).driver, 'app')
  const mirrored = direct.length
  for (const payload of [
    { source: 'feishu' }, { source: 'mcp' }, { source: 'app', channel: 'side' },
    { source: 'app', hidden: true }, { source: 'app', zcodeProjection: true }, { source: 'app', subagentId: 'worker' }
  ]) bridge.handleEvent({ ...event, payload: { ...event.payload, assistantMessageId: JSON.stringify(payload), ...payload } })
  const unbound = newSession()
  await bridge.ensureThread(unbound)
  bridge.handleEvent({ ...event, sessionId: unbound.id })
  await bridge.pushChains.get(id)
  assert.equal(direct.length, mirrored, 'mirrored and internal inputs cannot echo back')
  bridge.handleEvent({ ...event, seq: 12, payload: { source: 'app', assistantMessageId: 'visible', displayText: '用户看见的原文', text: 'internal expanded references' } })
  await bridge.pushChains.get(id)
  assert.equal(JSON.parse(direct.at(-1).data.content).text, '来自 UniAgent 的输入：\n\n用户看见的原文')
})

test('App new and clear move the private session and announce each command once', async t => {
  const { bridge, store, sessions, stateDir, newSession, created, direct, sent, input } = await assistantFixture(t, 'assistant-app-commands')
  await emit(input('app-command-first', 'hello'))
  const first = created[0].sessionId
  let previous = first
  for (const command of ['new', 'clear']) {
    const next = newSession(), before = direct.length
    sessions.get(previous).assistantEndReason = command
    bridge.rebindAssistantSession(previous, next, { command, requestId: `app-${command}` })
    bridge.rebindAssistantSession(previous, next, { command, requestId: `app-${command}` })
    await bridge.pushChains.get(next.id)
    assert.equal(store.bySession(previous), undefined)
    assert.deepEqual(bridge.getAssistantPrivateSessions().map(link => link.sessionId), [next.id])
    assert.equal(new FeishuThreadStore(stateDir).bySession(next.id).chatId, 'chat-1')
    assert.equal(direct.length, before + 1, 'retry does not announce or move twice')
    assert.ok(JSON.parse(direct.at(-1).data.content).text.startsWith(`来自 UniAgent：/${command}`))
    previous = next.id
  }
  await emit(input('app-command-follow-up', 'continue', { root_id: 'app-command-first', parent_id: 'old-message' }))
  assert.equal(sent.at(-1).sessionId, previous, 'Feishu follows the App command even when replying to an old message')
  const count = direct.length
  bridge.handleEvent({ sessionId: first, seq: 9, ts: Date.now(), type: 'user_message', payload: { source: 'app', text: 'old conversation', assistantMessageId: 'old-app' } })
  await bridge.pushChains.get(first)
  assert.equal(direct.length, count, 'previous sessions stop mirroring input')
})

test('App session commands serialize with private inbound messages before moving the binding', async t => {
  const { bridge, created, sent, input } = await assistantFixture(t, 'assistant-command-race')
  await emit(input('race-first', 'hello'))
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const execute = bridge.deps.assistantCommand
  bridge.deps.assistantCommand = async (...args) => { entered(); await gate; return execute(...args) }
  const command = bridge.executeAssistantCommandFromApp(created[0].sessionId, 'new', 'app-command')
  await started
  const message = emit(input('race-next', 'new input'))
  await new Promise(setImmediate)
  assert.equal(sent.length, 0, 'inbound waits for the App command to commit')
  release()
  const next = await command
  await message
  assert.equal(sent.at(-1).sessionId, next.id)
  await bridge.pushChains.get(next.id)
})

test('assistant input mirror uploads attached files and chunks long text without changing characters', async t => {
  const { bridge, created, direct, stateDir, input } = await assistantFixture(t, 'assistant-attachments')
  await emit(input('attachments-first', 'hello'))
  const path = join(stateDir, 'note.txt')
  await writeFile(path, 'uploaded note')
  const uploads = []
  bridge.client.im.v1.file = { create: async request => { uploads.push(request); return { file_key: 'note-key' } } }
  const id = created[0].sessionId, before = direct.length, text = '😀'.repeat(3001)
  bridge.handleEvent({ sessionId: id, seq: 1, ts: Date.now(), type: 'user_message', payload: {
    source: 'app', text, assistantMessageId: 'attachment-input', attachments: [{ kind: 'file', path, name: 'note.txt' }]
  } })
  await bridge.pushChains.get(id)
  const messages = direct.slice(before)
  assert.deepEqual(messages.map(item => item.data.msg_type), ['text', 'text', 'file'])
  assert.equal(messages.slice(0, 2).map(item => JSON.parse(item.data.content).text).join('').replace('来自 UniAgent 的输入：\n\n', ''), text)
  assert.equal(uploads[0].data.file_name, 'note.txt')
  assert.equal(uploads[0].data.file.toString(), 'uploaded note')
  assert.equal(JSON.parse(messages[2].data.content).file_key, 'note-key')
  assert.equal(new Set(messages.map(item => item.data.uuid)).size, 3)
})

test('assistant private messages share one session and /new switches even replies to old topics', async t => {
  const { bridge, store, stateDir, sessions, newSession, created, sent, direct, threaded, commands, input } = await assistantFixture(t, 'assistant-private')
  await Promise.all([emit(input('om-assistant-first', 'hello')), emit(input('om-assistant-second', 'follow up'))])
  assert.equal(created.length, 1, 'concurrent private messages must not create two sessions')
  const first = created[0].sessionId
  assert.equal(sent[0].sessionId, first)
  assertFeishuPrompt(sent[0].text, 'follow up')
  assert.equal(store.bySession(first).replyInThread, false)
  assert.equal(new FeishuThreadStore(stateDir).bySession(first).replyInThread, false, 'direct routing survives restart')

  await bridge.replyText(store.bySession(first), 'answer')
  assert.equal(direct.at(-1).params.receive_id_type, 'chat_id')
  assert.equal(direct.at(-1).data.receive_id, 'chat-1')
  const repliesBefore = direct.length
  await bridge.pushApproval(store.bySession(first), {
    sessionId: first, seq: 1, state: 'pending', payload: {
      requestId: 'private-question', kind: 'question', method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', question: '继续？' }] }
    }
  })
  assert.equal(direct.length, repliesBefore + 1, 'questions also stay in the private chat')
  assert.equal(direct.at(-1).data.msg_type, 'interactive')
  bridge.clearPendingRequest(first, 'private-question')

  await emit(input('om-assistant-new', '/new'))
  assert.deepEqual(commands, [{ id: first, command: 'new' }])
  assert.equal(store.bySession(first), undefined)
  assert.equal(await bridge.ensureThread(sessions.get(first)), undefined, 'an ended session must not recreate its private binding')
  const current = store.all()[0].sessionId
  assert.notEqual(current, first)
  const appSession = newSession()
  const appBinding = await bridge.ensureThread(appSession)
  assert.equal(appBinding.replyInThread, false)
  assert.equal(appBinding.rootMessageId, '', 'App notifications do not create a topic')
  await emit(input('om-assistant-old-topic', 'continue', {
    root_id: 'om-assistant-first', parent_id: 'old-answer', thread_id: 'old-thread'
  }))
  assert.equal(sent.at(-1).sessionId, current, 'old references and App notifications must not replace the resident session')
  assert.equal(threaded.length, 0, 'private replies never use reply_in_thread')
})

test('assistant legacy private bindings and unbound command replies stay in the chat', async t => {
  const { bridge, store, stateDir, newSession, created, sent, direct, threaded, input } = await assistantFixture(t, 'assistant-legacy')
  await emit(input('om-assistant-unbound-new', '/new'))
  assert.equal(created.length, 0)
  assert.equal(direct.length, 1, 'an unbound command sends a direct notice')
  const session = newSession()
  store.upsert({ sessionId: session.id, chatId: 'chat-1', rootMessageId: 'legacy-root', threadId: 'legacy-topic',
    botAppId: 'cli_assistant', rootAppId: 'cli_assistant', lastPushedSeq: 10 })
  const restored = await bridge.ensureThread(session)
  assert.equal(restored.replyInThread, false)
  assert.equal(restored.threadId, undefined)
  assert.equal(restored.lastPushedSeq, 10)
  assert.equal(new FeishuThreadStore(stateDir).bySession(session.id).replyInThread, false)
  bridge.handleSessionUpdated(session)
  assert.equal(bridge.pushChains.size, 0, 'private chats have no topic title to synchronize')
  await emit(input('om-assistant-legacy-input', 'keep context', { root_id: 'legacy-root', thread_id: 'legacy-topic' }))
  assert.equal(created.length, 0)
  assert.equal(sent.at(-1).sessionId, session.id)
  await bridge.replyText(restored, 'answer')
  assert.equal(threaded.length, 0)
})

test('assistant group mentions bind the existing topic or create an independent topic', async t => {
  const { bridge, store, stateDir, sessions, created, sent, direct, threaded, input } = await assistantFixture(t, 'assistant-group')
  const group = (id, text, extra = {}) => input(id, text, {
    chat_id: 'group-1', chat_type: 'group', mentions: [{ key: '@_user_1' }], ...extra
  })
  await emit(group('om-assistant-no-mention', 'ignore', { mentions: [] }))
  assert.equal(created.length, 0)
  await emit(group('om-assistant-existing-topic', '@_user_1 first', { root_id: 'existing-root', thread_id: 'existing-thread' }))
  const first = created[0].sessionId
  assertFeishuPrompt(created[0].text, 'first')
  assert.equal(store.bySession(first).rootMessageId, 'existing-root')
  assert.equal(store.bySession(first).replyInThread, true)
  assert.equal(new FeishuThreadStore(stateDir).bySession(first).replyInThread, true)
  await emit(group('om-assistant-topic-follow-up', '@_user_1 again', { thread_id: 'existing-thread' }))
  await emit(group('om-assistant-topic-parent', '@_user_1 by root', { parent_id: 'existing-root' }))
  assert.equal(created.length, 1)
  assert.ok(sent.every(item => item.sessionId === first))
  await emit(group('om-assistant-bound-no-mention', 'ignore', { mentions: [], thread_id: 'existing-thread' }))
  assert.equal(sent.length, 2)
  await bridge.replyText(store.bySession(first), 'answer in topic')
  assert.equal(threaded.at(-1).path.message_id, 'existing-root')
  assert.equal(threaded.at(-1).data.reply_in_thread, true)

  await emit(group('om-assistant-top-level', '@_user_1 new task'))
  const second = created[1].sessionId
  assert.notEqual(second, first)
  assert.equal(store.bySession(second).rootMessageId, 'om-assistant-top-level')
  await bridge.replyText(store.bySession(second), 'answer in new topic')
  assert.equal(threaded.at(-1).path.message_id, 'om-assistant-top-level')
  assert.equal(threaded.at(-1).data.reply_in_thread, true)
  assert.equal(store.bySession(second).threadId, 'thread-om-assistant-top-level')
  await emit(group('om-assistant-new-topic-follow-up', '@_user_1 next', { thread_id: store.bySession(second).threadId }))
  assert.equal(sent.at(-1).sessionId, second)
  assert.equal(created.length, 2)
  assert.equal(direct.length, 0)
  assert.equal(bridge.fallbackChatId(), undefined, 'group topics are not a fallback private notification target')
  await emit(group('om-assistant-topic-new', '@_user_1 /new', { thread_id: store.bySession(second).threadId }))
  const switched = store.byThread('thread-om-assistant-top-level')
  assert.notEqual(switched.sessionId, second)
  assert.equal(switched.replyInThread, true)
  assert.equal(threaded.at(-1).path.message_id, 'om-assistant-top-level')
  assert.equal(await bridge.ensureThread(sessions.get(second)), undefined, 'an ended group session must not fall back to a private chat')
})
