import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentUpdateStatusChecker } from '../src/main/agentUpdateStatusChecker.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uniagent-update-status-'))
  const file = join(directory, 'agent-update-status.json')
  const state = { checks: 0, updated: [] }
  const lifecycle = { checkAllUpdates: async () => { state.checks += 1; return [{ id: 'codex', lifecycle: { updateStatus: 'current' } }] } }
  return { file, state, lifecycle }
}

test('后台更新检查在首次启动执行一次', async () => {
  const { file, state, lifecycle } = fixture()
  const checker = new AgentUpdateStatusChecker({ file, lifecycle, onUpdated: (agents) => { state.updated.push(agents) } })
  await checker.run()
  assert.equal(state.checks, 1)
  assert.equal(state.updated.length, 1)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(typeof stored.lastCheckedAt, 'number')
})

test('间隔内的重复启动不再检查', async () => {
  const { file, state, lifecycle } = fixture()
  let now = 1_000_000
  const options = { file, lifecycle, onUpdated: (agents) => { state.updated.push(agents) }, intervalMs: 60_000, now: () => now }
  const checker = new AgentUpdateStatusChecker(options)
  await checker.run()
  assert.equal(state.checks, 1)
  now += 30_000
  await checker.run()
  assert.equal(state.checks, 1, '间隔内不应重复访问注册表')
  now += 31_000
  await checker.run()
  assert.equal(state.checks, 2, '超过间隔后应重新检查')
  assert.equal(state.updated.length, 2)
})

test('并发触发只执行一次检查', async () => {
  const { file, state, lifecycle } = fixture()
  const checker = new AgentUpdateStatusChecker({ file, lifecycle, onUpdated: () => {} })
  await Promise.all([checker.run(), checker.run(), checker.run()])
  assert.equal(state.checks, 1)
})

test('检查失败不抛出，并且仍然记录节流时间', async () => {
  const { file, state } = fixture()
  const failing = { checkAllUpdates: async () => { throw new Error('registry unreachable') } }
  const checker = new AgentUpdateStatusChecker({ file, lifecycle: failing, onUpdated: () => {} })
  await assert.rejects(() => checker.run(), /registry unreachable/)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(typeof stored.lastCheckedAt, 'number')
  assert.equal(state.checks, 0)
})
