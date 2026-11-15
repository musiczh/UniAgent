import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionRecoveryStore } from '../src/main/sessionRecoveryStore'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import { defaultRecoverySettings } from '../src/shared/sessionRecovery'

const root = await mkdtemp(join(tmpdir(), 'recovery-store-'))
try {
  const file = join(root, 'session-recovery.json'), store = new SessionRecoveryStore(file)
  assert.deepEqual(await store.load(), { version: 1, errors: [], records: [] })
  await store.save({ version: 1, errors: [], records: [{ sessionId: 's', chainId: 'c', phase: 'waiting', attempts: 2, maxRetries: 3, reason: '繁忙', matchedRuleIds: [], updatedAt: 1, failureIds: ['a'], history: [] }] })
  assert.equal((await store.load()).records[0].attempts, 2)
  await writeFile(file, '{invalid')
  await assert.rejects(store.load())
  await writeFile(file, JSON.stringify({ version: 1, errors: [], records: [{ attempts: -1 }] }))
  await assert.rejects(store.load(), /无效/)
  const settings = new AppSettingsStore(join(root, 'settings.json'))
  assert.equal(settings.get().sessionRecovery?.enabled, false)
  const config = { ...defaultRecoverySettings(), enabled: true, agentId: 'codex', model: 'judge', rules: [{ id: 'deny', effect: 'no-retry' as const, description: '需要登录', enabled: true }] }
  settings.set({ sessionRecovery: config })
  assert.deepEqual(new AppSettingsStore(join(root, 'settings.json')).get().sessionRecovery, config)
  assert.throws(() => settings.set({ sessionRecovery: { maxRetries: 0 } }))
  assert.equal(settings.get().sessionRecovery!.maxRetries, 3)
  console.log('PASS recovery persistence: settings roundtrip, durable counts and corrupt state fails closed')
} finally { await rm(root, { recursive: true, force: true }) }
