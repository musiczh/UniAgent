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
    let prefs = {lastByAgent:{}};
    const api = {
      homeDir:'/fixture',
      getWorktreeArchiveReviews:async()=>[],
      teamCatalog:async()=>({projects:[],teams:[{id:'layout-team',revision:1,name:'布局团队',description:'',rules:'',
        leaderMemberId:'layout-member',members:[{id:'layout-member',role}],limits:DEFAULT_TEAM_LIMITS,status:'draft'}],errors:[]}),
      listDiagnostics:async()=>[], listPresets:async()=>[], listProjects:async()=>[],
      listRoles:async()=>[], listRequirements:async()=>[], listModelCredentials:async()=>[],
      listAutomations:async()=>[], listAgents:async()=>agents,
      getPrefs:async()=>prefs,
      setPrefs:async(id,patch)=>(prefs={lastByAgent:{...prefs.lastByAgent,[id]:{...prefs.lastByAgent[id],...patch}}}),
      getAppVersion:async()=>'1.0.9',
      getAppSettings:async()=>({autoCheckUpdate:false, enabledAgentIds:['codex','deepseek'],spaceRequirementSidebar:false}),
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
      adapter:id,bin:'/fixture/'+id,installed:true,
      models:id==='codex'?[{id:'layout-model',label:'A long model name that must not expand the default parameter control',efforts:['low','high']}]:[],
      capabilities:{modelSelect:id==='codex',reasoningEffort:id==='codex',startupSystemPrompt:true,
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
    window.__configureFeishuDefaults = () => {
      const previous = {getAppSettings:api.getAppSettings,feishuStatus:api.feishuStatus,listProjects:api.listProjects};
      let settings = {autoCheckUpdate:false,enabledAgentIds:['codex','deepseek'],spaceRequirementSidebar:false,
        feishu:{defaultAgentId:'codex',defaultModel:'layout-model',defaultEffort:'low',defaultPermissionMode:'ask',defaultProjectId:'default'}};
      window.__feishuPatches = [];
      api.getAppSettings = async()=>settings;
      api.feishuStatus = async()=>({appId:'layout-bot',connected:true});
      api.listProjects = async()=>[{id:'default',name:'默认项目',isDefault:true},
        {id:'long-project',name:'A long project name that must not expand the default parameter control'}];
      api.setAppSettings = async patch => {
        window.__feishuPatches.push(patch.feishu);
        settings = {...settings,feishu:{...settings.feishu,...patch.feishu}};
        return settings;
      };
      return () => {Object.assign(api,previous);delete api.setAppSettings;};
    };
    window.__settingsCategories = SETTINGS_CATEGORIES.filter(item=>!isSettingsPagePanel(item.id)).map(item=>item.id);
    window.__checkSettingsShell = async () => {
      const startup = document.createElement('div');
      startup.innerHTML = ${JSON.stringify(readFileSync('src/renderer/startup.html', 'utf8'))};
      startup.querySelector('#ua-startup').hidden = true;
      document.body.append(startup);
      Object.assign(api, {
        startupState:async()=>({ready:true}), getLifecycleSnapshot:async()=>agents,
        getAssistantPrivateSessions:async()=>[], listSessions:async()=>[0,1].map(index=>({
          id:'layout-session-'+index,title:'会话布局 '+index,status:'idle',createdAt:2-index,
          config:{agentId:'codex',workdir:'/fixture',model:'default',permissionMode:'ask'}
        })), listQueues:async()=>({}),
        e2eEnabled:async()=>false
      });
      const { App } = await import('./src/renderer/App');
      const shellHost = document.body.appendChild(document.createElement('div'));
      Object.assign(shellHost.style,{display:'flex',width:'1280px'});
      const shellRoot = createRoot(shellHost);
      const settle = async () => { await window.__settleSettings(); await new Promise(resolve=>setTimeout(resolve,260)); };
      const failures = [];
      const check = (condition,label) => { if (!condition) failures.push(label); };
      const rowProperties = ['fontFamily','fontSize','fontWeight','lineHeight','gap','paddingTop','paddingRight','paddingBottom','paddingLeft','borderRadius','color','backgroundColor'];
      const readStyle = (element,properties) => Object.fromEntries(properties.map(property=>[property,getComputedStyle(element)[property]]));
      const textOffset = (row,selector) => row.querySelector(selector).getBoundingClientRect().left-row.getBoundingClientRect().left;
      const rowStep = rows => rows[1].getBoundingClientRect().top-rows[0].getBoundingClientRect().top;
      const dragTo = async (requested,expected,settings) => {
        const handle = [...shellHost.querySelectorAll('.sidebar-resizer')].find(element=>!element.closest('[inert]') && element.getBoundingClientRect().width>0);
        check(!!handle,'visible resize handle/'+settings);
        if (!handle) return;
        const rail = shellHost.querySelector(settings?'.set-nav':'.sidebar');
        const rect = handle.getBoundingClientRect();
        check(rect.left+rect.width/2===rail.getBoundingClientRect().right,'resize handle follows the rail boundary/'+settings);
        check(getComputedStyle(handle).webkitAppRegion==='no-drag','resizing does not drag the window/'+settings);
        handle.dispatchEvent(new MouseEvent('mousedown',{button:0,clientX:rect.left+rect.width/2,bubbles:true}));
        check(document.body.classList.contains('resizing-sidebar'),'drag starts/'+settings);
        window.dispatchEvent(new MouseEvent('mousemove',{clientX:requested,bubbles:true}));
        await window.__settleSettings();
        check(rail.getBoundingClientRect().width===expected,'drag clamps rail width/'+settings+'/'+requested);
        if (settings) check(shellHost.querySelector('.settings-head').getBoundingClientRect().width===expected,'drag keeps heading and navigation aligned');
        const saveDeadline=performance.now()+1000;
        while (localStorage.getItem('ua.sidebarWidth')!==String(expected) && performance.now()<saveDeadline) {
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        check(localStorage.getItem('ua.sidebarWidth')===String(expected),'drag saves width/'+settings+'/'+requested);
        window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        window.dispatchEvent(new MouseEvent('mousemove',{clientX:400,bubbles:true}));
        await window.__settleSettings();
        check(!document.body.classList.contains('resizing-sidebar') && rail.getBoundingClientRect().width===expected,'mouse release ends drag/'+settings);
      };
      for (const [savedWidth,initialWidth,collapsed] of [[null,220,false],['invalid',220,false],['199',220,false],['521',220,false],['200',200,false],['260',260,false],['520',520,false],['312',312,true]]) {
        let width = initialWidth;
        localStorage.setItem('ua.sidebarCollapsed',collapsed?'1':'0');
        if (savedWidth===null) localStorage.removeItem('ua.sidebarWidth');
        else localStorage.setItem('ua.sidebarWidth',savedWidth);
        flushSync(()=>shellRoot.render(React.createElement(App,{key:savedWidth+'/'+collapsed})));
        await settle();
        const sidebar = shellHost.querySelector('.sidebar');
        check(sidebar.getBoundingClientRect().width===(collapsed?0:initialWidth), 'default or saved sidebar width/'+savedWidth);
        if (savedWidth===null) { await dragTo(300,300,false); width=300; }
        const shortcuts = [...shellHost.querySelectorAll('.sidebar-nav-item')];
        const sidebarColor = getComputedStyle(sidebar).backgroundColor;
        const navTop = shortcuts[0].getBoundingClientRect().top-sidebar.getBoundingClientRect().top;
        if (!collapsed) {
          const header = sidebar.querySelector('.sidebar-header');
          const brand = header.querySelector('.logo');
          const actions = header.querySelector('.header-actions');
          const nameLines = new Set();
          const walker = document.createTreeWalker(brand,NodeFilter.SHOW_TEXT);
          for (let node=walker.nextNode();node;node=walker.nextNode()) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) nameLines.add(Math.round(rect.top));
          }
          check(nameLines.size===1, 'sidebar name stays on one line/'+width);
          check(brand.getBoundingClientRect().right<=actions.getBoundingClientRect().left, 'sidebar name does not overlap action buttons/'+width);
          check([...actions.querySelectorAll('button')].every((button,index)=> {
            const rect=button.getBoundingClientRect();
            return rect.width===26 && rect.height===(index===0?22:26) && rect.right<=header.getBoundingClientRect().right-14;
          }), 'sidebar action buttons keep their size and remain inside the heading/'+width);
        }
        const sessions = [...sidebar.querySelectorAll('.session-item')];
        check(sessions.length===2, 'real session rows provide the typography baseline');
        const sessionStyle = readStyle(sessions[0],rowProperties);
        const sessionHeight = sessions[0].getBoundingClientRect().height;
        const sessionStep = rowStep(sessions);
        const sessionTextOffset = textOffset(sessions[0],'.si-title');
        const sessionIconWidth = sessions[0].querySelector('.si-icon').getBoundingClientRect().width;
        shortcuts.find(row=>row.textContent.trim()==='Agent').click(); await settle();
        const activeStyle = readStyle(shellHost.querySelector('.sidebar-nav-item.active'),['backgroundColor','color','fontWeight','boxShadow']);
        const entry = shellHost.querySelector('.settings-entry');
        entry.click(); await settle();
        check(sidebar.getBoundingClientRect().width===0, 'settings covers the session sidebar/'+collapsed);
        check(sidebar.inert && sidebar.getAttribute('aria-hidden')==='true', 'covered sidebar cannot receive focus/'+collapsed);
        check(!shellHost.querySelector('.sidebar-reveal'), 'settings has no sidebar reveal button/'+collapsed);
        check(shellHost.querySelector('.main').getBoundingClientRect().left===shellHost.getBoundingClientRect().left, 'settings fills the window/'+collapsed);
        const head = shellHost.querySelector('.settings-head');
        const back = shellHost.querySelector('.settings-back');
        const headRect = head.getBoundingClientRect(), backRect = back.getBoundingClientRect();
        const nav = shellHost.querySelector('.set-nav');
        const rows = [...nav.querySelectorAll('.set-nav-item')];
        check(headRect.width===width && nav.getBoundingClientRect().width===width, 'settings inherits sidebar width/'+width+'/'+collapsed);
        check(backRect.top-headRect.top===32 && backRect.left-headRect.left===14, 'back button sits below macOS window controls/'+collapsed);
        check(getComputedStyle(back).webkitAppRegion==='no-drag', 'back button remains clickable inside the drag region');
        check(getComputedStyle(head).backgroundColor===sidebarColor && getComputedStyle(nav).backgroundColor===sidebarColor, 'settings rail shares the sidebar background');
        check(getComputedStyle(nav).paddingLeft==='8px' && getComputedStyle(nav).paddingRight==='8px', 'settings rail shares the sidebar inset');
        check(JSON.stringify(readStyle(nav.querySelector('.active'),Object.keys(activeStyle)))===JSON.stringify(activeStyle), 'selected navigation shares sidebar styling');
        check(shellHost.querySelector('.set-content').getBoundingClientRect().top-headRect.top===40, 'content preserves its original vertical position');
        if (!collapsed) {
          check(rows[0].getBoundingClientRect().top-headRect.top===navTop, 'first navigation item aligns with the main sidebar');
          check(rowStep(rows)===sessionStep, 'navigation shares session row spacing/'+width);
          for (const row of rows) {
            const label = row.textContent.trim();
            if (!row.classList.contains('active')) check(JSON.stringify(readStyle(row,rowProperties))===JSON.stringify(sessionStyle), 'navigation shares session font and padding/'+label);
            check(row.getBoundingClientRect().height===sessionHeight, 'navigation shares session row height/'+label);
            check(textOffset(row,'.lbl')===sessionTextOffset, 'navigation shares session text alignment/'+label);
            check(row.querySelector('.ic').getBoundingClientRect().width===sessionIconWidth, 'navigation shares session icon size/'+label);
          }
        }
        if (savedWidth===null || collapsed) {
          for (const [requested,expected] of [[344,344],[150,200],[600,520],[332,332]]) await dragTo(requested,expected,true);
          width=332;
        }
        shellHost.querySelectorAll('.set-nav-item')[1].click(); await settle();
        check(sidebar.getBoundingClientRect().width===0, 'changing category keeps the sidebar covered/'+collapsed);
        back.click(); await settle();
        check(sidebar.getBoundingClientRect().width===(collapsed?0:width), 'return restores sidebar width/'+collapsed);
        check(sidebar.inert===collapsed, 'return restores sidebar focus/'+collapsed);
        check(localStorage.getItem('ua.sidebarCollapsed')===(collapsed?'1':'0'), 'settings preserves saved collapsed preference/'+collapsed);
        check(localStorage.getItem('ua.sidebarWidth')===String(width), 'settings preserves saved sidebar width/'+collapsed);
        if (!collapsed) {
          [...shellHost.querySelectorAll('.sidebar-nav-item')].find(button=>button.textContent.trim()==='Agent').click(); await settle();
          check(sidebar.getBoundingClientRect().width===width, 'sidebar shortcut keeps its existing navigation');
          check(!shellHost.querySelector('.set-nav'), 'sidebar shortcut keeps its category-only view');
          check(getComputedStyle(shellHost.querySelector('.settings-panel')).display==='flex', 'category-only view retains its full content layout');
        }
        if (savedWidth===null) {
          flushSync(()=>shellRoot.render(React.createElement(App,{key:'reload-saved-width'})));
          await settle();
          check(shellHost.querySelector('.sidebar').getBoundingClientRect().width===width, 'remount restores the width saved in settings');
        }
      }
      flushSync(()=>shellRoot.unmount());
      const frame = document.createElement('iframe');
      frame.style.cssText='width:720px;height:760px;border:0';
      await new Promise(resolve=>{
        frame.onload=resolve;
        frame.srcdoc='<link rel="stylesheet" href="'+document.querySelector('link[rel="stylesheet"]').href+'"><div id="narrow"></div>';
        document.body.appendChild(frame);
      });
      const narrowHost = frame.contentDocument.getElementById('narrow');
      const narrowRoot = createRoot(narrowHost);
      localStorage.setItem('ua.sidebarCollapsed','0');
      flushSync(()=>narrowRoot.render(React.createElement(App)));
      await settle();
      narrowHost.querySelector('.settings-entry').click();
      await settle();
      const narrowNav = narrowHost.querySelector('.set-nav');
      const narrowContent = narrowHost.querySelector('.set-content');
      const narrowBack = narrowHost.querySelector('.settings-back');
      check(frame.contentWindow.matchMedia('(max-width:720px)').matches, 'narrow fixture exercises the actual viewport breakpoint');
      check(frame.contentWindow.getComputedStyle(narrowHost.querySelector('.sidebar-resizer')).display==='none', 'narrow horizontal navigation has no vertical resize handle');
      check(frame.contentWindow.getComputedStyle(narrowNav).flexDirection==='row', 'narrow navigation remains horizontal');
      check(narrowContent.getBoundingClientRect().width===720, 'narrow content uses the full window width');
      check(narrowNav.scrollWidth>narrowNav.clientWidth, 'narrow navigation scrolls instead of stretching each item');
      check(narrowContent.getBoundingClientRect().top>=narrowNav.getBoundingClientRect().bottom, 'narrow content follows the navigation without overlap');
      check(narrowBack.getBoundingClientRect().top===32 && narrowBack.getBoundingClientRect().left===14, 'narrow back button also sits below window controls');
      const last = narrowNav.lastElementChild;
      last.click(); await window.__settleSettings();
      check(last.classList.contains('active') && !!narrowContent.querySelector('.token-embedded'), 'narrow navigation can open its last category');
      narrowBack.click();
      await settle();
      check(!narrowHost.querySelector('.set-nav'), 'narrow back button exits settings');
      check(narrowHost.querySelector('.sidebar').getBoundingClientRect().width===332, 'narrow return preserves the saved sidebar width');
      flushSync(()=>narrowRoot.unmount());
      frame.remove();
      return failures;
    };
  `,
  inspect: `(async () => {
    const measurements = [];
    const paddings = [];
    const cases = [];
    const controlWidths = [];
    const defaultParameterBounds = [];
    const feishuParameterBounds = [];
    function selectBounds(select) {
      const rect = select.parentElement.getBoundingClientRect();
      const caret = select.parentElement.querySelector('.set-caret').getBoundingClientRect();
      const input = select.getBoundingClientRect();
      return {width:rect.width,left:rect.left,right:rect.right,disabled:select.disabled,
        caretCovered:input.left<=caret.left && input.right>=caret.right};
    }
    function measureDefaultParameters(content,label) {
      const selects = ['默认模型','默认推理强度'].map(name=>content.querySelector('select[aria-label="'+name+'"]'));
      const bounds = selects.map(selectBounds);
      defaultParameterBounds.push({label,bounds,model:selects[0].value});
    }
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
        let parent = item.parentElement;
        while (getComputedStyle(parent).display==='contents') parent = parent.parentElement;
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
    const restoreFeishu = window.__configureFeishuDefaults();
    for (const width of [720,1280]) {
      for (const windowed of [true,false]) {
        const content = await window.__mountSettings('assistants',windowed,width);
        await click(content,'button[role="tab"]','session飞书管理','select[aria-label="驱动 Agent"]');
        const names = ['驱动 Agent','默认模型','默认推理强度','默认权限','默认项目'];
        const selects = () => names.map(name=>content.querySelector('select[aria-label="'+name+'"]'));
        const record = stage => feishuParameterBounds.push({label:width+'/'+windowed+'/'+stage,
          bounds:selects().map(selectBounds),values:selects().map(select=>select.value),
          overflow:content.scrollWidth>content.clientWidth});
        record('initial');
        if (width===1280 && !windowed) {
          for (const [name,value] of [['默认推理强度','high'],['默认项目','long-project'],['驱动 Agent','deepseek'],['驱动 Agent','codex']]) {
            const select = content.querySelector('select[aria-label="'+name+'"]');
            select.value = value;
            select.dispatchEvent(new Event('change',{bubbles:true}));
            await window.__settleSettings();
            record(name+'/'+value);
          }
        }
      }
    }
    const feishuPatches = window.__feishuPatches;
    restoreFeishu();
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
        measureDefaultParameters(content,'disabled');
        if (content.querySelector('.deepseek-setup')) throw new Error('A ready Agent must show its standard detail page');
        await click(content,'button','管理登录','.deepseek-setup');
        measure(content,'agent/manage-deepseek-login');
        controlWidths.push(content.querySelector('input[aria-label="DeepSeek API Key"]').getBoundingClientRect().width);
      }
    }
    for (const width of [720,1280]) {
      for (const windowed of [true,false]) {
        const content = await window.__mountSettings('agent',windowed,width);
        await click(content,'button[aria-label="查看 Codex 详情"]','','.set-detail-top');
        for (const value of ['', 'layout-model', '']) {
          const model = content.querySelector('select[aria-label="默认模型"]');
          model.value = value;
          model.dispatchEvent(new Event('change',{bubbles:true}));
          await window.__settleSettings();
          measureDefaultParameters(content,'enabled/'+width+'/'+windowed+'/'+value);
        }
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
    return {measurements,paddings,cases,controlWidths,defaultParameterBounds,feishuParameterBounds,feishuPatches,shellFailures,errors:window.__settingsErrors};
  })()`
})

assert.deepEqual(result.errors, [], 'settings fixtures must render without errors')
assert.deepEqual(result.shellFailures, [], 'settings matches Session rows, shares the 220px default and persisted drag width, and preserves back navigation and collapsed state')
assert.equal(result.cases.length, INTERNAL_DISTRIBUTION ? 58 : 54, 'distribution categories including superAgent settings and the automation editor cover both entry modes, narrow/wide containers, ready details, login management and a nested dialog')
assert.deepEqual(result.paddings.filter(({ left, right }) => left !== 24 || right !== 24), [], 'settings content keeps 24px on both sides')
assert.deepEqual(result.controlWidths, [348], 'widening the setup container preserves the API Key field width')
assert.equal(result.defaultParameterBounds.length, 13, 'default parameters cover disabled controls and narrow/wide containers in both entry modes')
for (const {label,bounds,model} of result.defaultParameterBounds) {
  assert.deepEqual(bounds.map(item=>item.width), [150,150], label+': both default parameter controls keep the compact 150px width despite long model options')
  assert.equal(bounds[0].left, bounds[1].left, label+': default parameter controls align on the left')
  assert.equal(bounds[0].right, bounds[1].right, label+': default parameter controls align on the right')
  assert.ok(bounds.every(item=>item.caretCovered), label+': native selects retain their full caret hit area')
  assert.ok(bounds.every(item=>item.disabled===(label==='disabled')), label+': control availability is preserved')
  assert.equal(model, label.endsWith('/layout-model')?'layout-model':'', label+': selecting a long model and returning to the previous choice still works')
}
assert.equal(result.feishuParameterBounds.length, 8, 'Feishu defaults cover both entry modes, narrow/wide containers and selection changes')
for (const {label,bounds,values,overflow} of result.feishuParameterBounds) {
  assert.deepEqual(bounds.map(item=>item.width), [150,150,150,150,150], label+': all five Feishu defaults keep the compact 150px width despite long options')
  assert.ok(bounds.every(item=>item.left===bounds[0].left && item.right===bounds[0].right), label+': all five controls align on both sides')
  assert.ok(bounds.every(item=>item.caretCovered), label+': native selects cover their caret hit area')
  assert.equal(overflow, false, label+': long options cannot overflow the settings content')
  assert.deepEqual(bounds.map(item=>item.disabled), [false,values[0]==='deepseek',values[0]==='deepseek',false,false], label+': agent capabilities preserve disabled states')
  if (label.endsWith('/initial')) assert.deepEqual(values, ['codex','layout-model','low','ask','default'])
  if (label.endsWith('默认推理强度/high')) assert.equal(values[2], 'high')
  if (label.endsWith('默认项目/long-project')) assert.equal(values[4], 'long-project')
}
assert.deepEqual(result.feishuPatches.slice(0,2), [{defaultEffort:'high'},{defaultProjectId:'long-project'}], 'compact controls still save the selected effort and project')
assert.deepEqual(result.feishuPatches.slice(2).map(patch=>patch.defaultAgentId), ['deepseek','codex'], 'agent changes still save and refresh dependent controls')
const failures = result.measurements.filter(({ left, right, width }) => width <= 0 || left < -1 || right < -1 || Math.abs(left - right) > 1)
assert.deepEqual(failures, [], 'settings items and action bars must keep equal space on both sides of their parent content')
console.log(`settings-spacing: ${result.cases.length} views and ${result.measurements.length} item bounds passed`)
import { INTERNAL_DISTRIBUTION, APP_NAME } from '../src/shared/distribution'
