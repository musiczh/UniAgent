import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'

const result = await renderEventStream([], 'idle', 'model-source-enterprise-settings', {
  setup: `
    import {ModelSourceSettings} from './src/renderer/components/ModelSourceSettings';
    import {sourceDraft} from './src/shared/modelSources';
    const endpoints=['anthropic-messages','openai-responses'].map(protocol=>({id:protocol,protocol,baseUrl:'https://fixture.example',auth:'none'}));
    const models=['fixture-gpt','fixture-deepseek'].map(id=>({id,label:id,maxContextWindow:500,capabilities:{contextWindow:500},routes:endpoints.map(endpoint=>({endpointId:endpoint.id,upstreamModel:'config:'+id}))}));
    let snapshot={revision:'initial',sources:[],bindings:[],statuses:[],gateway:'running'};
    window.saves=[];window.connects=0;window.tests=[];window.mode='enterprise';window.deferConnect=true;window.confirm=()=>true;
    window.uniagent={
      getModelSources:async()=>snapshot,refreshModelSourceQuotas:async()=>snapshot,
      getLifecycleSnapshot:async()=>['codex','claude','deepseek','kimi','zcode','qoder','mcode'].map(id=>({id,name:({codex:'Codex',claude:'Claude Code',deepseek:'DeepSeek Harness',kimi:'Kimi Code',zcode:'ZCode',qoder:'Qoder CN',mcode:'MiniMax Code'})[id],installed:true})),
      onModelSourcesChanged:()=>()=>{},
      connectEnterpriseModelSource:async()=>{window.connects++;if(window.deferConnect)await new Promise(resolve=>window.releaseConnect=resolve);if(window.connectFailure)throw Error('企业登录已过期');return {name:'Trae 企业模型',preset:'trae',enabled:true,endpoints,models}},
      testModelSource:async(source,endpointId,modelId)=>{window.tests.push({source,endpointId,modelId});if(window.testFailure)throw Error('模型验证失败 HTTP 503');return {state:'connected',endpointId,modelId,checkedAt:Date.now(),elapsedMs:123,message:'企业模型连接验证通过'}},
      queryModelSource:async(source,endpointId)=>{
        if(window.mode==='fail')throw new Error('目录连接失败');
        if(source.preset==='trae')return [{...models[0],maxContextWindow:200,capabilities:{contextWindow:200}}];
        if(endpointId==='anthropic-messages')throw new Error('Messages 目录连接失败');
        return [{...source.models[1],routes:[{endpointId,upstreamModel:source.models[1].id}]}];
      },
      saveModelSource:async input=>{
        window.saves.push(input);const source={...input.source,id:input.source.id||'source-'+window.saves.length,revision:window.saves.length,hasCredential:false,connectionTest:input.source.preset==='trae'?{state:'connected',endpointId:'anthropic-messages',modelId:'fixture-gpt',checkedAt:Date.now(),elapsedMs:123,message:'企业模型连接验证通过'}:undefined};
        snapshot={...snapshot,revision:'saved-'+window.saves.length,sources:[...snapshot.sources.filter(s=>s.id!==source.id),source],bindings:[...snapshot.bindings.filter(b=>b.sourceId!==source.id),...input.bindings.map(b=>({...b,sourceId:source.id}))],statuses:input.bindings.filter(b=>b.enabled).map(b=>({sourceId:source.id,agentId:b.agentId,state:'applied'}))};return snapshot;
      }
    };
    const settings=document.body.appendChild(document.createElement('div'));settings.className='settings-inner';createRoot(settings).render(React.createElement(ModelSourceSettings,{onModelsChanged:async()=>{},navigationGuard:{current:null}}));
  `,
  inspect: `(async()=>{
    const wait=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw new Error('UI wait timed out: '+document.body.textContent.slice(-1400))};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
    const click=text=>{const target=button(text);if(!target)throw Error('Missing button: '+text+'; '+document.body.textContent.slice(-800));target.click()};
    const enter=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
    const idle=()=>!document.querySelector('.model-source-form').disabled;
    await wait(()=>button('＋ 添加数据源'));click('＋ 添加数据源');await wait(()=>document.querySelector('.model-source-presets'));
    const result={};
    if(${INTERNAL_DISTRIBUTION}){
    await wait(()=>button('Trae 企业模型'));click('Trae 企业模型');await wait(()=>button('验证连接'));
    result.needsConnection=document.querySelectorAll('.model-source-agent').length===0;
    result.noEnterpriseQuotaDetail=!document.querySelector('.model-source-quota-detail')&&!document.querySelector('.quota-console');
    result.oneButton=[...document.querySelectorAll('button')].filter(b=>/验证连接|连接企业模型|刷新企业连接/.test(b.textContent)).length===1;
    const edit=document.querySelector('button[aria-label="编辑数据源名称"]');edit.click();await wait(()=>document.querySelector('input[aria-label="数据源名称"]'));
    let name=document.querySelector('input[aria-label="数据源名称"]');enter(name,'取消的名称');await new Promise(r=>setTimeout(r,30));name.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('input[aria-label="数据源名称"]'));
    result.cancelName=document.querySelector('h2').textContent==='Trae 企业模型';
    document.querySelector('button[aria-label="编辑数据源名称"]').click();await wait(()=>document.querySelector('input[aria-label="数据源名称"]'));name=document.querySelector('input[aria-label="数据源名称"]');enter(name,'  团队 Trae  ');await new Promise(r=>setTimeout(r,30));name.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));await new Promise(r=>setTimeout(r,30));result.compositionRetained=!!document.querySelector('input[aria-label="数据源名称"]');name.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await wait(()=>document.querySelector('h2').textContent==='团队 Trae');
    click('验证连接');await wait(()=>window.releaseConnect&&button('验证中…'));
    result.pending=button('验证中…').matches(':disabled')&&!!button('验证中…').querySelector('.is-spinning')&&window.tests.length===0;
    click('验证中…');result.noDuplicate=window.connects===1;
    window.deferConnect=false;window.releaseConnect();await wait(()=>button('验证连接')&&idle());
    result.connected=document.querySelector('.model-source-enterprise-verification [role=status]').textContent==='已连接';
    result.freshSourceTested=window.tests[0].source.name==='团队 Trae'&&window.tests[0].modelId==='fixture-gpt';
    result.noRedundantCopy=!document.querySelector('.model-source-connection-state')&&!document.querySelector('.set-detail-title .set-detail-sub')&&!document.querySelector('.set-card.pad .set-fld-row')&&!document.body.textContent.includes('复用本机企业登录');
    const verification=document.querySelector('.model-source-enterprise-verification'),endpoint=document.querySelector('.model-source-endpoint');
    result.leftAligned=Math.abs(verification.querySelector('[role=status]').getBoundingClientRect().left-endpoint.getBoundingClientRect().left)<1;
    result.endpointsExpanded=!endpoint.closest('details')&&endpoint.getBoundingClientRect().height>0;
    result.agents=[...document.querySelectorAll('.model-source-agent .r-label')].map(el=>el.textContent);
    result.noApiKey=!document.querySelector('.model-source-key');
    for(const checkbox of [...document.querySelectorAll('.model-source-agent .row input')]){checkbox.click();await new Promise(r=>setTimeout(r,30))}
    click('保存并应用');await wait(()=>window.saves.length===1&&document.querySelector('.dirty')?.textContent==='已保存'&&idle());
    click('返回数据源');await wait(()=>document.querySelector('.rowlink'));
    result.noEnterpriseQuotaList=!document.querySelector('.quota-source-row .quota-console')&&!document.querySelector('.quota-source-row .quota-summary')?.textContent;
    document.querySelector('.rowlink').click();await wait(()=>button('验证连接'));
    result.reopenedConnected=document.querySelector('.model-source-enterprise-verification [role=status]').textContent==='已连接';
    result.reopenedName=document.querySelector('h2').textContent;
    window.connectFailure=true;click('验证连接');await wait(()=>document.querySelector('.model-source-key-result.failed')&&idle());
    result.refreshFailure=document.querySelector('.model-source-key-result').textContent==='连接失败'&&document.querySelector('.model-source-key-result').title.includes('企业登录已过期')&&window.tests.length===1&&document.querySelectorAll('.model-source-model').length===2;
    window.connectFailure=false;window.testFailure=true;click('验证连接');await wait(()=>document.querySelector('.model-source-key-result.failed')?.title.includes('HTTP 503')&&idle());
    result.testFailure=document.querySelector('.model-source-key-result').title.includes('HTTP 503');
    window.testFailure=false;click('验证连接');await wait(()=>document.querySelector('.model-source-key-result.connected')&&idle());
    result.retryConnected=window.connects===4&&window.tests.length===3;
    result.reopenedSelections=[...document.querySelectorAll('.model-source-agent .row input')].filter(input=>input.checked).length;await new Promise(r=>setTimeout(r,30));
    click('查询模型');await wait(()=>document.querySelectorAll('.model-source-model').length===1&&idle());
    result.refreshedContext=document.querySelector('.model-source-context input').value;
    click('保存并应用');await wait(()=>window.saves.length===2&&document.querySelector('.dirty')?.textContent==='已保存'&&idle());result.enterpriseSave=window.saves[1];
    window.mode='fail';click('查询模型');await wait(()=>document.querySelector('.model-source-query-result.failed')&&idle());
    result.failedRefreshRetained=document.querySelectorAll('.model-source-model').length===1;
    click('返回数据源');await wait(()=>button('＋ 添加数据源'));click('＋ 添加数据源');await wait(()=>document.querySelector('.model-source-presets'));
    }else{
      result.publicPresets=[...document.querySelectorAll('.model-source-preset')].map(element=>element.textContent.trim());
      result.noEnterpriseEntry=!button('Trae 企业模型')&&!button('验证连接')&&!document.querySelector('.model-source-enterprise-verification');
      result.publicReady=!!document.querySelector('.model-source-form:not(:disabled)')&&!!document.querySelector('.model-source-key input')&&!!document.querySelector('input[aria-label="在 Codex 生效"]')&&!!document.querySelector('input[aria-label="在 Claude Code 生效"]')&&!!button('保存并应用');
    }
    await wait(()=>button('小米 MiMo'));click('小米 MiMo');await wait(()=>document.querySelector('.model-source-key'));
    enter(document.querySelector('.model-source-key input'),'fixture-key');await new Promise(r=>setTimeout(r,30));
    const codex=document.querySelector('input[aria-label="在 Codex 生效"]');codex.click();await wait(()=>codex.checked);
    document.querySelector('input[aria-label="Codex 使用 mimo-v2.6-flash"]').click();await new Promise(r=>setTimeout(r,30));
    window.mode='partial';click('查询模型');await wait(()=>document.querySelector('.model-source-query-result.partial')?.textContent.includes('已保留原配置')&&idle());
    const expectedSaves=${INTERNAL_DISTRIBUTION ? 3 : 1};
    click('保存并应用');await wait(()=>window.saves.length===expectedSaves&&document.querySelector('.dirty')?.textContent==='已保存'&&idle());result.partialSave=window.saves.at(-1);
    result.enterpriseConnections=window.connects;
    return result;
  })()`
})
if (INTERNAL_DISTRIBUTION) {
assert.equal(result.needsConnection, true)
assert.equal(result.connected, true)
assert.equal(result.noEnterpriseQuotaDetail, true, 'Trae detail does not display quota or a console entry')
assert.equal(result.noEnterpriseQuotaList, true, 'Trae list item does not display quota or a console entry')
for (const key of ['compositionRetained','oneButton','cancelName','pending','noDuplicate','freshSourceTested','noRedundantCopy','leftAligned','endpointsExpanded','refreshFailure','testFailure','retryConnected']) assert.equal(result[key], true, key)
assert.equal(result.reopenedName, '团队 Trae')
assert.equal(result.noApiKey, true)
assert.deepEqual(result.agents, ['Codex', 'Claude Code', 'DeepSeek Harness', 'Kimi Code', 'ZCode'])
assert.equal(result.reopenedConnected, true)
assert.equal(result.reopenedSelections, 5)
assert.equal(result.refreshedContext, '200', 'refresh clamps a previous context value to a lower upstream limit')
assert.deepEqual(result.enterpriseSave.source.models.map(model => model.id), ['fixture-gpt'])
assert.ok(result.enterpriseSave.bindings.every(binding => binding.enabled && binding.modelIds.join() === 'fixture-gpt'))
assert.equal(result.failedRefreshRetained, true)
} else {
  assert.deepEqual(result.publicPresets, ['DeepSeek', 'GLM', '小米 MiMo', '火山方舟', '自定义'], 'public source selection retains every supported preset and omits the enterprise preset')
  assert.equal(result.noEnterpriseEntry, true, 'public settings exposes neither the enterprise preset nor its connection action')
  assert.equal(result.publicReady, true, 'public source settings retains usable credential, Agent selection and save controls')
  assert.equal(result.enterpriseConnections, 0, 'the public source workflow never invokes enterprise authentication')
}
assert.equal(result.partialSave.source.preset, 'mimo')
assert.equal(result.partialSave.source.apiKey, 'fixture-key', 'both distributions save the entered public provider credential')
assert.deepEqual(result.partialSave.source.models.find(model => model.id === 'mimo-v2.6-pro').routes.map(route => route.endpointId), ['anthropic-messages'], 'a failed endpoint preserves its original models while successful endpoints remove stale routes')
assert.ok(result.partialSave.bindings.every(binding => !binding.enabled && !binding.modelIds.length), 'a selection removed from the Codex endpoint cannot remain enabled')
console.log(INTERNAL_DISTRIBUTION ? '✓ enterprise settings: connect, select five Agents, save, reopen, refresh limits, remove stale routes and retain failed endpoints' : '✓ public source settings: enterprise entry absent, supported controls usable, provider save, stale route removal and failed endpoint retention')
