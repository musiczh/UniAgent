import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RouterDatabase } from '../src/main/router/database'
import { DEFAULT_ROUTER_CONFIG } from '../src/shared/router'

const root=await mkdtemp(join(tmpdir(),'ua-router-store-')),path=join(root,'router.sqlite')
let db=new RouterDatabase(path)
try {
  const id=db.sessionId(),requestId=randomUUID(),input={requestId,prompt:'继续修复重启后的历史图片',scope:{kind:'space' as const,projectId:'ua'}}
  const request=db.register(input,DEFAULT_ROUTER_CONFIG)
  assert.equal(request.state,'queued');assert.equal(db.register(input,DEFAULT_ROUTER_CONFIG).version,1)
  assert.throws(()=>db.register({...input,prompt:'不同输入'},DEFAULT_ROUTER_CONFIG),/相同输入/)
  assert.throws(()=>db.register({...input,requestId:'bad'},DEFAULT_ROUTER_CONFIG),/invalid_router/)
  const next=db.update(requestId,1,{state:'routing'})
  assert.equal(next.version,2);assert.throws(()=>db.update(requestId,1,{state:'failed'}),/revision_conflict/)
  await db.index([{id:'task-images',kind:'task',title:'历史图片恢复',summary:'重启后图片漏显',projectId:'ua',version:'1',lastBusinessUpdatedAt:Date.now()},
    {id:'task-other',kind:'task',title:'历史图片恢复',summary:'Android 图片',projectId:'android',version:'1',lastBusinessUpdatedAt:Date.now()},
    {id:'ua',kind:'space',title:'UniAgent',summary:'应用',version:'1',projectId:'ua'}])
  const catalog=await db.catalog(requestId,'space')
  assert.deepEqual(catalog.items.map(row=>row.id),['ua'])
  const context={objects:catalog.objects,memories:[],reading:{scannedTaskIds:[],details:[],catalogs:[{key:'requirement:ua',complete:true}]}}
  db.update(requestId,next.version,{context})
  assert.deepEqual((await db.taskBriefs(requestId,{kind:'space',projectId:'ua'})).items.map(row=>row.id),['task-images'])
  await db.index([...Array.from({length:150},(_,index)=>({id:'noise-'+index,kind:'task' as const,title:'历史图片恢复',summary:'图片漏显',projectId:'other',version:'1'})),
    {id:'ua',kind:'space',title:'UniAgent',summary:'应用',version:'1',projectId:'ua'},
    {id:'scoped-hit',kind:'task',title:'历史图片恢复',summary:'图片漏显',projectId:'ua',version:'1',lastBusinessUpdatedAt:Date.now()}])
  assert.equal((await db.taskBriefs(requestId,{kind:'space',projectId:'ua'})).items[0].id,'scoped-hit','other spaces cannot exhaust scoped reading')
  assert.throws(()=>db.object('task-images'),/object_not_found/,'complete refresh removes absent objects')
  const memory=db.writeMemory({id:'m1',content:'偏好中文',scope:{kind:'global'},status:'candidate',revision:0,source:{sessionId:'s1',seq:1,version:'v1'},updatedAt:0})
  assert.equal(db.memories().length,0);assert.equal(db.memories(undefined,true).length,1)
  db.writeMemory({...memory,status:'active'},memory.revision)
  assert.equal(db.memories().length,1);assert.throws(()=>db.writeMemory({...memory,status:'revoked'},1),/revision_conflict/)
  assert.throws(()=>db.writeMemory({...memory,id:'secret',content:'api_key=example'},0),/invalid_memory_content/)
  const current=db.memories()[0];db.writeMemory({...current,status:'revoked'},current.revision)
  assert.equal(db.memories().length,0)
  const image={kind:'image' as const,path:'/fixture/draft.png',name:'draft.png',mime:'image/png',previewDataUrl:'data:image/png;base64,preview'}
  db.draftImages('save',[image]);assert.deepEqual(db.draftImages('read'),[image])
  assert.throws(()=>db.draftImages('save',[{...image,kind:'file'}] as any),/invalid_router_draft/)
  assert.throws(()=>db.draftImages('save',[{...image,previewDataUrl:'file:///secret'}]),/invalid_router_draft/)
  db.close();db=new RouterDatabase(path)
  assert.deepEqual(db.draftImages('read'),[image],'image metadata and preview survive reopening the actual database')
  const added={...image,path:'/fixture/next.png',name:'next.png'}
  db.draftImages('append',[added]);assert.deepEqual(db.draftImages('read'),[image,added],'leaving before hydration appends new images without erasing the unread draft')
  db.draftImages('submitted',[image]);assert.deepEqual(db.draftImages('read'),[added],'accepting an old image preserves the next draft')
  db.draftImages('save',[]);assert.deepEqual(db.draftImages('read'),[])
  assert.equal(db.sessionId(),id);assert.equal(db.request(requestId)?.state,'routing')
  assert.equal(db.pending().length,1)
  const later=db.register({requestId:randomUUID(),prompt:'已经在等待的任务'},DEFAULT_ROUTER_CONFIG)
  const waiting=db.update(requestId,db.request(requestId)!.version,{state:'needs_input'})
  const requeued=db.update(requestId,waiting.version,{state:'queued'})
  assert.deepEqual(db.pending().filter(row=>row.state==='queued').map(row=>row.requestId),[later.requestId,requestId],
    'answering an older request places it after inputs already waiting')
  assert.equal(requeued.createdAt,request.createdAt,'requeue keeps the original creation time')
  db.close();db=new RouterDatabase(path)
  assert.deepEqual(db.pending().filter(row=>row.state==='queued').map(row=>row.requestId),[later.requestId,requestId],
    'queue order survives reopening the database')
  const originalNow=Date.now
  try {
    Date.now=()=>request.createdAt
    const first=db.register({requestId:randomUUID(),prompt:'同毫秒第一项'},DEFAULT_ROUTER_CONFIG)
    const second=db.register({requestId:randomUUID(),prompt:'同毫秒第二项'},DEFAULT_ROUTER_CONFIG)
    const active=db.update(first.requestId,first.version,{state:'needs_input'})
    const resumed=db.update(first.requestId,active.version,{state:'queued'})
    assert.deepEqual(db.pending().filter(row=>[first.requestId,second.requestId].includes(row.requestId)).map(row=>row.requestId),[second.requestId,first.requestId],
      'submissions and requeue in the same millisecond retain FIFO order even if the clock moves back')
    const refreshed=db.update(first.requestId,resumed.version,{resolution:'读取状态不重新入队'})
    assert.equal(refreshed.queuedAt,resumed.queuedAt,'ordinary updates do not move a waiting input')
  } finally { Date.now=originalNow }
  const timingClock=Date.now
  try {
    let now=1000;Date.now=()=>now
    const timed=db.register({requestId:randomUUID(),prompt:'分配计时'},DEFAULT_ROUTER_CONFIG)
    assert.equal(timed.timing?.queuedAt,1000,'timing uses real enqueue time rather than FIFO ordinal')
    now=13000
    const running=db.update(timed.requestId,timed.version,{state:'routing',roundStartedAt:now})
    assert.equal(running.timing?.startedAt,13000)
    now=21000
    const finished=db.update(timed.requestId,running.version,{state:'bound',delivery:'accepted'})
    assert.equal(finished.timing?.elapsedMs,8000)
    assert.equal(finished.timing?.runningSince,undefined)
    const frozen=structuredClone(finished.timing)
    now=50000
    const refreshed=db.update(timed.requestId,finished.version,{targetTitle:'后续刷新不改变时间'})
    assert.deepEqual(refreshed.timing,frozen)
    db.close();db=new RouterDatabase(path)
    assert.deepEqual(db.request(timed.requestId)?.timing,frozen,'finished timing survives database reopen')

    const paused=db.register({requestId:randomUUID(),prompt:'澄清与恢复计时'},DEFAULT_ROUTER_CONFIG)
    now=51000
    let current=db.update(paused.requestId,paused.version,{state:'routing'})
    now=53000
    current=db.update(paused.requestId,current.version,{state:'needs_input'})
    assert.equal(current.timing?.elapsedMs,2000)
    now=100000
    current=db.update(paused.requestId,current.version,{state:'routing'})
    now=101000
    current=db.update(paused.requestId,current.version,{state:'needs_input'})
    assert.equal(current.timing?.elapsedMs,3000,'user configuration wait is excluded when resuming the same round')
    now=110000
    current=db.update(paused.requestId,current.version,{state:'queued'})
    assert.deepEqual(current.timing,{queuedAt:110000,elapsedMs:0},'clarification requeue starts a fresh round')
    now=112000
    current=db.update(paused.requestId,current.version,{state:'routing'})
    now=113000
    current=db.update(paused.requestId,current.version,{state:'queued',autoRecovery:{attempts:1,total:1,phase:'routing',reason:'连接重试',nextAt:115000}})
    now=115000
    current=db.update(paused.requestId,current.version,{state:'routing',roundStartedAt:now,autoRecovery:{...current.autoRecovery!,nextAt:undefined}})
    assert.equal(current.timing?.startedAt,112000,'automatic recovery preserves the round start')
    now=116000
    current=db.update(paused.requestId,current.version,{state:'failed'})
    assert.equal(current.timing?.elapsedMs,4000,'automatic recovery backoff remains in the elapsed time')
    now=120000
    const retried=db.update(paused.requestId,current.version,{state:'queued'})
    assert.deepEqual(retried.timing,{queuedAt:120000,elapsedMs:0},'manual retry begins a new measurement')
    now=119000
    const backwards=db.update(paused.requestId,retried.version,{state:'routing'})
    now=118000
    const cancelled=db.update(paused.requestId,backwards.version,{state:'cancelled'})
    assert.equal(cancelled.timing?.elapsedMs,0,'clock regression cannot produce negative duration')
    const neverStarted=db.register({requestId:randomUUID(),prompt:'开始前取消'},DEFAULT_ROUTER_CONFIG)
    now=121000
    const stopped=db.update(neverStarted.requestId,neverStarted.version,{state:'cancelled'})
    assert.equal(stopped.timing?.stoppedAt,121000)
    assert.equal(stopped.timing?.startedAt,undefined)
    now=130000
    assert.deepEqual(db.update(stopped.requestId,stopped.version,{resolution:'刷新'}).timing,stopped.timing,'cancellation freezes queue wait')

    let recovery=db.register({requestId:randomUUID(),prompt:'开始前的连接恢复'},DEFAULT_ROUTER_CONFIG)
    now=131000
    recovery=db.update(recovery.requestId,recovery.version,{state:'queued',autoRecovery:{attempts:1,total:1,phase:'routing',reason:'准备重试',nextAt:133000}})
    assert.equal(recovery.timing?.startedAt,undefined,'recovery before first send remains queue wait')
    now=133000
    recovery=db.update(recovery.requestId,recovery.version,{state:'routing',autoRecovery:{...recovery.autoRecovery!,nextAt:undefined}})
    now=135000
    recovery=db.update(recovery.requestId,recovery.version,{state:'bound',delivery:'unknown'})
    assert.equal(recovery.timing?.elapsedMs,2000)
    now=136000
    recovery=db.update(recovery.requestId,recovery.version,{autoRecovery:{attempts:1,total:2,phase:'delivery',reason:'核对回执',nextAt:138000}})
    now=139000
    recovery=db.update(recovery.requestId,recovery.version,{delivery:'accepted',autoRecovery:{...recovery.autoRecovery!,nextAt:undefined}})
    assert.equal(recovery.timing?.elapsedMs,5000,'delivery recovery adds its active time to the same measurement')
    assert.equal(recovery.timing?.runningSince,undefined)
  } finally { Date.now=timingClock }
  console.log('Router store: stable session, request idempotence, versions, scoped reading and memory lifecycle passed')
}finally{db.close()}
