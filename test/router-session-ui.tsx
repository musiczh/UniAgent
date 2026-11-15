import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-session-ui', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'deepseek',model:'flash',version:1};
    const agent={id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:'flash',label:'Flash',efforts:[]}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]},lifecycle:{availability:'available'}};
    let current={id:'old-router',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'deepseek',model:'flash',managedPurpose:'router',workdir:'/fixture'}},notice,changed=()=>{},onEvent=()=>{},finishCreate,rejectCreate,releaseOld,delayOld=false;
    const requests=[{requestId:'old-request',routerSessionId:'old-router',prompt:'旧输入',scope:{kind:'global'},config,version:4,state:'bound',delivery:'queued',createdAt:2,updatedAt:2,targetId:'old-task',targetTitle:'旧分配卡',decision:{action:'reuse_task',taskId:'old-task',reason:'旧任务'}}];
    const errors=[],creates=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    const message=id=>({sessionId:id,seq:0,ts:1,type:'user_message',payload:{text:id==='old-router'?'旧会话内容':'接续后的原始输入'}});
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config,available:true,sessionId:current.id,sessionNotice:notice,requests}),openRouter:async()=>({...current}),
      getEvents:async id=>{if(delayOld&&id==='old-router')return new Promise(resolve=>{releaseOld=()=>resolve([message(id)])});return [message(id)]},
      onRouterChanged:cb=>{changed=cb;return()=>{}},onEvent:cb=>{onEvent=cb;return()=>{}},getPrefs:async()=>({lastByAgent:{}}),
      newRouterSession:id=>{creates.push(id);return new Promise((resolve,reject)=>{rejectCreate=reject;finishCreate=()=>{current={...current,id:'new-router',createdAt:100};notice={sessionId:current.id,kind:'manual'};changed();resolve({...current})}})}},
      {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.className='session-view';host.style.height='800px';const root=createRoot(host);
    root.render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));
    window.sessionFixture={host,creates,errors,delay:()=>{delayOld=true;config.version++;changed()},releaseOld:()=>releaseOld?.(),oldWaiting:()=>!!releaseOld,
      finish:()=>finishCreate(),fail:()=>rejectCreate(new Error('创建失败，原会话保留')),
      automatic:()=>{current={...current,id:'auto-router',status:'running',createdAt:200};notice={sessionId:current.id,kind:'recovery'};changed()},
      stale:()=>onEvent({sessionId:'old-router',seq:0,ts:99,type:'agent_message',payload:{id:'stale',text:'迟到的旧回复'}})};
  `,
  inspect: `(async()=>{
    const f=window.sessionFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Router session UI timeout: '+f.host.textContent+' / '+f.errors)},button=()=>f.host.querySelector('[aria-label="新建 RouterAgent 会话"]');
    await wait(()=>f.host.textContent.includes('旧会话内容')&&f.host.textContent.includes('旧分配卡'));
    const headerButtons=[...f.host.querySelector('.session-header').querySelectorAll('button')].map(row=>row.textContent);
    f.delay();await wait(()=>f.oldWaiting());button().click();button().click();await tick();
    const pending=button().disabled&&button().getAttribute('aria-busy')==='true',clicks=f.creates.length;
    f.finish();await wait(()=>f.host.textContent.includes('新会话已就绪')&&f.host.textContent.includes('接续后的原始输入'));
    f.releaseOld();f.stale();await tick();await tick();
    const isolated=!f.host.textContent.includes('旧会话内容')&&!f.host.textContent.includes('迟到的旧回复')&&!f.host.textContent.includes('旧分配卡');
    button().click();await tick();f.fail();await wait(()=>f.host.querySelector('[role="alert"]'));
    const failedKeptConversation=f.host.textContent.includes('接续后的原始输入')&&f.host.textContent.includes('原会话保留')&&!button().disabled;
    f.automatic();await wait(()=>f.host.textContent.includes('已自动创建新会话，正在继续处理任务'));
    return {headerButtons,pending,clicks,isolated,failedKeptConversation,automaticDisabled:button().disabled,errors:f.errors};
  })()`
})
assert.deepEqual(result.headerButtons.slice(-3), ['查看会话', '新建会话', '配置'])
assert.equal(result.pending, true)
assert.equal(result.clicks, 1, 'double-clicks are coalesced before IPC')
assert.equal(result.isolated, true, 'equal sequence numbers and late old history/events cannot leak into the new conversation')
assert.equal(result.failedKeptConversation, true)
assert.equal(result.automaticDisabled, true, 'the active replacement task disables manual creation')
assert.deepEqual(result.errors, [])
console.log('PASS Router session UI: header action, creation state, history isolation, retained conversation on failure and automatic continuation')

const switched = await renderEventStream([], 'idle', 'router-agent-switch-ui', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const agents=['deepseek','codex','claude'].map(id=>({id,name:{deepseek:'DeepSeek Harness',codex:'Codex',claude:'Claude Code'}[id],adapter:id,installed:true,models:[{id:'vision',label:'Vision',efforts:[],imageInput:true}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]}}));
    let current='first', changed=()=>{},event=()=>{},status=()=>{},finishHistory,finishThird,delayed=false,delayThird=false;
    const segments=[{sessionId:'first',agentId:'deepseek'}],errors=[],imageReads=[];
    const receipt={requestId:'saved-route',routerSessionId:'first',prompt:'切换前的输入',scope:{kind:'global'},config:{},version:1,state:'bound',delivery:'accepted',createdAt:1,updatedAt:1,targetId:'saved-task',targetTitle:'原分配任务',decision:{action:'reuse_task',taskId:'saved-task',reason:'原目标'}};
    const config={enabled:true,agentId:'deepseek',model:'vision',version:1};
    const histories={first:[{sessionId:'first',seq:0,ts:1,type:'user_message',payload:{text:'切换前的输入',attachments:[{kind:'image',path:'/fixture/before.png',name:'before.png',mimeType:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgo='}]}}],second:[{sessionId:'second',seq:0,ts:2,type:'user_message',payload:{text:'切换后的输入'}}],third:[]};
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config:{...config},available:true,sessionId:current,conversationSessions:[...segments],requests:[receipt]}),
      fsReadAttachmentImage:async(id,path)=>{imageReads.push([id,path]);return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII='},
      openRouter:async()=>({id:current,title:'RouterAgent',createdAt:1,status:'idle',config:{agentId:config.agentId,model:'vision',workdir:'/fixture',managedPurpose:'router'}}),
      getEvents:async id=>delayThird&&id==='third'?new Promise(resolve=>{finishThird=()=>resolve([])}):delayed&&id==='first'?new Promise(resolve=>{finishHistory=()=>resolve(histories[id])}):histories[id]||[],getPrefs:async()=>({lastByAgent:{}}),
      onRouterChanged:cb=>{changed=cb;return()=>{}},onEvent:cb=>{event=cb;return()=>{}},onStatusChange:cb=>{status=cb;return()=>{}}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.height='800px';let root=createRoot(host);
    const render=()=>root.render(React.createElement(RouterPanel,{agents,onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));render();
    window.switchFixture={host,errors,imageReads,switch:()=>{delayed=true;current='second';config.agentId='codex';config.version++;segments.push({sessionId:current,agentId:'codex',switchedAt:123});changed()},
      late:()=>event({sessionId:'first',seq:1,ts:3,type:'agent_message',payload:{text:'旧 Agent 的迟到历史',phase:'final_answer'}}),
      restart:()=>{root.unmount();root=createRoot(host);render()},
      race:()=>{delayed=true;config.version++;changed()},waiting:()=>!!finishHistory,
      next:()=>{delayed=false;delayThird=true;current='third';config.agentId='claude';config.version++;segments.push({sessionId:current,agentId:'claude',switchedAt:456});changed()},release:()=>{delayed=false;finishHistory?.()},
      thirdWaiting:()=>!!finishThird,deliver:()=>{event({sessionId:'third',seq:0,ts:5,type:'user_message',payload:{text:'加载期间的新输入'}});status({sessionId:'third',status:'running'})},finishThird:()=>finishThird?.()};
  `,
  inspect: `(async()=>{
    const f=window.switchFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<200;i++){if(check())return;await tick()}throw Error('Agent switch UI timeout: '+f.host.textContent+' / '+f.errors)};
    await wait(()=>f.host.textContent.includes('切换前的输入'));f.switch();await wait(()=>f.waiting());await tick();await tick();
    const boundaryBeforeOldHistory=f.host.querySelectorAll('.router-agent-switch').length===1;
    const retainedBeforeOldHistory=f.host.textContent.includes('切换前的输入')&&f.host.textContent.includes('原分配任务');
    const currentBeforeOldHistory=f.host.textContent.includes('切换后的输入');f.release();
    await wait(()=>f.host.textContent.includes('切换后的输入')&&f.host.textContent.includes('已切换 Agent'));
    const text=f.host.textContent,retained=text.includes('切换前的输入')&&text.indexOf('切换前的输入')<text.indexOf('已切换 Agent')&&text.indexOf('已切换 Agent')<text.indexOf('切换后的输入');
    const boundary=f.host.querySelector('.router-agent-switch')?.textContent;
    await wait(()=>f.host.querySelector('img[src*="iVBORw0KGgo"]'));
    const imageRetained=!!f.host.querySelector('img[src*="iVBORw0KGgo"]')&&f.imageReads.every(row=>row[0]==='first');
    const receiptRetained=f.host.textContent.includes('原分配任务');
    f.late();await tick();await tick();
    const listKeepsLateReplyHidden=!f.host.querySelector('.router-list-view').textContent.includes('旧 Agent 的迟到历史');
    f.host.querySelector('[aria-label="查看 RouterAgent 会话"]').click();
    await wait(()=>f.host.querySelector('[data-router-detail]')?.textContent.includes('旧 Agent 的迟到历史'));
    const historyScoped=listKeepsLateReplyHidden&&f.host.querySelector('[data-router-detail]').textContent.includes('切换前的输入')&&f.host.querySelector('[data-router-detail]').textContent.includes('切换后的输入');
    f.host.querySelector('[aria-label="返回分配列表"]').click();await wait(()=>!f.host.querySelector('[data-router-detail]'));
    f.restart();await wait(()=>f.host.textContent.includes('切换前的输入')&&f.host.textContent.includes('切换后的输入'));
    const restored=f.host.querySelectorAll('.router-agent-switch').length===1;
    f.race();await wait(()=>f.waiting());f.next();await wait(()=>f.thirdWaiting());f.deliver();f.finishThird();await wait(()=>f.host.querySelectorAll('.router-agent-switch').length===2);f.release();await tick();await tick();
    return {boundaryBeforeOldHistory,retainedBeforeOldHistory,currentBeforeOldHistory,retained,boundary,imageRetained,receiptRetained,historyScoped,restored,buffered:f.host.textContent.includes('加载期间的新输入'),running:f.host.querySelector('[aria-label="新建 RouterAgent 会话"]').disabled,boundaries:f.host.querySelectorAll('.router-agent-switch').length,errors:f.errors};
  })()`
})
assert.equal(switched.retained, true, 'old input, boundary and new input remain in order')
assert.equal(switched.boundaryBeforeOldHistory, true, 'a confirmed Agent switch must not wait for a slower previous Session history')
assert.equal(switched.retainedBeforeOldHistory, true, 'cached input and assignment stay visible while previous history refreshes')
assert.equal(switched.currentBeforeOldHistory, true, 'current Session history loads independently of previous Sessions')
assert.match(switched.boundary, /DeepSeek Harness.*Codex/)
assert.equal(switched.imageRetained, true, 'the image from the preceding Session remains visible')
assert.equal(switched.receiptRetained, true, 'previous task assignment cards remain visible')
assert.equal(switched.historyScoped, true, 'late events stay in their original Session segment')
assert.equal(switched.restored, true, 'remounting restores the persisted boundary')
assert.equal(switched.buffered, true, 'new Session events received while loading history cannot disappear')
assert.equal(switched.running, true, 'running status received during history loading remains effective')
assert.equal(switched.boundaries, 2, 'late history cannot undo a newer switch or duplicate boundaries')
assert.deepEqual(switched.errors, [])
console.log('PASS Router Agent switch UI: continuous history, scoped late events, retained images, persistent boundaries and reload race')

const entry = await renderEventStream([], 'idle', 'router-entry-ui', {
  setup: `
    import {flushSync} from 'react-dom';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'deepseek',model:'flash',version:1};
    const agents=[{id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:'flash',label:'Flash',efforts:[]}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]},lifecycle:{availability:'available'}}];
    const session={id:'entry-router',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'deepseek',model:'flash',managedPurpose:'router',workdir:'/fixture'}};
    const requests=[{requestId:'old-cancelled',prompt:'继续',scope:{kind:'global'},config,version:2,state:'cancelled',delivery:'pending',createdAt:0,updatedAt:1},
      {requestId:'latest-bound',routerSessionId:session.id,prompt:'已有 Router 对话',scope:{kind:'global'},config,version:4,state:'bound',delivery:'finished',createdAt:1,updatedAt:2,targetId:'saved-task',targetTitle:'已分配目标',decision:{action:'reuse_task',reason:'继续原任务'}}];
    const viewState={current:undefined},errors=[],snapshots=[],histories=[];
    let status=()=>{},currentText='已有 Router 对话';
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getRouterSnapshot:()=>new Promise((resolve,reject)=>snapshots.push({resolve,reject})),openRouter:async()=>session,
      getEvents:()=>new Promise((resolve,reject)=>histories.push(error=>error?reject(error):resolve([{sessionId:session.id,seq:0,ts:1,type:'user_message',payload:{text:currentText}}]))),
      onStatusChange:cb=>{status=cb;return()=>{}},getPrefs:async()=>({lastByAgent:{}})},
      {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));let root;
    const frame=()=>({disabled:!!host.querySelector('.router-disabled'),conversation:!!host.querySelector('.session-body'),loading:!!host.querySelector('.session-loading'),cards:host.querySelectorAll('.router-assignment').length,text:host.textContent,composer:!!host.querySelector('.router-task-composer')});
    const mount=(cached=true)=>{root=createRoot(host);flushSync(()=>root.render(React.createElement(RouterPanel,{agents,viewState:cached?viewState:undefined,onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent})));return frame()};
    const first=mount();
    window.entryFixture={host,errors,snapshots,histories,first,frame,mount,unmount:()=>flushSync(()=>root.unmount()),
      ready:()=>snapshots.at(-1).resolve({config:{...config},available:true,sessionId:session.id,requests}),
      disabled:()=>snapshots.at(-1).resolve({config:{...config,enabled:false},available:false,requests:[]}),
      running:()=>status({sessionId:session.id,status:'running'}),update:()=>{currentText='刷新后的 Router 对话'}};
  `,
  inspect: `(async()=>{
    const f=window.entryFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Router entry timeout: '+f.host.textContent+' / '+f.errors)};
    await wait(()=>f.snapshots.length===1);const waitingForConfig=f.frame();f.ready();await wait(()=>f.histories.length===1);
    const waitingForHistory=f.frame();f.histories[0]();await wait(()=>f.host.textContent.includes('已有 Router 对话')&&f.frame().composer);
    f.running();await wait(()=>f.host.querySelector('[aria-label="新建 RouterAgent 会话"]').disabled);
    f.unmount();const reopened=f.mount();
    const cachedRunning=f.host.querySelector('[aria-label="新建 RouterAgent 会话"]').disabled;
    await wait(()=>f.snapshots.length===2);f.update();f.ready();await wait(()=>f.histories.length===2);f.running();f.histories[1]();
    await wait(()=>f.host.textContent.includes('刷新后的 Router 对话'));const refreshed=f.frame();
    const refreshedRunning=f.host.querySelector('[aria-label="新建 RouterAgent 会话"]').disabled;
    f.unmount();f.mount(false);await wait(()=>f.snapshots.length===3);f.disabled();await wait(()=>f.host.querySelector('.router-disabled'));
    const disabled=f.frame();f.unmount();f.mount(false);await wait(()=>f.snapshots.length===4);f.snapshots[3].reject(Error('读取 Router 配置失败'));
    await wait(()=>f.host.querySelector('[role="alert"]'));const failed=f.frame();
    f.unmount();f.mount(false);await wait(()=>f.snapshots.length===5);f.ready();await wait(()=>f.histories.length===3);f.histories[2](Error('原会话历史读取失败'));
    await wait(()=>f.host.textContent.includes('原会话历史读取失败'));const failedHistory=f.frame();
    [...f.host.querySelectorAll('button')].find(row=>row.textContent==='重试').click();await wait(()=>f.histories.length===4);f.histories[3]();
    await wait(()=>f.host.textContent.includes('刷新后的 Router 对话')&&f.host.textContent.includes('已分配目标'));const retried=f.frame();
    return {first:f.first,waitingForConfig,waitingForHistory,reopened,cachedRunning,refreshed,refreshedRunning,disabled,failed,failedHistory,retried,errors:f.errors};
  })()`
})
for (const [name, frame] of Object.entries({ first: entry.first, waitingForConfig: entry.waitingForConfig, waitingForHistory: entry.waitingForHistory })) {
  assert.equal(frame.disabled, false, `${name}: unknown configuration and pending history must not show the setup page`)
  assert.equal(frame.conversation, true, `${name}: enter the existing conversation layout immediately`)
}
assert.equal(entry.waitingForHistory.composer, true, 'enabled Router exposes task input while its history loads')
assert.equal(entry.waitingForHistory.loading, true, 'saved requests do not imply that the conversation history is ready')
assert.equal(entry.waitingForHistory.cards, 0, 'old orphaned cancelled requests must not appear as the initial restored conversation')
assert.equal(entry.reopened.text.includes('已有 Router 对话'), true, 'navigation restores the cached conversation in the first render')
assert.equal(entry.reopened.loading, false, 'navigation does not replay conversation loading')
assert.equal(entry.reopened.composer, true)
assert.equal(entry.cachedRunning, true, 'cached running status keeps session creation disabled')
assert.equal(entry.refreshed.text.includes('刷新后的 Router 对话'), true, 'cached content is refreshed from the backend')
assert.equal(entry.refreshedRunning, true, 'live status during cached history refresh is not overwritten by the earlier session read')
assert.equal(entry.disabled.disabled, true, 'confirmed disabled configuration still shows the existing setup action')
assert.equal(entry.disabled.text.includes('RouterAgent 尚未启用'), true)
assert.equal(entry.failed.disabled, false, 'configuration read failure is not treated as disabled')
assert.equal(entry.failed.text.includes('读取 Router 配置失败'), true)
assert.equal(entry.failedHistory.cards, 0, 'failed history must not fall back to an unrelated cancelled card')
assert.equal(entry.failedHistory.text.includes('对话恢复失败'), true, 'a failed first history read remains explicit and retryable')
assert.equal(entry.failedHistory.composer, true, 'history failure does not block the new-task composer')
assert.equal(entry.retried.cards, 2, 'retry restores the original history and saved receipts')
assert.deepEqual(entry.errors, [])
console.log('PASS Router entry UI: immediate conversation, delayed snapshot/history, cached navigation, background refresh and confirmed disabled/error states')

const hydration = await renderEventStream([], 'idle', 'router-history-hydration-ui', {
  setup: `
    import {flushSync} from 'react-dom';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'deepseek',model:'flash',version:1};
    const agents=[{id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,models:[{id:'flash',label:'Flash',efforts:[]}],capabilities:{auxiliarySystemPrompt:true,protocol:'web',permissionModes:[]}}];
    const session={id:'cached-router',title:'RouterAgent',createdAt:1,status:'idle',config:{agentId:'deepseek',model:'flash',managedPurpose:'router',workdir:'/fixture'}};
    const event=(seq,ts,type,payload,state='success')=>({sessionId:session.id,seq,ts,type,payload,state});
    const partial=[event(0,1000,'user_message',{text:'wire input',displayText:'原始路由输入'}),event(1,1100,'turn_started',{turnId:'1'}),event(2,3000,'reasoning',{id:'thinking',turnId:'1',text:'准备读取路由协议'},'running')];
    const request={requestId:'saved-request',routerSessionId:session.id,prompt:'原始路由输入',scope:{kind:'global'},config,version:4,state:'bound',delivery:'running',createdAt:1000,updatedAt:65000,targetId:'saved-task',targetTitle:'已分配目标',decision:{action:'reuse_task',taskId:'saved-task',reason:'继续原任务'}};
    const full=[...partial.slice(0,2),event(3,4000,'reasoning',{id:'thinking',turnId:'1',text:'已读取路由协议'}),event(4,5000,'tool_call',{id:'query',name:'router_query',turnId:'1',input:{mode:'bootstrap'}}),event(5,64000,'tool_call',{id:'assign',name:'router_assign_task',turnId:'1',input:{requestId:request.requestId}}),event(6,65000,'agent_message',{id:'reply',text:'分配完成，目标任务已收到输入',phase:'final_answer',turnId:'1'}),event(7,66000,'turn_completed',{turnId:'1'})];
    const historical=events=>events.map(row=>({...row,sessionId:'previous-router',payload:row.payload.id==='assign'?{...row.payload,input:{requestId:'previous-request'}}:row.payload}));
    const segments=[{sessionId:'previous-router',agentId:'deepseek'},{sessionId:session.id,agentId:'deepseek',switchedAt:1}];
    const snapshot=()=>({config:{...config},available:true,sessionId:session.id,conversationSessions:segments,requests:[request,{...request,requestId:'previous-request',routerSessionId:'previous-router'}]});
    const viewState={current:{snapshot:snapshot(),session,events:partial,history:{'previous-router':historical(partial)},segments}};
    const errors=[],loads=[];let changed=()=>{},pushEvent=()=>{},root;
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getRouterSnapshot:async()=>snapshot(),openRouter:async()=>session,getEvents:id=>new Promise(resolve=>loads.push({id,resolve})),getTurnArtifactSummary:async()=>null,getPrefs:async()=>({lastByAgent:{}}),onRouterChanged:cb=>{changed=cb;return()=>{}},onEvent:cb=>{pushEvent=cb;return()=>{}}},
      {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));
    const mount=()=>{root=createRoot(host);flushSync(()=>root.render(React.createElement(RouterPanel,{agents,viewState,onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent})))};
    mount();
    window.hydrationFixture={host,viewState,errors,loads,full,mount,unmount:()=>flushSync(()=>root.unmount()),refresh:()=>{config.version++;changed()},
      finish:(start,extra=[])=>loads.slice(start).forEach(load=>load.resolve(load.id===session.id?[...full,...extra]:historical(full))),
      live:row=>pushEvent(row),event};
  `,
  inspect: `(async()=>{
    const f=window.hydrationFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Router hydration timeout: '+f.host.textContent+' / '+f.errors)};
    const state=()=>({users:f.host.querySelectorAll('.user-msg').length,historyUsers:f.host.querySelector('[data-router-history-session]')?.querySelectorAll('.user-msg').length,assignments:f.host.querySelectorAll('[data-router-request="saved-request"]').length,historyAssignments:f.host.querySelectorAll('[data-router-request="previous-request"]').length,timer:f.host.querySelector('.turn-timer-text')?.textContent,seqs:f.viewState.current.events.map(row=>row.seq),historySeqs:f.viewState.current.history['previous-router'].map(row=>row.seq),last:f.viewState.current.events.at(-1)?.type});
    await wait(()=>f.loads.length===2);const cached=state();f.finish(0);
    await wait(()=>f.viewState.current.events.some(row=>row.type==='agent_message'&&row.payload.text==='分配完成，目标任务已收到输入'));await tick();const restored=state();
    if(f.host.textContent.includes('分配完成，目标任务已收到输入'))throw Error('Router list must keep final replies in details only');
    f.unmount();f.mount();await wait(()=>f.loads.length===4);f.finish(2);await tick();await tick();const reopened=state();
    f.refresh();await wait(()=>f.loads.length===6);
    const nextInput=f.event(8,70000,'user_message',{text:'下一项输入'}),started=f.event(9,71000,'turn_started',{turnId:'2'}),stale=f.event(10,72000,'agent_message',{id:'live-reply',turnId:'2',text:'旧回复快照'},'running');
    f.live(nextInput);f.live(started);f.live({...stale,payload:{...stale.payload,text:'加载期间的最新回复'}});
    f.finish(4,[nextInput,started,stale]);await wait(()=>f.viewState.current.events.some(row=>row.payload.id==='live-reply'&&row.payload.text==='加载期间的最新回复'));await tick();
    return {cached,restored,reopened,liveUsers:f.host.querySelectorAll('.user-msg').length,liveReplies:f.viewState.current.events.filter(row=>row.payload.id==='live-reply').map(row=>row.payload.text),liveNarrationHidden:!f.host.textContent.includes('加载期间的最新回复')&&!f.host.querySelector('.process-step,.status-line'),errors:f.errors};
  })()`
})
assert.deepEqual(hydration.errors, [])
for (const state of [hydration.restored, hydration.reopened]) {
  assert.equal(state.users, 2, 'one user bubble per Session remains after loading overlapping cached history')
  assert.equal(state.historyUsers, 1, 'a previous Agent Session also deduplicates its cached history')
  assert.equal(state.assignments, 1, 'the accepted routing result stays visible exactly once')
  assert.equal(state.historyAssignments, 1, 'the previous Session retains its own single assignment result')
  assert.equal(state.timer, '1m 5s', 'elapsed time uses the complete turn rather than the cached two-second prefix')
  assert.deepEqual(state.seqs, [0,1,3,4,5,6,7])
  assert.deepEqual(state.historySeqs, state.seqs)
  assert.equal(state.last, 'turn_completed', 'the successful completion stays at the end of the restored turn')
}
assert.equal(hydration.cached.timer, '2s', 'the initial cached frame represents the reported partial turn')
assert.equal(hydration.liveUsers, 3, 'loading retains a new input without duplicating an overlapping snapshot')
assert.deepEqual(hydration.liveReplies, ['加载期间的最新回复'], 'live updates received while loading take precedence over the older backend snapshot')
assert.equal(hydration.liveNarrationHidden, true, 'loading keeps live process updates in the original events without showing them in the Router list')
console.log('PASS Router history hydration: cached prefixes and full remounts deduplicate current/previous Sessions, retain the full duration and preserve in-flight updates')

const partialFailure = await renderEventStream([], 'idle', 'router-history-partial-failure-ui', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    const config={enabled:true,agentId:'codex',model:'vision',version:1};
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'vision',label:'Vision',efforts:[]}],capabilities:{auxiliarySystemPrompt:true,permissionModes:[]}};
    const session={id:'current',title:'RouterAgent',createdAt:1,status:'idle',config:{agentId:'codex',model:'vision',managedPurpose:'router',workdir:'/fixture'}};
    const event=(id,text)=>({sessionId:id,seq:0,ts:10,type:'user_message',payload:{text}});
    const request=id=>({requestId:id,routerSessionId:id,prompt:id,scope:{kind:'global'},config,version:1,state:'bound',delivery:'finished',createdAt:1,updatedAt:2,targetId:'task-'+id,targetTitle:id+'分配结果',decision:{action:'reuse_task',reason:'原任务'}});
    let finishSlow;
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config,available:true,sessionId:session.id,conversationSessions:['slow','broken','current'].map(sessionId=>({sessionId,agentId:'codex'})),requests:['slow','broken','current'].map(request)}),
      openRouter:async()=>session,getEvents:id=>id==='slow'?new Promise(resolve=>{finishSlow=()=>resolve([event(id,'慢历史原输入')])}):id==='broken'?Promise.reject(Error('旧会话历史损坏')):Promise.resolve([event(id,'当前会话原输入')]),getPrefs:async()=>({lastByAgent:{}})},
      {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));
    createRoot(host).render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));
    window.partialHistoryFixture={host,waiting:()=>!!finishSlow,finish:()=>finishSlow()};
  `,
  inspect: `(async()=>{
    const f=window.partialHistoryFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Partial history timeout: '+f.host.textContent)};
    await wait(()=>f.waiting()&&f.host.textContent.includes('当前会话原输入')&&f.host.textContent.includes('旧会话历史损坏'));
    const before={boundaries:f.host.querySelectorAll('.router-agent-switch').length,currentCards:f.host.querySelectorAll('[data-router-request="current"]').length,slowCards:f.host.querySelectorAll('[data-router-request="slow"]').length,brokenCards:f.host.querySelectorAll('[data-router-request="broken"]').length,composer:!!f.host.querySelector('.router-task-composer')};
    f.finish();await wait(()=>f.host.textContent.includes('慢历史原输入')&&f.host.textContent.includes('slow分配结果'));
    return {before,after:{boundaries:f.host.querySelectorAll('.router-agent-switch').length,currentCards:f.host.querySelectorAll('[data-router-request="current"]').length,error:f.host.textContent.includes('旧会话历史损坏')},errors:window.__fixtureErrors};
  })()`
})
assert.deepEqual(partialFailure.errors, [])
assert.equal(partialFailure.before.boundaries, 2, 'one failed and one slow old history cannot block confirmed boundaries')
assert.equal(partialFailure.before.currentCards, 1, 'the current assignment remains available independently')
assert.equal(partialFailure.before.slowCards, 0, 'an unread previous history does not render a partial fallback transcript')
assert.equal(partialFailure.before.brokenCards, 0, 'failed history is reported rather than presented as successfully restored')
assert.equal(partialFailure.before.composer, true)
assert.equal(partialFailure.after.boundaries, 2, 'late history does not duplicate switch boundaries')
assert.equal(partialFailure.after.currentCards, 1)
assert.equal(partialFailure.after.error, true, 'successful reads do not erase a different Session history failure')
console.log('PASS Router partial history: independent current/previous reads, retained error, confirmed boundaries and available composer')
