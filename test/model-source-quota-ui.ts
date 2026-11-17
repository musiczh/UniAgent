import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'model-source-quota-ui', {
  setup: `
    import {ModelSourceSettings} from './src/renderer/components/ModelSourceSettings';
    import {sourceQuotaText} from './src/renderer/components/ModelSourceQuota';
    import {sourceDraft} from './src/shared/modelSources';
    const source=(preset,id)=>({...sourceDraft(preset),id,revision:1,hasCredential:true});
    const legacyMimo={...sourceDraft('mimo','token-plan'),id:'mimo',plan:'mimo-token-plan',revision:1,hasCredential:true};
    const cash={status:'ready',kind:'balance',balances:[{currency:'CNY',total:'0.00'}],capturedAt:1000,checkedAt:2000};
    let snapshot={revision:'one',sources:[source('deepseek','ds'),source('ark-coding-plan','ark'),{...source('custom','custom'),name:'团队的自定义模型来源',endpoints:[{id:'openai-chat',protocol:'openai-chat',baseUrl:'https://api.example.com/v1',auth:'bearer'}]}],bindings:[],statuses:[],gateway:'stopped',quotas:{ds:cash,ark:{status:'unsupported',needsCredentials:true,checkedAt:2000,message:'需要火山引擎 AK / SK'},custom:{status:'unsupported',checkedAt:2000}}};
    window.calls=[];window.opened=[];window.saves=[];window.quotaSaves=[];window.confirm=()=>true;
    window.showDeepSeekQuota=quota=>{snapshot={...snapshot,quotas:{...snapshot.quotas,ds:quota??cash}};window.publish(snapshot)};
    window.showLegacyMimo=()=>{snapshot={...snapshot,sources:[legacyMimo],quotas:{mimo:{status:'ready',kind:'credits',credits:{remaining:30,total:100,unit:'积分'}}}};window.publish(snapshot)};
    window.uniagent={getModelSources:async()=>snapshot,getLifecycleSnapshot:async()=>[],onModelSourcesChanged:callback=>{window.publish=callback;return ()=>{}},openExternal:async url=>{window.opened.push(url)},
      refreshModelSourceQuotas:async(id,force)=>{window.calls.push({id,force});if(!force)return snapshot;return new Promise(resolve=>{window.resolveQuota=state=>{snapshot={...snapshot,quotas:{...snapshot.quotas,[id]:state}};window.publish(snapshot);resolve(snapshot)}})},
      saveModelSourceQuota:async input=>{window.quotaSaves.push(input);snapshot={...snapshot,revision:'quota-saved',sources:snapshot.sources.map(source=>source.id===input.sourceId?{...source,quotaQuery:input.query,hasQuotaCredentials:true}:source)};return snapshot},
      saveModelSource:async input=>{window.saves.push(input);snapshot={...snapshot,sources:snapshot.sources.map(source=>source.id===input.source.id?{...source,...input.source}:source)};return snapshot}
    };
    window.quotaFormats={big:sourceQuotaText({status:'ready',kind:'credits',credits:{remaining:7531033016,total:11000000000,unit:'积分'}}),unlimited:sourceQuotaText({status:'ready',amount:{unlimited:true,unit:'USD'}}),credits:sourceQuotaText({status:'ready',kind:'credits',credits:{remaining:0,total:100,unit:'积分'}}),windows:sourceQuotaText({status:'ready',kind:'windows',windows:[{label:'5 小时额度',usedPercent:100},{label:'每周额度',usedPercent:25}]}),multiple:sourceQuotaText({status:'ready',kind:'balance',balances:[{currency:'CNY',total:'10'},{currency:'USD',total:'2'}]})};
    const settings=document.body.appendChild(document.createElement('div'));settings.className='settings-inner';settings.style.width='940px';createRoot(settings).render(React.createElement(ModelSourceSettings,{onModelsChanged:async()=>{},navigationGuard:{current:null}}));
  `,
  inspect: `(async()=>{
    const wait=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw Error('wait: '+fn.toString()+'; opened='+JSON.stringify(window.opened)+'; '+document.body.textContent.slice(-900))};
    const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
    const enter=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
    await wait(()=>document.querySelectorAll('.quota-source-row').length===3&&window.calls.length===1);
    let rows=[...document.querySelectorAll('.quota-source-row')];
    const result={formats:window.quotaFormats,zero:rows[0].querySelector('.quota-summary').textContent,unsupported:rows[1].querySelector('.quota-summary').textContent,noNested:!document.querySelector('button button'),initialCalls:window.calls.length};
    const balance=total=>({status:'ready',kind:'balance',balances:[{currency:'CNY',total,toppedUp:total,granted:'0.00'}],capturedAt:1000,checkedAt:2000});
    const error={status:'error',checkedAt:2000,message:'查询失败'};
    const grouped=(first,second,refreshing=false)=>({status:first.status==='error'||second.status==='error'?'error':'ready',refreshing,accounts:[{id:'one',label:'凭据 1 · Anthropic',endpointIds:['anthropic'],quota:first},{id:'two',label:'凭据 2 · OpenAI Chat / Responses',endpointIds:['chat','responses'],quota:second}]});
    const show=async quota=>{window.showDeepSeekQuota(quota);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const view=document.querySelector('.quota-summary,.model-source-quota-detail'),summary=view.querySelector('[role=status]');return {text:summary.textContent,values:summary.querySelectorAll('.quota-summary-value,.r-label').length,console:!!view.querySelector('.quota-console'),refreshing:!!summary.querySelector('.is-spinning'),refreshDisabled:button('查询中…')?.disabled}};
    result.preferred=await show(grouped(balance('98.65'),balance('26.00')));
    result.fallback=await show(grouped(error,balance('26.00')));
    result.freshBeforeStale=await show(grouped({...balance('98.65'),...error,stale:true},balance('26.00')));
    result.emptyFallback=await show(grouped({status:'ready',checkedAt:2000},balance('26.00')));
    result.zeroPreferred=await show(grouped(balance('0.00'),balance('26.00')));
    result.refreshingFallback=await show(grouped(error,balance('26.00'),true));
    result.bothFailed=await show(grouped(error,error));
    result.staleFallback=await show(grouped(error,{...balance('26.00'),...error,stale:true}));
    result.recovered=await show(grouped(balance('98.65'),balance('26.00')));
    rows[0].querySelector('.rowlink').click();await wait(()=>button('刷新额度'));
    result.preferredDetail=await show(grouped(balance('98.65'),balance('26.00')));
    result.fallbackDetail=await show(grouped({...balance('98.65'),...error,stale:true},balance('26.00')));
    result.zeroDetail=await show(grouped(balance('0.00'),balance('26.00')));
    result.refreshingDetail=await show(grouped(error,balance('26.00'),true));
    result.bothFailedDetail=await show(grouped(error,error));
    result.staleDetail=await show(grouped(error,{...balance('26.00'),...error,stale:true}));
    result.recoveredDetail=await show(grouped(balance('98.65'),balance('26.00')));
    button('返回数据源').click();await wait(()=>document.querySelectorAll('.quota-source-row').length===3);await show();rows=[...document.querySelectorAll('.quota-source-row')];
    rows[1].querySelector('.quota-console').click();await wait(()=>window.opened.length===1);
    result.listConsole=window.opened[0];result.consoleKeepsList=!!document.querySelector('.quota-source-row');
    rows[0].querySelector('.rowlink').click();await wait(()=>button('刷新额度'));
    result.detailZero=document.querySelector('.quota-detail-result').textContent;
    button('刷新额度').click();await wait(()=>button('查询中…')&&window.resolveQuota);
    result.loading=button('查询中…').disabled&&!!button('查询中…').querySelector('.is-spinning')&&!document.querySelector('.model-source-form').disabled;
    button('查询中…').click();result.forceCalls=window.calls.filter(call=>call.force).length;
    window.resolveQuota({status:'error',kind:'balance',balances:[{currency:'CNY',total:'0.00'}],capturedAt:1000,checkedAt:3000,stale:true,message:'额度查询超时'});
    await wait(()=>button('刷新额度'));result.stale=document.querySelector('.quota-detail-result').textContent;
    button('返回数据源').click();await wait(()=>document.querySelectorAll('.quota-source-row').length===3);result.listStale=document.querySelector('.quota-summary').textContent;
    document.querySelectorAll('.quota-source-row')[2].querySelector('.quota-console').click();await wait(()=>document.querySelector('[aria-label="额度控制台地址"]'));
    enter(document.querySelector('[aria-label="额度控制台地址"]'),'https://console.example.com?token=bad');await new Promise(r=>setTimeout(r,30));button('确认地址').click();await wait(()=>document.querySelector('.model-source-quota-error'));result.invalidRejected=window.saves.length===0;
    enter(document.querySelector('[aria-label="额度控制台地址"]'),'https://console.example.com/quota');await new Promise(r=>setTimeout(r,30));button('确认地址').click();await wait(()=>!document.querySelector('[aria-label="额度控制台地址"]'));
    button('保存并应用').click();await wait(()=>window.saves.length===1&&document.querySelector('.dirty')?.textContent==='已保存'&&!document.querySelector('.model-source-form').disabled);result.savedUrl=window.saves[0].source.consoleUrl;
    button('控制台查看额度').click();await wait(()=>window.opened.length===2);result.customConsole=window.opened[1];
    button('查询设置').click();await wait(()=>document.querySelector('[aria-label="额度查询方式"]'));
    const selector=document.querySelector('[aria-label="额度查询方式"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(selector,'new-api');selector.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>document.querySelector('[aria-label="额度访问令牌"]'));
    enter(document.querySelector('[aria-label="额度访问令牌"]'),'fixture-query-secret');await new Promise(r=>setTimeout(r,30));button('编辑控制台地址').click();await new Promise(r=>setTimeout(r,30));
    result.consoleGuard=!document.querySelector('[aria-label="额度控制台地址"]')&&!button('保存并查询').disabled;
    button('取消').click();await wait(()=>!document.querySelector('.quota-query-editor'));result.modelFieldsUnlocked=!document.querySelector('.model-source-model-fields').disabled;
    button('返回数据源').click();await wait(()=>document.querySelectorAll('.quota-source-row').length===3);
    const row=document.querySelector('.quota-source-row'),summary=row.querySelector('.quota-summary');result.noOverlap=summary.getBoundingClientRect().left>=row.querySelector('.quota-source-name').getBoundingClientRect().right;
    document.querySelectorAll('.quota-source-row')[1].querySelector('.quota-query-configure').click();await wait(()=>document.querySelector('[aria-label="AccessKey ID"]'));
    enter(document.querySelector('[aria-label="AccessKey ID"]'),'fixture-ak');enter(document.querySelector('[aria-label="Secret AccessKey"]'),'fixture-sk');await new Promise(r=>setTimeout(r,30));
    result.modelFieldsLocked=document.querySelector('.model-source-model-fields').disabled;
    result.akPassword=document.querySelector('[aria-label="Secret AccessKey"]').type==='password';
    button('保存并查询').click();await wait(()=>window.quotaSaves.length===1&&button('查询中…'));
    result.quotaSaved=window.quotaSaves[0];result.noModelSaveForQuota=window.saves.length===1;result.querySecretCleared=!document.querySelector('[aria-label="Secret AccessKey"]');
    window.resolveQuota({status:'ready',kind:'windows',planType:'Coding Plan',windows:[{label:'5 小时额度',usedPercent:24},{label:'每周额度',usedPercent:92,resetsAt:1795392000000}]});await wait(()=>document.querySelectorAll('.quota-window').length===2);
    result.windowDetails=document.querySelector('.quota-detail-result').textContent;result.lowWarning=!!document.querySelector('.quota-window .quota-low');
    const actions=document.querySelector('.model-source-quota-detail .quota-actions').getBoundingClientRect(),details=document.querySelector('.quota-detail-result').getBoundingClientRect();
    result.windowActionsLeft=Math.abs(actions.left-details.left)<1;result.windowActionsAbove=actions.bottom<=details.top;
    button('返回数据源').click();await wait(()=>document.querySelectorAll('.quota-source-row').length===3);
    window.showLegacyMimo();await wait(()=>document.querySelectorAll('.quota-source-row').length===1);document.querySelector('.quota-source-name').click();await wait(()=>document.querySelector('.set-fld-row select'));
    result.legacyPlan=document.querySelector('.set-fld-row select').selectedOptions[0]?.textContent;
    result.legacyKeyRetained=document.querySelector('.model-source-key input').placeholder.includes('密钥已保存');
    result.legacyCredits=document.querySelector('.quota-detail-result').textContent;
    button('查询设置').click();await wait(()=>document.querySelector('.quota-query-editor'));
    enter(document.querySelector('.model-source-model-fields .set-fld-row input'),'MiMo renamed');await new Promise(r=>setTimeout(r,30));
    result.reverseEditGuard=document.querySelector('[aria-label="额度查询方式"]').matches(':disabled')&&!button('保存并应用').matches(':disabled');
    return result;
  })()`
})
assert.match(result.zero, /剩余.*0\.00/)
assert.match(result.detailZero, /剩余.*0\.00/)
assert.match(result.unsupported, /待配置额度查询/)
assert.match(result.listConsole, /subscription\/coding-plan$/)
assert.equal(result.consoleKeepsList, true)
assert.equal(result.noNested, true)
assert.equal(result.noOverlap, true)
assert.equal(result.loading, true)
assert.equal(result.forceCalls, 1)
assert.match(result.stale, /上次剩余.*0\.00/)
assert.match(result.stale, /额度查询超时/)
assert.match(result.listStale, /上次剩余.*0\.00/)
assert.equal(result.invalidRejected, true)
assert.equal(result.savedUrl, 'https://console.example.com/quota')
assert.equal(result.customConsole, result.savedUrl)
assert.match(result.formats.credits.summary, /剩余 0 \/ 100 积分/)
assert.equal(result.formats.windows.summary, '5 小时额度剩余 0% · 每周额度剩余 75%')
assert.match(result.formats.multiple.summary, /10\.00.*2\.00/)
assert.equal(result.legacyPlan, 'Token Plan')
assert.equal(result.legacyKeyRetained, true)
assert.match(result.legacyCredits, /剩余 30 \/ 100 积分/)
console.log('model-source-quota-ui: shared list/detail values, loading, stale zero, separate console and custom URL passed')

assert.match(result.formats.big.summary, /75\.31 亿/)
assert.match(result.formats.big.detail, /7,531,033,016/)
assert.match(result.formats.unlimited.summary, /不限额/)
assert.equal(result.akPassword, true)
assert.equal(result.modelFieldsLocked, true)
assert.equal(result.quotaSaved.credentials.secretAccessKey, 'fixture-sk')
assert.equal(result.quotaSaved.sourceId, 'ark')
assert.equal(result.noModelSaveForQuota, true)
assert.equal(result.querySecretCleared, true)
assert.match(result.windowDetails, /5 小时额度.*76%/s)
assert.equal(result.lowWarning, true)
assert.equal(result.windowActionsLeft, true, 'quota actions align with the left edge of the details')
assert.equal(result.windowActionsAbove, true)

for (const state of [result.preferred, result.recovered]) {
  assert.match(state.text, /剩余.*98\.65/)
  assert.doesNotMatch(state.text, /26\.00|组凭据|凭据 1|凭据 2/)
  assert.equal(state.values, 1)
}
for (const state of [result.fallback, result.freshBeforeStale, result.emptyFallback, result.refreshingFallback]) {
  assert.match(state.text, /剩余.*26\.00/)
  assert.doesNotMatch(state.text, /98\.65|上次剩余|查询失败/)
  assert.equal(state.console, false)
}
assert.equal(result.refreshingFallback.refreshing, true)
assert.match(result.zeroPreferred.text, /剩余.*0\.00/)
assert.doesNotMatch(result.zeroPreferred.text, /26\.00/)
assert.match(result.bothFailed.text, /暂无法获取额度/)
assert.equal(result.bothFailed.console, true)
assert.match(result.staleFallback.text, /上次剩余.*26\.00/)
for (const state of [result.preferredDetail, result.recoveredDetail]) {
  assert.match(state.text, /剩余.*98\.65/)
  assert.doesNotMatch(state.text, /26\.00|凭据/)
  assert.equal(state.values, 1)
}
for (const state of [result.fallbackDetail, result.refreshingDetail]) {
  assert.match(state.text, /剩余.*26\.00.*现金.*26\.00.*赠金.*0\.00/s)
  assert.doesNotMatch(state.text, /98\.65|上次剩余|查询失败|凭据/)
  assert.equal(state.values, 1)
}
assert.equal(result.refreshingDetail.refreshing, true)
assert.equal(result.refreshingDetail.refreshDisabled, true)
assert.match(result.zeroDetail.text, /剩余.*0\.00/)
assert.doesNotMatch(result.zeroDetail.text, /26\.00|凭据/)
assert.match(result.bothFailedDetail.text, /暂无法获取额度.*查询失败/s)
assert.equal(result.bothFailedDetail.console, true)
assert.match(result.staleDetail.text, /上次剩余.*26\.00.*查询失败/s)
assert.doesNotMatch(result.staleDetail.text, /98\.65|凭据/)

assert.equal(result.consoleGuard, true)
assert.equal(result.modelFieldsUnlocked, true)

// Other providers can still render independent account details.
const narrow = await renderEventStream([], 'idle', 'quota-narrow', {
  setup: `
    import {ModelSourceQuotaView} from './src/renderer/components/ModelSourceQuota';
    document.getElementById('root').style.display='none';document.getElementById('dock').style.display='none';
    const node=document.body.appendChild(document.createElement('div'));node.className='settings-inner model-source-settings';node.style.cssText='width:100%;padding:12px;display:block;box-sizing:border-box';
    const quota={status:'error',accounts:[{id:'one',label:'凭据 1 · Anthropic',endpointIds:['anthropic'],quota:{status:'error',kind:'balance',balances:[{currency:'CNY',total:'98.65'}],stale:true,message:'密钥无额度查询权限',capturedAt:1000}},{id:'two',label:'凭据 2 · OpenAI Chat / Responses',endpointIds:['chat','responses'],quota:{status:'ready',kind:'balance',balances:[{currency:'CNY',total:'26.00'}],capturedAt:2000}}]};
    createRoot(node).render(React.createElement('div',{className:'set-card'},React.createElement(ModelSourceQuotaView,{quota,consoleUrl:'https://console.example',onConsole:()=>{},onConfigure:()=>{},onRefresh:()=>{},onQueryConfigure:()=>{}})));
  `,
  inspect: `(async()=>{for(let i=0;i<100&&!document.querySelector('.quota-account');i++)await new Promise(r=>setTimeout(r,20));const root=document.querySelector('.model-source-quota-detail'),actions=root.querySelector('.quota-actions').getBoundingClientRect(),details=root.querySelector('.quota-detail-result').getBoundingClientRect();return {accounts:root.querySelectorAll('.quota-account').length,text:root.textContent,stacked:actions.bottom<=details.top,leftAligned:Math.abs(actions.left-details.left)<1,visible:root.getBoundingClientRect().height>100&&root.getBoundingClientRect().top>=0&&root.getBoundingClientRect().bottom<=innerHeight,overflow:[root,...root.querySelectorAll('.quota-account,.quota-actions')].some(el=>el.getBoundingClientRect().right>innerWidth||el.scrollWidth>el.clientWidth+1),nestedButtons:!!root.querySelector('button button')}})()`,
  screenshot: { path: 'out/test/model-source-quota-narrow.png', width: 420, height: 600 }
})
assert.equal(narrow.accounts, 2)
assert.match(narrow.text, /上次剩余.*98\.65/s)
assert.match(narrow.text, /剩余.*26\.00/s)
assert.match(narrow.text, /密钥无额度查询权限/)
assert.equal(narrow.visible, true)
assert.equal(narrow.stacked, true)
assert.equal(narrow.leftAligned, true)
assert.equal(narrow.overflow, false)
assert.equal(narrow.nestedButtons, false)

assert.equal(result.reverseEditGuard, true)
console.log('model-source-quota-ui: DeepSeek single result in list/details, fallback, zero, cached values and left-aligned actions passed')
