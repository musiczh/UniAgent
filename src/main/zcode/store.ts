import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ZCODE_PERMISSION_VALUES, type ZCodeModelSelection, type ZCodePermissionValue, type ZCodeSessionState } from '../../shared/zcode'

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  const serialized = JSON.stringify(value)
  if (serialized === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('ZCode payload must contain JSON values')
  return serialized
}

export function zcodePayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function writeZCodeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8')
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* renamed or absent */ }
  }
}

export function sanitizeZCodeSelection(value: unknown): ZCodeModelSelection | undefined {
  if (!record(value) || !string(value.providerId) || !string(value.modelId)) return undefined
  if (value.providerId.length > 512 || value.modelId.length > 512) return undefined
  if (value.options !== undefined && (!record(value.options) || Object.keys(value.options).some(key => key !== 'reasoningLevel'))) return undefined
  if (value.options?.reasoningLevel !== undefined && !string(value.options.reasoningLevel)) return undefined
  return { providerId: value.providerId, modelId: value.modelId,
    ...(value.options?.reasoningLevel ? { options: { reasoningLevel: value.options.reasoningLevel } } : {}) }
}

export function sanitizeZCodeState(value: unknown): ZCodeSessionState | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !string(value.dataRootId)
    || !string(value.workspaceKey) || !string(value.runtimeFingerprint) || !Array.isArray(value.deliveries)) return undefined
  if (value.deliveries.length > 1024) return undefined
  const deliveries: ZCodeSessionState['deliveries'] = []
  const ids = new Set<string>()
  for (const entry of value.deliveries) {
    if (!record(entry) || !string(entry.queueItemId) || !string(entry.commandId) || ids.has(entry.commandId)
      || !['prepared', 'sent', 'acknowledged', 'observed', 'uncertain', 'failed'].includes(entry.phase)
      || !/^[a-f0-9]{64}$/.test(entry.payloadHash) || !Number.isSafeInteger(entry.issuedAt) || entry.issuedAt < 0
      || !record(entry.submission) || typeof entry.submission.text !== 'string' || Buffer.byteLength(entry.submission.text) > 1024 * 1024
      || !Object.values(ZCODE_PERMISSION_VALUES).includes(entry.submission.mode) || typeof entry.submission.planEnabled !== 'boolean') return undefined
    const selection = sanitizeZCodeSelection(entry.submission.modelSelection)
    if (!selection) return undefined
    const attachments = entry.submission.attachments
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 32 || attachments.some((item: any) => !record(item)
      || !string(item.ref) || !string(item.fileName) || !string(item.mime) || !Number.isSafeInteger(item.bytes) || item.bytes < 0))) return undefined
    const submission = { text: entry.submission.text, mode: entry.submission.mode as ZCodePermissionValue, planEnabled: entry.submission.planEnabled, modelSelection: selection,
      ...(attachments?.length ? { attachments: attachments.map((item: any) => ({ ref: item.ref, fileName: item.fileName, mime: item.mime, bytes: item.bytes })) } : {}) }
    if (zcodePayloadHash(submission) !== entry.payloadHash) return undefined
    for (const key of ['nativeSessionId', 'replacesCommandId', 'turnId']) if (entry[key] !== undefined && !string(entry[key])) return undefined
    if (entry.configVersion !== undefined && (!Number.isSafeInteger(entry.configVersion) || entry.configVersion < 0)) return undefined
    if (entry.ackStatus !== undefined && !['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed'].includes(entry.ackStatus)) return undefined
    if (entry.retryRequested !== undefined && entry.retryRequested !== true) return undefined
    ids.add(entry.commandId)
    deliveries.push({ queueItemId: entry.queueItemId, commandId: entry.commandId, phase: entry.phase, payloadHash: entry.payloadHash,
      issuedAt: entry.issuedAt, submission,
      ...(entry.nativeSessionId ? { nativeSessionId: entry.nativeSessionId } : {}),
      ...(entry.replacesCommandId ? { replacesCommandId: entry.replacesCommandId } : {}),
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      ...(entry.ackStatus ? { ackStatus: entry.ackStatus } : {}),
      ...(entry.retryRequested ? { retryRequested: true as const } : {}),
      ...(entry.configVersion !== undefined ? { configVersion: entry.configVersion } : {}) })
  }
  const state: ZCodeSessionState = { schemaVersion: 1, dataRootId: value.dataRootId, workspaceKey: value.workspaceKey, runtimeFingerprint: value.runtimeFingerprint, deliveries }
  if (value.createCommandId !== undefined) { if (!string(value.createCommandId)) return undefined; state.createCommandId = value.createCommandId }
  if (value.suspendedAfterStop !== undefined) { if (typeof value.suspendedAfterStop !== 'boolean') return undefined; state.suspendedAfterStop = value.suspendedAfterStop }
  if (value.pendingConfig !== undefined) {
    const pending = value.pendingConfig
    if (!record(pending) || !Number.isSafeInteger(pending.version) || pending.version < 0) return undefined
    state.pendingConfig = { version: pending.version }
    if (pending.modelSelection !== undefined) {
      const selection = sanitizeZCodeSelection(pending.modelSelection)
      if (!selection) return undefined
      state.pendingConfig.modelSelection = selection
    }
    if (pending.mode !== undefined) { if (!Object.values(ZCODE_PERMISSION_VALUES).includes(pending.mode)) return undefined; state.pendingConfig.mode = pending.mode }
    if (pending.planEnabled !== undefined) { if (typeof pending.planEnabled !== 'boolean') return undefined; state.pendingConfig.planEnabled = pending.planEnabled }
  }
  return state
}

export interface ZCodeCacheIdentity {
  nativeSessionId: string
  workspaceKey: string
  dataRootId: string
  runtimeFingerprint: string
}

/** Cache loss never changes a durable input receipt. */
export class ZCodeCacheStore {
  constructor(private root: string) {}
  private path(sessionId: string, kind: 'checkpoint' | 'display'): string {
    return join(this.root, createHash('sha256').update(sessionId).digest('hex'), kind + '.json')
  }
  save(sessionId: string, kind: 'checkpoint' | 'display', identity: ZCodeCacheIdentity, value: unknown): void {
    const payload = { schemaVersion: 1, projectionVersion: 1, identity, value }
    const serialized = JSON.stringify(payload)
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('ZCode cache exceeds limit')
    // A checkpoint with interaction secrets cannot serve as an exact resume base.
    if (/(?:"(?:apiKey|authorization|password|requestAuth|accessToken)"\s*:)/i.test(serialized)) throw new Error('ZCode cache contains sensitive fields')
    writeZCodeJson(this.path(sessionId, kind), { ...payload, checksum: zcodePayloadHash(payload) })
  }
  load(sessionId: string, kind: 'checkpoint' | 'display', identity: ZCodeCacheIdentity): unknown | undefined {
    try {
      const text = readFileSync(this.path(sessionId, kind), 'utf8')
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) return undefined
      const item = JSON.parse(text)
      const payload = { schemaVersion: item.schemaVersion, projectionVersion: item.projectionVersion, identity: item.identity, value: item.value }
      if (item.schemaVersion !== 1 || item.projectionVersion !== 1 || canonicalJson(item.identity) !== canonicalJson(identity)
        || item.checksum !== zcodePayloadHash(payload)) return undefined
      return item.value
    } catch { return undefined }
  }
}
