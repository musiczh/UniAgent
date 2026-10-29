import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Measure production components in Chromium; SSR cannot detect unused space or CSS sizing.
const result = await renderEventStream([], 'idle', 'settings-spacing', {
  setup: `
    import { flushSync } from 'react-dom';
    import { SettingsPanel } from './src/renderer/components/SettingsPanel';
    import { DISTRIBUTION_SETTINGS_CATEGORIES as SETTINGS_CATEGORIES, isSettingsPagePanel } from './src/shared/settingsNavigation';
    import { DEFAULT_TEAM_LIMITS } from './src/shared/teamTypes';
    import './src/renderer/components/teams.css';
    const noop = () => {};
    const sources = {phase:'stopped', enabled:false, sources:[], quotaRefreshing:false};
    const role = {id:'layout-role',name:'布局角色',agentId:'codex',permissionMode:'ask'};
    const api = {
      homeDir:'/fixture',
      teamCatalog:async()=>({projects:[],teams:[{id:'layout-team',revision:1,name:'布局团队',description:'',rules:'',
        leaderMemberId:'layout-member',members:[{id:'layout-member',role}],limits:DEFAULT_TEAM_LIMITS,status:'draft'}],errors:[]}),
      listDiagnostics:async()=>[], listPresets:async()=>[], listProjects:async()=>[],
      listRoles:async()=>[], listRequirements:async()=>[], listModelCredentials:async()=>[],
      listAutomations:async()=>[], listAgents:async()=>agents,
      getPrefs:async()=>({lastByAgent:{}}), getAppVersion:async()=>'1.0.9',
      getAppSettings:async()=>({autoCheckUpdate:false, enabledAgentIds:['codex','deepseek']}),
      feishuStatus:async()=>({connected:false}),
      getAssistantFeishu:async()=>({configured:false,status:{connected:false}}),
      getAssistantWeixin:async()=>({configured:false,phase:'idle'}),
      getPersonalAssistant:async()=>({
        assistant:{id:'personal',enabled:false,defaultAgentId:'codex',autoReviewEnabled:false},
        documents:['soul','working_rules','user','memory'].map(type=>({type,content:'',revision:1})),
        review:{status:'off'}
      }),
      getClaudeSources:async()=>sources, getCodexSources:async()=>sources,
      getAgentSetup:async()=>({phase:'idle',cancellable:false}),
      getLocalModels:async()=>({availability:'ready',activeModelId:null,models:[],message:'布局测试提示'}),
      getDeepSeekConnection:async()=>({installed:true,verified:true,baseUrl:'https://api.deepseek.com',hasKey:true})
    };
    window.uniagent = new Proxy(api, {get:(target,key)=>target[key] ||
      (String(key).startsWith('on') ? () => noop : async () => null)});
    const agents = ['codex','deepseek'].map(id=>({id,name:id==='codex'?'Codex':'DeepSeek Harness',
      adapter:id,bin:'/fixture/'+id,installed:true,models:[],
      capabilities:{modelSelect:false,reasoningEffort:false,startupSystemPrompt:true,
        permissionModes:[{id:'ask',label:'询问'}]},
      lifecycle:{availability:'available',updateStatus:'current',selfUpdateSupported:true}
    }));
    const host = document.body.appendChild(document.createElement('div'));
    Object.assign(host.style,{display:'flex',height:'760px'});
    const settingsRoot = createRoot(host);
    window.__settingsErrors = [];
    window.addEventListener('error', event=>window.__settingsErrors.push(event.error?.stack || event.message));
    window.addEventListener('unhandledrejection', event=>window.__settingsErrors.push(String(event.reason)));
    window.__settleSettings = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    let serial = 0;
    window.__mountSettings = async (category,windowed,width) => {
      host.style.width = width+'px';
      flushSync(()=>settingsRoot.render(React.createElement(SettingsPanel,{
        key:++serial,initialCategory:category,windowed,agents,onRedetect:noop,onInitialize:noop,
        onAgentsChanged:noop,onOpenSync:noop,onBack:noop
      })));
      await window.__settleSettings();
      return host.querySelector('.set-content');
    };
    window.__settingsCategories = SETTINGS_CATEGORIES.filter(item=>!isSettingsPagePanel(item.id)).map(item=>item.id);
    window.__checkSettingsShell = async () => {
      const startup = document.createElement('div');
      startup.innerHTML = ${JSON.stringify(readFileSync('src/renderer/startup.html', 'utf8'))};
      startup.querySelector('#ua-startup').hidden = true;
      document.body.append(startup);
      Object.assign(api, {
        startupState:async()=>({ready:true}), getLifecycleSnapshot:async()=>agents,
        getAssistantPrivateSessions:async()=>[], listSessions:async()=>[], listQueues:async()=>({}),
        e2eEnabled:async()=>false
      });
      const { App } = await import('./src/renderer/App');
      const shellHost = document.body.appendChild(document.createElement('div'));
      Object.assign(shellHost.style,{display:'flex',width:'1280px'});
      const shellRoot = createRoot(shellHost);
      const settle = async () => { await window.__settleSettings(); await new Promise(resolve=>setTimeout(resolve,260)); };
      const failures = [];
      const check = (condition,label) => { if (!condition) failures.push(label); };
      for (const collapsed of [false,true]) {
        localStorage.setItem('ua.sidebarCollapsed',collapsed?'1':'0');
        localStorage.setItem('ua.sidebarWidth','312');
        flushSync(()=>shellRoot.render(React.createElement(App,{key:String(collapsed)})));
        await settle();
        const sidebar = shellHost.querySelector('.sidebar');
        const entry = shellHost.querySelector('.settings-entry');
        entry.click(); await settle();
        check(sidebar.getBoundingClientRect().width===0, 'settings covers the session sidebar/'+collapsed);
        check(sidebar.inert && sidebar.getAttribute('aria-hidden')==='true', 'covered sidebar cannot receive focus/'+collapsed);
        check(!shellHost.querySelector('.sidebar-reveal'), 'settings has no sidebar reveal button/'+collapsed);
        check(shellHost.querySelector('.main').getBoundingClientRect().left===shellHost.getBoundingClientRect().left, 'settings fills the window/'+collapsed);
        const head = shellHost.querySelector('.settings-head');
        const back = shellHost.querySelector('.settings-back');
        const headRect = head.getBoundingClientRect(), backRect = back.getBoundingClientRect();
        const style = getComputedStyle(head);
        check(style.paddingTop==='8px' && style.paddingBottom==='8px', 'settings header has equal compact padding/'+collapsed);
        check(Math.abs(backRect.top-headRect.top-8)<1 && Math.abs(headRect.bottom-backRect.bottom-9)<1, 'back button has no extra vertical margin/'+collapsed);
        check(backRect.left-headRect.left>=88, 'back button clears macOS window controls/'+collapsed);
        shellHost.querySelectorAll('.set-nav-item')[1].click(); await settle();
        check(sidebar.getBoundingClientRect().width===0, 'changing category keeps the sidebar covered/'+collapsed);
        back.click(); await settle();
        check(sidebar.getBoundingClientRect().width===(collapsed?0:312), 'return restores sidebar width/'+collapsed);
        check(sidebar.inert===collapsed, 'return restores sidebar focus/'+collapsed);
        check(localStorage.getItem('ua.sidebarCollapsed')===(collapsed?'1':'0'), 'settings preserves saved collapsed preference/'+collapsed);
        check(localStorage.getItem('ua.sidebarWidth')==='312', 'settings preserves saved sidebar width/'+collapsed);
        if (!collapsed) {
          [...shellHost.querySelectorAll('.sidebar-nav-item')].find(button=>button.textContent.trim()==='Agent').click(); await settle();
          check(sidebar.getBoundingClientRect().width===312, 'sidebar shortcut keeps its existing navigation');
          check(!shellHost.querySelector('.set-nav'), 'sidebar shortcut keeps its category-only view');
        }
      }
      flushSync(()=>shellRoot.unmount());
      return failures;
    };
  `,
  inspect: `(async () => {
    const measurements = [];
    const paddings = [];
    const cases = [];
    const controlWidths = [];
    function measure(content,label,regular=true) {
      cases.push(label);
      const style = getComputedStyle(content);
      if (regular) paddings.push({label,left:parseFloat(style.paddingLeft),right:parseFloat(style.paddingRight)});
      const page = [...content.children].find(element=>element.matches('.set-page:not([hidden])'));
      if (!page) throw new Error(label+': missing active settings page');
      const items = [...page.querySelectorAll('.set-group,.codex-model-pane,.deepseek-setup,.set-detail-bar,.update-alert,.assistant-save,.role-detail-top,.team-page,.auto-config,.auto-config-scroll,.auto-config-savebar')]
        .filter(element=>element.getClientRects().length);
      if (!items.length) throw new Error(label+': missing rendered settings items');
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        const parent = item.parentElement;
        const parentLeft = parent.getBoundingClientRect().left+parent.clientLeft;
        const style = getComputedStyle(parent);
        const left = rect.left-parentLeft-parseFloat(style.paddingLeft);
        const right = parentLeft+parent.clientWidth-parseFloat(style.paddingRight)-rect.right;
        measurements.push({label,item:item.className,left,right,width:rect.width});
      }
    }
    async function click(content,selector,text,expected) {
      const button = [...content.querySelectorAll(selector)].find(element=>element.getClientRects().length && element.textContent.includes(text));
      if (!button) throw new Error('Missing settings action: '+text);
      button.click();
      await window.__settleSettings();
      if (!content.querySelector(expected)?.getClientRects().length) throw new Error('Settings action did not render: '+text);
    }
    for (const width of [720,1280]) {
      for (const windowed of [true,false]) {
        for (const category of window.__settingsCategories) {
          const content = await window.__mountSettings(category,windowed,width);
          measure(content,category+'/'+(windowed?'windowed':'embedded')+'/'+width);
        }
      }
    }
    for (const [category,selector,text,expected] of [
      ['general','button',${JSON.stringify(APP_NAME + ' 版本')},'.update-alert'],
      ['agent','button[aria-label="查看 Codex 详情"]','','.set-detail-top'],
      ['agent','button[aria-label="查看 DeepSeek Harness 详情"]','','.set-detail-top'],
      ['assistants','button[role="tab"]','session飞书管理','.assistant-bind-form'],
      ['codex-sources','button[role="tab"]','Codex','.set-detail-bar'],
      ['roles','button','添加角色','.role-detail-top'],
      ['teams','button','创建团队','.team-form']
    ]) {
      const content = await window.__mountSettings(category,true,1280);
      await click(content,selector,text,expected);
      measure(content,category+'/detail/'+(text || selector));
      if (selector.includes('DeepSeek Harness')) {
        if (content.querySelector('.deepseek-setup')) throw new Error('A ready Agent must show its standard detail page');
        await click(content,'button','管理登录','.deepseek-setup');
        measure(content,'agent/manage-deepseek-login');
        controlWidths.push(content.querySelector('input[aria-label="DeepSeek API Key"]').getBoundingClientRect().width);
      }
    }
    let content = await window.__mountSettings('teams',true,1280);
    await click(content,'button.team-tile','布局团队','.team-form');
    await click(content,'button.team-member-label','布局角色','.team-role-form');
    measure(content,'teams/member-role');
    content = await window.__mountSettings('teams',true,1280);
    await click(content,'button','创建团队','.team-form');
    await click(content,'button','添加成员','[role="dialog"]');
    await click(content,'button','创建团队专属角色','.team-role-modal');
    measure(content,'teams/role-dialog');
    for (const width of [720,1280]) {
      for (const windowed of [true,false]) {
        content = await window.__mountSettings('automations',windowed,width);
        await click(content,'button','新建','.auto-config');
        measure(content,'automations/create/'+windowed+'/'+width,false);
      }
    }
    const shellFailures = await window.__checkSettingsShell();
    return {measurements,paddings,cases,controlWidths,shellFailures,errors:window.__settingsErrors};
  })()`
})

assert.deepEqual(result.errors, [], 'settings fixtures must render without errors')
assert.deepEqual(result.shellFailures, [], 'settings covers the sidebar, keeps a compact header and restores the previous sidebar state on return')
assert.equal(result.cases.length, INTERNAL_DISTRIBUTION ? 54 : 50, 'distribution categories and the automation editor cover both entry modes, narrow/wide containers, ready details, login management and a nested dialog')
assert.deepEqual(result.paddings.filter(({ left, right }) => left !== 24 || right !== 24), [], 'settings content keeps 24px on both sides')
assert.deepEqual(result.controlWidths, [348], 'widening the setup container preserves the API Key field width')
const failures = result.measurements.filter(({ left, right, width }) => width <= 0 || left < -1 || right < -1 || Math.abs(left - right) > 1)
assert.deepEqual(failures, [], 'settings items and action bars must keep equal space on both sides of their parent content')
console.log(`settings-spacing: ${result.cases.length} views and ${result.measurements.length} item bounds passed`)
import { INTERNAL_DISTRIBUTION, APP_NAME } from '../src/shared/distribution'
