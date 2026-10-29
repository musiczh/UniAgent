import assert from 'node:assert/strict'
import type { AgentRole, SessionConfig } from '../src/shared/types.ts'

import { buildGrokSessionMeta, grokRoleUnavailableReason, projectGrokConfigOptions, supportsGrokConfigOptions } from '../src/main/grokRoleConfig.ts'
const role: AgentRole = { id: 'reviewer', name: 'Reviewer', agentId: 'grok', permissionMode: 'ask' }
const config: SessionConfig = { agentId: 'grok', workdir: '/tmp/ua-grok-role' }

assert.equal(buildGrokSessionMeta(config), undefined)
assert.deepEqual(buildGrokSessionMeta({ ...config, permissionMode: 'approve-for-me' }), { autoMode: true })
assert.deepEqual(buildGrokSessionMeta({ ...config, permissionMode: 'full-access' }), { yoloMode: true })
assert.deepEqual(buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, instructions: ' literal $role\n\n<rule/> ' } }), {
  rules: ' literal $role\n\n<rule/> '
})
assert.deepEqual(buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, instructions: '  ' } }), undefined)

const readonly = { ...role, toolPolicy: { mode: 'allow-only' as const, tools: ['Read', 'grep_search', 'list_dir', 'read_file'] } }
assert.deepEqual(buildGrokSessionMeta({ ...config, roleSnapshot: readonly }), {
  agentProfile: {
    name: 'reviewer', description: 'Reviewer', promptMode: 'extend', injectDefaultTools: false,
    toolConfig: { tools: [{ id: 'GrokBuild:read_file' }, { id: 'GrokBuild:grep' }, { id: 'GrokBuild:list_dir' }] },
    disallowedTools: ['search_tool', 'use_tool', 'Agent', 'workflow', 'scheduler_create', 'monitor']
  }
})
assert.deepEqual(buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'allow-only', tools: [] } } })!.agentProfile, {
  name: 'reviewer', description: 'Reviewer', promptMode: 'extend', injectDefaultTools: false,
  toolConfig: { tools: [{ id: 'GrokBuild:read_file' }] },
  disallowedTools: ['search_tool', 'use_tool', 'Agent', 'workflow', 'scheduler_create', 'monitor', 'read_file']
})
assert.deepEqual((buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'allow-only', tools: ['shell', 'search_replace'] } } })!.agentProfile as Record<string, unknown>).toolConfig, {
  tools: [{ id: 'GrokBuild:run_terminal_cmd', params: { enabled_background: false } }, { id: 'GrokBuild:search_replace', params: { skip_read_before_edit: true } }]
})
assert.deepEqual((buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'deny-only', tools: ['shell'] } } })!.agentProfile as Record<string, unknown>).disallowedTools, [
  'run_terminal_cmd', 'search_tool', 'use_tool', 'Agent', 'workflow', 'scheduler_create', 'monitor'
])
assert.deepEqual((buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'deny-only', tools: ['Write'] } } })!.agentProfile as Record<string, unknown>).disallowedTools, [
  'search_replace', 'write', 'search_tool', 'use_tool', 'Agent', 'workflow', 'scheduler_create', 'monitor'
])
assert.deepEqual((buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'deny-only', tools: ['write'] } } })!.agentProfile as Record<string, unknown>).disallowedTools, [
  'write', 'search_tool', 'use_tool', 'Agent', 'workflow', 'scheduler_create', 'monitor'
])
assert.match(grokRoleUnavailableReason({ ...role, toolPolicy: { mode: 'allow-only', tools: ['write'] } })!, /^role_tool_unsupported:/)
assert.equal(buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'deny-only', tools: [] } } }), undefined)
assert.equal(grokRoleUnavailableReason(readonly), undefined)
assert.equal(grokRoleUnavailableReason({ ...role, skills: [] }), 'role_skills_unsupported')
assert.equal(grokRoleUnavailableReason({ ...role, skills: ['review'] }), 'role_skills_unsupported')
assert.match(grokRoleUnavailableReason({ ...role, toolPolicy: { mode: 'allow-only', tools: ['unknown'] } })!, /^role_tool_unsupported: unknown$/)
assert.match(grokRoleUnavailableReason({ ...role, toolPolicy: { mode: 'allow-only', tools: ['Agent'] } })!, /^role_tool_delegation_unsupported:/)
assert.throws(() => buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, toolPolicy: { mode: 'deny-only', tools: ['unknown'] } } }), /role_tool_unsupported/)
assert.throws(() => buildGrokSessionMeta({ ...config, roleSnapshot: { ...role, skills: [] } }), /role_skills_unsupported/)

const response = { configOptions: [
  { id: 'model', type: 'select', currentValue: 'grok-4.7', options: [{ value: 'grok-4.7', name: 'Grok 4.7' }, { group: 'older', name: 'Older', options: [{ value: 'grok-4.6', name: 'Grok 4.6' }] }] },
  { id: 'reasoning_effort', type: 'select', currentValue: 'high', options: [{ value: 'xhigh' }, { value: 'high' }, { value: 'low' }] }
] }
assert.equal(supportsGrokConfigOptions(response), true)
assert.equal(supportsGrokConfigOptions({ configOptions: [] }), false)
assert.equal(supportsGrokConfigOptions({ configOptions: [{ id: 'model', type: 'boolean', currentValue: true }] }), false)
assert.deepEqual(projectGrokConfigOptions(response), {
  models: [
    { id: 'grok-4.7', label: 'Grok 4.7', efforts: ['xhigh', 'high', 'low'], defaultEffort: 'high' },
    { id: 'grok-4.6', label: 'Grok 4.6', efforts: ['xhigh', 'high', 'low'], defaultEffort: 'high' }
  ], currentModelId: 'grok-4.7', currentEffort: 'high'
})
assert.deepEqual(projectGrokConfigOptions({ configOptions: [
  { id: 'model', type: 'select', currentValue: true, options: [null, { value: '' }, { value: 3 }, { value: 'grok-id' }, { value: 'grok-id', name: 'duplicate' }] },
  { id: 'reasoning_effort', type: 'select', currentValue: 'max', options: [{ value: 'minimal' }, { value: 'high' }, { value: 'high' }, { value: 'unknown' }] }
] }), { models: [{ id: 'grok-id', label: 'grok-id', efforts: ['high'] }] })
assert.deepEqual(projectGrokConfigOptions({}), { models: [] })
assert.deepEqual(projectGrokConfigOptions({ configOptions: [{ id: 'reasoning_effort', type: 'select', currentValue: 'low', options: [{ value: 'low' }] }] }), { models: [], currentEffort: 'low' })
console.log('grok-role-config: ok')
