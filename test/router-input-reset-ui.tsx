import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-input-reset', {
  setup: `
    import {NewTaskPanel} from './src/renderer/components/NewTaskPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const project={id:'default',name:'默认空间',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true};
    const agents=[{id:'codex',name:'Codex',adapter:'codex',installed:true,models:[],capabilities:{permissionModes:[{id:'bypassPermissions',label:'完全访问'}]},lifecycle:{availability:'available'}}];
    const prefs={lastAgentId:'codex',lastByAgent:{codex:{permissionMode:'bypassPermissions'}}};
    const requests=[],errors=[];let picked=[],submitted=0;
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>prefs,setPrefs:async()=>prefs,listProjects:async()=>[project],listRequirements:async()=>[],listPresets:async()=>[],getPersonalAssistant:async()=>undefined,getRouterSnapshot:async()=>({config:{enabled:true,version:1},available:true,requests:[]}),getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[]}),getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir),pickFiles:async()=>picked,submitRouterInput:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject}))},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
    const props={agents,promptPrefill:{text:'第一项任务'},onCreate:async()=>{throw Error('must route instead of creating directly')},onCommitCreatedSession:()=>{},onRouterSubmitted:()=>{submitted++;host.style.display='none'}};
    root.render(React.createElement(NewTaskPanel,props));
    window.resetFixture={host,requests,errors,submitted:()=>submitted,pick:file=>picked=[file],reopen:()=>{host.style.display='';root.render(React.createElement(NewTaskPanel,props))}};
  `,
  inspect: `(async()=>{
    const f=window.resetFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,15));
    const wait=async predicate=>{for(let i=0;i<180;i++){if(predicate())return;await tick()}throw Error('router reset timeout: '+f.errors+' / '+f.host.textContent)};
    const send=()=>f.host.querySelector('.new-task-send-btn'),text=()=>window.__markdownInput.text(f.host);
    const settled=()=>send()?.getAttribute('aria-label')==='开始';
    const fill=async value=>{window.__markdownInput.fill(f.host,value);await tick()};
    const add=async name=>{f.pick({kind:'file',path:'/fixture/'+name,name});[...f.host.querySelectorAll('button')].find(button=>button.textContent.includes('添加附件')).click();await wait(()=>f.host.querySelector('[aria-label="移除 '+name+'"]'))};
    await wait(()=>send()&&!send().disabled);
    const autoCheckbox=f.host.querySelector('input[aria-label="自动归属"]');
    if(autoCheckbox)autoCheckbox.click();
    else{f.host.querySelector('.project-picker-trigger').click();await wait(()=>f.host.querySelector('.scope-picker-auto'));f.host.querySelector('.scope-picker-auto').click()}
    await tick();
    send().click();await wait(()=>f.requests.length===1);
    const checks={pendingKeepsText:text()==='第一项任务'&&f.submitted()===0};
    f.requests[0].resolve();await wait(()=>f.submitted()===1&&settled());f.reopen();await tick();
    checks.successClearsText=text()==='';
    checks.emptyDraftCannotSubmit=send().disabled;
    await tick();checks.prefillDoesNotReplay=text()==='';

    await fill('第二项任务');await add('sent.txt');send().click();await wait(()=>f.requests.length===2);
    checks.payloadPreserved=f.requests[1].input.prompt==='第二项任务'&&f.requests[1].input.attachments[0].name==='sent.txt';
    f.requests[1].reject(Error('路由提交失败'));await wait(()=>settled()&&f.host.textContent.includes('路由提交失败'));
    checks.failureKeepsDraft=text()==='第二项任务'&&!!f.host.querySelector('[aria-label="移除 sent.txt"]')&&f.submitted()===1;
    send().click();await wait(()=>f.requests.length===3);
    checks.retryUsesSameRequest=f.requests[2].input.requestId===f.requests[1].input.requestId;
    await fill('下一项任务草稿');await add('next.txt');
    f.requests[2].resolve();await wait(()=>f.submitted()===2&&settled());f.reopen();await tick();
    checks.newTextKept=text()==='下一项任务草稿';
    checks.onlySentAttachmentRemoved=!f.host.querySelector('[aria-label="移除 sent.txt"]')&&!!f.host.querySelector('[aria-label="移除 next.txt"]');

    send().click();await wait(()=>f.requests.length===4);
    checks.nextPayloadIsNewDraft=f.requests[3].input.prompt==='下一项任务草稿'&&f.requests[3].input.attachments.length===1&&f.requests[3].input.attachments[0].name==='next.txt';
    f.requests[3].resolve();await wait(()=>f.submitted()===3&&settled());f.reopen();await tick();
    checks.successClearsAttachments=text()===''&&!f.host.querySelector('[aria-label="移除 next.txt"]')&&send().disabled;
    return{checks,errors:f.errors};
  })()`
})

assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS Router input reset: success clears submitted text and attachments, failure retains input, pending edits survive and retry stays idempotent')
