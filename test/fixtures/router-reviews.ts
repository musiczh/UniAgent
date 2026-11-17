import { readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { RouterDecision, RouterObject, RouterRequest } from '../../src/shared/router'
import { routerObjectScope, routerScopeKey } from '../../src/shared/router'
import type { RouterFeedback, RouterTrace } from '../../src/shared/routerReview'

export interface ReviewCase {
  id: string
  request: RouterRequest
  feedback?: RouterFeedback
  trace?: Omit<RouterTrace, 'history' | 'events'>
  traces: Array<Pick<RouterTrace, 'id' | 'startedAt' | 'reasoning' | 'assembledContext'>>
  availability: string
  objects: RouterObject[]
  queries: Array<{ arguments: any; result: any }>
  gaps: string[]
}

export function chronologicalReviewCases<T extends ReviewCase>(cases: T[]): T[] {
  return cases.slice().sort((a, b) => (a.trace?.startedAt || a.request.createdAt) - (b.trace?.startedAt || b.request.createdAt))
}

// Unknown expectation fields stay unknown. In particular, a negative rating alone
// does not make a different decision correct, and a later retry is not the rated result.
export function reviewExpectation(feedback?: RouterFeedback): Partial<RouterDecision>[] | undefined {
  if (!feedback) return
  if (feedback.matches) {
    const actual = feedback.actual.decision
    if (!actual) return
    const target = actual.action === 'reuse_task' ? 'taskId' : actual.action === 'create_task_in_requirement' ? 'requirementId' : 'projectId'
    return [{ action: actual.action, ...(actual[target] ? { [target]: actual[target] } : {}) }]
  }
  const expected = feedback.expected
  if (!expected) return
  const actions: RouterDecision['action'][] = expected.kind === 'reuse_task' ? ['reuse_task'] : expected.kind === 'create_requirement' ? ['create_requirement_and_task'] :
    expected.scope === 'requirement' || expected.requirementId ? ['create_task_in_requirement'] : expected.scope === 'space' ? ['create_task_in_space'] : ['create_task_in_requirement', 'create_task_in_space']
  return actions.map(action => ({ action, ...(expected.taskId ? { taskId: expected.taskId } : {}),
    ...(expected.requirementId ? { requirementId: expected.requirementId } : {}), ...(expected.projectId ? { projectId: expected.projectId } : {}) }))
}

export function judgeReview(feedback: RouterFeedback | undefined, decision: RouterDecision | undefined, objects: RouterObject[] = []): 'matched' | 'mismatched' | 'unscored' {
  const expected = reviewExpectation(feedback)
  if (!expected) return 'unscored'
  if (!decision) return 'mismatched'
  const target = objects.find(row => row.id === (decision.taskId || decision.requirementId || decision.projectId))
  const actual = { ...decision, projectId: decision.projectId || target?.projectId,
    requirementId: decision.requirementId || (target?.kind === 'task' ? target.requirementId : undefined) }
  return expected.some(option => Object.entries(option).every(([key, value]) => actual[key as keyof RouterDecision] === value)) ? 'matched' : 'mismatched'
}

function eventQuery(event: any): { arguments: any; result: any } | undefined {
  const payload = event.payload
  if (event.type !== 'tool_call' || event.state !== 'success' || !/(?:^|[/_.])router_query$/.test(payload?.name || payload?.tool || '')) return
  try {
    const rawArgs = payload.input ?? payload.arguments
    const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
    const rawResult = payload.result ?? payload.output
    const result = rawResult?.content ? JSON.parse(rawResult.content.find((part: any) => part.type === 'text').text) : typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult
    if (args && result && !result.error) return { arguments: args, result }
  } catch { /* Older events sometimes contain only a rendered summary. */ }
}

export function reviewObjects(queries: ReviewCase['queries']): RouterObject[] {
  const objects = new Map<string, RouterObject>()
  const taskPages = new Map<string, { started: boolean; ids: Set<string> }>()
  for (const { arguments: args, result } of queries) {
    // A complete newer list supersedes an old task's observed eligibility. Its
    // absence does not tell us whether it was archived, moved or aged out.
    if (args.mode === 'task_briefs' && args.selectedScope && Array.isArray(result.items)) {
      const scope = routerScopeKey(args.selectedScope), key = scope + ':' + (result.snapshotId || 'single')
      const page = !args.cursor ? { started: true, ids: new Set<string>() } : taskPages.get(key) || { started: false, ids: new Set<string>() }
      for (const item of result.items) page.ids.add(item.id)
      taskPages.set(key, page)
      if (page.started && result.nextCursor === null && result.coverage?.complete === true) {
        for (const object of objects.values()) if (object.kind === 'task' && routerScopeKey(routerObjectScope(object)) === scope && !page.ids.has(object.id)) objects.delete(object.id)
      }
    }
    for (const raw of [...result.items || [], ...result.item ? [result.item] : [], ...(result.objects || []).filter((row: any) => row.kind)]) {
      if (!raw.id || !['space', 'requirement', 'task'].includes(raw.kind)) continue
      const previous = objects.get(raw.id), description = typeof raw.description === 'string' ? raw.description : raw.description?.text
      const observedSources = [...raw.sources || [], ...(result.item?.id === raw.id ? result.sources || [] : [])]
        .filter((source: any) => typeof source.text === 'string')
      const changed = raw.sourceRevision && previous?.sourceRevision && raw.sourceRevision !== previous.sourceRevision
      const sources = new Map((changed ? [] : previous?.sources || []).map(source => [source.ref, source]))
      for (const source of observedSources) sources.set(source.ref, source)
      objects.set(raw.id, { ...previous, ...raw, summary: description ?? raw.summary ?? previous?.summary ?? '',
        version: raw.version || createHash('sha256').update(JSON.stringify(raw)).digest('hex'), sources: [...sources.values()], description: undefined,
        // The brief only exposes routing status/counts, not the full routing view.
        routing: raw.routing?.sourceRevision ? raw.routing : undefined })
    }
  }
  return [...objects.values()]
}

export async function loadReviewCases(root: string): Promise<ReviewCase[]> {
  const base = resolve(root)
  await readFile(resolve(base, 'README.md'), 'utf8')
  const read = async (path: string) => {
    const absolute = resolve(base, path), local = relative(base, absolute)
    if (isAbsolute(local) || local === '..' || local.startsWith('../')) throw new Error('review_path_outside_export')
    return JSON.parse(await readFile(absolute, 'utf8'))
  }
  const index = await read('index.json'), cases: ReviewCase[] = []
  for (const entry of index.records) {
    const record = await read(entry.record), traces: RouterTrace[] = await Promise.all(entry.traces.map(read))
    const feedback = record.feedbacks.slice().sort((a: RouterFeedback, b: RouterFeedback) => a.revision - b.revision || a.savedAt - b.savedAt).at(-1)
    const trace = feedback?.attemptId ? traces.find(row => row.id === feedback.attemptId) :
      traces.find(row => row.result?.decision && JSON.stringify(row.result.decision) === JSON.stringify(feedback?.actual?.decision)) ||
      (traces.length === 1 && !traces[0].id && traces[0].requestId === entry.requestId ? traces[0] : !feedback ? traces.at(-1) : undefined)
    const capturedQueries = trace?.steps?.filter(step => step.kind === 'query').map(step => step.data as ReviewCase['queries'][number]) || []
    const currentQueries = capturedQueries.length ? capturedQueries : (trace?.events || []).flatMap(event => eventQuery(event) || [])
    const queries = [
      ...(trace?.history || []).filter(event => event.ts <= trace!.startedAt).flatMap(event => eventQuery(event) || []),
      ...currentQueries
    ]
    const gaps = ['底层 assembledContext 未提供；历史消息不能还原原生压缩后的完整模型上下文。']
    if (!trace) gaps.push('缺少可关联到被评价结果的完整诊断尝试，不能补用后续重试或当前线上数据。')
    if (record.logAvailability === 'legacy-events-only') gaps.push('仅有旧事件：复用实际保存的 input/output，未采集的上下文和模型历史不能还原。')
    if (!queries.length) gaps.push('没有可恢复的 router_query 返回，不能重建历史候选。')
    const objects = reviewObjects(queries)
    if (objects.some(object => !object.sources?.length)) gaps.push('部分候选只采集了摘要或来源目录，未采集的原文保持缺失。')
    // Fixed-Session histories repeat in every exported trace. Keep their observed
    // objects, not dozens of copies of the same native history and JSON outputs.
    const { history: _history, events: _events, ...header } = trace || {} as RouterTrace
    cases.push({ id: entry.requestId, request: feedback?.actual || record.request, feedback, trace: trace ? header : undefined,
      traces: traces.map(({ id, startedAt, reasoning, assembledContext }) => ({ id, startedAt, reasoning, assembledContext })),
      availability: record.logAvailability, queries: currentQueries, objects, gaps })
  }
  return cases
}
