import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'agent-list-status-ui', {
  setup: `
    import { SettingsPanel } from './src/renderer/components/SettingsPanel';
    const names = { nika: 'Nika', zcode: 'ZCode', mcode: 'MiniMax Code', deepseek: 'DeepSeek Harness', codex: 'Codex', traex: 'TraeX', claude: 'Claude Code', kimi: 'Kimi Code', grok: 'Grok', full: '满额度', warn: '低额度', critical: '临界额度', offline: '待安装 Agent' };
    const agent = (id, lifecycle) => ({ id, name: names[id], adapter: ['full','warn','critical'].includes(id) ? 'codex' : id === 'offline' ? 'generic' : id, bin: '/fixture/bin/' + id, builtin: true, installed: id !== 'offline', version: '1.2.3', models: [],
      capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [{ id: 'ask', label: '询问' }] },
      lifecycle: { availability: 'available', auth: 'authenticated', health: 'healthy', updateStatus: 'current', checkedAt: 1, ...lifecycle } });
    const agents = Object.keys(names).map(id => agent(id, id === 'kimi'
      ? { availability: 'unhealthy', health: 'unhealthy', detectionStatus: 'failed', detectionError: '连接失败' }
      : id === 'offline' ? { availability: 'not-installed' } : id === 'codex' ? { updateStatus: 'available' } : {}));
    window.opened = []; window.nikaOpened = 0; window.quotaQueries = [];
    window.zcodeService = 'zai-coding'; window.toggleCalls = [];
    const settings = { enabledAgentIds: Object.keys(names), sidebarShortcuts: [], autoCheckUpdate: false };
    window.uniagent = new Proxy({
      homeDir: '/fixture', teamCatalog: async () => ({ teams: [], errors: [] }), getAppSettings: async () => settings,
      getPrefs: async () => ({ lastByAgent: {} }), getAppVersion: async () => '1.0.9',
      getZCodeConfiguration: async () => ({ service: window.zcodeService, phase: 'ready', hasKey: true }),
      setAppSettings: async patch => { window.toggleCalls.push(patch); Object.assign(settings, patch); return settings; },
      feishuStatus: async () => ({ configured: false, configuring: false, status: { phase: 'idle' } }),
      getAgentQuota: async id => {
        window.quotaQueries.push(id);
        if (id === 'codex') return { agentId: id, status: 'error', stale: true, kind: 'windows', windows: [{ label: '5 小时限额', usedPercent: 18 }, { label: '周限额', usedPercent: 32 }], capturedAt: 2 };
        if (['grok','full','warn','critical'].includes(id)) return { agentId: id, status: 'ready', kind: 'windows', windows: [{ label: '套餐额度', usedPercent: { grok:100, full:0, warn:80, critical:95 }[id] }], capturedAt: 2 };
        if (id === 'deepseek') return { agentId: id, status: 'ready', kind: 'balance', balances: [{ currency: 'CNY', total: '12.34' }], capturedAt: 2 };
        if (id === 'traex') throw Error('quota unavailable');
        return null;
      },
      openExternal: async url => { window.opened.push(url); },
      nikaSetupAction: async action => { if (action === 'open') window.nikaOpened += 1; }
    }, { get: (target, key) => target[key] || (String(key).startsWith('on') ? () => () => {} : async () => []) });
    const host = document.body.appendChild(document.createElement('div'));
    Object.assign(host.style, {display:'flex',width:'1280px',height:'900px'});
    window.settingsHost = host;
    createRoot(host).render(React.createElement(SettingsPanel, { agents, initialCategory: 'agent',
      onAgentsChanged: () => {}, onRedetect: () => {}, onInitialize: () => {}, onOpenSync: () => {}, onBack: () => {} }));
  `,
  inspect: `(async () => {
    const wait = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Agent list condition timeout: ' + document.body.innerText.slice(-1500)); };
    const row = name => document.querySelector('button[aria-label="查看 ' + name + ' 详情"]')?.closest('.settings-agent-row');
    const result = {};
    await wait(() => row('Codex')?.querySelector('[role="progressbar"]') && window.quotaQueries.length === 9);
    result.codexRow = row('Codex').innerText;
    result.kimiRow = row('Kimi Code').innerText;
    result.codexSub = row('Codex').querySelector('.r-sub').textContent;
    result.meters = ['Codex','Grok','满额度','低额度','临界额度'].map(name => {
      const meter = row(name).querySelector('[role="progressbar"]');
      return { name, text:meter.textContent, value:Number(meter.getAttribute('aria-valuenow')),
        width:meter.querySelector('i').style.width, title:meter.title,
        tone:meter.parentElement.classList.contains('danger') ? 'danger' : meter.parentElement.classList.contains('warn') ? 'warn' : 'ok' };
    });
    result.deepseekHint = row('DeepSeek Harness').querySelector('.settings-agent-console').title;
    result.balanceHasNoBar = !row('DeepSeek Harness').querySelector('[role="progressbar"]');
    result.noConsole = ['Nika','TraeX'].map(name => ({name, button:!!row(name).querySelector('.settings-agent-console'),text:row(name).querySelector('.settings-agent-quota').textContent}));
    result.pathHidden = ![...document.querySelectorAll('.settings-agent-row')].some(item => item.innerText.includes('/fixture/bin/'));
    result.quotaQueries = [...window.quotaQueries];
    result.layouts = [];
    for (const width of [1280, 860]) {
      window.settingsHost.style.width = width + 'px';
      await new Promise(resolve => requestAnimationFrame(resolve));
      const controls = [...document.querySelectorAll('.settings-agent-controls')];
      result.layouts.push(controls.map(control => {
        const quota = control.querySelector('.settings-agent-quota');
        const status = control.querySelector('.settings-agent-status');
        const toggle = control.querySelector('[role="switch"]');
        const q = quota.getBoundingClientRect(), s = status.getBoundingClientRect(), t = toggle.getBoundingClientRect();
        return {quota:q.x,status:s.x,toggle:t.x,ordered:q.right <= s.left && s.right <= t.left,
          adjacent:status.nextElementSibling === toggle || status.nextElementSibling?.contains(toggle)};
      }));
    }
    const consoleButtons = [...document.querySelectorAll('.settings-agent-console')];
    result.consoleLabels = consoleButtons.map(button => button.textContent);
    result.consoleSizes = consoleButtons.map(button => ({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}));
    for (const name of ['ZCode','MiniMax Code','DeepSeek Harness','Claude Code','Kimi Code']) {
      const before = window.opened.length;
      row(name).querySelector('.settings-agent-console').click();
      await wait(() => window.opened.length === before + 1);
    }
    window.zcodeService = 'bigmodel-api';
    row('ZCode').querySelector('.settings-agent-console').click();
    await wait(() => window.opened.length === 6);
    result.opened = [...window.opened];
    result.stillInList = !!row('Codex') && !document.querySelector('.set-page:not([hidden]) .set-detail-title');
    row('Codex').querySelector('[role="switch"]').click();
    await wait(() => window.toggleCalls.length === 1);
    result.enabledAgentIds = window.toggleCalls[0].enabledAgentIds;
    result.toggleStayedInList = !!row('Codex') && !document.querySelector('.set-page:not([hidden]) .set-detail-title');
    result.nikaOpened = window.nikaOpened;
    return result;
  })()`
})

assert.ok(result.codexRow.includes('可更新'), '有新版本的 Agent 显示可更新')
assert.ok(result.codexRow.includes('1.2.3'), '列表展示版本号')
assert.equal(result.codexSub, '1.2.3', '版本行不再混入额度')
assert.deepEqual(result.meters.map(({name,text,value,width,tone}: any) => ({name,text,value,width,tone})), [
  {name:'Codex',text:'68%',value:68,width:'68%',tone:'ok'},
  {name:'Grok',text:'0%',value:0,width:'0%',tone:'danger'},
  {name:'满额度',text:'100%',value:100,width:'100%',tone:'ok'},
  {name:'低额度',text:'20%',value:20,width:'20%',tone:'warn'},
  {name:'临界额度',text:'5%',value:5,width:'5%',tone:'danger'}
], '横条、数字和无障碍值都表示剩余比例，保留耗尽、满额与低额度边界')
assert.match(result.meters[0].title, /周限额.*剩余 68%.*显示上次结果/, '保留限额窗口与过期数据说明')
assert.match(result.deepseekHint, /余额 ¥12.34/, '余额放入控制台悬停说明')
assert.equal(result.balanceHasNoBar, true, '只有余额时不编造百分比')
assert.ok(result.kimiRow.includes('检测失败'), '检测失败保留状态与重试入口')
assert.equal(result.pathHidden, true, '列表不再展示本机目录')
assert.deepEqual(result.quotaQueries.sort(), ['claude','codex','critical','deepseek','full','grok','traex','warn','zcode'], '控制台回退不能阻止原生查询；未安装、异常和不支持查询的 Agent 不查询')
for (const layout of result.layouts) {
  assert.equal(layout.length, 13)
  for (const item of layout) {
    assert.equal(item.ordered, true, '额度、状态、开关不能重叠或错序')
    assert.equal(item.adjacent, true, '状态与开关之间不能插入按钮')
    for (const column of ['quota','status','toggle']) assert.ok(Math.abs(item[column] - layout[0][column]) < 1, column + ' 全行对齐，包含未安装与检测失败')
  }
}
assert.deepEqual(result.noConsole, [{name:'Nika',button:false,text:'—'},{name:'TraeX',button:false,text:'—'}])
assert.ok(result.consoleLabels.every((text: string) => text === '控制台'))
assert.ok(result.consoleSizes.every(({width,height}: any) => width <= 72 && height <= 26), '控制台按钮使用更小尺寸')
assert.deepEqual(result.opened, ['https://z.ai/manage-apikey/billing', 'https://platform.minimaxi.com/user-center/payment/coding-plan',
  'https://platform.deepseek.com/', 'https://claude.ai/settings/usage', 'https://www.kimi.com/code/console', 'https://bigmodel.cn/finance/overview'], '按钮在浏览器打开对应控制台，ZCode 按点击时的当前服务选择')
assert.equal(result.nikaOpened, 0, 'Nika 不再跳转客户端')
assert.equal(result.stillInList, true, '控制台按钮不触发行详情')
assert.equal(result.enabledAgentIds.includes('codex'), false)
assert.equal(result.toggleStayedInList, true, '开关仍可操作且不打开详情')
console.log('Agent list status: aligned quota/status/toggle columns, remaining bars, compact browser consoles, exceptions and independent controls passed')
