import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { TaskCreation, taskRegistration } from '../src/main/taskCreation'
import { TeamService } from '../src/main/teamService'
import { TeamStore } from '../src/main/teamStore'
import { ProjectStore } from '../src/main/projectStore'
import { DEFAULT_TEAM_LIMITS, DEFAULT_TEAM_RULES } from '../src/shared/teamTypes'
import type { AgentDef, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'task-creation-runtime-'))
const previousData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const agent: AgentDef = { id:'codex', name:'Codex', bin:'/usr/bin/true', adapter:'codex', icon:'', builtin:true, installed:true, models:[], capabilities:{modelSelect:true,reasoningEffort:false,streaming:true,permissionModes:[{id:'read-only',label:'只读'}]} }
let teams: TeamService | undefined
try {
  const spaceRoot = join(root,'workspace'); await mkdir(spaceRoot)
  const spaces = new ProjectStore(root), space = spaces.create({name:'Space',primaryDirectory:spaceRoot,additionalDirectories:[]})
  const disk = new SessionStore(join(root,'sessions.json'))
  const runtime = new Orchestrator(() => agent, disk, join(root,'artifacts'), join(root,'logs'), (config,validate) => spaces.resolveSessionConfig(config,validate))
  let turns = 0
  // Replace the external Agent transport, retaining real registration and history.
  ;(runtime as any).run = (session: Session) => { turns++; session.status='completed'; return true }
  const receipts = new TaskCreation(join(root,'receipts')), id = randomUUID()
  const config = {agentId:agent.id,projectId:space.id,workdir:spaceRoot,permissionMode:'read-only' as const}
  const hooks = {execute:async(record:any,before:()=>Promise<void>) => {
    runtime.registerTaskSession(config,'Task',record.sessionId,taskRegistration(record))
    assert.equal(turns,0)
    assert.equal(disk.load().find(row=>row.id===record.sessionId)?.taskRegistration?.phase,'provisioning')
    await before(); runtime.setTaskRegistration(record.sessionId,taskRegistration(record))
    return runtime.createSession(config,'Task',undefined,undefined,undefined,undefined,undefined,record.sessionId)
  },existing:async(record:any)=>runtime.getSessionById(record.sessionId)!}
  const created = await receipts.run(id,'message',{config,prompt:'Task'},'Task',hooks)
  runtime.setTaskRegistration(created.id,taskRegistration((await receipts.get(id))!))
  runtime.setTaskRegistration(created.id,{...created.taskRegistration!,phase:'provisioning',delivery:'accepted',events:created.taskRegistration!.events.slice(0,2)})
  assert.equal(created.taskRegistration!.delivery,'dispatched','a late duplicate query cannot regress the live task receipt')
  assert.equal((await receipts.run(id,'message',{config,prompt:'Task'},'Task',hooks)).id,created.id)
  assert.equal(turns,1); assert.equal(runtime.listSessions().length,1)
  assert.equal(disk.load()[0].taskRegistration?.phase,'active')

  const pendingId=randomUUID(), pendingRecord={...(await receipts.get(id))!,requestId:pendingId,inputId:pendingId,sessionId:'pending',state:'accepted' as const}
  const pending=runtime.registerTaskSession(config,'Pending','pending',taskRegistration(pendingRecord))
  assert.equal(disk.load().find(row=>row.id==='pending')?.status,'draft','pre-dispatch task stays draft after restart')
  pending.readOnly=true
  assert.throws(()=>runtime.registerTaskSession(config,'Pending','pending',taskRegistration(pendingRecord)),/不可写/)
  pending.readOnly=false;pending.taskRegistration!.delivery='dispatching'
  disk.saveOrThrow(runtime.listSessions())
  assert.equal(disk.load().find(row=>row.id==='pending')?.taskRegistration?.delivery,'unknown')
  pending.taskRegistration!.delivery='unknown'
  ;(runtime as any).queues.set(pending.id,[{id:pending.taskRegistration!.inputId,prompt:'Must not replay',state:'pending',acceptedAt:1,attempts:0}])
  ;(runtime as any).dispatchPendingQueue(pending)
  assert.equal(turns,1,'unknown first input cannot be replayed by the normal queue')
  pending.status='idle';pending.nativeSessionId='native-unknown'
  assert.equal((runtime as any).canResumePendingQueue(pending,()=>true),false)
  ;(runtime as any).queues.set(pending.id,[{id:'explicit-followup',prompt:'New authorized input',state:'pending',acceptedAt:2,attempts:0}])
  assert.equal((runtime as any).canResumePendingQueue(pending,()=>true),true,'uncertainty about the first input must not freeze later explicit inputs')

  agent.capabilities.nativeReview=true
  let reviews=0
  ;(runtime as any).ensureStreamerForNativeAction=()=>({startReview:async()=>{reviews++}})
  const reviewId=randomUUID(),action={type:'review.start' as const,draft:{scope:{type:'uncommittedChanges' as const}}}
  const nativeHooks={execute:async(record:any,before:()=>Promise<void>)=>{runtime.registerTaskSession(config,'Review',record.sessionId,taskRegistration(record));await before();return runtime.createNativeActionSession(config,action,undefined,record.sessionId)},existing:async(record:any)=>runtime.getSessionById(record.sessionId)!}
  const review=await receipts.run(reviewId,'native',{config,action},'Review',nativeHooks)
  assert.equal((await receipts.run(reviewId,'native',{config,action},'Review',nativeHooks)).id,review.id)
  assert.equal(reviews,1)

  const teamStore=new TeamStore(root)
  teams=new TeamService(runtime,spaces,()=>[agent],teamStore)
  const definition=teams.saveTeam({name:'Team',description:'',rules:DEFAULT_TEAM_RULES,leaderMemberId:'leader',members:['leader','member'].map(member=>({id:member,role:{id:'role_'+member,name:member,agentId:agent.id,permissionMode:'read-only' as const}})),limits:{...DEFAULT_TEAM_LIMITS},status:'active'})
  let sends=0
  runtime.sendMessage=async()=>{sends++}
  const teamId=randomUUID(), input={teamId:definition.id,spaceId:space.id,prompt:'Team task'}
  const callbacks={execute:async(record:any,beforeDispatch:()=>Promise<void>)=>teams!.create(input,undefined,undefined,false,{record,beforeDispatch}),existing:async(record:any)=>teamStore.project(record.teamProjectId)}
  const project=await receipts.run(teamId,'team',input,input.prompt,callbacks)
  const again=await new TaskCreation(join(root,'receipts')).run(teamId,'team',input,input.prompt,callbacks)
  assert.equal(project.id,again.id);assert.equal(sends,1)
  assert.equal(project.memberSessions.leader,(await receipts.get(teamId))!.sessionId)
  assert.equal(teamStore.catalog().projects.length,1)
  execFileSync('git',['init','-q',spaceRoot])
  execFileSync('git',['-C',spaceRoot,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'})
  const worktreeId=randomUUID(), worktreeInput={...input,prompt:'Worktree recovery',workspaceSelection:{mode:'worktree' as const,baseRef:'HEAD',requestId:randomUUID()}}
  let failOnce=true
  const worktreeCallbacks={execute:async(record:any,beforeDispatch:()=>Promise<void>)=>teams!.create(worktreeInput,undefined,undefined,false,{record,beforeDispatch:async()=>{if(failOnce){failOnce=false;throw new Error('before input acceptance')};await beforeDispatch()}}),existing:async(record:any)=>teamStore.project(record.teamProjectId)}
  await assert.rejects(receipts.run(worktreeId,'team',worktreeInput,worktreeInput.prompt,worktreeCallbacks),/before input acceptance/)
  const draftRecord=(await receipts.get(worktreeId))!,draftProject=teamStore.project(draftRecord.teamProjectId)
  const fixedMembers={...draftProject.memberSessions}
  const resumed=await receipts.run(worktreeId,'team',worktreeInput,worktreeInput.prompt,worktreeCallbacks)
  assert.deepEqual(resumed.memberSessions,fixedMembers)
  assert.equal(sends,2,'only the successful resumed team sends the first input')
  assert.equal(resumed.worktree?.state,'ready')
  console.log('PASS Task creation with real SessionStore / Orchestrator / TeamService: registration, replay, read-only, restart and fixed identities')
} finally { teams?.close(); if(previousData===undefined)delete process.env.UNIAGENT_USER_DATA;else process.env.UNIAGENT_USER_DATA=previousData; await rm(root,{recursive:true,force:true}) }
