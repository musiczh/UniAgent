import type { RouterScope } from '../../src/shared/router'

export async function readRouterTarget(call: (name: string, args: unknown) => Promise<any>, requestId: string, selectedScope: RouterScope, taskId?: string) {
  const directory = new Map<string, any>()
  for (const kind of ['space', 'requirement']) {
    let cursor: string | undefined
    do {
      const result = await call('router_query', { requestId, mode: 'catalog', kind, ...(cursor ? { cursor } : {}) })
      if (!result.ok) throw new Error(result.error)
      for (const item of result.value.items) directory.set(item.id, item)
      cursor = result.value.nextCursor || undefined
    } while (cursor)
  }
  let cursor: string | undefined, result: any
  do {
    result = await call('router_query', { requestId, mode: 'task_briefs', selectedScope, ...(cursor ? { cursor } : {}) })
    if (!result.ok) throw new Error(result.error)
    cursor = result.value.nextCursor || undefined
  } while (cursor)
  const scanId = result.value.snapshotId, scopeId = selectedScope.kind === 'requirement' ? selectedScope.requirementId : selectedScope.kind === 'space' ? selectedScope.projectId : ''
  const assignment = { scanId, scopeAssessment: { selectedScope, evidenceRefs: [directory.get(scopeId).evidenceRef], comparedRequirements: selectedScope.kind === 'space' ? [...directory.values()].filter(row => row.kind === 'requirement' && row.projectId === selectedScope.projectId && !row.archived).map(row => ({ requirementId: row.id, conclusion: 'unrelated', evidenceRefs: [row.evidenceRef], reason: '此夹具的目标属于所选空间直属任务' })) : [] } }
  if (taskId) {
    result = await call('router_query', { requestId, mode: 'task_detail', taskId, scanId })
    if (!result.ok) throw new Error(result.error)
  }
  return { value: result.value, assignment, assessment: taskId ? { taskId, continuous: true, stronglyRelated: true, contextRequired: true,
    evidenceRefs: result.value.sources.map((row: any) => row.ref), reason: '测试输入继续该任务已经确定的方案，需要原任务上下文。' } : undefined }
}
