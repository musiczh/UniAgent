import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { RouterController } from '../src/main/router/controller'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'
import { feishuRouteAnswer, feishuRouteCard, feishuRouteId } from '../src/main/feishuRouting'
import type { RouterStore } from '../src/main/router/store'
import type { AgentDef } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'router-feishu-'))
const database = new RouterDatabase(join(directory, 'router.sqlite'))
const store = new Proxy({} as RouterStore, { get: (_, key: string) => async (...args: unknown[]) => (database[key as keyof RouterDatabase] as Function).apply(database, args) })
const config = { ...DEFAULT_ROUTER_CONFIG, enabled: true }
const agent = { id: config.agentId, installed: true, adapter: 'deepseek', models: [{ id: config.model, efforts: ['max'] }], capabilities: { auxiliarySystemPrompt: true, protocol: 'web' } } as AgentDef
const interrupted: string[] = []
const controller = new RouterController(store, { agents: () => [agent], config: () => config, saveConfig() {},
  orchestrator: { interrupt: id => interrupted.push(id) } as any,
  objects: async () => [], changed() {}, error() {}, newTask: async () => { throw Error('unexpected dispatch') }, recoverTask: async () => undefined }, directory)
// Isolate state transitions from the native Router pump; delivery ordering is
// exercised through the actual MCP/controller path in router-controller.ts.
;(controller as any).pump = () => {}
const source = { botAppId: 'fixture', chatId: 'fixture-chat', rootMessageId: 'root', cardMessageId: 'card' }
try {
  const request = database.register({ requestId: randomUUID(), prompt: 'route', feishu: source }, config)
  const failed = database.update(request.requestId, request.version, { state: 'failed', error: 'connection lost', context: { objects: [{ id: 'stale', version: '1' }], reading: { scannedTaskIds: ['stale'], details: [], catalogs: [{ key: 'space', complete: true, catalogRevision: 'old-catalog', asOf: 1 }] } } })
  await assert.rejects(controller.retry(failed.requestId, failed.version - 1), /不能重新路由/)
  const retry = await controller.retry(failed.requestId, failed.version)
  assert.equal(retry.state, 'queued'); assert.deepEqual(retry.context?.objects, [{ id: 'stale', version: '1' }], 'the same requestId retains prior reading as a fast entry'); assert.deepEqual(retry.context?.reading, { scannedTaskIds: ['stale'], details: [], catalogs: [{ key: 'space', complete: true, catalogRevision: 'old-catalog', asOf: 1 }] }, 'old reading keeps its original catalog revision and asOf'); assert.equal(retry.error, undefined)
  assert.deepEqual(retry.feishu, source)
  for (let i = 0; i < 205; i++) database.register({ requestId: randomUUID(), prompt: 'newer' }, config)
  assert.ok(!database.requests().some(row => row.requestId === retry.requestId))
  assert.equal(database.feishuTopic('fixture', 'fixture-chat', 'root')!.requestId, retry.requestId, 'older topics do not depend on the recent-request window')
  assert.equal(database.feishuTopic('other-bot', 'fixture-chat', 'root'), undefined)
  assert.equal(database.feishuTopic('fixture', 'other-chat', 'root'), undefined)
  assert.equal(database.feishuTopic('fixture', 'fixture-chat', undefined, 'card')!.requestId, retry.requestId)
  const running = database.update(retry.requestId, retry.version, { state: 'routing' })
  ;(controller as any).active = running.requestId; (controller as any).session = 'router-session'
  const cancelled = await controller.cancel(running.requestId, running.version)
  assert.equal(cancelled.state, 'cancelled'); assert.deepEqual(interrupted, ['router-session'])
  const restarted = await controller.retry(cancelled.requestId, cancelled.version)
  assert.equal(restarted.state, 'queued')
  for (const delivery of ['unknown','accepted','queued','running'] as const) {
    const initial = database.register({ requestId: randomUUID(), prompt: 'uncertain' }, config)
    const blocked = database.update(initial.requestId, initial.version, { state: 'failed', delivery })
    await assert.rejects(controller.retry(blocked.requestId, blocked.version), /不能重新路由/)
    assert.equal(database.request(blocked.requestId)!.delivery, delivery)
  }
  assert.equal(feishuRouteId('bot', 'message'), feishuRouteId('bot', 'message'))
  assert.notEqual(feishuRouteId('bot', 'message'), feishuRouteId('other-bot', 'message'))
  assert.match(feishuRouteId('bot', 'message'), /^[a-f0-9-]{36}$/)
  const unknown = JSON.stringify(feishuRouteCard({ ...request, state: 'bound', delivery: 'unknown' }, { id: 'task', title: 'Task', config: { agentId: 'codex' } } as any))
  assert.match(unknown, /投递待确认/); assert.ok(!unknown.includes('retryRoute'))
  const missing = JSON.stringify(feishuRouteCard({ ...request, state: 'bound' }))
  assert.match(missing, /目标暂不可用/); assert.ok(!missing.includes('retryRoute'))
  const task = { id: 'task', title: 'Task', config: { agentId: 'codex' } } as any
  const original = { sessionId: 'task', chatId: 'oc_fixture', rootMessageId: 'om_root', threadId: 'omt_fixture', lastPushedSeq: 0 }
  const card = feishuRouteCard({ ...request, state: 'bound' }, task, original) as any
  const link = new URL(card.body.elements.find((element: any) => element.behaviors?.[0]?.type === 'open_url').behaviors[0].default_url)
  assert.equal(link.pathname, '/client/thread/open')
  assert.equal(link.searchParams.get('openthreadid'), original.threadId)
  assert.equal(link.searchParams.get('open_thread_id'), original.threadId)
  assert.equal(link.searchParams.get('openchatid'), original.chatId)
  assert.equal(link.searchParams.get('thread_position'), '0')
  assert.match(JSON.stringify(feishuRouteCard({ ...request, state: 'bound', delivery: 'unknown' }, task, original)), /打开原话题/)
  assert.ok(!link.href.includes('om_root'), 'message IDs cannot be used as numeric message positions')
  assert.ok(JSON.stringify(feishuRouteCard({ ...request, state: 'bound' }, task, { ...original, threadId: undefined })).includes('打开原聊天'))
  const failedCard = feishuRouteCard({ ...request, state: 'failed' }, undefined, undefined, true) as any
  const form = failedCard.body.elements.find((row: any) => row.tag === 'form')
  assert.equal(form.elements[0].name, 'routeAnswer')
  assert.equal(form.elements[1].form_action_type, 'submit')
  assert.equal(form.elements[1].behaviors[0].value.routeId, request.requestId)
  const clarification = { ...request, state: 'needs_input' as const, decision: { action: 'clarify' as const, reason: '需要选择', clarificationOptions: [{ objectId: 'space', label: '空间直属' }] } }
  const clarificationCard = feishuRouteCard(clarification) as any
  const choiceForm = clarificationCard.body.elements.find((row: any) => row.tag === 'form')
  const select = choiceForm.elements.find((row: any) => row.tag === 'select_static')
  assert.ok(select, 'clarification uses the native single-select component')
  assert.equal(select.name, 'routeChoice'); assert.equal(select.required, true)
  assert.deepEqual(select.options.map((row: any) => row.value), ['space','__other__'])
  assert.equal(select.options.at(-1).text.content, '其他')
  assert.equal(choiceForm.elements.find((row: any) => row.name === 'routeAnswer').required, false, 'a candidate does not require Other text')
  assert.deepEqual(feishuRouteAnswer(clarification,{routeChoice:'space'}),{action:'answer',answer:'空间直属'},'old card choices submit text without binding a target')
  const textOptions=[{label:'把「开发者选项」移到 superAgent 配置页'},{label:'把黄框里的「按项目和需求组织侧栏」移到 superAgent 配置页'}]
  const textRequest={...clarification,decision:{...clarification.decision,clarificationOptions:textOptions}}
  const textCard=feishuRouteCard(textRequest) as any
  const textSelect=textCard.body.elements.find((row:any)=>row.tag==='form').elements.find((row:any)=>row.tag==='select_static')
  assert.equal(new Set(textSelect.options.map((row:any)=>row.value)).size,3)
  for(const [index,option] of textOptions.entries())assert.deepEqual(feishuRouteAnswer(textRequest,{routeChoice:textSelect.options[index].value,routeAnswer:'忽略未选中的输入'}),{action:'answer',answer:option.label})
  for(const routeChoice of ['forged','option:9',undefined])assert.throws(()=>feishuRouteAnswer(textRequest,{routeChoice}),/选项|候选/)
  assert.throws(()=>feishuRouteAnswer(textRequest,{routeChoice:'__other__',routeAnswer:'  '}),/填写/)
  assert.deepEqual(feishuRouteAnswer(textRequest,{routeChoice:'__other__',routeAnswer:'  另一个设置  '}),{action:'answer',answer:'另一个设置'})
  const emptyCard = feishuRouteCard({ ...clarification, decision: { ...clarification.decision, clarificationOptions: [] } }) as any
  assert.deepEqual(emptyCard.body.elements.find((row: any) => row.tag === 'form').elements.find((row: any) => row.tag === 'select_static').options.map((row: any) => row.value), ['__other__'])
  const automatic = JSON.stringify(feishuRouteCard({ ...request, state: 'queued', autoRecovery: { attempts: 1, total: 1, phase: 'routing', reason: '恢复中', nextAt: Date.now() + 2000 } }))
  assert.match(automatic, /无需操作/); assert.ok(!automatic.includes('retryRoute'))
  assert.ok(!JSON.stringify(feishuRouteCard({ ...request, state: 'failed', delivery: 'unknown' })).includes('retryRoute'))
  console.log('Router Feishu state transitions: retry, active cancellation, durable source and uncertain-delivery guards passed')
} finally { await controller.close() }
