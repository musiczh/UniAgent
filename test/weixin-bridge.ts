import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinStore } from '../src/main/assistant/weixinStore'
import { WeixinBridge } from '../src/main/assistant/weixinBridge'
import type { WeixinApi } from '../src/main/assistant/weixinApi'
import type { Session } from '../src/shared/types'
import { acceptsFeishuAssistant, splitWeixinContext } from '../src/shared/weixin'
import { asyncQuestionReply } from '../src/shared/interactionRequests'

const root = await mkdtemp(join(tmpdir(), 'uniagent-weixin-'))
const original = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const wait = async (condition: () => boolean) => { for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('condition timed out') }
let bridge: WeixinBridge | undefined
try {
  const file = join(root, 'weixin.json')
  const store = new WeixinStore(file)
  const account = { token: 'private-test-token', botId: 'bot', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' }
  await store.update({ account, contextToken: 'private-context' })
  const raw = await readFile(file,'utf8')
  assert.ok(!raw.includes(account.token) && !raw.includes('private-context'))
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const restored = new WeixinStore(file); await restored.load()
  assert.deepEqual(restored.get().account, account)
  const sessions = new Map<string, Session>()
  const sent: string[] = []
  const forwarded: any[] = []
  const answered: any[] = []
  const executed: string[] = []
  const snapshot = { assistantId: 'personal' as const, soul: '', soulRevision: 1, workingRules: '', workingRulesRevision: 1 }
  let activeTurn: { ts: number } | undefined
  let created = 0
  let polled = false
  const api = {
    async updates(_account: unknown, _cursor: string, signal: AbortSignal) {
      if (!polled) { polled = true; return { msgs: [], get_updates_buf: 'cursor-1' } }
      return new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
    },
    async send(_account: unknown, _context: string, item: any) { sent.push(item.text_item?.text || 'attachment') },
    async download() { return Buffer.from('89504e470d0a1a0a00000000','hex') },
    async upload() { return { type: 4 } }
  } as unknown as WeixinApi
  const orchestrator = {
    getSessionById: (id: string) => sessions.get(id), getEvents: async () => [],
    forceSend: async (...args: any[]) => { forwarded.push(args) }, interrupt: (id: string) => { executed.push('stop:' + id) },
    respondToRequest: async (...args: any[]) => { answered.push(args); return { handled: true } }, setArchived() {}, currentTurnAgentMessageText: () => '本轮结果', getWeixinSendTurn: () => activeTurn
  }
  const create = () => {
    const session = { id: `weixin-${++created}`, title: '个人助手 · 微信', status: 'running', createdAt: 1, origin: 'created', config: { agentId: 'codex', workdir: root, assistantSnapshot: snapshot, assistantChannel: 'weixin' } } as Session
    sessions.set(session.id, session); return session
  }
  bridge = new WeixinBridge({ store: restored, api, orchestrator: orchestrator as any, attachmentsDirectory: root, onState() {}, onError(message) { throw new Error(message) },
    async createSession(prompt, attachments, bind, assertCurrent) { assertCurrent(); const session = create(); await bind(session); forwarded.push([session.id,prompt,attachments]); return session },
    async command(id, command) { executed.push(command + ':' + id); return create() }
  })
  await bridge.restore(); await wait(() => bridge!.getState().phase === 'connected')
  const message = (id: string, text: string, from = 'owner') => ({ message_id: id, message_type: 1, from_user_id: from, to_user_id: 'bot', context_token: 'context', item_list: [{ type: 1, text_item: { text } }] })
  await bridge.receive(message('foreign','外部用户','other'))
  assert.equal(created,0)
  await bridge.receive(message('1','分析项目'))
  assert.equal(created,1)
  assert.equal(splitWeixinContext(forwarded[0][1])?.text, '分析项目')
  assert.equal(acceptsFeishuAssistant(sessions.get('weixin-1')!.config), false)
  assert.equal(acceptsFeishuAssistant({}), true)
  await bridge.receive(message('1','分析项目'))
  assert.equal(forwarded.length,1,'duplicate message cannot repeat an Agent turn')
  await bridge.receive(message('2','/new'))
  assert.deepEqual(executed,['new:weixin-1'])
  assert.equal(restored.get().sessionId,'weixin-2')
  assert.equal(forwarded.length,1,'host control commands must not enter the model')
  await bridge.receive(message('3','/stop'))
  assert.deepEqual(executed,['new:weixin-1','stop:weixin-2'])
  const beforeQuestion = sent.length
  const question = { sessionId: 'weixin-2', seq: 4, ts: 1, type: 'approval_request' as const, state: 'pending' as const, payload: {
    requestId: 'question', kind: 'question', method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'target', question: '使用哪个目录？', options: [{ label: '当前项目' }, { label: '新建目录' }] },
      { id: 'name', question: '项目名称？' }
    ] }
  } }
  bridge.handleEvent(question)
  bridge.handleEvent(question)
  bridge.handleEvent({ sessionId: 'weixin-2', seq: 5, ts: 1, type: 'turn_started', payload: {} })
  await wait(() => sent.length === beforeQuestion + 3)
  const questionCode = sent[beforeQuestion].match(/[A-F0-9]{6}/)![0]
  assert.match(sent[beforeQuestion], /使用哪个目录/)
  assert.equal(sent[beforeQuestion + 1], `回答问题 ${questionCode} 1`, 'copyable command must be sent as its own Weixin message')
  assert.match(sent[beforeQuestion + 2], /正在处理/, 'queued Agent notifications cannot split a question from its copyable command')
  await bridge.receive(message('question-answer-1', `回答问题 ${questionCode} 2`))
  assert.equal(answered.length, 0, 'the provider receives the answer only after every question is collected')
  const nextCode = sent.at(-1)!.match(/[A-F0-9]{6}/)![0]
  assert.notEqual(nextCode, questionCode)
  assert.equal(sent.at(-1), `回答问题 ${nextCode}`, 'a text question has no numeric or literal-content placeholder')
  assert.match(sent.at(-3)!, /已记录.*新建目录/)
  await bridge.receive(message('question-stale', `回答问题 ${questionCode} 1`))
  assert.equal(answered.length, 0, 'a stale copied reply cannot answer the next question')
  await bridge.receive(message('question-answer-2', `回答问题 ${nextCode} 微信助手`))
  assert.deepEqual(answered, [['weixin-2', 'question', { answers: { target: { answers: ['新建目录'] }, name: { answers: ['微信助手'] } } }, { source: 'weixin' }]])
  assert.match(sent.at(-1)!, /已提交.*微信助手/)
  assert.equal(forwarded.length, 1, 'answer commands are submitted through the original request rather than forwarded as ordinary tasks')
  const asyncQuestion = { sessionId: 'weixin-2', seq: 6, ts: 1, type: 'agent_message' as const, state: 'success' as const, payload: {
    id: 'async-1', delivery: 'async', questions: [{ id: 'interaction', question: '测试哪种交互？', options: [{ label: '预设选项' }, { label: '自定义回答' }] }]
  } }
  const beforeAsync = sent.length
  bridge.handleEvent(asyncQuestion)
  await wait(() => sent.length === beforeAsync + 2)
  const asyncCode = sent.at(-1)!.match(/[A-F0-9]{6}/)![0]
  await bridge.receive(message('async-answer', `回答问题 ${asyncCode} 2 用中文测试`))
  assert.equal(answered[1][0], 'weixin-2')
  assert.equal(answered[1][1], 'async-question:async-1')
  assert.deepEqual(answered[1][3], { source: 'weixin' })
  assert.equal(asyncQuestionReply(asyncQuestion, answered[1][2]), '回答 Agent 提问：\n\n测试哪种交互？\n回答：自定义回答\n补充：用中文测试', 'an async reply carries the selected label and note into the same-session follow-up')
  bridge.handleEvent({ sessionId: 'feishu-session', seq: 8, ts: 1, type: 'turn_completed', state: 'success', payload: {} })
  assert.ok(!sent.includes('本轮结果'))
  bridge.handleEvent({ sessionId: 'weixin-2', seq: 9, ts: 1, type: 'turn_completed', state: 'success', payload: {} })
  bridge.handleEvent({ sessionId: 'weixin-2', seq: 9, ts: 1, type: 'turn_completed', state: 'success', payload: {} })
  await wait(() => sent.includes('本轮结果'))
  await wait(() => restored.get().pushedSeq === 9)
  assert.equal(sent.filter(text => text === '本轮结果').length,1,'replayed completion is only pushed once')
  await restored.update({ sessionId: 'weixin-2',pushedSeq: 9 })
  const moved = restored.update({ sessionId: 'weixin-next',pushedSeq: -1 })
  const oldWatermark = restored.update(current => current.sessionId === 'weixin-2' ? { pushedSeq: 99 } : undefined)
  await Promise.all([moved,oldWatermark])
  assert.equal(restored.get().pushedSeq,-1,'late completion cannot write the new session watermark')
  await restored.update({ sessionId: 'weixin-2',pushedSeq: 9 })
  await assert.rejects(bridge.sendToSession('weixin-2','forged',[],Date.now()), /当前微信轮次/)
  activeTurn = { ts: Date.now() - 1 }
  await writeFile(join(root,'result.txt'),'hello')
  assert.deepEqual(await bridge.sendToSession('weixin-2',undefined,['result.txt'],Date.now()),['result.txt'])
  await assert.rejects(bridge.sendToSession('weixin-2',undefined,['../outside.txt'],Date.now()))
  await bridge.receive({ ...message('image',''),item_list: [{type:2,image_item:{}}] })
  assert.equal(forwarded.at(-1)[2][0].mime,'image/png','image MIME follows its bytes rather than a guessed JPEG filename')
  assert.match(forwarded.at(-1)[2][0].name,/\.png$/)
  await bridge.disconnect()
  const disconnected = new WeixinStore(file); await disconnected.load()
  assert.equal(disconnected.get().account,undefined)
  assert.equal(disconnected.get().sessionId,undefined)
  console.log('weixin-bridge: encrypted persistence, owner identity, dedup, commands, channel routing and attachment permissions passed')
} finally {
  await bridge?.close()
  if (original === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = original
  await rm(root,{ recursive: true, force: true })
}
