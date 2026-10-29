import type { AgentDef, Attachment, ModelDef, SessionConfig } from '../shared/types'
import type { ResolvedNativeTurnContext } from '../shared/nativeCapabilities'

/** Pure helpers shared by adapters and focused protocol tests. */

export function traexMaxConfigFlags(adapter: string, maxMode: boolean | undefined): string[] {
  if (adapter !== 'traex' || !maxMode) return []
  return ['-c', 'model_backend_variant="max"']
}

/** turn/start contract: null explicitly disables a previously enabled Max turn. */
export function traexTurnBackendVariant(maxMode: boolean | undefined): 'max' | null {
  return maxMode ? 'max' : null
}

export function normalizeTraexMax(
  adapter: string | undefined,
  supportsMax: boolean | undefined,
  maxMode: boolean | undefined
): { maxMode: boolean; disabled: boolean } {
  if (!maxMode) return { maxMode: false, disabled: false }
  if (adapter === 'traex' && supportsMax) return { maxMode: true, disabled: false }
  return { maxMode: false, disabled: true }
}

export function formatModelNotice(
  kind: 'rerouted' | 'fallback' | 'verification',
  p: any
): string {
  const from = p?.fromModel ?? p?.from_model ?? p?.previousModel ?? p?.previous_model
  const to = p?.toModel ?? p?.to_model ?? p?.model ?? p?.selectedModel ?? p?.selected_model
  const reason = p?.reason ?? p?.message ?? p?.detail
  const variant = modelBackendVariantOf(p)
  const labels = {
    rerouted: '模型已由服务端重新路由',
    fallback: '模型已由服务端自动回退',
    verification: '模型配置已由服务端校验调整'
  }
  let text = labels[kind]
  if (from || to) text += `：${from || '原模型'} → ${to || '实际模型'}`
  if (variant === 'standard' || variant === null || p?.maxMode === false) {
    text += '（Max 已降级为标准模式）'
  } else if (variant === 'max' || p?.maxMode === true) {
    text += '（Max）'
  }
  if (reason) text += `；原因：${reason}`
  return text + '。'
}

/** Preserve an explicit null: in the app-server contract null means standard/off. */
export function modelBackendVariantOf(p: any): unknown {
  if (p && Object.prototype.hasOwnProperty.call(p, 'modelBackendVariant')) return p.modelBackendVariant
  if (p && Object.prototype.hasOwnProperty.call(p, 'model_backend_variant')) return p.model_backend_variant
  return p?.backendVariant
}

export type ModelNotificationKind = 'rerouted' | 'fallback' | 'verification'

export interface NormalizedModelNotification {
  key: string
  noticeKind: 'warning'
  text: string
  correction?: Pick<SessionConfig, 'model' | 'maxMode'>
}

export interface ModelSettingsEvidence {
  model?: string
  variant?: unknown
  hasVariant: boolean
  contextWindow?: number
}

/** Evidence source: traecli binary schema `FallbackTarget { ordinal, provider, model, modelBackendVariant }`. */
function fallbackTargetEvidence(target: any): ModelSettingsEvidence {
  return modelSettingsEvidenceOf(target)
}

function fallbackTargetProjection(target: any): Record<string, unknown> | undefined {
  if (!target || typeof target !== 'object') return undefined
  return {
    ordinal: target.ordinal,
    provider: target.provider,
    model: target.model,
    modelBackendVariant: target.modelBackendVariant
  }
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(object[key])}`
  ).join(',')}}`
}

/**
 * Exact semantic projection of traecli's tagged ModelFallbackEvent union.
 * Unknown transport fields are ignored; every schema field that can distinguish
 * two legal notifications is stable-serialized (including nested settings).
 */
function fallbackPhaseIdentity(phase: string, event: any, target: any): string {
  let projection: Record<string, unknown>
  switch (phase) {
    case 'attemptStarted':
      projection = {
        ordinal: event.ordinal,
        from: fallbackTargetProjection(event.from),
        to: fallbackTargetProjection(event.to),
        trigger: event.trigger
      }
      break
    case 'candidateSkipped':
      projection = { ordinal: event.ordinal, target: fallbackTargetProjection(target), reason: event.reason }
      break
    case 'settingsAdjusted':
      projection = {
        target: fallbackTargetProjection(target),
        field: event.field,
        requested: event.requested,
        effective: event.effective,
        reason: event.reason
      }
      break
    case 'attemptFailed':
      projection = {
        ordinal: event.ordinal,
        target: fallbackTargetProjection(target),
        errorKind: event.errorKind,
        retryCount: event.retryCount
      }
      break
    case 'committed':
      projection = {
        ordinal: event.ordinal,
        configuredPrimary: event.configuredPrimary,
        trigger: event.trigger,
        attemptCount: event.attemptCount,
        target: fallbackTargetProjection(target),
        settings: event.settings
      }
      break
    case 'exhausted':
      projection = { attempts: event.attempts, finalErrorKind: event.finalErrorKind }
      break
    default:
      projection = { target: fallbackTargetProjection(target), reason: event.reason, errorKind: event.errorKind }
  }
  return stableSerialize(projection)
}

export function isMaxVariant(variant: unknown): boolean {
  return variant === 'max' || (typeof variant === 'string' && variant.endsWith('__max'))
}

/** Explicit standard evidence observed in traecli rollout context/fallback targets. */
export function isStandardVariant(variant: unknown): boolean {
  return variant === null || variant === 'standard' ||
    (typeof variant === 'string' && variant.endsWith('__dev'))
}

export function restoredMaxMode(
  previous: boolean | undefined,
  variant: unknown
): boolean | undefined {
  if (isMaxVariant(variant)) return true
  if (isStandardVariant(variant)) return false
  return previous
}

function own(obj: any, camel: string, snake: string): { found: boolean; value?: unknown } {
  if (obj && Object.prototype.hasOwnProperty.call(obj, camel)) return { found: true, value: obj[camel] }
  if (obj && Object.prototype.hasOwnProperty.call(obj, snake)) return { found: true, value: obj[snake] }
  return { found: false }
}

/** Read only explicit settings evidence; an absent variant must not mean standard/off. */
export function modelSettingsEvidenceOf(...sources: any[]): ModelSettingsEvidence {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const variant = own(source, 'modelBackendVariant', 'model_backend_variant')
    const maxMode = own(source, 'maxMode', 'max_mode')
    const model = source.model ?? source.modelId ?? source.model_id
    const contextWindow = source.modelContextWindow ?? source.model_context_window
    if (variant.found || maxMode.found || typeof model === 'string' || typeof contextWindow === 'number') {
      const effectiveVariant = variant.found
        ? variant.value
        : maxMode.found
          ? maxMode.value === true ? 'max' : maxMode.value === false ? 'standard' : undefined
          : undefined
      return {
        ...(typeof model === 'string' ? { model } : {}),
        ...(variant.found || maxMode.found ? { variant: effectiveVariant } : {}),
        hasVariant: variant.found || maxMode.found,
        ...(typeof contextWindow === 'number' ? { contextWindow } : {})
      }
    }
  }
  return { hasVariant: false }
}

/** Extract final model settings from a persisted event_msg payload. */
export function historyModelEvidenceOf(p: any): ModelSettingsEvidence {
  const contextEvidence = modelSettingsEvidenceOf(p?.context)
  if (contextEvidence.hasVariant || contextEvidence.model || contextEvidence.contextWindow) {
    return contextEvidence
  }
  if (p?.type === 'model_fallback') {
    const event = p?.event || {}
    if (event.type !== 'committed') return { hasVariant: false }
    return fallbackTargetEvidence(event.target)
  }
  return { hasVariant: false }
}

export function normalizeServerModelNotification(
  method: string,
  p: any,
  models: ModelDef[]
): NormalizedModelNotification | undefined {
  const kinds: Record<string, ModelNotificationKind> = {
    'model/rerouted': 'rerouted',
    'model/fallback': 'fallback',
    'model/verification': 'verification'
  }
  const kind = kinds[method]
  if (!kind) return undefined
  if (kind === 'fallback') return normalizeFallbackNotification(p, models)
  if (kind === 'verification') return normalizeVerificationNotification(p, models)
  return normalizeModelNotification(kind, p, models)
}

function correctionFromEvidence(
  target: unknown,
  evidence: ModelSettingsEvidence,
  models: ModelDef[]
): Pick<SessionConfig, 'model' | 'maxMode'> | undefined {
  const targetId = typeof target === 'string' ? target : evidence.model
  const knownTarget = targetId ? models.find((m) => m.id === targetId) : undefined
  const forceMaxOff =
    (!!knownTarget && evidence.hasVariant && isStandardVariant(evidence.variant)) ||
    (!!knownTarget && !knownTarget.supportsMax)
  const forceMaxOn = evidence.hasVariant && isMaxVariant(evidence.variant) && !!knownTarget?.supportsMax
  return knownTarget || forceMaxOff
    ? {
        ...(knownTarget ? { model: knownTarget.id } : {}),
        ...(forceMaxOff ? { maxMode: false } : forceMaxOn ? { maxMode: true } : {})
      }
    : undefined
}

function normalizeFallbackNotification(p: any, models: ModelDef[]): NormalizedModelNotification {
  const event = p?.event || {}
  const phase = event.type ?? 'notification'
  const target = event.target ?? event.to
  const evidence = fallbackTargetEvidence(target)
  const reason = event.reason ?? event.error?.message ?? event.error ?? event.message ?? p?.reason
  const phaseLabels: Record<string, string> = {
    attemptStarted: '开始尝试回退',
    candidateSkipped: '跳过回退候选',
    settingsAdjusted: '调整回退设置',
    attemptFailed: '回退尝试失败',
    committed: '已提交回退',
    exhausted: '回退候选已耗尽'
  }
  let text = `模型回退：${phaseLabels[phase] || phase}`
  if (evidence.model) text += ` → ${evidence.model}`
  if (phase === 'settingsAdjusted') {
    text += `；${event.field}：请求 ${String(event.requested)} → 生效 ${String(event.effective)}`
  }
  if (evidence.hasVariant && isStandardVariant(evidence.variant)) {
    text += '（Max 已降级为标准模式）'
  }
  if (reason) text += `；原因：${typeof reason === 'string' ? reason : JSON.stringify(reason)}`
  return {
    key: `model:fallback:${phase}:${fallbackPhaseIdentity(phase, event, target)}`,
    noticeKind: 'warning',
    text: text + '。',
    ...(phase === 'committed'
      ? { correction: correctionFromEvidence(evidence.model, evidence, models) }
      : {})
  }
}

function normalizeVerificationNotification(p: any, _models: ModelDef[]): NormalizedModelNotification {
  // Evidence source: traecli ModelVerification is a string enum
  // (`trustedAccessForCyber`), never an object containing adjusted settings.
  const verifications = (Array.isArray(p?.verifications) ? p.verifications : [])
    .filter((value: unknown): value is string => typeof value === 'string')
  const identity = verifications.join('|') || String(p?.message ?? p?.reason ?? 'verification')
  return {
    key: `model:verification:${identity}`,
    noticeKind: 'warning',
    text: `模型配置校验：${verifications.join('、') || p?.message || p?.reason || '服务端已完成校验'}。`
  }
}

/** Normalize a server model notification into one warning and an optional safe config correction. */
export function normalizeModelNotification(
  kind: ModelNotificationKind,
  p: any,
  models: ModelDef[]
): NormalizedModelNotification {
  const from = p?.fromModel ?? p?.from_model ?? p?.previousModel ?? p?.previous_model
  const to = p?.toModel ?? p?.to_model ?? p?.model ?? p?.selectedModel ?? p?.selected_model
  const reason = p?.reason ?? p?.message ?? p?.detail
  const variant = modelBackendVariantOf(p)
  const identity = from || to || variant !== undefined
    ? `${kind}:${from || ''}:${to || ''}:${String(variant)}`
    : `${kind}:${reason || ''}`
  const knownTarget = typeof to === 'string' ? models.find((m) => m.id === to) : undefined
  const forceMaxOff =
    variant === null ||
    variant === 'standard' ||
    p?.maxMode === false ||
    (!!knownTarget && !knownTarget.supportsMax)
  const forceMaxOn = (isMaxVariant(variant) || p?.maxMode === true) && !!knownTarget?.supportsMax
  const correction = knownTarget || forceMaxOff
    ? {
        ...(knownTarget ? { model: knownTarget.id } : {}),
        ...(forceMaxOff ? { maxMode: false } : forceMaxOn ? { maxMode: true } : {})
      }
    : undefined
  return {
    key: `model:${identity}`,
    noticeKind: 'warning',
    text: formatModelNotice(kind, p),
    ...(correction ? { correction } : {})
  }
}

/** Claim one semantic notification for the current turn. Clear the set at each turn boundary. */
export function claimModelNotification(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false
  keys.add(key)
  return true
}

export function buildInput(
  prompt: string,
  attachments?: Attachment[],
  nativeContext?: ResolvedNativeTurnContext
): any[] {
  const input: any[] = prompt ? [{ type: 'text', text: prompt, text_elements: [] }] : []
  for (const a of attachments || []) {
    input.push(
      a.kind === 'image'
        ? { type: 'localImage', path: a.path }
        : { type: 'mention', name: a.name, path: a.path }
    )
  }
  for (const skill of nativeContext?.skills || []) {
    input.push({ type: 'skill', name: skill.name, path: skill.path })
  }
  return input
}

/** Exact app-server turn contract, kept dependency-light for protocol tests. */
export function buildTurnStartParams(
  agent: AgentDef,
  config: SessionConfig,
  threadId: string | undefined,
  prompt: string,
  attachments?: Attachment[],
  nativeContext?: ResolvedNativeTurnContext
): Record<string, any> {
  return {
    threadId,
    input: buildInput(prompt, attachments, nativeContext),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(agent.adapter === 'codex'
      ? { serviceTier: config.fastMode ? 'priority' : 'default' }
      : {}),
    ...(agent.adapter === 'traex'
      ? { modelBackendVariant: traexTurnBackendVariant(config.maxMode) }
      : {})
  }
}

/** Ignore unknown/invalid windows and server-side rounding/reservation differences. */
export function isMaterialContextWindowMismatch(actual?: number, expected?: number): boolean {
  if (!actual || !expected || actual <= 0 || expected <= 0) return false
  const tolerance = Math.max(4096, expected * 0.1)
  return Math.abs(actual - expected) > tolerance
}
