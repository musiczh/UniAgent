import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { AppServerRunner } from '../src/main/appServerAdapter'
import { agentAdditionalDirectories, buildCommand, developerInstructions } from '../src/main/adapter'
import { Orchestrator } from '../src/main/orchestrator'
import { SessionStore } from '../src/main/sessionStore'
import { WorktreeService } from '../src/main/worktreeService'
import type { AgentDef, SessionConfig } from '../src/shared/types'

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])).stdout.trim()
const agent = (id: 'codex' | 'traex' | 'grok' = 'codex'): AgentDef => ({ id, name: id, adapter: id, bin: '/usr/bin/true', installed: true, builtin: true, icon: '', models: [], capabilities: { streaming: true, permissionModes: [{ id: 'ask', label: '询问' }] } })
const commit = async (cwd: string, name: string) => { await writeFile(join(cwd, name), name); await git(cwd, 'add', name); await git(cwd, 'commit', '-qm', name); return git(cwd, 'rev-parse', 'HEAD') }
async function fixture(root: string) {
  const cwd = join(root, 'repo'); await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main'); await git(cwd, 'config', 'user.name', 'Test'); await git(cwd, 'config', 'user.email', 'test@example.invalid'); await git(cwd, 'config', 'commit.gpgsign', 'false')
  const base = await commit(cwd, 'base.txt')
  const service = new WorktreeService(), project = { id: randomUUID(), name: 'Test', primaryDirectory: cwd, additionalDirectories: [], createdAt: 1, updatedAt: 1 }
  const tree = await service.create(await service.allocate(project, { mode: 'worktree', requestId: randomUUID() }))
  return { cwd, base, tree }
}

await test('commit/tool/turn events do not merge source behind the Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worktree-no-host-merge-')), before = process.env.UNIAGENT_USER_DATA
  process.env.UNIAGENT_USER_DATA = root
  const host = new Orchestrator(() => agent(), new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'), join(root, 'logs'))
  try {
    const { cwd, base, tree } = await fixture(root)
    const { session } = (host as any).createSessionRecord({ agentId: 'codex', projectId: tree.projectId, workdir: tree.workdir, worktree: tree, permissionMode: 'ask' }, 'Agent 合回')
    await (host as any).worktreeRuntime.prepare(session)
    await commit(tree.workdir, 'task.txt')
    for (const type of ['command_exec', 'tool_call', 'turn_completed']) host.emit('event', { sessionId: session.id, seq: 1, ts: 1, type, state: 'success', payload: {} })
    await (host as any).worktreeRuntime.settle([session])
    assert.equal(await git(cwd, 'rev-parse', 'HEAD'), base, 'the host must not programmatically merge after a commit')
  } finally { await host.closeSessionLogs(); if (before === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = before; await rm(root, { recursive: true, force: true }) }
})

class RecordingAgent extends EventEmitter {
  requests: Array<{ method: string; params: any }> = []
  instructions = ''
  blocked = false
  failCheck = false
  turn = 0
  constructor(private readonly source: string, private readonly branch: string) { super() }
  async start() {}
  notify() {}
  respond() {}
  interrupt() {}
  async dispose() {}
  async request<T>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'config/read') return { config: {} } as T
    if (method === 'thread/start' || method === 'thread/resume') {
      this.instructions = params.developerInstructions || ''
      return { thread: { id: 'merge-thread' } } as T
    }
    if (method === 'turn/start') {
      // The provider fixture executes the requested Git tool in a temporary repository.
      // This validates the wire policy and merge result, not real-model compliance.
      this.blocked = false
      if (this.instructions.includes('提交后由你合并回本机源分支')) {
        const check = this.instructions.match(/`git ([^`]+)`/)
        if (check) {
          if (this.failCheck) throw new Error('source status unavailable')
          this.blocked = !!await git(this.source, ...check[1].split(' '))
        }
        if (!this.blocked) await git(this.source, 'merge', '--no-edit', this.branch)
      }
      return { turn: { id: 'turn-' + ++this.turn } } as T
    }
    if (method === 'thread/goal/get') return { goal: null } as T
    return {} as T
  }
  finish() { this.emit('notification', 'turn/completed', { threadId: 'merge-thread', turn: { id: 'turn-' + this.turn, status: 'completed' } }) }
}

await test('Codex/TraeX receive merge policy, preserve source drafts and refresh it on setting changes', async () => {
  for (const id of ['codex', 'traex'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'worktree-agent-policy-')), before = process.env.UNIAGENT_USER_DATA
    process.env.UNIAGENT_USER_DATA = root
    let runner: AppServerRunner | undefined
    try {
      const { cwd, base, tree } = await fixture(root), rpc = new RecordingAgent(cwd, tree.branch!)
      let launchArgs: string[] = []
      let config: SessionConfig = { agentId: id, workdir: tree.workdir, projectId: tree.projectId, permissionMode: 'ask', worktree: { ...tree, autoSyncBack: true } }
      runner = new AppServerRunner('merge-policy-' + id, { n: 0 }, agent(id), config, undefined, undefined, options => { launchArgs = options.args; return rpc })
      runner.setInitialTitleGenerationPolicy(() => false)
      await writeFile(join(cwd, 'unrelated.txt'), 'other task draft')
      const first = await commit(tree.workdir, 'first.txt')
      await runner.startTurn('提交后按设置完成回源')
      assert.match(rpc.instructions, /提交后由你合并回本机源分支/, id)
      assert.match(rpc.instructions, /验证源分支包含本次提交/, id)
      assert.match(rpc.instructions, /允许.*源仓库.*Git 操作/, id)
      assert.match(rpc.instructions, /有输出即停止.*其他 Session.*稍后/)
      assert.match(rpc.instructions, /不得 stash、代提交、reset\/clean 或覆盖源改动/)
      assert.match(rpc.instructions, /不自动 pull\/push/)
      const start = rpc.requests.find(request => request.method === 'thread/start')!.params
      const roots = id === 'codex' ? start.config['sandbox_workspace_write.writable_roots'] : JSON.parse(launchArgs.find(arg => arg.startsWith('sandbox_workspace_write.writable_roots='))!.split('=').slice(1).join('='))
      assert.deepEqual(roots, [tree.repositoryRoot, tree.gitCommonDirectory])
      assert.notEqual(start.sandbox, 'danger-full-access', 'adding source roots must preserve the selected permission mode')
      assert.ok(rpc.instructions.includes(JSON.stringify(tree.sourcePrimaryDirectory)), 'Agent receives the canonical source directory')
      assert.doesNotMatch(rpc.instructions, /宿主自动合回|请勿重复合并/)
      assert.match(developerInstructions(config), /提交后由你合并回本机源分支/, 'CLI/Claude instruction builder uses the same policy')
      assert.equal(await git(cwd, 'rev-parse', 'HEAD'), first)
      assert.equal(await readFile(join(cwd, 'unrelated.txt'), 'utf8'), 'other task draft')
      rpc.finish()
      config = { ...config, worktree: { ...tree, autoSyncBack: false } }; runner.updateConfig(config)
      const second = await commit(tree.workdir, 'second.txt')
      await runner.startTurn('关闭回源后继续提交')
      assert.match(rpc.instructions, /不自动合并回源分支/)
      assert.doesNotMatch(rpc.instructions, /提交后由你合并回本机源分支/)
      assert.equal(await git(cwd, 'rev-parse', 'HEAD'), first, 'disabled setting must reach the existing native thread')
      rpc.finish()
      config = { ...config, worktree: { ...tree, autoSyncBack: true } }; runner.updateConfig(config)
      await runner.startTurn('重新开启后完成回源')
      assert.equal(await git(cwd, 'merge-base', '--is-ancestor', second, 'main'), '')
      assert.notEqual(await git(cwd, 'rev-parse', 'HEAD'), base)
      assert.equal(rpc.requests.filter(request => request.method === 'thread/resume').length, 2, 'policy changes refresh the same thread rather than keeping old instructions')
      rpc.finish()
      await writeFile(join(cwd, 'base.txt'), 'source changed'); await git(cwd, 'add', 'base.txt'); await git(cwd, 'commit', '-qm', 'source change')
      await writeFile(join(tree.workdir, 'base.txt'), 'task changed'); await git(tree.workdir, 'add', 'base.txt'); await git(tree.workdir, 'commit', '-qm', 'task change')
      const sourceBefore = await git(cwd, 'rev-parse', 'HEAD'), taskBefore = await git(tree.workdir, 'rev-parse', 'HEAD'), failedEvents: any[] = []
      runner.on('event', event => failedEvents.push(event))
      await runner.startTurn('分析冲突，无法安全合入时说明阻塞')
      assert.equal(await git(cwd, 'rev-parse', 'HEAD'), sourceBefore, 'a merge conflict must not be reported as merged')
      assert.equal(await git(tree.workdir, 'rev-parse', 'HEAD'), taskBefore)
      assert.match(await git(cwd, 'status', '--porcelain'), /UU base.txt/)
      assert.ok(failedEvents.some(event => event.type === 'error'), 'failed merge tool reaches the normal error path')
      assert.ok(!failedEvents.some(event => event.type === 'turn_completed' && event.state === 'success'))
      assert.equal(await readFile(join(cwd, 'unrelated.txt'), 'utf8'), 'other task draft')
    } finally { await runner?.waitForDisposal(); if (before === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = before; await rm(root, { recursive: true, force: true }) }
  }
})

await test('source tracked drafts stop an otherwise conflict-free Agent merge; untracked files alone do not', async () => {
  for (const mode of ['unstaged', 'staged', 'both', 'deleted', 'renamed', 'untracked', 'check-failed'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'worktree-source-draft-')), before = process.env.UNIAGENT_USER_DATA
    process.env.UNIAGENT_USER_DATA = root
    let runner: AppServerRunner | undefined
    try {
      const { cwd, tree } = await fixture(root), rpc = new RecordingAgent(cwd, tree.branch!)
      await commit(tree.workdir, 'task-only.txt')
      if (['unstaged', 'staged', 'both'].includes(mode)) await writeFile(join(cwd, 'base.txt'), 'other session draft')
      if (mode === 'staged' || mode === 'both') await git(cwd, 'add', 'base.txt')
      if (mode === 'both') await writeFile(join(cwd, 'base.txt'), 'newer unstaged draft')
      if (mode === 'deleted') await unlink(join(cwd, 'base.txt'))
      if (mode === 'renamed') { await rename(join(cwd, 'base.txt'), join(cwd, 'other\nsession.txt')); await git(cwd, 'add', '-A') }
      await writeFile(join(cwd, 'untracked.txt'), 'untracked draft')
      rpc.failCheck = mode === 'check-failed'
      const sourceBefore = await git(cwd, 'rev-parse', 'HEAD'), refsBefore = await git(cwd, 'show-ref')
      const statusBefore = await git(cwd, '--no-optional-locks', 'status', '--porcelain'), indexPath = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index'), indexBefore = await readFile(indexPath)
      const config: SessionConfig = { agentId: 'codex', projectId: tree.projectId, workdir: tree.workdir, permissionMode: 'ask', worktree: { ...tree, autoSyncBack: true } }
      runner = new AppServerRunner('source-draft-' + mode, { n: 0 }, agent(), config, undefined, undefined, () => rpc)
      runner.setInitialTitleGenerationPolicy(() => false)
      await runner.startTurn('完成任务后按当前回源规则合并')
      if (mode === 'untracked') {
        assert.notEqual(await git(cwd, 'rev-parse', 'HEAD'), sourceBefore)
        assert.equal(rpc.blocked, false)
      } else {
        assert.equal(await git(cwd, 'rev-parse', 'HEAD'), sourceBefore, mode + ': source HEAD must not move')
        assert.equal(await git(cwd, 'show-ref'), refsBefore, mode + ': source refs must not change')
        assert.deepEqual(await readFile(indexPath), indexBefore, mode + ': source index must not change')
        assert.equal(await git(cwd, '--no-optional-locks', 'status', '--porcelain'), statusBefore, mode + ': source draft must remain intact')
        assert.equal(rpc.blocked, mode !== 'check-failed')
      }
      assert.equal(await readFile(join(cwd, 'untracked.txt'), 'utf8'), 'untracked draft')
      if (mode === 'unstaged' || mode === 'staged') assert.equal(await readFile(join(cwd, 'base.txt'), 'utf8'), 'other session draft')
      if (mode === 'both') assert.equal(await readFile(join(cwd, 'base.txt'), 'utf8'), 'newer unstaged draft')
      if (mode === 'renamed') assert.equal(await readFile(join(cwd, 'other\nsession.txt'), 'utf8'), 'base.txt')
    } finally { await runner?.waitForDisposal(); if (before === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = before; await rm(root, { recursive: true, force: true }) }
  }
})

await test('CLI source roots cover Git metadata and preserve read-only mode', async () => {
  const tree = { repositoryRoot: '/source', gitCommonDirectory: '/source/.git', checkoutRoot: '/task', workdir: '/task', baseRef: 'refs/heads/main', baseCommit: '1'.repeat(40) } as NonNullable<SessionConfig['worktree']>
  const config: SessionConfig = { agentId: 'codex', workdir: '/task', worktree: tree, permissionMode: 'read-only', additionalDirectories: ['/docs', '/source'] }
  assert.deepEqual(agentAdditionalDirectories(config), ['/docs', '/source', '/source/.git'])
  for (const id of ['codex', 'traex', 'claude'] as const) {
    const definition = { ...agent(), id, adapter: id, capabilities: { ...agent().capabilities, permissionModes: [{ id: 'read-only' as const, label: '只读' }] } }
    const command = buildCommand(definition, { ...config, agentId: id }, '检查工作树')
    assert.ok(command.args.includes('/source')); assert.ok(command.args.includes('/source/.git'))
    assert.ok(!command.args.includes('--dangerously-bypass-approvals-and-sandbox'))
    if (id !== 'claude') assert.ok(command.args.includes('read-only'))
  }
})

await test('worktree protocol turns refresh the policy before sending input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worktree-protocol-policy-')), before = process.env.UNIAGENT_USER_DATA
  process.env.UNIAGENT_USER_DATA = root
  const host = new Orchestrator(() => agent('grok'), new SessionStore(join(root, 'sessions.json')), join(root, 'artifacts'), join(root, 'logs'))
  try {
    const { tree } = await fixture(root)
    const config: SessionConfig = { agentId: 'grok', projectId: tree.projectId, workdir: tree.workdir, permissionMode: 'ask', worktree: { ...tree, autoSyncBack: false } }
    const { session } = (host as any).createSessionRecord(config, '协议会话设置切换')
    const calls: string[] = []; let enabled = true
    ;(host as any).ensureProtocolRunner = () => ({ updateConfig: async (next: SessionConfig) => { enabled = next.worktree!.autoSyncBack!; calls.push('config:' + enabled) }, startTurn: async () => { calls.push('turn:' + enabled) } })
    ;(host as any).runProtocol(session, agent('grok'), '按当前设置执行', undefined, config)
    for (let i = 0; i < 100 && !calls.some(call => call.startsWith('turn:')); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(calls, ['config:false', 'turn:false'])
  } finally { await host.closeSessionLogs(); if (before === undefined) delete process.env.UNIAGENT_USER_DATA; else process.env.UNIAGENT_USER_DATA = before; await rm(root, { recursive: true, force: true }) }
})
