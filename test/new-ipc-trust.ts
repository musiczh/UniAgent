import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('new privileged IPC handlers reuse the main-frame trust guard', async () => {
  const source = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  for (const channel of [
    'getNativeCapabilities', 'createNativeActionSession', 'runNativeAction',
    'compactSession',
    'fsListDir', 'fsReadFile', 'fsReveal', 'fsOpenHtml', 'listAutomations', 'setAutomationStatus',
    'saveClipboardImage', 'copyImageToClipboard',
    'getAutomationDetail', 'updateAutomation', 'deleteAutomation',
    'reviewGetFilePair', 'reviewGetChangeSet',
    'getTurnArtifactSummary', 'previewSessionRewind', 'rewindSession',
    'setCollaborationMode',
    'getPrefs', 'setPrefs', 'getAppSettings', 'setAppSettings',
    'getAppVersion', 'checkAppUpdate', ...(INTERNAL_DISTRIBUTION ? ['getTokenUsage', 'refreshTokenUsage'] : []),
    'getNativeTokenUsage', 'refreshNativeTokenUsage', 'logTokenUsage', 'getCodexRateLimits',
    'getClaudeRateLimits',
    'getQueueWaitQuality', 'copyQueueWaitQuality', 'openQueueWaitQualityLogs'
  ]) {
    const start = source.indexOf(`IPC.${channel}`)
    assert.notEqual(start, -1, `missing IPC.${channel}`)
    assert.ok(
      source.slice(start, start + 500).includes('assertTrustedCapabilitySyncIpc(event)'),
      `IPC.${channel} is unguarded`
    )
  }
})

test('app-update IPC uses the isolated Bits cache and repository fallback', async () => {
  const source = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert.ok(source.includes("const APP_UPDATE_CACHE_DIR = join(resolveUserDataHome(), 'app-update-cache.git')"))
  assert.ok(source.includes('cacheDir: APP_UPDATE_CACHE_DIR'))
  assert.ok(source.includes('releaseUrl: RELEASE_REPOSITORY_PAGE'))
  assert.ok(source.includes('checkAppUpdate(appUpdateContext(), { force, onFailure:'))
})
