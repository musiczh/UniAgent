import assert from 'node:assert/strict'
import { buildCapabilityCompareRows, capabilityLogRows, compareRowStatusLabel, orderCapabilityItems } from '../src/renderer/components/AgentCapabilitiesPanel.tsx'
import type { CapabilityInventoryItem, CapabilityScanResult } from '../src/shared/capabilitySync.ts'

const item = (agentId: 'codex' | 'traex', name: string, scope: 'agent' | 'shared', extra: Partial<CapabilityInventoryItem> = {}): CapabilityInventoryItem => ({
  id: `${agentId}:${scope}:${name}`, agentId, kind: 'skill', name, scope, origin: scope,
  owner: scope === 'agent' ? 'user' : 'shared', fingerprint: name, manageable: scope === 'agent', copyable: scope === 'agent', status: 'available', ...extra
})

const left = [
  item('codex', 'same-name', 'shared'),
  item('codex', 'shared-left-only', 'shared'),
  item('codex', 'same-name', 'agent'),
  item('codex', 'broken', 'agent', { status: 'invalid', issueCode: 'invalid_skill_permissions', manageable: false, copyable: false })
]
const right = [item('traex', 'same-name', 'shared')]

const readonlyRows = buildCapabilityCompareRows(left, right, null, false)
const sameName = readonlyRows.filter((row) => row.name === 'same-name')
assert.equal(sameName.length, 2)
assert.deepEqual(sameName.map((row) => [row.scope, row.status, row.inLeft, row.inRight]), [
  ['shared', 'same', true, true],
  ['agent', 'add', true, false]
])
const sharedLeftOnly = readonlyRows.find((row) => row.name === 'shared-left-only')!
assert.deepEqual([sharedLeftOnly.scope, sharedLeftOnly.status, sharedLeftOnly.inLeft, sharedLeftOnly.inRight], ['shared', 'add', true, false])
assert.equal(compareRowStatusLabel(sharedLeftOnly, false), '仅左', 'shared location does not imply that another Agent reads it')
const invalid = readonlyRows.find((row) => row.name === 'broken')!
assert.equal(invalid.status, 'invalid')
assert.equal(compareRowStatusLabel(invalid, false), '无效：Skill 文件或目录权限不安全：对组或其他用户可写')

const scan: CapabilityScanResult = {
  id: 'scan', source: 'codex', target: 'traex', sourceRevision: 'a', targetRevision: 'b', scannedAt: 1,
  sourceAvailable: true, targetAvailable: true, executionSupported: true,
  items: [{ id: 'skill:same-name', kind: 'skill', name: 'same-name', status: 'add', compatible: true, selectable: true, cloneSafe: true, defaultSelected: true }]
}
const writableRows = buildCapabilityCompareRows(left, right, scan, true)
const excludedKinds = ['command', 'tool', 'global-instructions', 'global-preference'] as const
assert.equal(buildCapabilityCompareRows(excludedKinds.map(kind => item('codex', kind, 'agent', { kind })), [], null, false).length, 0)
assert.equal(buildCapabilityCompareRows([], [], { ...scan, items: (['global-instructions', 'global-preference'] as const).map(kind => ({ ...scan.items[0], kind, id: kind })) }, true).length, 0)
assert.deepEqual(writableRows.filter((row) => row.name === 'same-name').map((row) => [row.scope, row.status]), [
  ['shared', 'same'],
  ['agent', 'add']
])

const ordered = orderCapabilityItems([
  item('codex', 'android-cli', 'shared', { status: 'shadowed', issueCode: 'shadowed_capability' }),
  item('codex', 'android-cli', 'agent')
])
assert.deepEqual(ordered.map((entry) => [entry.name, entry.scope, entry.status]), [
  ['android-cli', 'agent', 'available'],
  ['android-cli', 'shared', 'shadowed']
])
assert.equal(capabilityLogRows({ inventories: [{ agentId: 'codex', available: true, writable: true, status: 'available', revision: 'x', items: ordered }], scannedAt: 1 }).length, 0)

console.log('capability compare tests passed')
