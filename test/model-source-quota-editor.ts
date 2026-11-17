import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'model-source-quota-editor', {
  setup: `
    import {ModelSourceQuotaEditor} from './src/renderer/components/ModelSourceQuotaEditor';
    import {sourceDraft} from './src/shared/modelSources';
    const source={...sourceDraft('custom'),id:'team',revision:1,hasCredential:true,endpoints:[{id:'chat',protocol:'openai-chat',baseUrl:'https://team.example/v1',auth:'bearer'}]};
    window.inputs=[];window.saved=[];window.dirty=[];window.cancelled=0;
    window.uniagent={saveModelSourceQuota:input=>{window.inputs.push(input);return new Promise(resolve=>window.saveDone=()=>resolve({revision:'new',sources:[],bindings:[],statuses:[],gateway:'stopped'}))}};
    const root=createRoot(document.body.appendChild(document.createElement('div')));
    window.renderEditor=(revision='original',disabled=false)=>root.render(React.createElement(ModelSourceQuotaEditor,{source,revision,disabled,onSaved:snapshot=>window.saved.push(snapshot),onCancel:()=>window.cancelled++,onDirty:value=>window.dirty.push(value),onConsole:()=>{}}));
    window.renderEditor();
  `,
  inspect: `(async()=>{
    const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw Error('wait: '+fn+'; '+document.body.textContent)};
    const field=label=>document.querySelector('[aria-label="'+label+'"]');
    const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
    const enter=(element,value)=>{Object.getOwnPropertyDescriptor(element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}))};
    await wait(()=>field('额度查询方式'));enter(field('额度查询方式'),'new-api');await wait(()=>field('额度访问令牌'));
    enter(field('额度访问令牌'),'fixture-token');enter(field('额度用户 ID'),'123');enter(field('额度单位'),'USD');await wait(()=>field('每单位对应额度'));
    button('保存并查询').click();await wait(()=>document.querySelector('[role=alert]'));
    const result={requiresConversion:window.inputs.length===0,secretType:field('额度访问令牌').type};
    enter(field('每单位对应额度'),'500000');await new Promise(r=>setTimeout(r,30));window.renderEditor('external');await new Promise(r=>setTimeout(r,30));
    button('保存并查询').click();await wait(()=>window.inputs.length===1);button('保存中…').click();
    result.singleSave=window.inputs.length===1;result.input=window.inputs[0];window.saveDone();await wait(()=>window.saved.length===1&&button('保存并查询'));
    result.secretCleared=field('额度访问令牌').value==='';
    enter(field('额度访问令牌'),'must-not-survive-template-change');enter(field('额度查询方式'),'sub2api');await wait(()=>!field('额度访问令牌'));
    enter(field('额度查询方式'),'new-api');await wait(()=>field('额度访问令牌'));result.templateCleared=field('额度访问令牌').value==='';
    window.renderEditor('external',true);await new Promise(r=>setTimeout(r,30));result.localDisabled=button('保存并查询').disabled;result.fieldsDisabled=field('额度访问令牌').matches(':disabled');button('取消').click();result.cancelAllowed=window.cancelled===1;
    return result;
  })()`
})
assert.equal(result.requiresConversion, true)
assert.equal(result.secretType, 'password')
assert.equal(result.singleSave, true)
assert.equal(result.input.expectedRevision, 'original', 'external updates cannot silently advance an open editor')
assert.deepEqual(result.input.query, { template: 'new-api', userId: '123', unit: 'USD', quotaPerUnit: 500000 })
assert.equal(result.input.credentials.accessToken, 'fixture-token')
assert.equal(result.secretCleared, true)
assert.equal(result.templateCleared, true)
assert.equal(result.localDisabled, true)
assert.equal(result.fieldsDisabled, true)
assert.equal(result.cancelAllowed, true)
console.log('model-source-quota-editor: conversion, dedicated secret save, revision, duplicate save and cancellation passed')

const ark = await renderEventStream([], 'idle', 'quota-ark-guidance', {
  setup: `
    import {ModelSourceQuotaEditor} from './src/renderer/components/ModelSourceQuotaEditor';
    import {sourceDraft} from './src/shared/modelSources';
    window.opened=[];window.saves=[];window.dirty=[];
    window.uniagent={saveModelSourceQuota:async input=>{window.saves.push(input);return {revision:'saved',sources:[],bindings:[],statuses:[],gateway:'stopped'}}};
    const node=document.body.appendChild(document.createElement('div'));node.className='settings-inner model-source-settings';
    createRoot(node).render(React.createElement(ModelSourceQuotaEditor,{source:{...sourceDraft('ark-coding-plan'),id:'ark',revision:1,hasCredential:true},revision:'original',disabled:false,onSaved:()=>{},onCancel:()=>{},onDirty:value=>window.dirty.push(value),onConsole:url=>window.opened.push(url)}));
  `,
  inspect: `(async()=>{
    for(let i=0;i<100&&!document.querySelector('[aria-label="AccessKey ID"]');i++)await new Promise(r=>setTimeout(r,20));
    const editor=document.querySelector('.quota-query-editor'),button=[...editor.querySelectorAll('button')].find(el=>el.textContent.trim()==='打开密钥管理');button.click();
    return {help:[...editor.querySelectorAll('.quota-query-help')].map(el=>el.textContent).join(' '),opened:window.opened,saves:window.saves,dirty:window.dirty,ak:editor.querySelector('[aria-label="AccessKey ID"]').value,sk:editor.querySelector('[aria-label="Secret AccessKey"]').value};
  })()`
})
assert.match(ark.help, /点击.*打开密钥管理/)
assert.match(ark.help, /登录.*开通套餐.*Access Key.*新建密钥.*复制.*填入/s)
assert.deepEqual(ark.opened, ['https://console.volcengine.com/iam/keymanage/'])
assert.deepEqual(ark.saves, [], 'opening key management must not save or query credentials')
assert.ok(!ark.dirty.includes(true))
assert.equal(ark.ak, '')
assert.equal(ark.sk, '')
console.log('model-source-quota-editor: actionable AK/SK guidance and official key management link passed')
