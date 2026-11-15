// Run explicitly: node scripts/run-ts-test.mjs test/settings-entry-modes.tsx
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentDef } from '../src/shared/types'
import { DISTRIBUTION_SETTINGS_CATEGORIES, isSettingsPagePanel, type SettingsCategory } from '../src/shared/settingsNavigation'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import { renderEventStream } from './regression/render-event-stream.mjs'

const noop = () => {}

const agent = {
  id: 'codex', name: 'Codex', adapter: 'codex', bin: 'codex', models: [],
  installed: true,
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [], sessionList: true },
  lifecycle: { availability: 'available', updateStatus: 'current', selfUpdateSupported: true }
} as unknown as AgentDef

function renderSettings(props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}): string {
  return renderToStaticMarkup(React.createElement(SettingsPanel, {
    agents: [agent],
    onRedetect: noop,
    onInitialize: noop,
    onAgentsChanged: noop,
    onOpenSync: noop,
    onBack: noop,
    ...props
  }))
}

// ---- 分类归属：自带页面面板的分类（导入会话 / 定时任务 / Token 消耗 / 工具能力） ----
for (const id of ['automations', 'capabilities', 'history', 'tokens'] as const) {
  assert.equal(isSettingsPagePanel(id), true, `${id} is a page-panel category`)
}
for (const id of ['general', 'projects', 'requirements', 'agent', 'assistants', 'codex-sources', 'local-models', 'teams', 'roles', 'presets'] as const) {
  assert.equal(isSettingsPagePanel(id), false, `${id} is a regular settings category`)
}

// ---- 页内模式（设置页内侧栏打开）：页面面板嵌入设置内容区，保留分类导航 ----
for (const [category, title, root] of [
  ['history', '历史会话 · 恢复', 'class="resume-panel resume-embedded"'],
  ['tokens', 'Token 消耗', 'class="token-usage-panel token-embedded"'],
  ['automations', '定时任务', 'class="automations-panel automations-embedded"']
] as const) {
  const markup = renderSettings({ initialCategory: category })
  assert.ok(markup.includes('class="set-nav"'), `embedded ${category} keeps the settings category nav`)
  assert.ok(markup.includes(root), `embedded ${category} renders without the standalone main-panel shell`)
  const navAt = markup.indexOf('class="set-nav"')
  const titleAt = markup.indexOf(title)
  assert.ok(titleAt > navAt, `embedded ${category} content lives inside the settings page, after the nav`)
  assert.ok(markup.includes('class="main-panel-head settings-head"'), `embedded ${category} keeps the 「‹ 设置」 header`)
}

{
  const markup = renderSettings({ initialCategory: 'capabilities' })
  assert.ok(markup.includes('class="capability-center capability-embedded"'), 'embedded capabilities keeps its in-page rendering')
  assert.ok(markup.includes('class="set-nav"'), 'embedded capabilities keeps the settings category nav')
}

// ---- 全窗模式（左侧侧边栏快捷入口打开）：无分类导航，标题为分类名 ----
{
  const markup = renderSettings({ windowed: true, initialCategory: 'agent' })
  assert.doesNotMatch(markup, /class="set-nav"/, 'windowed view hides the settings category nav')
  assert.doesNotMatch(markup, /class="settings-back"/, 'windowed view has no 「‹ 设置」 back button')
  assert.doesNotMatch(markup, /class="main-panel-head settings-head"/, 'windowed view does not use the settings header')
  assert.ok(markup.includes('<span class="main-panel-title">Agent</span>'), 'windowed view titles the page with the category label')
  assert.ok(markup.includes('class="set-content'), 'windowed view still renders the category content area')
}

// ---- 全窗模式对其它常规分类同样生效（以「通用」为例） ----
{
  const markup = renderSettings({ windowed: true, initialCategory: 'general' })
  assert.doesNotMatch(markup, /class="set-nav"/, 'windowed general hides the settings category nav')
  assert.ok(markup.includes('<span class="main-panel-title">通用</span>'), 'windowed general titles the page with the category label')
}

// ---- 切换分类后仍以同一模式展示（嵌入页不跳出：导航项只是切内容区） ----
{
  const markup = renderSettings({ initialCategory: 'tokens' })
  const navButtons = markup.match(/class="set-nav-item[^"]*"/g) || []
  assert.equal(navButtons.length, DISTRIBUTION_SETTINGS_CATEGORIES.length, 'embedded settings lists every category in the nav, including page-panel categories')
}

for (const windowed of [false, true]) {
  const markup = renderSettings({ initialCategory: 'general', windowed })
  assert.ok(markup.includes('开发者选项'), 'general settings provides one developer options entry')
  assert.ok(!markup.includes('按项目和需求组织侧栏'), 'sidebar style no longer appears in general settings')
  for (const label of ['诊断与日志', 'Session 导入错误', 'App 运行错误日志', '工具能力排查日志', '清空全部日志', '排队预估', '等待时间预测质量']) {
    assert.ok(!markup.includes(label), `${label} is not rendered before opening developer options`)
  }
}

const sidebarStyle = await renderEventStream([], 'idle', 'settings-sidebar-style-location', {
  setup: `
    import { flushSync } from 'react-dom';
    import { SettingsPanel } from './src/renderer/components/SettingsPanel';
    const noop=()=>{},patches=[],changes=[],errors=[];
    let settings={autoCheckUpdate:false,sidebarShortcuts:[]},fail=false,defer=false,finish,serial=0;
    window.addEventListener('error',event=>errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    window.uniagent=new Proxy({
      teamCatalog:async()=>({teams:[],errors:[]}),getAppSettings:async()=>settings,
      getPrefs:async()=>({lastByAgent:{}}),getAppVersion:async()=>'1.1.0',
      getRouterSnapshot:async()=>({config:{enabled:false,version:1},available:false,requests:[]}),
      setAppSettings:async patch=>{patches.push(patch);if(fail)throw Error('侧栏样式保存失败，请重试。');if(defer)await new Promise(resolve=>finish=resolve);settings={...settings,...patch};return settings}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>[]});
    const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
    host.style.cssText='display:flex;width:1100px;height:800px';
    window.sidebarStyleFixture={host,patches,changes,errors,fail:value=>fail=value,defer:value=>defer=value,finish:()=>finish(),
      reset:()=>{settings={autoCheckUpdate:false,sidebarShortcuts:[]};patches.length=changes.length=0},
      mount:(initialCategory,windowed)=>flushSync(()=>root.render(React.createElement(SettingsPanel,{
        key:++serial,initialCategory,windowed,agents:[],onRedetect:noop,onInitialize:noop,onAgentsChanged:noop,onOpenSync:noop,onBack:noop,
        onSidebarStyleChange:value=>changes.push(value)
      })))
    };
  `,
  inspect: `(async()=>{
    const f=window.sidebarStyleFixture,tick=()=>new Promise(resolve=>setTimeout(resolve,10));
    const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await tick()}throw Error('sidebar settings timeout: '+f.host.textContent)};
    const toggle=()=>f.host.querySelector('[aria-label="按项目和需求组织侧栏"]'),state=()=>toggle().getAttribute('aria-checked');
    const results=[];
    for(const windowed of [false,true]){
      f.reset();f.mount('general',windowed);await wait(()=>!f.host.querySelector('[aria-label="防止电脑休眠"]').disabled);
      const general={absent:!toggle(),shortcuts:f.host.querySelector('.set-page:not([hidden])').textContent.includes('侧栏快捷入口')};
      f.mount('requirement-tasks',windowed);
      const loading={checked:state(),disabled:toggle().disabled};
      await wait(()=>!toggle().disabled);
      const group=toggle().closest('.set-group');
      const placement={count:f.host.querySelectorAll('[aria-label="按项目和需求组织侧栏"]').length,afterHeader:group.previousElementSibling?.querySelector('h2')?.textContent==='superAgent配置',beforeRouter:group.nextElementSibling?.classList.contains('router-settings')};
      f.fail(true);toggle().click();await wait(()=>group.querySelector('[role=alert]'));
      const failed={checked:state(),notified:f.changes.length,retry:!toggle().disabled};
      f.fail(false);f.defer(true);toggle().click();await wait(()=>toggle().disabled);toggle().click();
      const saving={checked:state(),patches:f.patches.length,notified:f.changes.length};
      f.finish();await wait(()=>state()==='false'&&!toggle().disabled);f.defer(false);
      const off={checked:state(),changes:[...f.changes],errorCleared:!group.querySelector('[role=alert]')};
      f.mount('requirement-tasks',windowed);await wait(()=>!toggle().disabled);
      const reopened=state();
      f.host.querySelector('[aria-label="自动生成任务标题"]').click();await tick();toggle().click();
      await wait(()=>state()==='true'&&!toggle().disabled);
      const on={checked:state(),changes:[...f.changes],titleDraft:f.host.querySelector('[aria-label="自动生成任务标题"]').getAttribute('aria-checked')};
      results.push({windowed,general,loading,placement,failed,saving,off,reopened,on,patches:[...f.patches]});
    }
    return {results,errors:f.errors};
  })()`
})
assert.deepEqual(sidebarStyle.errors, [])
for (const result of sidebarStyle.results) {
  assert.deepEqual(result.general, { absent: true, shortcuts: true })
  assert.deepEqual(result.loading, { checked: 'true', disabled: true })
  assert.deepEqual(result.placement, { count: 1, afterHeader: true, beforeRouter: true })
  assert.deepEqual(result.failed, { checked: 'true', notified: 0, retry: true })
  assert.deepEqual(result.saving, { checked: 'true', patches: 2, notified: 0 })
  assert.deepEqual(result.off, { checked: 'false', changes: [false], errorCleared: true })
  assert.equal(result.reopened, 'false', 'explicitly saved off survives reopening the new settings page')
  assert.deepEqual(result.on, { checked: 'true', changes: [false, true], titleDraft: 'true' })
  assert.deepEqual(result.patches, [{ spaceRequirementSidebar: false }, { spaceRequirementSidebar: false }, { spaceRequirementSidebar: true }])
}

const navigation = await renderEventStream([], 'idle', 'settings-developer-options', {
  setup: `
    import { flushSync } from 'react-dom';
    import { SettingsPanel } from './src/renderer/components/SettingsPanel';
    import { COLOR_THEMES } from './src/shared/colorThemes';
    import { defaultRecoverySettings } from './src/shared/sessionRecovery';
    import { applyColorTheme } from './src/renderer/colorTheme';
    const noop = () => {};
    const diagnostics = [
      {id:'import-error',category:'session_import',level:'error',code:'import_fixture',message:'导入失败样本',ts:1,count:1,source:'fixture'},
      {id:'runtime-warn',category:'app_runtime',level:'warn',code:'runtime_fixture',message:'运行警告样本',ts:2,count:1,source:'fixture'}
    ];
    window.__qualityQueries = 0;
    window.__clears = 0;
    window.__themes = COLOR_THEMES;
    window.__applyTheme = applyColorTheme;
    window.__settings = {autoCheckUpdate:false,sidebarShortcuts:[],sessionRecovery:defaultRecoverySettings()};
    window.__settingsErrors = [];
    window.addEventListener('error', event => window.__settingsErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.__settingsErrors.push(String(event.reason)));
    window.confirm = () => true;
    window.uniagent = new Proxy({
      homeDir:'/fixture',teamCatalog:async()=>({teams:[],errors:[]}),
      getAppSettings:async()=>window.__settings,
      getPrefs:async()=>({lastByAgent:{}}),getAppVersion:async()=>'1.1.0',
      listDiagnostics:async()=>diagnostics,
      clearDiagnostics:async()=>{ window.__clears++; },
      getClaudeSources:async()=>({phase:'stopped',enabled:false,sources:[]}),
      getCodexSources:async()=>({phase:'stopped',enabled:false,sources:[]}),
      capabilityInventoryList:async()=>({inventories:[],scannedAt:1}),
      capabilitySyncGetJobSnapshot:async()=>({}),
      getQueueWaitQuality:async()=>{
        window.__qualityQueries++;
        return {generatedAt:1,evaluatedCount:1,successfulCount:1,interruptedCount:0,
          invalidCount:0,unfinishedCount:0,coverage:1,meanAbsoluteErrorMs:1200,
          p90AbsoluteErrorMs:1200,meanErrorMs:1200,recent:[],models:[],algorithmVersions:[]};
      }
    }, {get:(target,key)=>target[key] || (String(key).startsWith('on') ? () => noop : async()=>[])});
    const host = document.body.appendChild(document.createElement('div'));
    host.id = 'settings-fixture';
    host.style.cssText = 'display:flex;width:1280px;height:900px';
    const root = createRoot(host);
    window.__mountSettings = windowed => flushSync(()=>root.render(React.createElement(SettingsPanel, {
      key:String(windowed)+'/'+window.__settings.sessionRecovery.enabled,windowed,agents:[],onRedetect:noop,onInitialize:noop,
      onAgentsChanged:noop,onOpenSync:noop,onBack:noop
    })));
  `,
  inspect: `(async()=>{
    const host = document.getElementById('settings-fixture');
    const wait = async predicate => {
      for(let i=0;i<150;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
      throw Error('Developer settings condition timed out: '+host.innerText);
    };
    const page = () => host.querySelector('.set-page:not([hidden])');
    const labels = () => [...page().querySelectorAll('.r-label')].map(row=>row.textContent.trim());
    const click = async (text, expected) => {
      const button = [...page().querySelectorAll('button')].find(button=>button.textContent.trim()===text || button.querySelector('.r-label')?.textContent.trim()===text);
      if(!button) throw Error('Missing settings action: '+text);
      button.click();
      await wait(expected);
    };
    const isDeveloper = () => page().querySelector('h2')?.textContent==='开发者选项';
    const recoveryColors = [];
    const probe = document.body.appendChild(document.createElement('span'));
    const themeColor = variable => {
      probe.style.color = 'var('+variable+')';
      return getComputedStyle(probe).color;
    };
    const results = [];
    for(const windowed of [false,true]) {
      const previousQueries = window.__qualityQueries;
      for(const enabled of [true,false]) {
        window.__settings.sessionRecovery.enabled = enabled;
        window.__mountSettings(windowed);
        await wait(()=>host.querySelector('.color-theme-option')?.disabled===false);
        const row = [...page().querySelectorAll('button.rowlink')].find(button=>button.querySelector('.r-label')?.textContent==='自动恢复失败会话');
        if(!row) throw Error('Missing recovery settings entry');
        const status = row.querySelector('.r-control > span:not(.set-caret)');
        for(const theme of window.__themes) {
          window.__applyTheme(theme.id);
          recoveryColors.push({windowed,enabled,theme:theme.id,text:status.textContent,
            color:getComputedStyle(status).color,expected:themeColor('--text-dim'),
            label:getComputedStyle(row.querySelector('.r-label')).color,expectedLabel:themeColor('--text'),
            caret:getComputedStyle(row.querySelector('.set-caret')).color,expectedCaret:themeColor('--text-faint')});
        }
        window.__applyTheme('graphite');
        row.click();
        await wait(()=>!!page().querySelector('button[role="switch"][aria-label="自动恢复失败会话"]'));
        await click('返回通用',()=>labels().includes('开发者选项'));
      }
      window.__mountSettings(windowed);
      await wait(()=>labels().includes('开发者选项'));
      const initialQueries = window.__qualityQueries-previousQueries;
      const initialLabels = labels();
      await click('开发者选项',()=>isDeveloper() && page().textContent.includes('平均误差 1.2s'));
      const developerLabels = labels();
      const badges = [...page().querySelectorAll('.diag-stat')].map(item=>item.textContent);
      await click('Session 导入错误',()=>page().querySelector('h2')?.textContent==='Session 导入错误');
      const importLog = page().textContent;
      await click('返回开发者选项',isDeveloper);
      await click('App 运行错误日志',()=>page().querySelector('h2')?.textContent==='App 运行错误日志');
      const runtimeLog = page().textContent;
      await click('返回开发者选项',isDeveloper);
      await click('工具能力排查日志',()=>!!page().querySelector('.cap-log-summary'));
      await click('返回开发者选项',isDeveloper);
      await click('等待时间预测质量',()=>!!page().querySelector('.queue-quality-filters'));
      await click('返回开发者选项',isDeveloper);
      await click('清空全部',()=>page().textContent.includes('当前共 0 条'));
      const clearDisabled = [...page().querySelectorAll('button')].find(button=>button.textContent==='清空全部').disabled;
      await click('返回通用',()=>labels().includes('开发者选项') && !page().querySelector('h2'));
      const returnedLabels = labels();
      await click('开发者选项',isDeveloper);
      if(!windowed) {
        const category = text => [...host.querySelectorAll('.set-nav-item')].find(item=>item.textContent.trim()===text);
        category('Agent').click();
        await wait(()=>!isDeveloper());
        category('通用').click();
        await wait(()=>labels().includes('开发者选项'));
      } else {
        await click('返回通用',()=>labels().includes('开发者选项'));
      }
      results.push({windowed,initialQueries,initialLabels,developerLabels,badges,importLog,runtimeLog,clearDisabled,returnedLabels,resetLabels:labels()});
    }
    return {results,recoveryColors,clears:window.__clears,errors:window.__settingsErrors};
  })()`
})

assert.deepEqual(navigation.errors, [], 'developer settings renders without component errors')
assert.equal(navigation.recoveryColors.length, 36, 'recovery statuses cover nine themes, enabled/disabled and both settings entry modes')
for (const result of navigation.recoveryColors) {
  const label = `${result.theme}/${result.enabled}/${result.windowed}`
  assert.equal(result.text, result.enabled ? '已开启' : '未开启', `recovery status follows saved settings: ${label}`)
  assert.equal(result.color, result.expected, `recovery status uses the theme secondary text color: ${label}`)
  assert.equal(result.label, result.expectedLabel, `recovery title retains the theme primary text color: ${label}`)
  assert.equal(result.caret, result.expectedCaret, `recovery caret retains the theme faint text color: ${label}`)
}
assert.equal(navigation.clears, 2, 'clear diagnostics still invokes the existing action in both entry modes')
for (const result of navigation.results) {
  assert.equal(result.initialQueries, 0, 'general settings does not request queue quality until developer options opens')
  for (const labels of [result.initialLabels, result.returnedLabels, result.resetLabels]) {
    assert.ok(labels.includes('开发者选项'))
    assert.ok(labels.includes('防止电脑休眠') && labels.includes('默认覆盖左侧侧栏'), 'unrelated general settings remain available')
    assert.ok(!labels.includes('Session 导入错误') && !labels.includes('等待时间预测质量'), 'return and category navigation keep developer controls hidden')
  }
  for (const label of ['Session 导入错误', 'App 运行错误日志', '工具能力排查日志', '清空全部日志', '等待时间预测质量']) {
    assert.ok(result.developerLabels.includes(label), `developer options retains ${label}`)
  }
  assert.deepEqual(result.badges, ['1 错误', '1 警告'], 'diagnostic counts remain visible inside developer options')
  assert.ok(result.importLog.includes('导入失败样本') && !result.importLog.includes('运行警告样本'), 'import details keep their category filter')
  assert.ok(result.runtimeLog.includes('运行警告样本') && !result.runtimeLog.includes('导入失败样本'), 'runtime details keep their category filter')
  assert.equal(result.clearDisabled, true, 'clearing diagnostics refreshes and disables the empty action')
}
console.log('settings-entry-modes: recovery status colors across nine themes, nested navigation and diagnostic actions passed in both entry modes')
