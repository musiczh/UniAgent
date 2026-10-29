import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NativeCapabilityService,
  resolveNativeCapabilityAgent
} from '../src/main/nativeCapabilityService.ts'
import {
  applySlashCandidatePick,
  buildNativeCapabilityScope,
  nativeCapabilityChangeMatches
} from '../src/renderer/hooks.ts'
import { SlashMenu } from '../src/renderer/components/SlashMenu.tsx'
import { buildComposerDelivery } from '../src/renderer/components/Composer.tsx'
import { agentForSession, type AgentDef, type Session } from '../src/shared/types.ts'
import type { NativeCommandCandidate } from '../src/shared/nativeCapabilities.ts'

const baseGrok: AgentDef = {
  id: 'grok',
  name: 'Grok',
  bin: 'grok',
  adapter: 'grok',
  icon: 'grok',
  builtin: true,
  installed: true,
  capabilities: {
    modelSelect: true,
    reasoningEffort: true,
    permissionModes: [],
    commands: [],
    collaborationModes: []
  },
  models: []
}

const session: Session = {
  id: 'local-grok',
  title: 'Grok commands',
  config: { agentId: 'grok', workdir: '/workspace' },
  status: 'idle',
  createdAt: 1,
  agentContract: {
    models: [{
      id: 'grok-4.6',
      label: 'Grok 4.6',
      efforts: ['xhigh', 'high', 'medium', 'low'],
      defaultEffort: 'high',
      contextWindow: 500000
    }],
    currentModelId: 'grok-4.6',
    permissionModes: [],
    imageAttachments: false,
    fileAttachments: true,
    sessionList: true,
    sessionLoad: true,
    sessionResume: true,
    sessionFork: false,
    commands: ['compact', '/review', 'bad command', '', 'compact'],
    collaborationModes: ['default', 'plan']
  }
}

const scopedGrok = agentForSession(baseGrok, session)
assert.notEqual(
  buildNativeCapabilityScope('grok', '/workspace', 'session-a'),
  buildNativeCapabilityScope('grok', '/workspace', 'session-b'),
  'two Grok sessions in one workdir must not share stale command responses'
)
assert.equal(
  nativeCapabilityChangeMatches(
    { agentId: 'grok', workdir: '/workspace', sessionId: 'session-a' },
    'grok',
    '/workspace',
    'session-b'
  ),
  false,
  'a command update from one Grok session cannot refresh another session scope'
)
assert.equal(
  nativeCapabilityChangeMatches(
    { agentId: 'grok', workdir: '/workspace' },
    'grok',
    '/workspace',
    'session-b'
  ),
  true,
  'provider-wide capability updates remain compatible with session-scoped consumers'
)
assert.equal(
  resolveNativeCapabilityAgent(
    baseGrok,
    { agentId: 'grok', workdir: '/workspace', sessionId: session.id },
    (sessionId) => sessionId === session.id ? session : undefined
  ).capabilities.commands?.join(','),
  'compact,/review,bad command,,compact',
  'native discovery must resolve the exact session-scoped ACP contract'
)
assert.throws(
  () => resolveNativeCapabilityAgent(
    baseGrok,
    { agentId: 'codex', workdir: '/workspace', sessionId: session.id },
    () => session
  ),
  /invalid_native_capability_session/,
  'a session contract cannot be read through a mismatched Agent request'
)
let providerClientCreated = false
const service = new NativeCapabilityService(() => {
  providerClientCreated = true
  throw new Error('Grok commands must come from the negotiated ACP session contract')
})
const snapshot = await service.discover(scopedGrok, '/workspace', true)

assert.equal(providerClientCreated, false)
assert.deepEqual(snapshot.candidates, [
  { id: 'command:compact', kind: 'command', name: 'compact', command: '/compact' },
  { id: 'command:review', kind: 'command', name: 'review', command: '/review' }
])
assert.deepEqual(snapshot.actions, {
  goal: false,
  review: false,
  plan: { id: 'plan', name: 'Plan', model: 'grok-4.6', reasoningEffort: 'high' }
})

const compact = snapshot.candidates[0] as NativeCommandCandidate
assert.deepEqual(
  applySlashCandidatePick('please /com', { start: 7, end: 11, query: 'com' }, compact),
  { text: 'please /compact ', caret: 16 },
  'a provider command must remain in the prompt instead of becoming a structured Skill/MCP selection'
)
assert.deepEqual(
  buildComposerDelivery(null, '/compact summarize this session', [], []),
  {
    kind: 'turn',
    prompt: '/compact summarize this session',
    attachments: undefined,
    selection: { candidateIds: [] },
    activatePlan: false
  },
  'the selected Grok command must reach the provider as prompt text'
)
await assert.rejects(
  service.resolveSelection(scopedGrok, '/workspace', { candidateIds: ['command:compact'] }),
  /命令.*提示词/,
  'provider commands cannot be forged into the Skill/MCP selection channel'
)

const menu = renderToStaticMarkup(createElement(SlashMenu, {
  hits: snapshot.candidates,
  totalCount: snapshot.candidates.length,
  onPick: () => undefined,
  onClose: () => undefined,
  activeIndex: 0,
  setActiveIndex: () => undefined
}))
assert.match(menu, />Command</)
assert.match(menu, />compact</)
assert.match(menu, />review</)

console.log('grok-native-commands: negotiated commands and Plan are exposed without a second CLI probe')
