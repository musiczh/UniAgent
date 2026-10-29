import type { UAEvent, UAEState } from '../../shared/types'
import { isRecord, isZCodeSnapshot, scrubZCodeDiagnostic, ZCODE_LIMITS } from './protocol'
import type { ZCodeAssembledFrame, ZCodeRow, ZCodeSnapshot } from './protocol'

export type ZCodeApplyResult = { kind: 'applied'; state: ZCodeSnapshot; reset: boolean }
  | { kind: 'duplicate'; state: ZCodeSnapshot } | { kind: 'resync'; reason: string }
const PATCH_KEYS = new Set(['revision', 'control', 'sharedContextImport', 'availability', 'inputRouting', 'meta', 'config',
  'modelTransition', 'usage', 'queue', 'pendingInteractions', 'pendingCommands', 'backgroundWorks', 'subagents',
  'workflowRuns', 'goal', 'plan', 'workspaceHookAdmission'])

export function applyZCodeFrame(state: ZCodeSnapshot | undefined, delivery: ZCodeAssembledFrame): ZCodeApplyResult {
  const frame = delivery.frame
  if (state && frame.topic !== `conversation/${state.sessionId}`) return { kind: 'resync', reason: 'session_mismatch' }
  // A recovery snapshot is authoritative even when its watermark is lower or equal.
  if (frame.payload.kind === 'snapshot') {
    const snapshot = structuredClone(frame.payload.snapshot)
    if (snapshot.rows.window.length > 1000) snapshot.rows.window = snapshot.rows.window.slice(-1000)
    return { kind: 'applied', state: snapshot, reset: true }
  }
  if (!state) return { kind: 'resync', reason: 'missing_snapshot' }
  if (frame.toSeq <= state.seq) return { kind: 'duplicate', state }
  if (frame.fromSeq !== state.seq) return { kind: 'resync', reason: 'sequence_gap_or_overlap' }
  const candidate = structuredClone(state)
  let reset = false
  for (const delta of frame.payload.deltas) {
    const rows = candidate.rows
    switch (delta.op) {
      case 'row.appended':
        if (rows.window.some(row => row.rowId === delta.row.rowId)
          || (rows.window.length && rows.window[rows.window.length - 1].rowId >= delta.row.rowId)) return { kind: 'resync', reason: 'row_order_conflict' }
        rows.window.push(structuredClone(delta.row)); rows.totalCount++
        rows.firstRowId ??= delta.row.rowId
        break
      case 'row.upserted': {
        const index = rows.window.findIndex(row => row.rowId === delta.row.rowId)
        if (index !== -1) rows.window[index] = structuredClone(delta.row)
        break
      }
      case 'row.removed': {
        const kept = rows.window.filter(row => row.rowId < delta.fromRowId)
        const removed = rows.window.length - kept.length
        const all = rows.firstRowId !== null && delta.fromRowId <= rows.firstRowId
        rows.window = kept; rows.totalCount = all ? 0 : Math.max(0, rows.totalCount - removed)
        if (all) rows.firstRowId = null
        reset = true
        break
      }
      case 'row.delta': {
        const row = rows.window.find(item => item.rowId === delta.rowId)
        if (!row) break
        if (delta.path === 'text' && ['assistantText', 'reasoning'].includes(row.kind) && row.state === 'streaming') row.text += delta.append
        else if (delta.path === 'inputText' && row.kind === 'toolCall' && row.status === 'inputStreaming') row.inputText += delta.append
        else if (delta.path === 'output.text' && row.kind === 'toolCall' && ['running', 'pendingApproval'].includes(row.status)
          && isRecord(row.output) && typeof row.output.text === 'string') row.output.text += delta.append
        else if (delta.path === 'summaryText' && row.kind === 'subagent' && typeof row.summaryText === 'string') row.summaryText += delta.append
        else return { kind: 'resync', reason: 'invalid_stream_target' }
        break
      }
      case 'state.updated':
        if (Object.keys(delta.patch).some(key => !PATCH_KEYS.has(key))) return { kind: 'resync', reason: 'unsupported_state_key' }
        Object.assign(candidate, structuredClone(delta.patch))
        break
      case 'pluginUi.resourceUpdated': case 'pluginUi.resourceListChanged': case 'pluginUi.instanceClosed': case 'pluginUi.appToolCall': break
      default: return { kind: 'resync', reason: 'unsupported_delta' }
    }
  }
  // The display tail is bounded; native seq/count/firstRowId still describe the full conversation.
  if (candidate.rows.window.length > 1000) { candidate.rows.window = candidate.rows.window.slice(-1000); reset = true }
  candidate.seq = frame.toSeq
  if (Buffer.byteLength(JSON.stringify(candidate)) > ZCODE_LIMITS.logical) return { kind: 'resync', reason: 'projection_budget_exceeded' }
  if (!isZCodeSnapshot(candidate) || candidate.revision < state.revision) return { kind: 'resync', reason: 'invalid_reduced_state' }
  return { kind: 'applied', state: candidate, reset }
}

export function findObservedCommand(state: ZCodeSnapshot, commandId: string): { row: ZCodeRow; turn?: ZCodeRow } | undefined {
  const row = state.rows.window.find(item => ['userInput', 'turnHeader'].includes(item.kind) && item.sourceCommandId === commandId)
  if (!row) return undefined
  return { row, turn: state.rows.window.find(item => item.kind === 'turnHeader' && item.turnId === row.turnId) }
}

export interface ZCodeProjectionContext { sessionId: string; generation: number; nextSeq(): number }
const rowState = (row: ZCodeRow): UAEState => {
  const state = row.state ?? row.status
  if (['completedSuccess', 'complete', 'success'].includes(state)) return 'success'
  if (['completedInterrupted', 'interrupted', 'cancelled'].includes(state)) return 'cancelled'
  if (['failed', 'error'].includes(state)) return 'failed'
  if (['pendingApproval', 'inputStreaming'].includes(state)) return 'pending'
  return 'running'
}

export function projectZCodeEvents(state: ZCodeSnapshot, context: ZCodeProjectionContext, rows = state.rows.window): UAEvent[] {
  const events: UAEvent[] = []
  const base = `zcode:${state.sessionId}:${state.logEpoch}`
  const emit = (type: UAEvent['type'], payload: Record<string, any>, ts: number, eventState?: UAEState) => events.push({
    sessionId: context.sessionId, seq: context.nextSeq(), ts, type, ...(eventState ? { state: eventState } : {}),
    payload: { ...payload, zcodeProjection: true, projectionGeneration: context.generation,
      nativeSessionId: state.sessionId, nativeLogEpoch: state.logEpoch, nativeSeq: state.seq,
      nativeHasEarlier: state.rows.totalCount > rows.length },
  })
  for (const row of rows) {
    const id = `${base}:row:${row.rowId}`
    const common = { id, turnId: row.turnId, rowId: row.rowId, entityId: row.entityId, sourceCommandId: row.sourceCommandId }
    const status = rowState(row)
    switch (row.kind) {
      case 'userInput': emit('user_message', { ...common, text: row.text }, row.createdAt, 'success'); break
      case 'assistantText': emit('agent_message', { ...common, text: row.text, model: row.model }, row.createdAt, status); break
      case 'reasoning': emit('reasoning', { ...common, text: row.text, durationMs: row.durationMs }, row.createdAt, status); break
      case 'turnHeader':
        emit('turn_started', { ...common, startedAt: row.startedAt }, row.startedAt, 'success')
        if (row.state !== 'running') emit('turn_completed', { ...common, nativeState: row.state, endedAt: row.endedAt,
          durationMs: row.activeMs, interrupted: row.state === 'completedInterrupted', failed: row.state === 'failed',
          fileChanges: row.fileChanges, outputTokens: row.outputTokens }, row.endedAt ?? row.createdAt, status)
        break
      case 'toolCall': {
        const display = row.output?.display
        emit('tool_call', { ...common, toolCallId: row.toolCallId, name: row.toolName, input: row.input ?? row.inputText,
          result: row.output?.text, error: row.error ? scrubZCodeDiagnostic(String(row.error.message)) : undefined }, row.createdAt, status)
        if (display?.kind === 'file_diff' && typeof display.filePath === 'string' && Array.isArray(display.structuredPatch)) {
          const changes = [{ path: display.filePath, kind: 'update', additions: display.additions, deletions: display.deletions }]
          const diff = display.structuredPatch.map((hunk: any) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n')
          emit('file_change', { ...common, changes }, row.createdAt, status)
          emit('diff_update', { ...common, diff: `--- a/${display.filePath}\n+++ b/${display.filePath}\n${diff}`, files: changes }, row.createdAt, status)
        }
        break
      }
      case 'timelineMarker': if (typeof row.text === 'string') emit('system_notice', { ...common, text: row.text }, row.createdAt); break
    }
  }
  const contextWindow = state.usage?.contextWindow
  if (isRecord(contextWindow) && Number.isFinite(contextWindow.usedTokens) && contextWindow.usedTokens >= 0) emit('system_notice', {
    id: `${base}:context`, kind: 'context', usage: { contextTokens: contextWindow.usedTokens,
      ...(Number.isFinite(contextWindow.maxTokens) && contextWindow.maxTokens > 0 ? { contextWindow: contextWindow.maxTokens } : {}) }
  }, state.meta?.updatedAt ?? 0)
  if (isRecord(state.plan) && Array.isArray(state.plan.items)) emit('plan_update', { id: `${base}:plan`, steps: state.plan.items.map((item: any) => ({
    text: item.content, status: item.status === 'inProgress' ? 'in_progress' : item.status })) }, 0)
  for (const interaction of state.pendingInteractions) {
    const payload = interaction.payload
    const id = `${base}:interaction:${interaction.interactionId}`
    if (!isRecord(payload)) continue
    if (payload.sensitive || interaction.kind === 'workspaceHookReview') {
      emit('system_notice', { id, text: payload.sensitive ? 'ZCode 请求安全输入，请通过原生账号渠道处理。' : 'ZCode 工作区 Hook 等待原生审核。',
        reasonCode: payload.sensitive ? 'secureInputRequired' : 'workspaceHookReviewRequired' }, interaction.createdAt)
      continue
    }
    if (interaction.kind === 'permission') emit('approval_request', { id, requestId: interaction.interactionId, interactionId: interaction.interactionId,
      kind: payload.toolName === 'Bash' ? 'command' : ['Write', 'Edit'].includes(payload.toolName) ? 'fileChange' : 'permission',
      method: 'zcode/permission', params: { summary: payload.summary, title: payload.summary, toolName: payload.toolName, detail: payload.detail,
        ...(payload.toolName === 'Bash' ? { command: payload.detail?.command } : {}),
        ...(['Write', 'Edit'].includes(payload.toolName) && typeof payload.detail?.file_path === 'string'
          ? { changes: [{ path: payload.detail.file_path }] } : {}) },
      options: payload.options, freeText: payload.freeText }, interaction.createdAt, 'pending')
    else if (interaction.kind === 'userInput') emit('approval_request', { id, requestId: interaction.interactionId, interactionId: interaction.interactionId,
      kind: 'question', method: 'zcode/userInput', params: { prompt: payload.prompt, questions: payload.questions, freeText: payload.freeText },
      options: payload.options }, interaction.createdAt, 'pending')
  }
  if (state.control.lastError) emit('error', { id: `${base}:error`, message: scrubZCodeDiagnostic(String(state.control.lastError.message ?? state.control.lastError)),
    reasonCode: state.control.lastError.code }, 0, 'failed')
  const verification = state.goal?.verifications?.at(-1)
  if (['verified', 'failed'].includes(state.goal?.status) && verification?.outcome === 'failed') emit('error', {
    id: `${base}:goal-verification:${verification.iteration}:${verification.at}`, reasonCode: 'zcode_goal_verification_failed',
    message: scrubZCodeDiagnostic(String(verification.reason ?? 'ZCode Goal 验证失败'))
  }, verification.at ?? 0, 'failed')
  return events
}
