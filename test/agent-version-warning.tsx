import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentVersionWarning, testedAgentVersion } from '../src/shared/agentCompatibility.ts'
import { AgentVersionWarning } from '../src/renderer/components/AgentVersionWarning.tsx'
import type { AgentDef } from '../src/shared/types.ts'

const agent = { id: 'deepseek', adapter: 'deepseek', name: 'DeepSeek Harness', installed: true, version: '0.2.1-rc.2' } as AgentDef
for (const version of ['0.2.1-rc.2', '99.0.0', '', 'unknown']) {
  const value = { ...agent, version }
  const warning = agentVersionWarning(value)!
  assert.match(warning.message, /可能存在兼容问题.*更新至最新版 UniAgent/)
  assert.equal(warning.testedVersion, testedAgentVersion('deepseek'))
  const markup = renderToStaticMarkup(<AgentVersionWarning agent={value}/>)
  assert.match(markup, /role="status"/)
  assert.match(markup, /此版已验证/)
  assert.doesNotMatch(markup, /disabled|role="alert"|<button/)
}
assert.equal(agentVersionWarning({ ...agent, version: testedAgentVersion('deepseek') }), undefined)
assert.equal(agentVersionWarning({ ...agent, version: 'old-build', lifecycle: { currentVersion: testedAgentVersion('deepseek') } as AgentDef['lifecycle'] }), undefined, 'warnings use the same current runtime version as the Agent details')
assert.equal(agentVersionWarning({ ...agent, installed: false }), undefined)
assert.equal(agentVersionWarning(undefined), undefined)
for (const version of ['grok 1.0.62', '1.0.70', 'grok v1.0.77 (fixture)', testedAgentVersion('grok')!]) {
  assert.equal(agentVersionWarning({ ...agent, adapter: 'grok', name: 'Grok', version }), undefined)
}
assert.match(agentVersionWarning({ ...agent, adapter: 'grok', name: 'Grok', version: '99.0.0' })!.message, /Grok 99.0.0/)
for (const adapter of ['kimi', 'nika', 'claude', 'codex'] as const) {
  assert.equal(agentVersionWarning({ ...agent, adapter, version: '2.5.3' }), undefined, 'unrestricted versions do not gain a new version gate')
  assert.match(agentVersionWarning({ ...agent, adapter, version: 'future-build' })!.message, /版本无法识别/)
}
console.log('PASS Agent version warnings: older, newer, unknown, previously tested, uninstalled and unrestricted Agents')
