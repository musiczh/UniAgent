import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore, SessionStoreWriteError } from '../src/main/sessionStore'
import type { AgentDef, Session, UAEvent } from '../src/shared/types'

/**
 * 需求3（会话节点回退）— commitRewind atomicity + empty-artifact rewind node.
 *
 * These exercise the orchestrator layer (not just the store): a persistence
 * failure during the session swap must leave the in-memory session, its events,
 * its seq ref AND its live streamer exactly as they were (old runner still
 * usable), and the on-disk store must be restored to the original native id.
 */

function streamingAgent(id: string): AgentDef {
  return {
    id,
    name: id,
    bin: '/usr/bin/true',
    adapter: 'codex',
    icon: '',
    builtin: false,
    installed: true,
    capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [], streaming: true },
    models: []
  }
}

async function fixture(): Promise<{
  orchestrator: Orchestrator
  store: SessionStore
  storePath: string
  artRoot: string
  work: string
  session: Session
  base: string
}> {
  const baseDir = await mkdtemp(join(tmpdir(), 'uniagent-rewind-commit-'))
  const storePath = join(baseDir, 'sessions.json')
  const artRoot = join(baseDir, 'artifacts')
  const work = join(baseDir, 'work')
  await mkdir(work, { recursive: true })
  const store = new SessionStore(storePath)
  const session: Session = {
    id: 's1',
    title: 's1',
    config: { agentId: 'codex', workdir: work },
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nativeSessionId: 'orig-thread',
    origin: 'created',
    readOnly: false
  }
  store.save([session])
  const orchestrator = new Orchestrator((id) => (id === 'codex' ? streamingAgent('codex') : undefined), store, artRoot)
  orchestrator.loadPersisted()
  return { orchestrator, store, storePath, artRoot, work, session: orchestrator.getSessionById('s1')!, base: baseDir }
}

/** Seed one turn's captured events + a finalized artifact so rewind has a node. */
async function seedTurn(
  orchestrator: Orchestrator,
  work: string,
  turnId: string,
  userText: string,
  unifiedDiff: string
): Promise<void> {
  const events: UAEvent[] = (orchestrator as any).events.get('s1') || []
  const ref: { n: number } = (orchestrator as any).seqRefs.get('s1') || { n: 0 }
  ;(orchestrator as any).events.set('s1', events)
  ;(orchestrator as any).seqRefs.set('s1', ref)
  events.push({ sessionId: 's1', seq: ref.n++, ts: Date.now(), type: 'user_message', payload: { text: userText } })
  events.push({ sessionId: 's1', seq: ref.n++, ts: Date.now(), type: 'turn_started', payload: { turnId, threadId: 'orig-thread' } })
  await (orchestrator as any).artifacts.finalize({
    sessionId: 's1', nativeThreadId: 'orig-thread', nativeTurnId: turnId,
    startSeq: 0, endSeq: ref.n, startedAt: 1, completedAt: 2, unifiedDiff, workdir: work
  })
}

function fileDiff(path: string, before: string, after: string, kind: 'add' | 'modify' = 'modify'): string {
  const bl = before === '' ? [] : before.split('\n')
  const al = after === '' ? [] : after.split('\n')
  const a = kind === 'add' ? '/dev/null' : `a/${path}`
  const head = `diff --git a/${path} b/${path}\n--- ${a}\n+++ b/${path}\n`
  const hunk = `@@ -1,${bl.length} +1,${al.length} @@\n`
  const body = [...bl.map((l) => `-${l}`), ...al.map((l) => `+${l}`)].join('\n')
  return head + hunk + body
}

// 1. persistOrThrow failure during commit → session/events/seqRef/runner intact,
//    files rolled back, on-disk store restored to the original native id.
async function persistFailureIsAtomic(): Promise<void> {
  const fx = await fixture()
  try {
    const f = join(fx.work, 'a.ts')
    await writeFile(f, 'v1')
    await seedTurn(fx.orchestrator, fx.work, 't1', 'first turn', fileDiff('a.ts', '', 'v1', 'add'))
    await writeFile(f, 'v2')
    await seedTurn(fx.orchestrator, fx.work, 't2', 'second turn', fileDiff('a.ts', 'v1', 'v2'))

    // Install a live streamer stub so we can prove ownership survives a failure.
    const oldStreamer = { forkBeforeTurn: async () => 'fork-thread', removeAllListeners() {}, dispose() {}, interrupt() {} }
    ;(fx.orchestrator as any).streamers.set('s1', oldStreamer)
    // Fork returns a new thread; forked history loads fine.
    ;(fx.orchestrator as any).loadForkedEvents = async () => ({ events: [
      { sessionId: 's1', seq: 0, ts: 1, type: 'user_message', payload: { text: 'first turn' } }
    ] })
    // But persistence of the new native id throws.
    ;(fx.orchestrator as any).persistOrThrow = () => { throw new Error('disk full') }

    const eventsBefore = (fx.orchestrator as any).events.get('s1')
    const refBefore = (fx.orchestrator as any).seqRefs.get('s1')

    const res = await fx.orchestrator.rewindSession('s1', 't2')
    assert.equal(res.ok, false)
    assert.match((res as any).error, /回退持久化失败/)

    // In-memory session unchanged.
    const s = fx.orchestrator.getSessionById('s1')!
    assert.equal(s.nativeSessionId, 'orig-thread', 'native id must be rolled back')
    assert.equal(s.status, 'idle')
    // Events + seq ref objects are the SAME instances (never swapped).
    assert.equal((fx.orchestrator as any).events.get('s1'), eventsBefore, 'events buffer must be untouched')
    assert.equal((fx.orchestrator as any).seqRefs.get('s1'), refBefore, 'seq ref must be untouched')
    // Old runner still owned (not disposed).
    assert.equal((fx.orchestrator as any).streamers.get('s1'), oldStreamer, 'old runner must stay usable')
    // Files restored to pre-rewind content.
    assert.equal(readFileSync(f, 'utf8'), 'v2', 'file transaction must be rolled back')
    // On-disk store restored to the original native id.
    const persisted = JSON.parse(readFileSync(fx.storePath, 'utf8'))
    assert.equal(persisted[0].nativeSessionId, 'orig-thread', 'store must be re-persisted with old native id')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
}

// 2. A post-rename durability error means the new store contents are already
//    visible, so commitRewind must finish the in-memory switch to the fork.
async function committedDurabilityUncertainCompletesSwitch(): Promise<void> {
  const fx = await fixture()
  try {
    const f = join(fx.work, 'committed.ts')
    await writeFile(f, 'v1')
    await seedTurn(fx.orchestrator, fx.work, 't1', 'first turn', fileDiff('committed.ts', '', 'v1', 'add'))
    await writeFile(f, 'v2')
    await seedTurn(fx.orchestrator, fx.work, 't2', 'second turn', fileDiff('committed.ts', 'v1', 'v2'))

    let removedListeners = 0
    let disposed = 0
    const oldStreamer = {
      forkBeforeTurn: async () => 'fork-thread',
      removeAllListeners: () => { removedListeners += 1 },
      dispose: () => { disposed += 1 },
      interrupt() {}
    }
    ;(fx.orchestrator as any).streamers.set('s1', oldStreamer)
    ;(fx.orchestrator as any).loadForkedEvents = async () => ({ events: [
      { sessionId: 'native-fork', seq: 41, ts: 1, type: 'user_message', payload: { text: 'first turn' } },
      { sessionId: 'native-fork', seq: 42, ts: 2, type: 'assistant_message', payload: { text: 'first reply' } }
    ] })

    let persistAttempts = 0
    ;(fx.orchestrator as any).persistOrThrow = () => {
      persistAttempts += 1
      fx.store.saveOrThrow([fx.orchestrator.getSessionById('s1')!])
      throw new SessionStoreWriteError(
        'directory fsync failed after rename',
        'committed-durability-uncertain',
        new Error('fsync directory')
      )
    }

    const eventsBefore = (fx.orchestrator as any).events.get('s1')
    const refBefore = (fx.orchestrator as any).seqRefs.get('s1')
    const res = await fx.orchestrator.rewindSession('s1', 't2')

    assert.equal(res.ok, true, (res as any).error)
    assert.equal((res as any).prefillText, 'second turn')
    assert.equal(persistAttempts, 1)

    const session = fx.orchestrator.getSessionById('s1')!
    assert.equal(session.nativeSessionId, 'fork-thread', 'memory must follow the visible committed store')
    assert.equal(session.status, 'idle')
    const persisted = JSON.parse(readFileSync(fx.storePath, 'utf8'))
    assert.equal(persisted[0].nativeSessionId, 'fork-thread', 'disk already contains the forked identity')

    const eventsAfter = (fx.orchestrator as any).events.get('s1') as UAEvent[]
    const refAfter = (fx.orchestrator as any).seqRefs.get('s1') as { n: number }
    assert.notEqual(eventsAfter, eventsBefore, 'forked history must replace the old event buffer')
    assert.notEqual(refAfter, refBefore, 'forked history must replace the old seq ref')
    assert.deepEqual(eventsAfter.map((event) => [event.sessionId, event.seq]), [['s1', 0], ['s1', 1]])
    assert.equal(refAfter.n, 2)

    assert.equal((fx.orchestrator as any).streamers.has('s1'), false, 'old runner ownership must be released')
    assert.equal(removedListeners, 1)
    assert.equal(disposed, 1)
    assert.equal(readFileSync(f, 'utf8'), 'v1', 'successful rewind must retain the restored file state')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
}

// 3. A turn with NO file changes is still a valid rewind node: preview/apply work
//    and removeTurnIds is correct.
async function emptyArtifactIsRewindNode(): Promise<void> {
  const fx = await fixture()
  try {
    // t1 has no file diff; t2 modifies a file.
    await seedTurn(fx.orchestrator, fx.work, 't1', 'no-op turn', '')
    const f = join(fx.work, 'b.ts')
    await writeFile(f, 'x1')
    await seedTurn(fx.orchestrator, fx.work, 't2', 'edit turn', fileDiff('b.ts', '', 'x1', 'add'))

    // Empty artifact stored as a valid node.
    const t1summary = await fx.orchestrator.getTurnArtifactSummary('s1', 't1')
    assert.ok(t1summary, 't1 artifact must exist even with no file changes')
    assert.deepEqual(t1summary!.files, [])

    // Preview rewind to t1: removes t1 + t2, allowed (only t2 touches files).
    const preview = await fx.orchestrator.previewSessionRewind('s1', 't1')
    assert.equal(preview.allowed, true, preview.reason)
    assert.deepEqual(preview.removeTurnIds, ['t1', 't2'])

    // Apply to t2 (the empty-node predecessor kept): only b.ts removed.
    ;(fx.orchestrator as any).streamers.set('s1', { forkBeforeTurn: async () => 'fork-thread', removeAllListeners() {}, dispose() {}, interrupt() {} })
    ;(fx.orchestrator as any).loadForkedEvents = async () => ({ events: [] })
    const res = await fx.orchestrator.rewindSession('s1', 't2')
    assert.equal(res.ok, true, (res as any).error)
    assert.equal((res as any).prefillText, 'edit turn')
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(f), false, 'file added in t2 must be removed')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
}

// 4. Turn review preserves trusted artifact states instead of collapsing binary
// and oversized snapshots into the generic patch-only fallback.
async function specialSnapshotStatesReachReview(): Promise<void> {
  const fx = await fixture()
  try {
    await writeFile(join(fx.work, 'image.bin'), Buffer.from([1, 0, 2]))
    await writeFile(join(fx.work, 'huge.txt'), 'x'.repeat(1.5 * 1024 * 1024 + 1))
    const diff = [
      'diff --git a/image.bin b/image.bin',
      'Binary files a/image.bin and b/image.bin differ',
      'diff --git a/huge.txt b/huge.txt',
      'index 1111111..2222222 100644'
    ].join('\n')
    await (fx.orchestrator as any).artifacts.finalize({
      sessionId: 's1', nativeThreadId: 'orig-thread', nativeTurnId: 't-special',
      startSeq: 0, endSeq: 1, startedAt: 1, completedAt: 2, unifiedDiff: diff, workdir: fx.work
    })

    const binary = await fx.orchestrator.reviewGetFilePair({
      sessionId: 's1', path: 'image.bin', unifiedDiff: '', kind: 'modify',
      scope: { kind: 'turn', turnId: 't-special' }
    })
    assert.equal(binary.binary, true)
    assert.equal(binary.degraded, undefined)

    const huge = await fx.orchestrator.reviewGetFilePair({
      sessionId: 's1', path: 'huge.txt', unifiedDiff: '', kind: 'modify',
      scope: { kind: 'turn', turnId: 't-special' }
    })
    assert.equal(huge.tooLarge, true)
    assert.equal(huge.degraded, undefined)
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
}

await persistFailureIsAtomic()
await committedDurabilityUncertainCompletesSwitch()
await emptyArtifactIsRewindNode()
await specialSnapshotStatesReachReview()
console.log('orchestrator-rewind-commit: all assertions passed')
