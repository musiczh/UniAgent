import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAppUpdate, compareSemver } from '../src/main/appUpdater.ts'
import { ReleaseSourceError as BitsReleaseSourceError, RELEASE_REPOSITORY_PAGE } from '../src/main/releaseSource.ts'

const releaseUrl = RELEASE_REPOSITORY_PAGE

test('failed checks retry after one minute and report only actual failures', async () => {
  const context = { currentVersion: '9.0.0', isPackaged: true, isE2E: false, cacheDir: '/tmp/uniagent-failure-cache.git' }
  let failures = 0
  let reads = 0
  const options = { onFailure: () => { failures++ }, readLatestRelease: async () => {
    reads++
    if (reads === 1) throw new BitsReleaseSourceError('network')
    return latestRelease('9.0.1')
  } }
  await checkAppUpdate(context, { ...options, force: true, now: () => 100 })
  await checkAppUpdate(context, { ...options, now: () => 101 })
  assert.equal(failures, 1)
  assert.equal(reads, 1)
  assert.equal((await checkAppUpdate(context, { ...options, now: () => 60_100 })).latestVersion, '9.0.1')
  assert.equal(reads, 2)
})

function latestRelease(version: string) {
  return {
    manifest: {
      schemaVersion: 1 as const,
      version,
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      path: `release/v${version}/UniAgent-${version}-arm64.dmg`,
      size: 123,
      sha256: 'a'.repeat(64)
    },
    downloadUrl: `https://code.byted.org/zhenghuan.zheng/UniAgent/raw/master/release/v${version}/UniAgent-${version}-arm64.dmg`,
    releaseUrl
  }
}

test('app updater compares Bits versions, caches for six hours, and stays offline when disabled', async () => {
  assert.equal(compareSemver('v1.10.0', '1.2.9'), 1)
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0)
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1)

  const context = {
    currentVersion: '1.2.9',
    isPackaged: true,
    isE2E: false,
    cacheDir: '/tmp/uniagent-update-cache.git'
  }
  let reads = 0
  const readLatestRelease = async (options: { cacheDir: string; signal?: AbortSignal; timeoutMs?: number }) => {
    reads += 1
    assert.equal(options.cacheDir, context.cacheDir)
    assert.equal(options.timeoutMs, 15_000)
    assert.ok(options.signal)
    return latestRelease('1.10.0')
  }
  const first = await checkAppUpdate(context, { readLatestRelease, now: () => 100 })
  assert.deepEqual(first, {
    currentVersion: '1.2.9',
    latestVersion: '1.10.0',
    hasUpdate: true,
    downloadUrl: 'https://code.byted.org/zhenghuan.zheng/UniAgent/raw/master/release/v1.10.0/UniAgent-1.10.0-arm64.dmg',
    releaseUrl,
    checkedAt: 100
  })

  const cached = await checkAppUpdate(context, {
    readLatestRelease: async () => { throw new Error('cache miss') },
    now: () => 100 + (6 * 60 * 60 * 1000) - 1
  })
  assert.deepEqual(cached, first)
  assert.equal(reads, 1)

  const expired = await checkAppUpdate(context, {
    readLatestRelease,
    now: () => 100 + (6 * 60 * 60 * 1000)
  })
  assert.equal(expired.checkedAt, 100 + (6 * 60 * 60 * 1000))
  assert.equal(reads, 2)

  const forced = await checkAppUpdate(context, {
    force: true,
    readLatestRelease,
    now: () => 100 + (6 * 60 * 60 * 1000) + 1
  })
  assert.equal(forced.checkedAt, 100 + (6 * 60 * 60 * 1000) + 1)
  assert.equal(reads, 3)

  for (const disabled of [
    { ...context, isPackaged: false },
    { ...context, isE2E: true }
  ]) {
    const state = await checkAppUpdate(disabled, {
      force: true,
      readLatestRelease: async () => { throw new Error('disabled checker went online') },
      now: () => 200
    })
    assert.equal(state.hasUpdate, false)
    assert.equal(state.checkedAt, 200)
  }
  assert.equal(reads, 3)
})

test('app updater preserves all public Bits source errors', async () => {
  const context = {
    currentVersion: '1.0.0',
    isPackaged: true,
    isE2E: false,
    cacheDir: '/tmp/uniagent-update-errors.git'
  }
  for (const code of [
    'auth_required',
    'git_unavailable',
    'network',
    'invalid_manifest',
    'no_asset',
    'no_release'
  ] as const) {
    const state = await checkAppUpdate(context, {
      force: true,
      readLatestRelease: async () => { throw new BitsReleaseSourceError(code) }
    })
    assert.equal(state.error, code)
    assert.equal(state.hasUpdate, false)
    assert.equal(state.releaseUrl, releaseUrl)
  }
})

test('app updater reports equal and lower Bits versions without an update', async () => {
  const context = {
    currentVersion: '1.2.9',
    isPackaged: true,
    isE2E: false,
    cacheDir: '/tmp/uniagent-update-version-ordering.git'
  }
  for (const version of ['1.2.9', '1.2.8']) {
    const state = await checkAppUpdate(context, {
      force: true,
      readLatestRelease: async () => latestRelease(version)
    })
    assert.equal(state.latestVersion, version)
    assert.equal(state.hasUpdate, false)
  }
})
