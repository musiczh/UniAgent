import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionForkJobs, type ForkJobDependencies } from '../src/main/sessionForkJobs'
import type { AgentDef, Session, SessionConfig } from '../src/shared/types'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { readForkContext, writeForkTarget } from '../src/main/forkContext'

const home = await mkdtemp(join(tmpdir(), 'uniagent-fork-jobs-'))
const nativeRoot = join(home, '.codex/sessions')
await mkdir(nativeRoot, { recursive: true })
const original = join(nativeRoot, 'rollout-source.jsonl')
const base = JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: home } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'remember constraint' }] } }) + '\n'
await writeFile(original, base)
const checkpoint = JSON.stringify({ type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary retains constraint' }] }] } }) + '\n'
let compactions = 0, snapshots = 0, creates = 0, failValidation = true
const created = new Map<string, string>()
const config: SessionConfig = { agentId: 'codex', model: 'source-model', workdir: home }
const agent = { id: 'codex', adapter: 'codex', models: [], capabilities: { additionalDirectoriesNew: true, additionalDirectoriesResume: true } } as unknown as AgentDef
let release: (() => void) | undefined, entered: (() => void) | undefined
const deps: ForkJobDependencies = {
  prepare: async () => ({ source: agent, target: agent, sourceConfig: config, targetConfig: { ...config, agentId: 'claude' }, contextWindow: 200000, modelLabel: 'target', sourceSessionId: 'owner' }),
  snapshot: async job => { snapshots++; const id = `stage-${job.id}`; await copyFile(original, join(nativeRoot, `rollout-${id}.jsonl`)); return id },
  compact: async job => { compactions++; if (entered) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    await appendFile(join(nativeRoot, `rollout-${job.stagingNativeId}.jsonl`), checkpoint) },
  handoff: async () => { throw new Error('readable checkpoint should not invoke handoff') },
  validate: async () => { if (failValidation) throw new Error('disk export failed') },
  create: async job => { creates++; const id = `public-${job.id}`; created.set(job.id, id); return id },
  findCreated: job => created.get(job.id),
  retarget: (job, model) => ({ ...job.targetConfig, model })
}
const root = join(home, 'session-exports')
const jobs = new SessionForkJobs(root, deps, home)
const request = { sourceAgentId: 'codex', nativeId: 'source', targetAgentId: 'claude', targetModel: 'target' }
const plan = await jobs.preflight(request)
assert.equal(plan.reusable, false)
const started = await jobs.start(plan.planId)
assert.equal((await jobs.start(plan.planId)).id, started.id, 'duplicate start is idempotent')
await assert.rejects(jobs.wait(started.id), /disk export failed/)
assert.equal((await jobs.get(started.id))?.compacted, true)
assert.equal(compactions, 1)
assert.equal(creates, 0, 'failure before capacity confirmation publishes no target')
await appendFile(original, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'future source turn' }] } }) + '\n')
failValidation = false
const newModel = await jobs.retry(started.id, false, 'larger-target')
assert.equal(newModel.targetConfig.model, 'larger-target')
assert.notEqual(newModel.targetNativeId, started.targetNativeId, 'retargeting keeps source snapshot but reserves a new target identity')
await jobs.wait(started.id)
assert.equal(compactions, 1, 'retry export must reuse frozen checkpoint even after source advances')
assert.equal(snapshots, 1)
assert.equal(creates, 1)
assert.equal((await jobs.cancel(started.id)).status, 'completed', 'cancel cannot delete committed target')
assert.ok(!(await readFile(join(started.archivePath, 'context.json'), 'utf8')).includes('future source turn'))
const restored = new SessionForkJobs(root, deps, home)
assert.equal((await restored.get(started.id))?.targetSessionId, `public-${started.id}`)

const enteredPromise = new Promise<void>(resolve => { entered = resolve })
const second = await jobs.start((await jobs.preflight(request)).planId)
await enteredPromise
assert.equal((await jobs.cancel(second.id)).status, 'stopping')
release!()
await assert.rejects(jobs.wait(second.id), /停止/)
assert.equal((await jobs.get(second.id))?.status, 'cancelled')
assert.equal(creates, 1)
entered = undefined
await appendFile(original, checkpoint)
const reused = await jobs.preflight(request)
assert.equal(reused.reusable, true)
const third = await jobs.start(reused.planId)
await jobs.wait(third.id)
assert.equal(compactions, 2, 'fresh checkpoint skips native compaction')
assert.equal((await jobs.get(third.id))?.reusedCompaction, true)

const racedJobs = new SessionForkJobs(join(home, 'raced-exports'), { ...deps, snapshot: async job => {
  const id = await deps.snapshot(job)
  await appendFile(join(nativeRoot, `rollout-${id}.jsonl`), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'raced future content' }] } }) + '\n')
  return id
} }, home)
const raced = await racedJobs.start((await racedJobs.preflight(request)).planId)
await assert.rejects(racedJobs.wait(raced.id), /原生分叉期间发生变化/)
await racedJobs.retry(raced.id)
await assert.rejects(racedJobs.wait(raced.id), /快照尚未通过一致性检查/)
assert.equal(creates, 2, 'unverified native snapshots must never publish a target on retry')

let failNative!: () => void, enteredNative!: () => void
const nativeEntered = new Promise<void>(resolve => { enteredNative = resolve })
await appendFile(original, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'requires compact' }] } }) + '\n')
const uncertainJobs = new SessionForkJobs(join(home, 'uncertain-exports'), { ...deps, compact: async () => {
  enteredNative(); await new Promise<void>((_, reject) => { failNative = () => reject(new Error('原生请求超时')) })
} }, home)
const uncertain = await uncertainJobs.start((await uncertainJobs.preflight(request)).planId)
await nativeEntered
await uncertainJobs.cancel(uncertain.id)
failNative()
await assert.rejects(uncertainJobs.wait(uncertain.id), /停止尚未确认/)
assert.equal((await uncertainJobs.get(uncertain.id))?.status, 'failed', 'timeout cannot be presented as a confirmed cancellation')

// The public compatibility/cross APIs must route through compact jobs, not the legacy full-history translator.
const target = { ...agent, id: 'claude', models: [{ id: 'target', label: 'Target', efforts: [], contextWindow: 200000 }], defaultModel: 'target' } as AgentDef
const orchestrator = new Orchestrator(id => id === 'claude' ? target : agent, new SessionStore(join(home, 'sessions.json')))
let routed: any
Object.defineProperty(orchestrator, 'forkJobs', { value: {
  preflight: async (request: unknown) => { routed = request; return { planId: 'prepared' } },
  start: async () => ({ id: 'job' }), wait: async () => ({ targetSessionId: 'target-session' })
} })
await orchestrator.exportNativeSession('codex', 'native-source', 'claude')
assert.deepEqual(routed, { sourceAgentId: 'codex', nativeId: 'native-source', targetAgentId: 'claude', targetModel: 'target', point: undefined })
orchestrator.disposeAll()
// SessionStore normalization/project resolution cannot discard access to the exported archive.
const archiveStore = new SessionStore(join(home, 'archive-sessions.json'), config => ({ ...config, additionalDirectories: [] }))
const forked = { id: 'fork-owner', config: { ...config, agentId: 'claude' }, title: 'fork', status: 'idle', createdAt: 1, updatedAt: 1,
  nativeSessionId: 'target-native', forkedFrom: { agentId: 'codex', nativeId: 'source', mode: 'cross', exportId: 'saved-export' } } as Session
archiveStore.save([forked])
assert.equal(archiveStore.load()[0].forkedFrom?.exportId, 'saved-export')
const restoredOwner = new Orchestrator(id => id === 'claude' ? target : agent, archiveStore, join(home, 'artifacts'))
await restoredOwner.loadPersisted()
assert.deepEqual(restoredOwner.listSessions()[0].config.additionalDirectories, [join(home, 'session-exports/saved-export')])
await assert.rejects(restoredOwner.forkJobs.preflight({ ...request, targetAgentId: 'codex' }), /请先将来源会话导入/, 'Codex targets pass the capability gate and proceed to source validation')
restoredOwner.disposeAll()
for (const [sourceAgentId, targetAgentId] of [['codex', 'traex'], ['traex', 'codex']]) {
  const sourceRoot = join(home, sourceAgentId === 'codex' ? '.codex' : '.trae/cli', 'sessions')
  await mkdir(sourceRoot, { recursive: true })
  const sourceId = `${sourceAgentId}-roundtrip`
  const sourceFile = join(sourceRoot, `rollout-${sourceId}.jsonl`)
  const nativeCheckpoint = sourceAgentId === 'traex' ? JSON.stringify({ type: 'history_mutation', payload: {
    version: 1, operation: 'replace', compaction_response_id: 'traex-native-receipt', items: JSON.parse(checkpoint).payload.replacement_history
  } }) + '\n' : checkpoint
  await writeFile(sourceFile, base + nativeCheckpoint)
  let published: string | undefined
  const roundtripJobs = new SessionForkJobs(join(home, `${sourceAgentId}-jobs`), { ...deps,
    prepare: async () => ({ source: { ...agent, id: sourceAgentId }, target: { ...agent, id: targetAgentId },
      sourceConfig: { ...config, agentId: sourceAgentId }, targetConfig: { ...config, agentId: targetAgentId }, contextWindow: 475000, modelLabel: 'Sol' }),
    snapshot: async job => { const id = `stage-${job.id}`; await copyFile(sourceFile, join(sourceRoot, `rollout-${id}.jsonl`)); return id },
    compact: async () => { throw new Error('fresh native checkpoint must be reused') },
    validate: async job => {
      await writeForkTarget({ home, agentId: targetAgentId, nativeId: job.targetNativeId, cwd: home, archive: job.archivePath, model: 'gpt-6.1-sol' })
      const loaded = await readForkContext({ home, agentId: targetAgentId, nativeId: job.targetNativeId })
      assert.ok(JSON.stringify(loaded.messages).includes('summary retains constraint'))
      assert.ok(!JSON.stringify(loaded.messages).includes('remember constraint'))
    },
    create: async () => published = `${sourceAgentId}-published`, findCreated: () => published
  }, home)
  const started = await roundtripJobs.start((await roundtripJobs.preflight({ sourceAgentId, nativeId: sourceId, targetAgentId, targetModel: 'gpt-6.1-sol' })).planId)
  assert.equal((await roundtripJobs.wait(started.id)).reusedCompaction, true)
  assert.equal(await readFile(sourceFile, 'utf8'), base + nativeCheckpoint, 'both directions leave the source native history untouched')
}
console.log('session-fork-jobs: passed (retry, cancel, reuse, persistence, isolation, public route)')
