import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '../src/shared/types'
import { TASK_GENERATION_IPC } from '../src/shared/taskGeneration'
import { TaskGenerationConversations, registerTaskGenerationIpc } from '../src/main/taskGenerationConversation'
import { DeepSeekEventStore } from '../src/main/deepseekEventStore'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const session = (id: string): Session => ({ id, title: id, status: 'idle', createdAt: 1, config: { agentId: 'codex', workdir: '/fixture' } })
const input = (task: Session, kind: 'title-description' | 'quick-replies' | 'context-summary' = 'title-description') => ({
  task, kind, agentName: 'Codex', model: 'model-a', contextId: kind === 'quick-replies' ? task.id : 'context-a',
  prompt: '真实请求\n第二行 api_key="fixture-secret" Bearer fixture-bearer', signal: new AbortController().signal
})
const directory = await mkdtemp(join(tmpdir(), 'task-generation-'))
const changed: string[] = []
let records = new TaskGenerationConversations(directory, id => changed.push(id))
try {
  const a = session('task-a'), b = session('task-b')
  assert.deepEqual(await records.read(a), { taskId: a.id, running: false, legacyHistory: false, events: [] })
  assert.deepEqual(await readdir(directory), [], 'reading an empty task must not create a fabricated transcript')
  const first = deferred<string>(), second = deferred<string>()
  let actualCalls = 0
  const title = records.run({ ...input(a), images: [{ kind: 'image', name: 'input.png', path: '/fixture/input.png', dataUrl: 'data:image/png;base64,private' }] }, () => { actualCalls++; return first.promise })
  const replies = records.run({ ...input(a, 'quick-replies'), model: 'model-b' }, () => { actualCalls++; return second.promise })
  const live = await records.read(a)
  assert.equal(actualCalls, 2, 'recording and viewing must not invoke an extra model call')
  assert.equal(live.running, true)
  assert.equal(live.events.filter(event => event.type === 'user_message').length, 2)
  assert.ok(live.events.every(event => event.sessionId === a.id))
  const prompt = live.events.find(event => event.type === 'user_message')!.payload
  assert.match(prompt.text, /真实请求\n第二行/)
  assert.doesNotMatch(JSON.stringify(prompt), /fixture-secret|fixture-bearer|data:image|private/)
  assert.equal(prompt.attachments[0].path, '/fixture/input.png')
  second.resolve('{"suggestions":["执行回归"]}')
  assert.equal(await replies, '{"suggestions":["执行回归"]}')
  first.resolve('{"title":"真实标题","description":"真实描述"}')
  assert.equal(await title, '{"title":"真实标题","description":"真实描述"}')
  const completed = await records.read(a)
  assert.equal(completed.running, false)
  const calls = completed.events.filter(event => event.payload.turnId)
  assert.deepEqual(calls.map(event => event.type), ['user_message', 'turn_started', 'system_notice', 'agent_message', 'turn_completed', 'user_message', 'turn_started', 'system_notice', 'agent_message', 'turn_completed'], 'concurrent calls remain contiguous in the shared transcript')
  assert.match(calls[3].payload.text, /真实标题/)
  assert.match(calls[8].payload.text, /执行回归/)
  assert.equal(calls[0].payload.generationContextId, 'context-a')
  assert.equal(calls[5].payload.generationContextId, a.id)
  assert.equal(calls[5].payload.generationModel, 'model-b')
  assert.match(calls[2].payload.text, /标题与描述/)
  assert.match(calls[7].payload.text, /快捷回复/)
  assert.deepEqual((await records.read(b)).events, [], 'tasks cannot see each other’s records')
  const failure = new Error('provider unavailable password=hidden')
  await assert.rejects(records.run(input(b), async () => { throw failure }), error => error === failure)
  const failed = await records.read(b)
  assert.match(failed.events.find(event => event.type === 'error')!.payload.message, /provider unavailable/)
  assert.doesNotMatch(JSON.stringify(failed), /password=hidden/)
  assert.equal(failed.events.at(-1)!.state, 'failed')
  await records.run(input(b), async () => { throw undefined }).then(() => assert.fail('must reject'), error => assert.equal(error, undefined))
  assert.equal((await records.read(b)).events.at(-1)!.state, 'failed', 'a provider rejection without an Error object is still a failed call')
  const controller = new AbortController(), late = deferred<string>()
  const cancelled = records.run({ ...input(b), signal: controller.signal }, () => late.promise)
  await records.read(b); controller.abort(); late.resolve('迟到结果')
  assert.equal(await cancelled, '迟到结果', 'the recorder must preserve the caller’s cancellation/result contract')
  const afterCancel = await records.read(b)
  assert.equal(afterCancel.events.at(-1)!.state, 'cancelled')
  assert.match(afterCancel.events.at(-2)!.payload.text, /未作为有效生成结果应用/)
  await records.run(input(a, 'context-summary'), async () => 'not valid JSON')
  assert.equal((await records.read(a)).events.at(-2)!.payload.text, 'not valid JSON', 'unparseable raw responses are still inspectable')
  const old = { ...session('legacy'), taskMetadata: { generatedAt: 100 } } as Session
  assert.equal((await records.read(old)).legacyHistory, true)
  await records.run(input(old), async () => '新调用')
  const saved = await records.read(a)
  await records.close()
  records = new TaskGenerationConversations(directory, () => { throw new Error('renderer closed') })
  assert.deepEqual(await records.read(a), saved, 'worker-backed records survive restart')
  assert.equal((await records.read(session(old.id))).legacyHistory, true, 'saved coverage survives metadata changes')
  await records.run(input(b), async () => 'observer failure cannot break generation')
  const removed = session('remove-during-generation'), pending = deferred<string>()
  const active = records.run(input(removed), () => pending.promise)
  await records.read(removed)
  await records.remove(removed.id)
  pending.resolve('must not recreate history'); await active
  assert.deepEqual((await records.read(removed)).events, [])
  assert.ok(changed.length > 0 && changed.every(id => [a.id, b.id, old.id].includes(id)))

  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  let hydrated = false, reads = 0
  const managed = { ...session('managed'), config: { ...a.config, managedPurpose: 'router' } } as Session
  registerTaskGenerationIpc({ handle: (name: string, handler: any) => { handlers.set(name, handler) } }, { read: async task => { reads++; assert.ok(hydrated); return records.read(task) } }, {
    trusted: event => { if (!(event as any).trusted) throw Error('untrusted') }, hydrate: async () => { hydrated = true }, session: id => id === a.id ? a : id === managed.id ? managed : undefined
  })
  const read = handlers.get(TASK_GENERATION_IPC.read)!
  await assert.rejects(read({}, a.id), /untrusted/)
  for (const id of [null, '', 'x'.repeat(201)]) await assert.rejects(read({ trusted: true }, id), /无效/)
  await assert.rejects(read({ trusted: true }, '../../other-task'), /不存在/)
  await assert.rejects(read({ trusted: true }, managed.id), /没有生成会话/)
  assert.equal(reads, 0)
  assert.equal((await read({ trusted: true }, a.id) as any).taskId, a.id)
  assert.equal(reads, 1)

  const interruptedTask = session('interrupted'), key = 'generation-' + createHash('sha256').update(interruptedTask.id).digest('hex')
  const interruptedStore = new DeepSeekEventStore(join(directory, 'interrupted'))
  for (const [seq, type] of ['user_message', 'turn_started'].entries()) interruptedStore.append(key, {
    sessionId: key, seq, ts: 100, type: type as any, state: 'running', payload: { turnId: 'unfinished', text: '真实输入' }
  })
  await interruptedStore.close()
  const recovered = new TaskGenerationConversations(join(directory, 'interrupted'))
  try {
    const restored = await recovered.read(interruptedTask)
    assert.equal(restored.running, false)
    assert.equal(restored.events.at(-1)!.type, 'turn_completed')
    assert.equal(restored.events.at(-1)!.state, 'cancelled')
    assert.match(restored.events.at(-2)!.payload.message, /已中断/)
    assert.equal(restored.events.some(event => event.type === 'agent_message'), false)
  } finally { await recovered.close() }

  const brokenPath = join(directory, 'not-a-directory')
  await writeFile(brokenPath, 'fixture')
  const broken = new TaskGenerationConversations(brokenPath)
  try {
    assert.equal(await broken.run(input(a), async () => 'normal result'), 'normal result', 'unavailable storage cannot change generation')
    await assert.rejects(broken.read(a))
  } finally { await broken.close().catch(() => {}) }
} finally { await records.close(); await rm(directory, { recursive: true, force: true }) }
console.log('task-generation-conversation: real ledger persistence, redaction, task binding, concurrency, failures, cancellation, deletion, restart and read-only IPC passed')
