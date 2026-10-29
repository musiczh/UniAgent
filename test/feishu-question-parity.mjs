import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Exercise the production bridge at its external boundaries; never contact Feishu.
const directory = await mkdtemp(join(tmpdir(), 'uniagent-feishu-questions-'))
try {
  const output = join(directory, 'bridge.mjs')
  await build({ entryPoints: ['src/main/feishuBridge.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output,
    plugins: [{ name: 'desktop-and-network', setup(builder) {
      for (const [filter, contents] of [
        [/^electron$/, 'export const powerMonitor={on(){},off(){},getSystemIdleState(){return "active"},getSystemIdleTime(){return 0}}; export const systemPreferences={subscribeWorkspaceNotification(){},unsubscribeWorkspaceNotification(){}};'],
        [/^@larksuiteoapi\/node-sdk$/, 'export class WSClient{}; export class Client{}; export class EventDispatcher{}; export const defaultHttpInstance={}; export const normalizeCardAction=value=>value;'],
      ]) {
        const namespace = String(filter)
        builder.onResolve({ filter }, () => ({ path: namespace, namespace }))
        builder.onLoad({ filter: /.*/, namespace }, () => ({ contents }))
      }
    } }],
  })
  const { FeishuBridge } = await import(pathToFileURL(output).href)
  const sent = [], patched = [], responses = [], ordinary = [], errors = []
  const session = { id: 's', status: 'running', config: { agentId: 'codex' } }
  let link = { sessionId: 's', chatId: 'chat', rootMessageId: 'root', threadId: 'thread', driver: 'feishu', lastPushedSeq: 0 }
  let rejectResponse = false
  const bridge = new FeishuBridge({
    orchestrator: {
      getSessionById: () => session,
      respondToRequest: async (sessionId, requestId, answer) => {
        if (rejectResponse) throw new Error('fixture provider rejected answer')
        responses.push({ sessionId, requestId, answer })
        return { handled: true, hasPendingRequests: false }
      },
      forceSend: async (...args) => { ordinary.push(args) },
    },
    threadStore: {
      bySession: () => link, byThread: () => link, byRootMessage: () => link,
      patch: (_id, change) => { link = { ...link, ...change } },
    },
    getSettings: () => ({ enabled: true, notifyOnlyWhenLocked: false }), getAgents: () => [], onStatus() {}, onError: error => errors.push(error),
  })
  bridge.client = { im: { v1: { message: {
    reply: async ({ data }) => { sent.push(JSON.parse(data.content)); return { data: { message_id: 'card-' + sent.length, thread_id: 'thread' } } },
    patch: async ({ path, data }) => { patched.push({ id: path.message_id, card: JSON.parse(data.content) }); return {} },
  } } } }
  bridge.reactReceived = async () => {}
  const drain = async () => { await new Promise(resolve => setImmediate(resolve)); await bridge.pushChains.get('s') }
  const question = (id, seq) => ({ sessionId: 's', seq, ts: seq, type: 'agent_message', state: 'success', payload: {
    id, delivery: 'async', questions: [{ id: 'choice', question: '是否继续？', options: ['继续', '调整'] }], text: '是否继续？',
  } })
  const progress = { sessionId: 's', status: 'running', segments: new Map(), startedAt: Date.now() }
  bridge.progressCards.set('s', progress)
  bridge.handleEvent(question('one', 1))
  bridge.handleEvent(question('two', 2))
  await drain()
  assert.equal(sent.length, 2, 'every async question gets its own answerable Feishu card')
  assert.equal(progress.status, 'running', 'an async question must not mark the running card as waiting')
  assert.ok(sent[0].body.elements[0].elements.some(element => element.content?.includes('Agent 可继续执行')))
  const submit = sent[0].body.elements[0].elements.find(element => element.name === 'submitQuestion').behaviors[0].value
  const click = (value, form = { f0: '继续' }) => bridge.onCardAction({ action: { value, form_value: form } })
  await click(submit)
  await drain()
  assert.equal(responses[0].requestId, 'async-question:one', 'a newer question must not overwrite the older card route')
  assert.deepEqual(responses[0].answer, { answers: { choice: { answers: ['继续'] } } })
  assert.ok(patched.some(entry => entry.id === 'card-1'), 'provider acceptance resolves the original card')

  bridge.handleEvent({ ...question('two', 2), payload: { ...question('two', 2).payload, submittedAnswer: { answers: { choice: { answers: ['调整'] } } } } })
  await drain()
  assert.ok(patched.at(-1).card.header.title.content.includes('UniAgent App 回复'), 'an App answer updates the Feishu card')
  assert.equal(responses.length, 1)

  bridge.handleEvent(question('retry', 3)); await drain()
  const retry = sent.at(-1).body.elements[0].elements.find(element => element.name === 'submitQuestion').behaviors[0].value
  rejectResponse = true; await click(retry); await drain()
  assert.ok(errors.some(error => error.includes('fixture provider rejected')), 'submission errors are reported')
  rejectResponse = false; await click(retry); await drain()
  assert.equal(responses.at(-1).requestId, 'async-question:retry', 'a rejected answer leaves the card retryable')

  bridge.handleEvent(question('late', 4)); bridge.progressCards.delete('s'); await drain()
  assert.ok(sent.at(-1).body.elements[0].elements.some(element => element.name === 'submitQuestion'), 'turn completion cannot suppress an unanswered async card')

  bridge.handleEvent({ sessionId: 's', seq: 5, ts: 5, type: 'approval_request', state: 'pending', payload: { requestId: 'mcp', kind: 'elicitation', method: 'mcpServer/elicitation/request', params: { requestedSchema: { properties: { name: { type: 'string' } } } } } })
  await drain()
  const cancel = sent.at(-1).body.elements.find(element => element.name === 'cancelQuestion')
  assert.ok(cancel, 'MCP forms provide the same cancel action as App')
  await click(cancel.behaviors[0].value, {}); await drain()
  assert.deepEqual(responses.at(-1).answer, { action: 'cancel' })

  bridge.handleSideEvent(question('side-question', 6)); await drain()
  const sideCard = sent.at(-1)
  assert.match(sideCard.header.title.content, /侧边对话/)
  const sideSubmit = sideCard.body.elements[0].elements.find(element => element.name === 'submitQuestion').behaviors[0].value
  await click(sideSubmit); await drain()
  assert.equal(responses.at(-1).requestId, 'side:async-question:side-question', 'side questions have an independent answer route')

  bridge.handleEvent({ sessionId: 's', seq: 7, ts: 7, type: 'approval_request', state: 'pending', payload: { requestId: 'plan-confirmation:plan', kind: 'planMode', method: 'local/plan', params: { plan: '# Current plan\n\nMake the scoped change.' } } }); await drain()
  const planCard = sent.at(-1)
  assert.ok(planCard.body.elements.some(element => element.content?.includes('Make the scoped change.')))
  const planAction = planCard.body.elements.find(element => element.behaviors?.[0].value.act === 'revisePlan').behaviors[0].value
  const feedbackCard = await click(planAction)
  const feedbackSubmit = feedbackCard.card.data.body.elements.find(element => element.tag === 'form').elements.find(element => element.name === 'submitPlanFeedback').behaviors[0].value
  await click(feedbackSubmit, { feedback: 'Keep the existing layout.' }); await drain()
  assert.deepEqual(responses.at(-1).answer, { decision: 'rejected', feedback: 'Keep the existing layout.' })
  await click(submit); await drain()
  assert.equal(responses.at(-1).requestId, 'plan-confirmation:plan', 'a settled card cannot submit again')
  assert.equal(ordinary.length, 0, 'form answers must not become unrelated ordinary chat messages')
  console.log('feishu-question-parity: ok')
} finally { await rm(directory, { recursive: true, force: true }) }
