import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ZCODE_MODEL_SERVICES, type ZCodeConfigurationInput, type ZCodeConfigurationSnapshot, type ZCodeModelService } from '../../shared/zcode'
import { resolveUserDataHome } from '../userData'
import { mergeZCodeConfig } from './catalog'
import { isRecord } from './protocol'
import { resolveZCodeConfigurationRuntime, validateZCodeRuntimeConfig, zcodeRuntimeConfigPath, type ZCodeRuntime } from './runtime'
import { sanitizeZCodeSelection, writeZCodeJson } from './store'
import { ZCodeSetupTrace, type ZCodeRequestDiagnostic, type ZCodeSetupReporter } from './diagnostics'

class ConfigurationError extends Error {
  constructor(message: string, readonly diagnostic?: ZCodeRequestDiagnostic, options?: ErrorOptions) { super(message, options) }
}
const serviceDefinition = (id: ZCodeModelService) => ZCODE_MODEL_SERVICES.find(service => service.id === id)!
const emptyProvider = () => ({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] },
  modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } })

async function optionalText(path: string, privateFile = false): Promise<string> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 2 * 1024 * 1024 || privateFile && process.platform !== 'win32' && (info.mode & 0o077)) {
      throw new ConfigurationError('ZCode 配置文件无效或权限过宽，请检查本机配置')
    }
    return await readFile(path, 'utf8')
  } catch (error: any) { if (error.code === 'ENOENT') return ''; throw error }
}

async function storedConfiguration() {
  const runtimeText = await optionalText(zcodeRuntimeConfigPath())
  let runtime: any
  try { runtime = runtimeText ? JSON.parse(runtimeText) : undefined }
  catch { throw new ConfigurationError('ZCode 运行时配置无法读取，请重新配置运行时') }
  const path = typeof runtime?.personalProviderConfigPath === 'string' && isAbsolute(runtime.personalProviderConfigPath)
    ? runtime.personalProviderConfigPath : join(homedir(), 'Library', 'Application Support', 'UniAgentZCode', 'provider_config.json')
  const text = await optionalText(path, true)
  let document: any
  try { document = text ? JSON.parse(text) : emptyProvider() }
  catch { throw new ConfigurationError('ZCode Provider 配置无法读取，请检查本机配置') }
  if (!isRecord(document) || document.schemaVersion !== 1 || !isRecord(document.config)
    || !Array.isArray(document.config.providerConfigRules?.providerRules)) throw new ConfigurationError('ZCode Provider 配置格式不兼容')
  const selection = sanitizeZCodeSelection(document.config.defaultModelSelection)
  const rules = document.config.providerConfigRules.providerRules
  let provider: any
  for (const rule of rules) if (rule?.providerId === selection?.providerId) provider = mergeZCodeConfig(provider, rule)
  let builtin: any
  if (runtime?.resourceRoot) {
    try { builtin = JSON.parse(await readFile(join(runtime.resourceRoot, 'provider', 'zcode-builtin.json'), 'utf8'))?.config }
    catch { /* The runtime check reports missing resources before a key is saved. */ }
  }
  const template = builtin?.providerConfigRules?.templateRules?.find((rule: any) => rule.templateId === provider?.templateId)
  const config = mergeZCodeConfig(template?.config, provider?.config)
  const service = ZCODE_MODEL_SERVICES.find(item => item.accessType === config?.access?.type && item.apiType === config?.api?.type
    && item.baseUrl === config?.api?.baseUrl?.replace(/\/+$/, ''))?.id
  const key = service && provider?.enabled !== false && selection?.providerId.startsWith('personal:')
    && typeof config?.access?.apiKey === 'string' ? config.access.apiKey.trim() : ''
  let engineStamp = ''
  try { const info = await stat(runtime?.bundlePath ?? runtime?.executable); engineStamp = `${info.size}:${info.mtimeMs}` } catch { /* No installed engine. */ }
  const identity = createHash('sha256').update(JSON.stringify([runtimeText, text, engineStamp])).digest('hex')
  return { document, selection, service, key, identity, hasRuntime: !!runtime?.personalProviderConfigPath }
}

function candidateProvider(stored: Awaited<ReturnType<typeof storedConfiguration>>, service: ZCodeModelService, key: string, builtin?: any, returnedModels?: string[]): any {
  const definition = serviceDefinition(service)
  const document = structuredClone(stored.document)
  const rules = document.config.providerConfigRules.providerRules
  const providerId = stored.service === service && stored.selection ? stored.selection.providerId : `personal:uniagent-zcode-${service}`
  const previous = rules.findLast((rule: any) => rule.providerId === providerId)
  const template = builtin?.providerConfigRules?.templateRules?.find((rule: any) => rule.templateId === definition.templateId)
  const supported: string[] = template?.config?.builtinModelIds ?? previous?.config?.personalModelIds ?? [stored.selection?.modelId ?? 'GLM-5.3']
  const available = returnedModels && new Set(returnedModels.map(id => id.toLowerCase()))
  const models = available ? supported.filter(id => available.has(id.toLowerCase())) : supported
  if (!models.length || models.some(model => typeof model !== 'string' || !model)) throw new ConfigurationError(available
    ? '返回的模型中没有当前 ZCode 运行时支持的模型，请检查所选服务或更新 ZCode'
    : '当前运行时没有可用的 GLM 模型配置')
  const modelId = stored.selection && models.includes(stored.selection.modelId) ? stored.selection.modelId : models[0]
  const provider = { ...previous, providerId, templateId: definition.templateId, providerName: definition.label, enabled: true,
    config: { ...previous?.config, group: 'standard-personal',
      access: { type: definition.accessType, apiKey: key }, api: { type: definition.apiType, baseUrl: definition.baseUrl }, personalModelIds: models, modelOrder: models } }
  document.config.providerConfigRules.providerRules = [...rules.filter((rule: any) => rule.providerId !== providerId), provider]
  if (available) {
    // Personal providers inherit template models; use native per-model switches to exclude unavailable ones.
    const modelRules = document.config.modelConfigRules ??= { providerModelRules: [], manualProviderModelRules: [] }
    for (const modelId of supported) {
      const existing = [...modelRules.manualProviderModelRules, ...modelRules.providerModelRules]
        .find((rule: any) => rule.providerId === providerId && rule.modelId === modelId)
      const enabled = models.includes(modelId)
      if (existing) existing.config = { ...existing.config, enabled }
      else modelRules.providerModelRules.push({ providerId, modelId, config: { enabled } })
    }
  }
  document.config.defaultModelSelection = { ...(stored.selection?.modelId === modelId ? stored.selection : {}), providerId, modelId }
  return document
}

function failureMessage(detail: unknown): string {
  const text = detail instanceof Error ? detail.message : JSON.stringify(detail) ?? ''
  if (/active_session|ZCode.*任务/i.test(text)) return '请先结束 ZCode 任务，再检测或更换配置；原配置已保留'
  if (/ZCode.*更新/i.test(text)) return 'ZCode 正在更新，请完成更新后再检测配置'
  if (/quota|balance|insufficient|余额|额度|套餐.*(?:不足|耗尽|过期)/i.test(text)) return '模型额度不足或套餐不可用，请检查所选服务'
  if (/401|403|unauthori|authentication|invalid.{0,12}(?:key|token)|鉴权|无效.*密钥/i.test(text)) return 'API Key 无效或没有模型访问权限，请核对所选服务与 Key'
  if (/model.{0,30}(?:not found|not exist|not support|unavailable)|模型.*(?:不存在|不支持|不可用)/i.test(text)) return '当前模型不可用，请检查模型与账号权限'
  if (/\b429\b|rate.limit|too many requests|限流|频率/i.test(text)) return '模型服务请求受限，请稍后重试'
  if (/fetch failed|ENOTFOUND|ECONN|TLS|certificate|timed?.out|timeout|网络|超时/i.test(text)) return '模型连接失败或检测超时，请检查网络后重试'
  return '模型列表获取失败，请检查所选服务后重试'
}

export async function probeZCodeModels(service: ZCodeModelService, key: string, request: typeof fetch = fetch, timeoutMs = 30_000): Promise<string[]> {
  const definition = serviceDefinition(service)
  // Coding Helper uses the OpenAI-compatible list endpoint even for Anthropic inference.
  const baseUrl = definition.baseUrl.replace(/\/anthropic$/, '/coding/paas/v4')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const diagnostic: ZCodeRequestDiagnostic = { reason: 'network' }
  try {
    const response = await request(`${baseUrl}/models`, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: controller.signal })
    diagnostic.httpStatus = response.status
    if (!response.ok) {
      diagnostic.reason = [401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'http'
      await response.body?.cancel()
      throw new ConfigurationError([401, 403, 429].includes(response.status) ? failureMessage(String(response.status))
        : `模型列表获取失败（HTTP ${response.status}），请稍后重试`)
    }
    if (!response.body) { diagnostic.reason = 'empty_list'; throw new ConfigurationError('模型服务未返回模型列表，请检查所选服务') }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        diagnostic.responseBytes = size
        if (size > 2 * 1024 * 1024) { diagnostic.reason = 'response_too_large'; throw new ConfigurationError('模型列表响应过大，请稍后重试') }
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    let body: any
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { diagnostic.reason = 'invalid_json'; throw new ConfigurationError('模型服务未返回有效的模型列表，请稍后重试') }
    if (body?.error || body?.success === false) { diagnostic.reason = 'business'; throw new ConfigurationError(failureMessage(body)) }
    if (!Array.isArray(body?.data) || !body.data.length) { diagnostic.reason = 'empty_list'; throw new ConfigurationError('模型列表为空或格式不兼容，请检查所选服务与账号权限') }
    if (!body.data.every((model: unknown) => {
      const id = typeof model === 'string' ? model : isRecord(model) ? model.id : undefined
      return typeof id === 'string' && !!id.trim() && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id)
    })) { diagnostic.reason = 'invalid_models'; throw new ConfigurationError('模型列表格式不兼容，请稍后重试') }
    return [...new Set<string>(body.data.map((model: string | { id: string }) => (typeof model === 'string' ? model : model.id).trim()))]
  } catch (error) {
    if (controller.signal.aborted) diagnostic.reason = 'timeout'
    throw new ConfigurationError(controller.signal.aborted ? '模型列表获取超时，请检查网络后重试'
      : error instanceof ConfigurationError ? error.message : failureMessage(error), diagnostic, { cause: error })
  } finally { clearTimeout(timer) }
}

export class ZCodeConfigurationService {
  private flight?: Promise<ZCodeConfigurationSnapshot>
  private verified?: { identity: string; checkedAt: number }
  constructor(private probe: (service: ZCodeModelService, key: string) => Promise<string[]> = probeZCodeModels, private report?: ZCodeSetupReporter) {}
  isBusy(): boolean { return !!this.flight }
  async snapshot(): Promise<ZCodeConfigurationSnapshot> {
    try {
      const stored = await storedConfiguration()
      const checkedAt = this.verified?.identity === stored.identity ? this.verified.checkedAt : undefined
      return { service: stored.service ?? 'bigmodel-coding', hasKey: !!stored.key,
        phase: this.isBusy() ? 'checking' : checkedAt ? 'ready' : stored.key ? 'saved' : 'unconfigured',
        ...(checkedAt ? { checkedAt, message: '模型列表获取成功' } : {}) }
    } catch (error) {
      const trace = new ZCodeSetupTrace('configuration', this.report)
      trace.stage('read_snapshot'); trace.fail('configuration', error)
      return { service: 'bigmodel-coding', hasKey: false, phase: 'failed', message: 'ZCode 配置无法读取，请检查本机运行时与 Provider 配置' }
    }
  }
  check(input: unknown, beforeCommit: () => Promise<void>): Promise<ZCodeConfigurationSnapshot> {
    const service = isRecord(input) && ZCODE_MODEL_SERVICES.find(service => service.id === input.service)?.id
    const trace = new ZCodeSetupTrace('configuration', this.report, service || undefined)
    if (this.flight) { trace.fail('busy'); return Promise.reject(new Error('ZCode 正在检测配置，请稍后重试')) }
    if (!isRecord(input) || !ZCODE_MODEL_SERVICES.some(service => service.id === input.service)
      || input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey))) {
      trace.fail('invalid_input'); return Promise.reject(new Error('ZCode 配置参数无效'))
    }
    const flight = this.perform(input as ZCodeConfigurationInput, beforeCommit, trace).finally(() => { if (this.flight === flight) this.flight = undefined })
    this.flight = flight
    return flight
  }
  private async perform(input: ZCodeConfigurationInput, beforeCommit: () => Promise<void>, trace: ZCodeSetupTrace): Promise<ZCodeConfigurationSnapshot> {
    let temporary: string | undefined
    try {
      trace.stage('read_configuration')
      const stored = await storedConfiguration()
      const key = input.apiKey?.trim() || (stored.service === input.service ? stored.key : '')
      if (!key) throw new ConfigurationError('请输入所选服务的 API Key')
      const reuseExisting = !input.apiKey?.trim() && stored.service === input.service && stored.hasRuntime
      trace.stage('prepare_provider')
      temporary = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'uzcfg-'))
      const providerPath = join(temporary, 'provider.json')
      writeZCodeJson(providerPath, reuseExisting ? stored.document : candidateProvider(stored, input.service, key))
      let runtime: ZCodeRuntime
      trace.stage('resolve_runtime')
      try { runtime = await resolveZCodeConfigurationRuntime(providerPath) }
      catch (error) { throw new ConfigurationError('ZCode 运行时不可用，请先准备兼容的官方运行时', { reason: 'runtime' }, { cause: error }) }
      const builtin = runtime.builtinProviderPath ? JSON.parse(await readFile(runtime.builtinProviderPath, 'utf8'))?.config : undefined
      trace.stage('model_list')
      const returnedModels = await this.probe(input.service, key)
      trace.stage('apply_models')
      const document = candidateProvider(stored, input.service, key, builtin, returnedModels)
      writeZCodeJson(providerPath, document)
      runtime = await resolveZCodeConfigurationRuntime(providerPath)
      trace.stage('check_configuration_identity')
      if ((await storedConfiguration()).identity !== stored.identity) throw new ConfigurationError('ZCode 配置已变化，请重新检测后保存')
      if (reuseExisting && JSON.stringify(document) === JSON.stringify(stored.document)) {
        const checkedAt = Date.now()
        this.verified = { identity: stored.identity, checkedAt }
        return { service: input.service, hasKey: true, phase: 'ready', message: '模型列表获取成功', checkedAt }
      }
      trace.stage('before_commit')
      await beforeCommit()
      trace.stage('save_configuration')
      if ((await storedConfiguration()).identity !== stored.identity) throw new ConfigurationError('ZCode 配置已变化，请重新检测后保存')
      const savedPath = join(resolveUserDataHome(), 'zcode', 'providers', `provider-${randomUUID()}.json`)
      writeZCodeJson(savedPath, document)
      const config = await validateZCodeRuntimeConfig({ ...runtime.config, personalProviderConfigPath: savedPath })
      writeZCodeJson(zcodeRuntimeConfigPath(), config)
      const checkedAt = Date.now()
      this.verified = { identity: (await storedConfiguration()).identity, checkedAt }
      return { service: input.service, hasKey: true, phase: 'ready', message: '模型列表获取成功', checkedAt }
    } catch (error) {
      const detail = error instanceof ConfigurationError ? error.diagnostic : undefined
      trace.fail(detail?.reason ?? 'configuration', error, detail)
      const snapshot = await this.snapshot()
      return { ...snapshot, phase: 'failed', message: error instanceof ConfigurationError ? error.message : failureMessage(error) }
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
