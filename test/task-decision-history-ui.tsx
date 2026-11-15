import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Mount both the App's shared transcript and SessionTaskContent's standalone fallback.
// Merely checking the standalone component misses the App's event filtering.
const result = await renderEventStream([], 'idle', 'task-decision-history', {
  screenshot: {width:1360,height:900,path:resolve('out/test/task-conversation-unified.png')},
  setup: `
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';
    const errors=[],subscriptions={},loads=[];
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    localStorage.clear();
    const subscribe=name=>callback=>{const callbacks=subscriptions[name]||=new Set();callbacks.add(callback);return()=>callbacks.delete(callback)};
    const session={id:'history',title:'完整历史任务',status:'completed',createdAt:1,
      config:{agentId:'codex',workdir:'/fixture',permissionMode:'ask'},
      submittedUserMessages:[{type:'user_message',userOrdinal:3,acceptedAt:13,textHash:'latest'}]};
    const row=(seq,type,payload,state='success')=>({sessionId:session.id,seq,ts:seq*1000,type,state,payload});
    const events=[row(1,'agent_message',{id:'imported',text:'PRE_INPUT_REPLY'}),
      row(2,'user_message',{text:'HISTORY_INPUT'}),row(3,'turn_started',{turnId:'first'}),
      row(4,'agent_message',{id:'progress',text:'HISTORY_PROGRESS'}),
      row(5,'command_exec',{id:'old-tool',command:'printf HISTORY_COMMAND',output:'HISTORY_OUTPUT',exitCode:0}),
      row(6,'agent_message',{id:'first-reply',text:'HISTORY_REPLY',phase:'final_answer'}),row(7,'turn_completed',{turnId:'first'}),
      row(8,'goal_message',{text:'SECOND_INPUT'}),row(9,'turn_started',{turnId:'second'}),
      row(10,'agent_message',{id:'second-reply',text:'SECOND_REPLY',phase:'final_answer'}),row(11,'turn_completed',{turnId:'second'}),
      row(12,'user_message',{text:'LATEST_INPUT',attachments:[{kind:'file',name:'history-notes.txt',path:'/fixture/history-notes.txt'}]}),
      row(13,'turn_started',{turnId:'third'}),row(14,'agent_message',{id:'latest',text:'LATEST_REPLY',phase:'final_answer'}),
      row(15,'turn_completed',{turnId:'third'})];
    const agent={id:'codex',name:'Codex',adapter:'codex',bin:'codex',installed:true,models:[],
      lifecycle:{availability:'available'},capabilities:{sideChat:true,permissionModes:[]}};
    const api={listForkJobs:async()=>[],startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),
      getWorktreeArchiveReviews:async()=>[],
      getLifecycleSnapshot:async()=>[agent],getAppSettings:async()=>({spaceRequirementSidebar:false}),
      listSessions:async()=>[structuredClone(session)],getAssistantPrivateSessions:async()=>[],
      listQueues:async()=>({}),e2eEnabled:async()=>false,listProjects:async()=>[],listRequirements:async()=>[],
      listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}}),getTaskDecisions:async()=>[],
      getTaskState:async()=>null,getSessionRuntimeState:async id=>{loads.push(id);return{events,hasLiveStreamer:false,nativeSessionOccupancy:{state:'unsupported'}}},
      onStatusChange:subscribe('status'),onEvent:subscribe('event')};
    window.uniagent=new Proxy(api,{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const fallback=document.body.appendChild(document.createElement('div'));
    fallback.style.cssText='position:fixed;left:-1200px;top:0;display:flex;width:1024px;height:640px';
    const fallbackRoot=createRoot(fallback);
    const renderFallback=rows=>fallbackRoot.render(React.createElement(SessionTaskContent,{session:{...session},status:session.status,events:rows}));
    renderFallback(events);
    window.fixture={fallback,errors,loads,setStatus:status=>{session.status=status;renderFallback(events);
      for(const callback of subscriptions.status||[])callback({sessionId:session.id,status})},
      noInput:()=>renderFallback([events[0]]),empty:()=>renderFallback([])};
    window.appReady=import('./src/renderer/App').then(({App})=>{
      const host=document.body.appendChild(document.createElement('div'));host.id='history-app';
      host.style.cssText='position:fixed;inset:0';
      createRoot(host).render(React.createElement(App));
    });
  `,
  inspect: `(async()=>{
    const f=window.fixture,tick=()=>new Promise(r=>setTimeout(r,30));
    const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label)};
    await window.appReady;
    const host=document.getElementById('history-app');
    await wait(()=>host.querySelector('[data-session-id="history"]'),'App sessions');
    host.querySelector('[data-session-id="history"]').click();
    await wait(()=>host.querySelector('.session-view .event-stream')?.textContent.includes('LATEST_REPLY'),'loaded conversation');
    const stream=()=>host.querySelector('.session-view .event-stream');
    const original=stream(),composer=host.querySelector('.composer-wrap');
    const inputs=root=>[...root.querySelectorAll('.user-msg')].map(el=>el.textContent);
    const noTaskTabs=!host.querySelector('.session-view .task-view-switch,.session-view [role=tablist],.task-timeline');
    const phases=[];
    for(const status of ['completed','running','queued','error']){
      f.setStatus(status);await tick();await tick();
      phases.push({status,app:stream().textContent,appInputs:inputs(stream()),
        fallback:f.fallback.querySelector('.event-stream').textContent,fallbackInputs:inputs(f.fallback),
        sameStream:stream()===original,sameComposer:host.querySelector('.composer-wrap')===composer});
    }
    f.setStatus('completed');await tick();
    const expand=async root=>{
      for(const selector of ['.processed-fold.closed > .processed-head','.steps-fold-row[aria-expanded=false]',
        '.process-step-meta[aria-expanded=false]','.process-call-group .chain-head','.chain.closed > .chain-head']){
        root.querySelectorAll(selector).forEach(button=>button.click());await tick();await tick();
      }
      return root.textContent;
    };
    const appExpanded=await expand(stream()),fallbackExpanded=await expand(f.fallback);
    f.noInput();await tick();await tick();const noInput=f.fallback.querySelector('.event-stream').textContent;
    f.empty();await tick();await tick();const emptyInputs=inputs(f.fallback);
    if(host.querySelector('[role=alertdialog]'))throw Error('unexpected error overlay');
    return{phases,appExpanded,fallbackExpanded,noTaskTabs,noInput,emptyInputs,errors:f.errors,loads:f.loads};
  })()`
})

assert.deepEqual(result.errors, [])
assert.ok(result.loads.length > 0 && result.loads.every(id => id === 'history'))
for (const phase of result.phases) {
  for (const kind of ['app', 'fallback']) {
    assert.match(phase[kind], /PRE_INPUT_REPLY/, `${kind}: imported reply survives in ${phase.status}`)
    for (const text of ['HISTORY_INPUT', 'HISTORY_REPLY', 'SECOND_INPUT', 'SECOND_REPLY', 'LATEST_INPUT', 'LATEST_REPLY', 'history-notes.txt']) {
      assert.ok(phase[kind].includes(text), `${kind}: ${text} survives in ${phase.status}`)
    }
    assert.equal(phase[kind + 'Inputs'].length, 3, `${kind}: all inputs remain in ${phase.status}`)
  }
  assert.equal(phase.sameStream, true)
  assert.equal(phase.sameComposer, true)
}
for (const text of [result.appExpanded, result.fallbackExpanded]) {
  assert.match(text, /HISTORY_PROGRESS/)
  assert.match(text, /HISTORY_COMMAND/)
  assert.match(text, /HISTORY_OUTPUT/)
}
assert.equal(result.noTaskTabs, true)
assert.match(result.noInput, /PRE_INPUT_REPLY/)
assert.deepEqual(result.emptyInputs, [])
console.log('PASS full decision history in actual App and standalone SessionTaskContent, all execution states, expandable tools, attachments and shared conversation/composer')
