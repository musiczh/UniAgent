import type { HistoryForkPoint, SessionConfig } from './types'

export const FORK_IPC = {
  preflight: 'sessionFork:preflight', start: 'sessionFork:start', get: 'sessionFork:get',
  list: 'sessionFork:list', cancel: 'sessionFork:cancel', retry: 'sessionFork:retry', reveal: 'sessionFork:reveal'
} as const

export interface ForkRequest {
  sourceAgentId: string
  nativeId: string
  targetAgentId: string
  targetModel: string
  point?: HistoryForkPoint
}
export interface ForkPreflight {
  planId: string
  request: ForkRequest
  sourceRevision: string
  reusable: boolean
  contextWindow: number
  modelLabel: string
}
export type ForkStage = 'preparing' | 'compacting' | 'exporting' | 'validating' | 'creating' | 'completed'
export interface ForkJob {
  id: string
  seq: number
  request: ForkRequest
  sourceRevision: string
  sourceSessionId?: string
  stage: ForkStage
  status: 'running' | 'stopping' | 'failed' | 'cancelled' | 'completed'
  detail: string
  createdAt: number
  updatedAt: number
  reusedCompaction: boolean
  compacted?: boolean
  compactedRevision?: string
  contextSaved?: boolean
  contextHash?: string
  preparedHash?: string
  needsHandoff?: boolean
  stagingNativeId?: string
  snapshotVerified?: boolean
  targetNativeId: string
  targetSessionId?: string
  archivePath: string
  missing?: string[]
  allowMissing?: boolean
  error?: string
  capacity?: { window: number; contextTokens: number; overheadTokens: number; reserveTokens: number; method: string }
  sourceConfig: SessionConfig
  targetConfig: SessionConfig
  sourceCache?: { attachments: string[]; artifactsDirectory: string }
}

export interface ForkMessage {
  role: 'user' | 'assistant'
  content: Array<Record<string, any>>
}
export interface ForkContext {
  revision: string
  contextFingerprint: string
  reusable: boolean
  checkpoint?: string
  needsHandoff: boolean
  messages: ForkMessage[]
  cwd: string
  nativeFile: string
  missing: string[]
  records: number
}

/** Keep room for the next turn, output and estimation error; never report this as billed usage. */
export function forkCapacity(contextTokens: number, window: number, overhead: number, outputReserve: number): number {
  if (![contextTokens, window, overhead, outputReserve].every(Number.isFinite) || window <= 0 || Math.min(contextTokens, overhead, outputReserve) < 0) {
    throw new Error('容量暂无法确认，请刷新模型配置后重试')
  }
  const limit = Math.floor(window * 0.9) - overhead - outputReserve - Math.max(8192, Math.ceil(window * 0.05))
  if (contextTokens >= limit) throw new Error(`压缩后上下文估算 ${contextTokens.toLocaleString()} token 超过可用预算 ${Math.max(0, limit).toLocaleString()}（窗口 ${window.toLocaleString()}）。请选择更大窗口的模型或缩小分叉范围。`)
  return limit
}

export function claudeForkCapacity(report: any, providerWindow: number): NonNullable<ForkJob['capacity']> {
  const messages = report?.categories?.find((row: any) => row.id === 'messages')
  if (!messages || !Number.isFinite(messages.tokens) || messages.tokens <= 0 || !Number.isFinite(report.totalTokens) ||
      report.totalTokens < messages.tokens || !Number.isFinite(report.rawMaxTokens) || report.rawMaxTokens <= 0) throw new Error('目标 Claude 未返回可核验的上下文容量')
  const window = Math.min(providerWindow, report.rawMaxTokens,
    Number.isFinite(report.maxTokens) && report.maxTokens > 0 ? report.maxTokens : report.rawMaxTokens)
  const overheadTokens = report.totalTokens - messages.tokens
  const buffer = report.categories.filter((row: any) => row.kind === 'buffer').reduce((sum: number, row: any) => sum + row.tokens, 0)
  const reserveTokens = Math.max(32768, buffer)
  forkCapacity(messages.tokens, window, overheadTokens, reserveTokens)
  return { window, contextTokens: messages.tokens, overheadTokens, reserveTokens, method: 'Claude 原生 /context 估算，包含图片与当前工具；额外预留 10% 窗口' }
}

export function qoderForkCapacity(report: any, providerWindow: number): NonNullable<ForkJob['capacity']> {
  const percentage = report?.contextWindow?.usedPercentage
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || !Number.isFinite(providerWindow) || providerWindow <= 0) throw new Error('Qoder 未返回可核验的上下文占比或窗口')
  const contextTokens = Math.ceil(providerWindow * percentage / 100)
  const reserveTokens = Math.max(8192, Math.ceil(providerWindow * 0.1))
  forkCapacity(contextTokens, providerWindow, 0, reserveTokens)
  return { window: providerWindow, contextTokens, overheadTokens: 0, reserveTokens, method: '按 Qoder 原生占比和模型窗口保守估算，预留输出与余量；非精确 Token' }
}

export function appServerForkCapacity(contextTokens: number, window: number, toolTokens = 0, outputTokens = 32768): NonNullable<ForkJob['capacity']> {
  const overheadTokens = Math.max(32768, Math.ceil(window * 0.25), toolTokens)
  const reserveTokens = Math.max(32768, outputTokens)
  forkCapacity(contextTokens, window, overheadTokens, reserveTokens)
  return { window, contextTokens, overheadTokens, reserveTokens,
    method: '保守估算：文本按 UTF-8 字节 / 2，图片单独计入；系统与工具至少预留 25% 窗口，另留 10% 余量，非精确用量' }
}
