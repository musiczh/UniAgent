import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MAX_SKILL_MANIFEST_BYTES, secureRegularText } from './capability-sync/skillDiscovery.ts'
import type { CapabilityAgentInventory, CapabilityInventoryDetail, CapabilityInventoryItem } from '../shared/capabilitySync.ts'

type JsonRecord = Record<string, unknown>
type Entry = { item: CapabilityInventoryItem; publicMetadata: JsonRecord; native: JsonRecord }
const PHASES = ['pending', 'loading', 'active', 'failed', 'unloading']
const SOURCES = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'custom', 'bundled', 'runtime']
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, maximum = 500): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
const identifier = (value: unknown): value is string => text(value, 200) && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const opaqueId = (kind: string, identity: unknown): string => `deepseek:${kind}:${digest(identity).slice(0, 24)}`

export interface DeepSeekInventoryDetailOptions {
  /** All roots come from trusted main-process runtime configuration, never the raw inventory or renderer. */
  home?: string
  cwd?: string
  projectRoot?: string
  dshHome?: string
  agentsHome?: string
  customSkillDirs?: readonly string[]
  bundledSkillDirs?: readonly string[]
}

function localized(value: unknown): string | undefined {
  const candidate = record(value) ? value.en : value
  return text(candidate, 2_000) ? candidate : undefined
}

function moduleLabel(value: string): string {
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') {
      const name = decodeURIComponent(basename(url.pathname))
      if (identifier(name)) return name
    }
  } catch { /* Unsupported module specifiers get a fixed public label. */ }
  return 'Native plugin'
}

function pluginMetadata(value: JsonRecord): JsonRecord {
  if (!text(value.moduleName, 8_192) ||
      (value.enabled !== true && value.enabled !== false && value.enabled !== 'conditional') ||
      (value.fiberPhase !== null && !PHASES.includes(value.fiberPhase as string))) throw new Error('invalid')
  const meta = record(value.meta) ? value.meta : {}
  return {
    module: moduleLabel(value.moduleName),
    ...(localized(meta.title) ? { title: localized(meta.title) } : {}),
    ...(localized(meta.description) ? { description: localized(meta.description) } : {}),
    enabled: value.enabled, phase: value.fiberPhase
  }
}

function makeEntry(
  kind: CapabilityInventoryItem['kind'], name: string, identity: unknown,
  publicMetadata: JsonRecord, native: JsonRecord, extras: Partial<CapabilityInventoryItem> = {}
): Entry {
  return {
    item: {
      id: opaqueId(kind, identity), agentId: 'deepseek', kind, name, scope: 'builtin', origin: `DeepSeek ${kind}`,
      owner: 'system', fingerprint: digest(publicMetadata), manageable: false, copyable: false, status: 'available', ...extras
    }, publicMetadata, native
  }
}

function snapshot(raw: unknown): { inventory: CapabilityAgentInventory; entries: Entry[] } {
  try {
    if (!record(raw) || !Array.isArray(raw.skills) || !Array.isArray(raw.tools) || !Array.isArray(raw.commands) ||
        !record(raw.plugins) || !Array.isArray(raw.plugins.entries) ||
        (raw.plugins.agentPresets !== undefined && !Array.isArray(raw.plugins.agentPresets))) throw new Error('invalid')
    const entries: Entry[] = []
    for (const value of raw.skills) {
      if (!record(value) || !identifier(value.name) || !record(value.invocation) ||
          typeof value.invocation.modelInvocable !== 'boolean' || typeof value.invocation.userInvocable !== 'boolean') throw new Error('invalid')
      if (!value.invocation.modelInvocable && !value.invocation.userInvocable) continue
      const source = SOURCES.includes(value.source as string) ? value.source as string : 'runtime'
      const scope = source === 'user-agents' ? 'shared' : source === 'bundled' || source === 'runtime' ? 'builtin' : 'agent'
      const publicMetadata = {
        name: value.name, source,
        ...(text(value.description, 4_000) ? { description: value.description } : {}),
        ...(text(value.whenToUse, 4_000) ? { whenToUse: value.whenToUse } : {}),
        invocation: { modelInvocable: value.invocation.modelInvocable, userInvocable: value.invocation.userInvocable }
      }
      entries.push(makeEntry('skill', value.name, [source, value.name], publicMetadata, value, {
        source, scope, owner: scope === 'shared' ? 'shared' : scope === 'builtin' ? 'system' : 'user', origin: `${source} skill`
      }))
    }
    // Tool schemas are already filtered by the actual native agent and its role.
    for (const [kind, values] of [['tool', raw.tools], ['command', raw.commands]] as const) {
      for (const value of values) {
        if (!record(value) || !identifier(value.name) ||
            (kind === 'command' && !text(value.definitionId, 2_000))) throw new Error('invalid')
        const publicMetadata = { name: value.name, ...(text(value.description, 4_000) ? { description: value.description } : {}) }
        entries.push(makeEntry(kind, value.name, value.name, publicMetadata, value))
      }
    }
    for (const value of raw.plugins.entries) {
      if (!record(value) || !text(value.entryId, 2_000) || typeof value.enabled !== 'boolean') throw new Error('invalid')
      const publicMetadata = pluginMetadata(value)
      entries.push(makeEntry('plugin', (publicMetadata.title || publicMetadata.module) as string, value.entryId, publicMetadata, value, {
        scope: 'plugin', owner: 'plugin', origin: 'DeepSeek native plugin',
        manageable: raw.plugins.managementAvailable === true && value.manageable !== false && value.readOnlyReason === undefined,
        source: `${value.enabled ? 'enabled' : 'disabled'}${value.fiberPhase ? ` · ${value.fiberPhase}` : ''}`,
        ...(value.fiberPhase === 'failed' ? { status: 'invalid', issueCode: 'plugin_enumeration_failed' } : {})
      }))
    }
    for (const value of (raw.plugins.agentPresets || []) as unknown[]) {
      if (!record(value) || !text(value.id, 2_000) || !Array.isArray(value.rows) || typeof value.isDefault !== 'boolean') throw new Error('invalid')
      const rows = value.rows.map(row => {
        if (!record(row) || (row.entryId !== null && !text(row.entryId, 2_000))) throw new Error('invalid')
        return pluginMetadata(row)
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      const name = text(value.name, 200) ? value.name : 'Native agent preset'
      const publicMetadata = { name, isDefault: value.isDefault, broken: value.broken !== undefined, plugins: rows }
      entries.push(makeEntry('agent-profile', name, value.id, publicMetadata, value, {
        origin: 'DeepSeek agent preset', source: value.isDefault ? 'default' : 'preset',
        ...(value.broken !== undefined ? { status: 'invalid', issueCode: 'plugin_enumeration_failed' } : {})
      }))
    }
    entries.sort((a, b) => a.item.kind.localeCompare(b.item.kind) || a.item.name.localeCompare(b.item.name) || a.item.id.localeCompare(b.item.id))
    if (new Set(entries.map(entry => entry.item.id)).size !== entries.length) throw new Error('invalid')
    const items = entries.map(entry => entry.item)
    const inventory: CapabilityAgentInventory = {
      agentId: 'deepseek', available: true, writable: items.some(item => item.manageable), status: 'available',
      managementSupported: raw.plugins.managementAvailable === true,
      revision: digest(items), items
    }
    return { inventory, entries }
  } catch {
    return {
      inventory: { agentId: 'deepseek', available: true, writable: false, status: 'invalid',
        managementSupported: false,
        issueCode: 'unsupported_provider_layout', revision: digest('invalid'), items: [] }, entries: []
    }
  }
}

/** Project only public native SDK fields; raw configurations and diagnostic strings stay in main. */
export function projectDeepSeekInventory(raw: unknown): CapabilityAgentInventory {
  return snapshot(raw).inventory
}

/** Main-only lookup for native workercontrols; an opaque renderer id is never used as a Loader id. */
export function resolveDeepSeekPluginEntryId(id: string, raw: unknown): string | undefined {
  const entry = snapshot(raw).entries.find(value => value.item.id === id && value.item.kind === 'plugin' && value.item.manageable)
  return entry?.native.entryId as string | undefined
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

async function nearestProject(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    try { await lstat(join(current, '.git')); return current } catch { /* Match native filesystem discovery. */ }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function trustedSkillFile(native: JsonRecord, options: DeepSeekInventoryDetailOptions): Promise<{ path: string; anchor: string } | undefined> {
  if (!text(native.path, 8_192) || !isAbsolute(native.path) || basename(native.path) !== 'SKILL.md') return undefined
  const home = resolve(options.home || homedir()), cwd = resolve(options.cwd || process.cwd())
  const project = resolve(options.projectRoot || await nearestProject(cwd))
  const dshHome = resolve(options.dshHome || join(home, '.dsh')), agentsHome = resolve(options.agentsHome || join(home, '.agents'))
  const anchored = (base: string, root: string) => ({ root, anchor: inside(home, base) ? home : base })
  const roots = native.source === 'user-dsh' ? [anchored(dshHome, join(dshHome, 'skills'))]
    : native.source === 'user-agents' ? [anchored(agentsHome, join(agentsHome, 'skills'))]
    : native.source === 'project-dsh' ? [{ root: join(project, '.dsh', 'skills'), anchor: project }]
    : native.source === 'project-agents' ? [{ root: join(project, '.agents', 'skills'), anchor: project }]
    : native.source === 'custom' ? (options.customSkillDirs || []).map(root => anchored(resolve(root), resolve(root)))
    : native.source === 'bundled' ? (options.bundledSkillDirs || []).map(root => anchored(resolve(root), resolve(root))) : []
  const path = resolve(native.path)
  for (const allowed of roots) {
    try {
      const info = await lstat(allowed.anchor)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      // Canonicalize only a trusted base; secureRegularText rejects every child symlink.
      const anchor = await realpath(allowed.anchor), after = await lstat(allowed.anchor)
      if (after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino) continue
      const canonicalRoot = join(anchor, relative(allowed.anchor, allowed.root))
      if (inside(allowed.root, path)) return { path: join(anchor, relative(allowed.anchor, path)), anchor }
      if (inside(canonicalRoot, path)) return { path, anchor }
    } catch { /* Ignore missing or unsafe configured roots. */ }
  }
  return undefined
}

/** Resolve the current opaque item before reading a source-specific trusted Skill root. */
export async function getDeepSeekInventoryDetail(
  id: string, raw: unknown, options: DeepSeekInventoryDetailOptions = {}
): Promise<CapabilityInventoryDetail | undefined> {
  const entry = snapshot(raw).entries.find(value => value.item.id === id)
  if (!entry) return undefined
  const detail: CapabilityInventoryDetail = { id, name: entry.item.name, kind: entry.item.kind, openable: false }
  if (entry.item.kind !== 'skill') return { ...detail,
    manifestText: JSON.stringify(entry.publicMetadata, null, 2), manifestFile: `${entry.item.kind}.json` }
  const safe = await trustedSkillFile(entry.native, options)
  if (!safe) return { ...detail, manifestText: JSON.stringify(entry.publicMetadata, null, 2), manifestFile: 'skill.json' }
  try {
    detail.manifestText = await secureRegularText(safe.path, safe.anchor, MAX_SKILL_MANIFEST_BYTES)
    detail.manifestFile = basename(safe.path)
    const folder = dirname(safe.path), folderBefore = await lstat(folder)
    const files: NonNullable<CapabilityInventoryDetail['files']> = []
    const values = await readdir(folder, { withFileTypes: true })
    for (const value of values.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)) {
      if (value.name.startsWith('.') || value.isSymbolicLink() || !text(value.name, 500)) continue
      const info = await lstat(join(folder, value.name))
      if (info.isFile() || info.isDirectory()) files.push({ relativePath: value.name, directory: info.isDirectory(),
        ...(info.isFile() ? { size: info.size } : {}) })
    }
    const folderAfter = await lstat(folder)
    if (folderBefore.dev !== folderAfter.dev || folderBefore.ino !== folderAfter.ino) return detail
    await secureRegularText(safe.path, safe.anchor, MAX_SKILL_MANIFEST_BYTES)
    return { ...detail, files, folderPath: folder, openable: true }
  } catch { return detail }
}
