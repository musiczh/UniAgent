import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-board-motion', {
  setup: `
    import {TaskBoard} from './src/renderer/components/TaskBoard';
    import {projectTaskBoard} from './src/shared/taskBoard';
    let reduced=false;const match=window.matchMedia.bind(window);window.matchMedia=q=>q.includes('prefers-reduced-motion')?{matches:reduced,addEventListener(){},removeEventListener(){}}:match(q);
    const sessions=['a','b'].map((id,index)=>({id,title:'任务 '+id,status:'running',createdAt:2-index,config:{agentId:'codex',workdir:'/fixture',projectId:'p'},taskState:{phase:'active',version:1,updatedAt:2-index,awaitingAcceptance:false}}));let changed=()=>{};const opened=[];
    const change=phase=>{sessions[0]={...sessions[0],status:phase==='active'?'running':phase==='decision'?'interrupted':'idle',taskState:{...sessions[0].taskState,phase:phase==='decision'?'active':phase,version:sessions[0].taskState.version+1,updatedAt:Date.now()}};changed()};
    const state=()=>({record:sessions[0].taskState,busy:false,pendingDecisions:0,inputRevision:'input',turnRevision:'turn'});let complete;
    const action=phase=>new Promise(resolve=>{complete=()=>{complete=undefined;change(phase);resolve(state())}});
    window.uniagent=new Proxy({getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query),onTaskBoardChanged:cb=>{changed=cb;return()=>{}},getTaskDecisions:async()=>[],getEvents:async()=>[],getTaskState:async()=>state(),interrupt:()=>action('decision'),decideTask:(_id,input)=>action(input.disposition==='archive'?'archived':'standby')},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;left:180px;top:70px;width:1100px;height:700px;display:flex;background:var(--bg)';let root;const mount=()=>{root=createRoot(host);root.render(React.createElement(TaskBoard,{projects:[{id:'p',name:'项目'}],requirements:[],onCreate:()=>{},onOpenTask:id=>opened.push(id),onDeleteTask:async()=>{}}))};mount();window.boardMotion={host,opened,change,complete:()=>complete(),pending:()=>!!complete,refresh:()=>changed(),title:text=>{sessions[0].title=text;changed()},remount:()=>{root.unmount();mount()},reduce:()=>reduced=true};
  `,
  inspect: `(async()=>{
    const f=window.boardMotion,tick=ms=>new Promise(r=>setTimeout(r,ms||15)),wait=async p=>{for(let i=0;i<180;i++){if(p())return;await tick()}throw Error('board motion timeout: '+f.host.textContent)};
    const card=()=>f.host.querySelector('[data-task-id="a"]'),flight=()=>document.querySelector('body>[data-motion-key="task:a"]');
    const checks={},positions={},point=rect=>({left:rect.left,top:rect.top}),near=(a,b)=>Math.abs(a.left-b.left)<1&&Math.abs(a.top-b.top)<1;
    const measureFlight=(label,from)=>{
      const copy=flight(),animation=copy.getAnimations()[0],to=card().getBoundingClientRect();
      animation.pause();animation.currentTime=0;const start=copy.getBoundingClientRect();
      animation.currentTime=120;const middle=copy.getBoundingClientRect();
      animation.currentTime=239.999;const end=copy.getBoundingClientRect();
      positions[label]={from:point(from),start:point(start),middle:point(middle),end:point(end),to:point(to)};
      checks[label+'StartsAtCard']=near(start,from);
      checks[label+'MovesBetweenColumns']=middle.left>Math.min(from.left,to.left)&&middle.left<Math.max(from.left,to.left);
      checks[label+'EndsAtTarget']=near(end,to);
      animation.finish();
    };
    const clickAction=async(action,column)=>{
      const source=card(),from=source.getBoundingClientRect();source.querySelector('[data-action="'+action+'"]').click();
      await wait(()=>f.pending()&&source.getAnimations().some(a=>a.effect.getTiming().duration===180));
      f.complete();await wait(()=>card()?.dataset.cardColumn===column&&flight());
      checks[action+'ReplacesSource']=!source.isConnected;measureFlight(action,from);await tick(300);
    };
    await wait(()=>card());await tick(40);checks.initialNoEntry=card().getAnimations().length===0&&!flight();
    const initial=card().getBoundingClientRect();f.change('standby');await wait(()=>card()?.dataset.cardColumn==='standby'&&flight());
    checks.crossColumnAnimated=flight().inert&&flight().getAnimations()[0].effect.getTiming().duration===240;
    checks.singleTask=f.host.querySelectorAll('[data-task-id="a"]').length===1;
    checks.countTransition=f.host.querySelector('[data-column="active"]>header').getAnimations().some(a=>a.effect.getTiming().duration===180);
    measureFlight('stateChange',initial);await tick(300);checks.flightCleaned=!flight()&&card().style.opacity!== '0';
    f.refresh();await tick(160);checks.sameSnapshotNoReplay=card().getAnimations().length===0&&!flight();
    f.title('最新任务名称');await wait(()=>card()?.textContent.includes('最新任务名称'));await tick(30);checks.titleTransition=card().getAnimations().some(a=>a.effect.getTiming().duration===180);await tick(220);
    card().querySelector('button').click();await tick();checks.clickStillWorks=f.opened[0]==='a';
    f.change('active');await wait(()=>card()?.dataset.cardColumn==='active');await tick(300);
    await clickAction('pause','decision');await clickAction('standby','standby');
    f.host.querySelector('[aria-label="展开已归档列"]').click();await wait(()=>f.host.querySelector('.archive-expanded'));await tick(300);
    await clickAction('archive','archived');
    f.change('active');await wait(()=>card()?.dataset.cardColumn==='active'&&flight());
    const first=flight(),animation=first.getAnimations()[0];animation.pause();animation.currentTime=80;const interrupted=first.getBoundingClientRect();
    f.change('standby');await wait(()=>card()?.dataset.cardColumn==='standby'&&flight()!==first&&flight());
    measureFlight('interruptedFlight',interrupted);await tick(300);checks.latestStateConverged=!flight()&&card().style.opacity!=='0';
    f.remount();await wait(()=>card());await tick(40);checks.remountNoReplay=card().getAnimations().length===0&&!flight();
    f.reduce();f.change('active');await wait(()=>card()?.dataset.cardColumn==='active');await tick(40);checks.reducedDirect=!flight()&&card().getAnimations().length===0;
    return{checks,positions,errors:window.__fixtureErrors};
  })()`
})
assert.deepEqual(result.errors, [])
assert.deepEqual(Object.entries(result.checks).filter(([, passed]) => !passed), [], JSON.stringify(result.positions))
console.log('PASS real board action start/end coordinates, archive, interrupted flights, counts, snapshot stability, title updates, interaction and reduced motion')
