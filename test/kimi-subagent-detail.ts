import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { KimiWebRunner } from '../src/main/kimiWebRunner.ts'
import { loadKimiSubAgentEvents } from '../src/main/kimiHistory.ts'
import { kimiWebTranscriptEvents } from '../src/main/kimiWebEventProjection.ts'
import { EventStream } from '../src/renderer/components/EventStream'
import type { AgentDef, SessionConfig, UAEvent } from '../src/shared/types.ts'

Object.assign(DOMPurify, { sanitize: (html: string) => html })

type FakeKimi = {
  dir: string
  home: string
  bin: string
  log: string
  cleanup: () => Promise<void>
}

async function createFakeKimi(scenario: Record<string, any> = {}): Promise<FakeKimi> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-kimi-subagent-'))
  const home = join(dir, 'home')
  const bin = join(dir, 'kimi')
  const log = join(dir, 'requests.jsonl')
  await mkdir(home)
  await writeFile(bin, `#!/usr/bin/env node
process.env.FAKE_KIMI_SUBAGENT_LOG = ${JSON.stringify(log)}
process.env.FAKE_KIMI_SUBAGENT_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))}
require(${JSON.stringify(resolve('test/fixtures/fake-kimi-subagent.cjs'))})
`)
  await chmod(bin, 0o755)
  return { dir, home, bin, log, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const configFor = (fake: FakeKimi): SessionConfig => ({
  agentId: 'kimi', model: 'k3-256k', permissionMode: 'ask', collaborationMode: 'default',
  workdir: fake.dir, kimiDataHome: fake.home
})
const agentFor = (fake: FakeKimi): AgentDef => ({
  id: 'kimi', name: 'Kimi', adapter: 'kimi', bin: fake.bin, icon: 'kimi', builtin: true, models: [],
  capabilities: { protocol: 'web', modelSelect: true, reasoningEffort: true, permissionModes: [] }
})

async function readRequests(fake: FakeKimi): Promise<Array<Record<string, any>>> {
  try {
    return (await readFile(fake.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

const transcript = [{
  kind: 'turn', turnId: 't1', origin: { kind: 'user' }, prompt: 'Inspect the repository', state: 'completed',
  startedAt: new Date(1_790_000_000_000).toISOString(), endedAt: new Date(1_790_000_012_000).toISOString(),
  steps: [{
    stepId: 't1.1', state: 'completed',
    startedAt: new Date(1_790_000_001_000).toISOString(), endedAt: new Date(1_790_000_011_000).toISOString(),
    frames: [
      { kind: 'thinking', frameId: 't1.1.f0', text: 'Checking the workspace layout' },
      { kind: 'tool', frameId: 't1.1.f1', toolCallId: 'call-child-1', name: 'Read', state: 'done', input: { path: '/workspace/README.md' }, output: 'README CONTENTS' },
      { kind: 'text', role: 'assistant', frameId: 't1.1.f2', text: 'The child read the README.' }
    ]
  }]
}]

const fixture = await createFakeKimi()
const coldFixture = await createFakeKimi({ tasks: [] })
const liveFixture = await createFakeKimi()
try {
  const store = new SessionStore(join(fixture.dir, 'sessions.json'))
  store.saveOrThrow([{
    id: 'kimi-owner', title: 'Kimi owner', config: configFor(fixture), status: 'idle', createdAt: 1,
    nativeSessionId: 'native-parent',
    subagents: [
      { agentThreadId: 'child-1', parentThreadId: 'native-parent', nativeTaskId: 'task-1', status: 'running', startedAt: 1 },
      { agentThreadId: 'child-foreign', parentThreadId: 'another-parent', nativeTaskId: 'task-2', status: 'running', startedAt: 1 }
    ]
  }])
  const agent = agentFor(fixture)
  const orchestrator = new Orchestrator(id => id === agent.id ? agent : undefined, store)
  const render = (events: UAEvent[]): string =>
    renderToStaticMarkup(createElement(EventStream, { events, status: 'idle', manageProcessedFoldScroll: true }))
  try {
    await orchestrator.loadPersisted()
    assert.equal(orchestrator.getSessionById('kimi-owner')?.subagents?.[0]?.status, 'interrupted')
    // A live roster can still report running while the native turn is already
    // complete (Kimi's task registry ages out before the terminal frame).
    const owner = orchestrator.getSessionById('kimi-owner')!
    owner.subagents = owner.subagents!.map(child =>
      child.agentThreadId === 'child-1' ? { ...child, status: 'running' as const, endedAt: undefined } : child)

    // 运行中的 Kimi 子 Agent：详情必须走活的 KimiWebRunner，而不是像 DeepSeek 那样直接返回空。
    const liveAgent = agentFor(liveFixture)
    const liveRunner = new KimiWebRunner('kimi-owner', { n: 0 }, liveAgent, configFor(liveFixture))
    const liveCalls: Array<{ id: string; trusted?: { nativeTaskId: string; parentNativeSessionId: string } }> = []
    ;(liveRunner as any).runtime = {
      getSubagentTranscript: async (id: string, trusted?: { nativeTaskId: string; parentNativeSessionId: string }) => {
        liveCalls.push({ id, trusted })
        if (id !== 'child-1') throw new Error('kimi_web_subagent_not_owned')
        return kimiWebTranscriptEvents(transcript)
      }
    }
    ;(orchestrator as any).protocolRunners.set('kimi-owner', liveRunner)
    const live = await orchestrator.getSubAgentItems('kimi-owner', 'child-1')
    assert.equal(liveCalls.length, 1, 'a running Kimi child must be read from the live native runner')
    assert.deepEqual(liveCalls[0], { id: 'child-1', trusted: { nativeTaskId: 'task-1', parentNativeSessionId: 'native-parent' } })
    assert.ok(live.some(event => event.type === 'agent_message' && event.payload.text === 'The child read the README.'))
    assert.ok(live.some(event => event.type === 'tool_call' && event.payload.result === 'README CONTENTS'))
    assert.deepEqual(live.map(event => event.seq), live.map((_, index) => index), 'detail events need a stable UI sequence')
    assert.ok(live.every(event => event.sessionId === 'kimi-owner' && Number.isFinite(event.ts)))
    assert.match(render(live), /The child read the README\./, 'the child output is rendered in the detail stream')

    // 断连/完成后的冷读：复用只读原生服务读该 agent 的 transcript，不重发输入也不改写配置。
    const brokenRunner = new KimiWebRunner('kimi-owner', { n: 0 }, liveAgent, configFor(liveFixture))
    ;(brokenRunner as any).runtime = { getSubagentTranscript: async () => { throw new Error('kimi_web_runner_closed') } }
    ;(orchestrator as any).protocolRunners.set('kimi-owner', brokenRunner)
    const recoveredLive = await orchestrator.getSubAgentItems('kimi-owner', 'child-1')
    assert.ok(recoveredLive.some(event => event.type === 'agent_message' && event.payload.text === 'The child read the README.'),
      'an ended live connection falls back to the read-only native transcript')
    ;(orchestrator as any).protocolRunners.delete('kimi-owner')
    const cold = await orchestrator.getSubAgentItems('kimi-owner', 'child-1')
    assert.ok(cold.some(event => event.type === 'reasoning' && event.payload.text === 'Checking the workspace layout'))
    assert.ok(cold.some(event => event.type === 'agent_message' && event.payload.text === 'The child read the README.'))
    assert.deepEqual(cold.map(event => event.seq), cold.map((_, index) => index))
    assert.ok(cold.every(event => event.sessionId === 'kimi-owner' && Number.isFinite(event.ts)))
    assert.match(render(cold), /The child read the README\./)
    const coldRequests = await readRequests(fixture)
    assert.ok(coldRequests.some(row => row.method === 'GET' && row.path === '/api/v1/sessions/native-parent/tasks'))
    assert.ok(coldRequests.some(row => row.method === 'GET' && row.path === '/api/v1/sessions/native-parent/transcript' && row.agentId === 'child-1'))
    assert.equal(coldRequests.filter(row => row.path === '/api/v1/sessions/native-parent/transcript').length, 1,
      'a poll inside the cold-read window reuses the transcript instead of starting another reader')
    assert.ok(coldRequests.every(row => row.method === 'GET'), 'detail reads must never mutate the native session')

    // 归属校验：不属于该父会话/该原生 session 的 agent 一律读不到。
    assert.deepEqual(await orchestrator.getSubAgentItems('kimi-owner', 'foreign-child'), [])
    assert.deepEqual(await orchestrator.getSubAgentItems('kimi-owner', 'child-foreign'), [], 'a child owned by another parent is rejected before any native read')
    assert.deepEqual(await orchestrator.getSubAgentItems('kimi-owner', 'main'), [])
    assert.deepEqual(await orchestrator.getSubAgentItems('missing-owner', 'child-1'), [])

    // tasks 注册表已消失时，持久化的 nativeTaskId 仍可完成冷读；父会话不匹配必须拒绝。
    const trusted = { nativeTaskId: 'task-1', parentNativeSessionId: 'native-parent' }
    const recovered = await loadKimiSubAgentEvents('native-parent', 'child-1', coldFixture.bin, coldFixture.dir, { KIMI_CODE_HOME: coldFixture.home }, trusted)
    assert.ok(recovered.some(event => event.type === 'agent_message' && event.payload.text === 'The child read the README.'))
    await assert.rejects(
      loadKimiSubAgentEvents('native-parent', 'child-1', coldFixture.bin, coldFixture.dir, { KIMI_CODE_HOME: coldFixture.home }, { nativeTaskId: 'task-1', parentNativeSessionId: 'another-parent' }),
      /subagent_not_owned/
    )
    await assert.rejects(
      loadKimiSubAgentEvents('native-parent', 'main', coldFixture.bin, coldFixture.dir, { KIMI_CODE_HOME: coldFixture.home }, trusted),
      /subagent_identity_invalid/
    )
    await assert.rejects(
      loadKimiSubAgentEvents('native-parent', 'child-1', coldFixture.bin, coldFixture.dir, { KIMI_CODE_HOME: coldFixture.home }),
      /subagent_not_owned/
    )
  } finally {
    orchestrator.disposeAll()
  }
} finally {
  await fixture.cleanup()
  await coldFixture.cleanup()
  await liveFixture.cleanup()
}
console.log('kimi-subagent-detail: live runner routing, cold transcript ownership and rendered child output passed')
