import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'session-deletion-progress', {
  setup: `
    import {TaskBoardWorkspace} from './src/renderer/components/TaskBoard';
    import {deleteSessionWithConfirmation} from './src/renderer/sessionDeletion';
    import {projectTaskBoard} from './src/shared/taskBoard';
    const sessions=['tree','local','other'].map(id=>({id,title:id==='tree'?'工作树任务':id==='local'?'主目录任务':'其他任务',status:'completed',createdAt:1,config:{agentId:'codex',workdir:'/fixture',requirementId:'r'}}));
    const checks=[],cancelled=[],deletes=[],opened=[],errors=[],resolvers=new Map();
    let checkNotify=()=>{},boardNotify=()=>{},failPreview=false,failDelete=true,dirty=false,releaseDelete;
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({
      getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query),getEvents:async()=>[],getTaskDecisions:async()=>[],
      onTaskBoardChanged:cb=>{boardNotify=cb;return()=>boardNotify=()=>{}},
      onSessionDeletionChecking:cb=>{checkNotify=cb;return()=>checkNotify=()=>{}},
      cancelSessionDeletionPreview:async requestId=>{cancelled.push(requestId)},
      previewSessionDeletion:async(id,requestId)=>{
        if(id==='tree'){checks.push(requestId);checkNotify({requestId,title:'工作树任务'});await new Promise(resolve=>resolvers.set(requestId,resolve));if(failPreview)throw Error('Git 检查失败')}
        return{confirmationId:'checked-'+id,title:sessions.find(s=>s.id===id).title,team:false,worktrees:id==='tree'?[{path:'/fixture/tree',branch:'uniagent/task',dirty,sharedCount:0,removed:false}]:[]}
      },
      deleteSession:async(id,confirmationId)=>{deletes.push({id,confirmationId});await new Promise(resolve=>releaseDelete=resolve);if(failDelete)throw Error('后台清理失败');sessions.splice(sessions.findIndex(s=>s.id===id),1);boardNotify()}
    },{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;display:flex;width:1100px;height:680px';
    const root=createRoot(host),mount=(scoped=false)=>root.render(<TaskBoardWorkspace key={String(scoped)} projects={[]} requirements={[]} onOpenTask={id=>opened.push(id)} onCreate={()=>{}} onDeleteTask={async id=>{await deleteSessionWithConfirmation(id)}} {...(scoped?{requirementId:'r'}:{})}/>);
    localStorage.clear();mount();window.progressFixture={host,checks,cancelled,deletes,opened,errors,mount,refresh:()=>boardNotify(),complete:id=>resolvers.get(id)(),release:()=>releaseDelete(),previewFail:value=>failPreview=value,deleteFail:value=>failDelete=value,dirty:value=>dirty=value};
  `,
  inspect: `(async()=>{
    const f=window.progressFixture,tick=()=>new Promise(r=>setTimeout(r,25)),wait=async(p,label)=>{for(let i=0;i<120;i++){if(p())return;await tick()}throw Error(label+': '+document.body.textContent)},card=id=>f.host.querySelector('[data-task-id="'+id+'"]'),del=id=>card(id)?.querySelector('[data-action=delete]'),dialog=()=>document.querySelector('dialog.session-delete-overlay'),button=text=>[...dialog()?.querySelectorAll('button')||[]].find(b=>b.textContent===text),confirm=()=>dialog()?.querySelector('[data-confirm-delete]');
    await wait(()=>del('tree'),'board ready');
    del('tree').click();await wait(()=>button('中断检查'),'checking visible');
    const checking={visible:!!card('tree'),deletes:f.deletes.length,locked:[...card('tree').querySelectorAll('[data-action]')].every(b=>b.disabled)};
    const first=f.checks.at(-1);button('中断检查').click();await wait(()=>!dialog(),'interrupted');f.complete(first);await tick();await tick();
    const interrupted={cancelled:f.cancelled.includes(first),kept:!!card('tree'),lateDialog:!!dialog(),deletes:f.deletes.length};
    del('tree').click();await wait(()=>button('中断检查'),'second check');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!dialog(),'escape cancelled');f.complete(f.checks.at(-1));await tick();
    f.previewFail(true);del('tree').click();await wait(()=>f.checks.length===3,'failure check');f.complete(f.checks.at(-1));await wait(()=>dialog()?.textContent.includes('Git 检查失败')&&button('重试检查'),'check failure');
    const errorKept=!!card('tree')&&f.deletes.length===0;
    f.previewFail(false);const retryButton=button('重试检查');retryButton.click();retryButton.click();await wait(()=>f.checks.length===4,'check retry');f.complete(f.checks.at(-1));await wait(()=>confirm(),'clean confirmation');
    const clean={text:dialog().textContent,button:confirm().textContent,warning:!!dialog().querySelector('.session-delete-warning')};
    button('取消').click();await wait(()=>!dialog()&&!del('tree').disabled,'cancel clean confirmation');
    del('tree').click();await wait(()=>f.checks.length===5,'delete check');f.complete(f.checks.at(-1));await wait(()=>confirm(),'delete confirm');const confirmButton=confirm();confirmButton.click();confirmButton.click();
    await wait(()=>f.deletes.length===1&&!card('tree')&&!dialog(),'immediate hide');
    const immediateCount=f.host.querySelector('[data-column=decision] header>span').textContent;
    card('other').querySelector('.task-board-card-open').click();f.refresh();await new Promise(r=>setTimeout(r,180));const hiddenOnRefresh=!card('tree');
    f.mount(true);await wait(()=>card('other'),'scoped remount');const hiddenOnSwitch=!card('tree');
    f.release();await wait(()=>card('tree')&&f.host.querySelector('[role=alert]')?.textContent.includes('后台清理失败'),'failure restores after remount');
    const restoredCount=f.host.querySelector('[data-column=decision] header>span').textContent;
    f.dirty(true);f.deleteFail(false);del('tree').click();await wait(()=>f.checks.length===6,'dirty retry');f.complete(f.checks.at(-1));await wait(()=>confirm(),'dirty confirmation');
    const dirtyText=dialog().textContent;confirm().click();await wait(()=>f.deletes.length===2&&!card('tree'),'retry hidden');f.release();await new Promise(r=>setTimeout(r,180));const noSuccessFlash=!card('tree');
    const checksBefore=f.checks.length;del('local').click();await wait(()=>confirm(),'local confirmation');const local={text:dialog().textContent,checks:f.checks.length-checksBefore,checking:!!button('中断检查')};confirm().click();await wait(()=>f.deletes.length===3&&!card('local'),'local immediate hide');f.release();await tick();
    return{checking,interrupted,errorKept,clean,immediateCount,hiddenOnRefresh,hiddenOnSwitch,restoredCount,dirtyText,noSuccessFlash,local,deletes:f.deletes,opened:f.opened,errors:f.errors};
  })()`
})
assert.deepEqual(result.checking, { visible: true, deletes: 0, locked: true })
assert.deepEqual(result.interrupted, { cancelled: true, kept: true, lateDialog: false, deletes: 0 })
assert.equal(result.errorKept, true)
assert.match(result.clean.text, /工作树没有未提交改动/)
assert.match(result.clean.text, /保留分支/)
assert.equal(result.clean.button, '删除任务及工作树')
assert.equal(result.clean.warning, false)
assert.equal(result.immediateCount, '2')
assert.equal(result.hiddenOnRefresh, true)
assert.equal(result.hiddenOnSwitch, true)
assert.equal(result.restoredCount, '3')
assert.match(result.dirtyText, /永久丢弃/)
assert.match(result.dirtyText, /含 Git 忽略文件/)
assert.equal(result.noSuccessFlash, true)
assert.match(result.local.text, /项目文件保留/)
assert.equal(result.local.checks, 0)
assert.equal(result.local.checking, false)
assert.deepEqual(result.deletes.map((row: any) => row.confirmationId), ['checked-tree', 'checked-tree', 'checked-local'])
assert.deepEqual(result.opened, ['other'])
assert.deepEqual(result.errors, [])
console.log('PASS deletion progress: interrupt/Esc, stale completion, inspection retry, clean/dirty/local confirmation, immediate hide/counts, other task interaction, refresh/remount, background failure recovery and retry')
