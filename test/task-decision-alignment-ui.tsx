import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Measure the actual task actions beside the timer, retaining the original input.
for (const size of [{ width: 1800, height: 1000 }, { width: 1360, height: 900 }, { width: 1024, height: 640 }]) {
  const result = await renderEventStream([], 'idle', 'task-decision-alignment', {
    screenshot: { ...size, path: resolve('out/test/task-decision-alignment-' + size.width + '.png') },
    setup: `
      import {SessionTaskContent} from './src/renderer/components/TaskDetail';
      import {Composer} from './src/renderer/components/Composer';
      import {TurnStatusBar} from './src/renderer/components/EventStream';
      const errors=[],calls=[];let finishDecision;
      window.addEventListener('error',e=>errors.push(e.message));
      window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      const session={id:'alignment',title:'实现作者任务页面',status:'completed',createdAt:1,
        config:{agentId:'codex',workdir:'/fixture'},
        submittedUserMessages:[{type:'user_message',userOrdinal:1,acceptedAt:1,textHash:'input'}]};
      const row=(seq,type,payload)=>({sessionId:session.id,seq,ts:seq,type,state:'success',payload});
      let events=[row(1,'user_message',{text:'对齐任务操作与耗时胶囊'}),
        row(2,'agent_message',{text:'已完成当前任务。'}),
        row(3,'system_notice',{kind:'token_speed',id:'speed',speed:{outputTokens:409,durationMs:10000,
          metric:'request',source:'native timing',model:'test'}})];
      const timedEvents=events;
      let snapshot={record:{formatVersion:1,taskId:session.id,version:1,phase:'active',inputRevision:'input',reports:[],history:[],operations:[]},
        inputRevision:'input',turnRevision:'turn',busy:false,pendingDecisions:0};
      window.uniagent=new Proxy({getTaskState:async()=>structuredClone(snapshot),getTaskDecisions:async()=>[],listPresets:async()=>[],
        decideTask:async(id,input)=>{calls.push({id,input});await new Promise(resolve=>finishDecision=resolve);
          snapshot.record.phase=input.disposition==='archive'?'archived':'standby';snapshot.record.version++;return structuredClone(snapshot)}},
        {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>null});
      const capabilities={agentId:'codex',workdir:'/fixture',source:'native',candidates:[],errors:[],actions:{goal:false,review:false,plan:null}};
      const host=document.body.appendChild(document.createElement('div'));
      host.className='session-view';host.style.cssText='position:fixed;left:300px;right:0;top:0;bottom:0;background:var(--bg)';
      const root=createRoot(host);
      const render=()=>root.render(React.createElement(SessionTaskContent,{session,status:session.status,events,
        composer:React.createElement(React.Fragment,null,
          React.createElement(TurnStatusBar,{events,status:session.status}),
          React.createElement(Composer,{sessionId:session.id,status:session.status,config:session.config,
          queue:[],capabilities,capabilitiesReady:true,contextUsed:0,contextWindow:0,
          onSend:()=>{},onForceSend:()=>{},onInterrupt:()=>{},onUpdateConfig:()=>{},onSetCollaborationMode:()=>{},
          onRunNativeAction:()=>{},onDequeue:()=>{},onPromoteQueue:()=>{},onEditQueueItem:()=>{}}))
      },React.createElement(EventStream,{events,status:session.status,sessionId:session.id,onRespond:async()=>{}})));
      render();
      window.alignmentFixture={host,errors,calls,finishDecision:()=>finishDecision(),rerender:render,setPhase:phase=>{snapshot.record.phase=phase==='error'?'active':phase;snapshot.record.version++;
          session.status=phase==='error'?'error':'completed';session.taskState={phase:phase==='error'?'active':phase,version:snapshot.record.version,updatedAt:2};render()},
        setReadOnly:value=>{session.readOnly=value;render()},setBusy:value=>{snapshot.busy=value;session.status=value?'running':'completed';render()},
        setTiming:value=>{events=value?timedEvents:[];render()},
        setDelivery:enabled=>{snapshot.record.delivery=enabled?{summary:'较长的交付与验证材料',deliverables:Array.from({length:80},(_,i)=>'交付项 '+i),
          verification:{passed:['相关回归通过'],failed:[],unverified:['发布回归']}}:undefined;
          snapshot.record.version++;session.taskState={phase:snapshot.record.phase,version:snapshot.record.version,updatedAt:3};render()}};
    `,
    inspect: `(async()=>{
      const f=window.alignmentFixture,tick=()=>new Promise(r=>setTimeout(r,20));
      const wait=async p=>{for(let i=0;i<100;i++){if(p())return;await tick()}throw Error('task layout did not settle: '+f.host.textContent)};
      const bounds=el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom,height:r.height}};
      await wait(()=>f.host.querySelector('.task-decision-actions button:not(:disabled)')&&f.host.querySelector('.composer-wrap'));
      const composer=f.host.querySelector('.composer-wrap');
      const measure=()=>({actions:bounds(f.host.querySelector('.task-decision-actions')),
        buttons:[...f.host.querySelectorAll('.task-decision-actions button')].map(button=>({...bounds(button),disabled:button.disabled})),
        timer:bounds(f.host.querySelector('.turn-timer')),composer:bounds(composer),
        sameBar:f.host.querySelector('.task-decision-actions').parentElement===f.host.querySelector('.turn-timer').parentElement,
        count:f.host.querySelectorAll('.composer-wrap').length,overflow:f.host.scrollWidth>f.host.clientWidth});
      const completed=measure();
      f.rerender();await tick();const sameComposer=f.host.querySelector('.composer-wrap')===composer;
      f.setPhase('standby');await wait(()=>f.host.querySelector('.task-standby'));const standby=measure();
      f.setPhase('error');await wait(()=>f.host.querySelector('.task-decision-actions button')?.textContent==='关闭任务');const error=measure();
      f.setPhase('active');await wait(()=>f.host.querySelector('.task-decision-actions button')?.textContent==='暂存');
      f.setDelivery(true);await tick();await tick();
      const longDelivery=measure(),materialsAbsent=!f.host.querySelector('.task-optional-delivery,.task-delivery-form'),
        manualEntryAbsent=!f.host.querySelector('[aria-label="任务更多操作"]');
      const noTaskTabs=!f.host.querySelector('[role=tablist],.task-view-switch,.task-timeline');
      f.setTiming(false);await tick();
      const noTimingActions=f.host.querySelectorAll('.task-decision-actions button:not(:disabled)').length,
        noFakeTimer=!f.host.querySelector('.turn-timer');
      f.setTiming(true);await tick();
      f.setReadOnly(true);await tick();
      const readOnlyDisabled=[...f.host.querySelectorAll('.task-decision-actions button')].every(button=>button.disabled);
      f.setReadOnly(false);await tick();f.setBusy(true);await tick();
      const hiddenWhileBusy=!f.host.querySelector('.task-decision-actions');
      f.setBusy(false);await wait(()=>f.host.querySelector('.task-decision-actions button:not(:disabled)'));
      f.host.querySelector('.task-decision-actions button').click();await wait(()=>f.calls.length===1);
      const pendingDisabled=[...f.host.querySelectorAll('.task-decision-actions button')].every(button=>button.disabled);
      f.host.querySelector('.task-decision-actions button').click();
      const noDuplicate=f.calls.length===1;
      f.finishDecision();await wait(()=>f.host.querySelector('.task-standby'));
      f.host.querySelector('.task-decision-actions .primary').click();await wait(()=>f.calls.length===2);
      f.finishDecision();await wait(()=>f.host.textContent.includes('任务已归档'));
      const hiddenWhenArchived=!f.host.querySelector('.task-decision-actions');
      f.setPhase('active');await wait(()=>f.host.querySelector('.task-decision-actions button:not(:disabled)'));
      return{completed,standby,error,longDelivery,materialsAbsent,manualEntryAbsent,noTaskTabs,
        readOnlyDisabled,hiddenWhileBusy,pendingDisabled,noDuplicate,hiddenWhenArchived,calls:f.calls,
        noTimingActions,noFakeTimer,
        sameComposer,errors:f.errors,host:bounds(f.host)};
    })()`
  })
  assert.deepEqual(result.errors, [], 'no renderer errors at ' + size.width)
  for (const phase of ['completed', 'standby', 'error', 'longDelivery']) {
    const layout = result[phase]
    const label = phase + ' at ' + size.width + ': ' + JSON.stringify(layout)
    assert.equal(layout.sameBar, true, 'actions share the actual timer bar, ' + label)
    assert.ok(layout.actions.left > layout.timer.right && layout.actions.left - layout.timer.right <= 10, 'actions immediately follow the capsule, ' + label)
    for (const button of layout.buttons) {
      assert.ok(Math.abs(button.top - layout.timer.top) < 1 && Math.abs(button.bottom - layout.timer.bottom) < 1, 'each action matches the capsule height, ' + label)
    }
    assert.ok(layout.actions.right <= layout.composer.right, 'actions stay within the input column, ' + label)
    assert.ok(layout.timer.bottom <= layout.composer.top, 'timer and actions stay above the input, ' + label)
    assert.equal(layout.count, 1, 'one original composer, ' + label)
    assert.equal(layout.overflow, false, 'no horizontal overflow, ' + label)
    assert.ok(layout.composer.left > result.host.left && layout.composer.right < result.host.right, 'keep outer gutters, ' + label)
  }
  assert.equal(result.sameComposer, true)
  assert.equal(result.noTaskTabs, true)
  assert.ok(Math.abs((result.completed.timer.left + result.completed.actions.right) / 2 - (result.completed.composer.left + result.completed.composer.right) / 2) < 1, 'timer and actions are centered together')
  assert.equal(result.completed.buttons.length, 2)
  assert.equal(result.standby.buttons.length, 1, 'disabled standby action is hidden')
  assert.equal(result.standby.buttons[0].disabled, false)
  assert.equal(result.error.buttons.length, 1)
  assert.equal(result.readOnlyDisabled, true)
  assert.equal(result.hiddenWhileBusy, true)
  assert.equal(result.pendingDisabled, true)
  assert.equal(result.noDuplicate, true)
  assert.equal(result.hiddenWhenArchived, true)
  assert.equal(result.noTimingActions, 2, 'missing timing must not remove the original decision operations')
  assert.equal(result.noFakeTimer, true)
  assert.deepEqual(result.calls.map(call=>[call.id,call.input.disposition]), [['alignment','standby'],['alignment','archive']])
  assert.ok(result.calls.every(call=>call.input.actionId && call.input.inputRevision==='input' && call.input.turnRevision==='turn'))
  assert.equal(result.materialsAbsent, true)
  assert.equal(result.manualEntryAbsent, true)
  console.log('PASS task actions beside the capsule, equal heights, original input and state visibility at ' + size.width + 'px')
}
