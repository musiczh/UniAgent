import assert from 'node:assert/strict'
import { join } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'worktree-archive-dialog', {
  setup: `
    import {WorktreeArchiveReview} from './src/renderer/components/WorktreeArchiveReview';
    const calls=[];let listener;
    const pending={id:'request',taskId:'original',title:'保留原任务',version:2,phase:'pending',checks:[{treeId:'tree',sourceBranch:'master',changedFiles:2,unmergedCommits:1}]};
    window.uniagent={onWorktreeArchiveReviews:callback=>{listener=callback;return()=>{}},getWorktreeArchiveReviews:async()=>[pending],actWorktreeArchive:async input=>{calls.push(input);if(input.action==='merge')listener([{...pending,phase:'waiting',version:3}]);else if(input.action==='cancel')listener([])}};
    const draft=document.body.appendChild(document.createElement('textarea'));draft.value='保留输入草稿';draft.dataset.draft='true';
    const host=document.body.appendChild(document.createElement('div'));createRoot(host).render(React.createElement(WorktreeArchiveReview));
    window.archiveFixture={host,calls,pending,set:value=>listener(value)};
  `,
  inspect: `(async()=>{
    const f=window.archiveFixture,tick=()=>new Promise(r=>setTimeout(r,40));await tick();
    const initial={text:f.host.textContent,width:f.host.querySelector('[role=dialog]').getBoundingClientRect().width};
    f.host.querySelector('.primary').click();await tick();const hidden=!f.host.querySelector('[role=dialog]');
    f.set([{...f.pending,phase:'checking',version:4}]);await tick();const checking={spinner:!!f.host.querySelector('.loading-spinner'),primary:!!f.host.querySelector('.primary')};
    f.host.querySelector('button[aria-label]').click();await tick();const cancelled=!f.host.querySelector('[role=dialog]');
    f.set([{...f.pending,phase:'failed',version:5,error:'源分支不可用'}]);await tick();const failure=f.host.textContent;f.host.querySelector('.primary').click();await tick();
    return {initial,hidden,checking,cancelled,failure,calls:f.calls,draft:document.querySelector('[data-draft]').value};
  })()`
})
assert.match(result.initial.text, /未提交改动2 个文件.*未合回 master1 个提交/)
assert.match(result.initial.text, /重新核验/)
assert.equal(result.initial.width, 420)
assert.equal(result.hidden, true, 'accepted merge returns to the complete original conversation')
assert.deepEqual(result.checking, { spinner: true, primary: false })
assert.equal(result.cancelled, true)
assert.match(result.failure, /源分支不可用.*重试检查/)
assert.deepEqual(result.calls, [{ id: 'request', version: 2, action: 'merge' }, { id: 'request', version: 4, action: 'cancel' }, { id: 'request', version: 5, action: 'retry' }])
assert.equal(result.draft, '保留输入草稿')
const narrow = await renderEventStream([], 'idle', 'worktree-archive-narrow', {
  screenshot: { path: join(process.cwd(), 'out', 'worktree-archive-narrow.png'), width: 320, height: 640 },
  setup: `
    import {WorktreeArchiveDialog} from './src/renderer/components/WorktreeArchiveReview';
    const review={id:'narrow',taskId:'task',title:'归档前检查当前任务的完整改动',version:1,phase:'pending',checks:[{treeId:'tree',sourceBranch:'master',changedFiles:2,unmergedCommits:1}]};
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(WorktreeArchiveDialog,{review,onAction:async()=>{}}));
  `,
  inspect: `(()=>{const dialog=document.querySelector('[role=dialog]'),r=dialog.getBoundingClientRect();return {viewport:innerWidth,left:r.left,right:r.right,width:r.width,overflow:dialog.scrollWidth>dialog.clientWidth,buttons:[...dialog.querySelectorAll('button')].map(button=>{const b=button.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight})}})()`
})
assert.equal(narrow.viewport, 320)
assert.ok(narrow.left >= 10 && narrow.right <= 310)
assert.equal(narrow.overflow, false)
assert.ok(narrow.buttons.every(Boolean), 'all actions remain inside the narrow viewport')
console.log('PASS approved archive dialog: counts, checking, cancel, same-task merge, failed retry, draft preservation and 320px viewport')
