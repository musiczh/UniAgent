import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GrokACPRunner, probeGrokACP } from '../src/main/grokACPRunner.ts'
import { forkBetaSession,deleteOwnedGrokFork } from '../src/main/betaSessionFork.ts'
import { readonlyGrokInventory,readonlyGrokInventoryRunner } from '../src/main/grokInventory.ts'
import { readGrokChildHistory } from '../src/main/grokChildHistory.ts'
import type { AgentDef,UAEvent } from '../src/shared/types.ts'

if(process.env.UNIAGENT_GROK_NATIVE_TEST !== '1') console.log('grok-native-cli: opt in with UNIAGENT_GROK_NATIVE_TEST=1')
else {
  const root=await mkdtemp(join(tmpdir(),'ua-grok-native-cli-')),home=join(root,'home'),grokHome=join(home,'.grok'),cwd=join(root,'workspace')
  await mkdir(grokHome,{recursive:true});await mkdir(cwd)
  let route='ordinary',questionVariant='single'
  const captures:any[]=[],events:UAEvent[]=[],requests:any[]=[],notifications:any[]=[],releases:Array<()=>void>=[]
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    const body=raw?JSON.parse(raw):{}
    if(!body.messages){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'grok-4.7',context_window:200000}]}));return}
    captures.push(body)
    const users=body.messages.filter((m:any)=>m.role==='user').map((m:any)=>JSON.stringify(m.content)).join('\n')
    const executed=new Set(body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.tool_call_id))
    const tool=(name:string,args:any,id:string)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
    const tools=(body.tools||[]).map((t:any)=>t.function.name)
    const questionId=`ua-question-${questionVariant}`
    let delta:any={role:'assistant',content:'LOCAL_MODEL_OK'},hold=false
    if(tools.length===1&&tools[0]==='session_title')delta=tool('session_title',{title:'Isolated native test'},'title')
    else if(route==='question'&&!executed.has(questionId)) delta=tool('ask_user_question',{questions:[{question:'Choose scope',multi_select:questionVariant==='multi',options:questionVariant==='text'?[]:[{label:'Workspace',description:'Current directory'},{label:'Whole project',description:'All project files'}]}]},questionId)
    else if(route==='child'&&users.includes('UA_CHILD_MARKER')) {delta={role:'assistant',content:'CHILD_DETAIL'};hold=true}
    else if(route==='child'&&!executed.has('ua-child')) delta=tool('spawn_subagent',{prompt:'UA_CHILD_MARKER return child detail',description:'Isolated child test',background:true},'ua-child')
    else if(route==='child') hold=true
    const finish=delta.tool_calls?'tool_calls':'stop'
    const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:30},completion_tokens_details:{reasoning_tokens:7}}
    res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'})
    if(body.stream){res.write('data: '+JSON.stringify({id:'ua-local',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'grok-4.7',choices:[{index:0,delta,finish_reason:hold?null:finish}],...(!hold?{usage}:{})})+'\n\n');if(hold)releases.push(()=>res.end('data: [DONE]\n\n'));else res.end('data: [DONE]\n\n')}
    else res.end(JSON.stringify({id:'ua-local',object:'chat.completion',created:Math.floor(Date.now()/1000),model:'grok-4.7',choices:[{index:0,message:delta,finish_reason:finish}],usage}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${(server.address() as any).port}/v1`
  await writeFile(join(grokHome,'config.toml'),`[cli]\nauto_update=false\nuse_leader=false\n[features]\nmanaged_config=false\nfeedback=false\ntelemetry=false\n[managed_mcps]\nenabled=false\n[models]\ndefault="grok-4.7"\n[model."grok-4.7"]\nmodel="grok-4.7"\nbase_url="${base}"\napi_key="ua-dummy"\napi_backend="chat_completions"\nagent_type="grok-build"\nvision=true\nmax_retries=0\ncontext_window=200000\n[endpoints]\nmodels_base_url="${base}"\nxai_api_base_url="${base}"\ncli_chat_proxy_base_url="${base}"\n`)
  const env={HOME:home,GROK_HOME:grokHome,TMPDIR:root,XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'data'),XAI_API_KEY:'ua-dummy',GROK_SUBAGENTS:'1',GROK_GOAL:'0'}
  const agent:AgentDef={id:'grok',adapter:'grok',name:'Grok',bin:process.env.UNIAGENT_GROK_BIN || '/Users/bytedance/.grok/downloads/grok-1.0.62-macos-aarch64',builtin:true,icon:'',models:[],capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[]}}
  const runner=new GrokACPRunner('native-cli',{n:0},agent,{agentId:'grok',workdir:cwd,model:'grok-4.7',permissionMode:'ask'},undefined,env)
  runner.on('event',event=>{
    events.push(event)
    if(event.type==='approval_request'&&event.state==='pending'&&event.payload.method==='_x.ai/ask_user_question') runner.respondResult(event.payload.requestId,questionVariant==='cancel'?{outcome:'cancelled'}:{outcome:'accepted',answers:{[event.payload.params.questions[0].question]:questionVariant==='text'?['Exact free text']:questionVariant==='multi'?['Workspace','Whole project']:['Workspace']}})
    if(event.type==='approval_request'&&event.state==='pending'&&event.payload.method==='session/request_permission') {
      assert.equal(event.payload.params.toolCallId,'ua-child','only the local fixture child spawn may be approved')
      const option=event.payload.options.find((option:any)=>option.kind==='allow_once')
      runner.respondResult(event.payload.requestId,{outcome:{outcome:'selected',optionId:option.optionId}})
    }
  })
  const until=async(predicate:()=>boolean)=>{const end=Date.now()+20000;while(!predicate()){if(Date.now()>end)throw new Error('native CLI condition timeout: '+JSON.stringify(events.slice(-8)));await new Promise(r=>setTimeout(r,20))}}
  try {
    assert.equal((await probeGrokACP(agent.bin, cwd, env)).status, 'ready', 'the installed CLI must complete probe process and temporary directory cleanup')
    const probe=await runner.probeSession(false)
    assert.deepEqual(probe.contract.collaborationModes, ['default'])
    await assert.rejects(runner.setCollaborationMode('plan'), /未声明 Plan/,
      'Grok 1.0.62 must not expose a Plan mode absent from its native session')
    await runner.probeSession(false)
    ;(runner as any).connection.on('request',(frame:any)=>requests.push(frame))
    ;(runner as any).connection.on('notification',(frame:any)=>{if(frame.method?.startsWith('_') || frame.params?.sessionId !== probe.nativeSessionId)notifications.push(frame)})
    assert.equal(probe.contract.imageAttachments,true);assert.equal(probe.contract.nativeGoal,false)
    const path=join(root,'blue.png');await writeFile(path,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RMQ0AMAzEQLf8OacQ3CWbD8BHcg4Mm+7qOh340A9UiVSJVIlUiVSJVIlUiVSJMA+hxgE/8m7SpQAAAABJRU5ErkJggg==','base64'))
    await runner.startTurn('Image transport',[{kind:'image',path,name:'blue.png',mime:'image/png'}])
    assert.ok(captures.some(body=>JSON.stringify(body.messages).includes('data:image/')))
    assert.equal(events.filter(e=>e.payload.kind==='usage').length,1,JSON.stringify(events.filter(e=>e.type==='system_notice'||e.type==='error')))
    assert.equal(events.find(e=>e.payload.kind==='usage')!.payload.usage.cachedInputTokens,30)
    route='question';await runner.startTurn('Ask me')
    assert.ok(events.some(e=>e.payload.method==='_x.ai/ask_user_question'))
    assert.ok(events.some(e=>e.type==='tool_call'&&e.state==='success'&&e.payload.id==='ua-question-single'))
    assert.ok(events.some(e=>e.type==='tool_call'&&e.state==='success'&&String(e.payload.output).includes('"Choose scope"="Workspace"')),'the tool result must retain the exact question and selected label')
    questionVariant='cancel';await runner.startTurn('Ask again')
    assert.ok(events.some(e=>e.type==='approval_request'&&e.state==='cancelled'))
    questionVariant='text';await runner.startTurn('Ask for text')
    assert.ok(events.some(e=>e.type==='tool_call'&&e.state==='success'&&e.payload.id==='ua-question-text'&&String(e.payload.output).includes('Exact free text')))
    questionVariant='multi';await runner.startTurn('Ask for multiple selections')
    assert.ok(events.some(e=>e.type==='tool_call'&&e.state==='success'&&e.payload.id==='ua-question-multi'&&String(e.payload.output).includes('Workspace, Whole project')))
    route='child'
    const turn=runner.startTurn('Spawn a child for the local transport test')
    await until(()=>events.some(e=>e.type==='subagent'&&e.payload.agents?.[0]?.status==='running'))
    const child=events.find(e=>e.type==='subagent')!.payload.agents[0]
    await until(()=>runner.getSubAgentItems(child.agentThreadId).some(e=>String(e.payload.text).includes('CHILD_DETAIL')))
    assert.equal(events.some(e=>e.type==='agent_message'&&String(e.payload.text).includes('CHILD_DETAIL')),false)
    await runner.cancelSubAgent(child.agentThreadId)
    releases.forEach(release=>release());runner.interrupt();await turn
    assert.ok((await readGrokChildHistory(probe.nativeSessionId,child,env)).some(e=>String(e.payload.text).includes('CHILD_DETAIL')))
    const fork=await forkBetaSession('grok',probe.nativeSessionId,agent.bin,cwd,env)
    assert.notEqual(fork.nativeId,probe.nativeSessionId)
    await deleteOwnedGrokFork(fork.nativeId,agent.bin,env)
    const inventory=await readonlyGrokInventory(agent.bin,{cwd,env,runner:readonlyGrokInventoryRunner})
    assert.equal(inventory.status,'available');assert.equal(inventory.writable,false)
    assert.equal(events.some(e=>e.type==='error'),false)
    console.log('grok-native-cli: real 1.0.62 image transport, usage, questions, child routing/cancel/cache, fork cleanup and inventory passed')
  } finally {
    const evidence=join(process.cwd(),'out','test-results');await mkdir(evidence,{recursive:true})
    await writeFile(join(evidence,'grok-native-cli-latest.json'),JSON.stringify({events,requests,notifications,schemas:captures.flatMap(body=>(body.tools||[]).filter((tool:any)=>['ask_user_question','spawn_subagent'].includes(tool.function.name))).slice(0,4)},null,2))
    releases.forEach(release=>release());await runner.disposeAndWait();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})
  }
}
