import assert from 'node:assert/strict'
import test from 'node:test'
import { withAgentDefaults } from '../src/shared/agentChoices'
import type { AgentDef, AgentPref, SessionConfig } from '../src/shared/types'

const agent = {
  id: 'codex', adapter: 'codex', defaultModel: 'native',
  capabilities: { modelSelect: true, reasoningEffort: true },
  models: [
    { id: 'native', label: 'Native', efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: 'last', label: 'Last', efforts: ['medium', 'high'], defaultEffort: 'medium', modelSource: { kind: 'third-party', sourceId: 'fixture' } }
  ]
} as AgentDef
const config = { agentId: agent.id, projectId: 'space', workdir: '/fixture', permissionMode: 'read-only' } as SessionConfig
const history: AgentPref = { model: 'last', effort: 'high' }

test('new sessions follow the last model and effort, including the model source', () => {
  const resolved = withAgentDefaults(agent, config, history)
  assert.equal(resolved.model, 'last')
  assert.equal(resolved.effort, 'high')
  assert.deepEqual(resolved.modelSource, agent.models[1].modelSource)
  assert.deepEqual(history, { model: 'last', effort: 'high' }, 'resolving defaults must not turn history into fixed defaults')
})

test('fixed model and effort override history independently', () => {
  const fixedModel = withAgentDefaults(agent, config, { ...history, defaultModel: 'native' })
  assert.equal(fixedModel.model, 'native')
  assert.equal(fixedModel.effort, 'high')
  const fixedEffort = withAgentDefaults(agent, config, { ...history, defaultEffort: 'medium' })
  assert.equal(fixedEffort.model, 'last')
  assert.equal(fixedEffort.effort, 'medium')
  const explicit = withAgentDefaults(agent, { ...config, model: 'native', effort: 'low' }, { ...history, defaultModel: 'last', defaultEffort: 'high' })
  assert.equal(explicit.model, 'native')
  assert.equal(explicit.effort, 'low', 'explicit session and role choices still take priority')
})

test('missing or unavailable history falls back to the current model contract', () => {
  for (const pref of [undefined, { model: 'removed', effort: 'ultra' }, { model: 'native', effort: 'medium' }] as (AgentPref | undefined)[]) {
    const resolved = withAgentDefaults(agent, config, pref)
    assert.equal(resolved.model, 'native')
    assert.equal(resolved.effort, 'low')
  }
  const unavailableFixed = withAgentDefaults(agent, config, { ...history, defaultModel: 'removed', defaultEffort: 'ultra' })
  assert.equal(unavailableFixed.model, 'native')
  assert.equal(unavailableFixed.effort, 'low')
  assert.equal(withAgentDefaults({ ...agent, models: [] }, config, history).model, undefined)
  assert.equal(withAgentDefaults({ ...agent, capabilities: { ...agent.capabilities, modelSelect: false, reasoningEffort: false } }, config, history).model, undefined)
})

test('native thinking follows history and retains explicit defaults for Kimi and ZCode', () => {
  for (const adapter of ['kimi', 'zcode'] as const) {
    const native = { ...agent, id: adapter, adapter, defaultModel: 'native', models: [{ id: 'native', label: 'Native', efforts: [], thinkingOptions: ['balanced', 'fast'], defaultThinking: 'balanced', ...(adapter === 'zcode' ? { zcodeSelection: { providerId: 'fixture', modelId: 'native' } } : {}) }] } as AgentDef
    const thinking = (pref: AgentPref) => {
      const resolved = withAgentDefaults(native, { ...config, agentId: adapter }, pref)
      return adapter === 'kimi' ? resolved.kimiThinking : resolved.zcodeModelSelection?.options?.reasoningLevel
    }
    const last = adapter === 'kimi' ? { kimiThinking: 'fast' } : { zcodeThinking: 'fast' }
    assert.equal(thinking(last), 'fast')
    assert.equal(thinking({ ...last, defaultThinking: 'balanced' }), 'balanced')
    assert.equal(thinking(adapter === 'kimi' ? { kimiThinking: 'removed' } : { zcodeThinking: 'removed' }), 'balanced')
  }
})
