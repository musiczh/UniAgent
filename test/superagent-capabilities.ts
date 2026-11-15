import assert from 'node:assert/strict'
import { superAgentModels, superAgentUnavailable } from '../src/shared/superAgent'
import { resolveTaskTitleConfig } from '../src/shared/taskTitle'
import { resolveRouterConfig, DEFAULT_ROUTER_CONFIG, routerModels } from '../src/shared/router'
import type { AgentDef } from '../src/shared/types'

const base = { installed: true, name: 'Fixture', models: [{ id: 'text', label: 'Text', imageInput: false, efforts: [] }, { id: 'vision', label: 'Vision', imageInput: true, efforts: ['low'] }],
  capabilities: { modelSelect: true, startupSystemPrompt: true, imageAttachments: true, streaming: true } }
for (const adapter of ['codex','traex','claude','qoder','deepseek','generic']) {
  const agent = { ...base, id: adapter, adapter } as AgentDef
  assert.equal(superAgentUnavailable(agent), undefined)
  assert.deepEqual(superAgentModels(agent).map(model => model.id), ['vision'])
  assert.deepEqual(routerModels(agent).map(model => model.id), ['vision'])
  for (const model of ['vision','text']) {
    assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: adapter, model }, [agent]).enabled, model === 'vision')
    assert.equal(resolveRouterConfig({ ...DEFAULT_ROUTER_CONFIG, agentId: adapter, model, effort: undefined }, [agent]).available, model === 'vision')
  }
  for (const override of [{ installed: false }, { authenticationRequired: true }, { incompatible: true }, { lifecycle: { availability: 'checking' } },
    { capabilities: { ...base.capabilities, startupSystemPrompt: false } }, { capabilities: { ...base.capabilities, imageAttachments: false } }, { models: [base.models[0]] }]) {
    const blocked = { ...agent, ...override } as AgentDef
    assert.ok(superAgentUnavailable(blocked))
    assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: adapter, model: 'vision' }, [blocked]).enabled, false)
    assert.equal(resolveRouterConfig({ ...DEFAULT_ROUTER_CONFIG, agentId: adapter, model: 'vision' }, [blocked]).available, false)
  }
  const provider = { ...agent, models: [{ id: 'vision', label: 'Provider', imageInput: true, efforts: [], modelSource: { kind: 'third-party', sourceId: 'one' } }] } as AgentDef
  assert.equal(superAgentModels(provider).length, 1)
  assert.equal(routerModels(provider).length, 0, 'Router retains its native model identity contract')
  assert.equal(resolveTaskTitleConfig({ enabled: true, agentId: adapter, model: 'vision', modelSource: { kind: 'third-party', sourceId: 'two' } }, [provider]).enabled, false)
}
assert.equal(superAgentUnavailable({ ...base, id: 'host', adapter: 'deepseek', capabilities: { ...base.capabilities, startupSystemPrompt: false, auxiliarySystemPrompt: true } } as AgentDef), undefined)
console.log('PASS shared SuperAgent capability admission, model modalities, native/provider identities and unavailable states')
