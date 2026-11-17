import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserDataHome } from '../userData'
import { encryptLocalSecretAsync, decryptLocalSecretAsync } from '../localSecretStore'
import { ModelGatewayClient } from '../model-source-gateway/client'
import type { GatewayState } from '../model-source-gateway/gateway'
import { codexModelKey, parseCodexModelKey } from '../../shared/codexModelIdentity'
import { ARK_CODING_MODELS, MODEL_AGENT_PROTOCOLS, modelSourceConnectionIdentity, modelSourceSupportsAgent, sourceDraft, validateModelSource, type AgentSourceBinding, type BindingStatus, type ModelSource, type ModelSourceInput, type ModelSourceImport, type ModelSourceSave, type ModelSourcesSnapshot, type SourceEndpoint, type SourceConnectionTest } from '../../shared/modelSources'
import type { AgentDef, ModelDef, SessionConfig } from '../../shared/types'
import { modelEndpointUrl } from '../../shared/modelSources'
import { manageRevision } from '../assistant/manageValue'
import { CODEX_SOURCE_NAMES, CODEX_SOURCE_PRESETS, type CodexSourcePreset } from '../../shared/codexSources'
import { codexSourceCatalogModel } from '../codexSourceService'
import { CLAUDE_SOURCE_PRESETS, claudeSourceEffort, type ClaudeSourcePreset } from '../../shared/claudeSources'
import { parseMCodeModelValue } from '../../shared/mcode'
import { modelSourceQuotaProvider, quotaCredentialIdentity, validateQuotaQuery, type ModelSourceQuota, type ModelSourceQuotaSave, type ModelSourceQuotaCredentials } from '../../shared/modelSourceQuota'

type QuotaGateway = Pick<ModelGatewayClient, 'update' | 'close' | 'port'> & Partial<Pick<ModelGatewayClient, 'queryQuota'>>

interface StoredSource extends Omit<ModelSource, 'hasCredential' | 'hasQuotaCredentials' | 'connectionTest'> { encryptedQuotaCredentials?: string; encryptedKey: string; endpointKeys?: Record<string, string>; token: string; runtimeRevision: number; verification?: { signature: string; result: SourceConnectionTest } }
interface Store { version: 1; revision: string; sources: StoredSource[]; bindings: AgentSourceBinding[]; aliases: Record<string, string>; port: number; receipts: string[] }
export interface SourceConnection { baseUrl: string; apiKey: string; endpoint: SourceEndpoint; source: ModelSource; binding: AgentSourceBinding }
export interface SourceAdapter { apply(source: ModelSource, binding: AgentSourceBinding, connection: SourceConnection, agent: AgentDef): Promise<Pick<AgentSourceBinding, 'nativeModels' | 'managedHash'> & { models?: ModelDef[] }>; detach?(binding: AgentSourceBinding, agent: AgentDef): Promise<void>; discover?(agent: AgentDef): Promise<ModelSourceInput[]> }
export class ModelSourceApplyError extends Error { constructor(message: string, readonly evidence: Pick<AgentSourceBinding, 'managedHash'>) { super(message) } }
export interface ModelSourceServiceDeps { agents(): AgentDef[]; adapters: Record<string, SourceAdapter>; busy?(agentId: string, sourceId: string): boolean; gateway?: QuotaGateway; directory?: string; enterprise?: { discover(): Promise<ModelSourceInput>; test(input: ModelSourceInput, endpointId: string, modelId: string): Promise<string> } }
const publicSource = ({ encryptedKey, encryptedQuotaCredentials, endpointKeys: _keys, token: _token, runtimeRevision: _runtime, verification, ...source }: StoredSource): ModelSource => ({ ...structuredClone(source), hasCredential: !!encryptedKey, hasQuotaCredentials: !!encryptedQuotaCredentials, ...(verification ? { connectionTest: structuredClone(verification.result) } : {}) })
const emptyStore = (): Store => ({ version: 1, revision: randomUUID(), sources: [], bindings: [], aliases: {}, port: 0, receipts: [] })
function sourceDefaultEffort(source: ModelSourceInput, model: ModelSourceInput['models'][number] | undefined, agentId: string, efforts = model?.capabilities?.efforts) {
  const value = model?.capabilities?.defaultEffort
  return ['trae', 'ark-coding-plan'].includes(source.preset) && ['deepseek', 'zcode'].includes(agentId) && value && efforts?.includes(value) ? value : undefined
}

export class ModelSourceService extends EventEmitter {
  private state = emptyStore()
  private readonly directory: string
  private readonly gateway: QuotaGateway
  private loaded?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private statuses: BindingStatus[] = []
  private phase: ModelSourcesSnapshot['gateway'] = 'stopped'
  private routeVersions = new Map<string, GatewayState['routes'][number]>()
  private error?: string
  private imports = new Map<string, { agentId: string; source: ModelSourceInput }>()
  private connectionTests = new Map<string, SourceConnectionTest>()
  private appliedModels = new Map<string, { revision: number; models: ModelDef[] }>()
  private quotaCache = new Map<string, { signature: string; value: ModelSourceQuota }>()
  private quotaFlights = new Map<string, { signature: string; promise: Promise<void> }>()
  constructor(private deps: ModelSourceServiceDeps) {
    super(); this.directory = deps.directory ?? join(resolveUserDataHome(), 'model-sources')
    this.gateway = deps.gateway ?? new ModelGatewayClient(running => { this.phase = running ? 'running' : 'error'; this.publish() })
  }
  async start(): Promise<void> {
    await (this.loaded ??= this.load())
  }
  private async load(): Promise<void> {
    try {
      const file = join(this.directory, 'settings.json')
      if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error('too large')
      const original = await readFile(file, 'utf8'), stored = JSON.parse(original) as Store
      if (stored.version !== 1 || typeof stored.revision !== 'string' || !Array.isArray(stored.sources) || stored.sources.length > 100 || !Array.isArray(stored.bindings) || !stored.aliases || !Array.isArray(stored.receipts)) throw new Error('invalid')
      stored.sources.forEach(source => { validateModelSource(source); source.runtimeRevision ||= 1; if (source.encryptedQuotaCredentials !== undefined && typeof source.encryptedQuotaCredentials !== 'string' || typeof source.encryptedKey !== 'string' || typeof source.token !== 'string' || !source.token || !Number.isInteger(source.revision) || source.endpointKeys && (typeof source.endpointKeys !== 'object' || Array.isArray(source.endpointKeys) || Object.entries(source.endpointKeys).some(([id, key]) => !source.endpoints.some(endpoint => endpoint.id === id) || typeof key !== 'string' || !key))) throw new Error('invalid') })
      if (new Set(stored.sources.map(source => source.id)).size !== stored.sources.length) throw new Error('duplicate')
      stored.bindings.forEach(binding => this.validateBinding(binding, stored.sources.find(source => source.id === binding.sourceId), true))
      this.state = stored
      let capabilitiesUpdated = false
      for (const source of stored.sources.filter(source => source.preset === 'ark-coding-plan')) {
        let updated = false
        for (const model of source.models) {
          const defaults = ARK_CODING_MODELS[model.id]
          if (!defaults?.efforts?.length) continue
          const previous = JSON.stringify(model.capabilities)
          const capabilities = { ...model.capabilities }
          capabilities.efforts ??= [...defaults.efforts]
          if (defaults.thinkingOptions) capabilities.thinkingOptions ??= [...defaults.thinkingOptions]
          if (capabilities.defaultEffort === undefined && capabilities.efforts.includes(defaults.defaultEffort!)) capabilities.defaultEffort = defaults.defaultEffort
          model.capabilities = capabilities
          updated ||= previous !== JSON.stringify(capabilities)
        }
        if (updated) { source.revision++; capabilitiesUpdated = true }
      }
      if (capabilitiesUpdated) { this.state.revision = randomUUID(); await this.persist() }
      for (const binding of this.state.bindings) if (!modelSourceSupportsAgent(this.state.sources.find(source => source.id === binding.sourceId)!, binding.agentId)) { binding.enabled = false; binding.modelIds = []; binding.appliedRevision = undefined }
      if (await this.consolidateLegacySources()) {
        try { await writeFile(join(this.directory, 'settings.before-source-grouping.json'), original, { flag: 'wx', mode: 0o600 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        await this.persist()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.error = '模型数据源配置无法读取，请检查应用数据备份'; return }
      try { await this.migrateLegacy() } catch { this.state = emptyStore(); this.error = '旧模型配置迁移未完成，请检查凭据和应用数据备份后重试'; return }
    }
    this.statuses = this.state.bindings.filter(binding => binding.enabled).map(binding => ({ sourceId: binding.sourceId, agentId: binding.agentId, state: 'pending' }))
  }
  snapshot(): ModelSourcesSnapshot { return { revision: this.state.revision, sources: this.state.sources.map(publicSource), bindings: structuredClone(this.state.bindings), statuses: structuredClone(this.statuses), gateway: this.phase, quotas: Object.fromEntries(this.state.sources.map(source => { const cached = this.quotaCache.get(source.id); return [source.id, cached?.signature === this.quotaSignature(source) ? structuredClone(cached.value) : { status: 'unsupported' as const }] })), ...(this.error ? { error: this.error } : {}) } }
  private quotaSignature(source: StoredSource): string { return createHash('sha256').update(JSON.stringify([modelSourceConnectionIdentity(source), source.encryptedKey, source.endpointKeys, source.quotaQuery, source.encryptedQuotaCredentials])).digest('hex') }
  async refreshQuotas(sourceId?: string, force = false): Promise<ModelSourcesSnapshot> {
    await this.start()
    if (sourceId !== undefined && (typeof sourceId !== 'string' || !this.state.sources.some(source => source.id === sourceId)) || typeof force !== 'boolean') throw new Error('额度查询参数无效')
    const sources = this.state.sources.filter(source => sourceId === undefined || source.id === sourceId)
    // Bound background requests without holding the configuration/apply queue.
    for (let offset = 0; offset < sources.length; offset += 4) await Promise.all(sources.slice(offset, offset + 4).map(source => this.refreshQuota(source, force)))
    return this.snapshot()
  }
  private async refreshQuota(source: StoredSource, force: boolean): Promise<void> {
    const signature = this.quotaSignature(source), cached = this.quotaCache.get(source.id), flight = this.quotaFlights.get(source.id)
    if (flight?.signature === signature) return flight.promise
    const previous = cached?.signature === signature ? cached.value : undefined
    if (!force && previous?.checkedAt && Date.now() - previous.checkedAt < (previous.status === 'error' ? 60_000 : 300_000)) return
    const publish = (value: ModelSourceQuota) => {
      const current = this.state.sources.find(item => item.id === source.id)
      if (current && this.quotaSignature(current) === signature) { this.quotaCache.set(source.id, { signature, value }); this.emit('quotaChanged', this.snapshot()) }
    }
    publish({ ...(previous ?? { status: 'unsupported' }), refreshing: true })
    const promise = (async () => {
      try {
        const provider = modelSourceQuotaProvider(source)
        if (!provider) { publish({ status: 'unsupported', checkedAt: Date.now(), message: '请在对应控制台查看额度' }); return }
        const credentials: ModelSourceQuotaCredentials | undefined = source.encryptedQuotaCredentials ? JSON.parse(await decryptLocalSecretAsync(source.encryptedQuotaCredentials)) : undefined
        const ark = provider.preset === 'ark-coding-plan' || provider.preset === 'ark-agent-plan'
        const independent = ark || provider.preset === 'new-api'
        if (ark && (!credentials?.accessKeyId || !credentials.secretAccessKey) || provider.preset === 'new-api' && (!credentials?.accessToken || !source.quotaQuery?.userId)) {
          publish({ status: 'unsupported', needsCredentials: true, checkedAt: Date.now(), message: ark ? '需要火山引擎 AK / SK' : '需要站点访问令牌和用户 ID' }); return
        }
        if (!this.gateway.queryQuota) throw new Error('额度查询服务不可用')
        const groups = new Map<string, string[]>()
        for (const endpoint of source.endpoints) {
          const key = independent ? '' : await this.endpointKey(source, endpoint.id)
          groups.set(key, [...(groups.get(key) ?? []), endpoint.id])
        }
        const entries = [...groups], accounts: NonNullable<ModelSourceQuota['accounts']> = []
        for (let offset = 0; offset < entries.length; offset += 4) accounts.push(...await Promise.all(entries.slice(offset, offset + 4).map(async ([key, endpointIds], index) => {
          const id = JSON.stringify([...endpointIds].sort())
          const old = entries.length === 1 ? previous : previous?.accounts?.find(account => account.id === id)?.quota
          let quota: ModelSourceQuota
          try {
            if (!independent && !key) throw new Error('额度查询需要先保存 API Key')
            quota = { ...await this.gateway.queryQuota!(provider.preset, provider.baseUrl, key, { query: source.quotaQuery, credentials }), checkedAt: Date.now(), refreshing: false }
          } catch (error) {
            const message = error instanceof Error && /^(?:额度|密钥无额度查询权限|Kimi|DeepSeek|GLM|MiMo)/.test(error.message) ? error.message : '额度查询失败，请稍后重试'
            quota = { ...(old?.capturedAt ? old : {}), status: 'error', message, stale: !!old?.capturedAt, checkedAt: Date.now(), refreshing: false }
          }
          const protocols = [...new Set(source.endpoints.filter(endpoint => endpointIds.includes(endpoint.id)).map(endpoint => ({ 'openai-chat': 'OpenAI Chat', 'openai-responses': 'Responses', 'anthropic-messages': 'Anthropic' })[endpoint.protocol]))].join(' / ')
          return { id, label: `凭据 ${offset + index + 1} · ${protocols}`, endpointIds, quota }
        })))
        if (accounts.length === 1) publish(accounts[0].quota)
        else publish({ status: accounts.some(account => account.quota.status === 'error') ? 'error' : 'ready', accounts, checkedAt: Date.now(), refreshing: false, message: accounts.some(account => account.quota.status === 'error') ? '部分凭据查询失败，详情中可查看原因' : undefined })
      } catch (error) {
        const message = error instanceof Error && /^(?:额度|密钥无额度查询权限|Kimi|DeepSeek|GLM|MiMo)/.test(error.message) ? error.message : '额度查询失败，请稍后重试'
        publish({ ...(previous?.capturedAt ? previous : {}), status: 'error', message, stale: !!previous?.capturedAt, refreshing: false, checkedAt: Date.now() })
      }
    })().finally(() => { if (this.quotaFlights.get(source.id)?.promise === promise) this.quotaFlights.delete(source.id) })
    this.quotaFlights.set(source.id, { signature, promise })
    return promise
  }
  async discoverImports(): Promise<{ candidates: ModelSourceImport[]; errors: string[] }> {
    this.imports.clear(); const errors: string[] = []
    for (const agent of this.deps.agents().filter(agent => agent.installed)) {
      const discover = this.deps.adapters[agent.id]?.discover
      if (!discover) continue
      try { for (const source of await discover(agent)) { this.imports.set(randomUUID(), { agentId: agent.id, source: validateModelSource(source) }) } }
      catch { errors.push(`${agent.name} 原生配置未能读取，其它来源仍可导入`) }
    }
    return { candidates: [...this.imports].map(([id, { agentId, source }]) => { const { apiKey, ...value } = source; return { id, agentId, source: { ...value, importId: id }, hasCredential: !!apiKey } }), errors }
  }
  configuration(): Record<string, unknown> { return { quotaCredentialStatus: this.state.sources.map(source => { const provider = modelSourceQuotaProvider(source)?.preset; return { sourceId: source.id, type: provider === 'ark-coding-plan' || provider === 'ark-agent-plan' ? 'ak-sk' : provider === 'new-api' ? 'access-token' : 'source-key', configured: provider === 'ark-coding-plan' || provider === 'ark-agent-plan' || provider === 'new-api' ? !!source.encryptedQuotaCredentials : !!source.encryptedKey } }), sources: this.state.sources.map(source => { const { revision: _revision, hasCredential: _credential, hasQuotaCredentials: _quotaCredential, connectionTest: _test, ...value } = publicSource(source); return value }), bindings: this.state.bindings.map(({ sourceId, agentId, enabled, endpointId, modelIds }) => ({ sourceId, agentId, enabled, endpointId, modelIds: [...modelIds] })) } }
  updateConfiguration(changes: Record<string, unknown>, expectedRevision: string): Promise<ModelSourcesSnapshot> {
    return this.enqueue(async () => {
      await this.start(); if (this.error) throw new Error(this.error)
      if (manageRevision(this.configuration()) !== expectedRevision) throw new Error('revision_conflict: 请重新读取模型配置')
      const previous = this.state
      const sources = changes.sources === undefined ? previous.sources : (changes.sources as ModelSourceInput[]).map(value => {
        const clean = validateModelSource(value), stored = previous.sources.find(source => source.id === clean.id)
        if (!stored) throw new Error('新增数据源与凭据请使用模型配置专用表单')
        if (modelSourceConnectionIdentity(clean) !== modelSourceConnectionIdentity(stored)) throw new Error('更换套餐或连接地址请通过专用表单重新确认凭据')
        const { apiKey: _key, ...metadata } = clean
        const verification = stored.verification && JSON.stringify(clean.models.find(model => model.id === stored.verification!.result.modelId)?.routes) === JSON.stringify(stored.models.find(model => model.id === stored.verification!.result.modelId)?.routes) ? stored.verification : undefined
        if (JSON.stringify(clean) === JSON.stringify(validateModelSource(stored))) return stored
        const { quotaQuery: _oldQuery, ...oldModel } = validateModelSource(stored)
        const { quotaQuery: _newQuery, ...newModel } = clean
        const next = { ...stored, ...metadata, verification, revision: stored.revision + (JSON.stringify(oldModel) === JSON.stringify(newModel) ? 0 : 1) }
        if (!metadata.quotaQuery) delete next.quotaQuery
        if (quotaCredentialIdentity(next) !== quotaCredentialIdentity(stored)) delete next.encryptedQuotaCredentials
        if (!metadata.consoleUrl) delete next.consoleUrl
        return next
      })
      if (sources.length !== previous.sources.length || new Set(sources.map(source => source.id)).size !== sources.length || previous.sources.some(source => !sources.some(next => next.id === source.id))) throw new Error('来源删除请使用模型配置专用流程；可通过 enabled 停用')
      const sourceChanged = (id: string) => sources.find(source => source.id === id)?.revision !== previous.sources.find(source => source.id === id)?.revision
      const bindings: AgentSourceBinding[] = changes.bindings === undefined ? previous.bindings.map(binding => ({ ...binding, appliedRevision: sourceChanged(binding.sourceId) ? undefined : binding.appliedRevision })) : (changes.bindings as AgentSourceBinding[]).map(value => {
        this.validateBinding(value, sources.find(source => source.id === value.sourceId))
        const stored = previous.bindings.find(binding => binding.sourceId === value.sourceId && binding.agentId === value.agentId)
        const unchanged = stored && !sourceChanged(value.sourceId) && stored.enabled === value.enabled && stored.endpointId === value.endpointId && JSON.stringify(stored.modelIds) === JSON.stringify(value.modelIds)
        return { ...stored, sourceId: value.sourceId, agentId: value.agentId, endpointId: value.endpointId, modelIds: [...value.modelIds], enabled: value.enabled, appliedRevision: unchanged ? stored.appliedRevision : undefined }
      })
      if (new Set(bindings.map(binding => binding.sourceId + '/' + binding.agentId)).size !== bindings.length) throw new Error('Agent 绑定重复')
      for (const old of previous.bindings) if (!bindings.some(binding => binding.sourceId === old.sourceId && binding.agentId === old.agentId)) bindings.push({ ...old, enabled: false, modelIds: [] })
      this.state = { ...previous, sources, bindings, revision: randomUUID() }
      try { await this.persist() } catch (error) { this.state = previous; throw error }
      if (sources.some(source => sourceChanged(source.id)) || JSON.stringify(bindings) !== JSON.stringify(previous.bindings)) { this.emit('connectionChanged', { sourceIds: sources.map(source => source.id) }); await this.applySaved() }
      else this.emit('quotaChanged', this.snapshot())
      return this.snapshot()
    })
  }
  private publish(): void { this.emit('changed', this.snapshot()) }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result }
  private async persist(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, 'settings.json'), temporary = file + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 }); await rename(temporary, file)
  }
  save(input: ModelSourceSave): Promise<ModelSourcesSnapshot> {
    return this.enqueue(async () => {
      await this.start()
      if (this.error) throw new Error(this.error)
      if (!input || typeof input.operationId !== 'string' || !/^[\w-]{1,100}$/.test(input.operationId)) throw new Error('保存操作 ID 无效')
      if (this.state.receipts.includes(input.operationId)) return this.snapshot()
      if (input.expectedRevision !== this.state.revision) throw new Error('revision_conflict: 配置已变化，请重新读取')
      const value = validateModelSource(input.source), previous = this.state.sources.find(source => source.id === value.id)
      if (value.id && !previous) throw new Error('数据源不存在，请刷新配置')
      const imported = input.source.importId && this.imports.get(input.source.importId)
      if (input.source.importId && !value.apiKey && (!imported || modelSourceConnectionIdentity(imported.source) !== modelSourceConnectionIdentity(value))) throw new Error('导入配置已过期或地址变化，请重新发现或填写 API Key')
      const { apiKey: enteredKey, ...metadata } = value
      const apiKey = enteredKey || (imported ? imported.source.apiKey : undefined)
      const credentialChanged = previous && modelSourceConnectionIdentity(previous) !== modelSourceConnectionIdentity(value)
      const encryptedKey = apiKey ? await encryptLocalSecretAsync(apiKey) : credentialChanged ? '' : previous?.encryptedKey ?? ''
      if (metadata.endpoints.some(endpoint => endpoint.auth !== 'none') && !encryptedKey) throw new Error('请填写 API Key；更换套餐、地址或认证方式后需重新填写')
      const id = previous?.id ?? randomUUID()
      const source: StoredSource = { ...metadata, id, revision: (previous?.revision ?? 0) + 1, runtimeRevision: (previous?.runtimeRevision ?? 1) + (previous && (apiKey || credentialChanged) ? 1 : 0), encryptedKey, ...(!apiKey && !credentialChanged && previous?.endpointKeys ? { endpointKeys: previous.endpointKeys } : {}), token: previous?.token ?? randomUUID() }
      if (previous?.encryptedQuotaCredentials && quotaCredentialIdentity(previous) === quotaCredentialIdentity(source)) source.encryptedQuotaCredentials = previous.encryptedQuotaCredentials
      for (const result of [...(previous?.verification ? [previous.verification.result] : []), ...this.connectionTests.values()].reverse()) {
        const signature = this.testSignature(source, result.endpointId, result.modelId, await this.endpointKey(source, result.endpointId))
        if (signature && (this.connectionTests.get(signature) === result || previous?.verification?.signature === signature)) { source.verification = { signature, result }; break }
      }
      if (!Array.isArray(input.bindings) || input.bindings.length > 30 || new Set(input.bindings.map(binding => binding.agentId)).size !== input.bindings.length) throw new Error('Agent 生效范围无效')
      const bindings: AgentSourceBinding[] = input.bindings.map(binding => {
        const old = this.state.bindings.find(old => old.sourceId === id && old.agentId === binding.agentId)
        const next = { sourceId: id, agentId: binding.agentId, enabled: binding.enabled, endpointId: binding.endpointId, modelIds: [...binding.modelIds], appliedRevision: old?.appliedRevision, appliedRuntimeRevision: old?.appliedRuntimeRevision, ...(old?.nativeModels ? { nativeModels: old.nativeModels, retiredNativeModels: old.retiredNativeModels, managedHash: old.managedHash } : {}) }
        this.validateBinding(next, source); return next
      })
      for (const old of this.state.bindings.filter(binding => binding.sourceId === id && !bindings.some(next => next.agentId === binding.agentId))) bindings.push({ ...old, enabled: false, modelIds: [] })
      const before = this.state
      this.state = { ...before, revision: randomUUID(), sources: [...before.sources.filter(item => item.id !== id), source], bindings: [...before.bindings.filter(binding => binding.sourceId !== id), ...bindings], receipts: [...before.receipts, input.operationId].slice(-50) }
      try { await this.persist() } catch (error) { this.state = before; throw error }
      this.emit('connectionChanged', { sourceIds: [id], revision: source.revision })
      this.publish()
      await this.applySaved(id)
      return this.snapshot()
    })
  }
  saveQuota(input: ModelSourceQuotaSave): Promise<ModelSourcesSnapshot> {
    return this.enqueue(async () => {
      await this.start(); if (this.error) throw new Error(this.error)
      if (!input || typeof input.operationId !== 'string' || !/^[\w-]{1,100}$/.test(input.operationId)) throw new Error('保存操作 ID 无效')
      if (this.state.receipts.includes(input.operationId)) return this.snapshot()
      if (input.expectedRevision !== this.state.revision) throw new Error('revision_conflict: 配置已变化，请重新读取')
      const previous = this.state.sources.find(source => source.id === input.sourceId)
      if (!previous || previous.preset === 'trae') throw new Error('额度查询来源无效')
      const source = { ...previous, quotaQuery: input.query === undefined ? previous.quotaQuery : validateQuotaQuery(input.query) }
      if (quotaCredentialIdentity(source) !== quotaCredentialIdentity(previous) || input.clearCredentials) delete source.encryptedQuotaCredentials
      if (input.credentials !== undefined) {
        const credentials = input.credentials, provider = modelSourceQuotaProvider(source)?.preset
        const ark = provider === 'ark-coding-plan' || provider === 'ark-agent-plan'
        const allowed = ark ? ['accessKeyId', 'secretAccessKey'] : provider === 'new-api' ? ['accessToken'] : []
        if (input.clearCredentials || !credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.keys(credentials).some(key => !allowed.includes(key)) || Object.values(credentials).some(value => typeof value !== 'string' || !value.trim() || value.length > 16000 || /[\s\x00-\x1f\x7f]/.test(value))) throw new Error('额度查询凭据无效')
        if (ark && (!credentials.accessKeyId || !credentials.secretAccessKey)) throw new Error('请同时填写 AK / SK')
        if (provider === 'new-api' && (!credentials.accessToken || !source.quotaQuery?.userId)) throw new Error('请填写访问令牌和用户 ID')
        if (!allowed.length) throw new Error('该额度查询方式不需要独立凭据')
        source.encryptedQuotaCredentials = await encryptLocalSecretAsync(JSON.stringify(credentials))
      }
      const before = this.state
      this.state = { ...before, revision: randomUUID(), sources: before.sources.map(item => item.id === source.id ? source : item), receipts: [...before.receipts, input.operationId].slice(-50) }
      try { await this.persist() } catch (error) { this.state = before; throw error }
      this.emit('quotaChanged', this.snapshot())
      return this.snapshot()
    })
  }
  private validateBinding(binding: AgentSourceBinding, source?: Pick<ModelSource, 'id' | 'preset' | 'endpoints' | 'models'>, legacy = false): void {
    if (!source || binding.sourceId !== source.id || typeof binding.enabled !== 'boolean' || !Object.hasOwn(MODEL_AGENT_PROTOCOLS, binding.agentId) || !Array.isArray(binding.modelIds) || new Set(binding.modelIds).size !== binding.modelIds.length) throw new Error('Agent 绑定无效')
    if (!binding.enabled && !binding.modelIds.length) return
    if (!legacy && binding.enabled && !modelSourceSupportsAgent(source, binding.agentId)) throw new Error('此数据源尚未验证该 Agent，请选择支持范围内的 Agent')
    const endpoint = source.endpoints.find(endpoint => endpoint.id === binding.endpointId)
    if (!endpoint || !MODEL_AGENT_PROTOCOLS[binding.agentId].includes(endpoint.protocol) || binding.modelIds.some(id => !source.models.some(model => model.id === id && model.routes.some(route => route.endpointId === endpoint.id))) || binding.enabled && !binding.modelIds.length) throw new Error('Agent、协议或模型范围不兼容')
  }
  apply(sourceId?: string): Promise<ModelSourcesSnapshot> { return this.enqueue(async () => { await this.start(); if (this.error) throw new Error(this.error); await this.applySaved(sourceId); return this.snapshot() }) }
  async applyPending(): Promise<void> {
    const pending = this.statuses.filter(status => status.state === 'pending' && !this.deps.busy?.(status.agentId, status.sourceId) && this.deps.agents().some(agent => agent.id === status.agentId && agent.installed) && status.message !== '已停用')
    if (pending.length) await this.enqueue(async () => { for (const id of new Set(pending.map(status => status.sourceId))) await this.applySaved(id) })
  }
  private async syncGateway(): Promise<void> {
    const routes: GatewayState['routes'] = []
    for (const source of this.state.sources.filter(source => source.enabled)) {
      for (const binding of this.state.bindings.filter(binding => binding.sourceId === source.id && binding.enabled && modelSourceSupportsAgent(source, binding.agentId))) {
        const endpoint = source.endpoints.find(endpoint => endpoint.id === binding.endpointId)!
        const apiKey = await this.endpointKey(source, endpoint.id)
        const modelMap = Object.fromEntries(source.models.filter(model => binding.modelIds.includes(model.id)).flatMap(model => model.routes.filter(route => route.endpointId === endpoint.id).map(route => [model.id, route.upstreamModel])))
        const id = source.id + '/' + endpoint.id + '/' + binding.agentId + '/' + source.runtimeRevision
        const pinned = this.deps.busy?.(binding.agentId, source.id) && binding.appliedRevision !== source.revision ? this.routeVersions.get(id) : undefined
        routes.push(pinned ?? { id, token: this.bindingToken(source, binding, source.runtimeRevision), traceKey: this.bindingToken(source, binding), apiKey, endpoint, modelMap, models: Object.keys(modelMap), ...(source.preset === 'trae' ? { upstream: 'trae' as const } : {}), ...(source.preset === 'kimi' ? { kimi: true } : {}), ...(source.preset === 'deepseek' && endpoint.protocol === 'anthropic-messages' ? { files: true } : {}) })
      }
    }
    for (const route of this.routeVersions.values()) {
      const [sourceId, , agentId, revision] = route.id.split('/')
      if (this.deps.busy?.(agentId, sourceId) && this.state.bindings.some(binding => binding.sourceId === sourceId && binding.agentId === agentId && binding.appliedRuntimeRevision === Number(revision)) && !routes.some(current => current.id === route.id)) routes.push(route)
    }
    this.routeVersions = new Map(routes.map(route => [route.id, route]))
    if (!routes.length && this.phase === 'stopped') return
    this.phase = 'starting'; this.publish()
    try { this.state.port = await this.gateway.update({ routes }, this.state.port); this.phase = 'running' }
    catch { this.phase = 'error'; throw new Error('模型网关不可用，请重试应用') }
  }
  private async applySaved(sourceId?: string): Promise<void> {
    try { await this.syncGateway() } catch (error) {
      for (const binding of this.state.bindings.filter(binding => !sourceId || binding.sourceId === sourceId)) this.setStatus(binding, 'failed', (error as Error).message)
      await this.persist(); this.publish(); return
    }
    for (const binding of this.state.bindings.filter(binding => !sourceId || binding.sourceId === sourceId)) {
      const source = this.state.sources.find(source => source.id === binding.sourceId)!, agent = this.deps.agents().find(agent => agent.id === binding.agentId)
      const adapter = this.deps.adapters[binding.agentId]
      if (!modelSourceSupportsAgent(source, binding.agentId)) { binding.appliedRevision = undefined; this.setStatus(binding, 'unsupported', '此来源接入尚未验证，已移出支持范围'); continue }
      if (this.deps.busy?.(binding.agentId, source.id)) { this.setStatus(binding, 'pending', '该来源正在执行任务，空闲后自动应用'); continue }
      if (!agent?.installed) { this.setStatus(binding, 'pending', '请先在 Agent 设置中安装对应程序'); continue }
      if (!adapter) { this.setStatus(binding, 'unsupported', '该 Agent 暂未提供来源适配'); continue }
      this.setStatus(binding, 'applying')
      try {
        if (!binding.enabled || !source.enabled) { await adapter.detach?.(binding, agent); binding.appliedRevision = undefined; this.setStatus(binding, 'pending', '已停用'); continue }
        const { models, ...result } = await adapter.apply(publicSource(source), structuredClone(binding), this.localConnection(source, binding), agent)
        if (models) this.appliedModels.set(source.id + '/' + binding.agentId, { revision: source.revision, models })
        const retired = [...(binding.retiredNativeModels || []), ...Object.values(binding.nativeModels || {}).filter(id => !Object.values(result.nativeModels || {}).includes(id))]
        Object.assign(binding, result, { retiredNativeModels: [...new Set(retired)], appliedRevision: source.revision, appliedRuntimeRevision: source.runtimeRevision }); this.setStatus(binding, 'applied', ['codex', 'claude', 'mcode', 'deepseek', 'zcode'].includes(binding.agentId) ? '下一次新建会话生效' : '模型列表已应用')
      } catch (error) { if (error instanceof ModelSourceApplyError) Object.assign(binding, error.evidence); this.setStatus(binding, /conflict/.test(String(error)) ? 'conflict' : 'failed', this.safeError(error, source)) }
    }
    await this.persist(); this.publish()
  }
  private setStatus(binding: AgentSourceBinding, state: BindingStatus['state'], message?: string): void { this.statuses = [...this.statuses.filter(status => status.sourceId !== binding.sourceId || status.agentId !== binding.agentId), { sourceId: binding.sourceId, agentId: binding.agentId, state, message }]; this.publish() }
  private safeError(error: unknown, source?: StoredSource): string { let text = error instanceof Error ? error.message : '来源应用失败'; if (source) for (const binding of this.state.bindings.filter(binding => binding.sourceId === source.id)) for (const token of [source.token, this.bindingToken(source, binding, source.runtimeRevision), this.bindingToken(source, binding)]) text = text.split(token).join('[本地凭据]'); return text.slice(0, 500) }
  private localConnection(source: StoredSource, binding: AgentSourceBinding): SourceConnection {
    const endpoint = source.endpoints.find(endpoint => endpoint.id === binding.endpointId)!
    return { baseUrl: `http://127.0.0.1:${this.state.port}/s/${source.id}/e/${endpoint.id}/a/${binding.agentId}/r/${source.runtimeRevision}`, apiKey: this.bindingToken(source, binding, source.runtimeRevision), endpoint, source: publicSource(source), binding }
  }
  private bindingToken(source: StoredSource, binding: AgentSourceBinding, revision?: number): string { return createHash('sha256').update(source.token + '/' + binding.agentId + '/' + binding.endpointId + (revision ? '/' + revision : '')).digest('hex') }
  owns(config: SessionConfig): boolean { const sourceId = this.selectionSource(config); return !!sourceId && this.state.sources.some(source => source.id === sourceId) }
  usesSource(config: SessionConfig, sourceId: string): boolean { return this.selectionSource(config) === sourceId }
  private selectionSource(config: SessionConfig): string | undefined {
    const id = config.modelSource?.sourceId ?? (config.model ? parseCodexModelKey(config.model)?.source.sourceId : undefined)
    return id ? this.state.aliases[config.agentId + '/' + id] ?? id : this.state.bindings.find(binding => binding.agentId === config.agentId && [...Object.values(binding.nativeModels || {}), ...(binding.retiredNativeModels || [])].some(model => this.nativeMatch(config, model)))?.sourceId
  }
  private nativeMatch(config: SessionConfig, model: string): boolean { if (model === config.model) return true; if (config.agentId !== 'mcode') return false; const current = parseMCodeModelValue(config.model), target = parseMCodeModelValue(model); return !!current && !!target && current.providerId === target.providerId && current.modelId === target.modelId }
  normalize(config: SessionConfig): SessionConfig {
    if (!config.model) return config
    const parsed = parseCodexModelKey(config.model), sourceId = this.selectionSource(config)
    if (parsed && config.modelSource && (config.modelSource.kind !== parsed.source.kind || (this.state.aliases[config.agentId + '/' + parsed.source.sourceId] ?? parsed.source.sourceId) !== sourceId)) throw new Error('模型与数据源不匹配，请重新选择')
    if (!sourceId || !this.state.sources.some(source => source.id === sourceId)) return config
    const record = this.state.sources.find(source => source.id === sourceId)!, binding = this.state.bindings.find(binding => binding.sourceId === sourceId && binding.agentId === config.agentId)
    const source = { kind: 'third-party' as const, sourceId }
    const matches = parsed && record.models.filter(model => model.routes.some(route => route.endpointId === binding?.endpointId && route.upstreamModel === parsed.model))
    const modelId = parsed && record.models.some(model => model.id === parsed.model) ? parsed.model : matches && matches.length === 1 ? matches[0].id : parsed?.model
    const model = record.models.find(model => model.id === modelId || binding?.nativeModels?.[model.id] && this.nativeMatch(config, binding.nativeModels[model.id]))
    const defaultEffort = sourceDefaultEffort(record, model, config.agentId)
    return { ...config, ...(defaultEffort && config.effort === undefined && !config.zcodeModelSelection?.options?.reasoningLevel ? { effort: defaultEffort } : {}), ...(parsed ? { model: codexModelKey(modelId!, source) } : {}), modelSource: source }
  }
  assertReady(config: SessionConfig): void {
    if (!this.owns(config)) return
    config = this.normalize(config)
    const id = this.selectionSource(config), source = this.state.sources.find(source => source.id === id)!, binding = this.state.bindings.find(binding => binding.sourceId === id && binding.agentId === config.agentId)
    const model = config.model && (parseCodexModelKey(config.model)?.model ?? Object.entries(binding?.nativeModels || {}).find(([, native]) => this.nativeMatch(config, native))?.[0])
    if (!source.enabled || !binding?.enabled || !modelSourceSupportsAgent(source, config.agentId) || binding.appliedRevision !== source.revision || !model || !binding.modelIds.includes(model) || this.phase !== 'running') throw new Error('模型数据源尚未生效、已停用或模型已移除，请在模型配置中检查')
    if (config.agentId === 'codex' && config.permissionMode === 'approve-for-me') throw new Error('此来源尚未验证自动审批，请选择其它审批方式')
  }
  connection(config: SessionConfig): SourceConnection { this.assertReady(config); const source = this.state.sources.find(source => source.id === this.selectionSource(config))!; return this.localConnection(source, this.state.bindings.find(binding => binding.sourceId === source.id && binding.agentId === config.agentId)!) }
  mergeModels(agentId: string, native: ModelDef[], session = false): ModelDef[] {
    const additions: ModelDef[] = []
    for (const binding of this.state.bindings.filter(binding => binding.agentId === agentId && binding.enabled)) {
      const source = this.state.sources.find(source => source.id === binding.sourceId)
      if (!source?.enabled || !modelSourceSupportsAgent(source, agentId) || binding.appliedRevision !== source.revision) continue
      for (const id of binding.modelIds) {
        const model = source.models.find(model => model.id === id)!
        const sourceRef = { kind: 'third-party' as const, sourceId: source.id }
        const nativeId = binding.nativeModels?.[id]
        const applied = this.appliedModels.get(source.id + '/' + agentId)
        const catalogModels = !session && applied?.revision === source.revision ? applied.models : native
        const nativeModel = nativeId ? catalogModels.find(model => model.id === nativeId) : undefined
        const defaultEffort = sourceDefaultEffort(source, model, agentId, nativeModel?.efforts ?? model.capabilities?.efforts)
        const preset = (Object.hasOwn(CODEX_SOURCE_PRESETS, source.plan || '') ? source.plan : source.preset) as CodexSourcePreset
        const catalog = Object.hasOwn(CODEX_SOURCE_PRESETS, preset) ? codexSourceCatalogModel(id, preset) : undefined
        const claudePreset = Object.hasOwn(CLAUDE_SOURCE_PRESETS, preset) ? preset as ClaudeSourcePreset : undefined
        const effort = agentId === 'claude' && claudePreset ? claudeSourceEffort(id, claudePreset) : catalog ? { efforts: (catalog.supported_reasoning_levels as any[]).map(level => level.effort), defaultEffort: catalog.default_reasoning_level as any } : {}
        additions.push({ ...(catalog ? { contextWindow: catalog.context_window as number, imageInput: (catalog.input_modalities as string[]).includes('image') } : {}), ...effort, ...model.capabilities, ...nativeModel, ...(defaultEffort ? { defaultEffort, ...(agentId === 'zcode' ? { defaultThinking: defaultEffort } : {}) } : {}), id: ['codex', 'claude'].includes(agentId) ? codexModelKey(id, sourceRef) : nativeId ?? codexModelKey(id, sourceRef), label: `${source.preset === 'ark-coding-plan' && ['字节方舟 Coding Plan', '火山方舟 Coding Plan', '火山方舟 Agent Plan'].includes(source.name) ? source.plan === 'agent' ? '方舟 AP' : '方舟 CP' : source.name} · ${model.label}`, efforts: nativeModel?.efforts ?? (['codex','claude'].includes(agentId) ? model.capabilities?.efforts ?? ('efforts' in effort ? effort.efforts : undefined) : undefined) ?? [], modelSource: sourceRef })
      }
    }
    const managedNative = new Set(additions.map(model => model.id))
    const sourceIds = new Set(this.state.sources.map(source => source.id))
    const nativeIds = new Set(this.state.bindings.filter(binding => binding.agentId === agentId).flatMap(binding => [...Object.values(binding.nativeModels || {}), ...(binding.retiredNativeModels || [])]))
    return [...native.filter(model => !managedNative.has(model.id) && !nativeIds.has(model.id) && !sourceIds.has(model.modelSource?.sourceId || '') && !this.state.aliases[agentId + '/' + model.modelSource?.sourceId]), ...additions]
  }
  projectNativeModels(agentId: string, native: ModelDef[]): ModelDef[] { const ids = new Set(native.map(model => model.id)); return this.mergeModels(agentId, native, true).filter(model => ids.has(model.id)) }
  async query(input: ModelSourceInput, endpointId: string): Promise<ModelSource['models']> {
    if (input.preset === 'trae') { if (!this.deps.enterprise) throw new Error('企业模型来源在当前版本不可用'); return (await this.deps.enterprise.discover()).models }
    await this.start(); const value = validateModelSource(input), endpoint = value.endpoints.find(endpoint => endpoint.id === endpointId)
    if (!endpoint) throw new Error('请选择协议端点')
    const previous = this.state.sources.find(source => source.id === input.id)
    const key = value.apiKey || this.importedKey(input, value) || (previous && modelSourceConnectionIdentity(previous) === modelSourceConnectionIdentity(value) ? await this.endpointKey(previous, endpointId) : '')
    if (endpoint.auth !== 'none' && !key) throw new Error('请先填写 API Key')
    // Ark's /models includes video, image and dated platform IDs, not subscription aliases.
    if (value.preset === 'ark-coding-plan') return sourceDraft('ark-coding-plan', value.plan).models.map(model => ({ ...model, routes: [{ endpointId, upstreamModel: model.id }] }))
    const headers: Record<string, string> = endpoint.auth === 'x-api-key' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : endpoint.auth === 'bearer' ? { Authorization: `Bearer ${key}` } : {}
    const catalogEndpoint = value.preset === 'custom' ? endpoint : value.endpoints.find(endpoint => endpoint.protocol === 'openai-chat') ?? value.endpoints.find(endpoint => endpoint.protocol === 'openai-responses') ?? endpoint
    const response = await fetch(modelEndpointUrl(catalogEndpoint, '/models'), { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`模型目录查询失败（HTTP ${response.status}），可手工添加模型`) }
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error('模型目录过大')
    const body = JSON.parse(text), rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
    const presetModels = value.preset === 'mimo' ? new Set(sourceDraft('mimo', value.plan).models.map(model => model.id)) : undefined
    const models = rows.filter((row: any) => typeof (row.id ?? row.slug) === 'string' && (!presetModels || presetModels.has(row.id ?? row.slug))).slice(0, 100).map((row: any) => {
      const contextWindow = row.context_window ?? row.max_context_size ?? row.contextWindow
      const imageInput = Array.isArray(row.input_modalities) ? row.input_modalities.includes('image') : row.capabilities?.vision
      return { id: row.id ?? row.slug, label: row.display_name ?? row.displayName ?? row.id ?? row.slug, routes: [{ endpointId, upstreamModel: row.id ?? row.slug }], ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { maxContextWindow: contextWindow } : {}), capabilities: { ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}), ...(typeof imageInput === 'boolean' ? { imageInput } : {}) } }
    })
    return validateModelSource({ ...value, models }).models
  }
  async revealCredential(sourceId: string, endpointId: string, expectedConnection: string): Promise<string> {
    await this.start(); if (this.error) throw new Error(this.error)
    const source = this.state.sources.find(source => source.id === sourceId)
    if (!source || !source.endpoints.some(endpoint => endpoint.id === endpointId)) throw new Error('数据源或协议端点不存在')
    if (modelSourceConnectionIdentity(source) !== expectedConnection) throw new Error('连接信息已变化，请重新读取来源或填写当前套餐的 API Key')
    return this.endpointKey(source, endpointId)
  }
  private testSignature(source: Pick<ModelSourceInput, 'preset' | 'plan' | 'endpoints' | 'models'>, endpointId: string, modelId: string, key: string): string | undefined {
    const endpoint = source.endpoints.find(endpoint => endpoint.id === endpointId), model = source.models.find(model => model.id === modelId)?.routes.find(route => route.endpointId === endpointId)
    return endpoint && model ? createHash('sha256').update(JSON.stringify({ endpoint, model, key, ...(source.preset === 'ark-coding-plan' && source.plan === 'agent' ? { plan: 'agent' } : {}) })).digest('hex') : undefined
  }
  async test(input: ModelSourceInput, endpointId: string, modelId: string): Promise<SourceConnectionTest> {
    const start = Date.now()
    if (input.preset === 'trae' && !this.deps.enterprise) throw new Error('企业模型来源在当前版本不可用')
    await this.start(); const value = validateModelSource(input), endpoint = value.endpoints.find(endpoint => endpoint.id === endpointId), model = value.models.find(model => model.id === modelId)?.routes.find(route => route.endpointId === endpointId)
    if (!endpoint || !model) throw new Error('请选择当前协议支持的模型')
    const previous = this.state.sources.find(source => source.id === input.id)
    const key = value.apiKey || this.importedKey(input, value) || (previous && modelSourceConnectionIdentity(previous) === modelSourceConnectionIdentity(value) ? await this.endpointKey(previous, endpointId) : '')
    if (endpoint.auth !== 'none' && !key) throw new Error('请先填写 API Key')
    const messages = [{ role: 'user', content: 'Reply OK.' }]
    const body = endpoint.protocol === 'openai-responses' ? { model: model.upstreamModel, input: messages, max_output_tokens: 1024 } : { model: model.upstreamModel, messages, max_tokens: 2048, stream: false,
      ...(value.preset === 'ark-coding-plan' && endpoint.protocol === 'anthropic-messages' && /^glm-/.test(model.upstreamModel) ? { thinking: { type: 'enabled', budget_tokens: 1024 } } : {}) }
    const resource = endpoint.protocol === 'anthropic-messages' ? '/messages' : endpoint.protocol === 'openai-responses' ? '/responses' : '/chat/completions'
    let state: SourceConnectionTest['state'] = 'connected', message = '连接成功；当前模型已返回文本'
    try {
      if (value.preset === 'trae') message = await this.deps.enterprise!.test(value, endpointId, modelId)
      else {
        const response = await fetch(modelEndpointUrl(endpoint, resource), { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(endpoint.auth === 'bearer' ? { Authorization: `Bearer ${key}` } : endpoint.auth === 'x-api-key' ? { 'x-api-key': key } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(45_000) })
        if (!response.ok) { await response.body?.cancel(); throw new Error(`连接失败（HTTP ${response.status}），请检查协议、模型与账号权限`) }
        const result = await response.json() as any
        const texts = endpoint.protocol === 'anthropic-messages' ? result.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text) : endpoint.protocol === 'openai-responses' ? result.output?.flatMap((item: any) => item.content || []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text) : result.choices?.map((choice: any) => choice.message?.content)
        if (result.error || !texts?.some((text: unknown) => typeof text === 'string' && text.trim())) throw new Error('上游未返回当前协议的文本输出，请检查模型或重试')
      }
    } catch (error) { state = 'failed'; message = error instanceof Error && /^(连接失败|上游未返回|企业模型|企业登录|当前企业)/.test(error.message) ? error.message : '连接请求未完成，请检查网络与地址后重试' }
    const result: SourceConnectionTest = { state, endpointId, modelId, checkedAt: Date.now(), elapsedMs: Date.now() - start, message }, signature = this.testSignature(value, endpointId, modelId, key)!
    this.connectionTests.delete(signature); this.connectionTests.set(signature, result)
    if (this.connectionTests.size > 32) this.connectionTests.delete(this.connectionTests.keys().next().value!)
    await this.enqueue(async () => {
      const current = this.state.sources.find(source => source.id === input.id)
      if (current && this.testSignature(current, endpointId, modelId, await this.endpointKey(current, endpointId)) === signature) { current.verification = { signature, result }; await this.persist(); this.publish() }
    })
    return result
  }
  private importedKey(input: ModelSourceInput, value: ModelSourceInput): string { const imported = input.importId && this.imports.get(input.importId); return imported && modelSourceConnectionIdentity(imported.source) === modelSourceConnectionIdentity(value) ? imported.source.apiKey || '' : '' }
  private async endpointKey(source: StoredSource, endpointId: string): Promise<string> { const key = source.endpointKeys?.[endpointId] ?? source.encryptedKey; return key ? decryptLocalSecretAsync(key) : '' }
  private async consolidateLegacySources(): Promise<boolean> {
    let changed = false
    for (const [plan, preset] of Object.entries(CODEX_SOURCE_PRESETS)) {
      const primary = this.state.sources.find(source => source.id === this.state.aliases['codex/' + preset.id]), secondary = this.state.sources.find(source => source.id === this.state.aliases['claude/' + preset.id])
      if (!primary || !secondary || primary === secondary || primary.preset !== preset.id || secondary.preset !== preset.id || primary.plan !== plan || secondary.plan !== plan) continue
      const claude = Object.hasOwn(CLAUDE_SOURCE_PRESETS, plan) ? CLAUDE_SOURCE_PRESETS[plan as ClaudeSourcePreset] : undefined
      const official = (source: StoredSource) => source.endpoints.every(endpoint => endpoint.baseUrl.replace(/\/+$/, '') === (endpoint.protocol === 'openai-responses' ? preset.baseUrl : endpoint.protocol === 'anthropic-messages' ? claude?.baseUrl : undefined))
      const bindings = this.state.bindings.filter(binding => [primary.id, secondary.id].includes(binding.sourceId))
      if (!official(primary) || !official(secondary) || new Set(bindings.map(binding => binding.agentId)).size !== bindings.length || primary.endpoints.length + secondary.endpoints.length > 10 || new Set([...primary.models, ...secondary.models].map(model => model.id)).size > 100 || primary.endpoints.some(endpoint => secondary.endpoints.some(other => other.id === endpoint.id))) continue
      const sharedKey = primary.encryptedKey ? await decryptLocalSecretAsync(primary.encryptedKey) : ''
      for (const endpoint of secondary.endpoints) {
        const encrypted = secondary.endpointKeys?.[endpoint.id] ?? secondary.encryptedKey
        if (encrypted && await decryptLocalSecretAsync(encrypted) !== sharedKey) (primary.endpointKeys ??= {})[endpoint.id] = encrypted
      }
      primary.endpoints.push(...secondary.endpoints)
      for (const model of secondary.models) {
        const existing = primary.models.find(existing => existing.id === model.id)
        if (existing) { existing.routes.push(...model.routes); existing.capabilities = { ...model.capabilities, ...existing.capabilities } }
        else primary.models.push(model)
      }
      if (primary.name === 'Codex · ' + preset.id) primary.name = CODEX_SOURCE_NAMES[preset.id]
      primary.enabled ||= secondary.enabled
      primary.revision = Math.max(primary.revision, secondary.revision) + 1
      primary.runtimeRevision = Math.max(primary.runtimeRevision, secondary.runtimeRevision) + 1
      for (const binding of bindings) { this.state.aliases[binding.agentId + '/' + binding.sourceId] = primary.id; binding.sourceId = primary.id; binding.appliedRevision = undefined; binding.appliedRuntimeRevision = undefined }
      for (const [alias, id] of Object.entries(this.state.aliases)) if (id === secondary.id) this.state.aliases[alias] = primary.id
      this.state.sources = this.state.sources.filter(source => source !== secondary)
      changed = true
    }
    if (changed) this.state.revision = randomUUID()
    return changed
  }
  private async migrateLegacy(): Promise<void> {
    const parent = join(this.directory, '..')
    for (const agentId of ['codex', 'claude']) {
      let stored: any
      try { stored = JSON.parse(await readFile(join(parent, agentId + '-sources', 'settings.json'), 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error('旧来源配置无法读取，迁移已停止') }
      if (stored.version !== 1 || !Array.isArray(stored.sources)) throw new Error('旧来源配置格式无效')
      for (const old of stored.sources) {
        if (!old.encryptedKey) continue
        const preset = old.preset.startsWith('kimi') ? 'kimi' : old.id
        const draft: ModelSourceInput = { name: `${agentId === 'claude' ? 'Claude' : 'Codex'} · ${old.id}`, preset, plan: old.preset, enabled: !!old.enabled && (agentId !== 'codex' || stored.enabled),
          endpoints: [{ id: agentId, protocol: agentId === 'claude' ? 'anthropic-messages' : 'openai-responses', baseUrl: old.baseUrl, auth: agentId === 'claude' && old.id === 'kimi' ? 'x-api-key' : 'bearer' }], models: old.models.map((id: string) => ({ id, label: id, routes: [{ endpointId: agentId, upstreamModel: id }] })) }
        validateModelSource(draft)
        await decryptLocalSecretAsync(old.encryptedKey)
        const id = randomUUID()
        this.state.sources.push({ ...draft, id, revision: 1, runtimeRevision: 1, encryptedKey: old.encryptedKey, token: randomUUID() })
        this.state.bindings.push({ sourceId: id, agentId, enabled: draft.enabled, endpointId: agentId, modelIds: old.models })
        this.state.aliases[agentId + '/' + old.id] = id
      }
    }
    await this.consolidateLegacySources(); await this.persist()
  }
  async close(): Promise<void> { await this.tail; await this.gateway.close() }
}
