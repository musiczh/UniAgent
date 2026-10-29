import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getGitChangeSet } from '../src/main/gitChangeSet'
import { reviewGetFilePair } from '../src/main/reviewFiles'
import type { ReviewChangeItem, ReviewScope } from '../src/shared/types'

const execFileP = promisify(execFile)
const sandbox = await mkdtemp(join(tmpdir(), 'uniagent-review-scopes-'))
const workdir = join(sandbox, 'work')
const remote = join(sandbox, 'remote.git')
const nestedWorkdir = join(workdir, 'nested')
const git = (args: string[], cwd = workdir): Promise<string> =>
  execFileP('git', args, { cwd }).then(({ stdout }) => stdout.trim())
const paths = (items: ReviewChangeItem[]): string[] => items.map((item) => item.path).sort()

try {
  await mkdir(workdir)
  await git(['init', '--bare', '-q', remote], sandbox)
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'commit.gpgsign', 'false'])
  await mkdir(nestedWorkdir)

  for (const name of ['committed.txt', 'staged.txt', 'unstaged.txt', 'both.txt']) {
    await writeFile(join(workdir, name), 'base\n')
  }
  await writeFile(join(nestedWorkdir, 'sub.txt'), 'nested base\n')
  await writeFile(join(nestedWorkdir, '2:foo.txt'), 'colon base\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'baseline'])
  const upstreamCommit = await git(['rev-parse', 'HEAD'])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', '-q', '-u', 'origin', 'main'])

  await writeFile(join(workdir, 'committed.txt'), 'local commit\n')
  await git(['add', 'committed.txt'])
  await git(['commit', '-q', '-m', 'local committed change'])
  const localCommit = await git(['rev-parse', 'HEAD'])
  await writeFile(join(workdir, 'second-commit.txt'), 'second commit\n')
  await git(['add', 'second-commit.txt'])
  await git(['commit', '-q', '-m', 'second local commit'])
  const secondCommit = await git(['rev-parse', 'HEAD'])

  await writeFile(join(workdir, 'staged.txt'), 'staged\n')
  await writeFile(join(workdir, 'both.txt'), 'staged version\n')
  await git(['add', 'staged.txt', 'both.txt'])
  await writeFile(join(workdir, 'both.txt'), 'unstaged version\n')
  await writeFile(join(workdir, 'unstaged.txt'), 'unstaged\n')
  await writeFile(join(workdir, 'untracked.txt'), 'untracked\n')

  const workspace = await getGitChangeSet(workdir, { kind: 'workspace' })
  assert.deepEqual(paths(workspace.items), ['both.txt', 'staged.txt', 'unstaged.txt', 'untracked.txt'])
  assert.equal(workspace.upstream, 'origin/main')
  assert.deepEqual(workspace.commits, [
    { sha: secondCommit, title: 'second local commit' },
    { sha: localCommit, title: 'local committed change' }
  ])

  const unstaged = await getGitChangeSet(workdir, { kind: 'unstaged' })
  assert.deepEqual(paths(unstaged.items), ['both.txt', 'unstaged.txt', 'untracked.txt'])
  const unstagedBoth = unstaged.items.find((item) => item.path === 'both.txt')!
  assert.deepEqual(
    await reviewGetFilePair(pairRequest(unstagedBoth, { kind: 'unstaged' }), workdir),
    { path: 'both.txt', kind: 'modify', before: 'staged version\n', after: 'unstaged version\n' }
  )

  const staged = await getGitChangeSet(workdir, { kind: 'staged' })
  assert.deepEqual(paths(staged.items), ['both.txt', 'staged.txt'])
  const stagedBoth = staged.items.find((item) => item.path === 'both.txt')!
  assert.deepEqual(
    await reviewGetFilePair(pairRequest(stagedBoth, { kind: 'staged' }), workdir),
    { path: 'both.txt', kind: 'modify', before: 'base\n', after: 'staged version\n' }
  )

  const branch = await getGitChangeSet(workdir, { kind: 'branch' })
  assert.deepEqual(paths(branch.items), ['committed.txt', 'second-commit.txt'])
  const branchFile = branch.items.find((item) => item.path === 'committed.txt')!
  assert.deepEqual(
    await reviewGetFilePair(pairRequest(branchFile, { kind: 'branch' }), workdir),
    { path: 'committed.txt', kind: 'modify', before: 'base\n', after: 'local commit\n' }
  )

  const commitScope: ReviewScope = { kind: 'commit', sha: localCommit }
  const commit = await getGitChangeSet(workdir, commitScope)
  assert.deepEqual(paths(commit.items), ['committed.txt'])
  assert.deepEqual(
    await reviewGetFilePair(pairRequest(commit.items[0], commitScope), workdir),
    { path: 'committed.txt', kind: 'modify', before: 'base\n', after: 'local commit\n' }
  )
  assert.deepEqual(
    (await getGitChangeSet(workdir, { kind: 'commit', sha: 'HEAD' as string })).items,
    [],
    'renderer-provided refs are rejected; commit scope accepts only full object ids'
  )
  assert.deepEqual(
    (await getGitChangeSet(workdir, { kind: 'commit', sha: upstreamCommit })).items,
    [],
    'commit scope is limited to commits ahead of the configured upstream'
  )

  await writeFile(join(nestedWorkdir, 'sub.txt'), 'nested dirty\n')
  await writeFile(join(nestedWorkdir, '2:foo.txt'), 'colon staged\n')
  await git(['add', 'nested/2:foo.txt'])
  await writeFile(join(nestedWorkdir, '2:foo.txt'), 'colon unstaged\n')

  const nestedWorkspace = await getGitChangeSet(nestedWorkdir, { kind: 'workspace' })
  assert.deepEqual(
    paths(nestedWorkspace.items),
    ['2:foo.txt', 'sub.txt'],
    'a subdirectory workdir exposes only workdir-relative changes'
  )
  const nestedUnstaged = await getGitChangeSet(nestedWorkdir, { kind: 'unstaged' })
  const nestedUnstagedColon = nestedUnstaged.items.find((item) => item.path === '2:foo.txt')!
  assert.deepEqual(
    await reviewGetFilePair(pairRequest(nestedUnstagedColon, { kind: 'unstaged' }), nestedWorkdir),
    { path: '2:foo.txt', kind: 'modify', before: 'colon staged\n', after: 'colon unstaged\n' },
    'index reads use stage 0 even when a filename starts with a stage-like prefix'
  )
  const nestedStaged = await getGitChangeSet(nestedWorkdir, { kind: 'staged' })
  assert.deepEqual(paths(nestedStaged.items), ['2:foo.txt'])
  assert.deepEqual(
    await reviewGetFilePair(pairRequest(nestedStaged.items[0], { kind: 'staged' }), nestedWorkdir),
    { path: '2:foo.txt', kind: 'modify', before: 'colon base\n', after: 'colon staged\n' }
  )
  assert.deepEqual(
    await reviewGetFilePair({
      sessionId: 'test',
      path: 'committed.txt',
      unifiedDiff: '',
      kind: 'modify',
      scope: { kind: 'staged' }
    }, nestedWorkdir),
    { path: 'committed.txt', kind: 'modify', before: '', after: '', degraded: true },
    'a workdir-relative request cannot read a Git blob above that workdir'
  )

  await git(['branch', '--unset-upstream'])
  const noUpstream = await getGitChangeSet(workdir, { kind: 'branch' })
  assert.equal(noUpstream.isGitRepo, true)
  assert.equal(noUpstream.upstream, undefined)
  assert.deepEqual(noUpstream.items, [])

  const sha256Workdir = join(sandbox, 'sha256-work')
  const sha256Remote = join(sandbox, 'sha256-remote.git')
  await mkdir(sha256Workdir)
  await git(['init', '--bare', '-q', '--object-format=sha256', sha256Remote], sandbox)
  await git(['init', '-q', '-b', 'main', '--object-format=sha256'], sha256Workdir)
  await git(['config', 'user.email', 'test@example.com'], sha256Workdir)
  await git(['config', 'user.name', 'Test'], sha256Workdir)
  await writeFile(join(sha256Workdir, 'file.txt'), 'base\n')
  await git(['add', 'file.txt'], sha256Workdir)
  await git(['commit', '-q', '-m', 'baseline'], sha256Workdir)
  await git(['remote', 'add', 'origin', sha256Remote], sha256Workdir)
  await git(['push', '-q', '-u', 'origin', 'main'], sha256Workdir)
  await writeFile(join(sha256Workdir, 'file.txt'), 'local\n')
  await git(['add', 'file.txt'], sha256Workdir)
  await git(['commit', '-q', '-m', 'local'], sha256Workdir)
  const sha256Commit = await git(['rev-parse', 'HEAD'], sha256Workdir)
  assert.equal(sha256Commit.length, 64)
  assert.equal(
    (await getGitChangeSet(sha256Workdir, { kind: 'commit', sha: sha256Commit })).items.length,
    1
  )
  assert.deepEqual(
    (await getGitChangeSet(sha256Workdir, { kind: 'commit', sha: sha256Commit.slice(0, 40) })).items,
    [],
    'commit scope rejects abbreviated SHA-256 object ids'
  )

  console.log('review-change-scopes: all assertions passed')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

function pairRequest(item: ReviewChangeItem, scope: ReviewScope) {
  return {
    sessionId: 'test',
    path: item.path,
    oldPath: item.oldPath,
    unifiedDiff: item.unifiedDiff,
    kind: item.kind === 'rename' ? 'modify' as const : item.kind,
    scope
  }
}
