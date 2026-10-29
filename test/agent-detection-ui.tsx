import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'agent-detection-ui', {
  setup: `
    import { SettingsPanel } from './src/renderer/components/SettingsPanel';
    const names = { codex: 'Codex', traex: 'TraeX', claude: 'Claude Code', zcode: 'ZCode', deepseek: 'DeepSeek Harness', kimi: 'Kimi Code', grok: 'Grok' };
    const agent = id => ({ id, name: names[id], adapter: id, bin: '/fixture/' + id, builtin: true, installed: true, models: [],
      capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [{ id: 'ask', label: '询问' }] },
      lifecycle: { availability: 'available', auth: 'authenticated', health: 'healthy', updateStatus: id === 'zcode' ? 'available' : 'current', checkedAt: 1 } });
    const failed = (id, message) => ({ ...agent(id), lifecycle: { ...agent(id).lifecycle, availability: 'unhealthy', detectionStatus: 'failed', detectionError: message } });
    window.calls = []; window.finishes = {}; window.rejects = {}; window.updateChecks = [];
    const settings = { enabledAgentIds: Object.keys(names), sidebarShortcuts: [], autoCheckUpdate: false };
    window.uniagent = new Proxy({
      homeDir: '/fixture', teamCatalog: async () => ({ teams: [], errors: [] }), getAppSettings: async () => settings,
      getPrefs: async () => ({ lastByAgent: {} }), getAppVersion: async () => '1.0.9',
      feishuStatus: async () => ({ configured: false, configuring: false, status: { phase: 'idle' } }),
      getLifecycleSnapshot: async () => window.currentAgents,
      checkAgentUpdate: async id => { window.updateChecks.push(id); return agent(id); },
      detectAgent: id => { window.calls.push(id); return new Promise((resolve, reject) => { window.finishes[id] = (message) => resolve(message ? failed(id, message) : agent(id)); window.rejects[id] = reject; }); },
      detectAgents: async () => { throw Error('single retry must not detect all agents'); }
    }, { get: (target, key) => target[key] || (String(key).startsWith('on') ? () => () => {} : async () => []) });
    function Harness() {
      const [agents, setAgents] = React.useState(Object.keys(names).map(id => ['kimi', 'grok'].includes(id) ? failed(id, id + ' 初次检测失败') : agent(id)));
      window.currentAgents = agents;
      window.publishAgent = (id, message) => setAgents(current => current.map(item => item.id === id ? message ? failed(id, message) : agent(id) : item));
      return React.createElement(SettingsPanel, { agents, initialCategory: 'agent', onAgentsChanged: setAgents,
        onRedetect: () => { throw Error('unexpected global re-detection'); }, onInitialize: () => {}, onOpenSync: () => {}, onBack: () => {} });
    }
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(Harness));
  `,
  inspect: `(async () => {
    const wait = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Agent UI condition timeout: ' + document.body.innerText.slice(-1500)); };
    const retry = name => document.querySelector('button[aria-label="重试检测 ' + name + '"]');
    const row = name => document.querySelector('button[aria-label="查看 ' + name + ' 详情"]')?.closest('.settings-agent-row');
    const ready = name => row(name)?.getAttribute('aria-busy') === 'false' && !retry(name);
    const result = {};
    await wait(() => retry('Kimi Code') && retry('Grok'));
    result.initialCount = document.querySelectorAll('.settings-agent-row').length;
    result.initialReason = row('Kimi Code').innerText.includes('kimi 初次检测失败');
    result.entryUpdateChecks = window.updateChecks.length;
    for (let entry = 0; entry < 2; entry++) {
      document.querySelector('button[aria-label="查看 TraeX 详情"]').click();
      await wait(() => document.querySelector('.set-detail-title'));
      if (entry === 0) result.detailEntryUpdateChecks = window.updateChecks.length;
      else {
        const check = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '检查更新');
        check.click(); await wait(() => window.updateChecks.length === 1 && !check.disabled);
      }
      document.querySelector('.set-back').click();
      await wait(() => row('Codex'));
    }
    result.explicitUpdateChecks = [...window.updateChecks];
    result.reentryKeepsStatus = row('TraeX').innerText.includes('可用') && !row('TraeX').innerText.includes('可更新');
    result.updatableRow = row('ZCode').innerText.includes('可更新');
    result.readyRowHasNoUpdateHint = !row('Codex').innerText.includes('可更新');
    // 列表只显示三态，更新结论本身仍保留在详情页。
    document.querySelector('button[aria-label="查看 TraeX 详情"]').click();
    await wait(() => document.querySelector('.set-detail-title'));
    result.detailKeepsUpdateState = document.body.innerText.includes('已是最新');
    document.querySelector('.set-back').click();
    await wait(() => row('Codex'));
    const firstRetry = retry('Kimi Code'); firstRetry.click(); firstRetry.click();
    await wait(() => row('Kimi Code').getAttribute('aria-busy') === 'true' && !retry('Kimi Code'));
    result.kimiPending = row('Kimi Code').innerText.includes('检测中…');
    result.otherRetryEnabled = !retry('Grok').disabled;
    result.enabledToggle = !row('Codex').querySelector('button[role=switch]').disabled;
    retry('Grok').click(); await wait(() => window.finishes.grok);
    window.finishes.kimi('Kimi 服务连接超时，请重试');
    await wait(() => row('Kimi Code').innerText.includes('Kimi 服务连接超时'));
    result.failureRetained = !retry('Kimi Code').disabled && document.querySelectorAll('.settings-agent-row').length === 7;
    window.finishes.grok(); await wait(() => ready('Grok'));
    result.otherRecoveryKeepsKimiFailure = row('Kimi Code').innerText.includes('Kimi 服务连接超时') && row('Grok').innerText.includes('可用');
    retry('Kimi Code').click(); await wait(() => row('Kimi Code').getAttribute('aria-busy') === 'true' && !retry('Kimi Code'));
    window.finishes.kimi(); await wait(() => ready('Kimi Code'));
    result.recovered = row('Kimi Code').innerText.includes('可用') && !row('Kimi Code').innerText.includes('检测失败') && !row('Kimi Code').innerText.includes('服务连接超时');
    window.publishAgent('kimi', '模拟新的检测异常'); await wait(() => retry('Kimi Code'));
    retry('Kimi Code').click(); await wait(() => row('Kimi Code').getAttribute('aria-busy') === 'true' && !retry('Kimi Code'));
    window.rejects.kimi(new Error('检测请求连接已断开'));
    await wait(() => row('Kimi Code').innerText.includes('检测请求连接已断开'));
    result.requestFailureRetryable = !retry('Kimi Code').disabled;
    window.publishAgent('kimi'); await wait(() => ready('Kimi Code'));
    result.freshSnapshotClearsRequestError = !row('Kimi Code').innerText.includes('检测请求连接已断开');
    result.finalCount = document.querySelectorAll('.settings-agent-row').length;
    result.calls = window.calls;
    return result;
  })()`
})

assert.equal(result.initialCount, 7)
assert.equal(result.initialReason, true)
assert.equal(result.entryUpdateChecks, 0)
assert.equal(result.detailEntryUpdateChecks, 0)
assert.deepEqual(result.explicitUpdateChecks, ['traex'])
assert.equal(result.reentryKeepsStatus, true)
assert.equal(result.updatableRow, true)
assert.equal(result.readyRowHasNoUpdateHint, true)
assert.equal(result.detailKeepsUpdateState, true)
assert.equal(result.kimiPending, true)
assert.equal(result.otherRetryEnabled, true)
assert.equal(result.enabledToggle, true)
assert.equal(result.failureRetained, true)
assert.equal(result.otherRecoveryKeepsKimiFailure, true)
assert.equal(result.recovered, true)
assert.equal(result.requestFailureRetryable, true)
assert.equal(result.freshSnapshotClearsRequestError, true)
assert.equal(result.finalCount, 7)
assert.deepEqual(result.calls, ['kimi', 'grok', 'kimi', 'kimi'])
console.log('Agent detection UI: all rows retained, failure reasons, isolated concurrent retries and recovery passed')
