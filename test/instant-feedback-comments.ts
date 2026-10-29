import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommentStore } from '../src/main/commentStore'
import { CommentService, type CommentDependencies } from '../src/main/commentService'
import { commentAnchor, resolveCommentAnchor, COMMENT_INSTRUCTIONS } from '../src/shared/comments'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'
import type { CommentRuntimeCallbacks } from '../src/main/commentRuntime'

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
  service = new CommentService(deps)
  const restored = await service.list(parent.id)
  assert.equal(restored.length, 2)
  assert.equal(restored.find(row => row.id === file.id)?.status, 'interrupted', 'restart never pretends a lost stream is running')
  await service.send(parent.id, thread.id, '重启后追问')
  assert.match(prompts.at(-1)!, /方案 A/)
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
  console.log('instant feedback comments: snapshot, isolation, stream, model switch, stop, file source and restart passed')
} finally { await service.close(); await rm(root, { recursive: true, force: true }) }
