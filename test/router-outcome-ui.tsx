import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-outcome-ui', {
  setup: `
    import {RouterAssignmentCard} from './src/renderer/components/RouterAssignmentCard';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    const host=document.body.appendChild(document.createElement('div'));host.style.width='800px';const root=createRoot(host),calls=[],navigation=[],errors=[];
    let request={requestId:'11111111-1111-4111-8111-111111111111',prompt:'原始任务',version:3,state:'failed',delivery:'pending',scope:{kind:'global'},config:{},createdAt:1,error:'读取候选失败'};
    const render=patch=>{request={...request,...patch};root.render(React.createElement(RouterAssignmentCard,{key:request.requestId,request,agents:[],resolve:input=>new Promise((resolve,reject)=>calls.push({input,resolve,reject})),openTask:id=>navigation.push(['task',id])}))};
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    render({});const unavailableHost=document.body.appendChild(document.createElement('div'));
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config:{enabled:false,agentId:'deepseek',model:'flash',version:1},available:false,requests:[request]})},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    createRoot(unavailableHost).render(React.createElement(RouterPanel,{agents:[],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:(events,event)=>[...events,event]}));
    window.outcomeUI={host,unavailableHost,calls,navigation,errors,render};
  `,
  inspect: `(async()=>{
    const f=window.outcomeUI,tick=()=>new Promise(resolve=>setTimeout(resolve,15)),wait=async check=>{for(let i=0;i<100;i++){if(check())return;await tick()}throw Error('outcome UI timeout: '+f.host.textContent)},button=label=>[...f.host.querySelectorAll('button')].find(row=>row.textContent===label);
    await wait(()=>button('重试')&&f.unavailableHost.querySelector('.router-assignment'));const original=f.host.querySelector('.router-assignment'),checks={failureWithoutDecisionVisible:original.textContent.includes('任务分配暂未完成，请重试。'),unavailableAgentKeepsFailureCard:f.unavailableHost.textContent.includes('任务分配暂未完成，请重试。')};
    const dimensions=()=>{const card=original.getBoundingClientRect(),header=original.querySelector('header').getBoundingClientRect(),body=original.querySelector('.router-assignment-body').getBoundingClientRect(),footer=original.querySelector('footer')?.getBoundingClientRect(),feedback=original.querySelector('.router-inline-feedback')?.getBoundingClientRect();return Math.abs(card.height-header.height-body.height-(footer?.height||0)-(feedback?.height||0)-2)<2&&(!footer||Math.abs(footer.top-body.bottom)<2)};
    checks.failureHasNoReservedSpace=dimensions();checks.failureHasNoWorkingPlaceholders=!/正在判断|正在确定|正在读取候选/.test(original.textContent);
    f.render({state:'cancelled',error:undefined});await wait(()=>original.querySelector('.router-assignment-status').textContent==='已取消');
    checks.cancelledHasNoWorkingPlaceholders=!/正在判断|正在确定|正在读取候选/.test(original.textContent)&&original.textContent.includes('本次分配已取消');
    f.render({state:'failed',error:'读取候选失败'});await wait(()=>original.querySelector('.router-assignment-status').textContent==='分配失败');
    const retry=button('重试');retry.click();retry.click();await wait(()=>f.calls.length===1);
    checks.directRetryKeepsIdentity=f.calls[0].input.action==='retry'&&f.calls[0].input.requestId===original.dataset.routerRequest&&f.calls[0].input.expectedVersion===3&&!('answer' in f.calls[0].input);
    f.calls[0].reject(Error('重试未能提交'));await wait(()=>f.host.textContent.includes('操作暂未完成，请重试。'));
    button('补充信息后重试').click();await tick();const input=f.host.querySelector('[aria-label="补充路由信息"]');checks.blankSupplementDisabled=button('提交并重试').disabled;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'补充所属空间');input.dispatchEvent(new Event('input',{bubbles:true}));await tick();button('提交并重试').click();await wait(()=>f.calls.length===2);
    checks.supplementTargetsOriginal=f.calls[1].input.action==='retry'&&f.calls[1].input.answer==='补充所属空间'&&f.calls[1].input.expectedVersion===3;
    f.calls[1].reject(Error('网络不可用'));await wait(()=>f.host.textContent.includes('操作暂未完成，请重试。'));checks.failedSubmissionKeepsDraft=input.value==='补充所属空间';
    button('提交并重试').click();await wait(()=>f.calls.length===3);f.calls[2].resolve();await tick();
    f.render({state:'queued',version:4,error:undefined,autoRecovery:{attempts:1,total:1,phase:'routing',reason:'正在恢复连接',nextAt:Date.now()+2000}});await wait(()=>f.host.textContent.includes('正在自动恢复'));
    checks.automaticNeedsNoRetryButton=!button('重试')&&f.host.textContent.includes('无需操作');
    f.render({state:'bound',delivery:'queued',version:5,targetId:'original-target',autoRecovery:undefined});await wait(()=>f.host.textContent.includes('分配成功'));
    checks.successUsesSameCard=f.host.querySelector('.router-assignment')===original;checks.successHasNoReservedSpace=dimensions();
    f.render({delivery:'accepted',version:6,prompt:'第一行输入\\n第二行输入',targetTitle:'本次任务标题',projectName:'所属项目',requirementName:'所属需求',decision:{action:'reuse_task',reason:'继续处理原任务'}});await tick();
    checks.acceptedHasNoDuplicateStatus=!original.textContent.includes('输入已开始执行')&&!original.querySelector('footer');
    checks.noDiagnosticDisclosure=!original.querySelector('.router-source')&&!original.textContent.includes('查看详情');
    const method=original.querySelector('.router-assignment-method'),task=original.querySelector('.router-assignment-task'),prompt=original.querySelector('.router-assignment-input');
    checks.readableSections=!!method&&!!task&&!!prompt&&original.textContent.includes('本次任务')&&original.textContent.includes('继续处理原任务')&&prompt.textContent==='第一行输入\\n第二行输入';
    checks.equalMethodFont=!!method&&getComputedStyle(method.querySelector('span')).fontSize===getComputedStyle(method.querySelector('strong')).fontSize;
    const title=task?.querySelector('.router-assignment-task-title'),label=task?.querySelector('.router-assignment-label'),ownership=task?.querySelector('.router-assignment-ownership');
    checks.taskAndOwnershipAligned=!!title&&!!label&&!!ownership&&title.getBoundingClientRect().left>label.getBoundingClientRect().right&&Math.abs(title.getBoundingClientRect().top-label.getBoundingClientRect().top)<1&&Math.abs(title.getBoundingClientRect().left-ownership.getBoundingClientRect().left)<1&&ownership.textContent.includes('所属项目')&&ownership.textContent.includes('所属需求');
    button('打开目标任务').click();checks.headerActionsUseOriginalIdentity=!button('反馈')&&button('打开目标任务').closest('header')===original.querySelector('header')&&JSON.stringify(f.navigation)===JSON.stringify([['task','original-target']]);
    f.render({delivery:'running'});await tick();checks.runningHasNoDuplicateStatus=!original.querySelector('footer')&&!original.textContent.includes('输入已开始执行');
    f.render({delivery:'failed'});await tick();checks.executionFailureKeepsAssignmentSuccess=original.querySelector('.router-assignment-status').textContent==='分配成功'&&!original.querySelector('.router-assignment-body [role="alert"]')&&original.querySelector('footer')?.textContent.includes('本轮执行失败')&&!button('重试')&&!!button('打开目标任务');
    f.host.style.width='360px';f.render({targetTitle:'很长的任务名称'.repeat(35),projectName:'很长的项目名称'.repeat(20),requirementName:'很长的需求名称'.repeat(20)});await tick();checks.narrowCardHasNoOverflow=original.scrollWidth<=original.clientWidth&&original.querySelector('header').scrollWidth<=original.querySelector('header').clientWidth;
    f.render({state:'routing',delivery:'pending'});await tick();checks.routingKeepsFeedbackHidden=!original.querySelector('.router-inline-feedback');f.render({state:'bound',delivery:'accepted'});await tick();
    f.render({delivery:'unknown',version:6});await wait(()=>button('再次核对'));checks.unknownDoesNotOfferRetry=!button('重试');button('再次核对').click();await wait(()=>f.calls.length===4);checks.verifyDoesNotSendNewTask=f.calls[3].input.action==='verify';f.calls[3].resolve();
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS Router outcomes: early failure, original retry, double clicks, drafts, automatic recovery, delivery verification and content-sized cards')
