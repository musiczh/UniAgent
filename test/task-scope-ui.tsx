import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const reply = '已有回复。\n\n普通正文与 **加粗内容**。\n\n| 项目 | 大小 |\n| --- | --- |\n| TXT | 86 字节 |\n\n[查看说明](https://example.com)'

const result = await renderEventStream([], 'idle', 'task-scope-ui', {
  setup: `
    import {useState,useEffect} from 'react';
    import {ProjectPicker} from './src/renderer/components/ProjectPicker';
    import {RequirementEditor} from './src/renderer/components/RequirementPicker';
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';
    import {SessionHeader} from './src/renderer/App';
    import {COLOR_THEMES} from './src/shared/colorThemes';
    import {applyColorTheme} from './src/renderer/colorTheme';
    const projects=[{id:'a',name:'空间 A',primaryDirectory:'/a',additionalDirectories:[],isDefault:true},{id:'b',name:'空间 B',primaryDirectory:'/b',additionalDirectories:[]}];
    const requirements=[{id:'r',name:'所属需求',projectId:'b',dir:'/req',status:'active'},{id:'lost',name:'待绑定需求',status:'active'}];
    const selections=[],updates=[],errors=[],navigations=[],operations=[];let mounts=0,unmounts=0;
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getSessionWorktreeStatus:async()=>({treeId:'scope-tree',directory:'/trees/task-example/UniAgent',sourceBranch:'master',branch:'task/example',changedFiles:0,unmergedCommits:0,commits:[],checkedAt:1}),getSessionInfo:async()=>({native:[],local:[],errors:[]}),listProjects:async()=>projects,updateRequirement:async(id,patch)=>{updates.push({id,patch});return {...requirements[0],...patch}},listRequirements:async()=>requirements}, {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    function PickerFixture(){const [owner,setOwner]=useState({projectId:'a'});return React.createElement(ProjectPicker,{projects,projectId:owner.projectId,requirements,requirementId:owner.requirementId,onProjectsChange:()=>{},onSelect:p=>{setOwner({projectId:p.id});selections.push({kind:'space',id:p.id})},onRequirementSelect:r=>{setOwner({projectId:r.projectId,requirementId:r.id});selections.push({kind:'requirement',id:r.id})}})}
    const session={id:'s',title:'同一任务',status:'completed',createdAt:1,importMode:'direct',nativeSessionId:'native-s',config:{projectId:'a',requirementId:'r',requirementName:'旧需求名',agentId:'codex',model:'sample-model',permissionMode:'ask',workdir:'/a'}};
    const events=[{sessionId:'s',seq:1,ts:1,type:'user_message',state:'success',payload:{text:'任务目标'}},{sessionId:'s',seq:2,ts:2,type:'reasoning',state:'success',payload:{text:'读取任务背景'}},{sessionId:'s',seq:3,ts:3,type:'agent_message',state:'success',payload:{text:${JSON.stringify(reply)}}},{sessionId:'s',seq:4,ts:4,type:'turn_completed',state:'success',payload:{}}];
    function Draft(){const [text,setText]=useState('保留的草稿');useEffect(()=>{mounts++;return()=>unmounts++},[]);return React.createElement('div',null,React.createElement('textarea',{'aria-label':'原输入框',className:'composer-input',value:text,onChange:e=>setText(e.target.value)}),React.createElement('div',{className:'event-stream original-scroll',style:{height:180,overflow:'auto'}},React.createElement('div',{'data-seq':2,style:{height:1200,flexShrink:0}},'原对话与附件')))}
    const agent={id:'codex',name:'Codex',adapter:'codex',models:[],capabilities:{sideChat:true,permissionModes:[]}};
    function TaskFixture(){const [context,setContext]=useState({session,projects,requirements});window.updateTaskScope=patch=>setContext(current=>({...current,...patch}));return React.createElement('div',{className:'session-view',style:{height:640}},React.createElement(SessionHeader,{...context,agents:[agent],onNavigate:location=>navigations.push(location),onReturn:()=>operations.push('return'),onOpenFiles:()=>operations.push('files'),onForkLatest:()=>operations.push('fork'),onOpenSide:()=>operations.push('side'),onOpenComments:()=>operations.push('comments'),onRefreshNativeSession:()=>operations.push('refresh')}),React.createElement(SessionTaskContent,{session:context.session,events},React.createElement(Draft)))}
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;background:var(--bg);width:1024px;height:700px';
    const root=createRoot(host);root.render(React.createElement(PickerFixture));
    window.taskScopeFixture={session,projects,requirements,host,selections,updates,errors,navigations,operations,themes:COLOR_THEMES,applyTheme:applyColorTheme,mountEditor:()=>root.render(React.createElement(RequirementEditor,{requirement:requirements[0],onClose:()=>{},onSaved:()=>{}})),mountTask:()=>root.render(React.createElement(TaskFixture)),mounts:()=>mounts,unmounts:()=>unmounts};
  `,
  inspect: `(async()=>{
    const f=window.taskScopeFixture;const {session,projects,requirements}=f;const tick=()=>new Promise(r=>setTimeout(r,20));const wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+JSON.stringify(f.errors))};
    await wait(()=>f.host.querySelector('summary'),'picker');
    const open=async()=>{f.host.querySelector('summary').click();await wait(()=>f.host.querySelector('[role="listbox"]'),'open picker')};
    await open();
    let options=[...f.host.querySelectorAll('[role="option"]')];options.find(e=>e.textContent.includes('所属需求')).click();
    await wait(()=>f.selections.length===1,'select requirement');
    const reqTrigger=f.host.querySelector('summary').textContent;
    await open();options=[...f.host.querySelectorAll('[role="option"]')];const selectedReq=options.filter(e=>e.getAttribute('aria-selected')==='true').map(e=>e.textContent);
    options.find(e=>e.textContent.includes('空间 A')).click();await wait(()=>f.selections.length===2,'select space');const spaceTrigger=f.host.querySelector('summary').textContent;
    f.mountEditor();
    await wait(()=>document.querySelector('[aria-label="需求主项目"] option[value="a"]'),'editor projects');
    const select=document.querySelector('[aria-label="需求主项目"]');select.value='a';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();document.querySelector('.project-editor').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>f.updates.length===1,'save owner');
    f.mountTask();await wait(()=>f.host.querySelector('textarea'),'task view');
    const textarea=f.host.querySelector('textarea'),scroll=f.host.querySelector('.original-scroll');scroll.scrollTop=120;scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await tick();const before=scroll.scrollTop;
    const regions={header:getComputedStyle(f.host.querySelector('.session-header')).webkitAppRegion,title:getComputedStyle(f.host.querySelector('.session-info-trigger')).webkitAppRegion};
    const ownership=()=>f.host.querySelector('[aria-label="任务归属"]')?.textContent;
    const initialOwnership=ownership();
    [...f.host.querySelectorAll('[aria-label="任务归属"] button')].forEach(button=>button.click());
    const inlineOwnership=f.host.querySelector('.session-header').contains(f.host.querySelector('[aria-label="任务归属"]'));
    const worktreeLabel=f.host.querySelector('.task-worktree-badge')?.textContent||null;
    const toolbarActions=[...f.host.querySelectorAll('.session-fork-toggle,.session-side-toggle,.session-comments-toggle')].map(button=>({text:button.textContent.trim(),title:button.title,icon:button.querySelector('svg')?.getAttribute('class')}));
    const noTaskTabs=!f.host.querySelector('[role=tablist],.task-view-switch,.task-timeline');
    f.host.querySelector('.session-info-trigger').click();await wait(()=>document.querySelector('.session-info-popover'),'task info');
    document.querySelector('[aria-label="关闭会话信息"]').click();await tick();
    const controls=['打开文件查看器','返回点击前的 Session','从最新内容分叉新会话','侧边对话','打开侧边评论','刷新原生会话'];controls.forEach(label=>{const button=f.host.querySelector('[aria-label="'+label+'"]');if(!button||button.disabled)throw Error('missing control '+label);button.click()});
    const retained={sameNode:f.host.querySelector('textarea')===textarea,text:textarea.value,scrollBefore:before,scrollAfter:scroll.scrollTop,mounts:f.mounts(),unmounts:f.unmounts()};
    const reference=variable=>{const probe=f.host.appendChild(document.createElement('span'));probe.style.color='var(--'+variable+')';const value=getComputedStyle(probe).color;probe.remove();return value};
    const palette=[{dim:reference('text-dim'),blue:reference('blue')}];
    const cases=[],caseLinks=[];
    const update=async(patch)=>{window.updateTaskScope(patch);await tick();await tick();cases.push(ownership());const buttons=[...f.host.querySelectorAll('[aria-label="任务归属"] button')],before=f.navigations.length;buttons.filter(button=>button.disabled).forEach(button=>button.click());caseLinks.push({disabled:buttons.map(button=>button.disabled),icons:buttons.map(button=>button.querySelector('svg')?.getAttribute('class')),unchanged:f.navigations.length===before});if(cases.length<=2)buttons.forEach(button=>button.click())};
    const config=patch=>({...session.config,...patch});
    await update({projects:projects.map(p=>({...p,name:p.id==='a'?'空间 A 新名':'空间 B 新名'})),requirements:[{...requirements[0],name:'需求新名',projectId:'a'}]});
    await update({session:{...session,config:config({requirementId:undefined})}});
    await update({session:{...session,config:config({projectId:undefined,requirementId:undefined})}});
    await update({session:{...session,config:config({projectId:'removed',requirementId:undefined})}});
    await update({session,requirements:[]});
    await update({requirements:[{...requirements[0],projectId:undefined}]});
    const longName='用于检查超长归属名称是否保持在窗口内'.repeat(16);
    f.host.style.width='440px';
    await update({session:{...session,title:longName},projects:projects.map(p=>({...p,name:longName})),requirements:[{...requirements[0],name:longName}]});
    const row=f.host.querySelector('[aria-label="任务归属"]');
    const bounds=row?{overflow:row.scrollWidth>row.clientWidth,fullNames:[...row.querySelectorAll('[title]')].map(el=>el.title),visible:getComputedStyle(row).visibility==='visible'&&row.getBoundingClientRect().height>0}:null;
    const header=f.host.querySelector('.session-header'),headerRect=header.getBoundingClientRect(),actionRects=[...header.querySelectorAll('.session-fork-toggle,.session-side-toggle,.session-comments-toggle')].map(button=>button.getBoundingClientRect());
    const narrowToolbar={singleRow:new Set(actionRects.map(rect=>rect.top)).size===1,inside:actionRects.every(rect=>rect.left>=headerRect.left&&rect.right<=headerRect.right),height:headerRect.height};
    f.host.style.width='1024px';
    const worktreeCases=[];
    const tree={id:'scope-tree',baseRef:'refs/heads/master',state:'ready',workdir:'/trees/task-example/UniAgent',branch:'task/example'};
    const worktreeSessions=[
      session,
      {...session,status:'running'},
      {...session,config:config({workdir:undefined})},
      ...['running','completed','error'].map(status=>({...session,status,config:config({workdir:tree.workdir,worktree:tree})})),
      {...session,archived:true,config:config({workdir:tree.workdir,worktree:tree})},
      {...session,config:config({workdir:tree.workdir,worktree:{...tree,branch:undefined}})},
      {...session,config:config({workdir:tree.workdir,worktree:{...tree,state:'creating'}})},
      {...session,config:config({workdir:tree.workdir,worktree:{...tree,state:'failed',lastError:'创建失败样例'}})},
      {...session,config:config({workdir:tree.workdir,worktree:{...tree,removedAt:123}})},
      {...session,worktreePreparing:true,worktreeTaskError:'同步失败样例',config:config({workdir:tree.workdir,worktree:tree})}
    ];
    for(const next of worktreeSessions){
      window.updateTaskScope({session:next});await tick();await tick();
      const badge=f.host.querySelector('.task-worktree-badge');
      worktreeCases.push({text:badge?.textContent||null,title:badge?.title,icon:!!badge?.querySelector('.ui-icon-fork'),color:badge?getComputedStyle(badge).color:null,visible:!!badge&&badge.getBoundingClientRect().width>0,status:!!f.host.querySelector('.session-header .task-execution-status')});
    }
    return {initialOwnership,cases,caseLinks,bounds,longName,toolbarActions,narrowToolbar,selections:f.selections,reqTrigger,spaceTrigger,selectedReq,update:f.updates[0],regions,noTaskTabs,worktreeLabel,worktreeCases,palette,retained,inlineOwnership,navigations:f.navigations,operations:f.operations,errors:f.errors};
  })()`
})
assert.deepEqual(result.selections, [{ kind: 'requirement', id: 'r' }, { kind: 'space', id: 'a' }])
assert.match(result.reqTrigger, /所属需求/);assert.doesNotMatch(result.reqTrigger, /空间 A/)
assert.match(result.spaceTrigger, /空间 A/);assert.doesNotMatch(result.spaceTrigger, /所属需求/)
assert.equal(result.selectedReq.length, 1, 'only the requirement is selected, not its execution space')
assert.deepEqual(result.update, { id: 'r', patch: { projectId: 'a' } }, 'rebinding submits only changed ownership')
assert.deepEqual(result.regions, { header: 'drag', title: 'no-drag' }, 'clickable title excludes native window drag')
assert.equal(result.noTaskTabs, true)
assert.equal(result.worktreeLabel, null, 'tasks using the original directory have no worktree marker')
assert.deepEqual(result.retained, { sameNode: true, text: '保留的草稿', scrollBefore: 120, scrollAfter: 120, mounts: 1, unmounts: 0 })
assert.deepEqual(result.errors, [])
console.log('PASS Combined ownership selection, rebind form, unified toolbar and preserved conversation/draft/scroll')

assert.equal(result.inlineOwnership, true, 'ownership belongs to the compact title area')
assert.deepEqual(result.navigations, [{ kind: 'requirement', id: 'r' }, { kind: 'requirement', id: 'r' }, { kind: 'space', id: 'a' }], 'ownership navigates to either the requirement or the project without changing the execution directory')
assert.deepEqual(result.caseLinks.map((row: any) => row.disabled), [[false],[false],[true],[true],[true],[false],[false]])
assert.deepEqual(result.caseLinks.map((row: any) => row.icons), [['ui-icon ui-icon-file'],['ui-icon ui-icon-folder'],['ui-icon ui-icon-folder'],['ui-icon ui-icon-folder'],['ui-icon ui-icon-file'],['ui-icon ui-icon-file'],['ui-icon ui-icon-file']])
assert.ok(result.caseLinks.every((row: any) => row.unchanged), 'missing ownership cannot navigate')
assert.deepEqual(result.operations, ['files', 'return', 'fork', 'side', 'comments', 'refresh'], 'original toolbar callbacks work in the unified page')
assert.equal(result.initialOwnership, '所属需求', 'requirement ownership excludes the parent and execution projects')
assert.equal(result.cases[0], '需求新名')
assert.doesNotMatch(result.cases[0], /执行项目|旧需求名|空间 B/, 'renames and rebinding use the current catalog rather than stale session metadata')
assert.equal(result.cases[1], '空间 A 新名')
assert.doesNotMatch(result.cases[1], /旧需求名|需求新名/, 'clearing the requirement ignores its saved display name')
assert.equal(result.cases[2], '未关联项目')
assert.equal(result.cases[3], '项目暂不可用', 'unknown IDs are distinguished from absent ownership')
assert.equal(result.cases[4], '旧需求名', 'a missing requirement retains only its saved name without guessing its parent')
assert.equal(result.cases[5], '所属需求', 'a requirement without a main project still owns the task')
assert.ok(result.bounds?.visible, 'ownership is immediately visible without hovering')
assert.equal(result.bounds.overflow, false, 'long names fit even a narrow task pane')
assert.deepEqual(result.bounds.fullNames, [result.longName], 'the single truncated ownership name retains its full text in the tooltip')
assert.ok(result.toolbarActions.every((button: any) => button.text === '' && button.title), 'fork, side chat and comments use icons with hover descriptions')
assert.deepEqual(result.toolbarActions.map((button: any) => button.icon), ['ui-icon ui-icon-fork','ui-icon ui-icon-panel-right','ui-icon ui-icon-annotation'])
assert.equal(result.narrowToolbar.singleRow, true, 'long task titles and ownership names never wrap the action buttons')
assert.equal(result.narrowToolbar.inside, true, 'action buttons remain within the narrow task header')
assert.ok(result.narrowToolbar.height <= 50, 'the compact task header remains a single row')
console.log('PASS Task header live space/requirement ownership, cross-space execution, unified conversation, missing bindings and narrow pane long names')

assert.deepEqual(result.worktreeCases.map((row: any) => row.text), [null,null,null,'无待合入','无待合入','无待合入','无待合入','无待合入','工作树创建中','工作树不可用','工作树已移除','无待合入'])
assert.ok(result.worktreeCases.slice(0,3).every((row: any) => !row.visible && !row.icon && !row.status), 'local directories have no worktree marker in any task state')
assert.ok(result.worktreeCases.slice(3).every((row: any) => row.visible && row.icon && !row.status), 'bound worktrees retain their actual state and icon')
assert.match(result.worktreeCases[3].title, /分支：task\/example/)
assert.match(result.worktreeCases[3].title, /执行目录：\/trees\/task-example\/UniAgent/)
assert.doesNotMatch(result.worktreeCases[7].title, /当前分支|undefined/)
assert.match(result.worktreeCases[9].title, /创建失败样例/)
assert.equal(result.worktreeCases[3].color, result.palette[0].dim, 'worktrees without pending changes use the secondary marker')
assert.notEqual(result.worktreeCases[9].color, result.worktreeCases[3].color, 'failed worktrees are not marked ready')
console.log('PASS Task header directory marker follows the actual worktree binding across task statuses, creation, failure, removal and initial sync')
