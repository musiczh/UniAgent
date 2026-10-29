import { INTERNAL_DISTRIBUTION } from './distribution.ts'

export const SETTINGS_CATEGORIES = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'projects', label: '空间', icon: 'folder' },
  { id: 'requirements', label: '需求', icon: 'file' },
  { id: 'agent', label: 'Agent', icon: 'bot' },
  { id: 'assistants', label: '飞书&助手', icon: 'identity' },
  { id: 'codex-sources', label: '模型配置', icon: 'model' },
  { id: 'local-models', label: '本地大模型', icon: 'plug' },
  { id: 'teams', label: '专家团', icon: 'users' },
  { id: 'roles', label: '角色', icon: 'identity' },
  { id: 'presets', label: '任务模板', icon: 'templates' },
  { id: 'capabilities', label: '工具能力', icon: 'capabilities' },
  { id: 'automations', label: '定时任务', icon: 'automations' },
  { id: 'history', label: '导入会话', icon: 'history' },
  { id: 'tokens', label: 'Token 消耗', icon: 'tokens' }
] as const

export const DISTRIBUTION_SETTINGS_CATEGORIES = SETTINGS_CATEGORIES.filter(category => INTERNAL_DISTRIBUTION || category.id !== 'local-models')

export type SettingsCategory = typeof SETTINGS_CATEGORIES[number]['id']
// 自带独立页面面板的分类：侧栏快捷入口打开时直接全窗展示该面板；
// 设置页内侧栏打开时以 embedded 形式嵌进设置内容区。
export type SettingsPagePanel = 'automations' | 'capabilities' | 'history' | 'tokens'
export const MAX_SIDEBAR_SHORTCUTS = 5
export const DEFAULT_SIDEBAR_SHORTCUTS: readonly SettingsCategory[] = ['history', 'agent', 'tokens']

export function isSettingsPagePanel(id: SettingsCategory): id is SettingsPagePanel {
  return id === 'automations' || id === 'capabilities' || id === 'history' || id === 'tokens'
}

export function sanitizeSidebarShortcuts(raw: unknown): SettingsCategory[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SIDEBAR_SHORTCUTS]
  const ids = new Set<string>(DISTRIBUTION_SETTINGS_CATEGORIES.map(category => category.id))
  const shortcuts = raw.map(id => id === 'feishu' ? 'assistants' : id === 'diagnostics' ? 'general' : id)
  return [...new Set(shortcuts.filter((id): id is SettingsCategory => typeof id === 'string' && ids.has(id)))].slice(0, MAX_SIDEBAR_SHORTCUTS)
}
