import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'model-source-settings', {
  setup: `
    import {CodexModelSettings} from './src/renderer/components/CodexModelSettings';
    const candidate={id:'kimi-agent:code',revision:'revision-1',preset:'kimi-code',models:['k3'],label:'Kimi Code Agent'};
    let claude={enabled:true,phase:'running',sources:[],legacyAvailable:false,quotaRefreshing:false};
    let codex={enabled:false,phase:'stopped',sources:[],legacyAvailable:false,quotaRefreshing:false};
    window.calls=[];window.confirm=()=>false;
    window.uniagent=new Proxy({
      getClaudeSources:async()=>claude,getCodexSources:async()=>codex,
      listModelCredentials:async()=>[candidate],
      importModelCredential:async(client,selection)=>{window.calls.push(['import',client,selection]);const sources=[{id:'kimi',preset:'kimi-code',enabled:true,hasKey:true,baseUrl:'https://api.kimi.com/coding',models:['k3']}];if(client==='codex'){codex={...codex,sources,enabled:true,phase:'error',message:'端口已占用'};return codex}claude={...claude,sources};return claude},
      saveClaudeSource:async(input)=>{window.calls.push(['save',input]);return claude},
      testClaudeSource:async(input)=>{window.calls.push(['test',input]);return new Promise(resolve=>window.finishTest=()=>resolve('连接成功'))},
      restartCodexSources:async()=>{throw new Error('服务启动失败')},
      setCodexSourcesEnabled:async()=>{throw new Error('端口已占用')},
      openExternal:async(url)=>{window.calls.push(['openExternal',url])},
      onCodexSourcesChanged:(callback)=>{window.codexChanged=callback;return ()=>{}}
    },{get:(target,key)=>target[key]||(String(key).startsWith('on')?()=>()=>{}:async()=>null)});
    window.setCodexSnapshot=(snapshot)=>{codex=snapshot;window.codexChanged?.(snapshot)};
    const settings=document.body.appendChild(document.createElement('div'));settings.className='settings-inner';
    createRoot(settings).render(React.createElement(CodexModelSettings,{onModelsChanged:async()=>{},navigationGuard:{current:null}}));
  `,
  inspect: `(async()=>{
    const wait=async(read)=>{for(let i=0;i<150;i++){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('UI condition timeout')};
    const button=text=>[...document.querySelectorAll('.settings-inner button')].find(node=>node.textContent.trim()===text);
    const tab=text=>[...document.querySelectorAll('[role=tab]')].find(node=>node.textContent.trim()===text);
    const result={};
    await wait(()=>button('一键添加'));
    result.claudeProviders=[...document.querySelectorAll('.set-group .row .r-label')].map(node=>node.textContent.trim());
    result.mimoIcon=[...document.querySelectorAll('.set-group .row')].find(node=>node.innerText.includes('小米 MiMo'))?.querySelector('img')?.src.startsWith('data:image/png;base64,')===true;
    result.claudeCopy=[...document.querySelectorAll('.sdt-main h2')].find(node=>node.textContent.trim()==='第三方厂商')?.parentElement?.querySelector('.set-detail-sub')?.textContent||'';
    result.clientTabs=[...document.querySelectorAll('[aria-label=Agent] [role=tab]')].map(node=>node.textContent.trim());
    result.noDefault=!document.querySelector('.settings-inner').innerText.includes('默认配置');
    result.noOfficialQuota=!document.querySelector('.settings-inner').innerText.includes('额度待刷新');
    result.icons=document.querySelectorAll('.settings-inner .agent-icon').length;
    button('一键添加').click();await wait(()=>button('重新导入'));
    result.imports=window.calls.filter(call=>call[0]==='import');
    button('重新导入').click();await wait(()=>button('保存配置'));
    result.reimportDraft=window.calls.filter(call=>call[0]==='save').length===0&&document.querySelector('#codex-source-key').value==='';
    tab('Codex').click();await new Promise(resolve=>setTimeout(resolve,30));
    result.dirtyGuard=tab('Claude Code').getAttribute('aria-selected')==='true';
    button('测试连接').click();await wait(()=>window.finishTest);
    window.confirm=()=>true;tab('Codex').click();
    result.busyGuard=tab('Claude Code').getAttribute('aria-selected')==='true'&&button('测试连接').disabled;
    window.finishTest();await wait(()=>!button('测试连接').disabled);
    button('保存配置').click();await wait(()=>button('重新导入'));
    result.saved=window.calls.filter(call=>call[0]==='save');
    tab('Codex').click();await wait(()=>button('启动服务'));
    result.codexProviders=[...document.querySelectorAll('.set-group .row .r-label')].map(node=>node.textContent.trim());
    result.noSourceTabs=!document.querySelector('[aria-label=模型来源]')&&!tab('本地大模型')&&!tab('第三方厂商');
    result.serviceAboveProviders=button('启动服务').getBoundingClientRect().top<button('一键添加并启动').getBoundingClientRect().top;
    const mimoRow=[...document.querySelectorAll('.set-group .row')].find(node=>node.innerText.includes('小米 MiMo'));
    [...mimoRow.querySelectorAll('button')].find(node=>node.textContent.trim()==='补充 API Key').click();
    await wait(()=>document.querySelector('#codex-source-preset'));
    result.mimoPresetOptions=[...document.querySelectorAll('#codex-source-preset option')].map(node=>node.textContent.trim());
    const mimoPreset=document.querySelector('#codex-source-preset');
    mimoPreset.value='mimo-token-plan';mimoPreset.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>document.querySelector('#codex-source-url')?.value.includes('token-plan-cn'));
    result.mimoTokenPlanUrl=document.querySelector('#codex-source-url').value;
    button('返回来源列表').click();await wait(()=>button('启动服务'));
    button('启动服务').click();result.emptyStartPrompt=document.querySelector('.codex-source-prompt').open;
    document.querySelector('.codex-source-prompt button').click();
    button('一键添加并启动').click();await wait(()=>document.querySelector('.settings-inner').innerText.includes('端口已占用'));
    result.failedServiceVisible=document.querySelector('.settings-inner').innerText.includes('启动失败');
    await wait(()=>button('启动服务')&&!button('启动服务').disabled);button('启动服务').click();
    await wait(()=>button('启动服务')&&!button('启动服务').disabled);
    result.retryFailedVisible=document.querySelector('[role=alert]')?.textContent.includes('端口已占用');
    window.setCodexSnapshot({enabled:true,phase:'running',sources:[{id:'mimo',preset:'mimo-token-plan',enabled:true,hasKey:true,baseUrl:'https://token-plan-cn.xiaomimimo.com/v1',models:['mimo-v2.6-pro'],quota:{status:'unsupported',message:'小米 MiMo 暂不支持额度查询',capturedAt:1760950000000}}],legacyAvailable:false,quotaRefreshing:false});
    await wait(()=>button('打开控制台'));
    const mimoConfiguredRow=[...document.querySelectorAll('.set-group .row')].find(node=>node.innerText.includes('小米 MiMo'));
    result.mimoConsoleOnly=!mimoConfiguredRow.innerText.includes('暂不支持额度查询');
    button('打开控制台').click();
    result.mimoConsoleCall=window.calls.filter(call=>call[0]==='openExternal');
    return result;
  })()`
})
assert.deepEqual(result.clientTabs, ['Claude Code', 'Codex'])
assert.deepEqual(result.claudeProviders, ['Kimi', 'DeepSeek', '小米 MiMo'], 'Claude 页必须列出小米 MiMo')
assert.equal(result.mimoIcon, true, '小米 MiMo 使用内嵌官方图标')
assert.match(result.claudeCopy, /Claude Code 添加 Kimi、DeepSeek、小米 MiMo 模型/, '厂商说明由实际来源列表生成')
assert.ok(result.codexProviders.includes('GLM') && result.codexProviders.includes('小米 MiMo'), 'Codex 页保留 GLM 并新增小米 MiMo')
assert.deepEqual(result.mimoPresetOptions, ['小米 MiMo API（按量付费）', '小米 MiMo Token Plan（订阅套餐）'], 'MiMo 提供按量付费与 Token Plan 两种接入方式')
assert.equal(result.mimoTokenPlanUrl, 'https://token-plan-cn.xiaomimimo.com/v1', '切换 Token Plan 自动填入专属地址')
assert.equal(result.noDefault, true)
assert.equal(result.noOfficialQuota, true)
assert.ok(result.icons >= 4)
assert.equal(result.imports.length, 1)
assert.equal(result.imports[0][1], 'claude')
assert.equal(result.reimportDraft, true)
assert.equal(result.dirtyGuard, true)
assert.equal(result.busyGuard, true)
assert.equal(result.saved.length, 1)
assert.equal(result.saved[0][1].credential.id, 'kimi-agent:code')
assert.equal(result.saved[0][1].apiKey, undefined)
assert.equal(result.noSourceTabs, true, '模型配置页不再有本地大模型/第三方厂商子 tab，Codex 下直接展示第三方厂商内容')
assert.equal(result.serviceAboveProviders, true)
assert.equal(result.emptyStartPrompt, true)
assert.equal(result.failedServiceVisible, true)
assert.equal(result.retryFailedVisible, true)
assert.equal(result.mimoConsoleOnly, true, 'MiMo 额度区只保留打开控制台按钮，不再显示暂不支持提示')
assert.equal(result.mimoConsoleCall.length, 1, '点击打开控制台只触发一次外链跳转')
assert.equal(result.mimoConsoleCall[0][1], 'https://platform.xiaomimimo.com/console/balance', '打开控制台跳转 MiMo 控制台余额页')
console.log('model source settings: unified tabs, icons, one-click copy, draft import, dirty/busy guards, service placement and flat provider pane passed')
