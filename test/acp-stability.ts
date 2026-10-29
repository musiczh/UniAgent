import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACPRunner } from '../src/main/acp/acpRunner.ts'
import { loadDeepSeekSessionEvents } from '../src/main/grokACPRunner.ts'
import { agentRoleUnavailableReason } from '../src/main/agentRoles.ts'
import type { AgentDef } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'ua-acp-stable-'))
let checks = 0
try {
 for (const provider of ['kimi','grok','deepseek'] as const) {
  for (const scenario of [{}, { noModes:true, noOptions:true, noResume:true, replay:true }, { noAttachments:true, rejectMode:true }, { openingUpdates:true }]) {
   const log = join(root, `${provider}-${checks}.jsonl`), bin = join(root, `${provider}-${checks}`)
   await writeFile(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('test/fixtures/fake-stable-acp.cjs'))})\n`); await chmod(bin,0o755)
   const agent = { id: provider, adapter: provider, name: provider, bin, icon: provider, models: [], capabilities: { modelSelect: true, reasoningEffort: false, permissionModes: [{ id:'ask', label:'请求批准', hint:'' }] } } as AgentDef
   const events: any[] = [], done: any[] = []
   const runner = new ACPRunner('local', { n: 0 }, agent, { agentId:provider, workdir:root, permissionMode:'ask', model:scenario.openingUpdates ? 'another-model' : 'old-model', ...(scenario.openingUpdates ? { roleSnapshot:{id:'parameter-role',name:'Parameter preset',agentId:provider,model:'another-model',permissionMode:'ask'} } : {effort:'high'}) }, 'stable-id', { UA_STABLE_LOG:log, UA_STABLE_SCENARIO:JSON.stringify(scenario) })
   runner.on('event', e => { events.push(e); if (e.type === 'approval_request' && e.state === 'pending') runner.respondResult(e.payload.requestId, { outcome:{ outcome:'selected', optionId:'yes' } }) }); runner.on('done', x => done.push(x))
   try {
    const { contract } = await runner.probeSession(false)
    assert.equal(contract.nativeGoal, false); assert.equal(contract.steer, false); assert.equal(contract.sessionFork, false); assert.equal(contract.sideChat, false); assert.equal(contract.structuredSubagents, false); assert.equal(contract.capabilityInventory, false)
    assert.equal(contract.currentModelId, scenario.noOptions ? undefined : scenario.openingUpdates ? 'another-model' : 'new-model')
    assert.equal(contract.permissionModes.some(m => m.id === 'read-only'), false)
    await runner.startTurn('hello'); assert.equal(done.at(-1)?.failed,false); assert.ok(events.some(e => e.payload.text === 'STABLE_OK'))
    await runner.startTurn('approval'); assert.ok(events.some(e => e.payload.text === 'APPROVAL_OK'))
    const cancel = runner.startTurn('cancel'); await new Promise(r => setTimeout(r,70)); runner.interrupt(); await cancel; assert.equal(done.at(-1)?.interrupted,true)
    if (!scenario.noOptions) { const applied = await runner.updateConfig({ agentId:provider,workdir:root,permissionMode:'ask',model:'another-model' }); assert.equal(applied.contract?.currentModelId,'another-model') }
    assert.equal(events.some(e => e.payload.text === 'OLD_REPLAY'), false)
    if (scenario.noModes || scenario.rejectMode) await assert.rejects(runner.setCollaborationMode('plan'), /Plan|mode|removed/)
    else {
     await runner.setCollaborationMode('plan')
     await runner.startTurn('report-mode')
     assert.equal(events.filter(e => e.type === 'agent_message').at(-1)?.payload.text, 'MODE_plan')
     await runner.setCollaborationMode('default')
     await runner.startTurn('report-mode')
     assert.equal(events.filter(e => e.type === 'agent_message').at(-1)?.payload.text, 'MODE_default')
    }
    const image = join(root,'image.png'); await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RMQ0AMAzEQLf8OacQ3CWbD8BHcg4Mm+7qOh340A9UiVSJVIlUiVSJVIlUiVSJMA+hxgE/8m7SpQAAAABJRU5ErkJggg==','base64'))
    const before = done.length; await runner.startTurn('image',[{kind:'image',path:image,name:'image.png',mime:'image/png'}]); assert.equal(done.length,before+1); assert.equal(done.at(-1)?.failed,!!scenario.noAttachments)
    await assert.rejects(runner.getGoal(), /稳定 ACP/); await assert.rejects(runner.steer('never'), /稳定 ACP/)
    await assert.rejects(runner.updateConfig({ agentId:provider,workdir:root,permissionMode:'read-only' }), /权限|permission/)
    assert.match(agentRoleUnavailableReason({ id:'role',name:'Role',agentId:provider,permissionMode:'ask',instructions:'system rule' },[agent]) || '', provider === 'kimi' ? /Kimi Web/ : /稳定 ACP/)
    if (provider==='deepseek') { const loaded=await loadDeepSeekSessionEvents('stable-id',bin,root,{UA_STABLE_LOG:log,UA_STABLE_SCENARIO:JSON.stringify(scenario)}); assert.equal(loaded.model,scenario.noOptions ? undefined : 'new-model') }
    const records = (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.some(x => /^_|web/.test(x.method || '') || x.argv?.includes('web')),false)
    assert.ok(records.some(x => x.method === (scenario.noResume ? 'session/load' : 'session/resume')))
    checks++
   } finally { await runner.disposeAndWait() }
  }
 }

 for (const scenario of [{noLoad:true,noResume:true},{foreignId:true},{initializeDelay:150}]) {
  const log=join(root,'lifecycle-'+checks+'.jsonl'),bin=join(root,'lifecycle-'+checks)
  await writeFile(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('test/fixtures/fake-stable-acp.cjs'))})\n`); await chmod(bin,0o755)
  const agent={id:'grok',adapter:'grok',name:'Grok',bin,models:[],capabilities:{}} as AgentDef
  const runner=new ACPRunner('lifecycle',{n:0},agent,{agentId:'grok',workdir:root,permissionMode:'ask'}, scenario.initializeDelay ? undefined : 'stable-id',{UA_STABLE_LOG:log,UA_STABLE_SCENARIO:JSON.stringify(scenario)})
  const done:any[]=[]; runner.on('done',x=>done.push(x))
  try {
   if (scenario.initializeDelay) { const turn=runner.startTurn('cancel during initialize'); runner.interrupt(); await turn; assert.equal(done.length,1); assert.equal(done[0].interrupted,true); await runner.startTurn('hello'); assert.equal(done.at(-1).failed,false) }
   else await assert.rejects(runner.probeSession(false),/恢复|sessionId/)
   const records=(await readFile(log,'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(JSON.parse)
   if (scenario.noLoad) assert.equal(records.some(x=>['session/new','session/prompt'].includes(x.method)),false)
   checks++
  } finally { await runner.disposeAndWait() }
 }
} finally { await rm(root,{ recursive:true,force:true }) }
console.log(`acp-stability: ${checks} upgrade scenarios passed`)
