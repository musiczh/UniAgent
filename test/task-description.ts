import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskMetadataStore } from '../src/main/taskMetadataStore'
import { TaskTitleService } from '../src/main/taskTitleService'
import { TaskTitleIntegration } from '../src/main/taskTitleIntegration'
import { TaskTitleContextStore, taskTitleReplay } from '../src/main/taskTitleContext'
import { TaskTitleTokenCounter } from '../src/main/taskTitleTokens'
import { parseTaskTitleResult, taskDisplayDescription } from '../src/shared/taskTitle'
import { projectTaskBoard } from '../src/shared/taskBoard'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'task-description-'))
const counter = new TaskTitleTokenCounter()
const agent = { id: 'codex', name: 'Codex', adapter: 'codex', installed: true, models: [{ id: 'small', label: 'Small', efforts: ['low'] }], capabilities: { modelSelect: true, startupSystemPrompt: true } } as AgentDef
const sessions = new Map<string, Session>()
const session = (id: string): Session => {
  const value: Session = { id, title: '原始任务', status: 'idle', createdAt: 1, config: { agentId: 'codex' } }
  sessions.set(id, value)
  return value
}
const requests: Array<{ prompt: string; id?: string; signal: AbortSignal }> = []
let result = { title: '统一未读状态', description: '统一回答后的未读状态，保留其他真实未读。', needsClarification: false }
let gate: { resolve(value: string): void; promise: Promise<string> } | undefined
let store = new TaskMetadataStore(join(root, 'metadata'))
const dependencies = {
  session: (id: string) => sessions.get(id), agents: () => [agent], config: () => ({ enabled: true, agentId: 'codex', model: 'small' }),
  validateDescription: (text: string) => counter.validate(text),
  generate: async (_agent: AgentDef, _config: unknown, prompt: string, signal: AbortSignal, _images?: unknown, id?: string) => {
    requests.push({ prompt, id, signal })
    return gate ? gate.promise : JSON.stringify(result)
  }
}
let service = new TaskTitleService(store, dependencies, { debounceMs: 0, retryBackoffMs: 1 })
const until = async (predicate: () => boolean) => {
  for (let n = 0; n < 1000; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('description fixture did not settle: ' + JSON.stringify([...sessions.values()].map(value => store.current(value))))
}
const input = async (value: Session, text: string, id: string, previous?: string) => {
  const before = requests.length
  service.accepted(value.id, text, { inputId: id, previousAssistantResponse: previous })
  await store.flush()
  assert.equal(requests.length, before, 'accepted input alone cannot generate a description')
  service.responded(value.id, '先核对本轮范围。', id)
  await until(() => value.taskMetadata?.generatedInputId === id)
  return requests.at(-1)!
}

try {
  const value = session('task')
  store.initialize(value, false)
  await input(value, '修复回答后的未读残留，保留其他真实未读。', 'turn-1')
  assert.equal(value.taskMetadata?.description, result.description, 'title and description commit together')
  const conversationId = value.taskMetadata!.conversationId
  assert.ok(conversationId)
  const firstRequest = requests[0]
  assert.equal(firstRequest.id, conversationId, 'runtime is bound to the persisted task generation conversation')
  const beforeDuplicate = requests.length
  service.responded(value.id, '同一首段的流式增量。', 'turn-1')
  service.accepted(value.id, '修复回答后的未读残留，保留其他真实未读。', { inputId: 'turn-1' })
  await store.flush()
  assert.equal(requests.length, beforeDuplicate, 'same accepted input and stream duplicates do not regenerate')

  result = { ...result, title: '统一跨渠道未读状态', description: '统一飞书与本机回答后的未读，保留其他真实未读。' }
  service.completed(value.id, '前轮最终输出：还需核对图标和侧栏。', 'turn-1')
  await store.flush()
  const second = await input(value, '本机回答也一样。', 'turn-2', '前轮最终输出：还需核对图标和侧栏。')
  assert.equal(second.id, conversationId)
  assert.match(second.prompt, /前轮最终输出：还需核对图标和侧栏。/)
  assert.match(second.prompt, /修复回答后的未读残留/)
  assert.match(second.prompt, /本机回答也一样/)
  assert.equal(value.taskMetadata?.title, result.title, 'ready titles update on the next accepted turn')

  await service.close()
  store = new TaskMetadataStore(join(root, 'metadata'))
  await store.hydrate([value])
  service = new TaskTitleService(store, dependencies, { debounceMs: 0, retryBackoffMs: 1 })
  result = { ...result, title: '统一未读状态并验证恢复', description: '统一跨渠道回答后的未读，并验证重启恢复。' }
  const third = await input(value, '按这个做，再覆盖重启恢复。', 'turn-3')
  assert.equal(value.taskMetadata?.conversationId, conversationId, 'restart preserves the generation conversation identity')
  assert.match(third.prompt, /修复回答后的未读残留/)
  assert.match(third.prompt, /保留其他真实未读/)
  assert.match(third.prompt, /本机回答也一样/)
  const context = await store.contexts.current(value.id)
  assert.equal(context.turns.length, 3, 'all task turns survive restart')
  assert.equal(context.turns[0].finalResponse, '前轮最终输出：还需核对图标和侧栏。')
  assert.equal(value.taskMetadata?.seed, undefined, 'private history never reaches renderer metadata')

  await service.rename(value.id, '我的任务名称')
  result = { ...result, title: '模型的新标题', description: '补齐跨渠道未读和恢复验证。' }
  await input(value, '增加恢复后的逐问题核对。', 'turn-4')
  assert.equal(value.taskMetadata?.title, '我的任务名称', 'manual titles remain authoritative')
  assert.equal(value.taskMetadata?.description, result.description, 'manual title does not freeze the description')
  value.status = 'awaiting-approval'
  const board = projectTaskBoard([value], () => [])
  assert.equal(board.focus[0].description, taskDisplayDescription(value))
  assert.equal(board.focus[0].description, result.description)

  const other = session('other')
  store.initialize(other, false)
  const otherRequest = await input(other, '整理 Android 构建说明。', 'other-1')
  assert.notEqual(otherRequest.id, conversationId)
  assert.doesNotMatch(otherRequest.prompt, /跨渠道|重启恢复/)

  let resolve!: (value: string) => void
  gate = { promise: new Promise<string>(ok => { resolve = ok }), resolve: value => resolve(value) }
  const old = requests.length
  service.accepted(value.id, '旧轮次', { inputId: 'late-old' }); service.responded(value.id, '旧回复', 'late-old')
  await until(() => requests.length > old)
  const oldSignal = requests.at(-1)!.signal
  service.accepted(value.id, '新轮次', { inputId: 'late-new' })
  await store.flush()
  assert.equal(oldSignal.aborted, true)
  gate.resolve(JSON.stringify({ ...result, description: '不能覆盖的新旧竞争结果' }))
  gate = undefined
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(value.taskMetadata?.description, result.description, 'late superseded output cannot replace the last valid description')
  service.responded(value.id, '新轮次首段', 'late-new')
  await until(() => value.taskMetadata?.generatedInputId === 'late-new')

  const exactly200 = ' a'.repeat(200), over200 = ' a'.repeat(201)
  assert.equal(await counter.count(exactly200), 200)
  assert.equal(await counter.count(over200), 201)
  await counter.validate(exactly200)
  await assert.rejects(counter.validate(over200), /200 token/)
  await counter.validate('中文、English、emoji 😀，保留用户目标。')
  assert.throws(() => parseTaskTitleResult('{"title":"任务","needsClarification":false}'), /描述/)
  assert.throws(() => parseTaskTitleResult('{"title":"任务","description":"","needsClarification":false}'), /描述/)
  assert.throws(() => parseTaskTitleResult('{"title":"任务","description":"password=secret-fixture","needsClarification":false}'), /凭据/)

  const saved = result.description
  result = { ...result, description: over200 }
  service.accepted(value.id, '超长描述回归', { inputId: 'over-limit' }); service.responded(value.id, '首段', 'over-limit')
  await until(() => value.taskMetadata?.generationState === 'failed')
  assert.equal(value.taskMetadata?.description, saved, 'over-limit description never replaces the valid pair')

  const history = { formatVersion: 1 as const, taskId: 'long', id: 'long-conversation', turns: Array.from({ length: 20 }, (_, index) => ({ inputId: String(index), input: '长期约束与具体材料。'.repeat(150) + index })) }
  const original = structuredClone(history)
  const compacted: string[] = []
  const replay = await taskTitleReplay(history, async prompt => { compacted.push(prompt); return JSON.stringify({ summary: '保留最初目标及全部仍生效的用户约束。' }) })
  assert.ok(compacted.length > 0)
  assert.match(compacted[0], /长期约束与具体材料/)
  assert.equal(replay.history.turns.at(-1)?.inputId, '19')
  assert.ok(Buffer.byteLength(JSON.stringify(replay.history)) <= 24 * 1024)
  assert.deepEqual(history, original, 'compaction never deletes the persistent raw ledger')
  await assert.rejects(taskTitleReplay(history, async () => 'bad-json'), /压缩/)
  await assert.rejects(taskTitleReplay(history, async () => 'null'), /压缩/)

  const contextStore = new TaskTitleContextStore(join(root, 'context-errors'))
  const durable = await contextStore.update('persist', context => { context.turns.push({ inputId: 'first', input: '原始目标' }) })
  const reloaded = await new TaskTitleContextStore(join(root, 'context-errors')).current('persist')
  assert.equal(reloaded.id, durable.id)
  assert.deepEqual(reloaded.turns, durable.turns)

  const historyEvents: UAEvent[] = [
    { sessionId: 'restored', seq: 1, ts: 1, type: 'user_message', payload: { text: '早期完整任务目标' } },
    { sessionId: 'restored', seq: 2, ts: 2, type: 'agent_message', payload: { text: '首段', id: 'initial' }, state: 'success' },
    { sessionId: 'restored', seq: 3, ts: 3, type: 'agent_message', payload: { text: '前轮最终结论', id: 'final', phase: 'final_answer' }, state: 'success' },
    { sessionId: 'restored', seq: 4, ts: 4, type: 'user_message', payload: { text: '按这个做' } }
  ]
  const restored = session('restored')
  let accepted: any
  const integration = new TaskTitleIntegration({ accepted: (...args) => { accepted = args }, responded: () => {}, cancel: () => {} }, () => restored, () => historyEvents)
  integration.observe(historyEvents.at(-1)!); integration.accepted('restored')
  assert.equal(accepted[2].previousAssistantResponse, '前轮最终结论')
  assert.equal(accepted[2].history[0].input, '早期完整任务目标', 'upgrading an existing task bootstraps early history from its actual events')

  // Actual history loading must not inherit the UI's 200-event preview limit.
  const legacy = session('legacy')
  store.initialize(legacy, true)
  const oldEvents: UAEvent[] = [
    { sessionId: legacy.id, seq: 1, ts: 1, type: 'user_message', payload: { text: '跨过 UI 预览窗口的原始目标' } },
    ...Array.from({ length: 600 }, (_, index) => ({ sessionId: legacy.id, seq: index + 2, ts: index + 2, type: 'tool_call' as const, payload: { name: 'fixture' } })),
    { sessionId: legacy.id, seq: 602, ts: 602, type: 'agent_message', payload: { text: '历史最终回答', phase: 'final_answer' } },
    { sessionId: legacy.id, seq: 604, ts: 604, type: 'user_message', payload: { text: '尚未接受的排队输入' } }
  ]
  result = { title: '模型标题', description: '恢复完整历史后继续原始目标。', needsClarification: false }
  let historyLoads = 0
  const bootstrap = new TaskTitleService(store, { ...dependencies, history: async () => { historyLoads++; return oldEvents } }, { debounceMs: 0 })
  try {
    bootstrap.accepted(legacy.id, '继续原任务', { inputId: 'legacy:603:603', inputSequence: 603 })
    bootstrap.responded(legacy.id, '本轮首段', 'legacy:603:603')
    await until(() => legacy.taskMetadata?.generatedInputId === 'legacy:603:603')
    assert.match(requests.at(-1)!.prompt, /跨过 UI 预览窗口的原始目标/)
    assert.match(requests.at(-1)!.prompt, /历史最终回答/)
    assert.doesNotMatch(requests.at(-1)!.prompt, /尚未接受的排队输入/)
    assert.equal(legacy.taskMetadata?.title, '原始任务', 'legacy title stays preserved while a description is added')
    assert.equal(historyLoads, 1, 'complete logs are read only to bootstrap the dedicated ledger')
  } finally { await bootstrap.close() }

  value.archived = true
  const beforeArchive = requests.length
  await service.recover([value])
  assert.equal(requests.length, beforeArchive, 'archived tasks do not generate in the background')
  value.archived = false
  await input(value, '恢复后继续逐问题核对。', 'after-archive')
  assert.equal(value.taskMetadata?.conversationId, conversationId)

  const renamed = session('rename-before-persist')
  store.initialize(renamed, false)
  const beforeRename = requests.length
  service.accepted(renamed.id, '保存输入时重命名', { inputId: 'rename-race' })
  service.responded(renamed.id, '首段', 'rename-race')
  await service.rename(renamed.id, '立即手动命名')
  await store.flush()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(renamed.taskMetadata?.title, '立即手动命名')
  assert.equal(requests.length, beforeRename, 'manual rename cancels the pending round even before history persistence finishes')

  const corruptPath = join(root, 'context-errors', createHash('sha256').update('persist').digest('hex') + '.context.json')
  await writeFile(corruptPath, '{bad-json')
  await assert.rejects(new TaskTitleContextStore(join(root, 'context-errors')).current('persist'), /JSON/)
  await store.remove(other.id)
  const removed = await new TaskTitleContextStore(join(root, 'metadata')).current(other.id)
  assert.equal(removed.turns.length, 0, 'task deletion removes only that task generation ledger')
  assert.equal((await store.contexts.current(value.id)).id, conversationId, 'deleting another task cannot erase this task history')

  const beforeUnanswered = requests.length
  service.accepted(value.id, '恢复后继续逐问题核对。', { inputId: 'accepted-without-reply' })
  await store.flush()
  assert.equal(store.current(value).seed?.assistantResponse, undefined, 'even identical text in a new turn must await its own reply')
  await service.close()
  store = new TaskMetadataStore(join(root, 'metadata'))
  await store.hydrate([value])
  service = new TaskTitleService(store, dependencies, { debounceMs: 0 })
  await service.recover([value])
  assert.equal(requests.length, beforeUnanswered, 'restart cannot mistake the previous turn response for the current first reply')
} finally {
  gate?.resolve(JSON.stringify(result))
  await service.close()
  await counter.close()
  await rm(root, { recursive: true, force: true })
}
console.log('PASS task descriptions: per-turn updates, durable history, whole-task replay, manual names, isolation, races, real tokenizer and compaction')
