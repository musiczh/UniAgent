import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'curation-picker', {
  screenshot: { width: 1120, height: 720, path: resolve('out/verification/requirement-context/curation-picker.png') },
  setup: `import{RequirementCurationPanel}from'./src/renderer/components/RequirementCurationPanel';import{testedAgentVersion}from'./src/shared/agentCompatibility';import'./src/renderer/components/requirementReader.css';import'./src/renderer/components/workspaceBrowser.css';
    const agents=[{id:'codex',name:'Codex',adapter:'codex',installed:true,capabilities:{startupSystemPrompt:true,modelSelect:true},models:[{id:'small',label:'Small',imageInput:true,efforts:['low','high']},{id:'flash',label:'Ferry DeepSeek Flash',imageInput:true,efforts:['low','high']}]},{id:'claude',name:'Claude Code',adapter:'claude',installed:true,capabilities:{startupSystemPrompt:true,modelSelect:true},models:[{id:'cheap',label:'Cheap model',imageInput:true,efforts:['low']}]}];
    for(const agent of agents)agent.version=testedAgentVersion(agent.adapter)||'1.0.0';
    let settings={requirementCuration:{enabled:true,agentId:'codex',model:'small',effort:'low'}},failure=false,release;
    const saves=[],actions=[],state={sessionId:'curation-r',agentId:'codex',model:'small',status:'running',current:{id:'current',sessionId:'task-a',kind:'task'},queue:[{id:'next',sessionId:'task-b',kind:'task'}],history:[{id:'current',title:'整理任务：正在整理的任务',detail:'当前任务仍使用 Small',status:'running'}],updatedAt:1};
    window.uniagent={listAgents:async()=>agents,getAppSettings:async()=>settings,requirementCuration:async(id,action='read')=>{if(action!=='read')actions.push(action);return state},setAppSettings:async patch=>{saves.push(patch);if(failure)throw Error('保存失败');await new Promise(resolve=>{release=resolve});settings={requirementCuration:{...settings.requirementCuration,...patch.requirementCuration}};return settings}};
    const host=document.body.appendChild(document.createElement('div'));host.style.cssText='position:fixed;inset:0;background:var(--bg);overflow:auto;padding:24px';createRoot(host).render(<RequirementCurationPanel id="r" initial={state} onOpenConversation={()=>{}}/>);
    window.pickerFixture={host,saves,actions,state,fail:(value=true)=>{failure=value},release:()=>release(),settings:()=>settings};`,
  inspect: `(async()=>{const f=window.pickerFixture,q=s=>f.host.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,40)),wait=async(probe,label)=>{for(let i=0;i<80;i++){if(probe())return;await tick()}throw Error(label)};
    q('.rr-curation-entry').click();await wait(()=>q('.rr-curation-model-picker')?.dataset.model==='small','load settings');
    const button=label=>[...q('.rr-curation-model-picker').querySelectorAll('[role=tab]')].find(b=>b.textContent===label),open=async()=>{q('[aria-label="后台整理模型"]').click();await tick()},choose=selector=>q(selector).click();
    const iconVisible=!!q('.rr-curation-model-picker summary .agent-icon'),removed=!f.host.textContent.includes('配置整理模型');
    await open();button('模型').click();await tick();choose('[data-title-model="flash"]');await wait(()=>f.saves.length===1,'save request');
    const savingDisabled=q('[aria-label="后台整理模型"]').getAttribute('aria-disabled')==='true';
    const currentUnchanged=f.state.model==='small'&&q('.rr-curation-current-pill strong').textContent==='正在整理的任务';
    f.release();await wait(()=>q('[aria-label="后台整理模型"]').getAttribute('aria-disabled')==='false','save completion');
    const nextTask=f.host.textContent.includes('从下一个整理任务生效'),switchPreserved=f.settings().requirementCuration.enabled===true&&!('enabled'in f.saves[0].requirementCuration);
    await open();button('模型').click();await tick();choose('[data-title-model="flash"]');await tick();const unchangedNotSaved=f.saves.length===1;
    button('思考参数').click();await tick();choose('[data-title-effort="high"]');await wait(()=>f.saves.length===2,'save effort');f.release();await wait(()=>q('[aria-label="后台整理模型"]').getAttribute('aria-disabled')==='false','effort completion');
    await open();choose('[data-title-agent="claude"]');await tick();const partialNotSaved=f.saves.length===2;choose('[data-title-model="cheap"]');await wait(()=>f.saves.length===3,'save agent');f.release();await wait(()=>q('[aria-label="后台整理模型"]').getAttribute('aria-disabled')==='false','agent completion');
    const changedIcon=q('.rr-curation-model-picker summary').title.includes('Claude Code');
    f.fail();await open();choose('[data-title-agent="codex"]');await tick();choose('[data-title-model="small"]');await wait(()=>f.host.textContent.includes('配置未保存'),'save failure');
    const rolledBack=q('.rr-curation-model-picker').dataset.agentId==='claude'&&q('.rr-curation-model-picker').dataset.model==='cheap';
    f.fail(false);await open();choose('[data-title-agent="codex"]');await tick();choose('[data-title-model="flash"]');await wait(()=>f.saves.length===5,'save after retry');f.release();await wait(()=>q('[aria-label="后台整理模型"]').getAttribute('aria-disabled')==='false','retry completion');
    await open();button('模型').click();await tick();
    const popup=q('.superagent-picker-pop').getBoundingClientRect(),withinViewport=popup.left>=0&&popup.right<=innerWidth&&popup.top>=0&&popup.bottom<=innerHeight;
    return{iconVisible,removed,savingDisabled,currentUnchanged,nextTask,switchPreserved,unchangedNotSaved,partialNotSaved,changedIcon,rolledBack,withinViewport,actions:f.actions,saves:f.saves.map(value=>value.requirementCuration)};})()`
})
for (const key of ['iconVisible','removed','savingDisabled','currentUnchanged','nextTask','switchPreserved','unchangedNotSaved','partialNotSaved','changedIcon','rolledBack','withinViewport']) assert.equal(result[key], true, key)
assert.deepEqual(result.actions, [], 'editing configuration does not pause or submit a curation job')
assert.equal(result.saves[0].model, 'flash')
assert.equal(result.saves[1].effort, 'high')
assert.equal(result.saves[2].agentId, 'claude')
console.log('PASS inline curation picker: agent/model/effort, shared saving, next job, failure rollback and popup bounds')
