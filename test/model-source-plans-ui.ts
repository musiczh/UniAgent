import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'model-source-plans-ui', {
  setup: `
    import {ModelSourceSettings} from './src/renderer/components/ModelSourceSettings';
    import {sourceDraft,validateModelSource,modelSourceConnectionIdentity} from './src/shared/modelSources';
    const coding={...sourceDraft('ark-coding-plan'),id:'fixture-coding',name:'字节方舟 Coding Plan',revision:1,hasCredential:true,connectionTest:{state:'connected',endpointId:'anthropic-messages',modelId:'ark-code-latest',checkedAt:Date.now(),elapsedMs:100,message:'连接成功'}};
    let snapshot={revision:'initial',sources:[coding],bindings:[],statuses:[],gateway:'running'};
    window.reveals=[];window.saves=[];window.tests=[];window.confirm=()=>true;
    window.uniagent={getModelSources:async()=>snapshot,refreshModelSourceQuotas:async()=>snapshot,getLifecycleSnapshot:async()=>['codex','claude','deepseek','kimi','zcode'].map(id=>({id,name:id,installed:true})),onModelSourcesChanged:()=>()=>{},revealModelSourceCredential:async(...args)=>{window.reveals.push(args);return 'fixture-coding-key'},testModelSource:async(...args)=>{window.tests.push(args);return {state:'connected',endpointId:args[1],modelId:args[2],checkedAt:Date.now(),elapsedMs:100,message:'连接成功'}},saveModelSource:async input=>{
      const value=validateModelSource(input.source);if(!value.apiKey&&modelSourceConnectionIdentity(value)!==modelSourceConnectionIdentity(coding))throw new Error('请填写当前套餐的 API Key');
      window.saves.push(input);const source={...value,id:input.source.id||'new-source',revision:2,hasCredential:true};delete source.apiKey;snapshot={...snapshot,revision:'saved',sources:[source]};return snapshot;
    }};
    window.originalCoding=coding;
    const settings=document.body.appendChild(document.createElement('div'));settings.className='settings-inner';createRoot(settings).render(React.createElement(ModelSourceSettings,{onModelsChanged:async()=>{},navigationGuard:{current:null}}));
  `,
  inspect: `(async()=>{
    const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw new Error('UI wait timed out: '+document.body.textContent.slice(-1000))};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
    const enter=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
    const pick=value=>{const select=document.querySelector('.set-fld-row select');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}))};
    await wait(()=>document.querySelector('.rowlink'));document.querySelector('.rowlink').click();await wait(()=>document.querySelector('.set-fld-row select'));
    const result={options:[...document.querySelector('.set-fld-row select').options].map(option=>option.text),codingSelected:document.querySelector('.set-fld-row select').value};
    button('显示').click();await wait(()=>document.querySelector('.model-source-key input').value==='fixture-coding-key');
    pick('agent');await wait(()=>document.querySelector('.set-fld-row select').value==='agent'&&button('显示'));
    result.resetKey=document.querySelector('.model-source-key input').value==='';result.agentPlaceholder=document.querySelector('.model-source-key input').placeholder;
    result.validationReset=document.querySelector('.model-source-connection-state').textContent==='待验证'&&!document.querySelector('.model-source-key-result');
    result.defaultName=document.querySelector('.set-fld-row input').value;result.agentUrls=[...document.querySelectorAll('input[aria-label="Base URL"]')].map(input=>input.value);
    button('显示').click();await wait(()=>button('隐藏'));result.noOldReveal=window.reveals.length===1&&document.querySelector('.model-source-key input').value==='';button('隐藏').click();
    button('保存并应用').click();await wait(()=>document.querySelector('[role=alert]')&&!document.querySelector('.model-source-form').disabled);result.rejectedEmptyKey=window.saves.length===0;
    enter(document.querySelector('.model-source-key input'),'fixture-agent-key');await new Promise(r=>setTimeout(r,30));
    button('验证 API Key').click();await wait(()=>window.tests.length&&document.querySelector('.model-source-key-result.connected'));
    result.testedPlan=window.tests[0][0].plan;result.testedKey=window.tests[0][0].apiKey;
    pick('coding');await wait(()=>document.querySelector('.set-fld-row select').value==='coding');result.codingRestoredSavedPlaceholder=document.querySelector('.model-source-key input').placeholder;result.noAgentKeyOnReturn=document.querySelector('.model-source-key input').value==='';
    pick('agent');await wait(()=>document.querySelector('.set-fld-row select').value==='agent');enter(document.querySelector('.set-fld-row input'),'备用方舟账号');await new Promise(r=>setTimeout(r,30));
    pick('coding');await wait(()=>document.querySelector('.set-fld-row select').value==='coding');result.customNameRetained=document.querySelector('.set-fld-row input').value;
    pick('agent');await wait(()=>document.querySelector('.set-fld-row select').value==='agent');enter(document.querySelector('.model-source-key input'),'fixture-agent-key');await new Promise(r=>setTimeout(r,30));
    button('保存并应用').click();await wait(()=>window.saves.length&&document.querySelector('.dirty')?.textContent==='已保存');result.saved=window.saves[0];result.clearedAfterSave=document.querySelector('.model-source-key input').value==='';result.originalCodingPlan=window.originalCoding.plan;
    return result;
  })()`
})
assert.deepEqual(result.options, ['Coding Plan','Agent Plan'])
assert.equal(result.codingSelected, 'coding')
assert.equal(result.resetKey, true)
assert.match(result.agentPlaceholder, /Agent Plan/)
assert.equal(result.validationReset, true)
assert.equal(result.defaultName, '火山方舟 Agent Plan')
assert.deepEqual(result.agentUrls, ['https://ark.cn-beijing.volces.com/api/plan','https://ark.cn-beijing.volces.com/api/plan/v3','https://ark.cn-beijing.volces.com/api/plan/v3'])
assert.equal(result.noOldReveal, true)
assert.equal(result.rejectedEmptyKey, true)
assert.equal(result.testedPlan, 'agent')
assert.equal(result.testedKey, 'fixture-agent-key')
assert.match(result.codingRestoredSavedPlaceholder, /密钥已保存/)
assert.equal(result.noAgentKeyOnReturn, true)
assert.equal(result.customNameRetained, '备用方舟账号')
assert.equal(result.saved.source.plan, 'agent')
assert.equal(result.saved.source.apiKey, 'fixture-agent-key')
assert.equal(result.clearedAfterSave, true)
assert.equal(result.originalCodingPlan, 'coding')
console.log('✓ Ark plan UI: plan selection, dedicated URL/key, reveal and validation reset, saved-key scope and account-name preservation')
