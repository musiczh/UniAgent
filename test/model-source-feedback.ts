import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
const result = await renderEventStream([], 'idle', 'model-source-feedback', {
  setup: `
    import {ModelSourceSettings} from './src/renderer/components/ModelSourceSettings';
    import {sourceDraft} from './src/shared/modelSources';
    let snapshot={revision:'initial',sources:[{...sourceDraft('deepseek'),id:'fixture-source',revision:1,hasCredential:true},{...sourceDraft('ark-coding-plan'),id:'fixture-ark',revision:1,hasCredential:true}],bindings:[],statuses:[],gateway:'running'};
    window.saves=[];window.reveals=[];window.queries=[];window.confirm=()=>true;
    window.uniagent={getModelSources:async()=>snapshot,refreshModelSourceQuotas:async()=>snapshot,getLifecycleSnapshot:async()=>['codex','claude','deepseek','kimi','zcode','qoder','mcode'].map(id=>({id,name:({codex:'Codex',claude:'Claude Code',deepseek:'DeepSeek Harness',kimi:'Kimi Code',zcode:'ZCode',qoder:'Qoder CN',mcode:'MiniMax Code'})[id],installed:true})),onModelSourcesChanged:()=>()=>{},revealModelSourceCredential:async(...args)=>{window.reveals.push(args);return 'revealed-fixture-key'},testModelSource:async()=>new Promise(resolve=>window.resolveTest=resolve),saveModelSource:async input=>{window.saves.push(input);return snapshot},queryModelSource:async(source,id)=>new Promise((resolve,reject)=>window.queries.push({resolve:()=>resolve(source.models.map(model=>({...model,routes:[{endpointId:id,upstreamModel:model.id}]}))),reject}))};
    const settings=document.body.appendChild(document.createElement('div'));settings.className='settings-inner';createRoot(settings).render(React.createElement(ModelSourceSettings,{onModelsChanged:async()=>{},navigationGuard:{current:null}}));
  `,
  inspect: `(async()=>{
    const wait=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw new Error('UI wait timed out: '+document.body.textContent.slice(-1200))};
    const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===text);
    await wait(()=>document.querySelector('.rowlink'));const officialListIcon=document.querySelectorAll('.rowlink')[1].querySelector('img')?.src.startsWith('data:image/svg+xml;base64,');document.querySelector('.rowlink').click();await wait(()=>button('显示'));
    const result={officialListIcon,agents:[...document.querySelectorAll('.model-source-agent .r-label')].map(row=>row.textContent)};
    button('显示').click();await wait(()=>button('隐藏')&&document.querySelector('.model-source-key input').value==='revealed-fixture-key');
    result.revealCalls=window.reveals;result.revealed=document.querySelector('.model-source-key input').value;button('隐藏').click();
    await wait(()=>document.querySelector('.model-source-key input').value==='');result.hiddenValue=document.querySelector('.model-source-key input').value;
    button('验证 API Key').click();await wait(()=>window.resolveTest&&button('验证中…'));
    result.testingButton=button('验证中…')!==undefined;result.testingVisible=!!document.querySelector('.model-source-key-heading .model-source-key-result[role=status]');
    window.resolveTest({state:'connected',modelId:'deepseek-flash',endpointId:'anthropic-messages',checkedAt:Date.now(),elapsedMs:123,message:'连接成功'});
    await wait(()=>!document.querySelector('.model-source-form').disabled);
    result.resultNearButton=document.querySelector('.model-source-key-heading')?.textContent.includes('API Key 验证通过')===true;
    result.connected=document.querySelector('.model-source-connection-state')?.textContent==='已连接';
    result.noKeyHelper=!document.querySelector('.model-source-key .set-detail-sub');
    result.keyStatusBesideButton=document.querySelector('.model-source-key-result').parentElement===button('验证 API Key').parentElement;
    result.contextMax=document.querySelector('.model-source-context input').max;
    result.limitVisible=document.querySelector('.model-source-context').textContent.includes('1,048,576');
    const enter=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
    enter(document.querySelector('.model-source-context input'),'1048577');await new Promise(r=>setTimeout(r,30));
    button('保存并应用').click();await wait(()=>document.querySelector('[role=alert]')||window.saves.length);
    if(window.saves.length)throw new Error('limit input did not reach draft: '+JSON.stringify({input:document.querySelector('.model-source-context input').value,models:window.saves[0].source.models}));
    result.rejectedOverLimit=window.saves.length===0&&document.querySelector('[role=alert]').textContent.includes('官方上限');
    enter(document.querySelector('.model-source-context input'),'1048576');await new Promise(r=>setTimeout(r,30));
    button('保存并应用').click();await wait(()=>window.saves.length&&document.querySelector('.dirty')?.textContent==='已保存'&&document.querySelector('.model-source-feedback')?.textContent.includes('来源已保存')&&!document.querySelector('.model-source-form').disabled);result.savedKey=window.saves[0].source.apiKey;
    button('验证 API Key').click();await wait(()=>button('验证中…'));
    window.resolveTest({state:'failed',modelId:'deepseek-flash',endpointId:'anthropic-messages',checkedAt:Date.now(),elapsedMs:123,message:'连接失败（HTTP 401）'});
    await wait(()=>!document.querySelector('.model-source-form').disabled);
    result.failureVisible=document.querySelector('.model-source-key-heading .model-source-key-result.failed').textContent.includes('HTTP 401');
    result.failedState=document.querySelector('.model-source-connection-state').textContent==='连接失败';
    const codex=document.querySelector('input[aria-label="在 Codex 生效"]');codex.click();await wait(()=>codex.checked);
    const choices=document.querySelector('.model-source-model-choices');choices.querySelector('summary').click();
    const row=codex.closest('.row'),center=el=>{const r=el.getBoundingClientRect();return (r.top+r.bottom)/2};
    result.agentRowAligned=Math.abs(center(codex)-center(row.querySelector('.r-main')))<1&&Math.abs(center(codex)-center(row.querySelector('.r-control')))<1;
    result.choicesBelowRow=choices.getBoundingClientRect().top>=row.getBoundingClientRect().bottom-1;
    const controls=document.querySelector('.model-source-context-control');
    result.modelControlsAligned=Math.abs(center(controls.querySelector('input'))-center(controls.querySelector('button')))<1;
    result.contextWidth=controls.querySelector('input').getBoundingClientRect().width;
    const resolveQuery=async(mode)=>{
      window.queries=[];button('查询模型').click();await wait(()=>window.queries.length===3&&button('查询中…'));
      result.querySpinning=!!button('查询中…').querySelector('.is-spinning');
      result.queryAnimation=getComputedStyle(button('查询中…').querySelector('.is-spinning')).animationName==='ua-spin';
      const pending=document.querySelector('.model-source-query-result');result.queryNearButton=pending.parentElement===button('查询中…').parentElement;
      window.queries.forEach((query,index)=>mode==='failed'||mode==='partial'&&index===0?query.reject(new Error('fixture network unavailable')):query.resolve());
      await wait(()=>button('查询模型')&&!document.querySelector('.model-source-form').disabled);
      return {state:document.querySelector('.model-source-query-result').className,text:document.querySelector('.model-source-query-result').textContent,count:document.querySelectorAll('.model-source-model').length};
    };
    result.querySuccess=await resolveQuery('success');result.queryPartial=await resolveQuery('partial');result.queryFailure=await resolveQuery('failed');result.queryRetry=await resolveQuery('success');
    button('返回数据源').click();await wait(()=>button('＋ 添加数据源'));button('＋ 添加数据源').click();await wait(()=>document.querySelector('.model-source-presets'));
    result.officialPresetIcon=[...document.querySelectorAll('.model-source-preset')].find(el=>el.textContent.includes('火山方舟')).querySelector('img')?.src.startsWith('data:image/svg+xml;base64,');
    return result;
  })()`
})
assert.deepEqual(result.agents, ['Codex', 'Claude Code'])
assert.equal(result.revealCalls.length, 1)
assert.equal(result.revealCalls[0][0], 'fixture-source')
assert.equal(result.revealCalls[0][1], 'anthropic-messages')
assert.equal(JSON.parse(result.revealCalls[0][2]).preset, 'deepseek')
assert.equal(result.revealed, 'revealed-fixture-key')
assert.equal(result.hiddenValue, '')
assert.equal(result.savedKey, undefined, 'revealing a key must not replace protocol-specific saved credentials')
assert.equal(result.testingButton, true)
assert.equal(result.testingVisible, true)
assert.equal(result.resultNearButton, true)
assert.equal(result.connected, true)
assert.equal(result.contextMax, '1048576')
assert.equal(result.limitVisible, true)
assert.equal(result.rejectedOverLimit, true)
assert.equal(result.failureVisible, true)
assert.equal(result.failedState, true)
assert.equal(result.agentRowAligned, true)
assert.equal(result.choicesBelowRow, true)
assert.equal(result.modelControlsAligned, true)
assert.equal(result.noKeyHelper, true)
assert.equal(result.keyStatusBesideButton, true)
assert.equal(result.contextWidth, 128)
assert.equal(result.querySpinning, true)
assert.equal(result.queryAnimation, true)
assert.equal(result.queryNearButton, true)
assert.match(result.querySuccess.text, /查询成功/)
assert.match(result.queryPartial.state, /partial/)
assert.match(result.queryPartial.text, /已保留原配置/)
assert.match(result.queryFailure.text, /fixture network unavailable/)
assert.equal(result.queryFailure.count, result.querySuccess.count, 'failed queries preserve the existing models')
assert.match(result.queryRetry.text, /查询成功/)
assert.equal(result.officialListIcon, true)
assert.equal(result.officialPresetIcon, true)
console.log('✓ model source feedback: saved credential reveal, test pending/result placement, connection state, limits and supported Agents')
