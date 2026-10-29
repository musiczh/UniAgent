import { isDistributionAgent } from '../src/shared/distribution.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_AGENTS } from '../src/main/agents.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { migrateAssistantCarrier, type PersonalAssistant } from '../src/shared/assistant.ts'
import type { AgentDef, Session } from '../src/shared/types.ts'

// Only agents able to inject a system prompt at session startup may carry the assistant.
for (const id of ['codex', 'traex', 'claude'].filter(id => isDistributionAgent(id))) {
  assert.equal(BUILTIN_AGENTS.find(agent => agent.id === id)?.capabilities.startupSystemPrompt, true, `${id} must be marked as a startup system prompt carrier`)
}
for (const id of ['kimi', 'grok', 'deepseek', 'zcode']) {
  assert.ok(!BUILTIN_AGENTS.find(agent => agent.id === id)?.capabilities.startupSystemPrompt, `${id} wraps prompts per turn and must stay unmarked`)
}

const lifecycle = (availability: 'available' | 'unavailable'): AgentDef['lifecycle'] => ({ availability, auth: 'unknown', health: 'unknown' })
const agent = (id: string, supported: boolean, available = true): AgentDef => ({
  id, name: id, bin: id, adapter: 'codex', icon: '', builtin: true, installed: true,
  lifecycle: lifecycle(available ? 'available' : 'unavailable'),
  capabilities: {
    modelSelect: true, reasoningEffort: false,
    permissionModes: [{ id: 'ask', label: '询问', hint: '' }],
    ...(supported ? { startupSystemPrompt: true } : {})
  },
  models: [{ id: `${id}-model` } as AgentDef['models'][number]],
  defaultModel: `${id}-model`
})
const storedAssistant = (defaultAgentId: string, extra: Partial<PersonalAssistant> = {}): PersonalAssistant => ({
  id: 'personal', enabled: true, defaultAgentId, autoReviewEnabled: true, createdAt: 1, updatedAt: 1, ...extra
})

// Carrier migration: a supported stored default needs no rewrite.
assert.equal(migrateAssistantCarrier(storedAssistant('codex'), [agent('codex', true)]), null)

// An unsupported stored default switches to the first available carrier with freshly resolved defaults.
const switched = migrateAssistantCarrier(
  storedAssistant('kimi', { defaultWorkdir: '/tmp/work', defaultPermissionMode: 'plan' }),
  [agent('kimi', false), agent('codex', true)]
)
assert.ok(switched)
assert.equal(switched.defaultAgentId, 'codex')
assert.equal(switched.defaultModel, 'codex-model', 'model must be re-resolved for the new carrier')
assert.equal(switched.defaultPermissionMode, 'ask', 'permission must be re-resolved for the new carrier')
assert.equal(switched.defaultWorkdir, '/tmp/work', 'unrelated settings must be preserved')
assert.equal(switched.enabled, true)
assert.ok(!('id' in switched) && !('createdAt' in switched) && !('updatedAt' in switched), 'migration returns AssistantInput without record fields')

// Carriers that are not available are skipped in favor of the next available one.
const skipped = migrateAssistantCarrier(storedAssistant('kimi'), [agent('kimi', false), agent('codex', true, false), agent('claude', true)])
assert.equal(skipped?.defaultAgentId, 'claude')

// Without any carrier the assistant is disabled and the stored default is kept for the settings placeholder.
for (const candidates of [
  [agent('kimi', false)],
  [agent('kimi', false), agent('codex', true, false)],
  []
] as AgentDef[][]) {
  const disabled = migrateAssistantCarrier(storedAssistant('kimi'), candidates)
  assert.ok(disabled)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.defaultAgentId, 'kimi', 'a disabled migration keeps the stored agent id for display')
}

// Startup detach: assistant sessions on non-carrier agents become regular sessions, durably.
const root = await mkdtemp(join(tmpdir(), 'ua-assistant-support-'))
try {
  const sessionFile = join(root, 'sessions.json')
  const agents = new Map([agent('codex', true), agent('kimi', false)].map(def => [def.id, def]))
  const snapshot = { assistantId: 'personal', soul: '灵魂', soulRevision: 1, workingRules: '规则', workingRulesRevision: 1 } as const
  const base = (id: string, agentId: string): Session => ({
    id, title: id, config: { agentId, workdir: '/repo', permissionMode: 'ask' }, status: 'idle', createdAt: 1, origin: 'created'
  })
  const sessions: Session[] = [
    { ...base('kimi-assistant', 'kimi'), config: { agentId: 'kimi', workdir: '/repo', permissionMode: 'ask', assistantSnapshot: { ...snapshot } } },
    { ...base('codex-assistant', 'codex'), config: { agentId: 'codex', workdir: '/repo', permissionMode: 'ask', assistantSnapshot: { ...snapshot } } },
    { ...base('ghost-assistant', 'ghost'), config: { agentId: 'ghost', workdir: '/repo', permissionMode: 'ask', assistantSnapshot: { ...snapshot } } },
    { ...base('team-kimi', 'kimi'), teamBinding: { teamProjectId: 'project', memberId: 'member' }, config: { agentId: 'kimi', workdir: '/repo', permissionMode: 'ask', assistantSnapshot: { ...snapshot } } },
    { ...base('handoff-kimi', 'kimi'), handoffId: 'handoff-1', config: { agentId: 'kimi', workdir: '/repo', permissionMode: 'ask', assistantSnapshot: { ...snapshot } } },
    base('kimi-plain', 'kimi')
  ]
  new SessionStore(sessionFile).saveOrThrow(sessions)
  const orchestrator = new Orchestrator(id => agents.get(id), new SessionStore(sessionFile))
  orchestrator.loadPersisted()
  try {
    const updated: string[] = []
    orchestrator.on('sessionUpdated', ({ session }) => updated.push(session.id))
    const detached = orchestrator.detachUnsupportedAssistantSessions().map(session => session.id).sort()
    assert.deepEqual(detached, ['ghost-assistant', 'kimi-assistant'])
    assert.deepEqual([...new Set(updated)].sort(), ['ghost-assistant', 'kimi-assistant'], 'detached sessions must emit sessionUpdated')
    assert.equal(orchestrator.getSessionById('kimi-assistant')?.config.assistantSnapshot, undefined)
    assert.equal(orchestrator.getSessionById('ghost-assistant')?.config.assistantSnapshot, undefined)
    assert.deepEqual(orchestrator.getSessionById('codex-assistant')?.config.assistantSnapshot, { ...snapshot }, 'carrier sessions keep the assistant')
    assert.ok(orchestrator.getSessionById('team-kimi')?.config.assistantSnapshot, 'team bindings are out of scope')
    assert.ok(orchestrator.getSessionById('handoff-kimi')?.config.assistantSnapshot, 'handoff sessions are out of scope')
    assert.deepEqual(orchestrator.detachUnsupportedAssistantSessions(), [], 'detach must be idempotent')
  } finally {
    orchestrator.disposeAll()
  }
  const reloaded = new Orchestrator(id => agents.get(id), new SessionStore(sessionFile))
  reloaded.loadPersisted()
  try {
    assert.equal(reloaded.getSessionById('kimi-assistant')?.config.assistantSnapshot, undefined, 'detach must persist')
    assert.ok(reloaded.getSessionById('codex-assistant')?.config.assistantSnapshot, 'kept snapshots must survive the roundtrip')
  } finally {
    reloaded.disposeAll()
  }
  console.log('assistant agent support: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
