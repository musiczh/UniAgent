import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import * as TOML from '@iarna/toml'
import type { CapabilityIssueCode, CapabilityProviderId } from '../../shared/capabilitySync.ts'
import type { CanonicalCapability, Inventory } from './planner.ts'
import { semanticHash } from './planner.ts'

export interface ProviderPaths {
  root: string
  skills: string
  config: string
  memories: string[]
  agents: string
  layoutKnown: boolean
}

export type TomlRecord = Record<string, unknown>
export interface McpBlock {
  /** Safe stable display label; the arbitrary TOML key remains privateKey. */
  name: string
  privateKey: string
  body: string
  rawBody: string
  secretShape: string[]
  /** Backwards-compatible alias; internal only and never sent to renderer. */
  secretFields: string[]
  value: TomlRecord
}

const MEMORY_NAMES = ['MEMORY.md', 'memory.md', 'preferences.md', 'PREFERENCES.md']
const REVISION_KEY = randomBytes(32)
// Public MCP identities must not be an offline equality oracle for arbitrary
// quoted TOML keys (which may themselves contain paths or credentials). A
// process-private key is sufficient because scans and plans are process-local,
// while both providers must still derive the same identity during that process.
const MCP_ID_KEY = randomBytes(32)
const MCP_ID_DOMAIN = 'UniAgent/capability-sync/mcp-id/v2\0'
const MAX_TEXT = 2 * 1024 * 1024
const MAX_SKILL_FILE = 5 * 1024 * 1024
const RENAME_ANCHOR_ARTIFACT = /^\.ua-rn-v1-[a-f0-9]{32}$/
const SECRET_KEY = /(?:^|[_-])(token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)(?:$|[_-])/i
const SECRET_VALUE = /^(?:bearer|basic)\s+|[?&](?:access_token|api_key|token|secret|password)=/i

const isRecord = (value: unknown): value is TomlRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'tojson', 'valueof'])
const safeName = (name: string): boolean => name.length > 0 && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name) && !FORBIDDEN_KEYS.has(name.toLowerCase())
// Friendly renderer names are limited to conventional, low-risk MCP slugs.
// Quoted TOML keys outside this grammar, or names that look credential-bearing,
// stay main-private and are represented by a keyed opaque alias.
const PUBLIC_MCP_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+){0,7}$/
const CREDENTIAL_LIKE_MCP_IDENTIFIER = /(?:^|[._-])(?:auth(?:orization)?|bearer|cookie|credentials?|password|private[._-]?key|secret|tokens?|api[._-]?key|access[._-]?token|refresh[._-]?token)(?:$|[._-])/i
const CREDENTIAL_PREFIX_MCP_IDENTIFIER = /^(?:sk|rk|pk|gh[opasu]|xox[abprs]|akia|asia)[_-]/i
const isPublicMcpIdentifier = (name: string): boolean => name.length <= 64 && PUBLIC_MCP_IDENTIFIER.test(name) &&
  !CREDENTIAL_LIKE_MCP_IDENTIFIER.test(name) && !CREDENTIAL_PREFIX_MCP_IDENTIFIER.test(name)
const mcpKeyDigest = (name: string): string => createHmac('sha256', MCP_ID_KEY).update(MCP_ID_DOMAIN).update(name).digest('hex')
const publicMcpName = (name: string): string => isPublicMcpIdentifier(name) ? name : `MCP server #${mcpKeyDigest(name)}`
const capabilityId = (kind: string, name: string): string => {
  // MCP table keys are arbitrary quoted TOML strings and can themselves be
  // paths or credentials. Keep the raw key private and expose only a stable,
  // one-way identity across the source/target inventory boundary.
  if (kind === 'mcp') return isPublicMcpIdentifier(name) ? `mcp:${name}` : `mcp:opaque:${mcpKeyDigest(name)}`
  const canonicalName = kind === 'skill' || kind === 'memory' ? name.toLocaleLowerCase('en-US') : name
  return `${kind}:${encodeURIComponent(canonicalName)}`
}
const revisionHash = (parts: Array<string | Buffer>): string => {
  const hash = createHmac('sha256', REVISION_KEY)
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

export function providerPaths(id: CapabilityProviderId, home: string): ProviderPaths {
  if (id === 'codex') {
    const root = join(home, '.codex')
    const config = join(root, 'config.toml')
    return { root, skills: join(root, 'skills'), config, memories: MEMORY_NAMES.map((name) => join(root, name)), agents: join(root, 'AGENTS.md'), layoutKnown: existsSync(config) }
  }
  const root = join(home, '.trae')
  const current = join(root, 'traecli.toml')
  const legacy = join(root, 'cli/config.toml')
  const currentExists = existsSync(current)
  const legacyExists = existsSync(legacy)
  const rootSkills = join(root, 'skills')
  const cliSkills = join(root, 'cli/skills')
  const rootAgents = join(root, 'AGENTS.md')
  const cliAgents = join(root, 'cli/AGENTS.md')
  const currentSkillsExists = existsSync(rootSkills)
  const legacySkillsExists = existsSync(cliSkills)
  const currentAgentsExists = existsSync(rootAgents)
  const legacyAgentsExists = existsSync(cliAgents)
  // Config, skills, and AGENTS roots evolved independently. In particular the
  // repository scanner's live TraeX layout is cli/config.toml + root skills.
  // The authoritative `traecli.toml` and a stale legacy `cli/config.toml` both
  // exist on real machines; config parsing already prefers `traecli.toml` when
  // present (currentExists ? current : legacy), so treat the config layout as
  // KNOWN whenever either candidate exists. Skills / AGENTS still fail closed
  // when a single category carries two live candidates.
  const configKnown = currentExists || legacyExists
  const skillsUnambiguous = !(currentSkillsExists && legacySkillsExists)
  const agentsUnambiguous = !(currentAgentsExists && legacyAgentsExists)
  const layoutKnown = configKnown && skillsUnambiguous && agentsUnambiguous
  const config = currentExists ? current : legacy
  const configRoot = dirname(config)
  // When neither skills root exists, prefer the same root used by scanners so
  // a first synchronized Skill becomes visible everywhere immediately.
  const skills = currentSkillsExists || !legacySkillsExists ? rootSkills : cliSkills
  const agents = currentAgentsExists ? rootAgents : legacyAgentsExists ? cliAgents : join(configRoot, 'AGENTS.md')
  return {
    root, skills, config,
    memories: currentExists ? MEMORY_NAMES.map((name) => join(root, name)) : MEMORY_NAMES.map((name) => join(root, 'cli', name)),
    agents, layoutKnown
  }
}

/** Reject symlinks in every existing component below home, including roots. */
export async function assertSafePathChain(path: string, home: string, allowLeafSymlink = false): Promise<void> {
  const base = resolve(home)
  const candidate = resolve(path)
  const rel = relative(base, candidate)
  if (rel === '..' || rel.startsWith('..' + sep) || rel === '') throw new Error('unsafe_path')
  const baseInfo = await lstat(base)
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error('unsafe_path')
  let cursor = base
  let leafSymlink = false
  const parts = rel.split(sep)
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index])
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) {
        if (!(allowLeafSymlink && index === parts.length - 1)) throw new Error('unsafe_path')
        leafSymlink = true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  const existing = leafSymlink ? dirname(candidate) : await nearestExisting(candidate)
  const realBase = await realpath(base)
  const realExisting = await realpath(existing)
  if (realExisting !== realBase && !realExisting.startsWith(realBase + sep)) throw new Error('unsafe_path')
}

async function nearestExisting(path: string): Promise<string> {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error('unsafe_path')
    current = parent
  }
  return current
}

async function safeRegularFile(path: string, home: string, issue: CapabilityIssueCode, allowLeafSymlink = false): Promise<{ ok: true; text: string } | { ok: false; issue: CapabilityIssueCode }> {
  try {
    await assertSafePathChain(path, home, allowLeafSymlink)
    const info = await lstat(path)
    if ((!allowLeafSymlink && info.isSymbolicLink()) || (!info.isFile() && !info.isSymbolicLink())) return { ok: false, issue }
    const readPath = info.isSymbolicLink() ? await realpath(path) : path
    return { ok: true, text: await secureReadText(readPath, MAX_TEXT) }
  } catch {
    return { ok: false, issue }
  }
}

async function safeAgentsFile(path: string, home: string, shared: string): Promise<{ ok: true; text: string } | { ok: false; issue: CapabilityIssueCode }> {
  try {
    await assertSafePathChain(path, home, true)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      await assertSafePathChain(shared, home)
      if (await realpath(path) !== await realpath(shared)) return { ok: false, issue: 'unsafe_agents_path' }
    } else if (!info.isFile()) return { ok: false, issue: 'unsafe_agents_path' }
    const readPath = info.isSymbolicLink() ? await realpath(path) : path
    return { ok: true, text: await secureReadText(readPath, MAX_TEXT) }
  } catch {
    return { ok: false, issue: 'unsafe_agents_path' }
  }
}

async function secureReadText(path: string, maximum: number): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximum) throw new Error('unsafe_file')
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}

export function parseToml(text: string): TomlRecord {
  const parsed = TOML.parse(text) as unknown
  if (!isRecord(parsed)) throw new Error('invalid_toml')
  validateTomlTree(parsed)
  return parsed
}

function validateTomlTree(value: unknown): void {
  if (Array.isArray(value)) { for (const entry of value) validateTomlTree(entry); return }
  if (!isRecord(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (!safeName(key)) throw new Error('invalid_toml')
    validateTomlTree(entry)
  }
}

export function stringifyToml(value: TomlRecord): string {
  const output = TOML.stringify(value as never)
  // Parse-after-stringify is an explicit loadability/round-trip gate.
  const parsed = parseToml(output)
  if (stableValue(parsed) !== stableValue(value)) throw new Error('invalid_toml')
  return output
}

export function cloneToml<T>(value: T): T {
  if (value instanceof Date) {
    const cloned = new Date(value.getTime()) as Date & Record<string, unknown>
    for (const key of Object.keys(value)) cloned[key] = (value as Date & Record<string, unknown>)[key]
    return cloned as T
  }
  if (Array.isArray(value)) return value.map((entry) => cloneToml(entry)) as T
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneToml(entry)])) as T
  return value
}

export function stableValue(value: unknown): string {
  if (value instanceof Date) return `date:${value.toISOString()}:${Object.keys(value).sort().map((key) => `${key}=${String((value as Date & Record<string, unknown>)[key])}`).join(',')}`
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  return `${typeof value}:${String(value)}`
}

type SecretSegment = string | number
function collectSecretShape(value: unknown, path: SecretSegment[] = [], inherited = false, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) collectSecretShape(value[index], [...path, index], inherited, output)
    return output
  }
  if (!isRecord(value)) return output
  for (const [key, entry] of Object.entries(value)) {
    const next = [...path, key]
    const lower = key.toLowerCase()
    const normalized = lower.replace(/[-_.]/g, '')
    const containerSecret = inherited || ['env', 'environment', 'header', 'headers', 'httpheader', 'httpheaders', 'requestheader', 'requestheaders'].includes(normalized)
    // Arguments are opaque provider input. There is no reliable way to prove a
    // suspicious positional value is not a credential, so such arrays are target-owned.
    const directSecret = isSecretKey(key) || normalized === 'args' ||
      (typeof entry === 'string' && (SECRET_VALUE.test(entry) || new RegExp('://[^/@\\s]+:[^/@\\s]+@').test(entry)))
    if (directSecret || (containerSecret && !isRecord(entry) && !Array.isArray(entry))) output.add(secretPath(next))
    if (isRecord(entry)) collectSecretShape(entry, next, containerSecret || directSecret, output)
    else if (Array.isArray(entry)) {
      if (directSecret || containerSecret) output.add(secretPath(next))
      else collectSecretShape(entry, next, false, output)
    }
  }
  return output
}
const secretPath = (parts: SecretSegment[]): string => JSON.stringify(parts)
const decodeSecretPath = (path: string): SecretSegment[] => JSON.parse(path) as SecretSegment[]

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_.]/g, '')
  return SECRET_KEY.test(key) || /(?:token|secret|password|credentials?|authorization|cookie|apikey|privatekey|clientsecret|accesstoken|refreshtoken|auth)$/.test(normalized)
}

function redactedClone(value: unknown, path: SecretSegment[] = [], secrets?: Set<string>): unknown {
  if (!secrets) secrets = collectSecretShape(value)
  const joined = secretPath(path)
  if (joined && secrets.has(joined)) return '<credential>'
  if (Array.isArray(value)) return value.map((entry, index) => redactedClone(entry, [...path, index], secrets))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactedClone(entry, [...path, key], secrets)]))
  return value
}

function getAt(value: unknown, path: SecretSegment[]): unknown {
  let cursor = value
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(cursor) || part < 0 || part >= cursor.length) return undefined
      cursor = cursor[part]
    } else {
      if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return undefined
      cursor = cursor[part]
    }
  }
  return cursor
}

function setAt(value: TomlRecord, path: SecretSegment[], next: unknown): void {
  let cursor: unknown = value
  for (let index = 0; index < path.length - 1; index++) {
    const part = path[index]
    const following = path[index + 1]
    if (typeof part === 'number') {
      if (!Array.isArray(cursor)) throw new Error('credential_required')
      if (cursor[part] == null) cursor[part] = typeof following === 'number' ? [] : {}
      cursor = cursor[part]
    } else {
      if (!isRecord(cursor)) throw new Error('credential_required')
      if (cursor[part] == null) cursor[part] = typeof following === 'number' ? [] : {}
      cursor = cursor[part]
    }
  }
  const last = path[path.length - 1]
  if (typeof last === 'number') {
    if (!Array.isArray(cursor)) throw new Error('credential_required')
    cursor[last] = cloneToml(next)
  } else {
    if (!isRecord(cursor)) throw new Error('credential_required')
    cursor[last] = cloneToml(next)
  }
}

export function mergeMcpCredentialSafe(source: TomlRecord, target: TomlRecord | undefined): { value?: TomlRecord; credentialRequired: boolean; secretShape: string[] } {
  const sourceSecrets = collectSecretShape(source)
  const targetSecrets = target ? collectSecretShape(target) : new Set<string>()
  const secretShape = [...sourceSecrets].sort()
  // Array positions are not identities. Even equal-looking shapes may refer to
  // different principals after a reorder, so never transplant credentials by
  // index from either side. Returning no value keeps the target config intact.
  if ([...sourceSecrets, ...targetSecrets].some((path) => decodeSecretPath(path).some((part) => typeof part === 'number'))) {
    return { credentialRequired: true, secretShape }
  }
  if ([...sourceSecrets].some((path) => {
    const parts = decodeSecretPath(path)
    return !sameCredentialShape(getAt(source, parts), getAt(target, parts))
  })) return { credentialRequired: true, secretShape }
  const result = cloneToml(source)
  // Every sensitive source value is replaced by its exact target counterpart.
  for (const path of sourceSecrets) { const parts = decodeSecretPath(path); setAt(result, parts, getAt(target, parts)) }
  // Preserve target-only credentials too; replacing a server must never erase them.
  for (const path of targetSecrets) {
    const parts = decodeSecretPath(path)
    const targetValue = getAt(target, parts)
    if (targetValue !== undefined) setAt(result, parts, targetValue)
  }
  return { value: result, credentialRequired: false, secretShape }
}

function sameCredentialShape(source: unknown, target: unknown): boolean {
  if (target === undefined) return false
  if (Array.isArray(source) || Array.isArray(target)) return Array.isArray(source) && Array.isArray(target)
  if (isRecord(source) || isRecord(target)) return isRecord(source) && isRecord(target)
  if (source instanceof Date || target instanceof Date) return source instanceof Date && target instanceof Date
  return typeof source === typeof target
}

export function parseMcpBlocks(text: string): McpBlock[] {
  const config = parseToml(text)
  const servers = config.mcp_servers
  if (servers == null) return []
  if (!isRecord(servers)) throw new Error('invalid_mcp_schema')
  return Object.entries(servers).map(([privateKey, value]) => {
    if (!safeName(privateKey) || !isRecord(value)) throw new Error('invalid_mcp_schema')
    const secretShape = [...collectSecretShape(value)].sort()
    const body = stringifyToml({ mcp_servers: { [privateKey]: redactedClone(value) } })
    const secretFields = secretShape.map((path) => String(decodeSecretPath(path).at(-1)))
    return { name: publicMcpName(privateKey), privateKey, body, rawBody: body, secretShape, secretFields, value: cloneToml(value) }
  })
}

export function mcpRecord(config: TomlRecord): TomlRecord {
  if (config.mcp_servers == null) return {}
  if (!isRecord(config.mcp_servers)) throw new Error('invalid_mcp_schema')
  return config.mcp_servers
}

export function setMcpServer(config: TomlRecord, name: string, value: TomlRecord | undefined): void {
  const servers = mcpRecord(config)
  if (!isRecord(config.mcp_servers)) config.mcp_servers = servers
  if (value === undefined) {
    // Target-only delete operations carry the safe public display placeholder,
    // never the arbitrary raw TOML key. Resolve it against private config keys
    // and fail closed if a malicious exact key makes the request ambiguous.
    const candidates = new Set<string>()
    if (Object.prototype.hasOwnProperty.call(servers, name)) candidates.add(name)
    for (const key of Object.keys(servers)) if (publicMcpName(key) === name) candidates.add(key)
    if (candidates.size > 1) throw new Error('invalid_mcp_schema')
    const [key] = candidates
    if (key !== undefined) delete servers[key]
  } else servers[name] = cloneToml(value)
  if (Object.keys(servers).length === 0) delete config.mcp_servers
}

export function rootPreference(config: TomlRecord, key: string): unknown { return config[key] }
export function setRootPreference(config: TomlRecord, key: string, value: unknown): void {
  if (value === undefined) delete config[key]
  else config[key] = cloneToml(value)
}

async function hashTree(dir: string, root: string, home: string, normalizePermissions = false): Promise<string> {
  await assertSafePathChain(root, home)
  await assertSafePathChain(dir, home)
  const rootInfo = await lstat(root)
  const dirInfo = await lstat(dir)
  if (!rootInfo.isDirectory() || !dirInfo.isDirectory()) throw new Error('unsafe_skill_root')
  const hash = createHash('sha256')
  async function walk(current: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (isRenameAnchorArtifact(entry.name)) continue
      const path = join(current, entry.name)
      const info = await lstat(path)
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('unsafe_skill_entry')
      hash.update(relative(dir, path)).update('\0')
      if (entry.isDirectory()) await walk(path)
      else {
        if (info.size > MAX_SKILL_FILE) throw new Error('skill_file_too_large')
        hash.update(await secureReadText(path, MAX_SKILL_FILE)).update('\0')
      }
    }
  }
  await walk(dir)
  return hash.digest('hex')
}

export async function validateSkillTree(dir: string, root: string, home: string, normalizePermissions = false): Promise<string> {
  try { return await hashTree(dir, root, home, normalizePermissions) }
  catch (error) {
    const message = (error as Error).message
    if (['unsafe_skill_root', 'unsafe_skill_entry', 'invalid_skill_permissions', 'skill_file_too_large'].includes(message)) throw error
    throw new Error('unsafe_skill_entry')
  }
}

function invalidItem(id: string, kind: CanonicalCapability['kind'], name: string, issueCode: CapabilityIssueCode, privateRef: string): CanonicalCapability {
  return { id, kind, name, owner: 'user', fingerprint: '', compatible: false, issueCode, privateRef }
}

export async function discoverProvider(id: CapabilityProviderId, home: string): Promise<Inventory> {
  const paths = providerPaths(id, home)
  const items: CanonicalCapability[] = []
  const revisionParts: Array<string | Buffer> = [id, paths.layoutKnown ? 'known' : 'unknown']
  let layoutKnown = paths.layoutKnown

  try {
    await assertSafePathChain(paths.root, home)
    const rootInfo = await lstat(paths.root)
    if (!rootInfo.isDirectory()) throw new Error('unsafe')
  } catch {
    layoutKnown = false
  }

  if (existsSync(paths.skills)) {
    try {
      await assertSafePathChain(paths.skills, home)
      if (!(await lstat(paths.skills)).isDirectory()) throw new Error('unsafe')
      const entries = await readdir(paths.skills, { withFileTypes: true })
      const counts = new Map<string, number>()
      for (const entry of entries) {
        const candidate = entry.isSymbolicLink() || (entry.isDirectory() && existsSync(join(paths.skills, entry.name, 'SKILL.md')))
        if (!entry.name.startsWith('.') && candidate) counts.set(entry.name.toLocaleLowerCase('en-US'), (counts.get(entry.name.toLocaleLowerCase('en-US')) || 0) + 1)
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const normalized = entry.name.toLocaleLowerCase('en-US')
        const ref = join(paths.skills, entry.name)
        if (!safeName(entry.name)) {
          items.push(invalidItem(`skill:invalid:${semanticHash(entry.name).slice(0, 12)}`, 'skill', '无效 Skill', 'unsafe_skill_entry', ref))
          continue
        }
        if ((counts.get(normalized) || 0) > 1) {
          items.push(invalidItem(`skill:duplicate:${semanticHash(entry.name).slice(0, 12)}`, 'skill', entry.name, 'duplicate_capability', ref))
          continue
        }
        if (entry.isSymbolicLink()) {
          const item: CanonicalCapability = { id: capabilityId('skill', entry.name), kind: 'skill', name: entry.name, owner: 'user',
            fingerprint: '', compatible: false, linked: true, privateRef: ref }
          try {
            const link = await readlink(ref)
            if (!link || link.length > 4096 || link.includes('\0')) throw new Error('unsafe_skill_entry')
            item.fingerprint = revisionHash(['skill-link', link])
            const manifest = join(ref, 'SKILL.md')
            if (!(await stat(manifest)).isFile()) throw new Error('unsafe_skill_entry')
            await access(manifest, fsConstants.R_OK)
          } catch { item.issueCode = 'unsafe_skill_entry' }
          items.push(item)
          continue
        }
        if (!existsSync(join(ref, 'SKILL.md'))) continue
        try {
          const fingerprint = await validateSkillTree(ref, paths.skills, home)
          items.push({ id: capabilityId('skill', entry.name), kind: 'skill', name: entry.name, owner: 'user', fingerprint, compatible: true, privateRef: ref })
        } catch (error) {
          const code = (error as Error).message as CapabilityIssueCode
          items.push(invalidItem(capabilityId('skill', entry.name), 'skill', entry.name, code, ref))
        }
      }
    } catch {
      layoutKnown = false
      items.push(invalidItem('skill:__unsafe_root__', 'skill', 'Skills', 'unsafe_skill_root', paths.skills))
    }
  }

  const configResult = await safeRegularFile(paths.config, home, 'unsafe_config_path')
  if (!configResult.ok) {
    layoutKnown = false
    items.push(invalidItem('mcp:__invalid_config__', 'mcp', 'MCP 配置', configResult.issue, paths.config))
    items.push(invalidItem('preference:__invalid_config__', 'global-preference', '全局偏好', configResult.issue, paths.config))
  } else {
    revisionParts.push(configResult.text)
    try {
      const config = parseToml(configResult.text)
      const declaredVersion = config.config_version ?? config.schema_version
      if (declaredVersion != null && ![1, '1', '1.0'].includes(declaredVersion as string | number)) layoutKnown = false
      for (const server of parseMcpBlocks(configResult.text)) {
        items.push({
          id: capabilityId('mcp', server.privateKey), kind: 'mcp', name: server.name, owner: 'user',
          fingerprint: semanticHash(server.body), compatible: true, privateRef: paths.config, privateKey: server.privateKey, secretShape: server.secretShape
        })
      }
      for (const key of ['model', 'model_reasoning_effort']) {
        const value = rootPreference(config, key)
        if (value !== undefined) items.push({
          id: `preference:${key}`, kind: 'global-preference', name: key, owner: 'user',
          fingerprint: semanticHash(stableValue(value)), compatible: true, privateRef: paths.config, privateKey: key
        })
      }
    } catch (error) {
      layoutKnown = false
      const issue = (error as Error).message === 'invalid_mcp_schema' ? 'invalid_mcp_schema' : 'invalid_toml'
      items.push(invalidItem('mcp:__invalid_config__', 'mcp', 'MCP 配置', issue, paths.config))
      items.push(invalidItem('preference:__invalid_config__', 'global-preference', '全局偏好', issue, paths.config))
    }
  }

  const memoryFiles: string[] = []
  const memoryInodes = new Set<string>()
  for (const file of paths.memories) if (existsSync(file)) {
    try {
      const info = await lstat(file)
      const inode = `${info.dev}:${info.ino}`
      if (!memoryInodes.has(inode)) { memoryInodes.add(inode); memoryFiles.push(file) }
    } catch { /* represented as unsafe only when the entry can be inspected */ }
  }
  const memoryCounts = new Map<string, number>()
  for (const file of memoryFiles) {
    const key = basename(file).toLocaleLowerCase('en-US')
    memoryCounts.set(key, (memoryCounts.get(key) || 0) + 1)
  }
  for (const file of memoryFiles) {
    if ((memoryCounts.get(basename(file).toLocaleLowerCase('en-US')) || 0) > 1) {
      items.push(invalidItem(`memory:duplicate:${semanticHash(file).slice(0, 12)}`, 'memory', basename(file), 'duplicate_capability', file))
      continue
    }
    const result = await safeRegularFile(file, home, 'unsafe_memory_path')
    if (result.ok) {
      revisionParts.push(basename(file), result.text)
      items.push({ id: capabilityId('memory', basename(file)), kind: 'memory', name: basename(file), owner: 'user', fingerprint: semanticHash(result.text), compatible: true, privateRef: file })
    } else items.push(invalidItem(capabilityId('memory', basename(file)), 'memory', basename(file), result.issue, file))
  }

  const shared = join(home, '.agents/AGENTS.md')
  if (existsSync(paths.agents)) {
    const result = await safeAgentsFile(paths.agents, home, shared)
    if (result.ok) {
      revisionParts.push(paths.agents, result.text)
      items.push({ id: 'global-instructions:agents', kind: 'global-instructions', name: 'AGENTS.md', owner: 'user', fingerprint: semanticHash(result.text), compatible: true, privateRef: paths.agents })
    } else items.push(invalidItem('global-instructions:agents', 'global-instructions', 'AGENTS.md', result.issue, paths.agents))
  }
  if (existsSync(shared)) {
    const result = await safeRegularFile(shared, home, 'unsafe_agents_path')
    revisionParts.push('shared-agents', result.ok ? result.text : result.issue)
    if (!result.ok) layoutKnown = false
  } else revisionParts.push('shared-agents-missing')

  for (const path of new Set([paths.skills, paths.config, ...paths.memories, paths.agents, shared])) {
    if (!existsSync(path) || isTransactionArtifact(path)) continue
    try { revisionParts.push('path-state', await pathState(path, home)) } catch { revisionParts.push('path-state-invalid') }
  }

  revisionParts.push(...items.map((item) => `${item.id}:${item.fingerprint}:${item.compatible}:${item.linked || false}:${item.issueCode || ''}`).sort())
  return { revision: revisionHash(revisionParts), items, layoutKnown }
}

async function pathState(path: string, home: string): Promise<string> {
  await assertSafePathChain(path, home, true)
  const hash = createHash('sha256')
  async function visit(current: string, root: string): Promise<void> {
    const info = await lstat(current)
    hash.update(relative(root, current)).update(':').update(String(info.mode & 0o777)).update(':')
    if (info.isSymbolicLink()) { hash.update('link:').update(await readlink(current)); return }
    if (info.isFile()) { hash.update('file:').update(await secureReadText(current, MAX_SKILL_FILE)); return }
    if (!info.isDirectory()) { hash.update('other'); return }
    hash.update('directory')
    for (const name of (await readdir(current)).sort()) {
      const child = join(current, name)
      if (!isTransactionArtifact(child)) await visit(child, root)
    }
  }
  await visit(path, path)
  return hash.digest('hex')
}

function isTransactionArtifact(path: string): boolean {
  const name = basename(path)
  return isRenameAnchorArtifact(name) ||
    /^\.ua-(?:stage|rollback|restore|post)-.+-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d+$/i.test(name)
}

function isRenameAnchorArtifact(path: string): boolean {
  const name = basename(path)
  // JavaScript's `$` also matches immediately before a trailing line break.
  // Keep the accepted filename language equal to the protocol grammar.
  return name.length === 42 && RENAME_ANCHOR_ARTIFACT.test(name)
}

export async function ensurePrivateDirectory(path: string, home: string): Promise<void> {
  await assertSafePathChain(path, home)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  await access(path, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
}

export function assertSafeDestination(path: string, root: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '..' || rel.startsWith('..' + sep) || rel === '') throw new Error('path_traversal')
}
