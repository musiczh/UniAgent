import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-input-ui', {
  setup: `
    import {NewTaskPanel} from './src/renderer/components/NewTaskPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const projects=[{id:'a',name:'默认空间',primaryDirectory:'/fixture/a',additionalDirectories:[],isDefault:true},{id:'b',name:'执行空间',primaryDirectory:'/fixture/b',additionalDirectories:[]}];
    const requirements=[{id:'r',name:'界面优化需求',projectId:'b',status:'active'}];
    const agents=[{id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:['high']}],capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[{id:'bypassPermissions',label:'完全访问'}]},lifecycle:{availability:'available'}}];
    const prefs={lastAgentId:'codex',lastByAgent:{codex:{model:'model',permissionMode:'bypassPermissions'}}};
    const routed=[],created=[],errors=[];let router={config:{enabled:true,version:1},available:true,requests:[]},changed=()=>{},finishRouter,submitted=0;
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>prefs,setPrefs:async()=>prefs,listProjects:async()=>projects,listRequirements:async()=>requirements,listPresets:async()=>[],getPersonalAssistant:async()=>undefined,getRouterSnapshot:async()=>router,onRouterChanged:callback=>{changed=callback;return()=>{}},getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[],unavailableReason:'不是 Git 仓库'}),getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir),submitRouterInput:input=>{routed.push(input);return new Promise(resolve=>finishRouter=resolve)}},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
    host.style.cssText='position:fixed;inset:0';
    const seed={agentId:'codex',requirementId:'r'};
    const props={agents,requirementsEnabled:true,quickCreateSeed:seed,promptPrefill:{text:'继续优化输入界面'},onCreate:async(config,prompt,attachments)=>{created.push({config,prompt,attachments});return{id:'created-'+created.length,config,status:'idle',createdAt:1,title:'界面任务'}},onCommitCreatedSession:()=>{},onRouterSubmitted:()=>submitted++};
    root.render(React.createElement(NewTaskPanel,props));
    window.inputFixture={host,routed,created,errors,finishRouter:()=>finishRouter(),submitted:()=>submitted,refresh:(enabled,available,reason)=>{router={...router,config:{...router.config,enabled},available,reason};changed()},render:overrides=>root.render(React.createElement(NewTaskPanel,{...props,...overrides}))};
  `,
  inspect: `(async()=>{
    const f=window.inputFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,15));
    const wait=async predicate=>{for(let i=0;i<180;i++){if(predicate())return;await tick()}throw Error('input UI timeout: '+f.errors+' / '+f.host.textContent)};
    const trigger=()=>f.host.querySelector('.project-picker-trigger'),send=()=>f.host.querySelector('.new-task-send-btn');
    const open=async()=>{if(!f.host.querySelector('.project-picker').open)trigger().click();await wait(()=>f.host.querySelector('.project-picker-pop[data-positioned]'))};
    const auto=()=>f.host.querySelector('.scope-picker-auto');
    const option=label=>[...f.host.querySelectorAll('.project-picker-list [role=option]')].find(row=>row.textContent.includes(label));
    const selected=()=>[...f.host.querySelectorAll('.project-picker-list [aria-selected=true]')];
    const fill=async()=>{window.__markdownInput.fill(f.host,'继续优化输入界面');await tick()};
    await wait(()=>trigger()?.textContent.includes('界面优化需求')&&!send()?.disabled);await open();
    const checks={entryEnabled:!auto().disabled,noDuplicateCheckbox:!f.host.querySelector('input[type=checkbox][aria-label="自动归属"]')};
    if(!checks.entryEnabled)return{checks,errors:f.errors};
    auto().focus();checks.keyboardFocusable=document.activeElement===auto();
    auto().click();await wait(()=>trigger().textContent.includes('自动归属'));checks.autoClosesMenu=!f.host.querySelector('.project-picker').open;
    await open();checks.singleAutoSelection=selected().length===1&&selected()[0]===auto()&&!!auto().querySelector('.ui-icon-check');
    f.host.querySelector('.project-picker').removeAttribute('open');send().click();await wait(()=>f.routed.length===1);
    checks.autoUsesGlobalScope=f.routed[0].scope.kind==='global'&&f.routed[0].execution.requirementId===undefined;
    checks.executionPreserved=f.routed[0].execution.agentId==='codex'&&f.routed[0].execution.model==='model'&&f.routed[0].execution.permissionMode==='bypassPermissions'&&f.routed[0].prompt==='继续优化输入界面';
    f.host.querySelector('.project-picker').open=true;await wait(()=>auto());checks.submittingLocksOptions=trigger().getAttribute('aria-disabled')==='true'&&auto().disabled&&option('界面优化需求').disabled;
    option('界面优化需求').click();await tick();checks.lockedSelectionKept=trigger().textContent.includes('自动归属');
    f.finishRouter();await wait(()=>f.submitted()===1&&send().getAttribute('aria-label')==='开始');await open();option('界面优化需求').click();await wait(()=>trigger().textContent.includes('界面优化需求'));
    await open();checks.singleRequirementSelection=selected().length===1&&selected()[0]===option('界面优化需求');
    f.host.querySelector('.project-picker').removeAttribute('open');await fill();send().click();await wait(()=>f.created.length===1&&!send().disabled);
    checks.requirementExitsAuto=f.routed.length===1&&f.created[0].config.taskScope.kind==='requirement'&&f.created[0].config.requirementId==='r'&&f.created[0].config.projectId==='b';
    await open();auto().click();await wait(()=>trigger().textContent.includes('自动归属'));await open();option('执行空间').click();await wait(()=>trigger().textContent.includes('执行空间'));
    await fill();send().click();await wait(()=>f.created.length===2&&!send().disabled);
    checks.spaceExitsAuto=f.routed.length===1&&f.created[1].config.taskScope.kind==='space'&&f.created[1].config.taskScope.projectId==='b'&&f.created[1].config.requirementId===undefined;
    await open();f.refresh(false,true);await wait(()=>auto().disabled);auto().click();await tick();checks.disabledRouterBlocked=auto().textContent.includes('暂不可用')&&auto().title.includes('启用 RouterAgent')&&trigger().textContent.includes('执行空间');
    f.refresh(true,false,'连接检查失败');await wait(()=>auto().title.includes('连接检查失败'));checks.failedCheckBlocked=auto().disabled;
    f.refresh(true,true);await wait(()=>!auto().disabled);auto().click();await wait(()=>trigger().textContent.includes('自动归属'));
    f.render({quickCreateSeed:{agentId:'codex',projectId:'b'}});await wait(()=>trigger().textContent.includes('执行空间'));checks.seedExitsAuto=true;
    f.render({requirementsEnabled:false,quickCreateSeed:undefined});await open();await wait(()=>!option('界面优化需求'));checks.availableWithoutRequirements=!auto().disabled;
    return{checks,errors:f.errors};
  })()`
})

assert.equal(result.checks.entryEnabled, true, 'ready Router must be selectable in the scope menu')
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
assert.deepEqual(result.errors, [])
console.log('PASS Router input: one scope entry, exclusive selection, global routing, manual creation, readiness and submission locks')
