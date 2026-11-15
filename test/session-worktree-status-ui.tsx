import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const width of [1360, 1024]) {
  const result = await renderEventStream([], 'idle', 'session-worktree-status-ui', {
    screenshot: { width, height: 760, path: resolve('out/test/session-worktree-status-' + width + '.png') },
    setup: `
      import {SessionHeader} from './src/renderer/components/SessionHeader';
      import {TaskBoardWorkspace} from './src/renderer/components/TaskBoard';
      import {projectTaskBoard} from './src/shared/taskBoard';
      Object.defineProperty(document,'visibilityState',{value:'visible'});localStorage.clear();
      const errors=[],calls=[],opened=[],listeners=new Set(),noop=()=>{};window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const tree={id:'status-tree-${width}',state:'ready',workdir:'/fixture/task/UniAgent',baseRef:'refs/heads/master',branch:'uniagent/task-status',repositoryRoot:'/fixture',gitCommonDirectory:'/fixture/.git'};
      const task={id:'status-task',title:'检查工作树状态',status:'completed',createdAt:1,config:{agentId:'codex',projectId:'p',requirementId:'r',workdir:tree.workdir,worktree:tree}};
      const local={...task,id:'local-task',title:'原目录任务',config:{...task.config,worktree:undefined}},failed={...task,id:'failed-task',title:'创建失败任务',config:{...task.config,worktree:{...tree,id:'failed-tree-${width}',state:'failed',lastError:'创建失败样例'}}};
      const sessions=[task,local,failed];let fail=false,status={treeId:tree.id,directory:tree.workdir,sourceBranch:'master',branch:tree.branch,changedFiles:0,unmergedCommits:0,commits:[],checkedAt:Date.now()};
      window.uniagent=new Proxy({getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query),getSessionWorktreeStatus:async id=>{calls.push(id);if(fail)throw Error('Git 暂时不可用');return structuredClone(status)},getTaskDecisions:async()=>[],onStatusChange:cb=>{listeners.add(cb);return()=>listeners.delete(cb)}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>null});
      const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;overflow:auto;background:var(--bg)';const root=createRoot(host);
      const render=(header=task)=>root.render(<><SessionHeader key={header.id} session={header} agents={[]}/><div className="board-all"><TaskBoardWorkspace projects={[]} requirements={[]} onOpenTask={id=>opened.push(id)} onDeleteTask={async()=>{}}/></div><div className="board-scoped"><TaskBoardWorkspace projects={[]} requirements={[]} requirementId="r" onOpenTask={id=>opened.push(id)} onDeleteTask={async()=>{}}/></div></>);render();
      window.worktreeFixture={host,calls,errors,opened,read:()=>listeners.forEach(cb=>cb({sessionId:task.id,status:'completed'})),update:patch=>status={...status,...patch,checkedAt:Date.now()},fail:value=>fail=value,localHeader:()=>render(local)};
    `,
    inspect: `(async()=>{
      const f=window.worktreeFixture,tick=()=>new Promise(r=>setTimeout(r,20)),wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+f.host.textContent+' / '+f.errors)};
      const markers=()=>[...f.host.querySelectorAll('.worktree-status-badge')].filter(el=>!el.closest('[data-task-id=failed-task]'));
      const labels=()=>markers().map(el=>el.textContent),pop=()=>document.querySelector('.worktree-status-popover');
      await wait(()=>markers().length===3&&labels().every(text=>text==='无待合入'),'shared clean state');const initialCalls=f.calls.length;
      const localAbsent=![...f.host.querySelectorAll('[data-task-id=local-task]')].some(card=>card.querySelector('.worktree-status-badge'));
      const header=f.host.querySelector('.session-header .worktree-status-badge');header.click();await wait(()=>pop()&&!pop().querySelector('[aria-busy=true]'),'popover');
      const initialInfo=pop().textContent;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!pop(),'Escape');const focusRestored=document.activeElement===header;
      f.update({changedFiles:2});f.read();await wait(()=>labels().every(text=>text==='待合入'),'dirty state');
      const dirty=labels(),colors=markers().map(el=>getComputedStyle(el).color);
      f.host.querySelector('.board-all [data-task-id=status-task] .worktree-status-badge').click();await wait(()=>pop(),'card details');const dirtyInfo=pop().textContent;
      f.update({changedFiles:0,unmergedCommits:2,commits:[{hash:'a'.repeat(40),subject:'新增提交：保留任务标题'},{hash:'b'.repeat(40),subject:'完整提交说明。'.repeat(100)}]});f.read();await wait(()=>pop().textContent.includes('新增提交'),'ahead commits');
      const pendingInfo=pop().textContent,rect=pop().getBoundingClientRect(),content=pop().querySelector('.session-info-content');
      const layout={inside:rect.left>=12&&rect.right<=innerWidth-12&&rect.bottom<=innerHeight-12,scroll:content.scrollHeight>content.clientHeight,overflow:pop().scrollWidth>pop().clientWidth};
      f.update({unmergedCommits:0,commits:[]});f.read();await wait(()=>labels().every(text=>text==='无待合入'),'merged state');
      f.fail(true);f.read();await wait(()=>labels().every(text=>text==='状态待确认'),'failure state');const failure=pop().querySelector('[role=alert]')?.textContent;
      f.fail(false);[...pop().querySelectorAll('button')].find(el=>el.textContent==='刷新').click();await wait(()=>labels().every(text=>text==='无待合入')&&!pop().querySelector('[role=alert]'),'retry');
      document.querySelector('[aria-label=关闭工作树状态]').click();await wait(()=>!pop(),'close');
      const before=f.calls.length;f.localHeader();await tick();await tick();const localHeaderAbsent=!f.host.querySelector('.session-header .worktree-status-badge'),noLocalRead=f.calls.length===before;
      const failed=f.host.querySelector('[data-task-id=failed-task] .worktree-status-badge');failed.click();await wait(()=>pop(),'failed binding details');const creationError=pop().textContent;
      return{initialCalls,localAbsent,initialInfo,focusRestored,dirty,colors,dirtyInfo,pendingInfo,layout,failure,localHeaderAbsent,noLocalRead,creationError,opened:f.opened,calls:f.calls,errors:f.errors};
    })()`
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.initialCalls, 1, 'header and both boards share one pending request')
  assert.equal(result.localAbsent, true); assert.equal(result.localHeaderAbsent, true); assert.equal(result.noLocalRead, true)
  for (const text of ['/fixture/task/UniAgent','master','uniagent/task-status','没有未提交的改动','没有待合入的提交']) assert.ok(result.initialInfo.includes(text), text)
  assert.equal(result.focusRestored, true)
  assert.deepEqual(result.dirty, ['待合入','待合入','待合入'])
  assert.equal(new Set(result.colors).size, 1, 'both entry points use the same state color')
  assert.match(result.dirtyInfo, /2 个文件未提交/)
  assert.match(result.pendingInfo, /领先源分支的提交 · 2/); assert.match(result.pendingInfo, /aaaaaaaa/); assert.match(result.pendingInfo, /新增提交：保留任务标题/)
  assert.deepEqual(result.layout, { inside: true, scroll: true, overflow: false })
  assert.match(result.failure, /Git 暂时不可用/)
  assert.match(result.creationError, /创建失败样例/)
  assert.ok(result.calls.every(id=>id==='status-task'), 'local and unavailable worktrees never issue inspections')
  assert.deepEqual(result.opened, [], 'opening a card status never opens the task underneath it')
  console.log('PASS shared header/board worktree status: dirty, ahead, merged, failures/retry, details, focus, narrow layout and non-worktree exclusion at '+width)
}
