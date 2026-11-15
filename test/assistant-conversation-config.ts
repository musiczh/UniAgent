import assert from 'node:assert/strict'
import { parseAssistantConversationSelection, resolveAssistantConversationConfig } from '../src/shared/assistantConversation'
import type { AssistantConversationSelection } from '../src/shared/assistantConversation'
import type { PersonalAssistant } from '../src/shared/assistant'
import type { AgentDef, AgentPref } from '../src/shared/types'

const assistant: PersonalAssistant = { id: 'personal', enabled: true, defaultAgentId: 'codex', defaultModel: 'a', defaultPermissionMode: 'ask', autoReviewEnabled: false, createdAt: 1, updatedAt: 1 }
const agent: AgentDef = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '', icon: '', builtin: true, installed: true,
  lifecycle: { availability: 'available', auth: 'authenticated', health: 'healthy' }, defaultModel: 'b',
  capabilities: { startupSystemPrompt: true, modelSelect: true, reasoningEffort: true, permissionModes: [{ id: 'ask', label: '询问', hint: '' }] },
  models: [{ id: 'a', label: 'A', efforts: ['low', 'xhigh'], defaultEffort: 'low', modelSource: { kind: 'native' } },
    { id: 'b', label: 'B', efforts: ['low', 'high'], defaultEffort: 'high' }] }
const pref: AgentPref = { defaultModel: 'b', defaultEffort: 'xhigh', model: 'b', effort: 'low' }
const before = structuredClone({ assistant, agent, pref })
const resolve = (selection?: AssistantConversationSelection) => resolveAssistantConversationConfig(assistant, agent, pref, selection)
const defaults = resolve()
assert.equal(defaults.model, 'a', 'assistant model takes precedence over agent preferences')
assert.equal(defaults.effort, 'xhigh', 'thinking follows the selected agent defaults')
assert.equal(defaults.useAssistant, true)
assert.equal(defaults.permissionMode, 'ask')
assert.equal(defaults.workdir, '', 'workspace and identity remain resolved by the existing assistant service')
const chosen = resolve({ agentId: 'codex', model: 'b', effort: 'low' })
assert.equal(chosen.model, 'b')
assert.equal(chosen.effort, 'low')
assert.equal(chosen.modelSource, undefined, 'model identity cannot retain another model source')
assert.equal(resolve({ agentId: 'codex', model: 'b' }).effort, 'high', 'unsupported defaults fall back to the selected model default')
assert.equal(resolveAssistantConversationConfig({ ...assistant, defaultModel: undefined }, agent, { model: 'b', effort: 'low' }).effort, 'low', 'missing fixed defaults follow last accepted choices')
assert.equal(resolveAssistantConversationConfig({ ...assistant, defaultModel: undefined }, agent, { model: 'b' }).model, 'b')

const other: AgentDef = { ...agent, id: 'claude', adapter: 'claude', defaultModel: 'b' }
assert.equal(resolveAssistantConversationConfig(assistant, other, {}, { agentId: 'claude' }).model, 'b', 'changing agent uses its own model defaults')
assert.equal(resolveAssistantConversationConfig(assistant, { ...other, capabilities: { ...other.capabilities, reasoningEffort: false } }, {}, { agentId: 'claude' }).effort, undefined)
assert.equal(resolveAssistantConversationConfig(assistant, { ...other, models: [], capabilities: { ...other.capabilities, modelSelect: false, reasoningEffort: false } }, {}, { agentId: 'claude' }).model, undefined, 'nonselectable models use the agent runtime default')
const native = (adapter: 'kimi' | 'zcode'): AgentDef => ({ ...agent, id: adapter, adapter, defaultModel: 'native', models: [
  { id: 'native', label: 'Native', efforts: [], thinkingOptions: ['fast', 'deep'], defaultThinking: 'fast',
    ...(adapter === 'zcode' ? { zcodeSelection: { providerId: 'provider', modelId: 'native', options: { reasoningLevel: 'fast' } } } : {}) }
] })
for (const adapter of ['kimi', 'zcode'] as const) {
  const config = resolveAssistantConversationConfig(assistant, native(adapter), { defaultThinking: 'fast' }, { agentId: adapter, thinking: 'deep' })
  assert.equal(config.effort, undefined, 'native thinking does not become a generic effort')
  assert.equal(adapter === 'kimi' ? config.kimiThinking : config.zcodeModelSelection?.options?.reasoningLevel, 'deep')
  if (adapter === 'zcode') assert.equal(config.zcodeModelSelection?.providerId, 'provider')
  assert.throws(() => resolveAssistantConversationConfig(assistant, native(adapter), {}, { agentId: adapter, effort: 'high' }), /思考强度/)
  assert.throws(() => resolveAssistantConversationConfig(assistant, native(adapter), {}, { agentId: adapter, thinking: 'missing' }), /Thinking/)
}
assert.throws(() => resolve({ agentId: 'codex', model: 'missing' }), /模型已不可用/)
assert.throws(() => resolve({ agentId: 'codex', model: 'b', effort: 'xhigh' }), /思考强度/)
assert.throws(() => resolve({ agentId: 'codex', thinking: 'deep' }), /Thinking/)
assert.throws(() => resolveAssistantConversationConfig(assistant, undefined), /Agent 当前不可用/)
assert.throws(() => resolveAssistantConversationConfig(assistant, { ...agent, lifecycle: { ...agent.lifecycle!, availability: 'unavailable' } }), /Agent 当前不可用/)
assert.throws(() => resolveAssistantConversationConfig(assistant, { ...agent, capabilities: { ...agent.capabilities, startupSystemPrompt: false } }), /承接个人助手/)
assert.throws(() => resolveAssistantConversationConfig({ ...assistant, enabled: false }, agent), /停用/)
assert.throws(() => resolveAssistantConversationConfig({ ...assistant, defaultPermissionMode: 'full-access' }, agent), /默认权限/)
for (const value of [null, [], {}, { agentId: '' }, { agentId: 'codex', effort: 5 }, { agentId: 'codex', model: 'x'.repeat(501) }, { agentId: 'codex', permissionMode: 'full-access' }]) {
  assert.throws(() => parseAssistantConversationSelection(value), /参数无效/)
}
assert.equal(parseAssistantConversationSelection(undefined), undefined)
assert.deepEqual({ assistant, agent, pref }, before, 'creation choices never mutate assistant settings, catalog or global preferences')
console.log('PASS assistant conversation config: defaults, one-off choices, model identity, native Thinking and invalid input')
