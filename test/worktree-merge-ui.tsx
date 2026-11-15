import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const width of [1360, 1024]) {
  const result = await renderEventStream([], 'idle', 'worktree-merge-app', {
    screenshot: { width, height: 800, path: resolve('out/test/worktree-merge-' + width + '.png') },
    setup: `
      import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
      installMarkdownInputDriver();localStorage.clear();
      const errors=[],mutations=[],subscriptions={},noop=()=>{};
      window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const tree={id:'merge-tree',state:'ready',workdir:'/fixture/task',baseRef:'refs/heads/master',branch:'uniagent/task-merge'};
      const a={id:'merge-a',title:'合并工作树',status:'completed',createdAt:1,config:{agentId:'codex',workdir:tree.workdir,permissionMode:'ask',worktree:tree}};
      const b={...a,id:'merge-b',title:'另一任务',config:{...a.config,worktree:{...tree,id:'other-tree',workdir:'/fixture/other'}}};
      let sessions=[a,b],failStatus=false;
      const subscribe=name=>cb=>{const listeners=subscriptions[name]||=new Set();listeners.add(cb);return()=>listeners.delete(cb)};
      const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],lifecycle:{availability:'available'},capabilities:{permissionModes:[]}};
      const api={listForkJobs:async()=>[],startupState:async()=>({ready:true}),teamCatalog:async()=>({teams:[],projects:[],errors:[]}),
        getWorktreeArchiveReviews:async()=>[],getLifecycleSnapshot:async()=>[agent],getAppSettings:async()=>({spaceRequirementSidebar:false}),
        listSessions:async()=>structuredClone(sessions),getAssistantPrivateSessions:async()=>[],listQueues:async()=>({}),e2eEnabled:async()=>false,
        listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],getPrefs:async()=>({lastByAgent:{}}),getTaskDecisions:async()=>[],getTaskState:async()=>null,
        pickFiles:async()=>[{kind:'file',name:'draft.txt',path:'/fixture/draft.txt'}],
        getSessionRuntimeState:async()=>({events:[],hasLiveStreamer:false,nativeSessionOccupancy:{state:'unsupported'}}),
        getSessionWorktreeStatus:async id=>{if(failStatus)throw Error('Git 查询失败');const t=sessions.find(s=>s.id===id).config.worktree;return{treeId:t.id,directory:t.workdir,sourceBranch:'master',branch:t.branch,changedFiles:0,unmergedCommits:1,commits:[{hash:'a'.repeat(40),subject:'任务提交'}],checkedAt:Date.now()}},
        onSessionUpdated:subscribe('updated'),onStatusChange:subscribe('status'),onEvent:subscribe('event')};
      window.uniagent=new Proxy(api,{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async(...args)=>{if(/send|create|interrupt|archive|respond/i.test(String(k)))mutations.push({method:k,args});return null}});
      window.fixture={errors,mutations,prompt:'请将当前工作树的任务提交合并回绑定的本机源分支，遵守回源检查并核验结果；不要 push。',
        update:patch=>{sessions=sessions.map(s=>s.id===a.id?{...s,...patch}:s);for(const cb of subscriptions.updated||[])cb({session:structuredClone(sessions[0])})},
        failStatus:value=>{failStatus=value;for(const cb of subscriptions.status||[])cb({sessionId:a.id,status:'completed'})}};
      window.appReady=import('./src/renderer/App').then(({App})=>{const host=document.body.appendChild(document.createElement('div'));host.id='merge-app';host.style.cssText='position:fixed;inset:0';createRoot(host).render(<App/>)});
    `,
    inspect: `(async()=>{
      const f=window.fixture,tick=()=>new Promise(r=>setTimeout(r,30));
      const wait=async(p,label)=>{for(let i=0;i<120;i++){if(p())return;await tick()}throw Error(label+': '+JSON.stringify(f.errors))};
      await window.appReady;const host=document.getElementById('merge-app');
      const select=async id=>{host.querySelector('[data-session-id="'+id+'"]').click();await wait(()=>host.querySelector('.session-task-content')?.dataset.taskId===id&&host.querySelector('.markdown-editor-content[contenteditable=true]'),'select '+id)};
      const composer=()=>host.querySelector('.session-view .composer-wrap'),text=()=>window.__markdownInput.text(composer()),pop=()=>document.querySelector('.worktree-status-popover'),merge=()=>pop()?.querySelector('[aria-label="填入工作树合并指令"]');
      const open=async()=>{host.querySelector('.session-header .worktree-status-badge').click();await wait(()=>pop()&&!pop().querySelector('[aria-busy=true]'),'open worktree')};
      const fill=async value=>{window.__markdownInput.fill(composer(),value);await tick()};
      const clickMerge=async()=>{await open();if(!merge())throw Error('missing merge action');merge().click();await wait(()=>!pop()&&text().includes(f.prompt),'merge prefill');await tick()};
      await wait(()=>host.querySelector('[data-session-id="merge-a"]'),'sidebar');await select('merge-a');
      await fill('保留这份草稿');
      composer().querySelector('.sb-add summary').click();[...composer().querySelectorAll('.sb-menu-item')].find(b=>b.textContent.includes('添加附件')).click();
      await wait(()=>composer().querySelector('.attach-file'),'attachment');
      await clickMerge();const first=text(),focused=document.activeElement===composer().querySelector('[contenteditable=true]'),attachment=composer().querySelector('.attach-file').textContent;
      await clickMerge();const repeated=text();
      await fill(first+'\\n补充说明');await clickMerge();const appendedNote=text();
      await select('merge-b');const otherInitially=text();await clickMerge();const emptyFilled=text();
      await fill('另一任务的草稿');await select('merge-a');const restored=text();
      await select('merge-b');const otherRestored=text();await select('merge-a');
      f.failStatus(true);await wait(()=>host.querySelector('.session-header .worktree-status-badge')?.textContent==='状态待确认','status failure');await open();const disabledOnError=merge()?.disabled;pop().querySelector('[aria-label="关闭工作树状态"]').click();f.failStatus(false);
      f.update({readOnly:true});await wait(()=>!host.querySelector('.session-view .composer-wrap'),'readonly');await open();const noReadonlyMerge=!merge();pop().querySelector('[aria-label="关闭工作树状态"]').click();
      f.update({readOnly:false,archived:true});await wait(()=>host.querySelector('.task-standby'),'archived');await open();const noArchivedMerge=!merge();pop().querySelector('[aria-label="关闭工作树状态"]').click();
      f.update({archived:false,config:{agentId:'codex',workdir:'/fixture/task',permissionMode:'ask',worktree:{id:'removed-tree',state:'ready',removedAt:1,workdir:'/fixture/task',baseRef:'refs/heads/master'}}});
      await wait(()=>host.querySelector('.session-header .worktree-status-badge')?.textContent==='工作树已移除','removed');await open();const unavailableMerge=merge()?.disabled;const r=pop().getBoundingClientRect(),layout=r.left>=12&&r.right<=innerWidth-12&&r.bottom<=innerHeight-12;
      return{first,repeated,appendedNote,focused,attachment,otherInitially,emptyFilled,restored,otherRestored,disabledOnError,noReadonlyMerge,noArchivedMerge,unavailableMerge,layout,mutations:f.mutations,errors:f.errors,prompt:f.prompt};
    })()`
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.first, '保留这份草稿\n\n' + result.prompt)
  assert.equal(result.repeated, result.first)
  assert.equal(result.appendedNote, result.first + '\n补充说明')
  assert.equal(result.focused, true)
  assert.match(result.attachment, /draft.txt/)
  assert.equal(result.otherInitially, '')
  assert.equal(result.emptyFilled, result.prompt)
  assert.equal(result.restored, result.appendedNote)
  assert.equal(result.otherRestored, '另一任务的草稿')
  for (const key of ['disabledOnError', 'noReadonlyMerge', 'noArchivedMerge', 'unavailableMerge', 'layout']) assert.equal(result[key], true, key)
  assert.deepEqual(result.mutations, [], 'opening or filling a merge request must never send or mutate the task')
  console.log('PASS worktree merge App wiring: draft/attachment preservation, repeat, focus, session isolation and unavailable states at ' + width)
}

const prefill = await renderEventStream([], 'idle', 'merge-prefill-contract', {
  setup: `
    import {Composer} from './src/renderer/components/Composer';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();localStorage.clear();
    const noop=()=>{},host=document.body.appendChild(document.createElement('div')),root=createRoot(host),sends=[];
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],capabilities:{permissionModes:[]}};
    const capabilities={agentId:'codex',workdir:'/fixture',source:'native',candidates:[],errors:[],actions:{goal:false,review:false,plan:null}};
    window.uniagent=new Proxy({listPresets:async()=>[]},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>null});
    let request={text:'',nonce:0},disabled=false;
    const render=()=>root.render(<Composer sessionId='a' status='idle' config={{agentId:'codex',workdir:'/fixture'}} agent={agent} onSend={text=>sends.push(text)} onForceSend={noop} onInterrupt={noop} onUpdateConfig={noop} onSetCollaborationMode={noop} onRunNativeAction={noop} queue={[]} onDequeue={noop} onPromoteQueue={noop} onEditQueueItem={noop} capabilities={capabilities} capabilitiesReady contextUsed={0} disabled={disabled} prefill={request}/>);
    render();window.prefillFixture={host,sends,request:(patch,lock=false)=>{request={...patch,nonce:request.nonce+1};disabled=lock;render()},rerender:render};
  `,
  inspect: `(async()=>{
    const f=window.prefillFixture,tick=()=>new Promise(r=>setTimeout(r,40));
    for(let i=0;i<100&&!f.host.querySelector('[contenteditable=true]');i++)await tick();
    const text=()=>window.__markdownInput.text(f.host);window.__markdownInput.fill(f.host,'原草稿');await tick();
    f.request({text:'合并指令',append:true,sessionId:'b'});await tick();const mismatch=text();
    f.request({text:'合并指令',append:true,sessionId:'a'},true);await tick();const locked=text();
    f.request({text:'回退后的输入'});await tick();const replaced=text();
    window.__markdownInput.fill(f.host,'回退后继续编辑');await tick();f.rerender();await tick();const retained=text();
    f.request({text:'同一任务合并',append:true,sessionId:'a'});await tick();const appended=text();
    return{mismatch,locked,replaced,retained,appended,sends:f.sends,errors:window.__fixtureErrors};
  })()`
})
assert.deepEqual(prefill.errors, [])
assert.equal(prefill.mismatch, '原草稿')
assert.equal(prefill.locked, '原草稿')
assert.equal(prefill.replaced, '回退后的输入')
assert.equal(prefill.retained, '回退后继续编辑')
assert.equal(prefill.appended, '回退后继续编辑\n\n同一任务合并')
assert.deepEqual(prefill.sends, [])
console.log('PASS Composer prefill: rewind replacement, ordinary rerender, target session and disabled input')
