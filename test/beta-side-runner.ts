import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BetaSideRunner } from '../src/main/betaSideRunner.ts'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

const root = await realpath(await mkdtemp(join(tmpdir(), 'uniagent-beta-side-')))
const fixture = resolve('test/fixtures/fake-beta-side.cjs')
const bin = join(root, 'agent')
await writeFile(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(fixture)})\n`)
await chmod(bin, 0o755)
const waitUntil = async (test: () => boolean | Promise<boolean>) => {
  for (let i=0;i<200;i++) { if (await test()) return; await new Promise(resolve=>setTimeout(resolve,10)) }
  assert.fail('side runner did not reach expected state')
}
const runners: BetaSideRunner[] = []
try {
  for (const provider of ['kimi','grok','deepseek'] as const) {
    const log = join(root, `${provider}.jsonl`)
    const statePath = join(root, `${provider}.json`)
    await writeFile(statePath, JSON.stringify({ serial:0, sessions:{source:['native source marker']} }))
    const env = { HOME:root, FAKE_BETA_PROVIDER:provider, FAKE_BETA_OWNER:'source-owner', FAKE_BETA_LOG:log, FAKE_BETA_STATE:statePath }
    const records = async () => { try { return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) } catch { return [] } }
    const state = async () => JSON.parse(await readFile(statePath,'utf8'))
    const config:SessionConfig = { agentId:provider, workdir:root, permissionMode:'ask', model:'audit-local', kimiRuntimeOwnerId:'source-owner' }
    const agent:AgentDef = { id:provider, name:provider, adapter:provider, bin, icon:'', builtin:true, capabilities:{modelSelect:true,reasoningEffort:false,permissionModes:[],...(provider==='grok'?{steer:true}:{})},models:[] }
    const runner = new BetaSideRunner('local-source',{n:0},agent,config,'source',undefined,()=>env)
    runners.push(runner)
    const events:UAEvent[]=[]
    let done=0
    let nativeId:string|undefined
    runner.on('event',event=>events.push(event))
    runner.on('done',()=>done++)
    runner.on('nativeThreadReady',id=>nativeId=id)
    assert.equal((await records()).length,0,'constructing Side must not fork or start the source')
    await runner.startTurn('side-one')
    assert.equal(done,1)
    assert.equal(nativeId,'fork-1')
    assert.deepEqual((await state()).sessions.source,['native source marker'])
    assert.deepEqual((await state()).sessions['fork-1'],['native source marker','side-one'])
    assert.equal(events.some(event=>event.type==='agent_message'&&event.payload.text==='answer:side-one'),true)
    assert.equal((await records()).filter(frame=>frame.method==='session/resume').every(frame=>frame.params.sessionId==='fork-1'),true)
    runner.updateConfig({...config,model:'audit-other'})
    await runner.startTurn('side-two')
    assert.equal((await records()).some(frame=>frame.method==='session/set_config_option'&&frame.params.value==='audit-other'),true)
    await runner.setCollaborationMode('plan')
    assert.equal((await records()).some(frame=>['session/set_mode','_uniagent/set_mode'].includes(frame.method)&&(frame.params.modeId==='plan'||frame.params.mode==='plan')),true)
    await runner.setCollaborationMode('default')
    const approvalTurn=runner.startTurn('approval')
    await waitUntil(()=>events.some(event=>event.type==='approval_request'&&event.state==='pending'))
    const approval=events.findLast(event=>event.type==='approval_request'&&event.state==='pending')!
    assert.deepEqual(await runner.respond(approval.payload.requestId,{outcome:{outcome:'selected',optionId:'allow'}}),{handled:true,hasPendingRequests:false})
    await approvalTurn
    const held=runner.startTurn('hold')
    await waitUntil(async()=> (await state()).sessions['fork-1'].includes('hold'))
    if (provider==='deepseek' || provider==='grok') await runner.steer('native-steer')
    else await assert.rejects(runner.steer('unsupported-steer'),/引导|steer/)
    runner.interrupt()
    await held
    if (provider==='grok') {
      const steer=(await records()).find(frame=>frame.method==='_x.ai/interject')
      assert.deepEqual(steer.params,{sessionId:'fork-1',text:'native-steer'},'Side steering must target the independent native fork')
      assert.equal((await state()).sessions.source.includes('native-steer'),false)
    }
    await runner.compact()
    assert.equal((await state()).sessions['fork-1'].includes('/compact'),true)
    if (provider==='deepseek') runner.updateConfig({...config,model:'audit-local',effort:'high'})
    const promoted=await runner.forkPersistent([], 'promoted-local')
    assert.equal(promoted,'fork-2')
    assert.deepEqual((await state()).sessions['fork-2'],(await state()).sessions['fork-1'])
    if(provider==='deepseek') {
      const nativeFork=(await records()).findLast(frame=>frame.method==='_uniagent/fork')
      assert.deepEqual(nativeFork.params.configOptions,[{id:'model',currentValue:'audit-local'},{id:'reasoning_effort',currentValue:'high'}],'promotion must apply the current Side config even without a subsequent turn')
      assert.ok(Array.isArray(nativeFork.params.mcpServers),'Side MCP context must accompany the native fork')
    }
    assert.deepEqual((await state()).sessions.source,['native source marker'])
    await runner.disposeForkAndWait(true)
    const restored = new BetaSideRunner('local-source',{n:events.length},agent,{...config,model:'audit-other'},'source','fork-1',()=>env)
    runners.push(restored)
    await restored.startTurn('restored')
    assert.equal((await state()).serial,2,'restoring must resume Side identity without another source fork')
    assert.equal((await state()).sessions['fork-1'].at(-1),'restored')
    assert.equal((await records()).filter(frame=>frame.kind==='started').every(frame=>frame.owner==='source-owner'),true)
    await assert.rejects(restored.deleteThread('source'),/主会话|源会话/)
    await restored.disposeForkAndWait(provider==='deepseek')
    if (provider!=='deepseek') await waitUntil(async()=>!(await state()).sessions['fork-1'])
    assert.throws(()=>new BetaSideRunner('bad',{n:0},agent,config,'source','source',()=>env),/主会话|源会话/)
  }
  // Break caught: cancel between native fork creation and the first prompt.
  const delayedLog=join(root,'delayed.jsonl')
  const delayedState=join(root,'delayed.json')
  await writeFile(delayedState, JSON.stringify({ serial:0, sessions:{source:['native source marker']} }))
  const delayedEnv={HOME:root,FAKE_BETA_PROVIDER:'kimi',FAKE_BETA_LOG:delayedLog,FAKE_BETA_STATE:delayedState,FAKE_BETA_FORK_DELAY:'150'}
  const delayedAgent:AgentDef={id:'kimi',name:'Kimi',adapter:'kimi',bin,icon:'',builtin:true,capabilities:{modelSelect:false,reasoningEffort:false,permissionModes:[]},models:[]}
  const delayed=new BetaSideRunner('delayed-local',{n:0},delayedAgent,{agentId:'kimi',workdir:root,permissionMode:'ask'},'source',undefined,()=>delayedEnv)
  runners.push(delayed)
  let cancelled=0
  delayed.on('done',({interrupted})=>{if(interrupted) cancelled++})
  const cancelledTurn=delayed.startTurn('must-not-run')
  await waitUntil(async()=>JSON.parse(await readFile(delayedState,'utf8')).serial===1)
  delayed.interrupt()
  await cancelledTurn
  assert.equal(cancelled,1)
  assert.deepEqual(JSON.parse(await readFile(delayedState,'utf8')).sessions['fork-1'],['native source marker'])
  await delayed.startTurn('after-cancel')
  assert.deepEqual(JSON.parse(await readFile(delayedState,'utf8')).sessions['fork-1'],['native source marker','after-cancel'])
  const starting=(delayed as any).runner
  const originalUpdate=starting.updateConfig.bind(starting)
  let releaseUpdate:()=>void=()=>{}
  starting.updateConfig=async (config:SessionConfig)=> { await new Promise<void>(resolve=>releaseUpdate=resolve); return originalUpdate(config) }
  delayed.updateConfig({agentId:'kimi',workdir:root,permissionMode:'ask',model:'audit-other'})
  const pending=delayed.startTurn('must-not-run-during-config')
  await new Promise(resolve=>setImmediate(resolve))
  delayed.interrupt()
  releaseUpdate()
  await pending
  assert.equal(cancelled,2,'cancel during configuration preparation must finish before the underlying turn exists')
  assert.equal(JSON.parse(await readFile(delayedState,'utf8')).sessions['fork-1'].includes('must-not-run-during-config'),false)
  const disposalLog = join(root, 'disposal.jsonl')
  const disposalState = join(root, 'disposal.json')
  await writeFile(disposalState, JSON.stringify({ serial:0, sessions:{source:['native source marker']} }))
  const disposing = new BetaSideRunner('dispose-during-fork', {n:0}, delayedAgent,
    {agentId:'kimi',workdir:root,permissionMode:'ask'}, 'source', undefined,
    () => ({...delayedEnv, FAKE_BETA_LOG:disposalLog, FAKE_BETA_STATE:disposalState}))
  runners.push(disposing)
  const disposingTurn = disposing.startTurn('must-not-run-after-dispose')
  await waitUntil(async () => JSON.parse(await readFile(disposalState,'utf8')).serial === 1)
  await disposing.disposeForkAndWait(false)
  await disposingTurn
  assert.deepEqual(JSON.parse(await readFile(disposalState,'utf8')).sessions, {source:['native source marker']},
    'closing during fork must await cleanup of the newly created native branch')
} finally {
  await Promise.all(runners.map(runner=>runner.disposeForkAndWait(true)))
  for (const filename of ['kimi','grok','deepseek','delayed','disposal'].map(name=>join(root,`${name}.jsonl`))) {
    const contents = await readFile(filename,'utf8').catch((error:NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
    const pids = new Set(contents.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).pid))
    for (const pid of pids) assert.throws(() => process.kill(pid,0), { code:'ESRCH' }, 'owned transport must exit before fixture deletion')
  }
  await rm(root,{recursive:true,force:true})
}
console.log('beta-side-runner: independent fork/resume, source isolation, config, plan, approvals, interrupt, compaction and promotion verified')
