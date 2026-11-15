import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFile } from '../sessionStore'
import { routerInputId, type RouterRequest } from '../../shared/router'
import { parseRouterFeedback, parseRouterReviewDeletion, routerReviewDeletable, sanitizeRouterReview, routerOptimizationPrompt, type RouterFeedbackInput, type RouterReviewDocument, type RouterReviewDetail, type RouterReviewPage, type RouterReviewQuery, type RouterReviewPrompt, type RouterTrace, type RouterReviewDeletionItem, type RouterReviewDeletionPlan, type RouterReviewDeleteResult } from '../../shared/routerReview'

export class RouterReviewStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {}
  private serial<T>(run: () => Promise<T>): Promise<T> { const operation = this.tail.catch(() => {}).then(run); this.tail = operation; return operation }
  private path(id: string, file: string): string { routerInputId(id); return join(this.directory, 'reviews', id, file) }
  private async write(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await atomicWriteFile(path, JSON.stringify(sanitizeRouterReview(value), null, 2)) }
  private async document(id: string): Promise<RouterReviewDocument> {
    try { const document = JSON.parse(await readFile(this.path(id, 'review.json'), 'utf8')); if (document.schemaVersion !== 1) throw new Error('路由反馈格式不可读取'); return document }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { schemaVersion: 1, requestId: id, revision: 0, attempts: [], feedbacks: [], dismissed: [] } }
  }
  private async trace(id: string, attemptId: string): Promise<RouterTrace> { routerInputId(attemptId); return JSON.parse(await readFile(this.path(id, `attempt-${attemptId}.json`), 'utf8')) }
  async begin(request: RouterRequest, sessionId: string, systemPrompt: string, history: RouterTrace['history'], appVersion: string): Promise<string | undefined> {
    return this.serial(async () => {
      const id = randomUUID(), startedAt = Date.now(), document = await this.document(request.requestId)
      if (document.deletedAt !== undefined) return undefined
      const trace: RouterTrace = { id, requestId: request.requestId, sessionId, startedAt, request, systemPrompt, systemPromptHash: createHash('sha256').update(systemPrompt).digest('hex'), appVersion, history, steps: [], events: [], reasoning: 'not-provided', assembledContext: 'not-provided' }
      await this.write(this.path(request.requestId, `attempt-${id}.json`), trace)
      document.attempts.push({ id, startedAt }); await this.write(this.path(request.requestId, 'review.json'), document)
      return id
    })
  }
  async step(requestId: string, kind: string, data: unknown): Promise<void> {
    return this.serial(async () => { const document = await this.document(requestId), attempt = document.attempts.at(-1); if (document.deletedAt !== undefined || !attempt) return
      const trace = await this.trace(requestId, attempt.id); trace.steps.push({ at: Date.now(), kind, data }); await this.write(this.path(requestId, `attempt-${attempt.id}.json`), trace) })
  }
  async finish(request: RouterRequest, events: RouterTrace['events'], error?: string, dismiss = false): Promise<void> {
    return this.serial(async () => {
      const document = await this.document(request.requestId), attempt = document.attempts.at(-1); if (document.deletedAt !== undefined || !attempt || attempt.endedAt) return
      const trace = await this.trace(request.requestId, attempt.id); trace.endedAt = Date.now(); trace.result = request; trace.events = events; trace.error = error
      trace.reasoning = events.some(event => event.type === 'reasoning' && event.payload.text) ? 'provided' : 'not-provided'
      await this.write(this.path(request.requestId, `attempt-${attempt.id}.json`), trace)
      attempt.endedAt = trace.endedAt; attempt.result = sanitizeRouterReview(request)
      if (dismiss && !document.dismissed.includes(attempt.id)) document.dismissed.push(attempt.id)
      await this.write(this.path(request.requestId, 'review.json'), document)
    })
  }
  async detail(request: RouterRequest, attemptId?: string, includeTrace = false): Promise<RouterReviewDetail> {
    await this.tail.catch(() => {})
    const document = await this.document(request.requestId), attempt = attemptId ? document.attempts.find(row => row.id === attemptId) : document.attempts.findLast(row => row.endedAt)
    if (document.deletedAt !== undefined) throw new Error('该路由记录已删除')
    if (attemptId && !attempt) throw new Error('路由回合不存在，请重新读取')
    const feedback = document.feedbacks.findLast(row => row.attemptId === attempt?.id)
    const actual = attempt && attempt.id !== document.attempts.at(-1)?.id ? attempt.result || request : request
    const trace = attempt && includeTrace ? await this.trace(request.requestId, attempt.id) : undefined
    const legacy = !attempt && includeTrace ? await this.legacyEvents(request.requestId) : undefined
    return { request: sanitizeRouterReview(actual), revision: document.revision, attempts: document.attempts, attemptId: attempt?.id, feedback,
      feedbackHistory: document.feedbacks, traceAvailable: !!attempt, ...(trace ? { trace, diagnostics: { reasoning: trace.reasoning, sections: [
        { title: '输入与 Router 规则', data: { request: trace.request, systemPrompt: trace.systemPrompt, systemPromptHash: trace.systemPromptHash, appVersion: trace.appVersion } },
        { title: '此前 Router 会话上下文', data: trace.history }, { title: '查询、分配与宿主校验', data: trace.steps },
        { title: 'Agent 返回的分析与过程', data: trace.events }, { title: '实际结果与异常', data: { result: trace.result, error: trace.error } },
        { title: '用户反馈版本', data: document.feedbacks }
      ].map(({ title, data }) => ({ title, text: JSON.stringify(data, null, 2) })) } } : legacy ? { diagnostics: { reasoning: legacy.events.some(event => event.type === 'reasoning' && event.payload.text) ? 'provided' : 'not-provided', sections: [{ title: '已有 Router 会话事件（历史记录）', text: JSON.stringify(legacy, null, 2) }] } } : {}) }
  }
  private async legacyEvents(id: string): Promise<{ events: RouterTrace['events'] } | undefined> {
    try { return JSON.parse(await readFile(this.path(id, 'legacy-events.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
  }
  async linkLegacy(id: string, sessionId: string, events: RouterTrace['events']): Promise<void> {
    return this.serial(async () => {
      const document = await this.document(id)
      if (document.deletedAt !== undefined) return
      if (document.attempts.length || await this.legacyEvents(id)) return
      const selected = new Set<number>()
      for (let index = 0; index < events.length; index++) {
        const event = events[index]
        let args = event.payload.input || event.payload.args || event.payload.arguments || event.payload.params
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
        const matched = event.type === 'tool_call' && /(?:^|[/_.])router_(?:query|assign_task)$/.test(event.payload.tool || event.payload.name || '') && args?.requestId === id || event.type === 'user_message' && String(event.payload.text || '').includes('requestId=' + id)
        if (!matched) continue
        let start = index, end = index
        while (start > 0 && events[start].type !== 'user_message' && events[start - 1].type !== 'turn_completed') start--
        while (end + 1 < events.length && events[end].type !== 'turn_completed' && events[end + 1].type !== 'user_message') end++
        for (let cursor = start; cursor <= end; cursor++) selected.add(cursor)
      }
      if (selected.size) await this.write(this.path(id, 'legacy-events.json'), { schemaVersion: 1, requestId: id, sessionId, logAvailability: 'legacy-events-only', contextSnapshot: 'not-captured', systemPrompt: 'not-captured', events: events.filter((_, index) => selected.has(index)) })
    })
  }
  async save(request: RouterRequest, raw: RouterFeedbackInput): Promise<RouterReviewDetail> {
    const input = parseRouterFeedback(raw)
    await this.serial(async () => {
      const document = await this.document(request.requestId)
      if (document.deletedAt !== undefined) throw new Error('该路由记录已删除')
      if (document.revision !== input.expectedRevision) throw new Error('反馈已变化，请重新读取后保存')
      const attempt = input.attemptId ? document.attempts.find(row => row.id === input.attemptId) : undefined
      if (input.attemptId && !attempt?.endedAt || !input.attemptId && document.attempts.length) throw new Error('请选择已结束的路由回合')
      const actual = attempt && attempt.id !== document.attempts.at(-1)?.id ? attempt.result || request : request
      if (['queued', 'routing', 'committing'].includes(actual.state)) throw new Error('请等待本次路由结束后反馈')
      document.revision++; document.feedbacks.push({ ...input, expected: input.expected ? { ...input.expected, projectName: raw.expected?.projectName, requirementName: raw.expected?.requirementName, taskTitle: raw.expected?.taskTitle } : undefined,
        revision: document.revision, savedAt: Date.now(), actual: sanitizeRouterReview(actual) })
      if (attempt && !document.dismissed.includes(attempt.id)) document.dismissed.push(attempt.id)
      await this.write(this.path(request.requestId, 'review.json'), document)
    })
    return this.detail(request, input.attemptId)
  }
  async list(requests: RouterRequest[], query: RouterReviewQuery = {}): Promise<RouterReviewPage> {
    if (!['all', 'unrated', 'bad', 'good'].includes(query.filter || 'all') || query.search !== undefined && typeof query.search !== 'string' || query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0) || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw new Error('路由记录查询格式无效')
    const rows: RouterReviewPage['rows'] = [], counts = { all: 0, unrated: 0, bad: 0, good: 0 }; let deletableCount = 0
    for (const request of requests) {
      const document = await this.document(request.requestId), attempt = document.attempts.findLast(row => row.endedAt), feedback = document.feedbacks.findLast(row => row.attemptId === attempt?.id)
      if (document.deletedAt !== undefined) continue
      const deletable = this.deletable(request, document); if (deletable) deletableCount++
      counts.all++; const verdict = feedback ? feedback.matches ? 'good' : 'bad' : 'unrated'; counts[verdict]++
      if (query.filter && query.filter !== 'all' && query.filter !== verdict) continue
      if (query.search && ![request.prompt, request.targetTitle, request.decision?.reason, request.projectName, request.requirementName].join(' ').toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) continue
      const actual = attempt && attempt.id !== document.attempts.at(-1)?.id ? attempt.result || request : request
      rows.push({ request: sanitizeRouterReview(actual), revision: document.revision, attemptId: attempt?.id, feedback, traceAvailable: !!attempt, deletable })
    }
    return { rows: rows.slice(query.offset || 0, (query.offset || 0) + (query.limit || 50)), total: rows.length, counts, deletableCount }
  }
  private deletable(request: RouterRequest, document: RouterReviewDocument): boolean { const last = document.attempts.at(-1); return routerReviewDeletable(request) && (!last || last.endedAt !== undefined) }
  async deletion(requests: RouterRequest[]): Promise<RouterReviewDeletionPlan> {
    await this.tail.catch(() => {})
    const plan: RouterReviewDeletionPlan = { items: [], protectedCount: 0 }
    for (const request of requests) {
      const document = await this.document(request.requestId); if (document.deletedAt !== undefined) continue
      if (this.deletable(request, document)) plan.items.push({ requestId: request.requestId, requestVersion: request.version, reviewRevision: document.revision })
      else plan.protectedCount++
    }
    return plan
  }
  private async cleanDeleted(id: string): Promise<void> {
    const directory = dirname(this.path(id, 'review.json'))
    for (const name of await readdir(directory)) if (name !== 'review.json') await rm(join(directory, name), { recursive: true, force: true })
  }
  async delete(requests: RouterRequest[], raw: RouterReviewDeletionItem[]): Promise<RouterReviewDeleteResult> {
    const items = parseRouterReviewDeletion(raw), byId = new Map(requests.map(row => [row.requestId, row]))
    return this.serial(async () => {
      const result: RouterReviewDeleteResult = { deletedIds: [], skippedIds: [], failures: [] }
      for (const item of items) {
        let removed = false
        try {
          const request = byId.get(item.requestId)
          if (!request) { result.skippedIds.push(item.requestId); continue }
          const document = await this.document(item.requestId)
          if (document.deletedAt === undefined) {
            if (!this.deletable(request, document) || request.version !== item.requestVersion || document.revision !== item.reviewRevision) { result.skippedIds.push(item.requestId); continue }
            await this.write(this.path(item.requestId, 'review.json'), { schemaVersion: 1, requestId: item.requestId, revision: document.revision + 1, attempts: [], feedbacks: [], dismissed: [], deletedAt: Date.now() } satisfies RouterReviewDocument)
          }
          removed = true
          await this.cleanDeleted(item.requestId); result.deletedIds.push(item.requestId)
        } catch (error) { result.failures.push({ requestId: item.requestId, error: removed ? `记录已移除，诊断文件清理失败：${String(error)}` : String(error), ...(removed ? { removed: true } : {}) }) }
      }
      return result
    })
  }
  async recoverDeleted(id: string): Promise<boolean> { const document = await this.document(id); if (document.deletedAt === undefined) return false; await this.cleanDeleted(id); return true }
  async dismiss(requestId: string, attemptId: string): Promise<void> {
    routerInputId(attemptId)
    await this.serial(async () => { const document = await this.document(requestId); if (document.deletedAt !== undefined) return; if (!document.attempts.some(row => row.id === attemptId)) throw new Error('路由回合不存在')
      if (!document.dismissed.includes(attemptId)) { document.dismissed.push(attemptId); await this.write(this.path(requestId, 'review.json'), document) } })
  }
  async prompts(requests: RouterRequest[], dismiss = false): Promise<RouterReviewPrompt[]> {
    const prompts: RouterReviewPrompt[] = []
    for (const request of requests) { const document = await this.document(request.requestId)
      if (document.deletedAt !== undefined) continue
      for (const attempt of document.attempts) if (attempt.endedAt && !document.dismissed.includes(attempt.id) && !document.feedbacks.some(row => row.attemptId === attempt.id)) {
        if (dismiss) await this.dismiss(request.requestId, attempt.id)
        else prompts.push({ requestId: request.requestId, attemptId: attempt.id, prompt: sanitizeRouterReview(request.prompt), targetTitle: request.targetTitle, endedAt: attempt.endedAt })
      }
    }
    return prompts.sort((a, b) => a.endedAt - b.endedAt)
  }
  async export(requests: RouterRequest[], requestId?: string): Promise<{ directory: string; prompt: string; count: number }> {
    if (requestId) { routerInputId(requestId); if ((await this.document(requestId)).deletedAt !== undefined) throw new Error('该路由记录已删除') }
    const selected = requests.filter(row => !requestId || row.requestId === requestId), directory = join(this.directory, 'review-exports', randomUUID())
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const index: Array<{ requestId: string; record: string; traces: string[]; feedbackCount: number }> = []
    for (const request of selected) {
      const document = await this.document(request.requestId), traces: string[] = []
      if (document.deletedAt !== undefined) { if (requestId) throw new Error('该路由记录已删除'); continue }
      for (const attempt of document.attempts) { const file = `traces/${request.requestId}-${attempt.id}.json`; await this.write(join(directory, file), await this.trace(request.requestId, attempt.id)); traces.push(file) }
      const legacy = !traces.length ? await this.legacyEvents(request.requestId) : undefined
      if (legacy) { const file = `traces/${request.requestId}-legacy.json`; await this.write(join(directory, file), legacy); traces.push(file) }
      const record = `records/${request.requestId}.json`; await this.write(join(directory, record), { request, ...document, logAvailability: legacy ? 'legacy-events-only' : traces.length ? 'captured' : 'not-captured' })
      index.push({ requestId: request.requestId, record, traces, feedbackCount: document.feedbacks.length })
    }
    await this.write(join(directory, 'index.json'), { schemaVersion: 1, exportedAt: Date.now(), records: index })
    await atomicWriteFile(join(directory, 'README.md'), 'RouterAgent 本地反馈与诊断快照\n\n先读取 index.json，再按 record、traces 路径读取每条记录。feedbacks 为用户已保存评价；无评价或缺少原因／预期目标不代表符合或不符合。历史记录 logAvailability=not-captured 表示未采集当时的完整上下文。Agent 未返回的 reasoning 和底层 assembledContext 标为 not-provided。回放分配只记录结果，避免重新投递真实任务。\n')
    return { directory, count: index.length, prompt: routerOptimizationPrompt(directory, index.length) }
  }
}
