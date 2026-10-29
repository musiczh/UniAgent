import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, lstat, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as TOML from '@iarna/toml'
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml'
import type { AgentDef } from '../shared/types.ts'
import type { CapabilityAgentId, CapabilityAgentInventory, CapabilityInventoryDetail, CapabilityInventoryItem, CapabilityInventoryResult } from '../shared/capabilitySync.ts'
import { listCapabilityInventories, getCapabilityInventoryDetail, skillLinkDependencies } from './capability-sync/inventory.ts'
import { discoverSkillRoot, secureManifest, secureRegularText } from './capability-sync/skillDiscovery.ts'
import { atomicRenameExclusiveSync, helperAvailable } from './capability-sync/atomicFs.ts'
import type { PluginCommandRunner } from './capability-sync/plugins.ts'
import { grokInventoryFromOptions, readonlyGrokInventoryRunner } from './grokInventory.ts'
import { providerPaths } from './capability-sync/provider.ts'
import { manageBetaCapabilityInventory } from './betaCapabilityManagement.ts'
import { getKimiInventoryDetail, inspectKimiInventory } from './kimiInventory.ts'

type Source = NonNullable<CapabilityAgentInventory['readSources']>[number]
type ToolAgent = Pick<AgentDef, 'id' | 'name' | 'bin' | 'installed' | 'adapter'>
type NativeSkill = { name: string; path: string; description?: string; builtin?: boolean }
export interface AgentToolInventoryOptions {
  home: string
  agents: readonly ToolAgent[]
  env?: NodeJS.ProcessEnv
  deepseekHome?: string
  pluginRunner?: PluginCommandRunner
  run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>
  kimiPluginRemove?: (id: string) => Promise<void>
  zcodePlugins?: () => Promise<unknown>
  zcodePluginRemove?: (id: string) => Promise<void>
  nativeSkills?: Partial<Record<'nika' | 'zcode', () => Promise<{ skills: NativeSkill[]; plugins?: string[]; tools?: string[]; mcps?: string[]; commands?: string[]; errors?: string[] }>>>
}
interface SkillRoot { path: string; scope: 'agent' | 'shared' | 'builtin'; depth?: number; flat?: boolean; parentName?: string; nesting?: number }
const exec = promisify(execFile)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
const identifier = (agentId: string, kind: string, path: string): string => `${agentId}:files:${kind}:${hash(path).slice(0, 24)}`
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)
const runNative = async (bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
  (await exec(bin, args, { env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })).stdout

async function source(path: string, kind: Source['kind']): Promise<Source> {
  try { await access(path); return { path, kind, status: 'read' } }
  catch (error) { return { path, kind, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error' } }
}

async function config(path: string): Promise<Record<string, any>> {
  try {
    const root = await realpath(dirname(path))
    const text = await secureRegularText(join(root, basename(path)), root, 2 * 1024 * 1024)
    const value = path.endsWith('.toml') ? TOML.parse(text) : path.endsWith('.yaml') ? loadYaml(text, { schema: JSON_SCHEMA }) : JSON.parse(text)
    if (!record(value)) throw new Error('invalid_config')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('工具配置无法读取或格式无效')
  }
}

async function fileSkill(agentId: CapabilityAgentId, entry: string, scope: SkillRoot['scope'], flat = false): Promise<CapabilityInventoryItem> {
  const info = await lstat(entry)
  let resolved = entry, manifestPath: string | undefined, fingerprint = '', status: CapabilityInventoryItem['status'] = 'available'
  const linked = info.isSymbolicLink()
  let name = flat ? basename(entry, '.md') : basename(entry)
  try {
    if (linked) resolved = resolve(dirname(entry), await readlink(entry))
    resolved = await realpath(resolved)
    manifestPath = flat ? resolved : join(resolved, 'SKILL.md')
    const manifest = await secureManifest(manifestPath, dirname(manifestPath))
    fingerprint = linked ? hash(`${await readlink(entry)}\0${manifest.fingerprint}`) : manifest.fingerprint
    const metadata = manifest.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (metadata) {
      const parsed = loadYaml(metadata[1], { schema: JSON_SCHEMA })
      if (record(parsed) && safeName(parsed.name)) name = parsed.name
    }
  } catch {
    status = 'invalid'
    manifestPath = flat ? resolved : join(resolved, 'SKILL.md')
    fingerprint = hash(`invalid:${resolved}`)
  }
  const manageable = scope !== 'builtin' && helperAvailable() && (linked || status === 'available')
  return { id: identifier(agentId, 'skill', entry), agentId, kind: 'skill', name,
    scope, owner: scope === 'agent' ? 'user' : scope === 'builtin' ? 'system' : 'shared', origin: dirname(entry),
    fingerprint, manageable, copyable: false, linked: linked || undefined, entryPath: entry,
    location: flat ? dirname(resolved) : resolved, manifestPath, status,
    ...(status === 'invalid' ? { issueCode: 'unsafe_skill_entry' as const } : {}),
    ...(manageable ? { removal: linked ? 'link' as const : 'skill' as const } : { readOnlyReason: scope === 'builtin' ? '由 Agent 安装和更新维护。' : '文件不可安全读取或文件管理组件尚未就绪。' }) }
}

async function scanRoot(agentId: CapabilityAgentId, root: SkillRoot, sources: Source[]): Promise<CapabilityInventoryItem[]> {
  const state = await source(root.path, 'skill'); sources.push(state)
  if (state.status !== 'read') return []
  const anchor = await realpath(root.path)
  // Reuse the shared directory scanner for directory bundles, including symlinks.
  const discoveries = await discoverSkillRoot(anchor, anchor, root.scope === 'shared' ? 'shared' : 'agent', root.depth ?? 0)
  if (discoveries.some(item => !item.entryPath && item.status === 'invalid')) state.status = 'error'
  const items: CapabilityInventoryItem[] = []
  for (const discovered of discoveries) {
    const entry = discovered.entryPath || discovered.linkPath
    if (entry) {
      if (root.flat && dirname(entry) === anchor && basename(entry).endsWith('.md')) continue
      const item = await fileSkill(agentId, join(root.path, relative(anchor, entry)), root.scope, basename(entry) === 'SKILL.md')
      if (basename(entry) === 'SKILL.md' && item.name === 'SKILL') item.name = discovered.name
      items.push(item)
    }
  }
  if (root.flat) for (const entry of await readdir(anchor, { withFileTypes: true })) {
    if (!entry.name.startsWith('.') && entry.name.endsWith('.md') && !(root.parentName && entry.name === 'SKILL.md') && (entry.isFile() || entry.isSymbolicLink())) {
      items.push(await fileSkill(agentId, join(root.path, entry.name), root.scope, true))
    }
  }
  if (agentId === 'kimi' && (root.nesting || 0) < 8) {
    for (const item of [...items]) if (item.status === 'available' && item.manifestPath && item.entryPath && basename(item.manifestPath) === 'SKILL.md') {
      const text = (await secureManifest(item.manifestPath, dirname(item.manifestPath))).text
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const metadata = frontmatter ? loadYaml(frontmatter[1], { schema: JSON_SCHEMA }) : undefined
      if (record(metadata) && (metadata['has-sub-skill'] === true || metadata.hasSubSkill === true || metadata.metadata?.['has-sub-skill'] === true)) {
        items.push(...await scanRoot(agentId, { ...root, path: item.entryPath, parentName: item.name, nesting: (root.nesting || 0) + 1 }, sources))
      }
    }
  }
  if (root.parentName) for (const item of items) if (!item.name.startsWith(root.parentName + '.')) item.name = `${root.parentName}.${item.name}`
  return items
}

async function pluginSkills(plugin: CapabilityInventoryItem, sources: Source[]): Promise<CapabilityInventoryItem[]> {
  if (!plugin.location || !plugin.manifestPath || plugin.enabled === false) return []
  const manifest = await config(plugin.manifestPath)
  if (plugin.agentId === 'kimi' && manifest.skills == null) {
    try {
      await access(join(plugin.location, 'SKILL.md'))
      const skill = await fileSkill('kimi', plugin.location, 'agent')
      sources.push(await source(join(plugin.location, 'SKILL.md'), 'skill'))
      return [{ ...skill, scope: 'plugin', owner: 'plugin', manageable: false, removal: undefined, plugin: plugin.pluginId,
        readOnlyReason: `随插件“${plugin.name}”启用和卸载，请管理所属插件。` }]
    } catch { /* A directory manifest may declare a conventional skills folder instead. */ }
  }
  const paths = manifest.skills === false ? [] : Array.isArray(manifest.skills) ? manifest.skills
    : typeof manifest.skills === 'string' ? [manifest.skills] : ['skills']
  const items: CapabilityInventoryItem[] = []
  for (const path of paths) {
    if (typeof path !== 'string') continue
    const root = resolve(plugin.location, path)
    if (!inside(plugin.location, root)) continue
    let skills: CapabilityInventoryItem[]
    try {
      await access(join(root, 'SKILL.md'))
      sources.push(await source(root, 'skill'))
      const manifest = join(root, 'SKILL.md'), linkedManifest = (await lstat(manifest)).isSymbolicLink()
      skills = [await fileSkill(plugin.agentId, linkedManifest ? manifest : root, 'agent', linkedManifest)]
    } catch { skills = await scanRoot(plugin.agentId, { path: root, scope: 'agent', depth: 6 }, sources) }
    for (const skill of skills) {
      items.push({ ...skill, scope: 'plugin', owner: 'plugin', manageable: false, removal: undefined,
        name: plugin.agentId === 'claude' ? `${plugin.name}:${skill.name}` : skill.name,
        plugin: plugin.pluginId, origin: plugin.name, enabled: plugin.enabled,
        readOnlyReason: `随插件“${plugin.name}”启用和卸载，请管理所属插件。` })
    }
  }
  return items
}

async function supplementary(agent: ToolAgent, options: AgentToolInventoryOptions): Promise<CapabilityAgentInventory> {
  const agentId = agent.id as CapabilityAgentId, { home } = options
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, HOME: home }
  const roots: SkillRoot[] = [], readSources: Source[] = [], items: CapabilityInventoryItem[] = []
  const nativeSkillItems: CapabilityInventoryItem[] = []
  let message: string | undefined
  let nativeRevision: string | undefined, nativeWritable = false
  const add = (path: string, scope: SkillRoot['scope'] = 'agent', flat = false, depth = 0) => roots.push({ path, scope, flat, depth })
  const shared = join(home, '.agents/skills')
  if (agentId === 'kimi') {
    const userHome = env.KIMI_CODE_HOME || join(home, '.kimi-code'), path = join(userHome, 'config.toml')
    readSources.push(await source(path, 'config'))
    const settings = await config(path)
    add(join(userHome, 'skills'), 'agent', true)
    add(shared, 'shared', true)
    if (Array.isArray(settings.extra_skill_dirs)) for (const value of settings.extra_skill_dirs) if (typeof value === 'string') {
      add(value.startsWith('~/') ? join(home, value.slice(2)) : resolve(home, value), 'agent', true)
    }
    const nativeConfig = await inspectKimiInventory({ home, cwd: home, env })
    nativeRevision = nativeConfig.revision; nativeWritable = nativeConfig.writable
    items.push(...nativeConfig.items.filter(item => item.kind === 'mcp' && item.source?.startsWith('user')).map(item => ({ ...item,
      status: item.status === 'shadowed' ? 'available' as const : item.status, issueCode: item.issueCode === 'shadowed_capability' ? undefined : item.issueCode })))
    readSources.push(await source(join(userHome, 'mcp.json'), 'config'))
    const pluginFile = join(userHome, 'plugins/installed.json'); readSources.push(await source(pluginFile, 'plugin'))
    try {
      const installed = await config(pluginFile)
      if (installed.plugins !== undefined && !Array.isArray(installed.plugins)) throw new Error('invalid_plugins')
      for (const plugin of installed.plugins || []) {
        if (!record(plugin) || !safeName(plugin.id) || typeof plugin.root !== 'string' || !isAbsolute(plugin.root)) continue
        let manifestPath = join(plugin.root, 'kimi.plugin.json')
        try { await access(manifestPath) } catch { manifestPath = join(plugin.root, '.kimi-plugin/plugin.json') }
        const manifest = await config(manifestPath)
        items.push({ id: identifier(agentId, 'plugin', plugin.id), agentId, kind: 'plugin', name: safeName(manifest.name) ? manifest.name : plugin.id,
          pluginId: plugin.id, scope: 'plugin', owner: 'plugin', origin: pluginFile, location: plugin.root, manifestPath,
          enabled: plugin.enabled !== false, version: typeof manifest.version === 'string' ? manifest.version : undefined,
          fingerprint: hash(JSON.stringify(plugin)), manageable: !!options.kimiPluginRemove && agent.installed !== false,
          copyable: false, status: 'available', ...(!options.kimiPluginRemove ? { readOnlyReason: 'Kimi 原生插件服务尚不可用，请先准备 Agent 运行环境。' } : {}) })
      }
    } catch { readSources.at(-1)!.status = 'error'; message = 'Kimi 插件登记或清单无法读取；已保留可读取的 Skill。' }
  } else if (agentId === 'mcode') {
    const data = env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR || join(home, env.MAVIS_PROFILE ? `.minimax-${env.MAVIS_PROFILE}` : '.minimax')
    const path = join(data, 'config.yaml'); readSources.push(await source(path, 'config'))
    const settings = await config(path)
    const external = settings.skills?.external
    add(join(data, 'agents/mavis/skills'))
    const userRoots: { path: string; scope: 'agent' | 'shared'; priority: number }[] = [{ path: join(data, 'skills'), scope: 'agent', priority: 0 }]
    if (external?.enabled !== false) for (const [id, dir, priority] of [['user-cc', '.claude', 40], ['user-codex', '.codex', 35], ['user-agents', '.agents', 30]] as const) {
      const configured = external?.sources?.[id] ?? (id === 'user-cc' ? external?.sources?.['user-claude'] : undefined)
      if (configured?.enabled !== false) userRoots.push({ path: join(home, dir, 'skills'), scope: 'shared',
        priority: typeof configured?.priority === 'number' && Number.isFinite(configured.priority) ? configured.priority : priority })
    }
    for (const root of userRoots.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path))) add(root.path, root.scope, false, 6)
    add(join(data, '.builtin-skills'), 'builtin', false, 6)
    readSources.push({ path: `${agent.bin} plugin list --json`, kind: 'native', status: 'read' })
    try {
      const raw: unknown = JSON.parse(await (options.run || runNative)(agent.bin, ['plugin', 'list', '--json'], env))
      if (!record(raw) || !Array.isArray(raw.installed)) throw new Error('MiniMax 插件清单格式无效')
      for (const plugin of raw.installed) if (record(plugin) && plugin.installed !== false && safeName(plugin.pluginId) && safeName(plugin.name)) {
      items.push({ id: identifier(agentId, 'plugin', plugin.pluginId), agentId, kind: 'plugin', name: safeName(plugin.displayName) ? plugin.displayName : plugin.name,
        scope: 'plugin', owner: 'plugin', origin: plugin.marketplaceName || plugin.marketplace || 'MiniMax Code', pluginId: plugin.pluginId,
        version: typeof plugin.version === 'string' ? plugin.version : undefined, source: plugin.enabled === false ? 'disabled' : 'enabled',
        fingerprint: hash(JSON.stringify(plugin)), manageable: true, copyable: false, status: 'available', enabled: plugin.enabled !== false,
        components: { skills: Number(plugin.capabilities?.skillCount) || 0, mcps: Number(plugin.capabilities?.mcpServerCount) || 0,
          apps: Number(plugin.capabilities?.appCount) || 0, hooks: 0, commands: 0, models: 0 } })
      }
    } catch {
      readSources.at(-1)!.status = 'error'
      message = 'MiniMax 插件清单读取失败；已保留可读取的 Skill，请重新扫描。'
    }
  } else if (agentId === 'deepseek') {
    const data = options.deepseekHome
    if (!data) throw new Error('DeepSeek 运行环境尚未准备完成')
    add(join(data, 'skills'), 'agent', true); add(join(data, '.agents/skills'), 'shared', true)
    const profile = join(data, 'profiles/default/package.json'); readSources.push(await source(profile, 'plugin'))
    const manifest = await config(profile)
    for (const [name, version] of Object.entries(manifest.dependencies || {})) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) continue
      const protectedPlugin = ['@deepseek-ai/dsh-acp', '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/dsh-skill-filesystem'].includes(name) || name.startsWith('uniagent-')
      items.push({ id: identifier(agentId, 'plugin', name), agentId, kind: 'plugin', name, pluginId: name,
        scope: 'plugin', owner: protectedPlugin ? 'system' : 'plugin', origin: profile, version: String(version),
        location: join(dirname(profile), 'node_modules', name), fingerprint: hash(`${name}:${version}`), manageable: !protectedPlugin,
        copyable: false, status: 'available', ...(protectedPlugin ? { readOnlyReason: 'DeepSeek 原生运行组件，由运行环境维护。' } : {}) })
    }
  } else if (agentId === 'grok') {
    const data = env.GROK_HOME || join(home, '.grok'), path = join(data, 'config.toml')
    readSources.push(await source(path, 'config'))
    const settings = await config(path)
    add(join(data, 'skills')); add(join(home, '.claude/skills'), 'shared')
    if (Array.isArray(settings.skills?.paths)) for (const value of settings.skills.paths) if (typeof value === 'string') {
      add(value.startsWith('~/') ? join(home, value.slice(2)) : resolve(home, value))
    }
    const native = await grokInventoryFromOptions(agent.bin, { cwd: home, env,
      runner: options.run ? async (bin, args) => ({ stdout: await options.run!(bin, ['--no-auto-update', ...args], env) }) : readonlyGrokInventoryRunner })
    nativeRevision = native.revision; nativeWritable = native.writable
    items.push(...native.items.filter(item => item.kind !== 'skill'))
    nativeSkillItems.push(...native.items.filter(item => item.kind === 'skill').map(item => ({ ...item,
      readOnlyReason: 'Grok 原生目录未返回该技能的文件位置，请通过所属插件或 Agent 管理。' })))
    readSources.push({ path: `${agent.bin} inspect / mcp list / plugin list --json`, kind: 'native', status: native.status === 'invalid' ? 'error' : 'read' })
    if (native.status !== 'available') message = 'Grok 原生清单未能完整读取；已保留可读取的文件工具。'
  } else if ( agentId === 'zcode') {
    const discover = options.nativeSkills?.[agentId]
    readSources.push({ path:  'ZCode 原生 skills/referenceCatalog、mcp/list、workspace/readPresentation', kind: 'native', status: discover ? 'read' : 'error' })
    if (!discover) throw new Error(`${agent.name} 原生工具目录尚不可用，请先在 Agent 设置中准备运行环境。`)
    const native = await discover()
    if (native.errors?.length) {
      message = '部分原生能力读取失败，请重新扫描或在 Agent 设置检查运行状态。'
      readSources.at(-1)!.status = 'error'
    }
    for (const skill of native.skills) {
      if (!safeName(skill.name) || !isAbsolute(skill.path)) continue
      const manifestLink = basename(skill.path) === 'SKILL.md' && (await lstat(skill.path)).isSymbolicLink()
      const logical = basename(skill.path) === 'SKILL.md' && !manifestLink ? dirname(skill.path) : skill.path
      const entry = join(await realpath(dirname(logical)), basename(logical))
      const scope = inside(join(home, '.agents/skills'), entry) ? 'shared' : skill.builtin || /[/\\](?:\.system|\.builtin-skills|node_modules)[/\\]/.test(entry) ? 'builtin' : 'agent'
      const item = await fileSkill(agentId, entry, scope, basename(entry).endsWith('.md'))
      item.name = skill.name; items.push(item)
      readSources.push(await source(dirname(entry), 'skill'))
    }
    for (const plugin of native.plugins || []) if (safeName(plugin)) {
      items.push({ id: identifier(agentId, 'plugin', plugin), agentId, kind: 'plugin', name: plugin, scope: 'plugin', owner: 'plugin',
        origin: `${agent.name} native config`, fingerprint: hash(plugin), manageable: false, copyable: false, status: 'available',
        readOnlyReason: `${agent.name} 当前原生接口未提供插件卸载，请在该 Agent 的插件设置中管理。` })
    }
    for (const [kind, names] of [['tool', native.tools], ['mcp', native.mcps], ['command', native.commands]] as const) {
      for (const name of names || []) if (safeName(name)) items.push({ id: identifier(agentId, kind, name), agentId, kind, name,
        scope: 'builtin', owner: 'system', origin: `${agent.name} native catalog`, fingerprint: hash(`${kind}:${name}`),
        manageable: false, copyable: false, status: 'available', readOnlyReason: `由 ${agent.name} 原生能力目录提供，请在所属 Agent 中管理。` })
    }
    if (agentId === 'zcode' && options.zcodePlugins) {
      readSources.push({ path: 'ZCode 原生 plugins/list（user scope）', kind: 'native', status: 'read' })
      try {
        const result = await options.zcodePlugins()
        if (!record(result) || !Array.isArray(result.plugins)) throw new Error('invalid_plugins')
        for (const plugin of result.plugins) if (record(plugin) && safeName(plugin.id) && safeName(plugin.name)) {
          const location = typeof plugin.rootPath === 'string' && isAbsolute(plugin.rootPath) ? await realpath(plugin.rootPath).catch(() => plugin.rootPath) : undefined
          items.push({ id: identifier(agentId, 'plugin', plugin.id), agentId, kind: 'plugin', name: plugin.name,
            pluginId: plugin.id, scope: 'plugin', owner: 'plugin', origin: plugin.marketplace || 'ZCode native plugins',
            location, manifestPath: typeof plugin.manifestPath === 'string' && isAbsolute(plugin.manifestPath) ? plugin.manifestPath : undefined,
            enabled: plugin.enabled !== false, version: typeof plugin.version === 'string' ? plugin.version : undefined,
            manageable: !!options.zcodePluginRemove, copyable: false, status: 'available',
            fingerprint: hash(JSON.stringify([plugin.id, plugin.version, plugin.enabled, plugin.rootPath, plugin.manifestPath])),
            components: { skills: Number(plugin.skillCount) || 0, mcps: Array.isArray(plugin.mcpServerNames) ? plugin.mcpServerNames.length : 0,
              commands: Number(plugin.commandRootCount) || 0, hooks: Array.isArray(plugin.hookDetails) ? plugin.hookDetails.length : 0, apps: 0, models: 0 } })
          if (location) for (const skill of items) if (skill.kind === 'skill' && skill.location && inside(location, skill.location)) {
            skill.scope = 'plugin'; skill.owner = 'plugin'; skill.manageable = false; skill.removal = undefined; skill.plugin = plugin.id
            skill.readOnlyReason = `随插件“${plugin.name}”启用和卸载，请管理所属插件。`
          }
        }
      } catch { readSources.at(-1)!.status = 'error'; message = 'ZCode 插件清单读取失败；已保留其它可读取的工具。' }
    }
  }
  for (const root of roots) {
    try { items.push(...await scanRoot(agentId, root, readSources)) }
    catch { readSources.push({ path: root.path, kind: 'skill', status: 'error' }) }
  }
  for (const item of nativeSkillItems) if (!items.some(other => other.kind === 'skill' && other.name === item.name)) items.push(item)
  if (agentId === 'kimi') for (const plugin of items.filter(item => item.kind === 'plugin')) {
    try { items.push(...await pluginSkills(plugin, readSources)) }
    catch { readSources.push({ path: plugin.manifestPath || plugin.origin, kind: 'plugin', status: 'error' }) }
  }
  if (['kimi', 'deepseek', 'grok', 'mcode'].includes(agentId)) {
    const seen = new Set<string>()
    for (const item of items) if (item.kind === 'skill' && item.status === 'available') {
      const key = item.name.toLowerCase()
      if (seen.has(key)) { item.status = 'shadowed'; item.issueCode = 'shadowed_capability' }
      else seen.add(key)
    }
  }
  const failed = readSources.some(value => value.status === 'error')
  return { agentId, agentName: agent.name, available: agent.installed !== false, writable: nativeWritable || items.some(item => item.manageable),
    managementSupported: agentId === 'grok' || agentId === 'kimi', status: failed ? 'invalid' : 'available',
    ...(failed ? { issueCode: 'unsafe_skill_entry' as const } : {}), revision: nativeRevision || hash(JSON.stringify(items)), items,
    readSources: [...new Map(readSources.map(value => [value.path, value])).values()], ...(message ? { message } : {}) }
}

/** The registered Agent catalog is the only source of the selectable Agent list. */
export async function listAgentToolInventories(options: AgentToolInventoryOptions): Promise<CapabilityInventoryResult> {
  const base = await listCapabilityInventories(options.home, options.pluginRunner, undefined, options.agents.map(agent => agent.id))
  const byAgent = new Map(base.inventories.map(inventory => [inventory.agentId, inventory]))
  const inventories: CapabilityAgentInventory[] = await Promise.all(options.agents.map(async agent => {
    const agentId = agent.id as CapabilityAgentId
    try {
      const existing = byAgent.get(agentId)
      if (existing) {
        const root = join(options.home, agentId === 'codex' ? '.codex' : agentId === 'traex' ? '.trae' : '.claude')
        const paths = agentId === 'codex' || agentId === 'traex' ? providerPaths(agentId, options.home) : undefined
        existing.agentName = agent.name
        existing.readSources = await Promise.all([source(paths?.skills || join(root, 'skills'), 'skill'), source(paths?.config || join(options.home, '.claude.json'), 'config'),
          ...(agentId === 'claude' ? [] : [source(join(options.home, '.agents/skills'), 'skill')])])
        existing.readSources.push({ path: `${agent.bin} plugin list`, kind: 'native', status: existing.items.some(item => item.issueCode === 'plugin_enumeration_failed') ? 'error' : 'read' })
        if (agentId === 'codex') existing.readSources.push(await source(join(root, 'skills/.system'), 'skill'))
        for (const item of existing.items) if (item.issueCode === 'unsafe_skill_root') {
          const path = item.scope === 'shared' ? join(options.home, '.agents/skills') : paths?.skills || join(root, 'skills')
          const state = existing.readSources.find(source => source.path === path)
          if (state) state.status = 'error'
        }
        for (const item of existing.items) if (item.kind === 'skill' && item.scope !== 'builtin') {
          if (agentId === 'codex' && item.status === 'shadowed') { item.status = 'available'; delete item.issueCode }
          if (item.entryPath && item.linked) item.removal = 'link'
          if (item.removal) item.manageable = helperAvailable()
        }
        existing.writable ||= existing.items.some(item => item.manageable)
        for (const plugin of existing.items.filter(item => item.kind === 'plugin')) {
          if (plugin.migratableTo) plugin.migratableTo = plugin.migratableTo.filter(id => options.agents.some(agent => agent.id === id))
          try { existing.items.push(...await pluginSkills(plugin, existing.readSources)) }
          catch { existing.readSources.push({ path: plugin.manifestPath || plugin.origin, kind: 'plugin', status: 'error' }) }
        }
        existing.revision = hash(JSON.stringify(existing.items))
        return existing
      }
      return await supplementary(agent, options)
    } catch (error) {
      return { agentId, agentName: agent.name, available: agent.installed !== false, writable: false, status: 'invalid' as const,
        issueCode: 'unsupported_provider_layout' as const, revision: hash('scan-failed'), items: [],
        message: error instanceof Error && error.message.startsWith(`${agent.name} 原生`) ? error.message : `${agent.name} 工具读取失败，请检查配置和运行状态后重新扫描。`,
        readSources: [{ path: `${agent.name} native inventory`, kind: 'native' as const, status: 'error' as const }] }
    }
  }))
  const allItems = inventories.flatMap(value => value.items)
  const locations = new Map<string, Promise<string>>()
  await Promise.all(allItems.filter(item => item.kind === 'skill' && item.location).map(async item => {
    let location = locations.get(item.location!)
    if (!location) { location = realpath(item.location!).catch(() => item.location!); locations.set(item.location!, location) }
    item.location = await location
    if (item.manifestPath) item.manifestPath = join(item.location, basename(item.manifestPath))
  }))
  for (const inventory of inventories) for (const item of inventory.items) if (item.scope === 'shared' && !item.linked && item.location) {
    item.dependentAgents = [...new Set(allItems.filter(other => other.kind === 'skill' && other.manifestPath === item.manifestPath).map(other => other.agentId))]
  }
  return { inventories, scannedAt: Date.now() }
}

async function currentItem(id: string, options: AgentToolInventoryOptions, allAgents = false): Promise<{ item: CapabilityInventoryItem; all: CapabilityInventoryItem[] }> {
  const selected = allAgents ? options : { ...options, agents: options.agents.filter(agent => agent.id === id.split(':')[0]) }
  const all = (await listAgentToolInventories(selected)).inventories.flatMap(inventory => inventory.items)
  const item = all.find(value => value.id === id)
  if (!item) throw new Error('invalid_selection')
  return { item, all }
}

export async function getAgentToolDetail(id: string, options: AgentToolInventoryOptions): Promise<CapabilityInventoryDetail> {
  const { item } = await currentItem(id, options)
  if (!item.manifestPath) {
    if (item.agentId === 'kimi' && item.kind === 'mcp') return (await getKimiInventoryDetail(id, { home: options.home, cwd: options.home, env: options.env }))
      || { id, name: item.name, kind: item.kind, openable: false }
    if (['codex', 'traex', 'claude'].includes(item.agentId)) return getCapabilityInventoryDetail(options.home, id, options.agents.map(agent => agent.id))
    return { id, name: item.name, kind: item.kind, openable: false, manifestFile: 'capability.json',
      manifestText: JSON.stringify({ name: item.name, origin: item.origin, version: item.version, enabled: item.enabled, components: item.components }, null, 2) }
  }
  const path = await realpath(item.manifestPath), folder = item.kind === 'plugin' && item.location ? await realpath(item.location) : dirname(path)
  const value = await secureManifest(path, dirname(path))
  const files = (await readdir(folder, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.')).slice(0, 200)
    .map(entry => ({ relativePath: entry.name, directory: entry.isDirectory() }))
  return { id, name: item.name, kind: item.kind, openable: true, folderPath: folder, manifestText: value.text, manifestFile: basename(path), files }
}

async function removeEntry(path: string, expectedLink: boolean, expected?: { dev: bigint; ino: bigint }): Promise<void> {
  const parentPath = dirname(path)
  const [parent, entry] = await Promise.all([lstat(parentPath, { bigint: true }), lstat(path, { bigint: true })])
  if (parent.isSymbolicLink() || !parent.isDirectory() || entry.isSymbolicLink() !== expectedLink) throw new Error('stale_selection')
  if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino)) throw new Error('stale_selection')
  const removed = `.uniagent-remove-${randomUUID()}`
  atomicRenameExclusiveSync(parentPath, basename(path), removed,
    { dev: parent.dev, ino: parent.ino, mode: Number(parent.mode & 0o777n) },
    { dev: entry.dev, ino: entry.ino, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' })
  // Recursive disk work stays in asynchronous I/O after the identity-checked rename.
  await rm(join(parentPath, removed), { recursive: entry.isDirectory(), force: false })
}

export async function removeAgentToolSkill(id: string, agentId: CapabilityAgentId, expectedFingerprint: string | undefined, options: AgentToolInventoryOptions): Promise<void> {
  const { item, all } = await currentItem(id, options, true)
  if (item.agentId !== agentId || item.kind !== 'skill' || !item.manageable || item.scope === 'builtin' || item.scope === 'plugin') throw new Error('invalid_selection')
  if (expectedFingerprint && item.fingerprint !== expectedFingerprint) throw new Error('stale_selection')
  if (!item.entryPath) throw new Error('invalid_selection')
  const expected = await lstat(item.entryPath, { bigint: true })
  if (!item.linked && item.manifestPath) {
    const manifest = await realpath(item.manifestPath)
    if ((await secureManifest(manifest, dirname(manifest))).fingerprint !== item.fingerprint) throw new Error('stale_selection')
  }
  if (!item.linked && item.scope === 'shared') {
    const links = new Set(all.filter(other => other.linked && other.manifestPath === item.manifestPath && other.entryPath).map(other => other.entryPath!))
    if (expected.isDirectory()) for (const link of (await skillLinkDependencies(options.home, options.agents.map(agent => agent.id))).get(item.location!) || []) links.add(link.linkPath)
    for (const path of links) {
      const linkIdentity = await lstat(path, { bigint: true })
      const target = await realpath(path)
      if (target !== item.location && target !== item.manifestPath) throw new Error('stale_selection')
      await removeEntry(path, true, linkIdentity)
    }
  }
  await removeEntry(item.entryPath, !!item.linked, expected)
}

export async function uninstallAgentToolPlugin(value: unknown, options: AgentToolInventoryOptions): Promise<void> {
  if (!record(value) || !['mcode', 'deepseek', 'kimi', 'zcode'].includes(value.agentId) || !['plugin-uninstall', 'plugin-remove'].includes(value.action)
    || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedFingerprint)
    || Object.keys(value).some(key => !['agentId', 'action', 'id', 'expectedFingerprint'].includes(key))) throw new Error('invalid_capability_inventory_manage_request')
  const { item } = await currentItem(value.id, options)
  if (item.agentId !== value.agentId || item.kind !== 'plugin' || !item.manageable || !item.pluginId) throw new Error('invalid_selection')
  if (item.fingerprint !== value.expectedFingerprint) throw new Error('stale_selection')
  const agent = options.agents.find(agent => agent.id === item.agentId)!
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, HOME: options.home }
  const args = item.agentId === 'mcode' ? ['plugin', 'remove', item.pluginId, '--json'] : ['plugin', 'remove', item.pluginId]
  if (item.agentId === 'deepseek') env.DSH_HOME = options.deepseekHome
  if (item.agentId === 'kimi') {
    if (!options.kimiPluginRemove) throw new Error('capability_inventory_action_unsupported')
    await options.kimiPluginRemove(item.pluginId)
  } else if (item.agentId === 'zcode') {
    if (!options.zcodePluginRemove) throw new Error('capability_inventory_action_unsupported')
    await options.zcodePluginRemove(item.pluginId)
  } else await (options.run || runNative)(agent.bin, args, env)
  const next = (await listAgentToolInventories({ ...options, agents: [agent] })).inventories[0]
  if (!next || next.status !== 'available' || next.items.some(other => other.id === item.id)) throw new Error('plugin_uninstall_failed')
}

export async function manageAgentToolInventory(value: unknown, options: AgentToolInventoryOptions): Promise<CapabilityAgentInventory> {
  if (!record(value) || !['mcode', 'deepseek', 'grok', 'kimi', 'zcode'].includes(value.agentId)) throw new Error('capability_inventory_action_unsupported')
  const agent = options.agents.find(agent => agent.id === value.agentId)
  if (!agent) throw new Error('capability_inventory_unavailable')
  if (value.agentId === 'grok' || value.agentId === 'kimi' && value.action !== 'plugin-uninstall') await manageBetaCapabilityInventory(value, { home: options.home, cwd: options.home,
    env: options.env, grokBin: agent.bin,
    grokRunner: options.run ? async (bin, args, context) => ({ stdout: await options.run!(bin, ['--no-auto-update', ...args], context.env || {}) }) : readonlyGrokInventoryRunner })
  else await uninstallAgentToolPlugin(value, options)
  const inventory = (await listAgentToolInventories({ ...options, agents: [agent] })).inventories[0]
  if (!inventory) throw new Error('capability_inventory_unavailable')
  return inventory
}
