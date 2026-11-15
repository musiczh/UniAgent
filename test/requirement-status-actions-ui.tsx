import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'requirement-status-actions', {
  screenshot: { width: 1160, height: 740, path: 'out/test/requirement-status-actions.png' },
  setup: `
    import {useState} from 'react';
    import {SpaceRequirementNavigation,WorkspaceDetail,useWorkspaceData} from './src/renderer/components/WorkspaceBrowser';
    import {RequirementSettings} from './src/renderer/components/RequirementSettings';
    import {projectTaskBoard} from './src/shared/taskBoard';
    const originalApi=window.uniagent;
    window.uniagent=new Proxy({}, {get:(target,key)=>Reflect.has(target,key)?Reflect.get(target,key):originalApi[key]});
    localStorage.clear();
    const listeners=new Set(), updates=[], confirmations=[], sessionWrites=[], navigations=[];
    const initialRequirements=[
      {id:'active',name:'进行中需求',projectId:'a',status:'active'},
      {id:'legacy',name:'历史已完成需求',projectId:'a',status:'done'},
      {id:'retry',name:'重试需求',projectId:'a',status:'active'},
      {id:'archived',name:'已归档需求',projectId:'a',status:'archived'}
    ].map(r=>({...r,dir:'/fixture/'+r.id,docPath:'/fixture/'+r.id+'/context.md',createdAt:1,updatedAt:1}));
    let requirements=initialRequirements.map(r=>({...r}));
    const sessions=[{id:'task',title:'原任务',status:'completed',createdAt:1,config:{agentId:'codex',projectId:'a',requirementId:'active'}}];
    window.uniagent.getTaskBoard=async query=>projectTaskBoard(sessions,()=>[],query);
    let confirmResult=true, failNext=false, holdNext=false, finishPending;
    const emit=()=>listeners.forEach(listener=>listener());
    window.confirm=message=>{confirmations.push(message);return confirmResult};
    window.uniagent.listRequirements=async()=>requirements.map(r=>({...r}));
    window.uniagent.onRequirementsChanged=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
    window.uniagent.listProjects=async()=>[{id:'a',name:'空间 A',isDefault:true}];
    window.uniagent.updateRequirement=(id,patch)=>{
      updates.push([id,patch]);
      if(failNext){failNext=false;return Promise.reject(Error('写入失败样例'))}
      const finish=()=>{requirements=requirements.map(r=>r.id===id?{...r,...patch}:r);emit();return requirements.find(r=>r.id===id)};
      if(holdNext){holdNext=false;return new Promise(resolve=>{finishPending=()=>resolve(finish())})}
      return Promise.resolve(finish());
    };
    for(const key of ['archiveSession','unarchiveSession','deleteSession','decideTask'])window.uniagent[key]=(...args)=>sessionWrites.push([key,args]);
    const host=document.body.appendChild(document.createElement('div'));
    host.style.cssText='position:fixed;inset:0;display:flex;padding:20px;gap:24px';
    function Fixture(){
      const data=useWorkspaceData(true),[location,setLocation]=useState({kind:'space',id:'a'}),[detail,setDetail]=useState(null);
      window.setRequirementActionLocation=setLocation;
      window.setRequirementActionDetail=setDetail;
      return <><aside className="sidebar" style={{width:280,minWidth:280}}><SpaceRequirementNavigation data={data} location={location} sessions={sessions} pending={{}} unread={{}} status={{}} onNavigate={next=>{navigations.push(next);setLocation(next)}} onCreate={()=>{}} onOpenTask={()=>{}}/></aside><section style={{display:'flex',flexDirection:'column',flex:1,minWidth:0,overflow:'auto'}}>{detail?<WorkspaceDetail key={detail.kind+detail.id} location={detail} data={data} requirementsEnabled sessions={sessions} pending={{}} unread={{}} status={{}} sessionsLoading={false} onRetrySessions={async()=>{}} onNavigate={next=>{navigations.push(next);setDetail(next)}} onCreate={()=>{}} onOpenTask={()=>{}} onManage={category=>navigations.push(category)}/>:<RequirementSettings enabled onToggle={()=>{}} onBrowse={()=>{}}/>}</section></>;
    }
    createRoot(host).render(<Fixture/>);
    window.requirementActions={host,updates,confirmations,sessionWrites,navigations,sessions,
      confirm:value=>confirmResult=value,fail:()=>failNext=true,hold:()=>holdNext=true,finish:()=>finishPending(),
      remove:id=>{requirements=requirements.filter(r=>r.id!==id);emit()},
      reset:()=>{requirements=initialRequirements.map(r=>({...r}));updates.length=0;confirmations.length=0;emit()}
    };
  `,
  inspect: `(async()=>{
    const f=window.requirementActions,tick=()=>new Promise(r=>setTimeout(r,25)),q=s=>f.host.querySelector(s),all=s=>[...f.host.querySelectorAll(s)],menu=()=>document.querySelector('[role=menu][aria-label="需求操作"]');
    const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await tick()}throw Error('timeout '+label)};
    await wait(()=>all('.project-settings-row').length===4&&all('.scope-nav-row.requirement').length===3,'mount');
    const text=e=>e.textContent.trim(),buttons=e=>[...e.querySelectorAll('button')],settings=name=>all('.project-settings-row').find(e=>e.querySelector('.r-label').textContent.startsWith(name));
    const labels=buttons(settings('进行中需求')).map(text);
    if(labels.includes('完成'))return {phase:'completion-visible',labels};
    const row=name=>all('.scope-nav-row.requirement').find(e=>e.querySelector('.scope-nav-name').textContent===name);
    const rightClick=element=>element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:window.innerWidth-1,clientY:window.innerHeight-1}));
    const key=(element,value,extra={})=>element.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:value,...extra}));
    rightClick(row('进行中需求').querySelector('button'));await tick();
    if(!menu())return {phase:'missing-menu',labels};
    const menuLabels=buttons(menu()).map(text),bounds=menu().getBoundingClientRect();
    const bounded=bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight;
    const focusMoved=menu().contains(document.activeElement);
    key(menu(),'Escape');await wait(()=>!menu(),'escape');
    const focusRestored=document.activeElement===row('进行中需求').querySelector('button');
    key(document.activeElement,'F10',{shiftKey:true});await wait(()=>menu(),'keyboard menu');
    f.confirm(false);menu().querySelector('button').click();await wait(()=>!menu(),'cancel');
    const cancelled=f.updates.length===0&&!!row('进行中需求');
    f.confirm(true);rightClick(row('进行中需求'));await wait(()=>menu(),'archive menu');
    window.setRequirementActionLocation({kind:'requirement',id:'active'});await tick();
    f.hold();const archive=menu().querySelector('button');archive.click();archive.click();await tick();
    rightClick(row('进行中需求'));await tick();
    const locked=f.updates.length===1&&!menu();f.finish();
    await wait(()=>!row('进行中需求')&&settings('进行中需求').textContent.includes('已归档'),'archive refresh');
    const archiveDidNotNavigate=f.navigations.length===0;
    const legacyLabels=buttons(settings('历史已完成需求')).map(text);
    buttons(settings('历史已完成需求')).find(e=>text(e)==='归档').click();
    await wait(()=>!row('历史已完成需求'),'legacy archive');
    const choose=async view=>{q('[aria-label="切换侧栏视图"]').click();await tick();q('[data-sidebar-view="'+view+'"]').click();await tick()};
    await choose('requirement');window.setRequirementActionLocation({kind:'requirement',id:'retry'});await tick();
    rightClick(row('重试需求'));await wait(()=>menu(),'flat menu');
    f.fail();menu().querySelector('button').click();await wait(()=>all('[role=alert]').some(e=>e.textContent.includes('写入失败样例')),'error');
    const failurePreserved=!!row('重试需求');rightClick(row('重试需求'));await wait(()=>menu(),'retry menu');
    document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await wait(()=>!menu(),'outside');
    rightClick(row('重试需求'));await wait(()=>menu(),'retry');menu().querySelector('button').click();
    await wait(()=>!row('重试需求'),'retry success');
    window.setRequirementActionLocation({kind:'requirement',id:'archived'});await tick();
    if(row('已归档需求')||all('.scope-nav-row.requirement').length||q('.scope-muted')?.textContent!=='暂无需求')throw Error('selected archived requirement must stay hidden and the empty list must show its placeholder');
    const restoreLabels=buttons(settings('已归档需求')).map(text),confirmationsBeforeRestore=f.confirmations.length;
    buttons(settings('已归档需求')).find(e=>text(e)==='恢复').click();
    await wait(()=>settings('已归档需求').textContent.includes('进行中')&&row('已归档需求'),'restore refresh');
    const restoreWithoutConfirmation=f.confirmations.length===confirmationsBeforeRestore;
    buttons(settings('进行中需求')).find(e=>text(e)==='恢复').click();await wait(()=>row('进行中需求'),'settings restore');
    await choose('task');const group=q('[data-task-group="active:requirement:active"] > button');
    const expanded=group.getAttribute('aria-expanded');rightClick(group);await wait(()=>menu(),'task group menu');
    const taskGroupLabels=buttons(menu()).map(text),foldUnchanged=group.getAttribute('aria-expanded')===expanded;
    f.confirm(false);menu().querySelector('button').click();await wait(()=>!menu(),'task cancel');
    f.confirm(true);buttons(settings('进行中需求')).find(e=>text(e)==='归档').click();
    await wait(()=>settings('进行中需求').textContent.includes('已归档'),'settings archive');
    const archivedGroup=q('[data-task-group="active:requirement:active"] > button');
    key(archivedGroup,'ContextMenu');await wait(()=>menu(),'restore task group menu');
    if(buttons(menu()).map(text).join()!=='恢复')throw Error('active task group must retain its archived requirement restore action');
    menu().querySelector('button').click();await wait(()=>settings('进行中需求').textContent.includes('进行中'),'task group restore');
    await choose('requirement');rightClick(row('进行中需求'));await wait(()=>menu(),'stale menu');
    const beforeRemoval=f.updates.length;f.remove('active');await wait(()=>!menu()&&!row('进行中需求'),'removed requirement');
    const sidebarResult={phase:'passed',labels,legacyLabels,menuLabels,restoreLabels,taskGroupLabels,bounded,focusMoved,focusRestored,cancelled,locked,archiveDidNotNavigate,failurePreserved,restoreWithoutConfirmation,foldUnchanged,
      removedWithoutWrite:f.updates.length===beforeRemoval,updates:f.updates.slice(),confirmations:f.confirmations.slice(),sessionWrites:f.sessionWrites,taskStatus:f.sessions[0].status};
    f.reset();window.setRequirementActionDetail({kind:'requirement',id:'active'});
    await wait(()=>q('.workspace-detail .scope-more'),'detail mount');
    const more=()=>q('.workspace-detail .scope-more'),trigger=()=>more().querySelector('.scope-button'),detailMenu=()=>more().querySelector('[role=menu]'),openMore=async()=>{trigger().click();await wait(()=>detailMenu(),'detail menu')},item=label=>buttons(detailMenu()).find(button=>text(button)===label);
    trigger().click();await tick();
    if(!detailMenu()||!item('归档'))return {...sidebarResult,detail:{phase:'missing-archive'}};
    const detailLabels=buttons(detailMenu()).map(text),detailBounds=detailMenu().getBoundingClientRect(),detailBounded=detailBounds.left>=0&&detailBounds.right<=innerWidth&&detailBounds.top>=0&&detailBounds.bottom<=innerHeight;
    const icons=buttons(detailMenu()).every(button=>button.querySelector('.ui-icon')),itemHeight=buttons(detailMenu()).every(button=>button.getBoundingClientRect().height>=34),roundedItems=buttons(detailMenu()).every(button=>parseFloat(getComputedStyle(button).borderRadius)>=5);
    const detailFocusMoved=document.activeElement===item('需求设置');key(detailMenu(),'ArrowDown');const arrowSelected=document.activeElement===item('归档');key(detailMenu(),'Home');const homeSelected=document.activeElement===item('需求设置');key(detailMenu(),'End');const endSelected=document.activeElement===item('归档');
    key(detailMenu(),'Escape');await wait(()=>!detailMenu(),'detail escape');const detailFocusRestored=document.activeElement===trigger();
    await openMore();document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await wait(()=>!detailMenu(),'detail outside');
    await openMore();item('需求设置').click();await wait(()=>document.querySelector('[aria-label="编辑需求"]'),'settings editor');const settingsClosedMenu=!detailMenu();document.querySelector('[aria-label="编辑需求"] [aria-label="关闭"]').click();await wait(()=>!document.querySelector('[aria-label="编辑需求"]'),'editor close');
    await openMore();f.confirm(false);item('归档').click();await wait(()=>!detailMenu(),'detail cancel');const detailCancelled=f.updates.length===0&&!q('.scope-heading .task-execution-status');
    f.confirm(true);await openMore();f.hold();const detailArchive=item('归档');detailArchive.click();detailArchive.click();await tick();await openMore();const detailLocked=f.updates.length===1&&buttons(detailMenu()).find(button=>button.querySelector('.ui-icon-archive')).disabled;key(detailMenu(),'Escape');f.finish();
    await wait(()=>q('.scope-heading .task-execution-status')?.textContent==='已归档','detail archived');const createDisabled=q('.scope-actions .primary').disabled;await openMore();const archiveAbsent=!item('归档');key(detailMenu(),'Escape');
    window.setRequirementActionDetail({kind:'requirement',id:'legacy'});await wait(()=>q('.scope-heading h1')?.textContent==='历史已完成需求','legacy detail');await openMore();f.fail();item('归档').click();await wait(()=>all('[role=alert]').some(e=>e.textContent.includes('写入失败样例')),'detail failure');const detailFailurePreserved=!q('.scope-heading .task-execution-status');await openMore();item('归档').click();await wait(()=>q('.scope-heading .task-execution-status')?.textContent==='已归档','detail retry');const detailErrorCleared=!all('[role=alert]').some(e=>e.textContent.includes('写入失败样例'));
    for(const location of [{kind:'space',id:'a'},{kind:'assistant'}]){window.setRequirementActionDetail(location);await wait(()=>q('.scope-heading h1')?.textContent===(location.kind==='space'?'空间 A':'个人助手'),'other scope');await openMore();if(item('归档'))throw Error('archive leaked to '+location.kind);key(detailMenu(),'Escape')}
    window.setRequirementActionDetail({kind:'requirement',id:'retry'});await wait(()=>q('.scope-heading h1')?.textContent==='重试需求','removal detail');await openMore();const writesBeforeRemoval=f.updates.length;f.remove('retry');await wait(()=>!detailMenu(),'removed detail');const removedDetailWithoutWrite=f.updates.length===writesBeforeRemoval;await openMore();const unavailableDisabled=buttons(detailMenu()).every(button=>button.disabled)&&!item('归档');key(detailMenu(),'Escape');
    const detail={phase:'passed',labels:detailLabels,detailBounded,icons,itemHeight,roundedItems,detailFocusMoved,arrowSelected,homeSelected,endSelected,detailFocusRestored,settingsClosedMenu,detailCancelled,detailLocked,createDisabled,archiveAbsent,detailFailurePreserved,detailErrorCleared,removedDetailWithoutWrite,unavailableDisabled,updates:f.updates.slice(),confirmations:f.confirmations.slice()};
    f.reset();window.setRequirementActionLocation({kind:'requirement',id:'active'});window.setRequirementActionDetail({kind:'requirement',id:'active'});await wait(()=>q('.scope-heading h1')?.textContent==='进行中需求'&&!q('.scope-heading .task-execution-status'),'preview');await openMore();
    return {...sidebarResult,detail};
  })()`
})

assert.equal(result.phase, 'passed', `archive-only UI contract failed: ${JSON.stringify(result)}`)
assert.deepEqual(result.labels, ['查看详情', '打开目录', '编辑', '归档'])
assert.deepEqual(result.legacyLabels, result.labels, 'legacy done requirements retain their data and use the same archive action')
assert.deepEqual(result.menuLabels, ['归档'])
assert.deepEqual(result.restoreLabels, ['查看详情', '打开目录', '编辑', '恢复'])
assert.deepEqual(result.taskGroupLabels, ['归档'], 'task view requirement groups use the same action')
for (const key of ['bounded', 'focusMoved', 'focusRestored', 'cancelled', 'locked', 'archiveDidNotNavigate', 'failurePreserved', 'restoreWithoutConfirmation', 'foldUnchanged', 'removedWithoutWrite']) {
  assert.equal(result[key], true, key)
}
assert.deepEqual(result.updates, [
  ['active', { status: 'archived' }],
  ['legacy', { status: 'archived' }],
  ['retry', { status: 'archived' }],
  ['retry', { status: 'archived' }],
  ['archived', { status: 'active' }],
  ['active', { status: 'active' }],
  ['active', { status: 'archived' }],
  ['active', { status: 'active' }]
])
assert.ok(result.confirmations.every((message: string) => message.includes('只修改需求状态，不归档或删除其下会话')))
assert.deepEqual(result.sessionWrites, [], 'requirement actions never mutate associated tasks or sessions')
assert.equal(result.taskStatus, 'completed')
assert.equal(result.detail.phase, 'passed', JSON.stringify(result.detail))
assert.deepEqual(result.detail.labels, ['需求设置', '归档'])
for (const key of ['detailBounded', 'icons', 'itemHeight', 'roundedItems', 'detailFocusMoved', 'arrowSelected', 'homeSelected', 'endSelected', 'detailFocusRestored', 'settingsClosedMenu', 'detailCancelled', 'detailLocked', 'createDisabled', 'archiveAbsent', 'detailFailurePreserved', 'detailErrorCleared', 'removedDetailWithoutWrite', 'unavailableDisabled']) assert.equal(result.detail[key], true, key)
assert.deepEqual(result.detail.updates, [['active', { status: 'archived' }], ['legacy', { status: 'archived' }], ['legacy', { status: 'archived' }]])
assert.ok(result.detail.confirmations.every((message: string) => message.includes('只修改需求状态，不归档或删除其下会话')))
console.log('PASS requirement archive actions: settings, sidebars and detail menu; cancellation, dedupe, refresh, retry, keyboard, bounds and removed requirements')
