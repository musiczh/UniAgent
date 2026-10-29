import { createHash } from 'node:crypto'
import type {
  AgentsStrategy,
  CapabilityBlockCode,
  CapabilityIssueCode,
  CapabilityKind,
  CapabilityResolution,
  CapabilitySyncMode,
  CapabilitySyncPlan,
  PublicCapabilityItem,
  PublicPlannedOperation
} from '../../shared/capabilitySync.ts'

export interface CanonicalCapability {
  id: string
  kind: CapabilityKind
  name: string
  owner: 'user' | 'shared' | 'plugin' | 'system'
  fingerprint: string
  compatible: boolean
  /** Top-level Skill symlink: removable as a directory entry, never sync-compatible. */
  linked?: boolean
  issueCode?: CapabilityIssueCode
  /** Internal only. Never put these paths or names in renderer DTOs. */
  secretShape?: string[]
  privateRef: string
  privateKey?: string
}

export interface Inventory {
  revision: string
  items: CanonicalCapability[]
  layoutKnown: boolean
}

export const semanticHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const CAPABILITY_KINDS = new Set<CapabilityKind>(['skill', 'mcp', 'memory', 'global-instructions', 'global-preference'])

export function diffInventories(source: Inventory, target: Inventory): PublicCapabilityItem[] {
  const src = new Map(source.items.map((item) => [item.id, item]))
  const dst = new Map(target.items.map((item) => [item.id, item]))
  return [...new Set([...src.keys(), ...dst.keys()])].sort().map((id) => {
    const a = src.get(id)
    const b = dst.get(id)
    const base = a || b!
    // Valid Skill links are present and removable, but never comparable or copyable.
    // Invalid links retain their issue while remaining removable from the inventory.
    const linked = a?.linked === true || b?.linked === true
    const sourceInvalid = a?.compatible === false && (!a.linked || !!a.issueCode)
    const targetInvalid = b?.compatible === false && (!b.linked || !!b.issueCode)
    const unsafe = sourceInvalid || targetInvalid
    const status = unsafe
      ? (sourceInvalid ? 'incompatible' : 'invalid')
      : !a
        ? 'target-only'
        : !b
          ? 'add'
          : linked || a.fingerprint === b.fingerprint
            ? 'same'
            : a.kind === 'global-preference'
              ? 'update'
              : 'conflict'
    const selectable = !!a && !unsafe && !linked && status !== 'same'
    return {
      id,
      kind: base.kind,
      name: base.name,
      status,
      compatible: !unsafe,
      selectable,
      cloneSafe: !unsafe && !linked,
      defaultSelected: status === 'add' && selectable,
      issueCode: a?.issueCode || b?.issueCode
    }
  })
}

export function buildPlan(input: {
  id: string
  scanId: string
  source: 'codex' | 'traex'
  target: 'codex' | 'traex'
  sourceRevision: string
  targetRevision: string
  mode: CapabilitySyncMode
  cloneCategories: CapabilityKind[]
  items: PublicCapabilityItem[]
  selections: string[]
  resolutions: Record<string, CapabilityResolution>
  agentsStrategy?: AgentsStrategy
  agentsMergeConflict?: boolean
}): CapabilitySyncPlan {
  const byId = new Map(input.items.map((item) => [item.id, item]))
  const selected = new Set(input.selections)
  const cloneCategories = new Set(input.cloneCategories)
  const blockedReasons: CapabilityBlockCode[] = []
  for (const id of selected) if (!byId.get(id)?.selectable) blockedReasons.push('invalid_selection')
  for (const [id, resolution] of Object.entries(input.resolutions)) {
    const item = byId.get(id)
    if (!selected.has(id) || !item || item.status !== 'conflict' || item.kind === 'global-instructions' ||
        (resolution === 'merge' && item.kind !== 'memory')) blockedReasons.push('invalid_selection')
  }

  if (cloneCategories.size !== input.cloneCategories.length ||
      input.cloneCategories.some((kind) => !CAPABILITY_KINDS.has(kind)) ||
      ((input.mode === 'merge' || input.mode === 'remove-selected') && cloneCategories.size > 0) ||
      (input.mode === 'clone-supported-scope' && cloneCategories.size === 0)) {
    blockedReasons.push('invalid_selection')
  }
  if (input.mode === 'clone-supported-scope') {
    for (const id of selected) {
      const item = byId.get(id)
      if (item && !cloneCategories.has(item.kind)) blockedReasons.push('invalid_selection')
    }
    for (const kind of cloneCategories) {
      const members = input.items.filter((item) => item.kind === kind)
      // A scan has no item for a category absent on both sides. It is a valid
      // explicit no-op scope; this also lets the UI expose a fixed closed list
      // instead of inferring clone intent from renderer-visible contents.
      if (members.some((item) => item.cloneSafe === false || (!item.selectable && item.status !== 'same' && item.status !== 'target-only'))) {
        blockedReasons.push('clone_category_unsafe')
      }
      if (members.some((item) => item.selectable && item.status !== 'target-only' && !selected.has(item.id))) {
        blockedReasons.push('clone_requires_complete_category')
      }
      // Keeping/skipping a conflict (or structurally merging a memory) would
      // make the result a merge, not an exact clone of the selected category.
      if (members.some((item) => item.status === 'conflict' && item.kind !== 'global-instructions' &&
          selected.has(item.id) && input.resolutions[item.id] != null && input.resolutions[item.id] !== 'source')) {
        blockedReasons.push('clone_requires_complete_category')
      }
    }
  }

  const agentsSelected = selected.has('global-instructions:agents')
  if (input.agentsStrategy && !agentsSelected) blockedReasons.push('invalid_selection')
  if (agentsSelected && !input.agentsStrategy) blockedReasons.push('agents_strategy_required')
  if (agentsSelected && input.agentsStrategy === 'merge' && input.agentsMergeConflict) blockedReasons.push('agents_merge_conflict')

  for (const item of input.items) {
    if (!selected.has(item.id)) continue
    if (item.issueCode === 'credential_required') blockedReasons.push('credential_required')
    if (item.status === 'conflict' && item.kind !== 'global-instructions') {
      const resolution = input.resolutions[item.id]
      if (!resolution) blockedReasons.push('resolution_required')
      else if (resolution === 'merge' && item.kind !== 'memory') blockedReasons.push('invalid_selection')
    }
  }

  // A clone plan is all-or-nothing for deletion: any category blocker yields
  // zero delete operations, even if another category would otherwise be safe.
  const cloneCanDelete = input.mode === 'clone-supported-scope' && blockedReasons.length === 0
  const selectedCanDelete = input.mode === 'remove-selected' && blockedReasons.length === 0
  const operations: PublicPlannedOperation[] = input.items.map((item) => {
    let action: PublicPlannedOperation['action'] = 'skip'
    if (item.kind === 'global-instructions' && selected.has(item.id) && input.agentsStrategy) action = 'share'
    else if (item.status === 'same') action = 'noop'
    else if (item.status === 'target-only') action = (cloneCanDelete && cloneCategories.has(item.kind)) || (selectedCanDelete && selected.has(item.id)) ? 'delete' : 'noop'
    else if (selected.has(item.id) && item.selectable) {
      const resolution = item.status === 'conflict' ? input.resolutions[item.id] : undefined
      action = resolution === 'target' || resolution === 'skip' ? 'skip' : 'write'
    }
    return {
      itemId: item.id,
      kind: item.kind,
      name: item.name,
      action,
      destructive: action === 'delete' || action === 'share' || (action === 'write' && item.status === 'conflict'),
      // No native provider reload is performed by this implementation.
      verification: 'V1',
      issueCode: item.issueCode
    }
  })
  const destructiveCount = operations.filter((operation) => operation.destructive).length
  return {
    id: input.id,
    scanId: input.scanId,
    source: input.source,
    target: input.target,
    sourceRevision: input.sourceRevision,
    targetRevision: input.targetRevision,
    mode: input.mode,
    operations,
    destructiveCount,
    requiresConfirmation: input.mode === 'clone-supported-scope' || input.mode === 'remove-selected' || operations.some((operation) => operation.action === 'share'),
    blockedReasons: [...new Set(blockedReasons)],
    agentsStrategy: input.agentsStrategy
  }
}
