import assert from 'node:assert/strict'
import { configureKimiPlatformKey } from '../src/main/kimiPlatformKey.ts'
import { kimiConnectionStatus } from '../src/main/kimiWebContract.ts'

const originalProvider = { id: 'existing-third-party', base_url: 'https://fixture.invalid' }
const providers = [originalProvider]
let defaultModel = 'existing-third-party/current', released = 0
const writes: { method: string; path: string; body: any }[] = []
const acquire = async () => ({ transport: {
  specification: async () => ({ paths: { '/api/v1/providers': { post: {} }, '/api/v1/models/{tail}': { post: {} } } }),
  request: async (method: string, path: string, body: any) => {
    writes.push({ method, path, body })
    if (path === '/api/v1/providers') providers.push(body)
    else defaultModel = decodeURIComponent(path.slice('/api/v1/models/'.length).split(':')[0])
  }
}, release: async () => { released++ } }) as any
let receivedUrl = '', receivedHeader = ''
const request: typeof fetch = async (url, options) => {
  receivedUrl = String(url); receivedHeader = (options!.headers as any).Authorization
  return new Response(JSON.stringify({ data: [
    { id: 'kimi-k-fixture', context_length: 128000, supports_image_in: true, supports_reasoning: true },
    { id: 'unrelated-model', context_length: 100 }, { id: 'kimi-k-invalid', context_length: 0 }
  ] }))
}
const signal = new AbortController().signal
await configureKimiPlatformKey('/fixture/kimi', 'global', 'offline-fixture-key', signal, {}, request, acquire)
assert.equal(receivedUrl, 'https://api.moonshot.ai/v1/models')
assert.equal(receivedHeader, 'Bearer offline-fixture-key')
assert.equal(writes[0].method, 'POST'); assert.equal(writes[0].path, '/api/v1/providers')
assert.equal(writes[0].body.type, 'kimi'); assert.equal(writes[0].body.models.length, 1)
assert.equal(writes[0].body.models[0].max_context_size, 128000)
assert.ok(writes[0].body.models[0].capabilities.includes('image_in'))
assert.equal(defaultModel, writes[0].body.id + '/kimi-k-fixture')
assert.equal(providers[0], originalProvider, 'the native API receives a new identity instead of overwriting any old provider')
assert.equal(released, 1)
for (const response of [new Response('', { status: 401 }), new Response(JSON.stringify({ data: [] }))]) {
  const before = writes.length
  await assert.rejects(configureKimiPlatformKey('/fixture/kimi', 'cn', 'offline-fixture-key', signal, {}, async () => response, acquire), error => error instanceof Error && /原配置已保留/.test(error.message) && !error.message.includes('offline-fixture-key'))
  assert.equal(writes.length, before, 'failed candidates never reach the native writer')
}
const cancelled = new AbortController(); cancelled.abort()
await assert.rejects(configureKimiPlatformKey('/fixture/kimi', 'cn', 'offline-fixture-key', cancelled.signal, {}, request, acquire))
assert.equal(kimiConnectionStatus({ models_ready: false }, []), 'needs-config')
assert.equal(kimiConnectionStatus({ models_ready: true }, []), 'needs-config', 'empty model catalog is not ready')
assert.equal(kimiConnectionStatus({ models_ready: false, managed_provider: { status: 'unauthenticated', name: 'kimi' } }, [{ provider: 'kimi' }]), 'needs-auth')
assert.equal(kimiConnectionStatus({ models_ready: true, managed_provider: { status: 'unauthenticated', name: 'kimi' } }, [{ provider: 'external' }]), 'ready', 'usable third-party providers do not require OAuth')
console.log('Kimi Platform Key: region, native route/body, model metadata, preserved providers, failed candidates, cancellation and config/auth distinction passed')
