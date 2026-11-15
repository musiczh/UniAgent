import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorktreeService } from '../src/main/worktreeService'
import { registerWorktreeArchiveIpc, WorktreeArchiveRuntime } from '../src/main/worktreeArchive'
import { TaskLifecycleService } from '../src/main/taskLifecycleService'
import { TaskLifecycleStore } from '../src/main/taskLifecycleStore'
import { ARCHIVE_CANCELLED, WORKTREE_ARCHIVE_IPC, type WorktreeArchiveReview } from '../src/shared/worktreeArchive'
import type { Session, UAEvent } from '../src/shared/types'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])).stdout.trim()
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const until = async (test: () => boolean) => { for (let i = 0; i < 500; i++) { if (test()) return; await tick() }; throw new Error('archive timeout') }
async function fixture(run: (value: { root: string; cwd: string; tree: NonNullable<Session['config']['worktree']>; service: WorktreeService; session: Session }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'worktree-archive-')), previous = process.env.UNIAGENT_USER_DATA
  process.env.UNIAGENT_USER_DATA = join(root, 'data'); await mkdir(process.env.UNIAGENT_USER_DATA)
  try {
    const cwd = join(root, 'repo'); await mkdir(cwd)
    await git(cwd, 'init', '-q', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid'); await git(cwd, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(cwd, 'base.txt'), 'base'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'base')
    const service = new WorktreeService(), project = { id: randomUUID(), name: 'Test', primaryDirectory: cwd, additionalDirectories: [], createdAt: 1, updatedAt: 1 }
    const tree = await service.create(await service.allocate(project, { mode: 'worktree', requestId: randomUUID() }))
    const session: Session = { id: 'task', title: '归档任务', createdAt: 1, status: 'idle', nativeSessionId: 'original-thread',
      config: { agentId: 'codex', permissionMode: 'ask', workdir: tree.workdir, worktree: tree },
      submittedUserMessages: [{ type: 'user_message', userOrdinal: 1, acceptedAt: 1, textHash: 'initial' }] }
    await run({ root, cwd, tree, service, session })
  } finally { if (previous === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = previous; await rm(root, { recursive: true, force: true }) }
}

await test('archive inspection counts Git state without changing refs, index or files', () => fixture(async ({ cwd, tree, service }) => {
  const initial = await service.inspectArchive(tree)
  assert.deepEqual(initial, { treeId: tree.id, sourceBranch: 'main', changedFiles: 0, unmergedCommits: 0 })
  await writeFile(join(tree.workdir, 'task.txt'), 'task'); await git(tree.workdir, 'add', 'task.txt'); await git(tree.workdir, 'commit', '-qm', 'task')
  await git(tree.workdir, 'mv', 'base.txt', 'renamed.txt')
  await mkdir(join(tree.workdir, 'drafts')); await writeFile(join(tree.workdir, 'drafts', 'a\nb.txt'), 'draft')
  const index = await git(tree.workdir, 'rev-parse', '--git-path', 'index'), beforeIndex = await readFile(index), refs = await git(cwd, 'show-ref')
  const pending = await service.inspectArchive(tree)
  assert.equal(pending.changedFiles, 2, 'rename is one file; untracked paths with newline are counted correctly')
  assert.equal(pending.unmergedCommits, 1)
  assert.deepEqual(await readFile(index), beforeIndex, 'status cannot refresh the index')
  assert.equal(await git(cwd, 'show-ref'), refs)
  assert.equal(await readFile(join(tree.workdir, 'drafts', 'a\nb.txt'), 'utf8'), 'draft')
  await writeFile(join(cwd, 'source.txt'), 'source'); await git(cwd, 'add', 'source.txt'); await git(cwd, 'commit', '-qm', 'source')
  assert.equal((await service.inspectArchive(tree)).unmergedCommits, 1, 'divergent source must not conceal task commits')
  await git(cwd, 'merge', '--no-edit', tree.branch!)
  assert.equal((await service.inspectArchive(tree)).unmergedCommits, 0)
  await git(cwd, 'switch', '-qc', 'other'); await git(cwd, 'branch', '-D', 'main')
  await assert.rejects(service.inspectArchive(tree))
}))

await test('an unresolved Git merge remains pending for the Agent to handle', () => fixture(async ({ cwd, tree, service }) => {
  for (const [directory, text] of [[cwd, 'source change'], [tree.workdir, 'task change']]) {
    await writeFile(join(directory, 'base.txt'), text); await git(directory, 'add', 'base.txt'); await git(directory, 'commit', '-qm', text)
  }
  await assert.rejects(git(tree.workdir, 'merge', '--no-edit', 'main'))
  const head = await git(tree.workdir, 'rev-parse', 'HEAD'), status = await git(tree.workdir, 'status', '--porcelain')
  const result = await service.inspectArchive(tree)
  assert.equal(result.gitOperation, 'MERGE_HEAD'); assert.equal(result.changedFiles, 1); assert.equal(result.unmergedCommits, 1)
  assert.equal(await git(tree.workdir, 'rev-parse', 'HEAD'), head); assert.equal(await git(tree.workdir, 'status', '--porcelain'), status)
}))

await test('archive lifecycle sends one original-task message and waits for actual clean Git state', () => fixture(async ({ root, cwd, tree, service, session }) => {
  await writeFile(join(tree.workdir, 'draft.txt'), 'draft')
  let views: WorktreeArchiveReview[] = [], turn = 'first', sends = 0, reserved = false, failSend = false
  const events = (type: UAEvent['type'], payload: Record<string, unknown> = {}, state: UAEvent['state'] = 'success'): UAEvent => ({ sessionId: session.id, seq: 2, ts: 2, type, payload, state })
  const runtime = new WorktreeArchiveRuntime({
    session: id => id === session.id ? session : undefined, busy: () => session.status === 'running', turnRevision: () => turn,
    publish: value => { views = value }, send: async (target, prompt, inputId) => {
      assert.equal(reserved, false, 'archive must release mutation reservation before sending to the Agent')
      if (failSend) throw new Error('provider unavailable')
      assert.equal(target, session); assert.equal(target.nativeSessionId, 'original-thread')
      assert.match(prompt, /提交.*合并回.*本机源分支/); assert.match(prompt, /处理冲突/)
      assert.match(prompt, /`git --no-optional-locks status --porcelain --untracked-files=no`/)
      assert.match(prompt, /有输出即停止.*其他 Session.*稍后/)
      assert.match(prompt, /不得 stash、代提交、reset\/clean 或覆盖源改动/)
      sends++; session.status = 'running'
      session.submittedUserMessages!.push({ type: 'user_message', userOrdinal: sends + 1, acceptedAt: sends + 1, textHash: inputId })
      runtime.observe(events('user_message', { text: prompt, routedInputId: inputId }))
    }
  }, service)
  const store = new TaskLifecycleStore(join(root, 'lifecycle')); await store.hydrate([session])
  const lifecycle = new TaskLifecycleService(store, { session: () => session, busy: () => session.status === 'running', pending: () => 0, turnRevision: () => turn,
    reserve: () => { assert.equal(reserved, false); reserved = true; return () => { reserved = false } }, mirrorArchive: (_, value) => { session.archived = value; return session }, publish: () => {}, beforeArchive: s => runtime.prepare(s) })
  const snapshot = lifecycle.snapshot(session.id)
  const input = { actionId: 'finish', expectedVersion: snapshot.record.version, inputRevision: snapshot.inputRevision, turnRevision: snapshot.turnRevision, disposition: 'archive' as const }
  let finished = false
  const archive = lifecycle.decide(session.id, input).then(result => { finished = true; return result })
  await until(() => views[0]?.phase === 'pending')
  assert.equal(session.archived, undefined); assert.equal(sends, 0)
  const action = { id: views[0].id, version: views[0].version, action: 'merge' as const }
  await Promise.all([runtime.act(action), runtime.act(action)])
  assert.equal(sends, 1); assert.equal(views[0].phase, 'waiting'); assert.equal(finished, false)
  turn = 'claimed-done'; session.status = 'idle'; runtime.observe(events('turn_completed')); runtime.wake()
  await until(() => views[0]?.phase === 'pending')
  assert.equal(finished, false, 'an Agent completion without a real merge cannot archive')
  failSend = true
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'merge' })
  assert.equal(views[0].phase, 'failed'); assert.match(views[0].error!, /provider unavailable/)
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'retry' }); failSend = false
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'merge' })
  await git(tree.workdir, 'add', 'draft.txt'); await git(tree.workdir, 'commit', '-qm', 'keep draft'); await git(cwd, 'merge', '--no-edit', tree.branch!)
  turn = 'merged'; session.status = 'idle'; runtime.observe(events('turn_completed')); runtime.wake()
  assert.equal((await archive).record.phase, 'archived'); assert.equal(session.archived, true)
  const version = lifecycle.snapshot(session.id).record.version
  await lifecycle.decide(session.id, input)
  assert.equal(lifecycle.snapshot(session.id).record.version, version, 'same archive action remains idempotent after the merge round')
  await lifecycle.archive(session.id, false)
  await writeFile(join(tree.workdir, 'next-draft.txt'), 'keep')
  const normalArchive = lifecycle.archive(session.id, true).catch(error => String(error))
  await until(() => views[0]?.phase === 'pending')
  assert.equal(session.archived, false, 'Session/menu archive uses the same backend check')
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'cancel' })
  assert.match(await normalArchive as string, new RegExp(ARCHIVE_CANCELLED))
  runtime.close()
}))

await test('cancel, new input, failed inspection, late checks and shared worktrees retain the task', () => fixture(async ({ tree, service, session }) => {
  await writeFile(join(tree.workdir, 'draft.txt'), 'draft')
  let views: WorktreeArchiveReview[] = [], inspections = 0, related = [session, { ...session, id: 'member' }], silentSend = false
  const inspect = service.inspectArchive.bind(service)
  service.inspectArchive = async (...args) => { inspections++; return inspect(...args) }
  const runtime = new WorktreeArchiveRuntime({ session: () => session, related: () => related, busy: () => false,
    publish: value => { views = value }, send: async () => { if (!silentSend) throw new Error('unexpected send') } }, service)
  const handlers = new Map<string, (...args: any[]) => any>(), sender = { trusted: true }
  let hydrated = 0
  registerWorktreeArchiveIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, runtime, { trusted: event => { assert.equal(event, sender) }, hydrate: async () => { hydrated++ } })
  assert.deepEqual(await handlers.get(WORKTREE_ARCHIVE_IPC.list)!(sender), [], 'list IPC accepts no Session id')
  await assert.rejects(handlers.get(WORKTREE_ARCHIVE_IPC.list)!({}), /equal/)
  const start = () => runtime.prepare(session).then(() => 'archived', error => String(error))
  let pending = start(); await until(() => views[0]?.phase === 'pending')
  assert.equal(inspections, 1, 'team members sharing one worktree are checked once')
  await handlers.get(WORKTREE_ARCHIVE_IPC.act)!(sender, { id: views[0].id, version: views[0].version, action: 'cancel' })
  assert.equal(hydrated, 2, 'IPC checks the sender and hydration before applying the structured action')
  assert.match(await pending, new RegExp(ARCHIVE_CANCELLED)); assert.equal(views.length, 0)
  pending = start(); await until(() => views[0]?.phase === 'pending')
  runtime.observe({ sessionId: session.id, seq: 9, ts: 9, type: 'user_message', state: 'success', payload: { text: 'continue task' } })
  assert.match(await pending, new RegExp(ARCHIVE_CANCELLED))
  service.inspectArchive = async () => { throw new Error('Git unavailable') }
  pending = start(); await until(() => views[0]?.phase === 'failed'); assert.match(views[0].error!, /Git unavailable/)
  service.inspectArchive = inspect
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'retry' }); assert.equal(views[0].phase, 'pending')
  silentSend = true
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'merge' })
  assert.equal(views[0].phase, 'failed'); assert.match(views[0].error!, /尚未确认接受合并消息/)
  runtime.remove(session.id); assert.match(await pending, new RegExp(ARCHIVE_CANCELLED)); assert.equal(session.archived, undefined)
  let finish!: () => void
  service.inspectArchive = async () => { await new Promise<void>(resolve => { finish = resolve }); return { treeId: tree.id, changedFiles: 0, unmergedCommits: 0, sourceBranch: 'main' } }
  pending = start(); await until(() => !!finish)
  await runtime.act({ id: views[0].id, version: views[0].version, action: 'cancel' }); finish(); await tick()
  assert.match(await pending, new RegExp(ARCHIVE_CANCELLED)); assert.equal(views.length, 0, 'late clean result cannot restore an archive intent')
  related = [{ ...session, config: { ...session.config, worktree: undefined } }]
  assert.equal(await runtime.prepare(session), undefined, 'ordinary directories skip the worktree check')
  runtime.close(); await assert.rejects(runtime.prepare(session), new RegExp(ARCHIVE_CANCELLED))
}))

await test('original Session durable delivery accepts the merge request before a verified archive', () => fixture(async ({ root, cwd, tree, service }) => {
  const agent = { id: 'codex', name: 'Codex', adapter: 'codex' as const, bin: '/usr/bin/true', builtin: true, installed: true, icon: '', models: [], capabilities: { streaming: true, permissionModes: [{ id: 'ask' as const, label: '询问' }] } }
  const host = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'), join(root, 'logs'))
  const { session } = (host as any).createSessionRecord({ agentId: 'codex', projectId: tree.projectId, workdir: tree.workdir, worktree: tree, permissionMode: 'ask' }, '归档任务')
  session.status = 'idle'; session.nativeSessionId = 'original-native-thread'
  let views: WorktreeArchiveReview[] = [], runs = 0
  const runtime = new WorktreeArchiveRuntime({ session: id => host.getSessionById(id), busy: id => host.hasActiveSessionWork(id), publish: value => { views = value },
    send: (target, prompt, inputId) => host.sendMessage(target.id, prompt, undefined, undefined, false, { routedInputId: inputId }) }, service)
  host.on('event', event => runtime.observe(event)); host.on('taskTitleInputRecorded', event => runtime.observe(event)); host.on('statusChange', () => runtime.wake())
  ;(host as any).runStreaming = (target: Session, _agent: unknown, prompt: string) => {
    runs++; assert.equal(target, session); assert.equal(target.nativeSessionId, 'original-native-thread'); assert.match(prompt, /工作树绑定/)
    void (async () => {
      await git(tree.workdir, 'add', 'draft.txt'); await git(tree.workdir, 'commit', '-qm', 'Agent commit'); await git(cwd, 'merge', '--no-edit', tree.branch!)
      ;(host as any).record(target.id, { type: 'turn_completed', state: 'success', payload: {} }); (host as any).afterTurn(target)
    })()
  }
  try {
    await writeFile(join(tree.workdir, 'draft.txt'), 'draft')
    const pending = runtime.prepare(session)
    await until(() => views[0]?.phase === 'pending')
    await runtime.act({ id: views[0].id, version: views[0].version, action: 'merge' })
    const permit = await pending
    permit!.assertCurrent()
    assert.equal(runs, 1)
    assert.equal(session.submittedUserMessages.length, 1)
    assert.ok(session.submittedUserMessages[0].routedInputId, 'merge input is recorded durably on the original task')
    assert.equal(session.pendingQueue?.length || 0, 0)
    assert.equal((await service.inspectArchive(tree)).unmergedCommits, 0)
  } finally { runtime.close(); await host.closeSessionLogs() }
}))
