import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const errorDisclosure = await renderEventStream([], 'idle', 'router-error-disclosure', {
  setup: `
    import {RouterAssignmentContext,RouterAssignmentEvent} from './src/renderer/components/RouterAssignmentCard';
    const marker='diagnostic-only-marker';
    const response={content:[{type:'text',text:JSON.stringify({error:'invalid_router_arguments',code:'invalid_router_arguments',message:'请按工具声明修正参数；router_query 仅支持 catalog、object_detail、task_briefs、task_detail。本轮基础信息已随输入提供。',recovery:{action:'retry'},detail:marker})}],structuredContent:null,_meta:null};
    const request={requestId:'11111111-1111-4111-8111-111111111111',prompt:'用户输入：{"error":"invalid_router_arguments"}',scope:{kind:'global'},config:{},version:4,state:'routing',delivery:'pending',createdAt:1,updatedAt:1};
    const event={sessionId:'router-errors',seq:1,ts:2,type:'tool_call',state:'failed',payload:{name:'router_assign_task',input:{requestId:request.requestId,version:3},output:response}};
    const original=JSON.stringify(event),host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
    window.uniagent={getRouterReview:async id=>({request:{requestId:id},revision:0,attempts:[],feedbackHistory:[]}),getRouterReviewTargets:async()=>[],onRouterChanged:()=>()=>{}};
    let rejection=response;
    const show=(patch={},tool=event,known=true)=>root.render(React.createElement(RouterAssignmentContext.Provider,{value:known?{requests:[{...request,...patch}],agents:[],resolve:async()=>{throw rejection},openTask:()=>{}}:undefined},React.createElement(RouterAssignmentEvent,{event:tool})));
    show();window.errorDisclosure={host,request,event,response,original,show,rejectWith:value=>rejection=value};
  `,
  inspect: `(async()=>{
    const f=window.errorDisclosure,tick=()=>new Promise(resolve=>setTimeout(resolve,20)),wait=async check=>{for(let i=0;i<100;i++){if(check())return;await tick()}throw Error('Router error disclosure timeout')};
    await wait(()=>f.host.querySelector('.router-assignment'));
    const checks={},safe=()=>!f.host.textContent.includes('diagnostic-only-marker')&&!f.host.textContent.includes('structuredContent')&&!f.host.textContent.includes('router_query 仅支持 catalog、object_detail、task_briefs、task_detail');
    for(const [index,[field,value]] of [['output',f.response],['output',JSON.stringify(f.response)],['error',f.response],['result',f.response],['error','invalid_router_arguments'],['output',undefined]].entries()){
      const {output,...payload}=f.event.payload;f.show({}, {...f.event,payload:{...payload,[field]:value}});await tick();
      checks['toolResponse'+index]=safe()&&f.host.querySelector('.router-error')?.textContent==='正在重新确认分配信息，请稍候。'&&f.host.querySelector('.router-error')?.getAttribute('role')==='status';
    }
    checks.businessInputPreserved=f.host.querySelector('.router-assignment-input').textContent===f.request.prompt;
    f.show({}, {...f.event,state:'success'});await tick();checks.successfulCallClearsNotice=!f.host.querySelector('.router-error');
    f.show({state:'bound',delivery:'accepted',targetId:'task',error:JSON.stringify(f.response)},f.event);await tick();checks.confirmedReceiptIgnoresOldToolFailure=!f.host.querySelector('.router-error')&&safe();
    f.show({state:'cancelled',error:JSON.stringify(f.response)});await tick();checks.cancelledHasNoStaleError=!f.host.querySelector('.router-error')&&safe();
    const snapshot={...f.request,state:'needs_input',version:3,error:JSON.stringify(f.response),decision:{action:'clarify',reason:'请选择归属',clarificationOptions:[]},question:'请选择归属'};
    f.show({state:'bound',clarifications:[{id:'old-round',answeredAt:3,answer:'属于 UniAgent',snapshot}]});await tick();checks.frozenClarificationHasNoToolError=!f.host.querySelector('.router-error')&&safe();
    f.show({state:'routing',error:JSON.stringify(f.response),failure:{code:'router-tool-recovery',sessionId:'router-errors'}}, {...f.event,state:'success'});await tick();checks.persistedRecoveryIsReadable=safe()&&f.host.querySelector('.router-error')?.textContent==='正在重新确认分配信息，请稍候。';
    f.show({state:'queued',error:JSON.stringify(f.response),autoRecovery:{attempts:1,total:1,phase:'routing',reason:JSON.stringify(f.response),nextAt:Date.now()+2000}});await tick();checks.automaticRecoveryHidesDiagnostics=safe()&&!f.host.querySelector('.router-error')&&f.host.querySelector('.router-recovery')?.textContent.startsWith('正在自动恢复分配，请稍候。');
    f.show({state:'failed',error:JSON.stringify(f.response)});await tick();
    checks.failureHasReadableRetry=safe()&&f.host.querySelector('[role="alert"]')?.textContent==='任务分配暂未完成，请重试。'&&[...f.host.querySelectorAll('button')].some(button=>button.textContent==='重试');
    for(const value of [f.response,Error(JSON.stringify(f.response))]){
      f.rejectWith(value);[...f.host.querySelectorAll('button')].find(button=>button.textContent==='重试').click();await tick();
      checks[value instanceof Error?'exceptionHidden':'rejectedResponseHidden']=safe()&&f.host.querySelector('[role="alert"]')?.textContent==='操作暂未完成，请重试。';
    }
    f.show({state:'bound',delivery:'accepted',targetId:'task',version:5});await tick();checks.newReceiptClearsLocalError=!f.host.querySelector('.router-error');
    f.show({state:'bound',delivery:'failed',targetId:'task'});await tick();checks.failedDeliveryKeepsAssignmentSuccess=safe()&&f.host.querySelector('.router-assignment-status')?.textContent==='分配成功'&&!f.host.querySelector('.router-assignment-body [role="alert"]')&&f.host.querySelector('.router-assignment footer')?.textContent.includes('本轮执行失败')&&[...f.host.querySelectorAll('button')].some(button=>button.textContent==='打开目标任务')&&![...f.host.querySelectorAll('button')].some(button=>button.textContent==='重试');
    f.show({},f.event,false);await tick();const fallback=f.host.querySelector('.tool-call');fallback.open=true;await tick();checks.missingReceiptHidesPayload=safe()&&!fallback.querySelector('pre')&&fallback.textContent.includes('暂时无法读取分配结果，请稍后再查看。');
    f.show({}, {...f.event,state:'running'},false);await tick();checks.pendingReceiptHidesPayload=safe()&&!f.host.querySelector('pre')&&f.host.textContent.includes('正在读取分配结果，请稍候。');
    checks.originalDiagnosticsRetained=JSON.stringify(f.event)===f.original;
    return{checks,errors:window.__fixtureErrors};
  })()`
})
assert.deepEqual(errorDisclosure.errors, [])
for (const [name, passed] of Object.entries(errorDisclosure.checks)) assert.equal(passed, true, name)
console.log('PASS Router error disclosure: object/string tool responses, missing receipts, native failures, action errors, recovery and original diagnostics')

const result = await renderEventStream([], 'idle', 'router-ui', {
  setup: `
    import {RouterAssignmentContext} from './src/renderer/components/RouterAssignmentCard';
    import {RouterSettings} from './src/renderer/components/RouterSettings';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {SessionConversation} from './src/renderer/components/SessionConversation';
    import {Composer} from './src/renderer/components/Composer';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    const config={enabled:false,agentId:'deepseek',model:JSON.stringify(['deepseek-official','deepseek-flash']),effort:'max',version:1};
    const agents=[{id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:config.model,label:'Flash',efforts:['max']}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]},lifecycle:{availability:'available'}}];
    const request={requestId:'11111111-1111-4111-8111-111111111111',prompt:'继续修复图片',scope:{kind:'global'},config,version:4,state:'bound',delivery:'queued',createdAt:1,updatedAt:1,decision:{action:'reuse_task',taskId:'original',reason:'目标相同'},targetId:'original',targetTitle:'图片漏显',projectName:'UniAgent',execution:{agentId:'codex',model:'gpt',workdir:'/other'}};
    const routerChanges=new Set();
    const errors=[],resolutions=[],opened=[],saves=[];let finishSave,changed=()=>routerChanges.forEach(cb=>cb()),reads=0;
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getRouterReview:async id=>({request:{requestId:id},revision:0,attempts:[],feedbackHistory:[]}),getRouterSnapshot:async()=>({config,available:true,requests:[request],sessionId:'fixed-router'}),onRouterChanged:cb=>{routerChanges.add(cb);return()=>routerChanges.delete(cb)},saveRouterConfig:(draft,version)=>{saves.push({draft,version});return new Promise(resolve=>finishSave=resolve)},openRouter:async()=>({id:'fixed-router',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'deepseek',model:config.model,effort:'max',workdir:'/fixture',managedPurpose:'router'}}),getEvents:async()=>[{sessionId:"fixed-router",seq:0,ts:1,type:"user_message",payload:{text:"wire request instruction",displayText:"原始任务输入",routedInputId:request.requestId}},{sessionId:"fixed-router",seq:1,ts:2,type:"system_notice",payload:{kind:"usage",usage:{contextTokens:32000,contextWindow:1000000}}}],getPrefs:async()=>({lastByAgent:{}})}, {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const event=(seq,type,payload,state='success')=>({sessionId:'fixed-router',seq,ts:seq+1,type,payload,state});
    const history=[event(0,'user_message',{text:request.prompt}),event(1,'tool_call',{name:'mcp__uniagent_router__router_assign_task',input:{requestId:request.requestId,version:3}}),...Array.from({length:12},(_,i)=>event(i+2,'agent_message',{text:'处理步骤 '+i,phase:'commentary'})),event(20,'agent_message',{text:'输入已排队，按原任务配置继续',phase:'final_answer'}),event(21,'turn_completed',{})];
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
    const context={requests:[request],agents,resolve:async value=>{resolutions.push(value)},openTask:id=>opened.push(id)};
    const render=status=>root.render(React.createElement(RouterAssignmentContext.Provider,{value:context},React.createElement(EventStream,{sessionId:'fixed-router',status,events:status==='running'?history.slice(0,-2):history})));
    render('idle');
    const settingHost=document.body.appendChild(document.createElement('div')),settingRoot=createRoot(settingHost);settingRoot.render(React.createElement(RouterSettings,{agents}));
    const panelHost=document.body.appendChild(document.createElement('div')),panelRoot=createRoot(panelHost),panelProps={onOpenTask:id=>opened.push(id),onSettings:()=>{},mergeEvent:(events,event)=>[...events,event]};panelRoot.render(React.createElement(RouterPanel,{...panelProps,agents}));
    const originalRead=window.uniagent.getRouterSnapshot;window.uniagent.getRouterSnapshot=async()=>{reads++;return originalRead()};
    const referenceHost=document.body.appendChild(document.createElement('div')),referenceRoot=createRoot(referenceHost),referenceConfig={agentId:'deepseek',model:config.model,effort:'max',workdir:'/fixture'};
    panelHost.style.cssText='position:fixed;left:100px;top:0;width:1100px;height:600px';referenceHost.style.cssText=panelHost.style.cssText+';visibility:hidden';
    const noop=()=>{},asyncNoop=async()=>{};
    referenceRoot.render(React.createElement('div',{className:'session-view'},React.createElement(SessionConversation,{sessionId:'reference',status:'idle',events:[{sessionId:'reference',seq:0,ts:1,type:'user_message',payload:{text:'普通会话输入'}}]}),React.createElement(Composer,{sessionId:'reference',status:'idle',runtimeStatus:'idle',agent:agents[0],config:referenceConfig,onSend:asyncNoop,onForceSend:asyncNoop,onInterrupt:noop,onUpdateConfig:noop,onSetCollaborationMode:asyncNoop,onRunNativeAction:asyncNoop,queue:[],onDequeue:asyncNoop,onPromoteQueue:noop,onEditQueueItem:asyncNoop,capabilities:emptyNativeCapabilitySnapshot('deepseek','/fixture'),capabilitiesReady:true,contextUsed:0,onCompact:asyncNoop,canCompact:false,compacting:false})));
    const disabledHost=document.body.appendChild(document.createElement('div')),disabledRoot=createRoot(disabledHost),settingsOpened=[];
    window.routerFixture={host,settingHost,panelHost,referenceHost,disabledHost,settingsOpened,resolutions,opened,saves,errors,render,reads:()=>reads,refreshAgents:()=>panelRoot.render(React.createElement(RouterPanel,{...panelProps,agents:[...agents]})),finishSave:()=>finishSave({config:{...saves[0].draft,version:2},available:true,requests:[]}),push:()=>changed(),mountDisabled:()=>{window.uniagent.getRouterSnapshot=async()=>({config,available:false,requests:[{...request,state:'queued'},{...request,requestId:'second-waiting',state:'queued'}]});disabledRoot.render(React.createElement(RouterPanel,{...panelProps,agents,onSettings:()=>settingsOpened.push('settings')}))}};
  `,
  inspect: `(async()=>{
    const f=window.routerFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw Error('router UI timeout '+f.errors+' / '+f.host.textContent)},button=(host,label)=>[...host.querySelectorAll('button')].find(row=>row.textContent.trim()===label);
    await wait(()=>f.host.querySelector('.router-assignment')&&f.panelHost.querySelector('.router-assignment'));
    const visible=()=>{const card=f.host.querySelector('.router-assignment');return !!card&&getComputedStyle(card).display!=='none'&&![...card.parentElement.closest('details:not([open])')?[card.parentElement.closest('details:not([open])')]:[]].length};
    const completedVisible=visible(),text=f.host.querySelector('.router-assignment').textContent,decisionActions=!!f.host.querySelector('.router-decision-actions');
    button(f.host,'打开目标任务').click();
    f.render('running');await tick();const runningVisible=visible();
    const toggle=f.settingHost.querySelector('[aria-label="启用 RouterAgent"]');const defaultOff=toggle.getAttribute('aria-checked')==='false';toggle.click();await tick();
    button(f.settingHost,'保存配置').click();await wait(()=>f.saves.length===1);const savingDisabled=button(f.settingHost,'保存中…').disabled;f.finishSave();await wait(()=>f.settingHost.textContent.includes('已保存 · 已启用'));
    const readsBefore=f.reads();f.refreshAgents();await wait(()=>f.reads()>readsBefore);
    const geometry=[];await wait(()=>f.referenceHost.querySelector('.composer-wrap')&&f.panelHost.querySelector('.composer-box'));
    // Compare columns with the same scrollbar space; restored receipts now retain their full height.
    for(const host of [f.panelHost,f.referenceHost])host.querySelector('.event-stream').style.overflowY='scroll';
    const box=(host,selector)=>{const r=host.querySelector(selector).getBoundingClientRect();return {left:r.left,width:r.width}};
    for(const width of [700,1100,1500]){f.panelHost.style.width=f.referenceHost.style.width=width+'px';await tick();geometry.push({width,routerInput:box(f.panelHost,'.composer-box'),normalInput:box(f.referenceHost,'.composer-wrap'),routerUser:box(f.panelHost,'.user-msg'),normalUser:box(f.referenceHost,'.user-msg'),assignment:box(f.panelHost,'.router-assignment')})}
    f.mountDisabled();await wait(()=>f.disabledHost.querySelector('.router-disabled button'));await tick();
    const configButton=f.disabledHost.querySelector('.router-disabled button'),style=getComputedStyle(configButton),configButtonStyle={height:configButton.getBoundingClientRect().height,color:style.color,borderRadius:style.borderRadius,background:style.backgroundColor,icon:!!configButton.querySelector('.ui-icon-settings')};
    configButton.focus();const configButtonFocusable=document.activeElement===configButton;configButton.click();
    return {unavailableQueue:f.disabledHost.querySelectorAll('.queue-card').length,unavailableCards:f.disabledHost.querySelectorAll('.router-assignment').length,configButtonStyle,configButtonFocusable,settingsOpened:f.settingsOpened,taskInput:!!f.panelHost.querySelector('.new-task-send-btn')&&!!f.panelHost.querySelector('.project-picker-trigger'),geometry,originalBubble:f.panelHost.textContent.includes("原始任务输入")&&!f.panelHost.textContent.includes("wire request instruction"),availabilityRefreshed:true,completedVisible,runningVisible,text,decisionActions,resolutions:f.resolutions,opened:f.opened,defaultOff,savingDisabled,saved:f.saves[0],orphanVisible:f.panelHost.querySelector('.router-assignment')?.textContent.includes('图片漏显'),errors:f.errors};
  })()`
})
assert.equal(result.completedVisible, true, 'completed assignment is visible outside processed history')
assert.equal(result.unavailableCards, 0, 'waiting inputs have no assignment cards while Router is unavailable')
assert.equal(result.unavailableQueue, 2, 'all inputs remain in the queue when Router cannot start')
assert.equal(result.runningVisible, true, 'live assignment remains visible across folded process steps')
assert.match(result.text, /UniAgent/)
assert.equal(result.decisionActions, false, 'reused tasks with a different incoming configuration do not show a choice')
assert.deepEqual(result.resolutions, [])
assert.match(result.text, /输入已排队/)
assert.doesNotMatch(result.text, /等待你决定|按原任务配置继续|按本次配置新建/)
assert.deepEqual(result.opened, ['original'])
assert.equal(result.defaultOff, true)
assert.equal(result.saved.version, 1)
assert.equal(result.saved.draft.enabled, true)
assert.equal(result.savingDisabled, true)
assert.equal(result.orphanVisible, true, 'receipts remain visible when native tool history is absent')
assert.equal(result.taskInput, true, 'Router uses the initial new-task controls');
assert.equal(result.originalBubble, true, 'Router bubbles show the submitted business input');
for(const row of result.geometry){
  assert.deepEqual(row.routerInput,row.normalInput,`Router input shares the ordinary conversation width/gutters at ${row.width}px`)
  assert.deepEqual(row.routerUser,row.normalUser,`Router messages share the ordinary conversation width/gutters at ${row.width}px`)
  assert.deepEqual(row.assignment,row.normalUser,`assignment card stays in the ordinary message column at ${row.width}px`)
}
assert.equal(result.availabilityRefreshed, true, 'Agent catalog changes recheck Router availability after startup')
assert.equal(result.configButtonStyle.height, 32, 'empty-state action retains a 32px click target')
assert.equal(result.configButtonStyle.borderRadius, '7px')
assert.equal(result.configButtonStyle.color, 'rgb(138, 184, 255)')
assert.equal(result.configButtonStyle.background, 'rgba(88, 140, 255, 0.12)')
assert.equal(result.configButtonStyle.icon, true)
assert.equal(result.configButtonFocusable, true)
assert.deepEqual(result.settingsOpened, ['settings'])
assert.deepEqual(result.errors, [])
console.log('PASS Router UI: visible live/completed assignment, original task action, orphan receipts, default off and non-optimistic configuration save')

const duplicates = await renderEventStream([], 'idle', 'router-duplicates', {
  setup: `
    import {RouterAssignmentContext} from './src/renderer/components/RouterAssignmentCard';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'deepseek',model:'flash',version:1};
    const agent={id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:'flash',label:'Flash',efforts:[]}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]},lifecycle:{availability:'available'}};
    const request={requestId:'11111111-1111-4111-8111-111111111111',prompt:'相同的输入',scope:{kind:'global'},config,version:4,state:'needs_input',delivery:'pending',createdAt:1,updatedAt:1,decision:{action:'clarify',reason:'等待补充',clarification:'请选择任务'},question:'请选择任务'};
    const second={...request,requestId:'22222222-2222-4222-8222-222222222222',state:'bound',delivery:'queued',question:undefined,targetId:'second-task',decision:{action:'reuse_task',taskId:'second-task',reason:'第二项输入复用已有目标'}};
    const event=(seq,type,payload,state='success')=>({sessionId:'router-duplicates',seq,ts:seq+1,type,payload,state});
    const call=(seq,id,version,state,requestId=request.requestId)=>event(seq,'tool_call',{id,name:'mcp__uniagent_router__router_assign_task',input:{requestId,version}},state);
    const history=[event(0,'user_message',{text:request.prompt}),call(1,'first-call',3,'running'),call(2,'first-call',3,'failed'),call(3,'retry-call',4,'running'),call(4,'retry-call',4,'success'),event(5,'agent_message',{text:'已分配',phase:'final_answer'}),event(6,'turn_completed',{}),event(7,'user_message',{text:request.prompt}),call(8,'follow-up',5,'success'),call(9,'second-call',3,'running',second.requestId),call(10,'second-call',3,'success',second.requestId),event(11,'agent_message',{text:'第二次分配完成',phase:'final_answer'}),event(12,'turn_completed',{})];
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host),opened=[],errors=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    const render=(status,events,receipt=request,requests=[receipt,second])=>root.render(React.createElement(RouterAssignmentContext.Provider,{value:{requests,agents:[agent],resolve:async()=>{},openTask:id=>opened.push(id)}},React.createElement(EventStream,{sessionId:'router-duplicates',status,events})));
    const routing={...request,state:'routing',decision:undefined,question:undefined};
    const failedWithoutDecision={...routing,requestId:'33333333-3333-4333-8333-333333333333',state:'failed',error:'读取候选失败'};
    render('running',history.slice(0,2),routing,[routing,second]);
    const panelHost=document.body.appendChild(document.createElement('div')),panelRoot=createRoot(panelHost);
    window.uniagent=new Proxy({getRouterReview:async id=>({request:{requestId:id},revision:0,attempts:[],feedbackHistory:[]}),getRouterSnapshot:async()=>({config,available:true,requests:[request,second,failedWithoutDecision],sessionId:'router-duplicates'}),openRouter:async()=>({id:'router-duplicates',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'deepseek',model:'flash',workdir:'/fixture',managedPurpose:'router'}}),getEvents:async()=>history,getPrefs:async()=>({lastByAgent:{}})},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const mountPanel=key=>panelRoot.render(React.createElement(RouterPanel,{key,agents:[agent],onOpenTask:id=>opened.push(id),onSettings:()=>{},mergeEvent:mergeSessionEvent}));
    mountPanel('initial');
    window.duplicateFixture={host,panelHost,history,opened,errors,render,mountPanel,request,second,routing};
  `,
  inspect: `(async()=>{
    const f=window.duplicateFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<100;i++){if(check())return;await tick()}throw Error('duplicate fixture timeout')};
    const ids=host=>[...host.querySelectorAll('.router-assignment')].map(card=>card.dataset.routerRequest);
    await wait(()=>f.host.querySelector('.router-assignment, .tool-call')&&ids(f.panelHost).length>=2);
    const beforeAcceptance=[ids(f.host).length];
    const rejected=[...f.history.slice(0,2),{...f.history[2],payload:{...f.history[2].payload,output:'router_scope_conflict'}}];
    f.render('running',rejected,f.routing,[f.routing,f.second]);await tick();beforeAcceptance.push(ids(f.host).length);
    const rejectionVisible=f.host.querySelector('[role="status"].router-error')?.textContent==='正在重新确认分配信息，请稍候。'&&!f.host.textContent.includes('router_scope_conflict');
    f.render('running',f.history.slice(0,5),f.routing,[f.routing,f.second]);await tick();beforeAcceptance.push(ids(f.host).length);const retryClearsRejection=!f.host.querySelector('.router-error');
    f.render('running',f.history.slice(0,5),{...f.request,state:'routing'});await tick();beforeAcceptance.push(ids(f.host).length);
    f.render('running',f.history.slice(0,5),{...f.request,state:'cancelled'});await tick();beforeAcceptance.push(ids(f.host).length);
    f.render('running',f.history.slice(0,5),f.request);await wait(()=>ids(f.host).length===1);
    const first=f.host.querySelector('.router-assignment');
    const updated={...f.request,version:6,state:'bound',delivery:'queued',question:undefined,targetId:'updated-task',decision:{action:'reuse_task',taskId:'updated-task',reason:'宿主已接受复用'}};
    f.render('running',f.history.slice(0,5),updated);
    await wait(()=>f.host.textContent.includes('输入已排队'));
    const current=f.host.querySelector('.router-assignment'),sameCard=first===current,latestReceipt=current.textContent.includes('输入已排队')&&!current.querySelector('.router-question');
    [...current.querySelectorAll('button')].find(button=>button.textContent==='打开目标任务').click();
    f.render('running',f.history.slice(0,-2),updated);await tick();const running=ids(f.host);
    f.render('idle',f.history);await tick();const completed=ids(f.host),hydrated=ids(f.panelHost);
    f.mountPanel('reopen');await wait(()=>ids(f.panelHost).length>=2);const reopened=ids(f.panelHost);
    f.render('running',f.history.slice(0,5),{...updated,state:'committing',delivery:'dispatching'});await tick();const committing=ids(f.host);
    f.render('running',f.history.slice(0,5),{...updated,state:'queued',autoRecovery:undefined});await tick();const waiting=ids(f.host);
    f.render('idle',f.history.slice(0,5),{...updated,state:'failed',delivery:'failed',error:'任务创建失败'});await tick();const acceptedFailure=ids(f.host);
    const unknown=[{sessionId:'router-duplicates',seq:0,ts:1,type:'user_message',payload:{text:'缺少回执'}},...f.history.slice(1,5)];
    f.render('running',unknown,f.request,[]);await tick();
    const fallback=[...f.host.querySelectorAll('.tool-call > summary')].map(row=>row.textContent);
    const failed=[...unknown.slice(0,-1),{...unknown.at(-1),seq:5,state:'failed'}];
    f.render('running',failed,f.request,[]);await tick();
    const failedFallback=[...f.host.querySelectorAll('.tool-call > summary')].map(row=>row.textContent);
    return {waiting,beforeAcceptance,rejectionVisible,retryClearsRejection,committing,acceptedFailure,running,completed,hydrated,reopened,sameCard,latestReceipt,opened:f.opened,fallback,failedFallback,errors:f.errors};
  })()`
})
assert.deepEqual(duplicates.beforeAcceptance,[1,1,1,1,1],'every known request has one card, including routing, rejected calls and cancellation')
assert.equal(duplicates.rejectionVisible,true,'rejected assignment shows a readable status without the tool error')
assert.equal(duplicates.retryClearsRejection,true,'a later successful tool call clears the earlier recovery status')
assert.deepEqual(duplicates.committing,['11111111-1111-4111-8111-111111111111'],'accepted decisions remain visible during delivery')
assert.deepEqual(duplicates.waiting, [], 'saved assignment calls do not create a card for a waiting input')
assert.deepEqual(duplicates.acceptedFailure,['11111111-1111-4111-8111-111111111111'],'an accepted decision retains the task creation failure result')
for (const state of ['running', 'completed', 'hydrated', 'reopened'] as const) {
  assert.deepEqual(duplicates[state], ['11111111-1111-4111-8111-111111111111', ...(['hydrated','reopened'].includes(state)?['33333333-3333-4333-8333-333333333333']:[]), '22222222-2222-4222-8222-222222222222'],
    `${state}: one card per request; fallback receipts follow their input time and distinct identical inputs remain visible`)
}
assert.equal(duplicates.sameCard, true, 'updating a receipt keeps the original card mounted')
assert.equal(duplicates.latestReceipt, true, 'one card reflects the latest host receipt')
assert.deepEqual(duplicates.opened, ['updated-task'], 'the updated receipt opens the current target')
assert.deepEqual(duplicates.fallback, ['分配任务 · 正在读取回执'], 'missing receipts use one fallback with the latest tool state')
assert.deepEqual(duplicates.failedFallback, ['分配任务 · 调用失败'], 'a later failure updates the existing fallback')
assert.deepEqual(duplicates.errors, [])
console.log('PASS Router assignment deduplication: streaming, retries, follow-up turns, history/reopen, latest receipts and distinct identical inputs')

const clarification = await renderEventStream([], 'idle', 'router-clarification-continuation', {
  setup: `
    import {RouterAssignmentContext} from './src/renderer/components/RouterAssignmentCard';
    const event=(seq,type,payload)=>({sessionId:'router',seq,ts:seq+1,type,payload,state:'success'});
    const request=id=>({requestId:id,prompt:'相同输入',scope:{kind:'global'},config:{},version:4,state:'bound',delivery:'accepted',createdAt:1,updatedAt:1,decision:{action:'create_task_in_space',projectId:'space',reason:'明确归属'}});
    const requests=[{...request('original'),supplements:[{text:'属于 UniAgent 空间'}]},request('independent')];
    const turn=(seq,id)=>[event(seq,'user_message',{text:'相同输入',routedInputId:id}),event(seq+1,'tool_call',{name:'router_assign_task',input:{requestId:id,version:1}}),event(seq+2,'turn_completed',{})];
    const events=[...turn(0,'original'),...turn(3,'independent'),...turn(6,'original')];
    const host=document.body.appendChild(document.createElement('div')),normal=document.body.appendChild(document.createElement('div'));
    createRoot(host).render(React.createElement(RouterAssignmentContext.Provider,{value:{requests,agents:[],resolve:async()=>{},openTask:()=>{}}},React.createElement(EventStream,{sessionId:'router',status:'idle',events})));
    createRoot(normal).render(React.createElement(EventStream,{sessionId:'router',status:'idle',events}));
    window.clarificationFixture={host,normal};
  `,
  inspect: `(async()=>{
    const {host,normal}=window.clarificationFixture;for(let i=0;i<100&&!host.querySelector('.router-assignment');i++)await new Promise(r=>setTimeout(r,15));
    return{inputs:host.querySelectorAll('.user-msg').length,cards:host.querySelectorAll('.router-assignment').length,
      supplements:host.querySelector('[data-router-request="original"]').textContent.includes('属于 UniAgent 空间'),normalInputs:normal.querySelectorAll('.user-msg').length};
  })()`
})
assert.equal(clarification.inputs,2,'clarification resumes the original input; identical independent submissions stay separate')
assert.equal(clarification.cards,2,'clarification updates the same assignment card')
assert.equal(clarification.supplements,true,'the original card retains the supplemental answer')
assert.equal(clarification.normalInputs,3,'normal conversation and details retain every real routing turn')

const placement = await renderEventStream([], 'idle', 'router-assignment-placement', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'deepseek',model:'flash',version:1};
    const agents=[{id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:'flash',label:'Flash',efforts:[]}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]}}];
    const session={id:'router-placement',title:'RouterAgent',createdAt:1,status:'running',config:{agentId:'deepseek',model:'flash',workdir:'/fixture',managedPurpose:'router'}};
    const request=(requestId,createdAt,state)=>({requestId,prompt:'输入 '+requestId,scope:{kind:'global'},config,createdAt,updatedAt:createdAt,state,delivery:'pending',version:1});
    let requests=[request('old-failed',1,'failed'),request('old-cancelled',2,'cancelled'),{...request('old-bound',3,'bound'),delivery:'finished',targetId:'unrelated-task'}, {...request('first',1000,'routing'),routerSessionId:session.id}];
    const event=(seq,ts,type,payload)=>({sessionId:session.id,seq,ts,type,payload,state:'success'});
    const routerChanges=new Set();
    let events=[event(0,1010,'user_message',{text:'第一项输入',routedInputId:'first'})],changed=()=>routerChanges.forEach(cb=>cb()),push=()=>{},activeRequestId='first';
    const errors=[],opened=[];window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getRouterReview:async id=>({request:{requestId:id},revision:0,attempts:[],feedbackHistory:[]}),getRouterSnapshot:async()=>({config,available:true,sessionId:session.id,activeRequestId,requests}),openRouter:async()=>session,getEvents:async()=>events,getTurnArtifactSummary:async()=>null,getPrefs:async()=>({lastByAgent:{}}),
      onRouterChanged:cb=>{routerChanges.add(cb);return()=>routerChanges.delete(cb)},onEvent:cb=>{push=cb;return()=>{}}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';const root=createRoot(host);
    const mount=key=>root.render(React.createElement(RouterPanel,{key,agents,onSettings:()=>{},onOpenTask:id=>opened.push(id),mergeEvent:mergeSessionEvent}));mount('initial');
    const append=rows=>{events=[...events,...rows];rows.forEach(push)};
    const finish=id=>{requests=requests.map(row=>row.requestId===id?{...row,state:'bound',delivery:'accepted',version:row.version+1,targetId:id+'-task',targetTitle:id+' 目标',decision:{action:'reuse_task',taskId:id+'-task',reason:'已确认目标'}}:row);changed();const seq=events.at(-1).seq,ts=events.at(-1).ts;
      append([event(seq+1,ts+10,'tool_call',{id:id+'-call',name:'router_assign_task',input:{requestId:id,version:1}}),event(seq+2,ts+20,'agent_message',{text:'分配完成'}),event(seq+3,ts+30,'turn_completed',{})])};
    window.placementFixture={host,errors,opened,finish,mount,queueNext:()=>{requests=[...requests,{...request('second',1500,'queued'),routerSessionId:session.id}];changed()},startNext:()=>{activeRequestId='second';requests=requests.map(row=>row.requestId==='second'?{...row,state:'routing',version:row.version+1}:row);requests.push({...request('between-cancelled',1600,'cancelled'),routerSessionId:session.id,roundStartedAt:1600});changed();append([event(4,2010,'user_message',{text:'第二项输入',routedInputId:'second'})])}};
  `,
  inspect: `(async()=>{
    const f=window.placementFixture,tick=()=>new Promise(r=>setTimeout(r,15)),wait=async check=>{for(let i=0;i<160;i++){if(check())return;await tick()}throw Error('Router card placement timeout: '+f.host.textContent+' / '+f.errors)};
    const ids=()=>[...f.host.querySelectorAll('[data-router-request]')].map(row=>row.dataset.routerRequest);
    const card=id=>f.host.querySelector('[data-router-request="'+id+'"]');
    await wait(()=>card('first'));for(let i=0;i<5;i++)await tick();const routing=ids();
    f.queueNext();await wait(()=>f.host.querySelectorAll('.queue-card').length===1);for(let i=0;i<5;i++)await tick();const waiting={cards:ids(),queue:f.host.querySelector('.queue-text').textContent};
    f.finish('first');await wait(()=>card('first')?.textContent.includes('分配成功'));for(let i=0;i<5;i++)await tick();const firstDone=ids();
    const stream=f.host.querySelector('.event-stream').getBoundingClientRect(),receipt=card('first').getBoundingClientRect();const successVisible=receipt.bottom>stream.top&&receipt.top<stream.bottom&&!card('first').closest('details:not([open]),[aria-hidden="true"]');
    [...card('first').querySelectorAll('button')].find(button=>button.textContent==='打开目标任务').click();
    f.startNext();await wait(()=>card('second'));for(let i=0;i<5;i++)await tick();const nextRouting=ids();
    f.finish('second');await wait(()=>card('second')?.textContent.includes('分配成功'));for(let i=0;i<5;i++)await tick();const bothDone=ids();
    [...card('second').querySelectorAll('button')].find(button=>button.textContent==='打开目标任务').click();
    f.mount('reopened');await wait(()=>card('second'));for(let i=0;i<5;i++)await tick();
    return {waiting,successVisible,routing,firstDone,nextRouting,bothDone,reopened:ids(),opened:f.opened,errors:f.errors};
  })()`
})
assert.deepEqual(placement.errors, [])
assert.deepEqual(placement.waiting, {cards:['old-failed','first'],queue:'输入 second'}, 'unrelated terminal requests stay out of the conversation while pending preparation failures remain retryable')
assert.equal(placement.successVisible, true, 'the completed receipt remains visible while the next input waits in the queue')
for (const stage of ['routing', 'firstDone'] as const) {
  assert.deepEqual(placement[stage], ['old-failed', 'first'], `${stage}: unrelated cancelled and bound requests must not push the current result above the visible latest input`)
}
for (const stage of ['nextRouting', 'bothDone', 'reopened'] as const) {
  assert.deepEqual(placement[stage], ['old-failed', 'first', 'between-cancelled', 'second'], `${stage}: a cancellation after routing started remains in its own Session`)
}
assert.deepEqual(placement.opened, ['first-task', 'second-task'])
console.log('PASS Router assignment placement: retryable preparation failures, scoped cancellations, unrelated terminal records, consecutive results and reopening')
