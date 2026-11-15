import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'

// Execute the registered read handler: opening local-model settings must not
// re-probe every Agent as a side effect of reading the current model state.
const source = readFileSync('src/main/index.ts', 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let handler: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' &&
      node.arguments[0]?.getText(ast) === 'LOCAL_MODEL_IPC.get') handler = node.arguments[1]
  ts.forEachChild(node, visit)
}
visit(ast)
if (INTERNAL_DISTRIBUTION) {
  assert.ok(handler)
  const reads = { models: 0, probes: 0 }
  const snapshot = { availability: 'ready', models: [] }
  const readLocalModels = vm.runInNewContext(ts.transpile(`(${handler.getText(ast)})`, {
    target: ts.ScriptTarget.ES2022
  }), {
    assertTrustedCapabilitySyncIpc: () => {}, startupCoreReady: Promise.resolve(),
    localModels: { start: async () => { reads.models++; return snapshot } },
    refreshDetectedAgents: async () => { reads.probes++ }, recordRuntime: () => {}
  })
  for (let entry = 0; entry < 3; entry++) assert.equal(await readLocalModels({}), snapshot)
  assert.equal(reads.models, 3)
  assert.equal(reads.probes, 0, 'reading local-model settings must not start full Agent detection')
} else {
  assert.equal(handler, undefined, 'the public distribution has no internal local-model IPC handler')
}

const result = await renderEventStream([], 'idle', 'settings-refresh', {
  setup: `
    const noop = () => {};
    const timers = new Map();
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    let nextTimer = -1;
    window.setInterval = (callback, delay, ...args) => {
      if (![30000, 600000].includes(delay)) return nativeSetInterval(callback, delay, ...args);
      const id = nextTimer--; timers.set(id, {callback, delay}); return id;
    };
    window.clearInterval = id => { if (!timers.delete(id)) nativeClearInterval(id); };
    const agent = (id, availability) => ({id, name:id, adapter:id, installed:true, bin:'/fixture/'+id,
      models:[], builtin:true, capabilities:{permissionModes:[]}, lifecycle:{availability}});
    let agents = [agent('codex','available'), agent('grok','needs-auth')];
    let lifecycleListener = noop, finish;
    const calls = {full:0, single:[]};
    const methods = {
      homeDir:'/fixture', startupState:async()=>({ready:true}),
      teamCatalog:async()=>({teams:[],projects:[],errors:[]}),
      getLifecycleSnapshot:async()=>agents,
      detectAgents:async()=>{calls.full++;return agents},
      detectAgent:id=>{calls.single.push(id);return new Promise(resolve=>{finish=()=>{
        agents=agents.map(item=>agent(item.id,'available'));
        lifecycleListener({agentId:id,phase:'completed',message:'ready'});
        resolve(agents.find(item=>item.id===id));
      }})},
      onLifecycleProgress:callback=>{lifecycleListener=callback;return noop},
      getAppSettings:async()=>({enabledAgentIds:['codex','grok'],autoCheckUpdate:false}),
      getPrefs:async()=>({lastByAgent:{}}),getAppVersion:async()=>'1.1.0',
      listSessions:async()=>[],getAssistantPrivateSessions:async()=>[],
      getSessionAttention:async()=>({revision:1,unreadBySession:{}}),
      listQueues:async()=>({}),e2eEnabled:async()=>false,
      getWorktreeArchiveReviews:async()=>[]
    };
    window.uniagent=new Proxy(methods,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>noop:async()=>String(key).startsWith('list')?[]:null});
    window.fixture={calls,timers,finish:()=>finish()};
    window.appReady=import('./src/renderer/App').then(({App})=>{
      const root=createRoot(document.body.appendChild(document.createElement('div')));
      root.render(React.createElement(App));window.unmountApp=()=>root.unmount();
    });
  `,
  inspect: `(async()=>{
    await window.appReady;
    const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('settings refresh timeout: '+document.body.innerText.slice(-1000))};
    const timer=delay=>[...window.fixture.timers.values()].find(item=>item.delay===delay);
    const click=(selector,text)=>{const button=[...document.querySelectorAll(selector)].find(item=>!text||item.textContent.trim()===text);if(!button)throw Error('missing '+selector+' '+text);button.click()};
    await wait(()=>document.querySelector('.settings-entry')&&!document.querySelector('.app-startup-blocker')&&timer(30000));
    for(let entry=0;entry<3;entry++){
      click('.settings-entry');await wait(()=>document.querySelector('.set-nav'));
      click('.set-nav-item','Agent');await wait(()=>document.querySelector('[aria-label="查看 codex 详情"]'));
      click('.settings-back');await wait(()=>!document.querySelector('.set-nav'));
    }
    const entryChecks={full:window.fixture.calls.full,single:[...window.fixture.calls.single]};
    click('.settings-entry');await wait(()=>document.querySelector('.set-nav'));
    click('.set-nav-item','Agent');await wait(()=>document.querySelector('[aria-label="查看 codex 详情"]'));
    timer(30000).callback();await wait(()=>window.fixture.calls.single.length>0||window.fixture.calls.full>0);
    const fastChecks={full:window.fixture.calls.full,single:[...window.fixture.calls.single]};
    if(fastChecks.full||fastChecks.single.join()!=='grok')throw Error('anomaly retry unexpectedly detected all Agents: '+JSON.stringify(fastChecks));
    timer(30000).callback();
    const noDuplicate=window.fixture.calls.single.length===1;
    const readyAgentUnaffected=!document.querySelector('[aria-label="查看 codex 详情"]').closest('.settings-agent-row').textContent.includes('检测中');
    window.fixture.finish();await wait(()=>!timer(30000));
    timer(600000).callback();await wait(()=>window.fixture.calls.full>fastChecks.full);
    const periodicChecks=window.fixture.calls.full-fastChecks.full;
    await wait(()=>!document.querySelector('.settings-agent-row[aria-busy="true"]'));
    click('.set-page:not([hidden]) .set-mini-btn','重新探测');
    await wait(()=>window.fixture.calls.full===fastChecks.full+2);
    const manualChecks=window.fixture.calls.full-fastChecks.full-periodicChecks;
    window.unmountApp();
    return {entryChecks,fastChecks,noDuplicate,readyAgentUnaffected,periodicChecks,manualChecks,timersAfterUnmount:window.fixture.timers.size,errors:window.__fixtureErrors};
  })()`
})
assert.deepEqual(result.entryChecks, { full: 0, single: [] }, 'opening and leaving settings must reuse the detected Agent state')
assert.deepEqual(result.fastChecks, { full: 0, single: ['grok'] }, 'only the anomalous Agent is rechecked')
assert.equal(result.noDuplicate, true, 'an in-flight retry must not be queued again')
assert.equal(result.readyAgentUnaffected, true)
assert.equal(result.periodicChecks, 1, 'full background detection remains on the ten-minute interval')
assert.equal(result.manualChecks, 1, 'explicit detection still refreshes all Agents immediately')
assert.equal(result.timersAfterUnmount, 0)
assert.deepEqual(result.errors, [])
console.log('Settings refresh: entry reads avoid full detection, anomaly retries stay scoped, periodic detection and cleanup passed')
