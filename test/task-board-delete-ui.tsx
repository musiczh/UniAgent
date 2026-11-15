import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-board-delete', {
  setup: `
    import {TaskBoard} from './src/renderer/components/TaskBoard';
    import {deleteSessionWithConfirmation} from './src/renderer/sessionDeletion';
    import {WorkspaceDetail} from './src/renderer/components/WorkspaceBrowser';
    import {projectTaskBoard} from './src/shared/taskBoard';
    import {DEFAULT_ROUTER_CONFIG} from './src/shared/router';
    const session=(id,status='idle',extra={})=>({id,title:'任务 '+id+' · 较长标题'.repeat(8),status,createdAt:1,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'},...extra});
    const sessions=[session('done','completed'),session('running','running'),session('queued','queued'),session('fresh'),session('approval','awaiting-approval'),session('error','error'),session('standby','idle',{taskState:{phase:'standby'}}),session('archived','idle',{archived:true}),session('readonly','completed',{readOnly:true}),session('team','completed',{teamBinding:{teamProjectId:'team'}})];
    const request={requestId:'11111111-1111-4111-8111-111111111111',prompt:'路由失败输入'.repeat(12),scope:{kind:'requirement',requirementId:'r'},config:DEFAULT_ROUTER_CONFIG,state:'failed',version:4,delivery:'pending',createdAt:1,updatedAt:2};
    const calls=[],confirmations=[],opened=[],errors=[];let notify=()=>{},accept=false,fail=true,routeFail=false,release;
    const data={projects:[{id:'p',name:'空间'}],requirements:[{id:'r',name:'需求',projectId:'p',status:'active',dir:'/fixture/r'}],requirementsEnabled:true,projectsLoading:false,requirementsLoading:false};
    window.confirm=text=>{confirmations.push(text);return accept};
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({
      getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query,()=>true,[request]),getEvents:async()=>[],getTaskDecisions:async()=>[],
      previewSessionDeletion:async id=>({confirmationId:'checked-'+id,title:sessions.find(row=>row.id===id).title,team:id==='team',worktrees:id==='done'?[{path:'/fixture/worktree',branch:'uniagent/task-done',dirty:true,sharedCount:0,removed:false}]:[]}),
      deleteSession:async(id,confirmationId)=>{if(confirmationId!=='checked-'+id)throw Error('缺少预检确认');calls.push({task:id});await new Promise(resolve=>release=resolve);if(fail)throw Error('任务删除失败');if(id==='team')throw Error('团队任务仍在执行');sessions.splice(sessions.findIndex(row=>row.id===id),1);notify()},
      cancelRouterInput:async(id,version)=>{calls.push({router:id,version});if(version!==request.version)throw Error('路由记录已变化');if(routeFail)throw Error('路由删除失败');request.state='cancelled';request.version++;notify();return {...request}},
      onTaskBoardChanged:callback=>{notify=callback;return()=>{notify=()=>{}}}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const onDeleteTask=async id=>{await deleteSessionWithConfirmation(id)};
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;width:1024px;height:640px;display:flex;background:var(--bg)';
    const root=createRoot(host),mount=(scoped=false)=>root.render(React.createElement(scoped?WorkspaceDetail:TaskBoard,{projects:data.projects,requirements:data.requirements,onCreate:()=>{},onOpenTask:id=>opened.push(id),onOpenRouter:()=>opened.push('router'),onDeleteTask,...(scoped?{location:{kind:'requirement',id:'r'},data,requirementsEnabled:true,sessions,pending:{},unread:{},status:{},sessionsLoading:false,onRetrySessions:async()=>{},onNavigate:()=>{},onManage:()=>{}}:{})}));
    localStorage.clear();mount();window.deleteFixture={host,sessions,request,calls,confirmations,opened,errors,mount,accept:value=>accept=value,allow:()=>fail=false,routeFail:value=>routeFail=value,release:()=>release()};
  `,
  inspect: `(async()=>{
    const f=window.deleteFixture,q=selector=>f.host.querySelector(selector),tick=()=>new Promise(resolve=>setTimeout(resolve,20)),wait=async(predicate,label)=>{for(let i=0;i<150;i++){if(predicate())return;await tick()}throw Error(label+': '+f.host.textContent+' / '+f.errors)},card=id=>q('[data-task-id="'+id+'"]'),del=id=>card(id)?.querySelector('[data-action=delete]');
    const confirm=async(accept=true)=>{await wait(()=>document.querySelector('[data-confirm-delete]'),'confirmation');const dialog=document.querySelector('.session-delete-overlay');f.confirmations.push(dialog.textContent);dialog.querySelector(accept?'[data-confirm-delete]':'[data-cancel-delete]').click()};
    await wait(()=>card('done'),'board');q('[aria-label=展开已归档列]').click();await wait(()=>card('archived'),'archive');
    const ids=f.sessions.map(row=>row.id),available=ids.map(id=>({id,enabled:!!del(id)&&!del(id).disabled}));
    del('done').focus();const focusVisible=getComputedStyle(del('done').parentElement).opacity;
    const layouts=[];for(const width of [640,1024,1360]){f.host.style.width=width+'px';await tick();for(const id of ['done','running','archived','router:'+f.request.requestId]){const el=card(id),controls=el.querySelector('.task-board-card-actions').getBoundingClientRect(),heading=el.querySelector('.task-board-card-heading'),open=el.querySelector('.task-board-card-open');layouts.push({width,id,actionCount:el.querySelectorAll('[data-action]').length,contained:controls.right<=el.getBoundingClientRect().right&&controls.left>=el.getBoundingClientRect().left,titlePadding:getComputedStyle(heading).paddingRight,textFills:Math.abs(heading.lastElementChild.getBoundingClientRect().right-(open.getBoundingClientRect().right-parseFloat(getComputedStyle(open).paddingRight)))<1,overflow:el.scrollWidth>el.clientWidth});}}
    f.host.style.width='1024px';await tick();
    del('done').click();await confirm(false);await tick();const cancelled={calls:f.calls.length,kept:!!card('done')};
    f.accept(true);const button=del('done');button.click();button.click();await confirm();await wait(()=>f.calls.length===1,'delete pending');
    const locked=!card('done')&&!document.querySelector('.session-delete-overlay');
    f.release();await wait(()=>q('[role=alert]')?.textContent.includes('任务删除失败'),'failure');const retained=!!card('done')&&!del('done').disabled;
    f.allow();del('done').click();await confirm();await wait(()=>f.calls.length===2,'retry');f.release();await wait(()=>!card('done'),'deleted');
    const removedCount=q('[data-column=decision] header>span').textContent;
    for(const id of ['running','queued','fresh','approval','error','standby','archived']){const n=f.calls.length;del(id).click();await confirm();await wait(()=>f.calls.length===n+1,'delete '+id);f.release();await wait(()=>!card(id),'remove '+id)}
    del('team').click();await confirm();await wait(()=>f.calls.at(-1)?.task==='team','team request');f.release();await wait(()=>q('[role=alert]')?.textContent.includes('团队任务仍在执行'),'team guard');const teamGuarded=!!card('team');
    f.mount(true);await wait(()=>q('.requirement-detail')&&del('readonly'),'scoped board');del('readonly').click();await confirm();await wait(()=>f.calls.at(-1)?.task==='readonly','scoped callback');f.release();await wait(()=>!card('readonly'),'scoped deletion');
    const routeId='router:'+f.request.requestId;await wait(()=>del(routeId),'failed route');
    f.request.version++;del(routeId).click();await wait(()=>q('[role=alert]')?.textContent.includes('路由记录已变化'),'stale route');await tick();await tick();
    const staleKept=!!card(routeId);f.routeFail(true);del(routeId).click();await wait(()=>q('[role=alert]')?.textContent.includes('路由删除失败'),'router failure');await tick();
    const routeRetained=!!card(routeId);f.routeFail(false);del(routeId).click();await wait(()=>!card(routeId),'route deleted');
    const routeRemovedCount=q('[data-column=active] header>span').textContent;
    return {available,focusVisible,layouts,cancelled,locked,retained,removedCount,teamGuarded,staleKept,routeRetained,routeRemovedCount,routeState:f.request.state,confirmations:f.confirmations,calls:f.calls,opened:f.opened,errors:f.errors};
  })()`
})
assert.ok(result.available.every((entry: any) => entry.enabled), 'every ordinary task has deletion in all four columns, including read-only records and team leaders')
assert.equal(result.focusVisible, '1')
assert.deepEqual([...new Set(result.layouts.map((layout: any) => layout.actionCount))].sort(), [1, 2, 3])
assert.ok(result.layouts.every((layout: any) => layout.contained && layout.titlePadding === '0px' && layout.textFills && !layout.overflow), 'one to three actions overlay full-width titles without overflowing, including archived and Router cards: ' + JSON.stringify(result.layouts))
assert.deepEqual(result.cancelled, { calls: 0, kept: true })
assert.equal(result.locked, true, 'the confirmed card and dialog disappear while deletion is still pending')
assert.equal(result.retained, true, 'failed deletion retains the card and permits retry')
assert.equal(result.removedCount, '4', 'successful deletion updates the decision count')
assert.equal(result.teamGuarded, true)
assert.equal(result.staleKept, true); assert.equal(result.routeRetained, true)
assert.equal(result.routeRemovedCount, '0'); assert.equal(result.routeState, 'cancelled')
assert.deepEqual(result.calls.filter((call: any) => call.router).map((call: any) => call.version), [4, 5, 5])
assert.ok(result.confirmations.some((text: string) => text.includes('成员会话')), 'team confirmation discloses member deletion')
assert.ok(result.confirmations.some((text: string) => text.includes('永久丢弃') && text.includes('/fixture/worktree')), 'dirty checkout deletion discloses the real scope before mutation')
assert.ok(result.confirmations.some((text: string) => text.includes('诊断历史')), 'routing confirmation explains retained history')
assert.deepEqual(result.opened, [], 'delete buttons never open the card')
assert.deepEqual(result.errors, [])
console.log('PASS board deletion: all columns, running/queued/read-only tasks, team guard, scoped callback, confirmation cancel, pending lock, failure/retry, counts, stale router versions and retained diagnostics')
