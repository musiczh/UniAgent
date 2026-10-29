// Offline native-frame fixtures must participate in the release regression gate.
import '../scripts/zcode-adapter-check'
import assert from 'node:assert/strict'
import { ZCodeRunner } from '../src/main/zcode/runner'
import { sanitizeZCodeState, zcodePayloadHash } from '../src/main/zcode/store'
import type { Session } from '../src/shared/types'
import type { ZCodeRuntime } from '../src/main/zcode/runtime'
import type { ZCodeRuntimePool } from '../src/main/zcode/runtimePool'

const selection = { providerId: 'fixture', modelId: 'fixture' }
const session: Session = {
  id: 'zcode-plan', title: 'Plan', createdAt: 1, updatedAt: 1, status: 'idle', nativeSessionId: 'native-plan',
  config: { agentId: 'zcode', workdir: '/repo', permissionMode: 'ask', collaborationMode: 'plan' },
  zcodeState: { schemaVersion: 1, dataRootId: 'data', workspaceKey: 'workspace', runtimeFingerprint: 'runtime', deliveries: [] }
}
let persisted: unknown
const runner = new ZCodeRunner({ session, runtime: { selection, models: [] } as unknown as ZCodeRuntime,
  pool: {} as ZCodeRuntimePool, clientId: 'fixture', nextSeq: () => 0,
  persist: () => { persisted = structuredClone(session.zcodeState) }, mcpServers: () => [] })
Object.assign(runner, { state: { config: { modelSelection: selection }, control: { phase: 'idle' }, inputRouting: { mode: 'startNow' } } })
const planned = runner.prepare('plan-ask', 'Plan the change')
assert.equal(planned.submission.planEnabled, true)
assert.equal(planned.submission.mode, 'build')
session.config = { ...session.config, permissionMode: 'full-access' }
const unrestricted = runner.prepare('plan-full', 'Continue planning')
assert.equal(unrestricted.submission.planEnabled, true, 'Plan must survive a permission change')
assert.equal(unrestricted.submission.mode, 'yolo')
session.config = { ...session.config, collaborationMode: 'default' }
const normal = runner.prepare('normal', 'Implement after leaving Plan')
assert.equal(normal.submission.planEnabled, false)
assert.equal(planned.submission.planEnabled, true, 'a queued submission must retain its original mode')
assert.equal(planned.payloadHash, zcodePayloadHash(planned.submission))
assert.deepEqual(sanitizeZCodeState(persisted)?.deliveries.map(record => record.submission.planEnabled), [true, true, false],
  'persisted delivery snapshots must retain Plan independently of permission modes')
for (const [permissionMode, native] of [['auto-edit', 'edit'], ['guarded', 'guarded']] as const) {
  session.config = { ...session.config, permissionMode, collaborationMode: 'plan' }
  const delivery = runner.prepare(`mode-${native}`, 'Use the selected permission')
  assert.equal(delivery.submission.mode, native)
  assert.equal(delivery.submission.planEnabled, true)
  assert.equal(sanitizeZCodeState(persisted)?.deliveries.at(-1)?.submission.mode, native,
    'new native permission modes must survive delivery restoration')
}
console.log('ZCode Plan: native submission and restored delivery modes passed')
