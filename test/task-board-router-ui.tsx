import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-board-router-ui', {
  setup: `
    import {TaskBoard} from './src/renderer/components/TaskBoard';
    import {WorkspaceDetail} from './src/renderer/components/WorkspaceBrowser';
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {projectTaskBoard} from './src/shared/taskBoard';
    import {DEFAULT_ROUTER_CONFIG} from './src/shared/router';
    const request={requestId:'11111111-1111-4111-8111-111111111111',prompt:'看板新增路由占位卡片 '+ '较长输入内容'.repeat(20),scope:{kind:'global'},config:DEFAULT_ROUTER_CONFIG,version:1,state:'queued',delivery:'pending',createdAt:1,updatedAt:2};
    const requests=[request],sessions=[],opened=[],errors=[],routerRequests=[];let notify=()=>{},routerOpens=0,rejectOpen=false;
    const data={projects:[{id:'p',name:'产品空间',primaryDirectory:'/fixture'}],requirements:[{id:'r',name:'样例需求',projectId:'p',status:'active',dir:'/fixture/r'}],projectsLoading:false,requirementsLoading:false,requirementsEnabled:true};
    const routerSession={id:'fixed-router',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'deepseek',workdir:'/fixture',managedPurpose:'router'}};
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({getTaskBoard:async query=>projectTaskBoard(sessions,()=>[],query,()=>false,requests),onTaskBoardChanged:callback=>{notify=callback;return()=>{notify=()=>{}}},getEvents:async()=>[],getPrefs:async()=>({lastByAgent:{}}),getRouterSnapshot:async()=>({config:DEFAULT_ROUTER_CONFIG,available:true,requests,sessionId:routerSession.id}),openRouter:async()=>routerSession}, {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:absolute;inset:0;width:1024px;height:640px;display:flex;background:var(--bg)';
    const root=createRoot(host),noop=()=>{},onOpenTask=id=>opened.push(id),onOpenRouter=async requestId=>{if(rejectOpen)throw Error('路由入口读取失败');routerOpens++;routerRequests.push(requestId);root.render(React.createElement(RouterPanel,{focusRequestId:requestId,agents:[],onOpenTask,onSettings:noop,mergeEvent:(events,event)=>[...events,event]}))};
    const mount=(scoped=false)=>root.render(React.createElement(scoped?WorkspaceDetail:TaskBoard,{projects:data.projects,requirements:data.requirements,onOpenTask,onOpenRouter,onCreate:noop,...(scoped?{location:{kind:'requirement',id:'r'},data,requirementsEnabled:true,sessions,pending:{},unread:{},status:{},sessionsLoading:false,onRetrySessions:async()=>{},onNavigate:noop,onManage:noop}:{})}));
    const change=patch=>{Object.assign(request,patch);request.version++;request.updatedAt++;notify()};
    localStorage.clear();mount();window.routingBoardFixture={host,request,sessions,mount,change,opened,errors,routerRequests,routerOpens:()=>routerOpens,rejectOpen:value=>rejectOpen=value};
  `,
  inspect: `(async()=>{
    const f=window.routingBoardFixture,q=selector=>f.host.querySelector(selector),wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20))}throw Error('routing board timeout: '+f.host.textContent+' / '+f.errors)},card=()=>q('[data-task-id="router:'+f.request.requestId+'"]');
    await wait(()=>card());
    const initial={count:q('[data-column=active] header>span').textContent,label:card().querySelector('.task-board-routing-label')?.textContent,spinner:!!card().querySelector('.task-board-card-status .si-spinner'),routerIcon:!!card().querySelector('.task-board-agent .ui-icon-router'),actions:card().querySelectorAll('[data-action]').length,scope:q('.task-board-group-head').textContent,overflow:card().scrollWidth>card().clientWidth};
    const open=card().querySelector('.task-board-card-open');open.focus();const focusable=document.activeElement===open;open.click();
    await wait(()=>q('[data-router-conversation]')&&f.host.textContent.includes('RouterAgent'));
    const routerEntered=f.routerOpens()===1&&f.opened.length===0;
    f.mount();await wait(()=>card());
    f.rejectOpen(true);card().querySelector('.task-board-card-open').click();await wait(()=>q('[role=alert]')?.textContent.includes('路由入口读取失败'));
    const openFailure={kept:!!card(),enabled:!card().querySelector('button').disabled};f.rejectOpen(false);
    f.change({state:'routing'});await wait(()=>card()?.querySelector('.task-board-routing-label')?.textContent==='路由中');
    f.change({state:'needs_input'});await wait(()=>card()?.querySelector('.task-board-routing-label')?.textContent==='待确认');
    const needsInput={spinner:!!card().querySelector('.si-spinner'),question:!!card().querySelector('.ui-icon-question')};
    f.change({state:'failed'});await wait(()=>card()?.querySelector('.task-board-routing-label')?.textContent==='路由失败');
    const failed={spinner:!!card().querySelector('.si-spinner'),alert:!!card().querySelector('.ui-icon-alert-circle')};
    card().querySelector('.task-board-card-open').click();await wait(()=>q('[data-router-conversation]'));
    f.mount();await wait(()=>card());f.change({state:'cancelled'});await wait(()=>!card());const cancelled=q('[data-column=active] header>span').textContent;
    f.change({state:'routing'});await wait(()=>card());
    f.sessions.push({id:'target',title:'正常任务标题',createdAt:1,updatedAt:9,status:'running',config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}});
    f.change({state:'bound',targetId:'target',delivery:'running'});await wait(()=>q('[data-task-id=target]')&&!card());
    const replaced={count:q('[data-column=active] header>span').textContent,labels:f.host.querySelectorAll('.task-board-routing-label').length,title:q('[data-task-id=target] strong').textContent,actions:q('[data-task-id=target]').querySelectorAll('[data-action=pause]').length};
    q('[data-task-id=target] .task-board-card-open').click();await wait(()=>f.opened.length===1);
    f.request.scope={kind:'requirement',requirementId:'r'};f.change({state:'queued',targetId:undefined});f.mount(true);await wait(()=>q('.requirement-detail')&&card());
    const scoped={label:card().querySelector('.task-board-routing-label').textContent,groups:f.host.querySelectorAll('.task-board-group-head').length};
    card().querySelector('.task-board-card-open').click();await wait(()=>q('[data-router-conversation]'));
    return {initial,focusable,routerEntered,openFailure,needsInput,failed,cancelled,replaced,scoped,opened:f.opened,routerOpens:f.routerOpens(),routerRequests:f.routerRequests,errors:f.errors};
  })()`
})
assert.deepEqual(result.initial, { count: '1', label: '路由中', spinner: true, routerIcon: true, actions: 0, scope: '自动归属', overflow: false })
assert.equal(result.focusable, true)
assert.equal(result.routerEntered, true, 'routing card opens the actual RouterPanel without selecting a business session')
assert.deepEqual(result.openFailure, { kept: true, enabled: true })
assert.deepEqual(result.needsInput, { spinner: false, question: true })
assert.deepEqual(result.failed, { spinner: false, alert: true })
assert.equal(result.cancelled, '0')
assert.deepEqual(result.replaced, { count: '1', labels: 0, title: '正常任务标题', actions: 1 })
assert.deepEqual(result.opened, ['target'], 'bound card navigates by target Session identity')
assert.deepEqual(result.scoped, { label: '路由中', groups: 0 }, 'requirement board retains the same routing navigation')
assert.equal(result.routerOpens, 3)
assert.deepEqual(result.routerRequests, Array(3).fill('11111111-1111-4111-8111-111111111111'), 'global and requirement boards preserve the selected Router request identity')
assert.deepEqual(result.errors, [])
console.log('PASS real renderer routing navigation, scoped board wiring, state replacement, target action, cancellation and open failure')
