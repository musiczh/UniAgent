import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const results = await renderEventStream([], 'idle', 'token-refresh-layout', {
  setup: `
    import {TokenUsagePanel} from './src/renderer/components/TokenUsagePanel';
    localStorage.clear();
    localStorage.setItem('uniagent.tokenUsage.source', 'native');
    window.__usageRequests = [];
    window.uniagent = {
      getNativeTokenUsage: query => new Promise(resolve => window.__usageRequests.push({query, resolve})),
      refreshNativeTokenUsage: async () => {},
      logTokenUsage: async () => {}
    };
    window.__finishUsage = () => {
      const {query, resolve} = window.__usageRequests.shift();
      resolve({range:query.period, stats:{tokens:42,cost:0,sessions:1,hours:0,codeLines:0,
        inputTokens:42,outputTokens:0,cachedTokens:0,reasoningTokens:0}, heatmap:[],dailyTrend:[],
        toolBreakdown:[],modelBreakdown:[],skillBreakdown:[],projectBreakdown:[],mcpBreakdown:[]});
    };
    const fixture = document.body.appendChild(document.createElement('div'));
    fixture.id = 'token-fixture';
    fixture.style.cssText = 'position:absolute;left:0;top:0;width:1280px;height:800px;display:flex';
    createRoot(fixture).render(React.createElement(TokenUsagePanel));
  `,
  inspect: `(async () => {
    const wait = async probe => {
      const deadline = Date.now() + 5000;
      while (!probe()) {
        if (Date.now() > deadline) throw new Error('Token refresh fixture timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const fixture = document.getElementById('token-fixture');
    const button = () => fixture.querySelector('button[aria-label="刷新 Token 用量"]');
    await wait(() => window.__usageRequests.length === 1 && button());
    window.__finishUsage();
    await wait(() => button().getAttribute('aria-busy') === 'false');
    const actions = fixture.querySelector('.token-usage-actions');
    if (actions.firstElementChild !== button()) throw new Error('刷新按钮必须位于数据来源切换控件左侧');
    const measure = () => [fixture.querySelector('.token-usage-head'), ...actions.children].map(node => {
      const {x,y,width,height} = node.getBoundingClientRect();
      return {x,y,width,height};
    });
    const results = [];
    for (const width of [1280, 920, 480]) {
      fixture.style.width = width + 'px';
      const idle = measure();
      button().click();
      await wait(() => button().textContent === '刷新中' && window.__usageRequests.length === 1);
      const busy = measure();
      const spinner = button().querySelector('.loading-spinner');
      const style = spinner && getComputedStyle(spinner);
      const spinnerVisible = !!spinner && spinner.getBoundingClientRect().width > 0;
      const spinnerAnimated = style?.animationName === 'ua-spin' && style.animationPlayState === 'running';
      const cacheRetained = !!fixture.querySelector('.token-usage-body');
      button().click();
      const duplicateBlocked = button().disabled && window.__usageRequests.length === 1;
      window.__finishUsage();
      await wait(() => button().textContent === '刷新' && !button().disabled);
      results.push({width,idle,busy,done:measure(),spinnerVisible,spinnerAnimated,cacheRetained,duplicateBlocked});
    }
    return results;
  })()`
})

assert.equal(results.length, 3)
for (const result of results) {
  assert.deepEqual(result.busy, result.idle, `${result.width}px：刷新状态不能改变按钮或周围控件的布局`)
  assert.deepEqual(result.done, result.idle, `${result.width}px：刷新完成后布局必须保持一致`)
  assert.equal(result.spinnerVisible, true, '刷新中文字旁必须显示 loading 图标')
  assert.equal(result.spinnerAnimated, true, 'loading 图标必须使用旋转动画')
  assert.equal(result.cacheRetained, true, '刷新中应持续显示已有数据')
  assert.equal(result.duplicateBlocked, true, '刷新中重复点击不能再发起请求')
}
console.log('token usage refresh: button order, loading text/icon, stable layout at 1280/920/480px and duplicate clicks passed')
