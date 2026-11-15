import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeService, worktreeInstructions } from '../src/main/worktreeService'
import type { Project, SessionConfig, SessionWorktree } from '../src/shared/types'

const execFileP = promisify(execFile)
const sandbox = await mkdtemp(join(tmpdir(), 'uniagent-worktree-instructions-'))
process.env.UNIAGENT_USER_DATA = join(sandbox, 'user-data')
const git = (args: string[], cwd: string): Promise<string> =>
  execFileP('git', args, { cwd }).then(({ stdout }) => stdout.trim())

const fakeTree = (overrides: Partial<SessionWorktree>): SessionWorktree => ({
  id: randomUUID(), projectId: 'project-1', sourcePrimaryDirectory: '/repo', repositoryRoot: '/repo',
  gitCommonDirectory: '/repo/.git', checkoutRoot: '/repo-worktree', workdir: '/repo-worktree',
  baseRef: 'refs/heads/master', baseCommit: '1'.repeat(40), creationRequestId: randomUUID(), state: 'ready',
  ...overrides
})
const configOf = (worktree?: SessionWorktree): SessionConfig =>
  ({ agentId: 'codex', workdir: worktree?.workdir || '/repo', worktree }) as SessionConfig

try {
  // 每轮同步与提交后回源均由 Agent 执行，关闭回源设置时仅提醒。
  const text = worktreeInstructions(configOf(fakeTree({ baseRef: 'refs/heads/master', autoSyncBack: true })))
  assert.match(text, /独立工作树分支：detached HEAD；源分支：master/)
  assert.match(text, /提交后由你合并回本机源分支/)
  assert.match(text, /验证源分支包含本次提交/)
  assert.match(text, /`git --no-optional-locks status --porcelain --untracked-files=no`/)
  assert.match(text, /有输出即停止.*其他 Session.*稍后/)
  assert.match(text, /不得 stash、代提交、reset\/clean 或覆盖源改动/)
  assert.match(text, /无法确认目录或状态则停止/)
  assert.match(text, /允许.*源仓库.*Git 操作/)
  assert.match(text, /有新提交.*合并/)
  assert.doesNotMatch(text, /宿主自动合回|请勿重复合并/)
  assert.match(text, /每轮.*本机源分支.*同步/)
  assert.match(text, /冲突.*分析/)
  assert.equal(text.split('\n').length, 3)
  assert.ok(text.length < 350, '工作树提示保持精简，只提供必要的源目录和操作边界')
  assert.match(worktreeInstructions(configOf(fakeTree({ branch: 'uniagent/task-example', autoSyncBack: false }))), /uniagent\/task-example[\s\S]*用户明确要求合并/)
  assert.match(worktreeInstructions(configOf(fakeTree({ autoSyncBack: false }))), /不自动合并回源分支/)
  assert.match(worktreeInstructions(configOf(fakeTree({ autoSyncBack: false }))), /用户明确要求.*合并/)
  assert.match(worktreeInstructions(configOf(fakeTree({}))), /不自动合并回源分支/, 'missing preference defaults to no automatic source merge')
  assert.ok(worktreeInstructions(configOf(fakeTree({ baseRef: 'refs/heads/feature/login' })))
    .includes('源分支：feature/login'), '来源分支去掉 refs/heads/ 前缀')
  assert.ok(worktreeInstructions(configOf(fakeTree({ baseRef: 'HEAD', baseCommit: '2'.repeat(40) })))
    .includes(`源分支：HEAD（${'2'.repeat(7)}）`), '无来源分支时回退显示基准提交')
  assert.equal(worktreeInstructions(configOf(undefined)), '', '非工作树会话不注入该说明')

  // allocate 默认 HEAD 解析为空间主目录当前分支，供提示词写出来源分支。
  const workdir = join(sandbox, 'repo')
  const userData = process.env.UNIAGENT_USER_DATA!
  await mkdir(workdir)
  await mkdir(userData, { recursive: true })
  await git(['init', '-q', '-b', 'main'], workdir)
  await git(['config', 'user.email', 'test@example.com'], workdir)
  await git(['config', 'user.name', 'Test'], workdir)
  await git(['config', 'commit.gpgsign', 'false'], workdir)
  await writeFile(join(workdir, 'README.md'), 'base\n')
  await git(['add', '.'], workdir)
  await git(['commit', '-q', '-m', 'baseline'], workdir)
  const headCommit = await git(['rev-parse', 'HEAD'], workdir)
  const service = new WorktreeService()
  const project = (primaryDirectory: string): Project => ({
    id: randomUUID(), name: 'test', primaryDirectory, additionalDirectories: [], createdAt: Date.now(), updatedAt: Date.now()
  })

  const nonGit = join(sandbox, 'non-git')
  await mkdir(nonGit)
  const previousLocale = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE }
  try {
    for (const locale of ['C', 'zh_CN.UTF-8', 'fr_FR.UTF-8']) {
      process.env.LC_ALL = locale
      process.env.LANGUAGE = locale
      const info = await service.inspect(project(nonGit))
      assert.equal(info.canCreateWorktree, false, `${locale}: 非 Git 目录不能创建工作树`)
      assert.equal(info.inspectionFailed, undefined, `${locale}: 非 Git 目录不是检测失败`)
      assert.equal(info.unavailableReason, '主目录不是可用的 Git 仓库')
      assert.equal(await service.defaultSelection(project(nonGit), undefined, true), undefined, `${locale}: 默认工作树不阻止普通任务`)
    }
  } finally {
    for (const [key, value] of Object.entries(previousLocale)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const missing = project(join(sandbox, 'missing'))
  assert.equal((await service.inspect(missing)).inspectionFailed, true, '不存在的目录仍保留真实检测失败')
  await assert.rejects(service.defaultSelection(missing, undefined, true), /检测失败/)
  assert.deepEqual(await service.defaultSelection(missing, { mode: 'local' }, true), { mode: 'local' }, '显式普通任务不依赖 Git 检测')

  const fromHead = await service.allocate(project(workdir), { mode: 'worktree', baseRef: 'HEAD', requestId: randomUUID() })
  assert.equal(fromHead.baseRef, 'refs/heads/main', '默认 HEAD 解析为空间主目录当前分支')
  assert.equal(fromHead.baseCommit, headCommit)
  assert.ok(worktreeInstructions(configOf(fromHead)).includes('源分支：main'), '提示词写出解析后的来源分支')

  const explicit = await service.allocate(project(workdir), { mode: 'worktree', baseRef: 'refs/heads/main', requestId: randomUUID() })
  assert.equal(explicit.baseRef, 'refs/heads/main', '显式指定的基准分支保持不变')

  await git(['checkout', '-q', '--detach', 'HEAD'], workdir)
  const detached = await service.allocate(project(workdir), { mode: 'worktree', baseRef: 'HEAD', requestId: randomUUID() })
  assert.equal(detached.baseRef, 'HEAD', '源目录 detached 时保留 HEAD')
  await assert.rejects(
    service.allocate(project(workdir), { mode: 'worktree', baseRef: 'refs/heads/missing', requestId: randomUUID() }),
    /所选基准分支已不存在/,
    '不存在的基准分支仍被拒绝'
  )

  console.log('worktree-instructions: all assertions passed')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}
