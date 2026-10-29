// Run on request: node scripts/run-ts-test.mjs test/team-requirement-context.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequirementStore } from '../src/main/requirementStore'
import { Orchestrator } from '../src/main/orchestrator'
import type { UAEvent } from '../src/shared/types'

const home = mkdtempSync(join(tmpdir(), 'team-requirement-context-'))
try {
  const store = new RequirementStore(home)
  const requirement = await store.create({ name: '团队需求' })
  const read = () => store.context(requirement.id, 'leader', { action: 'bootstrap' })
  const event: UAEvent = { sessionId: 'leader', seq: 1, ts: 1, type: 'user_message', payload: { text: '完整团队消息：用户目标', displayText: '处理团队消息' } }
  const events: UAEvent[] = [event]
  store.configureContext({ events: async () => events, requirementId: () => requirement.id, isTeam: id => id === 'leader' })
  await store.recordInput(requirement.id, event, 'team')
  await store.recordInput(requirement.id, event, 'team')
  let context = await read()
  assert.equal(context.sync.pending.length, 1)
  assert.equal(context.recentSources, undefined)
  assert.ok(!context.core.content.includes('完整团队消息'))
  await assert.rejects(store.context(requirement.id,'leader',{action:'commit',expectedRevision:context.revision,operationId:'forged-user',documents:[{
    id:'core',kind:'core',title:'目标',content:'派单不能作为用户授权',sources:[{kind:'user',sessionId:'leader',seq:1,quote:'完整团队消息：用户目标'}]
  }]}),/不是用户确认/)
  await store.finishTurn(requirement.id, { ...event, seq:3, type:'turn_completed', state:'failed' })
  context = await read()
  assert.equal(context.sync.pending[0].status, 'interrupted')
  assert.ok(!context.state.content.includes('未完成结果'))
  await store.context(requirement.id, 'leader', {action:'propose',expectedRevision:context.revision,operationId:'team-proposal',documents:[{
    id:'member-finding',kind:'proposal',title:'成员待核实结论',content:'需 Leader 核对'
  }]})
  context = await read()
  assert.equal(context.unresolved[0].id,'member-finding')
  assert.ok(!context.navigation.some((d: any) => d.id === 'member-finding'))
  await store.context(requirement.id,'leader',{action:'pending'})
  await store.context(requirement.id,'leader',{action:'acknowledge',expectedRevision:context.revision,throughSeq:3})
  assert.equal((await read()).sync.status,'synced')

  const history: UAEvent[] = [{ ...event, type: 'agent_message', payload: { text: '上一轮回复' } }, { ...event, seq: 2, payload: { text: '新一轮输入' } }]
  const orchestrator = Object.assign(Object.create(Orchestrator.prototype), { sessions: new Map([['leader', { id: 'leader' }]]), events: new Map([['leader', history]]) }) as Orchestrator
  assert.equal(orchestrator.latestAgentMessageText('leader'), '上一轮回复', 'other callers retain latest-message behavior')
  assert.equal(orchestrator.currentTurnAgentMessageText('leader', 10), '', 'a turn with no output must not inherit old replies')
  history.push({ ...event, seq: 3, type: 'agent_message', payload: { text: '本轮回复' } })
  history.push({ ...event, seq: 4, type: 'system_notice', payload: { kind: 'team_event', text: '补充' } })
  assert.equal(orchestrator.currentTurnAgentMessageText('leader', 10), '本轮回复', 'steer must not reset the turn boundary')
  history.push({ ...event, seq: 5, type: 'user_message', payload: { text: '普通会话运行中补充' } })
  history.push({ ...event, seq: 6, type: 'turn_completed', state: 'cancelled' })
  assert.equal(orchestrator.currentTurnAgentMessageText('leader', 6), '本轮回复', 'ordinary steer keeps earlier output from the same turn')
  history.push({ ...event, seq: 7, type: 'user_message', payload: { text: '下一轮' } })
  history.push({ ...event, seq: 8, type: 'turn_completed', state: 'failed' })
  assert.equal(orchestrator.currentTurnAgentMessageText('leader', 8), '', 'failure before turn_started cannot reuse the prior reply')
  console.log('PASS team requirement provenance, attachments and failed-turn recovery')
} finally {
  rmSync(home, { recursive: true, force: true })
}
