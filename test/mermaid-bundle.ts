import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { renderEventStream } from './regression/render-event-stream.mjs'

// The screenshot's actual diagram; keep Chinese labels, branches and cycles.
const source = `flowchart TD
    A["用户提交输入"] --> B{"提交入口"}
    B -->|"已有任务对话"| C["原任务输入链路"]
    B -->|"手动选择归属"| D["原任务创建链路"]
    B -->|"自动归属 / Router 页面"| E["持久登记 RouterRequest"]

    E --> F["FIFO：进入固定 Router Session"]
    F --> G["模型调用 router_query"]
    G --> H["读取事实源，更新索引，召回候选与记忆"]
    H --> I["模型调用 router_assign_task"]
    I --> J["宿主校验版本、范围、状态与配置"]

    J -->|"需要补充或选择"| K["needs_input：显示决策卡"]
    K -->|"补充目标"| F
    K -->|"确认执行配置"| J

    J -->|"复用任务"| L["acceptRoutedInput：加入原任务队列"]
    J -->|"新建任务 / 需求"| M["TaskCreation：固定身份创建"]
    M --> L
    L --> C

    C --> N["实际业务 Agent 执行"]
    N --> O["流式事件、输入回执、任务状态"]
    O --> P["Router 分配卡与任务界面更新"]`
const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: [require.resolve('mermaid')], bundle: true, write: false,
  platform: 'browser', format: 'esm', minify: true,
})
const requests = new Map<string, number>()
// A real failed dynamic import followed by the real Mermaid library, not a
// mocked render function. No installed App or account is accessed.
const server = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://fixture').pathname
  const count = (requests.get(path) || 0) + 1
  requests.set(path, count)
  response.writeHead(count === 1 ? 503 : 200, {
    'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
  })
  response.end(count === 1 ? 'temporarily unavailable' : bundle.outputFiles[0].text)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const moduleFixture = (path: string) => [{ name: 'mermaid-module-fixture', setup(builder) {
  builder.onResolve({ filter: /^virtual:uniagent-mermaid-runtime-url$/ }, () => ({
    path: 'mermaid-url', namespace: 'mermaid-url',
  }))
  builder.onLoad({ filter: /.*/, namespace: 'mermaid-url' }, () => ({
    contents: `export default ${JSON.stringify(`http://127.0.0.1:${address.port}${path}`)}`,
  }))
} }]

try {
  const ordinary = await renderEventStream([{
    sessionId: 'ordinary-code', seq: 1, ts: 1, type: 'agent_message', state: 'success',
    payload: { text: '```text\nflowchart TD\n A --> B\n```' },
  }], 'idle', 'ordinary-code', {
    buildPlugins: moduleFixture('/ordinary.mjs'),
    inspect: `({code:document.querySelector('[data-streamdown="code-block"][data-language="text"] code')?.innerText,image:!!document.querySelector('.md-mermaid img')})`,
  })
  assert.equal(ordinary.code, 'flowchart TD\n A --> B')
  assert.equal(ordinary.image, false)
  assert.equal(requests.size, 0, 'ordinary Markdown must not load the diagram runtime')
  for (const recovery of ['source', 'retry']) {
    const path = `/${recovery}.mjs`
    const result = await renderEventStream([], 'idle', `mermaid-${recovery}`, {
      buildPlugins: moduleFixture(path),
      setup: `
        import {Markdown} from './src/renderer/components/Markdown';
        const host=document.body.appendChild(document.createElement('div'));
        host.style.cssText='width:720px';
        const root=createRoot(host), errors=[];
        let renderStarts=0;
        new MutationObserver(records=>{
          for(const record of records)for(const node of record.addedNodes)
            if(node instanceof Element&&node.id.startsWith('dua-mermaid-'))renderStarts++;
        }).observe(document.body,{childList:true,subtree:true});
        window.addEventListener('error',e=>errors.push(e.message));
        window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
        const source=${JSON.stringify(source)};
        const mount=text=>root.render(React.createElement(Markdown,{text:'\u0060\u0060\u0060mermaid\\n'+text+'\\n\u0060\u0060\u0060'}));
        mount(source);
        window.fixture={host,source,mount,errors,renderStarts:()=>renderStarts};
      `,
      inspect: `(async()=>{
        const f=window.fixture, tick=()=>new Promise(r=>setTimeout(r,30));
        const wait=async p=>{for(let i=0;i<200;i++){if(p())return true;await tick()}return false};
        const image=()=>f.host.querySelector('.md-mermaid img');
        const ready=()=>image()?.complete&&image()?.naturalWidth>0;
        await wait(()=>f.host.querySelector('[role=alert]'));
        const failed={title:f.host.querySelector('[role=alert] strong')?.textContent,
          source:f.host.querySelector('pre code')?.textContent,
          retry:!!f.host.querySelector('[role=alert] button')};
        if(${JSON.stringify(recovery)}==='source') f.mount(f.source+'\\n%% latest source');
        else f.host.querySelector('[role=alert] button')?.click();
        const recovered=await wait(ready);
        if(!recovered)return {failed,recovered,after:f.host.querySelector('[role=alert]')?.textContent,errors:f.errors};
        const svg=new DOMParser().parseFromString(decodeURIComponent(image().src.split(',').slice(1).join(',')),'image/svg+xml');
        const rendered={width:image().naturalWidth,height:image().naturalHeight,text:svg.documentElement.textContent,
          unsafe:!!svg.querySelector('script,foreignObject'),alert:!!f.host.querySelector('[role=alert]')};
        f.mount('flowchart TD\\n A[broken');
        await wait(()=>f.host.querySelector('[role=alert]'));
        const syntax={title:f.host.querySelector('[role=alert] strong')?.textContent,
          detail:f.host.querySelector('[role=alert] p')?.textContent,
          source:f.host.querySelector('pre code')?.textContent};
        const beforeRetry=f.renderStarts();
        f.host.querySelector('[role=alert] button')?.click();
        const syntaxRetried=await wait(()=>f.renderStarts()>beforeRetry&&f.host.querySelector('[role=alert]'));
        const syntaxRetry=f.host.querySelector('[role=alert] strong')?.textContent;
        f.mount('flowchart TD\\n A["恢复后的最新图"] --> B["完成"]');
        const corrected=await wait(ready);
        const correctedSvg=corrected?decodeURIComponent(image().src.split(',').slice(1).join(',')):'';
        f.mount('flowchart TD\\n OLD[旧图] --> END[旧结果]');
        f.mount('flowchart TD\\n NEW[最新图] --> END[新结果]');
        await wait(()=>ready()&&decodeURIComponent(image().src.split(',').slice(1).join(',')).includes('新结果'));
        const latestSvg=decodeURIComponent(image().src.split(',').slice(1).join(','));
        return {failed,recovered,rendered,syntax,syntaxRetried,syntaxRetry,corrected,correctedSvg,latestSvg,errors:f.errors};
      })()`,
    })
    assert.equal(result.recovered, true, `${recovery}: failed initial module recovery; requests=${requests.get(path)}; after=${result.after}`)
    assert.equal(requests.get(path), 2, `${recovery}: retry loads the module again; later syntax errors reuse the loaded library`)
    assert.equal(result.failed.title, '图表组件加载失败')
    assert.equal(result.failed.source, source + '\n')
    assert.equal(result.failed.retry, true)
    assert.ok(result.rendered.width > 0 && result.rendered.height > 0)
    assert.match(result.rendered.text, /用户提交输入/)
    assert.match(result.rendered.text, /Router 分配卡与任务界面更新/)
    assert.equal(result.rendered.unsafe, false)
    assert.equal(result.rendered.alert, false)
    assert.equal(result.syntax.title, '图表渲染失败')
    assert.match(result.syntax.detail, /Parse error/)
    assert.equal(result.syntax.source, 'flowchart TD\n A[broken\n')
    assert.equal(result.syntaxRetried, true, 'retry must perform another real render before showing the syntax error again')
    assert.equal(result.syntaxRetry, '图表渲染失败')
    assert.equal(result.corrected, true)
    assert.match(result.correctedSvg, /恢复后的最新图/)
    assert.match(result.latestSvg, /最新图/)
    assert.match(result.latestSvg, /新结果/)
    assert.doesNotMatch(result.latestSvg, /旧结果|恢复后的最新图/)
    assert.deepEqual(result.errors, [])
  }
  const local = await renderEventStream([{
    sessionId: 'local-mermaid', seq: 1, ts: 1, type: 'agent_message', state: 'success',
    payload: { text: '```mermaid\n' + source + '\n```' },
  }], 'idle', 'local-mermaid', {
    // Cold file-module loading can take over nine seconds under the release
    // runner. Keep the image and complete-diagram assertions after that load.
    inspect: `(async()=>{const deadline=performance.now()+15000;while(performance.now()<deadline){
      const img=document.querySelector('.md-mermaid img');
      if(img?.complete&&img.naturalWidth>0)return {width:img.naturalWidth,height:img.naturalHeight};
      await new Promise(r=>setTimeout(r,30));
    }return {error:document.body.textContent,html:document.body.innerHTML.slice(0,16000),
      errors:window.__fixtureErrors,resources:performance.getEntriesByType('resource').map(r=>({name:r.name,duration:r.duration}))}})()`,
  })
  assert.ok(local.width > 0 && local.height > 0, 'file:// modules with attempt query parameters render the complete diagram: ' + JSON.stringify(local))
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
console.log('mermaid: actual module failure, retry/source recovery, full screenshot diagram, syntax errors and latest source passed')
