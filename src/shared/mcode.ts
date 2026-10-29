/** MiniMax Code integration contract (shared between main, preload and renderer). */

export const MCODE_BIN = 'mcode'

export const MCODE_IPC = {
  get: 'mcode:get',
  check: 'mcode:check',
  install: 'mcode:install',
  signIn: 'mcode:sign-in',
  cancel: 'mcode:cancel',
  reopen: 'mcode:reopen'
} as const

export interface MCodeConnectionInput {
  apiKey?: string
  region?: 'cn' | 'global'
}

export interface MCodeConnectionSnapshot {
  installed: boolean
  version: string
  bin?: string
  dataDir: string
  status: 'uninstalled' | 'needs-auth' | 'ready' | 'failed'
  phase: 'idle' | 'checking' | 'installing' | 'login' | 'verifying' | 'cancelled' | 'failed'
  cancellable: boolean
  message?: string
  region: 'cn' | 'global'
  needsLogin: boolean
}

/**
 * Permission modes exposed by MiniMax Code's ACP `permissionMode` config option.
 * The runtime rejects anything outside these three values — there is no
 * read-only tier on the ACP surface, so we must not pretend there is one.
 */
export const MCODE_PERMISSION_VALUES = {
  ask: 'default',
  'approve-for-me': 'auto',
  'full-access': 'bypassPermissions'
} as const

export type MCodePermissionValue = (typeof MCODE_PERMISSION_VALUES)[keyof typeof MCODE_PERMISSION_VALUES]

/** Reverse lookup used when the agent reports its current permission mode back. */
export function mcodePermissionFromValue(value: unknown): string | undefined {
  const found = (Object.keys(MCODE_PERMISSION_VALUES) as Array<keyof typeof MCODE_PERMISSION_VALUES>)
    .find((key) => MCODE_PERMISSION_VALUES[key] === value)
  return found
}

/**
 * MiniMax Code encodes the selected model as
 * `m:<providerId>:<modelId>:u` (no variant) or
 * `m:<providerId>:<modelId>:v:<variant>` (with variant).
 */
export interface MCodeModelRef {
  providerId: string
  modelId: string
  variant?: string
}

export function parseMCodeModelValue(value: unknown): MCodeModelRef | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parts = value.split(':')
  if (parts.length < 4 || parts[0] !== 'm') return undefined
  const [, providerId, modelId, kind, variant, ...rest] = parts
  if (!providerId || !modelId || rest.length) return undefined
  if (kind === 'u') return variant === undefined ? { providerId, modelId } : undefined
  if (kind === 'v') return variant === undefined ? undefined : { providerId, modelId, variant }
  return undefined
}

/** Human readable label for an encoded model value, e.g. "MiniMax-M3 · thinking". */
export function mcodeModelLabel(value: unknown): string {
  const ref = parseMCodeModelValue(value)
  if (!ref) return typeof value === 'string' ? value : ''
  const base = ref.modelId
  return ref.variant ? `${base} · ${ref.variant}` : base
}
