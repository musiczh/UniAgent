import type { ModelDef, UAEvent } from './types'
import type { CodexSourceQuota } from './codexSources'

export const ZCODE_PERMISSION_VALUES = { ask: 'build', 'auto-edit': 'edit', guarded: 'guarded', 'full-access': 'yolo' } as const
export type ZCodePermissionValue = typeof ZCODE_PERMISSION_VALUES[keyof typeof ZCODE_PERMISSION_VALUES]

export interface ZCodeQuotaSnapshot extends CodexSourceQuota {
  providerId?: string
}

export interface ZCodeEventCursor {
  generation: number
  upToEventSeq: number
}

export interface ZCodeEventsSnapshot extends ZCodeEventCursor {
  sessionId: string
  events: UAEvent[]
}

export interface ZCodeModelSelection {
  providerId: string
  modelId: string
  options?: { reasoningLevel?: string }
}

export const ZCODE_MODEL_SERVICES = [
  { id: 'bigmodel-coding', label: '智谱 · GLM Coding Plan', description: '使用智谱 GLM Coding Plan 编程套餐', templateId: 'bigmodel-api', accessType: 'zhipu-coding-plan-api-key', apiType: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
  { id: 'zai-coding', label: 'Z.ai · Coding Plan', description: '使用 Z.ai Coding Plan 编程套餐', templateId: 'zai-api', accessType: 'zhipu-coding-plan-api-key', apiType: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
  { id: 'bigmodel-api', label: '智谱 · 按量 API', description: '使用智谱开放平台资源包或充值余额', templateId: 'bigmodel-standard-api', accessType: 'api-key', apiType: 'openai-chat-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'zai-api', label: 'Z.ai · 按量 API', description: '使用 Z.ai 平台按量 API', templateId: 'zai-standard-api', accessType: 'api-key', apiType: 'openai-chat-completions', baseUrl: 'https://api.z.ai/api/paas/v4' }
] as const
export type ZCodeModelService = typeof ZCODE_MODEL_SERVICES[number]['id']
export interface ZCodeConfigurationInput { service: ZCodeModelService; apiKey?: string }
export interface ZCodeConfigurationSnapshot {
  service: ZCodeModelService
  hasKey: boolean
  phase: 'unconfigured' | 'saved' | 'checking' | 'ready' | 'failed'
  message?: string
  checkedAt?: number
}

export interface ZCodeAttachmentRef {
  ref: string
  fileName: string
  mime: string
  bytes: number
}

export const ZCODE_IPC = {
  installation: 'zcode:installation',
  install: 'zcode:install',
  cancelInstall: 'zcode:cancelInstall',
  runtimeSnapshot: 'zcode:runtimeSnapshot',
  quota: 'zcode:quota',
  configuration: 'zcode:configuration',
  checkConfiguration: 'zcode:checkConfiguration',
  saveRuntime: 'zcode:saveRuntime',
  pickRuntimeFile: 'zcode:pickRuntimeFile',
  selectRuntime: 'zcode:selectRuntime',
  loadEarlier: 'zcode:loadEarlier',
  eventsReset: 'zcode:eventsReset'
} as const

export interface ZCodeRuntimeConfig {
  schemaVersion: 1
  source: 'cli' | 'official-app' | 'source-build'
  executable: string
  bundlePath?: string
  resourceRoot?: string
  sourceAppPath?: string
  personalProviderConfigPath?: string
  dataRootId: string
}

export interface ZCodeRuntimeSnapshot {
  config?: ZCodeRuntimeConfig
  phase: 'unconfigured' | 'checking' | 'ready' | 'needs-auth' | 'failed'
  version?: string
  nodeVersion?: string
  fingerprint?: string
  message?: string
  currentModel?: ZCodeModelSelection
  models?: ModelDef[]
}

export interface ZCodeInstallationSnapshot {
  phase: 'idle' | 'preparing' | 'downloading' | 'building' | 'verifying' | 'activating' | 'completed' | 'cancelled' | 'failed'
  installed: boolean
  cancellable: boolean
  message?: string
  version?: string
}

export interface ZCodeDeliveryRecord {
  queueItemId: string
  commandId: string
  nativeSessionId?: string
  phase: 'prepared' | 'sent' | 'acknowledged' | 'observed' | 'uncertain' | 'failed'
  replacesCommandId?: string
  payloadHash: string
  issuedAt: number
  configVersion?: number
  submission: {
    text: string
    modelSelection: ZCodeModelSelection
    mode: ZCodePermissionValue
    planEnabled: boolean
    attachments?: ZCodeAttachmentRef[]
  }
  ackStatus?: 'accepted' | 'rejected' | 'stale' | 'duplicate' | 'noop' | 'failed'
  turnId?: string
  retryRequested?: true
}

export interface ZCodeSessionState {
  schemaVersion: 1
  dataRootId: string
  workspaceKey: string
  runtimeFingerprint: string
  createCommandId?: string
  deliveries: ZCodeDeliveryRecord[]
  suspendedAfterStop?: boolean
  pendingConfig?: {
    version: number
    modelSelection?: ZCodeModelSelection
    mode?: ZCodePermissionValue
    planEnabled?: boolean
  }
}
