import assert from 'node:assert/strict'
import { parsePublicReleaseManifest, readLatestRelease } from '../src/main/githubReleaseSource.ts'

const manifest = { schemaVersion: 1, version: '1.1.0', platform: 'darwin', arch: 'arm64', path: 'release/v1.1.0/UniAgent-Public-1.1.0-arm64.dmg', size: 123, sha256: 'a'.repeat(64) }
assert.deepEqual(parsePublicReleaseManifest(manifest), manifest)
for (const patch of [null, [], { version: '1.1.0/../../private' }, { path: 'https://example.com/private.dmg' }, { path: 'release/v1.1.0/UniAgent-1.1.0-arm64.dmg' }, { arch: 'x64' }, { size: 0 }, { size: Infinity }, { sha256: 'bad' }, { schemaVersion: 2 }]) {
  assert.throws(() => parsePublicReleaseManifest(patch === null || Array.isArray(patch) ? patch : { ...manifest, ...patch }), /invalid_manifest/)
}
let requests = 0
const release = await readLatestRelease({ cacheDir: '/unused', request: async (url, options) => {
  requests++
  assert.equal(String(url), 'https://musiczh.github.io/UniAgent/latest.json')
  assert.equal(options?.credentials, 'omit')
  return new Response(JSON.stringify(manifest))
} })
assert.equal(requests, 1)
assert.equal(release.downloadUrl, 'https://github.com/musiczh/UniAgent/releases/download/v1.1.0/UniAgent-Public-1.1.0-arm64.dmg')
assert.equal(release.releaseUrl, 'https://github.com/musiczh/UniAgent/releases/tag/v1.1.0')
for (const [response, error] of [[new Response('', { status: 404 }), 'no_release'], [new Response('', { status: 503 }), 'network'], [new Response('{}'), 'invalid_manifest']] as const) {
  await assert.rejects(readLatestRelease({ cacheDir: '/unused', request: async () => response }), new RegExp(error))
}
await assert.rejects(readLatestRelease({ cacheDir: '/unused', request: async () => { throw new Error('offline') } }), /network/)
console.log('GitHub release source: fixed public endpoint, manifest boundaries and network failures passed')
