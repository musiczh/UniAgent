import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PrefsStore } from '../src/main/prefsStore'

test('explicit defaults do not replace the last-used agent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-prefs-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new PrefsStore(join(directory, 'prefs.json'))

  store.set('codex', { model: 'gpt-5' })
  const data = store.set('traex', { defaultModel: 'seed-code', defaultEffort: 'high' })

  assert.equal(data.lastAgentId, 'codex')
  assert.equal(data.lastByAgent.traex.defaultModel, 'seed-code')
})

test('write failures are propagated without changing persisted preferences', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-prefs-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'prefs.json')
  const store = new PrefsStore(file)

  store.set('codex', { model: 'gpt-5' })
  const before = await readFile(file, 'utf8')
  await chmod(file, 0o400)

  assert.throws(() => store.set('traex', { model: 'seed-code' }))
  assert.equal(await readFile(file, 'utf8'), before)
})

test('legacy Plan preferences migrate by the resolved agent adapter and round-trip independently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-prefs-plan-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'prefs.json')
  await writeFile(file, JSON.stringify({
    lastAgentId: 'custom-codex',
    lastByAgent: {
      'custom-codex': { model: 'gpt-5', permissionMode: 'plan' },
      'custom-traex': { permissionMode: 'plan' },
      'custom-claude': { permissionMode: 'plan' },
      unknown: { permissionMode: 'plan' },
      'null-entry': null,
      'array-entry': [],
      'number-entry': 7,
      'string-entry': 'invalid'
    }
  }))
  const adapters = new Map([
    ['custom-codex', 'codex'],
    ['custom-traex', 'traex'],
    ['custom-claude', 'claude']
  ])
  const store = new PrefsStore(file, (agentId: string) => {
    const adapter = adapters.get(agentId)
    return adapter ? { adapter } as any : undefined
  })

  const migrated = store.get()
  assert.deepEqual(migrated.lastByAgent['custom-codex'], {
    model: 'gpt-5', permissionMode: 'read-only', collaborationMode: 'plan'
  })
  assert.deepEqual(migrated.lastByAgent['custom-traex'], {
    permissionMode: 'read-only', collaborationMode: 'plan'
  })
  assert.deepEqual(migrated.lastByAgent['custom-claude'], { permissionMode: 'plan' })
  assert.deepEqual(migrated.lastByAgent.unknown, { permissionMode: 'plan' })
  assert.equal('null-entry' in migrated.lastByAgent, false)
  assert.equal('array-entry' in migrated.lastByAgent, false)
  assert.equal('number-entry' in migrated.lastByAgent, false)
  assert.equal('string-entry' in migrated.lastByAgent, false)
  assert.deepEqual(new PrefsStore(file, (agentId: string) => {
    const adapter = adapters.get(agentId)
    return adapter ? { adapter } as any : undefined
  }).get(), migrated, 'migration must be idempotent after the first persisted rewrite')

  const updated = store.set('custom-codex', { collaborationMode: 'default' })
  assert.equal(updated.lastByAgent['custom-codex'].permissionMode, 'read-only')
  assert.equal(updated.lastByAgent['custom-codex'].collaborationMode, 'default')
  assert.deepEqual(new PrefsStore(file, (agentId: string) => {
    const adapter = adapters.get(agentId)
    return adapter ? { adapter } as any : undefined
  }).get(), updated)
})
