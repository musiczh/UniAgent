import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { COLOR_THEMES, isThemePreference, resolveColorTheme } from '../src/shared/colorThemes'
import type { AppSettingsPatch } from '../src/shared/types'

const directory = mkdtempSync(join(tmpdir(), 'ua-color-themes-'))
try {
  const store = new AppSettingsStore(directory)
  assert.equal(COLOR_THEMES.length, 9)
  assert.equal(new Set(COLOR_THEMES.map(theme => theme.id)).size, 9)
  assert.equal(resolveColorTheme(store.get().theme), 'graphite')
  store.set({ autoCheckUpdate: false, preventSleep: true, sidebarShortcuts: ['history'] })
  for (const theme of COLOR_THEMES) {
    assert.equal(isThemePreference(theme.id), true)
    assert.equal(store.set({ theme: theme.id }).theme, theme.id)
    const restored = new AppSettingsStore(directory).get()
    assert.equal(restored.theme, theme.id, 'theme survives a new store instance')
    assert.equal(restored.autoCheckUpdate, false)
    assert.equal(restored.preventSleep, true)
    assert.deepEqual(restored.sidebarShortcuts, ['history'])
  }
  store.set({ theme: 'cx-porcelain' })
  for (const invalid of ['', 'unknown', null, 0, {}, ['ui-ink']]) {
    assert.equal(isThemePreference(invalid), false)
    assert.equal(store.set({ theme: invalid } as AppSettingsPatch).theme, 'cx-porcelain')
    assert.equal(resolveColorTheme(invalid), 'graphite')
  }
  store.set({ notificationMode: 'always' })
  assert.equal(store.get().theme, 'cx-porcelain', 'other preference changes preserve color')
  for (const theme of [undefined, 'system', 'dark', 'light', 'unknown']) {
    writeFileSync(join(directory, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, theme }))
    assert.equal(resolveColorTheme(new AppSettingsStore(directory).get().theme), 'graphite', 'legacy appearance stays black')
  }
  writeFileSync(join(directory, 'app-settings.json'), '{invalid')
  assert.equal(resolveColorTheme(store.get().theme), 'graphite')
  const invalidDirectory = join(directory, 'not-a-directory')
  writeFileSync(invalidDirectory, 'fixture')
  assert.throws(() => new AppSettingsStore(invalidDirectory).set({ theme: 'ui-paper' }), /颜色风格保存失败/)
  assert.equal(readFileSync(invalidDirectory, 'utf8'), 'fixture')
  console.log('color themes: nine palettes, persistence, legacy defaults, invalid values, unrelated settings and write failure passed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
