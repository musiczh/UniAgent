import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'session-list-deletion', {
  setup: `
    import {SessionList} from './src/renderer/components/SessionList';
    localStorage.clear();
    const sessions=[{id:'task',title:'工作树任务',status:'idle',archived:true,createdAt:1,config:{agentId:'codex',workdir:'/fixture',projectId:'p'}}];
    let accept=false,fail=true,previewFail=false;const confirmations=[],calls=[],errors=[];
    window.confirm=message=>{confirmations.push(message);return accept};
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({listRequirements:async()=>[],previewSessionDeletion:async id=>{if(previewFail)throw Error('Git 检查失败');return{confirmationId:'checked',title:'工作树任务',team:false,worktrees:[{path:'/fixture/tree',branch:'uniagent/task',dirty:true,sharedCount:0,removed:false}]}}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('aside'));host.className='sidebar';host.style.cssText='position:absolute;inset:0;width:280px;height:700px';
    const root=createRoot(host),mount=()=>root.render(<SessionList sessions={[...sessions]} agents={[{id:'codex',name:'Codex',builtin:true,installed:true,icon:'',models:[],capabilities:{},lifecycle:{availability:'available'}}]} activeId={null} statusBySession={{}} unreadBySession={{}} onSelect={()=>{}} onArchive={()=>{}} onUnarchive={()=>{}} onDelete={async(id,confirmationId)=>{calls.push({id,confirmationId});if(fail)throw Error('工作树清理失败');sessions.splice(0);mount()}} onArchiveMany={()=>{}} onDeleteMany={()=>{throw Error('single deletion must use its checked token')}} onRename={()=>{}} onPin={()=>{}}/>);
    mount();window.deletionFixture={host,confirmations,calls,errors,accept:value=>accept=value,allow:()=>fail=false,failPreview:value=>previewFail=value};
  `,
  inspect: `(async()=>{
    const f=window.deletionFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(resolve=>setTimeout(resolve,25)),wait=async(p,label)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error(label+': '+f.host.textContent)};
    const confirm=async(accept=true)=>{await wait(()=>document.querySelector('[data-confirm-delete]'),'confirmation');const dialog=document.querySelector('.session-delete-overlay');f.confirmations.push(dialog.textContent);dialog.querySelector(accept?'[data-confirm-delete]':'[data-cancel-delete]').click()};
    await wait(()=>q('.sl-archive-head'),'archive toggle');q('.sl-archive-head').click();await wait(()=>q('[aria-label="删除会话"]'),'delete button');
    q('[aria-label="删除会话"]').click();await confirm(false);await tick();
    const cancelled={calls:f.calls.length,visible:!!q('[aria-label="删除会话"]'),collapsed:!!q('.exiting-delete')};
    f.accept(true);q('[aria-label="删除会话"]').click();await confirm();await wait(()=>q('[role=alert]')?.textContent.includes('工作树清理失败'),'failure');
    const failed={visible:!!q('[aria-label="删除会话"]'),collapsed:!!q('.exiting-delete'),calls:f.calls.length};
    f.failPreview(true);q('[aria-label="删除会话"]').click();await wait(()=>document.querySelector('.session-delete-overlay [role=alert]')?.textContent.includes('Git 检查失败'),'preflight failure');
    const checked=f.confirmations.length;
    document.querySelector('[data-cancel-delete]').click();await tick();
    f.failPreview(false);f.allow();q('[aria-label="删除会话"]').click();await confirm();await wait(()=>!q('[aria-label="删除会话"]'),'success');
    return{cancelled,failed,checked,confirmations:f.confirmations,calls:f.calls,errors:f.errors};
  })()`
})
assert.deepEqual(result.cancelled, { calls: 0, visible: true, collapsed: false })
assert.deepEqual(result.failed, { visible: true, collapsed: false, calls: 1 })
assert.equal(result.checked, 2, 'failed preflight does not show a confirmation')
assert.equal(result.confirmations.length, 3, 'the parent never adds a second confirmation')
assert.ok(result.confirmations.every((text: string) => text.includes('永久丢弃') && text.includes('/fixture/tree')))
assert.deepEqual(result.calls, [{ id: 'task', confirmationId: 'checked' }, { id: 'task', confirmationId: 'checked' }])
assert.deepEqual(result.errors, [])
console.log('PASS sidebar deletion: confirm before exit animation, cancellation keeps rows, failed deletion restores rows, checked tokens and retry')
