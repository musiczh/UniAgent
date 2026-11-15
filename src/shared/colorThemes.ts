export const COLOR_THEMES = [
  { id: 'graphite', name: '经典黑色', description: '原有黑灰与蓝色', scheme: 'dark' },
  { id: 'ui-ink', name: '墨石', description: '暖调炭黑与陶土色', scheme: 'dark' },
  { id: 'ui-paper', name: '宣纸 · UI', description: '中性纸白与靛蓝', scheme: 'light' },
  { id: 'ds-ink', name: '暖墨', description: '暖黑与黄铜色', scheme: 'dark' },
  { id: 'ds-paper', name: '宣纸 · DS', description: '暖纸白与墨蓝', scheme: 'light' },
  { id: 'cx-porcelain', name: '瓷白', description: '近白与银灰', scheme: 'light' },
  { id: 'cx-obsidian', name: '墨玉', description: '炭黑与浅玉色', scheme: 'dark' },
  { id: 'cx-atelier', name: '黑白工坊', description: '炭黑导航与暖白画布', scheme: 'light' },
  { id: 'grok-zinc', name: '锌匣', description: '冷黑导航与浅锌灰', scheme: 'light' }
] as const

export type ColorThemeId = typeof COLOR_THEMES[number]['id']
// Keep previously persisted values readable; the original UI was always dark.
export type ThemePreference = ColorThemeId | 'system' | 'dark' | 'light'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light'
    || COLOR_THEMES.some(theme => theme.id === value)
}

export function resolveColorTheme(value: unknown): ColorThemeId {
  return COLOR_THEMES.find(theme => theme.id === value)?.id ?? 'graphite'
}
