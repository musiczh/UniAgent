import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { McpCapabilityDetail } from '../src/renderer/components/McpCapabilityDetail.tsx'
import { renderEventStream } from './regression/render-event-stream.mjs'

const unsupported = renderToStaticMarkup(createElement(McpCapabilityDetail, { detail: { id: 'fixture', name: 'reader', kind: 'mcp', openable: false }, loading: false, onReadTools() {} }))
assert(unsupported.includes('当前 Agent 尚未提供可读取的工具定义'))
assert(!unsupported.includes('data-mcp-read-tools'))

const result = await renderEventStream([], 'idle', 'mcp-capability-detail', {
  setup: `
    import {AgentCapabilitiesPanel} from './src/renderer/components/AgentCapabilitiesPanel';
    document.getElementById('root').style.display='none';
    const items=['reader','other'].map(name=>({id:'codex:'+name,agentId:'codex',name,kind:'mcp',scope:'agent',owner:'user',origin:'fixture',fingerprint:'a'.repeat(64),manageable:true,copyable:false,status:'available'}));
    const detail=id=>({id,name:id.split(':')[1],kind:'mcp',openable:false,manifestFile:'config.toml',manifestText:JSON.stringify({command:'uvx',enabled_tools:['read_article','setup'],default_tools_approval_mode:'prompt'}),mcp:{catalogSupported:true}});
    const catalog={status:'loaded',serverName:'Reader MCP Server',version:'1.0.0',connectionStatus:'connected',tools:[{name:'read_article',description:'Read an article and extract its content.',parameters:[{name:'url',type:'string',description:'Article URL.',required:true}]}]};
    window.__reads=0;
    window.uniagent={onCapabilityInventoryChanged:()=>()=>{},onCapabilitySyncProgress:()=>()=>{},capabilitySyncGetJobSnapshot:async()=>({}),capabilityInventoryList:async()=>({inventories:[{agentId:'codex',available:true,writable:true,status:'available',revision:'fixture',items}],scannedAt:1}),
      capabilityInventoryDetail:async(id,read)=>{const value=detail(id);if(read){window.__reads++;if(window.__defer)await new Promise(resolve=>window.__resolve=resolve);value.mcp.catalog=window.__fail?{status:'failed',tools:[]}:catalog;}return value;}
    };
    const fixture=document.body.appendChild(document.createElement('div'));fixture.id='mcp-fixture';fixture.className='settings-inner';fixture.style.cssText='position:fixed;inset:0;display:flex';
    createRoot(fixture).render(React.createElement(AgentCapabilitiesPanel,{embedded:true,agents:[{id:'codex',name:'Codex'}],onOpenSync(){}}));
  `,
  inspect: `(async()=>{
    const wait=async probe=>{const until=Date.now()+5000;while(!probe()){if(Date.now()>until)throw Error('MCP fixture timed out');await new Promise(r=>setTimeout(r,10));}};
    const fixture=document.getElementById('mcp-fixture');const open=name=>[...fixture.querySelectorAll('.capability-row')].find(row=>row.querySelector('.cap-nm').textContent===name).click();
    await wait(()=>fixture.querySelectorAll('.capability-row').length===2);open('reader');await wait(()=>fixture.querySelector('[data-mcp-read-tools]'));
    const initial={reads:window.__reads,rawCollapsed:!fixture.querySelector('.cd-mcp-config').open,text:fixture.querySelector('.cap-detail').textContent};
    fixture.querySelector('[data-mcp-read-tools]').click();await wait(()=>fixture.querySelector('.cd-mcp-summary').textContent.includes('1.0.0'));
    fixture.querySelector('.cd-mcp-tool summary').click();await wait(()=>fixture.querySelector('.cd-mcp-tool').open);
    const loaded=fixture.querySelector('.cd-body').textContent;
    window.__fail=true;fixture.querySelector('[data-mcp-read-tools]').click();await wait(()=>fixture.querySelector('.cd-mcp-error'));
    const failure=fixture.querySelector('.cd-mcp-content').textContent;
    window.__fail=false;window.__defer=true;fixture.querySelector('[data-mcp-read-tools]').click();await wait(()=>window.__resolve);
    fixture.querySelector('.cd-x').click();open('other');await wait(()=>fixture.querySelector('.cd-name')?.textContent==='other'&&!fixture.querySelector('.panel-loading'));
    window.__resolve();await new Promise(r=>setTimeout(r,50));
    return {initial,loaded,failure,latestName:fixture.querySelector('.cd-name').textContent,staleIgnored:!fixture.querySelector('.cd-body').textContent.includes('Reader MCP Server'),newReadEnabled:!fixture.querySelector('[data-mcp-read-tools]').disabled};
  })()`
})
assert.equal(result.initial.reads, 0)
assert.equal(result.initial.rawCollapsed, true)
for (const text of ['已配置', 'stdio', 'uvx', '每次询问', '配置允许 2']) assert(result.initial.text.includes(text))
for (const text of ['Reader MCP Server', '1.0.0', '已连接', 'Read an article', 'url', '必填', 'Article URL.']) assert(result.loaded.includes(text))
for (const text of ['读取失败', 'read_article', 'setup']) assert(result.failure.includes(text))
assert.equal(result.latestName, 'other')
assert.equal(result.staleIgnored, true)
assert.equal(result.newReadEnabled, true)
console.log('mcp-capability-detail-ui: connection summary, lazy discovery, parameter expansion, fallback and stale replies passed')
