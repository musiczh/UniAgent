import { routerInputId, type RouterRequest, type RouterObject } from './router'
import type { UAEvent } from './types'

export type RouterReviewFilter = 'all' | 'unrated' | 'bad' | 'good'
export interface RouterExpectedResult {
  kind: 'create_task' | 'reuse_task' | 'create_requirement'
  scope?: 'space' | 'requirement'
  projectId?: string
  requirementId?: string
  taskId?: string
  projectName?: string
  requirementName?: string
  taskTitle?: string
}
export interface RouterFeedbackInput {
  requestId: string
  attemptId?: string
  expectedRevision: number
  matches: boolean
  reason?: string
  expected?: RouterExpectedResult
}
export interface RouterFeedback extends RouterFeedbackInput {
  revision: number
  savedAt: number
  actual: RouterRequest
}
export interface RouterTrace {
  id: string
  requestId: string
  sessionId: string
  startedAt: number
  endedAt?: number
  request: RouterRequest
  systemPrompt: string
  systemPromptHash?: string
  appVersion: string
  history: UAEvent[]
  steps: Array<{ at: number; kind: string; data: unknown }>
  events: UAEvent[]
  reasoning: 'provided' | 'not-provided'
  assembledContext: 'not-provided'
  result?: RouterRequest
  error?: string
}
export interface RouterTraceSummary { id: string; startedAt: number; endedAt?: number; result?: RouterRequest }
export interface RouterReviewDocument {
  schemaVersion: 1
  requestId: string
  revision: number
  attempts: RouterTraceSummary[]
  feedbacks: RouterFeedback[]
  dismissed: string[]
  deletedAt?: number
}
export interface RouterReviewRow {
  request: RouterRequest
  revision: number
  attemptId?: string
  feedback?: RouterFeedback
  traceAvailable: boolean
  deletable?: boolean
}
export interface RouterReviewDetail extends RouterReviewRow { attempts: RouterTraceSummary[]; trace?: RouterTrace; feedbackHistory: RouterFeedback[]; diagnostics?: { reasoning: RouterTrace['reasoning']; sections: Array<{ title: string; text: string }> } }
export interface RouterReviewQuery { filter?: RouterReviewFilter; search?: string; offset?: number; limit?: number }
export interface RouterReviewPage { rows: RouterReviewRow[]; total: number; counts: Record<RouterReviewFilter, number>; deletableCount: number }
export interface RouterReviewDeletionItem { requestId: string; requestVersion: number; reviewRevision: number }
export interface RouterReviewDeletionPlan { items: RouterReviewDeletionItem[]; protectedCount: number }
export interface RouterReviewDeleteResult { deletedIds: string[]; skippedIds: string[]; failures: Array<{ requestId: string; error: string; removed?: boolean }> }
export interface RouterReviewPrompt { requestId: string; attemptId: string; prompt: string; targetTitle?: string; endedAt: number }
export const ROUTER_FEEDBACK_PROMPT_DURATION_MS = 5000
export type RouterReviewTarget = Pick<RouterObject, 'id' | 'kind' | 'title' | 'projectId' | 'requirementId' | 'archived'>
export const ROUTER_REVIEW_IPC = { list: 'router:review:list', detail: 'router:review:detail', save: 'router:review:save', targets: 'router:review:targets', dismiss: 'router:review:dismiss', copy: 'router:review:copy', deletion: 'router:review:deletion', delete: 'router:review:delete' } as const
export const routerActionLabels = { reuse_task: '复用已有任务', create_task_in_requirement: '在已有需求中新建任务', create_task_in_space: '空间直属新建任务', create_requirement_and_task: '新建需求与任务', clarify: '等待补充信息' }
export const routerDeliveryLabels = { pending: '尚未投递', queued: '输入已加入原任务等待队列', accepted: '输入已接受', dispatching: '正在核对投递', running: '输入已开始执行', unknown: '投递结果待确认，未自动重发', finished: '本轮已结束', failed: '本轮执行失败' }

export function routerReviewDeletable(request: RouterRequest): boolean { return !['queued', 'routing', 'committing'].includes(request.state) }

export function parseRouterReviewDeletion(raw: unknown): RouterReviewDeletionItem[] {
  if (!Array.isArray(raw)) throw new Error('删除路由记录格式无效')
  const ids = new Set<string>()
  return raw.map(item => {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.requestVersion) || item.requestVersion < 1 || !Number.isSafeInteger(item.reviewRevision) || item.reviewRevision < 0 || ids.has(item.requestId)) throw new Error('删除路由记录格式无效')
    routerInputId(item.requestId); ids.add(item.requestId)
    return { requestId: item.requestId, requestVersion: item.requestVersion, reviewRevision: item.reviewRevision }
  })
}

export function parseRouterFeedback(raw: unknown): RouterFeedbackInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_router_feedback')
  const value = raw as RouterFeedbackInput
  routerInputId(value.requestId)
  if (typeof value.matches !== 'boolean' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new Error('请选择是否符合预期')
  if (value.attemptId !== undefined) routerInputId(value.attemptId)
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 4000)) throw new Error('反馈原因格式无效')
  const expected = value.matches ? undefined : value.expected
  if (expected) {
    if (typeof expected !== 'object' || Array.isArray(expected)) throw new Error('预期结果格式无效')
    if (!['create_task', 'reuse_task', 'create_requirement'].includes(expected.kind)) throw new Error('预期结果类型无效')
    if (expected.scope !== undefined && !['space', 'requirement'].includes(expected.scope)) throw new Error('预期归属类型无效')
    for (const key of ['projectId', 'requirementId', 'taskId'] as const) if (expected[key] !== undefined && (typeof expected[key] !== 'string' || !expected[key]!.trim() || expected[key]!.length > 200)) throw new Error('预期目标格式无效')
    if (expected.kind === 'create_requirement' && (expected.scope || expected.projectId || expected.requirementId || expected.taskId) || expected.kind === 'create_task' && expected.taskId) throw new Error('预期目标与类型不符')
    if (expected.kind === 'create_task' && expected.projectId && expected.requirementId) throw new Error('创建任务时空间与需求互斥')
    if (expected.scope === 'space' && expected.requirementId || expected.kind === 'create_task' && expected.scope === 'requirement' && expected.projectId) throw new Error('预期目标与归属类型不符')
  }
  return { requestId: value.requestId, attemptId: value.attemptId, expectedRevision: value.expectedRevision, matches: value.matches,
    reason: value.reason?.trim() || undefined, ...(expected ? { expected: { kind: expected.kind, scope: expected.scope, projectId: expected.projectId, requirementId: expected.requirementId, taskId: expected.taskId } } : {}) }
}

export function sanitizeRouterReview<T>(value: T): T {
  const clean = (input: unknown): unknown => {
    if (typeof input === 'string') return input.replace(/\bsk-[\w-]{10,}/g, '[已脱敏]').replace(/((?:api[_-]?key|password|token|secret)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1[已脱敏]').replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [已脱敏]')
    if (Array.isArray(input)) return input.map(clean)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([key]) => !/^(?:env|headers|authorization|api[_-]?key|password|secret|.*token|nativeContext|native_context|dataUrl|data_url|base64)$/i.test(key)).map(([key, item]) => [key, clean(item)]))
    return input
  }
  return clean(value) as T
}

export function routerOptimizationPrompt(directory: string, count: number): string {
  return `请优化 UniAgent RouterAgent 的路由效果。\n\n背景：Router 使用固定 Session，查询空间、需求、任务与有效记忆，决定新建或复用任务。业务执行沿用原 Task、原生 Session 和输入队列。\n\n本地数据目录：${directory}\n共 ${count} 条记录。先读取 README.md、index.json，再按索引读取 records/ 的用户反馈和 traces/ 的诊断 JSON。\n\n是否符合预期是用户判断；原因、预期类型和目标可能没有填写，不要把缺失值当成正确答案。优先分析不符合预期的样本，同时用符合预期的样本回归。对照当时的 router_query 上下文、Agent 实际返回的分析、工具参数及宿主校验，区分检索、判断、配置和投递问题。未提供的日志明确说明。\n\n读取仓库 AGENTS.md、CLAUDE.md（存在时）及 src/main/router/controller.ts、src/main/router/database.ts、src/shared/router.ts，复用 test/router-*.ts 和已有隔离路由评测，将反馈转为可执行 case，先回放定位再修正并回归。回放分配仅记录结果，避免重复投递真实任务。报告原因、改动、样本前后结果及仍待验证项。`
}
