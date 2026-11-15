import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const width of [1360, 1024]) {
  const result = await renderEventStream([], 'idle', 'generation-app', {
    screenshot: { width, height: 900, path: resolve('out/test/task-generation-conversation-' + width + '.png') },
    setup: `
      import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
      installMarkdownInputDriver();
      localStorage.clear();
      const errors=[],subscriptions={},reads=[],mutations=[];
      window.addEventListener('error',e=>errors.push(e.message));
      window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const subscribe=name=>cb=>{const listeners=subscriptions[name]||=new Set();listeners.add(cb);return()=>listeners.delete(cb)};
      const task={id:'task-a',title:'原任务标题',status:'completed',createdAt:1,
        config:{agentId:'codex',workdir:'/fixture',permissionMode:'ask'},
        taskMetadata:{title:'修复图片历史',description:'完整任务描述',conversationId:'context-a',generatedAt:1}};
      const b={...task,id:'task-b',title:'另一个任务',taskMetadata:{title:'另一个任务'}};
      const row=(seq,type,payload,state='success')=>({sessionId:task.id,seq,ts:seq*1000,type,state,payload});
      const events=[row(0,'user_message',{text:'MAIN_INPUT'}),row(1,'turn_started',{turnId:'main'}),
        row(2,'agent_message',{id:'main',text:'MAIN_REPLY\\n\\n'+Array.from({length:45},(_,i)=>'主任务材料 '+i).join('\\n\\n'),phase:'final_answer'}),row(3,'turn_completed',{turnId:'main'})];
      let generated=[row(0,'user_message',{text:'GENERATION_INPUT',generationKind:'title-description'}),row(1,'turn_started',{turnId:'g1'}),
        row(2,'system_notice',{text:'标题与描述 · Codex · model-a'}),
        row(3,'agent_message',{id:'g1',text:'GENERATION_RESULT',phase:'final_answer'}),row(4,'turn_completed',{turnId:'g1'})];
      const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],lifecycle:{availability:'available'},capabilities:{permissionModes:[]}};
      const api={listForkJobs:async()=>[],startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),
        getWorktreeArchiveReviews:async()=>[],getLifecycleSnapshot:async()=>[agent],getAppSettings:async()=>({spaceRequirementSidebar:false}),
        listSessions:async()=>[structuredClone(task),structuredClone(b)],getAssistantPrivateSessions:async()=>[],
        listQueues:async()=>({}),e2eEnabled:async()=>false,listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],
        getPrefs:async()=>({lastByAgent:{}}),getTaskDecisions:async()=>[],getTaskState:async()=>null,
        pickFiles:async()=>[{kind:'file',name:'draft-notes.txt',path:'/fixture/draft-notes.txt'}],
        getSessionInfo:async()=>{throw Error('native metadata unavailable')},
        getSessionRuntimeState:async id=>({events:events.map(e=>({...e,sessionId:id})),hasLiveStreamer:false,nativeSessionOccupancy:{state:'unsupported'}}),
        getTaskGenerationConversation:async id=>{reads.push(id);return{taskId:id,events:id===task.id?generated:[],running:false,legacyHistory:id===task.id}},
        onTaskGenerationChanged:subscribe('generation'),onEvent:subscribe('event')};
      window.uniagent=new Proxy(api,{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>{if(/send|create|generate|interrupt|archive|respond/i.test(String(k)))mutations.push(k);return null}});
      window.fixture={task,b,errors,reads,mutations,emit:id=>{for(const cb of subscriptions.generation||[])cb({taskId:id})},
        update:()=>{generated=[...generated,row(5,'user_message',{text:'QUICK_REPLY_INPUT',generationKind:'quick-replies'}),row(6,'turn_started',{turnId:'g2'}),
          row(7,'system_notice',{text:'快捷回复 · Codex'}),row(8,'agent_message',{id:'g2',text:'QUICK_REPLY_RESULT',phase:'final_answer'}),row(9,'turn_completed',{turnId:'g2'})]}};
      window.appReady=import('./src/renderer/App').then(({App})=>{
        const host=document.body.appendChild(document.createElement('div'));host.id='generation-app';host.style.cssText='position:fixed;inset:0';
        createRoot(host).render(React.createElement(App));
      });
    `,
    inspect: `(async()=>{
      const f=window.fixture,tick=()=>new Promise(r=>setTimeout(r,30));
      const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+JSON.stringify(f.errors))};
      await window.appReady;
      const host=document.getElementById('generation-app');
      await wait(()=>host.querySelector('[data-session-id="task-a"]'),'sidebar ready');
      host.querySelector('[data-session-id="task-a"]').click();
      await wait(()=>host.querySelector('.session-view .event-stream')?.textContent.includes('MAIN_REPLY'),'main ready');
      const title=host.querySelector('.session-info-trigger'),original=title.closest('.session-view'),stream=original.querySelector('.event-stream'),composer=original.querySelector('.composer-wrap');
      await wait(()=>composer.querySelector('.markdown-editor-content[contenteditable=true]'),'editor ready');
      window.__markdownInput.fill(composer,'查看后保留这份草稿');await tick();
      composer.querySelector('.sb-add summary').click();[...composer.querySelectorAll('.sb-menu-item')].find(b=>b.textContent.includes('添加附件')).click();
      await wait(()=>composer.querySelector('.attach-file')?.textContent.includes('draft-notes.txt'),'attachment draft');
      stream.scrollTop=120;stream.dispatchEvent(new Event('scroll'));await tick();
      const beforeScroll=stream.scrollTop,beforeReads=f.reads.length;
      const mutationsBefore=f.mutations.length;
      title.click();await wait(()=>document.querySelector('.session-info-errors'),'metadata read failure');
      const pop=document.querySelector('.session-info-popover');
      const buttons=[...pop.querySelectorAll('.session-info-footer button')];
      const entry=buttons.find(button=>button.textContent.includes('查看生成会话'));
      const entryRect=entry.getBoundingClientRect(),copyRect=buttons.at(-1).getBoundingClientRect(),popRect=pop.getBoundingClientRect();
      const entryLayout={left:entryRect.left,right:copyRect.right,popLeft:popRect.left,popRight:popRect.right,ordered:entryRect.right<=copyRect.left};
      entry.click();await wait(()=>host.querySelector('.task-generation-conversation .event-stream')?.textContent.includes('GENERATION_RESULT'),'generation ready');
      const pane=host.querySelector('.task-generation-conversation');
      const opened={title:pane.querySelector('.session-header').textContent,text:pane.textContent,sameStream:original.querySelector('.event-stream')===stream,
        sameComposer:original.querySelector('.composer-wrap')===composer,originalHidden:!original.checkVisibility(),
        noComposer:!pane.querySelector('.composer-wrap'),noActions:!pane.querySelector('.task-decision-actions,.task-execution-controls'),
        copyPopupClosed:!document.querySelector('.session-info-popover'),overflow:pane.scrollWidth>pane.clientWidth};
      const readCount=f.reads.length;f.emit('different-task');await new Promise(r=>setTimeout(r,100));
      const ignoredOtherTask=f.reads.length===readCount;
      f.update();f.emit('task-a');await wait(()=>pane.textContent.includes('QUICK_REPLY_RESULT'),'live update');
      const typeLabels=[...pane.querySelectorAll('[aria-label="生成调用类型"]')].map(label=>({text:label.textContent,visible:label.checkVisibility()}));
      const sameGenerationStream=host.querySelector('.task-generation-conversation .event-stream')===pane.querySelector('.event-stream');
      pane.querySelector('[aria-label="返回任务"]').click();await wait(()=>!host.querySelector('.task-generation-conversation')&&original.checkVisibility(),'returned');
      await tick();
      const restored={sameStream:original.querySelector('.event-stream')===stream,sameComposer:original.querySelector('.composer-wrap')===composer,
        draft:window.__markdownInput.text(composer),attachment:composer.querySelector('.attach-file')?.textContent,scroll:stream.scrollTop,focused:document.activeElement===title};
      const open=async()=>{title.click();await wait(()=>document.querySelector('.session-info-popover'),'reopen title');[...document.querySelectorAll('.session-info-footer button')].find(b=>b.textContent.includes('查看生成会话')).click();await wait(()=>host.querySelector('.task-generation-conversation'),'reopen generation')};
      await open();host.querySelector('[data-session-id="task-b"]').click();await wait(()=>!host.querySelector('.task-generation-conversation')&&host.querySelector('.session-info-trigger')?.textContent.includes('另一个任务'),'sidebar navigation');
      host.querySelector('[data-session-id="task-a"]').click();await wait(()=>host.querySelector('.session-info-trigger')?.textContent.includes('修复图片历史'),'return task A');
      host.querySelector('.session-info-trigger').click();await wait(()=>document.querySelector('.session-info-popover'),'final title open');
      [...document.querySelectorAll('.session-info-footer button')].find(b=>b.textContent.includes('查看生成会话')).click();
      await wait(()=>host.querySelector('.task-generation-conversation')?.textContent.includes('QUICK_REPLY_RESULT'),'capture implemented generation view');
      await new Promise(r=>setTimeout(r,320));
      return{opened,entryLayout,restored,beforeScroll,beforeReads,ignoredOtherTask,sameGenerationStream,typeLabels,mutationDelta:f.mutations.slice(mutationsBefore),errors:f.errors};
    })()`
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.beforeReads, 0, 'startup and task open do not load generation history')
  assert.match(result.opened.title, /生成会话 · 修复图片历史/)
  assert.match(result.opened.text, /旧版本未保存/)
  assert.match(result.opened.text, /GENERATION_INPUT/)
  assert.match(result.opened.text, /GENERATION_RESULT/)
  assert.doesNotMatch(result.opened.text, /MAIN_REPLY|MAIN_INPUT/)
  for (const key of ['sameStream', 'sameComposer', 'originalHidden', 'noComposer', 'noActions', 'copyPopupClosed']) assert.equal(result.opened[key], true, key)
  assert.equal(result.opened.overflow, false)
  assert.ok(result.entryLayout.left >= result.entryLayout.popLeft && result.entryLayout.right <= result.entryLayout.popRight && result.entryLayout.ordered)
  assert.equal(result.ignoredOtherTask, true)
  assert.equal(result.sameGenerationStream, true)
  assert.deepEqual(result.typeLabels, [{text:'标题与描述',visible:true},{text:'快捷回复',visible:true}], 'generation types stay visible when work processes are collapsed')
  assert.deepEqual(result.mutationDelta, [], 'viewing and returning cannot send, regenerate, interrupt or archive')
  assert.equal(result.restored.draft, '查看后保留这份草稿')
  assert.match(result.restored.attachment, /draft-notes.txt/)
  assert.equal(result.restored.sameStream, true)
  assert.equal(result.restored.sameComposer, true)
  assert.equal(result.restored.focused, true)
  assert.ok(result.beforeScroll > 0 && Math.abs(result.beforeScroll - result.restored.scroll) < 1, 'preserve transcript scroll on return')
  console.log('PASS generation entry in actual App, reused readonly stream, scoped live update, original draft/scroll/focus and sidebar return at ' + width)
}

const races = await renderEventStream([], 'idle', 'generation-races', {
  setup: `
    import {TaskGenerationConversation} from './src/renderer/components/TaskGenerationConversation';
    import {SessionHeader} from './src/renderer/components/SessionHeader';
    const requests=[],listeners=new Set(),errors=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    const a={id:'a',title:'任务 A',status:'idle',createdAt:1,config:{agentId:'codex',workdir:'/fixture'}};
    const b={...a,id:'b',title:'任务 B'};
    window.uniagent=new Proxy({getTaskGenerationConversation:id=>new Promise((resolve,reject)=>requests.push({id,resolve,reject})),
      onTaskGenerationChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)}},
      {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';const root=createRoot(host);
    const mount=(task=a)=>root.render(React.createElement(TaskGenerationConversation,{session:task,onBack:()=>{}}));
    window.fixture={requests,listeners,errors,host,a,b,mount,emit:id=>listeners.forEach(cb=>cb({taskId:id})),
      result:(id,text='',legacyHistory=false,running=false)=>({taskId:id,legacyHistory,running,events:text?[{sessionId:id,seq:1,ts:1,type:'user_message',state:'success',payload:{text,generationKind:'constructor'}}]:[]}),
      header:(session,task=true)=>root.render(React.createElement(SessionHeader,{session,agents:[],onOpenGeneration:()=>{},...(task?{}:{titleConfiguration:React.createElement('span',null,'Router 配置')})}))};
    mount();
  `,
  inspect: `(async()=>{
    const f=window.fixture,tick=()=>new Promise(r=>setTimeout(r,25));
    const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+JSON.stringify(f.errors))};
    const last=()=>f.requests.at(-1),text=()=>f.host.textContent;
    await wait(()=>f.requests.length===1,'initial read');const old=last();
    f.emit('a');await wait(()=>f.requests.length===2,'update during initial read');
    last().resolve(f.result('a','NEWEST'));await wait(()=>text().includes('NEWEST'),'newest first');
    old.resolve(f.result('a','STALE'));await tick();const sameTaskRace=!text().includes('STALE');
    f.emit('a');await wait(()=>f.requests.length===3,'later read');const previousTask=last();
    f.mount(f.b);await wait(()=>last().id==='b','task B request');const bRequest=last();
    previousTask.resolve(f.result('a','WRONG_TASK'));await tick();const noCrossTask=!text().includes('WRONG_TASK')&&!text().includes('NEWEST');
    bRequest.reject(Error('offline'));await wait(()=>f.host.querySelector('[role=alert]'),'initial read failure');
    f.host.querySelector('[role=alert] button').click();await wait(()=>last()!==bRequest,'retry');
    last().resolve(f.result('b'));await wait(()=>text().includes('当前任务尚无生成记录'),'new empty');
    f.emit('b');await wait(()=>f.requests.length===6,'legacy update');last().resolve(f.result('b','',true));
    await wait(()=>text().includes('旧版原始生成对话未保存'),'legacy empty');
    f.emit('b');await wait(()=>f.requests.length===7,'running update');last().resolve(f.result('b','RUNNING_INPUT',true,true));
    await wait(()=>text().includes('当前正在生成')&&text().includes('RUNNING_INPUT'),'running state');
    f.emit('b');await wait(()=>f.requests.length===8,'failed live refresh');last().reject(Error('refresh failed'));
    await wait(()=>text().includes('读取更新失败'),'refresh error');const retained=text().includes('RUNNING_INPUT');
    f.host.querySelector('[role=alert] button').click();await wait(()=>f.requests.length===9,'refresh retry');last().resolve(f.result('b','RECOVERED'));
    await wait(()=>text().includes('RECOVERED')&&!text().includes('读取更新失败'),'refresh recovered');
    f.header({...f.a,source:'router'},false);await wait(()=>!f.host.querySelector('.task-generation-conversation'),'unmounted');
    const unsubscribed=f.listeners.size===0;
    return{sameTaskRace,noCrossTask,retained,unsubscribed,errors:f.errors};
  })()`
})
assert.deepEqual(races.errors, [])
for (const key of ['sameTaskRace', 'noCrossTask', 'retained', 'unsubscribed']) assert.equal(races[key], true, key)
console.log('PASS generation loading races, task isolation, empty/legacy states, running updates, failure recovery and subscription cleanup')
