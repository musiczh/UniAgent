import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequirementStore } from '../src/main/requirementStore'
import { runRequirementCuration, CURATION_SYSTEM_PROMPT } from '../src/main/requirementCurationRuntime'
import type { AgentDef } from '../src/shared/types'

const home = await mkdtemp(join(tmpdir(), 'curation-runtime-')), store = new RequirementStore(home)
try {
  const requirement = await store.create({ name: 'Multi Agent' }), calls: any[] = []
  const agent = (adapter: string) => ({ id: adapter, adapter, name: adapter, installed: true, models: [{ id: 'vision', label: 'Vision', imageInput: true, efforts: ['low'] }], capabilities: { startupSystemPrompt: true, modelSelect: true } }) as AgentDef
  const image = { kind: 'image' as const, name: 'fixture.png', path: '/fixture.png', mime: 'image/png' }
  store.configureContext({ requirementId:()=>requirement.id, events:async()=>[
    {sessionId:'source',seq:0,ts:1,type:'user_message',payload:{text:'已结束输入',attachments:[image]}},
    {sessionId:'source',seq:1,ts:2,type:'turn_completed',payload:{}},
    {sessionId:'source',seq:2,ts:3,type:'user_message',payload:{text:'尚未结束输入',attachments:[{...image,path:'/unfinished.png'}]}}
  ] })
  assert.deepEqual((await store.taskEvidence(requirement.id,'source')).flatMap(event=>event.images),[image],'curation images only come from completed source turns')
  let shouldFail = false
  const deps = {
    generate: async (agent: any, config: any, prompt: any, signal: any, options: any, images: any) => {
      calls.push({ agent: agent.id, config, prompt, options, images }); signal.throwIfAborted()
      if (Buffer.byteLength(prompt) > (options.maxInputBytes ?? 64 * 1024)) throw Error('标题输入为空或过长')
      if (shouldFail) throw Error('model failed')
      return '{"labels":["上一项结论"]}'
    },
    extract: async (_agent: any, _config: any, _prompt: any, _signal: any, _factory: any, options: any) => {
      calls.push({ native: true, options }); await options.session.onThread('owned-codex'); return '{"labels":["原生结论"]}'
    }
  }
  for (const adapter of ['claude','traex','qoder','deepseek']) {
    await runRequirementCuration(store, requirement.id, agent(adapter), { agentId: adapter, model: 'vision', effort: 'low' }, '本轮资料 '+adapter, new AbortController().signal, [image], deps as any)
    assert.equal(calls.at(-1).options.systemPrompt, CURATION_SYSTEM_PROMPT)
    assert.deepEqual(calls.at(-1).images, [image])
  }
  assert.match(calls[1].prompt, /上一项结论/)
  let conversation = await new RequirementStore(home).readCurationConversation(requirement.id)
  assert.equal(conversation.sessionId, 'curation-'+requirement.id)
  assert.equal(conversation.events.filter(event => event.type === 'user_message').length, 4)
  assert.equal(conversation.events.filter(event => event.type === 'agent_message').length, 4)
  await runRequirementCuration(store, requirement.id, agent('codex'), { agentId: 'codex', model: 'vision' }, '原生资料', new AbortController().signal, [], deps as any)
  await runRequirementCuration(store, requirement.id, agent('codex'), { agentId: 'codex', model: 'vision' }, '原生续接', new AbortController().signal, [], deps as any)
  assert.equal(calls.at(-1).options.session.threadId, 'owned-codex')
  await runRequirementCuration(store, requirement.id, agent('claude'), { agentId: 'claude', model: 'vision' }, '切换资料', new AbortController().signal, [], deps as any)
  assert.equal((await store.readCuration(requirement.id)).nativeThreadId, undefined, 'a different Agent cannot reuse the Codex thread')
  shouldFail = true
  await assert.rejects(runRequirementCuration(store, requirement.id, agent('claude'), { agentId: 'claude', model: 'vision' }, '失败资料', new AbortController().signal, [], deps as any), /model failed/)
  conversation = await new RequirementStore(home).readCurationConversation(requirement.id)
  assert.equal(conversation.events.at(-1)?.type, 'error')
  assert.equal(new Set(conversation.events.map(event=>event.seq)).size, conversation.events.length)
  const controller = new AbortController(); controller.abort()
  const count = calls.length
  await assert.rejects(runRequirementCuration(store, requirement.id, agent('claude'), { agentId: 'claude', model: 'vision' }, '取消资料', controller.signal, [], deps as any))
  assert.equal(calls.length, count)
  const largePrompt = '完整需求资料。'.repeat(20000)
  shouldFail = false
  await runRequirementCuration(store, requirement.id, agent('traex'), { agentId: 'traex', model: 'vision' }, largePrompt, new AbortController().signal, [], deps as any)
  assert.equal(calls.at(-1).prompt, largePrompt, 'large current materials are preserved without replaying earlier requests')
  assert.equal(calls.at(-1).options.maxInputBytes, 512 * 1024)
  assert.equal(calls.at(-1).options.timeoutMs, 120000)
  await assert.rejects(runRequirementCuration(store, requirement.id, agent('traex'), { agentId: 'traex', model: 'vision' }, '超时资料', new AbortController().signal, [], {
    ...deps, generate: async () => { throw Error('任务标题生成超时') }
  } as any), /需求后台整理超时/)
  assert.match((await store.readCurationConversation(requirement.id)).events.at(-1)!.payload.message as string, /需求后台整理超时/)
} finally { await rm(home, { recursive: true, force: true }) }
console.log('PASS multi-Agent curation requests, native thread reuse, durable cross-Agent history, images, failure and cancellation')
