import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { MCODE_PERMISSION_MODES } from '../src/main/acp/acpProvider.ts'
import type { AgentDef } from '../src/shared/types.ts'

async function withHost(run: (host: Orchestrator, agent: AgentDef, dir: string, store: SessionStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ua-mcode-orchestrator-'))
  process.env.UNIAGENT_USER_DATA = dir
  const bin = join(dir, 'mcode-cli')
  await writeFile(bin, `#!${process.execPath}\nprocess.env.FAKE_MCODE_STATE=${JSON.stringify(join(dir, 'state.json'))}\nprocess.env.FAKE_MCODE_LOG=${JSON.stringify(join(dir, 'protocol.jsonl'))}\nrequire(${JSON.stringify(resolve('test/fixtures/fake-mcode.cjs'))})\n`, { mode: 0o700 })
  const agent: AgentDef = { id: 'mcode', name: 'MiniMax Code', adapter: 'mcode', bin, icon: 'mcode', builtin: true, installed: true,
    models: [], capabilities: { protocol: 'acp', modelSelect: true, reasoningEffort: true, permissionModes: MCODE_PERMISSION_MODES,
      sessionList: true, sessionLoad: true, sessionResume: true, sessionFork: true, nativeGoal: true, steer: true, formElicitation: true, freeTextElicitation: true } }
  const store = new SessionStore(join(dir, 'sessions.json'))
  const host = new Orchestrator(id => id === 'mcode' ? agent : undefined, store)
  try { await run(host, agent, dir, store) }
  finally { host.disposeAll(); await host.closeSessionLogs(); await rm(dir, { recursive: true, force: true }) }
}

async function idle(host: Orchestrator, id: string) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const session = host.getSessionById(id)!
    assert.notEqual(session.status, 'error', JSON.stringify(await host.getEvents(id)))
    if (session.status === 'idle' || session.status === 'completed') return session
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error('MiniMax session did not settle')
}

await test('MiniMax history imports through the detected executable', async () => withHost(async (host, _agent, dir) => {
  const source = host.createSession({ agentId: 'mcode', workdir: dir, permissionMode: 'ask' }, 'preserved prompt')
  await idle(host, source.id)
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  const row = { ...state.sessions[0], sessionId: 'external-mcode' }
  state.sessions.push(row)
  await writeFile(join(dir, 'state.json'), JSON.stringify(state))
  const imported = await host.importSession('mcode', row.sessionId, 'snapshot', dir)
  assert.ok(imported)
  assert.ok((await host.getEvents(imported.id)).some(event => event.type === 'user_message' && event.payload.text === 'preserved prompt'))
}))

await test('MiniMax same-agent fork creates a writable independent session', async () => withHost(async (host, _agent, dir) => {
  const source = host.createSession({ agentId: 'mcode', workdir: dir, permissionMode: 'ask' }, 'source context')
  await idle(host, source.id)
  const before = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).sessions.find((row: any) => row.sessionId === source.nativeSessionId)
  const fork = await host.forkSameSession('mcode', source.nativeSessionId!, dir)
  assert.ok(fork, 'an advertised fork must create a session')
  assert.notEqual(fork.nativeSessionId, source.nativeSessionId)
  assert.equal(fork.readOnly, false)
  assert.equal(fork.config.permissionMode, 'ask')
  await host.sendMessage(fork.id, 'fork followup')
  await idle(host, fork.id)
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(state.sessions.find((row: any) => row.sessionId === source.nativeSessionId), before)
}))

await test('catalog refresh preserves MiniMax capabilities and an active native Goal', async () => withHost(async (host, _agent, dir) => {
  const session = host.createSession({ agentId: 'mcode', workdir: dir, permissionMode: 'ask' }, 'ready')
  await idle(host, session.id)
  await host.runNativeAction(session.id, { type: 'goal.set', objective: 'remain active', tokenBudget: 1200 })
  host.reconcileAgentConfigs()
  assert.equal(session.agentContract?.nativeGoal, true)
  assert.equal(session.agentContract?.sessionFork, true)
  assert.equal(session.goal?.autonomous, true)
  await host.runNativeAction(session.id, { type: 'goal.update', action: 'pause' })
  await idle(host, session.id)
  await host.runNativeAction(session.id, { type: 'goal.update', action: 'resume' })
  assert.equal(session.status, 'running')
  await host.runNativeAction(session.id, { type: 'goal.clear' })
  await idle(host, session.id)
}))

await test('a failed MiniMax turn must not drain the next queued message', async () => withHost(async (host, _agent, dir) => {
  const session = host.createSession({ agentId: 'mcode', workdir: dir, permissionMode: 'ask' }, 'fail-turn')
  await host.sendMessage(session.id, 'retain this pending message')
  const deadline = Date.now() + 10000
  while (session.status !== 'error' && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  assert.equal(session.status, 'error')
  assert.equal(host.getQueue(session.id).length, 1)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  const frames = (await readFile(join(dir, 'protocol.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(frames.filter(row => row.kind === 'inbound' && row.frame.method === 'session/prompt').length, 1)
}))

await test('MiniMax uncertain delivery is retained during recovery', async () => withHost(async (host, agent, dir, store) => {
  const session = host.createSession({ agentId: 'mcode', workdir: dir, permissionMode: 'ask' }, 'ready for recovery')
  await idle(host, session.id)
  await host.sendMessage(session.id, 'fail-turn')
  await host.sendMessage(session.id, 'fail-turn')
  const waitError = async () => {
    const deadline = Date.now() + 10000
    while (session.status !== 'error' && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    assert.equal(session.status, 'error')
  }
  await waitError()
  host.resumePendingQueues()
  const deadline = Date.now() + 10000
  while (!host.getQueue(session.id)[0]?.deliveryUncertain && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  await waitError()
  assert.equal(host.getQueue(session.id)[0]?.deliveryUncertain, true)
  await host.flushSessionLogs()
  host.disposeAll()
  const recovered = new Orchestrator(id => id === 'mcode' ? agent : undefined, store)
  try {
    await recovered.loadPersisted()
    assert.ok((await recovered.getEvents(session.id)).some(event => event.type === 'user_message'), 'native history is restored through the detected executable')
    const before = await readFile(join(dir, 'protocol.jsonl'), 'utf8')
    recovered.resumePendingQueues()
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
    const after = await readFile(join(dir, 'protocol.jsonl'), 'utf8')
    const prompts = (text: string) => text.split('\n').filter(line => line.includes('"kind":"inbound"') && line.includes('"method":"session/prompt"')).length
    assert.equal(prompts(after), prompts(before), 'an uncertain turn must never be resent automatically')
  } finally { recovered.disposeAll(); await recovered.closeSessionLogs() }
}))
