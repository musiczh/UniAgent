import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef } from '../src/shared/types.ts'

// DeepSeek 子 Agent 名册恢复与冷读门控。DeepSeek 已切换到 Host API 直连，稳定
// ACP 接入退役：原生子历史冷读桥（deepseekChildHistory）随之移除，
// getSubAgentItems 对 deepseek 一律返回空且不得拉起任何原生运行时。
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-child-history-'))
const previousData = process.env.UNIAGENT_USER_DATA
try {
  process.env.UNIAGENT_USER_DATA = fixture
  const store = new SessionStore(join(fixture, 'sessions.json'))
  store.saveOrThrow([{
    id: 'local-owner', title: 'Restored owner', config: { agentId: 'deepseek', workdir: fixture, permissionMode: 'ask' },
    status: 'idle', createdAt: 1, nativeSessionId: 'owner', origin: 'created',
    subagents: [
      { agentThreadId: 'child', parentThreadId: 'owner', status: 'completed', prompt: 'Inspect child', tokens: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
      { agentThreadId: 'running-child', parentThreadId: 'owner', status: 'running' },
      { agentThreadId: 'initializing-child', parentThreadId: 'owner', status: 'pendingInit' },
      { agentThreadId: 'child', status: 'running', message: 'Duplicate must not replace first entry' },
      { agentThreadId: ' child', status: 'completed' },
      { agentThreadId: 'invalid-status', status: 'invented' as any },
      { agentThreadId: 'invalid-parent', parentThreadId: 'owner\n', status: 'completed' },
      { agentThreadId: 'closed-dto', status: 'completed', unknownSecret: 'must not persist' } as any
    ]
  }])
  const agent: AgentDef = {
    id: 'deepseek', name: 'DeepSeek', adapter: 'deepseek', bin: join(fixture, 'dsh'), icon: '', builtin: true, models: [],
    capabilities: { protocol: 'web', modelSelect: true, reasoningEffort: true, permissionModes: [] }
  }
  const orchestrator = new Orchestrator(id => id === 'deepseek' ? agent : undefined, store)
  try {
    await orchestrator.loadPersisted()
    // Break caught: 名册恢复必须丢弃重复/空白/非法条目并把未完结状态归为
    // interrupted，内存与落盘都使用封闭 DTO。
    const roster = orchestrator.getSessionById('local-owner')!.subagents!
    assert.deepEqual(roster.map(child => [child.agentThreadId, child.status]), [
      ['child', 'completed'], ['running-child', 'interrupted'], ['initializing-child', 'interrupted'], ['closed-dto', 'completed']
    ])
    assert.deepEqual(roster[0].tokens, { inputTokens: 8, outputTokens: 3, totalTokens: 11 })
    assert.equal(roster[0].prompt, 'Inspect child')
    assert.equal('unknownSecret' in roster[3], false)
    const storedRoster = JSON.parse(await readFile(join(fixture, 'sessions.json'), 'utf8'))[0].subagents
    assert.equal(JSON.stringify(storedRoster).includes('unknownSecret'), false, 'saving roster also uses a closed DTO')
    // 稳定 ACP 退役后：名册条目存在也不再冷读原生历史，更不得为此起进程。
    assert.deepEqual(await orchestrator.getSubAgentItems('local-owner', 'child'), [], 'deepseek 子历史冷读已随稳定 ACP 一并退役')
    assert.equal((orchestrator as any).protocolRunners.size, 0, 'child history must not resume a runtime runner')
  } finally {
    orchestrator.disposeAll()
    await orchestrator.closeSessionLogs()
  }
} finally {
  if (previousData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousData
  await rm(fixture, { recursive: true, force: true })
}
console.log('deepseek-child-history: roster restore hygiene and retired native cold reads verified')
