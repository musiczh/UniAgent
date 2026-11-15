import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Exercise the real board and projection; only Electron IPC is replaced.
const result = await renderEventStream([], 'idle', 'task-board-actions', {
  setup: `
    import {TaskBoard} from './src/renderer/components/TaskBoard';
    import {projectTaskBoard} from './src/shared/taskBoard';
    const sessions=[
      {id:'running',title:'执行中的任务',status:'running',createdAt:1,config:{agentId:'codex',projectId:'p'}},
      {id:'done',title:'刚完成未查看',status:'completed',createdAt:2,config:{agentId:'codex',projectId:'p',requirementId:'r'},taskMetadata:{description:'修正任务创建前的 Git 检测行为：非 Git 目录应禁用工作树功能并允许创建任务，避免误导用户。'.repeat(4)}},
      {id:'wait',title:'等待授权',status:'awaiting-approval',createdAt:3,config:{agentId:'codex',projectId:'p'}},
      {id:'race',title:'读取时状态变化',status:'completed',createdAt:4,config:{agentId:'codex',projectId:'p'}},
      {id:'readonly',title:'只读任务',status:'completed',readOnly:true,createdAt:5,config:{agentId:'codex',projectId:'p'}}
    ];
    let listener=()=>{}, fail=true, failOpen=true, release;const calls=[],opened=[];
    const state=id=>({record:{formatVersion:1,taskId:id,version:7,phase:sessions.find(s=>s.id===id).taskState?.phase||'active',inputRevision:'input',reports:[],history:[],operations:[]},inputRevision:'input',turnRevision:'turn',busy:id==='race',pendingDecisions:0});
    window.uniagent=new Proxy({
      getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query),getEvents:async()=>[],getTaskDecisions:async()=>[],
      getTaskState:async id=>state(id),
      decideTask:async(id,input)=>{calls.push({id,input});await new Promise(r=>release=r);if(fail)throw Error('写入失败');sessions.find(s=>s.id===id).taskState={phase:input.disposition==='archive'?'archived':'standby',version:8,updatedAt:1};listener();return state(id)},
      interrupt:async id=>{calls.push({interrupt:id});sessions.find(s=>s.id===id).status='interrupted';listener()},
      onTaskBoardChanged:cb=>{listener=cb;return()=>{listener=()=>{}}}
    },{get:(t,k)=>k in t?t[k]:()=>()=>{}});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;width:1024px;height:640px;display:flex;background:var(--bg)';
    function Fixture(){const [unread,setUnread]=React.useState({done:'main'});return React.createElement(TaskBoard,{projects:[{id:'p',name:'同名归属'}],requirements:[{id:'r',name:'同名归属',projectId:'p'}],unreadBySession:unread,onOpenTask:async id=>{if(failOpen)throw Error('打开失败');opened.push(id);setUnread({})},onCreate:()=>{}})}
    createRoot(host).render(React.createElement(Fixture));
    window.actionFixture={host,calls,opened,allow:()=>fail=false,allowOpen:()=>failOpen=false,release:()=>release(),measure:()=>{
      const card=host.querySelector('[data-task-id=done]'),group=card.querySelector('.task-board-card-actions'),button=group.querySelector('button'),rect=button.getBoundingClientRect(),description=card.querySelector('.task-board-card-description');
      return {height:card.offsetHeight,descriptionWidth:description.offsetWidth,descriptionHeight:description.offsetHeight,opacity:getComputedStyle(group).opacity,pointerEvents:getComputedStyle(group).pointerEvents,background:getComputedStyle(group).backgroundColor,cardBackground:getComputedStyle(card).backgroundColor,hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('[data-action]')?.dataset.action};
    }};
  `,
  mouseEvents: [
    `(async()=>{const f=window.actionFixture;for(let i=0;i<120&&!f.host.querySelector('[data-task-id=done]');i++)await new Promise(r=>setTimeout(r,25));const card=f.host.querySelector('[data-task-id=done]');card.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(r));f.normal=f.measure();const rect=card.getBoundingClientRect();f.target={x:rect.x+15,y:rect.y+10,element:document.elementFromPoint(rect.x+15,rect.y+10)?.className};return {type:'mouseMoved',x:f.target.x,y:f.target.y}})()`,
    `(()=>{const f=window.actionFixture;f.hovered=f.measure();return {type:'mouseMoved',x:1,y:1}})()`
  ],
  inspect: `(async()=>{
    const f=window.actionFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,25)),wait=async(p,label)=>{for(let i=0;i<120;i++){if(p())return;await tick()}throw Error(label)};
    await wait(()=>q('[data-task-id=done]'),'board data');
    const groupHeadings=()=>[...f.host.querySelectorAll('.task-board-group-head')].map(e=>({kind:e.dataset.scopeKind,text:e.textContent}));
    const initial={dot:!!q('[data-task-id=done] .task-board-unread'),yellowText:!!q('[data-column=decision] .task-board-status'),groups:[...f.host.querySelectorAll('[data-column=decision] .task-board-group-head')].map(e=>e.dataset.scopeKind),headings:groupHeadings(),columnCounts:[...f.host.querySelectorAll('.task-board-column>header>span,.archive-rail>span')].map(e=>e.textContent),blocked:q('[data-task-id=wait] [data-action=archive]')?.disabled,readonly:[...q('[data-task-id=readonly]').querySelectorAll('[data-action]')].map(button=>button.dataset.action),standbyIcon:!!q('[data-task-id=done] [data-action=standby] svg circle')};
    if (!q('.task-board-card-open')) return {initial};
    const scroll=q('[data-column=decision] .task-board-column-scroll');const scrollbar=getComputedStyle(scroll,'::-webkit-scrollbar').display;
    const restored=f.measure();q('[data-task-id=done] .task-board-card-open').focus();await tick();const focused=f.measure(),visible=focused.opacity;
    const layouts=[];
    for(const width of [640,1024,1360]){f.host.style.width=width+'px';await tick();for(const id of ['done','running']){const card=q('[data-task-id='+id+']'),open=card.querySelector('.task-board-card-open'),style=getComputedStyle(open),heading=card.querySelector('.task-board-card-heading'),description=card.querySelector('.task-board-card-description'),controls=card.querySelector('.task-board-card-actions').getBoundingClientRect();layouts.push({width,id,titlePadding:getComputedStyle(heading).paddingRight,descriptionPadding:description&&getComputedStyle(description).paddingRight,descriptionFills:!description||Math.abs(description.getBoundingClientRect().width-(open.getBoundingClientRect().width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)))<1,contained:controls.left>=card.getBoundingClientRect().left&&controls.right<=card.getBoundingClientRect().right});}}
    f.host.style.width='1024px';await tick();
    q('[data-task-id=done] .task-board-card-open').click();await wait(()=>q('[role=alert]'),'failed open');const retainedDot=!!q('[data-task-id=done] .task-board-unread');
    f.allowOpen();q('[data-task-id=done] .task-board-card-open').click();await wait(()=>!q('[data-task-id=done] .task-board-unread'),'mark viewed');
    q('[data-task-id=done] [data-action=standby]').click();await wait(()=>f.calls.length===1,'first write');
    const locked=q('[data-task-id=done] [data-action=archive]').disabled;
    f.release();await wait(()=>q('[role=alert]')?.textContent.includes('写入失败'),'failure retained');const retained=!!q('[data-column=decision] [data-task-id=done]');
    f.allow();q('[data-task-id=done] [data-action=standby]').click();await wait(()=>f.calls.length===2,'retry');f.release();await wait(()=>q('[data-column=standby] [data-task-id=done]'),'deferred');
    q('[data-task-id=race] [data-action=archive]').click();await wait(()=>q('[role=alert]')?.textContent.includes('任务仍在执行'),'race guarded');
    const guarded=f.calls.length===2;
    q('[data-task-id=running] [data-action=pause]').click();await wait(()=>q('[data-column=decision] [data-task-id=running]'),'interrupted');
    q('[data-task-id=done] [data-action=archive]').click();await wait(()=>f.calls.length===4,'archive');f.release();await wait(()=>!q('[data-column=standby] [data-task-id=done]'),'archived and hidden');
    q('[aria-label=展开已归档列]').click();await wait(()=>q('[data-column=archived] [data-task-id=done]'),'archive content opens directly');
    return {initial,target:f.target,normal:f.normal,hovered:f.hovered,restored,focused,headingsAfterArchive:groupHeadings(),scrollbar,visible,layouts,retainedDot,locked,retained,guarded,opened:f.opened,calls:f.calls,overflow:f.host.scrollWidth>f.host.clientWidth};
  })()`
})
assert.equal(result.initial.dot, true); assert.equal(result.initial.yellowText, false)
assert.deepEqual(result.initial.groups.sort(), ['requirement','space'])
assert.equal(result.initial.headings.length, 3)
assert.ok(result.initial.headings.every((heading: any) => heading.text === '同名归属'), 'requirement and space group headings show only their names')
assert.deepEqual(result.initial.columnCounts, ['1', '4', '0', '0'], 'column totals and the collapsed archive total remain visible')
assert.ok(result.headingsAfterArchive.some((heading: any) => heading.kind === 'requirement'))
assert.ok(result.headingsAfterArchive.every((heading: any) => heading.text === '同名归属'), 'group counts stay absent after task transitions and archive expansion')
assert.equal(result.initial.blocked, true); assert.deepEqual(result.initial.readonly, ['delete'], 'read-only records retain deletion while task lifecycle actions stay unavailable')
assert.equal(result.initial.standbyIcon, true)
assert.equal(result.scrollbar, 'none'); assert.equal(result.visible, '1')
assert.ok(result.layouts.every((layout: any) => layout.titlePadding === '0px' && (!layout.descriptionPadding || layout.descriptionPadding === '0px') && layout.descriptionFills && layout.contained), 'titles and descriptions use the full content width while overlay actions stay within the card: ' + JSON.stringify(result.layouts))
assert.equal(result.normal.opacity, '0'); assert.equal(result.normal.pointerEvents, 'none')
assert.equal(result.hovered.opacity, '1', 'hover target: ' + JSON.stringify(result.target)); assert.equal(result.hovered.pointerEvents, 'auto')
assert.equal(result.restored.opacity, '0'); assert.equal(result.restored.pointerEvents, 'none')
assert.notEqual(result.hovered.background, 'rgba(0, 0, 0, 0)', 'the action group masks the underlying text')
assert.notEqual(result.hovered.background, result.hovered.cardBackground, 'the action background is distinguishable from the hovered card')
assert.equal(result.hovered.hit, 'standby', 'the overlay receives the pointer above the card text')
assert.equal(result.focused.hit, 'standby', 'keyboard focus also exposes the overlay')
for (const state of [result.hovered, result.restored, result.focused]) {
  assert.equal(state.height, result.normal.height, 'showing actions does not resize the card')
  assert.equal(state.descriptionWidth, result.normal.descriptionWidth, 'showing actions does not reflow text')
  assert.equal(state.descriptionHeight, result.normal.descriptionHeight)
}
assert.equal(result.retainedDot, true); assert.equal(result.locked, true); assert.equal(result.retained, true); assert.equal(result.guarded, true)
assert.deepEqual(result.opened, ['done']); assert.equal(result.overflow, false)
assert.equal(result.calls[0].input.actionId, result.calls[1].input.actionId)
assert.deepEqual(result.calls[2], { interrupt: 'running' })
assert.equal(result.calls[3].input.disposition, 'archive'); assert.equal(result.calls[3].input.expectedVersion, 7)
console.log('PASS real board: unread cleared only after successful open, separate scopes, hover/focus controls, pending lock, failed retry identity, state race rejection, interrupt/defer/archive transitions and hidden scrollbars')
