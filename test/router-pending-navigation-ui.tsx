import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-pending-navigation-ui', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[]},lifecycle:{availability:'available'}};
    const config={enabled:true,agentId:'codex',model:'model',version:1};
    const request=(id,sessionId)=>({requestId:id,routerSessionId:sessionId,prompt:'处理文档评论：'+id,scope:{kind:'global'},config,version:8,state:'needs_input',delivery:'pending',createdAt:2,updatedAt:3,execution:{agentId:'codex',model:'model',workdir:'/fixture'},decision:{action:'clarify',reason:'缺少归属信息。'.repeat(50),clarification:'这个文档属于哪个需求？'},question:'这个文档属于哪个需求？'});
    const selected=request('selected','current'),other=request('other','current');
    const event=(sessionId,seq,type,payload)=>({sessionId,seq,ts:seq+1,type,state:'success',payload});
    const turn=(sessionId,seq,id)=>[event(sessionId,seq,'user_message',{text:'处理文档评论：'+id}),event(sessionId,seq+1,'tool_call',{name:'router_assign_task',input:{requestId:id,version:7}}),event(sessionId,seq+2,'agent_message',{text:'请先确认归属',phase:'final_answer'}),event(sessionId,seq+3,'turn_completed',{})];
    const later=Array.from({length:16},(_,i)=>[event('current',20+i*3,'user_message',{text:'后续任务 '+i}),event('current',21+i*3,'agent_message',{text:'后续回答 '+i+'。'.repeat(180),phase:'final_answer'}),event('current',22+i*3,'turn_completed',{})]).flat();
    let currentId='current',requests=[other,selected],segments=[],histories={current:[...turn('current',0,'other'),...turn('current',5,'selected'),...later]},changed=()=>{},holdSnapshot=false,resumeSnapshot=()=>{};
    const errors=[],resolutions=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>({lastByAgent:{}}),getRouterSnapshot:async()=>{if(holdSnapshot)await new Promise(resolve=>resumeSnapshot=resolve);return{config,available:true,sessionId:currentId,conversationSessions:segments,requests}},onRouterChanged:cb=>{changed=cb;return()=>{}},openRouter:async()=>({id:currentId,title:'RouterAgent',createdAt:100,status:'idle',config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}}),getEvents:async id=>histories[id]||[],resolveRouterInput:async input=>{resolutions.push(input);requests=requests.map(row=>row.requestId===input.requestId?{...row,state:'queued',version:row.version+1,question:undefined,decision:undefined}:row);changed()}},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';const root=createRoot(host);
    let generation=0;const viewState={current:undefined};
    const mount=(focusRequestId,cached=false)=>{if(!cached)viewState.current=undefined;root.render(React.createElement(RouterPanel,{key:++generation,focusRequestId,viewState,agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}))};
    mount('selected');window.pendingNavigation={host,errors,resolutions,mount,refresh:()=>changed(),reenterCached:()=>{holdSnapshot=true;mount('selected',true)},resumeSnapshot:()=>{holdSnapshot=false;resumeSnapshot()},reask:()=>{requests=requests.map(row=>({...row,state:'needs_input',version:10,question:'还需要明确哪个任务？',decision:{action:'clarify',reason:'继续确认',clarification:'还需要明确哪个任务？'}}));changed()},recreate:()=>{currentId='recreated';histories.recreated=[event('recreated',0,'user_message',{text:'新会话保留待确认'})];changed()},legacy:()=>{currentId='current';requests=[request('legacy','replaced')];histories={current:later};segments=[];mount()},history:(withCall=true)=>{currentId='current';requests=[request('history','previous')];histories={current:later,previous:withCall?turn('previous',0,'history'):[]};segments=[{sessionId:'previous',agentId:'codex'},{sessionId:'current',agentId:'codex'}];mount('history')}};
  `,
  inspect: `(async()=>{
    const f=window.pendingNavigation,tick=()=>new Promise(resolve=>setTimeout(resolve,20)),wait=async check=>{for(let i=0;i<160;i++){if(check())return;await tick()}throw Error('pending navigation timeout: '+f.host.textContent+' / '+f.errors)};
    const card=id=>f.host.querySelector('[data-router-request="'+id+'"]');
    const visible=id=>{const row=card(id),stream=f.host.querySelector('.session-body>.stream-area>.event-stream');if(!row||!stream)return false;const a=(row.querySelector('input')||row).getBoundingClientRect(),b=stream.getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom};
    await wait(()=>card('selected')&&f.host.querySelector('.new-task-send-btn'));for(let i=0;i<10;i++)await tick();
    const checks={selectedConversationEntryPresent:!!f.host.querySelector('[aria-label="查看 RouterAgent 会话"]')&&!card('selected').querySelector('.router-assignment-details'),selectedCardVisible:visible('selected'),selectedInputFocused:document.activeElement===card('selected').querySelector('input'),noDuplicateCurrent:f.host.querySelectorAll('[data-router-request="selected"]').length===1};
    const stream=f.host.querySelector('.session-body>.stream-area>.event-stream');stream.scrollTop=stream.scrollHeight;stream.dispatchEvent(new Event('scroll'));const bottom=stream.scrollTop;f.refresh();for(let i=0;i<10;i++)await tick();checks.refreshDoesNotStealScroll=Math.abs(stream.scrollTop-bottom)<1;
    f.reenterCached();for(let i=0;i<10;i++)await tick();checks.cachedReentryKeepsSelectedRequest=visible('selected')&&document.activeElement===card('selected')?.querySelector('input')&&!f.host.querySelector('.router-disabled');f.resumeSnapshot();
    f.recreate();await wait(()=>f.host.textContent.includes('新会话保留待确认'));for(let i=0;i<10;i++)await tick();checks.sameRequestAfterRecreation=visible('selected');
    f.mount();await wait(()=>card('other'));for(let i=0;i<10;i++)await tick();checks.sidebarOpensPending=visible('other');
    f.legacy();await wait(()=>f.host.querySelector('.new-task-send-btn'));for(let i=0;i<10;i++)await tick();
    checks.replacedSessionPendingReachable=!!card('legacy')&&visible('legacy');checks.originalRequestResumed=false;
    if(card('legacy')){card('legacy').querySelector('input[type=radio]').click();await tick();const input=card('legacy').querySelector('[aria-label="补充路由信息"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'征稿线索需求');input.dispatchEvent(new Event('input',{bubbles:true}));await tick();[...card('legacy').querySelectorAll('button')].find(button=>button.textContent==='继续分配').click();await wait(()=>f.resolutions.length===1);checks.originalRequestResumed=f.resolutions[0].requestId==='legacy'&&f.resolutions[0].expectedVersion===8&&f.resolutions[0].action==='answer'&&f.resolutions[0].answer==='征稿线索需求'}
    await wait(()=>!card('legacy'));f.reask();await wait(()=>card('legacy'));for(let i=0;i<10;i++)await tick();checks.repeatedClarificationFocused=visible('legacy')&&document.activeElement===card('legacy').querySelector('input');
    f.history();await wait(()=>card('history'));for(let i=0;i<10;i++)await tick();
    checks.previousSegmentReachable=visible('history');checks.noDuplicateHistory=f.host.querySelectorAll('[data-router-request="history"]').length===1;
    f.history(false);await wait(()=>card('history'));for(let i=0;i<10;i++)await tick();checks.previousSegmentWithoutCallReachable=visible('history');checks.noDuplicateHistoryFallback=f.host.querySelectorAll('[data-router-request="history"]').length===1;
    return{checks,errors:f.errors};
  })()`
})

assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, JSON.stringify({name,...result}))
console.log('PASS Router pending navigation: selected and default confirmation, replaced sessions, continuous history and original request continuation')
