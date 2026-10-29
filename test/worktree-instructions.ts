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
  // 独立工作树会话的系统提示词要写明来源分支，并提醒把改动合并回去。
  const text = worktreeInstructions(configOf(fakeTree({ baseRef: 'refs/heads/master' })))
  assert.match(text, /当前在独立工作树分支，来源分支：master；完成任务后提醒用户把改动合并回来源分支。/)
  assert.ok(text.includes(`创建基准：${'1'.repeat(40)}`), '原有创建基准信息保留')
  assert.ok(worktreeInstructions(configOf(fakeTree({ baseRef: 'refs/heads/feature/login' })))
    .includes('来源分支：feature/login'), '来源分支去掉 refs/heads/ 前缀')
  assert.ok(worktreeInstructions(configOf(fakeTree({ baseRef: 'HEAD', baseCommit: '2'.repeat(40) })))
    .includes(`来源分支：HEAD（${'2'.repeat(7)}）`), '无来源分支时回退显示基准提交')
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

  const fromHead = await service.allocate(project(workdir), { mode: 'worktree', baseRef: 'HEAD', requestId: randomUUID() })
  assert.equal(fromHead.baseRef, 'refs/heads/main', '默认 HEAD 解析为空间主目录当前分支')
  assert.equal(fromHead.baseCommit, headCommit)
  assert.ok(worktreeInstructions(configOf(fromHead)).includes('来源分支：main'), '提示词写出解析后的来源分支')

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
