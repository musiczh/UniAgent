import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentIcon } from '../src/renderer/components/AgentIcon.tsx'
import { Composer } from '../src/renderer/components/Composer.tsx'
import { permissionModesForNewTask, resolveNewTaskPermission } from '../src/renderer/components/NewTaskPanel.tsx'
import { AgentCapabilitiesPanel, betaCapabilityRemovalRequest, buildCapabilityCompareRows, canManageCapabilityItem, usesDirectCapabilityRemoval } from '../src/renderer/components/AgentCapabilitiesPanel.tsx'
import { RoleDetail } from '../src/renderer/components/SettingsPanel.tsx'
import type { AgentDef, AgentRole, QueueItem } from '../src/shared/types.ts'
import type { CapabilityInventoryItem } from '../src/shared/capabilitySync.ts'
import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution.ts'

const grok: AgentDef = {
  id: 'grok', name: 'Grok', bin: 'grok', adapter: 'grok', icon: 'grok', builtin: true, installed: true,
  capabilities: {
    modelSelect: true, reasoningEffort: true, protocol: 'acp', streaming: true,
    imageAttachments: false, fileAttachments: true,
    permissionModes: [
      { id: 'read-only', label: '只读', hint: 'sandbox read-only' },
      { id: 'ask', label: '请求批准', hint: 'ask' },
      { id: 'approve-for-me', label: '自动批准', hint: 'auto' },
      { id: 'full-access', label: '完全访问', hint: 'yolo' }
    ]
  },
  models: [{ id: 'grok-4.6', label: 'Grok 4.6', efforts: ['xhigh', 'high', 'medium', 'low'], defaultEffort: 'high', contextWindow: 500000 }],
  defaultModel: 'grok-4.6'
}

const icon = renderToStaticMarkup(createElement(AgentIcon, { agentId: 'grok', adapter: 'grok', size: 18 }))
assert.match(icon, /agent-icon-grok/)
assert.doesNotMatch(icon, /<circle cx="12" cy="12" r="6"/)

assert.deepEqual(permissionModesForNewTask(grok).map((mode) => mode.id), [
  'read-only', 'ask', 'approve-for-me', 'full-access'
])
assert.equal(resolveNewTaskPermission(grok, 'ask'), 'ask')
assert.equal(resolveNewTaskPermission(grok, 'auto-edit'), 'read-only')

function renderComposer(agent: AgentDef, queue: QueueItem[] = []): string {
  return renderToStaticMarkup(createElement(Composer, {
    sessionId: 'grok-session', status: 'idle', agent,
    config: { agentId: 'grok', workdir: '/workspace', model: 'grok-4.6', effort: 'high', permissionMode: 'ask' },
    onSend: async () => undefined, onForceSend: () => undefined, onInterrupt: () => undefined,
    onUpdateConfig: () => undefined, onSetCollaborationMode: () => undefined, onRunNativeAction: () => undefined,
    queue, onDequeue: () => undefined, onPromoteQueue: () => undefined, onEditQueueItem: () => undefined,
    capabilities: {
      agentId: 'grok', workdir: '/workspace', source: 'provider-native', candidates: [],
      actions: { goal: false, review: false, plan: { id: 'plan', name: 'Plan', model: null, reasoningEffort: null } }, errors: []
    },
    capabilitiesReady: true, contextUsed: 0, onCompact: async () => undefined, canCompact: true, compacting: false
  }))
}

const composer = renderComposer(grok)
assert.match(composer, /Grok 4.6/)
assert.match(composer, />高</)
assert.match(composer, /请求批准/)
assert.match(composer, /添加文件附件/)
assert.doesNotMatch(composer, new RegExp('添加图片附件|添加图片 / 文件附件'))
assert.match(composer, />Plan</)

// A provider gate must reach the editable controls, including the empty Skills
// selection: native Grok/Kimi still discover skills when discovery is disabled.
const betaAgents: AgentDef[] = [
  grok,
  { ...grok, id: 'kimi', name: 'Kimi Code', adapter: 'kimi', models: [{ id: 'kimi', label: 'Kimi', efforts: [], thinkingOptions: ['off', 'high'] }], defaultModel: 'kimi' },
  { ...grok, id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', models: [{ id: 'deepseek', label: 'DeepSeek', efforts: ['off', 'high'] }], defaultModel: 'deepseek' },
  { ...grok, id: 'claude', name: 'Claude Code', adapter: 'claude', version: '2.1.296' }
]
function roleMarkup(agentId: string, fields: Partial<AgentRole> = {}, override?: AgentDef): string {
  const role: AgentRole = { id: `role-${agentId}`, name: 'Reviewer', agentId, permissionMode: 'read-only', ...fields }
  return renderToStaticMarkup(createElement(RoleDetail, {
    agents: override ? betaAgents.map(candidate => candidate.id === agentId ? override : candidate) : betaAgents,
    projects: [], entry: null, role, onBack: () => undefined, onSave: () => undefined
  }))
}
const deepseekRole = roleMarkup('deepseek', { model: 'deepseek', effort: 'off' })
assert.match(deepseekRole, /<option value="kimi"[^>]*>Kimi Code/)
assert.match(deepseekRole, /<option value="deepseek"[^>]*>DeepSeek Harness/)
assert.match(deepseekRole, /<option value="off" selected="">关闭<\/option>/)
assert.match(deepseekRole, /<option value="(?:none|allowlist)" disabled=""/)
for (const agentId of ['kimi', 'grok']) {
  for (const skills of [[], ['review']]) {
    const markup = roleMarkup(agentId, { skills })
    assert.match(markup, /<option value="none" disabled=""/)
    assert.match(markup, /<option value="allowlist" disabled=""/)
    assert.match(markup, /不支持禁用或精确指定 Skills/)
    assert.match(markup, /role="alert">当前配置包含不支持的策略/)
  }
}
const kimiRole = roleMarkup('kimi', { model: 'kimi', kimiThinking: 'high' })
assert.match(kimiRole, /aria-label="角色思考级别"/)
assert.match(kimiRole, /<option value="high" selected="">高<\/option>/)
const oldClaude = { ...betaAgents.find(agent => agent.id === 'claude')!, version: '2.1.295' }
const oldClaudeMarkup = roleMarkup('claude', { skills: [] }, oldClaude)
assert.match(oldClaudeMarkup, /<option value="none" disabled=""/)
assert.match(oldClaudeMarkup, /2\.1\.296/)
assert.match(oldClaudeMarkup, /<option value="allow-only" disabled=""/)
const verifiedClaudeMarkup = roleMarkup('claude', { skills: [], toolPolicy: { mode: 'allow-only', tools: ['Read'] } })
assert.doesNotMatch(verifiedClaudeMarkup, /<option value="(?:none|allowlist|allow-only|deny-only)" disabled=""/)
assert.doesNotMatch(verifiedClaudeMarkup, /role="alert"/)
for (const version of ['2.1.295', undefined, 'unknown']) {
  assert.match(roleMarkup('claude', { skills: [] }, { ...oldClaude, version }), /role="alert">当前配置包含不支持的策略/)
}

const grokItem = (name: string): CapabilityInventoryItem => ({
  id: `grok:skill:${name}`, agentId: 'grok', kind: 'skill', name, scope: 'agent',
  origin: 'Grok skill', owner: 'user', fingerprint: name, manageable: false, copyable: false, status: 'available'
})
const rows = buildCapabilityCompareRows([grokItem('review-code')], [], null, false)
assert.deepEqual(rows.map((row) => ({ name: row.name, status: row.status, syncSelectable: row.syncSelectable })), [
  { name: 'review-code', status: 'add', syncSelectable: false }
])

const emptyCapabilities = renderToStaticMarkup(createElement(AgentCapabilitiesPanel, { onOpenSync: () => undefined }))
assert.match(emptyCapabilities, /aria-label="选择 Agent" aria-haspopup="listbox"/)
assert.equal((emptyCapabilities.match(/role="option"/g) || []).length, INTERNAL_DISTRIBUTION ? 9 : 7, 'all distribution providers remain selectable before the inventory request finishes')
for (const id of ['codex', 'claude', 'grok', 'kimi', 'deepseek', 'mcode', 'zcode']) {
  assert.ok(emptyCapabilities.includes(`data-agent-id="${id}"`), id + ' is available in the selector')
}
assert.equal(emptyCapabilities.includes('data-agent-id="traex"'), INTERNAL_DISTRIBUTION)
assert.equal(emptyCapabilities.includes('data-agent-id="nika"'), INTERNAL_DISTRIBUTION)
assert.match(emptyCapabilities, /agent-icon-kimi/)
assert.match(emptyCapabilities, /agent-icon-deepseek/)
assert.match(emptyCapabilities, /agent-icon-mcode/)
const nativePlugin: CapabilityInventoryItem = { ...grokItem('plugin'), agentId: 'claude', kind: 'plugin', manageable: true }
assert.equal(canManageCapabilityItem(nativePlugin, false), true, 'the native user-scope plugin action does not require a writable file-sync provider')
assert.equal(canManageCapabilityItem({ ...nativePlugin, manageable: false }, true), false, 'read-only native scopes never become deletable from an Agent-level writable flag')
assert.equal(canManageCapabilityItem({ ...nativePlugin, kind: 'skill' }, false), false, 'native plugin management does not grant deletion of unrelated private Skills')
const kimiSkill: CapabilityInventoryItem = { ...grokItem('kimi-skill'), agentId: 'kimi', manageable: true, owner: 'user', scope: 'agent' }
const kimiMcp: CapabilityInventoryItem = { ...kimiSkill, id: 'kimi:agent:mcp:' + 'b'.repeat(24), kind: 'mcp' }
for (const candidate of [kimiSkill, kimiMcp]) {
  assert.equal(usesDirectCapabilityRemoval(candidate), true, 'manageable native Kimi items use the fingerprint guarded management route')
  assert.deepEqual(betaCapabilityRemovalRequest(candidate), { agentId: 'kimi', action: candidate.kind === 'skill' ? 'skill-delete' : 'mcp-delete', id: candidate.id, expectedFingerprint: candidate.fingerprint })
  assert.equal(usesDirectCapabilityRemoval({ ...candidate, manageable: false }), false, 'unverified items cannot enter native mutation')
}
assert.equal(usesDirectCapabilityRemoval({ ...nativePlugin, agentId: 'kimi' }), false, 'Kimi plugins remain under the plugin action contract')
assert.equal(usesDirectCapabilityRemoval({ ...grokItem('codex-skill'), agentId: 'codex' }), false)

const newTaskSource = readFileSync('src/renderer/components/NewTaskPanel.tsx', 'utf8')
const capabilitySource = readFileSync('src/renderer/components/AgentCapabilitiesPanel.tsx', 'utf8')
const appSource = readFileSync('src/renderer/App.tsx', 'utf8')
assert.match(newTaskSource, new RegExp('grok:\\s*\\{\\s*install:'))
assert.match(appSource, /<AgentIcon agentId=\{a\.id\} adapter=\{a\.adapter\}/)
assert.match(readFileSync('src/renderer/components/AgentIcon.tsx', 'utf8'), /key === 'grok'/)
assert.match(capabilitySource, new RegExp('grok:\\s*[\"\']Grok[\"\']'))
assert.match(capabilitySource, /leftAgent === 'codex' && rightAgent === 'traex'/)
assert.equal(capabilitySource.includes('任一侧为 <b>Claude Code</b>'), false)

const resumeSource = readFileSync('src/renderer/components/ResumePanel.tsx', 'utf8')
assert.match(resumeSource, /agents.filter/)
assert.doesNotMatch(resumeSource, /agentId !== ['"]grok['"]/)
const subagentSource = readFileSync('src/renderer/components/SubAgentPanel.tsx', 'utf8')
assert.doesNotMatch(subagentSource, /agentId === ['"]codex['"]/)
assert.doesNotMatch(subagentSource, /agentId !== ['"]grok['"]/)

console.log('grok-ui-contract: existing controls expose the verified Grok experience')
