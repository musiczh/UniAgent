import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserDataHome } from './userData'
import { decryptLocalSecretAsync, encryptLocalSecretAsync } from './localSecretStore'
import { validateSourceInput, validateSourceModelQuery } from './codexSourceConfig'
import { fetchSourceModels } from './codexSourceModels'
import { codexSourceCatalogModel } from './codexSourceService'
import { CLAUDE_SOURCE_PRESETS, claudeSourceEffort, type ClaudeSourcePreset } from '../shared/claudeSources'
import { CODEX_SOURCE_NAMES, CODEX_SOURCE_PRESETS, codexSourceChatModels, codexSourceModelImageInput, type CodexSourceInput, type CodexSourceModelQueryInput, type CodexSourcesSnapshot } from '../shared/codexSources'
import { codexModelKey, codexWireModel, parseCodexModelKey } from '../shared/codexModelIdentity'
import type { ModelDef, SessionConfig } from '../shared/types'
import type { ClaudeConnection } from './claudeSourceRuntime'
import { cleanupStaleClaudeRuntimes } from './claudeSourceRuntime'

type StoredSource = Omit<CodexSourceInput, 'apiKey'> & { encryptedKey: string }

export function validateClaudeSource(input: unknown): CodexSourceInput {
  const value = validateSourceInput(input)
  if (!Object.hasOwn(CLAUDE_SOURCE_PRESETS, value.preset)) throw new Error('Claude 暂不支持此接入方式，请选择 Kimi Code、DeepSeek 或小米 MiMo')
  return value
}

export class ClaudeSourceService extends EventEmitter {
  private readonly directory = join(resolveUserDataHome(), 'claude-sources')
  private readonly file = join(this.directory, 'settings.json')
  private sources: StoredSource[] = []
  private flight: Promise<unknown> = Promise.resolve()
  private loading?: Promise<void>
  private loadError?: string

  start(): Promise<void> {
    return this.loading ??= this.load()
  }

  private async load(): Promise<void> {
    await cleanupStaleClaudeRuntimes()
    try {
      if ((await stat(this.file)).size > 2 * 1024 * 1024) throw new Error('配置过大')
      const stored = JSON.parse(await readFile(this.file, 'utf8'))
      const sourceLimit = new Set(Object.values(CLAUDE_SOURCE_PRESETS).map(preset => preset.id)).size
      if (stored.version !== 1 || !Array.isArray(stored.sources) || stored.sources.length > sourceLimit) throw new Error('配置格式错误')
      this.sources = stored.sources.map((source: StoredSource) => {
        const { apiKey: _apiKey, credential: _credential, ...value } = validateClaudeSource(source)
        if (typeof source.encryptedKey !== 'string' || !source.encryptedKey) throw new Error('缺少密文')
        return { ...value, encryptedKey: source.encryptedKey }
      })
      if (new Set(this.sources.map(source => source.id)).size !== this.sources.length) throw new Error('重复来源')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.sources = []
        this.loadError = 'Claude 模型配置无法读取，请恢复应用数据备份后重试'
      }
    }
  }

  snapshot(): CodexSourcesSnapshot {
    return { enabled: !this.loadError, phase: this.loadError ? 'error' : 'running', message: this.loadError,
      sources: this.sources.map(({ encryptedKey, ...source }) => ({ ...source, hasKey: !!encryptedKey })),
      legacyAvailable: false, quotaRefreshing: false }
  }

  save(input: CodexSourceInput): Promise<CodexSourcesSnapshot> {
    const operation = this.flight.then(async () => {
      await this.start()
      if (this.loadError) throw new Error(this.loadError)
      const source = validateClaudeSource(input)
      const { apiKey, ...metadata } = source
      const previous = this.sources.find(item => item.id === source.id)
      const encryptedKey = apiKey ? await encryptLocalSecretAsync(apiKey)
        : previous?.preset === source.preset && previous.baseUrl === source.baseUrl ? previous.encryptedKey : undefined
      if (!encryptedKey) throw new Error('请填写 API Key；更改接口地址后需要重新填写')
      const next = [...this.sources.filter(item => item.id !== source.id), { ...metadata, encryptedKey }]
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      const temporary = this.file + '.tmp'
      await writeFile(temporary, JSON.stringify({ version: 1, sources: next }), { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.file)
      this.sources = next
      const snapshot = this.snapshot()
      this.emit('changed', snapshot)
      return snapshot
    })
    this.flight = operation.catch(() => {})
    return operation
  }

  normalize(config: SessionConfig): SessionConfig {
    if (config.agentId !== 'claude' || !config.model) return config
    const parsed = parseCodexModelKey(config.model)
    if (parsed) {
      if (config.modelSource && (parsed.source.kind !== config.modelSource.kind || parsed.source.sourceId !== config.modelSource.sourceId)) throw new Error('模型与来源不匹配，请重新选择模型')
      return { ...config, modelSource: parsed.source }
    }
    return config.modelSource ? { ...config, model: codexModelKey(config.model, config.modelSource) } : config
  }

  assertReady(config: SessionConfig): void {
    const normalized = this.normalize(config)
    if (normalized.agentId !== 'claude' || !normalized.modelSource || normalized.modelSource.kind === 'native') return
    if (this.loadError) throw new Error(this.loadError)
    const source = this.sources.find(item => item.id === normalized.modelSource!.sourceId)
    if (normalized.modelSource.kind !== 'third-party' || !source?.enabled || !source.models.includes(codexWireModel(normalized)!)) {
      throw new Error('Claude 模型来源已停用、缺失或模型已移除，请重新选择模型')
    }
  }

  mergeModels(native: ModelDef[]): ModelDef[] {
    return [...native, ...this.sources.filter(source => source.enabled).flatMap(source => source.models.map(model => ({
      id: codexModelKey(model, { kind: 'third-party', sourceId: source.id }), label: `${CODEX_SOURCE_NAMES[source.id]} · ${model}`,
      ...claudeSourceEffort(model, source.preset as ClaudeSourcePreset), supportsFast: false, supportsMax: false,
      // 上下文窗口与 Codex 模型目录同源，供上下文负载计量显示总量；CLI 对第三方模型不上报窗口。
      contextWindow: codexSourceCatalogModel(model, source.preset).context_window as number,
      imageInput: codexSourceModelImageInput(source.preset, model),
      modelSource: { kind: 'third-party' as const, sourceId: source.id }
    })))]
  }

  async connection(config: SessionConfig): Promise<ClaudeConnection> {
    await this.start()
    this.assertReady(config)
    const normalized = this.normalize(config)
    const source = this.sources.find(item => item.id === normalized.modelSource?.sourceId)
    if (!source) throw new Error('Claude 模型来源不可用')
    return { baseUrl: source.baseUrl, apiKey: await decryptLocalSecretAsync(source.encryptedKey), model: codexWireModel(normalized)!, preset: source.preset as ClaudeSourcePreset }
  }

  async reusableSources(): Promise<CodexSourceInput[]> {
    await this.start()
    if (this.loadError) return []
    return Promise.all(this.sources.map(async ({ encryptedKey, ...source }) => ({ ...source, apiKey: await decryptLocalSecretAsync(encryptedKey) })))
  }

  async draftConnection(input: CodexSourceInput): Promise<ClaudeConnection> {
    await this.start()
    const source = validateClaudeSource(input)
    const previous = this.sources.find(item => item.id === source.id && item.preset === source.preset && item.baseUrl === source.baseUrl)
    const apiKey = source.apiKey || (previous && await decryptLocalSecretAsync(previous.encryptedKey))
    if (!apiKey) throw new Error('请先填写 API Key')
    return { baseUrl: source.baseUrl, apiKey, model: source.models[0], preset: source.preset as ClaudeSourcePreset }
  }

  async queryModels(input: CodexSourceModelQueryInput): Promise<string[]> {
    const query = validateSourceModelQuery(input)
    const connection = await this.draftConnection({ ...query, enabled: true, models: ['model-query'] })
    const official = CLAUDE_SOURCE_PRESETS[connection.preset].baseUrl
    if (connection.baseUrl !== official) throw new Error('自定义接口请手动填写模型 ID；自动查询仅支持厂商官方地址')
    return codexSourceChatModels(connection.preset, await fetchSourceModels(CODEX_SOURCE_PRESETS[connection.preset].baseUrl, connection.apiKey))
  }
}
