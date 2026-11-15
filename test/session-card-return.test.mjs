import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'session-card-return', {
  setup: `
    localStorage.clear();
    const sessions=['source','target','other'].map(id=>({id,title:id,status:id==='source'?'running':'idle',createdAt:1,config:{agentId:'codex',workdir:'/fixture'}}));
    const agent={id:'codex',name:'Codex',adapter:'codex',bin:'codex',installed:true,models:[],lifecycle:{availability:'available'},capabilities:{permissionModes:[]}};
    const taskId='00000000-0000-4000-8000-000000000001';
    const history=id=>id==='source'?[
      {sessionId:id,seq:1,ts:1,type:'user_message',state:'success',payload:{text:'发起交接'}},
      {sessionId:id,seq:2,ts:2,type:'system_notice',state:'success',payload:{kind:'handoff_end',taskId,targetSessionId:'target',agentName:'Codex',status:'completed',latestReply:'交接完成'}}
    ]:[{sessionId:id,seq:1,ts:1,type:'agent_message',state:'success',payload:{text:id+' 回复',phase:'final_answer'}}];
    const errors=[];window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    const api={listForkJobs:async()=>[],startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),getLifecycleSnapshot:async()=>[agent],getAppSettings:async()=>({spaceRequirementSidebar:false}),listSessions:async()=>sessions,getAssistantPrivateSessions:async()=>[],getWorktreeArchiveReviews:async()=>[],listQueues:async()=>({}),e2eEnabled:async()=>false,listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}}),getSessionRuntimeState:async id=>({events:history(id),hasLiveStreamer:id==='source',nativeSessionOccupancy:{state:'unknown'}})};
    window.uniagent=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
    window.fixture={errors};window.appReady=import('./src/renderer/App').then(({App})=>{const host=document.body.appendChild(document.createElement('div'));host.id='app-fixture';createRoot(host).render(React.createElement(App))});
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,40)),wait=async(predicate,label)=>{for(let i=0;i<120;i++){if(predicate())return;await tick()}throw Error(label)};
    await window.appReady;const host=document.getElementById('app-fixture'),q=selector=>host.querySelector(selector);
    const active=()=>q('.session-item.active')?.dataset.sessionId;
    const select=async id=>{q('[data-session-id="'+id+'"]').click();await wait(()=>active()===id&&q('.session-view .composer-input'),'select '+id)};
    const jump=async()=>{await wait(()=>q('.hx[role=button]'),'handoff card');q('.hx[role=button]').click();await wait(()=>active()==='target'&&q('.session-task-content[data-task-id=target]'),'jump target')};
    await wait(()=>q('[data-session-id=source]'),'sessions ready');await select('source');
    const composer=q('.composer-input');q('.session-info-trigger').click();await wait(()=>document.querySelector('.session-info-popover'),'title info');document.querySelector('[aria-label="关闭会话信息"]').click();await tick();const sameComposer=q('.composer-input')===composer;
    if(q('.task-view-switch,[aria-label=返回对话]'))throw Error('ordinary task has no secondary view');
    await jump();const cardReturn=q('.session-header [aria-label="返回点击前的 Session"]');if(!cardReturn)throw Error('task retains handoff source');cardReturn.click();await wait(()=>active()==='source'&&q('.session-header'),'handoff source restored');const returned=active();
    await jump();await select('other');if(q('[aria-label="返回点击前的 Session"]'))throw Error('normal selection must clear handoff source');
    return{sameComposer,returned,active:active(),errors:window.fixture.errors};
  })()`
})

assert.deepEqual(result, { sameComposer: true, returned: 'source', active: 'other', errors: [] })
console.log('PASS Task return: retained conversation/composer, handoff source Session and cleared history after normal selection')
