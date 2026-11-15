import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'qoder-context-selection', {
  setup: `
    import {Composer} from './src/renderer/components/Composer';
    window.uniagent=new Proxy({listPresets:async()=>[]},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
    const model={id:'kimi',label:'Kimi-K3.1-Pro',efforts:['max'],defaultEffort:'max',contextWindow:400000,qoderContextWindows:[200000,400000,1000000]};
    const agent={id:'qoder',adapter:'qoder',name:'Qoder',installed:true,models:[model],defaultModel:model.id,capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[]}};
    const capabilities={agentId:agent.id,workdir:'/fixture',source:'native',candidates:[],errors:[],actions:{goal:false,review:false,plan:null}};
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;left:40px;bottom:30px;width:600px';
    const changes=[],root=createRoot(host);
    function Fixture(){
      const [config,setConfig]=React.useState({agentId:agent.id,model:model.id,workdir:'/fixture'});
      const [status,setStatus]=React.useState('idle');
      window.contextFixture={host,changes,setConfig,setStatus};
      return React.createElement(Composer,{agent,config,status,capabilities,capabilitiesReady:true,sessionId:'context-selection',queue:[],contextUsed:0,
        onUpdateConfig:patch=>{changes.push(patch);setConfig(value=>({...value,...patch}))},
        onSend:()=>{},onForceSend:()=>{},onInterrupt:()=>{},onSetCollaborationMode:()=>{},onRunNativeAction:()=>{},onDequeue:()=>{},onPromoteQueue:()=>{},onEditQueueItem:()=>{}});
    }
    root.render(React.createElement(Fixture));
  `,
  inspect: `(async()=>{
    const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
    const wait=async check=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error('Context selection fixture did not settle')};
    await wait(()=>window.contextFixture?.host.querySelector('details.sb-agent'));
    const f=window.contextFixture,menu=f.host.querySelector('details.sb-agent'),rows=()=>[...f.host.querySelectorAll('.sb-sub-menu [role=option]')];
    const entry=()=>[...menu.querySelectorAll('.sb-sub-entry')].find(button=>button.textContent.includes('上下文窗口'));
    const open=async()=>{menu.querySelector('summary').click();await tick();entry().click();await wait(()=>rows().length===3)};
    const snapshot=()=>rows().map(row=>({label:row.textContent.trim(),selected:row.getAttribute('aria-selected')==='true',
      background:getComputedStyle(row.querySelector('.sb-sub-radio')).backgroundImage,border:getComputedStyle(row.querySelector('.sb-sub-radio')).borderTopColor}));
    await open();const defaults=snapshot();
    const select=async label=>{rows().find(row=>row.textContent.trim()===label).click();await wait(()=>rows().find(row=>row.textContent.trim()===label)?.getAttribute('aria-selected')==='true');return snapshot()};
    const smallest=await select('200,000 Token'),largest=await select('1,000,000 Token');
    menu.querySelector('summary').click();await wait(()=>!menu.open&&rows().length===0);await open();const reopened=snapshot();
    f.setConfig(value=>({...value,qoderContextWindow:400000}));await wait(()=>rows()[1].getAttribute('aria-selected')==='true');const explicit=snapshot();
    document.documentElement.style.setProperty('--blue','#ad72ed');const themed=snapshot();
    f.setStatus('running');await wait(()=>entry().disabled);const locked=snapshot(),disabled=rows().every(row=>row.disabled);
    rows()[0].click();await tick();
    return {defaults,smallest,largest,reopened,explicit,themed,locked,disabled,changes:f.changes,errors:window.__fixtureErrors};
  })()`
})

for (const [name, label] of Object.entries({
  defaults: '400,000 Token', smallest: '200,000 Token', largest: '1,000,000 Token',
  reopened: '1,000,000 Token', explicit: '400,000 Token', themed: '400,000 Token', locked: '400,000 Token'
})) {
  const rows = result[name]
  assert.deepEqual(rows.filter(row => row.selected).map(row => row.label), [label], `${name}: semantic selection follows the actual configuration`)
  assert.deepEqual(rows.filter(row => row.background.includes('radial-gradient')).map(row => row.label), [label], `${name}: only the selected option has a visible center dot`)
  assert.ok(rows.filter(row => !row.selected).every(row => row.background === 'none'), `${name}: other options keep empty circles`)
  assert.ok(rows.filter(row => !row.selected).every(row => row.border !== rows.find(row => row.selected).border), `${name}: the selected ring has a distinct color`)
}
assert.equal(result.themed.find(row => row.selected).border, 'rgb(173, 114, 237)', 'selection follows the existing theme color')
assert.deepEqual(result.changes, [{ qoderContextWindow: 200000 }, { qoderContextWindow: 1000000 }], 'clicks preserve the existing save payload; disabled options cannot change it')
assert.equal(result.disabled, true)
assert.deepEqual(result.errors, [])
console.log('PASS Qoder context selection: default, explicit, switching, reopening, theme and disabled menu')
