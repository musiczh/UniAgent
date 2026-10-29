import { closeSync, constants as fsConstants, fstatSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADDON_NAME = 'ua-capability-fs.node'
const MAX_BASENAME_BYTES = 255
const nativeRequire = createRequire(import.meta.url)

export const platformSupported = process.platform === 'darwin' && process.arch === 'arm64'
export const atomicFsPlatformSupported = platformSupported

export type AtomicFsErrorCode =
  | 'atomic_fs_unavailable'
  | 'atomic_fs_invalid_name'
  | 'atomic_fs_invalid_parent'
  | 'atomic_fs_parent_changed'
  | 'atomic_fs_anchor_exists'
  | 'atomic_fs_destination_exists'
  | 'atomic_fs_source_not_found'
  | 'atomic_fs_identity_mismatch'
  | 'atomic_fs_operation_failed'
  | 'atomic_fs_sync_failed'
  | 'atomic_fs_invalid_pid'
  | 'atomic_fs_process_query_failed'

export type AtomicFsRenamePhase =
  | 'source_to_anchor'
  | 'verify_anchor'
  | 'anchor_to_target'
  | 'verify_target'
  | 'sync'

export type AtomicFsRenameDisposition =
  | 'source_unchanged'
  | 'restored'
  | 'anchor_retained'
  | 'published'
  | 'unknown'

export interface AtomicFsRenameOutcome {
  phase: AtomicFsRenamePhase
  disposition: AtomicFsRenameDisposition
  applied: boolean
}

export class AtomicFsError extends Error {
  readonly code: AtomicFsErrorCode
  readonly applied: boolean
  readonly phase?: AtomicFsRenamePhase
  readonly disposition?: AtomicFsRenameDisposition
  constructor(
    code: AtomicFsErrorCode,
    applied = false,
    phase?: AtomicFsRenamePhase,
    disposition?: AtomicFsRenameDisposition
  ) {
    super(code)
    this.name = 'AtomicFsError'
    this.code = code
    this.applied = applied
    this.phase = phase
    this.disposition = disposition
  }
}

export interface AtomicFsParentIdentity {
  dev: string | number | bigint
  ino: string | number | bigint
  mode: number
}

export interface AtomicFsEntryIdentity {
  dev: string | number | bigint
  ino: string | number | bigint
}

export type AtomicFsEntryType = 'file' | 'directory' | 'symlink'
export interface AtomicFsSourceIdentity extends AtomicFsEntryIdentity { type: AtomicFsEntryType }

interface NativeAtomicFs {
  renameExclusive(
    parentFd: number, fromBasename: string, toBasename: string, device: string, inode: string, type: AtomicFsEntryType
  ): void
  renameAnchored(
    parentFd: number, sourceBasename: string, anchorBasename: string, targetBasename: string,
    device: string, inode: string, type: AtomicFsEntryType
  ): AtomicFsRenameOutcome
  removeIdentity(parentFd: number, basename: string, device: string, inode: string): void
  processStart(pid: number): string | null
}

let cachedAddon: NativeAtomicFs | undefined

/**
 * Kept under its original exported name for API compatibility. The returned
 * artifact is now an in-process Node-API bundle, never an executable helper.
 */
export function capabilityFsHelperPath(): string {
  const electronProcess = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string }
  if (typeof electronProcess.resourcesPath === 'string' && electronProcess.resourcesPath.length > 0 &&
      electronProcess.defaultApp !== true) {
    return join(electronProcess.resourcesPath, 'native', ADDON_NAME)
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  if (moduleDirectory.endsWith(join('src', 'main', 'capability-sync'))) {
    return resolve(moduleDirectory, '../../../out/native', ADDON_NAME)
  }
  return resolve(moduleDirectory, '../native', ADDON_NAME)
}

export function helperAvailable(): boolean {
  if (!platformSupported) return false
  try {
    requireAddon()
    return true
  } catch {
    return false
  }
}

export const capabilityFsHelperAvailable = helperAvailable

export function atomicRenameExclusiveSync(
  parentPath: string,
  fromBasename: string,
  toBasename: string,
  expectedParent: AtomicFsParentIdentity,
  expectedSource: AtomicFsSourceIdentity
): void {
  const addon = requireAddon()
  validateParentPath(parentPath)
  validateBasename(fromBasename)
  validateBasename(toBasename)
  if (fromBasename === toBasename) throw new AtomicFsError('atomic_fs_invalid_name')
  const expected = normalizeParentIdentity(expectedParent)
  const source = normalizeSourceIdentity(expectedSource)
  const parentFd = openVerifiedParent(parentPath, expected)

  try {
    addon.renameExclusive(parentFd, fromBasename, toBasename, source.dev, source.ino, source.type)
  } catch (error) {
    const code = nativeErrorCode(error)
    if (code === 'destination_exists') throw new AtomicFsError('atomic_fs_destination_exists')
    if (code === 'source_not_found') throw new AtomicFsError('atomic_fs_source_not_found')
    if (code === 'identity_mismatch') throw new AtomicFsError('atomic_fs_identity_mismatch')
    if (code === 'sync_failed') throw new AtomicFsError('atomic_fs_sync_failed', true)
    throw new AtomicFsError('atomic_fs_operation_failed')
  } finally {
    closeParent(parentFd)
  }
}

/**
 * Captures source under a caller-recorded anchor, verifies the captured
 * identity, and only then publishes it to target. This detects and preserves
 * pathname races; Darwin does not provide strict inode-CAS rename semantics.
 */
export function atomicRenameAnchoredSync(
  parentPath: string,
  sourceBasename: string,
  anchorBasename: string,
  targetBasename: string,
  expectedParent: AtomicFsParentIdentity,
  expectedSource: AtomicFsSourceIdentity
): AtomicFsRenameOutcome {
  const addon = requireAddon()
  validateParentPath(parentPath)
  validateBasename(sourceBasename)
  validateBasename(anchorBasename)
  validateBasename(targetBasename)
  if (sourceBasename === anchorBasename || sourceBasename === targetBasename ||
      anchorBasename === targetBasename) throw new AtomicFsError('atomic_fs_invalid_name')
  const expected = normalizeParentIdentity(expectedParent)
  const source = normalizeSourceIdentity(expectedSource)
  const parentFd = openVerifiedParent(parentPath, expected)

  try {
    const result = addon.renameAnchored(
      parentFd, sourceBasename, anchorBasename, targetBasename, source.dev, source.ino, source.type
    )
    const outcome = nativeRenameOutcome(result)
    if (!outcome || outcome.phase !== 'sync' || outcome.disposition !== 'published' || !outcome.applied) {
      throw new AtomicFsError('atomic_fs_operation_failed', false, outcome?.phase, outcome?.disposition)
    }
    return outcome
  } catch (error) {
    if (error instanceof AtomicFsError) throw error
    const code = nativeErrorCode(error)
    const metadata = nativeRenameOutcome(error)
    const applied = metadata?.applied ?? false
    const phase = metadata?.phase
    const disposition = metadata?.disposition
    if (code === 'anchor_exists')
      throw new AtomicFsError('atomic_fs_anchor_exists', applied, phase, disposition)
    if (code === 'destination_exists')
      throw new AtomicFsError('atomic_fs_destination_exists', applied, phase, disposition)
    if (code === 'source_not_found')
      throw new AtomicFsError('atomic_fs_source_not_found', applied, phase, disposition)
    if (code === 'identity_mismatch')
      throw new AtomicFsError('atomic_fs_identity_mismatch', applied, phase, disposition)
    if (code === 'sync_failed')
      throw new AtomicFsError('atomic_fs_sync_failed', applied, phase, disposition)
    throw new AtomicFsError('atomic_fs_operation_failed', applied, phase, disposition)
  } finally {
    closeParent(parentFd)
  }
}

export function atomicRemoveIdentitySync(
  parentPath: string,
  basenameToRemove: string,
  expectedParent: AtomicFsParentIdentity,
  expectedEntry: AtomicFsEntryIdentity
): void {
  const addon = requireAddon()
  validateParentPath(parentPath)
  validateBasename(basenameToRemove)
  const expected = normalizeParentIdentity(expectedParent)
  const entry = normalizeEntryIdentity(expectedEntry)
  const parentFd = openVerifiedParent(parentPath, expected)

  try {
    addon.removeIdentity(parentFd, basenameToRemove, entry.dev, entry.ino)
  } catch (error) {
    const code = nativeErrorCode(error)
    if (code === 'source_not_found') throw new AtomicFsError('atomic_fs_source_not_found')
    if (code === 'identity_mismatch') throw new AtomicFsError('atomic_fs_identity_mismatch')
    if (code === 'sync_failed') throw new AtomicFsError('atomic_fs_sync_failed', true)
    throw new AtomicFsError('atomic_fs_operation_failed')
  } finally {
    closeParent(parentFd)
  }
}

export function processStartIdentitySync(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff)
    throw new AtomicFsError('atomic_fs_invalid_pid')

  let identity: string | null
  try {
    identity = requireAddon().processStart(pid)
  } catch (error) {
    if (error instanceof AtomicFsError && error.code === 'atomic_fs_unavailable') throw error
    throw new AtomicFsError('atomic_fs_process_query_failed')
  }
  if (identity === null) return undefined
  if (typeof identity !== 'string') throw new AtomicFsError('atomic_fs_process_query_failed')
  const match = /^v1:([1-9]\d{0,19}):(\d{6})$/.exec(identity)
  if (!match || Number(match[2]) >= 1_000_000) throw new AtomicFsError('atomic_fs_process_query_failed')
  return `v1:${BigInt(match[1]).toString()}:${match[2]}`
}

function requireAddon(): NativeAtomicFs {
  if (!platformSupported) throw new AtomicFsError('atomic_fs_unavailable')
  if (cachedAddon) return cachedAddon

  try {
    const loaded = nativeRequire(capabilityFsHelperPath()) as Partial<NativeAtomicFs>
    if (typeof loaded?.renameExclusive !== 'function' || typeof loaded.renameAnchored !== 'function' ||
        typeof loaded.removeIdentity !== 'function' ||
        typeof loaded.processStart !== 'function') throw new Error('invalid native addon exports')
    cachedAddon = Object.freeze({
      renameExclusive: loaded.renameExclusive.bind(loaded),
      renameAnchored: loaded.renameAnchored.bind(loaded),
      removeIdentity: loaded.removeIdentity.bind(loaded),
      processStart: loaded.processStart.bind(loaded)
    })
    return cachedAddon
  } catch {
    throw new AtomicFsError('atomic_fs_unavailable')
  }
}

function validateParentPath(parentPath: string): void {
  if (typeof parentPath !== 'string' || !isAbsolute(parentPath) || parentPath.includes('\0'))
    throw new AtomicFsError('atomic_fs_invalid_parent')
}

function validateBasename(name: string): void {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') ||
      /[\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name) > MAX_BASENAME_BYTES) {
    throw new AtomicFsError('atomic_fs_invalid_name')
  }
}

function normalizeParentIdentity(identity: AtomicFsParentIdentity): { dev: string; ino: string; mode: number } {
  if (!identity || !Number.isSafeInteger(identity.mode) || identity.mode < 0)
    throw new AtomicFsError('atomic_fs_invalid_parent')
  return { dev: normalizeUnsigned(identity.dev), ino: normalizeUnsigned(identity.ino), mode: identity.mode & 0o777 }
}

function normalizeEntryIdentity(identity: AtomicFsEntryIdentity): { dev: string; ino: string } {
  if (!identity) throw new AtomicFsError('atomic_fs_invalid_parent')
  return { dev: normalizeUnsigned(identity.dev), ino: normalizeUnsigned(identity.ino) }
}

function normalizeSourceIdentity(identity: AtomicFsSourceIdentity): { dev: string; ino: string; type: AtomicFsEntryType } {
  const entry = normalizeEntryIdentity(identity)
  if (!['file', 'directory', 'symlink'].includes(identity.type))
    throw new AtomicFsError('atomic_fs_invalid_parent')
  return { ...entry, type: identity.type }
}

function normalizeUnsigned(value: string | number | bigint): string {
  const text = typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)$/.test(text))
    throw new AtomicFsError('atomic_fs_invalid_parent')
  return BigInt(text).toString()
}

function openVerifiedParent(
  parentPath: string,
  expected: { dev: string; ino: string; mode: number }
): number {
  let parentFd: number
  try {
    parentFd = openSync(parentPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  } catch {
    throw new AtomicFsError('atomic_fs_parent_changed')
  }

  try {
    const actual = fstatSync(parentFd, { bigint: true })
    if (!actual.isDirectory() || actual.dev.toString() !== expected.dev || actual.ino.toString() !== expected.ino ||
        Number(actual.mode & 0o777n) !== expected.mode) throw new AtomicFsError('atomic_fs_parent_changed')
    return parentFd
  } catch (error) {
    closeParent(parentFd)
    if (error instanceof AtomicFsError) throw error
    throw new AtomicFsError('atomic_fs_parent_changed')
  }
}

function closeParent(parentFd: number): void {
  try { closeSync(parentFd) } catch { /* operation result already determines the public outcome */ }
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function nativeRenameOutcome(value: unknown): AtomicFsRenameOutcome | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { phase?: unknown; disposition?: unknown; applied?: unknown }
  const phases: readonly AtomicFsRenamePhase[] = [
    'source_to_anchor', 'verify_anchor', 'anchor_to_target', 'verify_target', 'sync'
  ]
  const dispositions: readonly AtomicFsRenameDisposition[] = [
    'source_unchanged', 'restored', 'anchor_retained', 'published', 'unknown'
  ]
  if (typeof candidate.phase !== 'string' || !phases.includes(candidate.phase as AtomicFsRenamePhase) ||
      typeof candidate.disposition !== 'string' ||
      !dispositions.includes(candidate.disposition as AtomicFsRenameDisposition) ||
      typeof candidate.applied !== 'boolean') return undefined
  return {
    phase: candidate.phase as AtomicFsRenamePhase,
    disposition: candidate.disposition as AtomicFsRenameDisposition,
    applied: candidate.applied
  }
}
