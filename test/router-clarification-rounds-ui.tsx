import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result=await renderEventStream([], 'idle', 'router-clarification-rounds', {
  setup:`
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    const config={enabled:true,agentId:'codex',model:'model',version:1};
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}};
    const session={id:'router',title:'RouterAgent',createdAt:1,status:'running',config:{agentId:'codex',model:'model',managedPurpose:'router',workdir:'/fixture'}};
    const event=(seq,ts,type,payload)=>({sessionId:'router',seq,ts,type,payload,state:'success'});
    let request={requestId:'clarify',roundId:'round-1',roundStartedAt:10,routerSessionId:'router',prompt:'查看接入进展',scope:{kind:'global'},config,version:4,state:'needs_input',delivery:'pending',createdAt:1,updatedAt:20,
      decision:{action:'clarify',reason:'截图有两种解释',clarification:'这次希望移动哪个设置？',clarificationOptions:[{label:'把「开发者选项」移到 superAgent 配置页'},{label:'把黄框里的「按项目和需求组织侧栏」移到 superAgent 配置页',description:'仅移动黄框里的设置'}]},question:'这次希望移动哪个设置？'};
    let events=[event(0,11,'user_message',{text:request.prompt,routedInputId:request.requestId}),event(1,15,'tool_call',{name:'router_assign_task',input:{requestId:request.requestId,version:3,action:'clarify'}}),event(2,18,'agent_message',{text:'卡片外重复的澄清说明',phase:'final_answer'}),event(3,19,'system_notice',{kind:'usage',usage:{inputTokens:100,outputTokens:20}}),event(4,20,'turn_completed',{})];
    const listeners=new Set(),eventListeners=new Set(),resolutions=[],errors=[];let active='other',offline=false;
    const changed=()=>listeners.forEach(cb=>cb());
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>({lastByAgent:{}}),getAppSettings:async()=>({defaultTaskWorktree:false}),listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],
      getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir),openRouter:async()=>session,getEvents:async()=>events,
      getRouterSnapshot:async()=>({config:{...config,enabled:!offline},available:!offline,sessionId:offline?undefined:'router',activeRequestId:active,requests:[request]}),onRouterChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},onEvent:cb=>{eventListeners.add(cb);return()=>eventListeners.delete(cb)},
      resolveRouterInput:input=>new Promise((resolve,reject)=>resolutions.push({input,reject,resolve:()=>{const {clarifications,context,...snapshot}=request;request={...request,roundId:undefined,roundStartedAt:undefined,state:'queued',version:5,question:undefined,decision:undefined,clarifications:[{id:'round-1',answeredAt:25,answer:input.answer,snapshot}]};changed();resolve()}}))
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';let root=createRoot(host);const render=()=>root.render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));render();
    const push=(...rows)=>{events=[...events,...rows];for(const row of rows)eventListeners.forEach(cb=>cb(row))};
    window.roundsFixture={host,resolutions,errors,late:()=>push({...events[1],payload:{...events[1].payload,result:'迟到的原轮回执'}}),restart:()=>{root.unmount();root=createRoot(host);render()},offline:()=>{offline=true;root.unmount();root=createRoot(host);render()},start:()=>{active='clarify';request={...request,roundId:'round-2',roundStartedAt:30,state:'routing',version:10};push(event(5,31,'user_message',{text:request.prompt,routedInputId:request.requestId}));changed()},
      finish:()=>{active=undefined;request={...request,state:'bound',delivery:'accepted',version:13,decision:{action:'create_task_in_requirement',requirementId:'daily',reason:'已明确归属'},targetId:'task',targetTitle:'接入进展'};push(event(6,35,'tool_call',{name:'router_assign_task',input:{requestId:request.requestId,version:12,action:'create_task_in_requirement'}}),event(7,38,'agent_message',{text:'新的分配已经完成',phase:'final_answer'}),event(8,40,'turn_completed',{}));changed()},
      emptyCandidates:()=>{request={...request,state:'needs_input',roundId:'empty',version:14,decision:{action:'clarify',reason:'没有可选归属',clarificationOptions:[]},question:'请自行补充'};changed()}};
  `,
  inspect:`(async()=>{
    const f=window.roundsFixture,tick=()=>new Promise(r=>setTimeout(r,15)),wait=async check=>{for(let i=0;i<180;i++){if(check())return;await tick()}throw Error('Round UI timeout: '+f.host.textContent+' / '+f.errors)};
    const cards=()=>[...f.host.querySelectorAll('[data-router-request="clarify"]')],button=(card,text)=>[...card.querySelectorAll('button')].find(row=>row.textContent===text);
    await wait(()=>cards().length===1&&f.host.querySelector('.router-task-composer'));const initial=cards()[0];
    const checks={choicesFirst:initial.querySelectorAll('input[type=radio]').length===3,noTextBeforeCustom:!initial.querySelector('[aria-label="补充路由信息"]'),duplicateReplyHidden:!f.host.querySelector('.router-list-view').textContent.includes('卡片外重复的澄清说明'),clarificationActionsHidden:!f.host.querySelector('.message-actions.agent')};if(!checks.choicesFirst)return{checks,errors:f.errors};
    initial.querySelectorAll('input[type=radio]')[2].click();await wait(()=>initial.querySelector('[aria-label="补充路由信息"]'));checks.customEmptyBlocked=button(initial,'继续分配').disabled;
    checks.otherLabel=initial.querySelectorAll('input[type=radio]')[2].closest('label').textContent==='其他';
    const custom=initial.querySelector('[aria-label="补充路由信息"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(custom,'待保留的自填答案');custom.dispatchEvent(new Event('input',{bubbles:true}));await tick();
    initial.querySelectorAll('input[type=radio]')[0].click();await tick();checks.singleSelection=initial.querySelectorAll('input[type=radio]:checked').length===1&&!initial.querySelector('[aria-label="补充路由信息"]')&&!button(initial,'继续分配').disabled;checks.selectionAloneDoesNotSubmit=f.resolutions.length===0;
    initial.querySelectorAll('input[type=radio]')[2].click();await tick();checks.customDraftKept=initial.querySelector('[aria-label="补充路由信息"]').value==='待保留的自填答案';
    initial.querySelectorAll('input[type=radio]')[1].click();await tick();button(initial,'继续分配').click();button(initial,'继续分配').click();await wait(()=>f.resolutions.length===1);
    checks.choiceSubmitsPlainAnswer=f.resolutions[0].input.optionId===undefined&&f.resolutions[0].input.expectedVersion===4&&f.resolutions[0].input.action==='answer'&&f.resolutions[0].input.answer==='把黄框里的「按项目和需求组织侧栏」移到 superAgent 配置页';
    f.resolutions[0].reject(Error('暂时提交失败'));await wait(()=>initial.textContent.includes('暂时提交失败'));checks.failedChoiceRetained=initial.querySelectorAll('input[type=radio]')[1].checked;
    button(initial,'继续分配').click();await wait(()=>f.resolutions.length===2);f.resolutions[1].resolve();await wait(()=>cards().some(card=>card.textContent.includes('澄清结束')));
    checks.queueKeepsOnlyFrozenCard=cards().length===1&&!!f.host.querySelector('.router-input-queue')&&!cards()[0].querySelector('input');
    const frozen=cards()[0],oldText=frozen.textContent;checks.frozenAnswerSaved=frozen.querySelector('.router-clarification-answer').textContent.includes('把黄框里的「按项目和需求组织侧栏」移到 superAgent 配置页');
    f.late();await tick();checks.lateOriginalReceiptCannotChangeFrozenCard=cards()[0].textContent===oldText;
    f.start();await wait(()=>cards().length===2);checks.newCardAfterSend=cards().some(card=>card.textContent.includes('正在分配'))&&!f.host.querySelector('.router-input-queue');checks.oldCardUnchangedOnSend=frozen.textContent===oldText;
    f.finish();await wait(()=>cards().some(card=>card.textContent.includes('分配成功')));checks.oldCardUnchangedOnResult=frozen.textContent===oldText;checks.noDuplicateCurrentCard=cards().length===2;checks.oldReplyStaysHidden=!f.host.querySelector('.router-list-view').textContent.includes('卡片外重复的澄清说明');checks.successReplyHidden=!f.host.querySelector('.router-list-view').textContent.includes('新的分配已经完成');
    f.restart();await wait(()=>cards().length===2&&f.host.querySelector('.router-task-composer'));checks.restoredFrozenHistory=cards().find(card=>card.dataset.routerClarification)?.textContent===oldText;
    f.offline();await wait(()=>f.host.querySelector('.router-unavailable'));checks.disabledRouterKeepsBothCards=cards().length===2&&cards().find(card=>card.dataset.routerClarification)?.textContent===oldText;
    f.emptyCandidates();await wait(()=>cards().some(card=>card.textContent.includes('请自行补充')));const empty=cards().find(card=>!card.dataset.routerClarification);
    checks.noCandidatesStillOffersOther=empty.querySelectorAll('input[type=radio]').length===1&&empty.querySelector('label').textContent==='其他'&&!empty.querySelector('[aria-label="补充路由信息"]');
    if(checks.noCandidatesStillOffersOther){empty.querySelector('input[type=radio]').click();await tick();checks.otherStillRequiresText=!!empty.querySelector('[aria-label="补充路由信息"]')&&button(empty,'继续分配').disabled;}
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors,[])
for(const [name,passed] of Object.entries(result.checks))assert.equal(passed,true,name)
console.log('PASS Router clarification UI: candidate/custom choice, failed drafts, frozen cards through queue/send/result, independent new cards and scoped reply suppression')
