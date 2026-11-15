import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-side-decision', {
  setup: `
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';import {projectTaskDecisions} from './src/shared/taskDecisions';
    const session={id:'s',title:'侧边来源审批',status:'idle',createdAt:1,config:{agentId:'codex',workdir:'/fixture'}};
    const request={sessionId:'s',seq:2,ts:2,type:'approval_request',state:'pending',payload:{requestId:'native-side',kind:'command',params:{command:'printf SIDE_OK',cwd:'/fixture'}}};let pending=true;const calls=[],listeners=[];
    window.uniagent=new Proxy({getTaskDecisions:async()=>projectTaskDecisions(session,[],pending?[request]:[]),resolveTaskDecision:async(id,input)=>{calls.push({id,input});pending=false;listeners.forEach(cb=>cb({sessionId:'s',event:request}))},onSideEvent:cb=>{listeners.push(cb);return()=>{}}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;display:flex;background:var(--bg)';
    createRoot(host).render(React.createElement(SessionTaskContent,{session,events:[],children:React.createElement('div',{className:'original-main-stream'},'原主对话没有侧边审批')}));window.sideFixture={host,calls};
  `,
  inspect: `(async()=>{const f=window.sideFixture,tick=()=>new Promise(r=>setTimeout(r,20));for(let i=0;i<100&&!f.host.querySelector('.appr-accept');i++)await tick();const button=f.host.querySelector('.appr-accept');if(!button)throw Error('side request disappeared behind the main conversation slot');const text=f.host.textContent;button.click();for(let i=0;i<100&&!f.calls.length;i++)await tick();return{text,call:f.calls[0]}})()`
})
assert.match(result.text, /SIDE_OK/); assert.match(result.text, /侧边对话/)
assert.equal(result.call.id, 's'); assert.equal(result.call.input.answer.decision, 'accept')
assert.match(result.call.input.id, /side/)
console.log('PASS side-source native approval remains actionable when reusing the original main conversation and composer')

const isolation = await renderEventStream([], 'idle', 'task-side-switch', {
  setup: `
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';import {projectTaskDecisions} from './src/shared/taskDecisions';
    let session={id:'first',title:'第一项',status:'completed',createdAt:1,config:{agentId:'codex',workdir:'/fixture'}};
    const request=id=>({sessionId:id,seq:2,ts:2,type:'approval_request',state:'pending',payload:{requestId:'side-'+id,kind:'command',params:{command:'printf '+id}}});
    let finish;window.uniagent=new Proxy({getTaskDecisions:id=>id==='first'?Promise.resolve(projectTaskDecisions(session,[],[request(id)])):new Promise(resolve=>finish=()=>resolve(projectTaskDecisions({...session,id},[],[request(id)])))},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host),render=()=>root.render(React.createElement(SessionTaskContent,{session,events:[],composer:React.createElement('textarea',{defaultValue:'保留输入'})}));render();
    window.switchFixture={host,second:()=>{session={...session,id:'second'};render()},managed:()=>{session={...session,id:'managed',config:{...session.config,managedPurpose:'router'}};render()},finish:()=>finish()};
  `,
  inspect: `(async()=>{const f=window.switchFixture,tick=()=>new Promise(r=>setTimeout(r,20)),wait=async p=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('switch fixture timeout')};await wait(()=>f.host.querySelector('.appr-accept'));f.second();await wait(()=>f.host.querySelector('[data-task-id=second]'));const secondAbsent=!f.host.querySelector('.task-decision');f.managed();await wait(()=>f.host.querySelector('[data-task-id=managed]'));const managedAbsent=!f.host.querySelector('.task-decision');f.finish();await tick();await tick();return{secondAbsent,managedAbsent,lateAbsent:!f.host.querySelector('.task-decision'),composer:f.host.querySelector('textarea').value}})()`
})
assert.deepEqual(isolation, { secondAbsent: true, managedAbsent: true, lateAbsent: true, composer: '保留输入' })
console.log('PASS switching tasks or managed conversations never shows another task’s pending side approval or its late response')
