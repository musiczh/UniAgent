import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'timer-fixture', {
  setup: `
    import { SideChatPanel } from './src/renderer/components/SideChatPanel';
    import { TurnStatusBar } from './src/renderer/components/EventStream';
    const noop = () => {};
    const now = 100000;
    window.timerNow = now;
    Date.now = () => window.timerNow;
    window.timerErrors = [];
    window.addEventListener('error', event => window.timerErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.timerErrors.push(String(event.reason)));
    const config = {agentId:'codex', workdir:'/fixture', permissionMode:'full-access'};
    const agent = {id:'codex', name:'Codex', adapter:'codex', bin:'codex', installed:true,
      models:[], capabilities:{sideChat:true, modelSelect:false, reasoningEffort:false, permissionModes:[]}};
    let sideState = {config, status:'idle', queue:[], hasLiveStreamer:true};
    let sideEvents = [];
    let eventListener = noop;
    let stateListener = noop;
    window.uniagent = new Proxy({
      getSideEvents:async()=>sideEvents,
      getSideState:async()=>sideState,
      closeSideChat:async()=>{sideEvents=[];sideState={...sideState,status:'idle'}},
      onSideEvent:listener=>{eventListener=listener;return ()=>{eventListener=noop}},
      onSideState:listener=>{stateListener=listener;return ()=>{stateListener=noop}},
      getNativeCapabilities:async()=>({agentId:'codex',workdir:'/fixture',source:'provider-native',
        candidates:[],errors:[],actions:{goal:false,review:false,plan:null}}),
      listPresets:async()=>[], getPrefs:async()=>({lastByAgent:{}})
    }, {get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? ()=>noop : async()=>null});
    window.pushSideEvent = (sessionId,event) => eventListener({sessionId,event});
    window.pushSideState = (sessionId,status) => {
      const next = {...sideState,status};
      if (sessionId === 'side-session') sideState = next;
      stateListener({sessionId,state:next});
    };
    window.saveSideEvents = events => {sideEvents=events};
    localStorage.setItem('ua.sidePanelWidth','320');
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent='.side-panel {animation:none!important}';
    const sideHost = document.body.appendChild(document.createElement('div'));
    Object.assign(sideHost.style,{width:'700px',height:'600px'});
    let sideRoot;
    window.mountSide = () => {
      sideRoot=createRoot(sideHost);
      sideRoot.render(React.createElement(SideChatPanel,{open:true,sessionId:'side-session',agent,onClose:noop,onPromote:noop}));
    };
    window.unmountSide = () => sideRoot.unmount();
    window.mountSide();
    const mainHost=document.body.appendChild(document.createElement('div'));
    createRoot(mainHost).render(React.createElement(TurnStatusBar,{status:'running',events:[
      {sessionId:'main',seq:1,ts:40000,type:'user_message',payload:{text:'主对话'}},
      {sessionId:'main',seq:2,ts:41000,type:'system_notice',payload:{id:'main-speed',kind:'token_speed',
        speed:{outputTokens:999,durationMs:1000,metric:'request',source:'main'}}}
    ]}));
  `,
  inspect: `(async()=>{
    const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
    const event = (seq,ts,type,payload={}) => ({sessionId:'side-session',seq,ts,type,payload,state:'success'});
    const input = event(1,90000,'user_message',{text:'侧边对话'});
    const sample = event(2,95000,'system_notice',{id:'side-speed',kind:'token_speed',
      speed:{outputTokens:100,durationMs:2000,metric:'request',source:'side'}});
    const plan = event(3,96000,'plan_update',{steps:[{text:'检查',status:'in_progress'}]});
    const finished = event(4,102000,'turn_completed');
    const snapshot = () => {
      const side=document.querySelector('.side-panel');
      const timer=side?.querySelector('.turn-timer');
      return {duration:timer?.querySelector('.turn-timer-text')?.textContent ?? null,
        state:timer?.className ?? null, speed:timer?.querySelector('.turn-speed-value')?.textContent ?? null,
        tooltip:timer?.querySelector('.turn-speed-tooltip')?.textContent ?? null,
        plan:!!side?.querySelector('.plan-pill'),
        beforeComposer:!!timer && !!(timer.compareDocumentPosition(side.querySelector('.side-composer')) & Node.DOCUMENT_POSITION_FOLLOWING),
        main:document.querySelector('body > div:last-of-type .turn-timer')?.textContent ?? null};
    };
    await wait(150);
    const empty=snapshot();
    window.pushSideEvent('other-session',input);
    window.pushSideState('other-session','running');
    await wait(40);
    const other=snapshot();
    window.pushSideEvent('side-session',input);
    window.pushSideEvent('side-session',sample);
    window.pushSideEvent('side-session',plan);
    window.pushSideState('side-session','running');
    await wait(80);
    const running=snapshot();
    const layouts=[];
    for (const width of [320,460,640]) {
      const side=document.querySelector('.side-panel');
      side.querySelector('.subagent-panel-grip').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      window.dispatchEvent(new MouseEvent('mousemove',{clientX:window.innerWidth-width,bubbles:true}));
      window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      await wait(50);
      const timer=side.querySelector('.turn-timer');
      const button=timer?.querySelector('.turn-speed-value');
      if (button) button.focus();
      const panel=side.getBoundingClientRect(), capsule=timer?.getBoundingClientRect(), tooltip=timer?.querySelector('.turn-speed-tooltip')?.getBoundingClientRect();
      layouts.push({width:panel.width,capsule:capsule ? {left:capsule.left-panel.left,right:capsule.right-panel.right} : null,
        tooltip:tooltip ? {left:tooltip.left-panel.left,right:tooltip.right-panel.right,width:tooltip.width} : null});
    }
    window.timerNow=102000;
    await wait(1100);
    const advanced=snapshot();
    window.pushSideState('side-session','awaiting-approval');
    await wait(40);
    const waiting=snapshot();
    window.pushSideEvent('side-session',finished);
    window.pushSideState('side-session','idle');
    await wait(60);
    const done=snapshot();
    window.timerNow=120000;
    await wait(1100);
    const frozen=snapshot();
    window.saveSideEvents([input,sample,plan,finished]);
    window.unmountSide();
    window.mountSide();
    await wait(120);
    const restored=snapshot();
    window.pushSideEvent('side-session',event(5,120000,'user_message',{text:'下一轮'}));
    window.pushSideState('side-session','running');
    await wait(60);
    const next=snapshot();
    window.timerNow=122000;
    window.pushSideEvent('side-session',{...event(6,122000,'error',{message:'连接失败'}),state:'failed'});
    window.pushSideState('side-session','idle');
    await wait(60);
    const failedWithoutCompletion=snapshot();
    window.timerNow=130000;
    window.pushSideEvent('side-session',event(7,130000,'user_message',{text:'重试'}));
    window.pushSideState('side-session','running');
    await wait(60);
    const retry=snapshot();
    window.timerNow=132000;
    window.pushSideEvent('side-session',{...event(8,132000,'turn_completed'),state:'failed'});
    window.pushSideState('side-session','idle');
    await wait(60);
    const failedCompletion=snapshot();
    window.timerNow=134000;
    window.pushSideEvent('side-session',event(9,134000,'user_message',{text:'再次重试'}));
    window.pushSideState('side-session','running');
    window.pushSideEvent('side-session',event(10,137000,'turn_completed'));
    window.pushSideState('side-session','idle');
    await wait(60);
    const recovered=snapshot();
    document.querySelector('.side-new-btn').click();
    await wait(80);
    const cleared=snapshot();
    return {empty,other,running,layouts,advanced,waiting,done,frozen,restored,next,failedWithoutCompletion,retry,failedCompletion,recovered,cleared,errors:window.timerErrors};
  })()`
})

assert.deepEqual(result.errors, [], 'side chat and timer render without runtime errors')
assert.equal(result.empty.duration, null, 'an empty side chat has no timer')
assert.equal(result.other.duration, null, 'events from another side chat cannot create a timer')
assert.equal(result.running.duration, '10s', 'side timer starts from the side conversation input')
assert.match(result.running.state, /st-running/)
assert.match(result.running.speed, /上次请求.*≈50\.0.*token\/s/)
assert.match(result.running.tooltip, /输出 token\s*100/)
assert.match(result.running.main, /1m.*≈999\.0/, 'the main timer retains its own events and speed')
assert.equal(result.running.beforeComposer, true, 'the timer appears before the side composer')
assert.equal(result.running.plan, false, 'the side panel only adds the approved timer capsule')
for (const entry of result.layouts) {
  assert.ok(entry.capsule && entry.capsule.left >= -1 && entry.capsule.right <= 1, `${entry.width}px: timer stays inside the side panel`)
  assert.ok(entry.tooltip && entry.tooltip.width > 0 && entry.tooltip.left >= -1 && entry.tooltip.right <= 1, `${entry.width}px: speed details stay inside the side panel: ${JSON.stringify(entry.tooltip)}`)
}
assert.equal(result.advanced.duration, '12s', 'the live side timer advances')
assert.match(result.waiting.state, /st-waiting/, 'approval state is reflected by the side timer')
assert.equal(result.done.duration, '12s')
assert.match(result.done.state, /st-done/)
assert.match(result.done.speed, /请求均速.*≈50\.0/)
assert.equal(result.frozen.duration, '12s', 'the completed side timer remains frozen')
assert.equal(result.restored.duration, '12s', 'the last side turn is restored from its events')
assert.equal(result.next.duration, '0s', 'a new side turn starts a fresh timer')
assert.equal(result.next.speed, null, 'the previous turn speed is not reused as the current turn speed')
assert.match(result.failedWithoutCompletion.state, /st-error/, 'a fatal side error without a completion event is not shown as success')
assert.match(result.retry.state, /st-running/, 'a new running turn clears the previous error state')
assert.match(result.failedCompletion.state, /st-error/, 'a failed side completion is not shown as success')
assert.match(result.recovered.state, /st-done/, 'a later successful turn clears the previous error state')
assert.equal(result.cleared.duration, null, 'starting a new conversation clears the timer')
console.log('side chat timer: independent events, live states, speed, restoration, reset and widths passed')
