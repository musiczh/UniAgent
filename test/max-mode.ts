import assert from 'node:assert/strict'
import { projectModelCache } from '../src/main/agents.ts'
import { AppServerRunner, buildTurnStartParams } from '../src/main/appServerAdapter.ts'
import {
  claimModelNotification,
  formatModelNotice,
  historyModelEvidenceOf,
  isMaterialContextWindowMismatch,
  normalizeModelNotification,
  normalizeServerModelNotification,
  normalizeTraexMax,
  restoredMaxMode,
  traexMaxConfigFlags,
  traexTurnBackendVariant
} from '../src/main/maxMode.ts'
import type { AgentDef, SessionConfig } from '../src/shared/types.ts'
import { displayedContextWindow } from '../src/renderer/contextWindow.ts'
import { sessionMetadata } from '../src/main/sessionStore.ts'
import { Orchestrator } from '../src/main/orchestrator.ts'

const cache = projectModelCache([
  {
    slug: 'GPT-Max',
    context_window: 272000,
    max_context_window: 800000,
    business_metadata: { variants: { max_key: 'gpt-max__max', max_context_window: 800000 } }
  },
  {
    slug: 'Standard-Only',
    context_window: 200000,
    max_context_window: 1000000,
    business_metadata: { variants: { max_key: null, max_context_window: 1000000 } }
  },
  {
    slug: 'Nested-Max',
    context_window: 200000,
    business_metadata: { variants: { max_key: 'nested__max', max_context_window: 1000000 } }
  }
])
assert.deepEqual(
  cache.map((m) => [m.id, m.contextWindow, m.maxContextWindow, m.supportsMax]),
  [
    ['GPT-Max', 272000, 800000, true],
    ['Standard-Only', 200000, undefined, false],
    ['Nested-Max', 200000, 1000000, true]
  ]
)

const traexStandardCatalog = projectModelCache([{
  slug: 'GPT-5.6-Sol',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'ultra' }
  ],
  business_metadata: {
    variants: {
      standard_default_reasoning_level: 'medium',
      standard_supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }
      ]
    }
  }
}], 'slug', 'standard')
assert.deepEqual(traexStandardCatalog[0]?.efforts, ['low', 'medium', 'high', 'xhigh'])
assert.equal(traexStandardCatalog[0]?.defaultEffort, 'medium')

const traex: AgentDef = {
  id: 'traex', name: 'TraeX', bin: 'traecli', adapter: 'traex', icon: '', builtin: true,
  capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] },
  models: cache
}
const base: SessionConfig = {
  agentId: 'traex', model: 'GPT-Max', effort: 'high', workdir: '/repo', permissionMode: 'read-only'
}
const codex: AgentDef = {
  ...traex, id: 'codex', name: 'Codex', bin: 'codex', adapter: 'codex'
}
assert.deepEqual(traexMaxConfigFlags(traex.adapter, true), ['-c', 'model_backend_variant="max"'])
assert.deepEqual(traexMaxConfigFlags(traex.adapter, false), [])
assert.equal(traexTurnBackendVariant(true), 'max')
assert.equal(traexTurnBackendVariant(false), null)
assert.deepEqual(normalizeTraexMax('traex', true, true), { maxMode: true, disabled: false })
assert.deepEqual(normalizeTraexMax('traex', false, true), { maxMode: false, disabled: true })
assert.deepEqual(normalizeTraexMax('codex', true, true), { maxMode: false, disabled: true })

const maxTurn = buildTurnStartParams(traex, { ...base, maxMode: true }, 'thread-1', 'hello')
assert.equal(maxTurn.modelBackendVariant, 'max')
assert.equal(Object.prototype.hasOwnProperty.call(maxTurn, 'modelBackendVariant'), true)
const standardTurn = buildTurnStartParams(traex, { ...base, maxMode: false }, 'thread-1', 'hello')
assert.equal(standardTurn.modelBackendVariant, null)
assert.equal(Object.prototype.hasOwnProperty.call(standardTurn, 'modelBackendVariant'), true)
const codexTurn = buildTurnStartParams(codex, { ...base, agentId: 'codex' }, 'thread-1', 'hello')
assert.equal(Object.prototype.hasOwnProperty.call(codexTurn, 'modelBackendVariant'), false)

const fallback = formatModelNotice('fallback', {
  fromModel: 'GPT-Max', toModel: 'Standard-Only', modelBackendVariant: 'standard', reason: 'capacity'
})
assert.match(fallback, /自动回退/)
assert.match(fallback, /Max 已降级为标准模式/)
assert.match(fallback, /capacity/)
assert.match(formatModelNotice('fallback', { modelBackendVariant: null }), /Max 已降级为标准模式/)
assert.match(formatModelNotice('rerouted', { to_model: 'GPT-Max', model_backend_variant: 'max' }), /重新路由.*Max/)
assert.match(formatModelNotice('verification', { message: 'policy adjusted' }), /校验调整.*policy adjusted/)

const normalizedFallback = normalizeModelNotification('fallback', {
  fromModel: 'GPT-Max', toModel: 'Standard-Only', modelBackendVariant: 'standard'
}, cache)
assert.equal(normalizedFallback.noticeKind, 'warning')
assert.deepEqual(normalizedFallback.correction, { model: 'Standard-Only', maxMode: false })
const mappedFallback = normalizeServerModelNotification('model/fallback', {
  event: {
    type: 'committed',
    configuredPrimary: 'GPT-Max', trigger: 'modelCapacity', attemptCount: 2,
    target: { ordinal: 2, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' }
  }
}, cache)!
assert.equal(mappedFallback.noticeKind, 'warning')
assert.deepEqual(mappedFallback.correction, { model: 'Standard-Only', maxMode: false })
const mappedReroute = normalizeServerModelNotification('model/rerouted', {
  toModel: 'Standard-Only'
}, cache)!
assert.equal(mappedReroute.noticeKind, 'warning')
assert.deepEqual(mappedReroute.correction, { model: 'Standard-Only', maxMode: false })
assert.equal(normalizeServerModelNotification('thread/compacted', {}, cache), undefined)

const runner = new AppServerRunner('session-1', { n: 0 }, traex, { ...base, maxMode: true })
const runnerEvents: any[] = []
const runnerCorrections: any[] = []
runner.on('event', (event) => runnerEvents.push(event))
runner.on('configCorrection', (correction) => runnerCorrections.push(correction))
const fallbackAttemptStarted = {
  // Schema evidence: strings(traecli) exposes FallbackTarget and the tagged
  // ModelFallbackEvent union fields used verbatim by these fixtures.
  event: {
    type: 'attemptStarted', ordinal: 1, trigger: 'modelCapacity',
    from: { ordinal: 0, provider: 'trae', model: 'GPT-Max', modelBackendVariant: 'gpt-max__max' },
    to: { ordinal: 1, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' }
  }
}
const fallbackAttemptFailed = {
  event: {
    type: 'attemptFailed', ordinal: 1, errorKind: 'modelCapacity', retryCount: 0,
    target: { ordinal: 1, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' }
  }
}
const fallbackAttemptFailedRetry = {
  event: {
    type: 'attemptFailed', ordinal: 1, errorKind: 'modelCapacity', retryCount: 1,
    target: { ordinal: 1, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' }
  }
}
const fallbackCommitted = {
  event: {
    type: 'committed', ordinal: 2,
    configuredPrimary: 'GPT-Max',
    trigger: 'modelCapacity', attemptCount: 2,
    target: { ordinal: 2, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' },
    settings: { serviceTier: { requested: 'priority', effective: 'default' }, verbosity: 'medium' }
  }
}
const fallbackCandidateSkipped = {
  event: {
    type: 'candidateSkipped', ordinal: 1, reason: 'duplicateAttempt',
    target: { ordinal: 1, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' }
  }
}
const fallbackExhausted = {
  event: { type: 'exhausted', attempts: 3, finalErrorKind: 'modelUnavailable' }
}
const fallbackSettingOne = {
  event: {
    type: 'settingsAdjusted', field: 'serviceTier', requested: 'priority', effective: 'default',
    target: { ordinal: 1, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' },
    reason: 'explicitSettingUnsupported'
  }
}
const fallbackSettingTwo = {
  event: {
    type: 'settingsAdjusted', field: 'reasoningSummary', requested: 'detailed', effective: 'auto',
    target: { ordinal: 1, provider: 'trae', model: 'Standard-Only', modelBackendVariant: 'standard' },
    reason: 'strictSettingUnsupported'
  }
}
;(runner as any).onNotification('model/fallback', fallbackAttemptStarted)
;(runner as any).onNotification('model/fallback', fallbackCandidateSkipped)
;(runner as any).onNotification('model/fallback', fallbackSettingOne)
;(runner as any).onNotification('model/fallback', fallbackSettingTwo)
;(runner as any).onNotification('model/fallback', fallbackAttemptFailed)
;(runner as any).onNotification('model/fallback', fallbackAttemptFailedRetry)
;(runner as any).onNotification('model/fallback', fallbackAttemptFailedRetry)
;(runner as any).onNotification('model/fallback', fallbackExhausted)
;(runner as any).onNotification('model/fallback', fallbackExhausted)
;(runner as any).onNotification('model/fallback', fallbackCommitted)
;(runner as any).onNotification('model/fallback', fallbackCommitted)
assert.equal(runnerEvents.length, 8)
assert.deepEqual(runnerEvents.map((e) => e.payload.kind), Array(8).fill('warning'))
assert.deepEqual(runnerCorrections, [{ model: 'Standard-Only', maxMode: false }])
assert.match(runnerEvents[2].payload.text, /请求 priority → 生效 default/)

const startedDifferentFrom = structuredClone(fallbackAttemptStarted)
startedDifferentFrom.event.from.model = 'Nested-Max'
const startedA = normalizeServerModelNotification('model/fallback', fallbackAttemptStarted, cache)!
const startedB = normalizeServerModelNotification('model/fallback', startedDifferentFrom, cache)!
assert.notEqual(startedA.key, startedB.key)

const committedDifferentPrimary = structuredClone(fallbackCommitted)
committedDifferentPrimary.event.configuredPrimary = 'Nested-Max'
const committedDifferentSettings = structuredClone(fallbackCommitted)
committedDifferentSettings.event.settings.verbosity = 'high'
const committedReorderedSettings = structuredClone(fallbackCommitted)
committedReorderedSettings.event.settings = {
  verbosity: 'medium',
  serviceTier: { effective: 'default', requested: 'priority' }
}
const committedA = normalizeServerModelNotification('model/fallback', fallbackCommitted, cache)!
assert.notEqual(
  committedA.key,
  normalizeServerModelNotification('model/fallback', committedDifferentPrimary, cache)!.key
)
assert.notEqual(
  committedA.key,
  normalizeServerModelNotification('model/fallback', committedDifferentSettings, cache)!.key
)
assert.equal(
  committedA.key,
  normalizeServerModelNotification('model/fallback', committedReorderedSettings, cache)!.key
)

const normalizedNull = normalizeModelNotification('verification', {
  modelBackendVariant: null
}, cache)
assert.deepEqual(normalizedNull.correction, { maxMode: false })
const normalizedFalse = normalizeModelNotification('verification', { maxMode: false }, cache)
assert.deepEqual(normalizedFalse.correction, { maxMode: false })

const verification = normalizeServerModelNotification('model/verification', {
  // Schema evidence: traecli ModelVerification is a string enum.
  verifications: ['trustedAccessForCyber']
}, cache)!
assert.match(verification.text, /trustedAccessForCyber/)
assert.equal(verification.correction, undefined)
const verificationWithoutEvidence = normalizeServerModelNotification('model/verification', {
  verifications: ['trustedAccessForCyber']
}, cache)!
assert.equal(verificationWithoutEvidence.correction, undefined)

const tokenCountHistory = historyModelEvidenceOf({
  type: 'token_count',
  context: { model: 'GPT-Max', modelBackendVariant: 'max', modelContextWindow: 800000 },
  info: { model_context_window: 800000 }
})
assert.deepEqual(tokenCountHistory, {
  model: 'GPT-Max', variant: 'max', hasVariant: true, contextWindow: 800000
})
assert.equal(historyModelEvidenceOf({ type: 'model_fallback', ...fallbackAttemptStarted }).hasVariant, false)
assert.deepEqual(historyModelEvidenceOf({ type: 'model_fallback', ...fallbackCommitted }), {
  model: 'Standard-Only', variant: 'standard', hasVariant: true
})
assert.deepEqual(historyModelEvidenceOf({
  type: 'model_verification', verifications: ['trustedAccessForCyber']
}), { hasVariant: false })
const unknownCommitted = normalizeServerModelNotification('model/fallback', {
  event: {
    type: 'committed', configuredPrimary: 'GPT-Max', trigger: 'modelCapacity', attemptCount: 1,
    target: { ordinal: 1, provider: 'trae', model: 'Unknown', modelBackendVariant: 'unknown__dev' }
  }
}, cache)!
assert.equal(unknownCommitted.correction, undefined)
const knownExplicitDev = normalizeServerModelNotification('model/fallback', {
  event: {
    type: 'committed', configuredPrimary: 'GPT-Max', trigger: 'modelCapacity', attemptCount: 1,
    target: { ordinal: 1, provider: 'trae', model: 'Nested-Max', modelBackendVariant: 'nested__dev' }
  }
}, cache)!
assert.deepEqual(knownExplicitDev.correction, { model: 'Nested-Max', maxMode: false })
assert.match(knownExplicitDev.text, /Max 已降级为标准模式/)
const knownCanary = normalizeServerModelNotification('model/fallback', {
  event: {
    type: 'committed', configuredPrimary: 'GPT-Max', trigger: 'modelCapacity', attemptCount: 1,
    target: { ordinal: 1, provider: 'trae', model: 'Nested-Max', modelBackendVariant: 'nested__canary' }
  }
}, cache)!
assert.deepEqual(knownCanary.correction, { model: 'Nested-Max' })
assert.doesNotMatch(knownCanary.text, /Max 已降级/)
assert.equal(restoredMaxMode(true, 'nested__canary'), true)
assert.equal(restoredMaxMode(undefined, 'nested__canary'), undefined)
assert.equal(restoredMaxMode(true, 'nested__dev'), false)

const supportedReroute = normalizeModelNotification('rerouted', { toModel: 'Nested-Max' }, cache)
assert.deepEqual(supportedReroute.correction, { model: 'Nested-Max' })
const unknownReroute = normalizeModelNotification('rerouted', { toModel: 'unknown-model' }, cache)
assert.equal(unknownReroute.correction, undefined)

const turnKeys = new Set<string>()
assert.equal(claimModelNotification(turnKeys, normalizedFallback.key), true)
assert.equal(claimModelNotification(turnKeys, normalizedFallback.key), false)
turnKeys.clear()
assert.equal(claimModelNotification(turnKeys, normalizedFallback.key), true)

assert.equal(isMaterialContextWindowMismatch(800000, 800000), false)
assert.equal(isMaterialContextWindowMismatch(796000, 800000), false)
assert.equal(isMaterialContextWindowMismatch(258400, 272000), false)
assert.equal(isMaterialContextWindowMismatch(244800, 272000), false)
assert.equal(isMaterialContextWindowMismatch(244799, 272000), true)
assert.equal(isMaterialContextWindowMismatch(272000, 800000), true)
assert.equal(isMaterialContextWindowMismatch(undefined, 800000), false)
assert.equal(isMaterialContextWindowMismatch(800000, undefined), false)

const oldUsage: any = {
  sessionId: 's', seq: 1, ts: 1, type: 'system_notice',
  payload: { kind: 'usage', usage: { contextWindow: 258400 } }
}
assert.equal(displayedContextWindow([oldUsage], 'idle', 800000), 800000)
assert.equal(displayedContextWindow([oldUsage], 'idle'), 258400)
const newUser: any = { sessionId: 's', seq: 2, ts: 2, type: 'user_message', payload: { text: 'next' } }
assert.equal(displayedContextWindow([oldUsage, newUser], 'running', 800000), 800000)
assert.equal(displayedContextWindow([oldUsage, newUser], 'running'), undefined)
const newUsage: any = {
  sessionId: 's', seq: 3, ts: 3, type: 'system_notice',
  payload: { kind: 'context', usage: { contextWindow: 790000 } }
}
assert.equal(displayedContextWindow([oldUsage, newUser, newUsage], 'running', 800000), 790000)

const memoryStore = { load: () => [], save: () => {} } as any
const sameMainProcess = new Orchestrator(() => undefined, memoryStore) as any
sameMainProcess.events.set('s', [oldUsage, newUser, newUsage])
sameMainProcess.backendConfigCorrectionSeqs.set('s', 4)
const firstRenderer = await sameMainProcess.getSessionRuntimeState('s')
const reloadedRenderer = await sameMainProcess.getSessionRuntimeState('s')
assert.equal(firstRenderer.backendConfigCorrectionSeq, 4)
assert.equal(reloadedRenderer.backendConfigCorrectionSeq, 4)
assert.equal(
  displayedContextWindow(reloadedRenderer.events, 'running', 200000, reloadedRenderer.backendConfigCorrectionSeq),
  200000
)
const restartedMainProcess = new Orchestrator(() => undefined, memoryStore) as any
restartedMainProcess.events.set('s', [oldUsage, newUser, newUsage])
assert.equal((await restartedMainProcess.getSessionRuntimeState('s')).backendConfigCorrectionSeq, undefined)
// A backend correction at seq 4 invalidates earlier current-turn Max usage. The
// meter immediately uses the corrected standard config until a later tick arrives.
assert.equal(displayedContextWindow([oldUsage, newUser, newUsage], 'running', 200000, 4), 200000)
const correctedUsage: any = {
  sessionId: 's', seq: 5, ts: 5, type: 'system_notice',
  payload: { kind: 'context', usage: { contextWindow: 198000 } }
}
assert.equal(
  displayedContextWindow([oldUsage, newUser, newUsage, correctedUsage], 'running', 200000, 4),
  198000
)

const staleEffortSession: any = {
  id: 'stale-effort',
  title: 'stale effort',
  config: { ...base, model: 'GPT-5.6-Sol', effort: 'ultra' },
  status: 'idle',
  createdAt: 1
}
let persistedSessions = [staleEffortSession]
const effortStore = {
  load: () => persistedSessions,
  save: (sessions: any[]) => { persistedSessions = structuredClone(sessions) }
} as any
const effortOrchestrator = new Orchestrator(
  () => ({ ...traex, models: traexStandardCatalog }),
  effortStore
)
effortOrchestrator.loadPersisted()
assert.equal(effortOrchestrator.reconcileAgentConfigs(), true)
assert.equal(effortOrchestrator.getSessionById('stale-effort')?.config.effort, traexStandardCatalog[0]?.defaultEffort)
assert.equal(persistedSessions[0]?.config.effort, traexStandardCatalog[0]?.defaultEffort)
assert.equal(effortOrchestrator.reconcileAgentConfigs(), false)

const persisted = sessionMetadata({
  id: 'persisted', title: 'persisted', config: base, status: 'running', createdAt: 1,
  backendConfigCorrectionSeq: 999
} as any)
assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'backendConfigCorrectionSeq'), false)
// After hydration the transient map starts empty; an old persisted seq therefore
// cannot mask the new process's independently rebuilt event coordinates.
assert.equal(displayedContextWindow([oldUsage, newUser, newUsage], 'running', 800000), 790000)

console.log('max-mode focused tests passed')
