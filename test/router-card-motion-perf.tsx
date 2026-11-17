import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Diagnostic measurement for the RouterAgent assignment-card slide-up entrance.
// Prints frame pacing, long tasks, forced-layout reads and observer churn for a
// realistic transcript; asserts only sanity so it stays machine-independent.
const result = await renderEventStream([], 'idle', 'router-card-motion-perf', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    const match=window.matchMedia.bind(window);window.matchMedia=q=>q.includes('prefers-reduced-motion')?{matches:false,addEventListener(){},removeEventListener(){}}:match(q);
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[{id:'ask',label:'询问'}]}};
    const session={id:'router',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}},config={enabled:true,agentId:'codex',model:'model',version:1};
    const routerChanges=new Set(),eventCbs=new Set(),statusCbs=new Set();
    const codeBlock=Array.from({length:36},(_,l)=>'  const step'+l+' = await pipeline.run({ input, scope: "global", index: '+l+' })').join('\\n');
    const md=i=>'## 第 '+i+' 轮归属判断\\n\\n本轮处理第 '+i+' 个业务对象的归属判断，结合项目负责的系统范围与近期改动确认目标。需要核对需求与任务的对应关系，检查已有会话是否覆盖本次输入，并确认执行配置与权限档位。结论应当复用已有任务并追加本轮输入，保留原始配置与登录态。\\n\\n- 核对需求与任务的对应关系\\n- 检查已有会话是否覆盖本次输入\\n- 确认执行配置与权限档位\\n- 校验目标任务的运行状态\\n\\n\`\`\`ts\\n'+codeBlock+'\\n\`\`\`\\n\\n| 项目 | 需求 | 任务 | 状态 |\\n| --- | --- | --- | --- |\\n| 项目'+i+' | 需求'+i+' | 任务'+i+' | 运行中 |\\n\\n结论：复用已有任务并追加本轮输入，保留原始配置与登录态。';
    const history=[];let seq=1;const now=Date.now();
    for(let i=0;i<80;i++){
      const rid=i<3?'old'+i:undefined;
      history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000,type:'user_message',payload:{text:'请处理第 '+i+' 项业务输入',displayText:'请处理第 '+i+' 项业务输入',clientTurnKey:'t'+i,...(rid?{routedInputId:rid}:{})}});
      history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000+1,type:'turn_started',payload:{turnId:'nt'+i}});
      history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000+2,type:'reasoning',state:'success',payload:{id:'r'+i,text:'先识别业务对象，再核对项目与需求归属。'}});
      if(rid)history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000+3,type:'tool_call',state:'success',payload:{id:'tc'+i,name:'router_assign_task',input:{requestId:rid},result:{ok:true}}});
      history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000+4,type:'agent_message',state:'success',payload:{id:'m'+i,text:md(i),phase:'final_answer'}});
      history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000+5,type:'turn_completed',state:'success',payload:{turnId:'nt'+i}});
      history.push({sessionId:'router',seq:seq++,ts:now-(80-i)*60000+6,type:'system_notice',payload:{kind:'usage',usage:{inputTokens:1200,outputTokens:340,cachedInputTokens:800,cost:0.01}}});
    }
    const bound=i=>({requestId:'old'+i,routerSessionId:'router',scope:{kind:'global'},config,version:2,state:'bound',delivery:'accepted',createdAt:now-(80-i)*60000,updatedAt:now-(80-i)*60000+5000,prompt:'请处理第 '+i+' 项业务输入',targetId:'task'+i,targetTitle:'业务任务 '+i,projectName:'项目',requirementName:'需求',decision:{action:'reuse_task',taskId:'task'+i,reason:'目标一致，复用已有任务'},timing:{queuedAt:now-(80-i)*60000,startedAt:now-(80-i)*60000+1000,elapsedMs:4000,stoppedAt:now-(80-i)*60000+5000}});
    let requests=[bound(0),bound(1),bound(2)];
    const changed=()=>routerChanges.forEach(cb=>cb());
    const base={requestId:'next',routerSessionId:'router',scope:{kind:'global'},config,version:1,state:'routing',delivery:'pending',createdAt:Date.now(),updatedAt:Date.now(),prompt:'精简分配中的任务卡片',timing:{queuedAt:Date.now()-2000,startedAt:Date.now()-1000,runningSince:Date.now()-1000,elapsedMs:0}};
    window.addEventListener('error',e=>(window.__fixtureErrors.push(e.message)));
    window.uniagent=new Proxy({getRouterReview:async id=>({request:{requestId:id},revision:0,attempts:[],feedbackHistory:[]}),homeDir:'/fixture',getPrefs:async()=>({lastAgentId:'codex',lastByAgent:{codex:{model:'model',permissionMode:'ask'}}}),setPrefs:async()=>{},getAppSettings:async()=>({}),listProjects:async()=>[],listRequirements:async()=>[],listPresets:async()=>[],getPersonalAssistant:async()=>undefined,getNativeCapabilities:async i=>emptyNativeCapabilitySnapshot(i.agentId,i.workdir),getTurnArtifactSummary:async()=>null,getRouterSnapshot:async()=>({config,available:true,sessionId:'router',requests}),openRouter:async()=>session,getEvents:async id=>id==='router'?history:[],onRouterChanged:cb=>{routerChanges.add(cb);return()=>routerChanges.delete(cb)},onEvent:cb=>{eventCbs.add(cb);return()=>eventCbs.delete(cb)},onStatusChange:cb=>{statusCbs.add(cb);return()=>statusCbs.delete(cb)},resolveRouterInput:async()=>{}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const P={gBCR:{n:0,ms:0},scroll:{n:0,ms:0},MO:{n:0,ms:0},RO:{n:0,ms:0},longtasks:[]};
    const time=(bucket,fn)=>{const t=performance.now();const r=fn();const b=P[bucket];b.n++;b.ms+=performance.now()-t;return r};
    const gbcr=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){return time('gBCR',()=>gbcr.call(this))};
    for(const proto of [Element.prototype,HTMLElement.prototype])for(const prop of ['scrollHeight','clientHeight','offsetHeight','offsetTop']){const d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.get)continue;Object.defineProperty(proto,prop,{...d,get(){return time('scroll',()=>d.get.call(this))}})}
    const NMO=window.MutationObserver;window.MutationObserver=class extends NMO{constructor(cb){super((...a)=>time('MO',()=>cb(...a)))}};
    const NRO=window.ResizeObserver;window.ResizeObserver=class extends NRO{constructor(cb){super((...a)=>time('RO',()=>cb(...a)))}};
    new PerformanceObserver(list=>{for(const e of list.getEntries())P.longtasks.push({start:Math.round(e.startTime),dur:Math.round(e.duration)})}).observe({type:'longtask',buffered:true});
    P.reset=()=>{for(const k of ['gBCR','scroll','MO','RO'])P[k]={n:0,ms:0};P.longtasks=[]};
    P.record=ms=>new Promise(resolve=>{const frames=[];let last=performance.now();const t0=last;const loop=t=>{frames.push(t-last);last=t;if(t-t0<ms)requestAnimationFrame(loop);else resolve(frames)};requestAnimationFrame(loop)});
    P.stats=frames=>{const s=[...frames].sort((a,b)=>a-b);const sum=frames.reduce((a,b)=>a+b,0);return{frames:frames.length,meanMs:+(sum/frames.length).toFixed(1),p95Ms:+(s[Math.floor(s.length*.95)]||0).toFixed(1),maxMs:+(s.at(-1)||0).toFixed(1),over25:frames.filter(d=>d>25).length,over50:frames.filter(d=>d>50).length}};
    P.snapshot=()=>({gBCR:{n:P.gBCR.n,ms:+P.gBCR.ms.toFixed(1)},scroll:{n:P.scroll.n,ms:+P.scroll.ms.toFixed(1)},MO:{n:P.MO.n,ms:+P.MO.ms.toFixed(1)},RO:{n:P.RO.n,ms:+P.RO.ms.toFixed(1)},longtasks:P.longtasks.slice(),longtaskMs:P.longtasks.reduce((a,b)=>a+b.dur,0),domNodes:document.getElementsByTagName('*').length});
    window.__perf=P;
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;width:1000px;height:700px';
    const root=createRoot(host);root.render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));
    let liveSeq=10000;
    window.cardMotion={host,
      add:id=>{requests=[...requests,{...base,requestId:id,createdAt:Date.now(),updatedAt:Date.now()}];changed()},
      bind:id=>{requests=requests.map(r=>r.requestId===id?{...r,version:r.version+1,state:'bound',delivery:'accepted',targetId:'task-new',targetTitle:'真实任务',projectName:'项目',requirementName:'需求',decision:{action:'reuse_task',taskId:'task-new',reason:'目标一致，复用已有任务'},timing:{...r.timing,elapsedMs:3000,stoppedAt:Date.now()}}:r);changed()},
      stream:(ms,interval)=>{statusCbs.forEach(cb=>cb({sessionId:'router',status:'running'}));const t0=Date.now();let k=0;const timer=setInterval(()=>{k++;const text='正在核对第 '+k+' 条归属证据，结合项目范围与任务历史判断。'.repeat(Math.min(k,12));const emit=e=>setTimeout(()=>eventCbs.forEach(cb=>cb(e)),0);emit({sessionId:'router',seq:liveSeq++,ts:Date.now(),type:'reasoning',state:'running',payload:{id:'live-r',text}});emit({sessionId:'router',seq:liveSeq++,ts:Date.now(),type:'agent_message',state:'running',payload:{id:'live-m',text}});if(k%4===0)emit({sessionId:'router',seq:liveSeq++,ts:Date.now(),type:'tool_call',state:'running',payload:{id:'live-t'+k,name:'read_file',input:{path:'/fixture/'+k}}});if(Date.now()-t0>ms){clearInterval(timer);eventCbs.forEach(cb=>cb({sessionId:'router',seq:liveSeq++,ts:Date.now(),type:'agent_message',state:'success',payload:{id:'live-m',text,phase:'final_answer'}}));statusCbs.forEach(cb=>cb({sessionId:'router',status:'idle'}))}},interval)},
    };
  `,
  inspect: `(async()=>{const f=window.cardMotion,P=window.__perf;const tick=ms=>new Promise(r=>setTimeout(r,ms||15));const wait=async p=>{for(let i=0;i<240;i++){if(p())return;await tick()}throw Error('perf fixture timeout: '+window.__fixtureErrors)};
    await wait(()=>f.host.querySelector('.event-stream'));await tick(400);
    const streamEl=f.host.querySelector('.router-list-view .event-stream');
    const transcript={rows:streamEl?streamEl.children.length:0,bubbles:f.host.querySelectorAll('.bubble').length,cards:f.host.querySelectorAll('.router-assignment').length,scrollHeight:streamEl?streamEl.scrollHeight:0,clientHeight:streamEl?streamEl.clientHeight:0,markdown:f.host.querySelectorAll('.agent-md').length};
    const card=id=>f.host.querySelector('[data-router-request="'+id+'"]');
    const scenarios={};
    P.reset();f.add('next');const fa=await P.record(700);await wait(()=>card('next')&&card('next').style.height==='');await tick(120);
    scenarios.idleEntrance={...P.stats(fa),...P.snapshot()};
    P.reset();f.add('mid');await tick(120);const midHeight=card('mid')?card('mid').getBoundingClientRect().height:-1;await tick(400);const fullHeight=card('mid')?card('mid').getBoundingClientRect().height:-1;
    scenarios.entranceShape={midHeight,fullHeight,animating:midHeight>0&&midHeight<fullHeight};
    P.reset();f.bind('next');const fb=await P.record(600);await tick(200);
    scenarios.bindGrow={...P.stats(fb),...P.snapshot()};
    P.reset();f.add('live');f.stream(650,16);const fc=await P.record(700);await wait(()=>card('live')&&card('live').style.height==='');await tick(250);
    scenarios.streamingEntrance={...P.stats(fc),...P.snapshot()};
    P.reset();f.stream(650,16);const fd=await P.record(700);await tick(250);
    scenarios.streamingOnly={...P.stats(fd),...P.snapshot()};
    return{transcript,scenarios,errors:window.__fixtureErrors}})()`
})
assert.deepEqual(result.errors, [])
for (const [name, data] of Object.entries(result.scenarios)) {
  if (data.frames !== undefined) assert.ok(data.frames > 10, `${name}: frames recorded`)
}
assert.equal(result.scenarios.entranceShape.animating, true, 'entrance animates from partial to full height')
console.log('Router card motion performance report (software rendering, hidden window):')
console.log('transcript:', JSON.stringify(result.transcript))
console.log(JSON.stringify(result.scenarios, null, 2))
console.log('PASS Router card motion perf measurement completed without renderer errors')