import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { TaskMetadataStore } from '../src/main/taskMetadataStore'
import { TaskTitleService } from '../src/main/taskTitleService'
import { TaskTitleIntegration } from '../src/main/taskTitleIntegration'
import type { AgentDef, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'title-host-'))
const agent = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', builtin: true, installed: true,
  models: [{ id: 'small', label: 'Small', efforts: ['low'] }], capabilities: { startupSystemPrompt: true, streaming: true, modelSelect: true,
    permissionModes: [{ id: 'ask', label: '按需批准', hint: '' }] } } as AgentDef
const originalStart = AppServerRunner.prototype.startTurn
const runners: AppServerRunner[] = []
AppServerRunner.prototype.startTurn = async function() { runners.push(this) }
const disk = new SessionStore(join(root, 'sessions.json'))
const host = new Orchestrator(() => agent, disk, root, join(root, 'logs'))
let generated = 0, resolveTitle!: (text: string) => void
const titles = new TaskTitleService(new TaskMetadataStore(join(root, 'titles')), {
  session: id => host.getSessionById(id), agents: () => [agent], config: () => ({ enabled: true, agentId: 'codex', model: 'small' }),
  generate: async (_agent, config) => { generated++; assert.equal(config.model, 'small'); return new Promise(resolve => { resolveTitle = resolve }) },
  publish: session => host.publishTaskState(session)
}, { debounceMs: 0 })
const accepted: string[] = []
const bridge = new TaskTitleIntegration({ accepted: (id, text, identity) => { accepted.push(text); titles.accepted(id, text, identity) },
  responded: (id, text, inputId) => titles.responded(id, text, inputId), cancel: id => titles.cancel(id) }, id => host.getSessionById(id))
host.on('sessionCreated', session => titles.store.initialize(session, false))
host.on('taskTitleInputRecorded', event => bridge.observe(event))
host.on('event', event => bridge.observe(event))
host.on('taskInputAccepted', id => bridge.accepted(id))
host.on('sessionDeleted', id => bridge.remove(id))
const until = async (check: () => boolean) => { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('title host did not settle') }
try {
  const session = host.createSession({ agentId: 'codex', workdir: root }, '请帮我把图片修复一下')
  await until(() => runners.length === 1)
  assert.deepEqual(accepted, ['请帮我把图片修复一下'])
  assert.equal(generated, 0)
  let seq = 100
  const emit = (type: UAEvent['type'], payload: any) => runners.at(-1)!.emit('event', { sessionId: session.id, seq: seq++, ts: Date.now(), type, payload } satisfies UAEvent)
  emit('turn_started', { threadId: 'native' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(generated, 0, 'connection alone cannot generate title')
  emit('turn_started', { threadId: 'native', turnId: 'first' })
  emit('agent_message', { id: 'reply-first', text: '主 AI 分析：图片来自任务历史，需要修复附件预览。', phase: 'final_answer', turnId: 'first' })
  await new Promise(resolve => setTimeout(resolve, 10))
  await until(() => generated === 1)
  await host.sendMessage(session.id, '队列里的下一条输入')
  assert.deepEqual(accepted, ['请帮我把图片修复一下'], 'queued input waits for dispatch')
  emit('turn_completed', { turnId: 'first' })
  await until(() => generated === 1)
  const before = { updatedAt: session.updatedAt, title: session.title, nativeId: session.nativeSessionId, config: structuredClone(session.config), taskState: structuredClone(session.taskState) }
  resolveTitle('{"title":"修复任务图片漏显","description":"任务描述夹具","needsClarification":false}')
  await until(() => session.taskMetadata?.title === '修复任务图片漏显')
  assert.equal(session.title, before.title)
  assert.equal(session.updatedAt, before.updatedAt)
  assert.equal(session.nativeSessionId, before.nativeId)
  assert.deepEqual(session.config, before.config)
  assert.deepEqual(session.taskState, before.taskState)
  runners.at(-1)!.emit('done', { nativeSessionId: 'native', failed: false })
  await until(() => runners.length === 2)
  assert.equal(accepted.at(-1), '队列里的下一条输入', 'queue dispatch emits actual acceptance')
  emit('turn_started', { threadId: 'native', turnId: 'second' })
  await titles.store.flush()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(generated, 1, 'stable title does not rename on continuation')
  console.log('PASS task title through actual Orchestrator, first output gate, queue dispatch and activity/model/native/lifecycle preservation')
} finally {
  await titles.close()
  for (const session of host.listSessions()) host.interrupt(session.id)
  await host.closeSessionLogs()
  AppServerRunner.prototype.startTurn = originalStart
  await rm(root, { recursive: true, force: true })
}
