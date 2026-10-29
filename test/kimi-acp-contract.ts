import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACPRunner,
  KIMI_PERMISSION_MODES,
  probeKimiACP
} from '../src/main/acp/acpRunner.ts'
import type { AgentDef } from '../src/shared/types.ts'
import { hasKimiLoginAttempts } from '../src/main/kimiAuth.ts'

const dir = await mkdtemp(join(tmpdir(), 'uniagent-kimi-acp-'))
const bin = join(dir, 'kimi')
const logPath = join(dir, 'protocol.jsonl')
const fixture = resolve(process.cwd(), 'test/fixtures/fake-kimi.cjs')
await writeFile(bin, `#!/usr/bin/env node
process.env.FAKE_KIMI_LOG = ${JSON.stringify(logPath)}
require(${JSON.stringify(fixture)})
`, 'utf8')
await chmod(bin, 0o755)

const agent: AgentDef = {
  id: 'kimi', name: 'Kimi Code', bin, adapter: 'kimi', icon: 'kimi', builtin: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    permissionModes: KIMI_PERMISSION_MODES,
    protocol: 'acp'
  },
  models: []
}

let runner: ACPRunner | undefined
try {
  const events: any[] = []
  const contracts: any[] = []
  const nativeIds: string[] = []
  const completions: any[] = []
  runner = new ACPRunner(
    'local-kimi',
    { n: 0 },
    agent,
    {
      agentId: 'kimi',
      model: 'kimi-k2-turbo',
      kimiThinking: 'high',
      permissionMode: 'ask',
      workdir: dir,
      additionalDirectories: [join(dir, 'extra')]
    },
    'kimi-existing'
  )
  runner.on('event', (event) => events.push(event))
  runner.on('contract', (contract) => contracts.push(structuredClone(contract)))
  runner.on('nativeSession', ({ nativeSessionId }) => nativeIds.push(nativeSessionId))
  runner.on('done', (completion) => completions.push(completion))
  await runner.startTurn('hello')

  // Kimi resume/load responses omit sessionId. The shared runner must retain
  // the exact requested identity rather than inventing or losing the session.
  assert.deepEqual(nativeIds, ['kimi-existing'])
  assert.equal(events.find((event) => event.type === 'reasoning')?.payload.text, 'Kimi thinking')
  assert.equal(events.find((event) => event.type === 'agent_message')?.payload.text, 'Kimi reply')
  assert.deepEqual(
    events.find((event) => event.type === 'system_notice' && event.payload.kind === 'context')?.payload.usage,
    { contextTokens: 64, contextWindow: 262144, modelId: 'kimi-k2-turbo' }
  )
  assert.equal(events.some((event) => event.type === 'system_notice' && event.payload.kind === 'usage'), false)
  assert.equal(contracts.at(-1)?.currentModelId, 'kimi-k2-turbo')
  assert.equal(contracts.at(-1)?.models.find((model: any) => model.id === 'kimi-k2-turbo')?.defaultThinking, 'high')
  assert.equal(contracts.at(-1)?.commands.includes('compact'), true)
  assert.equal(contracts.at(-1)?.steer, false)
  assert.equal(contracts.at(-1)?.formElicitation, false)
  assert.equal(contracts.at(-1)?.freeTextElicitation, false)

  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(records.find((record) => record.kind === 'argv')?.argv, ['acp'])
  const resume = records.find((record) => record.kind === 'inbound' && record.frame?.method === 'session/resume')
  assert.equal(resume?.frame?.params?.sessionId, 'kimi-existing')
  assert.equal('additionalDirectories' in resume.frame.params, true)
  assert.deepEqual(
    records.filter((record) => record.kind === 'inbound' && record.frame?.method === 'session/set_config_option')
      .map((record) => [record.frame.params.configId, record.frame.params.value]),
    [['model', 'kimi-k2-turbo'], ['thinking', 'high']]
  )
  assert.equal(
    records.find((record) => record.kind === 'inbound' && record.frame?.method === 'session/set_mode')?.frame?.params?.modeId,
    undefined
  )

  for (const prompt of ['quota-failure', 'quota-data-failure']) {
    const start = events.length
    await runner.startTurn(prompt)
    const errors = events.slice(start).filter(event => event.type === 'error')
    assert.equal(errors.length, 1, '一次额度失败只报告一条真实错误')
    assert.equal(errors[0].state, 'failed')
    assert.match(errors[0].payload.message, /Kimi Code 额度已耗尽/)
    assert.match(errors[0].payload.detail, prompt === 'quota-failure' ? /5-hour usage limit.*quota will reset/ : /quota_exceeded/)
    assert.equal(errors[0].payload.authLogin, undefined)
    assert.equal(completions.at(-1)?.failed, true)
    assert.equal(completions.at(-1)?.authRequired, false)
    assert.equal(hasKimiLoginAttempts(), false, '额度耗尽不能启动 kimi login')
  }
  await runner.startTurn('hello after quota reset')
  assert.equal(completions.at(-1)?.failed, false, '额度恢复后仍可继续原会话')

  await runner.startTurn('auth-failure')
  assert.equal(events.some((event) => event.type === 'error' && event.payload.authLogin === true), true)
  assert.equal(completions.at(-1)?.failed, true)
  assert.equal(completions.at(-1)?.authRequired, true)
  runner.dispose()

  const probe = await probeKimiACP(bin, dir)
  assert.equal(probe.status, 'ready')
  assert.equal(probe.version, '2.0.2')
  assert.equal(probe.contract?.steer, false)
  assert.equal(probe.contract?.sessionFork, false)
} finally {
  await runner?.disposeAndWait()
  await rm(dir, { recursive: true, force: true })
}

console.log('kimi-acp-contract: shared ACP runner preserves Kimi semantics')
