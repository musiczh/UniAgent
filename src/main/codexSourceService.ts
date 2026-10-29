import { EventEmitter } from 'node:events'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { atomicWrite } from './projectStore'
import { resolveUserDataHome } from './userData'
import { decryptLocalSecret, encryptLocalSecret, isLocalSecret } from './localSecretStore'
import { migrateLegacySecrets } from './legacySecretMigration'
import { parseCodexConfig, validateSourceInput, validateSourceModelQuery, type ConfigField } from './codexSourceConfig'
import { fetchSourceModels } from './codexSourceModels'
import { fetchSourceQuota, quotaUnavailableReason } from './codexSourceQuota'
import { codexSourceRuntimeDiagnostic, diagnostics } from './diagnostics'
import { CODEX_SOURCE_PRESETS, CODEX_SOURCE_PRESET_ORDER, codexSourceChatModels, codexSourceModelImageInput, codexSourceModelIssues, updateCodexSourceRuntimeIssues, type CodexSource, type CodexSourceId, type CodexSourceInput, type CodexSourceModelQueryInput, type CodexSourcePreset, type CodexSourceQuota, type CodexSourceRuntimeEvent, type CodexSourceRuntimeIssue, type CodexSourcesSnapshot } from '../shared/codexSources'
import type { CodexModelSourceRef, ModelDef, ReasoningEffort } from '../shared/types'
import type { RouterConfig } from './codexSourceRouter'
import { codexModelKey } from '../shared/codexModelIdentity'

const execFileP = promisify(execFile)
const PORT = 11436
const ENDPOINT = `http://127.0.0.1:${PORT}/api/codex/v1`
const LEGACY_LABEL = 'com.bytedance.codex-kimi-router'
type CatalogModel = Record<string, unknown> & { slug: string }
type StoredSource = Omit<CodexSource, 'hasKey' | 'quota' | 'issues'> & { encryptedKey: string }
interface CachedQuota { signature: string; expiresAt: number; quota: CodexSourceQuota }
interface Takeover {
  fields: ConfigField[]
  originalBaseUrl: string
  originalModels: CatalogModel[]
}
interface Store {
  version: 1
  enabled: boolean
  sources: StoredSource[]
  takeover?: Takeover
  migrated?: boolean
}

function readText(file: string, fallback?: string): string {
  try {
    if (statSync(file).size > 16 * 1024 * 1024) throw new Error('配置文件过大')
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
}
function catalogModels(file: string): CatalogModel[] {
  let value: any
  try { value = JSON.parse(readText(file)) } catch { throw new Error('无法读取原 Codex 模型目录，请先启动一次 Codex 并检查模型配置') }
  if (!Array.isArray(value.models) || !value.models.length || value.models.some((m: any) => !m || typeof m.slug !== 'string')) {
    throw new Error('原 Codex 模型目录无效，未修改配置')
  }
  return value.models
}
/** Codex 模型目录条目；MiMo 已知模型使用 1M 上下文与固定思考档，未知模型保持保守能力。 */
export function codexSourceCatalogModel(model: string, preset: CodexSourcePreset): CatalogModel {
  const known = CODEX_SOURCE_PRESETS[preset].models.includes(model)
  const small = ['kimi-for-coding-highspeed', 'kimi-k2.7-code', 'k3-256k'].includes(model)
  const mimo = preset.startsWith('mimo') && known
  // ponytail: unknown IDs use conservative text/128K capabilities; expose per-model metadata if needed.
  const context = !known ? 131072 : mimo ? 1048576 : model === 'glm-5-turbo' ? 204800 : small ? 262144 : 1048576
  // MiMo 仅区分是否开启思考，非 none 档位行为一致，因此只暴露一个档位，避免给出虚假的强度选择。
  const levels = !known || mimo ? ['high'] : model === 'glm-5-turbo' ? ['max'] : ['kimi-for-coding-highspeed', 'kimi-k2.7-code'].includes(model) ? ['high'] : ['low', 'high', 'max']
  return {
    slug: model, display_name: model, description: `${CODEX_SOURCE_PRESETS[preset].label} · ${model}`,
    default_reasoning_level: known && preset === 'glm' ? 'max' : levels.includes('high') ? 'high' : levels[0],
    supported_reasoning_levels: levels.map(effort => ({ effort, description: effort })),
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 0,
    base_instructions: '', supports_reasoning_summaries: true, default_reasoning_summary: 'none', support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 }, context_window: context, max_context_window: context,
    effective_context_window_percent: 95, supports_parallel_tool_calls: known, experimental_supported_tools: [],
    ...(known && preset === 'glm' ? { apply_patch_tool_type: 'freeform' } : {}),
    input_modalities: codexSourceModelImageInput(preset, model) ? ['text', 'image'] : ['text'],
    supports_image_detail_original: known && model === 'deepseek-flash'
  }
}

function sourceModelDef(model: string, preset: StoredSource['preset'], sourceId: CodexSourceId): ModelDef {
  const catalog = codexSourceCatalogModel(model, preset)
  const efforts = (catalog.supported_reasoning_levels as Array<{ effort: ReasoningEffort }>).map(({ effort }) => effort)
  return {
    id: codexModelKey(model, { kind: 'third-party', sourceId }),
    label: String(catalog.display_name),
    efforts,
    defaultEffort: catalog.default_reasoning_level as ReasoningEffort,
    contextWindow: catalog.context_window as number,
    supportsMax: false,
    supportsFast: false,
    imageInput: (catalog.input_modalities as string[]).includes('image'),
    modelSource: { kind: 'third-party', sourceId }
  }
}

export function mergeCodexCatalogModels(providerModels: CatalogModel[]): CatalogModel[] {
  const models = [...providerModels]
  if (new Set(models.map(model => model.slug)).size !== models.length) {
    throw new Error('同一第三方来源的模型 ID 不能重复')
  }
  return models
}

export function mergeCodexSourceModels(nativeModels: ModelDef[], supplementalModels: ModelDef[]): ModelDef[] {
  return [...nativeModels, ...supplementalModels]
}

export function codexSourceRuntimeArgs(endpoint: string, catalogFile: string, sourceId: CodexSourceId, model: string): string[] {
  const provider = `uniagent-${sourceId}`
  return [
    '-c', `model=${JSON.stringify(model)}`,
    '-c', `review_model=${JSON.stringify(model)}`,
    '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}.name=${JSON.stringify('UniAgent 第三方 LLM')}`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(endpoint)}`,
    '-c', `model_providers.${provider}.wire_api=${JSON.stringify('responses')}`,
    '-c', `model_providers.${provider}.requires_openai_auth=false`,
    '-c', `model_providers.${provider}.supports_websockets=false`,
    '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`,
    '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false',
    '-c', 'features.enable_request_compression=false',
    // MiMo 的 Responses 网关拒绝 OpenAI 托管的 web_search 工具；官方 Codex 配置同样要求关闭。
    ...(sourceId === 'mimo' ? ['-c', 'web_search="disabled"', '-c', 'features.standalone_web_search=false'] : [])
  ]
}

export class CodexSourceService extends EventEmitter {
  private readonly directory = join(resolveUserDataHome(), 'codex-sources')
  private readonly file = join(this.directory, 'settings.json')
  private readonly codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  private readonly configFile = join(this.codexHome, 'config.toml')
  private readonly legacyPlist = join(homedir(), 'Library/LaunchAgents', LEGACY_LABEL + '.plist')
  private state: Store = { version: 1, enabled: false, sources: [] }
  private phase: CodexSourcesSnapshot['phase'] = 'stopped'
  private message?: string
  private loadError?: string
  private persisted = ''
  private child?: ChildProcess
  private closing = false
  private retries = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private flight: Promise<unknown> = Promise.resolve()
  private quotaFlight?: Promise<CodexSourcesSnapshot>
  private quotaRefreshing = false
  private readonly quotas = new Map<CodexSourceId, CachedQuota>()
  private runtimeIssues: CodexSourceRuntimeIssue[] = []
  private activeRouterConfig?: RouterConfig

  constructor() {
    super()
    try {
      const raw = readText(this.file, '')
      this.persisted = raw
      if (!raw) return
      const state = JSON.parse(raw) as Store
      if (state.version !== 1 || typeof state.enabled !== 'boolean' || !Array.isArray(state.sources)) throw new Error()
      state.sources = state.sources.map(source => {
        const clean = validateSourceInput(source)
        if (typeof source.encryptedKey !== 'string') throw new Error()
        return { ...clean, encryptedKey: source.encryptedKey }
      })
      if (new Set(state.sources.map(s => s.id)).size !== state.sources.length) throw new Error()
      if (state.takeover && (!Array.isArray(state.takeover.fields) || !Array.isArray(state.takeover.originalModels) || typeof state.takeover.originalBaseUrl !== 'string')) throw new Error()
      this.state = state
    } catch { this.loadError = '来源配置文件无法读取，请恢复备份后重试'; this.phase = 'error'; this.message = this.loadError }
  }

  snapshot(): CodexSourcesSnapshot {
    return {
      enabled: this.state.enabled, phase: this.phase, message: this.message,
      endpoint: this.phase === 'running' ? ENDPOINT : undefined,
      legacyAvailable: !this.state.migrated && this.isLegacy(),
      quotaRefreshing: this.quotaRefreshing,
      sources: CODEX_SOURCE_PRESET_ORDER.map(preset => {
        const defaults = CODEX_SOURCE_PRESETS[preset]
        const source = this.state.sources.find(s => s.id === defaults.id)
        const cached = source && this.quotas.get(source.id)
        const quota = source?.enabled && cached?.signature === this.quotaSignature(source) ? cached.quota : undefined
        const issues = codexSourceModelIssues(this.runtimeIssues, defaults.id)
        return source ? { id: source.id, preset: source.preset, enabled: source.enabled, baseUrl: source.baseUrl, models: [...source.models], hasKey: !!source.encryptedKey, quota, ...(issues.length ? { issues } : {}) }
          : { id: defaults.id, preset, enabled: false, baseUrl: defaults.baseUrl, models: [...defaults.models], hasKey: false }
      })
    }
  }

  supplementalModels(): ModelDef[] {
    return this.state.enabled && this.phase === 'running'
      ? this.state.sources
          .filter(source => source.enabled)
          .flatMap(source => source.models.map(model => sourceModelDef(model, source.preset, source.id)))
      : []
  }

  sourceRefsFor(model: string): CodexModelSourceRef[] {
    return this.state.sources.filter(item => item.models.includes(model)).map(source => ({ kind: 'third-party', sourceId: source.id }))
  }

  runtimeArgs(model?: string, sourceRef?: CodexModelSourceRef): string[] {
    if (!model || sourceRef?.kind !== 'third-party') return []
    this.assertModelReady(model, sourceRef)
    const source = this.state.sources.find(item => item.id === sourceRef.sourceId && item.enabled && item.models.includes(model))
    return codexSourceRuntimeArgs(`${ENDPOINT}/${source!.id}`, this.sourceCatalogFile(source!.id), source!.id, model)
  }

  assertModelReady(model?: string, sourceRef?: CodexModelSourceRef): void {
    if (!model || sourceRef?.kind !== 'third-party') return
    const source = this.state.sources.find(s => s.id === sourceRef.sourceId && s.models.includes(model))
    if (!source || !this.state.enabled || !source.enabled || this.phase !== 'running') {
      throw new Error('模型来源未运行，请在设置 → Codex 来源配置中启用或重启服务')
    }
  }

  start(): Promise<CodexSourcesSnapshot> {
    return this.run(async () => {
      if (this.state.takeover) throw new Error('发现旧全局接管记录，请先预览并确认迁移；启动不会自动修改 Codex 配置')
      if (this.state.enabled) await this.apply(this.state)
      else await this.migrateKeys()
    })
  }
  save(input: CodexSourceInput): Promise<CodexSourcesSnapshot> {
    return this.run(async () => {
      const value = validateSourceInput(input)
      const previous = this.state.sources.find(s => s.id === value.id)
      const { apiKey, ...fields } = value
      if (!apiKey && (!previous?.encryptedKey || previous.preset !== value.preset || previous.baseUrl !== value.baseUrl)) {
        throw new Error('首次配置、切换接入方式或地址时，请填写对应的 API Key')
      }
      let encryptedKey = previous?.encryptedKey || ''
      if (apiKey) {
        encryptedKey = encryptLocalSecret(apiKey)
      }
      const source = { ...fields, encryptedKey }
      const next = { ...this.state, enabled: true, sources: [...this.state.sources.filter(s => s.id !== value.id), source] }
      await this.apply(next)
    })
  }
  async queryModels(input: CodexSourceModelQueryInput): Promise<string[]> {
    const value = validateSourceModelQuery(input)
    if (!value.apiKey) await this.migrateKeys()
    const previous = this.state.sources.find(source => source.id === value.id)
    let apiKey = value.apiKey
    if (!apiKey) {
      if (!previous?.encryptedKey || previous.preset !== value.preset || previous.baseUrl !== value.baseUrl) {
        throw new Error('请先填写当前接入方式和地址对应的 API Key')
      }
      try { apiKey = decryptLocalSecret(previous.encryptedKey) }
      catch { throw new Error('无法读取已保存的 API Key，请重新填写') }
    }
    return codexSourceChatModels(value.preset, await fetchSourceModels(value.baseUrl, apiKey))
  }
  async reusableSources(): Promise<CodexSourceInput[]> {
    await this.migrateKeys()
    return this.state.sources.map(({ encryptedKey, ...source }) => ({ ...source, apiKey: decryptLocalSecret(encryptedKey) }))
  }
  setEnabled(enabled: boolean): Promise<CodexSourcesSnapshot> {
    return this.run(async () => {
      if (typeof enabled !== 'boolean') throw new Error('无效的启用状态')
      if (enabled) await this.apply({ ...this.state, enabled: true })
      else {
        this.state = { ...this.state, enabled: false }
        this.persist()
        await this.stopChild()
        this.phase = 'stopped'
        this.activeRouterConfig = undefined
      }
    })
  }
  restart(): Promise<CodexSourcesSnapshot> {
    return this.run(async () => {
      if (!this.state.enabled) throw new Error('请先配置并启用来源')
      await this.apply(this.state)
    })
  }
  migrate(): Promise<CodexSourcesSnapshot> {
    return this.run(async () => {
      if (this.state.enabled || !this.isLegacy()) throw new Error('未发现可导入的旧 Kimi 服务，或服务已由 UniAgent 管理')
      let key = process.env.KIMI_API_KEY?.trim()
      if (!key) {
        try {
          const result = await execFileP('/usr/bin/security', ['find-generic-password', '-s', 'codex-kimi-router', '-a', userInfo().username, '-w'], { timeout: 120_000 })
          key = result.stdout.trim()
        } catch { throw new Error('旧 Kimi 密钥导入未完成，请允许钥匙串访问后重试；原配置已保留') }
      }
      const config = parseCodexConfig(readText(this.configFile))
      const models = catalogModels(this.resolvePath(config.model_catalog_json)).filter(m => CODEX_SOURCE_PRESETS['kimi-code'].models.includes(m.slug)).map(m => m.slug)
      const input = validateSourceInput({ id: 'kimi', preset: 'kimi-code', enabled: true, baseUrl: CODEX_SOURCE_PRESETS['kimi-code'].baseUrl, models, apiKey: key })
      const { apiKey, ...source } = input
      const next: Store = { ...this.state, enabled: true, migrated: true, sources: [...this.state.sources.filter(s => s.id !== 'kimi'), { ...source, encryptedKey: encryptLocalSecret(apiKey!) }] }
      // Import the supplemental connection only; global cleanup needs a separate preview.
      await this.apply(next)
    })
  }

  refreshQuotas(force = false): Promise<CodexSourcesSnapshot> {
    if (this.state.sources.some(source => source.encryptedKey && !isLocalSecret(source.encryptedKey))) {
      return this.migrateKeys().then(() => this.refreshQuotas(force))
    }
    if (this.quotaFlight) return this.quotaFlight
    const now = Date.now()
    const sources = this.state.sources.filter(source => source.enabled)
    const pending = sources.filter(source => {
      const cached = this.quotas.get(source.id)
      return force || !cached || cached.signature !== this.quotaSignature(source) || cached.expiresAt <= now
    })
    if (!pending.length) return Promise.resolve(this.snapshot())
    this.quotaRefreshing = true
    this.emitStatus()
    const job = Promise.all(pending.map(async source => {
      const signature = this.quotaSignature(source)
      const reason = quotaUnavailableReason(source.preset, source.baseUrl)
      if (reason) {
        this.quotas.set(source.id, { signature, expiresAt: Number.POSITIVE_INFINITY, quota: { status: 'unsupported', message: reason } })
        return
      }
      try {
        const apiKey = decryptLocalSecret(source.encryptedKey)
        const quota = await fetchSourceQuota(source.preset, source.baseUrl, apiKey)
        this.quotas.set(source.id, { signature, expiresAt: Date.now() + 5 * 60_000, quota })
      } catch (error) {
        const previous = this.quotas.get(source.id)
        const message = error instanceof Error && ['密钥无额度查询权限', '额度查询过于频繁'].includes(error.message)
          ? error.message : '额度查询失败'
        const quota = previous?.signature === signature && previous.quota.kind
          ? { ...previous.quota, status: 'error' as const, stale: true, message }
          : { status: 'error' as const, message }
        this.quotas.set(source.id, { signature, expiresAt: Date.now() + 60_000, quota })
      }
    })).finally(() => {
      this.quotaRefreshing = false
      this.quotaFlight = undefined
      this.emitStatus()
    }).then(() => this.snapshot())
    this.quotaFlight = job
    return job
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    await Promise.allSettled([this.flight, this.quotaFlight])
    await this.stopChild()
    this.activeRouterConfig = undefined
  }

  private run(work: () => Promise<void>): Promise<CodexSourcesSnapshot> {
    const job = this.flight.then(async () => {
      if (this.closing) throw new Error('应用正在退出')
      if (this.loadError) throw new Error(this.loadError)
      this.message = undefined
      this.retries = 0
      try { await work(); this.emitStatus(); return this.snapshot() }
      catch (error) {
        this.phase = this.child ? 'running' : 'error'
        this.message = error instanceof Error ? error.message : '来源配置操作失败'
        this.emitStatus()
        throw new Error(this.message)
      }
    })
    this.flight = job.catch(() => {})
    return job
  }
  private persist(): void {
    if (readText(this.file, '') !== this.persisted) throw new Error('来源配置被其他程序修改，请重新打开 UniAgent 后重试')
    const text = JSON.stringify(this.state, null, 2)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    chmodSync(this.directory, 0o700)
    atomicWrite(this.file, text)
    this.persisted = text
  }
  private async migrateStore(state: Store): Promise<Store> {
    const keys = state.sources.map(source => source.encryptedKey)
    const migrated = await migrateLegacySecrets(keys)
    if (keys.every((key, index) => key === migrated[index])) return state
    return { ...state, sources: state.sources.map((source, index) => ({ ...source, encryptedKey: migrated[index] })) }
  }
  private async migrateKeys(): Promise<void> {
    const previous = this.state
    const migrated = await this.migrateStore(previous)
    if (migrated === previous) return
    if (this.state !== previous) return this.migrateKeys()
    this.state = migrated
    try { this.persist() }
    catch (error) { this.state = previous; throw error }
  }
  private emitStatus(): void { this.emit('changed', this.snapshot()) }
  private quotaSignature(source: StoredSource): string { return `${source.preset}\0${source.baseUrl}\0${source.encryptedKey}` }
  private resolvePath(path: unknown): string {
    if (typeof path !== 'string' || !path) return join(this.codexHome, 'models_cache.json')
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : join(this.codexHome, path)
  }
  private isLegacy(): boolean {
    if (process.platform !== 'darwin') return false
    try {
      const config = parseCodexConfig(readText(this.configFile, ''))
      return config.openai_base_url === 'http://127.0.0.1:11435/api/codex/v1' &&
        this.hasLegacyDefinition() &&
        existsSync(join(this.codexHome, 'config.toml.bak.before-kimi-router'))
    } catch { return false }
  }
  private hasLegacyDefinition(): boolean {
    const plist = readText(this.legacyPlist, '')
    return plist.includes(`<string>${LEGACY_LABEL}</string>`) && plist.includes(`<string>${join(this.codexHome, 'kimi-router.py')}</string>`)
  }

  private routerConfig(state: Store): RouterConfig {
    const sources = state.sources.filter(s => s.enabled).map(source => {
      const models = [...source.models]
      let apiKey: string
      try { apiKey = decryptLocalSecret(source.encryptedKey) }
      catch { throw new Error('无法解密来源密钥，请在设置中重新填写') }
      return { id: source.id, baseUrl: source.baseUrl, models, apiKey }
    })
    if (!sources.length) throw new Error('请至少启用一个已配置来源；暂停所有来源请关闭接入服务')
    return { port: PORT, sources }
  }
  private sourceCatalogFile(sourceId: CodexSourceId): string {
    return join(this.directory, `models-${sourceId}.json`)
  }

  private async apply(proposed: Store): Promise<void> {
    if (this.state.takeover) throw new Error('旧全局接管记录需要单独确认迁移，未修改 Codex 配置')
    const previous = this.state
    const previousRouterConfig = this.activeRouterConfig
    const next = await this.migrateStore({ ...proposed, enabled: true })
    const config = this.routerConfig(next)
    const catalogs = next.sources.filter(source => source.enabled).map(source => ({
      file: this.sourceCatalogFile(source.id),
      before: readText(this.sourceCatalogFile(source.id), ''),
      after: JSON.stringify({ models: mergeCodexCatalogModels(source.models.map(model => codexSourceCatalogModel(model, source.preset))) })
    }))
    this.phase = 'starting'
    this.emitStatus()
    await this.stopChild()
    try {
      for (const catalog of catalogs) atomicWrite(catalog.file, catalog.after)
      await this.spawnChild(config)
      this.state = next
      this.persist()
      this.activeRouterConfig = config
      this.phase = 'running'
    } catch (error) {
      await this.stopChild()
      this.state = previous
      this.activeRouterConfig = previousRouterConfig
      for (const catalog of catalogs) {
        if (readText(catalog.file, '') === catalog.after) atomicWrite(catalog.file, catalog.before)
      }
      if (previous.enabled && previousRouterConfig) {
        try { await this.spawnChild(previousRouterConfig) }
        catch { this.activeRouterConfig = undefined }
      }
      throw error
    }
  }

  private async spawnChild(config: RouterConfig): Promise<void> {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'codexSourceRouter.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UNIAGENT_CODEX_ROUTER: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    this.child = child
    this.runtimeIssues = []
    child.on('error', () => { /* startup promise or exit handles recovery */ })
    child.on('message', (value: any) => {
      if (this.child === child && value?.type === 'runtime' && value.event) this.handleRuntimeEvent(value.event as CodexSourceRuntimeEvent)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('接入服务启动超时')), 8000)
      const exited = (): void => finish(new Error('接入服务启动失败'))
      const failed = (): void => finish(new Error('接入服务启动失败'))
      const message = (value: any): void => {
        if (value?.type === 'ready') finish()
        else if (value?.type === 'failed') finish(new Error(value.message === '接入端口被占用，请关闭其他接入服务后重试' ? value.message : '接入服务启动失败'))
      }
      const finish = (error?: Error): void => {
        clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed)
        error ? reject(error) : resolve()
      }
      child.on('message', message); child.once('exit', exited); child.once('error', failed)
      child.send(config, error => { if (error) finish(new Error('无法初始化接入服务')) })
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      if (this.closing || !this.state.enabled) return
      this.phase = 'error'
      this.message = '接入服务已退出，正在重试'
      this.emitStatus()
      if (++this.retries > 3) { this.message = '接入服务反复退出，请点击重启服务'; this.emitStatus(); return }
      this.retryTimer = setTimeout(() => {
        this.flight = this.flight.then(async () => {
          if (this.closing || !this.state.enabled || this.child) return
          try {
            if (!this.activeRouterConfig) throw new Error('接入服务配置不可用')
            await this.spawnChild(this.activeRouterConfig)
            this.phase = 'running'
            this.message = undefined
          }
          catch { await this.stopChild(); this.phase = 'error'; this.message = '自动重启失败，请点击重启服务' }
          this.emitStatus()
        }).catch(() => {})
      }, 1000 * this.retries)
    })
  }
  private handleRuntimeEvent(event: CodexSourceRuntimeEvent): void {
    if (event.type === 'service-issue') {
      this.message = event.issue.message.slice(0, 200)
      diagnostics.record(codexSourceRuntimeDiagnostic(event.issue))
      this.emitStatus()
      return
    }
    const next = updateCodexSourceRuntimeIssues(this.runtimeIssues, event)
    if (event.type === 'issue') diagnostics.record(codexSourceRuntimeDiagnostic(event.issue))
    if (next === this.runtimeIssues) return
    this.runtimeIssues = next
    this.emitStatus()
  }
  private async stopChild(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const child = this.child
    this.child = undefined
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL') }, 1500)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill('SIGTERM')
    })
  }
}
