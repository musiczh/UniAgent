import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-task-input-ui', {
  screenshot: process.env.UNIAGENT_ROUTER_TASK_SCREENSHOT ? { path: resolve(process.env.UNIAGENT_ROUTER_TASK_SCREENSHOT), width: 1100, height: 900 } : undefined,
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    localStorage.setItem('uniagent.mode','team');
    const projects=[{id:'default',name:'默认空间',primaryDirectory:'/fixture/default',additionalDirectories:[],isDefault:true},{id:'app',name:'应用空间',primaryDirectory:'/fixture/app',additionalDirectories:['/fixture/docs']}];
    const requirements=[{id:'req',name:'输入框需求',projectId:'app',status:'active'}];
    const makeAgent=(id,name)=>({id,name,adapter:id,installed:true,models:[{id:id+'-model',label:name+' Model',efforts:['high']}],capabilities:{modelSelect:true,reasoningEffort:true,imageAttachments:true,fileAttachments:true,permissionModes:[{id:'bypassPermissions',label:'完全访问'},{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}});
    const agents=[makeAgent('codex','Codex'),makeAgent('claude','Claude Code'),makeAgent('deepseek','DeepSeek Harness'),makeAgent('grok','Grok')];
    const prefs={lastAgentId:'codex',lastByAgent:{codex:{model:'codex-model',effort:'high',permissionMode:'bypassPermissions'},claude:{model:'claude-model',effort:'high',permissionMode:'ask'}}};
    let session={id:'router-session',title:'RouterAgent',createdAt:1,status:'running',config:{agentId:'deepseek',model:'deepseek-model',workdir:'/fixture',managedPurpose:'router'}};
    let snapshot={config:{enabled:true,agentId:'deepseek',model:'deepseek-model',version:1},available:true,sessionId:session.id,activeRequestId:'previous-input',requests:[]};
    const now=Date.now(),events=[{sessionId:session.id,seq:0,ts:now-21000,type:'user_message',payload:{text:'正在分配的任务'}},{sessionId:session.id,seq:1,ts:now-1000,type:'system_notice',payload:{id:'router-speed',kind:'token_speed',speed:{outputTokens:731,durationMs:10000,metric:'request',source:'router'}}}];
    const errors=[],submitted=[],cancelled=[],forbidden=[],listeners=new Set();let picked=[],interrupts=0,cancelFails=false,statusChange=()=>{},eventListener=()=>{};
    const changed=()=>listeners.forEach(callback=>callback());
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>prefs,setPrefs:async()=>prefs,getAppSettings:async()=>({defaultTaskWorktree:false}),listProjects:async()=>projects,listRequirements:async()=>requirements,listPresets:async()=>[],
      getPersonalAssistant:async()=>({assistant:{enabled:true}}),getRouterSnapshot:async()=>snapshot,openRouter:async()=>session,getEvents:async()=>events,
      onRouterChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},onStatusChange:callback=>{statusChange=callback;return()=>{}},onEvent:callback=>{eventListener=callback;return()=>{}},
      getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[],inspectionFailed:true,unavailableReason:'Git 或主目录检测失败，请检查后重试'}),getNativeCapabilities:async input=>({...emptyNativeCapabilitySnapshot(input.agentId,input.workdir),actions:{goal:true,plan:null,review:true}}),pickFiles:async()=>picked,
      submitRouterInput:input=>new Promise((resolve,reject)=>submitted.push({input,resolve:()=>{snapshot={...snapshot,requests:[...snapshot.requests,{...input,config:snapshot.config,state:'queued',version:1,createdAt:submitted.length,updatedAt:submitted.length}]};changed();resolve()},reject})),
      cancelRouterInput:async(id,version)=>{cancelled.push({id,version});if(cancelFails)throw Error('取消失败，输入仍在队列');snapshot={...snapshot,requests:snapshot.requests.map(row=>row.requestId===id?{...row,state:'cancelled',version:row.version+1}:row)};changed()},
      interruptRouter:async()=>{interrupts++},sendMessage:async()=>{forbidden.push('chat');throw Error('普通聊天禁止')},createSession:async()=>{forbidden.push('create');throw Error('必须经 Router 创建')}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';const root=createRoot(host);
    const props={agents,enabledAgentIds:['codex','claude','deepseek'],requirementsEnabled:true,onOpenTask:()=>{},onSettings:()=>{},mergeEvent:(events,event)=>[...events,event]};
    root.render(React.createElement(RouterPanel,props));
    window.taskInputFixture={host,errors,submitted,cancelled,forbidden,pick:file=>picked=[file],cancelFailure:value=>cancelFails=value,interrupts:()=>interrupts,renderAgents:agents=>root.render(React.createElement(RouterPanel,{...props,agents})),
      availability:value=>{snapshot={...snapshot,available:value,reason:value?undefined:'路由连接暂不可用'};changed()},
      finishRequests:()=>{snapshot={...snapshot,activeRequestId:undefined,requests:snapshot.requests.map(row=>({...row,state:'bound',routerSessionId:session.id,delivery:'accepted',version:row.version+1}))};changed()},
      requestState:(id,state,activeRequestId,queuedAt)=>{snapshot={...snapshot,activeRequestId,requests:snapshot.requests.map(row=>row.requestId===id?{...row,state,version:row.version+1,...(['routing','bound'].includes(state)?{routerSessionId:session.id}:{}),...(queuedAt===undefined?{}:{queuedAt})}:row)};changed()},
      running:()=>{session={...session,status:'running'};statusChange({sessionId:session.id,status:'running'})},
      idle:()=>{session={...session,status:'idle'};statusChange({sessionId:session.id,status:'idle'})},
      finishTurn:()=>{eventListener({sessionId:session.id,seq:2,ts:now,type:'turn_completed',state:'success',payload:{}});session={...session,status:'idle'};statusChange({sessionId:session.id,status:'idle'})}};
  `,
  inspect: `(async()=>{
    const f=window.taskInputFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,15));
    const wait=async predicate=>{for(let i=0;i<180;i++){if(predicate())return;await tick()}throw Error('Router task input timeout: '+f.errors+' / '+f.host.textContent)};
    await wait(()=>f.host.querySelector('.session-header'));for(let i=0;i<8;i++)await tick();
    const checks={newTaskComposer:!!f.host.querySelector('.new-task-send-btn')};if(!checks.newTaskComposer)return {checks,errors:f.errors};
    const send=()=>f.host.querySelector('.new-task-send-btn'),scope=()=>f.host.querySelector('.project-picker-trigger');
    const fill=async text=>{window.__markdownInput.fill(f.host,text);await tick()};
    const settle=()=>send().getAttribute('aria-label')==='新建任务';
    const add=async(name,kind='file')=>{f.pick({kind,path:'/fixture/'+name,name});f.host.querySelector('.sb-add summary').click();await tick();[...f.host.querySelectorAll('button')].find(row=>row.textContent.includes('添加附件')).click();await wait(()=>f.host.querySelector('[aria-label="移除 '+name+'"]'))};
    const shortcut=()=>window.__markdownInput.input(f.host).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true,cancelable:true}));
    const chooseScope=async label=>{if(!f.host.querySelector('.project-picker').open)scope().click();await wait(()=>f.host.querySelector('.project-picker-pop[data-positioned]'));[...f.host.querySelectorAll('.project-picker-list [role=option]')].find(row=>row.textContent.includes(label)).click();await tick()};
    await wait(()=>scope()?.textContent.includes('自动归属')&&f.host.querySelector('.router-task-composer .sb-agent')?.dataset.agentId==='codex');
    checks.taskButtonText=send().textContent.trim()==='新建任务';
    checks.emptyInputBlocked=send().disabled;
    checks.noHomeHero=!f.host.querySelector('.hero');
    checks.noChatControls=!f.host.querySelector('.composer-wrap');
    const timer=()=>f.host.querySelector('[data-router-conversation] .turn-timer'),stop=()=>f.host.querySelector('[aria-label="停止当前分配"]'),box=()=>f.host.querySelector('.router-task-composer .composer-box');
    await wait(()=>timer()?.textContent.includes('73.1'));
    const layouts=[];
    for(const width of [740,1000,1280]){
      f.host.style.width=width+'px';await tick();
      const capsule=timer().getBoundingClientRect(),button=stop().getBoundingClientRect(),input=box().getBoundingClientRect();
      layouts.push({width,timerGap:input.top-capsule.bottom,stopGap:input.top-button.bottom,centerOffset:(capsule.left+capsule.right-input.left-input.right)/2,overlap:capsule.right>button.left});
    }
    f.host.style.width='';await tick();
    checks.timerAndStopShareInputGap=layouts.every(row=>row.timerGap>0&&Math.abs(row.timerGap-row.stopGap)<1);
    checks.timerCenteredWithoutStopOverlap=layouts.every(row=>Math.abs(row.centerOffset)<1&&!row.overlap);
    const speedLabel=timer().querySelector('.turn-speed-label');
    checks.timerKeepsSpeedStyle=getComputedStyle(speedLabel).backgroundColor==='rgba(0, 0, 0, 0)'&&speedLabel.getBoundingClientRect().width>30;
    f.host.querySelector('.sb-add summary').click();await tick();checks.noNativeCommands=!f.host.querySelector('.sb-add').textContent.match(/Goal|Plan|Review|审查/);f.host.querySelector('.sb-add').removeAttribute('open');
    await fill('第一项新任务');await add('context.txt');await add('screenshot.png','image');
    if(send().disabled)throw Error('Git 检测失败不应阻止 RouterAgent 发送文字和图片');
    checks.noPrematureCreationError=!f.host.querySelector('[role=alert]');
    scope().click();await wait(()=>f.host.querySelector('.project-worktree-choice'));
    const worktree=f.host.querySelector('.project-worktree-choice');
    checks.automaticWorktreeAvailable=!worktree.disabled&&worktree.getAttribute('aria-checked')==='false';
    worktree.click();await tick();
    checks.automaticWorktreeSelected=worktree.getAttribute('aria-checked')==='true'&&!send().disabled&&!f.host.querySelector('[aria-label="新工作树的基准分支"]')&&f.host.querySelector('.project-worktree-hint').textContent.includes('分配后创建');
    worktree.click();await tick();checks.automaticWorktreeCanCancel=worktree.getAttribute('aria-checked')==='false';
    worktree.click();await tick();
    f.host.querySelector('.project-picker').removeAttribute('open');send().click();send().click();await wait(()=>f.submitted.length===1);
    checks.busySubmission=f.host.querySelector('.session-header')&&f.submitted[0].input.scope.kind==='global';
    checks.executionPreserved=f.submitted[0].input.execution.agentId==='codex'&&f.submitted[0].input.execution.model==='codex-model'&&f.submitted[0].input.execution.effort==='high'&&f.submitted[0].input.execution.permissionMode==='bypassPermissions';
    checks.attachmentPreserved=f.submitted[0].input.attachments[0].name==='context.txt';
    checks.imagePreserved=f.submitted[0].input.attachments[1].kind==='image'&&f.submitted[0].input.attachments[1].name==='screenshot.png';
    checks.automaticWorktreeSubmitted=f.submitted[0].input.execution.workspaceSelection.mode==='worktree'&&f.submitted[0].input.execution.workspaceSelection.baseRef==='HEAD'&&!!f.submitted[0].input.execution.workspaceSelection.requestId;
    checks.submissionLocked=send().disabled&&f.host.querySelector('.router-task-composer .sb-agent summary').getAttribute('aria-disabled')==='true';
    f.submitted[0].reject(Error('提交连接失败'));await wait(()=>settle()&&f.host.textContent.includes('提交连接失败'));
    checks.failureKeepsDraft=window.__markdownInput.text(f.host)==='第一项新任务'&&!!f.host.querySelector('[aria-label="移除 context.txt"]')&&!!f.host.querySelector('[aria-label="移除 screenshot.png"]');
    checks.actualSubmissionError=f.host.querySelector('[role=alert]').textContent.includes('创建任务失败：提交连接失败');
    send().click();await wait(()=>f.submitted.length===2);
    checks.retryIdempotent=f.submitted[0].input.requestId===f.submitted[1].input.requestId;
    checks.worktreeRetryIdempotent=f.submitted[0].input.execution.workspaceSelection.requestId===f.submitted[1].input.execution.workspaceSelection.requestId;
    await fill('下一项草稿');await add('next.txt');f.submitted[1].resolve();await wait(()=>settle()&&f.host.querySelectorAll('.queue-card').length===1);
    checks.pendingDraftPreserved=window.__markdownInput.text(f.host)==='下一项草稿'&&!f.host.querySelector('[aria-label="移除 context.txt"]')&&!!f.host.querySelector('[aria-label="移除 next.txt"]');
    send().click();await wait(()=>f.submitted.length===3);f.submitted[2].resolve();await wait(()=>settle()&&f.host.querySelectorAll('.queue-card').length===2);
    checks.successClearsDraft=window.__markdownInput.text(f.host)===''&&send().disabled&&!f.host.querySelector('.attach-bar');
    checks.independentInputs=f.submitted[2].input.requestId!==f.submitted[1].input.requestId&&f.submitted[2].input.prompt==='下一项草稿';
    checks.independentWorktrees=f.submitted[2].input.execution.workspaceSelection.requestId!==f.submitted[1].input.execution.workspaceSelection.requestId;
    checks.queueOrder=[...f.host.querySelectorAll('.queue-text')].map(row=>row.textContent).join('|')==='第一项新任务|下一项草稿';
    checks.queueHasNoChatActions=!f.host.querySelector('[aria-label="直接发送"], [aria-label="编辑等待消息"]');
    const queue=f.host.querySelector('.router-input-queue').getBoundingClientRect(),queuedTimer=timer().getBoundingClientRect(),queuedStop=stop().getBoundingClientRect(),queuedInput=box().getBoundingClientRect();
    checks.queueAboveTimerAndStop=queue.bottom<=Math.min(queuedTimer.top,queuedStop.top);
    checks.queuedTimerAndStopShareInputGap=Math.abs(queuedTimer.bottom-queuedStop.bottom)<1&&queuedInput.top-queuedTimer.bottom>0;
    await chooseScope('输入框需求');
    scope().click();await wait(()=>f.host.querySelector('.project-worktree-choice'));
    checks.manualNonGitStillBlocked=f.host.querySelector('.project-worktree-choice').disabled&&f.host.querySelector('.project-worktree-choice').getAttribute('aria-checked')==='false';
    f.host.querySelector('.project-picker').removeAttribute('open');
    await fill('需求中的新任务');send().click();await wait(()=>f.submitted.length===4);
    checks.requirementStillRoutes=f.submitted[3].input.scope.kind==='requirement'&&f.submitted[3].input.scope.requirementId==='req'&&f.submitted[3].input.execution.projectId==='app';
    f.submitted[3].resolve();await wait(()=>settle());await chooseScope('应用空间');
    const executor=f.host.querySelector('.router-task-composer .sb-agent');executor.querySelector('summary').click();await tick();
    checks.noTeamEntry=!executor.textContent.includes('专家团');
    [...executor.querySelectorAll('.sb-sub-entry')].find(row=>row.querySelector('.sb-entry-body')?.firstChild?.textContent.trim()==='Agent').click();await wait(()=>executor.querySelector('[role=option]'));
    checks.noAssistantEntry=!executor.textContent.includes('个人助手');checks.enabledAgentsHonored=!executor.textContent.includes('Grok');
    [...executor.querySelectorAll('[role=option]')].find(row=>row.textContent.includes('Claude Code')).click();await wait(()=>executor.dataset.agentId==='claude'&&executor.dataset.model==='claude-model');executor.removeAttribute('open');
    await fill('空间中的新任务');send().click();await wait(()=>f.submitted.length===5);
    checks.spaceStillRoutes=f.submitted[4].input.scope.kind==='space'&&f.submitted[4].input.scope.projectId==='app';
    checks.executorIndependent=f.submitted[4].input.execution.agentId==='claude'&&f.submitted[4].input.execution.permissionMode==='ask'&&f.submitted[4].input.execution.workdir==='/fixture/app'&&f.submitted[4].input.execution.additionalDirectories[0]==='/fixture/docs';
    f.submitted[4].resolve();await wait(()=>settle());
    f.cancelFailure(true);f.host.querySelector('[aria-label="取消待分配任务"]').click();await wait(()=>f.host.textContent.includes('取消失败，输入仍在队列'));
    checks.cancelFailureKeepsQueue=f.host.querySelectorAll('.queue-card').length===4;
    f.cancelFailure(false);f.host.querySelector('[aria-label="取消待分配任务"]').click();await wait(()=>f.host.querySelectorAll('.queue-card').length===3);
    checks.versionedCancellation=f.cancelled[1].id===f.submitted[1].input.requestId&&f.cancelled[1].version===1;
    f.host.querySelector('[aria-label="停止当前分配"]').click();await wait(()=>f.interrupts()===1);checks.separateInterrupt=true;
    await fill('暂存任务');f.availability(false);await wait(()=>send().disabled&&f.host.textContent.includes('路由连接暂不可用'));
    checks.unavailableKeepsDraft=window.__markdownInput.text(f.host)==='暂存任务';
    shortcut();await tick();checks.unavailableShortcutBlocked=f.submitted.length===5;
    f.availability(true);await wait(()=>!send().disabled);f.idle();await tick();
    send().click();await wait(()=>f.submitted.length===6);checks.idleStillRoutes=f.submitted[5].input.scope.kind==='space';f.submitted[5].resolve();await wait(()=>settle());
    await add('image.png','image');await wait(()=>!send().disabled);shortcut();await wait(()=>f.submitted.length===7);
    checks.imageOnlyShortcutRoutes=f.submitted[6].input.prompt===''&&f.submitted[6].input.attachments[0].kind==='image';f.submitted[6].resolve();await wait(()=>settle()&&send().disabled);
    await fill('重复内容');send().click();await wait(()=>f.submitted.length===8);f.submitted[7].resolve();await wait(()=>settle()&&send().disabled);
    await fill('重复内容');send().click();await wait(()=>f.submitted.length===9);f.submitted[8].resolve();await wait(()=>settle()&&send().disabled);
    checks.identicalNewTasksIndependent=f.submitted[7].input.requestId!==f.submitted[8].input.requestId;
    f.finishRequests();await wait(()=>!f.host.querySelector('.router-input-queue'));
    const card=id=>f.host.querySelector('[data-router-request="'+id+'"]');
    const queueText=()=>[...f.host.querySelectorAll('.router-input-queue .queue-text')].map(row=>row.textContent);
    const queueFrames=[],observer=new MutationObserver(()=>queueFrames.push(!!f.host.querySelector('.router-input-queue')));
    observer.observe(f.host,{childList:true,subtree:true});
    await fill('空闲直接分配');send().click();await wait(()=>f.submitted.length===10);const direct=f.submitted[9].input.requestId;
    f.submitted[9].resolve();await wait(()=>settle());for(let i=0;i<8;i++)await tick();
    checks.idleFirstHasNoWaitingCard=!card(direct);
    checks.idleSubmissionNoQueue=!f.host.querySelector('.router-input-queue');
    f.running();await tick();checks.statusBeforeSnapshotNoQueue=!f.host.querySelector('.router-input-queue');
    f.requestState(direct,'routing',direct);await wait(()=>card(direct)?.textContent.includes('正在分配'));await tick();
    observer.disconnect();checks.directSubmissionNeverFlashesQueue=queueFrames.length>0&&!queueFrames.some(Boolean);
    await fill('等待前项分配');send().click();await wait(()=>f.submitted.length===11);const next=f.submitted[10].input.requestId;
    f.submitted[10].resolve();await wait(()=>settle()&&queueText().length===1);
    checks.busyQueueExcludesActive=queueText().join('|')==='等待前项分配';
    await fill('第三项分配');send().click();await wait(()=>f.submitted.length===12);const last=f.submitted[11].input.requestId;
    f.submitted[11].resolve();await wait(()=>settle()&&queueText().length===2);
    checks.busyQueueStillFIFO=queueText().join('|')==='等待前项分配|第三项分配';
    f.requestState(direct,'bound',undefined);f.idle();await wait(()=>card(direct).textContent.includes('分配成功'));await tick();
    checks.nextInputLeavesQueueWhenSlotFree=queueText().join('|')==='第三项分配';
    f.requestState(next,'routing',next);await wait(()=>card(next)?.textContent.includes('正在分配'));await tick();
    checks.startingNextKeepsOnlyLaterInput=queueText().join('|')==='第三项分配';
    f.requestState(next,'bound',last);await wait(()=>card(next).textContent.includes('分配成功'));await tick();
    checks.activeIdentityExcludesStaleQueuedInput=!f.host.querySelector('.router-input-queue');
    f.requestState(direct,'queued','another-active-input',1000);await wait(()=>queueText().length===2);
    checks.clarificationQueueUsesNewPosition=queueText().join('|')==='第三项分配|空闲直接分配';
    scope().click();await wait(()=>f.host.querySelector('.scope-picker-auto'));f.host.querySelector('.scope-picker-auto').click();await tick();
    checks.automaticChoiceSurvivesManualScope=scope().textContent.includes('自动归属')&&scope().textContent.includes('工作树');
    await fill('执行方离线时保留草稿');f.renderAgents([]);await wait(()=>send().disabled&&f.host.textContent.includes('暂无可用的执行 Agent'));
    checks.executorUnavailableKeepsComposer=!!f.host.querySelector('.router-task-composer')&&window.__markdownInput.text(f.host)==='执行方离线时保留草稿';
    shortcut();await tick();checks.executorUnavailableCannotSubmit=f.submitted.length===12;
    checks.noPlainChatOrDirectCreation=f.forbidden.length===0;
    f.finishTurn();await wait(()=>timer()?.classList.contains('st-done')&&!stop());
    const doneTimer=timer().getBoundingClientRect(),doneInput=box().getBoundingClientRect();
    checks.completedTimerStaysAboveInput=Math.abs(doneInput.top-doneTimer.bottom-layouts[0].timerGap)<1&&Math.abs((doneTimer.left+doneTimer.right-doneInput.left-doneInput.right)/2)<1;
    return {checks,layouts,errors:f.errors};
  })()`
})

assert.deepEqual(result.errors, [])
assert.deepEqual(Object.entries(result.checks).filter(([, passed]) => !passed).map(([name]) => name), [], JSON.stringify(result.layouts))
console.log('PASS Router task input: shared new-task composer, execution choices, scoped FIFO inputs, retry identity, draft retention, cancellation and routing-only behavior')
