import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The managed runtime is no longer pinned: resolve the newest installed runtime-<version> dir.
function resolveInstalledDeepSeekRuntime(): string {
  const root = join(homedir(), 'Library/Application Support/UniAgent/deepseek')
  const installed = existsSync(root) ? readdirSync(root).filter((name) => /^runtime-.+/.test(name)) : []
  installed.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
  return join(root, installed[0] || 'runtime-0.2.1-rc.2')
}

// Removing the bridge's routing, native side effects, or cancellation must break this real SDK probe.
const source = resolve('src/main/deepseekBridgePlugin.mjs')
assert.equal(await access(source).then(() => true, () => false), true, 'DeepSeek SDK extension bridge must exist')
const runtime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || resolveInstalledDeepSeekRuntime()
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-bridge-'))
const home = join(fixture, 'home')
let child: ChildProcessWithoutNullStreams | undefined
let stderr = ''
let sequence = 0
const replies = new Map<any, { resolve: (value: any) => void, reject: (error: Error) => void }>()
const messages: any[] = []
const waiters = new Set<() => void>()
try {
  await mkdir(home, { recursive: true })
  await symlink(join(runtime, 'node_modules'), join(fixture, 'node_modules'), 'dir')
  await copyFile(source, join(fixture, 'bridge.mjs'))
  await copyFile(resolve('src/main/deepseekControlPlugin.mjs'), join(fixture, 'deepseekControlPlugin.mjs'))
  await copyFile(resolve('src/main/deepseekRolePlugin.mjs'), join(fixture, 'deepseekRolePlugin.mjs'))
  await writeFile(join(fixture, 'readable.txt'), 'native child read reached the filesystem\n')
  await writeFile(join(fixture, 'attachments.mjs'), `
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
export function apply(ctx) {
  class DelayedAttachmentStore extends LocalAttachmentStore {
    gates=new Map()
    reads=[]
    readers=new Map()
    holdAdmission=false
    admissionStarted=false
    admissionObservers=[]
    releaseAdmission
    async admitPromptContent(parts) {
      const content=await super.admitPromptContent(parts)
      if(this.holdAdmission && parts.some(part=>part.type==='image')) {
        this.admissionStarted=true
        for(const resolve of this.admissionObservers.splice(0))resolve()
        await new Promise(resolve=>{this.releaseAdmission=resolve})
      }
      return content
    }
    awaitAdmission() {return this.admissionStarted?Promise.resolve():new Promise(resolve=>this.admissionObservers.push(resolve))}
    async readImage(ref,signal) {
      if(!ref.attachmentId.startsWith('goal-output-'))return super.readImage(ref,signal)
      this.reads.push(ref.attachmentId)
      this.readers.get(ref.attachmentId)?.()
      await new Promise(resolve=>this.gates.set(ref.attachmentId,resolve))
      return {ref,data:Buffer.from('fixture-image-bytes')}
    }
    release(id) {this.gates.get(id)?.();this.gates.delete(id)}
    waitRead(id) {return this.reads.includes(id)?Promise.resolve():new Promise(resolve=>this.readers.set(id,resolve))}
  }
  new DelayedAttachmentStore(ctx,{})
}
`)
  await writeFile(join(fixture, 'fixture.mjs'), `
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import sharp from 'sharp'
export const inject = ['agents', 'commands', 'planMode', 'sessionQuery', 'userQuestions', 'sessions', 'skills', 'tools', 'approval', 'goals', 'attachments', 'llm']
export function apply(ctx) {
  let childInterrupted=false
  const activeStreams=new Map()
  const activeStreamObservers=new Map()
  const heldAssemblies=new Map()
  const heldDrivers=new Map()
  const nextStreams=new Map()
  const requestRoutes=new Map()
  const claimedInputs=[]
  ctx.on('agent/inbox/claimed',function({message,turn}){claimedInputs.push({message,turn})})
  ctx.on('system-prompt/assemble',async(assembly,context,next)=>{
    const held=heldAssemblies.get(context.scope?.id)
    if(held){held.started=true;held.observed?.();await new Promise(resolve=>{held.release=resolve})}
    return next()
  })
  ctx.on('agent/request',async({agent},next)=>{const config=await next();return requestRoutes.has(agent.id)?{...config,model:requestRoutes.get(agent.id)}:config},{prepend:true})
  ctx.on('llm/stream',async function*(options,next){
    const initial=options.messages.some(message=>message.content.some(block=>block.type==='text' && block.text==='fixture-active-steer'))
    if(!initial)return yield* next()
    const held=nextStreams.get(options.sessionId)
    if(!activeStreams.has(options.sessionId))await new Promise(resolve=>{activeStreams.set(options.sessionId,resolve);activeStreamObservers.get(options.sessionId)?.()})
    if(held){held.started=true;held.observed?.();await new Promise(resolve=>{held.release=resolve})}
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'text-delta',index:0,text:'Native active steer fixture'}
    yield {type:'block-end',index:0,block:{type:'text',text:'Native active steer fixture'}}
    yield {type:'finish',reason:{kind:'stop'}}
  })
  ctx.commands.register({name:'fixture-release-steer',description:'Release the public LLM seam for an active native turn',handler:({agent})=>{activeStreams.get(agent.id)?.();return {kind:'success'}}})
  ctx.commands.register({name:'fixture-await-steer',description:'Wait until the active native stream can be released',handler:async({agent})=>{if(!activeStreams.has(agent.id))await new Promise(resolve=>activeStreamObservers.set(agent.id,resolve));return {kind:'success'}}})
  ctx.commands.register({name:'fixture-hold-driver',description:'Keep admitted official prompts pending before their inbox claim',handler:({agent})=>{void agent.runMaintenance(signal=>new Promise(resolve=>{heldDrivers.set(agent.id,resolve);signal.addEventListener('abort',resolve,{once:true})})).catch(()=>{});return {kind:'success'}}})
  ctx.commands.register({name:'fixture-release-driver',description:'Resume the native driver',handler:({agent})=>{heldDrivers.get(agent.id)?.();return {kind:'success'}}})
  ctx.commands.register({name:'fixture-hold-assembly',description:'Pause public system assembly before request route resolution',handler:({agent})=>{heldAssemblies.set(agent.id,{});return {kind:'success'}}})
  ctx.commands.register({name:'fixture-await-assembly',description:'Wait for paused public system assembly',handler:async({agent})=>{const held=heldAssemblies.get(agent.id);if(!held.started)await new Promise(resolve=>{held.observed=resolve});return {kind:'success'}}})
  ctx.commands.register({name:'fixture-release-assembly',description:'Resume system assembly',handler:({agent})=>{heldAssemblies.get(agent.id)?.release?.();heldAssemblies.delete(agent.id);return {kind:'success'}}})
  ctx.commands.register({name:'fixture-set-request-route',description:'Override the public plugin request route',handler:({agent,rawInput})=>{requestRoutes.set(agent.id,rawInput.trim());return {kind:'success'}}})
  ctx.commands.register({name:'fixture-hold-next-stream',description:'Pause the next request in the same native turn',handler:({agent})=>{nextStreams.set(agent.id,{});return {kind:'success'}}})
  ctx.commands.register({name:'fixture-await-next-stream',description:'Wait for the next request route and header',handler:async({agent})=>{const held=nextStreams.get(agent.id);if(!held.started)await new Promise(resolve=>{held.observed=resolve});return {kind:'success'}}})
  ctx.commands.register({name:'fixture-release-next-stream',description:'Complete the held native request',handler:({agent})=>{nextStreams.get(agent.id)?.release?.();nextStreams.delete(agent.id);return {kind:'success'}}})
  ctx.commands.register({name:'fixture-hold-admission',description:'Delay verified image publication at the public service seam',handler:()=>{ctx.attachments.admissionStarted=false;ctx.attachments.holdAdmission=true;return {kind:'success'}}})
  ctx.commands.register({name:'fixture-admission-state',description:'Observe delayed image publication',handler:()=>({kind:'success',text:String(ctx.attachments.admissionStarted)})})
  ctx.commands.register({name:'fixture-await-admission',description:'Wait for image publication without polling',handler:async()=>{await ctx.attachments.awaitAdmission();return {kind:'success'}}})
  ctx.commands.register({name:'fixture-release-admission',description:'Complete verified image publication',handler:()=>{ctx.attachments.holdAdmission=false;ctx.attachments.releaseAdmission?.();return {kind:'success'}}})
  ctx.commands.register({name:'fixture-steer-state',description:'Inspect native steer claims and public limits',handler:({agent})=>({kind:'success',text:JSON.stringify({active:activeStreams.has(agent.id),claimed:claimedInputs,limits:ctx.attachments.imageLimits})})})
  const goalOutputs=[]
  const persistImage=async(agent,red=false)=>{
    const bytes=await sharp({create:{width:2,height:2,channels:4,background:{r:red?190:25,g:90,b:red?25:190,alpha:1}}}).png().toBuffer()
    const attachment=await ctx.attachments.saveImage({data:bytes,mediaType:'image/png'})
    const session=agent.session
    const turn=(session.snapshotEvents().filter(event=>event.type==='turn/start').at(-1)?.data.turn??0)+1
    const image={type:'image',attachment}
    const callId='native-image-tool'
    session.append('turn/start',{turn})
    session.append('step/start',{turn,step:1})
    const event=session.append('assistant/message',{turn,step:1,message:createAssistantMessage({content:[image,{type:'tool-call',id:callId,name:'read',arguments:'{}'}],source:{provider:'deepseek-official',model:'deepseek-flash'}}),stream:[]},{surfaceOp:'append'})
    const call=session.append('tool/call',{turn,step:1,callId,name:'read',arguments:'{}'})
    const result=session.append('tool/result',{turn,step:1,message:createToolResultMessage({callId,isError:false,content:[image]})},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
    session.append('step/end',{turn,step:1})
    session.append('turn/end',{turn,reason:{kind:'completed'}})
    return {assistant:event.seq,toolResult:result.seq,attachment,dataUrl:'data:image/png;base64,'+bytes.toString('base64')}
  }
  ctx.commands.register({name:'fixture-native-image',description:'Persist an image through the official attachment service',handler:async({agent})=>({kind:'success',text:JSON.stringify(await persistImage(agent))})})
  ctx.commands.register({name:'fixture-native-child-image',description:'Completed native child image and ownership fixture',handler:async({agent,signal,rawInput})=>{
    const mode=rawInput.trim()
    const handle=await ctx.agents.create({sessionId:'image-child-'+crypto.randomUUID(),...(mode==='spoof'?{}:{parentAgent:agent}),meta:{cwd:agent.session.header.cwd,parentSession:agent.id,...(mode==='spoof'?{}:{origin:'subagent'})},signal})
    const info={runId:'image-run-'+crypto.randomUUID(),provider:'spawn',id:handle.agent.id,local:true}
    if(mode!=='unobserved')ctx.emit(scopeTarget(agent,agent),'subagent/start',info)
    const image=await persistImage(handle.agent,mode==='red')
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    if(mode!=='unobserved')ctx.emit(scopeTarget(agent,agent),'subagent/end',{...info,stopReason:'completed'})
    return {kind:'success',text:JSON.stringify({...image,childSessionId:info.id,live:!!ctx.agents.get(info.id)})}
  }})
  ctx.commands.register({name:'fixture-image-lineage',description:'Durable nested, fork, missing-parent and cyclic image histories',handler:async({agent,signal,rawInput})=>{
    const mode=rawInput.trim()
    const middleId='image-ancestor-'+crypto.randomUUID()
    const childId='image-descendant-'+crypto.randomUUID()
    const middle=await ctx.agents.create({sessionId:middleId,...(mode==='fork'?{seed:[],inheritedEventCount:0}:{}),meta:{cwd:agent.session.header.cwd,parentSession:mode==='cycle'?childId:agent.id,...(mode==='fork'?{isSeeded:true}:{origin:'subagent'})},signal})
    const handle=await ctx.agents.create({sessionId:childId,meta:{cwd:agent.session.header.cwd,parentSession:mode==='missing'?'absent-native-ancestor':middleId,origin:'subagent'},signal})
    const image=await persistImage(handle.agent)
    await ctx.sessions.flush(handle.agent.session)
    await ctx.sessions.flush(middle.agent.session)
    await handle.dispose()
    await middle.dispose()
    return {kind:'success',text:JSON.stringify({...image,childSessionId:childId})}
  }})
  ctx.commands.register({name:'fixture-goal-output',description:'Consecutive native Goal rounds with delayed official ACP conversion',handler:async({agent})=>{
    await agent.whenIdle()
    ctx.goals.create(agent,{objective:'fixture delayed output',maxGoalRounds:2})
    ctx.goals.disarm(agent)
    const goal=ctx.goals.get(agent)
    const session=agent.session
    const start=(session.snapshotEvents().filter(event=>event.type==='turn/start').at(-1)?.data.turn??0)+1
    for(let round=0;round<=2;round++) {
      const turn=start+round
      const id='goal-output-'+round
      const callId='goal-output-tool-'+round
      const source=round===0?{kind:'user'}:{kind:'goal',goalId:goal.id,revision:goal.revision,round}
      const image=attachmentId=>({type:'image',attachment:{attachmentId,mediaType:'image/png',bytes:19,width:1,height:1}})
      const content=[image(id+'-assistant'),{type:'text',text:'Goal assistant round '+round},{type:'tool-call',id:callId,name:'read',arguments:'{}'}]
      session.append('turn/start',{turn})
      session.append('user/message',{id:id+'-prompt',role:'user',source,content:[{type:'text',text:'Native Goal fixture round '+round}]},{surfaceOp:'append'})
      session.append('step/start',{turn,step:1})
      session.append('request/header',{header:{config:{provider:'deepseek-official',model:'deepseek-flash'},tools:ctx.tools.schemas(agent)},reason:round===0?'initial':'change'})
      session.append('assistant/message',{turn,step:1,message:createAssistantMessage({content,source:{provider:'deepseek-official',model:'deepseek-flash'}}),stream:[]},{surfaceOp:'append'})
      const callSeq=session.append('tool/call',{turn,step:1,callId,name:'read',arguments:'{}'}).seq
      session.append('tool/result',{turn,step:1,message:createToolResultMessage({callId,isError:false,content:[image(id+'-tool'),{type:'text',text:'Goal tool round '+round}]})},{surfaceOp:'append',sourceEventSeqs:[callSeq]})
      session.append('step/end',{turn,step:1})
      session.append('turn/end',{turn,reason:{kind:'completed'}})
      goalOutputs.push({turn,round})
    }
    return {kind:'success',text:JSON.stringify(goalOutputs)}
  }})
  ctx.commands.register({name:'fixture-output-reads',description:'Inspect attachment conversion seam',handler:()=>({kind:'success',text:JSON.stringify(ctx.attachments.reads)})})
  ctx.commands.register({name:'fixture-await-output-read',description:'Wait for the public attachment seam to start',handler:async({rawInput})=>{await ctx.attachments.waitRead(rawInput.trim());return {kind:'success'}}})
  ctx.commands.register({name:'fixture-release-output',description:'Release one official attachment conversion',handler:({rawInput})=>{ctx.attachments.release(rawInput.trim());return {kind:'success'}}})
  ctx.skills.register({name:'fixture-visible',description:'Visible registered skill',source:'runtime',content:'Test instruction'})
  ctx.skills.register({name:'fixture-masked',description:'Uninvocable registered skill',source:'runtime',content:'Test instruction',invocation:{modelInvocable:false,userInvocable:false}})
  ctx.commands.register({name:'fixture-ask',description:'SDK question fixture',handler:async({agent,signal})=>{
    const answer=await ctx.userQuestions.ask({agent,signal,questions:[{id:'decision',question:'Choose a direction',detail:'# Native plan',options:[{label:'Approve'},{label:'Reject'}],intent:{kind:'plan-review',approve:'Approve'}}]})
    return {kind:'success',text:JSON.stringify(answer)}
  }})
  ctx.commands.register({name:'fixture-cold',description:'Make a stored inactive session',handler:async({agent,signal})=>{
    const handle=await ctx.agents.create({sessionId:'cold-native-session',meta:{cwd:agent.session.header.cwd},signal})
    ctx.planMode.set(handle.agent,true)
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    return {kind:'success',text:'cold-native-session'}
  }})
  ctx.commands.register({name:'fixture-read-state',description:'Inspect native live state',handler:({agent})=>({kind:'success',text:JSON.stringify({mode:ctx.planMode.get(agent),coldActive:!!ctx.agents.get('cold-native-session')})})})
  ctx.commands.register({name:'fixture-ask-signal',description:'Question uses its original abort signal',handler:async({agent})=>{
    const controller=new AbortController()
    const question=ctx.userQuestions.ask({agent,signal:controller.signal,questions:[{id:'cancel',question:'Cancel via SDK signal'}]})
    queueMicrotask(()=>controller.abort())
    await question
    return {kind:'success'}
  }})
  ctx.commands.register({name:'fixture-impostor',description:'An equal ID is not an ACP owner',handler:async({agent,signal})=>{
    let code
    try { await ctx.userQuestions.ask({agent:{...agent,id:agent.id,session:agent.session},signal,questions:[{id:'fake',question:'Wrong identity'}]}) } catch(error) {code=error.code}
    return {kind:'success',text:code}
  }})
  ctx.on('agent/pre-step',async(payload,next)=>payload.messages.some(message=>message.content.some(block=>block.type==='text' && block.text.includes('fixture-steer-only')))?{kind:'reject'}:next())
  ctx.commands.register({name:'fixture-child',description:'Native runtime ownership fixture',handler:async({agent,signal})=>{
    const handle=await ctx.agents.create({sessionId:'native-child',parentAgent:agent,meta:{cwd:agent.session.header.cwd,parentSession:agent.id,origin:'subagent'},signal})
    const info={runId:'fixture-run',provider:'spawn',id:handle.agent.id,local:true}
    ctx.emit(scopeTarget(agent,agent),'subagent/start',info)
    ctx.planMode.set(handle.agent,true)
    let questionCode
    try { await ctx.userQuestions.ask({agent:handle.agent,signal,questions:[{id:'child',question:'Child must not ask'}]}) } catch(error) { questionCode=error.code }
    await handle.dispose()
    ctx.emit(scopeTarget(agent,agent),'subagent/end',{...info,stopReason:'completed'})
    return {kind:'success',text:questionCode}
  }})
  ctx.commands.register({name:'fixture-resident-child',description:'A live independently cancellable child',handler:async({agent,signal})=>{
    const handle=await ctx.agents.create({sessionId:'resident-child',parentAgent:agent,meta:{cwd:agent.session.header.cwd,parentSession:agent.id,origin:'subagent'},signal})
    const work=handle.agent.runMaintenance(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>{childInterrupted=true;resolve()},{once:true})))
    ctx.effect(()=>()=>{handle.agent.cancel({kind:'disposed'});return work.then(()=>handle.dispose())})
    return {kind:'success',text:handle.agent.id}
  }})
  ctx.commands.register({name:'fixture-child-state',description:'Observe native child cancellation',handler:()=>({kind:'success',text:String(childInterrupted)})})
  ctx.on('tools/pre-execute',async(exec,next)=>{
    if(exec.name==='bash' && exec.arguments.command==='printf NATIVE_BASH_APPROVAL_OK')return {kind:'ask',reason:'Inspect the exact official bash approval payload'}
    const decision=await next()
    return decision.kind==='allow' && exec.agent?.id.startsWith('approval-child-')?{kind:'ask',reason:'Fixture child read approval'}:decision
  })
  ctx.commands.register({name:'fixture-root-bash-approval',description:'Official root bash tool and stock ACP approval transport',handler:async({agent,signal})=>{
    const session=agent.session
    const turn=(session.snapshotEvents().filter(event=>event.type==='turn/start').at(-1)?.data.turn??0)+1
    const callId='root-bash-'+crypto.randomUUID()
    const args={command:'printf NATIVE_BASH_APPROVAL_OK',description:'Print the native bash approval fixture',workdir:agent.session.header.cwd}
    session.append('turn/start',{turn})
    session.append('step/start',{turn,step:1})
    session.append('assistant/message',{turn,step:1,message:createAssistantMessage({content:[{type:'tool-call',id:callId,name:'bash',arguments:JSON.stringify(args)}],source:{provider:'deepseek-official',model:'deepseek-flash'}}),stream:[]},{surfaceOp:'append'})
    const call=session.append('tool/call',{turn,step:1,callId,name:'bash',arguments:JSON.stringify(args)})
    try {
      const result=await ctx.tools.execute({agent,callId,name:'bash',arguments:args,signal})
      session.append('tool/result',{turn,step:1,message:createToolResultMessage({callId,content:result.content,isError:result.isError})},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
      return {kind:'success',text:JSON.stringify({callId,result})}
    } finally {
      session.append('step/end',{turn,step:1})
      session.append('turn/end',{turn,reason:{kind:'completed'}})
    }
  }})
  ctx.commands.register({name:'fixture-child-read',description:'Execute an official read tool in an owned child',handler:async({agent,signal})=>{
    const id='approval-child-'+crypto.randomUUID()
    const handle=await ctx.agents.create({sessionId:id,parentAgent:agent,meta:{cwd:agent.session.header.cwd,parentSession:agent.id,origin:'subagent'},signal})
    const session=handle.agent.session
    const callId='child-read-'+crypto.randomUUID()
    const toolCall={type:'tool-call',id:callId,name:'read',arguments:JSON.stringify({file_path:agent.session.header.cwd+'/readable.txt'})}
    session.append('turn/start',{turn:1})
    session.append('step/start',{turn:1,step:1})
    session.append('request/header',{header:{config:{provider:'deepseek-official',model:'deepseek-flash'},tools:ctx.tools.schemas(handle.agent)},reason:'initial'})
    session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[toolCall],source:{provider:'deepseek-official',model:'deepseek-flash'}}),stream:[]},{surfaceOp:'append'})
    const callSeq=session.append('tool/call',{turn:1,step:1,callId,name:'read',arguments:toolCall.arguments}).seq
    try {
      const result=await ctx.tools.execute({agent:handle.agent,callId,name:'read',arguments:{file_path:agent.session.header.cwd+'/readable.txt'},signal})
      session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId,content:result.content,isError:result.isError})},{surfaceOp:'append',sourceEventSeqs:[callSeq]})
      return {kind:'success',text:JSON.stringify({childSessionId:id,result})}
    } finally {
      session.append('step/end',{turn:1,step:1})
      session.append('turn/end',{turn:1,reason:{kind:'completed'}})
      await handle.dispose()
    }
  }})
}
`)
  const fixturePatch = [
    { id: 'acp', disabled: true },
    { id: 'otel', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'hmr', disabled: true },
    { id: 'attachment-local', disabled: true },
    { insert: [
      { id: 'native-delayed-attachments', name: pathToFileURL(join(fixture, 'attachments.mjs')).href },
      { id: 'uniagent-bridge', name: pathToFileURL(join(fixture, 'bridge.mjs')).href, inject: ['acpAppStartup'], config: { provider: 'deepseek-official', model: 'deepseek-flash', sessionListPageSize: 2 } },
      { id: 'native-fixture', name: pathToFileURL(join(fixture, 'fixture.mjs')).href }
    ] }
  ]
  await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify(fixturePatch))
  child = startHarness()
  const initialized = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'uniagent-isolated-probe' }, clientCapabilities: {} })
  assert.equal(initialized.agentInfo.name, 'deepseek-harness-acp', 'official ACP handshake remains unchanged')
  assert.equal(initialized.agentCapabilities.promptCapabilities.image, true, 'the ordinary ACP connection advertises inline image input')
  assert.deepEqual(initialized._meta['uniagent/bridge'], { version: 1 })
  const created = await request('session/new', { cwd: fixture, mcpServers: [] })
  const sessionId = created.sessionId
  assert.equal(typeof sessionId, 'string')

  const capabilities = await request('_uniagent/capabilities', { sessionId })
  assert.equal(capabilities.version, 1)
  assert.equal(capabilities.flags.history, true)
  assert.equal(capabilities.flags.planMode, true)
  assert.equal(capabilities.flags.questions, true)
  assert.equal(capabilities.flags.steer, true)
  assert.equal(capabilities.flags.sessionForkAtTurn, true)
  assert.equal(capabilities.flags.nativeGoal, true)
  assert.ok(capabilities.commands.some((entry: any) => entry.name === 'compact'))
  assert.equal((await request('_uniagent/goal_get', { sessionId })).goal, null)
  const unsupportedBudget = await rpc('_uniagent/goal_set', { sessionId, objective: 'rounds do not mean tokens', tokenBudget: 100 })
  assert.equal(unsupportedBudget.error.code, -32602)
  const pluginManagement = await request('_uniagent/plugin_action', { sessionId, action: 'list' })
  assert.ok(Array.isArray(pluginManagement.plugins))

  const mode = await request('_uniagent/set_mode', { sessionId, mode: 'plan' })
  assert.equal(mode.active, true)
  assert.equal(mode.change, 'committed')
  const state = await command(sessionId, '/fixture-read-state')
  assert.equal(JSON.parse(state.result.text).mode.active, true, 'extension changes actual native Plan state')
  const liveHistory = await request('_uniagent/history', { sessionId })
  assert.equal(liveHistory.session.id, sessionId)
  assert.ok(liveHistory.events.some((event: any) => event.type === 'plan/mode' && event.data.active))
  assert.ok(liveHistory.events.some((event: any) => event.type === 'sandbox/mode' && event.data.mode === 'read-only'), 'Plan selection sets native sandbox to read-only')
  await until(() => messages.some(message => message.method === '_uniagent/session_update' && message.params.sessionId === sessionId && message.params.kind === 'projection' && message.params.key === 'plan' && message.params.value.active))
  assert.ok(messages.some(message => message.method === '_uniagent/session_update' && message.params.kind === 'event' && message.params.event.type === 'plan/mode'))

  await command(sessionId, '/fixture-cold')
  const sessionFiles = await readdir(join(home, 'sessions'), { recursive: true })
  const coldFile = sessionFiles.find(file => file.includes('cold-native-session/') && /\.jsonl(?:\.zstd)?$/.test(file))
  assert.ok(coldFile, 'native stored session has an actual JSONL artifact')
  const coldBefore = await readFile(join(home, 'sessions', coldFile))
  const cold = await request('_uniagent/history', { sessionId: 'cold-native-session' })
  assert.equal(cold.session.id, 'cold-native-session')
  assert.ok(cold.events.some((event: any) => event.type === 'plan/mode' && event.data.active))
  assert.equal(JSON.parse((await command(sessionId, '/fixture-read-state')).result.text).coldActive, false, 'history does not activate stored sessions')
  assert.deepEqual(await readFile(join(home, 'sessions', coldFile)), coldBefore, 'cold history is read-only')

  const inventory = await request('_uniagent/inventory', { sessionId })
  assert.ok(inventory.tools.some((tool: any) => tool.name === 'exit_plan_mode'))
  assert.equal(inventory.tools.some((tool: any) => tool.name === 'write'), false, 'Plan inventory applies the same pure role tool filter as execution')
  assert.ok(inventory.commands.some((entry: any) => entry.name === 'fixture-ask'))
  assert.ok(inventory.skills.some((entry: any) => entry.name === 'fixture-visible'))
  assert.equal(inventory.skills.some((entry: any) => entry.name === 'fixture-masked'), false)
  assert.ok(inventory.plugins.entries.some((entry: any) => entry.moduleName.includes('bridge.mjs')))
  assert.equal(JSON.stringify(inventory).includes('apiKey'), false)
  assert.equal(inventory.plugins.entries.some((entry: any) => Object.hasOwn(entry, 'config')), false)
  assert.equal(inventory.plugins.managementAvailable, true)
  const protectedPlugins = inventory.plugins.entries.filter((entry: any) => entry.moduleName.includes('bridge.mjs') || entry.moduleName === '@deepseek-ai/dsh-acp')
  assert.ok(protectedPlugins.length >= 2)
  assert.ok(protectedPlugins.every((entry: any) => entry.manageable === false && entry.readOnlyReason === 'management-required'), 'transport and policy entries cannot be offered for management')
  const nativeList = await request('_uniagent/list_sessions', { cwd: fixture })
  assert.ok(nativeList.sessions.some((entry: any) => entry.sessionId === 'cold-native-session' && !entry.live))
  assert.equal((await rpc('_uniagent/list_sessions', { cwd: 'relative/path' })).error.code, -32602)
  assert.equal((await rpc('_uniagent/list_sessions', { cursor: 'invalid' })).error.code, -32602)
  const bashApprovalOffset = messages.length
  const bashApprovalSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  const rootBash = rpc('_uniagent/command', { sessionId: bashApprovalSessionId, line: '/fixture-root-bash-approval' }).catch(error => ({ error }))
  const rootBashPermission = await until(() => messages.slice(bashApprovalOffset).find(message => message.method === 'session/request_permission'))
  assert.deepEqual(Object.keys(rootBashPermission.params.toolCall), ['toolCallId'], 'official root ACP approval sends only the correlation ID')
  const bashCallId = rootBashPermission.params.toolCall.toolCallId
  const bashStock = messages.slice(bashApprovalOffset).find(message => message.method === 'session/update' && message.params.update.toolCallId === bashCallId && message.params.update.sessionUpdate === 'tool_call')
  assert.ok(bashStock, 'official ACP drains the preceding tool call before asking approval')
  assert.equal(bashStock.params.update.title, 'bash')
  assert.equal(bashStock.params.update.kind, 'other', 'stock ACP presents bash as a generic tool before execution')
  assert.equal(bashStock.params.update.rawInput.command, 'printf NATIVE_BASH_APPROVAL_OK', 'real command arguments are already parsed by the official ACP tool update')
  assert.ok(Number.isSafeInteger(bashStock.params._meta['uniagent/nativeOutput'].turn), 'the standard tool update carries the native-output deduplication marker')
  const bashNative = messages.slice(bashApprovalOffset).find(message => message.params?.kind === 'event' && message.params.event.type === 'tool/call' && message.params.event.data.callId === bashCallId)
  assert.equal(JSON.parse(bashNative.params.event.data.arguments).command, 'printf NATIVE_BASH_APPROVAL_OK')
  send({ jsonrpc: '2.0', id: rootBashPermission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  const rootBashResponse = await rootBash
  assert.equal(rootBashResponse.error, undefined)
  const rootBashResult = JSON.parse(rootBashResponse.result.result.text)
  assert.equal(rootBashResult.result.isError, false)
  assert.ok(JSON.stringify(rootBashResult.result.content).includes('NATIVE_BASH_APPROVAL_OK'), 'a one-shot approval executes the real official bash tool')
  await request('session/close', { sessionId: bashApprovalSessionId })
  for (let read = 0; read < 2; read++) {
    const { reading, permission } = await startChildRead(sessionId)
    assert.equal(permission.params.sessionId, sessionId, 'child approval routes through its owning ACP root')
    assert.match(permission.params._meta.childSessionId, /^approval-child-/)
    assert.match(permission.id, /^uniagent:/)
    const option = permission.params.options.find((option: any) => option.kind === 'allow_once')
    assert.ok(option, 'each native child read requires a fresh ACP one-shot grant')
    send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } })
    const response = await reading
    assert.equal(response.error, undefined)
    const nativeRead = JSON.parse(response.result.result.text)
    assert.equal(nativeRead.childSessionId, permission.params._meta.childSessionId)
    assert.equal(nativeRead.result.isError, false)
    assert.ok(JSON.stringify(nativeRead.result.content).includes('native child read reached the filesystem'), 'grant actually executes the official filesystem read')
    const childHistory = await request('_uniagent/history', { sessionId: nativeRead.childSessionId })
    assert.ok(childHistory.events.some((event: any) => event.type === 'approval/decided' && event.data.outcome === 'allowed-once'), 'native child owns the approval audit record')
  }
  for (const [outcome, answer] of [
    ['rejected', { outcome: { outcome: 'selected', optionId: 'reject-once' } }],
    ['cancelled', { outcome: { outcome: 'cancelled' } }],
    ['unavailable', { outcome: { optionId: 'allow-once' } }],
    ['unavailable', { outcome: { outcome: 'selected', optionId: 'unknown-grant' } }]
  ] as const) {
    const { reading, permission } = await startChildRead(sessionId)
    send({ jsonrpc: '2.0', id: permission.id, result: answer })
    const response = await reading
    assert.equal(response.error, undefined)
    const nativeRead = JSON.parse(response.result.result.text)
    assert.equal(nativeRead.result.isError, true, outcome + ' never grants the filesystem read')
    const childHistory = await request('_uniagent/history', { sessionId: nativeRead.childSessionId })
    assert.ok(childHistory.events.some((event: any) => event.type === 'approval/decided' && event.data.outcome === outcome))
  }
  const cancelledRead = await startChildRead(sessionId)
  const continuingRead = await startChildRead(sessionId)
  await request('_uniagent/subagent_cancel', { sessionId, childSessionId: cancelledRead.permission.params._meta.childSessionId })
  const cancellationResponse = await cancelledRead.reading
  assert.equal(cancellationResponse.error, undefined)
  const cancellationResult = JSON.parse(cancellationResponse.result.result.text)
  assert.equal(cancellationResult.result.isError, true, 'child cancel retires its pending native permission')
  send({ jsonrpc: '2.0', id: cancelledRead.permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  send({ jsonrpc: '2.0', id: continuingRead.permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  assert.equal(JSON.parse((await continuingRead.reading).result.result.text).result.isError, false, 'a cancelled sibling and late reply cannot satisfy or cancel another child')
  const cancelledReadHistory = await request('_uniagent/history', { sessionId: cancellationResult.childSessionId })
  assert.ok(cancelledReadHistory.events.some((event: any) => event.type === 'approval/decided' && event.data.outcome === 'cancelled'))
  const parentCancelledRead = await startChildRead(sessionId)
  send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  const parentCancellation = await parentCancelledRead.reading
  assert.ok(parentCancellation.error || JSON.parse(parentCancellation.result.result.text).result.isError, 'parent cancellation never grants the child read')
  send({ jsonrpc: '2.0', id: parentCancelledRead.permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  assert.equal((await command(sessionId, '/fixture-read-state')).result.kind, 'success', 'late cancelled approval never reaches stock ACP correlation')

  const goalOutputOffset = messages.length
  const goalSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  const goalOutput = await command(goalSessionId, '/fixture-goal-output')
  const outputRounds = JSON.parse(goalOutput.result.text)
  await command(goalSessionId, '/fixture-await-output-read goal-output-0-assistant')
  const goalMessages = messages.slice(goalOutputOffset).filter(message => message.params?.sessionId === goalSessionId)
  for (const { turn, round } of outputRounds.filter(({ round }: any) => round > 0)) {
    const running = goalMessages.findIndex(message => message.params?.kind === 'goal_turn' && message.params.state === 'running' && message.params.turn === turn)
    const terminal = goalMessages.findIndex(message => message.params?.kind === 'goal_turn' && message.params.state === 'success' && message.params.turn === turn)
    assert.ok(running >= 0 && terminal > running)
    assert.equal(goalMessages[terminal].params.output, 'native-events')
    const events = goalMessages.slice(running + 1, terminal).filter(message => message.params?.kind === 'event' && message.params.goalRound?.turn === turn)
    assert.ok(events.some(message => message.params.event.type === 'assistant/message' && JSON.stringify(message.params.event.data).includes('Goal assistant round ' + round)), 'authoritative assistant precedes terminal while stock conversion is blocked')
    assert.ok(events.some(message => message.params.event.type === 'tool/result' && JSON.stringify(message.params.event.data).includes('Goal tool round ' + round)), 'authoritative tool result precedes terminal while stock conversion is blocked')
    assert.equal(events.at(-1).params.event.type, 'turn/end')
  }
  assert.equal(goalMessages.some(message => message.method === 'session/update' && ['agent_message_chunk', 'tool_call', 'tool_call_update'].includes(message.params.update.sessionUpdate)), false, 'both native Goal rounds finish before delayed official conversion')
  for (const { turn, round } of outputRounds) {
    for (const kind of ['assistant', 'tool']) {
      const attachmentId = 'goal-output-' + round + '-' + kind
      await command(goalSessionId, '/fixture-await-output-read ' + attachmentId)
      await command(goalSessionId, '/fixture-release-output ' + attachmentId)
      const stock = await until(() => messages.slice(goalOutputOffset).find(message => message.method === 'session/update' && (kind === 'assistant' ? message.params.update.content?.text === 'Goal assistant round ' + round : message.params.update.toolCallId === 'goal-output-tool-' + round && message.params.update.sessionUpdate === 'tool_call_update')))
      assert.equal(stock.params._meta['uniagent/nativeOutput'].turn, turn, 'late stock update retains its source regular or Goal turn')
      assert.equal(stock.params._meta['uniagent/nativeOutput'].round, round)
      const raw = goalMessages.find(message => message.params?.kind === 'event' && message.params.event.type === (kind === 'assistant' ? 'assistant/message' : 'tool/result') && message.params.event.data.turn === turn)
      assert.ok(raw.params.event.data.message.content.some((block: any) => block.type === 'image'), 'native authority retains full attachment content')
      if (kind === 'assistant') await until(() => messages.some(message => message.method === 'session/update' && message.params.update.toolCallId === 'goal-output-tool-' + round))
    }
  }
  await request('session/close', { sessionId: goalSessionId })
  const imageSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  const nativeImage = JSON.parse((await command(imageSessionId, '/fixture-native-image')).result.text)
  for (const [eventSeq, toolResult] of [[nativeImage.assistant, false], [nativeImage.toolResult, true]] as const) {
    const result = await request('_uniagent/read_image', { sessionId: imageSessionId, eventSeq, blockIndex: 0, ...(toolResult ? { toolResult } : {}) })
    assert.match(result.dataUrl, /^data:image\/png;base64,/)
    assert.ok(Buffer.from(result.dataUrl.split(',')[1], 'base64').byteLength > 0, 'native public attachment store returns actual verified image bytes')
  }
  for (const params of [
    { eventSeq: nativeImage.assistant, blockIndex: 1 },
    { eventSeq: nativeImage.assistant, blockIndex: 0, toolResult: true },
    { eventSeq: nativeImage.assistant, blockIndex: 0, attachment: nativeImage.attachment },
    { eventSeq: nativeImage.assistant, blockIndex: 0, path: '/private/image.png' },
    { eventSeq: -1, blockIndex: 0 }
  ]) assert.equal((await rpc('_uniagent/read_image', { sessionId: imageSessionId, ...params })).error.code, -32602, 'image reads accept only an exact recorded image selector')
  assert.equal((await rpc('_uniagent/read_image', { sessionId, eventSeq: nativeImage.assistant, blockIndex: 0 })).error.code, -32602, 'a selector never reads an image from another session')
  const nativeChildImage = JSON.parse((await command(imageSessionId, '/fixture-native-child-image')).result.text)
  const otherChildImage = JSON.parse((await command(sessionId, '/fixture-native-child-image red')).result.text)
  assert.equal(nativeChildImage.live, false, 'image fixture child is disposed before RPC reads')
  assert.equal(nativeChildImage.assistant, otherChildImage.assistant, 'separate native children reuse sequence numbers')
  assert.notEqual(nativeChildImage.dataUrl, otherChildImage.dataUrl, 'same-sequence fixtures have distinct image bytes')
  for (const [ownerSessionId, image] of [[imageSessionId, nativeChildImage], [sessionId, otherChildImage]] as const) {
    for (const [eventSeq, toolResult] of [[image.assistant, false], [image.toolResult, true]] as const) {
      const result = await request('_uniagent/read_image', { sessionId: ownerSessionId, childSessionId: image.childSessionId, eventSeq, blockIndex: 0, ...(toolResult ? { toolResult } : {}) })
      assert.equal(result.dataUrl, image.dataUrl, 'completed owned children retain access to their exact native image history')
    }
  }
  const unobservedImage = JSON.parse((await command(imageSessionId, '/fixture-native-child-image unobserved')).result.text)
  const spoofedImage = JSON.parse((await command(imageSessionId, '/fixture-native-child-image spoof')).result.text)
  const nestedImage = JSON.parse((await command(imageSessionId, '/fixture-image-lineage nested')).result.text)
  const invalidLineageImages = []
  for (const mode of ['fork', 'missing', 'cycle']) invalidLineageImages.push(JSON.parse((await command(imageSessionId, '/fixture-image-lineage ' + mode)).result.text))
  for (const image of [unobservedImage, nestedImage]) {
    const result = await request('_uniagent/read_image', { sessionId: imageSessionId, childSessionId: image.childSessionId, eventSeq: image.assistant, blockIndex: 0 })
    assert.equal(result.dataUrl, image.dataUrl, 'valid native subagent ancestry grants image reads without a live observation')
  }
  for (const childSessionId of [otherChildImage.childSessionId, spoofedImage.childSessionId, ...invalidLineageImages.map(image => image.childSessionId), 'unknown-child', 'cold-native-session', imageSessionId, '', 123]) {
    assert.equal((await rpc('_uniagent/read_image', { sessionId: imageSessionId, childSessionId, eventSeq: nativeChildImage.assistant, blockIndex: 0 })).error.code, -32602, 'child image access requires an exact runtime ownership observation by this root')
  }
  await request('session/close', { sessionId: imageSessionId })
  assert.equal((await request('_uniagent/read_image', { sessionId: imageSessionId, childSessionId: nativeChildImage.childSessionId, eventSeq: nativeChildImage.assistant, blockIndex: 0 })).dataUrl, nativeChildImage.dataUrl, 'a closed root reads its completed child without activation')
  await request('session/resume', { sessionId: imageSessionId, cwd: fixture, mcpServers: [] })
  assert.equal((await request('_uniagent/read_image', { sessionId: imageSessionId, childSessionId: nativeChildImage.childSessionId, eventSeq: nativeChildImage.assistant, blockIndex: 0 })).dataUrl, nativeChildImage.dataUrl, 'a resumed root verifies completed child ownership from native persisted ancestry')
  await request('session/close', { sessionId: imageSessionId })

  const steerSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  const activeSteerOffset = messages.length
  const activeSteer = rpc('session/prompt', { sessionId: steerSessionId, prompt: [{ type: 'text', text: 'fixture-active-steer' }] }).catch(error => ({ error }))
  const activeRequest = await until(() => messages.slice(activeSteerOffset).find(message => message.params?.sessionId === steerSessionId && message.params.kind === 'event' && message.params.event.type === 'request/header'))
  assert.equal(activeRequest.params.event.data.header.config.model, 'deepseek-flash')
  const steerPrompt = [
    { type: 'text', text: 'Read this during the current turn: ' },
    { type: 'image', mimeType: 'image/png', data: nativeImage.dataUrl.split(',')[1] },
    { type: 'resource_link', name: 'readable.txt', uri: pathToFileURL(join(fixture, 'readable.txt')).href, mimeType: 'text/plain' },
    { type: 'text', text: ' then continue.' }
  ]
  assert.deepEqual(await request('_uniagent/steer', { sessionId: steerSessionId, prompt: steerPrompt }), { accepted: true })
  assert.deepEqual(await request('_uniagent/steer', { sessionId: steerSessionId, text: 'Legacy steer text' }), { accepted: true })
  const selectedOptions = await request('session/set_config_option', { sessionId: steerSessionId, configId: 'model', value: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']) })
  assert.equal(selectedOptions.configOptions.find((option: any) => option.id === 'model').currentValue, JSON.stringify(['deepseek-official', 'deepseek-v4-pro']))
  assert.deepEqual(await request('_uniagent/steer', { sessionId: steerSessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: steerPrompt[1].data }] }), { accepted: true }, 'the active Flash turn retains its pinned route after future model selection changes to Pro')
  const limits = JSON.parse((await command(steerSessionId, '/fixture-steer-state')).result.text).limits
  const imageBlock = steerPrompt[1]
  const badSteerParams = [
    { prompt: [] }, { prompt: {} }, { prompt: [{ type: 'text', text: '   ' }] }, { prompt: [{ type: 'text', text: 1 }] },
    { prompt: [{ type: 'image', mimeType: 'image/png', data: imageBlock.data + '\n' }] },
    { prompt: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    { prompt: [{ type: 'image', mimeType: 'image/png', data: 123 }] },
    { prompt: [{ type: 'image', mimeType: 'image/svg+xml', data: imageBlock.data }] },
    { prompt: [{ type: 'image', mimeType: 'image/jpeg', data: imageBlock.data }] },
    { prompt: Array.from({ length: limits.maxImagesPerMessage + 1 }, () => imageBlock) },
    { prompt: [{ type: 'resource', resource: { uri: 'file:///private/file.txt', text: 'embedded input' } }] },
    { prompt: [{ type: 'resource_link', uri: 'file:///private/file.txt', name: 123 }] },
    { prompt: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] },
    { prompt: [{ type: 'file', attachment: nativeImage.attachment }] },
    { prompt: [{ type: 'image', attachment: nativeImage.attachment }] },
    { prompt: [{ type: 'text', text: 'ambiguous' }], text: 'ambiguous legacy' }
  ]
  const beforeInvalid = await request('_uniagent/history', { sessionId: steerSessionId })
  for (const params of badSteerParams) assert.equal((await rpc('_uniagent/steer', { sessionId: steerSessionId, ...params })).error.code, -32602, 'invalid steer attachments or mixed selectors cannot enqueue user input')
  const afterInvalid = await request('_uniagent/history', { sessionId: steerSessionId })
  assert.deepEqual(afterInvalid.events, beforeInvalid.events, 'rejected image admission never changes the durable inbox')
  const steerInsertion = afterInvalid.events.find((event: any) => event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('Read this during'))
  assert.equal(steerInsertion.data.target, 'next-step', 'steer never becomes queued next-turn work')
  assert.ok(steerInsertion.data.inserted[0].content.some((block: any) => block.type === 'image' && block.attachment?.attachmentId))
  assert.equal(JSON.stringify(steerInsertion.data).includes(imageBlock.data), false, 'durable steer image uses a verified attachment reference without encoded bytes')
  await command(steerSessionId, '/fixture-release-steer')
  const finishedSteer = await activeSteer
  assert.equal(finishedSteer.error, undefined)
  const completedSteer = await request('_uniagent/history', { sessionId: steerSessionId })
  const steerMessage = completedSteer.events.find((event: any) => event.type === 'user/message' && event.data.id === steerInsertion.data.inserted[0].id)
  assert.equal(steerMessage.data.content[0].text, 'Read this during the current turn: ')
  assert.equal(steerMessage.data.content[1].type, 'image')
  assert.equal(steerMessage.data.content[2].text, '\n[resource_link name="readable.txt" uri=' + JSON.stringify(steerPrompt[2].uri) + ']\n then continue.', 'file links use the same ordered text vocabulary as stock ACP')
  const steerState = JSON.parse((await command(steerSessionId, '/fixture-steer-state')).result.text)
  const initialTurn = completedSteer.events.find((event: any) => event.type === 'turn/start').data.turn
  assert.equal(steerState.claimed.find((entry: any) => entry.message.id === steerMessage.data.id).turn, initialTurn, 'active native steer is claimed in the current turn')
  assert.equal(completedSteer.events.filter((event: any) => event.type === 'turn/start').length, 1, 'image steer does not create a new user turn')
  assert.equal(completedSteer.events.filter((event: any) => event.type === 'request/header').every((event: any) => event.data.header.config.model === 'deepseek-flash'), true, 'active requests remain pinned to their original Flash route')
  const proSteer = await rpc('_uniagent/steer', { sessionId: steerSessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: imageBlock.data }] })
  assert.equal(proSteer.error.code, -32602, 'the selected future Pro route rejects images once the Flash turn ends')
  await request('session/close', { sessionId: steerSessionId })
  const lateSteerSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  const lateSteerOffset = messages.length
  const lateActive = rpc('session/prompt', { sessionId: lateSteerSessionId, prompt: [{ type: 'text', text: 'fixture-active-steer' }] }).catch(error => ({ error }))
  await until(() => messages.slice(lateSteerOffset).find(message => message.params?.sessionId === lateSteerSessionId && message.params.kind === 'event' && message.params.event.type === 'request/header'))
  await command(lateSteerSessionId, '/fixture-hold-admission')
  const lateImage = rpc('_uniagent/steer', { sessionId: lateSteerSessionId, prompt: [imageBlock] }).catch(error => ({ error }))
  await command(lateSteerSessionId, '/fixture-await-admission')
  assert.equal((await command(lateSteerSessionId, '/fixture-admission-state')).result.text, 'true', 'verified image admission is pending during the active native turn')
  await command(lateSteerSessionId, '/fixture-release-steer')
  assert.equal((await lateActive).error, undefined)
  const endedBeforeAdmission = await request('_uniagent/history', { sessionId: lateSteerSessionId })
  await command(lateSteerSessionId, '/fixture-release-admission')
  assert.equal((await lateImage).error.code, -32602, 'image admission finishing after its active turn cannot enqueue input into a later turn')
  const lateHistory = await request('_uniagent/history', { sessionId: lateSteerSessionId })
  assert.equal(lateHistory.events.slice(endedBeforeAdmission.events.length).some((event: any) => event.type === 'agent/inbox/spliced' || event.type === 'user/message' || event.type === 'turn/start'), false, 'late verified images never mutate the completed turn or future inbox')
  await request('session/close', { sessionId: lateSteerSessionId })
  const idleSteerSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  await command(idleSteerSessionId, '/fixture-hold-admission')
  const idleImage = rpc('_uniagent/steer', { sessionId: idleSteerSessionId, prompt: [imageBlock] }).catch(error => ({ error }))
  await command(idleSteerSessionId, '/fixture-await-admission')
  const idleSteerOffset = messages.length
  const newlyActive = rpc('session/prompt', { sessionId: idleSteerSessionId, prompt: [{ type: 'text', text: 'fixture-active-steer' }] }).catch(error => ({ error }))
  await until(() => messages.slice(idleSteerOffset).find(message => message.params?.sessionId === idleSteerSessionId && message.params.kind === 'event' && message.params.event.type === 'request/header'))
  await command(idleSteerSessionId, '/fixture-await-steer')
  await command(idleSteerSessionId, '/fixture-release-admission')
  assert.equal((await idleImage).error?.code, -32602, 'steer image admitted while idle cannot enter a new ordinary turn started during image persistence')
  const newlyActiveHistory = await request('_uniagent/history', { sessionId: idleSteerSessionId })
  assert.equal(newlyActiveHistory.events.some((event: any) => event.type === 'agent/inbox/spliced' && event.data.inserted.some((message: any) => message.content.some((block: any) => block.type === 'image'))), false, 'idle admission rejected after a new turn starts never inserts an image into that turn inbox')
  await command(idleSteerSessionId, '/fixture-release-steer')
  assert.equal((await newlyActive).error, undefined)
  await command(idleSteerSessionId, '/fixture-hold-admission')
  const unchangedIdleImage = rpc('_uniagent/steer', { sessionId: idleSteerSessionId, prompt: [{ type: 'text', text: 'fixture-steer-only idle image' }, imageBlock] }).catch(error => ({ error }))
  await command(idleSteerSessionId, '/fixture-await-admission')
  await command(idleSteerSessionId, '/fixture-release-admission')
  assert.deepEqual((await unchangedIdleImage).result, { accepted: true }, 'idle image admission remains supported when the native turn state stays idle until enqueue')
  await request('session/close', { sessionId: idleSteerSessionId })

  const earlyRouteSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  await request('session/set_config_option', { sessionId: earlyRouteSessionId, configId: 'model', value: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']) })
  await command(earlyRouteSessionId, '/fixture-hold-driver')
  const earlyRouteOffset = messages.length
  const earlierProPrompt = rpc('session/prompt', { sessionId: earlyRouteSessionId, prompt: [{ type: 'text', text: 'fixture-active-steer' }] }).catch(error => ({ error }))
  await until(() => messages.slice(earlyRouteOffset).find(message => message.params?.sessionId === earlyRouteSessionId && message.params.kind === 'event' && message.params.event.type === 'agent/inbox/spliced' && message.params.event.data.inserted.some((input: any) => input.content.some((block: any) => block.text === 'fixture-active-steer'))))
  await request('session/set_config_option', { sessionId: earlyRouteSessionId, configId: 'model', value: JSON.stringify(['deepseek-official', 'deepseek-flash']) })
  await command(earlyRouteSessionId, '/fixture-hold-assembly')
  await command(earlyRouteSessionId, '/fixture-release-driver')
  await command(earlyRouteSessionId, '/fixture-await-assembly')
  assert.ok(messages.slice(earlyRouteOffset).some(message => message.params?.sessionId === earlyRouteSessionId && message.params.event?.type === 'turn/start'))
  assert.equal(messages.slice(earlyRouteOffset).some(message => message.params?.sessionId === earlyRouteSessionId && message.params.event?.type === 'request/header'), false, 'native turn starts and claims its pinned Pro input before the first request header')
  const beforeFirstHeader = await rpc('_uniagent/steer', { sessionId: earlyRouteSessionId, prompt: [imageBlock] })
  assert.equal(beforeFirstHeader.error?.code, -32602, 'future Flash selection cannot grant image steer before the earlier Pro turn route is resolved')
  await command(earlyRouteSessionId, '/fixture-release-assembly')
  await command(earlyRouteSessionId, '/fixture-await-steer')
  const earlyProHeader = messages.slice(earlyRouteOffset).find(message => message.params?.sessionId === earlyRouteSessionId && message.params.event?.type === 'request/header')
  assert.equal(earlyProHeader.params.event.data.header.config.model, 'deepseek-v4-pro', 'stock ACP pins the original Pro prompt despite the future Flash selection')
  await command(earlyRouteSessionId, '/fixture-release-steer')
  assert.equal((await earlierProPrompt).error, undefined)
  await request('session/close', { sessionId: earlyRouteSessionId })

  const changingRouteSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  const changingRouteOffset = messages.length
  const changingRoutePrompt = rpc('session/prompt', { sessionId: changingRouteSessionId, prompt: [{ type: 'text', text: 'fixture-active-steer' }] }).catch(error => ({ error }))
  await command(changingRouteSessionId, '/fixture-await-steer')
  await command(changingRouteSessionId, '/fixture-hold-admission')
  const changingRouteImage = rpc('_uniagent/steer', { sessionId: changingRouteSessionId, prompt: [imageBlock] }).catch(error => ({ error }))
  await command(changingRouteSessionId, '/fixture-await-admission')
  await request('_uniagent/steer', { sessionId: changingRouteSessionId, text: 'Continue the same turn after a public route change' })
  await command(changingRouteSessionId, '/fixture-set-request-route deepseek-v4-pro')
  await command(changingRouteSessionId, '/fixture-hold-next-stream')
  await command(changingRouteSessionId, '/fixture-release-steer')
  await command(changingRouteSessionId, '/fixture-await-next-stream')
  assert.ok(messages.slice(changingRouteOffset).some(message => message.params?.sessionId === changingRouteSessionId && message.params.event?.type === 'request/header' && message.params.event.data.header.config.model === 'deepseek-v4-pro'), 'a public request plugin changes the effective route within the same native turn')
  await command(changingRouteSessionId, '/fixture-release-admission')
  assert.equal((await changingRouteImage).error?.code, -32602, 'a corrected effective route invalidates image admission started under Flash')
  await command(changingRouteSessionId, '/fixture-release-next-stream')
  assert.equal((await changingRoutePrompt).error, undefined)
  await request('session/close', { sessionId: changingRouteSessionId })

  const idleModelSessionId = (await request('session/new', { cwd: fixture, mcpServers: [] })).sessionId
  await command(idleModelSessionId, '/fixture-hold-admission')
  const idleModelImage = rpc('_uniagent/steer', { sessionId: idleModelSessionId, prompt: [imageBlock] }).catch(error => ({ error }))
  await command(idleModelSessionId, '/fixture-await-admission')
  await request('session/set_config_option', { sessionId: idleModelSessionId, configId: 'model', value: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']) })
  await command(idleModelSessionId, '/fixture-release-admission')
  assert.equal((await idleModelImage).error?.code, -32602, 'an idle model selection change invalidates image admission even without a turn transition')
  await request('session/close', { sessionId: idleModelSessionId })

  const offset = messages.length
  const asking = command(sessionId, '/fixture-ask')
  const question = await until(() => messages.slice(offset).find(message => message.method === '_uniagent/ask_user_question'))
  assert.match(question.id, /^uniagent:/)
  assert.equal(question.params.sessionId, sessionId)
  assert.equal(question.params.questions[0].intent.kind, 'plan-review')
  assert.equal(question.params.questions[0].detail, '# Native plan')
  send({ jsonrpc: '2.0', id: question.id, result: { answers: [{ id: 'decision', selected: ['Approve'] }] } })
  assert.deepEqual(JSON.parse((await asking).result.text), { answers: [{ id: 'decision', selected: ['Approve'] }] })

  const malformedOffset = messages.length
  const malformedAsk = rpc('_uniagent/command', { sessionId, line: '/fixture-ask' })
  const malformedQuestion = await until(() => messages.slice(malformedOffset).find(message => message.method === '_uniagent/ask_user_question'))
  send({ jsonrpc: '2.0', id: malformedQuestion.id, result: { answers: [{ id: 'decision', selected: [123] }] } })
  assert.equal((await malformedAsk).error.code, -32602, 'invalid human answer cannot satisfy native request')

  const cancelOffset = messages.length
  const cancelled = rpc('_uniagent/command', { sessionId, line: '/fixture-ask' })
  const cancelledQuestion = await until(() => messages.slice(cancelOffset).find(message => message.method === '_uniagent/ask_user_question'))
  send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  assert.ok((await cancelled).error, 'session cancel retires the blocked question and command')
  send({ jsonrpc: '2.0', id: cancelledQuestion.id, result: { answers: [{ id: 'decision', selected: ['Approve'] }] } })
  assert.equal((await command(sessionId, '/fixture-read-state')).result.kind, 'success', 'late answer never corrupts stock ACP correlation')
  const signalAsk = await rpc('_uniagent/command', { sessionId, line: '/fixture-ask-signal' })
  assert.ok(signalAsk.error, 'SDK question signal cancels its extension request')
  const requestCancelOffset = messages.length
  const requestId = sequence + 1
  const requestCancel = rpc('_uniagent/command', { sessionId, line: '/fixture-ask' })
  await until(() => messages.slice(requestCancelOffset).find(message => message.method === '_uniagent/ask_user_question'))
  send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId } })
  assert.ok((await requestCancel).error, 'JSON-RPC request cancellation reaches the native command signal')
  assert.equal((await command(sessionId, '/fixture-impostor')).result.text, 'CALLER_NOT_LIVE')

  const other = await request('session/new', { cwd: fixture, mcpServers: [] })
  await command(sessionId, '/fixture-resident-child')
  const unauthorisedChildCancel = await rpc('_uniagent/subagent_cancel', { sessionId: other.sessionId, childSessionId: 'resident-child' })
  assert.equal(unauthorisedChildCancel.error.code, -32602)
  assert.deepEqual(await request('_uniagent/subagent_cancel', { sessionId, childSessionId: 'resident-child' }), { accepted: true })
  assert.equal((await command(sessionId, '/fixture-child-state')).result.text, 'true', 'subagent cancel actually aborts native child work')
  const otherOffset = messages.length
  const otherAsk = command(other.sessionId, '/fixture-ask')
  const otherQuestion = await until(() => messages.slice(otherOffset).find(message => message.method === '_uniagent/ask_user_question' && message.params.sessionId === other.sessionId))
  send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  assert.equal((await command(sessionId, '/fixture-read-state')).result.kind, 'success')
  send({ jsonrpc: '2.0', id: otherQuestion.id, result: { answers: [{ id: 'decision', selected: ['Reject'], custom: 'Keep current design' }] } })
  assert.equal(JSON.parse((await otherAsk).result.text).answers[0].selected[0], 'Reject', 'cancel affects only its owning root')
  await request('session/close', { sessionId: other.sessionId })

  const childOffset = messages.length
  const childResult = await command(sessionId, '/fixture-child')
  assert.equal(childResult.result.text, 'DELEGATED_CALLER', 'native child cannot claim root human interaction')
  const start = await until(() => messages.slice(childOffset).find(message => message.method === '_uniagent/session_update' && message.params.kind === 'subagent_start'))
  const end = await until(() => messages.slice(childOffset).find(message => message.method === '_uniagent/session_update' && message.params.kind === 'subagent_end'))
  assert.equal(start.params.sessionId, sessionId)
  assert.equal(start.params.parentSessionId, sessionId)
  assert.equal(start.params.id, 'native-child')
  assert.equal(end.params.runId, start.params.runId)
  assert.equal(end.params.stopReason, 'completed')
  assert.ok(messages.slice(childOffset).some(message => message.method === '_uniagent/session_update' && message.params.sessionId === sessionId && message.params.childSessionId === 'native-child' && message.params.kind === 'event'))
  assert.equal(messages.slice(childOffset).some(message => message.method === '_uniagent/ask_user_question'), false)

  const invalidMode = await rpc('_uniagent/set_mode', { sessionId, mode: 'invalid' })
  assert.equal(invalidMode.error.code, -32602)
  const unknown = await rpc('_uniagent/unknown', { sessionId })
  assert.equal(unknown.error.code, -32601)
  assert.equal((await rpc('_uniagent/capabilities', { sessionId: 'unknown-session' })).error.code, -32602)
  const invalidSteer = await rpc('_uniagent/steer', { sessionId, text: '' })
  assert.equal(invalidSteer.error.code, -32602)
  const steerOffset = messages.length
  assert.deepEqual(await request('_uniagent/steer', { sessionId, text: 'fixture-steer-only native input' }), { accepted: true })
  const turnEnd = await until(() => messages.slice(steerOffset).find(message => message.method === '_uniagent/session_update' && message.params.sessionId === sessionId && message.params.kind === 'event' && message.params.event.type === 'turn/end'))
  const sourceHistory = await request('_uniagent/history', { sessionId })
  assert.ok(sourceHistory.events.some((event: any) => event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('fixture-steer-only native input')), 'steer is admitted to the real native durable inbox')
  const modelOption = created.configOptions.find((option: any) => option.category === 'model')
  const alternateModel = modelOption.options.flatMap((group: any) => group.options ?? [group]).find((option: any) => option.value !== modelOption.currentValue)
  assert.ok(alternateModel, 'official catalog has an alternate model for fork configuration validation')
  const sourceSelection = await request('session/set_config_option', { sessionId, configId: modelOption.id, value: alternateModel.value })
  const reasoningOption = sourceSelection.configOptions.find((option: any) => option.id === 'reasoning_effort')
  const alternateEffort = reasoningOption.options.find((option: any) => option.value !== reasoningOption.currentValue)
  assert.ok(alternateEffort, 'official model has an alternate reasoning selection')
  await request('session/set_config_option', { sessionId, configId: reasoningOption.id, value: alternateEffort.value })
  const openBoundary = sourceHistory.events.find((event: any) => event.type === 'turn/start').seq
  const openFork = await request('_uniagent/fork', { sessionId, eventSeq: openBoundary })
  const openForkHistory = await request('_uniagent/history', { sessionId: openFork.sessionId })
  assert.equal(openForkHistory.inheritedEventCount, openBoundary + 1)
  assert.ok(openForkHistory.events.some((event: any) => event.type === 'turn/end' && event.data.reason.kind === 'forked'), 'an open turn cut receives official synthetic closers')
  await request('session/close', { sessionId: openFork.sessionId })
  const forked = await request('_uniagent/fork', { sessionId, eventSeq: turnEnd.params.event.seq })
  assert.equal(typeof forked.sessionId, 'string')
  assert.notEqual(forked.sessionId, sessionId)
  assert.equal(forked.configOptions.find((option: any) => option.id === modelOption.id).currentValue, alternateModel.value, 'fork preserves the current source selection even before a model request')
  assert.equal(forked.configOptions.find((option: any) => option.id === reasoningOption.id).currentValue, alternateEffort.value, 'fork preserves the current source reasoning selection')
  assert.equal(forked.cwd, fixture)
  const forkHistory = await request('_uniagent/history', { sessionId: forked.sessionId })
  assert.equal(forkHistory.session.parentSession, sessionId)
  assert.equal(forkHistory.session.isSeeded, true)
  assert.ok((await request('_uniagent/list_sessions', { cwd: fixture })).sessions.some((entry: any) => entry.sessionId === forked.sessionId && entry.parentSessionId === sessionId), 'session list includes native forks')
  assert.equal(forkHistory.inheritedEventCount, turnEnd.params.event.seq + 1)
  assert.deepEqual(forkHistory.events.slice(0, forkHistory.inheritedEventCount), sourceHistory.events.slice(0, forkHistory.inheritedEventCount), 'fork copies the exact inclusive native event prefix')
  assert.equal((await command(forked.sessionId, '/fixture-read-state')).result.kind, 'success', 'fork is attached to the stock ACP session map')
  await request('session/close', { sessionId: forked.sessionId })
  await request('session/resume', { sessionId: forked.sessionId, cwd: fixture, mcpServers: [] })
  assert.equal((await request('_uniagent/history', { sessionId: forked.sessionId })).session.parentSession, sessionId, 'durable resume preserves stored lineage')
  const forkAskOffset = messages.length
  const forkAsk = command(forked.sessionId, '/fixture-ask')
  const forkQuestion = await until(() => messages.slice(forkAskOffset).find(message => message.method === '_uniagent/ask_user_question' && message.params.sessionId === forked.sessionId))
  send({ jsonrpc: '2.0', id: forkQuestion.id, result: { answers: [{ id: 'decision', selected: ['Approve'] }] } })
  assert.equal((await forkAsk).result.kind, 'success', 'a lineage-bearing fork is a runtime root and may ask')
  await request('session/close', { sessionId: forked.sessionId })
  const planBoundary = sourceHistory.events.find((event: any) => event.type === 'plan/mode').seq
  const atEvent = await request('_uniagent/fork', { sessionId, eventSeq: planBoundary })
  assert.equal((await request('_uniagent/history', { sessionId: atEvent.sessionId })).inheritedEventCount, planBoundary + 1)
  await request('session/close', { sessionId: atEvent.sessionId })
  const invalidFork = await rpc('_uniagent/fork', { sessionId, eventSeq: 100000000 })
  assert.equal(invalidFork.error.code, -32602)
  assert.equal((await rpc('_uniagent/fork', { sessionId, mcpServers: {} })).error.code, -32602)
  for (const configOptions of [{}, [{ id: 'permission', currentValue: 'ask' }], [{ id: 'model', currentValue: 7 }], [{ id: 'model', currentValue: modelOption.currentValue }, { id: 'model', currentValue: alternateModel.value }]]) {
    assert.equal((await rpc('_uniagent/fork', { sessionId, configOptions })).error.code, -32602, 'invalid or duplicate caller selections are rejected')
  }
  const coldOverride = await request('_uniagent/fork', { sessionId: 'cold-native-session', mcpServers: [], configOptions: [
    { id: 'reasoning_effort', currentValue: reasoningOption.currentValue },
    { id: 'model', currentValue: modelOption.currentValue }
  ] })
  assert.equal(coldOverride.configOptions.find((option: any) => option.id === modelOption.id).currentValue, modelOption.currentValue, 'a fresh fork transport applies the caller current model')
  assert.equal(coldOverride.configOptions.find((option: any) => option.id === reasoningOption.id).currentValue, reasoningOption.currentValue, 'dependent reasoning is applied after the model regardless of caller order')
  await request('session/close', { sessionId: coldOverride.sessionId })
  const coldFork = await request('_uniagent/fork', { sessionId: 'cold-native-session', mcpServers: [] })
  assert.equal((await request('_uniagent/history', { sessionId: coldFork.sessionId })).session.parentSession, 'cold-native-session', 'native forking supports a stored source without activating it')
  await request('session/close', { sessionId: coldFork.sessionId })
  assert.equal(JSON.parse((await command(sessionId, '/fixture-read-state')).result.text).coldActive, false)
  const childResume = await rpc('session/resume', { sessionId: 'native-child', cwd: fixture, mcpServers: [] })
  assert.ok(childResume.error, 'fork admission facade does not grant a delegated child root ownership')
  const firstPage = await request('_uniagent/list_sessions', { cwd: fixture })
  assert.equal(firstPage.sessions.length, 2)
  assert.equal(firstPage.nextCursor, '2')
  const secondPage = await request('_uniagent/list_sessions', { cwd: fixture, cursor: firstPage.nextCursor })
  assert.equal(secondPage.sessions.some((entry: any) => firstPage.sessions.some((first: any) => first.sessionId === entry.sessionId)), false, 'native history pagination does not duplicate identities')
  const closed = await request('session/close', { sessionId })
  assert.deepEqual(closed, {})
  const resumed = await request('session/resume', { sessionId, cwd: fixture, mcpServers: [] })
  assert.equal(resumed.sessionId ?? sessionId, sessionId)
  assert.equal((await request('_uniagent/capabilities', { sessionId })).flags.history, true)

  const eofOffset = messages.length
  const eofAsk = command(sessionId, '/fixture-ask').then(() => undefined, () => undefined)
  await until(() => messages.slice(eofOffset).find(message => message.method === '_uniagent/ask_user_question'))
  const eofRead = await startChildRead(sessionId)
  child.stdin.end()
  await until(() => child!.exitCode !== null, 12000)
  await eofAsk
  await eofRead.reading.catch(() => undefined)
  assert.equal(child.exitCode, 0, 'EOF lets official agent teardown finish')
  child = startHarness()
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const imageLogFiles = (await readdir(join(home, 'sessions'), { recursive: true })).filter(file => /\.jsonl(?:\.zstd)?$/.test(file)).sort()
  const imageLogBytes = await Promise.all(imageLogFiles.map(file => readFile(join(home, 'sessions', file))))
  const coldImageOffset = messages.length
  assert.equal((await request('_uniagent/read_image', { sessionId: imageSessionId, eventSeq: nativeImage.assistant, blockIndex: 0 })).dataUrl, nativeImage.dataUrl, 'a fresh Harness reads the cold owner image without resuming it')
  for (const image of [nativeChildImage, unobservedImage, nestedImage]) {
    const result = await request('_uniagent/read_image', { sessionId: imageSessionId, childSessionId: image.childSessionId, eventSeq: image.assistant, blockIndex: 0 })
    assert.equal(result.dataUrl, image.dataUrl, 'fresh Harness reads the exact completed child image using only durable subagent ancestry')
  }
  for (const image of [otherChildImage, spoofedImage, ...invalidLineageImages]) {
    assert.equal((await rpc('_uniagent/read_image', { sessionId: imageSessionId, childSessionId: image.childSessionId, eventSeq: image.assistant, blockIndex: 0 })).error.code, -32602, 'restart never grants cross-root, ordinary-fork, missing or cyclic child lineage')
  }
  assert.deepEqual((await readdir(join(home, 'sessions'), { recursive: true })).filter(file => /\.jsonl(?:\.zstd)?$/.test(file)).sort(), imageLogFiles, 'cold images cannot create native session logs')
  assert.deepEqual(await Promise.all(imageLogFiles.map(file => readFile(join(home, 'sessions', file)))), imageLogBytes, 'owner and every child native log stay byte-for-byte unchanged')
  assert.equal(messages.slice(coldImageOffset).some(message => message.method === 'session/update' || message.method === '_uniagent/session_update'), false, 'cold image reads cannot activate a native turn')
  await request('session/resume', { sessionId: forked.sessionId, cwd: fixture, mcpServers: [] })
  const durableFork = await request('_uniagent/history', { sessionId: forked.sessionId })
  assert.equal(durableFork.session.parentSession, sessionId)
  assert.equal(durableFork.inheritedEventCount, turnEnd.params.event.seq + 1)
  assert.equal((await command(forked.sessionId, '/fixture-read-state')).result.kind, 'success', 'fork remains a stock ACP session after a fresh Harness process')
  child.stdin.end()
  await until(() => child!.exitCode !== null, 12000)
  assert.equal(child.exitCode, 0)
  const bridgePatch = fixturePatch.find((patch: any) => patch.insert)?.insert?.find((patch: any) => patch.id === 'uniagent-bridge')
  assert.ok(bridgePatch)
  bridgePatch.config.model = 'deepseek-v4-pro'
  await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify(fixturePatch))
  child = startHarness()
  const textOnlyInitialize = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(textOnlyInitialize.agentCapabilities.promptCapabilities.image, false)
  await request('session/resume', { sessionId: imageSessionId, cwd: fixture, mcpServers: [] })
  await request('session/set_config_option', { sessionId: imageSessionId, configId: 'model', value: JSON.stringify(['deepseek-official', 'deepseek-flash']) })
  assert.equal((await rpc('_uniagent/steer', { sessionId: imageSessionId, prompt: [imageBlock] })).error.code, -32602, 'steer images honor the same connection advertisement as ordinary ACP prompts')
  child.stdin.end()
  await until(() => child!.exitCode !== null, 12000)
  assert.equal(child.exitCode, 0)
  assert.equal(messages.some(message => message.method === undefined && typeof message.id === 'string' && message.id.startsWith('uniagent:acp:')), false, 'internal ACP request responses never escape to the client')
  console.log('deepseek bridge: official ACP, native history/Plan/inventory/questions/child approvals/subagents/completed child images/attachment steer/fork/durable restart/cancellation/EOF passed without external provider requests')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await until(() => child!.exitCode !== null, 8000).catch(() => { child!.kill('SIGKILL') })
  }
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function send(value: any) { child!.stdin.write(JSON.stringify(value) + '\n') }
function startHarness() {
  const processChild = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'acp'], {
    cwd: fixture,
    // 0.2.1 only advertises models once a credential resolves; the fake key never
    // leaves the process because every request is served by the local fixture.
    env: { ...process.env, HOME: home, DSH_HOME: home, UNIAGENT_USER_DATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, TMPDIR: fixture, DSH_TELEMETRY_MODE: 'DISABLED',
      DEEPSEEK_API_KEY: 'uniagent-bridge-fixture-key' }
  })
  processChild.stderr.on('data', data => { stderr += data.toString() })
  let buffer = ''
  processChild.stdout.on('data', data => {
    buffer += data.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      let value: any
      try { value = JSON.parse(line) } catch { continue }
      messages.push(value)
      if (value.id !== undefined && value.method === undefined) {
        const pending = replies.get(value.id)
        if (pending) { replies.delete(value.id); pending.resolve(value) }
      }
      for (const waiter of waiters) waiter()
    }
  })
  processChild.once('exit', code => {
    for (const pending of replies.values()) pending.reject(new Error('Harness exited: ' + code + '\n' + safeDiagnostics()))
    replies.clear()
    for (const waiter of waiters) waiter()
  })
  return processChild
}
function rpc(method: string, params: any): Promise<any> {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { replies.delete(id); reject(new Error('RPC timed out: ' + method + '\n' + safeDiagnostics())) }, 20000)
    replies.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
async function request(method: string, params: any) {
  const response = await rpc(method, params)
  assert.equal(response.error, undefined, method + ' failed: ' + JSON.stringify(response.error))
  return response.result
}
function command(sessionId: string, line: string) { return request('_uniagent/command', { sessionId, line }) }
async function startChildRead(sessionId: string) {
  const offset = messages.length
  const reading = rpc('_uniagent/command', { sessionId, line: '/fixture-child-read' })
  const permission = await Promise.race([
    until(() => messages.slice(offset).find(message => message.method === 'session/request_permission')),
    reading.then(response => { throw new Error('Native child read completed before approval: ' + JSON.stringify(response)) })
  ])
  return { reading, permission }
}
function until<T>(read: () => T, timeout = 8000): Promise<NonNullable<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Expected SDK event did not arrive\n' + safeDiagnostics())) }, timeout)
    const check = () => { const value = read(); if (value) { clearTimeout(timer); waiters.delete(check); resolve(value as NonNullable<T>) } }
    waiters.add(check); check()
  })
}
function safeDiagnostics() {
  let tail = stderr.slice(-9000)
  for (const [key, value] of Object.entries(process.env)) if (value && /KEY|TOKEN|SECRET|PASSWORD/i.test(key)) tail = tail.split(value).join('[redacted]')
  return tail
}
