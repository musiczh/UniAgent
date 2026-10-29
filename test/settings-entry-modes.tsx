// Run explicitly: node scripts/run-ts-test.mjs test/settings-entry-modes.tsx
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentDef } from '../src/shared/types'
import { DISTRIBUTION_SETTINGS_CATEGORIES, isSettingsPagePanel, type SettingsCategory } from '../src/shared/settingsNavigation'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'

const noop = () => {}

const agent = {
  id: 'codex', name: 'Codex', adapter: 'codex', bin: 'codex', models: [],
  installed: true,
  capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [], sessionList: true },
  lifecycle: { availability: 'available', updateStatus: 'current', selfUpdateSupported: true }
} as unknown as AgentDef

function renderSettings(props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}): string {
  return renderToStaticMarkup(React.createElement(SettingsPanel, {
    agents: [agent],
    onRedetect: noop,
    onInitialize: noop,
    onAgentsChanged: noop,
    onOpenSync: noop,
    onBack: noop,
    ...props
  }))
}

// ---- 分类归属：自带页面面板的分类（导入会话 / 定时任务 / Token 消耗 / 工具能力） ----
for (const id of ['automations', 'capabilities', 'history', 'tokens'] as const) {
  assert.equal(isSettingsPagePanel(id), true, `${id} is a page-panel category`)
}
for (const id of ['general', 'projects', 'requirements', 'agent', 'assistants', 'codex-sources', 'local-models', 'teams', 'roles', 'presets'] as const) {
  assert.equal(isSettingsPagePanel(id), false, `${id} is a regular settings category`)
}

// ---- 页内模式（设置页内侧栏打开）：页面面板嵌入设置内容区，保留分类导航 ----
for (const [category, title, root] of [
  ['history', '历史会话 · 恢复', 'class="resume-panel resume-embedded"'],
  ['tokens', 'Token 消耗', 'class="token-usage-panel token-embedded"'],
  ['automations', '定时任务', 'class="automations-panel automations-embedded"']
] as const) {
  const markup = renderSettings({ initialCategory: category })
  assert.ok(markup.includes('class="set-nav"'), `embedded ${category} keeps the settings category nav`)
  assert.ok(markup.includes(root), `embedded ${category} renders without the standalone main-panel shell`)
  const navAt = markup.indexOf('class="set-nav"')
  const titleAt = markup.indexOf(title)
  assert.ok(titleAt > navAt, `embedded ${category} content lives inside the settings page, after the nav`)
  assert.ok(markup.includes('class="main-panel-head settings-head"'), `embedded ${category} keeps the 「‹ 设置」 header`)
}

{
  const markup = renderSettings({ initialCategory: 'capabilities' })
  assert.ok(markup.includes('class="capability-center capability-embedded"'), 'embedded capabilities keeps its in-page rendering')
  assert.ok(markup.includes('class="set-nav"'), 'embedded capabilities keeps the settings category nav')
}

// ---- 全窗模式（左侧侧边栏快捷入口打开）：无分类导航，标题为分类名 ----
{
  const markup = renderSettings({ windowed: true, initialCategory: 'agent' })
  assert.doesNotMatch(markup, /class="set-nav"/, 'windowed view hides the settings category nav')
  assert.doesNotMatch(markup, /class="settings-back"/, 'windowed view has no 「‹ 设置」 back button')
  assert.doesNotMatch(markup, /class="main-panel-head settings-head"/, 'windowed view does not use the settings header')
  assert.ok(markup.includes('<span class="main-panel-title">Agent</span>'), 'windowed view titles the page with the category label')
  assert.ok(markup.includes('class="set-content'), 'windowed view still renders the category content area')
}

// ---- 全窗模式对其它常规分类同样生效（以「通用」为例） ----
{
  const markup = renderSettings({ windowed: true, initialCategory: 'general' })
  assert.doesNotMatch(markup, /class="set-nav"/, 'windowed general hides the settings category nav')
  assert.ok(markup.includes('<span class="main-panel-title">通用</span>'), 'windowed general titles the page with the category label')
}

// ---- 切换分类后仍以同一模式展示（嵌入页不跳出：导航项只是切内容区） ----
{
  const markup = renderSettings({ initialCategory: 'tokens' })
  const navButtons = markup.match(/class="set-nav-item[^"]*"/g) || []
  assert.equal(navButtons.length, DISTRIBUTION_SETTINGS_CATEGORIES.length, 'embedded settings lists every category in the nav, including page-panel categories')
}
