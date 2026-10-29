import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACPRunner } from '../src/main/acp/acpRunner.ts'
import type { AgentDef } from '../src/shared/types.ts'

const dir = await mkdtemp(join(tmpdir(), 'uniagent-dsh-contract-'))
const bin = join(dir, 'dsh'), log = join(dir, 'rpc.jsonl')
await writeFile(bin, `#!/usr/bin/env node\nprocess.env.FAKE_DSH_LOG = ${JSON.stringify(log)}\nrequire(${JSON.stringify(resolve('test/fixtures/fake-deepseek.cjs'))})\n`)
await chmod(bin, 0o755)
const agent = { id: 'deepseek', adapter: 'deepseek', name: 'DeepSeek Harness', bin, icon: 'deepseek', builtin: true, models: [], capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [], protocol: 'acp' } } as AgentDef
const events: any[] = [], done: any[] = []
let environmentGeneration = 'first'
const runner = new ACPRunner('local-dsh', { n: 0 }, agent, { agentId: 'deepseek', workdir: dir, model: 'deepseek-official/pro', effort: 'high', permissionMode: 'ask' }, 'dsh-existing', () => ({ FAKE_DSH_GENERATION:environmentGeneration, FAKE_DSH_REJECT_EFFORT:'max', FAKE_DSH_STATE:join(dir,'state.json') }))
runner.on('event', event => {
  events.push(event)
  if (event.type === 'approval_request' && event.state === 'pending') {
    assert.equal(event.payload.params.rawInput.command, 'pwd')
    assert.equal(event.payload.kind, 'command')
    runner.respondResult(event.payload.requestId, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
  }
})
runner.on('done', value => done.push(value))
try {
  const { nativeSessionId, contract } = await runner.probeSession()
  assert.equal(nativeSessionId, 'dsh-existing')
  assert.deepEqual(contract.models.map(m => m.id), ['deepseek-official/flash', 'deepseek-official/pro'])
  assert.deepEqual(contract.models[0].efforts, ['off', 'low', 'high', 'max'])
  assert.equal(contract.currentModelId, 'deepseek-official/pro')
  assert.equal(contract.fileAttachments, false)
  assert.equal(contract.sessionLoad, false)
  assert.equal(contract.sessionList, true)
  assert.equal(contract.structuredUsage, false)
  assert.equal(contract.formElicitation, false)
  assert.deepEqual(contract.collaborationModes, ['default'])
  await runner.startTurn('hello')
  assert.equal(done.at(-1)?.failed, false)
  assert.deepEqual(events.filter(e => e.type === 'agent_message' && e.state === 'success').map(e => e.payload.text), ['FirstSecond'])
  assert.equal(events.find(e => e.type === 'command_exec' && e.state === 'success')?.payload.output, '/work')
  assert.equal(events.find(e => e.type === 'system_notice' && e.payload.kind === 'context')?.payload.usage.contextTokens, 128)
  await runner.updateConfig({ agentId: 'deepseek', workdir: dir, model: 'deepseek-official/pro', effort: 'off', permissionMode: 'ask' })
  const running = runner.startTurn('cancel-me')
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  runner.interrupt(); await running
  assert.equal(done.at(-1)?.interrupted, true)
  await runner.startTurn('bad-key')
  assert.equal(done.at(-1)?.authRequired, true)
  await assert.rejects(runner.updateConfig({ agentId: 'deepseek', workdir: dir, model: 'invalid', effort: 'high', permissionMode: 'ask' }), /未声明/)
  const retained = await runner.probeSession()
  assert.equal(retained.contract.currentModelId, 'deepseek-official/pro')
  assert.equal(retained.contract.models[0].defaultEffort, 'off')
  await assert.rejects(runner.updateConfig({ agentId:'deepseek', workdir:dir, model:'deepseek-official/flash', effort:'max', permissionMode:'ask' }), /Rejected effort/)
  const rolledBack = await runner.probeSession()
  assert.equal(rolledBack.contract.currentModelId, 'deepseek-official/pro')
  assert.equal(rolledBack.contract.models[0].defaultEffort, 'off')
  environmentGeneration = 'second'
  await runner.startTurn('credential-changed')
  assert.equal(done.at(-1)?.failed, false)
  const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records[0].argv, ['--profile', 'acp'])
  assert.equal(records.some(r => r.inbound?.method === 'session/set_mode'), false)
  assert.equal(records.some(r => r.inbound?.params?.configId === 'reasoning_effort' && r.inbound.params.value === 'off'), true)
  assert.deepEqual(records.filter(r=>r.argv).map(r=>r.generation), ['first','first','first','second'])
} finally { runner.dispose(); await rm(dir, { recursive: true, force: true }) }
console.log('deepseek-acp-contract: model projection, approval, messages, usage, resume, cancel, auth passed')
