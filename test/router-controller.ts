import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {RouterDatabase} from '../src/main/router/database'
import {RouterController} from '../src/main/router/controller'
import {routerMcpServers,projectMemoryMcpEnv} from '../src/main/router/mcp'
import {routerTargetVersion} from '../src/main/router/target'
import {DEFAULT_ROUTER_CONFIG, ROUTER_SYSTEM_PROMPT, routerRole, type RouterRequest} from '../src/shared/router'
import type {RouterStore} from '../src/main/router/store'
import type {AgentDef,Session,UAEvent} from '../src/shared/types'
import {readRouterTarget} from './fixtures/router-reading'

const root=await mkdtemp(join(tmpdir(),'ua-router-controller-')),db=new RouterDatabase(join(root,'router.sqlite'))
let beforeReview: (() => Promise<void>) | undefined
const store=new Proxy({} as RouterStore,{get(_,key:string){return async(...args:unknown[])=>{if(key==='reviewBegin')await beforeReview?.();return (db[key as keyof RouterDatabase] as Function).apply(db,args)}}})
let config={...DEFAULT_ROUTER_CONFIG,enabled:true},sends=0,accepted=0,newTasks=0
const target:Session={id:'task-images',title:'图片漏显',config:{agentId:'codex',model:'gpt',projectId:'ua',workdir:root},status:'running',createdAt:1}
const sessions=new Map([[target.id,target]]),events=new Map<string,UAEvent[]>()
const agent={id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:config.model,label:'Flash',efforts:['max']}],capabilities:{auxiliarySystemPrompt:true,protocol:'web'}} as AgentDef
let beforeObjects: (()=>Promise<void>) | undefined
const deliveryOrder: string[] = []
const createdInputs: RouterRequest[] = []
const routerMessages: unknown[][] = [], acceptedInputs: unknown[][] = []
let beforeDelivery: (() => Promise<void>) | undefined
const objects=async()=>{const rows=[{id:'ua',kind:'space' as const,title:'UniAgent',summary:'应用',projectId:'ua',version:'1'},
  {id:target.id,kind:'task' as const,title:target.title,summary:'修复历史图片漏显',projectId:'ua',version:routerTargetVersion(target),busy:true,execution:target.config,lastBusinessUpdatedAt:Date.now(),
    sources:[{ref:'input:images',title:'原任务方案',text:'继续定位退出重启后历史图片漏显，保留原有图片存储方案。',at:1}]}];await beforeObjects?.();return rows}
const orchestrator={getSessionById:(id:string)=>sessions.get(id),managedSessions:()=>[...sessions.values()],getEvents:async(id:string)=>events.get(id)||[],
  createRouterDraft:(value:Session['config'],id:string)=>{if(!sessions.has(id))sessions.set(id,{id,title:'RouterAgent',config:value,status:'draft',createdAt:1});return sessions.get(id)!},
  updateSessionConfig:(id:string,patch:Partial<Session['config']>)=>{Object.assign(sessions.get(id)!.config,patch);return sessions.get(id)!},
  sendMessage:async(id:string,...args:unknown[])=>{routerMessages.push([id,...args]);sends++;sessions.get(id)!.status='running'},acceptRoutedInput:async(...args:unknown[])=>{acceptedInputs.push(args);deliveryOrder.push('accept:'+args[5]);accepted++;return {status:'queued' as const}},
  appendSystemNotice:()=>{},interrupt:()=>{}}
const controller=new RouterController(store,{agents:()=>[agent],config:()=>config,saveConfig:next=>{config=next},orchestrator:orchestrator as any,objects,projectMemory:async(_id:string,args:any)=>args.action==='read'?{items:[] as unknown[]}:[],
  beforeDispatch:async(request,session)=>{assert.equal(session.id,target.id);deliveryOrder.push('prepare');if(request.feishu)assert.equal(request.feishu.botAppId,'fixture-bot');await beforeDelivery?.()},
  newTask:async(request)=>{createdInputs.push(request);newTasks++;return target},recoverTask:async()=>undefined,changed:()=>{},error:()=>{}},root)
async function waitFor(check:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('router_timeout')}
async function call(name:string,args:unknown){const id=(await controller.snapshot()).sessionId!,server=routerMcpServers(id)![0],env=Object.fromEntries(server.env.map(row=>[row.name,row.value]));return (await fetch(env.UNIAGENT_ROUTER_ENDPOINT,{method:'POST',headers:{authorization:'Bearer '+env.UNIAGENT_ROUTER_TOKEN},body:JSON.stringify({name,arguments:args})})).json()}
async function end(){const id=(await controller.snapshot()).sessionId!;sessions.get(id)!.status='idle';await controller.event({sessionId:id,seq:sends,ts:1,type:'turn_completed',state:'success',payload:{}})}
try{
  await controller.recover()
  const id=randomUUID(),input={requestId:id,prompt:'继续修复历史图片漏显',feishu:{botAppId:'fixture-bot',chatId:'fixture-chat',rootMessageId:'fixture-root',cardMessageId:'fixture-card'}}
  await controller.submit(input)
  await waitFor(async()=>db.request(id)?.state==='routing')
  await waitFor(async()=>routerMessages.length===1)
  const systemPrompt=routerRole(sessions.get((await controller.snapshot()).sessionId!)!.config)!.instructions
  assert.equal(systemPrompt, ROUTER_SYSTEM_PROMPT, 'the actual Router role receives the current routing instructions')
  assert.equal((routerMessages[0][5] as { displayText: string }).displayText, input.prompt, 'the shortened protocol message preserves the original business input')
  const sentContext=JSON.parse((routerMessages[0][1] as string).split('本轮路由请求：\n')[1])
  assert.equal(sentContext.requestId,id,'the model-facing data binds this input to its own request, even in a reused native Session')
  assert.deepEqual(sentContext.hardScope,{kind:'global'},'the current explicit scope accompanies the input, not a previous execution config')
  assert.equal(sentContext.input,input.prompt)
  assert.equal(sentContext.inputSource,'new_input','a screenshot of an old question is still new business input')
  assert.deepEqual(sentContext.clarificationHistory,[],'no clarification from a previous request is inherited')
  assert.equal(sentContext.version,db.request(id)!.version,'the host provides the current request version without a bootstrap gate')
  assert.equal(typeof sentContext.catalogRevision,'string')
  assert.equal(typeof sentContext.asOf,'number')
  assert.deepEqual(sentContext.attachments,[])
  await controller.submit(input)
  assert.equal(sends,1)
  assert.equal((await controller.snapshot()).activeRequestId,id,'snapshot identifies the input occupying the Router turn')
  db.update(id,db.request(id)!.version,{resolution:'放到 UniAgent 空间',supplements:[{text:'放到 UniAgent 空间',attachments:[{kind:'image',path:'/fixture/routing.png',name:'routing.png'}]}]})
  const query=await readRouterTarget(call,id,{kind:'space',projectId:'ua'},target.id)
  let releaseDelivery!: () => void, deliveryEntered = false
  beforeDelivery = () => { deliveryEntered = true; return new Promise<void>(resolve => { releaseDelivery = resolve }) }
  const pendingAssignment=call('router_assign_task',{requestId:id,version:query.value.version,action:'reuse_task',taskId:target.id,reason:'同目标',...query.assignment, reuseAssessment:query.assessment})
  await waitFor(async()=>deliveryEntered)
  assert.equal(accepted,0,'native delivery waits for the topic/result barrier')
  releaseDelivery();beforeDelivery=undefined
  let result=await pendingAssignment
  assert.deepEqual(deliveryOrder,['prepare','accept:feishu'],'the topic/result barrier runs before native delivery with the real input channel')
  assert.deepEqual(db.request(id)!.feishu,input.feishu,'Feishu origin is persisted in the existing request JSON')
  assert.equal(result.value.delivery,'queued');assert.equal(result.value.project,'UniAgent');assert.equal(accepted,1)
  assert.equal(acceptedInputs[0][2],input.prompt,'reuse receives the original business request without routing answers')
  assert.equal(acceptedInputs[0][3],undefined,'routing attachments do not leak into the reused task')
  result=await call('router_assign_task',{requestId:id,version:query.value.version,action:'reuse_task',taskId:target.id,reason:'同目标',...query.assignment, reuseAssessment:query.assessment})
  assert.equal(result.ok,true);assert.equal(accepted,1)
  const duplicateChange=await call('router_assign_task',{requestId:id,version:query.value.version,action:'create_task_in_space',projectId:'ua',reason:'改分配'})
  assert.equal(duplicateChange.ok,false);assert.equal(newTasks,0)
  await end()
  assert.equal((await controller.snapshot()).activeRequestId,undefined,'completed Router turn releases its input')
  const review = await controller.reviewDetail(id, undefined, true)
  assert.ok(review.trace!.steps.some(step => step.kind === 'query' && (step.data as any).result.items?.some((row: any) => row.id === target.id)), 'actual MCP context is captured')
  const routingVersion = db.request(id)!.version, actionsBeforeFeedback = sends + accepted + newTasks
  const feedback = await controller.saveReview({ requestId: id, attemptId: review.attemptId, expectedRevision: review.revision, matches: false, expected: { kind: 'reuse_task', projectId: 'ua', taskId: target.id } })
  assert.equal(feedback.feedback!.expected!.taskTitle, target.title)
  assert.equal(db.request(id)!.version, routingVersion)
  assert.equal(sends + accepted + newTasks, actionsBeforeFeedback, 'feedback never dispatches a task')
  assert.equal((await controller.snapshot()).feedbackPrompts!.length, 0)
  const originalConfig=structuredClone(target.config)
  const conflict=randomUUID();await controller.submit({requestId:conflict,prompt:'继续图片漏显',execution:{agentId:'deepseek',model:config.model,modelSource:{kind:'local',sourceId:'other'},zcodeModelSelection:{providerId:'local',modelId:'other'},effort:'max',permissionMode:'full-access',projectId:'other',workdir:join(root,'other'),workspaceSelection:{mode:'worktree'}}})
  await waitFor(async()=>db.request(conflict)?.state==='routing')
  const q2=await readRouterTarget(call,conflict,{kind:'space',projectId:'ua'},target.id)
  const r2=await call('router_assign_task',{requestId:conflict,version:q2.value.version,action:'reuse_task',taskId:target.id,reason:'同目标但配置不同',...q2.assignment, reuseAssessment:q2.assessment})
  assert.equal(r2.value.state,'bound');assert.equal(r2.value.delivery,'queued');assert.equal(r2.value.taskId,target.id)
  assert.equal(r2.value.question,undefined);assert.equal(accepted,2);assert.equal(newTasks,0)
  assert.deepEqual(target.config,originalConfig,'reuse retains the original execution configuration and directory')
  const duplicate=await call('router_assign_task',{requestId:conflict,version:q2.value.version,action:'reuse_task',taskId:target.id,reason:'同目标但配置不同',...q2.assignment, reuseAssessment:q2.assessment})
  assert.equal(duplicate.ok,true);assert.equal(accepted,2,'retry does not deliver the same input twice');await end()
  const changedWhileWaiting = randomUUID()
  await controller.submit({requestId:changedWhileWaiting,prompt:'继续图片漏显',execution:{agentId:'deepseek',model:config.model,workdir:root}})
  await waitFor(async()=>db.request(changedWhileWaiting)?.state==='routing')
  const q3=await readRouterTarget(call,changedWhileWaiting,{kind:'space',projectId:'ua'},target.id)
  db.update(changedWhileWaiting,db.request(changedWhileWaiting)!.version,{state:'needs_input',decision:{action:'reuse_task',taskId:target.id,reason:'继续原问题',...q3.assignment, reuseAssessment:q3.assessment},targetId:target.id,question:'本次执行配置与原任务不同。按原任务配置继续，还是按本次配置新建？'})
  await end()
  target.config.effort='high'
  const stale=db.request(changedWhileWaiting)!
  const resumed=await controller.resolve({requestId:changedWhileWaiting,expectedVersion:stale.version,action:'continue_original'})
  assert.equal(resumed.state,'bound');assert.equal(resumed.delivery,'queued')
  assert.equal(accepted,3,'resuming does not require re-reading stale evidence')
  assert.equal(acceptedInputs[2][4],routerTargetVersion(target),'delivery still checks the current target execution version')
  await end()
  const clarificationId=randomUUID(),clarificationInput={requestId:clarificationId,prompt:'继续修复图片',attachments:[{kind:'file' as const,path:join(root,'details.md'),name:'details.md'}],execution:{agentId:'codex',model:'gpt',workdir:root}}
  await controller.submit(clarificationInput)
  await waitFor(async()=>db.request(clarificationId)?.state==='routing')
  for (const [question,answer] of [['属于哪个空间？','UniAgent 空间'],['属于哪个需求？','uniagent日常迭代']] as const) {
    const row=db.request(clarificationId)!
    const pending=await call('router_assign_task',{requestId:clarificationId,version:row.version,action:'clarify',reason:'需要用户补充',clarification:question,clarificationOptions:[{label:answer}]})
    assert.equal(pending.ok,true,JSON.stringify(pending))
    assert.equal(pending.value.state,'needs_input')
    const others=answer==='UniAgent 空间'?[randomUUID(),randomUUID()]:[]
    for (const requestId of others) await controller.submit({requestId,prompt:'独立的其他任务'})
    await end()
    if(others.length) {
      await waitFor(async()=>db.request(others[0])?.state==='routing')
      assert.equal(db.request(clarificationId)!.state,'needs_input','waiting for clarification does not block another assignment')
    }
    await controller.resolve({requestId:clarificationId,expectedVersion:db.request(clarificationId)!.version,action:'answer',answer,
      ...(answer==='UniAgent 空间'?{attachments:[{kind:'image' as const,path:'/fixture/clarification.png',name:'clarification.png'}]}:{})})
    if(others.length) {
      assert.deepEqual(db.pending().filter(row=>row.state==='queued').map(row=>row.requestId),[others[1],clarificationId],
        'clarification joins the queue behind the existing waiting input')
      for (const requestId of others) {
        await waitFor(async()=>db.request(requestId)?.state==='routing')
        await call('router_assign_task',{requestId,version:db.request(requestId)!.version,action:'clarify',reason:'保持夹具等待',clarification:'等待补充',clarificationOptions:[{label:'继续原任务'}]})
        await end()
        await controller.cancel(requestId,db.request(requestId)!.version)
      }
    }
    await waitFor(async()=>db.request(clarificationId)?.state==='routing')
  }
  const clarified=db.request(clarificationId)!
  assert.match(clarified.resolution!,/UniAgent 空间/,'later clarification must retain the earlier scope answer')
  assert.match(clarified.resolution!,/uniagent日常迭代/)
  assert.equal(clarified.prompt,clarificationInput.prompt)
  assert.deepEqual(clarified.attachments,clarificationInput.attachments)
  assert.deepEqual(clarified.execution,clarificationInput.execution)
  for (let i = 0; i < 100 && !String(routerMessages.at(-1)?.[1] || '').includes('uniagent日常迭代'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  const routingData=JSON.parse(String(routerMessages.at(-1)![1]).split('本轮路由请求：\n')[1])
  assert.match(routingData.clarification,/UniAgent 空间[\s\S]*uniagent日常迭代/,'routed continuation reads both answers under the original request')
  assert.deepEqual(routingData.clarificationHistory.map((row:any)=>[row.question,row.text]),[['属于哪个空间？','UniAgent 空间'],['属于哪个需求？','uniagent日常迭代']])
  assert.equal(routingData.input,clarificationInput.prompt)
  assert.equal(routingData.inputSource,'clarification_reply','only a stored answer under this request is a clarification reply')
  assert.equal(routingData.requestId,clarificationId)
  assert.deepEqual(routingData.clarificationHistory.map((row:any)=>[row.question,row.text]),[['属于哪个空间？','UniAgent 空间'],['属于哪个需求？','uniagent日常迭代']],
    'the next Router turn directly receives paired questions and answers')
  assert.equal((routerMessages.at(-1)![2] as any[]).length,2,'Router can still see the original and clarification attachments')
  const createQuery=await readRouterTarget(call,clarificationId,{kind:'space',projectId:'ua'},target.id)
  const created=await call('router_assign_task',{requestId:clarificationId,version:createQuery.value.version,action:'create_task_in_space',projectId:'ua',reason:'独立的新目标',...createQuery.assignment})
  assert.equal(created.ok,true,JSON.stringify(created))
  assert.equal(created.value.state,'bound')
  assert.equal(createdInputs.length,1)
  assert.equal(createdInputs[0].requestId,clarificationId)
  assert.equal(createdInputs[0].prompt,clarificationInput.prompt,'new task receives the original business input without routing answers')
  assert.deepEqual(createdInputs[0].attachments,clarificationInput.attachments)
  assert.deepEqual(createdInputs[0].execution,clarificationInput.execution)
  await end()
  let reviewStarted = false, releaseReview!: () => void
  const blocked = new Promise<void>(resolve => { releaseReview = resolve })
  beforeReview = async () => { reviewStarted = true; await blocked }
  const cancelled = randomUUID(), sendsBeforeCancel = sends
  await controller.submit({ requestId: cancelled, prompt: '日志准备期间取消' })
  await waitFor(async () => reviewStarted)
  await controller.cancel(cancelled, db.request(cancelled)!.version)
  releaseReview(); beforeReview = undefined
  await waitFor(async () => !!(await controller.reviewDetail(cancelled)).attempts.at(-1)?.endedAt)
  assert.equal(db.request(cancelled)!.state, 'cancelled')
  assert.equal(sends, sendsBeforeCancel, 'cancel during diagnostic preparation does not send a Router turn')
  assert.ok(!(await controller.snapshot()).feedbackPrompts!.some(row => row.requestId === cancelled), 'cancelled queued input does not show an unsolicited feedback prompt')
  const failedInput = db.register({ requestId: randomUUID(), prompt: '保留失败诊断，移除看板记录' }, config)
  const failedRequest = db.update(failedInput.requestId, failedInput.version, { state: 'failed', error: '原始路由错误' })
  await assert.rejects(controller.cancel(failedRequest.requestId, failedInput.version), /不能取消/)
  assert.equal(db.request(failedRequest.requestId)!.state, 'failed', 'stale deletion leaves the failed request intact')
  await controller.cancel(failedRequest.requestId, failedRequest.version)
  const removed = db.request(failedRequest.requestId)!
  assert.equal(removed.state, 'cancelled')
  assert.equal(removed.error, '原始路由错误'); assert.equal(removed.prompt, failedInput.prompt)
  assert.deepEqual((await controller.reviewDetail(removed.requestId)).request, removed, 'deleted placeholder retains its diagnostic detail')
  await assert.rejects(controller.cancel(removed.requestId, removed.version), /不能取消/)
  for (const state of ['routing', 'committing', 'bound'] as const) {
    const input = db.register({ requestId: randomUUID(), prompt: '不可取消：' + state }, config)
    const request = db.update(input.requestId, input.version, { state })
    await assert.rejects(controller.cancel(request.requestId, request.version), /不能取消/)
    assert.equal(db.request(request.requestId)!.state, state)
    db.update(request.requestId, request.version, { state: 'cancelled' })
  }
  events.set(target.id,[{sessionId:target.id,seq:0,ts:1,type:'user_message',state:'success',payload:{text:'请记住：我偏好中文。',source:'app'}}])
  const guide=await controller.projectContext(target.id,target.config)
  assert.match(guide,/project_memory/,'project memory remains available through the on-demand guide')
  assert.doesNotMatch(guide,/我偏好中文/,'dynamic memory contents are read through tools, never injected')
  const env=projectMemoryMcpEnv(target.id)
  assert.ok(env.UNIAGENT_PROJECT_MEMORY_TOKEN)
  assert.equal('UNIAGENT_GLOBAL_MEMORY_TOKEN' in env,false,'the removed global-memory capability is not exported')
  let refreshStarted=false,releaseRefresh!:()=>void,reads=0
  const refreshGate=new Promise<void>(resolve=>{releaseRefresh=resolve})
  beforeObjects=async()=>{reads++;if(reads===1){refreshStarted=true;await refreshGate}}
  const businessEvent:UAEvent={sessionId:target.id,seq:10,ts:Date.now(),type:'user_message',payload:{text:'继续原问题'}}
  await controller.event(businessEvent)
  await waitFor(async()=>refreshStarted)
  target.config.effort='medium'
  await controller.event({...businessEvent,seq:11})
  assert.equal(reads,1,'concurrent refresh waits for the in-flight source read')
  releaseRefresh()
  await waitFor(async()=>db.object(target.id).version===routerTargetVersion(target))
  assert.equal(reads,2,'a business change arriving mid-read refreshes once more')
  beforeObjects=undefined
  const oldInput = db.register({ requestId: randomUUID(), prompt: '长时间等待归属确认' }, config)
  const oldPending = db.update(oldInput.requestId, oldInput.version, { state: 'needs_input', decision: { action: 'clarify', reason: '需要归属', clarification: '属于哪个需求？' }, question: '属于哪个需求？' })
  for (let i = 0; i < 200; i++) {
    const input = db.register({ requestId: randomUUID(), prompt: '后续已结束请求 ' + i }, config)
    db.update(input.requestId, input.version, { state: 'cancelled' })
  }
  assert.ok(!db.requests().some(row => row.requestId === oldPending.requestId), 'fixture exceeds the recent request window')
  const snapshot = await controller.snapshot()
  assert.deepEqual(snapshot.requests.filter(row => row.requestId === oldPending.requestId), [db.request(oldPending.requestId)], 'pending confirmations remain available beyond the recent request window')
  assert.equal(new Set(snapshot.requests.map(row => row.requestId)).size, snapshot.requests.length, 'pending and recent requests are not duplicated')
  console.log('Router controller: fixed session, unique assignment, busy queue, original configuration reuse and memory source/scope passed')
}finally{await controller.close()}
