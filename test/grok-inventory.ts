import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectGrokInventory } from '../src/main/grokInventory.ts'
import { listCapabilityInventories } from '../src/main/capability-sync/inventory.ts'
import {
  parseCapabilityInventorySyncRequest,
  parseCapabilityPluginActionRequest,
  parseCapabilityScanRequest
} from '../src/shared/capabilitySync.ts'

type FakeGrok = {
  dir: string
  bin: string
  logPath: string
  cleanup: () => Promise<void>
}

async function createFakeGrok(scenario: Record<string, unknown> = {}): Promise<FakeGrok> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-grok-inventory-'))
  const bin = join(dir, 'grok')
  const logPath = join(dir, 'invocations.jsonl')
  const statePath = join(dir, 'state.json')
  const fixture = resolve(process.cwd(), 'test/fixtures/fake-grok.cjs')
  await mkdir(join(dir, 'workspace'))
  await writeFile(statePath, JSON.stringify({ sessions: [] }), 'utf8')
  await writeFile(bin, `#!/usr/bin/env node
process.env.FAKE_GROK_LOG = ${JSON.stringify(logPath)}
process.env.FAKE_GROK_STATE = ${JSON.stringify(statePath)}
process.env.FAKE_GROK_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))}
require(${JSON.stringify(fixture)})
`, 'utf8')
  await chmod(bin, 0o755)
  return { dir, bin, logPath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const emptyPluginRunner = async (bin: string, args: string[]): Promise<{ stdout: string }> => ({ stdout: bin === 'traecli'
  ? args.includes('marketplace') ? 'Found 0 plugins:\n' : 'Plugins:\n'
  : JSON.stringify({ installed: [], available: [] }) })

const fake = await createFakeGrok({ inventorySecret: 'TOP_SECRET_INVENTORY_VALUE' })
let firstRevision = ''
try {
  const direct = await inspectGrokInventory(fake.bin, join(fake.dir, 'workspace'))
  firstRevision = direct.revision
  assert.equal(direct.agentId, 'grok')
  assert.equal(direct.available, true)
  assert.equal(direct.writable, false)
  assert.equal(direct.status, 'available')
  assert.deepEqual(
    direct.items.map((item) => [item.kind, item.name]).sort(),
    [
      ['agent-profile', 'researcher'],
      ['global-instructions', 'AGENTS.md'],
      ['hook', 'PreToolUse'],
      ['mcp', 'fixture-mcp'],
      ['plugin', 'fixture-plugin'],
      ['skill', 'review-code']
    ]
  )
  assert.equal(direct.items.every((item) => !item.manageable && !item.copyable), true)
  assert.equal(direct.items.find((item) => item.kind === 'plugin')?.components?.hooks, 1)

  const serialized = JSON.stringify(direct)
  assert.equal(serialized.includes('TOP_SECRET_INVENTORY_VALUE'), false)
  assert.equal(serialized.includes('Bearer'), false)
  assert.equal(serialized.includes('ACCESS_KEY'), false)
  assert.equal(serialized.includes('/fixture/'), false)

  const calls = (await readFile(fake.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'argv').map((entry) => entry.argv)
  assert.deepEqual(calls, [
    ['inspect', '--json'],
    ['mcp', 'list', '--json'],
    ['plugin', 'list', '--json']
  ])

  const result = await listCapabilityInventories(fake.dir, emptyPluginRunner, {
    bin: fake.bin, cwd: join(fake.dir, 'workspace')
  })
  const grok = result.inventories.find((entry) => entry.agentId === 'grok')
  assert.ok(grok)
  assert.equal(grok.writable, false)
  assert.equal(grok.items.every((item) => !item.manageable && !item.copyable), true)
} finally {
  await fake.cleanup()
}

const alternateSecret = await createFakeGrok({ inventorySecret: 'A_DIFFERENT_SECRET' })
try {
  const inventory = await inspectGrokInventory(alternateSecret.bin, join(alternateSecret.dir, 'workspace'))
  assert.equal(JSON.stringify(inventory).includes('A_DIFFERENT_SECRET'), false)
  assert.equal(inventory.revision, firstRevision)
} finally {
  await alternateSecret.cleanup()
}

const malformed = await createFakeGrok({
  inventorySecret: 'MALFORMED_SECRET_SENTINEL',
  inventoryMalformed: 'inspect --json'
})
try {
  const inventory = await inspectGrokInventory(malformed.bin, join(malformed.dir, 'workspace'))
  assert.equal(inventory.status, 'invalid')
  assert.equal(inventory.items.length, 0)
  assert.equal(JSON.stringify(inventory).includes('MALFORMED_SECRET_SENTINEL'), false)
} finally {
  await malformed.cleanup()
}

assert.throws(() => parseCapabilityScanRequest({ source: 'grok', target: 'codex' }), /invalid_capability_scan_request/)
assert.throws(() => parseCapabilityInventorySyncRequest({ source: 'grok', target: 'codex', selections: ['opaque'] }), /invalid_capability_inventory_sync_request/)
assert.throws(() => parseCapabilityPluginActionRequest({ id: 'opaque', action: 'migrate', targetAgentId: 'grok' }), /invalid_capability_plugin_action/)

console.log('grok-inventory: read-only CLI inventory and redaction contracts ok')
