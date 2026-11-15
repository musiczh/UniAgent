import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeService, worktreeInstructions } from '../src/main/worktreeService'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import type { AgentDef, Session } from '../src/shared/types'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'worktree-orchestrator-'))
const previousData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])).stdout.trim()
const wait = async (predicate: () => boolean) => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }; throw Error('worktree scheduling timeout') }
const agent: AgentDef = { id: 'codex', name: 'Codex', adapter: 'codex', bin: '/usr/bin/true', builtin: true, installed: true, icon: '', models: [], capabilities: { streaming: true, modelSelect: false, reasoningEffort: false, nativeReview: true, permissionModes: [{ id: 'ask', label: '询问' }] } }
const runtime = new Orchestrator(() => agent, new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'), join(root, 'logs'))
try {
  const cwd = join(root, 'repo'); await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid'); await git(cwd, 'config', 'commit.gpgsign', 'false')
  const commit = async (file: string) => { await writeFile(join(cwd, file), file); await git(cwd, 'add', file); await git(cwd, 'commit', '-qm', file) }
  await commit('base.txt')
  const service = new WorktreeService()
  const project = { id: randomUUID(), name: 'Test', primaryDirectory: cwd, additionalDirectories: [], createdAt: 0, updatedAt: 0 }
  const tree = await service.create(await service.allocate(project, { mode: 'worktree', requestId: randomUUID() }))
  const turns: string[] = []
  ;(runtime as any).runStreaming = (session: Session, _agent: AgentDef, prompt: string, _attachments: unknown, _context: unknown, prepared: any) => {
    assert.equal(prepared.config.worktree.lastSourceCommit, session.config.worktree!.lastSourceCommit)
    ;(runtime as any).record(session.id, { type: 'turn_started', payload: {} })
    turns.push(prompt); (runtime as any).afterTurn(session)
  }
  await commit('latest.txt')
  const session = runtime.createSession({ agentId: 'codex', projectId: project.id, workdir: tree.workdir, worktree: tree, permissionMode: 'ask' }, 'first')
  assert.equal(turns.length, 0, 'transport must wait for asynchronous source preparation')
  assert.equal(session.worktreePreparing, true, 'first synchronization is exposed as transient card state')
  await wait(() => turns.length === 1)
  await assert.rejects(readFile(join(tree.workdir, 'latest.txt')), { code: 'ENOENT' }, 'first turn also leaves merging to the Agent')
  assert.equal(session.config.worktree!.lastSourceCommit, tree.baseCommit)
  assert.equal(session.worktreePreparing, false)
  assert.equal(session.config.worktree!.autoSyncBack, false, 'automatic source merge is disabled without explicit configuration')
  assert.match(worktreeInstructions(session.config), /不自动合并回源分支/)
  assert.ok(!(await runtime.getEvents(session.id)).some(event => event.type === 'system_notice' && event.payload.text === '正在同步本机源分支…'), 'loading does not become a permanent warning')
  const firstHead = await git(tree.workdir, 'rev-parse', 'HEAD')
  await commit('followup.txt')
  await runtime.sendMessage(session.id, 'followup')
  await wait(() => turns.length === 2)
  assert.equal(await git(tree.workdir, 'rev-parse', 'HEAD'), firstHead, 'later turns leave merging to the Agent')
  await assert.rejects(readFile(join(tree.workdir, 'followup.txt')), { code: 'ENOENT' })
  assert.match(worktreeInstructions(session.config), /每轮.*本机源分支.*同步/)
  assert.throws(() => runtime.retryWorktreePreparation(session.id), /没有可重试/, 'an ordinary session cannot use preparation retry')

  await writeFile(join(tree.workdir, 'draft.txt'), 'unsaved task work')
  await commit('queued-source.txt')
  ;(runtime as any).commitQueue(session, [{ id: 'queued', prompt: 'queued input', state: 'pending', acceptedAt: Date.now(), attempts: 0 }])
  ;(runtime as any).dispatchPendingQueue(session)
  await wait(() => turns.length === 3)
  assert.equal(await git(tree.workdir, 'rev-parse', 'HEAD'), firstHead, 'queued input does not merge a dirty worktree before the Agent can inspect it')
  assert.equal(await readFile(join(tree.workdir, 'draft.txt'), 'utf8'), 'unsaved task work')
  let autoSync = false
  runtime.configureWorktreeSync(() => autoSync)
  await (runtime as any).prepareNativeWorktree(session)
  assert.equal(session.config.worktree!.autoSyncBack, false, 'global setting reaches the prepared session prompt')
  assert.match(worktreeInstructions(session.config), /不自动合并回源分支/)
  autoSync = true
  await (runtime as any).prepareNativeWorktree(session)
  assert.match(worktreeInstructions(session.config), /提交后由你合并回本机源分支/)
  ;(runtime as any).setStatus(session, 'idle')
  let reviews = 0
  ;(runtime as any).ensureStreamerForNativeAction = () => ({ startReview: async () => { reviews++ } })
  await runtime.runNativeAction(session.id, { type: 'review.start', draft: { scope: { type: 'uncommittedChanges' } } })
  assert.equal(reviews, 1, 'native review may inspect a dirty worktree without an automatic merge')
  assert.equal(await git(tree.workdir, 'rev-parse', 'HEAD'), firstHead)
  const failedTree = await service.create(await service.allocate(project, { mode: 'worktree', requestId: randomUUID() }))
  await writeFile(join(failedTree.workdir, 'draft.txt'), 'initial draft')
  await commit('before-first.txt')
  const prepare = (runtime as any).worktreeRuntime.prepare.bind((runtime as any).worktreeRuntime)
  ;(runtime as any).worktreeRuntime.prepare = async (target: Session, ...args: unknown[]) => {
    if (target.config.worktree?.id === failedTree.id) throw new Error('工作树绑定暂时不可用')
    return prepare(target, ...args)
  }
  let failedSnapshot: Session | undefined
  runtime.on('sessionUpdated', ({ session }) => { if (session.worktreeTaskError) failedSnapshot = structuredClone(session) })
  const failedFirst = runtime.createSession({ agentId: 'codex', projectId: project.id, workdir: failedTree.workdir, worktree: failedTree, permissionMode: 'ask' }, 'keep initial input')
  await wait(() => failedFirst.status === 'error')
  assert.equal(failedFirst.pendingQueue?.[0]?.prompt, 'keep initial input', 'failed initial preparation retains its durable input')
  assert.equal(failedFirst.pendingQueue?.[0]?.state, 'pending')
  assert.equal(failedFirst.worktreePreparing, false)
  assert.match(failedFirst.worktreeTaskError!, /绑定暂时不可用/)
  assert.equal(failedSnapshot?.pendingQueue?.[0]?.state, 'pending', 'the failure card receives the restored retryable input')
  await git(failedTree.workdir, 'add', 'draft.txt'); await git(failedTree.workdir, 'commit', '-qm', 'keep initial draft')
  ;(runtime as any).worktreeRuntime.prepare = prepare
  runtime.retryWorktreePreparation(failedFirst.id)
  assert.throws(() => runtime.retryWorktreePreparation(failedFirst.id), /没有可重试/, 'a retry in progress cannot be submitted twice')
  await wait(() => turns.length === 4)
  assert.equal(failedFirst.worktreeTaskError, undefined, 'retry clears the failure card')
  assert.equal(failedFirst.worktreePreparing, false)
  assert.equal(turns.filter(prompt => prompt === 'keep initial input').length, 1)
  await assert.rejects(readFile(join(failedTree.workdir, 'before-first.txt')), { code: 'ENOENT' })

  const original = (runtime as any).worktreeRuntime.prepare.bind((runtime as any).worktreeRuntime)
  ;(runtime as any).worktreeRuntime.prepare = async () => { throw new Error('automatic recovery must not modify the workspace mid-turn') }
  ;(runtime as any).events.get(session.id).push({ type: 'user_message', payload: { text: 'recovery', automaticRecovery: { attempt: 1 } } })
  ;(runtime as any).run(session, 'automatic recovery', undefined, undefined, { agent, config: session.config, route: 'app-server', input: {} })
  assert.equal(turns.length, 5, 'same-turn automatic recovery resumes without preparing or changing workspace files')
  let release!: () => void
  ;(runtime as any).worktreeRuntime.prepare = () => new Promise<void>(resolve => { release = resolve })
  const stopped = runtime.createSession({ agentId: 'codex', projectId: project.id, workdir: tree.workdir, worktree: tree, permissionMode: 'ask' }, 'stopped')
  runtime.interrupt(stopped.id)
  release(); await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(turns.length, 5, 'stopping during preparation prevents a late transport start')
  assert.equal(stopped.status, 'idle')
  assert.equal(stopped.worktreePreparing, false, 'cancellation clears the temporary card')
  const { session: sideSession } = (runtime as any).createSessionRecord({ agentId: 'codex', projectId: project.id, workdir: tree.workdir, worktree: tree, permissionMode: 'ask' }, 'side preparation')
  const sidePreparation = (runtime as any).prepareNativeWorktree(sideSession, true)
  assert.equal(sideSession.worktreePreparing, true)
  runtime.interruptSide(sideSession.id)
  release()
  await assert.rejects(sidePreparation, /任务已停止/)
  assert.equal(sideSession.worktreePreparing, false, 'side cancellation also clears first preparation state')
  ;(runtime as any).worktreeRuntime.prepare = original
  console.log('PASS worktree orchestration: first sync card, Agent-managed later turns, durable retry, native review and cancellation fencing')
} finally {
  await runtime.closeSessionLogs()
  if (previousData === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = previousData
  await rm(root, { recursive: true, force: true })
}
