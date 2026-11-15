import assert from 'node:assert/strict'
import { sessionDisplayTitle } from '../src/shared/task'
import { projectTaskBoard } from '../src/shared/taskBoard'
import { matchesHistoryItem } from '../src/renderer/components/ResumePanel'
import { renderEventStream } from './regression/render-event-stream.mjs'
import type { AgentDef, Session } from '../src/shared/types'

const ordinary: Session = { id: 'task', title: '原生线程标题', status: 'awaiting-approval', createdAt: 1, updatedAt: 5,
  config: { agentId: 'codex', workdir: '/fixture', projectId: 'p' },
  taskState: { phase: 'active', version: 7, updatedAt: 5, awaitingAcceptance: false },
  taskMetadata: { formatVersion: 1, taskId: 'task', version: 3, configVersion: 1, title: '修复任务历史图片漏显', source: 'generated', generationState: 'ready', contextGeneration: 0, clarificationCount: 0, attempts: 1 } }
const unchanged = structuredClone(ordinary)
assert.equal(sessionDisplayTitle(ordinary), '修复任务历史图片漏显', 'conversation title uses independent task metadata')
const board = projectTaskBoard([ordinary], () => [])
assert.equal(board.columns.decision.items[0].title, '修复任务历史图片漏显')
assert.equal(board.focus[0].title, '修复任务历史图片漏显', 'focus and card name the same task')
assert.equal(board.focus[0].updatedAt, 5)
assert.equal(sessionDisplayTitle({ ...ordinary, taskMetadata: undefined }), '原生线程标题')
assert.equal(sessionDisplayTitle({ ...ordinary, taskMetadata: { ...ordinary.taskMetadata!, title: '  ' } }), '原生线程标题')
assert.deepEqual(ordinary, unchanged, 'title projection does not mutate native title, lifecycle or activity')

const agent = { id: 'codex', name: 'Codex', adapter: 'codex', installed: true, models: [], capabilities: { modelSelect: true, reasoningEffort: false, permissionModes: [] }, lifecycle: { availability: 'available' } } as unknown as AgentDef
const managed = { ...ordinary, id: 'managed', title: '原生初始化标题', config: { ...ordinary.config, initializationTargetAgentId: 'codex' } }
assert.equal(matchesHistoryItem({ id: 'native', agentId: 'codex', title: '原生历史标题', updatedAt: 1 }, '历史'), true, 'native history title search remains available')
const result = await renderEventStream([], 'idle', 'task-title-projection', {
  setup: `
    import {SessionHeader} from './src/renderer/App';import {SessionList} from './src/renderer/components/SessionList';import {WorkspaceDetail} from './src/renderer/components/WorkspaceBrowser';import {ProjectSettings} from './src/renderer/components/ProjectSettings';import {ProjectWorktrees} from './src/renderer/components/ProjectWorktrees';
    const noop=()=>{},sessions=${JSON.stringify([ordinary, managed])},agents=${JSON.stringify([agent])},project={id:'p',name:'样例空间',primaryDirectory:'/fixture',additionalDirectories:[],createdAt:1,updatedAt:1},renames=[],errors=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({listRequirements:async()=>[],listProjects:async()=>[project],listProjectWorktrees:async()=>[{path:'/fixture/tree',source:'managed',state:'ready',sessions:[{id:'task',title:'原生线程标题'}]}]}, {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>[]});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);const mount=kind=>root.render(kind==='list'?React.createElement(SessionList,{sessions,agents,activeId:null,statusBySession:{},unreadBySession:{},onSelect:noop,onArchive:noop,onUnarchive:noop,onDelete:noop,onArchiveMany:noop,onDeleteMany:noop,onRename:(id,title)=>renames.push([id,title]),onPin:noop}):kind==='header'?React.createElement(SessionHeader,{session:sessions[0],agents}):kind==='project'?React.createElement(ProjectSettings,{projects:[project],sessions,agents,navigationGuard:{current:null},onProjectsChange:noop}):kind==='worktree'?React.createElement(ProjectWorktrees,{project,sessions}):React.createElement(WorkspaceDetail,{location:{kind:'space',id:'p'},data:{projects:[project],requirements:[]},requirementsEnabled:false,sessions,pending:{},unread:{},status:{},sessionsLoading:false,onRetrySessions:async()=>{},onNavigate:noop,onCreate:noop,onOpenTask:noop,onManage:noop}));mount('list');window.titleProjectionFixture={host,mount,renames,errors};
  `,
  inspect: `(async()=>{
    const f=window.titleProjectionFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,10)),wait=async p=>{for(let i=0;i<150;i++){if(p())return;await tick()}throw Error('projection timeout: '+f.host.textContent+' / '+f.errors)};
    await wait(()=>q('[data-session-id=task]'));const r={sidebar:q('[data-session-id=task] .si-title').textContent,managed:q('[data-session-id=managed] .si-title').textContent};const openRename=async()=>{q('[data-session-id=task]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:10,clientY:10}));await wait(()=>[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent.includes('重命名')));[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes('重命名')).click();await wait(()=>q('[aria-label="任务标题"]'))};await openRename();r.renameInitial=q('[aria-label="任务标题"]').value;q('[aria-label="任务标题"]').focus();q('[aria-label="任务标题"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));q('[aria-label="任务标题"]')?.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));await tick();r.sameTitleSubmit=f.renames.slice();await openRename();q('[aria-label="任务标题"]').focus();q('[aria-label="任务标题"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));q('[aria-label="任务标题"]')?.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));await tick();r.afterEscape=f.renames.slice();await openRename();const input=q('[aria-label="任务标题"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'手动任务标题');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));await tick();r.renames=f.renames;
    f.mount('header');await wait(()=>q('.topbar-title-main'));r.header=q('.topbar-title-main').textContent;r.tooltip=q('.session-info-trigger').getAttribute('title');
    f.mount('scope');await wait(()=>q('[data-task-id=task]'));r.scope=q('[data-task-id=task] span').textContent;
    f.mount('project');await wait(()=>q('[aria-label="进入项目 样例空间"]'));q('[aria-label="进入项目 样例空间"]').click();await wait(()=>q('.project-session-title strong'));r.project=q('[data-session-id=task] .project-session-title strong').textContent;
    f.mount('worktree');await wait(()=>q('.project-worktree-session'));r.worktree=q('.project-worktree-session').textContent;return {...r,errors:f.errors};
  })()`
})
for (const surface of ['sidebar','renameInitial','header','scope','project','worktree']) assert.equal(result[surface], '修复任务历史图片漏显', surface)
assert.equal(result.managed, '原生初始化标题')
assert.match(result.tooltip, /修复任务历史图片漏显/)
assert.deepEqual(result.sameTitleSubmit, [['task','修复任务历史图片漏显']], 'confirming the same ordinary title must submit a manual lock')
assert.deepEqual(result.afterEscape, [['task','修复任务历史图片漏显']], 'Escape cancels without renaming')
assert.deepEqual(result.renames, [['task','修复任务历史图片漏显'],['task','手动任务标题']])
assert.deepEqual(result.errors, [])
console.log('PASS task title projections: detail, board/focus, sidebar, fallback, managed native title, history search and unchanged lifecycle/activity')
