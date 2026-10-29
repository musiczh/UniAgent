import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'

const root = join(tmpdir(), `uniagent-side-persistence-${process.pid}-${Date.now()}`)
const sessionFile = join(root, 'sessions.json')
const agent: AgentDef = {
  id: 'codex',
  name: 'Codex',
  bin: '/usr/bin/true',
  adapter: 'codex',
  icon: '',
  builtin: true,
  installed: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    streaming: true,
    permissionModes: [{ id: 'read-only', label: '只读', hint: '' }]
  },
  models: []
}
const session: Session = {
  id: 'main-session',
  title: '主会话',
  config: { agentId: agent.id, workdir: '/repo', permissionMode: 'read-only' },
  status: 'idle',
  createdAt: 1,
  nativeSessionId: 'main-thread',
  origin: 'created'
}
const getAgent = (id: string): AgentDef | undefined => id === agent.id ? agent : undefined

new SessionStore(sessionFile).saveOrThrow([session])
const first = new Orchestrator(getAgent, new SessionStore(sessionFile))
first.loadPersisted()
const firstInternals = first as any
firstInternals.recordSide(session.id, { type: 'user_message', payload: { text: '重启前的问题' } })
firstInternals.recordSide(session.id, { type: 'agent_message', payload: { text: '重启前的回答' } })
first.updateSideConfig(session.id, { model: 'gpt-side', modelSource: undefined })
assert.equal(first.getSessionById(session.id)?.config.model, undefined)
firstInternals.sideNativeSessionIds.set(session.id, 'side-thread')
const disposable = { removeAllListeners: () => {}, dispose: () => {}, disposeFork: () => {} }
firstInternals.streamers.set(session.id, disposable)
firstInternals.sideStreamers.set(session.id, disposable)
first.disposeAll()
first.disposeAll()

const restored = new Orchestrator(getAgent, new SessionStore(sessionFile))
restored.loadPersisted()

try {
  assert.deepEqual(
    restored.getSideEvents(session.id).map(({ sessionId, seq, type, payload }) => ({
      sessionId, seq, type, text: payload.text
    })),
    [
      { sessionId: session.id, seq: 0, type: 'user_message', text: '重启前的问题' },
      { sessionId: session.id, seq: 1, type: 'agent_message', text: '重启前的回答' }
    ]
  )
  assert.equal(restored.getSideState(session.id).config.model, 'gpt-side')
  assert.equal((restored as any).sideNativeSessionIds.get(session.id), 'side-thread')
  assert.equal((restored as any).ensureSideStreamer(session.id).nativeThreadId(), 'side-thread')
  assert.deepEqual(
    (restored as any).ensureSideStreamer(session.id).forkTranscript.map(
      ({ type, payload }: any) => ({ type, text: payload.text })
    ),
    [
      { type: 'user_message', text: '重启前的问题' },
      { type: 'agent_message', text: '重启前的回答' }
    ]
  )
  restored.disposeSession(session.id, true)
  assert.equal(restored.getSideEvents(session.id).length, 2)

  restored.closeSideChat(session.id)
  const cleared = new Orchestrator(getAgent, new SessionStore(sessionFile))
  cleared.loadPersisted()
  assert.deepEqual(cleared.getSideEvents(session.id), [])

  const configured = new Orchestrator(getAgent, new SessionStore(sessionFile))
  configured.loadPersisted()
  configured.updateSideConfig(session.id, { model: 'gpt-before-first-message', modelSource: { kind: 'native' } })
  const configuredRestart = new Orchestrator(getAgent, new SessionStore(sessionFile))
  configuredRestart.loadPersisted()
  assert.equal(configuredRestart.getSideState(session.id).config.model, 'gpt-before-first-message')
  assert.deepEqual(configuredRestart.getSideState(session.id).config.modelSource, { kind: 'native' })
  configuredRestart.updateSideConfig(session.id, { model: 'gpt-next-model' })
  assert.equal(configuredRestart.getSideState(session.id).config.modelSource, undefined)
  assert.equal(configuredRestart.getSessionById(session.id)?.config.model, undefined)
  assert.throws(() => configuredRestart.updateSideConfig(session.id, { workdir: '/other' }), /invalid_side_config_patch/)
  console.log('side-chat-persistence: ok')
} finally {
  first.disposeAll()
  restored.disposeAll()
  await rm(root, { recursive: true, force: true })
}
