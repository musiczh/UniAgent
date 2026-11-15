import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-decisions-ui', {
  setup: `
    import {TaskDecisions,useTaskDecisions} from './src/renderer/components/TaskDecisions';
    import {projectTaskDecisions} from './src/shared/taskDecisions';
    const session={id:'s',title:'集中处理',status:'running',createdAt:1,config:{agentId:'codex',model:'test',workdir:'/fixture'}};
    const approval={sessionId:'s',seq:1,ts:1,type:'approval_request',state:'pending',payload:{requestId:'native-1',kind:'command',method:'item/commandExecution/requestApproval',params:{command:'pnpm run test:startup',cwd:'/fixture',reason:'验证创建恢复'}}};
    const question={sessionId:'s',seq:2,ts:2,type:'agent_message',state:'success',payload:{id:'q',delivery:'async',questions:[{id:'scope',question:'确认范围？',options:[{label:'App 内流程'},{label:'增加飞书'}],allowOther:true}]}};
    let events=[approval,question], offline=false;const calls=[],listeners=[];
    window.uniagent=new Proxy({getTaskDecisions:async()=>{if(offline)throw Error('offline');return projectTaskDecisions(session,events)},resolveTaskDecision:async(id,input)=>{calls.push({id,input});events=events.filter(e=>e.seq!==1);listeners.forEach(cb=>cb({sessionId:'s',type:'approval_request',payload:{}}))},onEvent:cb=>{listeners.push(cb);return()=>{};}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;width:1024px;height:640px;background:var(--bg);display:flex';
    function Fixture(){const decisions=useTaskDecisions(session.id,true,session.status);return React.createElement(TaskDecisions,{session,items:decisions.items,error:decisions.error,onRefresh:decisions.refresh,onOpenConversation:()=>calls.push({conversation:true})})}
    const root=createRoot(host);root.render(React.createElement(Fixture));
    window.decisionFixture={host,calls,listeners,offline:()=>{offline=true;listeners.forEach(cb=>cb({sessionId:'s',type:'approval_request',payload:{}}))},unknown:()=>{offline=false;events=[{...approval,payload:{...approval.payload,taskResponseState:'unknown'}}];listeners.forEach(cb=>cb({sessionId:'s',type:'approval_request',payload:{}}))},plan:()=>{events=[{...approval,payload:{requestId:'plan-confirmation:sample',kind:'planMode',method:'local/plan',params:{plan:'实现当前已确认范围'}}}];listeners.forEach(cb=>cb({sessionId:'s',type:'approval_request',payload:{}}))}};
  `,
  inspect: `(async()=>{
    const f=window.decisionFixture,tick=()=>new Promise(r=>setTimeout(r,20));const wait=async(p)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('UI did not settle: '+f.host.textContent)};
    // Side-source decisions continue to use the existing focused native form.
    await wait(()=>f.host.querySelector('.task-decision .appr-accept'));
    const oneExpanded=f.host.querySelectorAll('.task-decision').length===1&&!f.host.querySelector('.task-decision .question-form');
    const material=f.host.querySelector('.task-decision-body').textContent;
    f.host.querySelector('.task-decision .appr-accept').click();await wait(()=>f.calls.length===1&&f.host.querySelector('.task-decision .question-form'));
    const asyncState=f.host.querySelector('.task-decision-head').textContent;
    f.offline();await wait(()=>f.host.querySelector('[role=alert]'));
    const offline={kept:!!f.host.querySelector('.task-decision'),editable:f.host.querySelectorAll('.task-decision .question-form input:not(:disabled)').length};
    f.unknown();await wait(()=>f.host.textContent.includes('处理结果待确认'));
    const unknown={noApprove:!f.host.querySelector('.task-decision .appr-accept'),refresh:[...f.host.querySelectorAll('button')].some(b=>b.textContent==='刷新状态')};
    f.plan();await wait(()=>f.host.querySelector('.plan-decision-actions .primary'));
    const planText=f.host.querySelector('.task-decision-body').textContent;
    f.host.querySelector('.plan-decision-actions .primary').click();await wait(()=>f.calls.length===2);
    return {oneExpanded,material,asyncState,call:f.calls[0],plan:f.calls[1].input.answer,planText,offline,unknown,overflow:f.host.scrollWidth>f.host.clientWidth};
  })()`
})
assert.equal(result.oneExpanded, true)
assert.match(result.material, /pnpm run test:startup/); assert.match(result.material, /验证创建恢复/)
assert.equal(result.call.id, 's'); assert.equal(result.call.input.answer.decision, 'accept'); assert.ok(result.call.input.actionId)
assert.match(result.asyncState, /任务仍可继续执行/)
assert.deepEqual(result.offline, { kept: true, editable: 0 })
assert.deepEqual(result.unknown, { noApprove: true, refresh: true })
assert.deepEqual(result.plan, { decision: 'approved' }); assert.match(result.planText, /实现当前已确认范围/)
assert.equal(result.overflow, false)
console.log('PASS R07 one focused native form, actual approval payload, asynchronous question, local read failure and unknown response lock')
