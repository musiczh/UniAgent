import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'agent-defaults-ui', {
  setup: `
    import {SettingsPanel} from './src/renderer/components/SettingsPanel';
    import {NewTaskPanel} from './src/renderer/components/NewTaskPanel';
    import {emptyNativeCapabilitySnapshot} from './src/shared/nativeCapabilities';
    import {installMarkdownInputDriver} from './test/fixtures/markdown-input-driver.mjs';
    installMarkdownInputDriver();
    const agents=[
      {id:'codex',name:'Codex',adapter:'codex',defaultModel:'native',models:[
        {id:'native',label:'Native',efforts:['low','high'],defaultEffort:'low'},
        {id:'last',label:'Last',efforts:['low','high'],defaultEffort:'low'}]},
      {id:'kimi',name:'Kimi Code',adapter:'kimi',defaultModel:'kimi-native',models:[
        {id:'kimi-native',label:'Kimi Native',efforts:[],thinkingOptions:['balanced','fast'],defaultThinking:'balanced'}]}
    ].map(agent=>({...agent,installed:true,builtin:true,bin:'/fixture/'+agent.id,version:'1.0.0',
      capabilities:{modelSelect:true,reasoningEffort:true,permissionModes:[{id:'read-only',label:'只读'}]},
      lifecycle:{availability:'available',auth:'authenticated',health:'healthy',updateStatus:'current'}}));
    const projects=[{id:'space',name:'默认空间',primaryDirectory:'/fixture',additionalDirectories:[],isDefault:true}];
    let prefs={lastAgentId:'codex',lastByAgent:{codex:{model:'last',effort:'high',defaultModel:'native',defaultEffort:'low'},kimi:{model:'kimi-native',kimiThinking:'fast',defaultThinking:'balanced'}}},failSave=false;
    const created=[],errors=[];
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({
      homeDir:'/fixture',getPrefs:async()=>structuredClone(prefs),
      setPrefs:async(id,patch)=>{if(failSave)throw Error('disk failed');prefs=JSON.parse(JSON.stringify({...prefs,lastByAgent:{...prefs.lastByAgent,[id]:{...prefs.lastByAgent[id],...patch}}}));return structuredClone(prefs)},
      getAppSettings:async()=>({enabledAgentIds:['codex','kimi'],sidebarShortcuts:[],autoCheckUpdate:false}),getAppVersion:async()=>'1.1.0',
      feishuStatus:async()=>({configured:false,status:{phase:'idle'}}),listProjects:async()=>projects,listRequirements:async()=>[],listPresets:async()=>[],teamCatalog:async()=>({teams:[],errors:[]}),
      getPersonalAssistant:async()=>undefined,getRouterSnapshot:async()=>({config:{enabled:false,version:1},available:false,requests:[]}),
      getProjectGitInfo:async()=>({canCreateWorktree:false,branches:[]}),getNativeCapabilities:async input=>emptyNativeCapabilitySnapshot(input.agentId,input.workdir)
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);host.style.cssText='position:fixed;inset:0';let version=0;
    const settings=()=>root.render(React.createElement(SettingsPanel,{key:++version,agents,initialCategory:'agent',onRedetect:()=>{},onInitialize:()=>{},onAgentsChanged:()=>{},onOpenSync:()=>{},onBack:()=>{}}));
    const task=id=>root.render(React.createElement(NewTaskPanel,{key:++version,agents,enabledAgentIds:['codex','kimi'],quickCreateSeed:{agentId:id,projectId:'space'},promptPrefill:{text:'验证默认参数'},onCreate:async config=>{created.push(config);return {id:'created-'+created.length,config,status:'idle',createdAt:1,title:'Fixture'}},onCommitCreatedSession:()=>{}}));
    settings();window.defaultsFixture={host,created,errors,settings,task,getPrefs:()=>prefs,failSave:value=>failSave=value};
  `,
  inspect: `(async()=>{
    const f=window.defaultsFixture,q=selector=>f.host.querySelector(selector),tick=()=>new Promise(resolve=>setTimeout(resolve,15));
    const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await tick()}throw Error('default parameter UI timeout: '+f.errors+' / '+f.host.textContent)};
    const select=label=>q('select[aria-label="'+label+'"]'),model=()=>select('默认模型'),effort=()=>select('默认推理强度');
    const choose=async(label,value)=>{const element=select(label);element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));await tick();await tick()};
    const open=async name=>{await wait(()=>q('button[aria-label="查看 '+name+' 详情"]'));q('button[aria-label="查看 '+name+' 详情"]').click();await wait(()=>model()&&!model().disabled)};
    await open('Codex');
    const r={modelOptions:[...model().options].map(option=>option.textContent),effortOptions:[...effort().options].map(option=>option.textContent),initial:[model().value,effort().value]};
    await choose('默认推理强度','');r.fixedModelKept=model().value==='native'&&effort().value==='';
    await choose('默认推理强度','low');await choose('默认模型','');r.fixedEffortKept=model().value===''&&effort().value==='low';
    await choose('默认推理强度','');await choose('默认模型','native');r.followEffortKept=effort().value===''&&f.getPrefs().lastByAgent.codex.defaultEffort===undefined;
    await choose('默认模型','');f.failSave(true);await choose('默认模型','last');r.failedSaveKept=model().value===''&&f.host.textContent.includes('默认配置保存失败');f.failSave(false);
    f.settings();await open('Codex');r.reopened=[model().value,effort().value];
    f.task('codex');await wait(()=>q('.new-task-send-btn')&&!q('.new-task-send-btn').disabled);q('.new-task-send-btn').click();await wait(()=>f.created.length===1);
    r.codex={model:f.created[0].model,effort:f.created[0].effort};r.afterSubmit=f.getPrefs().lastByAgent.codex;
    f.settings();await open('Kimi Code');await choose('默认思考级别','');r.kimiFollow=select('默认思考级别').value==='';
    f.task('kimi');await wait(()=>q('.new-task-send-btn')&&!q('.new-task-send-btn').disabled);q('.new-task-send-btn').click();await wait(()=>f.created.length===2);
    r.kimi={model:f.created[1].model,thinking:f.created[1].kimiThinking};
    r.kimiPersisted=f.getPrefs().lastByAgent.kimi.kimiThinking;r.errors=f.errors;return r;
  })()`
})

assert.deepEqual(result.modelOptions, ['沿用上一次的选择', 'Native', 'Last'])
assert.deepEqual(result.effortOptions, ['沿用上一次的选择', '低', '高'])
assert.deepEqual(result.initial, ['native', 'low'], 'existing fixed defaults remain selected')
for (const key of ['fixedModelKept', 'fixedEffortKept', 'followEffortKept', 'failedSaveKept', 'kimiFollow']) assert.equal(result[key], true, key)
assert.deepEqual(result.reopened, ['', ''], 'the follow-last selections survive reopening Settings')
assert.deepEqual(result.codex, { model: 'last', effort: 'high' }, 'new-task submission uses the remembered values')
assert.equal(result.afterSubmit.defaultModel, undefined)
assert.equal(result.afterSubmit.defaultEffort, undefined, 'submitting a task must not turn follow-last into a fixed default')
assert.deepEqual(result.kimi, { model: 'kimi-native', thinking: 'fast' })
assert.equal(result.kimiPersisted, 'fast')
assert.deepEqual(result.errors, [])
console.log('PASS Agent defaults: first options, independent selections, save failure, reopening, real new-task submission and native thinking history')
