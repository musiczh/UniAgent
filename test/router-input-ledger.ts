import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { routerTargetVersion } from '../src/main/router/target'
import { submittedTextHash, hydrateSubmittedUserMessages } from '../src/main/submittedUserMessages'
import type { AgentDef, Session } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'ua-router-input-'))
const store = new SessionStore(join(root, 'sessions.json'))
const agent = { id: 'fixture', installed: true, adapter: 'generic', models: [], capabilities: { permissionModes: [] } } as unknown as AgentDef
const seed: Session = { id: 'task', title: '原任务', config: { agentId: agent.id, workdir: root }, status: 'idle', createdAt: 1 }
store.save([seed])
const orchestrator = new Orchestrator(() => agent, store)
orchestrator.loadPersisted()
const target = orchestrator.getSessionById(seed.id)!
target.status = 'running'
const inputId = randomUUID(), version = routerTargetVersion(target)
const receipts = await Promise.all(Array.from({ length: 8 }, () => orchestrator.acceptRoutedInput(target.id, inputId, '继续原任务', undefined, version, 'feishu')))
assert.equal(receipts.every(row => row.status === 'queued'), true)
assert.deepEqual(orchestrator.getQueue(target.id).map(row => row.id), [inputId])
assert.equal(orchestrator.getQueue(target.id)[0].source, 'feishu', 'routed Feishu input keeps the actual channel')
await assert.rejects(orchestrator.acceptRoutedInput(target.id, inputId, '不同原文', undefined, version), /conflict/)
await assert.rejects(orchestrator.acceptRoutedInput(target.id, randomUUID(), '继续', undefined, 'stale'), /target_changed/)
await assert.rejects(orchestrator.acceptRoutedInput(target.id, 'invalid', '继续', undefined, version), /invalid_routed/)
const restored = new Orchestrator(() => agent, store)
restored.loadPersisted()
const recovered = restored.getSessionById(target.id)!
assert.equal(restored.getQueue(target.id)[0].routedInputId, inputId)
assert.equal(restored.getQueue(target.id)[0].source, 'feishu', 'the Feishu driver survives restart')
assert.equal((await restored.acceptRoutedInput(target.id, inputId, '继续原任务', undefined, routerTargetVersion(recovered))).status, 'queued')
assert.equal(restored.getQueue(target.id).length, 1)
const uncertain: Session = { ...seed, pendingQueue: [{ ...orchestrator.getQueue(target.id)[0], state: 'dispatching', attempts: 1 }] }
store.save([uncertain])
const afterCrash = new Orchestrator(() => agent, store)
afterCrash.loadPersisted()
const row = afterCrash.getSessionById(target.id)!
assert.equal((await afterCrash.acceptRoutedInput(row.id, inputId, '继续原任务', undefined, routerTargetVersion(row))).status, 'unknown')
assert.equal(afterCrash.getQueue(row.id).length, 1)
store.save([{ ...seed, submittedUserMessages: [{ routedInputId: inputId, type: 'user_message', source: 'app', userOrdinal: 0, textHash: submittedTextHash('继续原任务'), acceptedAt: 1 }] }])
const submitted = new Orchestrator(() => agent, store)
submitted.loadPersisted()
assert.equal((await submitted.acceptRoutedInput(seed.id, inputId, '继续原任务', undefined, 'old-version')).status, 'accepted')
assert.equal(submitted.getQueue(seed.id).length, 0)
assert.equal(hydrateSubmittedUserMessages([{ sessionId:seed.id,seq:0,ts:1,type:'user_message',payload:{text:'继续原任务'} }], submitted.getSessionById(seed.id)!.submittedUserMessages)[0].payload.routedInputId, inputId)
await assert.rejects(submitted.acceptRoutedInput(seed.id, inputId, '换了原文', undefined, 'old-version'), /conflict/)
console.log('PASS Router input ledger: concurrent retries, original queue, durable identity, stale target, submitted conflict and uncertain recovery')
