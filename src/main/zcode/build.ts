import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { ZCodeInstallationSnapshot, ZCodeRuntimeConfig } from '../../shared/zcode'
import { parseSemver, compareSemver } from '../semver'
import { ensureZCodeNode, ZCODE_NODE_VERSION } from './nodeRuntime'
import { runZCodeInstallProcess } from './installProcess'
import { detectZCodeEngine, zcodeRuntimeArgs } from './runtime'
import { ZCodeConnection, ZCodeRpcError } from './connection'

export const ZCODE_REPOSITORY = 'https://github.com/zai-org/ZCode.git'
export const ZCODE_VERIFIED_REVISION = '3c5b227649371507ddc4eb46ac5133afe6db1cab'
export const ZCODE_BUNDLE_PATH = 'apps/zcode-cli/packages/cli/dist/zcode.cjs'
export type ZCodeInstallProgress = (phase: ZCodeInstallationSnapshot['phase'], message: string) => void

export function zcodeBuildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

export async function zcodeSourceVersion(root: string): Promise<string> {
  const version = JSON.parse(await readFile(join(root, 'apps/zcode-cli/package.json'), 'utf8')).version
  if (typeof version !== 'string' || !parseSemver(version)) throw new Error('ZCode CLI 版本信息无效')
  return version
}

/** Verifies real storage startup and RPC without an account, a model request or access to user data. */
export async function verifyZCodeEngine(config: ZCodeRuntimeConfig, directory: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const root = await mkdtemp(join(directory, 'probe-'))
  // Match runtimePool: the native broker uses a Unix socket whose path is bounded on macOS.
  const temporary = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'uzv-'))
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root, NODE_ENV: 'production',
    ZCODE_DATA_BASE_DIR: root, ZCODE_STORAGE_DIR: join(root, 'storage'), ZCODE_SESSION_DB_PATH: join(root, 'db.sqlite'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, 'absent-provider.json'),
    ...(config.resourceRoot ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(config.resourceRoot, 'provider/zcode-builtin.json') } : {}) }
  const connection = new ZCodeConnection({ executable: config.executable, args: zcodeRuntimeArgs(config, ['app-server', '--stdio']), cwd: root, env })
  const abort = () => { void connection.close().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await connection.start()
    const capabilities = await connection.request<any>('runtime/capabilities', {}).catch(error => {
      if (error instanceof ZCodeRpcError && error.code === -32601) return {}
      throw error
    })
    const sessions = await connection.request<any>('session/list', {})
    if (!capabilities || typeof capabilities !== 'object' || !Array.isArray(sessions?.sessions) || sessions.sessions.length !== 0) {
      throw new Error('ZCode 引擎协议校验失败')
    }
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', abort)
    await connection.close()
    await rm(temporary, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}

/** Candidate belongs to the caller, who retains it only after verified activation. */
export async function buildZCodeRuntime(candidate: string, revision: string, signal: AbortSignal,
  progress: ZCodeInstallProgress, previous?: ZCodeRuntimeConfig, minimumVersion?: string): Promise<ZCodeRuntimeConfig> {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('ZCode 源码提交无效')
  const root = join(candidate, 'source'), home = join(candidate, 'build-home'), tools = join(candidate, 'tools'), temporary = join(candidate, 'tmp')
  for (const path of [root, home, tools, temporary]) await mkdir(path, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = { ...zcodeBuildEnvironment(), HOME: home, USERPROFILE: home,
    PATH: [tools, process.env.PATH].filter(Boolean).join(delimiter), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
    COREPACK_HOME: join(tools, 'corepack'), COREPACK_ENABLE_PROJECT_SPEC: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_registry: 'https://registry.npmjs.org', npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: join(home, 'global.npmrc'), HUSKY: '0', CI: '1' }
  const run = (bin: string, args: string[], timeout: number, message: string) => runZCodeInstallProcess(bin, args, { cwd: root, env, signal, timeout, message })
  progress('downloading', '正在下载 ZCode 官方源码…')
  await run('git', ['init'], 8000, 'ZCode 安装需要 Git，请先安装 Git 或使用 Agent 初始化')
  await run('git', ['remote', 'add', 'origin', ZCODE_REPOSITORY], 8000, 'ZCode 官方源初始化失败')
  await run('git', ['fetch', '--depth=1', 'origin', revision], 180_000, 'ZCode 源码下载失败或超时，请检查网络后重试')
  await run('git', ['checkout', '--detach', 'FETCH_HEAD'], 30_000, 'ZCode 源码检出失败')
  if (await run('git', ['rev-parse', 'HEAD'], 8000, 'ZCode 源码校验失败') !== revision) throw new Error('ZCode 源码提交不一致')
  const version = await zcodeSourceVersion(root)
  if (minimumVersion && compareSemver(version, minimumVersion) === -1) throw new Error('已阻止 ZCode 运行时降级')
  const toolchain = await readFile(join(root, 'mise.toml'), 'utf8')
  const nodeVersion = toolchain.match(/^node\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1]
  const pnpmVersion = toolchain.match(/^pnpm\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1]
  if (nodeVersion !== ZCODE_NODE_VERSION || pnpmVersion !== '10.33.2') throw new Error('ZCode 官方工具链已变化，请使用兼容版本或 Agent 初始化')
  progress('preparing', '正在准备 ZCode 专用运行环境…')
  const executable = await ensureZCodeNode(candidate, env, signal, previous?.executable)
  env.PATH = [tools, dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)
  const corepack = join(dirname(executable), 'corepack')
  progress('downloading', '正在安装 ZCode 构建依赖，可能需要数分钟…')
  await run(executable, [corepack, 'prepare', `pnpm@${pnpmVersion}`, '--activate'], 120_000, 'ZCode 构建工具下载失败或超时')
  await run(executable, [corepack, 'enable', '--install-directory', tools, 'pnpm'], 8000, 'ZCode 构建工具初始化失败')
  await run(executable, [corepack, 'pnpm', 'install', '--filter', '@zcode/cli...', '--frozen-lockfile'], 600_000, 'ZCode 依赖安装失败或超时')
  progress('building', '正在构建 ZCode，可能需要数分钟…')
  await run(executable, [corepack, 'pnpm', '--filter', '@zcode/cli...', 'build'], 600_000, 'ZCode 构建失败或超时')
  const bundlePath = join(root, ZCODE_BUNDLE_PATH)
  const config: ZCodeRuntimeConfig = { schemaVersion: 1, source: 'source-build', executable, bundlePath,
    resourceRoot: dirname(bundlePath), dataRootId: previous?.dataRootId ?? randomUUID(),
    ...(previous?.personalProviderConfigPath ? { personalProviderConfigPath: previous.personalProviderConfigPath } : {}) }
  progress('verifying', '正在验证 ZCode 引擎与协议…')
  const engine = await detectZCodeEngine(config)
  if (engine.version !== version) throw new Error('ZCode 构建版本与源码不一致')
  await verifyZCodeEngine(engine.config, candidate, signal)
  return engine.config
}
