import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'detail-session-switch', {
  setup: `
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(readFileSync('src/renderer/startup.html', 'utf8'))});
    document.getElementById('ua-startup').hidden = true;
    localStorage.clear();
    const sessions = ['source','other'].map(id => ({id,title:id,status:'idle',createdAt:1,
      config:{agentId:'codex',workdir:'/fixture',permissionMode:'ask'}}));
    const history = id => [{sessionId:id,seq:1,ts:1,type:'agent_message',state:'success',
      payload:{id:id+'-reply',text:id==='source'?'解释窗口的原会话内容':'另一个会话内容',phase:'final_answer'}}];
    const agent = {id:'codex',name:'Codex',adapter:'codex',bin:'codex',installed:true,models:[],
      lifecycle:{availability:'available'},capabilities:{sideChat:true,permissionModes:[]}};
    const calls = [], closed = [], sideLoads = [];
    let promoted, finishOpening;
    const opening = new Promise(resolve => { finishOpening = resolve });
    const api = {
      startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),
      getLifecycleSnapshot:async()=>[agent],getWorktreeArchiveReviews:async()=>[],listForkJobs:async()=>[],getAppSettings:async()=>({spaceRequirementSidebar:false}),listSessions:async()=>sessions,
      getAssistantPrivateSessions:async()=>[],listQueues:async()=>({}),e2eEnabled:async()=>false,
      listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}}),
      getSessionRuntimeState:async id=>({events:history(id),hasLiveStreamer:false,nativeSessionOccupancy:{state:'unsupported'}}),
      explainDetailSelection:async(id,context)=>{calls.push({id,context});await opening},
      closeDetail:async id=>{closed.push(id)},onDetailPromoted:callback=>{promoted=callback;return()=>{}},
      getSideEvents:async id=>{sideLoads.push(id);return[]},getSideState:async()=>null
    };
    window.uniagent = new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
    window.fixture = {calls,closed,sideLoads,finishOpening,promote:value=>promoted(value)};
    window.appReady = import('./src/renderer/App').then(({App})=>{
      const host=document.body.appendChild(document.createElement('div'));host.id='app-fixture';
      createRoot(host).render(React.createElement(App));
    });
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
    const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw new Error(label)};
    await window.appReady;
    const host=document.getElementById('app-fixture');
    const active=()=>host.querySelector('.session-item.active')?.dataset.sessionId;
    const select=async id=>{
      host.querySelector('[data-session-id="'+id+'"]').click();
      await wait(()=>active()===id&&host.querySelector('.session-view .agent-md')?.textContent.includes(id==='source'?'原会话':'另一个'),'session '+id);
    };
    await wait(()=>host.querySelector('[data-session-id="source"]'),'App setup');
    await select('source');
    const text=host.querySelector('.session-view .agent-md');
    const range=document.createRange();range.selectNodeContents(text);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    text.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    await wait(()=>document.querySelector('.sel-pop'),'selection menu');
    Array.from(document.querySelectorAll('.sel-pop button')).find(button=>button.textContent.includes('解释')).click();
    await wait(()=>window.fixture.calls.length===1,'explanation open');
    await select('other');await tick();
    const closedWhileOpening=[...window.fixture.closed];
    window.fixture.finishOpening();await tick();
    await select('source');await select('other');await tick();
    const closedAfterSwitching=[...window.fixture.closed];
    window.fixture.promote({sessionId:'source',kind:'side'});
    await wait(()=>window.fixture.sideLoads.length>0,'promoted side chat');await tick();
    return{calls:window.fixture.calls,closedWhileOpening,closedAfterSwitching,sideLoads:window.fixture.sideLoads,active:active()};
  })()`
})

assert.deepEqual(result.closedWhileOpening, [], 'switching sessions must not cancel an explanation still opening')
assert.deepEqual(result.closedAfterSwitching, [], 'switching away and back must never close or reopen the explanation')
assert.equal(result.calls.length, 1)
assert.equal(result.calls[0].id, 'source')
assert.equal(result.calls[0].context.sourceConversationId, 'source')
assert.equal(result.calls[0].context.selectedText, '解释窗口的原会话内容')
assert.equal(result.active, 'source', 'promoting a retained explanation returns to its source session')
assert.deepEqual(result.sideLoads, ['source'], 'the retained explanation must never be shown in another session side chat')
console.log('detail session switch: retained while loading and after navigation; source binding and side promotion passed')
