import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const size of [{width:1360,height:900},{width:1024,height:640}]) {
  const result = await renderEventStream([], 'idle', 'picker-layout', {
    screenshot: {...size,path:resolve('out/test/task-picker-'+size.width+'.png')},
    setup: `import{useState}from'react';import{ProjectPicker}from'./src/renderer/components/ProjectPicker';import'./src/renderer/components/requirements.css';
    const projects=[{id:'a',name:'默认空间',primaryDirectory:'/a',additionalDirectories:[],isDefault:true}];
    const requirements=Array.from({length:30},(_,i)=>({id:'r'+i,name:i===0?'一个需要保留完整阅读能力的长需求名称':'需求 '+i,projectId:'a',status:'active'}));
    const changes=[];function Fixture(){const[selection,setSelection]=useState({mode:'local',baseRef:'HEAD'});const[git,setGit]=useState(true);window.disableGit=()=>{setSelection({mode:'local',baseRef:'HEAD'});setGit(false)};window.enableGit=()=>setGit(true);return React.createElement(ProjectPicker,{projects,projectId:'a',requirements,autoRouting:{selected:false,available:false,onSelect:()=>changes.push('auto')},onSelect:()=>changes.push('space'),onRequirementSelect:()=>changes.push('requirement'),onProjectsChange:()=>{},workspaceSelection:selection,onWorkspaceChange:(mode,baseRef)=>setSelection({mode,baseRef}),gitInfo:{canCreateWorktree:git,unavailableReason:git?undefined:'主目录不是可用的 Git 仓库',currentBranch:'main',branches:[{name:'develop',ref:'develop'}]}})}
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;left:30px;bottom:30px';createRoot(host).render(React.createElement(Fixture));window.fixture={host,changes};`,
    inspect:`(async()=>{const f=window.fixture;const tick=()=>new Promise(r=>setTimeout(r,30));const wait=async p=>{for(let i=0;i<80;i++){if(p())return;await tick()}throw Error('fixture timeout')};await wait(()=>f.host.querySelector('summary'));f.host.querySelector('summary').click();await wait(()=>f.host.querySelector('[data-positioned]'));
    const pop=f.host.querySelector('.project-picker-pop'),list=pop.querySelector('.project-picker-list'),actions=[...pop.querySelectorAll('.project-picker-create')],box=pop.getBoundingClientRect(),rect=list.getBoundingClientRect();
    const defaultOff=pop.querySelector('[role=checkbox]').getAttribute('aria-checked')==='false'&&!pop.querySelector('select');
    pop.querySelector('.scope-picker-auto').click();const autoBlocked=f.changes.length===0;
    const footerBefore=actions[0].getBoundingClientRect().top;list.scrollTop=list.scrollHeight;await tick();const footerAfter=actions[0].getBoundingClientRect().top;
    const last=list.querySelector('button:last-child');const r=last.getBoundingClientRect();const canReadLast=r.top>=rect.top&&r.bottom<=rect.bottom+1;
    pop.querySelector('[role=checkbox]').click();await wait(()=>pop.querySelector('select'));const enabled=pop.querySelector('[role=checkbox]').getAttribute('aria-checked')==='true';
    const select=pop.querySelector('select');select.value='develop';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();const branchKept=pop.querySelector('select').value==='develop'&&pop.querySelector('[role=checkbox]').getAttribute('aria-checked')==='true';
    pop.querySelector('[role=checkbox]').focus();const focusable=document.activeElement===pop.querySelector('[role=checkbox]');pop.querySelector('[role=checkbox]').click();await tick();const offAgain=!pop.querySelector('select');
    window.disableGit();await tick();const unavailable=pop.querySelector('[role=checkbox]').disabled&&pop.textContent.includes('不是可用的 Git');const hint=pop.querySelector('.project-worktree-hint');const quietHint=getComputedStyle(hint).color===getComputedStyle(list.querySelector('button:not(.scope-picker-auto) small')).color&&getComputedStyle(hint,'::before').content==='none';window.enableGit();await tick();list.scrollTop=0;if(${size.width===1360}){pop.querySelector('[role=checkbox]').click();await wait(()=>pop.querySelector('select'))};
    return{quietHint,defaultOff,enabled,branchKept,focusable,offAgain,unavailable,autoBlocked,canReadLast,actionRow:Math.abs(actions[0].getBoundingClientRect().top-actions[1].getBoundingClientRect().top)<1,footerStable:footerBefore===footerAfter,listHeight:rect.height,popHeight:box.height,inBounds:box.top>=39&&box.bottom<=innerHeight-11,worktreeHeight:pop.querySelector('.project-workspace-group').getBoundingClientRect().height};})()`
  })
  for (const key of ['quietHint','defaultOff','enabled','branchKept','focusable','offAgain','unavailable','autoBlocked','canReadLast','actionRow','footerStable','inBounds']) assert.equal(result[key],true,key+' at '+size.width)
  assert.ok(result.listHeight>=200,JSON.stringify(result));assert.ok(result.popHeight<=521);assert.ok(result.worktreeHeight<=40)
  console.log('PASS Compact task picker '+size.width+'x'+size.height+': '+Math.round(result.listHeight)+'px readable list; fixed actions, toggle and branches')
}
