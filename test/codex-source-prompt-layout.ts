import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'source-prompt-layout', {
  setup: `
    import {CodexSourceSettings} from './src/renderer/components/CodexSourceSettings';
    window.uniagent = new Proxy({
      listModelCredentials: async () => [],
      getCodexSources: async () => ({phase:'stopped', enabled:false, sources:[], quotaRefreshing:false})
    }, {get:(target,key)=>target[key] || (String(key).startsWith('on') ? () => () => {} : async () => null)});
    const settings = document.body.appendChild(document.createElement('div'));
    settings.className = 'settings-inner';
    createRoot(settings).render(React.createElement(CodexSourceSettings, {
      onModelsChanged:async()=>{}, navigationGuard:{current:null}
    }));
  `,
  inspect: `(async () => {
    let trigger;
    for (let i=0;i<100;i++) {
      trigger = [...document.querySelectorAll('button')].find(button=>button.textContent==='启动服务');
      if (trigger) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    if (!trigger) throw new Error('启动服务按钮未出现');
    const dialog = document.querySelector('.codex-source-prompt');
    const measure = () => {
      const rect = dialog.getBoundingClientRect();
      return {open:dialog.open, horizontalOffset:rect.x+rect.width/2-innerWidth/2,
        verticalOffset:rect.y+rect.height/2-innerHeight/2};
    };
    const initiallyClosed = !dialog.open;
    trigger.click();
    const normal = measure();
    dialog.querySelector('p').textContent = dialog.querySelector('p').textContent.repeat(5);
    const multiline = measure();
    dialog.querySelector('button').click();
    const acknowledged = !dialog.open;
    trigger.click();
    return {initiallyClosed, normal, multiline, acknowledged, reopened:measure()};
  })()`
})

assert.equal(result.initiallyClosed, true, 'the configuration prompt starts closed')
for (const [state, position] of Object.entries({ normal: result.normal, multiline: result.multiline, reopened: result.reopened })) {
  assert.equal(position.open, true, `${state}: the start-service action opens the prompt`)
  assert.ok(Math.abs(position.horizontalOffset) <= 1, `${state}: prompt is horizontally centered, offset=${position.horizontalOffset}`)
  assert.ok(Math.abs(position.verticalOffset) <= 1, `${state}: prompt is vertically centered, offset=${position.verticalOffset}`)
}
assert.equal(result.acknowledged, true, 'acknowledging the prompt closes it')
console.log('codex source prompt: centered before and after text wrapping and reopening')
