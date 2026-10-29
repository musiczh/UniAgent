import type { ZCodeConnection } from './connection'
import { isId, isRecord } from './protocol'

const PREFERENCES = Object.freeze({ nativeSearchEnhancementsEnabled: false, subagentRuntimeConfigEnabled: false,
  memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' })
export interface ZCodeOwner { uniagentSessionId: string; nativeSessionId: string; confirmed: boolean }

export function bindZCodeHostCallbacks(connection: ZCodeConnection, owners: Map<string, ZCodeOwner>, valid: () => boolean): () => void {
  const handler = (id: string | number, method: string, params: unknown) => {
    if (!valid() || !connection.connected) return
    if (method === 'session/requestRuntimePreferences' && isRecord(params) && isId(params.sessionId)
      && ['runtime-materialization', 'user-execution'].includes(params.scope)) {
      // Official create asks before returning its ID; these constants disclose no owner data.
      connection.respond(id, PREFERENCES)
    } else if (method === 'interaction/requestProviderRuntimeHeaders') {
      connection.respond(id, { headersApplied: false, errorMessage: '当前接入仅支持已配置的 Personal Provider，尚未接入 OAuth 账号运行材料。' })
    } else if (['interaction/requestPermission', 'interaction/requestUserInput'].includes(method)
      && isRecord(params) && isId(params.sessionId) && owners.has(params.sessionId)) {
      // Returning -32601 wins the race against v4 resolveInteraction and denies approved tools.
      // The engine cancels this legacy request when v4 resolves it; the host owns no pending promise.
      return
    } else connection.respondError(id, { code: -32601, message: 'This host does not implement this account or runtime method' })
  }
  connection.on('request', handler)
  return () => { connection.off('request', handler) }
}
