import assert from 'node:assert/strict'
import { buildQuickReplyPrompt, parseQuickReplies } from '../src/shared/quickReplies'
import { QuickReplyService } from '../src/main/quickReplyService'
import type { Session, UAEvent } from '../src/shared/types'

const output = JSON.stringify({ replies: [{ label: '继续实施', text: '按已确认方案继续实施，并运行相关回归。' }] })
assert.deepEqual(parseQuickReplies(output), [{ label: '继续实施', text: '按已确认方案继续实施，并运行相关回归。' }])
assert.deepEqual(parseQuickReplies('{"replies":[]}'), [])
assert.throws(() => parseQuickReplies('not json'))
assert.throws(() => parseQuickReplies('{"replies":[],"send":true}'))
assert.deepEqual(parseQuickReplies(JSON.stringify({ replies: [
  { label: '太长的按钮文案', text: '继续' }, { label: '继续', text: 'x'.repeat(51) },
  { label: '继续', text: '相同回复' }, { label: '继续', text: '相同回复' },
  { label: '看结果', text: '查看结果' }, { label: '补说明', text: '补充说明' }, { label: '多余', text: '第四项' }
]})), [{ label: '继续', text: '相同回复' }, { label: '看结果', text: '查看结果' }, { label: '补说明', text: '补充说明' }])
assert.equal(parseQuickReplies(JSON.stringify({ replies: [{ label: '😀😀😀😀😀', text: '😀'.repeat(50) }] })).length, 1, 'count Unicode characters')
const prompt = buildQuickReplyPrompt('前'.repeat(20000) + '用户目标', '中'.repeat(20000) + '最终结论')
assert.ok(Buffer.byteLength(prompt) < 16384)
assert.ok(prompt.includes('用户目标') && prompt.includes('最终结论'), 'bounded context retains the end of each input')
assert.ok(!buildQuickReplyPrompt('api_key=sk-fixture-secret0123', 'password: secret').includes('sk-fixture-secret0123'))

const session: Session = { id: 'task', title: '任务', status: 'completed', createdAt: 1, config: { agentId: 'codex' } }
const agent = { id: 'claude', name: 'Claude', adapter: 'claude', installed: true,
  models: [{ id: 'small', label: 'Small', efforts: [] }], capabilities: { startupSystemPrompt: true, modelSelect: true } } as any
let enabled = true, selection: any = { enabled: false, agentId: 'claude', model: 'small' }, finish: (text: string) => void = () => {}, calls: any[] = [], pushes = 0
const service = new QuickReplyService({ session: id => id === session.id ? session : undefined,
  agents: () => [agent], config: () => ({ enabled, model: selection }), publish: () => { pushes++ },
  generate: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve }) } })
let seq = 0
const event = (type: UAEvent['type'], payload: any = {}, state: UAEvent['state'] = 'success'): UAEvent => ({ sessionId: session.id, seq: ++seq, ts: seq, type, payload, state })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const input = (text = '实施功能') => { service.observe(event('user_message', { text })); service.accepted(session.id); service.observe(event('turn_started', { turnId: 'turn-' + seq })) }
try {
  input()
  service.observe(event('agent_message', { text: '第一段', messageId: 'reply', partial: true }))
  await tick(); assert.equal(calls.length, 0, 'never generate from a partial reply')
  service.observe(event('agent_message', { text: '已完成，需要你确认下一步。', messageId: 'reply', phase: 'final_answer' }))
  service.observe(event('agent_message', { text: '后台清理结束', messageId: 'cleanup' }))
  service.observe(event('turn_completed'))
  await tick(); assert.equal(calls.length, 1, 'reply generation works while title generation is off')
  assert.ok(calls[0][2].includes('已完成，需要你确认下一步。'))
  assert.ok(!calls[0][2].includes('后台清理结束'), 'explicit final answer takes precedence over later commentary')
  finish(output); await tick()
  assert.equal(session.quickReplies?.length, 1)
  service.observe(event('turn_completed')); await tick(); assert.equal(calls.length, 1, 'duplicate completion is idempotent')
  service.accepted(session.id); await tick(); assert.equal(calls.length, 1, 'duplicate acceptance cannot reschedule a finished round')
  input('新一轮')
  assert.equal(session.quickReplies, undefined, 'accepted new input clears old suggestions')
  service.observe(event('agent_message', { text: '新结论' })); service.observe(event('turn_completed'))
  await tick(); assert.equal(calls.length, 2)
  const oldFinish = finish
  input('更新输入'); oldFinish(output); await tick()
  assert.equal(session.quickReplies, undefined, 'late results cannot populate a newer round')
  service.observe(event('agent_message', { text: '失败前的回复' })); service.observe(event('turn_completed', {}, 'failed'))
  await tick(); assert.equal(calls.length, 2, 'failed rounds do not produce suggestions')
  input(); service.observe(event('agent_message', { text: '完成' })); service.observe(event('turn_completed'))
  await tick(); enabled = false; service.configurationChanged(); finish(output); await tick()
  assert.equal(session.quickReplies, undefined, 'turning off cancels and rejects pending results')
  enabled = true; selection = { enabled: true }
  input(); service.observe(event('agent_message', { text: '完成' })); service.observe(event('turn_completed'))
  await tick(); assert.equal(calls.length, 3, 'missing model never falls back to the main task model')
  selection = { enabled: true, agentId: 'claude', model: 'small' }
  session.archived = true; input(); service.observe(event('agent_message', { text: '完成' })); service.observe(event('turn_completed'))
  await tick(); assert.equal(calls.length, 3)
  assert.ok(pushes > 0)
} finally { await service.close() }
console.log('PASS quick replies parsing, bounded input, final output, independent toggle, cancellation and stale-round guards')
