import { mcpToolApprovalAnswer } from './questions'

/** Encode an offered approval action using the provider's native response shape. */
export function buildDecisionAnswer(value: Record<string, unknown>): unknown {
  const method = String(value.method || '')
  const act = String(value.act || '')
  if (method === 'zcode/permission') return { optionId: String(value.optionId || '') }
  if (value.kind === 'mcpTool') return mcpToolApprovalAnswer(act === 'decline' ? 'decline' : 'accept', act === 'session' || act === 'always' ? act : undefined)
  if (method === 'session/request_permission') return act === 'cancel'
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: String(value.optionId || '') } }
  const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
  if (act === 'accept') return legacy ? { decision: 'approved' } : { decision: 'accept' }
  if (act === 'session') return legacy ? { decision: 'approved_for_session' } : { decision: 'acceptForSession' }
  return legacy ? { decision: 'denied' } : { decision: 'decline' }
}
