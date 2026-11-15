import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { access, mkdir, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Project, ProjectGitInfo, ProjectWorktree, SessionConfig, SessionWorktree, WorkspaceSelection } from '../shared/types'
import { resolveUserDataHome } from './userData.ts'
import { atomicWriteFile } from './sessionStore'
import type { WorktreeArchiveCheck } from '../shared/worktreeArchive'
import type { SessionWorktreeStatus } from '../shared/sessionWorktreeStatus'

const runFile = promisify(execFile)
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const PATH_FIELDS = ['sourcePrimaryDirectory', 'repositoryRoot', 'gitCommonDirectory', 'checkoutRoot', 'workdir'] as const
const removingWorktrees = new Set<string>()
const repositoryOperations = new Map<string, Promise<unknown>>()

function inRepository<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (repositoryOperations.get(key) || Promise.resolve()).catch(() => {}).then(operation)
  repositoryOperations.set(key, result)
  void result.finally(() => { if (repositoryOperations.get(key) === result) repositoryOperations.delete(key) }).catch(() => {})
  return result
}

export function assertWorktreeNotRemoving(config: Pick<SessionConfig, 'workdir' | 'worktree'>): void {
  if ([...removingWorktrees].some(path => within(path, config.worktree?.checkoutRoot || config.workdir))) throw new Error('工作树正在删除，请稍后再操作')
}

export function parseWorkspaceSelection(value: unknown): WorkspaceSelection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的工作方式选择')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['mode', 'baseRef', 'requestId'].includes(key))) throw new Error('无效的工作方式参数')
  if (row.mode === 'local') return { mode: 'local' }
  if (row.mode !== 'worktree' || typeof row.requestId !== 'string' || !UUID.test(row.requestId)) throw new Error('无效的工作树创建请求')
  const baseRef = row.baseRef ?? 'HEAD'
  if (typeof baseRef !== 'string' || baseRef.length > 512 || (baseRef !== 'HEAD' && !baseRef.startsWith('refs/heads/')) || /[\0\r\n]/.test(baseRef)) {
    throw new Error('无效的工作树基准分支')
  }
  return { mode: 'worktree', baseRef, requestId: row.requestId }
}

export function parseSessionWorktree(value: unknown): SessionWorktree | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.projectId !== 'string' || !row.projectId ||
      typeof row.creationRequestId !== 'string' || !UUID.test(row.creationRequestId) ||
      typeof row.baseRef !== 'string' || !row.baseRef || typeof row.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(row.baseCommit) ||
      !['creating', 'ready', 'failed'].includes(String(row.state)) ||
      PATH_FIELDS.some(key => typeof row[key] !== 'string' || !isAbsolute(row[key] as string)) ||
      (row.lastError !== undefined && typeof row.lastError !== 'string')) return undefined
  return {
    id: row.id, projectId: row.projectId, creationRequestId: row.creationRequestId,
    sourcePrimaryDirectory: row.sourcePrimaryDirectory as string, repositoryRoot: row.repositoryRoot as string,
    gitCommonDirectory: row.gitCommonDirectory as string, checkoutRoot: row.checkoutRoot as string,
    workdir: row.workdir as string, baseRef: row.baseRef, baseCommit: row.baseCommit,
    state: row.state as SessionWorktree['state'], ...(row.lastError ? { lastError: row.lastError as string } : {}),
    ...(typeof row.branch === 'string' ? { branch: row.branch } : {}),
    ...(typeof row.lastSourceCommit === 'string' && /^[a-f0-9]{40,64}$/i.test(row.lastSourceCommit) ? { lastSourceCommit: row.lastSourceCommit } : {}),
    ...(typeof row.lastSyncedCommit === 'string' && /^[a-f0-9]{40,64}$/i.test(row.lastSyncedCommit) ? { lastSyncedCommit: row.lastSyncedCommit } : {}),
    ...(typeof row.autoSyncBack === 'boolean' ? { autoSyncBack: row.autoSyncBack } : {}),
    ...(typeof row.removedAt === 'number' && Number.isFinite(row.removedAt) && row.removedAt > 0 ? { removedAt: row.removedAt } : {})
  }
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}

export function sessionUsesWorktree(path: string, config: Pick<SessionConfig, 'workdir' | 'worktree'>): boolean {
  return config.worktree?.checkoutRoot === path || within(path, config.workdir)
}

function gitDirectory(checkout: string): string {
  const dotGit = join(checkout, '.git')
  if (statSync(dotGit).isDirectory()) return realpathSync(dotGit)
  const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(dotGit, 'utf8'))
  if (!match) throw new Error('工作树 Git 记录不可用')
  return realpathSync(resolve(checkout, match[1]))
}

function commonDirectory(checkout: string): string {
  const gitDir = gitDirectory(checkout)
  const path = join(gitDir, 'commondir')
  return existsSync(path) ? realpathSync(resolve(gitDir, readFileSync(path, 'utf8').trim())) : gitDir
}

export function assertWorktreeAvailable(config: Pick<SessionConfig, 'projectId' | 'worktree'>): void {
  const tree = config.worktree
  if (!tree) return
  assertWorktreeNotRemoving({ workdir: tree.workdir, worktree: tree })
  if (config.projectId !== tree.projectId || !parseSessionWorktree(tree)) throw new Error('工作树与空间绑定不一致')
  const managed = join(realpathSync(resolveUserDataHome()), 'worktrees', tree.projectId, tree.id)
  if (dirname(tree.checkoutRoot) !== managed || !within(tree.checkoutRoot, tree.workdir)) throw new Error('工作树目录绑定无效')
  if (tree.state !== 'ready') throw new Error(tree.lastError || '工作树尚未创建完成，请重新发送创建任务')
  try {
    const root = realpathSync(tree.checkoutRoot)
    const cwd = realpathSync(tree.workdir)
    if (root !== tree.checkoutRoot || !statSync(cwd).isDirectory() || !within(root, cwd) ||
        commonDirectory(root) !== tree.gitCommonDirectory || commonDirectory(tree.repositoryRoot) !== tree.gitCommonDirectory) {
      throw new Error('工作树 Git 记录与原仓库不一致')
    }
    const gitDir = gitDirectory(root)
    if (realpathSync(resolve(gitDir, readFileSync(join(gitDir, 'gitdir'), 'utf8').trim())) !== realpathSync(join(root, '.git'))) {
      throw new Error('工作树 Git 注册已变化')
    }
  } catch {
    throw new Error(`工作树目录不可用，请修复原目录后重试：${tree.workdir}`)
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_.*)?|PREFIX|CEILING_DIRECTORIES|IMPLICIT_WORK_TREE|GRAFT_FILE|SHALLOW_FILE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS)$/.test(key)) delete env[key]
  }
  const { stdout } = await runFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-C', cwd, ...args], {
    env, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, signal
  })
  return args.includes('-z') ? stdout : stdout.trim()
}

async function ancestor(cwd: string, before: string, after: string): Promise<boolean> {
  try { await git(cwd, ['merge-base', '--is-ancestor', before, after]); return true }
  catch (error) { if ((error as { code?: number }).code === 1) return false; throw error }
}

async function sourceCommit(tree: SessionWorktree): Promise<string> {
  if (!tree.baseRef.startsWith('refs/heads/')) throw new Error('源目录为 detached HEAD，无法自动同步；请先选择本地源分支')
  const commit = await git(tree.repositoryRoot, ['show-ref', '--verify', '--hash', tree.baseRef])
    .catch(() => { throw new Error('源分支已不存在，请先恢复分支') })
  if (!await ancestor(tree.repositoryRoot, tree.lastSourceCommit || tree.baseCommit, commit)) throw new Error('源分支历史已改写，自动同步已暂停')
  return commit
}

async function requireNoGitOperation(cwd: string, signal?: AbortSignal): Promise<void> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    const path = await git(cwd, ['rev-parse', '--git-path', name], signal)
    if (await access(resolve(cwd, path)).then(() => true, () => false)) throw new Error(`目录正在执行其他 Git 操作：${cwd}`)
  }
}

async function taskBranch(tree: SessionWorktree): Promise<string> {
  const branch = await git(tree.checkoutRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  if (tree.branch && branch !== tree.branch || `refs/heads/${branch}` === tree.baseRef) throw new Error('工作树分支已变化，自动同步已暂停')
  if (tree.lastSyncedCommit && !await ancestor(tree.checkoutRoot, tree.lastSyncedCommit, 'HEAD')) throw new Error('已同步的工作树历史已改写，自动同步已暂停')
  return branch
}

async function worktreeChanges(tree: SessionWorktree, signal?: AbortSignal) {
  if (!tree.baseRef.startsWith('refs/heads/')) throw new Error('没有可核验的本机源分支，请先恢复源分支')
  const [source, head, status] = await Promise.all([
    git(tree.repositoryRoot, ['show-ref', '--verify', '--hash', tree.baseRef], signal),
    git(tree.checkoutRoot, ['rev-parse', 'HEAD'], signal),
    git(tree.checkoutRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)
  ])
  const paths = status.split('\0').filter(Boolean)
  let changedFiles = 0
  for (let i = 0; i < paths.length; i++) { changedFiles++; if (/^[RC]|^.[RC]/.test(paths[i])) i++ }
  const unmergedCommits = Number(await git(tree.repositoryRoot, ['rev-list', '--count', `${source}..${head}`], signal))
  if (!Number.isSafeInteger(unmergedCommits) || unmergedCommits < 0) throw new Error('无法读取未合回的提交')
  return { source, head, changedFiles, unmergedCommits }
}

async function syncState(tree: SessionWorktree): Promise<SessionWorktree> {
  let text: string
  try { text = await readFile(join(dirname(tree.checkoutRoot), 'sync.json'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return tree; throw error }
  const saved = parseSessionWorktree(JSON.parse(text))
  if (!saved || saved.state !== 'ready' || (['id', 'baseRef', 'checkoutRoot', 'workdir', 'gitCommonDirectory', 'sourcePrimaryDirectory', 'repositoryRoot'] as const).some(key => saved[key] !== tree[key])) {
    throw new Error('工作树同步记录与当前目录不一致，请先检查记录')
  }
  return { ...tree, baseCommit: saved.baseCommit, branch: saved.branch, lastSourceCommit: saved.lastSourceCommit, lastSyncedCommit: saved.lastSyncedCommit }
}

async function saveSyncState(tree: SessionWorktree): Promise<SessionWorktree> {
  await atomicWriteFile(join(dirname(tree.checkoutRoot), 'sync.json'), JSON.stringify(tree))
  return tree
}

export class WorktreeService {
  async defaultSelection(project: Project, selection: WorkspaceSelection | undefined, enabled: boolean, requestId: string = randomUUID()): Promise<WorkspaceSelection | undefined> {
    if (selection || !enabled) return selection
    const info = await this.inspect(project)
    if (info.inspectionFailed) throw new Error(info.unavailableReason || '无法检测仓库，已停止默认创建')
    return info.canCreateWorktree && info.currentBranch ? { mode: 'worktree', baseRef: 'HEAD', requestId } : undefined
  }

  lockRemoval(path: string): () => void {
    if (removingWorktrees.has(path)) throw new Error('工作树正在删除')
    removingWorktrees.add(path)
    return () => removingWorktrees.delete(path)
  }

  async list(project: Project, saved: SessionWorktree[] = [], signal?: AbortSignal): Promise<ProjectWorktree[]> {
    signal?.throwIfAborted()
    const root = await realpath(project.primaryDirectory)
    let output: string
    try { output = await git(root, ['worktree', 'list', '--porcelain', '-z'], signal) }
    catch {
      signal?.throwIfAborted()
      if (!signal && !(await this.inspect(project)).canCreateWorktree && !saved.length) return []
      throw new Error('无法读取工作树，请检查空间主目录与 Git 注册')
    }
    const repositoryRoot = await realpath(await git(root, ['rev-parse', '--show-toplevel'], signal))
    const gitCommonDirectory = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'], signal)))
    const managedRoot = join(await realpath(resolveUserDataHome()), 'worktrees')
    const rows: ProjectWorktree[] = []
    for (const record of output.split('\0\0').filter(Boolean)) {
      signal?.throwIfAborted()
      const fields = record.split('\0')
      const path = fields.find(field => field.startsWith('worktree '))?.slice(9)
      if (!path || !isAbsolute(path)) continue
      const savedTree = saved.find(tree => tree.checkoutRoot === path)
      const main = rows.length === 0 || path === repositoryRoot
      const row: ProjectWorktree = {
        path, branch: fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, ''),
        commit: fields.find(field => field.startsWith('HEAD '))?.slice(5),
        source: main ? 'primary' : within(managedRoot, path) ? 'managed' : 'external',
        state: 'ready', sessions: []
      }
      if (main) row.removalBlockedReason = '主工作区或空间主目录不可删除'
      try {
        if (await realpath(path) !== path) throw new Error('工作树路径已变化')
        if (await realpath(await git(path, ['rev-parse', '--show-toplevel'], signal)) !== path ||
            await realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir'], signal))) !== gitCommonDirectory) throw new Error('工作树 Git 注册已变化')
        if (fields.some(field => field === 'locked' || field.startsWith('locked '))) {
          row.state = 'locked'; row.removalBlockedReason = '工作树已被 Git 锁定'
        } else if (savedTree?.state === 'creating') {
          row.state = 'creating'; row.removalBlockedReason = '工作树正在创建'
        } else if (await git(path, ['status', '--porcelain', '--untracked-files=normal'], signal)) {
          row.state = 'dirty'; row.removalBlockedReason = '含未提交或未跟踪文件，请先处理改动'
        } else if (row.commit && !/^0+$/.test(row.commit) && await git(path, ['rev-list', '-1', row.commit, '--not', '--branches', '--tags', '--remotes'], signal)) {
          row.removalBlockedReason = '包含未被分支或标签保留的提交，请先创建分支'
        }
      } catch {
        signal?.throwIfAborted()
        row.state = 'missing'; row.removalBlockedReason = '目录或 Git 注册不可用，请先修复工作树'
      }
      rows.push(row)
    }
    for (const tree of saved) {
      if (rows.some(row => row.path === tree.checkoutRoot)) continue
      rows.push({ path: tree.checkoutRoot, commit: tree.baseCommit, source: 'managed',
        state: tree.state === 'ready' ? 'missing' : tree.state,
        removalBlockedReason: tree.state === 'creating' ? '工作树正在创建' : tree.lastError || '目录或 Git 注册不可用，请先修复工作树', sessions: [] })
    }
    return rows
  }

  async remove(project: Project, path: string): Promise<void> {
    const row = (await this.list(project)).find(tree => tree.path === path)
    if (!row) throw new Error('工作树已不在当前仓库，请刷新列表')
    if (row.removalBlockedReason) throw new Error(row.removalBlockedReason)
    // Git performs the final cleanliness/lock check; never force removal.
    await git(project.primaryDirectory, ['worktree', 'remove', path])
  }

  async inspectTaskRemoval(tree: SessionWorktree, signal?: AbortSignal): Promise<{ dirty: boolean; branch?: string; removed: boolean }> {
    signal?.throwIfAborted()
    const managedRoot = join(await realpath(resolveUserDataHome()), 'worktrees')
    const managed = join(managedRoot, tree.projectId, tree.id)
    if (!parseSessionWorktree(tree) || !within(managedRoot, managed) || dirname(tree.checkoutRoot) !== managed || !within(tree.checkoutRoot, tree.workdir)) throw new Error('工作树目录绑定无效，已停止清理')
    if (await realpath(tree.repositoryRoot) !== tree.repositoryRoot ||
        await realpath(resolve(tree.repositoryRoot, await git(tree.repositoryRoot, ['rev-parse', '--git-common-dir'], signal))) !== tree.gitCommonDirectory) throw new Error('工作树原仓库已变化，已停止清理')
    const project: Project = { id: tree.projectId, name: '', primaryDirectory: tree.repositoryRoot, additionalDirectories: [], createdAt: 0, updatedAt: 0 }
    const row = (await this.list(project, [], signal)).find(row => row.path === tree.checkoutRoot)
    if (!row) {
      try { if (await realpath(managed) !== managed) throw new Error('工作树元数据路径已变化，请先检查') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      try { await access(tree.checkoutRoot); throw new Error('工作树目录仍存在但没有 Git 注册，请先检查') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      let saved: SessionWorktree | undefined
      try { saved = parseSessionWorktree(JSON.parse(await readFile(join(managed, 'sync.json'), 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const removed = tree.removedAt || saved?.id === tree.id && saved.checkoutRoot === tree.checkoutRoot && saved.gitCommonDirectory === tree.gitCommonDirectory && saved.removedAt
      if (!removed && tree.state === 'ready') throw new Error('工作树目录或 Git 注册已丢失，请先检查')
      return { dirty: false, branch: tree.branch, removed: true }
    }
    if (await realpath(managed) !== managed || row.source !== 'managed' || ['locked', 'missing', 'creating', 'failed'].includes(row.state)) throw new Error(row.removalBlockedReason || '工作树不可清理')
    if (row.removalBlockedReason && row.state !== 'dirty') throw new Error(row.removalBlockedReason)
    await requireNoGitOperation(tree.checkoutRoot, signal)
    // Dirty worktrees still need the unreferenced-commit check skipped by list().
    if (row.commit && await git(tree.checkoutRoot, ['rev-list', '-1', row.commit, '--not', '--branches', '--tags', '--remotes'], signal)) throw new Error('包含未被分支或标签保留的提交，请先创建分支')
    return { dirty: row.state === 'dirty', branch: row.branch, removed: false }
  }

  async removeTaskWorktree(tree: SessionWorktree, discard: boolean, current: () => boolean): Promise<SessionWorktree> {
    return inRepository(tree.gitCommonDirectory, async () => {
      const state = await this.inspectTaskRemoval(tree)
      if (!current()) throw new Error('任务或工作树关联已变化，请重新确认删除')
      if (state.dirty && !discard) throw new Error('工作树有未提交或未跟踪文件，请重新确认删除')
      if (!state.removed) await git(tree.repositoryRoot, ['worktree', 'remove', ...(discard ? ['--force'] : []), '--', tree.checkoutRoot])
      const removed: SessionWorktree = { ...tree, state: 'failed', removedAt: tree.removedAt || Date.now(), lastError: '工作树已清理，请重试删除任务记录' }
      // Keep a durable tombstone until the session metadata has been persisted.
      if (existsSync(dirname(tree.checkoutRoot))) await saveSyncState(removed)
      return removed
    })
  }

  async removeTaskMetadata(tree: SessionWorktree): Promise<void> {
    try { if (await realpath(dirname(tree.checkoutRoot)) !== dirname(tree.checkoutRoot)) throw new Error('工作树元数据路径已变化，请先检查') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const operation of [() => unlink(join(dirname(tree.checkoutRoot), 'sync.json')), () => rmdir(dirname(tree.checkoutRoot))]) {
      try { await operation() }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error }
    }
  }

  async inspect(project: Project): Promise<ProjectGitInfo> {
    try {
      const cwd = await realpath(project.primaryDirectory)
      if (await git(cwd, ['rev-parse', '--is-bare-repository']) === 'true') return { branches: [], canCreateWorktree: false, unavailableReason: '主目录是 bare 仓库，不能新建工作树' }
      await git(cwd, ['rev-parse', '--show-toplevel'])
      const [branch, branches] = await Promise.all([
        git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
        git(cwd, ['for-each-ref', '--format=%(refname)%09%(refname:short)', 'refs/heads/'])
      ])
      const info: ProjectGitInfo = {
        ...(branch ? { currentBranch: branch } : {}),
        branches: branches.split('\n').filter(Boolean).map(line => { const [ref, name] = line.split('\t'); return { ref, name } }),
        canCreateWorktree: false
      }
      try { await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']) }
      catch { return { ...info, unavailableReason: '主目录仓库还没有提交，无法新建工作树' } }
      const customWorktree = await git(cwd, ['config', '--get', 'core.worktree']).catch(() => '')
      if (customWorktree) return { ...info, unavailableReason: '仓库使用了自定义 core.worktree，暂不支持自动创建' }
      return { ...info, canCreateWorktree: true }
    } catch (error) {
      const notRepository = /not a git repository/i.test(String((error as { stderr?: string }).stderr || ''))
      return { branches: [], canCreateWorktree: false, ...(!notRepository ? { inspectionFailed: true } : {}), unavailableReason: notRepository ? '主目录不是可用的 Git 仓库' : 'Git 或主目录检测失败，请检查后重试' }
    }
  }

  async allocate(project: Project, selection: WorkspaceSelection): Promise<SessionWorktree> {
    const info = await this.inspect(project)
    if (!info.canCreateWorktree) throw new Error(info.unavailableReason)
    const sourcePrimaryDirectory = await realpath(project.primaryDirectory)
    const repositoryRoot = await realpath(await git(sourcePrimaryDirectory, ['rev-parse', '--show-toplevel']))
    const selectedRef = selection.baseRef || 'HEAD'
    // 系统提示词要写出来源分支；默认 HEAD 表示空间主目录当前提交，解析为当前分支名，detached 时保留 HEAD。
    const baseRef = selectedRef === 'HEAD' && info.currentBranch ? `refs/heads/${info.currentBranch}` : selectedRef
    if (baseRef !== 'HEAD' && !info.branches.some(branch => branch.ref === baseRef)) throw new Error('所选基准分支已不存在，请重新选择')
    const baseCommit = await git(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])
    const part = relative(repositoryRoot, sourcePrimaryDirectory)
    if (!within(repositoryRoot, sourcePrimaryDirectory)) throw new Error('空间主目录不在 Git 仓库内')
    if (part && await git(repositoryRoot, ['cat-file', '-t', `${baseCommit}:${part.split(sep).join('/')}`]).catch(() => '') !== 'tree') {
      throw new Error('所选基准版本不包含空间主目录，请选择其他分支')
    }
    const id = randomUUID()
    const checkoutRoot = join(await realpath(resolveUserDataHome()), 'worktrees', project.id, id, basename(repositoryRoot))
    return {
      id, projectId: project.id, sourcePrimaryDirectory, repositoryRoot,
      gitCommonDirectory: commonDirectory(repositoryRoot), checkoutRoot, workdir: join(checkoutRoot, part),
      baseRef, baseCommit, creationRequestId: selection.requestId!, state: 'creating', branch: `uniagent/task-${id}`
    }
  }

  async create(tree: SessionWorktree): Promise<SessionWorktree> {
    return inRepository(tree.gitCommonDirectory, () => this.createInRepository(tree))
  }

  private async createInRepository(tree: SessionWorktree): Promise<SessionWorktree> {
    assertWorktreeNotRemoving({ workdir: tree.workdir, worktree: tree })
    if (tree.removedAt) throw new Error('工作树已清理，请重试删除任务记录')
    if (await realpath(tree.sourcePrimaryDirectory) !== tree.sourcePrimaryDirectory || commonDirectory(tree.repositoryRoot) !== tree.gitCommonDirectory) throw new Error('原仓库已变化，无法继续创建工作树')
    const ready: SessionWorktree = { ...tree, state: 'ready' }
    delete ready.lastError
    if (existsSync(join(tree.checkoutRoot, '.git'))) {
      assertWorktreeAvailable({ projectId: tree.projectId, worktree: ready })
      return saveSyncState(await syncState(ready))
    }
    if (existsSync(tree.checkoutRoot) && (await readdir(tree.checkoutRoot)).length) throw new Error(`工作树目录已有未完成内容，请先检查：${tree.checkoutRoot}`)
    await mkdir(dirname(tree.checkoutRoot), { recursive: true })
    if (await realpath(dirname(tree.checkoutRoot)) !== dirname(tree.checkoutRoot)) throw new Error('工作树存放目录已变化，请检查后重试')
    ready.baseCommit = await sourceCommit(tree)
    ready.lastSourceCommit = ready.baseCommit
    ready.lastSyncedCommit = ready.baseCommit
    ready.branch = tree.branch || `uniagent/task-${tree.id}`
    await git(tree.repositoryRoot, ['worktree', 'add', '-b', ready.branch, tree.checkoutRoot, ready.baseCommit])
    assertWorktreeAvailable({ projectId: tree.projectId, worktree: ready })
    return saveSyncState(ready)
  }

  async inspectArchive(tree: SessionWorktree, signal?: AbortSignal): Promise<WorktreeArchiveCheck> {
    signal?.throwIfAborted()
    assertWorktreeAvailable({ projectId: tree.projectId, worktree: tree })
    await taskBranch(tree)
    if (!tree.baseRef.startsWith('refs/heads/')) throw new Error('没有可核验的本机源分支，请先恢复源分支')
    let gitOperation: string | undefined
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      const path = await git(tree.checkoutRoot, ['rev-parse', '--git-path', name], signal)
      if (await access(resolve(tree.checkoutRoot, path)).then(() => true, () => false)) { gitOperation = name; break }
    }
    const { changedFiles, unmergedCommits } = await worktreeChanges(tree, signal)
    return { treeId: tree.id, sourceBranch: tree.baseRef.slice('refs/heads/'.length), changedFiles, unmergedCommits, ...(gitOperation ? { gitOperation } : {}) }
  }

  async inspectStatus(tree: SessionWorktree): Promise<SessionWorktreeStatus> {
    assertWorktreeAvailable({ projectId: tree.projectId, worktree: tree })
    const branch = await taskBranch(tree)
    const { source, head, changedFiles, unmergedCommits } = await worktreeChanges(tree)
    const fields = unmergedCommits ? (await git(tree.checkoutRoot, ['log', '-z', '--format=%H%x00%s', '--max-count=50', `${source}..${head}`, '--'])).split('\0') : []
    const commits: SessionWorktreeStatus['commits'] = []
    for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ hash: fields[i], subject: fields[i + 1] })
    return { treeId: tree.id, directory: tree.workdir, sourceBranch: tree.baseRef.slice('refs/heads/'.length), branch: branch || undefined, changedFiles, unmergedCommits, commits, checkedAt: Date.now() }
  }

  async prepare(tree: SessionWorktree, autoSyncBack: boolean, canWrite: (path: string) => boolean = () => true): Promise<SessionWorktree> {
    return inRepository(tree.gitCommonDirectory, async () => {
      assertWorktreeAvailable({ projectId: tree.projectId, worktree: tree })
      tree = await syncState(tree)
      const head = await git(tree.checkoutRoot, ['rev-parse', 'HEAD'])
      let branch = await taskBranch(tree)
      if (!await ancestor(tree.checkoutRoot, tree.baseCommit, head)) throw new Error('工作树历史已改写，自动同步已暂停')
      if (!branch) {
        if (!canWrite(tree.checkoutRoot)) throw new Error('工作树仍有其他运行任务，暂时无法创建分支')
        branch = `uniagent/task-${tree.id}`
        await git(tree.checkoutRoot, ['switch', '-c', branch])
      }
      return saveSyncState({ ...tree, branch, autoSyncBack })
    })
  }
}

export const WORKTREE_MERGE_GUARD = '回源前在源分支检出目录执行 `git --no-optional-locks status --porcelain --untracked-files=no`；有输出即停止，提示“源分支有其他 Session 正在工作，请稍后合入”。不得 stash、代提交、reset/clean 或覆盖源改动；无法确认目录或状态则停止。'

export function worktreeInstructions(config: SessionConfig): string {
  const tree = config.worktree
  if (!tree) return config.workspaceNotice ? `${config.workspaceNotice}\n本会话原工作树已删除，后续任务使用当前空间主目录：${JSON.stringify(config.workdir)}。不要沿用历史中的工作树路径。` : ''
  const sourceBranch = tree.baseRef === 'HEAD' ? `HEAD（${tree.baseCommit.slice(0, 7)}）` : tree.baseRef.replace(/^refs\/heads\//, '')
  return [
    `独立工作树分支：${tree.branch || 'detached HEAD'}；源分支：${sourceBranch}；源目录：${JSON.stringify(tree.sourcePrimaryDirectory)}。`,
    '每轮先检查本机源分支，有新提交则合并到当前工作树同步；保留改动，冲突由你分析，无法安全处理则说明阻塞。不自动 pull/push；附加目录共享。',
    `业务代码在工作树修改并提交；允许必要的源仓库 Git 操作。${tree.autoSyncBack === true ? '提交后由你合并回本机源分支。' : '不自动合并回源分支，提交后提醒；用户明确要求合并时执行。'}${WORKTREE_MERGE_GUARD}合后验证源分支包含本次提交。`
  ].join('\n')
}
