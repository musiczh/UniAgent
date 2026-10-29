import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { BetaSideRunner } from '../src/main/betaSideRunner.ts'
import { ACPTimeoutError } from '../src/main/acp/acpConnection.ts'
import type { AgentDef, Session, UAEvent } from '../src/shared/types.ts'

const root=await realpath(await mkdtemp(join(tmpdir(),'uniagent-beta-side-orchestrator-')))
const originalStart=BetaSideRunner.prototype.startTurn
const originalDispose=BetaSideRunner.prototype.disposeFork
const originalFork=BetaSideRunner.prototype.forkPersistent
const originalSteer=BetaSideRunner.prototype.steer
const originalCompact=BetaSideRunner.prototype.compact
const originalUpdate=BetaSideRunner.prototype.updateConfig
const originalRetain=BetaSideRunner.prototype.retainThread
const retained:string[]=[]
let updateCalls=0
let timeoutSteer=false
let followupSteer=false
const starts:string[]=[]
const orchestrators:Orchestrator[]=[]
try {
  BetaSideRunner.prototype.startTurn=async function(prompt) { starts.push(prompt); this.emit('nativeThreadReady','side-native') }
  BetaSideRunner.prototype.disposeFork=function() {}
  BetaSideRunner.prototype.forkPersistent=async function() { return 'promoted-native' }
  BetaSideRunner.prototype.steer=async function() { if(followupSteer) return {appendedToTurn:false,nativePromptId:'accepted-followup'}; if(timeoutSteer) throw new ACPTimeoutError('lost receipt'); throw new Error('steer rejected') }
  BetaSideRunner.prototype.compact=async function() { this.emit('done',{}) }
  BetaSideRunner.prototype.updateConfig=function() { updateCalls++ }
  BetaSideRunner.prototype.retainThread=async function(id) { retained.push(id) }
  for (const provider of ['kimi','grok','deepseek'] as const) {
    starts.length=0
    const agent:AgentDef={id:provider,name:provider,adapter:provider,bin:'/usr/bin/false',icon:'',builtin:true,capabilities:{sideChat:true,modelSelect:true,reasoningEffort:false,permissionModes:[{id:'ask',label:'Ask',hint:''}]},models:[]}
    const store=new SessionStore(join(root,`${provider}.json`))
    const source:Session={id:`local-${provider}`,title:'source',config:{agentId:provider,workdir:root,permissionMode:'ask',kimiRuntimeOwnerId:'source-owner'},status:'idle',createdAt:1,nativeSessionId:'source-native',origin:'created'}
    store.saveOrThrow([source])
    const orchestrator=new Orchestrator(id=>id===provider?agent:undefined,store)
    orchestrators.push(orchestrator)
    await orchestrator.loadPersisted()
    const internal=orchestrator as any
    assert.equal(orchestrator.canOpenSideChat(source.id),true,`${provider} must open supported native Side`)
    await orchestrator.sendSideMessage(source.id,'first')
    await new Promise(resolve=>setImmediate(resolve))
    assert.deepEqual(starts,['first'])
    const side=internal.sideStreamers.get(source.id)
    assert.equal(side instanceof BetaSideRunner,true)
    assert.equal(internal.sideNativeSessionIds.get(source.id),'side-native')
    for (const [seq, ts, state] of [[700, 10000, 'running'], [701, 11000, 'running'], [702, 15500, 'success']] as const) {
      side.emit('event', { sessionId: source.id, seq, ts, type: 'context_compaction', state, payload: { id: 'side-compaction' } })
    }
    const compactions = orchestrator.getSideEvents(source.id).filter(event => event.type === 'context_compaction')
    assert.equal(compactions.length, 1, '侧边对话缓存只保留一个压缩生命周期快照')
    assert.equal(compactions[0].payload.startedAt, 10000, '侧边对话缓存保留第一次压缩开始时间')
    assert.equal(compactions[0].payload.durationMs, 5500, '侧边对话状态合并后仍保留压缩耗时')
    updateCalls=0
    side.emit('collaborationModeChanged','plan')
    assert.equal(orchestrator.getSideState(source.id).config.collaborationMode,'plan')
    assert.equal(updateCalls,0,'a native ACP mode notification must not send a config update back into the running turn')
    await assert.rejects(orchestrator.runSideNativeAction(source.id,{type:'goal.update',action:'pause'}),/侧边对话|原生 Goal/)
    await orchestrator.sendSideMessage(source.id,'queued',undefined,undefined,false,{comments:[{quote:'selected',comment:'question'}],displayText:'queued display'})
    await orchestrator.forceSendSideMessage(source.id,'force')
    assert.deepEqual(orchestrator.getSideState(source.id).queue.map(item=>item.prompt),['queued','force'])
    assert.equal(orchestrator.getSideEvents(source.id).filter(event=>event.type==='user_message').length,1,'queue fallback must not record an undelivered force-send bubble')
    const firstQueueId=orchestrator.getSideState(source.id).queue[0].id
    orchestrator.promoteSideMessage(source.id,firstQueueId)
    assert.equal(orchestrator.getSideState(source.id).queue.length,2,'failed/unsupported steer must retain the accepted queue item')
    await new Promise(resolve=>setImmediate(resolve))
    assert.deepEqual(store.loadSideChats()[0].queue?.map(item=>item.prompt),['queued','force'])
    assert.deepEqual(store.loadSideChats()[0].queue?.[0].comments,[{quote:'selected',comment:'question'}])
    assert.equal(store.loadSideChats()[0].events.find(event => event.payload?.id === 'side-compaction')?.payload.durationMs, 5500,
      '侧边对话持久化后保留压缩耗时')
    const restored=new Orchestrator(id=>id===provider?agent:undefined,store)
    orchestrators.push(restored)
    await restored.loadPersisted()
    assert.deepEqual(restored.getSideState(source.id).queue.map(item=>item.prompt),['queued','force'])
    assert.equal(restored.getSideStatus(source.id),'idle','restored pending Side work must wait for explicit resumption')
    side.emit('done',{})
    assert.deepEqual(starts,['first','queued'])
    side.emit('done',{})
    assert.deepEqual(starts,['first','queued','force'])
    side.emit('done',{})
    assert.equal(orchestrator.getSideStatus(source.id),'idle')
    assert.deepEqual(store.loadSideChats()[0].queue,[],'dispatched work must never be replayed from cache')
    if(provider==='deepseek') {
      await orchestrator.sendSideMessage(source.id,'new-active')
      timeoutSteer=true
      await orchestrator.forceSendSideMessage(source.id,'ambiguous-steer')
      timeoutSteer=false
      const uncertain=orchestrator.getSideState(source.id).queue[0]
      assert.equal(uncertain.deliveryUncertain,true,'a timed out native steer must never be automatically resent')
      side.emit('done',{})
      assert.equal(starts.includes('ambiguous-steer'),false)
      assert.equal(store.loadSideChats()[0].queue?.[0].deliveryUncertain,true)
      orchestrator.dequeueSideMessage(source.id,uncertain.id)
    }
    await orchestrator.compactSideChat(source.id)
    assert.equal(orchestrator.getSideStatus(source.id),'idle')
    const originalRespond = side.respond
    let acknowledge!: () => void
    side.respond = () => new Promise(resolve => { acknowledge = () => resolve({handled:true,hasPendingRequests:false}) })
    internal.setSideStatus(source.id,'awaiting-approval')
    side.emit('event', { sessionId: source.id, seq: 999, ts: Date.now(), type: 'approval_request', state: 'pending', payload: { requestId: 'async-answer', kind: 'question' } })
    const answering = orchestrator.respondSideRequest(source.id,'async-answer',{})
    side.emit('done',{})
    acknowledge()
    await answering
    assert.equal(orchestrator.getSideStatus(source.id),'idle','native completion before answer acknowledgement must keep Side idle')
    side.respond = originalRespond
    for (const status of ['running', 'idle', 'awaiting-approval'] as const) {
      internal.setSideStatus(source.id, status)
      if (status === 'awaiting-approval') side.emit('event', { sessionId: source.id, seq: 1002, ts: Date.now(), type: 'approval_request', state: 'pending', payload: { requestId: 'native-blocker', kind: 'command' } })
      const id = `skip-${status}`
      const question: UAEvent = { sessionId: source.id, seq: 1000, ts: Date.now(), type: 'agent_message', state: 'success', payload: {
        id, delivery: 'async', questions: [{ id: 'scope', question: '是否继续？', options: ['继续'] }],
      } }
      side.emit('event', question)
      side.emit('event', { ...question, seq: 1001, payload: { ...question.payload, id: `other-${status}` } })
      const beforeSkip = orchestrator.getSideEvents(source.id).filter(event => event.type === 'user_message' || event.type === 'turn_started')
      const startCount = starts.length
      const steer = side.steer
      let skipSteers = 0
      side.steer = async () => { skipSteers++; throw new Error('跳过不应发送消息') }
      try {
        const result = await orchestrator.respondSideRequest(source.id, `async-question:${id}`, { action: 'skip' })
        assert.equal(result.handled, true)
        assert.equal(result.hasPendingRequests, status === 'awaiting-approval', '跳过不解除其它审批的等待状态')
        assert.deepEqual(orchestrator.getSideEvents(source.id).findLast(event => event.payload.id === id)?.payload.submittedAnswer, { action: 'skip' })
        assert.equal(orchestrator.getSideEvents(source.id).findLast(event => event.payload.id === `other-${status}`)?.payload.submittedAnswer, undefined)
        assert.deepEqual(orchestrator.getSideEvents(source.id).filter(event => event.type === 'user_message' || event.type === 'turn_started'), beforeSkip, '侧边跳过不新增消息或回合')
        assert.equal(starts.length, startCount, '空闲侧边跳过不启动新回合')
        assert.equal(skipSteers, 0, '运行中侧边跳过不发送消息')
        assert.equal(orchestrator.getSideStatus(source.id), status)
        if (status === 'awaiting-approval') assert.equal(orchestrator.getSideEvents(source.id).findLast(event => event.payload.requestId === 'native-blocker')?.state, 'pending')
        assert.deepEqual(orchestrator.getSideState(source.id).queue, [])
        assert.deepEqual(store.loadSideChats()[0].events.findLast(event => event.payload.id === id)?.payload.submittedAnswer, { action: 'skip' }, '侧边跳过结果持久化')
        await assert.rejects(orchestrator.respondSideRequest(source.id, `async-question:${id}`, { action: 'skip' }), /已处理/)
        side.emit('event', question)
        assert.deepEqual(orchestrator.getSideEvents(source.id).findLast(event => event.payload.id === id)?.payload.submittedAnswer, { action: 'skip' })
      } finally { side.steer = steer }
    }
    side.respond = () => ({ handled: true, hasPendingRequests: false })
    try { await orchestrator.respondSideRequest(source.id, 'native-blocker', { decision: 'denied' }) }
    finally { side.respond = originalRespond }
    internal.setSideStatus(source.id, 'idle')
    if(provider==='deepseek') {
      await orchestrator.sendSideMessage(source.id,'before-followup')
      followupSteer=true
      await orchestrator.forceSendSideMessage(source.id,'accepted-new-turn')
      followupSteer=false
      const followup = orchestrator.getSideEvents(source.id).findLast(event=>event.type==='user_message')!
      assert.equal(followup.payload.appendedToTurn,false)
      assert.equal(followup.payload.nativePromptId,'accepted-followup')
      assert.equal(orchestrator.getSideState(source.id).queue.length,0,'an acknowledged native follow-up must never be enqueued again')
      side.emit('done',{})
      await orchestrator.sendSideMessage(source.id,'old-turn-for-promote')
      await orchestrator.sendSideMessage(source.id,'promote-across-completion')
      const queuedId = orchestrator.getSideState(source.id).queue[0].id
      let deliver!: () => void
      side.steer = () => new Promise(resolve => { deliver = () => resolve({appendedToTurn:false,nativePromptId:'promoted-followup'}) })
      const startCount = starts.length
      orchestrator.promoteSideMessage(source.id,queuedId)
      orchestrator.promoteSideMessage(source.id,queuedId)
      side.emit('done',{})
      assert.equal(starts.length,startCount,'completion must not dispatch a Side message whose native steer is pending')
      deliver()
      await new Promise(resolve=>setImmediate(resolve))
      assert.equal(orchestrator.getSideState(source.id).queue.length,0)
      assert.equal(orchestrator.getSideEvents(source.id).filter(event=>event.type==='user_message'&&event.payload.text==='promote-across-completion').length,1)
      await orchestrator.sendSideMessage(source.id,'old-turn-with-backlog')
      await orchestrator.sendSideMessage(source.id,'late-appended-steer')
      await orchestrator.sendSideMessage(source.id,'backlog-after-steer')
      const appendedId = orchestrator.getSideState(source.id).queue[0].id
      side.steer = () => new Promise(resolve => { deliver = () => resolve({appendedToTurn:true}) })
      const backlogStartCount = starts.length
      orchestrator.promoteSideMessage(source.id,appendedId)
      side.emit('done',{})
      assert.equal(starts.length,backlogStartCount)
      deliver()
      await new Promise(resolve=>setImmediate(resolve))
      assert.equal(starts.at(-1),'backlog-after-steer','late acknowledgement for a completed turn must wake the next Side item')
      assert.equal(starts.filter(prompt=>prompt==='backlog-after-steer').length,1)
      assert.equal(starts.includes('late-appended-steer'),false,'acknowledged steer must never become a second prompt')
      assert.equal(orchestrator.getSideState(source.id).queue.length,0)
      side.emit('done',{})
      await orchestrator.sendSideMessage(source.id,'old-turn-with-edit')
      await orchestrator.sendSideMessage(source.id,'steer-before-edit')
      await orchestrator.sendSideMessage(source.id,'editing-backlog')
      const editingQueue = orchestrator.getSideState(source.id).queue
      side.steer = () => new Promise(resolve => { deliver = () => resolve({appendedToTurn:true}) })
      orchestrator.promoteSideMessage(source.id,editingQueue[0].id)
      orchestrator.setSideQueueEditing(source.id,editingQueue[1].id)
      side.emit('done',{})
      deliver()
      await new Promise(resolve=>setImmediate(resolve))
      assert.equal(starts.includes('editing-backlog'),false,'late steer acknowledgement must preserve the Side editing lock')
      orchestrator.setSideQueueEditing(source.id,null)
      assert.equal(starts.filter(prompt=>prompt==='editing-backlog').length,1)
      side.emit('done',{})
      await orchestrator.sendSideMessage(source.id,'old-turn-with-two-steers')
      for(const prompt of ['native-followup-a','native-steer-b','native-backlog-c']) await orchestrator.sendSideMessage(source.id,prompt)
      const nativeQueue=orchestrator.getSideState(source.id).queue
      const receipts:Array<(value:any)=>void>=[]
      side.steer=()=>new Promise(resolve=>receipts.push(resolve))
      orchestrator.promoteSideMessage(source.id,nativeQueue[0].id)
      orchestrator.promoteSideMessage(source.id,nativeQueue[1].id)
      side.emit('done',{})
      receipts[0]({appendedToTurn:false,nativePromptId:'active-followup'})
      await new Promise(resolve=>setImmediate(resolve))
      const originalRunning=side.isRunning
      side.isRunning=()=>true
      receipts[1]({appendedToTurn:true})
      await new Promise(resolve=>setImmediate(resolve))
      assert.equal(starts.includes('native-backlog-c'),false,'another late Side receipt cannot consume backlog during a native follow-up')
      side.isRunning=originalRunning
      side.emit('done',{})
      assert.equal(starts.filter(prompt=>prompt==='native-backlog-c').length,1)
      side.emit('done',{})
      side.steer = BetaSideRunner.prototype.steer
    }
    const before=structuredClone(orchestrator.getSideEvents(source.id))
    const promoted=await orchestrator.promoteSideToSession(source.id)
    assert.equal(retained.at(-1),'promoted-native','promotion transfers the new fork out of ephemeral ownership')
    assert.equal(promoted.nativeSessionId,'promoted-native')
    assert.equal(promoted.config.kimiRuntimeOwnerId,'source-owner')
    assert.deepEqual(orchestrator.getSessionById(source.id)?.nativeSessionId,'source-native')
    assert.equal(internal.sideEvents.has(source.id),false)
    assert.deepEqual(internal.events.get(promoted.id),before.map((event:UAEvent,seq:number)=>({...event,sessionId:promoted.id,seq})))
    if(provider==='deepseek') {
      const restoredPromotion=new Orchestrator(id=>id===provider?agent:undefined,store)
      orchestrators.push(restoredPromotion)
      await restoredPromotion.loadPersisted()
      assert.deepEqual(await restoredPromotion.getEvents(promoted.id),JSON.parse(JSON.stringify(internal.events.get(promoted.id))),'DeepSeek promoted Side transcript must survive App restart')
    }
  }
  const recoveryStore=new SessionStore(join(root,'recovery.json'))
  recoveryStore.saveSideChats([{sessionId:'recover',config:{agentId:'kimi',workdir:root,kimiRuntimeOwnerId:'owner'},events:[{sessionId:'recover',seq:1,ts:1,type:'approval_request',state:'pending',payload:{requestId:'expired'}}],queue:[{id:'unsent',prompt:'pending'}, {id:'uncertain',prompt:'receipt unknown',deliveryUncertain:true}, {id:'steering',prompt:'in-flight delivery',state:'steering'}]}])
  const recovered=recoveryStore.loadSideChats()[0]
  assert.equal(recovered.events[0].state,'cancelled','an approval from a previous ACP process must not remain actionable')
  assert.equal(recovered.events[0].payload.interactionExpired,true)
  assert.equal(recovered.config.kimiRuntimeOwnerId,'owner')
  assert.equal(recovered.queue?.[1].deliveryUncertain,true)
  assert.equal(recovered.queue?.[2].deliveryUncertain,true,'in-flight Side steering remains visible and cannot replay after restart')
} finally {
  orchestrators.forEach(orchestrator=>orchestrator.disposeAll())
  BetaSideRunner.prototype.startTurn=originalStart
  BetaSideRunner.prototype.disposeFork=originalDispose
  BetaSideRunner.prototype.forkPersistent=originalFork
  BetaSideRunner.prototype.steer=originalSteer
  BetaSideRunner.prototype.compact=originalCompact
  BetaSideRunner.prototype.updateConfig=originalUpdate
  BetaSideRunner.prototype.retainThread=originalRetain
  await rm(root,{recursive:true,force:true})
}
console.log('beta-side-orchestrator: beta gates, FIFO fallback, queue persistence, source isolation and promotion verified')
