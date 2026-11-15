import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'worktree-creation-state', {
  setup: `
    import {WorktreeCreation} from './src/renderer/components/WorktreeCreation';
    const calls=[];
    window.uniagent={retryWorktreeTask:async(...args)=>calls.push(args)};
    let session={id:'first',status:'running',worktreePreparing:true,config:{worktree:{state:'ready',baseRef:'refs/heads/main',sourcePrimaryDirectory:'/sample/repo',workdir:'/sample/tree'}}};
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
    const render=()=>root.render(React.createElement(WorktreeCreation,{session}));render();
    window.cardFixture={host,calls,set:patch=>{session={...session,...patch};render()}};
  `,
  inspect: `(async()=>{
    const f=window.cardFixture,tick=()=>new Promise(r=>setTimeout(r,30));
    await tick();const initial={text:f.host.textContent,spinner:!!f.host.querySelector('.loading-spinner'),role:f.host.querySelector('[role]')?.getAttribute('role')};
    f.set({worktreePreparing:false});await tick();const cleared=!f.host.querySelector('.worktree-creation-card');
    f.set({worktreeTaskError:'合并存在冲突，首次准备未完成',pendingQueue:[{id:'saved-input',state:'pending',prompt:'保留原始输入'}]});await tick();
    const failure={text:f.host.textContent,spinner:!!f.host.querySelector('.loading-spinner'),role:f.host.querySelector('[role]')?.getAttribute('role')};
    f.host.querySelector('button').click();await tick();
    f.set({worktreeTask:{prompt:'初始任务'},pendingQueue:undefined,config:{worktree:{state:'failed',lastError:'创建失败',baseRef:'refs/heads/main',sourcePrimaryDirectory:'/sample/repo',workdir:'/sample/tree'}}});await tick();
    f.host.querySelector('button').click();await tick();
    return {initial,cleared,failure,calls:f.calls};
  })()`
})
assert.match(result.initial.text, /正在准备任务/)
assert.deepEqual({ spinner: result.initial.spinner, role: result.initial.role }, { spinner: true, role: 'status' })
assert.equal(result.cleared, true, 'successful preparation removes the temporary card')
assert.match(result.failure.text, /冲突/)
assert.match(result.failure.text, /重试准备/)
assert.deepEqual({ spinner: result.failure.spinner, role: result.failure.role }, { spinner: false, role: 'alert' })
assert.deepEqual(result.calls, [['first'], ['first']], 'both preparation and creation reuse the existing retry route')
console.log('PASS first worktree loading card, success removal, failure and durable-input retry')
