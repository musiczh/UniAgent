import { resolveColorTheme } from '../shared/colorThemes'

export function applyColorTheme(value: unknown, root: HTMLElement = document.documentElement): void {
  const theme = resolveColorTheme(value)
  // No selector matches the classic theme: all existing colors remain intact.
  if (theme === 'graphite') root.removeAttribute('data-color-theme')
  else root.setAttribute('data-color-theme', theme)
}
