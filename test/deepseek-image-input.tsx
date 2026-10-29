import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from '../src/renderer/components/Composer'
import { deepseekHostContract } from '../src/main/deepseekHostContract'
import type { AgentDef } from '../src/shared/types'

// Official 0.2.1-rc.2 session/modelCatalog omits inputModalities, including for Flash.
const config = { agentId: 'deepseek', workdir: '/workspace', model: '["deepseek-official","deepseek-flash"]' }
const contract = deepseekHostContract({ groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] }] }, config,
  { options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }] })
const agent: AgentDef = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin: 'dsh', icon: 'deepseek',
  installed: true, builtin: true, models: contract.models, defaultModel: config.model,
  capabilities: { ...contract, modelSelect: true, reasoningEffort: true, protocol: 'web' } }
function markup(value: AgentDef) {
  return renderToStaticMarkup(createElement(Composer, {
    sessionId: 'image-input', status: 'idle', agent: value, config,
    onSend: async () => {}, onInterrupt: () => {}, onUpdateConfig: () => {},
    queue: [], onDequeue: () => {}, onPromoteQueue: () => {}, onEditQueueItem: () => {},
    capabilities: { agentId: 'deepseek', workdir: '/workspace', source: 'provider-native', candidates: [], actions: { goal: false, review: false, plan: false }, errors: [] },
    capabilitiesReady: true, contextUsed: 0, onCompact: async () => {}, canCompact: false, compacting: false
  }))
}
assert.equal(contract.models[0].imageInput, undefined, 'fixture must reproduce the real Host catalog omission')
assert.match(markup(agent), /添加图片 \/ 文件附件/, 'Host image admission must remain available when model metadata is unknown')
assert.doesNotMatch(markup({ ...agent, models: [{ ...agent.models[0], imageInput: false }] }), /添加图片/,
  'an explicitly text-only model must stay disabled')
assert.match(markup({ ...agent, models: [{ ...agent.models[0], imageInput: true }] }), /添加图片 \/ 文件附件/)
assert.doesNotMatch(markup({ ...agent, capabilities: { ...agent.capabilities, imageAttachments: false } }), /添加图片/,
  'provider-level image rejection must stay disabled')
assert.doesNotMatch(markup({ ...agent, capabilities: { ...agent.capabilities, protocol: 'acp' } }), /添加图片/,
  'legacy ACP must not inherit Host image admission')
assert.doesNotMatch(markup({ ...agent, id: 'kimi', adapter: 'kimi' }), /添加图片/,
  'Kimi still requires its own affirmative model capability')
console.log('deepseek-image-input: Host unknown capabilities, explicit text-only models and provider boundaries passed')
