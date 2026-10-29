import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeFileSync
} from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import TOML from '@iarna/toml'
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml'
import type {
  CapabilityAgentInventory, CapabilityInventoryDetail, CapabilityInventoryItem, CapabilityIssueCode
} from '../shared/capabilitySync.ts'
import {
  AtomicFsError, atomicRemoveIdentitySync, atomicRenameExclusiveSync, helperAvailable
} from './capability-sync/atomicFs.ts'
import { MAX_SKILL_MANIFEST_BYTES, secureManifest, secureRegularText } from './capability-sync/skillDiscovery.ts'

const MAX_CONFIG = 2 * 1024 * 1024
const REDACTED = '[redacted]'
type JsonRecord = Record<string, unknown>
type Source = 'user' | 'shared' | 'project' | 'project-root' | 'extra' | 'plugin' | 'builtin'
export interface KimiSkillRoot { path: string; plugin?: string; rootSkillOnly?: boolean }
export interface KimiInventoryOptions {
  home?: string
  kimiHome?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Additional roots supplied by a trusted main-process adapter, never renderer paths. */
  pluginSkillRoots?: KimiSkillRoot[]
  builtinSkillRoots?: string[]
}
interface Paths { home: string; kimiHome: string; cwd: string; project: string }
interface Root { path: string; anchor: string; source: Source; plugin?: string; rootSkillOnly?: boolean }
interface Entry {
  item: CapabilityInventoryItem
  manifest?: string
  text?: string
  flat?: boolean
  root?: Root
  mcp?: JsonRecord
}
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const inside = (base: string, path: string): boolean => {
  const rel = relative(base, path)
  return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
const canonical = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
function paths(options: KimiInventoryOptions): Paths {
  const env = options.env ?? process.env
  const logicalHome = resolve(options.home ?? env.HOME ?? homedir()), home = canonical(logicalHome)
  const logicalCwd = resolve(options.cwd ?? process.cwd()), cwd = canonical(logicalCwd)
  let kimiHome = resolve(cwd, options.kimiHome ?? (env.KIMI_CODE_HOME?.trim() || join(home, '.kimi-code')))
  // macOS /var and /tmp aliases may differ from the canonical fixture/home paths.
  if (inside(logicalHome, kimiHome)) kimiHome = join(home, relative(logicalHome, kimiHome))
  else if (inside(logicalCwd, kimiHome)) kimiHome = join(cwd, relative(logicalCwd, kimiHome))
  let project = cwd
  for (let cursor = cwd; ; cursor = dirname(cursor)) {
    try { lstatSync(join(cursor, '.git')); project = cursor; break } catch { /* Continue upward. */ }
    if (dirname(cursor) === cursor) break
  }
  return { home, kimiHome, cwd, project }
}
function root(paths: Paths, path: string, source: Source, extras: Partial<Root> = {}): Root {
  const absolute = resolve(path)
  const anchor = inside(paths.home, absolute) ? paths.home : inside(paths.project, absolute) ? paths.project : absolute
  return { path: absolute, anchor, source, ...extras }
}
function inventoryItem(source: Source, kind: 'skill' | 'mcp', identity: string, name: string, fingerprint: string,
  extras: Partial<CapabilityInventoryItem> = {}): CapabilityInventoryItem {
  const scope = source === 'user' ? 'agent' : source === 'builtin' ? 'builtin' : source === 'plugin' ? 'plugin' : 'shared'
  return {
    id: `kimi:${scope}:${kind}:${hash(identity).slice(0, 24)}`, agentId: 'kimi', kind, name, scope,
    origin: `Kimi ${source}`, owner: source === 'user' ? 'user' : source === 'builtin' ? 'system' : source === 'plugin' ? 'plugin' : 'shared',
    fingerprint, manageable: false, copyable: false, status: 'available', source, ...extras
  }
}

function parseSkill(text: string, fallback: string, directory: boolean): { name: string; subskills: boolean } {
  if (Buffer.byteLength(text) > MAX_SKILL_MANIFEST_BYTES) throw new Error('skill_file_too_large')
  const lines = text.split(/\r?\n/)
  let metadata: JsonRecord = {}
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end < 0) throw new Error('kimi_invalid_skill')
    let parsed: unknown
    try { parsed = loadYaml(lines.slice(1, end).join('\n'), { schema: JSON_SCHEMA }) } catch { throw new Error('kimi_invalid_skill') }
    if (!record(parsed)) throw new Error('kimi_invalid_skill')
    metadata = parsed
  } else if (directory) throw new Error('kimi_invalid_skill')
  if (metadata.type != null && !['prompt', 'inline', 'flow'].includes(String(metadata.type))) throw new Error('kimi_unsupported_skill')
  const name = label(metadata.name) ? metadata.name.trim() : fallback
  const description = metadata.description
  if (!label(name) || directory && (!label(metadata.name) || typeof description !== 'string' || !description.trim() || description.length > MAX_SKILL_MANIFEST_BYTES)) throw new Error('kimi_invalid_skill')
  const nested = record(metadata.metadata) ? metadata.metadata : {}
  return { name, subskills: metadata['has-sub-skill'] === true || metadata.hasSubSkill === true || nested['has-sub-skill'] === true || nested.hasSubSkill === true }
}

/** Kimi's native layout differs from the Codex scanner: flat files and opted-in subskills. */
async function discoverRoot(root: Root, writable: boolean): Promise<Entry[]> {
  const found: Entry[] = []
  let rootPath: string, anchor: string, linkedRoot: boolean
  try {
    rootPath = await realpath(root.path); anchor = await realpath(root.anchor)
    if (!inside(anchor, rootPath)) throw new Error('unsafe_skill_root')
    linkedRoot = rootPath !== root.path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return [{ item: inventoryItem(root.source, 'skill', `${root.source}:${root.path}:root`, 'Skills', hash('unsafe_skill_root'), { status: 'invalid', issueCode: 'unsafe_skill_root', plugin: root.plugin }) }]
  }
  const visited = new Set<string>()
  const register = async (manifest: string, fallback: string, flat: boolean, parent?: string): Promise<{ name: string; subskills: boolean } | undefined> => {
    const identity = `${root.source}:${root.plugin ?? ''}:${root.path}:${relative(root.path, manifest)}`
    let linked = linkedRoot
    try {
      const actual = await realpath(manifest)
      linked ||= actual !== manifest
      if (!inside(anchor, actual)) throw new Error('unsafe_skill_entry')
      const info = await lstat(actual)
      const value = await secureManifest(actual, anchor)
      const parsed = parseSkill(value.text, fallback, !flat)
      const name = parent && parsed.name !== parent && !parsed.name.startsWith(parent + '.') ? `${parent}.${parsed.name}` : parsed.name
      found.push({ item: inventoryItem(root.source, 'skill', identity, name, value.fingerprint, {
        manageable: root.source === 'user' && writable && !linked && info.nlink === 1,
        linked: linked || undefined, location: flat ? undefined : dirname(actual), plugin: root.plugin
      }), manifest: actual, text: value.text, flat, root })
      return { ...parsed, name }
    } catch (error) {
      const message = (error as Error).message
      const issueCode: CapabilityIssueCode = message === 'skill_file_too_large' ? message : 'unsafe_skill_entry'
      found.push({ item: inventoryItem(root.source, 'skill', identity, fallback, hash(`${identity}:${message}`), {
        status: message === 'kimi_unsupported_skill' ? 'unsupported' : 'invalid',
        issueCode: message === 'kimi_unsupported_skill' ? 'unsupported_provider_layout' : issueCode,
        linked: linked || undefined, plugin: root.plugin
      }), root })
      return undefined
    }
  }
  const walk = async (dir: string, depth: number, parent?: string): Promise<void> => {
    if (depth > 8) return
    let actualDir: string
    try {
      actualDir = await realpath(dir)
      if (!inside(anchor, actualDir) || visited.has(actualDir)) return
      visited.add(actualDir)
      if (!(await lstat(actualDir)).isDirectory()) return
    } catch { return }
    if (root.rootSkillOnly) { await register(join(dir, 'SKILL.md'), basename(dir), false); return }
    const entries = (await readdir(actualDir, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name))
    const bundles = new Set<string>(), subdirs: string[] = [], parents = new Map<string, string>()
    for (const entry of entries) {
      const path = join(dir, entry.name)
      try {
        const actual = await realpath(path)
        if (!(await lstat(actual)).isDirectory()) continue
        subdirs.push(entry.name)
        try {
          await lstat(join(path, 'SKILL.md')); bundles.add(entry.name)
        } catch { /* Namespace directory has no manifest. */ }
      } catch { if (entry.isSymbolicLink()) await register(join(path, 'SKILL.md'), entry.name, false, parent) }
    }
    for (const name of bundles) {
      const skill = await register(join(dir, name, 'SKILL.md'), name, false, parent)
      if (skill?.subskills) parents.set(name, skill.name)
    }
    if (depth === 0) {
      if (root.plugin) { try { await lstat(join(dir, 'SKILL.md')); await register(join(dir, 'SKILL.md'), basename(dir), false) } catch { /* Optional. */ } }
      for (const entry of entries) if (entry.name.endsWith('.md') && entry.name !== 'SKILL.md' && !bundles.has(entry.name.slice(0, -3))) {
        await register(join(dir, entry.name), entry.name.slice(0, -3), true)
      }
    }
    for (const name of subdirs) if (!bundles.has(name) || parents.has(name)) await walk(join(dir, name), depth + 1, parents.get(name) ?? parent)
  }
  await walk(root.path, 0)
  return found
}

function normalizeMcp(value: unknown): JsonRecord {
  if (!record(value)) throw new Error('kimi_invalid_mcp')
  const transport = value.transport ?? (typeof value.command === 'string' ? 'stdio' : typeof value.url === 'string' ? 'http' : undefined)
  if (!['stdio', 'http', 'sse'].includes(String(transport))) throw new Error('kimi_invalid_mcp')
  const output: JsonRecord = { transport }
  const strings = transport === 'stdio' ? ['command', 'cwd', 'runtime_id'] : ['url', 'bearerTokenEnvVar']
  for (const key of strings) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || (key !== 'cwd' && !(value[key] as string).length) || (value[key] as string).includes('\0')) throw new Error('kimi_invalid_mcp')
    output[key] = value[key]
  }
  if (transport === 'stdio' && !output.command || transport !== 'stdio' && !output.url) throw new Error('kimi_invalid_mcp')
  if (output.url) { try { new URL(String(output.url)) } catch { throw new Error('kimi_invalid_mcp') } }
  for (const key of ['enabled', 'deferred']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') throw new Error('kimi_invalid_mcp'); output[key] = value[key]
  }
  for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) if (value[key] !== undefined) {
    if (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 2147483647) throw new Error('kimi_invalid_mcp'); output[key] = value[key]
  }
  for (const key of ['enabledTools', 'disabledTools', ...(transport === 'stdio' ? ['args'] : [])]) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((item) => typeof item === 'string' && !item.includes('\0'))) throw new Error('kimi_invalid_mcp')
    output[key] = value[key]
  }
  for (const key of transport === 'stdio' ? ['env'] : ['headers']) if (value[key] !== undefined) {
    if (!record(value[key]) || !Object.values(value[key] as JsonRecord).every((item) => typeof item === 'string' && !item.includes('\0'))) throw new Error('kimi_invalid_mcp')
    output[key] = value[key]
  }
  if (value.executor !== undefined && transport === 'stdio') {
    if (value.executor !== 'local' && value.executor !== 'kaos') throw new Error('kimi_invalid_mcp'); output.executor = value.executor
  }
  if (value.auth !== undefined && transport !== 'stdio') {
    if (value.auth !== 'oauth') throw new Error('kimi_invalid_mcp'); output.auth = value.auth
  }
  return output
}

/** Only endpoint origins, transport metadata, and secret key names leave main. */
export function redactKimiMcp(config: JsonRecord): JsonRecord {
  const output: JsonRecord = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === 'env' || key === 'headers') output[key] = record(value) ? Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED])) : REDACTED
    else if (key === 'command' || key === 'cwd' || key === 'runtime_id') output[key] = REDACTED
    else if (key === 'args') output[key] = Array.isArray(value) ? value.map(() => REDACTED) : REDACTED
    else if (key === 'url') {
      try { const url = new URL(String(value)); output[key] = url.origin === 'null' ? REDACTED : `${url.origin}/${REDACTED}` } catch { output[key] = REDACTED }
    } else if (['transport', 'enabled', 'deferred', 'startupTimeoutMs', 'toolTimeoutMs', 'enabledTools', 'disabledTools', 'bearerTokenEnvVar', 'auth', 'executor'].includes(key)) output[key] = value
  }
  return output
}

async function mcpEntries(path: string, root: Root, writable: boolean, direct?: JsonRecord): Promise<Entry[]> {
  let servers: JsonRecord
  let regularUserFile = false
  try {
    if (direct) servers = direct
    else {
      const text = await secureRegularText(path, root.anchor, MAX_CONFIG)
      regularUserFile = (await lstat(path)).nlink === 1
      const data: unknown = text.trim() ? JSON.parse(text) : {}
      if (!record(data) || data.mcpServers !== undefined && !record(data.mcpServers)) throw new Error('kimi_invalid_mcp')
      servers = record(data.mcpServers) ? data.mcpServers : {}
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return [{ item: inventoryItem(root.source, 'mcp', `${root.source}:${path}:invalid`, 'MCP configuration', hash('invalid_mcp_schema'), { status: 'invalid', issueCode: 'invalid_mcp_schema', plugin: root.plugin }) }]
  }
  return Object.entries(servers).map(([name, value]) => {
    try {
      if (!label(name)) throw new Error('kimi_invalid_mcp')
      const mcp = normalizeMcp(value)
      return { item: inventoryItem(root.source, 'mcp', `${root.source}:${root.plugin ?? ''}:${path}:${name}`, name, hash(JSON.stringify(mcp)), {
        manageable: root.source === 'user' && writable && regularUserFile, plugin: root.plugin,
        source: `${root.source}${mcp.enabled === false ? ' · disabled' : ''}`
      }), mcp, root }
    } catch {
      return { item: inventoryItem(root.source, 'mcp', `${root.source}:${path}:${name}`, label(name) ? name : 'Invalid MCP', hash('invalid_mcp_schema'), {
        status: 'invalid', issueCode: 'invalid_mcp_schema', plugin: root.plugin
      }), root }
    }
  })
}

async function scan(options: KimiInventoryOptions): Promise<{ inventory: CapabilityAgentInventory; entries: Entry[]; paths: Paths }> {
  const p = paths(options)
  let writable = helperAvailable()
  try { captureChain(p.kimiHome, true) } catch { writable = false }
  const roots: Root[] = [root(p, join(p.project, '.kimi-code/skills'), 'project'), root(p, join(p.project, '.agents/skills'), 'project'),
    root(p, join(p.kimiHome, 'skills'), 'user'), root(p, join(p.home, '.agents/skills'), 'shared')]
  let configIssue: CapabilityIssueCode | undefined
  try {
    const config = TOML.parse(await secureRegularText(join(p.kimiHome, 'config.toml'), root(p, p.kimiHome, 'user').anchor, MAX_CONFIG))
    if (Array.isArray(config.extra_skill_dirs)) for (const value of config.extra_skill_dirs) {
      if (typeof value !== 'string') { configIssue = 'invalid_toml'; continue }
      roots.push(root(p, value === '~' ? p.home : value.startsWith('~/') ? join(p.home, value.slice(2)) : resolve(p.project, value), 'extra'))
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') configIssue = 'invalid_toml' }
  const pluginMcps: Entry[] = []
  try {
    const installed: unknown = JSON.parse(await secureRegularText(join(p.kimiHome, 'plugins/installed.json'), root(p, p.kimiHome, 'user').anchor, MAX_CONFIG))
    if (!record(installed) || !Array.isArray(installed.plugins)) throw new Error('invalid_plugin')
    for (const value of installed.plugins) {
      if (!record(value) || value.enabled !== true || !label(value.id) || typeof value.root !== 'string' || !isAbsolute(value.root)) continue
      const pluginRoot = root(p, value.root, 'plugin', { plugin: value.id })
      let manifest: unknown
      for (const name of ['kimi.plugin.json', '.kimi-plugin/plugin.json']) {
        try { manifest = JSON.parse(await secureRegularText(join(value.root, name), pluginRoot.anchor, MAX_CONFIG)); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      if (!record(manifest) || !label(manifest.name)) continue
      if (Array.isArray(manifest.skills)) for (const dir of manifest.skills) {
        if (typeof dir !== 'string' || !inside(value.root, resolve(value.root, dir))) continue
        roots.push(root(p, resolve(value.root, dir), 'plugin', { plugin: value.id }))
      } else {
        try { await lstat(join(value.root, 'SKILL.md')); roots.push({ ...pluginRoot, rootSkillOnly: true }) } catch { /* Optional fallback. */ }
      }
      if (record(manifest.mcpServers)) {
        const servers = Object.fromEntries(Object.entries(manifest.mcpServers).map(([name, config]) => [`plugin-${value.id}:${name}`, config]))
        pluginMcps.push(...await mcpEntries(join(value.root, 'kimi.plugin.json'), pluginRoot, false, servers))
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') configIssue ??= 'plugin_manifest_invalid' }
  for (const provided of options.pluginSkillRoots ?? []) roots.push(root(p, provided.path, 'plugin', { plugin: provided.plugin, rootSkillOnly: provided.rootSkillOnly }))
  for (const path of options.builtinSkillRoots ?? []) roots.push(root(p, path, 'builtin'))
  const entries: Entry[] = []
  const seenRoots = new Set<string>()
  for (const value of roots) {
    const key = `${value.source}:${value.plugin ?? ''}:${value.path}`
    if (!seenRoots.has(key)) { seenRoots.add(key); entries.push(...await discoverRoot(value, writable)) }
  }
  entries.push(...await mcpEntries(join(p.cwd, '.kimi-code/mcp.json'), root(p, p.cwd, 'project'), false),
    ...await mcpEntries(join(p.project, '.mcp.json'), root(p, p.project, 'project-root'), false),
    ...await mcpEntries(join(p.kimiHome, 'mcp.json'), root(p, p.kimiHome, 'user'), writable), ...pluginMcps)
  const seen = new Set<string>()
  for (const entry of entries) if (entry.item.status === 'available') {
    const key = `${entry.item.kind}:${entry.item.kind === 'skill' ? entry.item.name.toLowerCase() : entry.item.name}`
    if (seen.has(key)) { entry.item.status = 'shadowed'; entry.item.issueCode = 'shadowed_capability' } else seen.add(key)
  }
  const items = entries.map((entry) => entry.item).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const issueCode = configIssue ?? items.find((item) => item.status === 'invalid')?.issueCode
  const inventory: CapabilityAgentInventory = {
    agentId: 'kimi', available: true, writable, status: issueCode ? 'invalid' : 'available', ...(issueCode ? { issueCode } : {}),
    revision: hash(JSON.stringify(items)), items
  }
  return { inventory, entries, paths: p }
}

export async function inspectKimiInventory(options: KimiInventoryOptions = {}): Promise<CapabilityAgentInventory> {
  return (await scan(options)).inventory
}

export async function getKimiInventoryDetail(id: string, options: KimiInventoryOptions = {}): Promise<CapabilityInventoryDetail | undefined> {
  const entry = (await scan(options)).entries.find((candidate) => candidate.item.id === id)
  if (!entry) return undefined
  const detail: CapabilityInventoryDetail = { id, name: entry.item.name, kind: entry.item.kind, openable: false }
  if (entry.mcp) return { ...detail, manifestText: JSON.stringify(redactKimiMcp(entry.mcp), null, 2), manifestFile: 'mcp.json' }
  if (!entry.manifest || entry.text === undefined) return detail
  detail.manifestText = entry.text; detail.manifestFile = basename(entry.manifest)
  if (entry.flat || entry.item.linked) return detail
  const folder = dirname(entry.manifest)
  try {
    captureChain(folder)
    detail.files = (await readdir(folder, { withFileTypes: true })).filter((entry) => !entry.isSymbolicLink()).slice(0, 200).map((entry) => ({ relativePath: entry.name, directory: entry.isDirectory() }))
    detail.folderPath = folder; detail.openable = true
  } catch { /* Text detail remains useful when browsing is unsafe. */ }
  return detail
}

type Chain = Array<{ path: string; dev: bigint; ino: bigint }>
/** Mutation validation is synchronous through native publish, so there is no JavaScript await race. */
function captureChain(path: string, missing = false): Chain {
  const absolute = resolve(path), output: Chain = []
  let cursor: string = sep
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try {
      const info = lstatSync(cursor, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('kimi_unsafe_path')
      output.push({ path: cursor, dev: info.dev, ino: info.ino })
    } catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') break; throw new Error('kimi_unsafe_path') }
  }
  return output
}
function verifyChain(chain: Chain): void {
  for (const expected of chain) {
    const actual = lstatSync(expected.path, { bigint: true })
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('kimi_unsafe_path')
  }
}
function ensureDirectory(path: string): void {
  const chain = captureChain(path, true); verifyChain(chain)
  let cursor = chain.at(-1)?.path ?? sep
  for (const part of relative(cursor, resolve(path)).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try { mkdirSync(cursor, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    captureChain(cursor)
  }
}
function readUserFile(path: string): { text: string; info: ReturnType<typeof lstatSync> } {
  const chain = captureChain(dirname(path)); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_SKILL_MANIFEST_BYTES) throw new Error('kimi_unsafe_path')
    const text = readFileSync(fd, 'utf8'); verifyChain(chain)
    const current = lstatSync(path)
    if (current.dev !== info.dev || current.ino !== info.ino || current.isSymbolicLink()) throw new Error('kimi_unsafe_path')
    return { text, info }
  } finally { closeSync(fd) }
}
function removePath(path: string): void {
  const chain = captureChain(dirname(path)); const parent = lstatSync(dirname(path), { bigint: true }), entry = lstatSync(path, { bigint: true })
  verifyChain(chain)
  try { atomicRemoveIdentitySync(dirname(path), basename(path), { dev: parent.dev, ino: parent.ino, mode: Number(parent.mode & 0o777n) }, entry) }
  catch (error) { if (!(error instanceof AtomicFsError && error.applied)) throw error }
}
function publish(path: string, text: string, expectedText?: string): void {
  if (!helperAvailable()) throw new Error('atomic_fs_unavailable')
  ensureDirectory(dirname(path)); const chain = captureChain(dirname(path))
  const temp = join(dirname(path), `.ua-kimi-${randomUUID()}`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  let backup: string | undefined
  try {
    verifyChain(chain)
    const parent = lstatSync(dirname(path), { bigint: true })
    const parentIdentity = { dev: parent.dev, ino: parent.ino, mode: Number(parent.mode & 0o777n) }
    if (expectedText !== undefined) {
      if (readUserFile(path).text !== expectedText) throw new Error('kimi_stale_inventory')
      backup = join(dirname(path), `.ua-kimi-backup-${randomUUID()}`)
      const current = lstatSync(path, { bigint: true })
      atomicRenameExclusiveSync(dirname(path), basename(path), basename(backup), parentIdentity, { ...current, type: 'file' })
      if (readUserFile(backup).text !== expectedText) throw new Error('kimi_stale_inventory')
    }
    const stage = lstatSync(temp, { bigint: true }); verifyChain(chain)
    atomicRenameExclusiveSync(dirname(path), basename(temp), basename(path), parentIdentity, { ...stage, type: 'file' })
    if (backup) removePath(backup)
  } catch (error) {
    if (backup) {
      try {
        const info = lstatSync(backup, { bigint: true }), parent = lstatSync(dirname(path), { bigint: true })
        atomicRenameExclusiveSync(dirname(path), basename(backup), basename(path), { dev: parent.dev, ino: parent.ino, mode: Number(parent.mode & 0o777n) }, { ...info, type: 'file' })
      } catch { /* Retain the private backup if an external writer occupied the destination. */ }
    }
    if ((error as AtomicFsError).code === 'atomic_fs_destination_exists') throw new Error('kimi_already_exists')
    throw error
  } finally { try { unlinkSync(temp) } catch { /* Already published. */ } }
}
function safeName(name: unknown): asserts name is string {
  if (!label(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === 'node_modules') throw new Error('kimi_invalid_request')
}
async function mutable(id: string, fingerprint: string, options: KimiInventoryOptions): Promise<{ entry: Entry; paths: Paths }> {
  const result = await scan(options), entry = result.entries.find((value) => value.item.id === id)
  if (!entry) throw new Error('kimi_invalid_request')
  if (entry.item.owner !== 'user' || entry.item.linked || !entry.item.manageable) throw new Error('kimi_read_only')
  if (entry.item.fingerprint !== fingerprint) throw new Error('kimi_stale_inventory')
  captureChain(result.paths.kimiHome)
  return { entry, paths: result.paths }
}
export async function createKimiSkill(request: { name: string; manifestText: string }, options: KimiInventoryOptions = {}): Promise<CapabilityInventoryItem> {
  safeName(request.name)
  let parsed: ReturnType<typeof parseSkill>
  try { parsed = parseSkill(request.manifestText, request.name, true) } catch { throw new Error('kimi_invalid_skill') }
  const result = await scan(options), destination = join(result.paths.kimiHome, 'skills', request.name, 'SKILL.md')
  captureChain(result.paths.kimiHome, true)
  if (result.entries.some((entry) => entry.item.kind === 'skill' && entry.item.owner === 'user' && [request.name.toLowerCase(), parsed.name.toLowerCase()].includes(entry.item.name.toLowerCase()))) throw new Error('kimi_already_exists')
  try { lstatSync(join(result.paths.kimiHome, 'skills', request.name + '.md')); throw new Error('kimi_already_exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { lstatSync(dirname(destination)); throw new Error('kimi_already_exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  publish(destination, request.manifestText)
  const created = (await scan(options)).entries.find((entry) => entry.manifest === destination)
  if (!created) throw new Error('kimi_invalid_skill')
  return created.item
}
export async function updateKimiSkill(request: { id: string; expectedFingerprint: string; manifestText: string }, options: KimiInventoryOptions = {}): Promise<CapabilityInventoryItem> {
  const { entry } = await mutable(request.id, request.expectedFingerprint, options)
  if (!entry.manifest || entry.item.kind !== 'skill') throw new Error('kimi_invalid_request')
  let parsed: ReturnType<typeof parseSkill>
  try { parsed = parseSkill(request.manifestText, basename(entry.manifest, '.md'), !entry.flat) } catch { throw new Error('kimi_invalid_skill') }
  const entries = (await scan(options)).entries
  if (entries.some((candidate) => candidate.item.id !== request.id && candidate.item.kind === 'skill' && candidate.item.owner === 'user' && candidate.item.name.toLowerCase() === parsed.name.toLowerCase())) throw new Error('kimi_already_exists')
  publish(entry.manifest, request.manifestText, entry.text)
  return (await scan(options)).entries.find((value) => value.item.id === request.id)!.item
}
function mcpDocument(p: Paths): { path: string; text?: string; value: JsonRecord; servers: JsonRecord } {
  const path = join(p.kimiHome, 'mcp.json'); captureChain(p.kimiHome, true)
  let text: string | undefined
  try { lstatSync(path); text = readUserFile(path).text } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('kimi_unsafe_path')
  }
  let value: unknown = {}
  if (text?.trim()) { try { value = JSON.parse(text) } catch { throw new Error('kimi_invalid_mcp') } }
  if (!record(value) || value.mcpServers !== undefined && !record(value.mcpServers)) throw new Error('kimi_invalid_mcp')
  const servers = record(value.mcpServers) ? value.mcpServers : {}
  for (const config of Object.values(servers)) normalizeMcp(config)
  return { path, text, value, servers }
}
function retainRedacted(value: unknown, previous: unknown): unknown {
  if (value === REDACTED) { if (previous === undefined) throw new Error('kimi_invalid_mcp'); return previous }
  if (Array.isArray(value)) return value.map((item, index) => retainRedacted(item, Array.isArray(previous) ? previous[index] : undefined))
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, retainRedacted(nested, record(previous) ? previous[key] : undefined)]))
  return value
}
export async function upsertKimiMcp(request: { name: string; config: unknown; expectedFingerprint?: string }, options: KimiInventoryOptions = {}): Promise<CapabilityInventoryItem> {
  safeName(request.name)
  const p = paths(options), document = mcpDocument(p), previous = document.servers[request.name]
  if (previous !== undefined && hash(JSON.stringify(normalizeMcp(previous))) !== request.expectedFingerprint || previous === undefined && request.expectedFingerprint !== undefined) throw new Error('kimi_stale_inventory')
  const submitted = record(request.config) ? { ...request.config } : request.config
  if (record(submitted) && record(previous) && typeof submitted.url === 'string' && typeof previous.url === 'string' &&
      submitted.url === redactKimiMcp(previous).url) submitted.url = previous.url
  const config = normalizeMcp(retainRedacted(submitted, previous))
  const previousFields = record(previous) ? normalizeMcp(previous) : {}
  const preserved = record(previous) ? Object.fromEntries(Object.entries(previous).filter(([key]) =>
    !(key in previousFields) || config.transport === 'stdio' && (key === 'cwd' || key === 'runtime_id'))) : {}
  document.value.mcpServers = { ...document.servers, [request.name]: { ...preserved, ...config } }
  publish(document.path, JSON.stringify(document.value, null, 2) + '\n', document.text)
  return (await scan(options)).entries.find((entry) => entry.item.kind === 'mcp' && entry.item.owner === 'user' && entry.item.name === request.name)!.item
}
export async function deleteKimiCapability(request: { id: string; expectedFingerprint: string }, options: KimiInventoryOptions = {}): Promise<void> {
  const { entry, paths: p } = await mutable(request.id, request.expectedFingerprint, options)
  if (entry.item.kind === 'skill' && entry.manifest) {
    if (hash(readUserFile(entry.manifest).text) !== request.expectedFingerprint) throw new Error('kimi_stale_inventory')
    removePath(entry.flat ? entry.manifest : dirname(entry.manifest)); return
  }
  if (entry.item.kind !== 'mcp') throw new Error('kimi_invalid_request')
  const document = mcpDocument(p), value = document.servers[entry.item.name]
  if (!value || hash(JSON.stringify(normalizeMcp(value))) !== request.expectedFingerprint) throw new Error('kimi_stale_inventory')
  delete document.servers[entry.item.name]; document.value.mcpServers = document.servers
  publish(document.path, JSON.stringify(document.value, null, 2) + '\n', document.text)
}

export async function setKimiMcpEnabled(request: { id: string; expectedFingerprint: string; enabled: boolean }, options: KimiInventoryOptions = {}): Promise<void> {
  if (typeof request.enabled !== 'boolean') throw new Error('kimi_invalid_request')
  const { entry, paths: p } = await mutable(request.id, request.expectedFingerprint, options)
  if (entry.item.kind !== 'mcp') throw new Error('kimi_invalid_request')
  const document = mcpDocument(p), value = document.servers[entry.item.name]
  if (!record(value) || hash(JSON.stringify(normalizeMcp(value))) !== request.expectedFingerprint) throw new Error('kimi_stale_inventory')
  document.value.mcpServers = { ...document.servers, [entry.item.name]: { ...value, enabled: request.enabled } }
  publish(document.path, JSON.stringify(document.value, null, 2) + '\n', document.text)
}
