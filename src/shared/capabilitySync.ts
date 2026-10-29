export type CapabilityProviderId = 'codex' | 'traex'
export type CapabilityAgentId = CapabilityProviderId | 'claude' | 'grok' | 'kimi' | 'deepseek' | 'mcode' | 'nika' | 'zcode'
export type CapabilityInventoryKind = CapabilityKind | 'plugin' | 'command' | 'tool' | 'hook' | 'agent-profile'
export type CapabilityScope = 'agent' | 'shared' | 'plugin' | 'builtin'
export type CapabilityOwner = 'user' | 'shared' | 'plugin' | 'system'
export type CapabilityInventoryStatus = 'available' | 'invalid' | 'unsupported' | 'shadowed'
export type CapabilityKind =
  | 'skill'
  | 'mcp'
  | 'memory'
  | 'global-instructions'
  | 'global-preference'
export type CapabilityDiffStatus =
  | 'same'
  | 'add'
  | 'update'
  | 'conflict'
  | 'target-only'
  | 'incompatible'
  | 'invalid'
export type CapabilityResolution = 'target' | 'source' | 'merge' | 'skip'
export type CapabilitySyncMode = 'merge' | 'clone-supported-scope' | 'remove-selected'
export type AgentsStrategy = 'keep-codex' | 'keep-traex' | 'keep-shared' | 'merge'

/** Renderer-visible issue values are deliberately closed and contain no paths or user data. */
export type CapabilityIssueCode =
  | 'unsafe_skill_root'
  | 'unsafe_skill_entry'
  | 'invalid_skill_permissions'
  | 'skill_file_too_large'
  | 'duplicate_capability'
  | 'unsafe_config_path'
  | 'invalid_toml'
  | 'invalid_mcp_schema'
  | 'credential_required'
  | 'unsafe_memory_path'
  | 'unsafe_agents_path'
  | 'shared_source_conflict'
  | 'agents_merge_conflict'
  | 'shadowed_capability'
  | 'unsupported_provider_layout'
  | 'plugin_enumeration_failed'
  | 'plugin_manifest_invalid'
  | 'plugin_target_incompatible'
  | 'plugin_install_failed'
  | 'plugin_uninstall_failed'
  | 'grok_inventory_invalid'

export type CapabilityBlockCode =
  | 'unsupported_provider_layout'
  | 'atomic_fs_unavailable'
  | 'recovery_required'
  | 'clone_category_unsafe'
  | 'clone_requires_complete_category'
  | 'agents_strategy_required'
  | 'agents_merge_conflict'
  | 'resolution_required'
  | 'credential_required'
  | 'invalid_selection'

export type CapabilityJobState =
  | 'idle' | 'scanning' | 'scanned' | 'planning' | 'ready' | 'blocked'
  | 'backing_up' | 'staging' | 'committing' | 'verifying' | 'completed'
  | 'failed_no_change' | 'rolling_back' | 'rolled_back' | 'rollback_failed' | 'cancelled'

export type CapabilityJobErrorCode =
  | 'cancelled'
  | 'stale_plan'
  | 'backup_failed'
  | 'stage_failed'
  | 'stage_validation_failed'
  | 'commit_failed'
  | 'verification_failed'
  | 'startup_recovery'
  | 'rollback_failed'
  | 'atomic_fs_unavailable'
  | 'internal_error'

const JOB_STATES: CapabilityJobState[] = [
  'idle', 'scanning', 'scanned', 'planning', 'ready', 'blocked', 'backing_up', 'staging',
  'committing', 'verifying', 'completed', 'failed_no_change', 'rolling_back', 'rolled_back',
  'rollback_failed', 'cancelled'
]
const JOB_ERRORS: CapabilityJobErrorCode[] = [
  'cancelled', 'stale_plan', 'backup_failed', 'stage_failed', 'stage_validation_failed',
  'commit_failed', 'verification_failed', 'startup_recovery', 'rollback_failed', 'atomic_fs_unavailable', 'internal_error'
]

export interface CapabilityScanRequest {
  source: CapabilityProviderId
  target: CapabilityProviderId
}

/** Safe renderer DTO: contains no path, source text, command, environment value, or secret. */
export interface PublicCapabilityItem {
  id: string
  kind: CapabilityKind
  name: string
  status: CapabilityDiffStatus
  compatible: boolean
  selectable: boolean
  /** False means clone mode must not delete anything in this item's category. */
  cloneSafe: boolean
  defaultSelected: boolean
  issueCode?: CapabilityIssueCode
}

export interface CapabilityScanResult {
  id: string
  source: CapabilityProviderId
  target: CapabilityProviderId
  sourceRevision: string
  targetRevision: string
  scannedAt: number
  sourceAvailable: boolean
  targetAvailable: boolean
  executionSupported: boolean
  blockedReason?: CapabilityBlockCode
  items: PublicCapabilityItem[]
}

export interface CapabilityPlanRequest {
  scanId: string
  mode: CapabilitySyncMode
  /** Closed, public category scope selected explicitly for clone mode. */
  cloneCategories: CapabilityKind[]
  selections: string[]
  resolutions: Record<string, CapabilityResolution>
  agentsStrategy?: AgentsStrategy
}

export interface PublicPlannedOperation {
  itemId: string
  kind: CapabilityKind
  name: string
  action: 'noop' | 'write' | 'delete' | 'share' | 'skip'
  destructive: boolean
  /** V1 is static validation. V2 is reserved for a future native-provider reload check. */
  verification: 'V1' | 'V2'
  issueCode?: CapabilityIssueCode
}

export interface CapabilitySyncPlan {
  id: string
  scanId: string
  source: CapabilityProviderId
  target: CapabilityProviderId
  sourceRevision: string
  targetRevision: string
  mode: CapabilitySyncMode
  operations: PublicPlannedOperation[]
  destructiveCount: number
  requiresConfirmation: boolean
  blockedReasons: CapabilityBlockCode[]
  agentsStrategy?: AgentsStrategy
}

export interface CapabilityExecuteRequest {
  planId: string
  expectedSourceRevision: string
  expectedTargetRevision: string
  confirmation?: { acknowledged: boolean; targetName?: string; deleteCount?: number }
}

export interface CapabilityInventoryItem {
  /** Opaque renderer identity. It is never interpreted as a filesystem path. */
  id: string
  agentId: CapabilityAgentId
  kind: CapabilityInventoryKind
  name: string
  scope: CapabilityScope
  origin: string
  owner: CapabilityOwner
  fingerprint: string
  manageable: boolean
  copyable: boolean
  /** Discovery may resolve the target; deletion only unlinks the entry. */
  linked?: boolean
  /** Agents whose Skill symlinks currently resolve to this shared Skill. */
  dependentAgents?: CapabilityAgentId[]
  /** Absolute on-disk folder for a Skill/Plugin. Shown in the card; single-user Mac only. */
  location?: string
  /** Logical discovery entry, kept separate from the resolved source. */
  entryPath?: string
  manifestPath?: string
  /** File operations resolve the opaque ID again and never follow a link for deletion. */
  removal?: 'skill' | 'link'
  readOnlyReason?: string
  status: CapabilityInventoryStatus
  issueCode?: CapabilityIssueCode
  source?: string
  plugin?: string
  version?: string
  enabled?: boolean
  pluginId?: string
  marketplace?: string
  cachedVersions?: number
  components?: CapabilityPluginComponents
  migratableTo?: CapabilityAgentId[]
}

export interface CapabilityPluginComponents {
  skills: number
  mcps: number
  hooks: number
  apps: number
  models: number
  commands: number
}

export interface CapabilityPluginActionRequest {
  id: string
  action: 'migrate' | 'uninstall'
  targetAgentId?: CapabilityAgentId
}

export interface CapabilityPluginActionResult {
  action: 'migrate' | 'uninstall'
  sourceAgentId: CapabilityAgentId
  targetAgentId?: CapabilityAgentId
  pluginId: string
}

export interface CapabilityAgentInventory {
  agentId: CapabilityAgentId
  agentName?: string
  readSources?: { path: string; kind: 'skill' | 'plugin' | 'config' | 'native'; status: 'read' | 'missing' | 'error' }[]
  message?: string
  available: boolean
  writable: boolean
  /** Provider-native management availability, including installing the first user plugin. */
  managementSupported?: boolean
  status: CapabilityInventoryStatus
  issueCode?: CapabilityIssueCode
  revision: string
  items: CapabilityInventoryItem[]
}

export interface CapabilityInventoryResult { inventories: CapabilityAgentInventory[]; scannedAt: number }

/** Request full detail for one opaque inventory item id. */
export interface CapabilityInventoryDetailRequest { id: string }

/** A single file inside a Skill folder, described without leaking its absolute path. */
export interface CapabilityDetailFile {
  /** Path relative to the Skill folder root, using forward slashes. */
  relativePath: string
  /** Byte size of the file, or omitted when unavailable. */
  size?: number
  /** True when this entry is a directory. */
  directory?: boolean
}

/**
 * Detail payload for one capability. The renderer receives the rendered
 * SKILL.md text and a shallow file listing plus a boolean telling it whether an
 * in-app file browser can be opened. The absolute folder path is only exposed
 * so the renderer can hand it straight back to the file-browser IPC as a root;
 * it is never interpreted or reconstructed on the renderer side.
 */
export interface CapabilityInventoryDetail {
  id: string
  name: string
  kind: CapabilityInventoryKind
  /** SKILL.md (or manifest) text when available. */
  manifestText?: string
  /** File name of the manifest relative to the folder, e.g. SKILL.md. */
  manifestFile?: string
  /** Shallow listing of the Skill folder, when this capability is a folder. */
  files?: CapabilityDetailFile[]
  /** Absolute Skill folder path, present only when a folder can be browsed. */
  folderPath?: string
  /** Whether the renderer may open folderPath in the in-app file browser. */
  openable: boolean
}

/** Prepare a normal sync scan from opaque capability-center inventory ids. */
export interface CapabilityInventorySyncRequest {
  source: CapabilityProviderId
  target: CapabilityProviderId
  selections: string[]
}

export interface CapabilityInventorySyncPreparation {
  scan: CapabilityScanResult
  /** Canonical scan item ids corresponding only to requested, selectable items. */
  selections: string[]
}

export interface CapabilityMutationPlanRequest {
  mode: 'add-selected' | 'remove-selected'
  source?: CapabilityProviderId
  target: CapabilityProviderId
  selections: string[]
  resolutions?: Record<string, CapabilityResolution>
}
export interface CapabilityCancelRequest { jobId: string }

export interface CapabilityJobResult {
  /** Static V1 checks completed. This never implies native V2 validation. */
  verified: number
  noop: number
  skipped: number
  manualRequired: number
  failed: number
  rolledBack: number
  residualDifferences: number
}

export interface CapabilitySyncJob {
  id: string
  planId: string
  operation?: 'sync' | 'remove-selected'
  transactionId?: string
  state: CapabilityJobState
  stage?: string
  progress?: { completed: number; total: number }
  errorCode?: CapabilityJobErrorCode
  result?: CapabilityJobResult
  updatedAt: number
}

/**
 * The single completed transaction that the main process currently permits the
 * renderer to roll back. This deliberately remains a job-shaped public DTO:
 * it carries no journal paths, backup names, configuration text, or secrets.
 */
export type CapabilityRollbackCandidate = Omit<
  CapabilitySyncJob,
  'state' | 'transactionId'
> & {
  state: 'completed'
  transactionId: string
}

export interface CapabilityJobSnapshot {
  active?: CapabilitySyncJob
  latest?: CapabilitySyncJob
  rollbackCandidate?: CapabilityRollbackCandidate
}

/** Preview is AGENTS-only and exposes only the selected final merged value. */
export interface CapabilityMarkdownPreview {
  itemId: 'global-instructions:agents'
  lineCount: number
  headingCount: number
  byteCount: number
}

const providers = new Set(['codex', 'traex'])
const agents = new Set<CapabilityAgentId>(['codex', 'traex', 'claude'])
const modes = new Set(['merge', 'clone-supported-scope', 'remove-selected'])
const capabilityKinds = new Set<CapabilityKind>(['skill', 'mcp', 'memory', 'global-instructions', 'global-preference'])
const resolutions = new Set(['target', 'source', 'merge', 'skip'])
const strategies = new Set(['keep-codex', 'keep-traex', 'keep-shared', 'merge'])
const record = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const prototype = Object.getPrototypeOf(v)
  return prototype === Object.prototype || prototype === null
}
const bounded = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const exactKeys = (v: Record<string, unknown>, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(v)
  return required.every((key) => Object.prototype.hasOwnProperty.call(v, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function parseCapabilityScanRequest(v: unknown): CapabilityScanRequest {
  if (!record(v) || !exactKeys(v, ['source', 'target']) || !providers.has(String(v.source)) || !providers.has(String(v.target)) || v.source === v.target) {
    throw new Error('invalid_capability_scan_request')
  }
  return { source: v.source as CapabilityProviderId, target: v.target as CapabilityProviderId }
}

export function parseCapabilityInventorySyncRequest(v: unknown): CapabilityInventorySyncRequest {
  const selectionSet = record(v) && Array.isArray(v.selections) ? new Set(v.selections) : new Set()
  if (!record(v) || !exactKeys(v, ['source', 'target', 'selections']) ||
      !providers.has(String(v.source)) || !providers.has(String(v.target)) || v.source === v.target ||
      !Array.isArray(v.selections) || v.selections.length === 0 || v.selections.length > 1000 ||
      selectionSet.size !== v.selections.length || !v.selections.every((id) => bounded(id))) {
    throw new Error('invalid_capability_inventory_sync_request')
  }
  return {
    source: v.source as CapabilityProviderId,
    target: v.target as CapabilityProviderId,
    selections: [...v.selections] as string[]
  }
}

export function parseCapabilityPluginActionRequest(v: unknown): CapabilityPluginActionRequest {
  if (!record(v) || !exactKeys(v, ['id', 'action'], ['targetAgentId']) || !bounded(v.id, 512) ||
      !['migrate', 'uninstall'].includes(String(v.action)) ||
      (v.action === 'migrate' && !agents.has(v.targetAgentId as CapabilityAgentId)) ||
      (v.action === 'uninstall' && Object.prototype.hasOwnProperty.call(v, 'targetAgentId'))) throw new Error('invalid_capability_plugin_action')
  return { id: v.id, action: v.action as CapabilityPluginActionRequest['action'], targetAgentId: v.targetAgentId as CapabilityAgentId | undefined }
}

export function parseCapabilityPlanRequest(v: unknown): CapabilityPlanRequest {
  const selectionSet = record(v) && Array.isArray(v.selections) ? new Set(v.selections) : new Set()
  const categorySet = record(v) && Array.isArray(v.cloneCategories) ? new Set(v.cloneCategories) : new Set()
  if (!record(v) || !exactKeys(v, ['scanId', 'mode', 'cloneCategories', 'selections', 'resolutions'], ['agentsStrategy']) || !isUuid(v.scanId) || !modes.has(String(v.mode)) ||
      !Array.isArray(v.cloneCategories) || v.cloneCategories.length > capabilityKinds.size || categorySet.size !== v.cloneCategories.length ||
      !v.cloneCategories.every((kind) => capabilityKinds.has(kind as CapabilityKind)) ||
      ((v.mode === 'merge' || v.mode === 'remove-selected') && v.cloneCategories.length !== 0) ||
      (v.mode === 'clone-supported-scope' && v.cloneCategories.length === 0) ||
      !Array.isArray(v.selections) || v.selections.length > 1000 || selectionSet.size !== v.selections.length ||
      !v.selections.every((x) => bounded(x)) || !record(v.resolutions) || Object.keys(v.resolutions).length > 1000 ||
      Object.entries(v.resolutions).some(([key, value]) => !bounded(key) || !resolutions.has(String(value))) ||
      (v.agentsStrategy != null && !strategies.has(String(v.agentsStrategy)))) {
    throw new Error('invalid_capability_plan_request')
  }
  return {
    scanId: v.scanId,
    mode: v.mode as CapabilitySyncMode,
    cloneCategories: [...v.cloneCategories] as CapabilityKind[],
    selections: [...v.selections] as string[],
    resolutions: { ...v.resolutions } as Record<string, CapabilityResolution>,
    agentsStrategy: v.agentsStrategy as AgentsStrategy | undefined
  }
}

export function parseCapabilityExecuteRequest(v: unknown): CapabilityExecuteRequest {
  if (!record(v) || !exactKeys(v, ['planId', 'expectedSourceRevision', 'expectedTargetRevision'], ['confirmation']) ||
      !isUuid(v.planId) || !revision(v.expectedSourceRevision) || !revision(v.expectedTargetRevision) ||
      (v.confirmation != null && (!record(v.confirmation) || !exactKeys(v.confirmation, ['acknowledged'], ['targetName', 'deleteCount']) || typeof v.confirmation.acknowledged !== 'boolean' ||
       (v.confirmation.targetName != null && !providers.has(String(v.confirmation.targetName))) ||
       (v.confirmation.deleteCount != null && (!Number.isSafeInteger(v.confirmation.deleteCount) || (v.confirmation.deleteCount as number) < 0))))) {
    throw new Error('invalid_capability_execute_request')
  }
  return {
    planId: v.planId,
    expectedSourceRevision: v.expectedSourceRevision,
    expectedTargetRevision: v.expectedTargetRevision,
    confirmation: v.confirmation as CapabilityExecuteRequest['confirmation']
  }
}

export function parseCapabilityPreviewRequest(scanId: unknown, itemId: unknown, strategy: unknown): { scanId: string; itemId: 'global-instructions:agents'; strategy: AgentsStrategy } {
  if (!isUuid(scanId) || itemId !== 'global-instructions:agents' || !strategies.has(String(strategy))) throw new Error('invalid_preview_request')
  return { scanId, itemId, strategy: strategy as AgentsStrategy }
}

/** Defense in depth for persisted jobs before they cross the IPC boundary. */
export function isPublicCapabilityJob(value: unknown): value is CapabilitySyncJob {
  if (!record(value) || !exactKeys(value, ['id', 'planId', 'state', 'updatedAt'], ['operation', 'transactionId', 'stage', 'progress', 'errorCode', 'result']) ||
      !isUuid(value.id) || !bounded(value.planId) || !JOB_STATES.includes(value.state as CapabilityJobState) ||
      typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
      (value.operation != null && !['sync', 'remove-selected'].includes(String(value.operation))) ||
      (value.transactionId != null && !isUuid(value.transactionId)) ||
      (value.stage != null && !bounded(value.stage, 100)) ||
      (value.errorCode != null && !JOB_ERRORS.includes(value.errorCode as CapabilityJobErrorCode))) return false
  if (value.progress != null) {
    if (!record(value.progress)) return false
    const progress = value.progress
    if (!exactKeys(progress, ['completed', 'total']) ||
        !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total) ||
        (progress.completed as number) < 0 || (progress.total as number) < 0 || (progress.completed as number) > (progress.total as number)) return false
  }
  if (value.result != null) {
    const keys = ['verified', 'noop', 'skipped', 'manualRequired', 'failed', 'rolledBack', 'residualDifferences']
    if (!record(value.result)) return false
    const result = value.result
    if (!exactKeys(result, keys) || keys.some((key) => !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)) return false
  }
  return true
}

/** Runtime counterpart of CapabilityRollbackCandidate for IPC boundary checks. */
export function isPublicCapabilityRollbackCandidate(
  value: unknown
): value is CapabilityRollbackCandidate {
  return isPublicCapabilityJob(value) && value.state === 'completed' && isUuid(value.transactionId)
}

export interface BetaCapabilityMcpConfiguration {
  transport?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
  auth?: 'oauth'
  executor?: 'local' | 'kaos'
  enabled?: boolean
  deferred?: boolean
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  enabledTools?: string[]
  disabledTools?: string[]
}
export type BetaCapabilityGrokMcpConfiguration = Pick<BetaCapabilityMcpConfiguration,
  'command' | 'args' | 'url'> & { transport: 'stdio' | 'http' | 'sse'; env?: Record<string, string> | '[redacted]'; headers?: Record<string, string> | '[redacted]' }

/** Main supplies filesystem roots and binaries; existing items require their current fingerprint. */
export type BetaCapabilityManageRequest =
  | { agentId: 'kimi'; action: 'skill-create'; name: string; manifestText: string }
  | { agentId: 'kimi'; action: 'skill-update'; id: string; expectedFingerprint: string; manifestText: string }
  | { agentId: 'kimi'; action: 'skill-delete' | 'mcp-delete'; id: string; expectedFingerprint: string }
  | { agentId: 'kimi'; action: 'mcp-enable' | 'mcp-disable'; id: string; expectedFingerprint: string }
  | { agentId: 'kimi'; action: 'mcp-upsert'; name: string; config: BetaCapabilityMcpConfiguration; expectedFingerprint?: string }
  | ({ agentId: 'grok'; action: 'mcp-add'; name: string; scope?: 'user'; expectedRevision?: string } & BetaCapabilityGrokMcpConfiguration)
  | ({ agentId: 'grok'; action: 'mcp-update'; id: string; expectedFingerprint: string; expectedRevision?: string } & BetaCapabilityGrokMcpConfiguration)
  | { agentId: 'grok'; action: 'mcp-enable' | 'mcp-disable' | 'mcp-remove' | 'plugin-enable' | 'plugin-disable' | 'plugin-uninstall' | 'plugin-update'; id: string; expectedFingerprint: string; expectedRevision?: string }
  | { agentId: 'grok'; action: 'plugin-install'; source: string; expectedRevision?: string }

export type BetaCapabilityManageResult = CapabilityAgentInventory
export type BetaCapabilityManageErrorCode =
  | 'invalid_capability_inventory_manage_request'
  | 'capability_inventory_stale'
  | 'capability_inventory_read_only'
  | 'capability_inventory_already_exists'
  | 'capability_inventory_invalid_config'
  | 'capability_inventory_unsafe_path'
  | 'capability_inventory_action_unsupported'
  | 'capability_inventory_unavailable'
  | 'capability_inventory_manage_failed'
  | 'atomic_fs_unavailable'

export type DeepSeekCapabilityManageRequest =
  | { agentId: 'deepseek'; action: 'plugin-install'; spec: string }
  | { agentId: 'deepseek'; action: 'plugin-update'; id: string; expectedFingerprint: string; spec?: string }
  | { agentId: 'deepseek'; action: 'plugin-enable' | 'plugin-disable' | 'plugin-remove'; id: string; expectedFingerprint: string }
export type DeepSeekCapabilityManageResult = CapabilityAgentInventory

export type CapabilityInventoryManageRequest = BetaCapabilityManageRequest | DeepSeekCapabilityManageRequest
  | { agentId: 'mcode'; action: 'plugin-uninstall'; id: string; expectedFingerprint: string }
  | { agentId: 'kimi'; action: 'plugin-uninstall'; id: string; expectedFingerprint: string }
  | { agentId: 'zcode'; action: 'plugin-uninstall'; id: string; expectedFingerprint: string }
export type CapabilityInventoryManageResult = CapabilityAgentInventory

/** Public registry specs only; local files, alternate registries and credentials never cross this mutation boundary. */
export function parseDeepSeekCapabilityManageRequest(value: unknown): DeepSeekCapabilityManageRequest {
  const invalid = () => { throw new Error('invalid_capability_inventory_manage_request') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).some(key =>
    typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return invalid()
  const v = value as Record<string, unknown>
  if (v.agentId !== 'deepseek') return invalid()
  const required = v.action === 'plugin-install' ? ['agentId', 'action', 'spec'] : ['agentId', 'action', 'id', 'expectedFingerprint']
  const optional = v.action === 'plugin-update' ? ['spec'] : []
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) return invalid()
  if (v.action === 'plugin-install') {
    if (typeof v.spec !== 'string' || v.spec.length > 300 ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._-]*)?$/.test(v.spec)) return invalid()
    return { agentId: 'deepseek', action: v.action, spec: v.spec }
  }
  if (!['plugin-enable', 'plugin-disable', 'plugin-remove', 'plugin-update'].includes(String(v.action)) ||
      typeof v.id !== 'string' || !/^deepseek:plugin:[a-f0-9]{24}$/.test(v.id) ||
      typeof v.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.expectedFingerprint)) return invalid()
  if (v.action === 'plugin-update') {
    if (Object.hasOwn(v, 'spec') && (typeof v.spec !== 'string' || v.spec.length > 300 ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(v.spec))) return invalid()
    return { agentId: 'deepseek', action: v.action, id: v.id, expectedFingerprint: v.expectedFingerprint,
      ...(Object.hasOwn(v, 'spec') ? { spec: v.spec as string } : {}) }
  }
  return { agentId: 'deepseek', action: v.action as 'plugin-enable' | 'plugin-disable' | 'plugin-remove', id: v.id, expectedFingerprint: v.expectedFingerprint }
}
