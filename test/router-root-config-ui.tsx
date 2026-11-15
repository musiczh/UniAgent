import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'router-root-config-ui', {
  setup: `
    import {RouterPanel} from './src/renderer/components/RouterPanel';
    const agents=['codex','claude'].map(id=>({id,name:id==='codex'?'Codex':'Claude Code',adapter:id,installed:true,
      models:[{id:'first',label:'当前模型',imageInput:true,efforts:['high','xhigh']},{id:'second',label:'另一模型',imageInput:true,efforts:['high','xhigh']}],
      capabilities:{startupSystemPrompt:true,streaming:true,imageAttachments:true,permissionModes:[]},lifecycle:{availability:'available'}}));
    let snapshot={config:{enabled:true,agentId:'codex',model:'first',effort:'high',version:3},available:true,sessionId:'root-session',requests:[]};
    const calls=[],errors=[],listeners=new Set();let resolveSave,rejectSave;
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({getRouterSnapshot:async()=>snapshot,
      openRouter:async()=>({id:'root-session',title:'RouterAgent',status:'running',createdAt:1,config:{agentId:'claude',model:'second',workdir:'/wrong-directory',managedPurpose:'router'}}),
      getEvents:async()=>[],getAppSettings:async()=>({defaultTaskWorktree:false}),getPrefs:async()=>({lastByAgent:{}}),listProjects:async()=>[],listRequirements:async()=>[],
      onRouterChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
      saveRouterConfig:(config,version)=>{calls.push({config,version});return new Promise((resolve,reject)=>{resolveSave=()=>{snapshot={...snapshot,config:{...config,version:version+1}};listeners.forEach(callback=>callback());resolve(snapshot)};rejectSave=()=>reject(Error('配置保存失败，原配置保留'))})}
      },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0';
    createRoot(host).render(React.createElement(RouterPanel,{agents,onOpenTask:()=>{},onSettings:()=>{},mergeEvent:(events,event)=>[...events,event]}));
    window.rootFixture={host,calls,errors,finish:()=>resolveSave(),fail:()=>rejectSave()};
  `,
  inspect: `(async()=>{
    const f=window.rootFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,15));
    const wait=async check=>{for(let i=0;i<180;i++){if(check())return;await tick()}throw Error('Root config timeout: '+f.host.textContent+' / '+f.errors)};
    await wait(()=>f.host.querySelector('.session-header'));for(let i=0;i<10;i++)await tick();
    const picker=f.host.querySelector('.session-header .run-config-picker'),checks={headerConfigPresent:!!picker};
    if(!picker)return {checks,errors:f.errors};
    const summary=picker.querySelector('summary'),style=getComputedStyle(summary);
    checks.noDirectory=!f.host.querySelector('.session-header .topbar-title-path')&&!f.host.querySelector('.session-header').textContent.includes('/wrong-directory');
    checks.frameless=style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.borderTopWidth==='0px';
    checks.headerClickable=getComputedStyle(picker).webkitAppRegion==='no-drag';
    checks.actualConfig=!!summary.querySelector('.agent-icon-codex')&&summary.textContent.includes('当前模型')&&summary.textContent.includes('高')&&!summary.textContent.includes('Codex');
    const entry=label=>[...picker.querySelectorAll('.sb-sub-entry')].find(row=>row.querySelector('.sb-entry-body')?.firstChild?.textContent===label);
    const option=label=>[...picker.querySelectorAll('[role=option]')].find(row=>row.textContent.trim()===label);
    const save=()=>picker.querySelector('[aria-label="保存 Root Agent 配置"]');
    summary.click();await wait(()=>option('Codex'));entry('模型').click();await wait(()=>option('另一模型'));option('另一模型').click();await wait(()=>option('极高'));option('极高').click();await tick();
    if(!picker.open){summary.click();await tick()}
    checks.draftSummaryNotApplied=summary.textContent.includes('当前模型')&&f.calls.length===0;
    save().click();save().click();await wait(()=>f.calls.length===1);
    checks.busySaveKeepsRouting=f.calls[0].version===3&&f.calls[0].config.agentId==='codex'&&f.calls[0].config.model==='second'&&f.calls[0].config.effort==='xhigh'&&f.calls[0].config.enabled;
    checks.savingLocked=save().disabled&&summary.getAttribute('aria-disabled')==='true';
    f.fail();await wait(()=>picker.querySelector('[role=alert]'));
    checks.failureKeepsSavedSummary=summary.textContent.includes('当前模型');
    checks.failureKeepsDraft=picker.textContent.includes('另一模型')&&!save().disabled;
    save().click();await wait(()=>f.calls.length===2);f.finish();await wait(()=>summary.textContent.includes('另一模型')&&summary.textContent.includes('极高'));
    checks.successRefreshesSummary=summary.title.includes('Codex')&&save().disabled;
    picker.removeAttribute('open');await tick();summary.click();await wait(()=>option('Claude Code'));option('Claude Code').click();await tick();
    save().click();await wait(()=>f.calls.length===3);checks.agentSelectable=f.calls[2].config.agentId==='claude'&&f.calls[2].version===4;f.finish();
    await wait(()=>summary.querySelector('.agent-icon-claude'));
    checks.agentIconChanges=!summary.textContent.includes('Claude Code')&&summary.title.includes('Claude Code');
    return {checks,errors:f.errors};
  })()`
})

assert.deepEqual(result.errors, [])
assert.deepEqual(Object.entries(result.checks).filter(([, passed]) => !passed).map(([name]) => name), [])
console.log('PASS Root Agent header: saved config, icon-only frameless trigger, draft changes, versioned save, failure retention and Agent switching')
