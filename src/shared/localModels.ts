export type LocalModelDownloadState = 'not_downloaded' | 'verified' | 'invalid'
export type LocalModelDeploymentState = 'inactive' | 'running' | 'unhealthy'
export type LocalModelOperation = 'download' | 'deploy' | 'stop' | 'remove'

export interface LocalCodexCatalogEntry extends Record<string, unknown> {
  slug: string
  display_name: string
  context_window: number
  auto_compact_token_limit: number
  default_reasoning_level: string
  supported_reasoning_levels: Array<{ effort: string; description: string }>
}

export interface LocalModelCatalogModel {
  id: string
  displayName: string
  parameterCount: string
  quantization: string
  sizeBytes: number
  runtimeSizeBytes: number
  memoryBytes: number
  freeDiskBytes: number
  nodeMajor: number
  contextWindow: number
  autoCompactTokenLimit: number
  defaultReasoning: string
  reasoning: { low: string; medium: string; high: string }
  catalogEntry: LocalCodexCatalogEntry
}

export interface LocalModelCatalogResponse {
  protocolVersion: 2
  defaultModelId: string
  models: LocalModelCatalogModel[]
}

export interface LocalModelConnection {
  providerId: string
  baseUrl: string
  wireApi: 'responses'
  modelId: string
}

export interface LocalModelStatusModel {
  id: string
  downloadState: LocalModelDownloadState
  deploymentState: LocalModelDeploymentState
  healthy: boolean
}

export interface LocalModelProgress {
  type?: 'progress'
  operation: LocalModelOperation
  modelId?: string | null
  stage?: string
  completedBytes?: number
  totalBytes?: number
  percent?: number
  pid?: number
  startedAt?: string
}

export interface LocalModelStatusResponse {
  protocolVersion: 2
  migrationRequired?: boolean
  packageVersion: string
  supported: boolean
  activeModelId: string | null
  connection: LocalModelConnection | null
  models: LocalModelStatusModel[]
  operation?: LocalModelProgress
  ok?: boolean
}

export interface LocalModelView extends LocalModelCatalogModel, LocalModelStatusModel {}

export interface LocalModelsSnapshot {
  availability: 'ready' | 'stale' | 'unavailable'
  protocolVersion?: 2
  packageVersion?: string
  supported?: boolean
  defaultModelId?: string
  activeModelId: string | null
  connection?: LocalModelConnection | null
  models: LocalModelView[]
  operation?: LocalModelProgress
  message?: string
}

export interface LocalModelError {
  type: 'error'
  ok: false
  code: string
  stage: string
  message: string
  recoverable: boolean
  details?: unknown
}

export interface LocalModelProgressEvent extends LocalModelProgress {
  type: 'progress'
}

export interface LocalModelResult {
  type: 'result'
  ok: true
  operation: LocalModelOperation
  modelId?: string
  activeModelId?: string | null
  connection?: LocalModelConnection | null
  downloadState?: LocalModelDownloadState
  removed?: boolean
  requiresCodexRestart?: boolean
  catalogEntry?: LocalCodexCatalogEntry
}

export type LocalModelCliEvent = LocalModelProgressEvent | LocalModelResult | LocalModelError

export const LOCAL_MODEL_IPC = {
  get: 'localModels:get',
  download: 'localModels:download',
  deploy: 'localModels:deploy',
  stop: 'localModels:stop',
  remove: 'localModels:remove',
  changed: 'localModels:changed'
} as const
