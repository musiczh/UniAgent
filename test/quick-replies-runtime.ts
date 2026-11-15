import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskTitleRuntimePool } from '../src/main/taskTitleRuntime'
import { configureCodexAppServerArgsProvider } from '../src/main/appServerAdapter'
import { QUICK_REPLY_SCHEMA, parseQuickReplies } from '../src/shared/quickReplies'
import { buildTaskTitlePrompt } from '../src/shared/taskTitle'

const root = await mkdtemp(join(tmpdir(), 'quick-replies-runtime-'))
const auth = join(root, 'auth.json'), catalog = join(root, 'catalog.json')
await writeFile(auth, '{}')
await writeFile(catalog, JSON.stringify({ models: [{ slug: 'small', shell_type: 'shell_command' }] }))
configureCodexAppServerArgsProvider(() => ['-c', 'model_catalog_json=' + JSON.stringify(catalog)])
const agent = { id: 'codex', name: 'Codex', bin: '/fixture', adapter: 'codex', installed: true,
  models: [{ id: 'small', label: 'Small', efforts: ['low'] }], capabilities: { startupSystemPrompt: true, modelSelect: true } } as any
const config = { agentId: 'codex', model: 'small', effort: 'low' as const }
const pool = new TaskTitleRuntimePool(), clients: Rpc[] = []
let hang = false
class Rpc extends EventEmitter {
  calls: Array<{ method: string; params: any }> = []
  closed = 0
  previousTurn?: string
  constructor(readonly launch: any, readonly threadId: string) { super() }
  start = async () => {}
  notify() {}
  respond() {}
  async dispose() { this.closed++ }
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params })
    if (method === 'thread/start') return { thread: { id: this.threadId, model: 'small' } }
    if (method === 'turn/start' && !hang) {
      const turnId = 'turn-' + this.calls.length
      if (this.previousTurn) {
        this.emit('notification', 'item/completed', { threadId: this.threadId, turnId: this.previousTurn, item: { type: 'agentMessage', text: '{"title":"迟到标题"}' } })
        this.emit('notification', 'turn/completed', { threadId: this.threadId, turn: { id: this.previousTurn, status: 'completed' } })
      }
      const text = params.outputSchema?.properties.replies
        ? '{"replies":[{"label":"继续","text":"继续实施已确认的方案。"}]}' : '{"title":"实施方案","description":"按任务整体目标推进实施","needsClarification":false}'
      this.emit('notification', 'item/completed', { threadId: this.threadId, turnId, item: { type: 'agentMessage', text } })
      this.emit('notification', 'turn/completed', { threadId: this.threadId, turn: { id: turnId, status: 'completed' } })
      this.previousTurn = turnId
    }
    return {}
  }
}
const deps = { timeoutMs: 2000, readCodexNative: async () => ({ authPath: auth, config: {} }),
  createRpc: (launch: any) => { const client = new Rpc(launch, 'thread-' + clients.length); clients.push(client); return client as any } }
const taskPrompt = buildTaskTitlePrompt({ primaryIntent: '整个任务的最初目标', currentInput: '本轮继续输入', previousAssistantResponse: '上一轮最终回答',
  taskHistory: { conversationId: 'context-task', turns: [{ inputId: 'first', input: '早期约束' }, { inputId: 'last', input: '本轮继续输入' }] } })
const key = (id: string, replies = false) => (replies ? 'quick-replies:' : 'task-summary:') + id
const generate = (id: string, replies = false, signal = new AbortController().signal) => pool.generate(key(id, replies), agent, config,
  replies ? 'next step fixture' : taskPrompt, signal, { ...deps, ...(replies ? { outputSchema: QUICK_REPLY_SCHEMA } : {}) })
const input = (client: Rpc, index: number) => JSON.parse(client.calls.filter(call => call.method === 'turn/start')[index].params.input[0].text.split('\n').at(-1))
try {
  const title = await generate('task')
  const replies = await generate('task', true)
  assert.equal(JSON.parse(title).title, '实施方案')
  assert.equal(parseQuickReplies(replies)[0].label, '继续')
  assert.equal(clients.length, 2, 'title/description and quick replies have independent native sessions')
  const client = clients[0], replyClient = clients[1]
  assert.notEqual(client.threadId, replyClient.threadId)
  assert.equal(input(client, 0).taskHistory.turns.length, 2, 'cold native session replays the durable task history')
  await generate('task')
  assert.equal(clients.length, 2, 'the next task summary reuses its native session')
  assert.equal(client.calls.filter(call => call.method === 'initialize').length, 1)
  assert.equal(client.calls.filter(call => call.method === 'thread/start').length, 1)
  const next = input(client, 1)
  assert.equal(next.taskHistory.continuing, true)
  assert.equal(next.taskHistory.turns.length, 1, 'warm continuation adds only this turn rather than duplicating full history')
  assert.equal(next.previousAssistantResponse, '上一轮最终回答')
  assert.ok(client.calls.find(call => call.method === 'turn/start')!.params.outputSchema.properties.description)
  assert.deepEqual(replyClient.calls.find(call => call.method === 'turn/start')!.params.outputSchema, QUICK_REPLY_SCHEMA)
  assert.equal(client.listenerCount('notification'), 0, 'completed-turn listeners are removed')
  await access(client.launch.cwd); await access(client.launch.env.CODEX_HOME)
  await generate('other-task')
  assert.equal(clients.length, 3, 'another task gets a separate thread')
  await pool.close(key('task'))
  assert.equal(client.closed, 1)
  await assert.rejects(access(client.launch.cwd))
  await assert.rejects(access(client.launch.env.CODEX_HOME))
  await access(replyClient.launch.cwd)
  await generate('task'); assert.equal(clients.length, 4)
  assert.equal(input(clients[3], 0).taskHistory.turns.length, 2, 'released sessions rebuild from the complete replay window')
  await Promise.all([generate('task'), generate('task')])
  assert.equal(clients.length, 4, 'concurrent turns serialize within the task session')
  const controller = new AbortController(); hang = true
  const pending = generate('task', false, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 30)); controller.abort()
  await assert.rejects(pending, /取消/)
  assert.equal(clients[3].closed, 1, 'cancelled turns close their owned process')
  hang = false; await generate('task')
  assert.equal(clients.length, 5)
} finally { await pool.close(); await rm(root, { recursive: true, force: true }) }
console.log('PASS dedicated task-summary sessions, isolated quick replies, warm deltas, cold history replay, serialization and cancellation')
