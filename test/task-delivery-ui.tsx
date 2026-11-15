import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'delivery-ui', {
  setup: `
    import {SessionTaskContent} from './src/renderer/components/TaskDetail';
    import {TurnStatusBar} from './src/renderer/components/EventStream';
    const session={id:'s',title:'交付与普通回答',status:'completed',createdAt:1,config:{agentId:'codex',model:'test',workdir:'/fixture'}};
    const events=[{sessionId:'s',seq:1,ts:1,type:'user_message',state:'success',payload:{text:'完成当前任务'}},{sessionId:'s',seq:2,ts:2,type:'agent_message',state:'success',payload:{text:'本轮回答内容'}}];
    let snapshot={record:{formatVersion:1,taskId:'s',version:1,phase:'active',inputRevision:'input',reports:[],history:[],operations:[]},inputRevision:'input',turnRevision:'turn',busy:false,pendingDecisions:0};
    const report={operationId:'agent-report',resultVersion:1,inputRevision:'input',summary:'队列恢复实现',deliverables:['实现与说明'],verification:{passed:['回归通过'],failed:[],unverified:['发布回归']},source:'agent',createdAt:1};snapshot.record.delivery=report;snapshot.record.reports=[report];
    const calls=[],updates=[];let rejectArchive=true;const publish=()=>{session.taskState={phase:snapshot.record.phase,version:snapshot.record.version,awaitingAcceptance:!!snapshot.record.delivery,updatedAt:2};updates.forEach(cb=>cb({session}))};publish();
    let rejectRestore=true;
    window.uniagent=new Proxy({getTaskState:async()=>structuredClone(snapshot),getTaskDecisions:async()=>[],onSessionUpdated:cb=>{updates.push(cb);return()=>{}},unarchiveSession:async id=>{calls.push({restore:id});if(rejectRestore)throw Error('恢复失败');snapshot.record.phase='active';snapshot.record.version++;publish()},decideTask:async(id,input)=>{calls.push({decision:input});if(input.disposition==='archive'&&rejectArchive)throw Error('任务仍在执行');snapshot=structuredClone(snapshot);snapshot.record.version++;snapshot.record.phase=input.disposition==='archive'?'archived':'standby';delete snapshot.record.delivery;publish();return structuredClone(snapshot)}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;width:1024px;height:640px;background:var(--bg);display:flex';
    const root=createRoot(host),render=()=>root.render(React.createElement(SessionTaskContent,{session,events,onArchived:()=>calls.push({closed:true}),composer:React.createElement(React.Fragment,null,React.createElement(TurnStatusBar,{events,status:session.status}),React.createElement('textarea',{defaultValue:'归档前的草稿'}))}));render();
    window.deliveryFixture={host,calls,render,allowArchive:()=>rejectArchive=false,allowRestore:()=>rejectRestore=false};
  `,
  inspect: `(async()=>{
    const f=window.deliveryFixture,tick=()=>new Promise(r=>setTimeout(r,20));const wait=async(p)=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('UI did not settle: '+f.host.textContent)},button=text=>[...f.host.querySelectorAll('button')].find(b=>b.textContent===text);
    await wait(()=>button('暂存')&&!button('暂存').disabled);
    const materials=!!f.host.querySelector('.task-optional-delivery'),manualEntry=!!f.host.querySelector('[aria-label="任务更多操作"],.task-delivery-form'),reportText=f.host.textContent.includes('队列恢复实现');
    button('暂存').click();await wait(()=>f.host.querySelector('.task-standby'));
    const phase=f.host.querySelector('.task-standby').textContent;
    const stream=f.host.querySelector('.event-stream');f.render();await tick();const stillStandby=!!f.host.querySelector('.task-standby'),sameStream=f.host.querySelector('.event-stream')===stream;
    button('完成').click();await wait(()=>f.host.querySelector('[role=alert]'));
    const afterFailure=!!f.host.querySelector('.task-standby'),closedOnFailure=f.calls.some(c=>c.closed);
    f.allowArchive();await wait(()=>!button('完成').disabled);button('完成').click();await wait(()=>f.calls.some(c=>c.closed));
    await wait(()=>button('恢复任务'));const input=f.host.querySelector('textarea'),archivedHidden=!input.checkVisibility();
    button('恢复任务').click();await wait(()=>f.host.textContent.includes('恢复失败'));const restoreFailure=!input.checkVisibility()&&f.host.querySelector('.event-stream')===stream;
    f.allowRestore();await wait(()=>!button('恢复任务').disabled);button('恢复任务').click();await wait(()=>!button('恢复任务')&&input.checkVisibility());
    const restored=f.host.querySelector('textarea')===input&&input.value==='归档前的草稿'&&f.host.querySelector('.event-stream')===stream;
    return {materials,manualEntry,reportText,phase,archivedHidden,restoreFailure,restored,stillStandby,sameStream,afterFailure,closedOnFailure,decision:f.calls[0].decision,noViewTabs:!f.host.querySelector('[role=tablist],.task-view-switch'),timeline:f.host.querySelector('.event-stream').textContent,overflow:f.host.scrollWidth>f.host.clientWidth};
  })()`
})
assert.equal(result.materials, false); assert.equal(result.manualEntry, false); assert.equal(result.reportText, false)
assert.match(result.phase, /已暂定，任务保留在待推进/); assert.equal(result.decision.disposition, 'standby'); assert.equal(result.decision.turnRevision, 'turn'); assert.ok(result.decision.actionId)
assert.equal(result.archivedHidden, true); assert.equal(result.restoreFailure, true); assert.equal(result.restored, true)
assert.equal(result.stillStandby, true); assert.equal(result.afterFailure, true); assert.equal(result.closedOnFailure, false); assert.equal(result.sameStream, true); assert.equal(result.noViewTabs, true)
assert.match(result.timeline, /完成当前任务/); assert.match(result.timeline, /本轮回答内容/); assert.doesNotMatch(result.timeline, /交付已验收|任务已归档/); assert.equal(result.overflow, false)
console.log('PASS unified conversation: defer, failed completion retention, archive, stable transcript and full input/answer history')
