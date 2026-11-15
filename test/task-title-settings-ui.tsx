import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import { RequirementTaskSettings } from '../src/renderer/components/RequirementTaskSettings'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { renderEventStream } from './regression/render-event-stream.mjs'

const noop = () => {}
const navigation = renderToStaticMarkup(<SettingsPanel agents={[]} onRedetect={noop} onInitialize={noop} onAgentsChanged={noop} onOpenSync={noop} onBack={noop} initialCategory='requirement-tasks' />)
assert.match(navigation, /<h2>superAgent配置<\/h2>/, 'the category opens the renamed superAgent settings')
assert.ok(navigation.indexOf('>superAgent配置</span>') > navigation.indexOf('>需求</span>'))
assert.ok(navigation.indexOf('>superAgent配置</span>') < navigation.indexOf('>Agent</span>'))
assert.doesNotMatch(navigation, /需求任务/, 'the settings entry and content use the same new name')
const windowedNavigation = renderToStaticMarkup(<SettingsPanel agents={[]} onRedetect={noop} onInitialize={noop} onAgentsChanged={noop} onOpenSync={noop} onBack={noop} initialCategory='requirement-tasks' windowed />)
assert.match(windowedNavigation, /<span class="main-panel-title">superAgent配置<\/span>/, 'the shortcut entry uses the same category name')

const savedUnavailable = renderToStaticMarkup(<RequirementTaskSettings agents={[]} settings={{ taskTitleGeneration: { enabled: true, agentId: 'removed', model: 'saved-model', modelSource: { kind: 'third-party', sourceId: 'retired-provider' } } } as any} />)
assert.match(savedUnavailable, /removed \/ saved-model \/ retired-provider：未找到所选 Agent/, 'invalid saved identity stays in the status area')
assert.doesNotMatch(savedUnavailable, /data-title-agent="removed"/, 'invalid Agent is absent from selectable candidates')
assert.match(savedUnavailable, /暂不可用/)
assert.match(savedUnavailable, /<button[^>]*disabled=""[^>]*>试生成<\/button>/)
const loading = renderToStaticMarkup(<RequirementTaskSettings agents={[]} settings={null} />)
assert.match(loading, /正在读取配置/)
assert.match(loading, /<button[^>]*disabled=""[^>]*>保存配置<\/button>/, 'missing settings cannot be optimistically saved')
for (const settings of [null, {}]) {
  const markup = renderToStaticMarkup(<RequirementTaskSettings agents={[]} settings={settings as any} />)
  for (const label of ['自动生成任务标题', '快捷回复']) {
    assert.match(markup, new RegExp(`aria-checked="false"[^>]*aria-label="${label}"`), label + ' renders off without saved settings')
  }
}

const result = await renderEventStream([], 'idle', 'task-title-settings', {
  setup: `
    import {RequirementTaskSettings} from './src/renderer/components/RequirementTaskSettings';
    import {SessionList} from './src/renderer/components/SessionList';
    const noop=()=>{};
    const agents=[{id:'codex',name:'Codex',adapter:'codex',models:[{id:'light',label:'Light Native',efforts:[]},{id:'light',label:'Light Provider',imageInput:true,efforts:[],modelSource:{kind:'third-party',sourceId:'provider-a'}}]}, {id:'claude',name:'Claude Code',adapter:'claude',models:[{id:'haiku',label:'Haiku',efforts:[]}]},{id:'traex',name:'TraeX',adapter:'traex',models:[{id:'light',label:'TraeX Light',imageInput:true,efforts:[]}]},{id:'missing',name:'Missing',adapter:'claude',models:[],installed:false}].map(a=>({installed:true,bin:'/fixture',builtin:true,icon:'',capabilities:{startupSystemPrompt:true,modelSelect:true,reasoningEffort:false,permissionModes:[]},lifecycle:{availability:'available'},...a}));
    let settings={autoCheckUpdate:false,taskTitleGeneration:{enabled:true}}, listener=noop, failSave=false, delayedSave=false, failTrial=false;
    const saves=[],trials=[],cancels=[],errors=[],createdSessions=[];let finishTrial,finishSave;
    window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
    window.confirm=()=>false;
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config:{enabled:false,agentId:'deepseek',model:JSON.stringify(['deepseek-official','deepseek-flash']),effort:'max',version:1},available:false,requests:[]}),createSession:async input=>{createdSessions.push(input);return {id:'unexpected-task'}},getAppSettings:async()=>settings,onUniAgentManagementChanged:cb=>{listener=cb;return noop},setAppSettings:async patch=>{saves.push(patch);if(failSave)throw Error('disk failed');if(delayedSave)return new Promise(resolve=>finishSave=()=>{settings={...settings,...patch,taskTitleGeneration:{...settings.taskTitleGeneration,...patch.taskTitleGeneration}};resolve(settings)});settings={...settings,...patch,taskTitleGeneration:{...settings.taskTitleGeneration,...patch.taskTitleGeneration}};return settings},testTaskTitleGeneration:async request=>{trials.push(request);if(failTrial)throw Error('provider failed');return new Promise(resolve=>finishTrial=value=>resolve(value))},cancelTaskTitleGenerationTest:async id=>{cancels.push(id)}}, {get:(t,k)=>k in t?t[k]:String(k).startsWith('on')?()=>noop:async()=>[]});
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='width:1000px;height:900px';const root=createRoot(host),guard={current:null};
    const mount=()=>root.render(React.createElement(RequirementTaskSettings,{agents,navigationGuard:guard}));mount();
    window.titleFixture={get host(){return host.querySelector('.codex-model-pane')||host},saves,trials,cancels,errors,createdSessions,guard,mount,unmount:()=>root.unmount(),finishTrial:v=>finishTrial(v),failTrial:v=>failTrial=v,failSave:v=>failSave=v,delayedSave:v=>delayedSave=v,finishSave:()=>finishSave(),push:config=>{settings={...settings,taskTitleGeneration:config};listener('settings')},unavailable:()=>{agents[1]={...agents[1],lifecycle:{availability:'checking'}};root.render(React.createElement(RequirementTaskSettings,{agents:[...agents],navigationGuard:guard}))},remount:config=>{root.render(null);setTimeout(()=>{settings={...settings,taskTitleGeneration:config};mount()},0)}};
  `,
  inspect: `(async()=>{
    const f=window.titleFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,10)),wait=async p=>{for(let i=0;i<150;i++){if(p())return;await tick()}throw Error('title UI timeout: '+f.host.innerText+' / '+f.errors)};
    const button=text=>[...f.host.querySelectorAll('button')].find(b=>b.textContent.trim()===text),picker=()=>q('.title-generator-picker'),agentValue=()=>picker()?.dataset.agentId,modelValue=()=>picker()?.dataset.model,modelLabel=()=>q('.sb-effort-model')?.textContent;
    const open=async section=>{picker().open=true;await tick();[...f.host.querySelectorAll('.superagent-picker-tabs button')].find(b=>b.textContent===(section==='思考强度'?'思考参数':section)).click();await tick()},select=async(label,value)=>{await open('Agent');q('[data-title-agent="'+value+'"]').click();await tick()},chooseModel=async label=>{await open('模型');[...f.host.querySelectorAll('[data-title-model]')].find(b=>b.textContent.trim()===label).click();await tick()};
    await wait(()=>button('保存配置')&&!f.host.textContent.includes('正在读取配置'));
    await open('Agent');const r={defaultAgent:agentValue(),defaultModel:modelValue(),traexSelectable:!!q('[data-title-agent=traex]'),uninstalled:q('[data-title-agent=missing]').disabled,noKey:!q('input[type=password]')};
    await select('标题生成 Agent','traex');r.traexAgent=agentValue();
    await select('标题生成 Agent','codex');await chooseModel('Light Provider');await select('标题生成 Agent','claude');r.clearedModel=modelValue();
    await chooseModel('Haiku');r.dirtyGuard=f.guard.current();button('试生成').click();await wait(()=>f.trials.length===1);r.unsavedTrial={saves:f.saves.length,config:f.trials[0].config};
    await select('标题生成 Agent','codex');await chooseModel('Light Provider');f.finishTrial({title:'迟到结果',needsClarification:false});await tick();r.lateTrialIgnored=!f.host.textContent.includes('迟到结果');r.cancelledOnEdit=f.cancels.length===1;
    f.failSave(true);button('保存配置').click();await wait(()=>f.host.textContent.includes('保存失败'));r.failedSaveDraft=modelLabel();
    f.failSave(false);f.delayedSave(true);button('保存配置').click();await wait(()=>f.saves.length===2);await select('标题生成 Agent','claude');await chooseModel('Haiku');f.finishSave();await wait(()=>button('保存配置')&&!button('保存配置').disabled);r.lateSaveDraft=modelLabel();r.savedSource=f.saves[1].taskTitleGeneration.modelSource;
    f.push({enabled:true,agentId:'codex',model:'light',modelSource:{kind:'third-party',sourceId:'provider-a'}});await tick();await tick();r.pushKeepsDraft=agentValue();
    f.delayedSave(false);button('保存配置').click();await wait(()=>button('保存配置')&&button('保存配置').disabled);r.nativeSave=f.saves[2].taskTitleGeneration;r.nativeSaveKeys=Object.keys(r.nativeSave);r.sourceCleared=Object.hasOwn(r.nativeSave,'modelSource')&&r.nativeSave.modelSource===undefined;r.savedUntested=f.host.textContent.includes('已保存 · 未试生成');if(!r.sourceCleared)return {...r,createdSessions:f.createdSessions.length,errors:f.errors};
    q('[aria-label="自动生成任务标题"]').click();await tick();button('试生成').click();await wait(()=>f.trials.length===2);r.trialWhileOff=f.trials[1].config.enabled===false;f.finishTrial({title:'修复历史图片',needsClarification:false});await wait(()=>f.host.textContent.includes('修复历史图片'));r.success=true;
    button('试生成').click();await wait(()=>f.trials.length===3);button('取消试生成').click();await tick();f.finishTrial({title:'取消后的结果',needsClarification:false});await tick();r.cancelledResultIgnored=!f.host.textContent.includes('取消后的结果');
    f.failTrial(true);button('试生成').click();await wait(()=>q('.title-preview-result[role=alert]'));r.trialFailure=f.trials.length===4;r.providerError=q('.title-preview-result strong').textContent;f.failTrial(false);
    button('试生成').click();await wait(()=>f.trials.length===5);f.finishTrial({title:null,needsClarification:true});await wait(()=>f.host.textContent.includes('目标信息不足'));r.clarification=true;
    f.remount({enabled:true,agentId:'codex',model:'light',modelSource:{kind:'third-party',sourceId:'retired-provider'}});await wait(()=>f.host.textContent.includes('retired-provider'));r.unavailableModel={disabled:button('试生成').disabled,value:f.host.textContent};
    f.push({enabled:true,agentId:'claude',model:'haiku'});await wait(()=>agentValue()==='claude');button('试生成').click();await wait(()=>f.trials.length===6);f.unavailable();await wait(()=>f.host.textContent.includes('当前检测不可用'));f.finishTrial({title:'执行方失效后的结果',needsClarification:false});await tick();r.liveUnavailable=button('试生成')?.disabled&&agentValue()==='claude';r.liveCancelled=!f.host.textContent.includes('执行方失效后的结果')&&f.cancels.length===3;
    f.remount({enabled:true,agentId:'codex',model:'light'});await wait(()=>agentValue()==='codex'&&!button('试生成').disabled);button('试生成').click();await wait(()=>f.trials.length===7);f.unmount();await tick();r.unmountCancelled=f.cancels.length===4;
    return {...r,createdSessions:f.createdSessions.length,errors:f.errors};
  })()`
})
// Preserve undefined property presence across the fixture's JSON result file,
// then apply the actual component's IPC payload to the real persistence store.
const directory = mkdtempSync(join(tmpdir(), 'task-title-settings-ui-'))
try {
  const store = new AppSettingsStore(directory)
  store.set({ autoCheckUpdate: false, taskTitleGeneration: { enabled: true, agentId: 'codex', model: 'light', modelSource: { kind: 'third-party', sourceId: 'provider-a' } } })
  const emittedConfig = Object.fromEntries(result.nativeSaveKeys.map((key: string) => [key, result.nativeSave[key]]))
  store.set({ taskTitleGeneration: emittedConfig as any })
  const restored = new AppSettingsStore(directory).get()
  assert.deepEqual(restored.taskTitleGeneration, { enabled: true, agentId: 'claude', model: 'haiku' }, 'native selection clears the old provider in durable settings')
  assert.equal(restored.autoCheckUpdate, false, 'saving title configuration preserves unrelated settings')
} finally { rmSync(directory, { recursive: true, force: true }) }
assert.deepEqual([result.defaultAgent,result.defaultModel,result.clearedModel], ['','',''])
assert.equal(result.traexSelectable, true); assert.equal(result.traexAgent, 'traex'); assert.equal(result.uninstalled, true); assert.equal(result.noKey, true)
assert.equal(result.dirtyGuard, false)
assert.deepEqual(result.unsavedTrial, { saves: 0, config: { enabled: true, agentId: 'claude', model: 'haiku' } })
assert.equal(result.cancelledOnEdit, true); assert.equal(result.lateTrialIgnored, true)
assert.equal(result.failedSaveDraft, 'Light Provider'); assert.equal(result.lateSaveDraft, 'Haiku')
assert.deepEqual(result.savedSource, { kind: 'third-party', sourceId: 'provider-a' })
assert.equal(result.pushKeepsDraft, 'claude'); assert.equal(result.sourceCleared, true, 'saving a native model explicitly clears a previously saved provider source'); assert.equal(result.savedUntested, true)
assert.equal(result.trialWhileOff, true); assert.equal(result.success, true)
assert.equal(result.cancelledResultIgnored, true); assert.equal(result.unmountCancelled, true)
assert.equal(result.trialFailure, true); assert.equal(result.clarification, true)
assert.equal(result.unavailableModel.disabled, true); assert.match(result.unavailableModel.value, /retired-provider/)
assert.equal(result.liveUnavailable, true); assert.equal(result.liveCancelled, true)
assert.equal(result.createdSessions, 0, 'explicit title trials never create a task/session')
assert.deepEqual(result.errors, [])
assert.equal(result.providerError, 'provider failed', 'the original trial error remains visible instead of a generic failure hint')

const embedded = await renderEventStream([], 'idle', 'task-title-settings-embedded-read', {
  setup: `
    import {useState} from 'react';
    import {RequirementTaskSettings} from './src/renderer/components/RequirementTaskSettings';
    const noop=()=>{},agents=[{id:'codex',name:'Codex',adapter:'codex',models:[{id:'light',label:'Light',efforts:[]}]},{id:'claude',name:'Claude Code',adapter:'claude',models:[{id:'haiku',label:'Haiku',efforts:[]}]}].map(agent=>({...agent,installed:true,bin:'/fixture',builtin:true,icon:'',capabilities:{startupSystemPrompt:true,modelSelect:true,reasoningEffort:false,permissionModes:[]},lifecycle:{availability:'available'}}));
    const settings={autoCheckUpdate:false,taskTitleGeneration:{enabled:true,agentId:'codex',model:'light'}},saves=[],errors=[],createdSessions=[];
    let readMode='fail',reads=0,listener=noop,unsubscribes=0,finishRead;
    window.confirm=()=>false;
    window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({getRouterSnapshot:async()=>({config:{enabled:false,agentId:'deepseek',model:JSON.stringify(['deepseek-official','deepseek-flash']),effort:'max',version:1},available:false,requests:[]}),createSession:async input=>{createdSessions.push(input);return {id:'unexpected-task'}},getAppSettings:async()=>{reads++;if(readMode==='fail')throw Error('fixture read failed');if(readMode==='delay')return new Promise(resolve=>finishRead=resolve);return settings},onUniAgentManagementChanged:callback=>{listener=callback;return()=>{unsubscribes++;listener=noop}},setAppSettings:async patch=>{saves.push(patch);return settings}}, {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>[]});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host),guard={current:null};
    function EmbeddedSettings(){const [parentSettings,setParentSettings]=useState(null);window.pushTitleParent=next=>setParentSettings(next);return React.createElement('div',{className:'set-page'},React.createElement(RequirementTaskSettings,{agents,settings:parentSettings,navigationGuard:guard}))}
    root.render(React.createElement(EmbeddedSettings));window.embeddedTitleFixture={host,saves,errors,createdSessions,guard,reads:()=>reads,unsubscribes:()=>unsubscribes,setReadMode:mode=>readMode=mode,refresh:()=>listener('settings'),finishRead:next=>finishRead(next),unmount:()=>root.unmount()};
  `,
  inspect: `(async()=>{
    const f=window.embeddedTitleFixture,q=selector=>f.host.querySelector(selector),tick=()=>new Promise(resolve=>setTimeout(resolve,10)),wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await tick()}throw Error('embedded title read timeout: '+f.host.textContent+' / '+f.errors)},button=text=>[...f.host.querySelectorAll('button')].find(item=>item.textContent.trim()===text),picker=()=>q('.title-generator-picker'),agentValue=()=>picker()?.dataset.agentId,modelValue=()=>picker()?.dataset.model,modelLabel=()=>q('.sb-effort-model')?.textContent;
    const open=async section=>{picker().open=true;await tick();[...f.host.querySelectorAll('.superagent-picker-tabs button')].find(b=>b.textContent===(section==='思考强度'?'思考参数':section)).click();await tick()},select=async(label,value)=>{await open('Agent');q('[data-title-agent="'+value+'"]').click();await tick()},chooseModel=async label=>{await open('模型');[...f.host.querySelectorAll('[data-title-model]')].find(b=>b.textContent.trim()===label).click();await tick()};
    await wait(()=>q('[aria-label="选择标题 Agent、模型与思考参数"]'));await tick();await tick();
    const r={initial:{readError:!!q('[role=alert]')?.textContent.includes('配置读取失败'),retry:!!button('重试'),agentDisabled:q('[aria-label="选择标题 Agent、模型与思考参数"]').getAttribute('aria-disabled')==='true',saveDisabled:button('保存配置').disabled,reads:f.reads(),saves:f.saves.length}};
    if(!r.initial.retry){f.unmount();return {...r,errors:f.errors}}
    f.setReadMode('ready');button('重试').click();await wait(()=>q('[aria-label="选择标题 Agent、模型与思考参数"]').getAttribute('aria-disabled')==='false');r.retry={reads:f.reads(),agent:agentValue(),model:modelLabel(),errorCleared:!q('[role=alert]'),toggleEnabled:!q('[aria-label="自动生成任务标题"]').disabled,saveDisabled:button('保存配置').disabled};
    f.setReadMode('delay');f.refresh();await wait(()=>f.reads()===3);window.pushTitleParent({taskTitleGeneration:{enabled:true,agentId:'claude',model:'haiku'}});await wait(()=>agentValue()==='claude');f.finishRead({taskTitleGeneration:{enabled:true,agentId:'codex',model:'light'}});await tick();r.parentWinsPendingRead={agent:agentValue(),model:modelLabel()};
    await select('标题生成 Agent','codex');await chooseModel('Light');window.pushTitleParent({taskTitleGeneration:{enabled:false,agentId:'claude',model:'haiku'}});await tick();r.dirtyAfterParent={agent:agentValue(),model:modelLabel(),guard:f.guard.current()};
    f.refresh();await wait(()=>f.reads()===4);f.unmount();f.finishRead({taskTitleGeneration:{enabled:true,agentId:'claude',model:'haiku'}});await tick();r.unmount={unsubscribes:f.unsubscribes(),visible:!!q('[aria-label="选择标题 Agent、模型与思考参数"]'),saves:f.saves.length,createdSessions:f.createdSessions.length};return {...r,errors:f.errors};
  })()`
})
assert.equal(embedded.initial.readError, true, 'an embedded null initial setting must surface a local read error')
assert.deepEqual(embedded.initial, { readError: true, retry: true, agentDisabled: true, saveDisabled: true, reads: 1, saves: 0 })
assert.deepEqual(embedded.retry, { reads: 2, agent: 'codex', model: 'Light', errorCleared: true, toggleEnabled: true, saveDisabled: true })
assert.deepEqual(embedded.parentWinsPendingRead, { agent: 'claude', model: 'Haiku' }, 'late local reads cannot overwrite an authoritative parent push')
assert.deepEqual(embedded.dirtyAfterParent, { agent: 'codex', model: 'Light', guard: false }, 'parent pushes preserve unsaved edits after retry recovery')
assert.deepEqual(embedded.unmount, { unsubscribes: 1, visible: false, saves: 0, createdSessions: 0 })
assert.deepEqual(embedded.errors, [])
const parameters = await renderEventStream([], 'idle', 'task-title-combined-parameters', {
  setup: `
    import {RequirementTaskSettings} from './src/renderer/components/RequirementTaskSettings';
    const agents=[{id:'codex',name:'Codex',adapter:'codex',models:[{id:'small',label:'Title Small',efforts:['low','high'],defaultEffort:'high'}]},{id:'deepseek',name:'DeepSeek Harness',adapter:'deepseek',models:[{id:'native',label:'Native Small',imageInput:true,efforts:['low','high'],defaultEffort:'low'}]},{id:'kimi',name:'Kimi Code',adapter:'kimi',models:[{id:'native',label:'Kimi',imageInput:true,efforts:[],thinkingOptions:['balanced','fast'],defaultThinking:'balanced'}]},{id:'mcode',name:'MiniMax Code',adapter:'mcode',models:[]}].map(agent=>({...agent,installed:true,bin:'/fixture',capabilities:{startupSystemPrompt:true,modelSelect:true,reasoningEffort:true,permissionModes:[]},lifecycle:{availability:'available'}}));
    let settings={taskTitleGeneration:{enabled:true,agentId:'codex',model:'small'}},finish,rejectTrial;
    const saves=[],trials=[],cancels=[];window.uniagent={onRouterChanged:()=>()=>{},getRouterSnapshot:async()=>({config:{enabled:false,agentId:'deepseek',model:JSON.stringify(['deepseek-official','deepseek-flash']),effort:'max',version:1},available:false,requests:[]}),setAppSettings:async patch=>{saves.push(patch);settings={...settings,...patch};return settings},testTaskTitleGeneration:input=>{trials.push(input);return new Promise((resolve,reject)=>{finish=resolve;rejectTrial=reject})},cancelTaskTitleGenerationTest:async id=>{cancels.push(id)}};
    const host=document.body.appendChild(document.createElement('div'));host.className='settings-inner';host.style.cssText='position:fixed;left:0;top:0;width:1000px;height:900px;overflow:auto;background:var(--bg);z-index:9999';const root=createRoot(host);
    root.render(React.createElement(RequirementTaskSettings,{agents,settings}));window.parameterFixture={get host(){return host.querySelector('.codex-model-pane')||host},saves,trials,cancels,finish:value=>finish(value),fail:message=>rejectTrial(new Error("Error invoking remote method 'task-title:test': Error: "+message)),unmount:()=>root.unmount()};
  `,
  inspect: `(async()=>{
    const f=window.parameterFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,10)),wait=async p=>{for(let i=0;i<150;i++){if(p())return;await tick()}throw Error('parameter UI timeout')},button=text=>[...f.host.querySelectorAll('button')].find(b=>b.textContent.trim()===text),open=async name=>{q('details').open=true;await tick();[...f.host.querySelectorAll('.superagent-picker-tabs button')].find(b=>b.textContent===(name==='思考强度'?'思考参数':name)).click();await tick()},chooseEffort=async value=>{await open(q('details').dataset.agentId==='kimi'?'Thinking':'思考强度');q('[data-title-effort="'+value+'"]').click();await tick()};
    await wait(()=>q('summary'));const r={singleEntry:f.host.querySelectorAll('summary').length===1,noSelect:f.host.querySelectorAll('select').length===0,legacyEffort:q('.sb-effort-lvl').textContent,initialSaveDisabled:button('保存配置').disabled,compact:q('summary').getBoundingClientRect().width===300};
    await open('Agent');r.unsupportedHidden=q('[data-title-agent=mcode]').disabled;r.kimiSelectable=!!q('[data-title-agent=kimi]');r.menuRects=[...f.host.querySelectorAll('.superagent-picker-tabs button')].map(b=>{const rect=b.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,hit:hit?.outerHTML.slice(0,140),ok:b.contains(hit)}});r.menuHittable=r.menuRects.every(item=>item.ok);await chooseEffort('high');button('试生成').click();await wait(()=>f.trials.length===1);r.trialEffort=f.trials[0].config.effort;
    await chooseEffort('low');f.finish({title:'旧强度迟到结果',needsClarification:false});await tick();r.cancelOnEffort=f.cancels.length===1&&!f.host.textContent.includes('旧强度迟到结果');button('保存配置').click();await wait(()=>f.saves.length===1);r.savedEffort=f.saves[0].taskTitleGeneration.effort;
    await open('Agent');q('[data-title-agent=deepseek]').click();await tick();r.cleared=q('details').dataset.model===''&&q('details').dataset.effort==='';await open('模型');q('[data-title-model=native]').click();await tick();await chooseEffort('high');button('保存配置').click();await wait(()=>f.saves.length===2);r.native=f.saves[1].taskTitleGeneration;r.nativeKeys=Object.keys(r.native);
    await open('Agent');q('[data-title-agent=kimi]').click();await tick();await open('模型');q('[data-title-model=native]').click();await tick();await chooseEffort('fast');button('保存配置').click();await wait(()=>f.saves.length===3);r.kimi=f.saves[2].taskTitleGeneration;button('试生成').click();await wait(()=>f.trials.length===2);r.kimiTrial=f.trials[1].config;f.fail('403 Your current subscription does not have access to Kimi Code right now.');await wait(()=>q('.title-preview-result[role=alert]'));r.subscriptionError=q('.title-preview-result strong').textContent;r.retryReady=!button('试生成').disabled;
    button('试生成').click();await wait(()=>f.trials.length===3);await chooseEffort('balanced');f.finish({title:'旧 Thinking 迟到结果',needsClarification:false});await tick();r.nativeCancel=f.cancels.length===2&&!f.host.textContent.includes('旧 Thinking 迟到结果');f.unmount();return r;
  })()`
})
assert.deepEqual({ singleEntry: parameters.singleEntry, noSelect: parameters.noSelect, legacyEffort: parameters.legacyEffort,
  initialSaveDisabled: parameters.initialSaveDisabled, compact: parameters.compact, unsupportedHidden: parameters.unsupportedHidden,
  trialEffort: parameters.trialEffort, cancelOnEffort: parameters.cancelOnEffort, savedEffort: parameters.savedEffort, cleared: parameters.cleared },
{ singleEntry: true, noSelect: true, legacyEffort: '低', initialSaveDisabled: true, compact: true, unsupportedHidden: true,
  trialEffort: 'high', cancelOnEffort: true, savedEffort: 'low', cleared: true })
assert.equal(parameters.menuHittable, true, 'all three primary menu entries must remain clickable outside the settings card: '+JSON.stringify(parameters.menuRects))
assert.equal(parameters.native.agentId, 'deepseek')
assert.equal(parameters.native.effort, 'high')
assert.ok(parameters.nativeKeys.includes('effort'), 'the new Agent saves its explicitly chosen effort')
assert.equal(parameters.kimiSelectable, true)
assert.equal(parameters.kimi.kimiThinking, 'fast')
assert.equal(parameters.kimi.effort, undefined)
assert.equal(parameters.kimiTrial.kimiThinking, 'fast')
assert.equal(parameters.subscriptionError, '403 Your current subscription does not have access to Kimi Code right now.')
assert.equal(parameters.retryReady, true, 'subscription errors leave the test control usable')
assert.equal(parameters.nativeCancel, true, 'native Thinking edits cancel the stale trial')
console.log('PASS embedded title settings: null read failure/retry, controls after recovery, no optimistic save, parent/read race, dirty push preservation and safe unmount')
console.log('PASS title settings UI: standalone category, explicit Agent/model/source, unsupported choices, save failure/races, draft push guard, unsaved/off trial, edit/cancel/unmount and stale results')
