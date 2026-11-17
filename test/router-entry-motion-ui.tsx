import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-entry-motion', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    import {mergeSessionEvent} from './src/renderer/App';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    import {installMotionFinishDriver} from './test/fixtures/motion-finish-driver.mjs';
    installMarkdownInputDriver();
    window.entryMotionFinishes=installMotionFinishDriver();
    const digest=crypto.subtle.digest.bind(crypto.subtle);let delayed=false,releaseDigest;
    crypto.subtle.digest=(...args)=>delayed?new Promise(resolve=>releaseDigest=()=>{delayed=false;digest(...args).then(resolve)}):digest(...args);
    const agent={id:'codex',name:'Codex',adapter:'codex',installed:true,models:[{id:'model',label:'Model',efforts:[]}],capabilities:{permissionModes:[{id:'ask',label:'询问'}]},lifecycle:{availability:'available'}};
    const session={id:'router-entry',title:'RouterAgent',status:'idle',createdAt:1,config:{agentId:'codex',model:'model',workdir:'/fixture',managedPurpose:'router'}},config={enabled:true,agentId:'codex',model:'model',version:1};
    const previous={requestId:'previous',routerSessionId:session.id,prompt:'已经分配的输入',scope:{kind:'global'},config,version:2,state:'bound',delivery:'accepted',createdAt:1,updatedAt:1,decision:{action:'reuse_task',taskId:'old-task',reason:'继续已有任务'},targetId:'old-task',targetTitle:'已有任务',projectName:'UniAgent'};
    const history=[{sessionId:session.id,seq:1,ts:1,type:'user_message',payload:{text:previous.prompt,routedInputId:'previous'}},{sessionId:session.id,seq:2,ts:2,type:'tool_call',state:'success',payload:{name:'mcp__uniagent_router__router_assign_task',input:{requestId:'previous',version:1}}},{sessionId:session.id,seq:3,ts:3,type:'turn_completed',payload:{}}];
    const restored={...previous,requestId:'restored',routerSessionId:'older',createdAt:0};let releaseOlder;
    let snapshot={config,available:true,sessionId:session.id,requests:[restored,previous],conversationSessions:[{sessionId:'older',agentId:'codex',createdAt:0},{sessionId:session.id,agentId:'codex',createdAt:1}]},event=()=>{},listeners=new Set();const calls=[];
    window.uniagent=new Proxy({homeDir:'/fixture',getPrefs:async()=>({lastAgentId:'codex',lastByAgent:{codex:{model:'model',permissionMode:'ask'}}}),setPrefs:async()=>{},getAppSettings:async()=>({defaultTaskWorktree:false}),listProjects:async()=>[{id:'p',name:'UniAgent',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true}],listRequirements:async()=>[],listPresets:async()=>[],getPersonalAssistant:async()=>undefined,getNativeCapabilities:async i=>emptyNativeCapabilitySnapshot(i.agentId,i.workdir),getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[]}),getRouterSnapshot:async()=>snapshot,openRouter:async()=>session,getEvents:id=>id==='older'?new Promise(resolve=>releaseOlder=()=>resolve(history.map(row=>({...row,sessionId:'older',payload:row.type==='tool_call'?{...row.payload,input:{requestId:'restored',version:1}}:row.payload})))):Promise.resolve(history),onEvent:cb=>{event=cb;return()=>{}},onRouterChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},submitRouterInput:input=>new Promise((resolve,reject)=>calls.push({input,reject,accept:()=>{snapshot={...snapshot,requests:[...snapshot.requests,{...input,routerSessionId:session.id,config,version:1,state:'routing',delivery:'pending',createdAt:Date.now(),updatedAt:Date.now()}],activeRequestId:input.requestId};listeners.forEach(cb=>cb());resolve(snapshot.requests.at(-1))}}))},{get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;width:1000px;height:700px';createRoot(host).render(React.createElement(RouterPanel,{agents:[agent],onOpenTask:()=>{},onSettings:()=>{},mergeEvent:mergeSessionEvent}));window.entry={host,calls,delay:()=>delayed=true,digestWaiting:()=>!!releaseDigest,release:()=>releaseDigest(),restore:()=>releaseOlder(),receipt:()=>{const input=calls[0].input;event({sessionId:session.id,seq:4,ts:Date.now(),type:'user_message',payload:{text:input.prompt,routedInputId:input.requestId}});}};
  `,
  inspect: `(async()=>{
    const f=window.entry,tick=ms=>new Promise(r=>setTimeout(r,ms||10)),wait=async p=>{for(let i=0;i<240;i++){if(p()){for(const element of f.host.querySelectorAll('.user-msg,.router-assignment'))window.entryMotionFinishes.watch(element);return;}await tick()}throw Error('entry timeout: '+f.host.textContent)};
    const stream=()=>f.host.querySelector('.event-stream'),previous=()=>stream().querySelector('[data-router-request="previous"]'),row=()=>stream().querySelector('[data-client-turn-key="'+f.calls[0].input.requestId+'"]');
    await wait(()=>previous()&&f.host.querySelector('.new-task-send-btn'));await tick(400);
    window.__markdownInput.fill(f.host,'气泡和卡片渐显并慢慢顶开已有内容');await wait(()=>!f.host.querySelector('.new-task-send-btn').disabled);
    const oldTop=previous().getBoundingClientRect().top,inputWidth=f.host.querySelector('.composer-box').getBoundingClientRect().width;
    f.delay();f.host.querySelector('.new-task-send-btn').click();await wait(()=>f.digestWaiting());window.__markdownInput.fill(f.host,'标识计算期间的新草稿');await tick();f.release();await wait(()=>document.querySelector('[data-send-flight]')&&row());
    const copy=document.querySelector('[data-send-flight]'),initial={width:copy.getBoundingClientRect().width,height:row().getBoundingClientRect().height,oldTop:previous().getBoundingClientRect().top};
    const submittedSnapshot=copy.textContent.includes('气泡和卡片渐显并慢慢顶开已有内容')&&!copy.textContent.includes('标识计算期间的新草稿'),earlyDraftVisible=Number(getComputedStyle(f.host.querySelector('.composer-main')).opacity)===1;
    await tick(100);const middle={height:row().getBoundingClientRect().height,oldTop:previous().getBoundingClientRect().top,opacity:Number(getComputedStyle(row()).opacity),sourceOpacity:Number(getComputedStyle(copy).opacity)};
    const original=row();f.calls[0].accept();await wait(()=>stream().querySelectorAll('.router-assignment').length===2);const card=()=>stream().querySelector('[data-router-request="'+f.calls[0].input.requestId+'"]'),cardInitial=card().getBoundingClientRect().height;
    f.receipt();await tick(60);const retained=row()===original,cardMiddle=card().getBoundingClientRect().height;
    window.__markdownInput.fill(f.host,'发送期间的新草稿');await tick(30);const draftVisible=Number(getComputedStyle(f.host.querySelector('.composer-main')).opacity)===1;
    await tick(540);const final={height:row().getBoundingClientRect().height,cardHeight:card().getBoundingClientRect().height,oldTop:previous().getBoundingClientRect().top,opacity:Number(getComputedStyle(row()).opacity)};
    const finishes=window.entryMotionFinishes.samples;if(finishes.length<2||finishes.some(sample=>sample.gap>=1||sample.positionGap>=1))throw Error('Natural layout handoff: '+JSON.stringify(finishes));
    const settledTop=row().getBoundingClientRect().top;await tick(80);
    const finishGap=Math.abs(row().getBoundingClientRect().top-settledTop);f.restore();await wait(()=>f.host.querySelector('[data-router-request="restored"]'));const restored=f.host.querySelector('[data-router-request="restored"]'),historyDirect=Number(getComputedStyle(restored).opacity)===1&&restored.style.height==='';
    return {oldTop,inputWidth,initial,middle,final,cardInitial,cardMiddle,retained,draftVisible,submittedSnapshot,earlyDraftVisible,draft:window.__markdownInput.text(f.host),copies:document.querySelectorAll('[data-send-flight]').length,oldCardCopies:document.body.querySelectorAll(':scope>[data-motion-key]').length,finishGap,historyDirect,errors:window.__fixtureErrors};
  })()`
})
assert.deepEqual(result.errors, [])
assert.equal(result.submittedSnapshot, true, 'capture submitted contents before asynchronous client identity preparation')
assert.equal(result.earlyDraftVisible, true, 'identity preparation must not fade the next draft')
assert.ok(result.initial.width > result.inputWidth * .95, 'handoff begins across the entire input box')
assert.ok(result.initial.height < result.middle.height && result.middle.height < result.final.height, 'bubble gradually occupies its actual layout height')
assert.ok(result.middle.opacity > 0 && result.middle.opacity < 1, 'bubble fades in')
assert.ok(result.middle.sourceOpacity > 0 && result.middle.sourceOpacity < 1, 'input snapshot fades out')
assert.ok(result.initial.oldTop > result.middle.oldTop && result.middle.oldTop > result.final.oldTop, 'existing card moves upward in stages')
assert.ok(result.cardInitial < result.cardMiddle && result.cardMiddle < result.final.cardHeight, 'assignment gradually occupies its height')
assert.equal(result.retained, true, 'native receipt retains the animated bubble')
assert.equal(result.draftVisible, true)
assert.equal(result.draft, '发送期间的新草稿')
assert.equal(result.copies, 0)
assert.equal(result.oldCardCopies, 0, 'scrolling does not create floating copies of old cards')
assert.equal(result.historyDirect, true, 'late history restoration does not replay entry animation')
assert.ok(result.finishGap < 1)
assert.equal(result.final.opacity, 1)
console.log('PASS Router full input handoff, gradual bubble/card occupancy, continuous push, receipt identity, draft and stable finish')
