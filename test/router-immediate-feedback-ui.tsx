import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-immediate-feedback', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}};
    const session={id:'router-immediate',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}};
    let snapshot={config:{enabled:true,agentId:'codex',model:'model',version:1},available:true,sessionId:session.id,requests:[]},onEvent=()=>{},listeners=new Set();
    const calls=[],errors=[],history=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>({lastAgentId:'codex',lastByAgent:{codex:{model:'model',permissionMode:'ask'}}}),setPrefs:async()=>{},getAppSettings:async()=>({defaultTaskWorktree:false}),listProjects:async()=>[{id:'p',name:'项目',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true}],listRequirements:async()=>[],listPresets:async()=>[],getPersonalAssistant:async()=>undefined,getNativeCapabilities:async i=>emptyNativeCapabilitySnapshot(i.agentId,i.workdir),getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[]}),getRouterSnapshot:async()=>snapshot,openRouter:async()=>session,getEvents:async()=>history,onEvent:cb=>{onEvent=cb;return()=>{}},onRouterChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},submitRouterInput:input=>new Promise((resolve,reject)=>calls.push({input,resolve:()=>{const row={...input,routerSessionId:session.id,config:snapshot.config,version:1,state:'routing',delivery:'pending',createdAt:Date.now(),updatedAt:Date.now()};snapshot={...snapshot,requests:[...snapshot.requests,row],activeRequestId:input.requestId};listeners.forEach(cb=>cb());resolve(row)},reject}))},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';createRoot(host).render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));
    window.immediate={host,calls,errors,receipt:index=>{const input=calls[index].input,event={sessionId:session.id,seq:index+1,ts:Date.now(),type:'user_message',payload:{text:'Router 内部提示词',displayText:input.prompt,routedInputId:input.requestId}};history.push(event);onEvent(event)},idle:()=>{snapshot={...snapshot,activeRequestId:undefined,requests:snapshot.requests.map(row=>({...row,state:'bound',delivery:'accepted',version:row.version+1}))};listeners.forEach(cb=>cb())}};
  `,
  inspect: `(async()=>{
    const f=window.immediate,tick=()=>new Promise(r=>setTimeout(r,15)),wait=async p=>{for(let i=0;i<180;i++){if(p())return;await tick()}throw Error('即时反馈超时：'+f.host.textContent+' / '+f.errors)};
    const send=()=>f.host.querySelector('.new-task-send-btn'),bubbles=()=>[...f.host.querySelectorAll('.user-msg .bubble')];await wait(()=>send());
    window.__markdownInput.fill(f.host,'同一句原始输入');await wait(()=>!send().disabled);send().click();await wait(()=>f.calls.length===1);await tick();
    const checks={visibleBeforeAcceptance:bubbles().some(row=>row.textContent.includes('同一句原始输入'))};if(!checks.visibleBeforeAcceptance)return{checks,errors:f.errors};
    checks.flightBeforeAcceptance=!!document.querySelector('[data-send-flight]');
    f.calls[0].resolve();await tick();f.receipt(0);await wait(()=>bubbles().length===1);checks.oneAfterReceipt=bubbles().length===1&&!bubbles()[0].textContent.includes('内部提示词');f.idle();await tick();
    window.__markdownInput.fill(f.host,'同一句原始输入');await tick();await wait(()=>!send().disabled);send().click();await wait(()=>f.calls.length===2);await tick();checks.equalTextIsAnotherMessage=bubbles().length===2;f.calls[1].resolve();await tick();f.receipt(1);await wait(()=>bubbles().length===2);checks.twoAfterReceipts=bubbles().length===2;f.idle();await tick();
    window.__markdownInput.fill(f.host,'失败后保留的原文');await tick();await wait(()=>!send().disabled);send().click();await wait(()=>f.calls.length===3);f.calls[2].reject(Error('提交失败，稍后重试'));await wait(()=>f.host.textContent.includes('提交失败，稍后重试'));checks.failedDraftPreserved=window.__markdownInput.text(f.host)==='失败后保留的原文';
    window.__markdownInput.fill(f.host,'新的独立输入');await tick();await wait(()=>!send().disabled);send().click();await wait(()=>f.calls.length===4);f.calls[3].resolve();await tick();f.receipt(3);await wait(()=>bubbles().some(row=>row.textContent.includes('新的独立输入')));await tick();checks.oldFailureDoesNotReturn=!f.host.textContent.includes('提交失败，稍后重试');
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS Router immediate input, identity receipts, equal-text submissions and failure draft')
