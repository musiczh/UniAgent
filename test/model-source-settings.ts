import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'model-source-settings', {
  setup: `
    import {CodexModelSettings} from './src/renderer/components/CodexModelSettings';
    let snapshot={revision:'initial',sources:[],bindings:[],statuses:[],gateway:'stopped'};
    window.calls=[];window.queryCalls=[];window.confirm=()=>false;
    window.uniagent={
      getModelSources:async()=>snapshot,
      getLifecycleSnapshot:async()=>[{id:'claude',name:'Claude Code',installed:true},{id:'codex',name:'Codex',installed:true},{id:'kimi',name:'Kimi Code',installed:false}],
      onModelSourcesChanged:callback=>{window.publish=callback;return ()=>{}},
      applyModelSources:async()=>snapshot,
      saveModelSource:async input=>{window.calls.push(input);snapshot={...snapshot,revision:'saved',sources:[{...input.source,id:'fixture-source',revision:1,hasCredential:true,apiKey:undefined}],bindings:input.bindings.map(b=>({...b,sourceId:'fixture-source'})),statuses:[{sourceId:'fixture-source',agentId:'claude',state:'applied'}]};return snapshot},
      testModelSource:async()=> ({state:'connected',message:'连接已验证'}),
      queryModelSource:async(source,id)=>{window.queryCalls.push(id);return source.models.map(model=>({...model,routes:[{endpointId:id,upstreamModel:model.id}]}))}
    };
    window.guard={current:null};
    const settings=document.body.appendChild(document.createElement('div'));settings.className='settings-inner';
    createRoot(settings).render(React.createElement(CodexModelSettings,{onModelsChanged:async()=>{},navigationGuard:window.guard}));
  `,
  inspect: `(async()=>{
    const wait=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw new Error('UI wait timed out; queries='+JSON.stringify(window.queryCalls)+'; saves='+window.calls.length+'; page='+document.body.textContent.slice(-1800))};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
    const enter=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
    await wait(()=>button('＋ 添加数据源'));
    const result={noAgentTabs:!document.querySelector('[role=tablist]')};
    result.listSubtitleCount=document.querySelectorAll('.model-source-settings .set-detail-title .set-detail-sub').length;
    result.hasImportEntry=!!button('导入已有配置');
    result.hasMigrationCopy=document.querySelector('.model-source-settings').textContent.includes('已有 Codex／Claude 配置自动迁移');
    button('＋ 添加数据源').click();await wait(()=>document.querySelector('.model-source-presets'));
    result.presets=[...document.querySelectorAll('.model-source-preset')].map(b=>b.textContent.trim());
    result.formSubtitleVisible=document.body.textContent.includes('配置连接和模型，再选择生效 Agent。');
    result.noProtocolPicker=!document.querySelector('.model-source-agent select')&&!document.querySelector('select[aria-label="查询协议"]');
    result.guardBeforeSave=window.guard.current();
    enter(document.querySelector('input[type=password]'),'fixture-secret');
    await new Promise(r=>setTimeout(r,30));
    button('查询模型').click();await wait(()=>window.queryCalls.length===3&&!document.querySelector('.model-source-form').disabled&&document.querySelector('.model-source-query-result.connected')?.textContent.includes('查询成功'));
    result.queryCalls=window.queryCalls;
    const claude=document.querySelector('input[aria-label="在 Claude Code 生效"]');
    claude.click();await wait(()=>claude.checked);
    await wait(()=>document.querySelector('input[aria-label="Claude Code 使用 deepseek-v4-pro"]'));
    document.querySelector('input[aria-label="Claude Code 使用 deepseek-v4-pro"]').click();await new Promise(r=>setTimeout(r,30));
    const codex=document.querySelector('input[aria-label="在 Codex 生效"]');codex.click();await wait(()=>codex.checked);
    result.selectedStyle=getComputedStyle(claude.nextElementSibling).backgroundColor;
    result.kimiListed=!!document.querySelector('input[aria-label="在 Kimi Code 生效"]');
    result.boxRadius=getComputedStyle(claude.nextElementSibling).borderRadius;
    window.publish({revision:'external-edit',sources:[],bindings:[],statuses:[],gateway:'running'});await new Promise(r=>setTimeout(r,30));
    button('保存并应用').click();await wait(()=>window.calls.length&&document.querySelector('.dirty')?.textContent==='已保存');
    result.saved=window.calls[0];result.passwordCleared=document.querySelector('input[type=password]').value==='';
    result.guardAfterSave=window.guard.current();
    button('返回数据源').click();await wait(()=>button('＋ 添加数据源'));
    result.sourceVisible=document.body.textContent.includes('DeepSeek')&&document.body.textContent.includes('Claude Code');
    return result;
  })()`
})
assert.equal(result.noAgentTabs, true)
assert.equal(result.listSubtitleCount, 0)
assert.equal(result.hasImportEntry, false)
assert.equal(result.hasMigrationCopy, false)
assert.equal(result.formSubtitleVisible, true)
assert.equal(result.noProtocolPicker, true)
assert.deepEqual(result.queryCalls, ['anthropic-messages','openai-chat','openai-responses'])
for (const preset of ['DeepSeek','GLM','小米 MiMo','火山方舟','自定义']) assert.ok(result.presets.includes(preset))
assert.equal(result.guardBeforeSave, false)
assert.equal(result.guardAfterSave, true)
assert.equal(result.kimiListed, false, 'DeepSeek source only exposes verified Codex and Claude integrations')
assert.equal(result.boxRadius, '5px')
assert.notEqual(result.selectedStyle, 'rgb(255, 255, 255)')
assert.deepEqual(result.saved.bindings.map(binding => binding.agentId), ['claude','codex'])
assert.equal(result.saved.bindings[0].endpointId, 'anthropic-messages')
assert.equal(result.saved.bindings[1].endpointId, 'openai-responses')
assert.deepEqual(result.saved.bindings[0].modelIds, ['deepseek-flash'])
assert.equal(result.saved.expectedRevision, 'initial', 'external updates must not advance the dirty draft revision')
assert.equal(result.saved.source.apiKey, 'fixture-secret')
assert.equal(result.passwordCleared, true)
assert.equal(result.sourceVisible, true)
console.log('✓ model source settings: presets, source-first save, independent Agent selection, themed checkbox and dirty guard')
