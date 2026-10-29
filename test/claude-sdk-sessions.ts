import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { claudeSdkSessionOperation, claudeGoal } from '../src/main/claudeSdk'
import { ClaudeSdkSideRunner } from '../src/main/claudeSdkSideRunner'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { AgentDef, Session } from '../src/shared/types'

const root = await realpath(await mkdtemp(join(tmpdir(), 'ua-sdk-sessions-')))
const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, UNIAGENT_USER_DATA: process.env.UNIAGENT_USER_DATA }
process.env.HOME = root
process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
process.env.UNIAGENT_USER_DATA = join(root, 'data')
const project = join(root, '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
const parent = randomUUID(), first = randomUUID(), reply = randomUUID(), second = randomUUID()
const file = join(project, parent + '.jsonl')
const log = join(root, 'prompts.jsonl'), bin = join(root, 'claude.cjs')
const entries = [
  { type: 'user', uuid: first, parentUuid: null, message: { role: 'user', content: 'parent-first' } },
  { type: 'assistant', uuid: reply, parentUuid: first, message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'parent-reply' }] } },
  { type: 'user', uuid: second, parentUuid: reply, message: { role: 'user', content: 'parent-second' } }
].map(entry => ({ ...entry, sessionId: parent, cwd: root, timestamp: new Date().toISOString(), version: '2.1.311', isSidechain: false }))
await mkdir(project, { recursive: true })
await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
await writeFile(bin, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2), index=args.indexOf('--resume');
const session=index<0?(args.find(arg=>arg.startsWith('--resume='))||'').slice(9)||'unexpected-new':args[index+1];
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);
if(v.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{commands:[],models:[]}}});
if(v.type==='user'){
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({session,content:v.message.content})+'\\n');
 send({type:'system',subtype:'init',session_id:session});
 send({type:'result',subtype:'success',is_error:false,result:'ok',session_id:session,user_message_uuid:v.uuid});
}});
`, { mode: 0o700 })
const operation = (method: 'forkSession' | 'deleteSession' | 'history', args: unknown) => claudeSdkSessionOperation(bin, root, method, args)
const agent: AgentDef = { id:'claude', name:'Claude', adapter:'claude', bin, icon:'', builtin:true, installed:true, models:[], capabilities:{modelSelect:true,reasoningEffort:false,streaming:true,permissionModes:[{id:'ask',label:'',hint:''}]} }
const side = new ClaudeSdkSideRunner('side', {n:0}, agent, {agentId:'claude',workdir:root,permissionMode:'ask'}, parent)
let promoted: string | undefined
try {
  const orchestrator = new Orchestrator(()=>agent,new SessionStore(join(root,'sessions.json')),join(root,'artifacts'))
  const restored = {id:'restored-goal',title:'Goal',status:'idle',createdAt:1,config:{agentId:'claude',workdir:root,permissionMode:'ask'},goal:{...claudeGoal('resume objective'),autonomous:true}}
  ;(orchestrator as any).sessions.set(restored.id,restored)
  try {
    orchestrator.reconcileAgentConfigs()
    assert.equal(restored.goal.status,'paused','startup must not advertise autonomous work without a live SDK owner')
    assert.equal(restored.goal.autonomous,false)
    restored.goal={...claudeGoal('live objective'),autonomous:true}
    ;(orchestrator as any).claudeSdkRunners.set(restored.id,{hasClaudeSdkConnection:()=>true})
    orchestrator.reconcileAgentConfigs()
    assert.equal(restored.goal.autonomous,true,'refresh must preserve a live native Goal')
  } finally {
    ;(orchestrator as any).claudeSdkRunners.clear()
    orchestrator.disposeAll()
    await orchestrator.closeSessionLogs()
  }
  const history = await operation('history', parent)
  assert.deepEqual(history.map((message: any) => message.uuid), [first, reply, second])
  const beforeRewind = await operation('forkSession', {sessionId:parent,messageId:reply})
  assert.notEqual(beforeRewind.sessionId, parent)
  const prefix = await operation('history', beforeRewind.sessionId)
  assert.deepEqual(prefix.map((message:any)=>message.message.content), ['parent-first',[{type:'text',text:'parent-reply'}]], 'rewind must exclude the selected user turn and all its successors')
  assert.ok(prefix.every((message:any)=>![first,reply,second].includes(message.uuid)), 'SDK forks assign new native message identities')
  await operation('deleteSession', beforeRewind.sessionId)
  for (const prompt of ['side-first', 'side-second']) {
    const done = once(side, 'done')
    await side.startTurn(prompt)
    assert.equal((await done)[0].failed, false)
  }
  assert.ok(side.nativeThreadId())
  assert.notEqual(side.nativeThreadId(), parent)
  const prompts = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(prompts.map(value=>value.session), [side.nativeThreadId(),side.nativeThreadId()], 'all side turns must resume the same isolated native fork')
  assert.deepEqual(prompts.map(value=>value.content), ['side-first','side-second'])
  promoted = await side.forkPersistent([])
  assert.notEqual(promoted, side.nativeThreadId())
  assert.notEqual(promoted, parent)
  await assert.rejects(side.deleteThread(parent), /禁止删除/)
  await side.disposeFork()
  assert.deepEqual(await readFile(file,'utf8'), entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n', 'side cleanup must preserve the entire parent transcript')
  assert.ok((await operation('history', promoted)).length, 'promotion must survive temporary fork cleanup')
  const promotionOrchestrator = new Orchestrator(()=>agent,new SessionStore(join(root,'promotion-sessions.json')),join(root,'promotion-artifacts'))
  const internal = promotionOrchestrator as any
  const source: Session = {id:'promotion-source',title:'Source',status:'idle',createdAt:1,nativeSessionId:parent,config:{agentId:'claude',workdir:root,permissionMode:'ask'}}
  const promotionSide = new ClaudeSdkSideRunner(source.id,{n:1},agent,source.config,parent)
  let latePromotion: string | undefined
  internal.sessions.set(source.id,source)
  internal.sideEvents.set(source.id,[{sessionId:source.id,seq:0,ts:1,type:'user_message',payload:{text:'Promote this side'}}])
  internal.sideStatus.set(source.id,'idle')
  internal.sideStreamers.set(source.id,promotionSide)
  internal.bindSideStreamer(source.id,promotionSide)
  const fork = promotionSide.forkPersistent.bind(promotionSide)
  promotionSide.forkPersistent = async events => {
    const nativeId = await fork(events)
    promotionSide.emit('event',{sessionId:source.id,seq:1,ts:2,type:'system_notice',payload:{id:'late-speed',kind:'token_speed',speed:{outputTokens:16}}})
    return nativeId
  }
  try {
    const session = await promotionOrchestrator.promoteSideToSession(source.id)
    latePromotion = session.nativeSessionId
    assert.ok((await promotionOrchestrator.getEvents(session.id)).some(event=>event.payload.id==='late-speed'),'late native telemetry must be retained without invalidating a settled promotion')
  } finally {
    promotionOrchestrator.disposeAll()
    await promotionSide.disposeFork()
    await promotionOrchestrator.closeSessionLogs()
    if (latePromotion) await operation('deleteSession',latePromotion)
  }
  console.log('Claude SDK sessions: official history/fork/delete, rewind prefix, side isolation, reuse and promotion passed')
} finally {
  await side.disposeFork()
  if (promoted) await operation('deleteSession', promoted)
  for (const [key,value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  await rm(root,{recursive:true,force:true})
}
