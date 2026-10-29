import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution.ts'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentCapabilitiesPanel, betaCapabilityRemovalRequest, betaCapabilityEditorRequest, betaCapabilityStateRequest, capabilityManagementErrorMessage,
  canCreateBetaCapability, canManageCapabilityItem, usesDirectCapabilityRemoval
} from '../src/renderer/components/AgentCapabilitiesPanel.tsx'
import type { CapabilityInventoryItem } from '../src/shared/capabilitySync.ts'

const item = (agentId: 'kimi' | 'grok', kind: 'skill' | 'mcp' | 'plugin', extra: Partial<CapabilityInventoryItem> = {}): CapabilityInventoryItem => ({
  id: `${agentId}:${kind}:opaque`, agentId, kind, name: 'fixture', scope: 'agent', origin: 'native user', owner: 'user',
  fingerprint: 'a'.repeat(64), manageable: true, copyable: false, status: 'available', ...extra
})
for (const candidate of [item('kimi', 'skill'), item('kimi', 'mcp'), item('grok', 'mcp'), item('grok', 'plugin', { scope: 'plugin', owner: 'plugin' })]) {
  assert.ok(canManageCapabilityItem(candidate, true))
  const request = betaCapabilityRemovalRequest(candidate)!
  assert.equal(request.id, candidate.id)
  assert.equal(request.expectedFingerprint, candidate.fingerprint)
}
assert.equal(usesDirectCapabilityRemoval(item('grok', 'mcp')), true)
const kimiPlugin = item('kimi', 'plugin', { scope: 'plugin', owner: 'plugin', pluginId: 'registered-plugin' })
assert.equal(canManageCapabilityItem(kimiPlugin, true), true)
assert.deepEqual(betaCapabilityRemovalRequest(kimiPlugin), { agentId: 'kimi', action: 'plugin-uninstall', id: kimiPlugin.id, expectedFingerprint: kimiPlugin.fingerprint })
for (const candidate of [item('kimi', 'skill', { linked: true }), item('kimi', 'skill', { owner: 'shared', scope: 'shared' }),
  item('kimi', 'plugin'), item('grok', 'skill'), item('grok', 'mcp', { manageable: false }), item('kimi', 'mcp', { status: 'invalid' })]) {
  assert.equal(canManageCapabilityItem(candidate, true), false)
  assert.equal(betaCapabilityRemovalRequest(candidate), undefined)
}
assert.match(capabilityManagementErrorMessage(new Error("Error invoking remote method 'capabilityInventory:manage': Error: capability_inventory_stale")), /已变化/)
assert.equal(capabilityManagementErrorMessage(new Error('/private/SECRET_HOME ENV_SECRET failure')), '操作失败，请重新扫描后重试。')
assert.equal(canCreateBetaCapability({ agentId: 'grok', available: true, writable: false, status: 'available', items: [], revision: 'revision' }, 'mcp'), true, 'first native user MCP can be added')
assert.equal(canCreateBetaCapability({ agentId: 'kimi', available: true, writable: false, status: 'available', items: [], revision: 'revision' }, 'skill'), false, 'atomic FS gates Kimi creation')
assert.equal(canCreateBetaCapability({ agentId: 'grok', available: true, writable: true, status: 'invalid', items: [], revision: 'revision' }, 'plugin'), false)
const skillEdit = betaCapabilityEditorRequest({ agentId: 'kimi', kind: 'skill', name: 'fixture', text: 'new manifest', item: item('kimi', 'skill') })
assert.equal(skillEdit.action, 'skill-update')
assert.equal('expectedFingerprint' in skillEdit && skillEdit.expectedFingerprint, 'a'.repeat(64))
const grokEdit = betaCapabilityEditorRequest({ agentId: 'grok', kind: 'mcp', name: 'fixture', text: JSON.stringify({ transport: 'http', url: 'https://example.com', headers: { Authorization: '[redacted]' }, enabled: false }), item: item('grok', 'mcp'), expectedRevision: 'previous' })
assert.equal(grokEdit.action, 'mcp-update')
assert.equal('enabled' in grokEdit, false, 'enabled state has its own native action')
assert.equal('headers' in grokEdit && typeof grokEdit.headers === 'object' && grokEdit.headers?.Authorization, '[redacted]', 'secret placeholders pass through unchanged')
assert.equal('expectedRevision' in grokEdit && grokEdit.expectedRevision, 'previous')
for (const candidate of [item('grok', 'mcp', { manageable: false }), item('kimi', 'mcp', { scope: 'shared', owner: 'shared' })]) {
  assert.throws(() => betaCapabilityEditorRequest({ agentId: candidate.agentId as 'kimi' | 'grok', kind: 'mcp', name: candidate.name, text: '{}', item: candidate }))
  assert.equal(betaCapabilityStateRequest(candidate, false), undefined)
}
assert.deepEqual(betaCapabilityStateRequest(item('kimi', 'mcp'), false), { agentId: 'kimi', action: 'mcp-disable', id: 'kimi:mcp:opaque', expectedFingerprint: 'a'.repeat(64) })
assert.deepEqual(betaCapabilityStateRequest(item('grok', 'plugin', { scope: 'plugin', owner: 'plugin' }), true, 'rev'), { agentId: 'grok', action: 'plugin-enable', id: 'grok:plugin:opaque', expectedFingerprint: 'a'.repeat(64), expectedRevision: 'rev' })
assert.throws(() => betaCapabilityEditorRequest({ agentId: 'grok', kind: 'mcp', name: 'fixture', text: '{broken' }))
assert.throws(() => betaCapabilityEditorRequest({ agentId: 'grok', kind: 'mcp', name: 'fixture', text: JSON.stringify({ transport: 'stdio', command: 'node', cwd: '/private' }) }))
assert.throws(() => betaCapabilityEditorRequest({ agentId: 'kimi', kind: 'mcp', name: 'fixture', text: '[]' }))
const deepseekPlugin: CapabilityInventoryItem = { ...item('grok', 'plugin'), id: 'deepseek:plugin:' + 'd'.repeat(24), agentId: 'deepseek', scope: 'plugin', owner: 'plugin' }
assert.deepEqual(betaCapabilityRemovalRequest(deepseekPlugin), { agentId: 'deepseek', action: 'plugin-remove', id: deepseekPlugin.id, expectedFingerprint: deepseekPlugin.fingerprint })
assert.deepEqual(betaCapabilityStateRequest(deepseekPlugin, false), { agentId: 'deepseek', action: 'plugin-disable', id: deepseekPlugin.id, expectedFingerprint: deepseekPlugin.fingerprint })
assert.equal(canManageCapabilityItem({ ...deepseekPlugin, manageable: false }, true), false, 'protected DeepSeek plugins never gain actions')
assert.deepEqual(betaCapabilityEditorRequest({ agentId: 'deepseek', kind: 'plugin', name: '@scope/plugin@1.2.3', text: '' }), { agentId: 'deepseek', action: 'plugin-install', spec: '@scope/plugin@1.2.3' })
assert.deepEqual(betaCapabilityEditorRequest({ agentId: 'deepseek', kind: 'plugin', name: ' @scope/plugin@1.3.0 ', text: '', item: deepseekPlugin }), {
  agentId: 'deepseek', action: 'plugin-update', id: deepseekPlugin.id, expectedFingerprint: deepseekPlugin.fingerprint, spec: '@scope/plugin@1.3.0'
}, 'updating an existing plugin keeps the fingerprint captured when the form opened')
assert.throws(() => betaCapabilityEditorRequest({ agentId: 'deepseek', kind: 'plugin', name: '@scope/plugin@1.3.0', text: '', item: { ...deepseekPlugin, manageable: false } }), /invalid_capability_inventory_manage_request/, 'protected plugins cannot be updated')
assert.deepEqual(betaCapabilityEditorRequest({ agentId: 'deepseek', kind: 'plugin', name: '', text: '', item: deepseekPlugin }), {
  agentId: 'deepseek', action: 'plugin-update', id: deepseekPlugin.id, expectedFingerprint: deepseekPlugin.fingerprint
}, 'empty target upgrades the native bundle to latest without guessing a package from its module label')
assert.equal(canCreateBetaCapability({ agentId: 'deepseek', available: true, writable: false, managementSupported: true, status: 'available', items: [], revision: 'rev' }, 'plugin'), true, 'first plugin can be installed when native manager is available')
const markup = renderToStaticMarkup(createElement(AgentCapabilitiesPanel, { onOpenSync: () => undefined }))
for (const name of ['Codex', ...(INTERNAL_DISTRIBUTION ? ['TraeX'] : []), 'Claude Code', 'Grok', 'Kimi Code', 'DeepSeek']) assert.ok(markup.includes(name))
assert.equal(markup.includes('role="dialog"'), false, 'new forms are hidden until explicitly opened')
console.log('beta-capability-panel: native management requests, permission gates, stale fingerprints, safe errors and six-agent SSR ok')
