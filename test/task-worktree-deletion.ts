import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Orchestrator } from '../src/main/orchestrator'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { SessionStore } from '../src/main/sessionStore'
import { WorktreeService } from '../src/main/worktreeService'
import type { AgentDef, Project, Session, SessionWorktree } from '../src/shared/types'

const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'task-worktree-deletion-'))
const previousData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])).stdout.trim()
const agent: AgentDef = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', installed: true, builtin: true, icon: '', models: [], capabilities: { streaming: true, modelSelect: false, reasoningEffort: false, permissionModes: [{ id: 'ask', label: '询问' }] } }
const runtime = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'), join(root, 'logs'))
const service = new WorktreeService()
async function fixture() {
  const cwd = join(root, randomUUID()); await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid'); await git(cwd, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, 'code.txt'), 'base\n'); await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n')
  await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'base')
  const project: Project = { id: randomUUID(), name: 'Test', primaryDirectory: cwd, additionalDirectories: [], createdAt: 0, updatedAt: 0 }
  const tree = await service.create(await service.allocate(project, { mode: 'worktree', requestId: randomUUID() }))
  const session = (worktree: SessionWorktree = tree): Session => (runtime as any).createSessionRecord({ agentId: 'codex', projectId: project.id, workdir: worktree.workdir, worktree, permissionMode: 'ask' }, '任务').session
  return { cwd, tree, project, session }
}
try {
  const cancelled = await fixture(), cancelledSession = cancelled.session()
  await assert.rejects(runtime.previewSessionDeletion(cancelledSession.id, AbortSignal.abort()), { name: 'AbortError' })
  const fakeBin = join(root, 'cancel-check-bin'), marker = join(root, 'cancel-check-pid')
  await mkdir(fakeBin)
  const fakeGit = join(fakeBin, 'git')
  await writeFile(fakeGit, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)\n`)
  await chmod(fakeGit, 0o755)
  const previousPath = process.env.PATH
  const controller = new AbortController()
  try {
    process.env.PATH = fakeBin + ':' + previousPath
    const inspection = runtime.previewSessionDeletion(cancelledSession.id, controller.signal)
    const rejected = assert.rejects(inspection, { name: 'AbortError' })
    for (let attempt = 0; !existsSync(marker) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(existsSync(marker), 'the cancellable check starts a real owned child process')
    const pid = Number(await readFile(marker, 'utf8'))
    controller.abort()
    await rejected
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.throws(() => process.kill(pid, 0), 'interrupting inspection terminates its Git child process')
    assert.equal(runtime.getSessionById(cancelledSession.id), cancelledSession)
    assert.ok(existsSync(cancelled.tree.checkoutRoot), 'inspection cancellation never deletes files')
  } finally { controller.abort(); process.env.PATH = previousPath }

  const clean = await fixture(), first = clean.session()
  await runtime.deleteSession(first.id)
  assert.equal(existsSync(clean.tree.checkoutRoot), false, 'deleting the last task removes its managed checkout')
  assert.equal(runtime.getSessionById(first.id), undefined)
  assert.equal(existsSync(dirname(clean.tree.checkoutRoot)), false, 'sync metadata container is cleaned')
  assert.ok(await git(clean.cwd, 'rev-parse', 'refs/heads/' + clean.tree.branch), 'task branch remains recoverable')
  assert.equal(await readFile(join(clean.cwd, 'code.txt'), 'utf8'), 'base\n')
  assert.ok(!(await git(clean.cwd, 'worktree', 'list', '--porcelain')).includes(clean.tree.checkoutRoot))

  const dirty = await fixture(), second = dirty.session()
  await writeFile(join(dirty.tree.checkoutRoot, 'code.txt'), 'staged\n'); await git(dirty.tree.checkoutRoot, 'add', 'code.txt')
  await writeFile(join(dirty.tree.checkoutRoot, 'code.txt'), 'unstaged\n'); await writeFile(join(dirty.tree.checkoutRoot, 'new.txt'), 'untracked\n'); await writeFile(join(dirty.tree.checkoutRoot, 'ignored.txt'), 'ignored\n')
  await assert.rejects(runtime.deleteSession(second.id), /未提交|未跟踪/)
  assert.equal(runtime.getSessionById(second.id), second, 'unconfirmed deletion keeps the task and files')
  const preview = await runtime.previewSessionDeletion(second.id)
  assert.equal(preview.worktrees[0].dirty, true)
  await assert.rejects(runtime.deleteSession(second.id, randomUUID()), /重新确认/)
  await runtime.deleteSession(second.id, preview.confirmationId)
  assert.equal(existsSync(dirty.tree.checkoutRoot), false)

  const shared = await fixture(), owner = shared.session(), other = shared.session()
  other.archived = true
  await writeFile(join(shared.tree.checkoutRoot, 'code.txt'), 'shared draft\n')
  const sharedPreview = await runtime.previewSessionDeletion(owner.id)
  assert.equal(sharedPreview.worktrees[0].sharedCount, 1)
  await runtime.deleteSession(owner.id, sharedPreview.confirmationId)
  assert.equal(await readFile(join(shared.tree.checkoutRoot, 'code.txt'), 'utf8'), 'shared draft\n')
  const lastPreview = await runtime.previewSessionDeletion(other.id)
  assert.equal(lastPreview.worktrees[0].dirty, true)
  await runtime.deleteSession(other.id, lastPreview.confirmationId)
  assert.equal(existsSync(shared.tree.checkoutRoot), false)

  const changed = await fixture(), changedSession = changed.session()
  const stale = await runtime.previewSessionDeletion(changedSession.id)
  await writeFile(join(changed.tree.checkoutRoot, 'new.txt'), 'late change\n')
  await assert.rejects(runtime.deleteSession(changedSession.id, stale.confirmationId), /重新确认/)
  assert.ok(existsSync(changed.tree.checkoutRoot))
  assert.equal(runtime.getSessionById(changedSession.id), changedSession)

  const locked = await fixture(), lockedSession = locked.session()
  await git(locked.cwd, 'worktree', 'lock', locked.tree.checkoutRoot)
  await assert.rejects(runtime.previewSessionDeletion(lockedSession.id), /锁定/)
  await assert.rejects(runtime.deleteSession(lockedSession.id), /锁定/)
  assert.ok(existsSync(locked.tree.checkoutRoot))
  assert.equal(runtime.getSessionById(lockedSession.id), lockedSession)

  const ignored = await fixture(), ignoredSession = ignored.session()
  await writeFile(join(ignored.tree.checkoutRoot, 'ignored.txt'), 'ignored build output')
  const ignoredPreview = await runtime.previewSessionDeletion(ignoredSession.id)
  assert.equal(ignoredPreview.worktrees[0].dirty, false)
  await runtime.deleteSession(ignoredSession.id, ignoredPreview.confirmationId)
  assert.equal(existsSync(ignored.tree.checkoutRoot), false, 'the confirmation also covers ignored files')

  const newOwner = await fixture(), initialOwner = newOwner.session()
  const beforeSharing = await runtime.previewSessionDeletion(initialOwner.id)
  const addedOwner = newOwner.session()
  await assert.rejects(runtime.deleteSession(initialOwner.id, beforeSharing.confirmationId), /重新确认/)
  assert.equal(runtime.getSessionById(addedOwner.id), addedOwner)
  assert.ok(existsSync(newOwner.tree.checkoutRoot))

  const gitBusy = await fixture(), gitBusySession = gitBusy.session()
  const beforeOperation = await runtime.previewSessionDeletion(gitBusySession.id)
  const indexLock = await git(gitBusy.tree.checkoutRoot, 'rev-parse', '--git-path', 'index.lock')
  await writeFile(indexLock, '')
  await assert.rejects(runtime.deleteSession(gitBusySession.id, beforeOperation.confirmationId), /Git 操作/)
  assert.ok(existsSync(gitBusy.tree.checkoutRoot))

  const committed = await fixture(), committedSession = committed.session()
  await writeFile(join(committed.tree.checkoutRoot, 'code.txt'), 'committed task\n'); await git(committed.tree.checkoutRoot, 'add', 'code.txt'); await git(committed.tree.checkoutRoot, 'commit', '-qm', 'task')
  await runtime.deleteSession(committedSession.id)
  assert.equal(await git(committed.cwd, 'show', committed.tree.branch + ':code.txt'), 'committed task')
  assert.equal(await readFile(join(committed.cwd, 'code.txt'), 'utf8'), 'base\n', 'deletion never merges new code or changes the source checkout')

  const retry = await fixture(), retrySession = retry.session()
  const removeRecord = (runtime as any).deleteSessionRecord.bind(runtime)
  ;(runtime as any).deleteSessionRecord = async () => { throw new Error('native deletion unavailable') }
  await assert.rejects(runtime.deleteSession(retrySession.id), /native deletion unavailable/)
  assert.equal(runtime.getSessionById(retrySession.id), retrySession)
  assert.equal(existsSync(retry.tree.checkoutRoot), false)
  assert.ok(retrySession.config.worktree!.removedAt)
  assert.throws(() => runtime.assertUserSessionEnabled(retrySession.id), /工作树已清理/)
  assert.doesNotThrow(() => runtime.assertUserSessionEnabled(retrySession.id, true), 'deletion retry remains allowed through the IPC guard')
  ;(runtime as any).deleteSessionRecord = removeRecord
  const retried = await runtime.previewSessionDeletion(retrySession.id)
  assert.equal(retried.worktrees[0].removed, true)
  await runtime.deleteSession(retrySession.id, retried.confirmationId)
  assert.equal(runtime.getSessionById(retrySession.id), undefined)

  const saveFailure = await fixture(), saveFailureSession = saveFailure.session()
  const store = (runtime as any).store as SessionStore, save = store.saveOrThrow.bind(store)
  store.saveOrThrow = sessions => {
    if (!sessions.some(session => session.id === saveFailureSession.id)) throw new Error('任务记录写入失败')
    save(sessions)
  }
  await assert.rejects(runtime.deleteSession(saveFailureSession.id), /任务记录写入失败/)
  assert.equal(runtime.getSessionById(saveFailureSession.id), saveFailureSession)
  assert.equal(existsSync(saveFailure.tree.checkoutRoot), false)
  assert.ok(store.load().find(session => session.id === saveFailureSession.id)?.config.worktree?.removedAt, 'cleanup state remains durable when removing the record fails')
  store.saveOrThrow = save
  const afterSaveFailure = await runtime.previewSessionDeletion(saveFailureSession.id)
  await runtime.deleteSession(saveFailureSession.id, afterSaveFailure.confirmationId)
  assert.equal(runtime.getSessionById(saveFailureSession.id), undefined)

  const invalid = await fixture(), invalidSession = invalid.session({ ...invalid.tree, checkoutRoot: invalid.cwd, workdir: invalid.cwd })
  await assert.rejects(runtime.deleteSession(invalidSession.id), /目录绑定无效/)
  assert.equal(await readFile(join(invalid.cwd, 'code.txt'), 'utf8'), 'base\n', 'source directories cannot be supplied as managed checkouts')
  const escaped = invalid.session({ ...invalid.tree, projectId: '..', state: 'failed', checkoutRoot: join(root, invalid.tree.id, 'repo'), workdir: join(root, invalid.tree.id, 'repo') })
  await assert.rejects(runtime.deleteSession(escaped.id), /目录绑定无效/, 'project identifiers cannot escape the managed root')

  const protectedTree = await fixture(), protectedSession = protectedTree.session()
  runtime.configureWorktreeDeletion(() => [protectedTree.tree.workdir])
  await assert.rejects(runtime.deleteSession(protectedSession.id), /空间目录/)
  assert.ok(existsSync(protectedTree.tree.checkoutRoot))
  runtime.configureWorktreeDeletion(() => [])

  const team = await fixture(), leader = team.session(), member = team.session(), outsider = team.session()
  const teamId = randomUUID()
  leader.teamBinding = { teamProjectId: teamId, memberId: 'leader' }; member.teamBinding = { teamProjectId: teamId, memberId: 'member' }
  assert.equal((await runtime.previewSessionDeletion(outsider.id)).worktrees[0].sharedCount, 1, 'team members count as one other task in confirmation text')
  const teamPreview = await runtime.previewTeamDeletion(teamId, 'Team')
  assert.equal(teamPreview.team, true); assert.equal(teamPreview.worktrees.length, 1); assert.equal(teamPreview.worktrees[0].sharedCount, 1)
  await runtime.deleteTeamSessions(teamId, teamPreview.confirmationId)
  assert.equal(runtime.getSessionById(leader.id), undefined); assert.equal(runtime.getSessionById(member.id), undefined)
  assert.ok(existsSync(team.tree.checkoutRoot), 'an outside task retains a team checkout')
  await runtime.deleteSession(outsider.id)
  assert.equal(existsSync(team.tree.checkoutRoot), false)

  const worktreeRuntime = (runtime as any).worktreeRuntime
  const interrupt = runtime.interrupt.bind(runtime)

  const preparing = await fixture(), preparingSession = preparing.session()
  const prepare = worktreeRuntime.service.prepare.bind(worktreeRuntime.service)
  let releasePreparation!: () => void, enteredPreparation!: () => void, stoppedPreparation!: () => void
  const prepareGate = new Promise<void>(resolve => { releasePreparation = resolve }), prepareStarted = new Promise<void>(resolve => { enteredPreparation = resolve }), prepareStopped = new Promise<void>(resolve => { stoppedPreparation = resolve })
  worktreeRuntime.service.prepare = async (...args: unknown[]) => { enteredPreparation(); await prepareGate; return prepare(...args) }
  runtime.interrupt = id => { interrupt(id); if (id === preparingSession.id) stoppedPreparation() }
  const preparation = worktreeRuntime.prepare(preparingSession).catch(() => {})
  await prepareStarted
  let preparedDeleted = false
  const prepareDeletion = runtime.deleteSession(preparingSession.id).then(() => { preparedDeleted = true })
  await prepareStopped; await new Promise(resolve => setImmediate(resolve))
  assert.equal(preparedDeleted, false, 'deletion also waits for a source preparation already in progress')
  assert.ok(existsSync(preparing.tree.checkoutRoot))
  releasePreparation(); await preparation; await prepareDeletion
  worktreeRuntime.service.prepare = prepare; runtime.interrupt = interrupt
  assert.equal(existsSync(preparing.tree.checkoutRoot), false)

  const runner = new AppServerRunner('disposing', { n: 0 }, agent, { agentId: 'codex', workdir: root, permissionMode: 'ask' })
  let releaseTransport!: () => void, transportClosed = false
  const transportGate = new Promise<void>(resolve => { releaseTransport = resolve })
  ;(runner as any).retireTransport({ dispose: () => transportGate })
  ;(runner as any).retireTransport({ dispose: async () => { throw new Error('transport already disconnected') } })
  const closing = runner.waitForDisposal().then(() => { transportClosed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transportClosed, false, 'awaiting disposal must wait for all retired transports')
  releaseTransport(); await closing
  console.log('PASS task worktree deletion: cleanup, branch retention, dirty authorization, shared/team scope, state/lock guards, partial failure retry and sync coordination')
} finally {
  await runtime.closeSessionLogs()
  if (previousData === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = previousData
  await rm(root, { recursive: true, force: true })
}
