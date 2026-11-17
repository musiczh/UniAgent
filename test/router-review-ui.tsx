import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

const inputLimit = await renderEventStream([], 'idle', 'router-review-input-limit', {
  setup: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {RouterReviewPanel} from './src/renderer/components/RouterReviewPanel';
    const prompts=[
      '哈喽同学，我是ByteTech的运营。\\n\\n'+('请优化文章并参考 https://bytetech.info/articles/7708654986028122146 。\\n').repeat(30),
      '文'.repeat(120), '文'.repeat(119)+'😀后', '第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行\\n第七行', '短输入', ''
    ];
    const rows=prompts.map((prompt,index)=>({request:{requestId:'input-'+index,prompt,createdAt:1,state:'bound',delivery:'finished',decision:{action:'reuse_task',reason:'第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行\\n第七行'}},deletable:true,revision:0,attemptId:'attempt-'+index}));
    const api={listRouterReviews:async()=>({rows,total:rows.length,deletableCount:rows.length,counts:{all:rows.length,unrated:rows.length,bad:0,good:0}}),getRouterReview:async id=>({...rows.find(row=>row.request.requestId===id),attempts:[],feedbackHistory:[]}),getRouterReviewTargets:async()=>[]};
    window.uniagent=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.className='settings-inner';host.style.cssText='position:fixed;left:0;top:0;width:1100px;height:900px;overflow:auto';createRoot(host).render(React.createElement(RouterReviewPanel,{onBack:()=>{}}));
    window.inputLimitFixture={host,prompts};
  `,
  inspect: `(async()=>{
    const f=window.inputLimitFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async predicate=>{for(let i=0;i<180;i++){if(predicate())return;await tick()}throw Error('input limit UI timeout')};
    await wait(()=>f.host.querySelectorAll('.router-review-table-row').length===f.prompts.length);
    const rows=[...f.host.querySelectorAll('.router-review-table-row')],text=index=>rows[index].querySelector('.router-review-check-cell>div').firstChild.textContent;
    const checks={longTruncated:Array.from(text(0)).length===121&&text(0).endsWith('…'),exactLimitUnchanged:text(1)===f.prompts[1],unicodeBoundary:text(2)==='文'.repeat(119)+'😀…',multilineUnchanged:text(3)===f.prompts[3],shortUnchanged:text(4)===f.prompts[4],emptyUnchanged:text(5)===''};
    const input=row=>row.querySelector('.router-review-input-text')||row.querySelector('.router-review-check-cell>div'),reason=rows[3].querySelector('.router-review-reason-text'),lineHeight=parseFloat(getComputedStyle(reason).lineHeight);
    checks.sameHeight=Math.abs(input(rows[3]).getBoundingClientRect().height-reason.getBoundingClientRect().height)<1&&Math.abs(reason.getBoundingClientRect().height-lineHeight*5)<1;
    for(const width of [1100,450]){
      f.host.style.width=width+'px';await new Promise(resolve=>requestAnimationFrame(resolve));
      checks['boundedAt'+width]=rows.every(row=>input(row).getBoundingClientRect().height<=lineHeight*5+1);
      checks['dateOutsideAt'+width]=rows.every(row=>row.querySelector('small').getBoundingClientRect().top>=input(row).getBoundingClientRect().bottom);
    }
    rows[0].querySelector('button').click();await wait(()=>f.host.querySelector('.router-review-card dd'));
    checks.detailPreservesFullInput=f.host.querySelector('.router-review-card dd').textContent===f.prompts[0];
    return {checks,errors:window.__fixtureErrors};
  })()`
})
for (const [name, passed] of Object.entries(inputLimit.checks)) assert.equal(passed, true, name)
assert.deepEqual(inputLimit.errors, [])
console.log('PASS Router review input: character boundary, Unicode, shared five-line height, narrow columns, separate timestamps and full detail')

const result = await renderEventStream([], 'idle', 'router-review-ui', {
  screenshot: process.env.UNIAGENT_ROUTER_REVIEW_SCREENSHOT ? { path: resolve(process.env.UNIAGENT_ROUTER_REVIEW_SCREENSHOT), width: 1100, height: 900 } : undefined,
  setup: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {RouterReviewPanel} from './src/renderer/components/RouterReviewPanel';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {RouterSettings} from './src/renderer/components/RouterSettings';
    import {RequirementTaskSettings} from './src/renderer/components/RequirementTaskSettings';
    const id='11111111-1111-4111-8111-111111111111',attempt='22222222-2222-4222-8222-222222222222',nextId='33333333-3333-4333-8333-333333333333',nextAttempt='44444444-4444-4444-8444-444444444444',thirdId='55555555-5555-4555-8555-555555555555',thirdAttempt='66666666-6666-4666-8666-666666666666';
    const config={enabled:true,agentId:'deepseek',model:JSON.stringify(['deepseek-official','deepseek-flash']),effort:'max',version:1};
    const agents=[{id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',installed:true,defaultModel:config.model,models:[{id:config.model,label:'Flash',efforts:['max'],contextWindow:1000000}],capabilities:{protocol:'web',auxiliarySystemPrompt:true,modelSelect:true,reasoningEffort:true,permissionModes:[{id:'read-only',label:'只读'}]},lifecycle:{availability:'available'}}];
    const request={requestId:id,prompt:'继续修复图片漏显',scope:{kind:'global'},config,version:4,state:'bound',delivery:'finished',createdAt:1,updatedAt:2,targetId:'original',targetTitle:'原任务',projectName:'UniAgent',requirementName:'图片恢复',decision:{action:'reuse_task',taskId:'original',reason:'同一目标'}};
    let stored={request,deletable:true,revision:0,attemptId:attempt,feedback:undefined,traceAvailable:true,attempts:[{id:attempt,startedAt:1,endedAt:2,result:request}],feedbackHistory:[]},failSave=false;
    let snapshot={config,available:true,requests:[request],sessionId:'router-fixed',feedbackPrompts:[]};
    const saves=[],copies=[],errors=[],queries=[],listeners=new Set(),confirmations=[];
    window.confirm=message=>{confirmations.push(message);return true};window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    const diagnostics={reasoning:'provided',sections:[{title:'当时的候选快照',text:JSON.stringify({objects:[{title:'原任务',summary:'继续修复图片漏显'}]},null,2)}]};
    const api={getRouterSnapshot:async()=>snapshot,onRouterChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},getRouterReview:async(requestId,attemptId,logs)=>requestId===id?{...stored,...(logs?{diagnostics}:{})}:{request:{...request,requestId,prompt:'新的路由 '+requestId.slice(0,1)},revision:0,attemptId,traceAvailable:true,attempts:[{id:attemptId,startedAt:3,endedAt:4}],feedbackHistory:[]},
      listRouterReviews:async query=>{queries.push(query);return {rows:query.filter==='unrated'?[]:[stored],total:query.filter==='unrated'?0:1,deletableCount:1,counts:{all:1,unrated:stored.feedback?0:1,bad:stored.feedback?.matches===false?1:0,good:stored.feedback?.matches===true?1:0}}},
      getRouterReviewTargets:async()=>[{id:'ua',kind:'space',title:'UniAgent'},{id:'android',kind:'space',title:'Android'},{id:'history',kind:'requirement',title:'图片恢复',projectId:'ua'},{id:'original',kind:'task',title:'原任务',projectId:'ua',requirementId:'history'},{id:'direct',kind:'task',title:'空间直属任务',projectId:'ua'},{id:'android-task',kind:'task',title:'Android 任务',projectId:'android'}],
      saveRouterFeedback:async input=>{saves.push(input);if(failSave)throw Error('fixture write failed');if(input.expectedRevision!==stored.revision)throw Error('反馈已变化');stored={...stored,revision:stored.revision+1,feedback:{...input,revision:stored.revision+1,savedAt:3,actual:request}};return stored},
      copyRouterReviewPrompt:async value=>{copies.push(value);return {directory:'/fixture/exports',count:1}},
      openRouter:async()=>({id:'router-fixed',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'deepseek',model:config.model,effort:'max',workdir:'/fixture',managedPurpose:'router'}}),
      getEvents:async()=>[{sessionId:'router-fixed',seq:0,ts:1,type:'user_message',payload:{text:request.prompt}},{sessionId:'router-fixed',seq:1,ts:2,type:'tool_call',state:'success',payload:{name:'router_assign_task',input:{requestId:id}}},{sessionId:'router-fixed',seq:2,ts:3,type:'agent_message',payload:{text:'已分配',phase:'final_answer'}},{sessionId:'router-fixed',seq:3,ts:4,type:'turn_completed',state:'success',payload:{}}],getPrefs:async()=>({lastByAgent:{}})};
    window.uniagent=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.className='settings-inner';host.style.cssText='position:fixed;left:0;top:0;width:1100px;height:900px;overflow:auto';const root=createRoot(host);root.render(React.createElement(RouterReviewPanel,{onBack:()=>{}}));
    const panelHost=document.body.appendChild(document.createElement('div')),panelRoot=createRoot(panelHost);panelHost.style.cssText='position:fixed;left:0;top:0;width:1100px;height:650px;visibility:hidden';panelRoot.render(React.createElement(RouterPanel,{agents,onOpenTask:()=>{},onSettings:()=>{},mergeEvent:(events,event)=>[...events,event]}));
    const settingsHost=document.body.appendChild(document.createElement('div')),settingsRoot=createRoot(settingsHost),settingsOpens=[];settingsRoot.render(React.createElement(RouterSettings,{agents,onReview:()=>settingsOpens.push(true)}));
    const embeddedOuter=document.body.appendChild(document.createElement('div'));embeddedOuter.className='settings-inner';embeddedOuter.style.visibility='hidden';const embeddedHost=embeddedOuter.appendChild(document.createElement('div'));embeddedHost.className='set-content';embeddedHost.style.cssText='width:1000px;height:300px;overflow:auto';const embeddedGuard={current:null};createRoot(embeddedHost).render(React.createElement(RequirementTaskSettings,{agents,settings:{router:config,taskTitleGeneration:{enabled:false},quickRepliesEnabled:false},navigationGuard:embeddedGuard}));
    window.reviewFixture={host,panelHost,settingsHost,settingsOpens,embeddedHost,embeddedGuard,saves,copies,errors,confirmations,queries,id,attempt,nextId,nextAttempt,thirdId,thirdAttempt,conflict:()=>{stored={...stored,revision:stored.revision+1,feedback:{...stored.feedback,reason:'另一个入口已保存'}}},fail:value=>failSave=value,push:third=>{const now=Date.now(),prompts=[{requestId:nextId,attemptId:nextAttempt,prompt:'新的路由 3',endedAt:now}];if(third)prompts.push({requestId:thirdId,attemptId:thirdAttempt,prompt:'新的路由 5',endedAt:now});snapshot={...snapshot,feedbackPrompts:prompts};for(const listener of listeners)listener()}};
  `,
  inspect: `(async()=>{
    const f=window.reviewFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async predicate=>{for(let i=0;i<180;i++){if(predicate())return;await tick()}throw Error('feedback UI timeout: '+f.errors)},button=(host,label)=>[...host.querySelectorAll('button')].find(row=>row.textContent.trim()===label),change=(element,value)=>{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value').set;setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}))};
    await wait(()=>button(f.host,'详情与反馈'));button(f.host,'详情与反馈').click();await wait(()=>f.host.querySelector('.router-feedback-form'));
    const cards=f.host.querySelectorAll('.router-review-card'),a=cards[0].getBoundingClientRect(),b=cards[1].getBoundingClientRect(),singleColumn=b.top>a.bottom&&a.left===b.left&&a.width===b.width,svgReturn=!!f.host.querySelector('.set-back svg');
    const initiallyDisabled=button(f.host,'保存反馈').disabled;button(f.host,'不符合预期').click();await tick();const optionalEmptyAllowed=!button(f.host,'保存反馈').disabled;
    f.fail(true);button(f.host,'保存反馈').click();await wait(()=>f.host.textContent.includes('fixture write failed'));
    change(f.host.querySelector('.router-feedback-form textarea'),'继续原任务，不应另建');button(f.host,'分析日志').click();await wait(()=>f.host.querySelector('.router-review-logs details'));button(f.host,'用户反馈').click();await tick();const draftRetained=f.host.querySelector('.router-feedback-form textarea').value==='继续原任务，不应另建';
    f.fail(false);button(f.host,'保存反馈').click();await wait(()=>f.host.textContent.includes('反馈已保存到本地'));
    button(f.host,'在项目或需求下创建任务').click();await tick();button(f.host.querySelector('.router-feedback-form'),'需求').click();await tick();change(f.host.querySelector('[aria-label="预期新建任务归属"]'),'history');button(f.host.querySelector('.router-feedback-form'),'项目').click();await tick();const ownerCleared=f.host.querySelector('[aria-label="预期新建任务归属"]').value==='';button(f.host,'保存反馈').click();await tick();await wait(()=>f.saves.length===3&&button(f.host,'保存反馈')&&!button(f.host,'保存反馈').disabled);
    button(f.host,'继续某个已有任务').click();await tick();change(f.host.querySelector('[aria-label="预期任务项目"]'),'ua');await tick();change(f.host.querySelector('[aria-label="预期任务需求"]'),'history');await tick();change(f.host.querySelector('[aria-label="预期继续任务"]'),'original');await tick();change(f.host.querySelector('[aria-label="预期任务项目"]'),'android');await tick();const dependentTargetsCleared=f.host.querySelector('[aria-label="预期任务需求"]').value===''&&f.host.querySelector('[aria-label="预期继续任务"]').value==='';button(f.host,'保存反馈').click();await tick();await wait(()=>f.saves.length===4&&button(f.host,'保存反馈')&&!button(f.host,'保存反馈').disabled);
    button(f.host,'需要新建需求').click();await tick();const newRequirementHasNoTargets=f.host.querySelectorAll('.router-feedback-form select').length===0;button(f.host,'保存反馈').click();await tick();await wait(()=>f.saves.length===5&&button(f.host,'保存反馈')&&!button(f.host,'保存反馈').disabled);button(f.host,'返回列表').click();await wait(()=>f.host.querySelector('.router-review-table'));button(f.host,'一键复制优化 Prompt').click();await wait(()=>f.copies.length===1);
    button(f.host,'详情与反馈').click();await wait(()=>f.host.querySelector('.router-feedback-form textarea'));change(f.host.querySelector('.router-feedback-form textarea'),'本地未保存的原因');await tick();f.conflict();button(f.host,'保存反馈').click();await wait(()=>button(f.host,'重新读取反馈'));const conflictRetainsDraft=f.host.querySelector('.router-feedback-form textarea').value==='本地未保存的原因';button(f.host,'重新读取反馈').click();await wait(()=>f.host.querySelector('.router-feedback-form textarea').value==='另一个入口已保存');const conflictReloaded=f.confirmations.length===1;
    button(f.settingsHost,'路由记录与反馈查看历史输入与分配结果，记录预期并复制优化提示词。').click();
    const configToggle=f.embeddedHost.querySelector('[aria-label="启用 RouterAgent"]');configToggle.click();await tick();f.embeddedHost.scrollTop=120;const configScroll=f.embeddedHost.scrollTop;button(f.embeddedHost,'路由记录与反馈查看历史输入与分配结果，记录预期并复制优化提示词。').click();await wait(()=>f.embeddedHost.querySelector('.router-review-table'));await wait(()=>f.embeddedHost.scrollTop===0);const settingsStartsAtTop=f.embeddedHost.scrollTop===0;button(f.embeddedHost,'返回配置').click();await wait(()=>!f.embeddedHost.querySelector('.router-review-root'));await wait(()=>f.embeddedHost.scrollTop===configScroll);const settingsRetained=configToggle===f.embeddedHost.querySelector('[aria-label="启用 RouterAgent"]')&&configToggle.getAttribute('aria-checked')==='false'&&f.embeddedHost.scrollTop===configScroll;button(f.embeddedHost,'路由记录与反馈查看历史输入与分配结果，记录预期并复制优化提示词。').click();await wait(()=>button(f.embeddedHost,'详情与反馈'));button(f.embeddedHost,'详情与反馈').click();await wait(()=>f.embeddedHost.querySelector('.router-feedback-form textarea'));change(f.embeddedHost.querySelector('.router-feedback-form textarea'),'导航前未保存');await tick();const originalConfirm=window.confirm;window.confirm=()=>false;const settingsDraftGuard=f.embeddedGuard.current()===false;window.confirm=originalConfirm;
    f.panelHost.style.visibility='visible';f.host.style.visibility='hidden';await wait(()=>f.panelHost.querySelector('.router-inline-feedback .router-feedback-form'));
    const input=f.panelHost.querySelector('.router-task-composer [contenteditable="true"]');input.focus();document.execCommand('insertText',false,'保留输入草稿');await tick();
    const inline=f.panelHost.querySelector('.router-inline-feedback');button(inline,'不符合预期').click();await wait(()=>inline.querySelector('textarea'));change(inline.querySelector('textarea'),'暂存的反馈原因');await tick();
    const cardInputCorrect=inline.closest('.router-assignment').textContent.includes('继续修复图片漏显'),inlineFeedbackInsideCard=!!inline.closest('.router-assignment'),conversationRetained=input===f.panelHost.querySelector('.router-task-composer [contenteditable="true"]')&&input.textContent==='保留输入草稿';
    input.focus();f.push(true);await tick();await tick();const noFocusSteal=document.activeElement===input,incomingKeepsDraft=inline.querySelector('textarea').value==='暂存的反馈原因',noPopupAfterCompletion=!f.panelHost.querySelector('.router-feedback-prompt')&&!button(f.panelHost,'反馈');
    return {singleColumn,svgReturn,initiallyDisabled,optionalEmptyAllowed,draftRetained,ownerCleared,dependentTargetsCleared,newRequirementHasNoTargets,conflictRetainsDraft,conflictReloaded,settingsStartsAtTop,settingsRetained,settingsDraftGuard,cardInputCorrect,inlineFeedbackInsideCard,conversationRetained,noFocusSteal,incomingKeepsDraft,noPopupAfterCompletion,settingsOpens:f.settingsOpens,saves:f.saves,copies:f.copies,errors:f.errors};
  })().catch(cause=>({uiError:cause.stack}))`
})
assert.equal(result.uiError, undefined)
for (const field of ['singleColumn', 'svgReturn', 'initiallyDisabled', 'optionalEmptyAllowed', 'draftRetained', 'ownerCleared', 'dependentTargetsCleared', 'newRequirementHasNoTargets', 'conflictRetainsDraft', 'conflictReloaded', 'settingsStartsAtTop', 'settingsRetained', 'settingsDraftGuard', 'cardInputCorrect', 'inlineFeedbackInsideCard', 'conversationRetained', 'noFocusSteal', 'incomingKeepsDraft', 'noPopupAfterCompletion']) assert.equal(result[field], true, field)
assert.equal(result.saves[1].matches, false)
assert.equal(result.saves[1].expected, undefined)
assert.equal(result.saves[2].expected.kind, 'create_task')
assert.equal(result.saves[3].expected.projectId, 'android')
assert.equal(result.saves[3].expected.taskId, undefined)
assert.equal(result.saves[4].expected.kind, 'create_requirement')
assert.deepEqual(result.settingsOpens, [true])
assert.deepEqual(result.errors, [])
console.log('PASS Router review UI: optional feedback, failure draft, log switching, dependent selectors, inline card feedback, persistent drafts and local copy entry')
