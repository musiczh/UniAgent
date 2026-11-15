import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { QuickReplyService } from '../src/main/quickReplyService'
import type { AgentDef, UAEvent } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'quick-replies-host-'))
const agent = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', installed: true, builtin: true,
  models: [{ id: 'small', label: 'Small', efforts: [] }], capabilities: { startupSystemPrompt: true, streaming: true, modelSelect: true, permissionModes: [{ id: 'ask', label: '按需批准', hint: '' }] } } as AgentDef
const originalStart = AppServerRunner.prototype.startTurn, runners: AppServerRunner[] = []
AppServerRunner.prototype.startTurn = async function() { runners.push(this) }
const host = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')), root, join(root, 'logs'))
let generated = 0, finish: (text: string) => void = () => {}
const replies = new QuickReplyService({ session: id => host.getSessionById(id), agents: () => [agent],
  config: () => ({ enabled: true, model: { enabled: false, agentId: 'codex', model: 'small' } }),
  generate: async (_agent, config, prompt, _signal, id) => { generated++; assert.equal(config.model, 'small'); assert.equal(id, session.id); assert.ok(prompt.includes('最终业务结论')); return new Promise(resolve => { finish = resolve }) },
  publish: session => host.publishTaskState(session) })
host.on('taskTitleInputRecorded', event => replies.observe(event))
host.on('event', event => replies.observe(event))
host.on('taskInputAccepted', id => replies.accepted(id))
host.on('sessionDeleted', id => replies.remove(id))
const until = async (check: () => boolean) => { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('quick reply host did not settle') }
const session = host.createSession({ agentId: 'codex', workdir: root }, '实施已确认的需求')
try {
  await until(() => runners.length === 1)
  let seq = 100
  const emit = (type: UAEvent['type'], payload: any) => runners.at(-1)!.emit('event', { sessionId: session.id, seq: seq++, ts: Date.now(), type, payload } satisfies UAEvent)
  emit('turn_started', { threadId: 'native', turnId: 'first' })
  emit('agent_message', { id: 'opening', text: '先进行分析。', turnId: 'first' })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(generated, 0)
  emit('agent_message', { id: 'final', text: '最终业务结论：已实施，待用户确认。', phase: 'final_answer', turnId: 'first' })
  assert.equal(generated, 0)
  emit('turn_completed', { turnId: 'first' }); await until(() => generated === 1)
  const before = { config: structuredClone(session.config), state: structuredClone(session.taskState), nativeId: session.nativeSessionId, updatedAt: session.updatedAt }
  finish('{"replies":[{"label":"查看结果","text":"请展示当前结果和验证结论。"}]}')
  await until(() => !!session.quickReplies?.length)
  assert.deepEqual(session.config, before.config); assert.deepEqual(session.taskState, before.state)
  assert.equal(session.nativeSessionId, before.nativeId); assert.equal(session.updatedAt, before.updatedAt)
  await host.sendMessage(session.id, '继续推进')
  runners[0].emit('done', { nativeSessionId: 'native', failed: false })
  await until(() => runners.length === 2)
  assert.equal(session.quickReplies, undefined, 'the queued input clears suggestions only after actual dispatch')
  assert.equal(host.listSessions().length, 1, 'continuation retains the original task')
} finally {
  await replies.close()
  for (const session of host.listSessions()) host.interrupt(session.id)
  await host.closeSessionLogs(); AppServerRunner.prototype.startTurn = originalStart
  await rm(root, { recursive: true, force: true })
}
console.log('PASS actual Orchestrator end gate, final answer, queue dispatch and task/native/model/lifecycle preservation')
