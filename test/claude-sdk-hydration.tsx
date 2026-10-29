import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'sdk-hydration', {
  setup: `
    document.body.insertAdjacentHTML('beforeend','<div id="ua-startup" hidden><div class="cluster"><div class="core"></div><svg class="orbit"><path class="spokes"></path></svg><div class="halo"></div>'+['codex','claude','kimi','deepseek','grok','minimax','zcode'].map(id=>'<div data-agent="'+id+'"></div>').join('')+'</div><div class="glow"></div><div class="constellation"></div><h1 id="ua-startup-title"></h1><div id="ua-startup-stage"></div><button id="ua-startup-restart"></button></div>');
    const listeners={},loads=[];
    const subscribe=name=>fn=>{listeners[name]=fn;return()=>{if(listeners[name]===fn)delete listeners[name]}};
    const sessions=['initial','target'].map((id,index)=>({id,title:id,createdAt:2-index,status:'idle',config:{agentId:'claude',workdir:'/fixture',permissionMode:'ask'}}));
    const history=[
      {sessionId:'target',seq:1,ts:1,type:'user_message',payload:{text:'SDK_HISTORY_USER_987'}},
      {sessionId:'target',seq:2,ts:2,type:'agent_message',payload:{id:'reply',text:'SDK_HISTORY_REPLY_987',phase:'final_answer'}},
      {sessionId:'target',seq:3,ts:3,type:'system_notice',payload:{kind:'context_usage',contextUsage:{totalTokens:123,rawMaxTokens:200000}}}
    ];
    const agent={id:'claude',name:'Claude',adapter:'claude',bin:'claude',installed:true,models:[],lifecycle:{availability:'available'},capabilities:{permissionModes:[{id:'ask',label:'请求批准',hint:''}]}};
    const api={startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),getLifecycleSnapshot:async()=>[agent],getAppSettings:async()=>({}),listSessions:async()=>sessions,
      getAssistantPrivateSessions:async()=>[],listQueues:async()=>({}),e2eEnabled:async()=>false,listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}}),
      getSessionRuntimeState:async(id,includeEvents=true)=>{if(includeEvents)loads.push(id);return{events:includeEvents&&id==='target'?history:[],hasLiveStreamer:false,nativeSessionOccupancy:{state:'unsupported'}}},
      onEvent:subscribe('event'),onStatusChange:subscribe('status')};
    window.uniagent=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
    localStorage.clear();window.fixture={listeners,loads};
    window.appReady=import('./src/renderer/App').then(({App})=>{const host=document.body.appendChild(document.createElement('div'));createRoot(host).render(React.createElement(App))});
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
    const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw new Error(label)};
    await window.appReady;
    await wait(()=>document.querySelector('[data-session-id="target"]')&&window.fixture.listeners.event,'App setup');
    document.querySelector('[data-session-id="initial"]').click();await tick();
    if(window.fixture.loads.includes('target'))throw new Error('target was hydrated before the regression trigger');
    window.fixture.listeners.event({sessionId:'target',seq:10,ts:10,type:'system_notice',payload:{kind:'context',usage:{inputTokens:123}}});
    await tick();await tick();
    document.querySelector('[data-session-id="target"]').click();
    await wait(()=>window.fixture.loads.includes('target'),'live SDK metadata incorrectly suppressed history hydration');
    await wait(()=>document.querySelector('.session-view')?.innerText.includes('SDK_HISTORY_REPLY_987'),'native history did not reach the existing conversation UI');
    return{loads:window.fixture.loads,text:document.querySelector('.session-view').innerText};
  })()`
})
assert.equal(result.loads.filter((id:string)=>id==='target').length,1)
assert.match(result.text,/SDK_HISTORY_USER_987/)
assert.match(result.text,/SDK_HISTORY_REPLY_987/)
assert.match(result.text,/Claude 上下文/)
console.log('Claude SDK hydration: live metadata cannot replace persisted history; existing conversation and native report cards hydrate once')
