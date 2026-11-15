import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommentStore } from '../src/main/commentStore'
import { CommentService, type CommentDependencies } from '../src/main/commentService'
import { commentAnchor, commentPrompt, findCommentSource, resolveCommentAnchor, COMMENT_INSTRUCTIONS, COMMENT_PROMPT_MAX_CHARS, COMMENT_QUESTION_MAX_CHARS } from '../src/shared/comments'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'
import type { CommentRuntimeCallbacks } from '../src/main/commentRuntime'
import { appendEventSnapshot } from '../src/shared/eventSnapshots'
import { mergeSessionEvent } from '../src/renderer/App'

const root = await mkdtemp(join(tmpdir(), 'ua-comments-'))
const agent = { id: 'codex', name: 'Codex', adapter: 'codex', capabilities: { modelSelect: true, permissionModes: [{ id: 'full-access' }, { id: 'read-only' }] }, models: [{ id: 'model-a', label: 'A', efforts: [] }, { id: 'model-b', label: 'B', efforts: [] }], defaultModel: 'model-a' } as unknown as AgentDef
const parent = { id: 'parent', title: 'Main', createdAt: 1, status: 'idle', config: { agentId: 'codex', model: 'model-a', workdir: '/repo', permissionMode: 'full-access' } } as Session
const event = (seq: number, text: string, type: UAEvent['type'] = 'agent_message'): UAEvent => ({ sessionId: parent.id, seq, ts: seq, type, payload: { text, id: String(seq) } })
let parentEvents = [event(1, '方案 A'), event(2, '上下文快照固定')]
let fileText = '**Markdown** 文档'
const callbacks: CommentRuntimeCallbacks[] = []
const prompts: string[] = []
const configs: unknown[] = []
let stopped = 0
let disposed = 0
const deps: CommentDependencies = {
  store: new CommentStore(root), session: id => id === parent.id || id === 'other' ? { ...parent, id } : undefined,
  events: async () => parentEvents, agent: id => id === agent.id ? agent : id === 'other-agent' ? { ...agent, id } : undefined,
  readFile: async () => fileText, ready: async () => {},
  runtime(config, callback) { callbacks.push(callback); configs.push(config); return {
    async send(prompt) { prompts.push(prompt); callback.status('running') }, stop() { stopped++ },
    async respond() {}, dispose() { disposed++ }
  } }
}
let service = new CommentService(deps)
try {
  const longSource = '开头'.repeat(300_000) + '这段需要解释' + '结尾'.repeat(300_000)
  const longAnchor = commentAnchor({ seq: 2, start: 600_000, end: 600_006, quote: '这段需要解释', selectedMessageText: longSource })
  const longParent = [event(1, '最初需求：固定讨论背景', 'user_message'), event(2, longSource),
    { ...event(3, '', 'tool_call'), state: 'success' as const, payload: { name: 'read_file', output: '\u0000\\\"'.repeat(400_000), raw: { image: 'x'.repeat(1_200_000) } } },
    event(4, '最近进展：仍讨论方案 A')]
  const boundedPrompt = commentPrompt(longSource, longAnchor, '当前问题：为什么？', [event(1, '评论内的旧问题', 'user_message'), event(2, '评论内的旧回答')], longParent)
  assert.ok(boundedPrompt.length <= COMMENT_PROMPT_MAX_CHARS, 'large frozen snapshots and tool payloads must fit the comment input budget')
  assert.match(boundedPrompt, /这段需要解释/)
  assert.match(boundedPrompt, /最初需求：固定讨论背景/)
  assert.match(boundedPrompt, /最近进展：仍讨论方案 A/)
  assert.match(boundedPrompt, /评论内的旧问题|评论内的旧回答/)
  assert.ok(boundedPrompt.endsWith('当前问题：为什么？'), 'the current question must remain complete')
  assert.match(boundedPrompt, /omitted/i, 'bounded excerpts must disclose omitted context to the model')
  assert.equal(longParent[1].payload.text, longSource, 'prompt budgets must not rewrite the frozen snapshot')
  JSON.parse(boundedPrompt.split('Quoted context (JSON):\n')[1].split('\n\nCurrent comment question:')[0])
  assert.throws(() => commentPrompt('', longAnchor, 'x'.repeat(COMMENT_QUESTION_MAX_CHARS + 1)), /问题过长/)
  const escaped = '\u0000\\"\n😀'.repeat(80_000)
  const worstCase = commentPrompt(escaped, { ...longAnchor, quote: escaped }, '问题完整', [event(1, escaped)], [event(1, escaped, 'user_message')])
  assert.ok(worstCase.length <= COMMENT_PROMPT_MAX_CHARS, 'JSON escaping, long selections and restored discussions must share the input budget')
  const maxQuestion = 'q'.repeat(COMMENT_QUESTION_MAX_CHARS)
  const fullBudget = commentPrompt(escaped, { ...longAnchor, quote: escaped }, maxQuestion, [event(1, escaped)], [event(1, escaped, 'user_message')])
  assert.ok(fullBudget.length <= COMMENT_PROMPT_MAX_CHARS)
  assert.ok(fullBudget.endsWith(maxQuestion), 'the longest accepted question must not be truncated')
  const removalStore = new CommentStore(join(root, 'removal'))
  const removalCallbacks: CommentRuntimeCallbacks[] = []
  const removalPrompts: string[] = []
  let removalStops = 0
  let rejectNextTurn = false
  let waitForReady: (() => Promise<void>) | undefined
  const removals = new CommentService({ ...deps, store: removalStore, events: async () => longParent,
    ready: async () => { await waitForReady?.() },
    runtime: (_config, callback) => { removalCallbacks.push(callback); return { async send(prompt) { removalPrompts.push(prompt); if (rejectNextTurn) { rejectNextTurn = false; throw new Error('turn/start rejected') } }, stop() { removalStops++ }, async respond() {}, dispose() {} } }
  })
  try {
    const select = { seq: 2, start: 600_000, end: 600_006, quote: '这段需要解释', selectedMessageText: longSource }
    const draft = await removals.create(parent.id, select)
    await assert.rejects(removals.send(parent.id, draft.id, 'x'.repeat(COMMENT_QUESTION_MAX_CHARS + 1)), /问题过长/)
    assert.equal((await removals.list(parent.id))[0].events.length, 0, 'oversize questions must be rejected before entering the thread')
    await assert.rejects(removals.remove('other', draft.id), /不属于/)
    await removals.remove(parent.id, draft.id)
    assert.equal((await removals.list(parent.id)).length, 0, 'draft deletion must persist without starting a runtime')
    const running = await removals.create(parent.id, select)
    await removals.send(parent.id, running.id, 'hi')
    assert.ok(removalPrompts[0].length <= COMMENT_PROMPT_MAX_CHARS, 'the actual first runtime turn must receive bounded context')
    removalCallbacks[0].event({ ...event(8, '输入过长', 'error'), payload: { message: 'turn/start failed' } })
    removalCallbacks[0].status('error')
    await removals.send(parent.id, running.id, '重试')
    assert.equal(removalCallbacks.length, 2, 'a failed native turn must not reuse a runtime that missed its initial context')
    assert.match(removalPrompts[1], /最初需求：固定讨论背景/)
    removalCallbacks.at(-1)!.status('idle')
    rejectNextTurn = true
    await assert.rejects(removals.send(parent.id, running.id, '连接失败'), /turn\/start rejected/)
    await removals.send(parent.id, running.id, '连接失败后重试')
    assert.equal(removalCallbacks.length, 3, 'a rejected runtime send must rebuild its context on retry')
    assert.match(removalPrompts.at(-1)!, /最初需求：固定讨论背景/)
    const save = removalStore.save.bind(removalStore)
    removalStore.save = async () => { throw new Error('写盘失败') }
    await assert.rejects(removals.remove(parent.id, running.id), /写盘失败/)
    removalStore.save = save
    assert.equal((await removals.list(parent.id)).length, 1, 'failed durable deletion must keep the thread accessible')
    await removals.send(parent.id, running.id, '继续回答')
    removalCallbacks.at(-1)!.event(event(9, '删除前的事件'))
    let deleted = false, lateChanges = 0
    removals.on('removed', reference => { assert.equal(reference.id, running.id); deleted = true })
    removals.on('changed', () => { if (deleted) lateChanges++ })
    await removals.remove(parent.id, running.id)
    removalCallbacks.at(-1)!.event(event(10, '删除后的迟到回答')); removalCallbacks.at(-1)!.status('idle')
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(lateChanges, 0, 'late events and scheduled writes must never resurrect a removed thread')
    assert.equal(removals.hasActiveWork(), false)
    assert.ok(removalStops >= 2)
    const preparing = await removals.create(parent.id, select)
    let release!: () => void
    waitForReady = () => new Promise<void>(resolve => { release = resolve })
    const sending = removals.send(parent.id, preparing.id, '准备时删除')
    while (!release) await new Promise(resolve => setImmediate(resolve))
    const turns = removalPrompts.length
    removals.removeAllListeners('removed')
    await removals.remove(parent.id, preparing.id)
    release(); await sending
    assert.equal(removalPrompts.length, turns)
    assert.equal((await removalStore.load(parent.id)).length, 0, 'deleted comments stay absent after reloading the store')
  } finally { await removals.close() }
  const snapshots: UAEvent[] = []
  let rendered: UAEvent[] = []
  for (const snapshot of [
    { ...event(20, '流式回复'), state: 'running' as const, payload: { id: 'stable-reply', turnId: 'stable-turn', text: '流式回复' } },
    { ...event(29, '流式回复完成'), state: 'success' as const, payload: { id: 'stable-reply', turnId: 'stable-turn', text: '流式回复完成' } }
  ]) {
    appendEventSnapshot(snapshots, snapshot)
    rendered = mergeSessionEvent(rendered, snapshot)
  }
  assert.equal(snapshots[0].seq, 20)
  assert.equal(rendered[0].seq, 29, 'renderer and canonical buffer can keep different seq for one native reply')
  const sourceStore = new CommentStore(join(root, 'source-resolution'))
  const sourceService = new CommentService({ ...deps, store: sourceStore, events: async () => snapshots })
  try {
    const reply = rendered[0]
    const created = await sourceService.create(parent.id, {
      seq: reply.seq, messageId: reply.payload.id, turnId: reply.payload.turnId,
      start: 0, end: 4, quote: '流式回复', selectedMessageText: '流式回复完成', sourceText: reply.payload.text
    })
    assert.equal(created.anchor.messageId, 'stable-reply')
    assert.equal(created.anchor.seq, 20, 'store canonical position alongside the stable reply identity')
    assert.equal(created.anchor.turnId, 'stable-turn')
    const stored = (await sourceStore.load(parent.id))[0]
    assert.equal(stored.sourceContent, '流式回复完成')
    assert.equal(findCommentSource([{ ...snapshots[0], seq: 200 }], created.anchor)?.seq, 200, 'history replay can resequence the same native reply')
    const unrelated = { ...event(29, '另一轮回复'), payload: { id: 'other-reply', turnId: 'other-turn', text: '另一轮回复' } }
    snapshots.push(unrelated)
    assert.equal(findCommentSource(snapshots, { ...created.anchor, seq: 29 })?.payload.id, 'stable-reply', 'native identity wins when the view seq points to another reply')
    assert.equal(findCommentSource([unrelated], created.anchor), undefined, 'a deleted source must not attach to an unrelated position')
    assert.equal(findCommentSource(snapshots, { seq: 999, sourceText: '流式回复完成' })?.payload.id, 'stable-reply', 'legacy references require a unique verified source text')
    snapshots.push({ ...snapshots[0], seq: 30, payload: { ...snapshots[0].payload, turnId: 'later-turn' } })
    assert.equal(findCommentSource(snapshots, created.anchor)?.seq, 20, 'reused item IDs remain scoped to their native turn')
    assert.equal(findCommentSource(snapshots, { seq: 999, sourceText: '流式回复完成' }), undefined, 'ambiguous legacy references do not guess')
    await assert.rejects(sourceService.create(parent.id, { seq: 20, messageId: 'removed-reply', start: 0, end: 4, quote: '流式回复', selectedMessageText: '流式回复完成' }), /原回复已不存在/)
    await assert.rejects(sourceService.create(parent.id, { seq: 29, messageId: 'stable-reply', turnId: 'stable-turn', start: 0, end: 4, quote: '流式回复', selectedMessageText: '流式回复完成', sourceText: '旧版本原文' }), /原文已变化/)
    assert.equal((await sourceService.list(parent.id)).length, 1, 'rejected references must not create orphan drafts')
  } finally { await sourceService.close() }
  let negotiatedConfig: Session['config'] | undefined
  const negotiatedOwner = { ...parent, config: { ...parent.config, model: 'contract-a' }, agentContract: {
    models: [{ id: 'contract-a', label: 'A', efforts: [] }, { id: 'contract-b', label: 'B', efforts: [] }],
    currentModelId: 'contract-a', permissionModes: agent.capabilities.permissionModes
  } } as Session
  const negotiated = new CommentService({ ...deps, store: new CommentStore(join(root, 'negotiated')),
    session: id => id === parent.id ? negotiatedOwner : undefined,
    runtime: (config, callback) => ({ async send() { negotiatedConfig = config; callback.status('idle') }, stop() {}, async respond() {}, dispose() {} })
  })
  try {
    const draft = await negotiated.create(parent.id, { seq: 2, start: 0, end: 5, quote: '上下文快照', selectedMessageText: '上下文快照固定' })
    await negotiated.send(parent.id, draft.id, '使用协商后的当前 Agent 模型', { agentId: 'codex', model: 'contract-b' })
    assert.equal(negotiatedConfig?.model, 'contract-b', 'current-session negotiated models must remain selectable')
  } finally { await negotiated.close() }
  const selection = { seq: 2, start: 0, end: 5, quote: '上下文快照', selectedMessageText: '上下文快照固定' }
  const anchor = commentAnchor(selection)
  assert.deepEqual(resolveCommentAnchor('新增：上下文快照固定', anchor), { start: 3, end: 8 })
  assert.equal(resolveCommentAnchor('原文被删除', anchor), undefined)
  assert.equal(resolveCommentAnchor('上下文快照固定 上下文快照固定', { ...anchor, start: 50, end: 55, prefix: '', suffix: '' }), undefined)
  assert.throws(() => commentAnchor({ ...selection, end: 100 }), /重新划线/)
  const thread = await service.create(parent.id, selection)
  assert.equal(thread.status, 'draft')
  assert.equal(thread.config.model, parent.config.model)
  assert.equal('context' in thread, false, 'private snapshot never crosses the bridge')
  parentEvents[0].payload.text = '方案 B'
  parentEvents.push(event(3, '后续主会话进展'))
  await service.send(parent.id, thread.id, '为什么固定？')
  assert.equal(service.hasActiveWork(), true)
  assert.equal(service.activities()[0].id, `comment:${thread.id}`)
  assert.match(prompts[0], /方案 A/)
  assert.doesNotMatch(prompts[0], /方案 B|后续主会话进展/)
  assert.ok(prompts[0].includes(COMMENT_INSTRUCTIONS))
  assert.equal((configs[0] as any).permissionMode, 'full-access', 'consultation prompt must not silently impose another permission mode')
  await assert.rejects(service.send(parent.id, thread.id, '并发问题'), /正在回答/)
  await assert.rejects(service.send('other', thread.id, '串会话'), /不属于/)
  callbacks[0].event(event(1, '回答中'))
  callbacks[0].event(event(1, '回答完成'))
  callbacks[0].status('idle')
  assert.equal(service.hasActiveWork(), false)
  let current = (await service.list(parent.id))[0]
  assert.equal(current.events.filter(event => event.type === 'agent_message').length, 1, 'stream updates replace the same answer')
  const beforeRejectedSwitch = { events: current.events.length, prompts: prompts.length, runtimes: callbacks.length }
  await assert.rejects(service.send(parent.id, thread.id, '尝试切换 Agent', { agentId: 'other-agent', model: 'model-a' }), /只能使用主会话当前 Agent/)
  current = (await service.list(parent.id))[0]
  assert.deepEqual({ events: current.events.length, prompts: prompts.length, runtimes: callbacks.length }, beforeRejectedSwitch,
    'a cross-agent request must fail before accepting the question or starting a runtime')
  assert.equal(current.status, 'idle')
  await service.send(parent.id, thread.id, '继续追问')
  assert.equal(callbacks.length, 1, 'followups reuse the independent runtime')
  assert.doesNotMatch(prompts[1], /方案 B|后续主会话进展/)
  callbacks[0].event(event(2, '第二次回答'))
  callbacks[0].status('idle')
  current = (await service.list(parent.id))[0]
  assert.equal(new Set(current.events.map(event => event.seq)).size, current.events.length)
  await service.send(parent.id, thread.id, '切换模型', { agentId: 'codex', model: 'model-b' })
  assert.equal(callbacks.length, 2)
  assert.match(prompts[2], /继续追问|回答完成/)
  assert.match(prompts[2], /方案 A/)
  callbacks[1].event({ ...event(8, '等待查询批准', 'approval_request'), state: 'pending' })
  await service.stop(parent.id, thread.id)
  assert.equal((await service.list(parent.id))[0].events.find(event => event.type === 'approval_request')?.state, 'cancelled')
  assert.equal((await service.list(parent.id))[0].events.find(event => event.type === 'approval_request')?.payload.interactionExpired, true)
  assert.equal(stopped, 1)
  const count = (await service.list(parent.id))[0].events.length
  callbacks[1].event(event(4, '迟到事件'))
  assert.equal((await service.list(parent.id))[0].events.length, count)
  assert.equal((await service.list(parent.id))[0].status, 'interrupted')
  assert.ok(disposed >= 2)
  const file = await service.create(parent.id, { seq: -1, start: 0, end: 8, quote: 'Markdown', selectedMessageText: 'Markdown 文档', filePath: '/repo/doc.md', sourceText: fileText })
  assert.equal(file.anchor.filePath, '/repo/doc.md')
  fileText = '文档变化'
  await assert.rejects(service.create(parent.id, { seq: -1, start: 0, end: 8, quote: 'Markdown', selectedMessageText: 'Markdown 文档', filePath: '/repo/doc.md', sourceText: '**Markdown** 文档' }), /原文已变化/)
  assert.equal((await service.list('other')).length, 0)
  await service.send(parent.id, file.id, '说明文件')
  await service.close()
  deps.store = new CommentStore(root)
  const legacy = await deps.store.load(parent.id)
  const legacyThread = legacy.find(row => row.id === thread.id)!
  legacyThread.config = { ...legacyThread.config, agentId: 'other-agent', model: 'foreign-model' }
  await deps.store.save(parent.id, legacy)
  service = new CommentService(deps)
  const restored = await service.list(parent.id)
  assert.equal(restored.length, 2)
  assert.equal(restored.find(row => row.id === file.id)?.status, 'interrupted', 'restart never pretends a lost stream is running')
  await service.send(parent.id, thread.id, '重启后追问')
  assert.equal((configs.at(-1) as Session['config']).agentId, parent.config.agentId, 'old cross-agent threads resume through the current parent Agent')
  assert.equal((configs.at(-1) as Session['config']).model, parent.config.model)
  assert.match(prompts.at(-1)!, /方案 A/)
  assert.match(prompts.at(-1)!, /回答完成/, 'moving an old thread back to the parent Agent keeps its discussion')
  assert.doesNotMatch(prompts.at(-1)!, /后续主会话进展/)
  parent.config.permissionMode = 'read-only'
  await service.syncPermissions(parent)
  assert.equal((await service.list(parent.id)).find(row => row.id === thread.id)?.status, 'interrupted')
  await service.send(parent.id, thread.id, '权限收紧后继续查询')
  assert.equal((configs.at(-1) as any).permissionMode, 'read-only')
  await service.stop(parent.id, thread.id)
  let releaseReady!: () => void
  deps.ready = () => new Promise(resolve => { releaseReady = resolve })
  const turnsBefore = prompts.length
  const preparing = service.send(parent.id, thread.id, '准备过程中停止')
  while (!releaseReady) await new Promise(resolve => setImmediate(resolve))
  await service.stop(parent.id, thread.id)
  releaseReady(); await preparing
  assert.equal(prompts.length, turnsBefore, 'stop cancels a turn still waiting for agent readiness')
  assert.equal((await service.list(parent.id)).find(row => row.id === thread.id)?.events.findLast(event => event.type === 'user_message')?.payload.text, '准备过程中停止', 'a stopped preparation must keep the submitted question')
  releaseReady = undefined as any
  const closingTurn = service.send(parent.id, thread.id, '关闭时仍在准备')
  while (!releaseReady) await new Promise(resolve => setImmediate(resolve))
  await service.close(); releaseReady(); await closingTurn
  assert.equal(prompts.length, turnsBefore, 'shutdown cancels preparation before any native turn can start')
console.log('instant feedback comments: bounded snapshot, escaped input, error retry, delete persistence/failure, late events and permissions passed')
} finally { await service.close(); await rm(root, { recursive: true, force: true }) }
