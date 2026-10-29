import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'quota-fixture', {
  setup: `
    import {QuotaHoverButton} from './src/renderer/components/QuotaHoverButton';
    window.quotaErrors = [];
    window.addEventListener('error', event => window.quotaErrors.push(event.message));
    const agent = (id, extra = {}) => ({
      id, name: id === 'kimi' ? 'Kimi Code' : id === 'grok' ? 'Grok' : id === 'codex' ? 'Codex' : id,
      adapter:id, bin:id, icon:id, installed:true, lifecycle:{availability:'available'}, ...extra
    });
    const agents = [agent('codex'), agent('kimi'), agent('grok'), agent('disabled'),
      agent('uninstalled',{installed:false}), agent('unavailable',{lifecycle:{availability:'unavailable'}})];
    const enabled = ['codex','kimi','grok','uninstalled','unavailable'];
    const quota = (usedPercent, label = '5 小时额度') => ({status:'ready',kind:'windows',capturedAt:1000,windows:[{label,usedPercent}]});
    window.quotaCalls = [];
    window.sourceCalls = [];
    window.uniagent = {
      onCodexRateLimits: () => () => {}, onClaudeRateLimits: () => () => {},
      getAgentQuota: async (id, force) => {
        window.quotaCalls.push({id,force});
        const used = force ? {codex:22,kimi:85,grok:12} : {codex:100,kimi:30,grok:0};
        return {agentId:id,...quota(used[id])};
      },
      getCodexSources: async () => {
        window.sourceCalls.push('get');
        return {enabled:true,sources:[{id:'kimi',preset:'kimi-code',enabled:true,hasKey:true,quota:quota(90,'接入商额度')}]};
      },
      onCodexSourcesChanged: () => {window.sourceCalls.push('subscribe'); return () => {};},
      refreshCodexSourceQuotas: async () => {window.sourceCalls.push('refresh');return {enabled:true,sources:[]};}
    };
    function QuotaHarness() {
      const [enabledAgentIds,setEnabled] = React.useState(enabled);
      window.setQuotaEnabled = setEnabled;
      return React.createElement(QuotaHoverButton,{agents,enabledAgentIds});
    }
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(QuotaHarness));
  `,
  inspect: `(async () => {
    const settle = () => new Promise(resolve => setTimeout(resolve,40));
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (predicate()) return;
        await settle();
      }
      throw new Error(JSON.stringify({errors:window.quotaErrors,calls:window.quotaCalls,html:document.body.innerHTML.slice(-2500)}));
    };
    const names = () => [...document.querySelectorAll('.qp-vendor-name')].map(node => node.textContent);
    const windows = () => [...document.querySelectorAll('.quota-win')].map(node => ({
      remaining:node.querySelector('.quota-remain').textContent,
      width:node.querySelector('.quota-bar > i').style.width,
      tone:node.classList.contains('danger') ? 'danger' : node.classList.contains('warn') ? 'warn' : 'normal'
    }));
    await waitFor(() => document.querySelector('.quota-entry'));
    document.querySelector('.quota-entry').click();
    await waitFor(() => document.querySelector('.quota-pop') && window.quotaCalls.length >= 3 && names().length >= 3 && !document.querySelector('.qp-refresh').disabled);
    const initial = {names:names(),text:document.querySelector('.quota-pop').textContent,windows:windows(),
      calls:[...window.quotaCalls],sourceCalls:[...window.sourceCalls]};
    document.querySelector('.qp-refresh').click();
    await waitFor(() => window.quotaCalls.filter(call=>call.force).length >= 3 && windows()[0]?.remaining === '剩余 78%');
    const refresh = {calls:window.quotaCalls.filter(call=>call.force),sourceCalls:[...window.sourceCalls],windows:windows()};
    window.setQuotaEnabled(['codex','grok']); await settle();
    const disabled = names();
    return {initial,refresh,disabled};
  })()`
})

assert.deepEqual(result.initial.names, ['Codex', 'Kimi Code', 'Grok'], 'only enabled and available Agents appear, with one Kimi account card')
assert.deepEqual(result.initial.calls.map((call: { id: string }) => call.id), ['codex', 'kimi', 'grok'])
assert.match(result.initial.text, /剩余 0%/, 'an exhausted account remains visible')
assert.match(result.initial.text, /剩余 100%/, 'a reset Grok account remains visible')
assert.deepEqual(result.initial.windows, [
  { remaining:'剩余 0%', width:'0%', tone:'danger' },
  { remaining:'剩余 70%', width:'70%', tone:'normal' },
  { remaining:'剩余 100%', width:'100%', tone:'normal' }
], 'bars show remaining allowance, including empty and full accounts')
assert.doesNotMatch(result.initial.text, /接入商/)
assert.deepEqual(result.initial.sourceCalls, [], 'the popover must not query or subscribe to Codex source quotas')
assert.deepEqual(result.refresh.calls.map((call: { id: string }) => call.id), ['codex', 'kimi', 'grok'])
assert.deepEqual(result.refresh.sourceCalls, [], 'refresh only queries Agent accounts')
assert.deepEqual(result.refresh.windows, [
  { remaining:'剩余 78%', width:'78%', tone:'normal' },
  { remaining:'剩余 15%', width:'15%', tone:'warn' },
  { remaining:'剩余 88%', width:'88%', tone:'normal' }
], 'refresh updates bar widths to remaining allowance and preserves low-quota warnings')
assert.deepEqual(result.disabled, ['Codex', 'Grok'], 'disabling an Agent removes its cached card')
console.log('agent-quota-ui: Agent-only cards, query scope, remaining bars, refresh and zero/full boundaries passed')
