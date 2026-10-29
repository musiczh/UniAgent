import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ZCodeRuntimeConfig } from '../../shared/zcode'
import { resolveUserDataHome } from '../userData'
import { compareSemver, parseSemver } from '../semver'
import { detectZCodeRuntime, loadZCodeRuntimeConfig, zcodeRuntimeConfigPath } from './runtime'
import { writeZCodeJson } from './store'
import { buildZCodeRuntime, ZCODE_REPOSITORY as repository, ZCODE_BUNDLE_PATH as bundleRelativePath, zcodeBuildEnvironment as gitEnvironment, zcodeSourceVersion as cliVersion } from './build'

const execFileAsync = promisify(execFile)
const revisionPattern = /^[0-9a-f]{40}$/

interface ZCodeUpdateSource { config: ZCodeRuntimeConfig; revision: string; version: string }
export interface ZCodeUpdateInfo { currentRevision: string; availableRevision: string; availableVersion: string; updateAvailable: boolean }

async function git(args: string[], cwd?: string, timeout = 8000): Promise<string> {
  return (await execFileAsync('git', args, { cwd, env: gitEnvironment(), timeout, windowsHide: true, maxBuffer: 256 * 1024 })).stdout.trim()
}

export async function getZCodeUpdateSource(): Promise<ZCodeUpdateSource | undefined> {
  const config = await loadZCodeRuntimeConfig()
  if (config?.source !== 'source-build' || !config.bundlePath) return undefined
  try {
    const root = await realpath(await git(['rev-parse', '--show-toplevel'], dirname(config.bundlePath)))
    if (await realpath(join(root, bundleRelativePath)) !== config.bundlePath || config.resourceRoot !== dirname(config.bundlePath)) return undefined
    const origin = await git(['remote', 'get-url', 'origin'], root)
    if (origin !== repository && origin !== repository.slice(0, -4)) return undefined
    // A locally edited source tree is not an official build that we can safely replace.
    if (await git(['status', '--porcelain', '--untracked-files=no'], root)) return undefined
    const revision = await git(['rev-parse', 'HEAD'], root)
    if (!revisionPattern.test(revision)) return undefined
    return { config, revision, version: await cliVersion(root) }
  } catch { return undefined }
}

async function latestRevision(): Promise<string> {
  try {
    const result = await git(['ls-remote', repository, 'refs/heads/main'], undefined, 20_000)
    const revision = result.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/)?.[1]
    if (revision) return revision
  } catch { /* Report a bounded diagnostic rather than raw Git output. */ }
  throw new Error('无法连接 ZCode 官方更新源，请检查网络或代理')
}

async function remoteVersion(revision: string): Promise<string> {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/zai-org/ZCode/${revision}/apps/zcode-cli/package.json`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error('version_request_failed')
    const manifest = await response.json() as { version?: unknown }
    if (typeof manifest.version === 'string' && parseSemver(manifest.version)) return manifest.version
  } catch { /* The manifest is required even when the CLI version has not changed. */ }
  throw new Error('无法读取 ZCode 官方版本信息，请检查网络后重试')
}

export async function checkZCodeUpdate(): Promise<ZCodeUpdateInfo> {
  const source = await getZCodeUpdateSource()
  if (!source) throw new Error('仅支持未修改的官方源码构建运行时更新')
  const revision = await latestRevision()
  const version = revision === source.revision ? source.version : await remoteVersion(revision)
  if (compareSemver(version, source.version) === -1) throw new Error('官方更新源版本低于当前版本，已阻止降级')
  return { currentRevision: source.revision, availableRevision: revision, availableVersion: version, updateAvailable: revision !== source.revision }
}

export async function updateZCodeRuntime(
  requestedRevision: string | undefined,
  beforeSwitch: () => Promise<void>,
  onProgress: (message: string) => void
): Promise<string> {
  const source = await getZCodeUpdateSource()
  if (!source) throw new Error('仅支持未修改的官方源码构建运行时更新')
  const revision = requestedRevision ?? await latestRevision()
  if (!revisionPattern.test(revision)) throw new Error('ZCode 更新提交无效，请重新检查更新')
  if (revision === source.revision) return revision

  const parent = join(resolveUserDataHome(), 'zcode', 'runtime')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const candidate = await mkdtemp(join(parent, `source-${revision.slice(0, 12)}-`))
  let retainCandidate = false
  try {
    const config = await buildZCodeRuntime(candidate, revision, new AbortController().signal,
      (_phase, message) => onProgress(message), source.config, source.version)
    if (config.personalProviderConfigPath) await detectZCodeRuntime(config)
    if (JSON.stringify(await loadZCodeRuntimeConfig()) !== JSON.stringify(source.config)) throw new Error('ZCode 运行时配置已变化，请重新检查更新')
    await beforeSwitch()
    // A save can throw after the atomic rename (directory fsync); keep the validated candidate in that case.
    retainCandidate = true
    writeZCodeJson(zcodeRuntimeConfigPath(), config)
    return revision
  } finally {
    // Only discard this attempt's candidate. The active and previous runtimes remain intact.
    if (!retainCandidate) await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}
