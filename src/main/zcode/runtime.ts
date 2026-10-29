import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, lstat, access, readdir } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { ZCodeModelSelection, ZCodeRuntimeConfig, ZCodeRuntimeSnapshot } from '../../shared/zcode'
import { resolveUserDataHome } from '../userData'
import { isRecord, scrubZCodeDiagnostic } from './protocol'
import { sanitizeZCodeSelection, writeZCodeJson } from './store'
import { readZCodeConfiguredModels } from './catalog'
import type { ModelDef } from '../../shared/types'
import { findAgentExecutable } from '../agentSetupProcess'

const execFileAsync = promisify(execFile)
export interface ZCodeRuntime { config: ZCodeRuntimeConfig; fingerprint: string; version: string; nodeVersion: string; selection: ZCodeModelSelection; builtinProviderPath?: string; models: ModelDef[] }
export const zcodeRuntimeArgs = (config: ZCodeRuntimeConfig, args: string[]) => config.bundlePath ? [config.bundlePath, ...args] : args
export const zcodeRuntimeConfigPath = () => join(resolveUserDataHome(), 'zcode', 'runtime.json')

async function absoluteFile(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('ZCode requires an absolute file path')
  const resolved = await realpath(value)
  if (!(await stat(resolved)).isFile()) throw new Error('ZCode runtime path must point to a file')
  return resolved
}

export async function readZCodePersonalSelection(path: string): Promise<ZCodeModelSelection> {
  const file = await absoluteFile(path)
  const metadata = await stat(file)
  if (process.platform !== 'win32' && (metadata.mode & 0o077)) throw new Error('ZCode Provider 配置权限须为 0600')
  if (metadata.size > 2 * 1024 * 1024) throw new Error('ZCode Provider 配置过大')
  let parsed: any
  try { parsed = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('ZCode Provider 配置不是有效 JSON') }
  const selection = sanitizeZCodeSelection(parsed?.config?.defaultModelSelection)
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !selection || !selection.providerId.startsWith('personal:')) throw new Error('ZCode Provider 配置缺少有效的 Personal 模型选择')
  return selection
}

export async function validateZCodeRuntimeConfig(value: unknown): Promise<ZCodeRuntimeConfig> {
  if (!isRecord(value) || value.schemaVersion !== 1 || !['cli', 'official-app', 'source-build'].includes(value.source)
    || typeof value.dataRootId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.dataRootId)) throw new Error('ZCode runtime configuration is invalid')
  const executable = await absoluteFile(value.executable)
  const bundlePath = value.bundlePath === undefined ? undefined : await absoluteFile(value.bundlePath)
  if (bundlePath && !value.resourceRoot) throw new Error('ZCode bundle 需要完整资源目录')
  if (value.resourceRoot !== undefined && (typeof value.resourceRoot !== 'string' || !isAbsolute(value.resourceRoot))) throw new Error('ZCode resourceRoot must be an absolute path')
  const resourceRoot = value.resourceRoot ? await realpath(value.resourceRoot) : undefined
  if (resourceRoot && !(await stat(resourceRoot)).isDirectory()) throw new Error('ZCode resourceRoot must be a directory')
  const personalProviderConfigPath = value.personalProviderConfigPath === undefined ? undefined : await absoluteFile(value.personalProviderConfigPath)
  // Persist resolved paths, so a chosen symlink cannot later redirect this config.
  return { schemaVersion: 1, source: value.source, executable, bundlePath, resourceRoot, personalProviderConfigPath,
    dataRootId: value.dataRootId, ...(value.sourceAppPath ? { sourceAppPath: await realpath(value.sourceAppPath) } : {}) }
}

export async function detectZCodeEngine(config: ZCodeRuntimeConfig) {
  const checked = { ...await validateZCodeRuntimeConfig({ ...config, personalProviderConfigPath: undefined }),
    ...(config.personalProviderConfigPath !== undefined ? { personalProviderConfigPath: config.personalProviderConfigPath } : {}) }
  const hash = createHash('sha256').update(await readFile(checked.bundlePath ?? checked.executable)).digest('hex')
  const builtinProviderPath = checked.resourceRoot ? await absoluteFile(join(checked.resourceRoot, 'provider', 'zcode-builtin.json')) : undefined
  const metadata = await lstat(checked.executable)
  if (process.platform !== 'win32' && !(metadata.mode & 0o111)) throw new Error('ZCode Node 路径不可执行')
  const env = { PATH: process.env.PATH, NODE_ENV: 'production' }
  const nodeVersion = checked.bundlePath ? (await execFileAsync(checked.executable, ['--version'], { env, timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim() : ''
  const version = (await execFileAsync(checked.executable, zcodeRuntimeArgs(checked, ['--version']), { env, timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim()
  if (!version || version.length > 256) throw new Error('ZCode CLI 未返回有效版本信息')
  const help = (await execFileAsync(checked.executable, zcodeRuntimeArgs(checked, ['--help']), { env, timeout: 10_000, maxBuffer: 256 * 1024 })).stdout
  if (!/\bapp-server\b/.test(help)) throw new Error('ZCode CLI 缺少 app-server 接口')
  const fingerprint = createHash('sha256').update(JSON.stringify([checked.source, checked.executable, checked.bundlePath, checked.resourceRoot, checked.personalProviderConfigPath, hash, nodeVersion])).digest('hex')
  return { config: checked, fingerprint, version, nodeVersion, builtinProviderPath }
}

export async function detectZCodeRuntime(config: ZCodeRuntimeConfig): Promise<ZCodeRuntime> {
  const engine = await detectZCodeEngine(await validateZCodeRuntimeConfig(config))
  const { config: checked, builtinProviderPath } = engine
  if (!checked.personalProviderConfigPath) throw new Error('ZCode 已安装，请先配置模型服务与 API Key')
  const selection = await readZCodePersonalSelection(checked.personalProviderConfigPath)
  const models = await readZCodeConfiguredModels(checked.personalProviderConfigPath!, builtinProviderPath, selection)
  return { ...engine, selection, models }
}

export async function loadZCodeRuntimeConfig(): Promise<ZCodeRuntimeConfig | undefined> {
  try { return await validateZCodeRuntimeConfig(JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8'))) } catch { return undefined }
}

/** Resolve an installed/prepared engine using a candidate Provider file, without saving it. */
export async function resolveZCodeConfigurationRuntime(personalProviderConfigPath: string): Promise<ZCodeRuntime> {
  let stored: unknown
  try { stored = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8')) }
  catch (error: any) { if (error.code !== 'ENOENT') throw new Error('ZCode 运行时配置无法读取，请重新配置运行时') }
  if (stored !== undefined) {
    if (!isRecord(stored)) throw new Error('ZCode 运行时配置无效')
    return detectZCodeRuntime({ ...stored, personalProviderConfigPath } as ZCodeRuntimeConfig)
  }
  const root = join(homedir(), 'Library', 'Application Support', 'UniAgentZCode', 'runtime')
  let candidates: { path: string; modified: number }[]
  try {
    candidates = await Promise.all((await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(async entry => ({ path: join(root, entry.name, 'runtime-config.json'), modified: (await stat(join(root, entry.name))).mtimeMs })))
  } catch { throw new Error('ZCode 运行时尚未安装，请先准备官方运行时') }
  for (const candidate of candidates.sort((a, b) => b.modified - a.modified)) {
    try {
      const value = JSON.parse(await readFile(candidate.path, 'utf8'))
      return await detectZCodeRuntime({ ...value, schemaVersion: 1, personalProviderConfigPath, dataRootId: randomUUID() })
    } catch { /* Try the next prepared engine without changing the active configuration. */ }
  }
  throw new Error('ZCode 运行时不可用，请先准备兼容的官方运行时')
}

let preparedFlight: Promise<ZCodeRuntimeConfig | undefined> | undefined
export function importPreparedZCodeRuntime(): Promise<ZCodeRuntimeConfig | undefined> {
  return preparedFlight ??= importPreparedRuntime().finally(() => { preparedFlight = undefined })
}
async function importPreparedRuntime(): Promise<ZCodeRuntimeConfig | undefined> {
  const existing = await loadZCodeRuntimeConfig()
  if (existing) return existing
  try { await access(zcodeRuntimeConfigPath()); return undefined } catch (error: any) { if (error.code !== 'ENOENT') return undefined }
  const external = await discoverExternalZCodeRuntime()
  if (external) {
    try { await access(zcodeRuntimeConfigPath()); return loadZCodeRuntimeConfig() } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    writeZCodeJson(zcodeRuntimeConfigPath(), external)
    return external
  }
  const prepared = join(homedir(), 'Library', 'Application Support', 'UniAgentZCode')
  try {
    const root = join(prepared, 'runtime')
    const candidates = await Promise.all((await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(async entry => ({ path: join(root, entry.name, 'runtime-config.json'), modified: (await stat(join(root, entry.name))).mtimeMs })))
    for (const candidate of candidates.sort((a, b) => b.modified - a.modified)) {
      try {
        const value = JSON.parse(await readFile(candidate.path, 'utf8'))
        const runtime = await detectZCodeRuntime({ ...value, schemaVersion: 1, personalProviderConfigPath: join(prepared, 'provider_config.json'), dataRootId: randomUUID() })
        writeZCodeJson(zcodeRuntimeConfigPath(), runtime.config)
        return runtime.config
      } catch { /* Try the next prepared runtime without changing existing configuration. */ }
    }
    return undefined
  } catch { return undefined }
}

/** Validate complete external resources and isolated RPC before registering them. */
export async function discoverExternalZCodeRuntime(env: NodeJS.ProcessEnv = process.env,
  apps = ['/Applications/ZCode.app', join(env.HOME || homedir(), 'Applications/ZCode.app')], selectedFile?: string): Promise<ZCodeRuntimeConfig | undefined> {
  const candidates: ZCodeRuntimeConfig[] = []
  if (selectedFile && !isAbsolute(selectedFile)) throw new Error('请选择 ZCode 程序的绝对路径')
  const cli = await findAgentExecutable(selectedFile || 'zcode', env)
  if (selectedFile && !cli) throw new Error('选择的 ZCode 程序不存在或不可执行')
  const node = await findAgentExecutable('node', env)
  const personal = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(env.ZCODE_DATA_BASE_DIR || join(env.HOME || homedir(), '.zcode'), 'v2/provider_config.json')
  let personalProviderConfigPath: string | undefined
  try { await access(personal); personalProviderConfigPath = personal } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('ZCode Provider 路径无法访问，请检查权限') }
  if (cli) {
    const path = await realpath(cli)
    const bundled = /\.(cjs|mjs|js)$/.test(path)
    if (bundled && !node) throw new Error('已找到 ZCode CLI，但缺少可用 Node，请使用提示词排查')
    candidates.push({ schemaVersion: 1, source: 'cli', executable: bundled ? node! : path,
      ...(bundled ? { bundlePath: path, resourceRoot: dirname(path) } : {}), personalProviderConfigPath, dataRootId: randomUUID() })
  }
  let foundApp = false
  for (const sourceAppPath of apps) {
    const resources = join(sourceAppPath, 'Contents/Resources')
    try { await access(resources); foundApp = true } catch { continue }
    if (!node) continue
    for (const relative of ['glm/zcode.cjs', 'app.asar.unpacked/glm/zcode.cjs']) {
      const bundlePath = join(resources, relative)
      try { await access(bundlePath) } catch { continue }
      candidates.push({ schemaVersion: 1, source: 'official-app', executable: node, bundlePath,
        resourceRoot: join(resources, 'config'), sourceAppPath, personalProviderConfigPath, dataRootId: randomUUID() })
    }
  }
  for (const config of candidates) {
    try {
      const engine = await detectZCodeEngine(config)
      const { verifyZCodeEngine } = await import('./build')
      const directory = join(resolveUserDataHome(), 'zcode')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await verifyZCodeEngine(engine.config, directory, new AbortController().signal)
      return engine.config
    } catch { /* Other complete official sources can still be compatible. */ }
  }
  if (cli || foundApp) throw new Error('已找到本机 ZCode，但完整资源或 app-server 协议未通过校验；请检查原程序，暂不重复安装')
}

export async function getZCodeRuntimeSnapshot(): Promise<ZCodeRuntimeSnapshot> {
  const config = await loadZCodeRuntimeConfig()
  if (!config) {
    try { await access(zcodeRuntimeConfigPath()); return { phase: 'failed', message: 'ZCode 运行时配置无法读取或路径无效，请重新选择' } }
    catch { return { phase: 'unconfigured', message: '请选择已验证的 ZCode 运行时和本机 Provider 配置' } }
  }
  try {
    if (!config.personalProviderConfigPath) {
      const engine = await detectZCodeEngine(config)
      return { phase: 'needs-auth', config: engine.config, version: engine.version, nodeVersion: engine.nodeVersion,
        message: 'ZCode 已安装，请配置模型服务与 API Key' }
    }
    const runtime = await detectZCodeRuntime(config)
    return { phase: 'ready', config: runtime.config, version: runtime.version, nodeVersion: runtime.nodeVersion,
      fingerprint: runtime.fingerprint, currentModel: runtime.selection, models: runtime.models, message: '运行时已校验；协议和模型服务可用性在实际会话中确认' }
  } catch (error) { return { phase: 'failed', config, message: scrubZCodeDiagnostic(error instanceof Error ? error.message : 'ZCode 检测失败') } }
}

export async function saveZCodeRuntimeConfig(value: unknown): Promise<ZCodeRuntimeSnapshot> {
  const runtime = await detectZCodeRuntime(await validateZCodeRuntimeConfig(value))
  writeZCodeJson(zcodeRuntimeConfigPath(), runtime.config)
  return getZCodeRuntimeSnapshot()
}
