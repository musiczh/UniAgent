import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentDef } from '../src/shared/types'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'

const noop = () => {}
// 外部列表只暴露三种稳态：可用 / 异常 / 可更新。
for (const [availability, updateStatus, label] of [
  ['available', 'available', '可更新'],
  ['available', 'current', '可用'],
  ['available', 'idle', '可用'],
  ['needs-auth', 'current', '异常'],
  ['unhealthy', 'failed', '异常'],
  ['not-installed', 'unknown', '未安装']
] as const) {
  const agent = {
    id: 'codex', name: 'Codex', adapter: 'codex', bin: 'codex', models: [],
    installed: availability !== 'not-installed',
    capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] },
    lifecycle: { availability, updateStatus, selfUpdateSupported: true }
  } as AgentDef
  const markup = renderToStaticMarkup(React.createElement(SettingsPanel, {
    agents: [agent], initialCategory: 'agent', onRedetect: noop,
    onInitialize: noop, onAgentsChanged: noop, onOpenSync: noop, onBack: noop
  }))
  assert.ok(markup.includes(label), `${availability}/${updateStatus} keeps its status text`)
  assert.doesNotMatch(markup, /class="ndot"/, 'settings category navigation keeps notice dots hidden')
  if (availability !== 'not-installed') {
    assert.match(markup, /class="dot (?:ok|off|warn)"/, 'settings retain Agent availability status dots')
  }
}

console.log('settings notice and status dots: ok')
