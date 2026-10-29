import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  CapabilityAgentId, CapabilityAgentInventory, CapabilityInventoryItem, CapabilityInventoryResult,
  CapabilityInventoryDetail, CapabilityDetailFile
} from '../../shared/capabilitySync.ts'
import { assertSafePathChain, discoverProvider } from './provider.ts'
import {
  applySkillPrecedence, discoverSkillRoot, secureManifest, secureRegularText, type SkillDiscovery
} from './skillDiscovery.ts'
import {
  capabilityPluginInventoryId, discoverInstalledPlugins, discoverPluginCatalog, nativePluginCommandRunner,
  type DiscoveredPlugin, type PluginCommandRunner
} from './plugins.ts'
import { inspectGrokInventory, type GrokInventoryOptions } from '../grokInventory.ts'

type FileInventoryAgentId = 'codex' | 'traex' | 'claude'
const AGENTS: FileInventoryAgentId[] = ['codex', 'traex', 'claude']
const COMMANDS = [
  ['compact', true], ['goal', true], ['review', true], ['new', true], ['diff', false],
  ['init', false], ['plan', true], ['model', true], ['status', true]
] as const
const BUILTIN_TOOLS = [
  'uniagent_task',
  'uniagent_query',
  'send_to_feishu'
]

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const itemId = (agentId: CapabilityAgentId, scope: string, kind: string, identity: string): string =>
  `${agentId}:${scope}:${kind}:${digest(identity).slice(0, 24)}`
export const managedInventoryId = (agentId: 'codex' | 'traex', canonicalId: string): string =>
  itemId(agentId, 'agent', 'managed', canonicalId)

function roots(agentId: FileInventoryAgentId, home: string): { root: string; skills: string } {
  if (agentId === 'codex') return { root: join(home, '.codex'), skills: join(home, '.codex/skills') }
  if (agentId === 'traex') return { root: join(home, '.trae'), skills: join(home, '.trae/skills') }
  return { root: join(home, '.claude'), skills: join(home, '.claude/skills') }
}

type InventorySkill = CapabilityInventoryItem & { source?: string; plugin?: string; version?: string }

function discoveryItem(agentId: CapabilityAgentId, item: SkillDiscovery, dependentAgents?: CapabilityAgentId[]): InventorySkill {
  const origin = item.scope === 'shared' ? 'shared' : `${agentId} user directory`
  return {
    id: itemId(agentId, item.scope, 'skill', item.identity), agentId, kind: 'skill', name: item.name, scope: item.scope, origin,
    owner: item.scope === 'agent' ? 'user' : item.scope, fingerprint: item.fingerprint,
    manageable: !!item.linkPath || item.status === 'available' && (item.scope === 'shared' || agentId === 'claude' && item.scope === 'agent'), copyable: false,
    location: item.manifest ? dirname(item.manifest) : item.targetPath && item.linkPath?.endsWith('/SKILL.md') ? dirname(item.targetPath) : item.targetPath,
    entryPath: item.entryPath || item.linkPath,
    manifestPath: item.manifest || (item.targetPath ? item.linkPath?.endsWith('/SKILL.md') ? item.targetPath : join(item.targetPath, 'SKILL.md') : undefined),
    removal: item.linkPath ? 'link' : item.status === 'available' ? 'skill' : undefined,
    status: item.status, issueCode: item.issueCode, source: item.source, plugin: item.plugin, version: item.version, linked: item.linked,
    ...(dependentAgents?.length ? { dependentAgents } : {})
  }
}

function pluginItem(plugin: DiscoveredPlugin): InventorySkill {
  return {
    id: capabilityPluginInventoryId(plugin.agentId, plugin.pluginId), agentId: plugin.agentId, kind: 'plugin', name: plugin.displayName || plugin.name,
    scope: 'plugin', origin: plugin.marketplace, owner: 'plugin', fingerprint: plugin.fingerprint,
    manageable: (plugin.agentId !== 'claude' || plugin.scope === 'user') && plugin.issueCode !== 'plugin_enumeration_failed', copyable: false,
    location: plugin.installedDir,
    manifestPath: plugin.manifestPath, enabled: plugin.enabled,
    status: plugin.status, issueCode: plugin.issueCode, pluginId: plugin.pluginId, marketplace: plugin.marketplace,
    version: plugin.version, cachedVersions: plugin.cachedVersions, components: plugin.components,
    migratableTo: plugin.migratableTo || []
  }
}

function applyInventoryPrecedence(items: InventorySkill[]): InventorySkill[] {
  const seen = new Set<string>()
  return items.map((item) => {
    if (item.kind !== 'skill' || item.status !== 'available') return item
    const key = item.name.toLocaleLowerCase('en-US')
    if (seen.has(key)) return { ...item, status: 'shadowed', issueCode: 'shadowed_capability' }
    seen.add(key)
    return item
  })
}

async function claudeMcpItems(home: string): Promise<{ items: CapabilityInventoryItem[]; invalid: boolean }> {
  const config = join(home, '.claude.json')
  if (!existsSync(config)) return { items: [], invalid: false }
  try {
    const parsed = JSON.parse(await secureRegularText(config, home, 2 * 1024 * 1024)) as { mcpServers?: unknown }
    if (parsed.mcpServers == null) return { items: [], invalid: false }
    if (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) return { items: [], invalid: true }
    return { items: Object.entries(parsed.mcpServers).map(([name, value]) => ({
      id: itemId('claude', 'agent', 'mcp', `claude:mcp:${name}`), agentId: 'claude', kind: 'mcp', name, scope: 'agent',
      origin: 'Claude user config', owner: 'user', fingerprint: digest(JSON.stringify(value)),
      manageable: false, copyable: false, status: 'available'
    })), invalid: false }
  } catch { return { items: [], invalid: true } }
}

function builtinItems(agentId: CapabilityAgentId): CapabilityInventoryItem[] {
  const commands = COMMANDS.filter(([, streaming]) => agentId !== 'claude' || !streaming).map(([name]) => ({
    id: itemId(agentId, 'builtin', 'command', name), agentId, kind: 'command' as const, name, scope: 'builtin' as const,
    origin: `${agentId} native command`, owner: 'system' as const, fingerprint: digest(`command:${name}`), manageable: false, copyable: false, status: 'available' as const
  }))
  const mcp: CapabilityInventoryItem = { id: itemId(agentId, 'builtin', 'mcp', 'uniagent-handoff'), agentId, kind: 'mcp',
    name: 'uniagent-handoff', scope: 'builtin', origin: 'UniAgent', owner: 'system', fingerprint: digest(BUILTIN_TOOLS.join('\0')),
    manageable: false, copyable: false, status: 'available' }
  const tools = BUILTIN_TOOLS.map((name) => ({ id: itemId(agentId, 'builtin', 'tool', name), agentId, kind: 'tool' as const, name,
    scope: 'builtin' as const, origin: 'uniagent-handoff', owner: 'system' as const, fingerprint: digest(`tool:${name}`),
    manageable: false, copyable: false, status: 'available' as const }))
  return [...commands, mcp, ...tools]
}

function revisionIdentity(item: InventorySkill): string {
  return JSON.stringify({ id: item.id, kind: item.kind, name: item.name, scope: item.scope, origin: item.origin, owner: item.owner,
    status: item.status, issueCode: item.issueCode || '', fingerprint: item.fingerprint, source: item.source || '',
    plugin: item.plugin || '', version: item.version || '', linked: item.linked || false, pluginId: item.pluginId || '',
    cachedVersions: item.cachedVersions || 0, components: item.components, migratableTo: item.migratableTo || [],
    dependentAgents: item.dependentAgents || [] })
}

type SkillLinkDependency = { agentId: CapabilityAgentId; linkPath: string }
/** Index only links actually exposed by each supported Agent's Skill scanner. */
export async function skillLinkDependencies(home: string, availableAgents: readonly string[] = AGENTS): Promise<Map<string, SkillLinkDependency[]>> {
  const index = new Map<string, SkillLinkDependency[]>()
  const add = async (agentId: CapabilityAgentId, linkPath?: string): Promise<void> => {
    if (!linkPath) return
    try {
      if (!(await lstat(linkPath)).isSymbolicLink()) return
      const target = await realpath(linkPath)
      index.set(target, [...(index.get(target) || []), { agentId, linkPath }])
    } catch { /* stale or unsafe links are not dependencies */ }
  }
  for (const [agentId, root] of [
    ['codex', join(home, '.codex/skills')],
    ['traex', join(home, '.trae/skills')],
    ['traex', join(home, '.trae/cli/skills')],
    ['claude', roots('claude', home).skills]
  ] as const) {
    if (!availableAgents.includes(agentId)) continue
    try {
      await assertSafePathChain(root, home)
      const rootInfo = await lstat(root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && entry.isSymbolicLink()) await add(agentId, join(root, entry.name))
      }
    } catch { /* missing or unsafe Agent roots have no removable dependencies */ }
  }
  return index
}

export async function listCapabilityInventories(
  home: string,
  pluginRunner: PluginCommandRunner = nativePluginCommandRunner,
  grok?: GrokInventoryOptions & { bin: string },
  availableAgents: readonly string[] = AGENTS
): Promise<CapabilityInventoryResult> {
  const agents = AGENTS.filter(id => availableAgents.includes(id))
  const sharedRoot = join(home, '.agents/skills')
  const sharedDiscoveries = await discoverSkillRoot(home, sharedRoot, 'shared')
  const dependencyIndex = await skillLinkDependencies(home, availableAgents)
  const dependentAgents = new Map<string, CapabilityAgentId[]>()
  for (const item of sharedDiscoveries) if (item.manifest && !item.linked) {
    try {
      const links = dependencyIndex.get(await realpath(dirname(item.manifest))) || []
      dependentAgents.set(item.identity, agents.filter((agentId) => agentId !== 'claude' || links.some((link) => link.agentId === agentId)))
    } catch { /* invalid shared items stay read-only */ }
  }
  const inventories: CapabilityAgentInventory[] = []
  const plugins = await discoverPluginCatalog(home, pluginRunner)
  for (const agentId of agents) {
    const paths = roots(agentId, home)
    const available = existsSync(paths.root)
    const visibleSharedDiscoveries = agentId === 'claude' ? [] : sharedDiscoveries
    let items: InventorySkill[] = []
    let status: CapabilityAgentInventory['status'] = available ? 'available' : 'unsupported'
    let issueCode: CapabilityAgentInventory['issueCode']
    let revisionParts: string[] = []
    // 需求4: the "支持管理"(writable) badge and per-item manageability track the
    // provider's own layoutKnown, NOT the aggregate status. A shared/plugin extra
    // going `invalid` must taint only its own row — it may not demote the whole
    // agent to read-only (which previously flipped every user skill to 只读).
    let layoutWritable = false
    if (agentId === 'claude') {
      const localDiscoveries = await discoverSkillRoot(home, paths.skills, 'agent')
      const claudeMcp = await claudeMcpItems(home)
      items = [...applySkillPrecedence([localDiscoveries, visibleSharedDiscoveries]).map((item) => discoveryItem(agentId, item, dependentAgents.get(item.identity))), ...claudeMcp.items]
      if (claudeMcp.invalid) { status = 'invalid'; issueCode = 'invalid_mcp_schema' }
    } else {
      const discovered = await discoverProvider(agentId, home)
      status = discovered.layoutKnown ? 'available' : 'unsupported'
      issueCode = discovered.layoutKnown ? undefined : 'unsupported_provider_layout'
      layoutWritable = discovered.layoutKnown
      revisionParts = [discovered.revision]
      const managed: InventorySkill[] = discovered.items.filter((entry) => entry.kind === 'skill' || entry.kind === 'mcp').map((entry) => ({
        id: managedInventoryId(agentId, entry.id), agentId, kind: entry.kind, name: entry.name, scope: 'agent', origin: `${agentId} user directory`, owner: entry.owner,
        fingerprint: entry.fingerprint, manageable: discovered.layoutKnown && entry.owner === 'user' && (entry.compatible || !!entry.linked),
        copyable: discovered.layoutKnown && entry.owner === 'user' && entry.compatible, linked: entry.linked,
        location: entry.kind === 'skill' ? entry.privateRef : undefined,
        entryPath: entry.kind === 'skill' ? entry.privateRef : undefined,
        manifestPath: entry.kind === 'skill' && entry.privateRef ? join(entry.privateRef, 'SKILL.md') : undefined,
        status: !entry.issueCode && (entry.compatible || entry.linked) ? 'available' : 'invalid', issueCode: entry.issueCode
      }))
      const extras = visibleSharedDiscoveries.map((item) => discoveryItem(agentId, item, dependentAgents.get(item.identity)))
      items = applyInventoryPrecedence([...managed, ...extras])
    }
    for (const item of items) if (item.kind === 'skill' && item.linked && item.entryPath) {
      try {
        const actual = await realpath(item.entryPath)
        if (basename(item.entryPath) === 'SKILL.md') { item.location = dirname(actual); item.manifestPath = actual }
        else { item.location = actual; item.manifestPath = join(actual, 'SKILL.md') }
      } catch { /* Preserve a dangling entry for removal. */ }
    }
    if (agentId === 'codex') {
      const system = await discoverSkillRoot(home, join(paths.skills, '.system'), 'agent')
      items.push(...system.map(value => ({ ...discoveryItem(agentId, value), scope: 'builtin' as const,
        owner: 'system' as const, manageable: false, removal: undefined, readOnlyReason: 'Codex 内置技能，由 Agent 安装和更新维护。' })))
    }
    items = [...items, ...(plugins.get(agentId) || []).map(pluginItem), ...builtinItems(agentId)]
    const identityParts = items.map(revisionIdentity).sort()
    inventories.push({ agentId, available, writable: layoutWritable || items.some(item => item.manageable), status,
      ...(issueCode ? { issueCode } : {}), revision: digest([...revisionParts, ...identityParts].sort().join('\0')), items })
  }
  if (grok) inventories.push(await inspectGrokInventory(grok.bin, grok.cwd, grok.env, grok.runner))
  return { inventories, scannedAt: Date.now() }
}

/** Reconstruct the opaque id -> absolute skill folder mapping without retaining state. */
async function skillFolderIndex(home: string, availableAgents: readonly string[] = AGENTS): Promise<Map<string, { folder: string; manifest: string; kind: 'skill' | 'plugin'; name: string }>> {
  const index = new Map<string, { folder: string; manifest: string; kind: 'skill' | 'plugin'; name: string }>()
  const agents = AGENTS.filter(id => availableAgents.includes(id))
  const sharedRoot = join(home, '.agents/skills')
  const record = (agentId: CapabilityAgentId, item: SkillDiscovery): void => {
    if (!item.manifest) return
    index.set(itemId(agentId, item.scope, 'skill', item.identity), { folder: dirname(item.manifest), manifest: item.manifest, kind: 'skill', name: item.name })
  }
  for (const agentId of agents) {
    const paths = roots(agentId, home)
    const sharedDiscoveries = agentId === 'claude' ? [] : await discoverSkillRoot(home, sharedRoot, 'shared')
    for (const item of sharedDiscoveries) record(agentId, item)
    if (agentId === 'claude') {
      for (const item of await discoverSkillRoot(home, paths.skills, 'agent')) record(agentId, item)
    } else {
      const discovered = await discoverProvider(agentId, home)
      for (const entry of discovered.items) {
        if (entry.kind !== 'skill' || !entry.privateRef) continue
        index.set(managedInventoryId(agentId, entry.id), { folder: entry.privateRef, manifest: join(entry.privateRef, 'SKILL.md'), kind: 'skill', name: entry.name })
      }
    }
    for (const plugin of await discoverInstalledPlugins(agentId, home)) {
      if (plugin.installedDir && plugin.manifestPath) index.set(capabilityPluginInventoryId(agentId, plugin.pluginId), {
        folder: plugin.installedDir, manifest: plugin.manifestPath, kind: 'plugin', name: plugin.displayName || plugin.name
      })
    }
  }
  return index
}

const MAX_DETAIL_FILES = 200

/** Full detail for one opaque inventory id: SKILL.md text + shallow file listing. */
export async function getCapabilityInventoryDetail(home: string, id: string, availableAgents: readonly string[] = AGENTS): Promise<CapabilityInventoryDetail> {
  const target = (await skillFolderIndex(home, availableAgents)).get(id)
  if (!target) return { id, name: '', kind: 'skill', openable: false }
  let manifestText: string | undefined
  let manifestFile: string | undefined
  try {
    manifestText = target.kind === 'plugin'
      ? await secureRegularText(target.manifest, home, 2 * 1024 * 1024)
      : (await secureManifest(target.manifest, home)).text
    manifestFile = basename(target.manifest)
  } catch { /* manifest may be missing or unsafe; still list the folder */ }
  let files: CapabilityDetailFile[] | undefined
  let openable = false
  try {
    const entries = await readdir(target.folder, { withFileTypes: true })
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name))
    const collected: CapabilityDetailFile[] = []
    for (const entry of entries.slice(0, MAX_DETAIL_FILES)) {
      if (entry.name.startsWith('.')) continue
      const directory = entry.isDirectory()
      let size: number | undefined
      if (entry.isFile()) { try { size = (await stat(join(target.folder, entry.name))).size } catch { /* ignore */ } }
      collected.push({ relativePath: entry.name, directory, ...(size == null ? {} : { size }) })
    }
    files = collected
    openable = true
  } catch { /* folder unreadable */ }
  return { id, name: target.name, kind: target.kind, manifestText, manifestFile, files, folderPath: openable ? target.folder : undefined, openable }
}
