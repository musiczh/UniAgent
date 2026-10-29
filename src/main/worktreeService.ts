import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Project, ProjectGitInfo, ProjectWorktree, SessionConfig, SessionWorktree, WorkspaceSelection } from '../shared/types'
import { resolveUserDataHome } from './userData.ts'

const runFile = promisify(execFile)
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const PATH_FIELDS = ['sourcePrimaryDirectory', 'repositoryRoot', 'gitCommonDirectory', 'checkoutRoot', 'workdir'] as const
const removingWorktrees = new Set<string>()

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
    state: row.state as SessionWorktree['state'], ...(row.lastError ? { lastError: row.lastError as string } : {})
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

async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_.*)?|PREFIX|CEILING_DIRECTORIES|IMPLICIT_WORK_TREE|GRAFT_FILE|SHALLOW_FILE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS)$/.test(key)) delete env[key]
  }
  const { stdout } = await runFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-C', cwd, ...args], {
    env, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024
  })
  return stdout.trim()
}

export class WorktreeService {
  lockRemoval(path: string): () => void {
    if (removingWorktrees.has(path)) throw new Error('工作树正在删除')
    removingWorktrees.add(path)
    return () => removingWorktrees.delete(path)
  }

  async list(project: Project, saved: SessionWorktree[] = []): Promise<ProjectWorktree[]> {
    const root = await realpath(project.primaryDirectory)
    let output: string
    try { output = await git(root, ['worktree', 'list', '--porcelain', '-z']) }
    catch {
      if (!(await this.inspect(project)).canCreateWorktree && !saved.length) return []
      throw new Error('无法读取工作树，请检查空间主目录与 Git 注册')
    }
    const repositoryRoot = await realpath(await git(root, ['rev-parse', '--show-toplevel']))
    const gitCommonDirectory = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])))
    const managedRoot = join(await realpath(resolveUserDataHome()), 'worktrees')
    const rows: ProjectWorktree[] = []
    for (const record of output.split('\0\0').filter(Boolean)) {
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
        if (await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path ||
            await realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir']))) !== gitCommonDirectory) throw new Error('工作树 Git 注册已变化')
        if (fields.some(field => field === 'locked' || field.startsWith('locked '))) {
          row.state = 'locked'; row.removalBlockedReason = '工作树已被 Git 锁定'
        } else if (savedTree?.state === 'creating') {
          row.state = 'creating'; row.removalBlockedReason = '工作树正在创建'
        } else if (await git(path, ['status', '--porcelain', '--untracked-files=normal'])) {
          row.state = 'dirty'; row.removalBlockedReason = '含未提交或未跟踪文件，请先处理改动'
        } else if (row.commit && !/^0+$/.test(row.commit) && await git(path, ['rev-list', '-1', row.commit, '--not', '--branches', '--tags', '--remotes'])) {
          row.removalBlockedReason = '包含未被分支或标签保留的提交，请先创建分支'
        }
      } catch {
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
      return { branches: [], canCreateWorktree: false, unavailableReason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git 或主目录不可用' : '主目录不是可用的 Git 仓库' }
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
      baseRef, baseCommit, creationRequestId: selection.requestId!, state: 'creating'
    }
  }

  async create(tree: SessionWorktree): Promise<SessionWorktree> {
    if (await realpath(tree.sourcePrimaryDirectory) !== tree.sourcePrimaryDirectory || commonDirectory(tree.repositoryRoot) !== tree.gitCommonDirectory) throw new Error('原仓库已变化，无法继续创建工作树')
    const ready: SessionWorktree = { ...tree, state: 'ready' }
    delete ready.lastError
    if (existsSync(join(tree.checkoutRoot, '.git'))) {
      assertWorktreeAvailable({ projectId: tree.projectId, worktree: ready })
      return ready
    }
    if (existsSync(tree.checkoutRoot) && (await readdir(tree.checkoutRoot)).length) throw new Error(`工作树目录已有未完成内容，请先检查：${tree.checkoutRoot}`)
    await mkdir(dirname(tree.checkoutRoot), { recursive: true })
    if (await realpath(dirname(tree.checkoutRoot)) !== dirname(tree.checkoutRoot)) throw new Error('工作树存放目录已变化，请检查后重试')
    await git(tree.repositoryRoot, ['worktree', 'add', '--detach', tree.checkoutRoot, tree.baseCommit])
    assertWorktreeAvailable({ projectId: tree.projectId, worktree: ready })
    return ready
  }
}

export function worktreeInstructions(config: SessionConfig): string {
  const tree = config.worktree
  if (!tree) return config.workspaceNotice ? `${config.workspaceNotice}\n本会话原工作树已删除，后续任务使用当前空间主目录：${JSON.stringify(config.workdir)}。不要沿用历史中的工作树路径。` : ''
  const sourceBranch = tree.baseRef === 'HEAD' ? `HEAD（${tree.baseCommit.slice(0, 7)}）` : tree.baseRef.replace(/^refs\/heads\//, '')
  return [
    '本会话运行在 UniAgent 为当前空间创建的 Git 工作树内。',
    `当前在独立工作树分支，来源分支：${sourceBranch}；完成任务后提醒用户把改动合并回来源分支。`,
    `所属空间 ID：${JSON.stringify(tree.projectId)}`,
    `空间主目录：${JSON.stringify(tree.sourcePrimaryDirectory)}`,
    `当前工作目录：${JSON.stringify(tree.workdir)}`,
    `创建基准：${tree.baseCommit}`,
    '任务代码默认在当前工作树内修改，不要自行切回空间主目录。',
    '工作树初始为 detached HEAD；需要命名分支时按正常 Git 流程创建。',
    '本次仅包含基准提交，未提交改动、本地配置和依赖目录未自动复制。',
    '空间附加目录仍使用原路径，是共享目录，不属于工作树隔离范围。'
  ].join('\n')
}
