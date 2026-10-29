import { join } from 'node:path'
import type { LocalModelConnection, LocalModelsSnapshot } from '../shared/localModels'
import type { CodexModelSourceRef, ModelDef, SessionConfig } from '../shared/types'
import { projectModelCache } from './agents'
import type { CodexSourceService } from './codexSourceService'
import { mergeCodexSourceModels } from './codexSourceService'
import { atomicWrite } from './projectStore'
import { resolveUserDataHome } from './userData'
import { codexModelKey, codexWireModel, parseCodexModelKey } from '../shared/codexModelIdentity'

function sameSource(left?: CodexModelSourceRef, right?: CodexModelSourceRef): boolean {
  return left?.kind === right?.kind && left?.sourceId === right?.sourceId
}

export function codexLocalRuntimeArgs(connection: LocalModelConnection, catalogFile: string): string[] {
  const provider = 'uniagent-local'
  return [
    '-c', `model=${JSON.stringify(connection.modelId)}`,
    '-c', `review_model=${JSON.stringify(connection.modelId)}`,
    '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}.name=${JSON.stringify('UniAgent 本地 LLM')}`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(connection.baseUrl)}`,
    '-c', `model_providers.${provider}.wire_api=${JSON.stringify(connection.wireApi)}`,
    '-c', `model_providers.${provider}.requires_openai_auth=false`,
    '-c', `model_providers.${provider}.supports_websockets=false`,
    '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`,
    '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false',
    '-c', 'features.enable_request_compression=false'
  ]
}

export class CodexModelSources {
  private nativeIds = new Set<string>()
  private local: LocalModelsSnapshot = { availability: 'unavailable', activeModelId: null, models: [] }
  private readonly localCatalogFile = join(resolveUserDataHome(), 'local-models', 'models.json')
  private localCatalog = ''

  constructor(private readonly thirdParty: CodexSourceService) {}

  updateLocal(snapshot: LocalModelsSnapshot): void {
    this.local = structuredClone(snapshot)
    if (snapshot.availability !== 'ready') return
    const catalog = JSON.stringify({ models: snapshot.models.filter(model => model.id === snapshot.activeModelId).map(model => model.catalogEntry) })
    if (catalog === this.localCatalog) return
    this.local.connection = null
    atomicWrite(this.localCatalogFile, catalog)
    this.localCatalog = catalog
    this.local.connection = snapshot.connection
  }

  mergeModels(nativeModels: ModelDef[]): ModelDef[] {
    this.nativeIds = new Set(nativeModels.map(model => model.id))
    const native = nativeModels.map(model => ({ ...model, modelSource: { kind: 'native' as const } }))
    const thirdParty = this.thirdParty.supplementalModels()
    const local = this.local.availability === 'ready' && this.local.connection && this.local.activeModelId
      ? this.local.models
          .filter(model => model.id === this.local.activeModelId && model.healthy)
          .flatMap(model => projectModelCache([model.catalogEntry]).map(value => ({
            ...value,
            id: codexModelKey(value.id, { kind: 'local', sourceId: 'bonsai' }),
            modelSource: { kind: 'local' as const, sourceId: 'bonsai' }
          })))
      : []
    return mergeCodexSourceModels(native, [...thirdParty, ...local])
  }

  normalize(config: SessionConfig): SessionConfig {
    if (config.agentId !== 'codex' || !config.model) return config
    const encoded = parseCodexModelKey(config.model)
    if (encoded) {
      if (config.modelSource && !sameSource(config.modelSource, encoded.source)) throw new Error('模型与来源不匹配，请重新选择模型')
      return { ...config, modelSource: encoded.source }
    }
    if (config.modelSource) {
      return { ...config, model: codexModelKey(config.model, config.modelSource) }
    }
    const sources = this.sourcesFor(config.model)
    if (sources.length !== 1) return config
    return { ...config, model: codexModelKey(config.model, sources[0]), modelSource: sources[0] }
  }

  runtimeArgs(config: SessionConfig): string[] {
    if (config.agentId !== 'codex' || !config.model) return []
    this.assertReady(config)
    const normalized = this.normalize(config)
    const source = normalized.modelSource
    const model = codexWireModel(normalized)
    if (!source || source.kind === 'native') return []
    if (source.kind === 'third-party') return this.thirdParty.runtimeArgs(model, source)
    const connection = this.local.connection
    return codexLocalRuntimeArgs(connection!, this.localCatalogFile)
  }

  assertReady(config: SessionConfig): void {
    if (config.agentId !== 'codex' || !config.model) return
    const normalized = this.normalize(config)
    if (!normalized.modelSource && this.sourcesFor(config.model).length > 1) {
      throw new Error('旧会话模型存在同名来源，请重新选择对应的模型来源')
    }
    const source = normalized.modelSource
    const modelId = codexWireModel(normalized)
    if (!source || source.kind === 'native') return
    if (config.permissionMode === 'approve-for-me') throw new Error('补充模型暂不支持自动审批模型，请选择请求批准或无需批准')
    if (source.kind === 'third-party') {
      this.thirdParty.assertModelReady(modelId, source)
      return
    }
    const model = this.local.models.find(item => item.id === modelId)
    const connection = this.local.connection
    if (this.local.availability !== 'ready' || !model || !model.healthy || model.deploymentState !== 'running' ||
        !connection || connection.modelId !== modelId || source.sourceId !== 'bonsai') {
      throw new Error('本地模型未运行，请在设置 → 本地 LLM 中部署或重新启动该模型')
    }
  }

  private sourcesFor(model: string): CodexModelSourceRef[] {
    const sources: CodexModelSourceRef[] = this.nativeIds.has(model) ? [{ kind: 'native' }] : []
    if (this.local.models.some(item => item.id === model)) {
      sources.push({ kind: 'local', sourceId: 'bonsai' })
    }
    sources.push(...this.thirdParty.sourceRefsFor(model))
    return sources
  }
}
