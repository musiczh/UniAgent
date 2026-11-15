import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result=await renderEventStream([], 'idle', 'router-timing', {
  setup:`
    import {RouterAssignmentCard} from './src/renderer/components/RouterAssignmentCard';
    let now=21000;Date.now=()=>now;
    const timers=new Map();let timerId=0;
    window.setInterval=callback=>{const id=++timerId;timers.set(id,callback);return id};
    window.clearInterval=id=>timers.delete(id);
    const base={requestId:'timed',prompt:'增加分配用时',scope:{kind:'global'},config:{},version:1,state:'routing',delivery:'pending',createdAt:1000,updatedAt:13000,
      timing:{queuedAt:1000,startedAt:13000,runningSince:13000,elapsedMs:0}};
    let current={...base},frozen;
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;padding:20px';let root=createRoot(host);
    const props={agents:[],resolve:async()=>{},openTask:()=>{}};
    const render=()=>root.render(<>{frozen&&<RouterAssignmentCard {...props} request={frozen} clarification={{id:'old-round',answeredAt:84000,answer:'归入现有需求',snapshot:frozen}}/>}<RouterAssignmentCard {...props} request={current}/></>);
    render();
    window.timingFixture={host,timers,advance:ms=>{now+=ms;for(const callback of [...timers.values()])callback()},
      finish:()=>{current={...current,state:'bound',delivery:'accepted',timing:{...current.timing,elapsedMs:11000,runningSince:undefined,stoppedAt:now}};render()},
      remount:()=>{root.unmount();root=createRoot(host);render()},
      clarifyAgain:()=>{frozen={...current,state:'needs_input'};now=88000;current={...base,roundId:'next',timing:{queuedAt:84000,startedAt:86000,runningSince:86000,elapsedMs:0}};render()},
      legacy:()=>{frozen=undefined;current={...base,state:'bound',timing:undefined};render()},
      long:()=>{current={...base,state:'bound',timing:{queuedAt:1000,startedAt:62000,elapsedMs:3723000,stoppedAt:3785000}};render()},
      waiting:()=>{current={...base,state:'queued',autoRecovery:{attempts:1,total:1,nextAt:now+2000,reason:'准备重试'},timing:{queuedAt:now-5000,elapsedMs:0}};render()},
      cancel:()=>{current={...current,state:'cancelled',autoRecovery:undefined,timing:{...current.timing,stoppedAt:now}};render()},
      backwards:()=>{current={...base,timing:{queuedAt:now+2000,startedAt:now+1000,runningSince:now+1000,elapsedMs:0}};render()},
      unmount:()=>root.unmount()};
  `,
  inspect:`(async()=>{
    const f=window.timingFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,15)),wait=async check=>{for(let i=0;i<100;i++){if(check())return;await tick()}throw Error('timing UI timeout: '+f.host.textContent)};
    const current=()=>f.host.querySelector('.router-assignment:not([data-router-clarification]) .router-assignment-time');
    await wait(()=>!!current());await tick();
    const initial=current().textContent,status=current().previousElementSibling;
    const placement=current().parentElement.tagName==='HEADER'&&status.classList.contains('router-assignment-status')&&current().getBoundingClientRect().left>=status.getBoundingClientRect().right;
    const noBodyField=![...f.host.querySelectorAll('dt')].some(row=>row.textContent==='分配用时');
    f.advance(3000);await wait(()=>current().textContent.includes('11 秒'));const live=current().textContent;
    f.finish();await wait(()=>!f.host.querySelector('.router-assignment-status.working')&&f.timers.size===0);const completed=current().textContent;
    f.advance(60000);await tick();const fixed=current().textContent===completed;
    f.remount();await wait(()=>current()?.textContent===completed);const restored=current().textContent;
    f.clarifyAgain();await wait(()=>f.host.querySelectorAll('.router-assignment').length===2&&f.timers.size===1);
    const old=f.host.querySelector('[data-router-clarification] .router-assignment-time').textContent,newRound=current().textContent;
    f.advance(4000);await wait(()=>current().textContent.includes('6 秒'));const frozen=f.host.querySelector('[data-router-clarification] .router-assignment-time').textContent===old;
    f.legacy();await wait(()=>current().textContent.includes('未记录')&&f.timers.size===0);const legacy=current().textContent;
    f.long();await wait(()=>current().textContent.includes('小时'));const long=current().textContent;
    f.waiting();await wait(()=>current().textContent.includes('等待 5 秒'));f.advance(2000);await wait(()=>current().textContent.includes('等待 7 秒'));const waiting=current().textContent;
    f.cancel();await wait(()=>f.timers.size===0);const cancelled=current().textContent;f.advance(5000);await tick();const cancelFixed=current().textContent===cancelled;
    f.backwards();await wait(()=>current().textContent.includes('分配中 0 秒'));const backwards=current().textContent;
    f.unmount();await tick();return{initial,placement,noBodyField,live,completed,fixed,restored,old,newRound,frozen,legacy,long,waiting,cancelFixed,backwards,timers:f.timers.size,errors:window.__fixtureErrors};
  })()`
})
assert.equal(result.initial,'等待 12 秒 · 分配中 8 秒')
assert.equal(result.placement,true,'timing is immediately to the right of status in the card header')
assert.equal(result.noBodyField,true,'the card body retains its original fields')
assert.equal(result.live,'等待 12 秒 · 分配中 11 秒')
assert.equal(result.completed,'等待 12 秒 · 分配 11 秒')
assert.equal(result.fixed,true,'completed timing does not grow')
assert.equal(result.restored,result.completed,'remount preserves completed elapsed time')
assert.equal(result.old,result.completed)
assert.equal(result.newRound,'等待 2 秒 · 分配中 2 秒')
assert.equal(result.frozen,true,'later rounds cannot grow the frozen clarification time')
assert.equal(result.legacy,'等待未记录 · 分配未记录')
assert.equal(result.long,'等待 1 分 1 秒 · 分配 1 小时 2 分 3 秒')
assert.equal(result.waiting,'等待 7 秒 · 分配未开始')
assert.equal(result.cancelFixed,true,'cancellation also freezes waiting before a first attempt')
assert.equal(result.backwards,'等待 0 秒 · 分配中 0 秒')
assert.equal(result.timers,0,'unmount disposes the active refresh timer')
assert.deepEqual(result.errors,[])
console.log('PASS Router timing UI: header placement, live tick, completion freeze, restored rounds, missing data and clock boundaries')
