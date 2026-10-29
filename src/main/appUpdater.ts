import {
  RELEASE_REPOSITORY_PAGE,
  ReleaseSourceError,
  readLatestRelease
} from './releaseSource'
import type { AppUpdateError, AppUpdateState } from '../shared/types'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const FAILURE_CACHE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

export interface AppUpdateContext {
  currentVersion: string
  isPackaged: boolean
  isE2E: boolean
  cacheDir: string
}

export interface AppUpdateOptions {
  force?: boolean
  now?: () => number
  timeoutMs?: number
  signal?: AbortSignal
  readLatestRelease?: typeof readLatestRelease
  onFailure?: (error: ReleaseSourceError) => void
}

let cached: { key: string; expiresAt: number; state: AppUpdateState } | undefined
// Startup and Settings may check the same bare cache together; share one Git fetch to avoid lock contention.
const inFlightChecks = new Map<string, Promise<AppUpdateState>>()

function numericVersion(version: string): [number, number, number] {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/)
  if (!match) throw new TypeError('Invalid semantic version')
  const parts = match.slice(1, 4).map(Number) as [number, number, number]
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new TypeError('Invalid semantic version')
  return parts
}

/** Compare the numeric major, minor, and patch parts of two semantic versions. */
export function compareSemver(left: string, right: string): -1 | 0 | 1 {
  const a = numericVersion(left)
  const b = numericVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function cleanVersion(version: unknown): string | undefined {
  if (typeof version !== 'string') return undefined
  try {
    const [major, minor, patch] = numericVersion(version)
    return `${major}.${minor}.${patch}`
  } catch {
    return undefined
  }
}

function releaseState(
  fallback: AppUpdateState,
  latestVersion: string,
  downloadUrl: string,
  releaseUrl: string
): AppUpdateState {
  return {
    ...fallback,
    latestVersion,
    hasUpdate: compareSemver(latestVersion, fallback.currentVersion) > 0,
    downloadUrl,
    releaseUrl
  }
}

/** Check the Bits release manifest without importing Electron, so runtime guards stay testable. */
export async function checkAppUpdate(
  context: AppUpdateContext,
  options: AppUpdateOptions = {}
): Promise<AppUpdateState> {
  const checkedAt = (options.now ?? Date.now)()
  const fallback: AppUpdateState = {
    currentVersion: context.currentVersion,
    hasUpdate: false,
    releaseUrl: RELEASE_REPOSITORY_PAGE,
    checkedAt
  }

  if (!context.isPackaged || context.isE2E) return fallback
  const checkKey = `${context.currentVersion}\0${context.cacheDir}`
  if (!options.force && cached?.key === checkKey && cached.expiresAt > checkedAt) {
    return { ...cached.state }
  }

  const activeCheck = inFlightChecks.get(checkKey)
  if (activeCheck) return { ...await activeCheck }

  const check = (async (): Promise<AppUpdateState> => {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    let state: AppUpdateState
    try {
      const release = await (options.readLatestRelease ?? readLatestRelease)({
        cacheDir: context.cacheDir,
        signal,
        timeoutMs
      })
      const latestVersion = cleanVersion(release.manifest.version)
      if (!latestVersion) throw new Error('Invalid release version')
      state = releaseState(fallback, latestVersion, release.downloadUrl, release.releaseUrl)
    } catch (error) {
      const failure = error instanceof ReleaseSourceError ? error : new ReleaseSourceError('network')
      const appUpdateError: AppUpdateError = failure.code
      state = { ...fallback, error: appUpdateError }
      try { options.onFailure?.(failure) } catch { /* diagnostics must not affect update checks */ }
    }

    cached = { key: checkKey, expiresAt: checkedAt + (state.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS), state }
    return state
  })()
  inFlightChecks.set(checkKey, check)

  try {
    return { ...await check }
  } finally {
    if (inFlightChecks.get(checkKey) === check) inFlightChecks.delete(checkKey)
  }
}
