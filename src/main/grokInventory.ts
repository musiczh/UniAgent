import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as TOML from '@iarna/toml'
import { secureRegularText } from './capability-sync/skillDiscovery.ts'
import type {
  CapabilityAgentInventory, CapabilityInventoryDetail, CapabilityInventoryItem, CapabilityInventoryStatus, CapabilityPluginComponents
} from '../shared/capabilitySync.ts'

const MAX_OUTPUT = 8 * 1024 * 1024
const REDACTED = '[redacted]'
const MCP_CONFIG_FIELDS = ['transport', 'command', 'args', 'url', 'env', 'headers', 'enabled']
const SENSITIVE_KEY = /env|header|token|secret|password|credential|authorization|key/i
const COMMANDS = [
  ['inspect', '--json'],
  ['mcp', 'list', '--json'],
  ['plugin', 'list', '--json']
] as const

type JsonRecord = Record<string, unknown>
export type GrokInventoryCommandRunner = (
  bin: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string }>

export interface GrokInventoryOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  runner?: GrokInventoryCommandRunner
}

class GrokInventoryCommandError extends Error {
  readonly unavailable: boolean

  constructor(unavailable: boolean) {
    super('grok_inventory_command_failed')
    this.unavailable = unavailable
  }
}

const record = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, maximum = 500): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const opaqueId = (kind: string, identity: string): string => `grok:${kind}:${digest(identity).slice(0, 24)}`

/** Removes secret-bearing subtrees before validation or DTO construction. */
export function redactGrokInventoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactGrokInventoryValue)
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key, SENSITIVE_KEY.test(key) ? '[redacted]' : redactGrokInventoryValue(nested)
  ]))
}

export const nativeGrokInventoryCommandRunner: GrokInventoryCommandRunner = (bin, args, options) =>
  new Promise((resolveResult, reject) => {
    execFile(bin, [...args], {
      cwd: options.cwd, timeout: 10_000, maxBuffer: MAX_OUTPUT, shell: false,
      env: options.env ? { ...process.env, ...options.env } : process.env
    }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        reject(new GrokInventoryCommandError(code === 'ENOENT'))
      } else resolveResult({ stdout })
    })
  })

function sourceType(value: unknown): string | undefined {
  return record(value) && text(value.type, 100) ? value.type : undefined
}

function count(value: unknown): number {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number
  if (Array.isArray(value)) return value.length
  if (record(value)) return Object.keys(value).length
  return value == null || value === false ? 0 : 1
}

function components(value: unknown): CapabilityPluginComponents {
  const provided = record(value) ? value : {}
  return {
    skills: count(provided.skills), mcps: count(provided.mcpServers), hooks: count(provided.hooks),
    apps: 0, models: 0, commands: 0
  }
}

function item(
  kind: CapabilityInventoryItem['kind'], name: string, scope: CapabilityInventoryItem['scope'],
  origin: string, fingerprintFields: unknown, extras: Partial<CapabilityInventoryItem> = {}
): CapabilityInventoryItem {
  return {
    id: opaqueId(kind, `${scope}:${name}`), agentId: 'grok', kind, name, scope, origin,
    owner: scope === 'builtin' ? 'system' : scope === 'plugin' ? 'plugin' : 'user',
    fingerprint: digest(fingerprintFields), manageable: false, copyable: false, status: 'available', ...extras
  }
}

function safeName(value: unknown, fallback?: string): string | undefined {
  return text(value) ? value : text(fallback) ? fallback : undefined
}

function inspectItems(inspect: JsonRecord, mcpList: unknown[], pluginList: unknown[]): CapabilityInventoryItem[] {
  const items: CapabilityInventoryItem[] = []
  if (!Array.isArray(inspect.skills) || !Array.isArray(inspect.hooks) ||
      !Array.isArray(inspect.projectInstructions) || !Array.isArray(inspect.agents) ||
      !Array.isArray(inspect.plugins) || !Array.isArray(inspect.mcpServers)) {
    throw new Error('grok_inventory_invalid')
  }

  for (const value of inspect.skills) {
    if (!record(value)) throw new Error('grok_inventory_invalid')
    const name = safeName(value.name)
    if (!name) throw new Error('grok_inventory_invalid')
    const source = sourceType(value.source)
    items.push(item('skill', name, 'agent', source ? `${source} skill` : 'Grok skill', {
      name, source, userInvocable: value.userInvocable === true
    }, { source }))
  }
  for (const value of inspect.plugins) {
    if (!record(value)) throw new Error('grok_inventory_invalid')
    const name = safeName(value.name)
    if (!name) throw new Error('grok_inventory_invalid')
    const scope = text(value.scope, 100) ? value.scope : 'plugin'
    const provided = components(value.provides)
    items.push(item('plugin', name, 'plugin', `${scope} plugin`, {
      name, scope, enabled: value.enabled !== false, components: provided
    }, { components: provided, source: value.enabled === false ? 'disabled' : 'enabled' }))
  }
  for (const value of inspect.mcpServers) {
    if (!record(value)) throw new Error('grok_inventory_invalid')
    const name = safeName(value.name)
    if (!name) throw new Error('grok_inventory_invalid')
    const transport = text(value.transport, 100) ? value.transport : undefined
    const source = sourceType(value.source)
    const compatibility = text(value.compatibilityStatus, 100) ? value.compatibilityStatus : undefined
    items.push(item('mcp', name, 'agent', [source, transport].filter(Boolean).join(' · ') || 'Grok MCP', {
      name, transport, source, compatibility, vendor: text(value.vendor, 100) ? value.vendor : undefined
    }, { source: compatibility }))
  }
  for (const value of inspect.hooks) {
    if (!record(value)) throw new Error('grok_inventory_invalid')
    const name = safeName(value.event, text(value.hookType, 100) ? value.hookType : undefined)
    if (!name) throw new Error('grok_inventory_invalid')
    const source = sourceType(value.source)
    const hookType = text(value.hookType, 100) ? value.hookType : undefined
    const compatibility = text(value.compatibilityStatus, 100) ? value.compatibilityStatus : undefined
    items.push(item('hook', name, 'agent', [source, hookType].filter(Boolean).join(' · ') || 'Grok hook', {
      name, source, hookType, compatibility, vendor: text(value.vendor, 100) ? value.vendor : undefined
    }, { source: compatibility }))
  }
  for (const value of inspect.projectInstructions) {
    if (!record(value)) throw new Error('grok_inventory_invalid')
    const pathName = text(value.path, 4096) ? basename(value.path) : undefined
    const name = safeName(value.fileType, pathName)
    if (!name) throw new Error('grok_inventory_invalid')
    const scope = text(value.scope, 100) ? value.scope : 'project'
    const compatibility = text(value.compatibilityStatus, 100) ? value.compatibilityStatus : undefined
    items.push(item('global-instructions', name, 'agent', `${scope} instructions`, {
      name, scope, compatibility, vendor: text(value.vendor, 100) ? value.vendor : undefined,
      sizeBytes: Number.isSafeInteger(value.sizeBytes) ? value.sizeBytes : undefined,
      approxTokens: Number.isSafeInteger(value.approxTokens) ? value.approxTokens : undefined
    }, { source: compatibility }))
  }
  for (const value of inspect.agents) {
    if (!record(value)) throw new Error('grok_inventory_invalid')
    const name = safeName(value.name)
    if (!name) throw new Error('grok_inventory_invalid')
    const source = sourceType(value.source)
    items.push(item('agent-profile', name, 'agent', source ? `${source} agent profile` : 'Grok agent profile', { name, source }, { source }))
  }

  // Merge authoritative CLI listings without exposing their configuration payload.
  for (const [kind, values] of [['mcp', mcpList], ['plugin', pluginList]] as const) {
    for (const value of values) {
      if (!record(value)) throw new Error('grok_inventory_invalid')
      const name = safeName(value.name)
      if (!name) throw new Error('grok_inventory_invalid')
      if (items.some((candidate) => candidate.kind === kind && candidate.name === name)) continue
      items.push(item(kind, name, kind === 'plugin' ? 'plugin' : 'agent', `Grok ${kind}`, { kind, name }))
    }
  }
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

function emptyInventory(available: boolean, status: CapabilityInventoryStatus): CapabilityAgentInventory {
  return {
    agentId: 'grok', available, writable: false, status,
    ...(status === 'invalid' ? { issueCode: 'grok_inventory_invalid' as const } : {}),
    revision: digest({ available, status }), items: []
  }
}

export async function inspectGrokInventory(
  bin = 'grok', cwd = process.cwd(), env?: NodeJS.ProcessEnv, runner: GrokInventoryCommandRunner = nativeGrokInventoryCommandRunner
): Promise<CapabilityAgentInventory> {
  try {
    return (await snapshot(bin, { cwd, env, runner })).inventory
  } catch (error) {
    return error instanceof GrokInventoryCommandError && error.unavailable
      ? emptyInventory(false, 'unsupported')
      : emptyInventory(true, 'invalid')
  }
}

export async function grokInventoryFromOptions(bin: string, options: GrokInventoryOptions): Promise<CapabilityAgentInventory> {
  return inspectGrokInventory(bin, options.cwd, options.env, options.runner)
}

/** Production native capability surface is read-only even if the CLI supports management. */
export async function readonlyGrokInventory(bin: string, options: GrokInventoryOptions): Promise<CapabilityAgentInventory> {
  const inventory = await grokInventoryFromOptions(bin,options)
  return { ...inventory, writable:false, managementSupported:false,
    items:inventory.items.map(item => ({...item,manageable:false,copyable:false})) }
}

export const readonlyGrokInventoryRunner: GrokInventoryCommandRunner = (bin,args,options) =>
  nativeGrokInventoryCommandRunner(bin,['--no-auto-update',...args],options)

export interface GrokMcpConfiguration {
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export type GrokInventoryManageRequest =
  | ({ action: 'mcp-add'; name: string; scope?: 'user'; expectedRevision?: string } & GrokMcpConfiguration)
  | ({ action: 'mcp-update'; id: string; expectedRevision?: string } & GrokMcpConfiguration)
  | { action: 'mcp-enable' | 'mcp-disable' | 'mcp-remove' | 'plugin-enable' | 'plugin-disable' | 'plugin-uninstall' | 'plugin-update'; id: string; expectedRevision?: string }
  | { action: 'plugin-install'; source: string; expectedRevision?: string }

async function applyNativePluginStates(inspect: JsonRecord, options: GrokInventoryOptions): Promise<void> {
  const root = resolve(options.env?.GROK_HOME || process.env.GROK_HOME || join(options.env?.HOME || homedir(), '.grok'))
  let plugins: JsonRecord
  try {
    const canonicalRoot = await realpath(root)
    const config = TOML.parse(await secureRegularText(join(canonicalRoot, 'config.toml'), canonicalRoot, 2 * 1024 * 1024))
    if (!record(config.plugins)) return
    plugins = config.plugins
  } catch { return }
  if (!Array.isArray(inspect.plugins)) return
  for (const value of inspect.plugins) {
    if (!record(value) || value.scope !== 'user') continue
    let id: string | undefined
    if (text(value.path, 4096) && text(value.name)) {
      try {
        // Verified against _x.ai/plugins/list: IDs hash the canonical root, not its /var alias.
        const hash = createHash('sha256').update(await realpath(value.path)).digest('hex').slice(0, 8)
        id = `user/${hash}/${value.name}`
      } catch { /* A removed plugin has no canonical installation identity. */ }
    }
    const matches = (values: unknown): boolean => Array.isArray(values) && values.some(entry =>
      entry === value.name || id !== undefined && entry === id)
    // Grok 1.0.50 inspect reports enabled=true after plugin disable; native config is authoritative.
    if (matches(plugins.disabled)) value.enabled = false
    else if (matches(plugins.enabled)) value.enabled = true
  }
}

async function isNativeInstalledPlugin(plugin: JsonRecord, discovered: JsonRecord, options: GrokInventoryOptions): Promise<boolean> {
  if (!text(plugin.path, 4096) || !text(discovered.path, 4096) || !isAbsolute(plugin.path) ||
      !isAbsolute(discovered.path) || resolve(plugin.path) !== resolve(discovered.path)) return false
  const root = resolve(options.env?.GROK_HOME || process.env.GROK_HOME || join(options.env?.HOME || homedir(), '.grok'))
  const relativePath = relative(root, plugin.path)
  if (!relativePath.startsWith('installed-plugins' + sep) || relativePath.split(sep).length < 2) return false
  try {
    const canonicalRoot = await realpath(root)
    let cursor = canonicalRoot
    for (const part of relativePath.split(sep)) {
      if (part === '..' || part === '.') return false
      cursor = join(cursor, part)
      const info = await lstat(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
    }
    return true
  } catch { return false }
}

type InventorySnapshot = { inspect: JsonRecord; mcps: JsonRecord[]; plugins: JsonRecord[]; inventory: CapabilityAgentInventory }

async function snapshot(bin: string, options: GrokInventoryOptions): Promise<InventorySnapshot> {
  const runner = options.runner || nativeGrokInventoryCommandRunner
  const outputs: string[] = []
  for (const args of COMMANDS) outputs.push((await runner(bin, args, options)).stdout)
  let inspect: unknown, mcps: unknown, plugins: unknown
  try { [inspect, mcps, plugins] = outputs.map(value => JSON.parse(value)) } catch { throw new Error('grok_inventory_invalid') }
  if (!record(inspect) || !Array.isArray(mcps) || !mcps.every(record) || !Array.isArray(plugins) || !plugins.every(record)) {
    throw new Error('grok_inventory_invalid')
  }
  await applyNativePluginStates(inspect, options)
  const safeInspect = redactGrokInventoryValue(inspect) as JsonRecord
  const items = inspectItems(safeInspect, redactGrokInventoryValue(mcps) as unknown[], redactGrokInventoryValue(plugins) as unknown[])
  for (const entry of items) {
    // Check native origin before redaction; a redacted placeholder is not a valid installation ID.
    if (entry.kind === 'mcp') {
      const matching = mcps.filter(value => value.name === entry.name)
      const discovered = (inspect.mcpServers as JsonRecord[]).filter(value => value.name === entry.name)
      entry.manageable = matching.length === 1 && matching[0].scope === 'user' && (
        // inspect omits disabled servers; mcp list still supplies their native user scope.
        discovered.length === 0 && matching[0].enabled === false ||
        discovered.length === 1 && !discovered[0].vendor && sourceType(discovered[0].source) === 'configToml'
      )
      const enabled = matching.length === 1 ? matching[0].enabled !== false : undefined
      entry.source = matching.length === 1 ? `${matching[0].scope}${enabled ? '' : ' · disabled'}` : entry.source
      // Native editable configs need secret changes to invalidate CAS; only the digest crosses IPC.
      entry.fingerprint = digest({ previous: entry.fingerprint,
        definitions: entry.manageable ? matching : redactGrokInventoryValue(matching), enabled })
    } else if (entry.kind === 'plugin') {
      const matching = plugins.filter(value => value.name === entry.name)
      const discovered = (inspect.plugins as JsonRecord[]).filter(value => value.name === entry.name)
      entry.manageable = matching.length === 1 && matching[0].status === 'installed' &&
        text(matching[0].repo_key) && discovered.length === 1 && discovered[0].scope === 'user' &&
        await isNativeInstalledPlugin(matching[0], discovered[0], options)
      entry.version = matching.length === 1 && text(matching[0].version) ? matching[0].version : undefined
      entry.fingerprint = digest({ previous: entry.fingerprint, definitions: matching.map(value => ({
        ...redactGrokInventoryValue(value) as JsonRecord,
        installationId: text(value.repo_key) ? digest(value.repo_key) : undefined
      })) })
    }
  }
  const inventory: CapabilityAgentInventory = {
    agentId: 'grok', available: true, writable: items.some(entry => entry.manageable), status: 'available',
    revision: digest(items.map(entry => ({
      id: entry.id, kind: entry.kind, name: entry.name, scope: entry.scope, origin: entry.origin,
      fingerprint: entry.fingerprint, manageable: entry.manageable, status: entry.status, source: entry.source, components: entry.components
    }))), items
  }
  return { inspect, mcps, plugins, inventory }
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

async function safeDetailFile(path: string, source: JsonRecord, state: InventorySnapshot, options: GrokInventoryOptions): Promise<{ path: string; root: string } | undefined> {
  if (!text(path,4096) || !isAbsolute(path)) return undefined
  const gh = resolve(options.env?.GROK_HOME || process.env.GROK_HOME || join(options.env?.HOME || homedir(), '.grok'))
  const home = resolve(options.env?.HOME || homedir())
  const project = resolve(text(state.inspect.projectRoot,4096) ? state.inspect.projectRoot : options.cwd)
  const bases = [gh, home, resolve(options.cwd), project]
  const kind = sourceType(source)
  const roots = bases.flatMap(base => base === gh
    ? ['skills','commands','agents','plugins','installed-plugins','bundled'].map(folder => join(base,folder))
    : ['.grok','.agents','.claude','.cursor'].flatMap(vendor => ['skills','commands','agents','plugins'].map(folder => join(base,vendor,folder))))
  const allowed = roots.find(root => inside(root,path))
  if (!allowed || !['user','project','plugin','builtin','claude','cursor','codex'].includes(kind || '')) return undefined
  try {
    // Canonicalize only trusted base directories; secureRegularText rejects all child symlinks.
    const base = bases.find(root => inside(root,allowed))!
    const canonicalBase = await realpath(base)
    const canonicalPath = join(canonicalBase,relative(base,path))
    return { path: canonicalPath, root: canonicalBase }
  } catch { return undefined }
}

/** Resolve an opaque current inventory item; never accept caller-provided filesystem paths. */
export async function getGrokInventoryDetail(bin: string, id: string, options: GrokInventoryOptions): Promise<CapabilityInventoryDetail> {
  const state = await snapshot(bin,options)
  const entry = state.inventory.items.find(item => item.id === id)
  if (!entry) return { id, name: '', kind: 'skill', openable: false }
  const detail: CapabilityInventoryDetail = { id, name: entry.name, kind: entry.kind, openable: false }
  if (entry.kind === 'mcp' || entry.kind === 'plugin' || entry.kind === 'hook') {
    if (entry.kind === 'mcp' && entry.manageable) {
      const server = state.mcps.find(value => value.name === entry.name)!
      const configuration = Object.fromEntries(MCP_CONFIG_FIELDS.filter(key => server[key] !== undefined).map(key => [key, server[key]]))
      if (configuration.transport === undefined) configuration.transport = typeof server.command === 'string' ? 'stdio' : 'http'
      detail.manifestText = JSON.stringify(redactGrokInventoryValue(configuration), null, 2)
      detail.manifestFile = 'mcp.json'
      return detail
    }
    const values = entry.kind === 'mcp' ? state.inspect.mcpServers : entry.kind === 'plugin' ? state.inspect.plugins : state.inspect.hooks
    const matching = (values as JsonRecord[]).filter(value => value.name === entry.name || value.event === entry.name)
    detail.manifestText = JSON.stringify(redactGrokInventoryValue(matching),null,2)
    detail.manifestFile = `${entry.kind}.json`
    return detail
  }
  if (entry.kind !== 'skill' && entry.kind !== 'agent-profile') return detail
  const values = (entry.kind === 'skill' ? state.inspect.skills : state.inspect.agents) as JsonRecord[]
  const matching = values.filter(value => value.name === entry.name)
  if (matching.length !== 1 || !record(matching[0].source)) return detail
  const source = matching[0].source
  const safe = await safeDetailFile(source.path as string,source,state,options)
  if (!safe) return detail
  try {
    detail.manifestText = await secureRegularText(safe.path,safe.root,2*1024*1024)
    detail.manifestFile = basename(safe.path)
    if (entry.kind === 'skill') {
      const folder = dirname(safe.path)
      const entries = await readdir(folder,{withFileTypes:true})
      detail.files = []
      for (const value of entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0,200)) {
        if (value.name.startsWith('.') || value.isSymbolicLink()) continue
        const info = await lstat(join(folder,value.name))
        if (!info.isFile() && !info.isDirectory()) continue
        detail.files.push({ relativePath: value.name, directory: info.isDirectory(), ...(info.isFile() ? { size: info.size } : {}) })
      }
      detail.folderPath = folder
      detail.openable = true
    }
  } catch { /* The provider can discover a symlink or a file that changed after enumeration. */ }
  return detail
}

function validName(value: unknown): value is string {
  return text(value,200) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
}

function argument(value: unknown, maximum=16384): value is string {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000\r\n]/.test(value)
}

function stringMap(value: unknown, header=false): value is Record<string,string> {
  return record(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key,value]) =>
    (header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key) && argument(value))
}

function mcpArguments(name: string, config: GrokMcpConfiguration): string[] {
  if (!validName(name) || !['stdio','http','sse'].includes(config.transport) || containsRedacted(config)) throw new Error('grok_inventory_request_invalid')
  const args = ['mcp','add','--scope','user','--transport',config.transport,name]
  if (config.env !== undefined && !stringMap(config.env)) throw new Error('grok_inventory_request_invalid')
  if (config.headers !== undefined && !stringMap(config.headers,true)) throw new Error('grok_inventory_request_invalid')
  for (const [key,value] of Object.entries(config.env || {})) args.push('--env',`${key}=${value}`)
  for (const [key,value] of Object.entries(config.headers || {})) args.push('--header',`${key}: ${value}`)
  if (config.transport === 'stdio') {
    if (config.url !== undefined || !argument(config.command) || !config.command || config.command.startsWith('-') ||
        config.args !== undefined && (!Array.isArray(config.args) || config.args.length>100 || !config.args.every(value => argument(value)))) {
      throw new Error('grok_inventory_request_invalid')
    }
    args.push('--',config.command,...(config.args || []))
  } else {
    if (config.command !== undefined || config.args !== undefined) throw new Error('grok_inventory_request_invalid')
    let url: URL
    try { url = new URL(config.url!) } catch { throw new Error('grok_inventory_request_invalid') }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !argument(config.url)) throw new Error('grok_inventory_request_invalid')
    args.push(config.url)
  }
  return args
}

function containsRedacted(value: unknown): boolean {
  if (value === REDACTED) return true
  if (Array.isArray(value)) return value.some(containsRedacted)
  return record(value) && Object.values(value).some(containsRedacted)
}

function retainRedacted(value: unknown, previous: unknown): unknown {
  if (value === REDACTED) {
    if (previous === undefined) throw new Error('grok_inventory_request_invalid')
    return previous
  }
  if (Array.isArray(value)) return value.map((item, index) => retainRedacted(item, Array.isArray(previous) ? previous[index] : undefined))
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, nested]) =>
    [key, retainRedacted(nested, record(previous) ? previous[key] : undefined)]))
  return value
}

/** Native CLI mutations with origin checks and a fresh inventory returned after completion. */
export async function manageGrokInventory(bin: string, request: GrokInventoryManageRequest, options: GrokInventoryOptions): Promise<CapabilityAgentInventory> {
  if (!record(request as unknown) || !text(request.action,100)) throw new Error('grok_inventory_request_invalid')
  const configFields = ['transport', 'command', 'args', 'url', 'env', 'headers']
  const fields: Record<string, string[]> = {
    'mcp-add': ['name', 'scope', ...configFields], 'mcp-update': ['id', ...configFields],
    'mcp-enable': ['id'], 'mcp-disable': ['id'], 'mcp-remove': ['id'],
    'plugin-enable': ['id'], 'plugin-disable': ['id'], 'plugin-uninstall': ['id'], 'plugin-update': ['id'],
    'plugin-install': ['source']
  }
  if (!Object.hasOwn(fields, request.action) || Object.keys(request).some(key =>
    !['action', 'expectedRevision', ...fields[request.action]].includes(key)) ||
    request.expectedRevision !== undefined && !text(request.expectedRevision, 100)) throw new Error('grok_inventory_request_invalid')
  const state = await snapshot(bin,options)
  if (request.expectedRevision !== undefined && request.expectedRevision !== state.inventory.revision) throw new Error('grok_inventory_stale')
  const runner = options.runner || nativeGrokInventoryCommandRunner
  let args: string[]
  let disableAfterUpdate: string | undefined
  if (request.action === 'mcp-add') {
    if (request.scope !== undefined && request.scope !== 'user') throw new Error('grok_inventory_request_invalid')
    if (state.mcps.some(value => value.name === request.name) || (state.inspect.mcpServers as JsonRecord[]).some(value => value.name === request.name)) throw new Error('grok_inventory_already_exists')
    args = mcpArguments(request.name,request)
  } else if (request.action === 'plugin-install') {
    if (!argument(request.source,4096) || !request.source || request.source.startsWith('-')) throw new Error('grok_inventory_request_invalid')
    args = ['plugin','install',request.source,'--trust']
  } else {
    const entry = state.inventory.items.find(value => value.id === request.id)
    if (!entry || !entry.manageable || !validName(entry.name)) throw new Error('grok_inventory_readonly')
    if (request.action.startsWith('mcp-')) {
      if (entry.kind !== 'mcp') throw new Error('grok_inventory_request_invalid')
      const matching = state.mcps.filter(value => value.name === entry.name)
      if (matching.length !== 1 || matching[0].scope !== 'user') throw new Error('grok_inventory_ambiguous')
      if (request.action === 'mcp-update') {
        const original = matching[0]
        // Native add replaces the record; retain omitted secrets, reject unknown fields before loss.
        if (Object.keys(original).some(key => !['name','scope','transport','command','args','url','env','headers','enabled'].includes(key))) {
          throw new Error('grok_inventory_mcp_update_unsupported')
        }
        const config = Object.fromEntries(MCP_CONFIG_FIELDS.filter(key => key !== 'enabled').map(key => [key,
          retainRedacted((request as unknown as JsonRecord)[key] === undefined && ['env', 'headers'].includes(key)
            ? original[key] : (request as unknown as JsonRecord)[key], original[key])
        ])) as unknown as GrokMcpConfiguration
        args = mcpArguments(entry.name,config)
        if (original.enabled === false) disableAfterUpdate = entry.name
      } else if (request.action === 'mcp-remove') args = ['mcp','remove','--scope','user',entry.name]
      else if (request.action === 'mcp-enable' || request.action === 'mcp-disable') args = ['mcp',request.action.slice(4),entry.name]
      else throw new Error('grok_inventory_request_invalid')
    } else if (request.action.startsWith('plugin-')) {
      if (entry.kind !== 'plugin') throw new Error('grok_inventory_request_invalid')
      const matching = state.plugins.filter(value => value.name === entry.name)
      const target = matching[0]
      if (matching.length !== 1 || !text(target?.repo_key)) throw new Error('grok_inventory_ambiguous')
      const siblings = state.plugins.filter(value => value.repo_key === target.repo_key || typeof target.path === 'string' && value.path === target.path)
      if (request.action === 'plugin-uninstall' || request.action === 'plugin-update') {
        if (siblings.length !== 1) throw new Error('grok_inventory_multi_plugin')
      }
      if (request.action === 'plugin-uninstall') args = ['plugin','uninstall',entry.name,'--keep-data']
      else if (['plugin-enable','plugin-disable','plugin-update'].includes(request.action)) args = ['plugin',request.action.slice(7),entry.name]
      else throw new Error('grok_inventory_request_invalid')
    } else throw new Error('grok_inventory_request_invalid')
  }
  await runner(bin,args,options)
  if (disableAfterUpdate) await runner(bin,['mcp','disable',disableAfterUpdate],options)
  return (await snapshot(bin,options)).inventory
}
