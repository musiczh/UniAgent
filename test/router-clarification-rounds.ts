import assert from 'node:assert/strict'
import { RouterDatabase } from '../src/main/router/database'
import { join } from 'node:path'
import { routerFixture } from './fixtures/router-quality'
import type { RouterObject } from '../src/shared/router'
import { routerCardView, routerCardViews } from '../src/shared/routerClarification'
import { routerBusinessInput } from '../src/shared/router'

const objects: RouterObject[] = [
  { id: 'space', kind: 'space', title: 'uniagent', summary: '桌面客户端', version: '1', projectId: 'space' },
  { id: 'daily', kind: 'requirement', title: 'uniagent日常迭代', summary: '日常迭代', version: '1', projectId: 'space' },
  { id: 'archived', kind: 'requirement', title: 'qoder接入', summary: '归档需求', version: '1', projectId: 'space', archived: true }
]
const sent: string[] = []
const quickOptions=[{label:'把「开发者选项」移到 superAgent 配置页'},{label:'把黄框里的「按项目和需求组织侧栏」移到 superAgent 配置页',description:'仅移动黄框里的设置'}]
const f = await routerFixture(objects, { send: async (_id, prompt) => { sent.push(prompt) } })
async function wait(check: () => boolean) { for (let i=0;i<150;i++) { if(check())return; await new Promise(resolve=>setTimeout(resolve,10)) } throw Error('clarification round timeout') }
async function promptFor(id: string) { for (let i=0;i<150;i++) { const text=sent.at(-1); if(text?.includes('"requestId":"'+id+'"'))return JSON.parse(text.slice(text.indexOf('{'))); await new Promise(resolve=>setTimeout(resolve,10)) } throw Error('router prompt timeout') }
async function clarify(id: string) {
  return f.call('router_assign_task',{requestId:id,version:f.db.request(id)!.version,action:'clarify',reason:'截图中的两处标注有歧义',clarification:'这次希望移动哪个设置？',clarificationOptions:quickOptions})
}
try {
  const input={prompt:'把截图里的设置移到 superAgent 配置页',attachments:[{path:'/fixture/settings.png',name:'settings.png',kind:'image' as const}]}
  const id=await f.submit(input)
  const first=f.db.request(id)! as any
  assert.equal(typeof first.roundId,'string','a started Router turn has a durable round identity')
  const decision=await clarify(id)
  assert.equal(decision.ok,true,JSON.stringify(decision))
  assert.deepEqual(f.db.request(id)!.decision!.clarificationOptions,quickOptions,'plain text choices survive without object lookup or label rewriting')
  await f.end()
  const busy=await f.submit({prompt:'独立的其它任务'})
  const before=f.db.request(id)!, sentBefore=sent.length
  assert.equal(before.timing?.runningSince,undefined,'a clarification result stops the running measurement')
  const queued=await f.controller.resolve({requestId:id,expectedVersion:before.version,action:'answer',answer:quickOptions[1].label})
  assert.equal(queued.state,'queued')
  assert.equal(queued.roundId,undefined,'queued clarification does not represent a new sent round')
  assert.equal(sent.length,sentBefore,'another running assignment keeps this request in the queue')
  assert.equal(queued.clarifications!.length,1)
  const frozen=structuredClone(queued.clarifications![0])
  assert.equal(frozen.id,first.roundId)
  assert.equal(frozen.snapshot.question,before.question)
  assert.deepEqual(frozen.snapshot.timing,before.timing,'clarification freezes the exact timing in its snapshot')
  assert.equal(queued.timing!.startedAt,undefined,'answering resets timing until the next round starts')
  assert.equal(frozen.answer,quickOptions[1].label)
  assert.equal(queued.supplements!.at(-1)!.text,quickOptions[1].label)
  assert.equal(queued.supplements!.at(-1)!.optionId,undefined,'quick replies use the ordinary answer path')
  assert.equal(queued.targetId,undefined,'choosing a reply does not bind a target')
  assert.equal(f.journal.length,0,'choosing a reply creates or delivers no business task')
  assert.deepEqual(routerBusinessInput(queued),input,'business delivery still contains only the original input and attachments')
  await assert.rejects(f.controller.resolve({requestId:id,expectedVersion:before.version,action:'answer',optionId:'space'} as any),/revision/)
  const reopened=new RouterDatabase(join(f.directory,'router.sqlite'))
  try { assert.deepEqual((reopened.request(id) as any).clarifications,[frozen],'completed clarification survives restart') } finally { reopened.close() }
  await clarify(busy); await f.end()
  await wait(()=>f.db.request(id)?.state==='routing')
  const next=f.db.request(id)! as any
  const routing=await promptFor(id)
  assert.equal(routing.clarificationHistory.at(-1).text,quickOptions[1].label,'the next Router turn receives the selected text as a supplement')
  assert.equal(typeof next.timing.runningSince,'number','the next sent round starts its own timer')
  assert.notEqual(next.roundId,first.roundId,'dequeue starts a new display round under the same request')
  assert.deepEqual(next.clarifications,[frozen])
  await clarify(id); await f.end()
  const busyAgain=await f.submit({prompt:'第二轮等待期间的其它任务'})
  const clarifiedAgain=await f.controller.resolve({requestId:id,expectedVersion:f.db.request(id)!.version,action:'answer',answer:'归入日常迭代，仍然查看接入进展'})
  assert.equal(clarifiedAgain.clarifications?.length,2)
  const histories=structuredClone(clarifiedAgain.clarifications!)
  assert.deepEqual(histories[0],frozen)
  assert.deepEqual(routerCardViews(clarifiedAgain).map(view=>view.key),histories.map(round=>id+':'+round.id),'each completed round stays visible while queued, without a new active card')
  for(const [index,round] of histories.entries()){
    const event={sessionId:round.snapshot.routerSessionId!,seq:index,ts:round.answeredAt-1,type:'tool_call' as const,payload:{name:'router_assign_task',input:{requestId:id,version:round.snapshot.version-1}}}
    assert.equal(routerCardView(clarifiedAgain,event).clarification?.id,round.id,'native assignment versions select the matching frozen round')
  }
  await clarify(busyAgain); await f.end()
  await wait(()=>f.db.request(id)?.state==='routing')
  assert.equal(routerCardViews(f.db.request(id)!).length,3,'newly sent round is appended after both frozen cards')
  const assigned=await f.call('router_assign_task',{requestId:id,version:f.db.request(id)!.version,action:'create_task_in_requirement',requirementId:'daily',reason:'按用户明确归属处理'})
  assert.equal(assigned.value.state,'bound')
  assert.deepEqual(f.db.request(id)!.clarifications,histories,'later assignment does not alter either old question, candidates or answer')
  assert.equal(f.journal.at(-1)!.requestId,id,'business delivery retains the original request identity')
  await f.end()

  const stale=await f.submit({prompt:'另一次需要澄清的输入'})
  const legacyOptions=[{objectId:'daily',label:'原候选文字'},{objectId:'missing',label:'没有绑定对象的候选文字'}]
  const legacy=await f.call('router_assign_task',{requestId:stale,version:f.db.request(stale)!.version,action:'clarify',reason:'兼容已有卡片',clarification:'请选择补充信息',clarificationOptions:legacyOptions})
  assert.equal(legacy.ok,true)
  assert.deepEqual(f.db.request(stale)!.decision!.clarificationOptions,legacyOptions,'legacy option identifiers do not filter or rewrite text')
  await f.end()
  const pending=f.db.request(stale)!
  objects.find(row=>row.id==='daily')!.archived=true
  await assert.rejects(f.controller.resolve({requestId:stale,expectedVersion:pending.version,action:'answer',optionId:'invented'} as any),/候选/)
  objects.find(row=>row.id==='space')!.readOnly=true
  const resumed=await f.controller.resolve({requestId:stale,expectedVersion:pending.version,action:'answer',optionId:'daily'})
  assert.equal(resumed.clarifications![0].answer,'原候选文字','old card callbacks also only supplement text')
  await wait(()=>f.db.request(stale)?.state==='routing')
  const journalBefore=f.journal.length
  const rejected=await f.call('router_assign_task',{requestId:stale,version:f.db.request(stale)!.version,action:'create_task_in_requirement',requirementId:'daily',reason:'尝试分配归档目标'})
  assert.equal(rejected.ok,false)
  assert.equal(rejected.errorDetails.code,'task_not_eligible')
  assert.equal(f.db.request(stale)!.state,'routing','qualification failures leave Router able to offer choices instead of an empty host question')
  const clarifyUnavailable=await f.call('router_assign_task',{requestId:stale,version:f.db.request(stale)!.version,action:'clarify',reason:'目标已归档且项目只读',clarification:'希望如何处理原目标？',clarificationOptions:[{label:'恢复目标后继续'},{label:'另选可写项目新建需求'}]})
  assert.equal(clarifyUnavailable.value.state,'needs_input')
  assert.equal(f.db.request(stale)!.decision!.clarificationOptions!.length,2)
  assert.equal(f.db.request(stale)!.targetId,undefined)
  assert.equal(f.db.request(stale)!.delivery,'pending')
  assert.equal(f.journal.length,journalBefore)
  console.log('PASS Router clarification rounds: text-only choices, legacy replies, unchanged assignment guards, immutable cards, queued timing and original delivery input')
} finally { await f.close() }
