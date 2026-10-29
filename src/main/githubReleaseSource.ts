import { PUBLIC_REPOSITORY, PUBLIC_WEBSITE, PUBLIC_ARTIFACT_PREFIX } from '../shared/distribution.ts'

export const RELEASE_REPOSITORY_PAGE = PUBLIC_REPOSITORY
export type ReleaseErrorCode = 'auth_required' | 'git_unavailable' | 'network' | 'invalid_manifest' | 'no_asset' | 'no_release'
export class ReleaseSourceError extends Error {
  constructor(readonly code: ReleaseErrorCode, readonly diagnostic?: { stage: string; kind: string; exitCode?: number }) {
    super(code)
    this.name = 'ReleaseSourceError'
  }
}

export interface PublicReleaseManifest {
  schemaVersion: 1
  version: string
  platform: 'darwin'
  arch: 'arm64'
  path: string
  size: number
  sha256: string
}

export function parsePublicReleaseManifest(value: unknown): PublicReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReleaseSourceError('invalid_manifest')
  const manifest = value as PublicReleaseManifest
  if (manifest.schemaVersion !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) ||
      manifest.platform !== 'darwin' || manifest.arch !== 'arm64' ||
      manifest.path !== `release/v${manifest.version}/${PUBLIC_ARTIFACT_PREFIX}-${manifest.version}-arm64.dmg` ||
      !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new ReleaseSourceError('invalid_manifest')
  }
  return manifest
}

export async function readLatestRelease(options: {
  cacheDir: string
  signal?: AbortSignal
  timeoutMs?: number
  request?: typeof fetch
}) {
  const signal = options.signal || AbortSignal.timeout(options.timeoutMs ?? 15_000)
  let response: Response
  try {
    response = await (options.request ?? fetch)(new URL('latest.json', PUBLIC_WEBSITE), {
      signal, cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }
    })
  } catch { throw new ReleaseSourceError('network') }
  if (response.status === 404) throw new ReleaseSourceError('no_release')
  if (!response.ok) throw new ReleaseSourceError('network')
  let manifest: PublicReleaseManifest
  try { manifest = parsePublicReleaseManifest(await response.json()) }
  catch { throw new ReleaseSourceError('invalid_manifest') }
  return {
    manifest,
    downloadUrl: `${PUBLIC_REPOSITORY}/releases/download/v${manifest.version}/${PUBLIC_ARTIFACT_PREFIX}-${manifest.version}-arm64.dmg`,
    releaseUrl: `${PUBLIC_REPOSITORY}/releases/tag/v${manifest.version}`
  }
}
