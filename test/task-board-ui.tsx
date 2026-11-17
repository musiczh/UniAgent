import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-board-ui', {
  setup: `
    import {TaskBoard,TaskBoardWorkspace} from './src/renderer/components/TaskBoard';import {projectTaskBoard} from './src/shared/taskBoard';import {projectTaskDecisions} from './src/shared/taskDecisions';import {browserTaskAttentionBySession} from './src/renderer/scopeBrowser';
    const agents=[{id:'company-agent',adapter:'claude',name:'自定义 Agent'}];
    const sessions=Array.from({length:75},(_,i)=>({id:'s'+i,title:'任务 '+i+' · 较长内容'.repeat(8),status:'idle',createdAt:i+1,config:{agentId:i===74?'company-agent':'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}}));
    sessions.push({id:'wait',title:'需要用户决策',status:'awaiting-approval',createdAt:100,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}},{id:'old',title:'已归档样例',status:'idle',archived:true,createdAt:1,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}});
    sessions.push(...Array.from({length:35},(_,i)=>({id:'archive'+i,title:'归档任务 '+i,status:'idle',archived:true,createdAt:i+2,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}})));
    let offline=false,listener=()=>{},unreadBySession={};const calls=[],opened=[],openedRequirements=[];
    const decisions=id=>{const session=sessions.find(row=>row.id===id);return session.status==='error'?projectTaskDecisions(session,[{sessionId:id,seq:1,ts:1,type:'error',state:'failed',payload:{message:'需求文档写入等待超时，请稍后重试'}}]):[]};
    window.uniagent=new Proxy({getTaskBoard:async query=>{calls.push(query);if(offline)throw Error('offline');return projectTaskBoard(sessions,decisions,query,()=>true)},getEvents:async()=>[],getTaskDecisions:async()=>[],onTaskBoardChanged:cb=>{listener=cb;return()=>{listener=()=>{}}}}, {get:(t,k)=>k in t?t[k]:()=>()=>{}});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;width:1024px;height:640px;background:var(--bg);display:flex';
    let root;const mount=(scoped=false,extra={})=>{root=createRoot(host);root.render(React.createElement(scoped?TaskBoardWorkspace:TaskBoard,{agents,projects:[{id:'p',name:'产品空间'}],requirements:[{id:'r',name:'样例需求'}],attentionBySession:browserTaskAttentionBySession(sessions,{},{}),unreadBySession,...(scoped?{requirementId:'r'}:{}),...extra,onOpenTask:id=>opened.push(id),onOpenRequirement:id=>openedRequirements.push(id),onCreate:()=>opened.push('new')}))};localStorage.clear();localStorage.setItem('ua.taskBoard.all.archiveList','false');localStorage.setItem('ua.taskBoard.r.archiveList','false');mount();
    window.boardFixture={host,calls,opened,openedRequirements,mount,unmount:()=>root.unmount(),offline:()=>{offline=true;listener()},refresh:()=>{offline=false;listener()},replace:(rows,unread)=>{sessions.splice(0,sessions.length,...rows);unreadBySession=unread}};
  `,
  inspect: `(async()=>{
    const f=window.boardFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,30)),wait=async(p)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('board UI timeout: '+p.toString())};
    await wait(()=>q('[data-column=active] .task-board-card'));
    const first={columns:f.host.querySelectorAll('.task-board-column').length,cards:f.host.querySelectorAll('[data-column=active] .task-board-card').length,archived:!!q('[data-column=archived] [data-task-id=old]'),actions:f.host.querySelectorAll('.task-board-card .appr-accept,.task-board-card .question-form').length};
    const heading=()=>q('[data-task-id=s74] .task-board-card-heading');
    const globalAgent=!!heading()?.querySelector('.task-board-agent .agent-icon-claude');
    const positions=()=>{const row=heading(),brand=row.querySelector('.task-board-agent'),title=row.querySelector('strong'),state=row.querySelector('.task-board-card-status');return {left:!!brand&&brand.offsetLeft+brand.offsetWidth<=title.offsetLeft,right:!!state&&title.offsetLeft+title.offsetWidth<=state.offsetLeft,brandWidth:brand?.offsetWidth,titleClamp:getComputedStyle(title).webkitLineClamp,descriptionWidth:row.parentElement.querySelector('.task-board-card-description')?.offsetWidth};};
    const globalPosition=globalAgent?positions():null;
    if (!q('.task-board-card-open')) return {first};
    q('[data-task-id=wait] .task-board-card-open').focus();const keyboard=q('[data-task-id=wait] .task-board-card-open')===document.activeElement;q('[data-task-id=wait] .task-board-card-open').click();
    const collapsed=q('[aria-label=展开已归档列]')?.getAttribute('aria-expanded');
    q('[aria-label=展开已归档列]').click();await wait(()=>q('[aria-label=横向收起归档列]'));
    if(q('[data-column=archived] h2 button'))throw Error('archive title must not collapse the list');
    await wait(()=>q('[data-column=archived] .task-board-card'));
    const archive={cards:f.host.querySelectorAll('[data-column=archived] .task-board-card').length,requested:f.calls.at(-1).includeArchived,title:q('[data-column=archived] h2').textContent};
    const archiveScroll=q('[data-column=archived] .task-board-column-scroll');archiveScroll.scrollTop=150;archiveScroll.dispatchEvent(new Event('scroll'));
    q('[aria-label=横向收起归档列]').click();await wait(()=>q('[aria-label=展开已归档列]')&&f.calls.at(-1).includeArchived===false);
    q('[aria-label=展开已归档列]').click();await wait(()=>q('[data-column=archived] .task-board-card'));
    const archiveScrollRestored=q('[data-column=archived] .task-board-column-scroll').scrollTop;
    q('[aria-label=已归档下一页]').click();await wait(()=>q('[data-task-id=old]'));
    const archivePage={label:q('[data-column=archived] .task-board-pagination span').textContent,cards:f.host.querySelectorAll('[data-column=archived] .task-board-card').length};
    q('[aria-label=进行中下一页]').click();await wait(()=>q('[data-column=active] .task-board-pagination span').textContent==='2 / 3');
    const scroll=q('[data-column=active] .task-board-column-scroll');scroll.scrollTop=200;scroll.dispatchEvent(new Event('scroll'));
    f.unmount();f.mount();await wait(()=>q('[data-column=active] .task-board-pagination span')?.textContent==='2 / 3');
    const restored=q('[data-column=active] .task-board-column-scroll').scrollTop;
    f.offline();await wait(()=>q('[role=alert]'));const offline={kept:!!q('[data-column=active] .task-board-card'),time:q('[role=alert]').textContent.includes('最近更新')};
    f.refresh();await wait(()=>!q('[role=alert]'));await wait(()=>q('[data-task-id=old]'));const overflow=f.host.scrollWidth>f.host.clientWidth;
    const archiveRestored=!!q('[data-task-id=old]');
    const global={groups:f.host.querySelectorAll('.task-board-group-head').length,labels:f.host.querySelectorAll('.task-board-status,.task-board-scope,.task-board-card-meta').length,icons:f.host.querySelectorAll('.task-board-card-status svg').length};
    f.unmount();f.mount(true);await wait(()=>q('[data-column=active] .task-board-card'));
    const scopedAgent=!!heading()?.querySelector('.task-board-agent .agent-icon-claude'),scopedPosition=scopedAgent?positions():null;
    const scoped={groups:f.host.querySelectorAll('.task-board-group-head,.task-board-group').length,labels:f.host.querySelectorAll('.task-board-status,.task-board-scope,.task-board-card-meta').length,cards:f.host.querySelectorAll('[data-column=active] .task-board-card').length,query:f.calls.at(-1).requirementId,icons:f.host.querySelectorAll('.task-board-card-status svg').length};
    const scopedArchiveInitiallyCollapsed=!!q('[aria-label=展开已归档列]');q('[aria-label=展开已归档列]').click();await wait(()=>q('[data-column=archived] .task-board-card'));
    const scopedArchive={initiallyCollapsed:scopedArchiveInitiallyCollapsed,titleButton:!!q('[data-column=archived] h2 button'),cards:f.host.querySelectorAll('[data-column=archived] .task-board-card').length,query:f.calls.at(-1).requirementId};
    q('[aria-label=进行中下一页]').click();await wait(()=>q('[data-column=active] .task-board-pagination span').textContent==='2 / 3');
    const scopedPage=f.host.querySelectorAll('[data-column=active] .task-board-card').length;
    const rows=['idle','completed','error','interrupted','cancelled','running','queued','cancelling','awaiting-approval','standby','archived'].flatMap(status=>['main','side'].map(source=>({id:status+'-'+source,title:status+' '+source,status:status==='standby'?'completed':status,archived:status==='archived',...(status==='standby'?{taskState:{phase:'standby'}}:{}),createdAt:1,config:{agentId:source==='side'?'company-agent':'codex',workdir:'/fixture',requirementId:'r'}})));
    rows.push({id:'unknown-agent',title:'未知 Agent',status:'idle',createdAt:1,config:{agentId:'removed-agent',workdir:'/fixture',requirementId:'r'}});
    rows.push({id:'team',title:'团队任务',status:'idle',createdAt:1,teamBinding:{},config:{agentId:'codex',workdir:'/fixture',requirementId:'r'}});
    rows.push({id:'standby-error',title:'已暂定的异常任务',status:'error',taskState:{phase:'standby'},createdAt:2,config:{agentId:'codex',workdir:'/fixture',requirementId:'r'}});
    const unread=Object.fromEntries(rows.map(row=>[row.id,row.id.endsWith('side')?'side':'main']));
    unread['unknown-agent']=true;unread.team='legacy';
    f.unmount();localStorage.setItem('ua.taskBoard.r.pages','{}');f.replace(rows,unread);f.mount(true);
    await wait(()=>q('[data-task-id=running-side]'));
    const dots=Object.fromEntries(rows.map(row=>{const el=q('[data-task-id='+row.id+'] .task-board-unread');return [row.id,el?{label:el.getAttribute('aria-label'),title:el.title,color:getComputedStyle(el).backgroundColor}:null]}));
    const sideWithSpinner=!!q('[data-task-id=running-side] .si-spinner')&&!!q('[data-task-id=running-side] .task-board-unread');
    const runningCard=q('[data-task-id=running-side]'),runningPosition={agent:!!runningCard.querySelector('.task-board-agent .agent-icon-claude'),spinner:!!runningCard.querySelector('.task-board-card-status .si-spinner'),unread:!!runningCard.querySelector('.task-board-card-status .task-board-unread')};
    const fallback=!!q('[data-task-id=unknown-agent] .task-board-agent .agent-icon-generic');
    const team=!!q('[data-task-id=team] .task-board-agent .ui-icon-users');
    const staticIcons=f.host.querySelectorAll('.task-board-card-status svg').length;
    const attention=Object.fromEntries(rows.map(row=>{const el=q('[data-task-id='+row.id+'] .task-board-attention');return [row.id,el?{label:el.getAttribute('aria-label'),title:el.title,color:getComputedStyle(el).color}:null]}));
    f.unmount();f.replace(rows,{});f.mount(true);await wait(()=>q('[data-task-id=running-side]'));const readDots=f.host.querySelectorAll('.task-board-unread').length;
    const pagedRows=Array.from({length:35},(_,i)=>({id:'paged'+i,title:'待推进异常任务 '+i,status:'error',taskState:{phase:'standby'},createdAt:i+1,config:{agentId:'codex',workdir:'/fixture',requirementId:'r'}}));
    f.unmount();localStorage.setItem('ua.taskBoard.r.pages','{}');localStorage.setItem('ua.taskBoard.r.archiveWidth','false');f.replace(pagedRows,{});f.mount(true);await wait(()=>q('[data-column=standby] .task-board-card'));
    q('[aria-label=待推进下一页]').click();await wait(()=>q('[data-task-id=paged0]'));
    const pagedMarker=!!q('[data-task-id=paged0] .task-board-attention');
    q('[aria-label=展开已归档列]').click();await wait(()=>q('[aria-label=横向收起归档列]'));
    q('[aria-label=横向收起归档列]').click();await wait(()=>q('[aria-label=展开已归档列]'));
    f.unmount();f.mount(true);await wait(()=>q('[data-task-id=paged0]'));const restoredMarker=!!q('[data-task-id=paged0] .task-board-attention');
    f.unmount();localStorage.setItem('ua.taskBoard.all.pages','{}');localStorage.setItem('ua.taskBoard.all.archiveWidth','false');
    f.replace([{id:'label-active',title:'需求进行中',status:'idle',createdAt:3,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}},{id:'label-decision',title:'需求待决策',status:'awaiting-approval',createdAt:2,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}},{id:'label-space',title:'空间任务',status:'idle',createdAt:1,config:{agentId:'codex',workdir:'/fixture',projectId:'p'}}],{});
    f.mount();await wait(()=>q('[data-task-id=label-active]'));
    const reqHeads=[...f.host.querySelectorAll('.task-board-group-head.requirement')];
    const label={heads:reqHeads.length,allButtons:reqHeads.every(el=>el.tagName==='BUTTON'),spaceDiv:q('.task-board-group-head.space')?.tagName==='DIV',aria:reqHeads[0]?.getAttribute('aria-label'),title:reqHeads[0]?.getAttribute('title')};
    const openedBefore=f.opened.length;reqHeads.forEach(el=>el.click());
    const labelClick={openedRequirements:[...f.openedRequirements],openedDelta:f.opened.length-openedBefore};
    q('[data-task-id=label-active] .task-board-card-open').click();const labelCardOpen=f.opened.includes('label-active');
    f.unmount();f.mount(false,{requirements:[]});await wait(()=>q('[data-task-id=label-active]'));
    const missing={tag:q('.task-board-group-head.requirement')?.tagName,name:q('.task-board-group-head.requirement span')?.textContent};
    f.unmount();return {first,globalAgent,globalPosition,scopedAgent,scopedPosition,runningPosition,fallback,team,staticIcons,attention,pagedMarker,restoredMarker,keyboard,opened:f.opened,restored,offline,overflow,collapsed,archive,archiveScrollRestored,archivePage,archiveRestored,global,scoped,scopedArchive,scopedPage,dots,sideWithSpinner,readDots,label,labelClick,labelCardOpen,missing};
  })()`
})
assert.deepEqual(result.first, { columns: 4, cards: 30, archived: false, actions: 0 })
assert.equal(result.globalAgent, true, 'global cards show their actual Agent brand using the configured adapter')
assert.equal(result.scopedAgent, true, 'requirement cards share the same Agent mapping')
for (const position of [result.globalPosition, result.scopedPosition]) {
  assert.equal(position.left, true, 'Agent icon precedes the title')
  assert.equal(position.right, true, 'status area stays to the right of the title')
  assert.equal(position.brandWidth, 15)
  assert.equal(position.titleClamp, '2', 'long titles keep the existing two-line limit')
}
assert.deepEqual(result.runningPosition, {agent:true,spinner:true,unread:true}, 'Agent identity and concurrent running/unread status stay separate')
assert.equal(result.fallback, true, 'unknown Agent IDs keep the existing neutral icon')
assert.equal(result.team, true, 'team cards use the team identity icon')
assert.equal(result.collapsed, 'false'); assert.deepEqual(result.archive, { cards: 30, requested: true, title: '已归档' }); assert.equal(result.archiveRestored, true)
assert.ok(result.archiveScrollRestored >= 140, 'horizontal expansion restores archive scroll without a second toggle')
assert.deepEqual(result.archivePage, { label: '2 / 2', cards: 6 }, 'archive pagination remains available')
assert.deepEqual(result.scopedArchive, { initiallyCollapsed: true, titleButton: false, cards: 30, query: 'r' }, 'requirement archive opens directly despite a saved list-collapse preference')
assert.equal(result.keyboard, true); assert.deepEqual(result.opened, ['wait','label-active']); assert.ok(result.restored >= 190)
assert.deepEqual(result.offline, { kept: true, time: true }); assert.equal(result.overflow, false)
assert.ok(result.global.groups > 0, 'global board retains ownership groups')
assert.equal(result.global.labels, 0, 'global cards show no repeated status or ownership labels'); assert.equal(result.global.icons, 1, 'only the actual approval task has a handling marker')
assert.deepEqual(result.scoped, { groups: 0, labels: 0, cards: 30, query: 'r', icons: 1 }, 'requirement cards share the same handling marker')
assert.equal(result.scopedPage, 30, 'requirement pagination remains available without grouping')
assert.deepEqual(result.label, {heads:2,allButtons:true,spaceDiv:true,aria:'打开需求 样例需求',title:'打开需求 样例需求'}, 'requirement labels are clickable in every column while space labels stay static')
assert.deepEqual(result.labelClick, {openedRequirements:['r','r'],openedDelta:0}, 'label clicks open the requirement consistently across columns without opening cards')
assert.equal(result.labelCardOpen, true, 'card open behavior stays unchanged')
assert.deepEqual(result.missing, {tag:'DIV',name:'原需求'}, 'unresolvable requirements keep the non-clickable fallback label')
assert.equal(result.staticIcons,9,'only actual errors, interruptions, cancellations and approvals add handling markers')
for (const status of ['error','interrupted','cancelled','awaiting-approval']) for (const source of ['main','side']) assert.ok(result.attention[status+'-'+source], status+' remains identifiable alongside unread replies')
for (const status of ['idle','completed','running','queued','cancelling','standby','archived']) for (const source of ['main','side']) assert.equal(result.attention[status+'-'+source],null,status+' does not fabricate a handling marker')
assert.match(result.attention['standby-error'].title,/需求文档写入等待超时/,'the deferred failed task retains the actual error detail')
assert.equal(result.attention['standby-error'].color,'rgb(210, 153, 34)','handling marker uses the sidebar amber color')
assert.equal(result.pagedMarker,true);assert.equal(result.restoredMarker,true,'pagination, archive collapse and remount preserve the marker')
for (const status of ['idle','completed','error','interrupted','cancelled','running','queued','cancelling','awaiting-approval','standby']) {
  assert.deepEqual(result.dots[status+'-side'], {label:'侧边对话有新回复',title:'侧边对话有新回复',color:'rgb(91, 157, 255)'}, status+' side unread uses the same blue dot')
  assert.deepEqual(result.dots[status+'-main'], {label:'有新回复',title:'有新回复',color:'rgb(91, 157, 255)'}, status+' main unread remains identifiable')
}
assert.equal(result.dots['archived-main'],null);assert.equal(result.dots['archived-side'],null,'archived cards do not restore unread dots')
assert.equal(result.dots['unknown-agent'],null);assert.equal(result.dots.team,null,'unrecognized unread values do not fabricate reply dots')
assert.equal(result.sideWithSpinner,true,'execution and unread side replies remain separately visible on the same card')
assert.equal(result.readDots,0,'cleared unread state removes every card dot')
console.log('PASS real renderer: archive opens directly with no list toggle, legacy collapse preference ignored, horizontal collapse retained, archive pagination/scroll restoration, independent scopes, keyboard focus, offline snapshot, clickable requirement labels and 1024px layout')
