import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-question-resume-ui', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const agent={id:'codex',adapter:'codex',name:'Codex',installed:true,defaultModel:'model',models:[{id:'model',label:'当前模型',efforts:[]},{id:'alternative',label:'备选模型',efforts:[]}],capabilities:{modelSelect:true,permissionModes:[{id:'ask',label:'询问'},{id:'bypassPermissions',label:'完全访问'}]},lifecycle:{availability:'available'}};
    const config={enabled:true,agentId:'codex',model:'model',version:1},session={id:'router-questions',title:'RouterAgent',createdAt:1,status:'awaiting-approval',config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}};
    const request={requestId:'clarify',routerSessionId:session.id,prompt:'原始任务',config,state:'needs_input',delivery:'pending',version:4,createdAt:2,scope:{kind:'global'},decision:{action:'clarify',reason:'需要明确归属',clarification:'属于哪个空间？'},question:'属于哪个空间？'};
    let requests=[request,{...request,requestId:'configure',version:7,decision:{action:'create_task_in_space',projectId:'default',reason:'已经确定归属'},question:'请选择任务的 Agent、模型与权限。'}],feedbackPrompts=[];
    const events=[{sessionId:session.id,seq:0,ts:1,type:'user_message',payload:{text:'当前分配请求'}},{sessionId:session.id,seq:1,ts:2,type:'approval_request',state:'pending',payload:{requestId:'native-model-choice',kind:'question',method:'item/tool/requestUserInput',params:{questions:[{id:'model_choice',header:'模型选择',prompt:'继续使用哪个模型？',options:[{label:'使用推荐模型'},{label:'保留当前模型'}]}]}}}];
    const native=[],resolutions=[],submissions=[],errors=[],listeners=new Set();
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>({lastAgentId:'codex',lastByAgent:{codex:{permissionMode:'bypassPermissions'}}}),setPrefs:async()=>{},getAppSettings:async()=>({defaultTaskWorktree:false}),
      listProjects:async()=>[{id:'default',name:'默认空间',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true}],listRequirements:async()=>[],listPresets:async()=>[],getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[]}),getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir),
      getRouterSnapshot:async()=>({config,available:true,sessionId:session.id,requests,feedbackPrompts}),onRouterChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},openRouter:async()=>session,getEvents:async()=>events,
      getRouterReview:async()=>({request,attemptId:'feedback-attempt',revision:0,attempts:[],feedbackHistory:[]}),dismissRouterFeedback:async()=>{feedbackPrompts=[];listeners.forEach(callback=>callback())},
      respondRequest:(sessionId,requestId,answer)=>new Promise((resolve,reject)=>native.push({sessionId,requestId,answer,resolve,reject})),
      resolveRouterInput:input=>new Promise((resolve,reject)=>resolutions.push({input,reject,resolve:()=>{requests=requests.map(row=>row.requestId===input.requestId?{...row,state:input.action==='answer'?'queued':'bound',version:row.version+1,question:undefined}:row);listeners.forEach(callback=>callback());resolve()}})),
      submitRouterInput:async input=>{submissions.push(input)}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';createRoot(host).render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:(events,event)=>[...events,event]}));
    window.resumeFixture={host,native,resolutions,submissions,errors,showFeedback:()=>{feedbackPrompts=[{requestId:request.requestId,attemptId:'feedback-attempt',endedAt:Date.now()+30000}];listeners.forEach(callback=>callback())}};
  `,
  inspect: `(async()=>{
    const f=window.resumeFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,15)),wait=async check=>{for(let i=0;i<180;i++){if(check())return;await tick()}throw Error('Router question resume timeout: '+f.host.textContent+' / '+f.errors)};
    await wait(()=>f.host.querySelector('.new-task-send-btn')&&f.host.querySelector('[data-router-request="clarify"]'));for(let i=0;i<5;i++)await tick();
    const checks={nativeQuestionsReplyable:!!f.host.querySelector('.interaction-dock .question-form')};if(!checks.nativeQuestionsReplyable)return{checks,errors:f.errors};
    const composer=f.host.querySelector('.router-task-composer');window.__markdownInput.fill(composer,'独立的新任务草稿');await tick();
    f.showFeedback();await tick();await wait(()=>f.host.querySelector('.router-inline-feedback .router-feedback-form'));const feedback=f.host.querySelector('.router-inline-feedback');
    checks.feedbackDoesNotCoverQuestion=!!feedback.closest('.router-assignment')&&getComputedStyle(feedback).position==='static'&&!f.host.querySelector('.router-feedback-prompt')&&!!f.host.querySelector('.interaction-dock .question-form');
    const dock=f.host.querySelector('.interaction-dock'),radio=dock.querySelector('input[type=radio]');radio.click();await tick();dock.querySelector('.question-form .btn-send').click();await wait(()=>f.native.length===1);
    checks.nativeTargetsOriginalSession=f.native[0].sessionId==='router-questions'&&f.native[0].requestId==='native-model-choice';
    checks.nativeSelectionRoundTrips=f.native[0].answer.answers.model_choice.answers[0]==='使用推荐模型';
    f.native[0].reject(Error('回答提交失败'));await wait(()=>dock.textContent.includes('回答提交失败'));
    checks.failureKeepsNativeChoice=radio.checked;dock.querySelector('.question-form .btn-send').click();await wait(()=>f.native.length===2);f.native[1].resolve();await wait(()=>!f.host.querySelector('.interaction-dock .question-form'));
    checks.nativeAnswerDoesNotCreateTask=f.submissions.length===0&&f.resolutions.length===0;
    const card=f.host.querySelector('[data-router-request="clarify"]');card.querySelector('input[type=radio]').click();await tick();
    const answer=card.querySelector('[aria-label="补充路由信息"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(answer,'属于默认空间');answer.dispatchEvent(new Event('input',{bubbles:true}));await tick();
    [...card.querySelectorAll('button')].find(row=>row.textContent==='继续分配').click();await wait(()=>f.resolutions.length===1);
    checks.clarificationTargetsOriginalRequest=f.resolutions[0].input.requestId==='clarify'&&f.resolutions[0].input.expectedVersion===4&&f.resolutions[0].input.action==='answer'&&f.resolutions[0].input.answer==='属于默认空间';
    f.resolutions[0].reject(Error('路由回答失败'));await wait(()=>card.textContent.includes('操作暂未完成，请重试。'));checks.failureKeepsClarification=answer.value==='属于默认空间';
    [...card.querySelectorAll('button')].find(row=>row.textContent==='继续分配').click();await wait(()=>f.resolutions.length===2);f.resolutions[1].resolve();await wait(()=>!f.host.querySelector('[data-router-request="clarify"] [aria-label="补充路由信息"]'));
    const config=f.host.querySelector('[data-router-request="configure"]'),picker=config.querySelector('.run-config-picker');picker.querySelector('summary').click();await tick();
    [...picker.querySelectorAll('.sb-sub-entry')].find(row=>row.querySelector('.sb-entry-body')?.firstChild?.textContent==='模型').click();await tick();
    [...picker.querySelectorAll('[role=option]')].find(row=>row.textContent==='备选模型').click();await tick();
    [...config.querySelectorAll('button')].find(row=>row.textContent==='确认并创建').click();await wait(()=>f.resolutions.length===3);
    checks.modelChoiceTargetsOriginalRequest=f.resolutions[2].input.requestId==='configure'&&f.resolutions[2].input.expectedVersion===7&&f.resolutions[2].input.action==='configure'&&f.resolutions[2].input.execution.agentId==='codex'&&f.resolutions[2].input.execution.model==='alternative'&&f.resolutions[2].input.execution.permissionMode==='ask';
    f.resolutions[2].reject(Error('执行配置提交失败'));await wait(()=>config.textContent.includes('操作暂未完成，请重试。'));
    checks.failureKeepsModelChoice=picker.querySelector('summary').textContent.includes('备选模型');
    [...config.querySelectorAll('button')].find(row=>row.textContent==='确认并创建').click();await wait(()=>f.resolutions.length===4);
    checks.modelRetryKeepsRequest=f.resolutions[3].input.requestId==='configure'&&f.resolutions[3].input.expectedVersion===7&&f.resolutions[3].input.execution.model==='alternative';
    f.resolutions[3].resolve();await wait(()=>!config.querySelector('.router-execution'));
    checks.originalDraftUnaffected=window.__markdownInput.text(composer)==='独立的新任务草稿'&&f.submissions.length===0;
    composer.querySelector('.new-task-send-btn').click();await wait(()=>f.submissions.length===1);checks.onlyNewTaskUsesNewRequest=f.submissions[0].prompt==='独立的新任务草稿'&&!['clarify','configure','native-model-choice'].includes(f.submissions[0].requestId);
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS Router question resume: native model choices, scoped clarification/configuration replies, failed-answer drafts and independent new tasks')
