import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CapabilityAgentId, CapabilityIssueCode, CapabilityPluginActionRequest, CapabilityPluginActionResult,
  CapabilityPluginComponents
} from '../../shared/capabilitySync.ts'
import { comparePluginVersions, secureRegularText } from './skillDiscovery.ts'

const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_MANIFEST = 2 * 1024 * 1024
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}@[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
type PluginAgentId = 'codex' | 'traex' | 'claude'

export interface PluginListEntry {
  pluginId: string
  name: string
  marketplace: string
  version?: string
  enabled?: boolean
  scope?: 'user'
  sourcePath?: string
  repository?: string
}

export interface DiscoveredPlugin extends PluginListEntry {
  agentId: PluginAgentId
  displayName?: string
  status: 'available' | 'invalid'
  issueCode?: CapabilityIssueCode
  fingerprint: string
  installedDir?: string
  manifestPath?: string
  cachedVersions: number
  components: CapabilityPluginComponents
  migratableTo?: CapabilityAgentId[]
}

export type PluginCommandRunner = (
  bin: string,
  args: string[],
  options: { home: string }
) => Promise<{ stdout: string; stderr?: string }>

const emptyComponents = (): CapabilityPluginComponents => ({ skills: 0, mcps: 0, hooks: 0, apps: 0, models: 0, commands: 0 })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeText = (value: unknown, maximum = 300): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function splitPluginId(value: unknown): { pluginId: string; name: string; marketplace: string } {
  if (!safeText(value, 400) || !PLUGIN_ID.test(value)) throw new Error('plugin_enumeration_failed')
  const at = value.lastIndexOf('@')
  return { pluginId: value, name: value.slice(0, at), marketplace: value.slice(at + 1) }
}

function absolutePath(value: unknown): string | undefined {
  if (value == null) return undefined
  if (!safeText(value, 4096) || !isAbsolute(value)) throw new Error('plugin_enumeration_failed')
  return value
}

function unique(entries: PluginListEntry[]): PluginListEntry[] {
  if (new Set(entries.map((entry) => entry.pluginId)).size !== entries.length) throw new Error('plugin_enumeration_failed')
  return entries
}

function jsonRoot(text: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('plugin_enumeration_failed') }
  if (!record(parsed)) throw new Error('plugin_enumeration_failed')
  return parsed
}

function sourceMetadata(value: unknown): { sourcePath?: string; repository?: string } {
  if (typeof value === 'string') return isAbsolute(value) ? { sourcePath: absolutePath(value) } : {}
  if (!record(value)) return {}
  const sourcePath = value.path == null ? undefined : absolutePath(value.path)
  const repository = safeText(value.url, 2048) ? value.url : undefined
  return { sourcePath, repository }
}

export function parseCodexPluginList(text: string): PluginListEntry[] {
  const root = jsonRoot(text)
  if (!Array.isArray(root.installed)) throw new Error('plugin_enumeration_failed')
  return unique(root.installed.map((value) => {
    if (!record(value)) throw new Error('plugin_enumeration_failed')
    const id = splitPluginId(value.pluginId)
    if (value.installed === false || (value.name != null && value.name !== id.name) ||
        (value.marketplaceName != null && value.marketplaceName !== id.marketplace)) throw new Error('plugin_enumeration_failed')
    const source = sourceMetadata(value.source)
    return { ...id, version: safeText(value.version) ? value.version : undefined, enabled: value.enabled !== false, ...source }
  }))
}

export function parseClaudePluginList(text: string): PluginListEntry[] {
  const root = jsonRoot(text)
  if (!Array.isArray(root.installed)) throw new Error('plugin_enumeration_failed')
  return unique(root.installed.flatMap((value) => {
    if (!record(value)) throw new Error('plugin_enumeration_failed')
    // Capability sync manages user plugins; project/local installations share caches.
    if (value.scope !== 'user') return []
    const id = splitPluginId(value.id)
    return [{ ...id, scope: 'user' as const, version: safeText(value.version) ? value.version : undefined, enabled: value.enabled !== false, sourcePath: absolutePath(value.installPath) }]
  }))
}

export function parseTraexPluginList(text: string): PluginListEntry[] {
  const entries: PluginListEntry[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const idMatch = block.match(/^\s*id:\s*([^\s]+)\s*$/m)
    if (!idMatch) continue
    const id = splitPluginId(idMatch[1])
    const pathMatch = block.match(/^\s*From local:\s*(.+?)\s*$/m)
    const gitMatch = block.match(/^\s*From git:\s*(\S+)/m)
    entries.push({ ...id, sourcePath: pathMatch ? absolutePath(pathMatch[1]) : undefined, repository: gitMatch?.[1] })
  }
  if (/\bid:\s*/.test(text) && entries.length === 0) throw new Error('plugin_enumeration_failed')
  return unique(entries)
}

function parseAvailableJson(text: string): PluginListEntry[] {
  const root = jsonRoot(text)
  if (!Array.isArray(root.available)) throw new Error('plugin_enumeration_failed')
  return unique(root.available.map((value) => {
    if (!record(value)) throw new Error('plugin_enumeration_failed')
    const id = splitPluginId(value.pluginId)
    const source = sourceMetadata(value.source)
    return { ...id, version: safeText(value.version) ? value.version : undefined, ...source }
  }))
}

export function parseTraexMarketplace(text: string): PluginListEntry[] {
  const entries: PluginListEntry[] = []
  for (const match of text.matchAll(/^\*\s+.+?\s+\(([^)]+)\)\s*$/gm)) entries.push(splitPluginId(match[1]))
  const count = text.match(/Found (\d+) plugins:/)
  if (count && Number(count[1]) !== entries.length) throw new Error('plugin_enumeration_failed')
  return unique(entries)
}

export const nativePluginCommandRunner: PluginCommandRunner = (bin, args, options) => new Promise((resolveResult, reject) => {
  execFile(bin, args, { timeout: 10_000, maxBuffer: MAX_OUTPUT, shell: false,
    env: { ...process.env, HOME: options.home, USERPROFILE: options.home, CODEX_HOME: join(options.home, '.codex'),
      TRAE_HOME: join(options.home, '.trae'), CLAUDE_CONFIG_DIR: join(options.home, '.claude') } },
    (error, stdout, stderr) => error ? reject(new Error('plugin_enumeration_failed')) : resolveResult({ stdout, stderr }))
})

function memoizedRunner(runner: PluginCommandRunner): PluginCommandRunner {
  const cache = new Map<string, Promise<{ stdout: string; stderr?: string }>>()
  return (bin, args, options) => {
    const key = JSON.stringify([bin, args, options.home])
    let value = cache.get(key)
    if (!value) { value = runner(bin, args, options); cache.set(key, value) }
    return value
  }
}

function cacheRoot(agentId: PluginAgentId, home: string): string {
  return join(home, agentId === 'codex' ? '.codex/plugins/cache' : agentId === 'traex' ? '.trae/plugins/cache' : '.claude/plugins/cache')
}

function insideHome(path: string, home: string): boolean {
  const rel = relative(resolve(home), resolve(path))
  return rel !== '..' && !rel.startsWith('..' + sep)
}

async function safeDirectory(path: string | undefined, home: string): Promise<string | undefined> {
  if (!path || !insideHome(path, home)) return undefined
  try {
    const resolved = await realpath(path)
    if (!insideHome(resolved, home) || !(await lstat(resolved)).isDirectory()) return undefined
    return resolved
  } catch { return undefined }
}

async function safePhysicalDirectory(path: string, home: string): Promise<string | undefined> {
  if (!insideHome(path, home)) return undefined
  try {
    const lexical = resolve(path)
    const info = await lstat(lexical)
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    const resolved = await realpath(lexical)
    return resolved === lexical && insideHome(resolved, home) ? lexical : undefined
  } catch { return undefined }
}

async function versionDirectories(path: string, home: string): Promise<string[]> {
  const parent = await safeDirectory(path, home)
  if (!parent) return []
  const entries = await readdir(parent, { withFileTypes: true })
  return entries.filter((entry) => !entry.name.startsWith('.') && entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name)
}

async function readManifest(directory: string, home: string): Promise<{ manifest: Record<string, unknown>; path: string } | undefined> {
  for (const relativePath of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const path = join(directory, relativePath)
    if (!existsSync(path)) continue
    try {
      const parsed: unknown = JSON.parse(await secureRegularText(path, home, MAX_MANIFEST))
      if (record(parsed)) return { manifest: parsed, path }
    } catch { continue }
  }
  return undefined
}

async function countDirectory(root: string, path: unknown, standard: string, skill = false): Promise<number> {
  const candidates = typeof path === 'string' ? [path] : Array.isArray(path) ? path.filter((value): value is string => typeof value === 'string') : [standard]
  let total = 0
  for (const candidate of candidates) {
    const absolute = resolve(root, candidate)
    const rel = relative(root, absolute)
    if (rel === '..' || rel.startsWith('..' + sep)) continue
    try {
      const entries = await readdir(absolute, { withFileTypes: true })
      total += skill
        ? entries.filter((entry) => entry.isDirectory() && existsSync(join(absolute, entry.name, 'SKILL.md'))).length
        : entries.filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile())).length
    } catch { /* optional component */ }
  }
  return total
}

function declaredCount(value: unknown): number {
  if (typeof value === 'string') return 1
  if (Array.isArray(value)) return value.length
  return record(value) ? Object.keys(value).length : 0
}

async function componentCounts(root: string, manifest: Record<string, unknown>): Promise<CapabilityPluginComponents> {
  return {
    skills: await countDirectory(root, manifest.skills, 'skills', true),
    mcps: declaredCount(manifest.mcpServers ?? manifest.mcp_servers),
    hooks: declaredCount(manifest.hooks),
    apps: declaredCount(manifest.apps) || await countDirectory(root, undefined, 'apps'),
    models: declaredCount(manifest.models) || await countDirectory(root, undefined, 'models'),
    commands: declaredCount(manifest.commands) || await countDirectory(root, undefined, 'commands')
  }
}

async function installedEntries(agentId: PluginAgentId, home: string, runner: PluginCommandRunner): Promise<PluginListEntry[]> {
  const command = agentId === 'codex' ? ['codex', ['plugin', 'list', '--available', '--json']] as const
    : agentId === 'traex' ? ['traecli', ['plugin', 'list']] as const
      : ['claude', ['plugin', 'list', '--available', '--json']] as const
  const { stdout } = await runner(command[0], [...command[1]], { home })
  return agentId === 'codex' ? parseCodexPluginList(stdout) : agentId === 'traex' ? parseTraexPluginList(stdout) : parseClaudePluginList(stdout)
}

export async function discoverInstalledPlugins(
  agentId: PluginAgentId,
  home: string,
  runner: PluginCommandRunner = nativePluginCommandRunner
): Promise<DiscoveredPlugin[]> {
  let installed: PluginListEntry[]
  try { installed = await installedEntries(agentId, home, runner) }
  catch {
    return [{ agentId, pluginId: `__scan__@${agentId}`, name: 'Plugins', marketplace: agentId, status: 'invalid',
      issueCode: 'plugin_enumeration_failed', fingerprint: hash([agentId, 'scan']), cachedVersions: 0, components: emptyComponents() }]
  }
  const output: DiscoveredPlugin[] = []
  for (const entry of installed) {
    const cache = join(cacheRoot(agentId, home), entry.marketplace, entry.name)
    const versions = await versionDirectories(cache, home)
    const cacheVersion = entry.version && versions.includes(entry.version) ? entry.version
      : versions.sort((a, b) => comparePluginVersions(b, a))[0]
    const cachedDir = entry.version && versions.includes(entry.version)
      ? await safeDirectory(join(cache, entry.version), home)
      : undefined
    const sourceDir = await safeDirectory(entry.sourcePath, home)
    const fallbackDir = !entry.version && cacheVersion ? await safeDirectory(join(cache, cacheVersion), home) : undefined
    const installedDir = cachedDir || sourceDir || fallbackDir
    const manifestValue = installedDir ? await readManifest(installedDir, home) : undefined
    const manifest = manifestValue?.manifest
    const interfaceMetadata = record(manifest?.interface) ? manifest.interface : undefined
    const displayName = safeText(interfaceMetadata?.displayName) ? interfaceMetadata.displayName : undefined
    const version = entry.version || (safeText(manifest?.version) ? manifest.version : cacheVersion)
    const repository = entry.repository || (safeText(manifest?.repository, 2048) ? manifest.repository : undefined)
    const components = manifest && installedDir ? await componentCounts(installedDir, manifest) : emptyComponents()
    output.push({ ...entry, displayName, version, repository, agentId, installedDir, manifestPath: manifestValue?.path,
      status: manifestValue ? 'available' : 'invalid', issueCode: manifestValue ? undefined : 'plugin_manifest_invalid',
      cachedVersions: versions.length, components,
      fingerprint: hash([agentId, entry.pluginId, displayName || '', version || '', repository || '', components]) })
  }
  return output
}

async function availableEntries(agentId: PluginAgentId, home: string, runner: PluginCommandRunner): Promise<PluginListEntry[]> {
  if (agentId === 'traex') return parseTraexMarketplace((await runner('traecli', ['plugin', 'marketplace', 'list-plugins'], { home })).stdout)
  const bin = agentId === 'codex' ? 'codex' : 'claude'
  return parseAvailableJson((await runner(bin, ['plugin', 'list', '--available', '--json'], { home })).stdout)
}

function normalizedRepository(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.trim().toLowerCase().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

async function installSelector(source: DiscoveredPlugin, target: PluginAgentId, home: string, runner: PluginCommandRunner): Promise<string> {
  let available: PluginListEntry[]
  try { available = await availableEntries(target, home, runner) } catch { throw new Error('plugin_target_incompatible') }
  const exact = available.filter((entry) => entry.pluginId === source.pluginId)
  if (exact.length === 1) return exact[0].pluginId
  if (target === 'traex') {
    if (!source.installedDir || !existsSync(join(source.installedDir, '.codex-plugin/plugin.json'))) throw new Error('plugin_target_incompatible')
    try { await runner('traecli', ['plugin', 'validate', '--path', source.installedDir], { home }) }
    catch { throw new Error('plugin_target_incompatible') }
    return source.installedDir
  }
  const repository = normalizedRepository(source.repository)
  const compatible = repository ? available.filter((entry) => entry.name === source.name && normalizedRepository(entry.repository) === repository) : []
  if (compatible.length !== 1) throw new Error('plugin_target_incompatible')
  return compatible[0].pluginId
}

export async function pluginMigrationTargets(source: DiscoveredPlugin, home: string, runner: PluginCommandRunner = nativePluginCommandRunner): Promise<CapabilityAgentId[]> {
  if (source.issueCode === 'plugin_enumeration_failed') return []
  const targets: CapabilityAgentId[] = []
  for (const target of (['codex', 'traex', 'claude'] as PluginAgentId[]).filter((value) => value !== source.agentId)) {
    try {
      const installed = await installedEntries(target, home, runner)
      if (installed.some((entry) => entry.pluginId === source.pluginId)) continue
      await installSelector(source, target, home, runner)
      targets.push(target)
    } catch { /* incompatible target */ }
  }
  return targets
}

export async function discoverPluginCatalog(
  home: string,
  runner: PluginCommandRunner = nativePluginCommandRunner
): Promise<Map<PluginAgentId, DiscoveredPlugin[]>> {
  const cachedRunner = memoizedRunner(runner)
  const pairs = await Promise.all((['codex', 'traex', 'claude'] as PluginAgentId[]).map(async (agentId) => {
    const plugins = await discoverInstalledPlugins(agentId, home, cachedRunner)
    await Promise.all(plugins.map(async (plugin) => { plugin.migratableTo = await pluginMigrationTargets(plugin, home, cachedRunner) }))
    return [agentId, plugins] as const
  }))
  return new Map(pairs)
}

export function pluginActionCommand(agentId: PluginAgentId, action: 'migrate' | 'uninstall', selector: string): { bin: string; args: string[] } {
  if (action === 'uninstall') {
    if (agentId === 'claude') return { bin: 'claude', args: ['plugin', 'uninstall', selector, '--scope', 'user', '--json', '--keep-data'] }
    return agentId === 'codex'
      ? { bin: 'codex', args: ['plugin', 'remove', selector, '--json'] }
      : { bin: 'traecli', args: ['plugin', 'uninstall', selector] }
  }
  if (agentId === 'codex') return { bin: 'codex', args: ['plugin', 'add', selector, '--json'] }
  if (agentId === 'traex') return { bin: 'traecli', args: ['plugin', 'install', selector] }
  return { bin: 'claude', args: ['plugin', 'install', selector, '--scope', 'user'] }
}

function pluginOpaqueId(agentId: PluginAgentId, pluginId: string): string {
  return `${agentId}:plugin:plugin:${createHash('sha256').update(pluginId).digest('hex').slice(0, 24)}`
}

export async function executePluginAction(
  home: string,
  request: CapabilityPluginActionRequest,
  runner: PluginCommandRunner = nativePluginCommandRunner
): Promise<CapabilityPluginActionResult> {
  let source: DiscoveredPlugin | undefined
  for (const agentId of ['codex', 'traex', 'claude'] as PluginAgentId[]) {
    source = (await discoverInstalledPlugins(agentId, home, runner)).find((entry) => pluginOpaqueId(agentId, entry.pluginId) === request.id)
    if (source) break
  }
  if (!source || source.issueCode === 'plugin_enumeration_failed') throw new Error('plugin_target_incompatible')
  if (request.action === 'uninstall') {
    const command = pluginActionCommand(source.agentId, 'uninstall', source.pluginId)
    try { await runner(command.bin, command.args, { home }) } catch { throw new Error('plugin_uninstall_failed') }
    if ((await installedEntries(source.agentId, home, runner)).some((entry) => entry.pluginId === source?.pluginId)) throw new Error('plugin_uninstall_failed')
    if (source.agentId !== 'claude') {
      const cache = await safePhysicalDirectory(join(cacheRoot(source.agentId, home), source.marketplace, source.name), home)
      if (cache) await rm(cache, { recursive: true, force: true })
    }
    return { action: 'uninstall', sourceAgentId: source.agentId, pluginId: source.pluginId }
  }
  const requestedTarget = request.targetAgentId
  const target = requestedTarget === 'codex' || requestedTarget === 'traex' || requestedTarget === 'claude' ? requestedTarget : undefined
  if (!target || target === source.agentId) throw new Error('plugin_target_incompatible')
  const targetBefore = await installedEntries(target, home, runner)
  const selector = await installSelector(source, target, home, runner)
  const command = pluginActionCommand(target, 'migrate', selector)
  try { await runner(command.bin, command.args, { home }) } catch { throw new Error('plugin_install_failed') }
  const targetInstalled = await installedEntries(target, home, runner)
  if (!targetInstalled.some((entry) => entry.pluginId === selector || entry.pluginId === source?.pluginId ||
      (entry.name === source?.name && !targetBefore.some((before) => before.pluginId === entry.pluginId)))) throw new Error('plugin_install_failed')
  return { action: 'migrate', sourceAgentId: source.agentId, targetAgentId: target, pluginId: source.pluginId }
}

export const capabilityPluginInventoryId = pluginOpaqueId
