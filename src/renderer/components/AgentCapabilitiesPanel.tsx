import { INTERNAL_DISTRIBUTION, isDistributionAgent } from '@shared/distribution'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentDef } from '@shared/types'
import type {
  BetaCapabilityMcpConfiguration, CapabilityAgentInventory, CapabilityAgentId, CapabilityDiffStatus, CapabilityInventoryDetail, CapabilityInventoryItem, CapabilityInventoryKind, CapabilityInventoryManageRequest, CapabilityInventoryResult,
  CapabilityInventorySyncRequest, CapabilityIssueCode, CapabilityJobState, CapabilityProviderId,
  CapabilityRollbackCandidate, CapabilityScanResult, CapabilitySyncJob, CapabilitySyncPlan
} from '@shared/capabilitySync'
import { compareCapabilitySyncJobs } from '../capabilitySyncJobOrder'
import { AgentIcon } from './AgentIcon'
import { FileBrowser } from './FileBrowser'
import { RefreshIcon, ToggleSwitch, UiIcon } from './Icons'
import { Markdown } from './Markdown'
import './AgentCapabilitiesPanel.css'

const AGENT_NAMES: Record<CapabilityAgentId, string> = { codex: 'Codex', traex: 'TraeX', claude: 'Claude Code', grok: 'Grok', kimi: 'Kimi Code', deepseek: 'DeepSeek Harness', mcode: 'MiniMax Code', nika: 'Nika', zcode: 'ZCode' }
// 需求3: 对比视图 — diff 状态 → 文案（复用同步页 STATUS 语义，前置到对比视图）。
const COMPARE_STATUS: Record<CapabilityDiffStatus, string> = {
  add: '新增', update: '更新', conflict: '冲突', same: '一致', 'target-only': '仅目标', incompatible: '不兼容', invalid: '无效'
}
// 只读对比（任一侧不是可写 provider）只表达「仅左 / 仅右 / 两侧都有」，不假装能 diff 内容。
const READONLY_STATUS: Partial<Record<CapabilityDiffStatus, string>> = { add: '仅左', 'target-only': '仅右', same: '两侧都有' }
const INVENTORY_KINDS: CapabilityInventoryKind[] = ['skill', 'plugin', 'mcp', 'hook', 'agent-profile']
const COMPARE_KINDS = INVENTORY_KINDS

export function capabilityListItems(items: CapabilityInventoryItem[]): CapabilityInventoryItem[] {
  return items.filter(item => !['command', 'tool', 'global-instructions', 'global-preference'].includes(item.kind))
}

export interface CompareRow {
  id: string
  kind: string
  name: string
  scope?: CapabilityInventoryItem['scope']
  status: CapabilityDiffStatus
  issueCode?: CapabilityIssueCode
  inLeft: boolean
  inRight: boolean
  /** True only for an executable source-only add that maps to a copyable source item. */
  syncSelectable: boolean
  /** Opaque source-inventory id used to route the selection into 现有同步流程. */
  opaque?: string
}
const KIND_NAMES: Record<string, string> = { skill: 'Skill', plugin: 'Plugin', mcp: 'MCP', hook: 'Hook', 'agent-profile': 'Agent', command: '命令', tool: '工具', memory: 'Memory', 'global-instructions': '指令', 'global-preference': '偏好' }
const SCOPE_NAMES: Record<string, string> = { agent: '私有', shared: '共享', plugin: '插件', builtin: '内置' }
const INVENTORY_STATUS_NAMES: Record<CapabilityInventoryItem['status'], string> = {
  available: '可用', invalid: '异常', unsupported: '不支持', shadowed: '已覆盖'
}
const ISSUE_NAMES: Record<CapabilityIssueCode, string> = {
  unsafe_skill_root: 'Skill 根目录不安全或无法读取',
  unsafe_skill_entry: 'Skill 条目不安全、缺少有效文件或无法读取',
  invalid_skill_permissions: 'Skill 文件或目录权限不安全：对组或其他用户可写',
  skill_file_too_large: 'Skill 文件超过允许大小',
  duplicate_capability: '存在重复能力',
  unsafe_config_path: '配置文件路径不安全',
  invalid_toml: '配置文件不是有效的 TOML',
  invalid_mcp_schema: 'MCP 配置结构无效',
  credential_required: '能力依赖本机凭据，无法安全迁移',
  unsafe_memory_path: 'Memory 文件路径不安全',
  unsafe_agents_path: 'AGENTS.md 路径不安全',
  shared_source_conflict: '共享来源存在冲突',
  agents_merge_conflict: 'AGENTS.md 合并冲突',
  shadowed_capability: '同名能力已由更高优先级来源覆盖',
  unsupported_provider_layout: '无法识别 Agent 的能力目录布局',
  plugin_enumeration_failed: 'Agent 原生 CLI 无法枚举插件',
  plugin_manifest_invalid: '插件缺少有效的原生 manifest',
  plugin_target_incompatible: '目标 Agent 无法验证此插件的安装来源',
  plugin_install_failed: '目标 Agent 原生插件安装失败',
  plugin_uninstall_failed: '来源 Agent 原生插件卸载失败',
  grok_inventory_invalid: 'Grok CLI 返回了无效的能力清单'
}
const REMOVAL_BLOCKED: Record<string, string> = {
  recovery_required: '检测到未完成事务，需要先完成恢复。',
  atomic_fs_unavailable: '当前系统缺少安全文件事务组件，无法卸载。',
  unsupported_provider_layout: '无法确认该 Agent 的目录布局，已停止卸载。'
}
const COMPARE_SCOPE_NAMES: Partial<Record<CapabilityInventoryItem['scope'], string>> = { agent: '私有', shared: '共享', plugin: '插件', builtin: '内置' }

function compareRowKey(item: Pick<CapabilityInventoryItem, 'kind' | 'name' | 'scope'>): string {
  const scope = item.kind === 'skill' ? `:${item.scope}` : ''
  return `${item.kind}${scope}:${item.name.toLocaleLowerCase('en-US')}`
}

function inventoryItemInvalid(item: CapabilityInventoryItem | undefined): boolean {
  return item?.status === 'invalid' || item?.status === 'unsupported'
}

function sortCompareRows(rows: CompareRow[]): CompareRow[] {
  const scopeOrder: Partial<Record<CapabilityInventoryItem['scope'], number>> = { shared: 0, agent: 1, plugin: 2, builtin: 3 }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) ||
    (scopeOrder[a.scope || 'agent'] ?? 9) - (scopeOrder[b.scope || 'agent'] ?? 9))
}

function inventoryCompareRows(leftItems: CapabilityInventoryItem[], rightItems: CapabilityInventoryItem[]): CompareRow[] {
  const byKey = new Map<string, CompareRow>()
  for (const item of leftItems.filter((candidate) => COMPARE_KINDS.includes(candidate.kind))) {
    const invalid = inventoryItemInvalid(item)
    byKey.set(compareRowKey(item), {
      id: `L:${item.id}`, kind: item.kind, name: item.name, scope: item.kind === 'skill' ? item.scope : undefined,
      status: invalid ? 'invalid' : 'add', issueCode: invalid ? item.issueCode : undefined,
      inLeft: true, inRight: false, syncSelectable: false
    })
  }
  for (const item of rightItems.filter((candidate) => COMPARE_KINDS.includes(candidate.kind))) {
    const key = compareRowKey(item)
    const invalid = inventoryItemInvalid(item)
    const existing = byKey.get(key)
    if (existing) {
      existing.inRight = true
      if (invalid) { existing.status = 'invalid'; existing.issueCode = item.issueCode }
      else if (existing.status !== 'invalid') existing.status = 'same'
    } else {
      byKey.set(key, {
        id: `R:${item.id}`, kind: item.kind, name: item.name, scope: item.kind === 'skill' ? item.scope : undefined,
        status: invalid ? 'invalid' : 'target-only', issueCode: invalid ? item.issueCode : undefined,
        inLeft: false, inRight: true, syncSelectable: false
      })
    }
  }
  return sortCompareRows([...byKey.values()])
}

export function buildCapabilityCompareRows(
  leftItems: CapabilityInventoryItem[], rightItems: CapabilityInventoryItem[],
  compareScan: CapabilityScanResult | null, writablePair: boolean
): CompareRow[] {
  if (!writablePair) return inventoryCompareRows(leftItems, rightItems)
  if (!compareScan) return []

  const privateLeft = new Map(leftItems.filter((item) => item.kind === 'skill' && item.scope === 'agent').map((item) => [compareRowKey(item), item]))
  const privateRight = new Map(rightItems.filter((item) => item.kind === 'skill' && item.scope === 'agent').map((item) => [compareRowKey(item), item]))
  const rows = compareScan.items.filter(item => COMPARE_KINDS.includes(item.kind)).map<CompareRow>((item) => {
    const key = `skill:agent:${item.name.toLocaleLowerCase('en-US')}`
    const left = item.kind === 'skill' ? privateLeft.get(key) : undefined
    const right = item.kind === 'skill' ? privateRight.get(key) : undefined
    const invalid = inventoryItemInvalid(left) || inventoryItemInvalid(right)
    return {
      id: item.id, kind: item.kind, name: item.name, scope: item.kind === 'skill' ? 'agent' : undefined,
      status: invalid ? 'invalid' : item.status, issueCode: invalid ? left?.issueCode || right?.issueCode : item.issueCode,
      inLeft: item.kind === 'skill' ? !!left : item.status !== 'target-only',
      inRight: item.kind === 'skill' ? !!right : item.status !== 'add',
      syncSelectable: !invalid && item.status === 'add' && item.selectable
    }
  })
  const shared = inventoryCompareRows(
    leftItems.filter((item) => (item.kind === 'skill' && item.scope === 'shared') || item.kind === 'plugin'),
    rightItems.filter((item) => (item.kind === 'skill' && item.scope === 'shared') || item.kind === 'plugin')
  )
  return sortCompareRows([...rows, ...shared])
}

export function compareRowStatusLabel(row: CompareRow, writablePair: boolean): string {
  if (row.kind === 'skill' && row.scope === 'shared' && row.status === 'same') return '两侧共享一致'
  const status = writablePair ? COMPARE_STATUS[row.status] : READONLY_STATUS[row.status] || COMPARE_STATUS[row.status]
  if (row.issueCode) return `${status}：${ISSUE_NAMES[row.issueCode]}`
  return row.status === 'invalid' ? `${status}：扫描结果未提供具体原因` : status
}
const TERMINAL = new Set<CapabilityJobState>(['completed', 'failed_no_change', 'rolled_back', 'rollback_failed', 'cancelled'])
const CANCELLABLE = new Set<CapabilityJobState>(['backing_up', 'staging', 'committing', 'verifying'])
interface JobTracking { jobId?: string; planId?: string; transactionId?: string }
export interface CapabilityLogRow {
  id: string
  agentId: CapabilityAgentId
  kind: string
  name: string
  status: CapabilityInventoryItem['status']
  issueCode?: CapabilityIssueCode
  origin: string
}

export function orderCapabilityItems(items: CapabilityInventoryItem[]): CapabilityInventoryItem[] {
  const kindRank = new Map(INVENTORY_KINDS.map((value, index) => [value, index]))
  const sourceRank: Record<CapabilityInventoryItem['scope'], number> = { agent: 0, shared: 1, plugin: 2, builtin: 3 }
  return [...items].sort((a, b) => (kindRank.get(a.kind) ?? 99) - (kindRank.get(b.kind) ?? 99) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || sourceRank[a.scope] - sourceRank[b.scope] || a.origin.localeCompare(b.origin))
}

export function capabilityLogRows(result: CapabilityInventoryResult | null): CapabilityLogRow[] {
  if (!result) return []
  return result.inventories.flatMap((inventory) => {
    const rows: CapabilityLogRow[] = inventory.items.filter((item) => item.status === 'invalid' || item.status === 'unsupported').map((item) => ({
      id: item.id, agentId: inventory.agentId, kind: item.kind, name: item.name, status: item.status,
      issueCode: item.issueCode, origin: [item.origin, item.source, item.plugin, item.version].filter(Boolean).join(' · ')
    }))
    if (inventory.status !== 'available' && inventory.issueCode && !rows.some((row) => row.issueCode === inventory.issueCode)) {
      rows.unshift({ id: `${inventory.agentId}:inventory`, agentId: inventory.agentId, kind: 'agent', name: AGENT_NAMES[inventory.agentId], status: inventory.status, issueCode: inventory.issueCode, origin: 'Agent 能力目录' })
    }
    return rows
  })
}

function formatCapabilityLog(result: CapabilityInventoryResult, rows: CapabilityLogRow[]): string {
  return [
    '# UniAgent 工具能力排查日志',
    `扫描时间：${new Date(result.scannedAt).toLocaleString()}`,
    `异常数量：${rows.length}`,
    '',
    ...rows.flatMap((row, index) => [
      `[${index + 1}] ${AGENT_NAMES[row.agentId]} / ${KIND_NAMES[row.kind] || row.kind} / ${row.name}`,
      `状态：${INVENTORY_STATUS_NAMES[row.status]}`,
      `原因：${row.issueCode ? ISSUE_NAMES[row.issueCode] : '扫描结果未提供具体原因'}`,
      `错误码：${row.issueCode || 'unknown'}`,
      `来源：${row.origin || '未知'}`,
      ''
    ])
  ].join('\n')
}

function capabilitySubtitle(item: CapabilityInventoryItem): string {
  if (item.kind === 'plugin') return [item.pluginId, item.version && `当前 ${item.version}`, `缓存 ${item.cachedVersions || 0} 个版本`].filter(Boolean).join(' · ')
  return [item.source, item.plugin, item.version].filter((value): value is string => !!value).join(' · ') || item.origin
}

export function canManageCapabilityItem(item: CapabilityInventoryItem, writable: boolean): boolean {
  if (item.removal) return item.manageable
  if (item.agentId === 'mcode' && item.kind === 'plugin') return item.manageable
  if (item.agentId === 'zcode' && item.kind === 'plugin') return item.manageable
  if (item.agentId === 'deepseek' && item.kind === 'plugin') return !!betaCapabilityRemovalRequest(item)
  if (item.agentId === 'kimi' || item.agentId === 'grok') return !!betaCapabilityRemovalRequest(item) && writable
  return item.manageable && (item.kind === 'plugin' || item.scope === 'shared' || writable || !!item.linked)
}

export function usesDirectCapabilityRemoval(item: CapabilityInventoryItem): boolean {
  return !!item.removal || !!betaCapabilityRemovalRequest(item) || !!item.linked || item.scope === 'shared'
}

export function capabilityRemovalLabel(item: CapabilityInventoryItem): string {
  return item.linked ? '移除链接' : item.kind === 'skill' ? '删除' : '卸载此能力'
}

export function capabilityOwningPlugin(item: CapabilityInventoryItem, items: CapabilityInventoryItem[]): CapabilityInventoryItem | undefined {
  return item.scope === 'plugin' && item.kind !== 'plugin' && item.plugin
    ? items.find(candidate => candidate.agentId === item.agentId && candidate.kind === 'plugin' && candidate.pluginId === item.plugin) : undefined
}

export function betaCapabilityRemovalRequest(item: CapabilityInventoryItem): Extract<CapabilityInventoryManageRequest, { id: string }> | undefined {
  if (item.removal) return undefined
  if (!item.manageable || item.linked || item.status === 'invalid' || item.status === 'unsupported') return undefined
  if (item.agentId === 'mcode' && item.kind === 'plugin') return { agentId: 'mcode', action: 'plugin-uninstall', id: item.id, expectedFingerprint: item.fingerprint }
  if (item.agentId === 'zcode' && item.kind === 'plugin') return { agentId: 'zcode', action: 'plugin-uninstall', id: item.id, expectedFingerprint: item.fingerprint }
  if (item.agentId === 'kimi' && item.kind === 'plugin' && item.scope === 'plugin' && item.owner === 'plugin' && item.pluginId) return { agentId: 'kimi', action: 'plugin-uninstall', id: item.id, expectedFingerprint: item.fingerprint }
  if (item.agentId === 'kimi' && item.owner === 'user' && item.scope === 'agent' && (item.kind === 'skill' || item.kind === 'mcp')) {
    return { agentId: 'kimi', action: item.kind === 'skill' ? 'skill-delete' : 'mcp-delete', id: item.id, expectedFingerprint: item.fingerprint }
  }
  if (item.agentId === 'grok' && (item.kind === 'mcp' || item.kind === 'plugin')) {
    return { agentId: 'grok', action: item.kind === 'mcp' ? 'mcp-remove' : 'plugin-uninstall', id: item.id, expectedFingerprint: item.fingerprint }
  }
  if (item.agentId === 'deepseek' && item.kind === 'plugin') return { agentId: 'deepseek', action: 'plugin-remove', id: item.id, expectedFingerprint: item.fingerprint }
  return undefined
}

type BetaEditorKind = 'skill' | 'mcp' | 'plugin'
export interface BetaCapabilityEditorInput {
  agentId: 'kimi' | 'grok' | 'deepseek'
  kind: BetaEditorKind
  name: string
  text: string
  item?: CapabilityInventoryItem
  expectedRevision?: string
}
interface BetaCapabilityEditor extends BetaCapabilityEditorInput { error?: string }

export function canCreateBetaCapability(inventory: CapabilityAgentInventory | undefined, kind: BetaEditorKind): boolean {
  if (!inventory?.available || inventory.status !== 'available' || inventory.managementSupported === false) return false
  return inventory.agentId === 'kimi' ? inventory.writable && (kind === 'skill' || kind === 'mcp')
    : inventory.agentId === 'grok' ? kind === 'mcp' || kind === 'plugin'
    : inventory.agentId === 'deepseek' && kind === 'plugin' && inventory.managementSupported === true
}

export function betaCapabilityEditorRequest(input: BetaCapabilityEditorInput): CapabilityInventoryManageRequest {
  const { agentId, kind, item, text, expectedRevision } = input
  const name = input.name.trim()
  if ((!name && !(agentId === 'deepseek' && kind === 'plugin' && item)) || (item && (!betaCapabilityRemovalRequest(item) || item.agentId !== agentId || item.kind !== kind))) {
    throw new Error('invalid_capability_inventory_manage_request')
  }
  if (kind === 'skill') {
    if (agentId !== 'kimi' || !text.trim()) throw new Error('invalid_capability_inventory_manage_request')
    return item ? { agentId, action: 'skill-update', id: item.id, expectedFingerprint: item.fingerprint, manifestText: text }
      : { agentId, action: 'skill-create', name, manifestText: text }
  }
  if (kind === 'plugin') {
    if (agentId === 'deepseek') return item
      ? { agentId, action: 'plugin-update', id: item.id, expectedFingerprint: item.fingerprint, ...(name ? { spec: name } : {}) }
      : { agentId, action: 'plugin-install', spec: name }
    if (agentId !== 'grok' || item) throw new Error('invalid_capability_inventory_manage_request')
    return { agentId, action: 'plugin-install', source: name, ...(expectedRevision ? { expectedRevision } : {}) }
  }
  if (agentId === 'deepseek') throw new Error('invalid_capability_inventory_manage_request')
  let config: Record<string, unknown>
  try {
    config = JSON.parse(text)
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error()
  } catch { throw new Error('capability_inventory_invalid_config') }
  const fields = ['transport', 'command', 'args', 'url', 'env', 'headers', 'enabled',
    ...(agentId === 'kimi' ? ['bearerTokenEnvVar', 'auth', 'executor', 'deferred', 'startupTimeoutMs', 'toolTimeoutMs', 'enabledTools', 'disabledTools'] : [])]
  // Existing Kimi definitions can include native runtime paths, which stay in main.
  if (agentId === 'kimi' && item) { delete config.cwd; delete config.runtime_id }
  if (Object.keys(config).some((key) => !fields.includes(key))) throw new Error('capability_inventory_invalid_config')
  if (agentId === 'kimi') return { agentId, action: 'mcp-upsert', name, config: config as BetaCapabilityMcpConfiguration,
    ...(item ? { expectedFingerprint: item.fingerprint } : {}) }
  delete config.enabled
  if (!['stdio', 'http', 'sse'].includes(String(config.transport))) throw new Error('capability_inventory_invalid_config')
  const mcp = config as { transport: 'stdio' | 'http' | 'sse' }
  return item ? { ...mcp, agentId, action: 'mcp-update', id: item.id, expectedFingerprint: item.fingerprint, ...(expectedRevision ? { expectedRevision } : {}) }
    : { ...mcp, agentId, action: 'mcp-add', name, scope: 'user', ...(expectedRevision ? { expectedRevision } : {}) }
}

export function betaCapabilityStateRequest(item: CapabilityInventoryItem, enabled: boolean, expectedRevision?: string): CapabilityInventoryManageRequest | undefined {
  if (item.id.startsWith('deepseek:files:')) return undefined
  if (!betaCapabilityRemovalRequest(item)) return undefined
  if (item.agentId === 'kimi' && item.kind === 'mcp') return { agentId: 'kimi', action: enabled ? 'mcp-enable' : 'mcp-disable', id: item.id, expectedFingerprint: item.fingerprint }
  if (item.agentId === 'deepseek' && item.kind === 'plugin') return { agentId: 'deepseek', action: enabled ? 'plugin-enable' : 'plugin-disable', id: item.id, expectedFingerprint: item.fingerprint }
  if (item.agentId === 'grok' && (item.kind === 'mcp' || item.kind === 'plugin')) return { agentId: 'grok', action: item.kind === 'mcp' ? enabled ? 'mcp-enable' : 'mcp-disable' : enabled ? 'plugin-enable' : 'plugin-disable',
    id: item.id, expectedFingerprint: item.fingerprint, ...(expectedRevision ? { expectedRevision } : {}) }
  return undefined
}

function capabilityEnabled(item: CapabilityInventoryItem, detail: CapabilityInventoryDetail | null): boolean {
  try {
    const parsed = JSON.parse(detail?.manifestText || '{}')
    const config = Array.isArray(parsed) ? parsed.find((value) => value?.name === item.name) : parsed
    if (typeof config?.enabled === 'boolean') return config.enabled
  } catch { /* Non-JSON Skills have no enabled state. */ }
  return !/(?:^|\W)disabled(?:$|\W)/.test(item.source || '')
}

export function capabilityManagementErrorMessage(error: unknown): string {
  const code = (error instanceof Error ? error.message : '').match(/(?:^|Error: )(capability_inventory_[a-z_]+|atomic_fs_unavailable|invalid_capability_inventory_manage_request)$/)?.[1]
  const messages: Record<string, string> = {
    capability_inventory_stale: '能力已变化，请重新扫描后再操作。',
    capability_inventory_read_only: '该能力来自只读来源，无法修改。',
    capability_inventory_already_exists: '同名能力已存在，请使用其他名称。',
    capability_inventory_invalid_config: '配置无效，请检查内容后重试。',
    capability_inventory_unsafe_path: '无法安全访问能力目录，已停止操作。',
    capability_inventory_action_unsupported: '此原生安装暂不支持该操作。',
    capability_inventory_unavailable: 'Agent 暂不可用，请完成安装或更新后重试。',
    atomic_fs_unavailable: '安全文件组件不可用，已停止操作。',
    invalid_capability_inventory_manage_request: '操作参数无效，请重新打开能力详情。'
  }
  return code && Object.hasOwn(messages, code) ? messages[code] : '操作失败，请重新扫描后重试。'
}

const COMPONENT_NAMES: Record<string, string> = { skills: 'Skills', mcps: 'MCP', hooks: 'Hooks', apps: 'Apps', models: 'Models', commands: 'Commands' }

function tracks(tracking: JobTracking, job: CapabilitySyncJob): boolean {
  if (tracking.jobId === job.id || (tracking.transactionId && tracking.transactionId === job.transactionId)) return true
  return !tracking.jobId && !tracking.transactionId && tracking.planId === job.planId
}

function latestRemovalJob(jobs: CapabilitySyncJob[]): CapabilitySyncJob | undefined {
  return jobs.filter((candidate) => candidate.operation === 'remove-selected')
    .reduce<CapabilitySyncJob | undefined>((latest, candidate) =>
      !latest || compareCapabilitySyncJobs(candidate, latest) > 0 ? candidate : latest, undefined)
}

// Fix#3 — module-level cache of the last inventory scan so re-opening 工具能力 shows
// the previous result INSTANTLY (no blocking "正在扫描…"), while a fresh scan runs in
// the background and only re-renders when the result actually differs.
let cachedInventory: CapabilityInventoryResult | null = null

export function CapabilityAgentPicker({ value, label, agents, onChange }: {
  value: CapabilityAgentId; label: string; agents: readonly Pick<AgentDef, 'id' | 'name'>[]; onChange: (id: CapabilityAgentId) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    const outside = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  return <div className="cap-agent-select" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (!open) { setOpen(true); return }
    const options = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
    options[next]?.focus()
  }}>
    <button type="button" ref={trigger} className="cap-agent-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(current => !current)}>
      <AgentIcon agentId={value} size={23}/><span>{agents.find(agent => agent.id === value)?.name || AGENT_NAMES[value]}</span><UiIcon name="chevron-down" size={14}/>
    </button>
    <div className="mp-menu cap-agent-menu" role="listbox" aria-label={label} id={menuId} hidden={!open}>
      {agents.map(agent => <button type="button" className={`mp-opt ${agent.id === value ? 'is-sel' : ''}`} key={agent.id} role="option" aria-selected={agent.id === value} data-agent-id={agent.id} onClick={() => { onChange(agent.id as CapabilityAgentId); close() }}>
        <AgentIcon agentId={agent.id} size={21}/><span className="mp-opt-label">{agent.name}</span>{agent.id === value && <UiIcon name="check" size={14}/>}
      </button>)}
    </div>
  </div>
}

export function CapabilitySourceHint({ inventory }: { inventory?: CapabilityAgentInventory }): JSX.Element {
  const id = useId()
  return <span className="cap-source-hint">
    <button type="button" className="cap-source-trigger" aria-label="本次读取来源" aria-describedby={id}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/></svg>
    </button>
    <span className="cap-source-tooltip" role="tooltip" id={id}><b>本次读取来源</b>
      {!inventory?.readSources?.length ? <span>等待本次扫描完成</span> : inventory.readSources.map((source, index) =>
        <span key={`${source.path}:${index}`} className={`cap-source-entry ${source.status}`}><span>{source.status === 'read' ? '已读取' : source.status === 'missing' ? '不存在' : '读取失败'}</span><code>{source.path}</code></span>)}
    </span>
  </span>
}

export function AgentCapabilitiesPanel({ onOpenSync, embedded = false, agents = [], logOnly = false, onBack }: {
  onOpenSync: (request: CapabilityInventorySyncRequest) => void; embedded?: boolean
  agents?: readonly Pick<AgentDef, 'id' | 'name'>[]; logOnly?: boolean; onBack?: () => void
}): JSX.Element {
  const [result, setResult] = useState<CapabilityInventoryResult | null>(cachedInventory)
  const [agentId, setAgentId] = useState<CapabilityAgentId>('codex')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<CapabilityInventoryKind | 'all'>('all')
  // 需求2: 点击卡片打开 Skill / 能力详情抽屉；详情由安全的 detail IPC 现算得到
  // （SKILL.md 正文 + 文件列表 + 可在文件浏览器中打开的绝对目录）。
  const [detailItem, setDetailItem] = useState<CapabilityInventoryItem | null>(null)
  const [detail, setDetail] = useState<CapabilityInventoryDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [browseFolder, setBrowseFolder] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const [job, setJob] = useState<CapabilitySyncJob | null>(null)
  const [rollbackCandidate, setRollbackCandidate] = useState<CapabilityRollbackCandidate | null>(null)
  const [loading, setLoading] = useState(false)
  const [jobPending, setJobPending] = useState<'cancel' | 'rollback' | null>(null)
  const [capabilityActionPending, setCapabilityActionPending] = useState<string | null>(null)
  const [editor, setEditor] = useState<BetaCapabilityEditor | null>(null)
  const [editorPending, setEditorPending] = useState(false)
  const managementBusy = useRef(false)
  const [error, setError] = useState('')
  // Packaged Electron never resolves the native window.confirm modal, so plugin/
  // Skill mutations must gate on an in-app confirmation instead of blocking on it.
  const [confirmPrompt, setConfirmPrompt] = useState<{ title?: string; message: string; impact?: string; danger: boolean; confirmLabel?: string; keepOpen?: boolean; pending?: boolean; error?: string; resolve?: (ok: boolean) => void } | null>(null)
  const confirmTrigger = useRef<HTMLElement | null>(null)
  const askConfirm = useCallback((message: string, danger = false, title?: string, confirmLabel?: string, keepOpen = false, impact?: string): Promise<boolean> =>
    new Promise((resolve) => { confirmTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirmPrompt({ title, message, impact, danger, confirmLabel, keepOpen, resolve }) }), [])
  const answerConfirm = useCallback((ok: boolean) => {
    setConfirmPrompt((current) => {
      if (!current || current.pending) return current
      if (current.error) { queueMicrotask(() => confirmTrigger.current?.focus()); return null }
      current.resolve?.(ok)
      if (!ok) queueMicrotask(() => confirmTrigger.current?.focus())
      return ok && current.keepOpen ? { ...current, pending: true, resolve: undefined } : null
    })
  }, [])
  const failConfirm = useCallback((message: string) => setConfirmPrompt((current) => current?.pending ? { ...current, pending: false, error: message } : current), [])
  // Targeted removal animation: an uninstalled/unlinked row fades+collapses out on
  // its own, so the list doesn't flash from a full re-render (需求：不要整个列表刷).
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const animateRemoval = useCallback(async (id: string): Promise<void> => {
    setRemovingIds((prev) => new Set(prev).add(id))
    await new Promise((done) => setTimeout(done, 260))
    if (!mounted.current) return
    setRemovedIds((prev) => new Set(prev).add(id))
    setRemovingIds((prev) => { const next = new Set(prev); next.delete(id); return next })
  }, [])
  // 「清单 / 对比」模式切换。对比视图固定为左侧来源 → 右侧目标。
  const [view, setView] = useState<'inventory' | 'compare' | 'log'>(logOnly ? 'log' : 'inventory')
  const agentOptions = agents.length ? agents : result?.inventories.length
    ? result.inventories.map(value => ({ id: value.agentId, name: value.agentName || AGENT_NAMES[value.agentId] }))
    : Object.entries(AGENT_NAMES).filter(([id]) => isDistributionAgent(id)).map(([id, name]) => ({ id, name }))
  const agentIds = agentOptions.map(agent => agent.id as CapabilityAgentId)
  // 多选批量删除：清单视图下开启后每张可管理卡片出现复选框，底部条一键卸载选中项。
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [logAgent, setLogAgent] = useState<CapabilityAgentId | 'all'>('all')
  const [logCopyState, setLogCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [leftAgent, setLeftAgent] = useState<CapabilityAgentId>('codex')
  const [rightAgent, setRightAgent] = useState<CapabilityAgentId>(INTERNAL_DISTRIBUTION ? 'traex' : 'claude')
  const [onlyDiff, setOnlyDiff] = useState(true)
  const [compareScan, setCompareScan] = useState<CapabilityScanResult | null>(null)
  const [compareSelected, setCompareSelected] = useState<Set<string>>(new Set())
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState('')
  const compareGeneration = useRef(0)
  const inventoryGeneration = useRef(0)
  const removalInputGeneration = useRef(0)
  const removalRequestGeneration = useRef(0)
  const planGeneration = useRef<number | null>(null)
  const trackedJob = useRef<JobTracking | null>(null)
  const pendingRemovalIds = useRef<string[]>([])
  const recoveringJob = useRef(true)
  const recoveryProgress = useRef<CapabilitySyncJob[]>([])
  const mounted = useRef(true)

  const invalidateRemoval = useCallback(() => {
    removalInputGeneration.current += 1
    removalRequestGeneration.current += 1
    planGeneration.current = null
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++inventoryGeneration.current
    invalidateRemoval()
    // Only block with a spinner on the very first scan (no cache yet); otherwise
    // keep showing the cached list and refresh silently in the background.
    if (cachedInventory === null) setLoading(true)
    setError('')
    try {
      const next = await window.uniagent.capabilityInventoryList()
      if (generation !== inventoryGeneration.current || !mounted.current) return
      // Re-render only when the scan result actually changed, so a background
      // refresh of an unchanged inventory never flickers or drops the selection.
      if (JSON.stringify(next) !== JSON.stringify(cachedInventory)) {
        cachedInventory = next
        setResult(next)
        // Drop removed-ids the scan already dropped, and reveal any that unexpectedly
        // survived (action failed silently) so the row reappears instead of vanishing.
        const live = new Set(next.inventories.flatMap((entry) => entry.items.map((item) => item.id)))
        setRemovedIds((prev) => new Set([...prev].filter((id) => live.has(id))))
      }
    } catch {
      if (generation === inventoryGeneration.current && mounted.current && !cachedInventory) setError('扫描能力失败，请重试。')
    } finally {
      if (generation === inventoryGeneration.current && mounted.current) setLoading(false)
    }
  }, [invalidateRemoval])

  const acceptJob = useCallback((next: CapabilitySyncJob) => {
    if (next.operation !== 'remove-selected') return
    trackedJob.current = { jobId: next.id, transactionId: next.transactionId }
    setJob((current) => current?.id === next.id && compareCapabilitySyncJobs(next, current) <= 0 ? current : next)
    if (next.state === 'completed' && next.transactionId) setRollbackCandidate({ ...next, state: 'completed', transactionId: next.transactionId })
  }, [])

  useEffect(() => {
    mounted.current = true
    recoveringJob.current = true
    recoveryProgress.current = []
    void refresh()
    const offChanged = window.uniagent.onCapabilityInventoryChanged(() => { void refresh() })
    const offProgress = window.uniagent.onCapabilitySyncProgress((next) => {
      if (next.operation !== 'remove-selected') return
      const tracking = trackedJob.current
      if (!tracking && recoveringJob.current) {
        recoveryProgress.current = [...recoveryProgress.current.slice(-19), next]
        return
      }
      if (!tracking || !tracks(tracking, next)) return
      acceptJob(next)
      if (next.state === 'completed') {
        setConfirmPrompt(null)
        const ids = pendingRemovalIds.current; pendingRemovalIds.current = []
        if (ids.length) void Promise.all(ids.map(animateRemoval)).then(refresh)
        else void refresh()
      } else if (next.state === 'rolled_back') { pendingRemovalIds.current = []; failConfirm('卸载失败，变更已回滚。'); void refresh() }
      else if (TERMINAL.has(next.state)) { pendingRemovalIds.current = []; failConfirm('卸载失败，未提交的变更不会保留。') }
    })
    void window.uniagent.capabilitySyncGetJobSnapshot().then((snapshot) => {
      if (!mounted.current) return
      setRollbackCandidate(snapshot.rollbackCandidate?.operation === 'remove-selected' ? snapshot.rollbackCandidate : null)
      const bufferedLatest = latestRemovalJob(recoveryProgress.current)
      const recovered = snapshot.active?.operation === 'remove-selected' ? snapshot.active
        : snapshot.latest?.operation === 'remove-selected' ? snapshot.latest : bufferedLatest
      const tracking = trackedJob.current
      if (!recovered || (tracking && !tracks(tracking, recovered))) return
      acceptJob(recovered)
      const recoveredTracking = { jobId: recovered.id, transactionId: recovered.transactionId }
      const bufferedMatch = latestRemovalJob(recoveryProgress.current.filter((candidate) => tracks(recoveredTracking, candidate)))
      if (bufferedMatch) acceptJob(bufferedMatch)
    }).catch(() => {
      const bufferedLatest = latestRemovalJob(recoveryProgress.current)
      if (mounted.current && bufferedLatest) acceptJob(bufferedLatest)
    }).finally(() => { recoveringJob.current = false; recoveryProgress.current = [] })
    return () => { mounted.current = false; recoveringJob.current = false; recoveryProgress.current = []; inventoryGeneration.current += 1; removalRequestGeneration.current += 1; offChanged(); offProgress() }
  }, [acceptJob, animateRemoval, failConfirm, refresh])

  const inventory = result?.inventories.find((entry) => entry.agentId === agentId)
  const inventoryItems = useMemo(() => capabilityListItems(inventory?.items || []), [inventory])
  const visible = useMemo(() => orderCapabilityItems(inventoryItems.filter((item) => !removedIds.has(item.id) &&
    (kind === 'all' || item.kind === kind) && (!query.trim() || `${item.name} ${item.origin} ${item.source || ''} ${item.plugin || ''} ${item.version || ''}`.toLowerCase().includes(query.trim().toLowerCase())))), [inventoryItems, kind, query, removedIds])
  const skillNameCounts = useMemo(() => visible.reduce<Map<string, number>>((all, item) => {
    if (item.kind === 'skill') { const key = item.name.toLocaleLowerCase('en-US'); all.set(key, (all.get(key) || 0) + 1) }
    return all
  }, new Map()), [visible])
  const counts = useMemo(() => inventoryItems.reduce<Record<string, number>>((all, item) => { all[item.kind] = (all[item.kind] || 0) + 1; return all }, {}), [inventoryItems])
  // 可批量卸载项数：私有项沿用 Agent writable/link 约束；共享 Skill 独立可删。
  const selectableCount = useMemo(() => inventoryItems.filter(isSelectable).length, [inventoryItems])
  const selectedCount = useMemo(() => inventoryItems.filter((item) => selectedIds.has(item.id) && isSelectable(item)).length, [inventoryItems, selectedIds])
  const logRows = useMemo(() => capabilityLogRows(result), [result])
  const visibleLogRows = useMemo(() => logAgent === 'all' ? logRows : logRows.filter((row) => row.agentId === logAgent), [logAgent, logRows])
  const logCounts = useMemo(() => logRows.reduce<Partial<Record<CapabilityAgentId, number>>>((all, row) => { all[row.agentId] = (all[row.agentId] || 0) + 1; return all }, {}), [logRows])
  const jobActive = !!job && !TERMINAL.has(job.state)
  async function copyCapabilityLog(): Promise<void> {
    if (!result || logRows.length === 0) return
    try {
      await navigator.clipboard.writeText(formatCapabilityLog(result, logRows))
      setLogCopyState('copied')
    } catch { setLogCopyState('failed') }
    setTimeout(() => setLogCopyState('idle'), 1800)
  }

  function changeAgent(next: CapabilityAgentId): void {
    invalidateRemoval(); setAgentId(next); setError(''); exitMultiSelect()
  }

  // 需求2: 打开某个能力的详情抽屉，并异步拉取安全的 detail（SKILL.md + 文件列表 +
  // 可浏览的绝对目录）。detailRequest 保证只有最后一次点击的结果会落地。
  function openDetail(item: CapabilityInventoryItem): void {
    setEditor(null)
    const request = ++detailRequest.current
    setDetailItem(item)
    setError('')
    setDetail(null)
    setDetailLoading(true)
    void window.uniagent.capabilityInventoryDetail(item.id)
      .then((next) => { if (request === detailRequest.current) setDetail(next) })
      .catch(() => { if (request === detailRequest.current) setDetail(null) })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false) })
  }

  function closeDetail(): void {
    if (managementBusy.current) return
    detailRequest.current += 1
    setDetailItem(null); setDetail(null); setDetailLoading(false)
  }

  function openCreate(kind: BetaEditorKind): void {
    if (!canCreateBetaCapability(inventory, kind) || managementBusy.current || capabilityActionPending || jobActive) return
    closeDetail(); exitMultiSelect()
    setEditor({ agentId: inventory!.agentId as BetaCapabilityEditorInput['agentId'], kind, name: '',
      text: kind === 'skill' ? '---\nname: new-skill\ndescription: 描述此技能的用途\n---\n\n# New Skill\n\n在这里编写技能指令。\n' : kind === 'mcp' ? '{\n  "transport": "stdio",\n  "command": "npx",\n  "args": ["-y", "your-mcp-package"]\n}' : '',
      expectedRevision: inventory?.revision })
  }

  function openEditor(item: CapabilityInventoryItem): void {
    if (!canManageCapabilityItem(item, !!inventory?.writable) || !detail?.manifestText || detailLoading || managementBusy.current || capabilityActionPending) return
    if (item.agentId !== 'kimi' && item.agentId !== 'grok') return
    if (item.kind !== 'mcp' && !(item.agentId === 'kimi' && item.kind === 'skill')) return
    setEditor({ agentId: item.agentId, kind: item.kind, name: item.name, text: detail.manifestText, item,
      expectedRevision: inventory?.revision })
  }

  function closeEditor(): void {
    if (!managementBusy.current) setEditor(null)
  }

  function openPluginUpdate(item: CapabilityInventoryItem): void {
    if (item.agentId !== 'deepseek' || item.kind !== 'plugin' || !canManageCapabilityItem(item, !!inventory?.writable) ||
        managementBusy.current || capabilityActionPending || jobActive) return
    setEditor({ agentId: 'deepseek', kind: 'plugin', name: '', text: '', item })
  }

  function acceptManagedInventory(next: CapabilityAgentInventory): void {
    inventoryGeneration.current += 1
    setLoading(false)
    invalidateRemoval()
    setResult((previous) => {
      if (!previous) return previous
      const updated = { ...previous, inventories: previous.inventories.map((entry) => entry.agentId === next.agentId ? next : entry) }
      cachedInventory = updated
      return updated
    })
  }

  async function saveEditor(): Promise<void> {
    if (!editor || managementBusy.current || capabilityActionPending || jobActive) return
    let request: CapabilityInventoryManageRequest
    try { request = betaCapabilityEditorRequest(editor) }
    catch (error) { setEditor((current) => current && { ...current, error: capabilityManagementErrorMessage(error) }); return }
    managementBusy.current = true; setEditorPending(true)
    setEditor((current) => current && { ...current, error: undefined })
    try {
      const next = await window.uniagent.capabilityInventoryManage(request)
      if (!mounted.current) return
      acceptManagedInventory(next)
      setEditor(null); detailRequest.current += 1; setDetailItem(null); setDetail(null); setDetailLoading(false)
    } catch (error) {
      if (mounted.current) setEditor((current) => current && { ...current, error: capabilityManagementErrorMessage(error) })
    } finally { managementBusy.current = false; if (mounted.current) setEditorPending(false) }
  }

  async function runManagedState(item: CapabilityInventoryItem, action: 'enable' | 'disable' | 'update'): Promise<void> {
    if (!canManageCapabilityItem(item, !!inventory?.writable) || managementBusy.current || capabilityActionPending || jobActive) return
    const request = action === 'update' && item.agentId === 'grok' && item.kind === 'plugin'
      ? { agentId: 'grok', action: 'plugin-update', id: item.id, expectedFingerprint: item.fingerprint, expectedRevision: inventory?.revision } as const
      : action !== 'update' ? betaCapabilityStateRequest(item, action === 'enable', inventory?.revision) : undefined
    if (!request) return
    managementBusy.current = true; setCapabilityActionPending(`${item.id}:${action}`); setError('')
    try {
      const next = await window.uniagent.capabilityInventoryManage(request)
      if (!mounted.current) return
      acceptManagedInventory(next)
      const updated = next.items.find((candidate) => candidate.id === item.id)
      if (updated) {
        setDetailItem(updated)
        const generation = ++detailRequest.current
        const nextDetail = await window.uniagent.capabilityInventoryDetail(updated.id).catch(() => null)
        if (generation === detailRequest.current && mounted.current) setDetail(nextDetail)
      }
    } catch (error) { if (mounted.current) setError(capabilityManagementErrorMessage(error)) }
    finally { managementBusy.current = false; if (mounted.current) setCapabilityActionPending(null) }
  }

  function uninstallFromDetail(item: CapabilityInventoryItem): void {
    if (item.kind === 'plugin') { void runPluginAction(item, 'uninstall'); return }
    closeDetail()
    void removeItem(item)
  }

  function sharedImpact(items: CapabilityInventoryItem[]): string {
    const shared = items.filter((item) => item.scope === 'shared' && !item.linked)
    return shared.map((item) => `${item.name}：${(item.dependentAgents || []).map((id) => AGENT_NAMES[id]).join('、') || '无其他 Agent'}`).join('\n')
  }

  async function removeDirectCapability(item: CapabilityInventoryItem): Promise<void> {
    if (capabilityActionPending || !usesDirectCapabilityRemoval(item) || !isManageable(item)) return
    const shared = item.scope === 'shared' && !item.linked
    const prompt = shared
      ? `“${item.name}” 是共享 Skill。删除后，所有依赖它的 Agent 都将同步移除该技能。\n\n系统会清理这些 Agent 下指向共享 Skill 的链接，并删除共享源目录。此操作不可撤销。`
      : item.linked
        ? `移除链接：${item.entryPath || item.name}\n\n保留源文件：${item.manifestPath || item.location || '源目录'}\n其它入口保持原样。如果 Agent 同时直接读取共享目录，该技能仍可能可用。`
        : `确认从 ${AGENT_NAMES[item.agentId]} 卸载 ${KIND_NAMES[item.kind] || '能力'}「${item.name}」？\n仅移除当前用户级能力，内置、项目及插件来源保持不变。`
    const label = capabilityRemovalLabel(item)
    if (!(await askConfirm(prompt, true, label, label, true, shared ? sharedImpact([item]) : undefined))) return
    setCapabilityActionPending(item.id); setError('')
    try { await removeCurrentCapability(item); setConfirmPrompt(null); closeDetail(); await animateRemoval(item.id); void refresh() }
    catch (error) { failConfirm(betaCapabilityRemovalRequest(item) ? capabilityManagementErrorMessage(error) : shared ? '删除共享 Skill 未完成，请重新扫描确认剩余内容。' : item.linked ? '移除链接失败；源 Skill 未被修改。' : '卸载失败；能力可能已变化，请重新扫描。') }
    finally { setCapabilityActionPending(null) }
  }

  async function runPluginAction(item: CapabilityInventoryItem, action: 'migrate' | 'uninstall', targetAgentId?: CapabilityAgentId): Promise<void> {
    const nativeRequest = action === 'uninstall' ? betaCapabilityRemovalRequest(item) : undefined
    if (capabilityActionPending || item.kind !== 'plugin' || !item.pluginId && !nativeRequest) return
    const pluginName = item.pluginId || item.name
    const prompt = action === 'uninstall'
      ? item.agentId === 'codex' || item.agentId === 'traex'
        ? `确认从 ${AGENT_NAMES[item.agentId]} 卸载插件 ${pluginName}？\n\n将调用 Agent 原生命令，并清理该插件的全部缓存版本；此操作不支持 UniAgent 回滚。`
        : `确认从 ${AGENT_NAMES[item.agentId]} 卸载插件 ${pluginName}？\n\n将使用 Agent 原生卸载流程，移除当前安装及其提供的能力；此操作不支持 UniAgent 回滚。`
      : `确认将插件 ${pluginName} 迁移到 ${targetAgentId ? AGENT_NAMES[targetAgentId] : '目标 Agent'}？\n\n将调用目标 Agent 的原生安装命令；不会复制插件缓存。`
    if (!(await askConfirm(prompt, action === 'uninstall'))) return
    setCapabilityActionPending(`${item.id}:${action}:${targetAgentId || ''}`); setError('')
    try {
      if (nativeRequest) await window.uniagent.capabilityInventoryManage(nativeRequest)
      else await window.uniagent.capabilityPluginAction({ id: item.id, action, ...(targetAgentId ? { targetAgentId } : {}) })
      closeDetail()
      // Uninstall removes the row → fade it out before the silent refresh drops it.
      if (action === 'uninstall') { await animateRemoval(item.id); void refresh() } else await refresh()
    } catch (error) { setError(nativeRequest ? capabilityManagementErrorMessage(error) : action === 'uninstall' ? '插件卸载失败，请重新扫描后重试。' : '插件迁移失败：目标 Agent 无法完成原生安装或验证。') }
    finally { setCapabilityActionPending(null) }
  }

  async function previewRemoval(ids: string[]): Promise<CapabilitySyncPlan | undefined> {
    if ((agentId !== 'codex' && agentId !== 'traex') || ids.length === 0 || jobActive) return
    const inputGeneration = removalInputGeneration.current
    const requestGeneration = ++removalRequestGeneration.current
    const target = agentId
    try {
      setError('')
      const next = await window.uniagent.capabilityMutationPlanRemove(target, ids)
      if (requestGeneration !== removalRequestGeneration.current || inputGeneration !== removalInputGeneration.current || target !== agentId) return
      planGeneration.current = inputGeneration
      return next
    } catch { return }
  }

  async function removeItem(item: CapabilityInventoryItem): Promise<void> {
    if (!isManageable(item)) return
    if (usesDirectCapabilityRemoval(item)) { await removeDirectCapability(item); return }
    invalidateRemoval()
    if (!(await askConfirm(`确认从 ${AGENT_NAMES[item.agentId]} 卸载 ${KIND_NAMES[item.kind] || '能力'}「${item.name}」？\n卸载后该能力将从列表移除，可随时重新扫描确认。`, true, '卸载能力', '卸载', true))) return
    const next = await previewRemoval([item.id])
    if (!next) { failConfirm('无法生成卸载计划；能力可能已变化，请重新扫描。'); return }
    if (next.blockedReasons.length) { failConfirm(REMOVAL_BLOCKED[next.blockedReasons[0]] || `当前无法卸载：${next.blockedReasons[0]}`); return }
    await executeRemoval(next, [item.id])
  }

  async function executeRemoval(immutablePlan: CapabilitySyncPlan, removalIds: string[]): Promise<void> {
    if (!immutablePlan || planGeneration.current !== removalInputGeneration.current || jobActive) {
      failConfirm('能力列表已变化，请关闭弹窗后重试。')
      return
    }
    trackedJob.current = { planId: immutablePlan.id }
    pendingRemovalIds.current = removalIds
    try {
      const started = await window.uniagent.capabilitySyncExecute({ planId: immutablePlan.id, expectedSourceRevision: immutablePlan.sourceRevision, expectedTargetRevision: immutablePlan.targetRevision, confirmation: { acknowledged: true, targetName: immutablePlan.target, deleteCount: immutablePlan.destructiveCount } })
      acceptJob(started); invalidateRemoval()
    } catch { trackedJob.current = null; pendingRemovalIds.current = []; failConfirm('执行卸载失败；未提交的变更不会保留。') }
  }

  // 多选批量删除：清单视图下勾选可管理项后一次卸载。codex/traex 走单个原子计划
  // （planRemoval 同时接受 linked/非 linked skill 与 mcp）；其它直删项复用原生删除入口。
  function exitMultiSelect(): void { setMultiSelect(false); setSelectedIds(new Set()) }
  function toggleMultiSelect(): void { multiSelect ? exitMultiSelect() : setMultiSelect(true) }
  function isManageable(item: CapabilityInventoryItem): boolean {
    return canManageCapabilityItem(item, !!inventory?.writable)
  }
  function isSelectable(item: CapabilityInventoryItem): boolean {
    return item.kind !== 'plugin' && isManageable(item)
  }
  function toggleSelect(item: CapabilityInventoryItem): void {
    if (!isSelectable(item)) return
    setSelectedIds((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next })
  }

  async function removeCurrentCapability(item: CapabilityInventoryItem): Promise<void> {
    const request = betaCapabilityRemovalRequest(item)
    if (request) await window.uniagent.capabilityInventoryManage(request)
    else await window.uniagent.capabilitySkillLinkRemove(item.id, item.agentId, item.fingerprint)
  }

  async function removeSelected(): Promise<void> {
    const items = inventoryItems.filter((item) => selectedIds.has(item.id) && isSelectable(item))
    if (items.length === 0 || jobActive || capabilityActionPending) return
    invalidateRemoval()
    const shared = items.filter((item) => item.scope === 'shared' && !item.linked)
    if (!(await askConfirm(`确认删除选中的 ${items.length} 项能力？${shared.length ? '\n\n共享 Skill 的全部依赖链接也会同步清理。' : ''}\n删除后这些能力将从列表移除。`, true, shared.length ? '批量删除能力' : '批量卸载', `删除 ${items.length} 项`, true, shared.length ? sharedImpact(items) : undefined))) return
    exitMultiSelect()
    const direct = items.filter(usesDirectCapabilityRemoval)
    if (direct.length) {
      setCapabilityActionPending('batch'); setError('')
      const failures: string[] = []
      for (const item of direct) {
        try { await removeCurrentCapability(item); await animateRemoval(item.id) }
        catch { failures.push(item.name) }
      }
      setCapabilityActionPending(null)
      if (failures.length) { failConfirm(`部分删除失败：${failures.join('、')}；其余已删除。`); void refresh(); return }
      if (direct.length === items.length) { setConfirmPrompt(null); void refresh(); return }
      await refresh()
    }
    const ids = items.filter((item) => !usesDirectCapabilityRemoval(item)).map((item) => item.id)
    const next = await previewRemoval(ids)
    if (!next) { failConfirm('无法生成卸载计划；能力可能已变化，请重新扫描。'); return }
    if (next.blockedReasons.length) { failConfirm(REMOVAL_BLOCKED[next.blockedReasons[0]] || `当前无法卸载：${next.blockedReasons[0]}`); return }
    await executeRemoval(next, ids)
  }

  async function cancelJob(): Promise<void> {
    if (!job || !CANCELLABLE.has(job.state)) return
    setJobPending('cancel')
    try { const next = await window.uniagent.capabilitySyncCancel(job.id); if (next && trackedJob.current && tracks(trackedJob.current, next)) acceptJob(next) }
    catch { setError('取消任务失败，请重试。') } finally { setJobPending(null) }
  }

  async function rollbackJob(): Promise<void> {
    if (!rollbackCandidate || jobActive) return
    const prior = trackedJob.current
    trackedJob.current = { transactionId: rollbackCandidate.transactionId }
    setJobPending('rollback')
    try { const next = await window.uniagent.capabilitySyncRollback(rollbackCandidate.transactionId); setRollbackCandidate(null); acceptJob(next) }
    catch { trackedJob.current = prior; setError('回滚失败；目标内容可能已变化。') } finally { setJobPending(null) }
  }

  // 需求3: 对比视图 —— 只有 codex↔traex 可 diff+同步；Claude/Grok 只读对比。
  const writablePair = (leftAgent === 'codex' && rightAgent === 'traex') || (leftAgent === 'traex' && rightAgent === 'codex')
  const compareExecutionSupported = writablePair && compareScan?.executionSupported === true

  // 源侧「可复制」清单项的不透明 id 映射（按 kind+小写名对齐），用于把对比选择路由回既有同步流程。
  const sourceOpaqueByKey = useMemo(() => {
    const map = new Map<string, string>()
    if (!writablePair) return map
    const sourceInventory = result?.inventories.find((entry) => entry.agentId === leftAgent)
    for (const item of sourceInventory?.items || []) {
      if (item.scope === 'agent' && item.owner === 'user' && item.copyable) {
        map.set(`${item.kind}:${item.name.toLocaleLowerCase('en-US')}`, item.id)
      }
    }
    return map
  }, [result, leftAgent, writablePair])

  const loadCompare = useCallback(async () => {
    const generation = ++compareGeneration.current
    setCompareLoading(false)
    setCompareError('')
    setCompareSelected(new Set())
    setCompareScan(null)
    if (leftAgent === rightAgent) { setCompareError('请选择两个不同的 Agent 进行对比。'); return }
    if (!writablePair) return // 只读对比在渲染层用已加载的清单对齐，无需扫描。
    setCompareLoading(true)
    try {
      const next = await window.uniagent.capabilitySyncScan({ source: leftAgent as CapabilityProviderId, target: rightAgent as CapabilityProviderId })
      if (generation !== compareGeneration.current || !mounted.current) return
      setCompareScan(next)
    } catch {
      if (generation === compareGeneration.current && mounted.current) setCompareError('对比扫描失败，请重试。')
    } finally {
      if (generation === compareGeneration.current && mounted.current) setCompareLoading(false)
    }
  }, [leftAgent, rightAgent, writablePair])

  useEffect(() => { if (view === 'compare') void loadCompare() }, [view, loadCompare])

  // Skill 按 scope 分行：共享项固定一致，只有私有项进入真实 diff；其它能力沿用原有比较语义。
  const compareRows = useMemo<CompareRow[]>(() => {
    if (leftAgent === rightAgent) return []
    const left = result?.inventories.find((entry) => entry.agentId === leftAgent)
    const right = result?.inventories.find((entry) => entry.agentId === rightAgent)
    return buildCapabilityCompareRows(left?.items || [], right?.items || [], compareScan, writablePair).map((row) => {
      const opaque = sourceOpaqueByKey.get(`${row.kind}:${row.name.toLocaleLowerCase('en-US')}`)
      return { ...row, opaque, syncSelectable: compareExecutionSupported && row.syncSelectable && !!opaque }
    })
  }, [writablePair, compareExecutionSupported, compareScan, result, leftAgent, rightAgent, sourceOpaqueByKey])

  const compareVisible = useMemo(() => compareRows.filter((row) =>
    (kind === 'all' || row.kind === kind) &&
    (!onlyDiff || row.status !== 'same') &&
    (!query.trim() || row.name.toLowerCase().includes(query.trim().toLowerCase()))
  ), [compareRows, kind, onlyDiff, query])

  const compareCounts = useMemo(() => compareRows.reduce<Record<string, number>>((all, row) => { all[row.status] = (all[row.status] || 0) + 1; return all }, {}), [compareRows])
  const compareKindCounts = useMemo(() => compareRows.reduce<Record<string, number>>((all, row) => { all[row.kind] = (all[row.kind] || 0) + 1; return all }, {}), [compareRows])
  // Count only selections that still map to a syncable source item.
  const compareSyncCount = useMemo(() => compareExecutionSupported
    ? compareRows.filter((row) => compareSelected.has(row.id) && row.syncSelectable && row.status === 'add').length
    : 0, [compareExecutionSupported, compareRows, compareSelected])

  function changeCompareAgent(side: 'left' | 'right', next: CapabilityAgentId): void {
    if ((side === 'left' ? leftAgent : rightAgent) === next) return
    compareGeneration.current += 1
    setCompareScan(null); setCompareSelected(new Set()); setCompareError('')
    if (side === 'left') { if (next === rightAgent) setRightAgent(leftAgent); setLeftAgent(next) }
    else { if (next === leftAgent) setLeftAgent(rightAgent); setRightAgent(next) }
  }

  function toggleCompare(row: CompareRow): void {
    if (!row.syncSelectable) return
    setCompareSelected((current) => { const nextSet = new Set(current); nextSet.has(row.id) ? nextSet.delete(row.id) : nextSet.add(row.id); return nextSet })
  }

  function syncCompare(): void {
    if (!compareExecutionSupported) return
    const selections = compareRows.filter((row) => compareSelected.has(row.id) && row.syncSelectable && row.status === 'add' && row.opaque).map((row) => row.opaque!)
    if (selections.length === 0) return
    onOpenSync({ source: leftAgent as CapabilityProviderId, target: rightAgent as CapabilityProviderId, selections })
  }

  const kindChips = (kindCounts: Record<string, number>, total: number, kinds = COMPARE_KINDS): JSX.Element => <div className="cap-kind-chips" role="group" aria-label="能力类型筛选">
    <button className={`cap-chip ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>全部 <span className="cnt">{total}</span></button>
    {kinds.filter((value) => kindCounts[value]).map((value) => <button key={value} className={`cap-chip ${kind === value ? 'on' : ''}`} onClick={() => setKind(value)}>{KIND_NAMES[value]} <span className="cnt">{kindCounts[value]}</span></button>)}
  </div>

  const agentSelect = (selected: CapabilityAgentId, label: string, onChange: (id: CapabilityAgentId) => void): JSX.Element =>
    <CapabilityAgentPicker value={selected} label={label} agents={agentOptions} onChange={onChange}/>

  return <div className={embedded ? 'capability-center capability-embedded' : 'main-panel capability-center'}>
    <div className="settings-scroll">
      <div className="capability-heading">
        {view !== 'log' ? <div className="capability-view-switch"><button className={view === 'inventory' ? 'active' : ''} onClick={() => setView('inventory')}>清单管理</button><button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>跨 Agent 对比</button></div> : <span className="main-panel-title">工具能力排查日志</span>}
        {view === 'inventory' && <div className="cap-agent-picker">{agentSelect(agentId, '选择 Agent', changeAgent)}<CapabilitySourceHint inventory={inventory}/></div>}
        <button className="settings-redetect" onClick={() => view === 'compare' ? void loadCompare() : void refresh()} disabled={view === 'compare' ? compareLoading : loading}>{(view === 'compare' ? compareLoading : loading) ? '扫描中…' : <><RefreshIcon size={13} /> 重新扫描</>}</button>
      </div>
      {view === 'log' ? <>
        <section className="cap-log-summary">
          <span className={`cap-log-summary-icon ${logRows.length ? 'has-issues' : ''}`}><UiIcon name={logRows.length ? 'warn' : 'check'} size={18}/></span>
          <div><b>{logRows.length ? `本次能力扫描发现 ${logRows.length} 条异常` : '本次能力扫描未发现异常'}</b><span>{result ? `扫描于 ${new Date(result.scannedAt).toLocaleString()} · 重新扫描后自动刷新` : '等待首次扫描'}</span></div>
          <button className="settings-mini-btn" disabled={!logRows.length} onClick={() => void copyCapabilityLog()}><UiIcon name="copy" size={13}/>{logCopyState === 'copied' ? '已复制 ✓' : logCopyState === 'failed' ? '复制失败' : '复制全部日志'}</button>
          <button className="settings-mini-btn" onClick={() => onBack ? onBack() : setView('inventory')}>{onBack ? '返回通用' : '返回能力列表'}</button>
        </section>
        <div className="cap-log-filters"><button className={`cap-chip ${logAgent === 'all' ? 'on' : ''}`} onClick={() => setLogAgent('all')}>全部 <span className="cnt">{logRows.length}</span></button>{agentIds.map((id) => <button key={id} className={`cap-chip ${logAgent === id ? 'on' : ''}`} onClick={() => setLogAgent(id)}>{AGENT_NAMES[id]} <span className="cnt">{logCounts[id] || 0}</span></button>)}<span>日志来自当前扫描结果，不额外采集用户数据</span></div>
        <div className="cap-log-table">
          <div className="cap-log-row head"><span>时间</span><span>Agent</span><span>类型</span><span>能力</span><span>原因</span><span>错误码</span></div>
          {visibleLogRows.map((row) => <div key={row.id} className="cap-log-row"><span className="time">{result ? new Date(result.scannedAt).toLocaleTimeString() : '—'}</span><span>{AGENT_NAMES[row.agentId]}</span><span><i className={`cap-kind capability-kind k-${row.kind}`}>{KIND_NAMES[row.kind] || row.kind}</i></span><span className="name" title={row.name}>{row.name}<small title={row.origin}>{row.origin}</small></span><span className="reason">{row.issueCode ? ISSUE_NAMES[row.issueCode] : '扫描结果未提供具体原因'}</span><code>{row.issueCode || 'unknown'}</code></div>)}
          {!loading && visibleLogRows.length === 0 && <div className="cap-log-empty">{result ? '当前筛选下没有异常记录。' : '等待能力扫描完成。'}</div>}
        </div>
        <div className="cap-log-note">复制内容包含扫描时间、Agent、能力名称、状态、中文原因、错误码与来源位置，不包含 Skill 正文或凭据。</div>
      </> : view === 'inventory' ? <>
        <div className="cap-toolbar capability-toolbar">
          <label className="cap-search"><span className="mag"><UiIcon name="search" size={14} /></span><input aria-label="搜索工具能力" placeholder="搜索名称或来源…" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
          {kindChips(counts, inventoryItems.length, INVENTORY_KINDS)}
          {(['skill', 'mcp', 'plugin'] as BetaEditorKind[]).some((value) => canCreateBetaCapability(inventory, value)) && <div className="cap-create-actions">
            {(['skill', 'mcp', 'plugin'] as BetaEditorKind[]).filter((value) => canCreateBetaCapability(inventory, value)).map((value) => <button key={value} className="settings-mini-btn" data-capability-create={value} disabled={!!capabilityActionPending || editorPending || jobActive} onClick={() => openCreate(value)}><UiIcon name="plus" size={13}/>{value === 'skill' ? '新建 Skill' : value === 'mcp' ? '新增 MCP' : '安装插件'}</button>)}
          </div>}
          {selectableCount > 0 && <button className={`cap-ms-toggle ${multiSelect ? 'on' : ''}`} aria-pressed={multiSelect} onClick={toggleMultiSelect}><UiIcon name={multiSelect ? 'check' : 'checkbox'} size={13} />多选</button>}
        </div>
        {error && <div className="cap-sync-error">{error}</div>}
        {inventory?.message && <div className="settings-section-sub cap-inventory-message">{inventory.message}</div>}
        {inventory?.status === 'unsupported' && <div className="cap-sync-error">无法确认该 Agent 的目录布局，已关闭写操作；扫描结果不会被当作零项。</div>}
        {loading && !result && <div className="panel-loading"><div className="loading-spinner"/><span>正在扫描能力…</span></div>}
        <div className={`cap-grid capability-list ${multiSelect ? 'cap-ms' : ''}`}>{visible.map((item, index) => {
          const manageable = isManageable(item)
          const ownerPlugin = capabilityOwningPlugin(item, inventory?.items || [])
          const subtitle = capabilitySubtitle(item)
          const descText = item.entryPath || item.location || subtitle
          const skillKey = item.name.toLocaleLowerCase('en-US')
          const grouped = item.kind === 'skill' && (skillNameCounts.get(skillKey) || 0) > 1
          const groupStart = grouped && (index === 0 || visible[index - 1].kind !== 'skill' || visible[index - 1].name.toLocaleLowerCase('en-US') !== skillKey)
          const groupEnd = grouped && (index === visible.length - 1 || visible[index + 1].kind !== 'skill' || visible[index + 1].name.toLocaleLowerCase('en-US') !== skillKey)
          const pending = capabilityActionPending?.startsWith(item.id) === true
          const removing = removingIds.has(item.id)
          const selectable = multiSelect && item.kind !== 'plugin' && manageable
          const selected = selectable && selectedIds.has(item.id)
          // 需求2: 整卡可点击 → 打开详情抽屉。多选模式下整卡点击改为勾选，卸载图标隐藏。
          return <Fragment key={item.id}>
            {groupStart && <div className="cap-skill-group-label"><b>{item.name}</b><span>{skillNameCounts.get(skillKey)} 个来源</span></div>}
            <article className={`cap capability-row status-${item.status} ${manageable || item.migratableTo?.length ? '' : 'ro'} ${grouped ? 'grouped' : ''} ${item.kind === 'plugin' ? 'plugin-card' : ''} ${removing ? 'cap-removing' : ''} ${multiSelect ? 'cap-selectable' : ''} ${selected ? 'cap-selected' : ''}`} role={multiSelect ? (selectable ? 'checkbox' : undefined) : 'button'} tabIndex={multiSelect && !selectable ? undefined : 0} aria-checked={multiSelect && selectable ? selected : undefined} title={multiSelect ? (selectable ? '点击选择' : '该能力只读，不可批量卸载') : '点击查看详情'} aria-label={multiSelect ? `选择 ${item.name}` : `查看 ${item.name} 详情`} onClick={() => { if (multiSelect) toggleSelect(item); else openDetail(item) }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (multiSelect) toggleSelect(item); else openDetail(item) } }}>
              {multiSelect && <span className={`cap-check ${selectable ? '' : 'disabled'}`} aria-hidden="true"><UiIcon name="check" size={12} /></span>}
              <div className="cap-hd"><span className="cap-nm capability-name" title={item.name}>{item.name}</span><span className={`cap-kind capability-kind k-${item.kind}`}>{KIND_NAMES[item.kind] || item.kind}</span></div>
              <div className={`cap-desc ${item.location || item.entryPath ? 'cap-path' : ''}`} title={descText}>{item.linked ? '链接 ' : item.entryPath ? '位置 ' : ''}{descText}</div>
              {item.linked && <div className="cap-desc cap-path" title={item.manifestPath || item.location}>源文件 {item.manifestPath || item.location || '目标不存在或无法读取'}</div>}
              {item.kind === 'plugin' && item.components && <div className="cap-plugin-components">{Object.entries(item.components).filter(([, count]) => count > 0).map(([component, count]) => <span className="tag" key={component}>{COMPONENT_NAMES[component] || component} {count}</span>)}</div>}
              <div className="cap-foot"><span className={`tag scope scope-${item.scope}`}>{SCOPE_NAMES[item.scope] || item.scope}{item.linked ? '入口' : ''}</span>{item.linked && <span className="tag linked-tag" title="仅移除链接，不删除源 Skill">符号链接</span>}{item.enabled === false && <span className="capability-state">已停用</span>}{item.status !== 'available' && <span className={`capability-state ${item.status === 'shadowed' ? 'capability-covered' : 'cap-sync-danger'}`} title={INVENTORY_STATUS_NAMES[item.status]}>{INVENTORY_STATUS_NAMES[item.status]}</span>}{!multiSelect && <span className="cap-actions">
                {item.kind === 'plugin' && item.migratableTo?.map((target) => <button key={target} className="settings-mini-btn" disabled={!!capabilityActionPending} onClick={(event) => { event.stopPropagation(); void runPluginAction(item, 'migrate', target) }}>迁移到 {AGENT_NAMES[target]}</button>)}
                {item.kind === 'plugin' && manageable && <button className="settings-mini-btn cap-uninstall" disabled={!!capabilityActionPending} onClick={(event) => { event.stopPropagation(); void runPluginAction(item, 'uninstall') }}>卸载插件</button>}
                {item.kind !== 'plugin' && manageable && <button className="settings-mini-btn cap-uninstall" title={capabilityRemovalLabel(item)} aria-label={capabilityRemovalLabel(item)} disabled={jobActive || pending} onClick={(event) => { event.stopPropagation(); void removeItem(item) }}>{capabilityRemovalLabel(item)}</button>}
                {ownerPlugin && <button className="settings-mini-btn" onClick={event => { event.stopPropagation(); openDetail(ownerPlugin) }}>管理所属插件</button>}
              </span>}</div>
            </article>
            {groupEnd && <div className="cap-skill-group-end" />}
          </Fragment>
        })}</div>
        {!loading && visible.length === 0 && <div className="settings-section-sub">没有匹配的能力。</div>}
        {job && <section className="settings-section capability-job"><div className="settings-section-title">任务状态：{job.state}</div><div className="settings-section-sub">{job.stage || job.errorCode || '任务由主进程持有，离开页面不会丢失。'}</div>{job.progress && <div className="settings-section-sub">进度 {job.progress.completed} / {job.progress.total}</div>}{job.result && <div className="cap-sync-result">已验证 {job.result.verified} · 无变化 {job.result.noop} · 跳过 {job.result.skipped} · 失败 {job.result.failed} · 已回滚 {job.result.rolledBack}</div>}{job.state === 'completed' && <div className="settings-section-sub">静态验证完成，请重启目标 Agent 使配置生效。</div>}{CANCELLABLE.has(job.state) && <button className="settings-mini-btn" disabled={jobPending !== null} onClick={() => void cancelJob()}>{jobPending === 'cancel' ? '取消中…' : '取消'}</button>}{rollbackCandidate && <button className="settings-mini-btn" disabled={jobPending !== null || jobActive} onClick={() => void rollbackJob()}>{jobPending === 'rollback' ? '回滚中…' : rollbackCandidate.id === job.id ? '回滚此任务' : '回滚最近成功操作'}</button>}</section>}
      </> : <>
        <div className="capability-compare-head">
          <div className="cmp-side">{agentSelect(leftAgent, '选择来源 Agent', id => changeCompareAgent('left', id))}</div>
          <span className="cmp-arrow" aria-label="来源到目标" title="来源到目标"><UiIcon name="arrow-right" size={22} /></span>
          <div className="cmp-side">{agentSelect(rightAgent, '选择目标 Agent', id => changeCompareAgent('right', id))}</div>
        </div>
        <div className="cap-toolbar capability-toolbar"><label className="cap-search"><span className="mag"><UiIcon name="search" size={14} /></span><input aria-label="搜索对比能力" placeholder="搜索名称…" value={query} onChange={(event) => setQuery(event.target.value)}/></label>{kindChips(compareKindCounts, compareRows.length)}<span className="cap-chip capability-compare-toggle"><span>仅看差异</span><ToggleSwitch checked={onlyDiff} label="仅看差异" onChange={setOnlyDiff} /></span></div>
        {compareRows.length > 0 && <div className="capability-stats">{(['add','update','conflict','same','target-only','incompatible','invalid'] as CapabilityDiffStatus[]).filter((status) => compareCounts[status]).map((status) => <span key={status}>{(writablePair ? COMPARE_STATUS[status] : READONLY_STATUS[status] || COMPARE_STATUS[status])} {compareCounts[status]}</span>)}</div>}
        {compareError && <div className="cap-sync-error">{compareError}</div>}
        {writablePair && compareScan && !compareScan.executionSupported && <div className="cap-sync-error">已完成只读对比，但当前布局不可安全写入（{compareScan.blockedReason}），仅可查看差异。</div>}
        <div className="cmp-table capability-compare-list">
          <div className="cmp-tr hd"><span/><span>类型</span><span>名称</span><span>状态</span><span>{AGENT_NAMES[leftAgent]}</span><span>{AGENT_NAMES[rightAgent]}</span></div>
          {compareLoading && <div className="panel-loading"><div className="loading-spinner"/><span>正在对比…</span></div>}
          {compareVisible.map((row) => { const statusLabel = compareRowStatusLabel(row, writablePair); return <div key={row.id} className={`cmp-tr capability-compare-row status-${row.status} ${row.syncSelectable ? 'selectable' : ''} ${compareSelected.has(row.id) ? 'sel' : ''}`} role={row.syncSelectable ? 'checkbox' : undefined} aria-checked={row.syncSelectable ? compareSelected.has(row.id) : undefined} tabIndex={row.syncSelectable ? 0 : undefined} onClick={() => toggleCompare(row)} onKeyDown={(event) => { if (row.syncSelectable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleCompare(row) } }}>
            <span className={`row-check ${row.syncSelectable ? '' : 'disabled'}`} aria-hidden="true"><UiIcon name="check" size={11} /></span><span className={`cap-kind capability-kind k-${row.kind}`}>{KIND_NAMES[row.kind] || row.kind}</span><span className="cmp-name capability-name" title={row.name}><span className="nm">{row.name}</span>{row.kind === 'skill' && row.scope && <span className={`cmp-scope scope-${row.scope}`}>{COMPARE_SCOPE_NAMES[row.scope] || row.scope}</span>}{row.issueCode === 'credential_required' && <span title="凭据必需，不可搬运"><UiIcon name="lock" size={12} /></span>}</span><span className={`cap-sync-status status ${row.status}`} title={statusLabel}>● {statusLabel}</span><span className={`capability-compare-side side-mark ${row.inLeft ? 'side-yes' : 'side-no'}`}>{row.inLeft ? <UiIcon name="check" size={13} /> : <UiIcon name="minus" size={13} />}</span><span className={`capability-compare-side side-mark ${row.inRight ? 'side-yes' : 'side-no'}`}>{row.inRight ? <UiIcon name="check" size={13} /> : <UiIcon name="minus" size={13} />}</span>
          </div>})}
        </div>
        {!compareLoading && compareVisible.length === 0 && leftAgent !== rightAgent && <div className="settings-section-sub">没有匹配的能力。</div>}
      </>}
    </div>
    {view === 'inventory' && <div className={`cap-selbar cap-ms-bar ${multiSelect && selectedCount > 0 ? 'show' : ''}`}><b>已选 {selectedCount} 项</b><button className="cap-ms-all" onClick={() => setSelectedIds(new Set(inventoryItems.filter(isSelectable).map((item) => item.id)))}>全选可删</button><span className="spacer"/><button className="settings-mini-btn" onClick={exitMultiSelect}>取消</button><button className="settings-mini-btn cap-uninstall" disabled={selectedCount === 0 || jobActive || !!capabilityActionPending} onClick={() => void removeSelected()}><UiIcon name="trash" size={13} />删除选中 ({selectedCount})</button></div>}
    {view === 'compare' && <div className={`cap-selbar capability-compare-sync ${compareExecutionSupported && compareSyncCount > 0 ? 'show' : ''}`}><b>已选 {compareSyncCount} 项差异</b><span className="spacer"/><button className="settings-add-preset" disabled={!compareExecutionSupported || compareSyncCount === 0 || jobActive} onClick={syncCompare}>同步 {AGENT_NAMES[leftAgent]} → {AGENT_NAMES[rightAgent]} ({compareSyncCount})</button></div>}
    {detailItem && !editor && (() => {
      const manageable = isManageable(detailItem)
      const ownerPlugin = capabilityOwningPlugin(detailItem, inventory?.items || [])
      const pending = capabilityActionPending?.startsWith(detailItem.id) === true
      const manifest = detail?.manifestText ? parseManifest(detail.manifestText) : null
      const headerDesc = manifest?.description || capabilitySubtitle(detailItem)
      return <div className="cap-detail-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeDetail() }}>
        <aside className="cap-detail" role="dialog" aria-modal="true" aria-label={`${detailItem.name} 详情`}>
          <div className="cd-head">
            <div className="cd-head-top">
              <span className={`cap-kind capability-kind k-${detailItem.kind}`}>{KIND_NAMES[detailItem.kind] || detailItem.kind}</span>
              <span className="cd-head-spacer" />
              <button className="cd-x" aria-label="关闭详情" onClick={closeDetail}><UiIcon name="close" size={14} /></button>
            </div>
            <h2 className="cd-name" title={detailItem.name}>{detailItem.name}</h2>
            {headerDesc && <p className="cd-desc">{headerDesc}</p>}
            <div className="cd-meta">
              <span className="tag">{SCOPE_NAMES[detailItem.scope] || detailItem.scope}</span>
              <span className={`cd-status ${detailItem.status === 'available' ? 'ok' : detailItem.status === 'shadowed' ? 'covered' : 'bad'}`}><span className="dot" aria-hidden="true" /> {detailItem.status === 'available' && detailItem.kind === 'skill' ? '使用中' : detailItem.status === 'available' && detailItem.kind === 'plugin' ? '已安装' : INVENTORY_STATUS_NAMES[detailItem.status]}</span>
            </div>
            <div className="cd-origin" title={detailItem.origin}>{detailItem.origin}</div>
            {detailItem.entryPath && <dl className="cd-paths">
              {[[detailItem.linked ? '读取入口（符号链接）' : '读取位置', detailItem.entryPath], ['实际源目录', detailItem.location], ['原始指令文件', detailItem.manifestPath]].filter(([, path]) => path).map(([label, path]) => <div key={label}>
                <dt>{label}<button className="cd-copy-path" aria-label={`复制${label}`} onClick={() => void navigator.clipboard.writeText(path!).catch(() => setError('复制路径失败，请重试。'))}><UiIcon name="copy" size={12}/></button></dt><dd>{path}</dd>
              </div>)}
            </dl>}
            {detailItem.kind === 'plugin' && detailItem.components && <div className="cap-plugin-components detail-components">{Object.entries(detailItem.components).filter(([, count]) => count > 0).map(([component, count]) => <span className="tag" key={component}>{COMPONENT_NAMES[component] || component} {count}</span>)}</div>}
            <div className="cd-actions">
              {manageable && !detailItem.removal && (detailItem.agentId === 'kimi' && detailItem.kind === 'skill' || (detailItem.agentId === 'kimi' || detailItem.agentId === 'grok') && detailItem.kind === 'mcp') && <button className="settings-mini-btn" data-capability-edit disabled={pending || detailLoading || !detail?.manifestText} onClick={() => openEditor(detailItem)}>编辑</button>}
              {manageable && betaCapabilityStateRequest(detailItem, true) && <button className="settings-mini-btn" data-capability-state disabled={pending || detailLoading || jobActive} onClick={() => void runManagedState(detailItem, capabilityEnabled(detailItem, detail) ? 'disable' : 'enable')}>{pending ? '处理中…' : capabilityEnabled(detailItem, detail) ? '停用' : '启用'}</button>}
              {manageable && !detailItem.id.startsWith('deepseek:files:') && (detailItem.agentId === 'grok' || detailItem.agentId === 'deepseek') && detailItem.kind === 'plugin' && <button className="settings-mini-btn" data-capability-update disabled={pending || jobActive} onClick={() => detailItem.agentId === 'deepseek' ? openPluginUpdate(detailItem) : void runManagedState(detailItem, 'update')}>更新插件</button>}
              {detail?.openable && detail.folderPath && <button className="settings-mini-btn" onClick={() => { const folder = detail.folderPath!; closeDetail(); setBrowseFolder(folder) }}><UiIcon name="folder" size={13} /> 在文件浏览器中打开</button>}
              {detailItem.kind === 'plugin' && detailItem.migratableTo?.map((target) => <button key={target} className="settings-mini-btn" disabled={!!capabilityActionPending} onClick={() => void runPluginAction(detailItem, 'migrate', target)}>迁移到 {AGENT_NAMES[target]}</button>)}
              {detailItem.kind === 'plugin' && manageable && <button className="settings-mini-btn cap-detail-uninstall" disabled={!!capabilityActionPending} onClick={() => void runPluginAction(detailItem, 'uninstall')}>卸载插件</button>}
              {ownerPlugin && <button className="settings-mini-btn" onClick={() => openDetail(ownerPlugin)}>管理所属插件</button>}
              {detailItem.kind !== 'plugin' && manageable ? <button className="settings-mini-btn cap-detail-uninstall" disabled={jobActive || pending} onClick={() => uninstallFromDetail(detailItem)}>{capabilityRemovalLabel(detailItem)}</button> : detailItem.kind !== 'plugin' && <span className="cd-ro">{detailItem.readOnlyReason || (detailItem.issueCode ? ISSUE_NAMES[detailItem.issueCode] : '此能力由 Agent 或所属插件维护，无法单独删除。')}</span>}
              {detailItem.kind === 'plugin' && !manageable && !(detailItem.migratableTo?.length) && <span className="cd-ro">{detailItem.readOnlyReason || '当前 Agent 未提供可验证的插件卸载方式。'}</span>}
            </div>
          </div>
          <div className="cd-body">
            {error && <div className="cap-sync-error" role="alert">{error}</div>}
            {detailLoading && !detail ? <div className="panel-loading"><div className="loading-spinner"/><span>正在读取详情…</span></div> : <>
              {manifest && manifest.body.trim()
                ? (() => { const json = tryPrettyJson(manifest.body)
                    return json != null
                      ? <><div className="cd-section-h">{detail?.manifestFile || '清单'}</div><pre className="cd-code">{json}</pre></>
                      : <div className="cap-detail-md"><Markdown text={manifest.body} /></div> })()
                : !manifest && <div className="cap-detail-md"><p>{capabilitySubtitle(detailItem)}</p></div>}
              {detail?.files && detail.files.length > 0 && <>
                <div className="cd-section-h">文件<span className="cd-section-note"> · 点击「在文件浏览器中打开」查看完整目录</span></div>
                <div className="cd-files">{detail.files.map((file) => <div key={file.relativePath} className="cd-file"><UiIcon name={file.directory ? 'folder' : 'file'} size={13} /><span className="fnm">{file.relativePath}{file.directory ? '/' : ''}</span>{file.size != null && !file.directory && <span className="fsize">{formatFileSize(file.size)}</span>}</div>)}</div>
              </>}
            </>}
          </div>
        </aside>
      </div>
    })()}
    {editor && <div className="cap-detail-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeEditor() }}>
      <aside className="cap-detail" role="dialog" aria-modal="true" aria-label={`${editor.item ? editor.kind === 'plugin' ? '更新' : '编辑' : '新增'}${KIND_NAMES[editor.kind]}`} aria-busy={editorPending || undefined} onKeyDown={(event) => { if (event.key === 'Escape') closeEditor() }}>
        <div className="cd-head">
          <div className="cd-head-top"><span className={`cap-kind k-${editor.kind}`}>{KIND_NAMES[editor.kind]}</span><span className="cd-head-spacer"/><button className="cd-x" aria-label="关闭编辑" disabled={editorPending} onClick={closeEditor}><UiIcon name="close" size={14}/></button></div>
          <h2 className="cd-name">{editor.item ? `${editor.kind === 'plugin' ? '更新' : '编辑'} ${editor.item.name}` : editor.kind === 'skill' ? '新建 Skill' : editor.kind === 'mcp' ? '新增 MCP' : '安装插件'}</h2>
          <p className="cd-desc">{AGENT_NAMES[editor.agentId]} · {editor.item ? editor.kind === 'plugin' ? `当前版本 ${editor.item.version || '未知'}。更新后将重新读取能力清单。` : '修改当前用户级能力。' : '保存后将在能力清单中显示。'}</p>
          <div className="cd-meta"><span className="tag">用户级</span></div>
        </div>
        <div className="cd-body"><form id="capability-management-form" className="cap-management-form" onSubmit={(event) => { event.preventDefault(); void saveEditor() }}>
          <label className="cap-management-field"><span>{editor.kind === 'plugin' ? editor.item ? '目标版本（可选）' : editor.agentId === 'deepseek' ? 'npm 插件包' : '插件来源' : '名称'}</span><input data-capability-name autoFocus autoComplete="off" spellCheck={false} disabled={editorPending} readOnly={!!editor.item && editor.kind !== 'plugin'} value={editor.name} placeholder={editor.kind === 'plugin' ? editor.agentId === 'deepseek' ? '@scope/plugin@1.2.3' : 'owner/plugin 或 HTTPS 地址' : 'my-capability'} onChange={(event) => { const name = event.target.value; setEditor((current) => current && { ...current, name, ...(!current.item && current.kind === 'skill' ? { text: current.text.replace(/^name:.*$/m, `name: ${name}`) } : {}) }) }}/>{editor.item && <small>{editor.kind === 'plugin' ? '留空升级到最新版；指定版本需填写当前插件的 npm 包名和精确版本。' : '编辑时名称保持不变。'}</small>}</label>
          {editor.kind !== 'plugin' && <label className="cap-management-field"><span>{editor.kind === 'skill' ? 'SKILL.md' : 'MCP 配置（JSON）'}</span><textarea data-capability-config rows={16} disabled={editorPending} spellCheck={false} value={editor.text} onChange={(event) => setEditor((current) => current && { ...current, text: event.target.value })}/><small>{editor.kind === 'skill' ? '请填写完整技能文档，包含 name 和 description。' : editor.item ? '保留 [redacted] 即保留原值；填写新值可替换。' : '填写 command / args，或选择 HTTP / SSE 并填写 url。'}</small></label>}
          {editor.kind === 'plugin' && <p className="cap-management-note">{editor.item ? '更新保留当前插件的选择与启停状态。若插件已发生变化，请重新扫描后再操作。' : <>{editor.agentId === 'deepseek' ? '支持公共 npm 包名称及版本。' : '支持仓库短名称或 HTTPS 仓库地址。'}插件可添加 Skills、MCP 与 Hooks。请确认你信任此来源后安装。</>}</p>}
          {editor.error && <div className="cap-sync-error" role="alert">{editor.error}</div>}
        </form></div>
        <div className="cap-management-actions"><button className="settings-mini-btn" disabled={editorPending} onClick={closeEditor}>取消</button><button className="settings-mini-btn primary" data-capability-save type="submit" form="capability-management-form" disabled={editorPending || !editor.name.trim() && !(editor.kind === 'plugin' && editor.item)}>{editorPending ? '处理中…' : editor.kind === 'plugin' ? editor.item ? '更新插件' : '安装插件' : editor.item ? '保存更改' : '创建'}</button></div>
      </aside>
    </div>}
    {browseFolder && <FileBrowser sessionId="" workdir="" rootPath={browseFolder} onClose={() => setBrowseFolder(null)} />}
    {confirmPrompt && <div className="cap-confirm-overlay" role="presentation" onClick={(event) => { if (!confirmPrompt.pending && event.target === event.currentTarget) answerConfirm(false) }}>
      <div className="cap-confirm" role="alertdialog" aria-modal="true" aria-labelledby={confirmPrompt.title ? 'cap-confirm-title' : undefined} aria-describedby="cap-confirm-message" aria-busy={confirmPrompt.pending || undefined} onKeyDown={(event) => { if (event.key === 'Escape' && !confirmPrompt.pending) answerConfirm(false) }}>
        {confirmPrompt.title && <div className="cap-confirm-title" id="cap-confirm-title">{confirmPrompt.title}</div>}
        <p className="cap-confirm-msg" id="cap-confirm-message">{confirmPrompt.message}</p>
        {confirmPrompt.impact && <div className="cap-confirm-impact"><b>受影响 Agent</b><span>{confirmPrompt.impact}</span></div>}
        {confirmPrompt.error && <div className="cap-confirm-error" role="alert">{confirmPrompt.error}</div>}
        <div className="cap-confirm-actions">
          {confirmPrompt.error ? <button className="settings-mini-btn" onClick={() => answerConfirm(false)} autoFocus>知道了</button> : <>
            <button className="settings-mini-btn" disabled={confirmPrompt.pending} onClick={() => answerConfirm(false)}>取消</button>
            <button className={`settings-mini-btn ${confirmPrompt.danger ? 'cap-confirm-danger' : 'cap-confirm-primary'}`} disabled={confirmPrompt.pending} onClick={() => answerConfirm(true)} autoFocus>{confirmPrompt.pending && <span className="si-spinner" aria-hidden />}{confirmPrompt.pending ? `${confirmPrompt.confirmLabel || '确认'}中…` : confirmPrompt.confirmLabel || '确认'}</button>
          </>}
        </div>
      </div>
    </div>}
  </div>
}

/**
 * Split a SKILL.md manifest into its YAML frontmatter fields and the Markdown
 * body (头部重设计). When the text opens with a `---` fenced frontmatter block we
 * pull out `name` / `description` and hand back only the body for Markdown
 * rendering; otherwise everything falls through as `body` unchanged so
 * non-standard manifests still render whole.
 */
function parseManifest(text: string): { name?: string; description?: string; body: string } {
  const match = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  if (!match) return { body: text }
  const front = match[1]
  const field = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(front)
    if (!m) return undefined
    const raw = m[1].trim()
    return raw.replace(/^["']|["']$/g, '').trim() || undefined
  }
  return { name: field('name'), description: field('description'), body: text.slice(match[0].length) }
}

/** Pretty-print a manifest body when it is really JSON (e.g. plugin.json),
 *  so it renders as readable code instead of mangled Markdown. */
function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch { return null }
}

/** Compact human-readable byte size for the Skill detail file list. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
