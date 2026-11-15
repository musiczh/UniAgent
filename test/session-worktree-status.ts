import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeService } from '../src/main/worktreeService'
import { registerSessionWorktreeStatusIpc, sessionWorktreeStatusReader } from '../src/main/sessionWorktreeStatus'
import { projectTaskBoard } from '../src/shared/taskBoard'
import { SESSION_WORKTREE_STATUS_IPC } from '../src/shared/sessionWorktreeStatus'
import type { Session } from '../src/shared/types'

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])).stdout.trim()
const root = await mkdtemp(join(tmpdir(), 'session-worktree-status-')), previous = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = join(root, 'data')
await mkdir(process.env.UNIAGENT_USER_DATA)
try {
  const cwd = join(root, 'repo'); await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid'); await git(cwd, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, 'base.txt'), 'base'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'base')
  const service = new WorktreeService(), project = { id: randomUUID(), name: 'Test', primaryDirectory: cwd, additionalDirectories: [], createdAt: 1, updatedAt: 1 }
  const tree = await service.create(await service.allocate(project, { mode: 'worktree', requestId: randomUUID() }))
  const session: Session = { id: 'task', title: '工作树状态', status: 'completed', createdAt: 1, config: { agentId: 'codex', workdir: tree.workdir, worktree: tree } }
  const initial = await service.inspectStatus(tree)
  assert.equal(initial.changedFiles, 0); assert.equal(initial.unmergedCommits, 0); assert.deepEqual(initial.commits, [])
  assert.equal(initial.directory, tree.workdir); assert.equal(initial.sourceBranch, 'main'); assert.equal(initial.branch, tree.branch)
  await writeFile(join(tree.workdir, 'untracked\nfile.txt'), 'draft')
  assert.equal((await service.inspectStatus(tree)).changedFiles, 1, 'untracked input counts before any commit')
  await git(tree.workdir, 'add', '.'); await git(tree.workdir, 'commit', '-qm', '待合入：保留标题与描述')
  const taskHead = await git(tree.workdir, 'rev-parse', 'HEAD')
  await git(tree.workdir, 'mv', 'base.txt', 'renamed.txt')
  await writeFile(join(tree.workdir, 'untracked\nfile.txt'), 'unstaged change')
  const index = await git(tree.workdir, 'rev-parse', '--git-path', 'index'), beforeIndex = await readFile(index), refs = await git(cwd, 'show-ref')
  const pending = await service.inspectStatus(tree)
  assert.equal(pending.changedFiles, 2, 'staged rename and unstaged edit both count')
  assert.equal(pending.unmergedCommits, 1); assert.deepEqual(pending.commits, [{ hash: taskHead, subject: '待合入：保留标题与描述' }])
  assert.deepEqual(await readFile(index), beforeIndex, 'background status does not rewrite the index'); assert.equal(await git(cwd, 'show-ref'), refs)
  await writeFile(join(cwd, 'source.txt'), 'source'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'source changed')
  assert.equal((await service.inspectStatus(tree)).unmergedCommits, 1, 'divergent source still identifies task-only commits')
  await git(cwd, 'merge', '--no-edit', tree.branch!)
  const merged = await service.inspectStatus(tree)
  assert.equal(merged.unmergedCommits, 0); assert.deepEqual(merged.commits, []); assert.equal(merged.changedFiles, 2, 'dirty checkout remains pending after its commits are merged')
  await git(tree.workdir, 'add', '.'); await git(tree.workdir, 'commit', '-qm', 'remaining edits'); await git(cwd, 'merge', '--no-edit', tree.branch!)
  const clean = await service.inspectStatus(tree)
  assert.equal(clean.changedFiles + clean.unmergedCommits, 0)
  await assert.rejects(service.inspectStatus({ ...tree, baseRef: 'HEAD' }), /源分支/)
  await git(cwd, 'switch', '-qc', 'another'); await git(cwd, 'branch', '-D', 'main')
  await assert.rejects(service.inspectStatus(tree), 'missing source never reports clean')

  const rows = projectTaskBoard([session, { ...session, id: 'local', config: { ...session.config, worktree: undefined } }], () => []).columns.decision.items
  assert.equal(rows.find(row => row.id === 'task')?.worktree?.id, tree.id)
  assert.equal(rows.find(row => row.id === 'local')?.worktree, undefined)

  let reads = 0, running = 0, peak = 0, fail = false
  const sessions = new Map(Array.from({ length: 8 }, (_, i) => [String(i), { ...session, id: String(i), config: { ...session.config, worktree: { ...tree, id: String(i) } } }]))
  const reader = sessionWorktreeStatusReader({ session: id => sessions.get(id), inspect: async value => {
    reads++; peak = Math.max(peak, ++running)
    await new Promise(resolve => setTimeout(resolve, 15)); running--
    if (fail) throw Error('Git unavailable')
    return { ...clean, treeId: value.id }
  } })
  await Promise.all(Array.from({ length: 8 }, (_, i) => reader(String(i))))
  assert.ok(peak <= 4); assert.equal(reads, 8)
  await reader('0'); assert.equal(reads, 8, 'recent header and card reads share the cached result')
  await Promise.all([reader('0', true), reader('0', true)]); assert.equal(reads, 9, 'refreshes share an in-flight inspection')
  fail = true; await assert.rejects(reader('0', true), /unavailable/); fail = false
  await reader('0'); assert.equal(reads, 11, 'failed reads do not poison the cache')
  await assert.rejects(reader('../repo'), /不存在/); await assert.rejects(reader(''), /无效/)
  let handler: any, trusted = false, hydrated = false
  registerSessionWorktreeStatusIpc({ handle: (channel: string, callback: any) => { assert.equal(channel, SESSION_WORKTREE_STATUS_IPC); handler = callback } } as any, {
    trusted: () => { if (!trusted) throw Error('untrusted') }, hydrate: async () => { hydrated = true }, session: id => id === 'task' ? session : undefined, inspect: async value => { assert.ok(hydrated); assert.equal(value, tree); return clean }
  })
  await assert.rejects(handler({}, 'task'), /untrusted/); assert.equal(hydrated, false)
  trusted = true; assert.equal(await handler({}, 'task'), clean)
  await assert.rejects(handler({}, 'missing'), /不存在/)
  console.log('PASS read-only Git status: dirty/untracked/staged, ahead/divergence/merge, missing source, board binding, shared cache, concurrency, failures and trusted session IPC')
} finally {
  if (previous === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = previous
  await rm(root, { recursive: true, force: true })
}
