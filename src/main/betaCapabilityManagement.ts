import type {
  BetaCapabilityManageErrorCode, BetaCapabilityManageRequest, BetaCapabilityManageResult,
  BetaCapabilityMcpConfiguration
} from '../shared/capabilitySync.ts'
export type { BetaCapabilityManageErrorCode, BetaCapabilityManageRequest, BetaCapabilityManageResult } from '../shared/capabilitySync.ts'
import {
  grokInventoryFromOptions, manageGrokInventory, type GrokInventoryCommandRunner,
  type GrokInventoryManageRequest, type GrokMcpConfiguration
} from './grokInventory.ts'
import {
  createKimiSkill, deleteKimiCapability, inspectKimiInventory, setKimiMcpEnabled, updateKimiSkill, upsertKimiMcp
} from './kimiInventory.ts'

export interface BetaCapabilityManagementOptions {
  home: string
  cwd: string
  grokBin?: string
  env?: NodeJS.ProcessEnv
  /** Main-process test seam; never part of the renderer request. */
  grokRunner?: GrokInventoryCommandRunner
}
const INVALID = 'invalid_capability_inventory_manage_request'
const MCP_FIELDS = ['transport', 'command', 'args', 'url', 'env', 'headers']
type RecordValue = Record<string, unknown>
const own = (value: object, key: string): boolean => Object.hasOwn(value, key)
function record(value: unknown): value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && own(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function keys(value: RecordValue, required: string[], optional: string[] = []): void {
  if (required.some((key) => !own(value, key)) || Reflect.ownKeys(value).some((key) =>
    !required.includes(String(key)) && !optional.includes(String(key)))) throw new Error(INVALID)
}
const text = (value: unknown, maximum = 16384): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function name(value: unknown, grok = false): asserts value is string {
  if (!text(value, 200) || !(grok ? /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/ : /^[A-Za-z0-9][A-Za-z0-9._-]*$/).test(value) || value === 'node_modules') throw new Error(INVALID)
}
function id(value: unknown, agentId: 'kimi' | 'grok', kind: 'skill' | 'mcp' | 'plugin'): asserts value is string {
  const expression = agentId === 'kimi'
    ? new RegExp(`^kimi:(?:agent|shared|plugin|builtin):${kind}:[a-f0-9]{24}$`)
    : new RegExp(`^grok:${kind}:[a-f0-9]{24}$`)
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(INVALID)
}
function list(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || !Array.from(value).every((item) =>
    typeof item === 'string' && item.length <= 16384 && !/[\u0000-\u001f\u007f]/.test(item))) throw new Error(INVALID)
  return [...value]
}
function stringMap(value: unknown, headers: boolean): Record<string, string> {
  if (!record(value) || Object.keys(value).length > 100 || Object.entries(value).some(([key, item]) =>
    !(headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key) ||
    typeof item !== 'string' || item.length > 16384 || /[\u0000-\u001f\u007f]/.test(item))) throw new Error(INVALID)
  return { ...value } as Record<string, string>
}
function mcpConfig(value: unknown, kimi: boolean, existing = false): BetaCapabilityMcpConfiguration {
  if (!record(value)) throw new Error(INVALID)
  keys(value, [], [...MCP_FIELDS, ...(kimi ? ['bearerTokenEnvVar', 'auth', 'executor', 'enabled', 'deferred',
    'startupTimeoutMs', 'toolTimeoutMs', 'enabledTools', 'disabledTools'] : [])])
  const transport = value.transport ?? (kimi && typeof value.command === 'string' ? 'stdio' : kimi && typeof value.url === 'string' ? 'http' : undefined)
  if (!['stdio', 'http', 'sse'].includes(String(transport))) throw new Error(INVALID)
  const output: RecordValue = {}
  if (own(value, 'transport')) output.transport = transport
  if (transport === 'stdio') {
    if (!text(value.command) || value.command.startsWith('-') || own(value, 'url') || own(value, 'headers') ||
      own(value, 'bearerTokenEnvVar') || own(value, 'auth')) throw new Error(INVALID)
    output.command = value.command
    if (own(value, 'args')) output.args = list(value.args)
    if (own(value, 'env')) output.env = existing && value.env === '[redacted]' ? value.env : stringMap(value.env, false)
    if (own(value, 'executor')) {
      if (!['local', 'kaos'].includes(String(value.executor))) throw new Error(INVALID)
      output.executor = value.executor
    }
  } else {
    if (!text(value.url) || own(value, 'command') || own(value, 'args') || own(value, 'env') || own(value, 'executor')) throw new Error(INVALID)
    if (!(existing && value.url === '[redacted]')) {
      let url: URL
      try { url = new URL(value.url) } catch { throw new Error(INVALID) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(INVALID)
    }
    output.url = value.url
    if (own(value, 'headers')) output.headers = existing && value.headers === '[redacted]' ? value.headers : stringMap(value.headers, true)
    if (own(value, 'auth')) { if (value.auth !== 'oauth') throw new Error(INVALID); output.auth = value.auth }
    if (own(value, 'bearerTokenEnvVar')) {
      if (!text(value.bearerTokenEnvVar, 200) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.bearerTokenEnvVar)) throw new Error(INVALID)
      output.bearerTokenEnvVar = value.bearerTokenEnvVar
    }
  }
  for (const key of ['enabled', 'deferred']) if (own(value, key)) {
    if (typeof value[key] !== 'boolean') throw new Error(INVALID); output[key] = value[key]
  }
  for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) if (own(value, key)) {
    if (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 2147483647) throw new Error(INVALID)
    output[key] = value[key]
  }
  for (const key of ['enabledTools', 'disabledTools']) if (own(value, key)) output[key] = list(value[key])
  return output as BetaCapabilityMcpConfiguration
}
function manifest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 5 * 1024 * 1024 || value.includes('\0')) throw new Error(INVALID)
}
function pluginSource(value: unknown): asserts value is string {
  if (!text(value, 4096)) throw new Error(INVALID)
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:@[A-Za-z0-9][A-Za-z0-9_.\/-]*)?$/.test(value)) return
  let url: URL
  try { url = new URL(value) } catch { throw new Error(INVALID) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(INVALID)
}

/** Validates and copies all fields before any provider is inspected or mutated. */
export function parseBetaCapabilityManageRequest(value: unknown): BetaCapabilityManageRequest {
  if (!record(value) || !['kimi', 'grok'].includes(String(value.agentId)) || !text(value.action, 100)) throw new Error(INVALID)
  const agentId = value.agentId as 'kimi' | 'grok', action = value.action
  if (agentId === 'kimi') {
    if (action === 'skill-create') {
      keys(value, ['agentId', 'action', 'name', 'manifestText']); name(value.name); manifest(value.manifestText)
      return { agentId, action, name: value.name, manifestText: value.manifestText }
    }
    if (action === 'skill-update' || action === 'skill-delete' || action === 'mcp-delete' || action === 'mcp-enable' || action === 'mcp-disable') {
      keys(value, ['agentId', 'action', 'id', 'expectedFingerprint', ...(action === 'skill-update' ? ['manifestText'] : [])])
      id(value.id, agentId, action.startsWith('mcp-') ? 'mcp' : 'skill')
      if (!fingerprint(value.expectedFingerprint)) throw new Error(INVALID)
      if (action === 'skill-update') { manifest(value.manifestText); return { agentId, action, id: value.id, expectedFingerprint: value.expectedFingerprint, manifestText: value.manifestText } }
      return { agentId, action, id: value.id, expectedFingerprint: value.expectedFingerprint }
    }
    if (action === 'mcp-upsert') {
      keys(value, ['agentId', 'action', 'name', 'config'], ['expectedFingerprint']); name(value.name)
      if (own(value, 'expectedFingerprint') && !fingerprint(value.expectedFingerprint)) throw new Error(INVALID)
      return { agentId, action, name: value.name, config: mcpConfig(value.config, true),
        ...(own(value, 'expectedFingerprint') ? { expectedFingerprint: value.expectedFingerprint as string } : {}) }
    }
    throw new Error(INVALID)
  }
  const revision = own(value, 'expectedRevision') ? value.expectedRevision : undefined
  if (own(value, 'expectedRevision') && !fingerprint(revision)) throw new Error(INVALID)
  const base = { agentId, ...(revision !== undefined ? { expectedRevision: revision as string } : {}) }
  if (action === 'mcp-add') {
    keys(value, ['agentId', 'action', 'name', 'transport'], ['scope', 'expectedRevision', 'command', 'args', 'url', 'env', 'headers'])
    name(value.name, true)
    if (own(value, 'scope') && value.scope !== 'user') throw new Error(INVALID)
    const config = mcpConfig(Object.fromEntries(MCP_FIELDS.filter((key) => own(value, key)).map((key) => [key, value[key]])), false) as GrokMcpConfiguration
    return { ...base, action, name: value.name, ...config, ...(own(value, 'scope') ? { scope: 'user' as const } : {}) }
  }
  if (action === 'plugin-install') {
    keys(value, ['agentId', 'action', 'source'], ['expectedRevision']); pluginSource(value.source)
    return { ...base, action, source: value.source }
  }
  if (!['mcp-update', 'mcp-enable', 'mcp-disable', 'mcp-remove', 'plugin-enable', 'plugin-disable', 'plugin-uninstall', 'plugin-update'].includes(action)) throw new Error(INVALID)
  keys(value, ['agentId', 'action', 'id', 'expectedFingerprint', ...(action === 'mcp-update' ? ['transport'] : [])],
    ['expectedRevision', ...(action === 'mcp-update' ? ['command', 'args', 'url', 'env', 'headers'] : [])])
  id(value.id, agentId, action.startsWith('mcp-') ? 'mcp' : 'plugin')
  if (!fingerprint(value.expectedFingerprint)) throw new Error(INVALID)
  const entry = { ...base, id: value.id, expectedFingerprint: value.expectedFingerprint }
  if (action === 'mcp-update') return { ...entry, action,
    ...mcpConfig(Object.fromEntries(MCP_FIELDS.filter((key) => own(value, key)).map((key) => [key, value[key]])), false, true) as GrokMcpConfiguration }
  return { ...entry, action: action as 'mcp-enable' | 'mcp-disable' | 'mcp-remove' | 'plugin-enable' | 'plugin-disable' | 'plugin-uninstall' | 'plugin-update' }
}

const SAFE_ERRORS: Record<string, BetaCapabilityManageErrorCode> = {
  [INVALID]: INVALID,
  kimi_invalid_request: INVALID, grok_inventory_request_invalid: INVALID,
  kimi_stale_inventory: 'capability_inventory_stale', grok_inventory_stale: 'capability_inventory_stale',
  kimi_read_only: 'capability_inventory_read_only', grok_inventory_readonly: 'capability_inventory_read_only',
  kimi_already_exists: 'capability_inventory_already_exists', grok_inventory_already_exists: 'capability_inventory_already_exists',
  kimi_invalid_skill: 'capability_inventory_invalid_config', kimi_invalid_mcp: 'capability_inventory_invalid_config',
  grok_inventory_invalid: 'capability_inventory_invalid_config', kimi_unsafe_path: 'capability_inventory_unsafe_path',
  grok_inventory_mcp_update_unsupported: 'capability_inventory_action_unsupported', grok_inventory_multi_plugin: 'capability_inventory_action_unsupported',
  grok_inventory_ambiguous: 'capability_inventory_read_only', atomic_fs_unavailable: 'atomic_fs_unavailable',
  atomic_fs_parent_changed: 'capability_inventory_unsafe_path', atomic_fs_identity_mismatch: 'capability_inventory_stale',
  atomic_fs_destination_exists: 'capability_inventory_already_exists', atomic_fs_source_not_found: 'capability_inventory_stale'
}

/** Main owns home/cwd/bin; renderer IDs are resolved only through current inventories. */
export async function manageBetaCapabilityInventory(value: unknown, options: BetaCapabilityManagementOptions): Promise<BetaCapabilityManageResult> {
  try {
    const request = parseBetaCapabilityManageRequest(value)
    const env = { ...process.env, ...options.env, HOME: options.home }
    if (request.agentId === 'kimi') {
      const kimiOptions = { home: options.home, cwd: options.cwd, env }
      if (request.action === 'skill-create') await createKimiSkill(request, kimiOptions)
      else if (request.action === 'skill-update') await updateKimiSkill(request, kimiOptions)
      else if (request.action === 'skill-delete' || request.action === 'mcp-delete') await deleteKimiCapability(request, kimiOptions)
      else if (request.action === 'mcp-enable' || request.action === 'mcp-disable') await setKimiMcpEnabled({ id: request.id, expectedFingerprint: request.expectedFingerprint, enabled: request.action === 'mcp-enable' }, kimiOptions)
      else if (request.action === 'mcp-upsert') await upsertKimiMcp(request, kimiOptions)
      else throw new Error(INVALID)
      return await inspectKimiInventory(kimiOptions)
    }
    const bin = options.grokBin ?? 'grok', grokOptions = { cwd: options.cwd, env, runner: options.grokRunner }
    const current = await grokInventoryFromOptions(bin, grokOptions)
    if (!current.available || current.status === 'unsupported') throw new Error('capability_inventory_unavailable')
    if (current.status === 'invalid') throw new Error('grok_inventory_invalid')
    if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) throw new Error('grok_inventory_stale')
    if ('id' in request) {
      const entry = current.items.find((item) => item.id === request.id)
      if (!entry || !entry.manageable) throw new Error('grok_inventory_readonly')
      if (entry.fingerprint !== request.expectedFingerprint) throw new Error('grok_inventory_stale')
    }
    const { agentId: _agentId, ...native } = request
    const { expectedFingerprint: _fingerprint, ...nativeRequest } = native as typeof native & { expectedFingerprint?: string }
    return await manageGrokInventory(bin, { ...nativeRequest, expectedRevision: current.revision } as GrokInventoryManageRequest, grokOptions)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const code = message === 'capability_inventory_unavailable' ? message : own(SAFE_ERRORS, message) ? SAFE_ERRORS[message] : 'capability_inventory_manage_failed'
    throw new Error(code)
  }
}
