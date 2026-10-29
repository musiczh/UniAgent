import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Orchestrator } from '../src/main/orchestrator.ts'
import type { Session, UASubAgent } from '../src/shared/types.ts'
import { IPC } from '../src/shared/types.ts'

assert.equal(typeof Orchestrator.prototype.cancelSubAgent, 'function', 'the sub-agent detail has a native cancellation route')
const session: Session = {
  id: 'owner', title: 'Parent', status: 'running', createdAt: 1, nativeSessionId: 'native-owner',
  config: { agentId: 'grok', workdir: '/isolated-fixture' },
  subagents: [{ agentThreadId: 'child', parentThreadId: 'native-owner', status: 'running' }]
}
const child = session.subagents![0]
const accepted: string[] = []
let failure: Error | undefined
const runner = { async cancelSubAgent(id: string) { if (failure) throw failure; accepted.push(id) } }
// Exercise the real boundary without constructors, disk state or a live provider.
const host = Object.assign(Object.create(Orchestrator.prototype), {
  worktreeTransitions: new Set(),
  sessions: new Map([[session.id, session]]), protocolRunners: new Map([[session.id, runner]]),
  getAgent: (id: string) => ({ adapter: id })
}) as Orchestrator

await host.cancelSubAgent('owner', 'child')
assert.deepEqual(accepted, ['child'])
assert.equal(session.status, 'running', 'cancelling a child does not stop its parent')
assert.equal(child.status, 'running', 'native lifecycle notifications own terminal status')
session.config.agentId = 'deepseek'
await host.cancelSubAgent('owner', 'child')
assert.deepEqual(accepted, ['child', 'child'])
session.config.agentId = 'kimi'
await host.cancelSubAgent('owner', 'child')
assert.deepEqual(accepted, ['child', 'child', 'child'])
session.config.agentId = 'deepseek'

async function denied(mutate: () => void, reset: () => void, expected: RegExp): Promise<void> {
  const before = accepted.length
  mutate()
  try { await assert.rejects(host.cancelSubAgent('owner', 'child'), expected) }
  finally { reset() }
  assert.equal(accepted.length, before, 'rejected cancellation never reaches the native provider')
}
await assert.rejects(host.cancelSubAgent('missing', 'child'), /会话不存在/)
await assert.rejects(host.cancelSubAgent('owner', 'foreign-child'), /不属于当前会话/)
for (const value of ['', ' child', 'child\n', 'child\u0000']) {
  await assert.rejects(host.cancelSubAgent('owner', value), /无效/)
}
await denied(() => { session.teamBinding = { teamProjectId: 'project', memberId: 'member' } }, () => { delete session.teamBinding }, /team_session_requires_project_route/)
await denied(() => { session.readOnly = true }, () => { delete session.readOnly }, /只读/)
await denied(() => { session.archived = true }, () => { delete session.archived }, /归档/)
await denied(() => { session.handoffId = 'tool-task' }, () => { delete session.handoffId }, /启用会话/)
await denied(() => { session.config.agentId = 'claude' }, () => { session.config.agentId = 'deepseek' }, /不支持/)
for (const status of ['pendingInit', 'completed', 'interrupted', 'errored'] as UASubAgent['status'][]) {
  await denied(() => { child.status = status }, () => { child.status = 'running' }, /未在运行/)
}
await denied(() => { session.status = 'idle' }, () => { session.status = 'running' }, /未在运行/)
await denied(() => { child.parentThreadId = 'another-parent' }, () => { child.parentThreadId = 'native-owner' }, /不属于当前会话/)
await denied(() => { session.subagents!.push({ ...child }) }, () => { session.subagents!.pop() }, /不属于当前会话/)
await denied(() => { (host as any).protocolRunners.delete('owner') }, () => { (host as any).protocolRunners.set('owner', runner) }, /未连接/)
failure = new Error('Native provider did not accept cancellation')
await assert.rejects(host.cancelSubAgent('owner', 'child'), /did not accept/)
assert.equal(child.status, 'running', 'a rejected native cancellation keeps the child running')

assert.equal(IPC.subagentCancel, 'subagent:cancel')
const main = readFileSync('src/main/index.ts', 'utf8')
assert.match(main, /handleUserSessionMutation\(IPC\.subagentCancel/)
assert.match(main, /orchestrator\.cancelSubAgent\(sessionId, agentThreadId\)/)
assert.match(readFileSync('src/preload/index.ts', 'utf8'), /invoke\(IPC\.subagentCancel, sessionId, agentThreadId\)/)
console.log('subagent-cancel: native dispatch, ownership, lifecycle, team, readonly and IPC guards passed')
