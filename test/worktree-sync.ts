import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeService, parseSessionWorktree } from '../src/main/worktreeService'
import { AppSettingsStore } from '../src/main/appSettingsStore'
import type { Project } from '../src/shared/types'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'worktree-sync-'))
const previousData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = join(root, 'data')
await mkdir(process.env.UNIAGENT_USER_DATA)
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])).stdout.trim()
const service = new WorktreeService()
const commit = async (cwd: string, file: string, value: string) => {
  await writeFile(join(cwd, file), value)
  await git(cwd, 'add', '--', file); await git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}
async function fixture() {
  const cwd = join(root, randomUUID()); await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid')
  await git(cwd, 'config', 'commit.gpgsign', 'false')
  await commit(cwd, 'base.txt', 'base\n')
  const project: Project = { id: randomUUID(), name: 'Test', primaryDirectory: cwd, additionalDirectories: [], createdAt: 0, updatedAt: 0 }
  const allocated = await service.allocate(project, { mode: 'worktree', baseRef: 'HEAD', requestId: randomUUID() })
  return { cwd, project, allocated, create: () => service.create(allocated) }
}

try {
  const first = await fixture()
  assert.equal((await service.defaultSelection(first.project, undefined, true))?.mode, 'worktree')
  assert.equal((await service.defaultSelection(first.project, { mode: 'local' }, true))?.mode, 'local', 'explicit local choice overrides the global default')
  assert.equal(await service.defaultSelection(first.project, undefined, false), undefined)
  await assert.rejects(service.defaultSelection({ ...first.project, primaryDirectory: join(root, 'missing') }, undefined, true), /检测失败/)
  const latest = await commit(first.cwd, 'latest.txt', 'after allocation\n')
  let tree = await first.create()
  assert.equal(tree.baseCommit, latest, 'creation uses the latest local source, including commits after allocation')
  assert.equal(await git(tree.checkoutRoot, 'branch', '--show-current'), tree.branch)
  await commit(first.cwd, 'newer.txt', 'before next turn\n')
  tree = await service.prepare(tree, false)
  assert.equal(await git(tree.checkoutRoot, 'rev-parse', 'HEAD'), latest, 'even the first preparation leaves incoming merges to the Agent')
  await assert.rejects(readFile(join(tree.checkoutRoot, 'newer.txt')), { code: 'ENOENT' })
  assert.equal(tree.autoSyncBack, false)
  assert.deepEqual(parseSessionWorktree(tree), tree, 'sync metadata survives SessionStore parsing')
  await writeFile(join(tree.checkoutRoot, 'draft.txt'), 'keep this draft')
  tree = await service.prepare(tree, true)
  assert.equal(await readFile(join(tree.checkoutRoot, 'draft.txt'), 'utf8'), 'keep this draft', 'unchanged source permits continuing a dirty task')
  await commit(first.cwd, 'source-next.txt', 'source\n')
  tree = await service.prepare(tree, true)
  assert.equal(await git(tree.checkoutRoot, 'rev-parse', 'HEAD'), latest, 'later preparation does not modify a dirty checkout')
  await commit(tree.checkoutRoot, 'draft.txt', 'keep this draft')
  tree = await service.prepare(tree, true)
  await assert.rejects(readFile(join(tree.checkoutRoot, 'source-next.txt')), { code: 'ENOENT' }, 'later preparation leaves incoming merges to the Agent')
  await git(tree.checkoutRoot, 'merge', '--no-edit', 'main')
  assert.equal(await readFile(join(tree.checkoutRoot, 'source-next.txt'), 'utf8'), 'source\n', 'Agent may merge source without losing task commits')

  const conflict = await fixture(); const conflictTree = await conflict.create()
  const sourceBefore = await commit(conflict.cwd, 'base.txt', 'source changed\n')
  const taskBefore = await commit(conflictTree.checkoutRoot, 'base.txt', 'task changed\n')
  await service.prepare(conflictTree, true)
  assert.equal(await git(conflict.cwd, 'rev-parse', 'HEAD'), sourceBefore)
  assert.equal(await git(conflictTree.checkoutRoot, 'rev-parse', 'HEAD'), taskBefore)
  assert.equal(await git(conflict.cwd, 'status', '--porcelain'), '')
  assert.equal(await git(conflictTree.checkoutRoot, 'status', '--porcelain'), '', 'preflight leaves no conflict markers or in-progress merge')
  await assert.rejects(git(conflictTree.checkoutRoot, 'merge', '--no-edit', 'main'))
  await service.prepare(conflictTree, true)
  assert.match(await git(conflictTree.checkoutRoot, 'status', '--porcelain'), /UU base.txt/, 'Agent can continue examining an existing merge conflict')

  const parallel = await fixture()
  const trees = await Promise.all([parallel.create(), service.allocate(parallel.project, { mode: 'worktree', requestId: randomUUID() }).then(tree => service.create(tree))])
  const sourceHead = await git(parallel.cwd, 'rev-parse', 'HEAD')
  await commit(trees[0].checkoutRoot, 'one.txt', 'one\n'); await commit(trees[1].checkoutRoot, 'two.txt', 'two\n')
  await Promise.all(trees.map(tree => service.prepare(tree, true)))
  assert.equal(await git(parallel.cwd, 'rev-parse', 'HEAD'), sourceHead, 'parallel task preparation never merges commits into source')
  assert.equal(await readFile(join(trees[0].workdir, 'one.txt'), 'utf8'), 'one\n')
  assert.equal(await readFile(join(trees[1].workdir, 'two.txt'), 'utf8'), 'two\n')

  const rewritten = await fixture(); const rewrittenTree = await rewritten.create()
  const orphan = await git(rewritten.cwd, 'commit-tree', 'HEAD^{tree}', '-m', 'replacement history')
  await git(rewritten.cwd, 'update-ref', 'refs/heads/main', orphan)
  await service.prepare(rewrittenTree, true)
  assert.equal(await git(rewrittenTree.workdir, 'rev-parse', 'HEAD'), rewrittenTree.baseCommit, 'rewritten source is left to the Agent to inspect')
  const missing = await fixture(); const missingTree = await missing.create()
  await git(missing.cwd, 'switch', '-qc', 'another')
  await git(missing.cwd, 'branch', '-D', 'main')
  await service.prepare(missingTree, true)
  await assert.rejects(service.inspectArchive(missingTree), /show-ref/)
  await git(tree.checkoutRoot, 'switch', '-qc', 'unexpected')
  await assert.rejects(service.prepare(tree, true), /分支已变化/)
  await commit(tree.checkoutRoot, 'wrong.txt', 'wrong branch\n')
  await assert.rejects(service.prepare({ ...tree, baseRef: 'HEAD' }, true), /分支已变化|detached HEAD|同步记录/)

  const settings = new AppSettingsStore(join(root, 'settings'))
  assert.equal(settings.get().defaultTaskWorktree, false); assert.equal(settings.get().autoSyncWorktree, false)
  for (const [name, value] of Object.entries({
    legacy: JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false }),
    invalid: JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, defaultTaskWorktree: 'true', autoSyncWorktree: 1 }),
    corrupt: '{',
    future: JSON.stringify({ schemaVersion: 2, autoUpdateAgentsOnLaunch: false, defaultTaskWorktree: true, autoSyncWorktree: true })
  })) {
    const directory = join(root, name); await mkdir(directory)
    await writeFile(join(directory, 'app-settings.json'), value)
    const store = new AppSettingsStore(directory)
    assert.equal(store.get().defaultTaskWorktree, false, name)
    assert.equal(store.get().autoSyncWorktree, false, name)
    const saved = store.set({ autoCheckUpdate: false })
    assert.equal(saved.defaultTaskWorktree, false, name + ' unrelated save')
    assert.equal(saved.autoSyncWorktree, false, name + ' unrelated save')
  }
  for (const defaultTaskWorktree of [false, true]) for (const autoSyncWorktree of [false, true]) {
    settings.set({ defaultTaskWorktree, autoSyncWorktree })
    const restarted = new AppSettingsStore(join(root, 'settings'))
    restarted.set({ theme: 'system' })
    assert.equal(restarted.get().defaultTaskWorktree, defaultTaskWorktree, 'retain explicit worktree choice after restart and unrelated save')
    assert.equal(restarted.get().autoSyncWorktree, autoSyncWorktree, 'retain explicit sync choice independently')
  }
  settings.set({ defaultTaskWorktree: false, autoSyncWorktree: false, autoCheckUpdate: false })
  assert.equal(new AppSettingsStore(join(root, 'settings')).get().autoSyncWorktree, false)
  settings.set({ autoSyncWorktree: true })
  assert.equal(settings.get().defaultTaskWorktree, false); assert.equal(settings.get().autoCheckUpdate, false)
  const failedSettings = new AppSettingsStore(join(root, 'failed-settings'))
  await mkdir(join(root, 'failed-settings', 'app-settings.json'), { recursive: true })
  assert.throws(() => failedSettings.set({ autoSyncWorktree: false }), /工作树设置保存失败/)

  console.log('PASS worktree source preparation: latest source, named branches, conflicts, dirty tasks, parallel isolation, history guards and settings')
} finally {
  if (previousData === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = previousData
  await rm(root, { recursive: true, force: true })
}
