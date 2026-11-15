import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'side-chat-immediate', {
  setup: `
    import {SideChatPanel} from './src/renderer/components/SideChatPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';installMarkdownInputDriver();
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[{id:'ask',label:'询问'}]}};
    const calls=[],errors=[];let event=()=>{},state=()=>{},current={config:{agentId:'codex',model:'model',workdir:'/fixture'},status:'idle',queue:[],hasLiveStreamer:false};
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({getSideEvents:async()=>[],getSideState:async()=>current,getNativeCapabilities:async i=>emptyNativeCapabilitySnapshot(i.agentId,i.workdir),onSideEvent:cb=>{event=cb;return()=>{}},onSideState:cb=>{state=cb;return()=>{}},sendSideMessage:(id,prompt,attachments,selection,plan,bubble)=>new Promise((resolve,reject)=>calls.push({id,prompt,attachments,bubble,resolve,reject})),getPrefs:async()=>({lastByAgent:{}}),listPresets:async()=>[]},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';createRoot(host).render(React.createElement(SideChatPanel,{open:true,sessionId:'main',agent,onClose:()=>{},onPromote:()=>{}}));window.sideImmediate={host,calls,errors,receipt:index=>event({sessionId:'main',event:{sessionId:'main',seq:index+1,ts:Date.now(),type:'user_message',payload:{text:calls[index].prompt,...calls[index].bubble}}}),busy:()=>{current={...current,status:'running'};state({sessionId:'main',state:current})}};
  `,
  inspect: `(async()=>{
    const f=window.sideImmediate,tick=()=>new Promise(r=>setTimeout(r,15)),wait=async p=>{for(let i=0;i<180;i++){if(p())return;await tick()}throw Error('side timeout: '+f.host.textContent+' / '+f.errors)};
    const send=()=>f.host.querySelector('.composer-send-btn'),bubbles=()=>f.host.querySelectorAll('.user-msg');await wait(()=>f.host.querySelector('[contenteditable]'));
    const submit=async text=>{window.__markdownInput.fill(f.host,text);await wait(()=>send()&&!send().disabled);send().click();await tick()};
    await submit('重复输入');await wait(()=>f.calls.length===1&&bubbles().length===1);const checks={beforeReceipt:true,clientIdentity:typeof f.calls[0].bubble.clientTurnKey==='string',flight:!!document.querySelector('[data-send-flight]')};
    const first=bubbles()[0];f.receipt(0);f.calls[0].resolve();await tick();checks.receiptReusesBubble=bubbles().length===1&&bubbles()[0]===first;
    await submit('重复输入');await wait(()=>f.calls.length===2&&bubbles().length===2);f.receipt(1);f.calls[1].resolve();await tick();checks.equalTextSeparate=bubbles().length===2&&f.calls[0].bubble.clientTurnKey!==f.calls[1].bubble.clientTurnKey;
    await submit('失败后保留');await wait(()=>f.calls.length===3);f.calls[2].reject(Error('侧边发送失败'));await wait(()=>f.host.textContent.includes('侧边发送失败'));checks.failureDraft=window.__markdownInput.text(f.host)==='失败后保留'&&bubbles().length===2;
    f.busy();await tick();await submit('繁忙时排队');await wait(()=>f.calls.length===4&&f.host.querySelector('.queue-card'));checks.busyQueueImmediate=bubbles().length===2&&!!document.querySelector('[data-send-flight]');f.calls[3].reject(Error('排队提交失败'));await wait(()=>f.host.textContent.includes('排队提交失败'));checks.queueFailureRestoresDraft=!f.host.querySelector('.queue-card')&&window.__markdownInput.text(f.host)==='繁忙时排队';
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS side chat immediate flight, identity replacement, repeated text and failure draft restoration')
