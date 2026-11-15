import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'detail-send-motion', {
  setup: `
    import {DetailChatPopover} from './src/renderer/components/DetailChatPopover';
    let event=()=>{},status=()=>{};const calls=[],errors=[];
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.uniagent=new Proxy({onDetailEvent:cb=>{event=cb;return()=>{}},onDetailStatus:cb=>{status=cb;return()=>{}},explainDetailSelection:async()=>{event({sessionId:'s',event:{sessionId:'s',seq:0,ts:1,type:'agent_message',payload:{text:'已完成解释'}}});status({sessionId:'s',status:'idle'})},sendDetailMessage:(id,text,attachments,bubble)=>new Promise((resolve,reject)=>calls.push({text,bubble,resolve,reject})),getDetailEvents:async()=>[],getDetailStatus:async()=> 'idle',closeDetail:async()=>{}},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));createRoot(host).render(React.createElement(DetailChatPopover,{sessionId:'s',quote:'术语',selectedMessageText:'需要解释的术语',nonce:1,onClose:()=>{},onPromoted:()=>{},onSessionCreated:()=>{}}));window.detailMotion={calls,errors,receipt:index=>{event({sessionId:'s',event:{sessionId:'s',seq:index+1,ts:Date.now(),type:'user_message',payload:{text:calls[index].text,...calls[index].bubble}}});status({sessionId:'s',status:'idle'})}};
  `,
  inspect: `(async()=>{
    const f=window.detailMotion,tick=()=>new Promise(r=>setTimeout(r,15)),wait=async p=>{for(let i=0;i<180;i++){if(p())return;await tick()}throw Error('detail motion timeout: '+document.querySelector('.detail-pop')?.textContent+' / '+f.errors)};
    const pop=()=>document.querySelector('.detail-pop'),send=()=>pop().querySelector('.detail-send:not(.stop)'),bubbles=()=>pop().querySelectorAll('.user-msg');await wait(()=>send());
    const fill=async text=>{const input=pop().querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));await tick()};
    await fill('继续解释');send().click();await wait(()=>f.calls.length===1&&bubbles().length===1);const checks={beforeReceipt:!!document.querySelector('[data-send-flight]')};const original=bubbles()[0];f.receipt(0);f.calls[0].resolve();await tick();checks.receiptReusesBubble=bubbles().length===1&&bubbles()[0]===original;
    await fill('失败的追问');send().click();await wait(()=>f.calls.length===2);await fill('发送期间的新草稿');f.calls[1].reject(Error('解释发送失败'));await wait(()=>pop().textContent.includes('解释发送失败'));checks.keepsNewDraft=pop().querySelector('textarea').value==='发送期间的新草稿'&&bubbles().length===1;
    return{checks,errors:f.errors};
  })()`
})
assert.deepEqual(result.errors, [])
for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name)
console.log('PASS detail follow-up immediate flight, identity receipt, failed send and newer draft preservation')
