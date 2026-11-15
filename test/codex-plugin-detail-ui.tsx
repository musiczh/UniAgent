import assert from 'node:assert/strict'
import { capabilityListItems, betaCapabilityStateRequest } from '../src/renderer/components/AgentCapabilitiesPanel.tsx'
import type { CapabilityInventoryItem } from '../src/shared/capabilitySync.ts'
import { renderEventStream } from './regression/render-event-stream.mjs'

const plugin: CapabilityInventoryItem = { id: 'codex:plugin:fixture', agentId: 'codex', name: 'Design', kind: 'plugin', scope: 'plugin', owner: 'plugin',
  origin: 'local', status: 'available', manageable: true, copyable: false, fingerprint: 'a'.repeat(64), stateManageable: true, enabled: false }
assert.deepEqual(betaCapabilityStateRequest(plugin, true), { agentId: 'codex', action: 'plugin-enable', id: plugin.id, expectedFingerprint: plugin.fingerprint })
assert.equal(betaCapabilityStateRequest({ ...plugin, stateManageable: false }, true), undefined)
assert.deepEqual(capabilityListItems([plugin, { ...plugin, id: 'scan', issueCode: 'plugin_enumeration_failed' }]), [plugin], 'scan diagnostics must not count as installed plugins')

const result = await renderEventStream([], 'idle', 'codex-plugin-detail', {
  setup: `
    import {AgentCapabilitiesPanel} from './src/renderer/components/AgentCapabilitiesPanel';
    document.getElementById('root').style.display='none';
    const plugin=${JSON.stringify(plugin)};
    const skill={...plugin,id:'codex:skill:fixture',name:'design-to-code',kind:'skill',description:'Convert designs into production code.',manageable:false,plugin:'design@local',readOnlyReason:'随所属插件启用和卸载。'};
    plugin.pluginId='design@local';plugin.version='1.0.0';plugin.components={skills:1,mcps:1,apps:0,hooks:0,models:0,commands:0};
    window.__managementCalls=[];
    const inventory=()=>({agentId:'codex',available:true,writable:true,status:'available',revision:'fixture',items:[plugin]});
    window.uniagent={onCapabilityInventoryChanged:()=>()=>{},onCapabilitySyncProgress:()=>()=>{},capabilitySyncGetJobSnapshot:async()=>({}),
      capabilityInventoryList:async()=>({inventories:[inventory()],scannedAt:1}),
      capabilityInventoryDetail:async id=>id===plugin.id?{id,name:plugin.name,kind:'plugin',openable:false,plugin:{author:'Design, Inc.',shortDescription:'Create designs, ship code',description:'Bring your design workflow into Codex.',skills:[skill]}}:{id,name:skill.name,kind:'skill',openable:false,manifestText:'# Design instructions'},
      capabilityInventoryManage:async request=>{window.__managementCalls.push(request);if(window.__failWrite)throw Error('capability_inventory_manage_failed');plugin.enabled=request.action==='plugin-enable';plugin.fingerprint=(plugin.enabled?'b':'a').repeat(64);return inventory();}
    };
    const fixture=document.body.appendChild(document.createElement('div'));fixture.id='plugin-fixture';fixture.className='settings-inner';fixture.style.cssText='position:fixed;inset:0;display:flex';
    createRoot(fixture).render(React.createElement(AgentCapabilitiesPanel,{embedded:true,agents:[{id:'codex',name:'Codex'}],onOpenSync(){}}));
  `,
  inspect: `(async()=>{
    const wait=async probe=>{const until=Date.now()+5000;while(!probe()){if(Date.now()>until)throw Error('Plugin fixture timed out');await new Promise(r=>setTimeout(r,10));}};
    const fixture=document.getElementById('plugin-fixture');
    await wait(()=>fixture.querySelector('.capability-row'));fixture.querySelector('.capability-row').click();
    await wait(()=>fixture.querySelector('.cd-plugin-skill'));
    const text=fixture.querySelector('.cap-detail').textContent;
    const rawManifest=!!fixture.querySelector('.cd-code');
    const initiallyDisabled=fixture.querySelector('.cd-status').textContent.includes('已停用')&&fixture.querySelector('[data-capability-state]').textContent==='启用';
    fixture.querySelector('.cd-plugin-skill').click();
    await wait(()=>fixture.querySelector('.cd-name')?.textContent==='design-to-code'&&fixture.querySelector('.cd-body').textContent.includes('Design instructions'));
    const skillReadonly=!fixture.querySelector('.cap-detail-uninstall')&&fixture.querySelector('.cd-ro').textContent.includes('所属插件');
    [...fixture.querySelectorAll('.cd-actions button')].find(button=>button.textContent==='管理所属插件').click();
    await wait(()=>fixture.querySelector('.cd-plugin-skill'));
    fixture.querySelector('[data-capability-state]').click();
    await wait(()=>fixture.querySelector('.cd-status').textContent.includes('已启用')&&fixture.querySelector('[data-capability-state]').textContent==='停用');
    window.__failWrite=true;fixture.querySelector('[data-capability-state]').click();
    await wait(()=>fixture.querySelector('.cd-body [role="alert"]'));
    return {text,rawManifest,initiallyDisabled,skillReadonly,calls:window.__managementCalls,error:fixture.querySelector('.cd-body [role="alert"]').textContent,stillEnabled:fixture.querySelector('.cd-status').textContent.includes('已启用')};
  })()`
})
for (const text of ['Design, Inc.', 'v1.0.0', 'Create designs, ship code', 'Bring your design workflow', 'design-to-code', 'Convert designs into production code.']) assert(result.text.includes(text))
assert.equal(result.rawManifest, false)
assert.equal(result.initiallyDisabled, true)
assert.equal(result.skillReadonly, true)
assert.deepEqual(result.calls.map((call: any) => [call.action, call.expectedFingerprint]), [['plugin-enable', 'a'.repeat(64)], ['plugin-disable', 'b'.repeat(64)]])
assert(result.error.includes('操作失败'))
assert.equal(result.stillEnabled, true)
console.log('codex-plugin-detail-ui: plugin information, related Skill navigation, native state controls and failed writes passed')
