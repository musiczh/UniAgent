import { randomBytes } from 'node:crypto'

// Validate the native v4 contract independently of the CLI release version.
export const ZCODE_LIMITS = { line: 1024 * 1024, logical: 16 * 1024 * 1024, staged: 32 * 1024 * 1024,
  fragments: 1024, concurrent: 32, assemblyTimeout: 30_000 } as const
export const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
export const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
export type ZCodeDeliveryKind = 'initial' | 'online' | 'recovery'
export interface ZCodeRow extends Record<string, any> { rowId: number; turnId: string; kind: string; createdAt: number; createdAtSeq: number }
export interface ZCodeSnapshot extends Record<string, any> {
  protocolVersion: 1; sessionId: string; logEpoch: string; seq: number; revision: number
  control: Record<string, any>; config: Record<string, any>; pendingInteractions: Record<string, any>[]
  rows: { window: ZCodeRow[]; totalCount: number; firstRowId: number | null }
}
export interface ZCodeLogicalFrame {
  topic: string; subscriptionId: string; fromSeq: number; toSeq: number; sentAt: number
  payload: { kind: 'snapshot'; snapshot: ZCodeSnapshot } | { kind: 'deltas'; deltas: Record<string, any>[] }
}
export interface ZCodeAssembledFrame {
  frame: ZCodeLogicalFrame; deliveryKind: ZCodeDeliveryKind; logicalFrameId: string; logicalFrameOrdinal: number
}
export interface ZCodeWireFault {
  kind: 'fault'; reason: string; topic?: string; subscriptionId?: string; logicalFrameOrdinal?: number
}
export type ZCodeAssemblyEvent = ({ kind: 'frame' } & ZCodeAssembledFrame) | ZCodeWireFault
export interface ZCodeCommand {
  commandId: string; clientId: string; sessionId: string | null; type: string; payload: Record<string, unknown>; issuedAt: number
  baseRevision?: number; baseLogEpoch?: string
}
export interface ZCodeCommandAck { commandId: string; status: 'accepted' | 'rejected' | 'stale' | 'duplicate' | 'noop' | 'failed';
  revisionAtDecision: number; result?: Record<string, any>; reasonCode?: string; message?: string }

export function zcodeCommandId(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6] & 15) | 0x70
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isZCodeRow(row: unknown): row is ZCodeRow {
  if (!isRecord(row) || !isInteger(row.rowId) || !isId(row.turnId) || typeof row.kind !== 'string'
    || !Number.isFinite(row.createdAt) || !isInteger(row.createdAtSeq)) return false
  switch (row.kind) {
    case 'userInput': return typeof row.text === 'string'
    case 'turnHeader': return ['running', 'completedSuccess', 'completedInterrupted', 'failed'].includes(row.state) && Number.isFinite(row.startedAt)
    case 'assistantText': return typeof row.text === 'string' && ['streaming', 'complete', 'interrupted', 'failed'].includes(row.state)
    case 'reasoning': return typeof row.text === 'string' && ['streaming', 'complete', 'interrupted'].includes(row.state)
    case 'toolCall': return isId(row.toolCallId) && typeof row.toolName === 'string' && typeof row.inputText === 'string'
      && ['inputStreaming', 'pendingApproval', 'running', 'success', 'error', 'cancelled'].includes(row.status)
    // Auxiliary rows are retained as native data, never interpreted as executable UI.
    default: return true
  }
}

export function isZCodeSnapshot(value: unknown): value is ZCodeSnapshot {
  if (!isRecord(value) || value.protocolVersion !== 1 || !isId(value.sessionId) || !isId(value.logEpoch)
    || !isInteger(value.seq) || !isInteger(value.revision) || !isRecord(value.control) || typeof value.control.phase !== 'string'
    || !isRecord(value.config) || !Array.isArray(value.pendingInteractions) || !value.pendingInteractions.every(isRecord)
    || !isRecord(value.rows) || !Array.isArray(value.rows.window) || !value.rows.window.every(isZCodeRow)
    || !isInteger(value.rows.totalCount) || value.rows.totalCount < value.rows.window.length
    || !(value.rows.firstRowId === null || isInteger(value.rows.firstRowId))) return false
  const ids = value.rows.window.map((row: ZCodeRow) => row.rowId)
  return ids.every((id: number, index: number) => index === 0 || ids[index - 1] < id)
}

export function validateZCodeFrame(value: unknown): ZCodeLogicalFrame {
  if (!isRecord(value) || !isId(value.topic) || !isId(value.subscriptionId) || !isInteger(value.fromSeq)
    || !isInteger(value.toSeq) || value.fromSeq > value.toSeq || !Number.isFinite(value.sentAt) || !isRecord(value.payload)) {
    throw new Error('invalid_logical_frame')
  }
  if (!value.topic.startsWith('conversation/') || value.topic === 'conversation/') throw new Error('unsupported_topic')
  if (value.payload.kind === 'snapshot') {
    const snapshot = value.payload.snapshot
    if (value.fromSeq !== 0 || !isZCodeSnapshot(snapshot) || snapshot.seq !== value.toSeq
      || value.topic !== `conversation/${snapshot.sessionId}`) throw new Error('invalid_snapshot')
  } else if (value.payload.kind === 'deltas') {
    if (!Array.isArray(value.payload.deltas) || value.payload.deltas.length > 500) throw new Error('invalid_deltas')
    for (const delta of value.payload.deltas) {
      if (!isRecord(delta) || typeof delta.op !== 'string') throw new Error('invalid_delta')
      if (['row.appended', 'row.upserted'].includes(delta.op) && !isZCodeRow(delta.row)) throw new Error('invalid_row')
      if (delta.op === 'row.removed' && !isInteger(delta.fromRowId)) throw new Error('invalid_row_removal')
      if (delta.op === 'row.delta' && (!isInteger(delta.rowId) || typeof delta.append !== 'string'
        || !['text', 'inputText', 'output.text', 'summaryText'].includes(delta.path))) throw new Error('invalid_row_delta')
      if (delta.op === 'state.updated' && !isRecord(delta.patch)) throw new Error('invalid_state_patch')
    }
  } else throw new Error('unsupported_payload')
  return value as unknown as ZCodeLogicalFrame
}

export function scrubZCodeDiagnostic(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|code|secret|ticket)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api.?key|authorization|access.?token|refresh.?token|password|secret)["'\s]*[:=]["'\s]*)[^\s,"'}]+/gi, '$1[REDACTED]')
}
