import type { TaskScope } from './task'
import type { AutomationEditPatch, NativeAutomationInput } from './types'

export function automationTaskScope(input: Pick<NativeAutomationInput, 'taskScope' | 'projectId'>): TaskScope {
  const scope = input.taskScope
  if (scope !== undefined) {
    const key = scope?.kind === 'space' ? 'projectId' : scope?.kind === 'requirement' ? 'requirementId' : undefined
    const id = scope?.kind === 'space' ? scope.projectId : scope?.kind === 'requirement' ? scope.requirementId : undefined
    if (!key || typeof id !== 'string' || !id.trim() ||
      Object.keys(scope).some(field => field !== 'kind' && field !== key) ||
      (input.projectId !== undefined && (scope.kind !== 'space' || input.projectId !== scope.projectId))) {
      throw new Error('请选择一个有效的空间或需求')
    }
    return { ...scope }
  }
  if (typeof input.projectId !== 'string' || !input.projectId.trim()) throw new Error('请选择有效的空间或需求')
  return { kind: 'space', projectId: input.projectId }
}

export function mergeAutomationPatch(input: NativeAutomationInput, patch: AutomationEditPatch): NativeAutomationInput {
  if (patch.taskScope !== undefined) automationTaskScope(patch)
  const scope = patch.taskScope ?? (patch.projectId !== undefined ? { kind: 'space' as const, projectId: patch.projectId } : undefined)
  return scope ? { ...input, ...patch, taskScope: scope, projectId: scope.kind === 'space' ? scope.projectId : undefined }
    : { ...input, ...patch }
}
