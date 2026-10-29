import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentCapabilitiesPanel, CapabilitySourceHint, canManageCapabilityItem, capabilityRemovalLabel, capabilityOwningPlugin, capabilityListItems } from '../src/renderer/components/AgentCapabilitiesPanel.tsx'
import { renderEventStream } from './regression/render-event-stream.mjs'
import type { CapabilityAgentInventory, CapabilityInventoryItem } from '../src/shared/capabilitySync.ts'

const inventory: CapabilityAgentInventory = { agentId: 'nika', available: true, writable: true, status: 'available', revision: 'fixture', items: [],
  readSources: [{ path: '/fixture/shared/skills', kind: 'skill', status: 'read' }, { path: '/fixture/private/skills', kind: 'skill', status: 'missing' },
    { path: '/fixture/plugins', kind: 'plugin', status: 'error' }] }
const hint = renderToStaticMarkup(createElement(CapabilitySourceHint, { inventory }))
assert(hint.includes('aria-label="本次读取来源"'))
assert(hint.includes('role="tooltip"'))
for (const label of ['已读取', '不存在', '读取失败', '/fixture/shared/skills', '/fixture/private/skills', '/fixture/plugins']) assert(hint.includes(label))
const id = hint.match(/aria-describedby="([^"]+)"/)![1]
assert(hint.includes(`id="${id}"`))
const item: CapabilityInventoryItem = { id: 'fixture', agentId: 'kimi', name: 'fixture', kind: 'skill', scope: 'shared', owner: 'shared', origin: 'fixture',
  fingerprint: 'a'.repeat(64), manageable: true, removal: 'link', linked: true, status: 'invalid' }
assert.equal(canManageCapabilityItem(item, false), true, 'dangling shared links are managed per item, independently of Agent write support')
assert.equal(capabilityRemovalLabel(item), '移除链接', 'shared links must not offer source deletion')
assert.equal(capabilityRemovalLabel({ ...item, linked: false, scope: 'agent' }), '删除')
assert.equal(capabilityRemovalLabel({ ...item, linked: false }), '删除')
assert.deepEqual(capabilityListItems([item, ...(['command', 'tool', 'global-instructions', 'global-preference'] as const).map(kind => ({ ...item, kind }))]), [item])
const plugin: CapabilityInventoryItem = { ...item, id: 'plugin', kind: 'plugin', scope: 'plugin', pluginId: 'fixture@local' }
const provided: CapabilityInventoryItem = { ...item, id: 'provided', scope: 'plugin', plugin: 'fixture@local' }
assert.equal(capabilityOwningPlugin(provided, [plugin]), plugin)
assert.equal(capabilityOwningPlugin(provided, [{ ...plugin, agentId: 'codex' }]), undefined, 'plugin navigation stays in the same Agent')
assert.equal(capabilityOwningPlugin(plugin, [plugin]), undefined)
const agents = [{ id: 'nika', name: 'Nika' }, { id: 'zcode', name: 'ZCode' }, { id: 'codex', name: 'Codex' }]
const panel = renderToStaticMarkup(createElement(AgentCapabilitiesPanel, { onOpenSync() {}, agents }))
assert.equal((panel.match(/aria-haspopup="listbox"/g) || []).length, 1)
assert(!panel.includes('<select '), 'the Agent menu uses application theme styles')
assert(panel.includes('data-agent-id="nika"'))
assert(panel.includes('data-agent-id="zcode"'))
assert(!panel.includes('data-agent-id="traex"'), 'choices follow the provided registered Agent catalog')
assert(!panel.includes('统一查看与管理各 Agent'))
assert(!panel.includes('排查日志'))
const logs = renderToStaticMarkup(createElement(AgentCapabilitiesPanel, { onOpenSync() {}, agents, logOnly: true, onBack() {} }))
assert(logs.includes('工具能力排查日志'))
assert(logs.includes('返回通用'))
assert(!logs.includes('跨 Agent 对比'))
console.log('agent-tools-management-ui: registered Agent selector, source tooltip, link action and general-settings log view passed')

const layout = await renderEventStream([], 'idle', 'tool-management-layout', {
  setup: `
    import {AgentCapabilitiesPanel} from './src/renderer/components/AgentCapabilitiesPanel';
    const skill = (id, scope = 'agent') => ({id:'codex:' + id,agentId:'codex',name:id,kind:'skill',scope,owner:scope === 'shared'?'shared':'user',origin:'fixture',fingerprint:'a'.repeat(64),manageable:true,removal:'skill',copyable:true,status:'available'});
    const skills = [skill('alpha'),skill('beta','shared')];
    const items = [...skills,...['command','tool','global-instructions','global-preference'].map(kind => ({...skill('hidden-'+kind),kind}))];
    window.uniagent = {onCapabilityInventoryChanged:()=>()=>{},onCapabilitySyncProgress:()=>()=>{}};
    window.uniagent.capabilityInventoryList = async () => ({inventories:[{agentId:'codex',available:true,writable:true,status:'available',revision:'fixture',items,readSources:[{path:'/fixture/skills',kind:'skill',status:'read'}]}],scannedAt:1});
    window.uniagent.capabilitySyncGetJobSnapshot = async () => ({});
    window.uniagent.capabilitySyncScan = async () => ({executionSupported:true,items:[{id:'skill:alpha',kind:'skill',name:'alpha',status:'add',selectable:true},...['global-instructions','global-preference'].map(kind => ({id:kind,kind,name:'hidden-'+kind,status:'conflict',selectable:true}))]});
    const fixture = document.body.appendChild(document.createElement('div'));
    fixture.id = 'tool-fixture';
    fixture.style.cssText='position:absolute;left:320px;top:20px;width:1000px;height:740px;display:flex';
    createRoot(fixture).render(React.createElement(AgentCapabilitiesPanel,{embedded:true,agents:[{id:'codex',name:'Codex'},{id:'traex',name:'TraeX'},{id:'nika',name:'Nika'}],onOpenSync(){}}));
  `,
  inspect: `(async () => {
    let step = 0;
    const wait = async probe => { step++;const deadline=Date.now()+5000; while(!probe()){if(Date.now()>deadline)throw new Error('Tool layout fixture timed out at step '+step);await new Promise(r=>setTimeout(r,10));} };
    const fixture = document.getElementById('tool-fixture');
    const panel = fixture.querySelector('.capability-center');
    const trigger = () => panel.querySelector('.cap-agent-trigger');
    await wait(() => panel.querySelectorAll('.capability-row').length === 2);
    const initialNames = [...panel.querySelectorAll('.capability-name')].map(el=>el.textContent);
    const total = panel.querySelector('.cap-kind-chips .cnt').textContent;
    const rect = el => {const {left,right,top,bottom,width,height}=el.getBoundingClientRect();return {left,right,top,bottom,width,height};};
    const header = {tabs:rect(panel.querySelector('.capability-view-switch')),picker:rect(trigger()),hint:rect(panel.querySelector('.cap-source-trigger'))};
    trigger().click();
    await wait(()=>trigger().getAttribute('aria-expanded')==='true' && document.activeElement?.dataset.agentId==='codex');
    const menu = panel.querySelector('.cap-agent-menu');
    const menuColor = getComputedStyle(menu).backgroundColor;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    const arrowTarget = document.activeElement.dataset.agentId;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await wait(()=>trigger().getAttribute('aria-expanded')==='false');
    const escapeFocus = document.activeElement === trigger();
    trigger().click();await wait(()=>!menu.hidden);
    menu.querySelector('[data-agent-id="nika"]').click();
    await wait(()=>trigger().textContent.includes('Nika') && menu.hidden);
    const selectedAgent = trigger().textContent;
    trigger().click();await wait(()=>!menu.hidden);
    menu.querySelector('[data-agent-id="codex"]').click();
    await wait(()=>panel.querySelectorAll('.capability-row').length===2);
    trigger().click();await wait(()=>!menu.hidden);
    document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await wait(()=>menu.hidden);
    panel.querySelector('.cap-ms-toggle').click();await wait(()=>panel.querySelector('.capability-row').getAttribute('role')==='checkbox');
    panel.querySelector('.capability-row').click();await wait(()=>panel.querySelector('.cap-ms-bar.show'));
    await new Promise(r=>setTimeout(r,220));
    const bounds=[];
    for(const width of [1000,720]){fixture.style.width=width+'px';bounds.push({panel:rect(panel),bar:rect(panel.querySelector('.cap-ms-bar'))});}
    panel.querySelector('.cap-ms-all').click();await wait(()=>panel.querySelector('.cap-ms-bar b').textContent==='已选 2 项');
    const list = panel.querySelector('.capability-list');list.style.minHeight='1600px';
    const beforeScroll=rect(panel.querySelector('.cap-ms-bar'));panel.querySelector('.settings-scroll').scrollTop=200;
    const afterScroll=rect(panel.querySelector('.cap-ms-bar'));
    list.style.minHeight='';panel.querySelector('.settings-scroll').scrollTop=0;
    [...panel.querySelectorAll('.capability-view-switch button')].find(el=>el.textContent==='跨 Agent 对比').click();
    await wait(()=>panel.querySelectorAll('.capability-compare-row').length===2);
    const compareNames=[...panel.querySelectorAll('.capability-compare-row .nm')].map(el=>el.textContent);
    const compareTotal=panel.querySelector('.cap-kind-chips .cnt').textContent;
    const picks=[...panel.querySelectorAll('.cap-agent-trigger')].map(rect);
    const arrow=rect(panel.querySelector('.cmp-arrow'));
    const caret=rect(panel.querySelectorAll('.cap-agent-trigger')[1].lastElementChild);
    return {initialNames,total,header,menuColor,arrowTarget,escapeFocus,selectedAgent,bounds,beforeScroll,afterScroll,compareNames,compareTotal,picks,arrow,caret};
  })()`
})
assert.deepEqual(layout.initialNames, ['alpha', 'beta'])
assert.equal(layout.total, '2')
assert.equal(layout.compareTotal, '2')
assert.deepEqual(layout.compareNames, ['alpha', 'beta'])
assert.equal(layout.arrowTarget, 'traex')
assert.equal(layout.escapeFocus, true)
assert(layout.selectedAgent.includes('Nika'))
assert.notEqual(layout.menuColor, 'rgba(0, 0, 0, 0)')
assert(Math.abs((layout.header.tabs.top + layout.header.tabs.bottom - layout.header.picker.top - layout.header.picker.bottom) / 2) < 5)
assert(layout.header.hint.left - layout.header.picker.right <= 8)
for (const {panel, bar} of layout.bounds) {
  assert(bar.left >= panel.left && bar.right <= panel.right, 'batch actions stay inside the content panel')
  assert(Math.abs((bar.left + bar.right - panel.left - panel.right) / 2) < 1, 'batch actions center on the content panel')
}
assert.deepEqual(layout.beforeScroll, layout.afterScroll, 'scrolling the list does not move batch actions')
assert(layout.arrow.left - layout.picks[0].right <= 14)
assert(layout.picks[1].left - layout.arrow.right <= 14)
assert(Math.abs((layout.picks[1].top + layout.picks[1].bottom - layout.caret.top - layout.caret.bottom) / 2) < 1)
console.log('agent-tools-management-ui: themed selection, keyboard, panel-contained batch actions, compact comparison and hidden types passed')
