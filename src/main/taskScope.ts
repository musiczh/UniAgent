import type { NativeAutomationInput, SessionConfig } from '../shared/types'
import type { Requirement } from '../shared/requirementTypes'
import { automationTaskScope } from '../shared/automationOwnership'

export function resolveAutomationTaskConfig(input: NativeAutomationInput, requirement: (id: string) => Requirement | undefined, projectExists: (id: string) => boolean, requirementsEnabled: boolean): SessionConfig {
  const taskScope = automationTaskScope(input)
  if (taskScope.kind === 'requirement' && !requirementsEnabled) throw new Error('需求功能已停用，请重新选择定时任务归属')
  return resolveTaskCreationScope({
    agentId: input.agentId, taskScope, workdir: '', model: input.model || undefined,
    effort: input.reasoningEffort, permissionMode: input.permissionMode
  }, requirement, projectExists)
}

/** Resolve business ownership only at creation; never rebind existing sessions. */
export function resolveTaskCreationScope(config: SessionConfig, requirement: (id: string) => Requirement | undefined, projectExists: (id: string) => boolean): SessionConfig {
  const { taskScope, ...next } = config
  if (!taskScope) return next
  if (taskScope.kind === 'space' && typeof taskScope.projectId === 'string' && projectExists(taskScope.projectId)) {
    delete next.requirementId
    return { ...next, projectId: taskScope.projectId }
  }
  if (taskScope.kind === 'requirement' && typeof taskScope.requirementId === 'string') {
    const r = requirement(taskScope.requirementId)
    if (!r || r.status === 'archived') throw new Error('所选需求不可用，请重新选择')
    if (!r.projectId || !projectExists(r.projectId)) throw new Error('需求尚未绑定有效空间，请先编辑需求')
    if (config.projectId && config.projectId !== r.projectId) throw new Error('需求主空间已变更，请重新选择归属后提交')
    return { ...next, requirementId: r.id, projectId: r.projectId }
  }
  throw new Error('请选择有效的空间或需求')
}
