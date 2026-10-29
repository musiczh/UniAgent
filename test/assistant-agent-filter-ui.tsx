import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'assistant-agent-filter', {
  setup: `
    import {AssistantSettings} from './src/renderer/components/AssistantSettings';
    const agent = (id, name, supported) => ({
      id, name, adapter: id, bin: id, icon: id, builtin: true, installed: true,
      lifecycle: { availability: 'available', auth: 'unknown', health: 'unknown' },
      capabilities: {
        modelSelect: false, reasoningEffort: false,
        permissionModes: [{ id: 'ask', label: '询问', hint: '' }],
        ...(supported ? { startupSystemPrompt: true } : {})
      },
      models: []
    });
    window.uniagent = {
      homeDir: '/home/tester',
      getPersonalAssistant: async () => window.assistantDetail,
      savePersonalAssistant: async value => value,
      onAssistantChanged: () => () => {},
      getPrefs: async () => ({ lastByAgent: {} }),
      onPrefsChanged: () => () => {},
      getAssistantFeishu: async () => ({ configured: false, configuring: false, status: { phase: 'idle', connected: false } }),
      onAssistantFeishuChanged: () => () => {},
      getAssistantWeixin: async () => ({ configured: false, phase: 'idle' }),
      onAssistantWeixinChanged: () => () => {},
      pickDirectory: async () => undefined,
      listSessions: async () => []
    };
    window.assistantDetail = {
      assistant: { id: 'personal', enabled: true, defaultAgentId: 'kimi', autoReviewEnabled: false, createdAt: 1, updatedAt: 1 },
      documents: ['soul', 'working_rules', 'user', 'memory'].map(type => ({ assistantId: 'personal', type, content: '', revision: 1, updatedAt: 1, updatedBy: 'user' })),
      review: { status: 'off' }
    };
    function Harness() {
      const [agents, setAgents] = React.useState([
        agent('codex', 'Codex', true), agent('claude', 'Claude Code', true),
        agent('kimi', 'Kimi Code', false), agent('grok', 'Grok', false)
      ]);
      window.setAgentList = setAgents;
      return React.createElement(AssistantSettings, { agents, navigationGuard: { current: null } });
    }
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(Harness));
  `,
  inspect: `(async () => {
    const settle = () => new Promise(resolve => setTimeout(resolve, 40));
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 40; attempt++) { if (predicate()) return; await settle(); }
      throw new Error(document.body.innerHTML.slice(-2500));
    };
    await waitFor(() => document.querySelector('select[aria-label="默认 Agent"] option'));
    const options = () => [...document.querySelectorAll('select[aria-label="默认 Agent"] option')].map(node => node.textContent);
    const defaultOptions = options();
    const hintVisible = () => [...document.querySelectorAll('.assistant-hint')].some(node => node.textContent.includes('没有可承接个人助手'));
    const hintBefore = hintVisible();
    window.setAgentList(current => current
      .filter(a => a.id !== 'claude')
      .map(a => a.id === 'codex' ? { ...a, lifecycle: { availability: 'unavailable', auth: 'unknown', health: 'unknown' } } : a));
    await waitFor(hintVisible);
    return { defaultOptions, hintBefore, noCarrierOptions: options(), hintVisible: hintVisible() };
  })()`
})

assert.deepEqual(result.defaultOptions, ['kimi · 不可用', 'Codex', 'Claude Code'],
  'default agent select keeps only startup-system-prompt carriers, with the stale selection as an unavailable placeholder')
assert.equal(result.hintBefore, false, 'hint stays hidden while a carrier is available')
assert.deepEqual(result.noCarrierOptions, ['kimi · 不可用', 'Codex'],
  'the capability filter ignores install availability; only the hint reports it')
assert.equal(result.hintVisible, true, 'without any available carrier the settings explain the assistant is unusable')
console.log('assistant agent filter ui: ok')
