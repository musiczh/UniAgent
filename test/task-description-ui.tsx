import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-description-ui', {
  setup: `
    import {TaskBoard,TaskBoardWorkspace} from './src/renderer/components/TaskBoard';
    import {SessionHeader} from './src/renderer/components/SessionHeader';
    import {TaskFocusQueue} from './src/renderer/components/TaskFocusQueue';
    import {projectTaskBoard} from './src/shared/taskBoard';
    const description='统一飞书与本机回答后的问题解决及未读状态，保留其他真实未读，并覆盖重启恢复。'.repeat(4);
    const metadata={formatVersion:1,version:1,configVersion:0,title:'统一跨渠道未读状态',description,source:'generated',generationState:'ready',contextGeneration:1,clarificationCount:0,attempts:1};
    const sessions=['active','decision','standby','archived','empty'].map((id,index)=>({id,title:'初始任务 '+id,status:id==='active'||id==='empty'?'running':id==='decision'?'completed':'idle',createdAt:index+1,updatedAt:1,archived:id==='archived',taskState:{phase:id==='standby'?'standby':id==='archived'?'archived':'active',version:1},config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'},taskMetadata:id==='empty'?undefined:{...metadata,taskId:id}}));
    const events=id=>[{sessionId:id,seq:1,ts:1,type:'user_message',payload:{text:'最初输入：处理飞书回答后的提醒。'}},{sessionId:id,seq:2,ts:2,type:'user_message',payload:{text:'最新输入：补充恢复场景。'}}];
    const listeners=[],opened=[],noop=()=>{};
    window.uniagent=new Proxy({getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query),getEvents:async id=>events(id),getTaskDecisions:async()=>[],getTaskState:async()=>null,onTaskBoardChanged:cb=>{listeners.push(cb);return noop}}, {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;width:1024px;height:720px;background:var(--bg);display:flex;padding:20px;box-sizing:border-box';
    const root=createRoot(host);localStorage.clear();
    const mount=kind=>root.render(kind==='detail'?React.createElement(SessionHeader,{session:sessions[0],agents:[],projects:[{id:'p',name:'UniAgent'}],requirements:[{id:'r',name:'需求',projectId:'p'}]}):kind==='focus'?React.createElement(TaskFocusQueue,{entries:[{id:'active',title:sessions[0].taskMetadata.title,description:sessions[0].taskMetadata.description,readOnly:false,updatedAt:1}],onRefresh:noop,onOpenTask:noop}):React.createElement(kind==='scoped'?TaskBoardWorkspace:TaskBoard,{projects:[{id:'p',name:'UniAgent'}],requirements:[{id:'r',name:'需求',projectId:'p'}],...(kind==='scoped'?{requirementId:'r'}:{}),onOpenTask:id=>opened.push(id),onCreate:noop}));
    mount('board');window.descriptionFixture={host,mount,opened,description,sessions,refresh:()=>listeners.forEach(cb=>cb())};
  `,
  inspect: `(async()=>{
    const f=window.descriptionFixture,q=selector=>f.host.querySelector(selector),tick=()=>new Promise(resolve=>setTimeout(resolve,20)),wait=async(predicate,label)=>{for(let i=0;i<150;i++){if(predicate())return;await tick()}throw Error(label+': '+f.host.textContent)};
    await wait(()=>q('[data-task-id=active] .task-board-card-description'),'board description');
    q('[aria-label=展开已归档列]').click();await wait(()=>q('[data-task-id=archived] .task-board-card-description'),'archived description');
    const cards=['active','decision','standby','archived'].map(id=>{const node=q('[data-task-id='+id+'] .task-board-card-description'),style=getComputedStyle(node);return {id,text:node.textContent,tooltip:node.title,clamp:style.webkitLineClamp,withinTwoLines:node.getBoundingClientRect().height<=parseFloat(style.lineHeight)*2+1,horizontalOverflow:node.scrollWidth>node.clientWidth+1}});
    const empty=!!q('[data-task-id=empty] .task-board-card-description');
    q('[data-task-id=active] .task-board-card-open').click();await tick();
    f.sessions[0].taskMetadata.description='新描述：统一跨渠道未读并覆盖恢复';f.refresh();await wait(()=>q('[data-task-id=active] .task-board-card-description').textContent.includes('新描述'),'refresh description');
    const updated=q('[data-task-id=active] .task-board-card-description').textContent;
    f.mount('scoped');await wait(()=>q('[data-task-id=active] .task-board-card-description'),'scoped board');
    const scoped=q('[data-task-id=active] .task-board-card-description').textContent;
    f.mount('detail');await wait(()=>q('.session-info-trigger'),'unified header');q('.session-info-trigger').click();await wait(()=>document.querySelector('[data-field=taskDescription]'),'task information');
    const sections=[...document.querySelectorAll('[data-field=taskTitle],[data-field=taskDescription]')].map(node=>({label:node.querySelector('dt')?.textContent,text:node.querySelector('dd')?.textContent}));
    f.mount('focus');await wait(()=>q('.task-focus-context dd'),'focus');
    const focusDescription=q('.task-focus-context dd').textContent;
    const fold=[...f.host.querySelectorAll('.interaction-dock-tools button')].find(node=>node.textContent.includes('收起'));fold.click();await tick();
    f.sessions[0].taskMetadata.title='逐轮更新后的标题';f.mount('focus');await tick();const foldedTitle=q('.task-focus-folded').textContent;
    return {cards,empty,opened:f.opened,updated,scoped,sections,focusDescription,foldedTitle};
  })()`
})

for (const card of result.cards) {
  assert.match(card.text, /统一飞书与本机回答/)
  assert.equal(card.tooltip, card.text, `${card.id} exposes the full description`)
  assert.equal(card.clamp, '2')
  assert.equal(card.withinTwoLines, true)
  assert.equal(card.horizontalOverflow, false)
}
assert.equal(result.empty, false, 'tasks without generated descriptions add no placeholder')
assert.deepEqual(result.opened, ['active'], 'card description preserves the normal task entry')
assert.equal(result.updated, '新描述：统一跨渠道未读并覆盖恢复')
assert.equal(result.scoped, result.updated)
assert.deepEqual(result.sections, [{ label: '任务名称', text: '统一跨渠道未读状态' }, { label: '任务描述', text: result.updated }])
assert.equal(result.focusDescription, result.updated)
assert.equal(result.foldedTitle, '逐轮更新后的标题')
console.log('PASS task description UI: four board columns, bounds, tooltip, scoped parity, title popover description and live folded title')
