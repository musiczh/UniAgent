import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'

// Catches nested or missing task groups, missing/unbound requirements, duplicate tasks,
// lost view preferences, unbounded archive rendering and failed-open lockups.
const result = await renderEventStream([], 'idle', 'sidebar-views', {
  screenshot: { width: 1024, height: 900, path: 'out/test/sidebar-view-switch.png' },
  setup: `
    import {useState} from 'react';
    import {SpaceRequirementNavigation} from './src/renderer/components/WorkspaceBrowser';
    localStorage.clear();
    const projects=[{id:'a',name:'空间 A',isDefault:true},{id:'b',name:'空间 B'}];
    const requirements=[{id:'r',name:'需求一',projectId:'b',status:'active'},{id:'unbound',name:'未绑定需求',status:'active'},{id:'old',name:'历史需求',projectId:'a',status:'archived'}];
    const task=(id,i,extra={})=>({id,title:'任务 '+i,status:'completed',createdAt:1,updatedAt:i+2,config:{agentId:'codex',projectId:i%2?'a':'b',requirementId:i%3?'r':undefined,workdir:'/fixture'},...extra});
    const rows=Array.from({length:75},(_,i)=>task('t'+i,i));
    rows.push(task('t74',1),task('tool',90,{handoffId:'internal'}),task('assistant',91,{config:{agentId:'codex',assistantSnapshot:{}}}),task('init',92,{config:{agentId:'codex',initializationTargetAgentId:'kimi'}}));
    rows.push(task('unowned',76,{config:{agentId:'codex',workdir:'/removed'}}));
    rows.push(...Array.from({length:120},(_,i)=>task('arch'+i,200+i,{archived:true})));
    rows[74].taskMetadata={title:'最新任务标题'};
    const opened=[],created=[],locations=[];let failOpen=true;
    const host=document.body.appendChild(document.createElement('aside'));host.className='sidebar';host.style.cssText='position:fixed;top:20px;left:20px;width:280px;height:840px';
    let root=createRoot(host);
    function Fixture(){const [version,setVersion]=useState(0);window.updateViewFixture=()=>setVersion(v=>v+1);return <SpaceRequirementNavigation data={{projects,projectsLoading:false,projectsError:'',requirements,requirementsEnabled:true,requirementsLoading:false,requirementsError:version===1?'需求读取失败样例':''}} location={{kind:'requirement',id:'old'}} sessions={rows} pending={{t74:true}} unread={{t73:'main'}} status={{t72:'running'}} activeTaskId="t74" sessionsError={version===2?'任务读取失败样例':''} onRetrySessions={async()=>{throw Error('任务刷新失败样例')}} onNavigate={value=>locations.push(value)} onCreate={seed=>created.push(seed)} onOpenTask={async id=>{if(failOpen)throw Error('任务已移除样例');opened.push(id)}}/>}
    const mount=()=>{root.render(<Fixture/>)};mount();
    window.viewFixture={host,opened,created,locations,allowOpen:()=>failOpen=false,remount:()=>{root.unmount();root=createRoot(host);mount()}};
  `,
  inspect: `(async()=>{
    const f=window.viewFixture,tick=()=>new Promise(r=>setTimeout(r,30)),q=s=>f.host.querySelector(s),all=s=>[...f.host.querySelectorAll(s)],wait=async(p,label)=>{for(let i=0;i<90;i++){if(p())return;await tick()}throw Error('timeout '+label)};
    await wait(()=>q('.scope-navigation'),'mount');
    if(!q('[aria-label="切换侧栏视图"]'))return {selectorPresent:false};
    const choose=async value=>{q('[aria-label="切换侧栏视图"]').click();await wait(()=>q('[role=menu]'),'menu');q('[data-sidebar-view="'+value+'"]').click();await tick()};
    const initial={spaces:all('.scope-nav-row:not(.requirement)').length,tasks:all('[data-task-id]').length};
    await choose('requirement');
    const requirementNames=all('.scope-nav-name').map(e=>e.textContent);
    q('[aria-label="在需求一下新建任务"]').click();
    q('.scope-nav-row.requirement .scope-nav-name').click();
    await choose('task');
    const groups=all('.scope-task-list > [data-task-group]').map(e=>({key:e.dataset.taskGroup,kind:e.dataset.groupKind,title:e.querySelector('.scope-task-group-toggle span').textContent}));
    const oneLevel=all('[data-task-group]').every(e=>!e.querySelector('[data-task-group]'));
    const groupIndents=all('.scope-task-list > [data-task-group] > .scope-task-group-toggle').map(e=>getComputedStyle(e).paddingLeft);
    const membership=all('[data-task-id]').map(e=>[e.dataset.taskId,e.closest('[data-task-group]')?.dataset.taskGroup]);
    const first=all('[data-task-id]').map(e=>e.dataset.taskId);
    const selected=q('[data-task-id=t74]');
    const selection={selected:selected.classList.contains('selected'),title:selected.querySelector('.scope-nav-name').textContent,waiting:!!selected.querySelector('.si-ask')};
    const running=!!q('[data-task-id=t72] .si-spinner'),unread=!!q('[data-task-id=t73] .si-unread');
    q('[data-task-id=t74] .scope-nav-name').click();await wait(()=>q('[role=alert]')?.textContent.includes('任务已移除'),'open failure');
    f.allowOpen();q('[data-task-id=t74] .scope-nav-name').click();await wait(()=>f.opened.length===1,'open retry');
    q('[aria-label="任务下一页"]').click();await tick();const second=all('[data-task-id]').map(e=>e.dataset.taskId);
    const unownedVisible=first.includes('unowned')||second.includes('unowned');
    q('[aria-label="任务上一页"]').click();await tick();
    const requirementGroup=q('[data-task-group="active:requirement:r"]');
    requirementGroup?.querySelector('.scope-task-group-toggle').click();await tick();
    const folded=!!requirementGroup&&requirementGroup.querySelector('.scope-task-group-toggle').getAttribute('aria-expanded')==='false'&&!requirementGroup.querySelector('[data-task-id]')&&!!q('[data-task-id=unowned]');
    const archiveInitiallyHidden=!q('[data-task-id^=arch]');q('[aria-label="展开已归档任务"]').click();await tick();
    const archived=all('.scope-task-archive [data-task-id]').map(e=>e.dataset.taskId);
    const archiveGrouped=all('.scope-task-archive [data-task-group]').length>0&&all('.scope-task-archive [data-task-group]').every(e=>!e.querySelector('[data-task-group]'));
    q('[aria-label="已归档任务下一页"]').click();await tick();const archiveSecond=all('.scope-task-archive [data-task-id]').map(e=>e.dataset.taskId);
    f.remount();await wait(()=>q('[aria-label="切换侧栏视图"]'),'remount');const restored=q('[aria-label="切换侧栏视图"]').textContent.trim();
    const restoredGroup=q('[data-task-group="active:requirement:r"]');
    const restoredFold=restoredGroup?.querySelector('.scope-task-group-toggle').getAttribute('aria-expanded')==='false';
    restoredGroup?.querySelector('.scope-task-group-toggle').click();await tick();
    await choose('requirement');window.updateViewFixture();await wait(()=>q('[role=alert]')?.textContent.includes('需求读取失败'),'requirement error');
    await choose('task');const isolated=!f.host.textContent.includes('需求读取失败')&&all('[data-task-id]').length>0;
    q('[aria-label="切换侧栏视图"]').click();await tick();const escaped=q('[role=menu]');escaped.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();const escapeClosed=!q('[role=menu]');
    q('[aria-label="切换侧栏视图"]').click();await tick();document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await tick();const outsideClosed=!q('[role=menu]');
    window.updateViewFixture();await wait(()=>q('.scope-task-list [role=alert] button'),'task retry');q('.scope-task-list [role=alert] button').click();await wait(()=>all('[role=alert]').some(e=>e.textContent.includes('任务刷新失败样例')),'failed refresh displayed');
    return {selectorPresent:true,initial,requirementNames,created:f.created,locations:f.locations,groups,oneLevel,groupIndents,membership,first,second,selection,running,unread,opened:f.opened,unownedVisible,folded,archiveInitiallyHidden,archiveGrouped,archived,archiveSecond,restored,restoredFold,isolated,escapeClosed,outsideClosed,retryFailureVisible:true,overflow:f.host.scrollWidth>f.host.clientWidth};
  })()`
})

assert.equal(result.selectorPresent, true, 'the sidebar title offers space/requirement/task switching')
assert.deepEqual(result.initial, { spaces: 2, tasks: 0 })
assert.deepEqual(result.requirementNames, ['需求一', '未绑定需求'], 'flat requirements retain unbound requirements and hide archived requirements even when selected')
assert.deepEqual(result.created, [{ projectId: 'b', requirementId: 'r' }])
assert.deepEqual(result.locations, [{ kind: 'requirement', id: 'r' }])
assert.deepEqual(result.groups, [
  { key: 'active:requirement:r', kind: 'requirement', title: '需求一' },
  { key: 'active:space:', kind: 'space', title: '未关联项目' },
  { key: 'active:space:b', kind: 'space', title: '空间 B' },
  { key: 'active:space:a', kind: 'space', title: '空间 A' }
], 'requirements and spaces are peer groups containing only tasks')
assert.equal(result.oneLevel, true)
assert.deepEqual([...new Set(result.groupIndents)], ['6px'], 'requirement and space group headings share the same indentation')
assert.equal(new Map(result.membership).get('t74'), 'active:requirement:r')
assert.equal(new Map(result.membership).get('t73'), 'active:requirement:r', 'one requirement stays together across execution spaces')
assert.equal(new Map(result.membership).get('unowned'), 'active:space:')
assert.equal(result.first.length, 50)
assert.equal(result.second.length, 26)
assert.equal(new Set([...result.first, ...result.second]).size, 76)
assert.ok(![...result.first, ...result.second].some(id => ['tool', 'assistant', 'init'].includes(id)))
assert.equal(result.first[0], 't74', 'requirements appear first and retain the newest task title')
assert.equal(result.unownedVisible, true)
assert.deepEqual(result.selection, { selected: true, title: '最新任务标题', waiting: true })
assert.equal(result.running, true); assert.equal(result.unread, true)
assert.deepEqual(result.opened, ['t74'], 'failed opening unlocks retry for the same original task')
assert.equal(result.archiveInitiallyHidden, true)
assert.equal(result.folded, true, 'folding one group keeps unrelated groups available')
assert.equal(result.archiveGrouped, true, 'archive groups use one level independently of active group folds')
assert.equal(result.archived.length, 50); assert.equal(result.archiveSecond.length, 50)
assert.equal(new Set([...result.archived, ...result.archiveSecond]).size, 100)
assert.equal(result.restored, '任务', 'view choice survives a renderer remount')
assert.equal(result.restoredFold, true, 'group folds survive a renderer remount')
assert.equal(result.isolated, true, 'requirement failures cannot block available tasks')
assert.equal(result.escapeClosed, true); assert.equal(result.outsideClosed, true)
assert.equal(result.retryFailureVisible, true, 'failed refresh remains a local, recoverable error')
assert.equal(result.overflow, false)

const boundaries = await renderEventStream([], 'idle', 'sidebar-task-group-boundaries', {
  setup: `
    import {useState} from 'react';
    import {SidebarTaskList} from './src/renderer/components/SidebarTaskList';
    localStorage.clear();localStorage.setItem('ua.scopeBrowser.tasks.collapsed','{"invalid":true}');
    const projects=[{id:'same',name:'空间同名'},{id:'a',name:'空间 A'},{id:'b',name:'空间 B'}];
    const requirements=[{id:'same',name:'同名需求',projectId:'a',status:'active'},{id:'r2',name:'同名需求',projectId:'b',status:'active'},{id:'old',name:'历史需求',projectId:'b',status:'archived'}];
    const task=(id,updatedAt,projectId,requirementId,extra={})=>({id,title:id,status:'completed',createdAt:1,updatedAt,config:{agentId:'codex',projectId,requirementId,workdir:'/fixture'},...extra});
    const rows=[task('cross-a',8,'a','same'),task('cross-b',7,'b','same'),task('other-r',6,'a','r2'),task('direct',5,'same'),task('missing-req',4,'a','deleted'),task('missing-space',3,'deleted'),task('historical',2,'b','old'),task('cross-a',1,'b','r2'),task('state-archived',10,'a','same',{taskState:{phase:'archived'}}),task('status-archived',11,'a','same',{status:'archived'})];
    const host=document.body.appendChild(document.createElement('aside'));host.className='sidebar';host.style.cssText='width:280px';
    const opened=[];window.groupBoundary={host,opened};
    function Fixture(){const [version,setVersion]=useState(0);window.changeGroupBoundary=setVersion;return <SidebarTaskList sessions={rows} projects={version===2?[]:projects} requirements={version===2?[]:version===1?requirements.map(r=>r.id==='same'?{...r,name:'重命名需求',projectId:'b'}:r):requirements} requirementsEnabled={version!==3} status={{}} pending={{}} unread={{}} onOpenTask={id=>opened.push(id)}/>}
    createRoot(host).render(<Fixture/>);
  `,
  inspect: `(async()=>{
    const host=window.groupBoundary.host,tick=()=>new Promise(r=>setTimeout(r,35)),all=s=>[...host.querySelectorAll(s)],q=s=>host.querySelector(s);
    for(let i=0;i<50&&!q('[data-task-group]');i++)await tick();
    const ids=()=>all('.scope-task-list > [data-task-group] [data-task-id]').map(e=>e.dataset.taskId);
    const initialIds=ids(),membership=all('[data-task-id]').map(e=>[e.dataset.taskId,e.closest('[data-task-group]').dataset.taskGroup]);
    const groupNames=all('.scope-task-list > [data-task-group]').map(e=>[e.dataset.taskGroup,e.querySelector('.scope-task-group-toggle span').textContent]);
    q('[aria-label="展开已归档任务"]').click();await tick();const archivedIds=all('.scope-task-archive [data-task-id]').map(e=>e.dataset.taskId);
    window.changeGroupBoundary(1);await tick();const renamed=q('[data-task-group="active:requirement:same"] .scope-task-group-toggle span').textContent;
    const renamedMembership=q('[data-task-id=cross-a]').closest('[data-task-group]').dataset.taskGroup;
    window.changeGroupBoundary(2);await tick();const missingMetadataIds=ids();
    q('[data-task-id=missing-req] .scope-nav-name').click();await tick();
    window.changeGroupBoundary(3);await tick();const disabledRequirementIds=ids(),disabledRequirementGroups=all('.scope-task-list > [data-group-kind=requirement]').length;
    window.changeGroupBoundary(4);await tick();const restoredMembership=q('[data-task-id=cross-a]').closest('[data-task-group]').dataset.taskGroup;
    return {initialIds,membership,groupNames,archivedIds,renamed,renamedMembership,missingMetadataIds,opened:window.groupBoundary.opened,disabledRequirementIds,disabledRequirementGroups,restoredMembership};
  })()`
})
const activeIds = ['cross-a', 'cross-b', 'other-r', 'direct', 'missing-req', 'missing-space', 'historical'].sort()
assert.deepEqual([...boundaries.initialIds].sort(), activeIds, 'latest duplicate wins and archived state variants stay out of active tasks')
const membership = new Map(boundaries.membership)
assert.equal(membership.get('cross-a'), 'active:requirement:same')
assert.equal(membership.get('cross-b'), 'active:requirement:same')
assert.equal(membership.get('other-r'), 'active:requirement:r2', 'same names cannot merge distinct requirement IDs')
assert.equal(membership.get('direct'), 'active:space:same', 'space and requirement IDs use separate group keys')
assert.equal(membership.get('missing-req'), 'active:requirement:', 'missing requirement metadata preserves requirement grouping')
assert.equal(membership.get('missing-space'), 'active:space:')
assert.equal(membership.get('historical'), 'active:requirement:old', 'an archived requirement cannot hide its active task')
assert.deepEqual([...boundaries.archivedIds].sort(), ['state-archived', 'status-archived'])
assert.equal(new Map(boundaries.groupNames).get('active:requirement:old'), '历史需求')
assert.equal(boundaries.renamed, '重命名需求')
assert.equal(boundaries.renamedMembership, 'active:requirement:same', 'changing a requirement primary space cannot move its task group')
assert.deepEqual([...boundaries.missingMetadataIds].sort(), activeIds, 'metadata loss cannot hide existing tasks')
assert.deepEqual(boundaries.opened, ['missing-req'], 'fallback groups open the original task')
assert.deepEqual([...boundaries.disabledRequirementIds].sort(), activeIds)
assert.equal(boundaries.disabledRequirementGroups, 0, 'disabled requirements use space grouping while retaining all tasks')
assert.equal(boundaries.restoredMembership, 'active:requirement:same')

const indicators = await renderEventStream([], 'idle', 'sidebar-task-icons-and-status', {
  setup: `
    import {useState} from 'react';
    import {SpaceRequirementNavigation} from './src/renderer/components/WorkspaceBrowser';
    localStorage.clear();localStorage.setItem('ua.scopeBrowser.view',JSON.stringify('task'));
    const agents=[{id:'company-agent',adapter:'claude'},{id:'qoder-cn',adapter:'qoder'}];
    const task=(id,agentId,extra={})=>({id,title:id,status:'idle',createdAt:1,config:{agentId,projectId:'p',workdir:'/fixture'},...extra});
    const rows=[
      task('standby','codex',{taskState:{phase:'standby'}}),
      task('decision','company-agent',{status:'completed',taskState:{phase:'decision',awaitingAcceptance:true}}),
      task('main','kimi'),task('side','deepseek'),
      task('pending','traex',{status:'running'}),task('error','grok',{status:'error'}),
      task('running','minimax',{status:'running'}),task('members','qoder-cn',{status:'waiting_members'}),
      task('recovery','zcode',{recovery:{phase:'restarting'}}),
      task('queued','nika',{pendingQueue:[{state:'pending'}]}),
      task('unknown','removed-agent'),task('team','codex',{teamBinding:{}}),
      task('archived','company-agent',{archived:true})
    ];
    const unread={main:'main',side:'side',pending:'main',error:'main',running:'main',archived:'main',unknown:true};
    const host=document.body.appendChild(document.createElement('aside'));host.className='sidebar';host.style.width='300px';
    const opened=[];
    function Fixture(){const [version,setVersion]=useState(0);window.updateIndicatorFixture=setVersion;return <SpaceRequirementNavigation
      data={{projects:[{id:'p',name:'项目'}],projectsLoading:false,projectsError:'',requirements:[],requirementsEnabled:false,requirementsLoading:false,requirementsError:''}}
      agents={version===2?[]:agents} sessions={version===1?rows.map(row=>row.id==='standby'?{...row,config:{...row.config,agentId:'claude'}}:row):rows}
      pending={{pending:true}} unread={version===1?{}:unread} status={{}} activeTaskId="decision"
      onNavigate={()=>{}} onCreate={()=>{}} onOpenTask={id=>opened.push(id)}/>}
    createRoot(host).render(<Fixture/>);window.indicatorFixture={host,opened};
  `,
  inspect: `(async()=>{
    const f=window.indicatorFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,30));
    for(let i=0;i<70&&!q('[data-task-id=standby]');i++)await tick();
    const row=id=>q('[data-task-id='+id+']');
    const icon=id=>{const el=row(id).querySelector('.scope-nav-name .agent-icon,.scope-nav-name .ui-icon');const bounds=el.getBoundingClientRect();return {classes:el.getAttribute('class'),width:bounds.width,height:bounds.height,color:getComputedStyle(el).color,slotWidth:el.parentElement.getBoundingClientRect().width};};
    const status=id=>{const el=row(id).querySelector('.scope-task-status').firstElementChild;if(!el)return null;const style=getComputedStyle(el);return {classes:el.getAttribute('class'),width:parseFloat(style.width),height:parseFloat(style.height),color:style.backgroundColor,shadow:style.boxShadow};};
    const geometry=id=>{const el=row(id),title=el.querySelector('.scope-nav-name>span:last-child'),marker=el.querySelector('.scope-task-status');return [el.offsetWidth,title.offsetLeft-el.offsetLeft,marker.offsetWidth];};
    const ids=['standby','decision','main','side','pending','error','running','members','recovery','queued','unknown','team'];
    const icons=Object.fromEntries(ids.map(id=>[id,icon(id)])),states=Object.fromEntries(ids.map(id=>[id,status(id)]));
    const before=geometry('standby');row('standby').querySelector('.scope-nav-name').click();await tick();
    q('[aria-label="展开已归档任务"]').click();await tick();const archived={icon:icon('archived'),status:status('archived')};
    window.updateIndicatorFixture(1);await tick();const changed={icon:icon('standby'),status:status('main'),side:status('side'),geometry:geometry('standby')};
    window.updateIndicatorFixture(2);await tick();const missing=icon('decision');
    return {icons,states,before,archived,changed,missing,opened:f.opened,extraDots:f.host.querySelectorAll('.scope-task-dot').length};
  })()`
})
assert.equal(indicators.states.standby, null, 'a read standby task has no extra gray phase dot')
assert.equal(indicators.states.decision, null, 'a read completed task has no extra amber phase dot')
assert.equal(indicators.extraDots, 0)
const brands = { standby: 'codex', decision: 'claude', main: 'kimi', side: 'deepseek', pending: 'traex', error: 'grok', running: 'mcode', members: 'qoder', recovery: 'zcode', queued: INTERNAL_DISTRIBUTION ? 'nika' : 'generic', unknown: 'generic' }
for (const [id, brand] of Object.entries(brands)) {
  assert.ok(indicators.icons[id].classes.split(' ').includes('agent-icon-' + brand), `${id} uses its configured Agent brand or the existing fallback`)
  assert.equal(indicators.icons[id].width, 15)
  assert.equal(indicators.icons[id].height, 15)
  assert.equal(indicators.icons[id].slotWidth, 15, 'the icon slot cannot stretch into the task title')
}
assert.ok(indicators.icons.team.classes.includes('ui-icon-users'), 'Team tasks retain the old team icon')
assert.equal(indicators.icons.decision.color, 'rgb(236, 236, 237)', 'selected monochrome icons use the old selected color')
assert.equal(indicators.states.pending.classes, 'si-ask', 'pending answers take priority over running and unread')
assert.equal(indicators.states.error.classes, 'si-error', 'errors take priority over unread')
for (const id of ['running', 'members', 'recovery', 'queued']) assert.equal(indicators.states[id].classes, 'si-spinner')
assert.equal(indicators.states.running.width, 13)
assert.equal(indicators.states.main.classes, 'si-unread ')
assert.equal(indicators.states.side.classes, 'si-unread side')
assert.equal(indicators.states.main.width, 8)
assert.equal(indicators.states.main.color, 'rgb(91, 157, 255)')
assert.equal(indicators.states.side.color, 'rgb(57, 197, 207)')
assert.notEqual(indicators.states.main.shadow, 'none')
assert.equal(indicators.states.unknown, null, 'invalid unread values cannot manufacture a status mark')
assert.ok(indicators.archived.icon.classes.includes('agent-icon-claude'))
assert.equal(indicators.archived.status, null)
assert.ok(indicators.changed.icon.classes.includes('agent-icon-claude'), 'a changed Session Agent updates its row icon')
assert.equal(indicators.changed.status, null)
assert.equal(indicators.changed.side, null, 'reading replies clears both unread colors')
assert.deepEqual(indicators.changed.geometry, indicators.before, 'changing Agent and unread state preserves row geometry')
assert.ok(indicators.missing.classes.includes('agent-icon-generic'), 'missing custom Agent definitions fall back safely')
assert.deepEqual(indicators.opened, ['standby'], 'icon changes preserve opening the original task')
console.log('PASS sidebar views: peer task groups, ownership, pagination, archive, retry, attention, fold persistence, Agent icons and old Session status indicators')
