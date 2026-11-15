import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

for (const width of [1100,540]) {
  const result = await renderEventStream([], 'idle', 'superagent-selectors', {
    screenshot: { width, height: 900, path: `/tmp/uniagent-superagent-selectors-${width}.png` },
    setup: `import {RequirementTaskSettings} from './src/renderer/components/RequirementTaskSettings';
      const noop=()=>{},longName='Ferry DeepSeek Vision Model With A Very Long Name '.repeat(3);
      const base={installed:true,capabilities:{startupSystemPrompt:true,modelSelect:true,streaming:true,permissionModes:[]},models:[{id:'text',label:'Text only',imageInput:false,efforts:[]},{id:'vision',label:longName,imageInput:true,efforts:['low','high'],defaultEffort:'high'}]};
      const agents=[{...base,id:'codex',adapter:'codex',name:'Codex'},{...base,id:'qoder',adapter:'qoder',name:'Qoder CN'},
        {...base,id:'kimi',adapter:'kimi',name:'No System',capabilities:{...base.capabilities,startupSystemPrompt:false}},
        {...base,id:'locked',adapter:'claude',name:'Needs Login',authenticationRequired:true}];
      const settings={requirementCuration:{enabled:true,agentId:'codex',model:'vision'},taskTitleGeneration:{enabled:true,agentId:'codex',model:'vision',effort:'low'}};
      window.uniagent=new Proxy({getRouterSnapshot:async()=>({config:{enabled:false,agentId:'codex',model:'vision',version:1},available:true}),onRouterChanged:()=>noop,setAppSettings:async patch=>({...settings,...patch})},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>[]});
      const host=document.body.appendChild(document.createElement('div'));host.className='settings-inner';host.style.cssText='position:fixed;inset:0;overflow:auto;padding:20px;background:var(--bg);';createRoot(host).render(<RequirementTaskSettings agents={agents} settings={settings}/>);window.selectorFixture={host};`,
    inspect: `(async()=>{const host=window.selectorFixture.host,tick=()=>new Promise(r=>setTimeout(r,30)),wait=async check=>{for(let i=0;i<100;i++){if(check())return;await tick()}throw Error('selector fixture timeout')},trigger=label=>host.querySelector('summary[aria-label="'+label+'"]');await wait(()=>trigger('整理模型'));
      const curation=host.querySelector('.requirement-curation-settings'),widths=[...curation.querySelectorAll('summary')].map(item=>item.getBoundingClientRect().width),model=trigger('整理模型'),value=model.querySelector('.superagent-picker-value');
      const equal=widths.every(item=>item===widths[0]),truncated=value.scrollWidth>value.clientWidth&&model.title.includes('Very Long Name');
      const effort=trigger('整理思考强度');const defaultEffortMatchesRuntime=effort.textContent.includes('低');effort.scrollIntoView({block:'center'});effort.click();await wait(()=>effort.parentElement.querySelector('[role=option]'));const singleDefaultSelection=effort.parentElement.querySelectorAll('[aria-selected=true]').length===1;effort.parentElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
      const scopes=['整理 Agent','选择 Router Agent、模型与思考强度','选择标题 Agent、模型与思考参数'],checks=[];
      for(const label of scopes){const summary=trigger(label);summary.scrollIntoView({block:'center'});summary.click();await wait(()=>summary.parentElement.querySelector('[data-title-agent=qoder]'));const picker=summary.parentElement;checks.push({enabled:!picker.querySelector('[data-title-agent=qoder]').disabled,system:picker.querySelector('[data-title-agent=kimi]').disabled&&picker.textContent.includes('不支持系统提示词'),auth:picker.querySelector('[data-title-agent=locked]').disabled&&picker.textContent.includes('先登录')});picker.querySelector('[data-title-agent=qoder]').click();await tick();summary.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();if(picker.open)throw Error('Escape did not close');}
      trigger('整理模型').click();await wait(()=>trigger('整理模型').parentElement.querySelector('[data-title-model=vision]'));const picker=trigger('整理模型').parentElement;const onlyVision=!picker.querySelector('[data-title-model=text]');picker.querySelector('[data-title-model=vision]').click();await tick();
      const summary=trigger('整理 Agent');summary.scrollIntoView({block:'center'});summary.focus();summary.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await wait(()=>summary.parentElement.open&&document.activeElement?.getAttribute('role')==='option');const keyboard=true;document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));const moved=document.activeElement.dataset.titleAgent==='qoder';summary.parentElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();const restored=document.activeElement===summary;summary.click();await tick();host.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await tick();
      return{equal,width:widths[0],truncated,defaultEffortMatchesRuntime,singleDefaultSelection,checks,onlyVision,keyboard,moved,restored,outsideClosed:!summary.parentElement.open,errors:window.__fixtureErrors};})()`
  })
  assert.equal(result.equal, true)
  assert.equal(result.width, 300)
  assert.equal(result.truncated, true)
  assert.ok(result.checks.every((check:any)=>check.enabled&&check.system&&check.auth))
  for (const key of ['defaultEffortMatchesRuntime','singleDefaultSelection','onlyVision','keyboard','moved','restored','outsideClosed']) assert.equal(result[key],true,key)
  assert.deepEqual(result.errors, [])
}
console.log('PASS SuperAgent selectors: equal widths, long names, shared admission, explicit reasons, model filtering, keyboard and dismissal at 1100/540px')
