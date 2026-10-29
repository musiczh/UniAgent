import type { GrokNativeCapability, GrokNativeContract, SessionAgentContract } from '../shared/types.ts'
import type { ACPInitialize } from './acp/acpTypes.ts'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const GROK_NATIVE_VERSION = '1.0.70'
const VERIFIED_NATIVE_VERSIONS = new Set(['1.0.62', GROK_NATIVE_VERSION])
const FEATURES: GrokNativeCapability[] = ['goal', 'steer', 'subagents', 'questions', 'images', 'usage', 'fork', 'inventory']

/** Export only model limits: the native cache can also contain credentials. */
export async function grokModelContextWindows(env: NodeJS.ProcessEnv = {}): Promise<Record<string,number>> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(join(env.GROK_HOME || process.env.GROK_HOME || join(env.HOME || homedir(),'.grok'),'models_cache.json'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) return {}
    const cache = JSON.parse(await file.readFile('utf8'))
    if (!VERIFIED_NATIVE_VERSIONS.has(grokVersion(cache.grok_version) || '') || !cache.models || typeof cache.models !== 'object') return {}
    return Object.fromEntries(Object.entries(cache.models).slice(0,500).flatMap(([id,value]:[string,any]) =>
      value?.info?.id === id && Number.isSafeInteger(value.info.context_window) && value.info.context_window > 0 && value.info.context_window <= 100_000_000
        ? [[id,value.info.context_window]] : []))
  } catch { return {} }
  finally { await file?.close() }
}

export function grokVersion(value: unknown): string | undefined {
  return typeof value === 'string' ? /^(?:grok\s+)?(\d+\.\d+\.\d+)(?:\s|$)/.exec(value)?.[1] : undefined
}

export function grokNativeHandshake(initialize: ACPInitialize): GrokNativeContract {
  const version = grokVersion(initialize.agentInfo?.version || initialize._meta?.agentVersion) || 'unknown'
  const supported = VERIFIED_NATIVE_VERSIONS.has(version)
  return { version, confirmed: supported, capabilities: Object.fromEntries(FEATURES.map(key => [key,
    { status: supported ? key === 'goal' ? 'unknown' : 'verified' : 'unsupported',
      ...(!supported ? { reason: '当前 Grok 版本尚未验证原生扩展' } : {}) }
  ])) as GrokNativeContract['capabilities'] }
}

export function grokCapabilityAvailable(state: GrokNativeContract | undefined, key: GrokNativeCapability): boolean {
  return state?.confirmed === true && state.capabilities[key]?.status === 'verified'
}

/** The one projection used after every config/command/mode update. */
export function projectGrokContract(base: SessionAgentContract, native: GrokNativeContract): SessionAgentContract {
  if (!VERIFIED_NATIVE_VERSIONS.has(native.version)) return { ...base, grokNative:structuredClone(native) }
  const has = (key: GrokNativeCapability) => grokCapabilityAvailable(native, key)
  return { ...base, grokNative: structuredClone(native),
    models: base.models.map(model => ({ ...model, imageInput: has('images') && model.id === 'grok-4.7' })),
    imageAttachments: has('images') && base.currentModelId === 'grok-4.7',
    nativeGoal: has('goal'), steer: has('steer'), structuredSubagents: has('subagents'),
    formElicitation: has('questions'), freeTextElicitation: has('questions'), structuredUsage: has('usage'),
    sessionFork: has('fork'), sideChat: has('fork'), capabilityInventory: has('inventory'),
    nativeReview: false, sessionForkAtTurn: false, crossAgentFork: false, collaborationModes: ['default'] }
}

/** Persisted capabilities are hints until this process has renegotiated its connection. */
export function unconfirmGrokContract(contract: SessionAgentContract): SessionAgentContract {
  if (!contract.grokNative) return contract
  return projectGrokContract(contract, { ...contract.grokNative, confirmed: false })
}
