import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-conversation-detail', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {SessionConversation} from './src/renderer/components/SessionConversation';
    import {mergeSessionEvent} from './src/renderer/App';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const agent={id:'codex',name:'Codex',installed:true,adapter:'app-server',models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}};
    const config={enabled:true,agentId:'codex',model:'model',version:1};
    const event=(id,seq,type,payload)=>({sessionId:id,seq,ts:seq+100,type,payload,state:'success'});
    const rows={old:[event('old',0,'user_message',{text:'历史输入',routedInputId:'old-request'}),event('old',1,'agent_message',{text:'历史分配回复',phase:'final_answer'}),event('old',2,'turn_completed',{}),event('old',3,'user_message',{text:'历史未完成输入'}),event('old',4,'turn_started',{}),event('old',5,'system_notice',{kind:'launch',label:'历史启动信息',text:'启动: codex app-server'}),event('old',6,'agent_message',{text:'历史核对过程',phase:'commentary'}),event('old',7,'command_exec',{id:'old-command',command:'ls',output:'/history',exitCode:0})],current:[
      event('current',0,'user_message',{text:'协议包装输入',displayText:'第一项原始输入',routedInputId:'first'}),
      event('current',1,'system_notice',{kind:'launch',text:'已启动 Codex app-server',model:'model'}),event('current',2,'reasoning',{id:'reason',text:'先核对任务上下文'}),
      event('current',3,'agent_message',{text:'读取候选任务',phase:'commentary'}),
      event('current',4,'command_exec',{id:'command',command:'pwd',output:'/fixture',exitCode:0}),
      event('current',5,'tool_call',{id:'assignment',name:'router_assign_task',input:{requestId:'first',version:1},result:{accepted:true}}),
      event('current',6,'agent_message',{text:'第一项已分配',phase:'final_answer'}),event('current',7,'turn_completed',{}),
      event('current',8,'user_message',{text:'第二项原始输入',routedInputId:'second'}),event('current',9,'turn_started',{}),
      event('current',10,'agent_message',{text:'正在核对第二项',phase:'commentary'}),event('current',11,'command_exec',{id:'current-command',command:'git status',output:'',exitCode:0})],next:[]};
    let session={id:'current',title:'RouterAgent',createdAt:1,status:'running',config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}};
    let segments=[{sessionId:'old',agentId:'codex'},{sessionId:'current',agentId:'codex'}];
    const request=(id,sessionId,state,prompt)=>({requestId:id,routerSessionId:sessionId,state,prompt,scope:{kind:'global'},config,version:1,delivery:state==='bound'?'accepted':'pending',createdAt:1,updatedAt:1});
    let requests=[request('old-request','old','bound','历史输入'),request('first','current','bound','第一项原始输入'),request('second','current','routing','第二项原始输入'),request('unstarted',undefined,'failed','尚未执行的输入'),request('missing','missing','needs_input','缺少历史的输入')];
    const changes=new Set(),events=new Set(),statuses=new Set(),calls=[],errors=[];let rejectMissing=true,resolveMissing;
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>({lastByAgent:{}}),getAppSettings:async()=>({defaultTaskWorktree:false}),listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],
      getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir),
      getRouterSnapshot:async()=>({config,available:true,sessionId:session.id,conversationSessions:segments,requests}),openRouter:async()=>session,
      getEvents:async id=>{calls.push(['getEvents',id]);if(id==='missing'){if(rejectMissing)throw Error('历史读取失败');return new Promise(resolve=>resolveMissing=resolve)}return rows[id]||[]},
      onRouterChanged:cb=>{changes.add(cb);return()=>changes.delete(cb)},onEvent:cb=>{events.add(cb);return()=>events.delete(cb)},onStatusChange:cb=>{statuses.add(cb);return()=>statuses.delete(cb)},
      submitRouterInput:async()=>calls.push(['submit']),resolveRouterInput:async()=>calls.push(['resolve']),newRouterSession:async()=>calls.push(['new']),respondRequest:async()=>calls.push(['respond'])
    },{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';let root=createRoot(host);
    const props={agents:[agent],focusRequestId:'first',onOpenTask:()=>calls.push(['openTask']),onSettings:()=>{},mergeEvent:mergeSessionEvent};
    root.render(React.createElement(RouterPanel,props));
    const reference=document.body.appendChild(document.createElement('div'));reference.className='session-view';reference.style.cssText='position:fixed;left:2000px;width:1100px;height:900px';
    createRoot(reference).render(React.createElement(SessionConversation,{sessionId:'current',status:'running',events:rows.current.map(e=>e.payload.displayText?{...e,payload:{...e.payload,text:e.payload.displayText}}:e)}));
    const push=e=>{rows[e.sessionId]=mergeSessionEvent(rows[e.sessionId]||[],e);events.forEach(cb=>cb(e))};
    window.detailFixture={host,reference,calls,errors,push,select:id=>{props.focusRequestId=id;root.render(React.createElement(RouterPanel,props))},subscriberCount:()=>events.size,retryMissing:()=>{rejectMissing=false},finishMissing:()=>resolveMissing?.([event('missing',0,'user_message',{text:'补载的原始历史',routedInputId:'missing'})]),
      switch:()=>{session={...session,id:'next'};segments=[...segments,{sessionId:'next',agentId:'codex'}];config.version++;changes.forEach(cb=>cb())},
      unavailable:()=>{root.unmount();session={...session,id:undefined};config.enabled=false;requests=[{...request('offline','offline','failed','离线原输入')}];root=createRoot(host);root.render(React.createElement(RouterPanel,props))}};
  `,
  inspect: `(async()=>{
    const f=window.detailFixture,tick=()=>new Promise(r=>setTimeout(r,15)),wait=async(check,label)=>{for(let i=0;i<180;i++){if(check())return;await tick()}throw Error('Detail '+label+': '+f.host.textContent+' / '+f.errors)};
    const card=id=>f.host.querySelector('[data-router-request="'+id+'"]'),button=(host,text)=>[...host.querySelectorAll('button')].find(b=>b.textContent.trim()===text),detail=()=>f.host.querySelector('[data-router-detail]'),back=()=>f.host.querySelector('[aria-label="返回分配列表"]');
    await wait(()=>card('first')&&card('unstarted')&&f.host.querySelector('.router-task-composer'),'initial cards');
    const list=()=>f.host.querySelector('.router-list-view'),noProcess=()=>!list().querySelector('.process-timeline-head,.process-step,.processed-fold,.status-line,.steps-fold')&&!['已启动 Codex app-server','历史启动信息','历史核对过程','先核对任务上下文','正在核对第二项'].some(text=>list().textContent.includes(text));
    const conversationButton=()=>f.host.querySelector('[aria-label="查看 RouterAgent 会话"]'),open=async id=>{f.select(id);await tick();conversationButton().click()};
    const checks={toolbarConversationEntry:!!conversationButton()&&conversationButton().nextElementSibling?.getAttribute('aria-label')==='新建 RouterAgent 会话',cardsHaveNoDetails:[...f.host.querySelectorAll('.router-assignment')].every(c=>!button(c,'查看详情')),listHidesLiveAndHistoricalProcess:noProcess(),normalConversationStillShowsProcess:!!f.reference.querySelector('.process-step')&&!!f.reference.querySelector('.status-line'),listKeepsInputsAndCards:list().textContent.includes('第一项原始输入')&&list().textContent.includes('第二项原始输入')&&!!card('first')&&!!card('second')};
    checks.listHidesFinalReplies=!['第一项已分配','历史分配回复'].some(text=>list().textContent.includes(text))&&!list().querySelector('.message-actions.agent');
    checks.normalConversationKeepsFinalReply=f.reference.textContent.includes('第一项已分配');
    if(!checks.toolbarConversationEntry)return{checks,errors:f.errors};
    const composer=f.host.querySelector('.router-task-composer');window.__markdownInput.fill(composer,'保留的新任务草稿');await tick();
    const listStream=f.host.querySelector('.router-list-view .event-stream');listStream.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}));listStream.scrollTop=100;await tick();const savedScroll=listStream.scrollTop;checks.listCanScroll=savedScroll>0;
    const subscribers=f.subscriberCount();await open('first');await wait(()=>detail()?.querySelector('.event-stream')&&back(),'open');
    checks.fullNormalTranscript=detail().textContent.includes('第一项原始输入')&&detail().textContent.includes('第一项已分配')&&!detail().textContent.includes('协议包装输入')&&!detail().querySelector('.router-assignment');
    checks.detailShowsLiveActivity=!!detail().querySelector('.process-step')&&!!detail().querySelector('.status-line');
    const currentSteps=[...detail().querySelectorAll('.process-step')].filter(row=>!row.closest('[data-router-history-session]'));
    checks.sameTimeline=currentSteps.length===f.reference.querySelectorAll('.process-step').length&&currentSteps.length>0;
    checks.previousAgentHistoryInConversation=detail().textContent.includes('历史分配回复')&&detail().textContent.includes('第二项原始输入');
    const fold=[...detail().querySelectorAll('.processed-head')].find(row=>!row.closest('[data-router-history-session]'));checks.sameHistoryDisclosure=!!fold;if(fold){fold.click();await wait(()=>detail().querySelector('.processed-body .process-step'),'normal history');const step=[...detail().querySelectorAll('.processed-body .process-step')].find(row=>row.textContent.includes('读取候选任务'));step.querySelector('button').click();await wait(()=>detail().textContent.includes('router_assign_task'),'normal assignment tool');const tool=[...detail().querySelectorAll('.step-call')].find(row=>row.querySelector('.step-call-name')?.textContent==='router_assign_task');tool.querySelector('.step-call-row').click();await wait(()=>tool.textContent.includes('accepted'),'normal tool output');checks.originalToolInputAndOutput=tool.textContent.includes('requestId')&&tool.textContent.includes('first');}
    f.push({sessionId:'current',seq:12,ts:112,type:'agent_message',payload:{text:'详情中的实时回复',phase:'commentary'},state:'success'});await wait(()=>detail().textContent.includes('详情中的实时回复'),'live reply');
    checks.liveProcessStaysInDetails=!list().textContent.includes('详情中的实时回复')&&noProcess();
    f.push({sessionId:'current',seq:12,ts:112,type:'agent_message',payload:{text:'详情中的流式最终回复',phase:'final_answer'},state:'success'});await wait(()=>detail().textContent.includes('详情中的流式最终回复'),'live final reply');
    checks.listHidesStreamingFinalReply=!list().textContent.includes('详情中的流式最终回复')&&!list().querySelector('.message-actions.agent');
    f.push({sessionId:'current',seq:13,ts:113,type:'approval_request',state:'pending',payload:{requestId:'native-choice',kind:'question',method:'item/tool/requestUserInput',params:{questions:[{id:'choice',header:'范围',prompt:'选择目标范围',options:[{label:'当前需求'},{label:'当前空间'}]}]}}});await wait(()=>f.host.querySelector('.interaction-dock .question-form'),'original question dock');const question=f.host.querySelector('.interaction-dock .question-form'),radio=question.querySelector('input[type=radio]');radio.click();await tick();checks.singleOriginalQuestionDock=f.host.querySelectorAll('.interaction-dock .question-form').length===1;
    checks.draftStaysMounted=composer===f.host.querySelector('.router-task-composer')&&window.__markdownInput.text(composer)==='保留的新任务草稿';
    checks.noDuplicateSubscription=f.subscriberCount()===subscribers;
    back().click();await wait(()=>!detail()&&!back(),'back');await tick();await tick();checks.originalCardsRetained=!!card('first')&&window.__markdownInput.text(composer)==='保留的新任务草稿';checks.listScrollRestored=listStream===f.host.querySelector('.router-list-view .event-stream')&&Math.abs(listStream.scrollTop-savedScroll)<2;checks.questionChoicePreserved=question===f.host.querySelector('.interaction-dock .question-form')&&radio.checked;
    checks.returnKeepsProcessHidden=noProcess();
    await open('old-request');await wait(()=>detail()?.textContent.includes('历史分配回复'),'old history');
    checks.historyScoped=!detail().textContent.includes('第二项原始输入');const historicalStart=[...detail().querySelectorAll('.process-step')].find(row=>row.textContent.includes('任务开始'));historicalStart.querySelector('button').click();await wait(()=>detail().textContent.includes('历史启动信息'),'historical launch');checks.historyDetailsKeepProcess=detail().textContent.includes('历史启动信息')&&detail().textContent.includes('历史核对过程');f.switch();await tick();await tick();
    f.push({sessionId:'old',seq:8,ts:120,type:'agent_message',payload:{text:'历史会话的迟到记录',phase:'commentary'},state:'success'});await wait(()=>detail().textContent.includes('历史会话的迟到记录'),'late old event');
    checks.switchKeepsSelectedHistory=!detail().textContent.includes('详情中的实时回复');back().click();await wait(()=>!detail(),'history back');
    checks.historyPushDoesNotRevealProcess=noProcess()&&!list().textContent.includes('历史会话的迟到记录');
    await open('unstarted');await wait(()=>detail()?.textContent.includes('暂无对话记录'),'unbound');checks.unboundUsesOriginalInput=detail().textContent.includes('尚未执行的输入');back().click();await wait(()=>!detail(),'unbound back');
    await open('missing');await wait(()=>detail()?.textContent.includes('历史读取失败'),'load error');checks.errorKeepsBack=!!back();f.push({sessionId:'missing',seq:2,ts:122,type:'agent_message',payload:{text:'读取失败后的迟到事件',phase:'commentary'},state:'success'});back().click();await wait(()=>!detail(),'failed load back');await open('missing');await wait(()=>detail()?.textContent.includes('历史读取失败'),'reopen incomplete history');checks.partialPushDoesNotReplaceFullHistory=true;f.retryMissing();button(detail(),'重试').click();await wait(()=>detail()?.getAttribute('aria-busy')==='true','retry loading');
    f.push({sessionId:'missing',seq:1,ts:121,type:'agent_message',payload:{text:'补载期间收到的回复',phase:'final_answer'},state:'success'});f.finishMissing();await wait(()=>detail().textContent.includes('补载的原始历史')&&detail().textContent.includes('补载期间收到的回复'),'hydrate merge');
    checks.retryPreservesIncoming=true;back().click();await wait(()=>!detail(),'retry back');checks.noMutationFromDetails=!f.calls.some(row=>['submit','resolve','new','openTask','respond'].includes(row[0]));
    f.unavailable();await wait(()=>card('offline'),'disabled card');f.host.style.width='520px';await tick();const header=card('offline').querySelector('header'),status=header.querySelector('.router-assignment-status').getBoundingClientRect();checks.narrowHeaderKeepsStatusVisible=status.right<=header.getBoundingClientRect().right&&status.left>=header.getBoundingClientRect().left;conversationButton().click();await wait(()=>detail()?.textContent.includes('暂无对话记录'),'empty offline history');checks.unavailableStillHasDetails=!!back();back().click();await wait(()=>!detail()&&card('offline'),'disabled return');
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
assert.ok(Object.keys(result.checks).length > 1, 'detail interaction checks must execute')
console.log('PASS Router details: shared normal timeline and tools, live/history events, preserved composer and question choices, unbound input, load retry and hydration race')

const prompts = await renderEventStream([], 'idle', 'router-message-original-input', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'codex',model:'model',version:1};
    const agent={id:'codex',name:'Codex',installed:true,adapter:'app-server',models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[]}};
    const session={id:'current',title:'RouterAgent',createdAt:1,status:'idle',config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}};
    const image={kind:'image',name:'image.png',path:'/fixture/image.png'};
    const event=(id,seq,type,payload)=>({sessionId:id,seq,ts:100+seq,type,payload});
    const rows={old:[event('old',0,'user_message',{text:'历史 Router 附加指令',displayText:'历史用户输入',routedInputId:'old-input'}),event('old',1,'turn_completed',{})],current:[
      event('current',0,'user_message',{text:'图片 Router 附加指令',routedInputId:'image-input',attachments:[image]}),event('current',1,'turn_completed',{}),
      event('current',2,'user_message',{text:'文字 Router 附加指令',displayText:'用户文字输入',routedInputId:'text-input'}),event('current',3,'turn_completed',{})]};
    const request=(id,routerSessionId,prompt)=>({requestId:id,routerSessionId,prompt,scope:{kind:'global'},config,version:1,state:'bound',delivery:'accepted',createdAt:1,updatedAt:1});
    const requests=[request('old-input','old','历史用户输入'),{...request('image-input','current',''),attachments:[image]},request('text-input','current','用户文字输入')];
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config,available:true,sessionId:session.id,requests,conversationSessions:[{sessionId:'old',agentId:'codex'},{sessionId:'current',agentId:'codex'}]}),
      openRouter:async()=>session,getEvents:async id=>rows[id]||[],getPrefs:async()=>({lastByAgent:{}}),
      fsReadAttachmentImage:async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII='},
      {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.height='900px';
    createRoot(host).render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));window.routerPromptFixture={host,rows};
  `,
  inspect: `(async()=>{
    const {host,rows}=window.routerPromptFixture,tick=()=>new Promise(r=>setTimeout(r,20)),wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Router prompt timeout: '+host.textContent)};
    await wait(()=>host.textContent.includes('用户文字输入')&&host.textContent.includes('历史用户输入')&&host.querySelector('img'));
    const list=host.querySelector('.router-list-view'),imageRow=[...list.querySelectorAll('.user-msg')].find(row=>row.querySelector('img'));
    const checks={imageOnly:imageRow.querySelector('.bubble').textContent.trim()==='',wireHidden:!list.textContent.includes('Router 附加指令'),
      nativeHistoryUnchanged:rows.old[0].payload.text==='历史 Router 附加指令'&&rows.current[0].payload.displayText===undefined};
    const openPrompt=async(row,text)=>{const button=row.querySelector('[aria-label="查看附加提示词"]');if(!button)return false;button.click();await tick();const panel=document.getElementById(button.getAttribute('aria-controls')),matches=panel?.querySelector('pre').textContent===text;panel?.querySelector('[aria-label="关闭附加提示词"]').click();await tick();return matches};
    checks.imagePrompt=await openPrompt(imageRow,'图片 Router 附加指令');
    checks.oldPrompt=await openPrompt(list.querySelector('.router-history-segment .user-msg'),'历史 Router 附加指令');
    host.querySelector('[aria-label="查看 RouterAgent 会话"]').click();await wait(()=>host.querySelector('[data-router-detail] .user-msg img'));
    const detail=host.querySelector('[data-router-detail]'),detailImage=[...detail.querySelectorAll('.user-msg')].find(row=>row.querySelector('img'));checks.detailImageOnly=detailImage.querySelector('.bubble').textContent.trim()==='';
    checks.detailPrompt=await openPrompt(detailImage,'图片 Router 附加指令');
    return {checks,errors:window.__fixtureErrors};
  })()`,
})
assert.deepEqual(prompts.errors, [])
for (const [name, passed] of Object.entries(prompts.checks)) assert.equal(passed, true, name)
console.log('PASS Router prompts: original inputs and full supplemental prompts survive list, history and detail views, including legacy image-only messages')
