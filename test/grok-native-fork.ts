import assert from 'node:assert/strict'
import { mkdtemp,writeFile,readFile,rm,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { forkBetaSession,deleteOwnedGrokFork,retainGrokFork,recoverGrokForks } from '../src/main/betaSessionFork.ts'
import { BetaSideRunner } from '../src/main/betaSideRunner.ts'
import type { AgentDef } from '../src/shared/types.ts'
const root=await mkdtemp(join(tmpdir(),'ua-grok-fork-')),bin=join(root,'grok'),state=join(root,'state.json'),log=join(root,'frames.jsonl')
const env={HOME:root,GROK_HOME:join(root,'.grok'),FAKE_GROK_STATE:state,FAKE_GROK_LOG:log,FAKE_GROK_SCENARIO:JSON.stringify({native:true})}
await writeFile(bin,`#!${process.execPath}\nrequire(${JSON.stringify(resolve('test/fixtures/fake-grok.cjs'))})\n`,{mode:0o700})
await writeFile(state,JSON.stringify({sessions:[{sessionId:'source',cwd:root,transcript:[{role:'user',text:'preserved'}]}]}))
const sessions=async()=>JSON.parse(await readFile(state,'utf8')).sessions
const frames=async()=>String(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
try {
  const fork=await forkBetaSession('grok','source',bin,root,env)
  assert.notEqual(fork.nativeId,'source');assert.equal((await sessions()).length,2)
  const operations=(await frames()).filter(row=>row.frame?.method).map(row=>row.frame)
  assert.deepEqual(operations.find(frame=>frame.method==='_x.ai/session/fork').params,{sourceSessionId:'source',sourceCwd:root,newCwd:root})
  assert.equal(operations.some(frame=>['session/prompt','session/resume','session/fork'].includes(frame.method)),false)
  assert.equal(operations.some(frame=>frame.method==='session/load'&&frame.params.sessionId==='source'),false)
  await assert.rejects(deleteOwnedGrokFork('source',bin,env),/不属于/)
  await assert.rejects(deleteOwnedGrokFork('../source',bin,env),/无效/)
  await assert.rejects(deleteOwnedGrokFork(fork.nativeId,bin,{...env,GROK_HOME:join(root,'foreign')}),/不属于/)
  await deleteOwnedGrokFork(fork.nativeId,bin,env);await deleteOwnedGrokFork(fork.nativeId,bin,env)
  assert.deepEqual((await sessions()).map((s:any)=>s.sessionId),['source'])
  const retained=await forkBetaSession('grok','source',bin,root,env)
  await retainGrokFork(retained.nativeId,bin,env)
  await assert.rejects(deleteOwnedGrokFork(retained.nativeId,bin,env),/持久化/)
  const agent:AgentDef={id:'grok',adapter:'grok',name:'Grok',bin,builtin:true,icon:'',models:[],capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[],steer:true}}
  const side=new BetaSideRunner('parent',{n:0},agent,{agentId:'grok',workdir:root,model:'grok-4.7'},'source',undefined,()=>env)
  await side.startTurn('Side only');await side.disposeForkAndWait()
  assert.deepEqual((await sessions()).map((s:any)=>s.sessionId),['source',retained.nativeId])
  const cached=new BetaSideRunner('parent',{n:0},agent,{agentId:'grok',workdir:root},'source',undefined,()=>env)
  await cached.startTurn('Keep cache');await cached.disposeForkAndWait(true)
  assert.equal((await sessions()).length,3)
  assert.ok((await readdir(join(root,'.uniagent-public','grok-forks'))).length>=4)
  const abandoned=await forkBetaSession('grok','source',bin,root,env)
  const protectedFork=await forkBetaSession('grok','source',bin,root,env)
  const report=await recoverGrokForks(bin,new Set([protectedFork.nativeId]),env,Date.now()+1)
  assert.equal(report.cleaned,1);assert.equal(report.failed,0)
  assert.equal((await sessions()).some((s:any)=>s.sessionId===abandoned.nativeId),false)
  assert.equal((await sessions()).some((s:any)=>s.sessionId===protectedFork.nativeId),true)
  const faultEnv=(scenario:Record<string,unknown>)=>({...env,FAKE_GROK_SCENARIO:JSON.stringify({native:true,...scenario})})
  const beforeFailedLoad=(await sessions()).length
  await assert.rejects(forkBetaSession('grok','source',bin,root,faultEnv({forkLoadFails:true})),/fork load failed/)
  assert.equal((await sessions()).length,beforeFailedLoad,'failed fork verification cleans only the newly recorded fork')
  const deletion=await forkBetaSession('grok','source',bin,root,env)
  await assert.rejects(deleteOwnedGrokFork(deletion.nativeId,bin,faultEnv({pageSize:1,deleteNoop:true})),/删除尚未确认/)
  assert.ok((await sessions()).some((s:any)=>s.sessionId===deletion.nativeId),'a false successful CLI exit must not confirm cleanup')
  await deleteOwnedGrokFork(deletion.nativeId,bin,faultEnv({pageSize:1}))
  assert.equal((await sessions()).some((s:any)=>s.sessionId===deletion.nativeId),false,'uncertain deletion can be retried safely')
} finally {await rm(root,{recursive:true,force:true})}
console.log('grok-native-fork: extension parameters, source isolation, owned cleanup, persistent transfer and Side cache passed')
