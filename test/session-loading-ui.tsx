import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'session-loading-ui', {
  setup: `
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(readFileSync('src/renderer/startup.html', 'utf8'))});
    document.getElementById('ua-startup').hidden = true;
    localStorage.clear();
    const sessions = ['source','other','empty','failure'].map(id=>({id,title:id,status:'idle',createdAt:1,
      config:{agentId:'codex',workdir:'/fixture',permissionMode:'ask'}}));
    const agent={id:'codex',name:'Codex',adapter:'codex',bin:'codex',installed:true,models:[],
      lifecycle:{availability:'available'},capabilities:{sideChat:true,permissionModes:[]}};
    const pending={},callbacks=[],errors=[];
    const defer=id=>{pending[id]={};pending[id].promise=new Promise((resolve,reject)=>Object.assign(pending[id],{resolve,reject}));pending[id].promise.catch(()=>{});};
    sessions.forEach(session=>defer(session.id));
    const metadata={hasLiveStreamer:false,nativeSessionOccupancy:{state:'unsupported'}};
    const warning={sessionId:'source',seq:0,ts:1,type:'system_notice',payload:{kind:'warning',text:'需求后台整理未完成，已保留同步缺口'}};
    const history=id=>[{sessionId:id,seq:1,ts:2,type:'user_message',payload:{text:id+' 提问'}},
      {sessionId:id,seq:2,ts:3,type:'agent_message',state:'success',payload:{id:id+'-reply',text:id+' 完整历史',phase:'final_answer'}}];
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({
      startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),
      getLifecycleSnapshot:async()=>[agent],getAppSettings:async()=>({spaceRequirementSidebar:false}),listSessions:async()=>sessions,
      getAssistantPrivateSessions:async()=>[],getWorktreeArchiveReviews:async()=>[],listQueues:async()=>({}),e2eEnabled:async()=>false,
      listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}}),
      getSessionRuntimeState:(id,includeEvents=true)=>includeEvents?pending[id].promise:Promise.resolve({...metadata,events:[]}),
      onEvent:callback=>{callbacks.push(callback);return()=>{}}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
    window.fixture={errors,warning,defer,emit:()=>callbacks.forEach(callback=>callback(warning)),
      finish:(id,empty=false)=>pending[id].resolve({...metadata,events:empty?[]:[...(id==='source'?[warning]:[]),...history(id)]}),
      fail:id=>pending[id].reject(Error('fixture restore failed'))};
    window.appReady=import('./src/renderer/App').then(({App})=>{
      const host=document.body.appendChild(document.createElement('div'));host.id='app-fixture';
      createRoot(host).render(React.createElement(App));
    });
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
    const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw Error(label)};
    await window.appReady;
    const host=document.getElementById('app-fixture'),f=window.fixture;
    const body=()=>host.querySelector('.session-view .session-body');
    const select=id=>host.querySelector('[data-session-id="'+id+'"]').click();
    await wait(()=>host.querySelector('[data-session-id="source"]'),'session list');
    select('source');await wait(()=>body()?.querySelector('.loading-spinner'),'source loading');
    f.emit();await tick();
    const loadingAfterWarning=!!body().querySelector('.loading-spinner');
    const noticesDuringLoading=body().querySelectorAll('.process-notice').length;
    if(!loadingAfterWarning)return{loadingAfterWarning,noticesDuringLoading};
    const spinner=body().querySelector('.loading-spinner');
    const before=spinner&&getComputedStyle(spinner).transform;await tick();
    const animated=!!spinner&&before!==getComputedStyle(spinner).transform;
    const composerAvailable=!!host.querySelector('.composer-input');
    select('other');await wait(()=>body()?.querySelector('.loading-spinner'),'other loading');
    f.finish('source');await tick();
    const lateReplyOverwroteOther=body().textContent.includes('source 完整历史');
    f.finish('other');await wait(()=>body()?.textContent.includes('other 完整历史'),'other ready');
    select('source');await wait(()=>body()?.textContent.includes('source 完整历史'),'source ready');
    const loaded={spinner:!!body().querySelector('.loading-spinner'),warnings:body().querySelectorAll('.process-notice.warning').length,
      replies:body().querySelectorAll('.agent-msg .agent-md').length};
    select('empty');await wait(()=>body()?.querySelector('.loading-spinner'),'empty loading');
    f.finish('empty',true);await wait(()=>!body()?.querySelector('.loading-spinner'),'successful empty restore');
    const emptyFailed=!!body().querySelector('[role=alert]');
    select('failure');await wait(()=>body()?.querySelector('.loading-spinner'),'failure loading');
    f.fail('failure');await wait(()=>body()?.querySelector('[role=alert]'),'restore error');
    const error={text:body().textContent,spinner:!!body().querySelector('.loading-spinner')};
    f.defer('failure');[...body().querySelectorAll('button')].find(button=>button.textContent==='重试').click();
    await wait(()=>body()?.querySelector('.loading-spinner'),'retry loading');
    f.finish('failure');await wait(()=>body()?.textContent.includes('failure 完整历史'),'retry ready');
    return{loadingAfterWarning,noticesDuringLoading,animated,composerAvailable,lateReplyOverwroteOther,loaded,emptyFailed,error,
      retryFailed:!!body().querySelector('[role=alert]'),errors:f.errors};
  })()`
})

assert.equal(result.loadingAfterWarning, true, 'an early warning cannot finish conversation loading')
assert.equal(result.noticesDuringLoading, 0, 'the waiting body shows loading, not partial warning rows')
assert.equal(result.animated, true)
assert.equal(result.composerAvailable, true, 'only the conversation body waits')
assert.equal(result.lateReplyOverwroteOther, false, 'a late response cannot replace a different active session')
assert.deepEqual(result.loaded, { spinner: false, warnings: 1, replies: 1 })
assert.equal(result.emptyFailed, false, 'successful empty history is not a loading failure')
assert.equal(result.error.spinner, false)
assert.match(result.error.text, /fixture restore failed/)
assert.equal(result.retryFailed, false)
assert.deepEqual(result.errors, [], 'restore failures must be handled without unhandled rejections')
console.log('session loading UI: animated waiting, warning preservation, switching, empty success and failure retry passed')
