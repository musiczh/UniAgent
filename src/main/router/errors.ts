import type { RouterObject, RouterQuery, RouterRequest } from '../../shared/router'

export interface RouterErrorData { code: string; message: string; recovery?: { action: 'query' | 'refresh' | 'retry' | 'clarify'; arguments?: Partial<RouterQuery> };
  current?: { requestId: string; version: number; state: RouterRequest['state']; hardScope: RouterRequest['scope'] } }
export class RouterToolError extends Error {
  constructor(readonly data: RouterErrorData) { super(data.code) }
}
export function assertRouterScope(request: RouterRequest, object: RouterObject): void {
  if (request.scope.kind === 'requirement' && object.id !== request.scope.requirementId && object.requirementId !== request.scope.requirementId ||
    request.scope.kind === 'space' && object.id !== request.scope.projectId && object.projectId !== request.scope.projectId) {
    if (request.context?.protocolVersion === 2) throw new RouterToolError({ code: 'hard_scope_conflict', message: '目标超出用户本轮明确选择的范围', recovery: { action: 'clarify' } })
    throw new Error('router_scope_conflict')
  }
}
export function routerError(error: unknown): RouterErrorData {
  if (error instanceof RouterToolError) return error.data
  const code = error instanceof Error ? error.message : String(error)
  return { code, message: code }
}
