import { createHash, randomUUID } from 'node:crypto'
import { load, dump } from 'js-yaml'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveUserDataHome } from './userData.ts'
import { decryptLocalSecret, encryptLocalSecret, isLocalSecret } from './localSecretStore'
import { migrateLegacySecrets } from './legacySecretMigration'
import { ACPRunner, assertACPProviderConfig } from './acp/acpRunner.ts'
import { DEEPSEEK_BASE_URL, DEEPSEEK_PACKAGE, DEEPSEEK_VERIFIED_VERSION, deepseekBaseUrl, type DeepSeekConnectionInput, type DeepSeekConnectionSnapshot, type DeepSeekInstallPhase } from '../shared/deepseek.ts'
import { ALL_EFFORTS, type AgentDef, type ModelDef, type SessionConfig } from '../shared/types.ts'
import type { CodexSourceQuota } from '../shared/codexSources'
import { fetchSourceQuota } from './codexSourceQuota'
import { compareSemver, parseSemver } from './semver.ts'
import { DeepSeekHostService, probeDeepSeekHost } from './deepseekHostService.ts'
import { DeepSeekAccountService } from './deepseekAccountService.ts'
import { ensureDeepSeekNode, privateNodeBin } from './deepseekNodeRuntime.ts'
import type { DeepSeekHostClient } from './deepseekHostClient.ts'
import { deepseekHostContract } from './deepseekHostContract.ts'
import { prepareDeepSeekHostContext, registerDeepSeekHostContext } from './deepseekHostContext.ts'

const execFileP = promisify(execFile)
type Connection = { baseUrl: string; apiKey: string }
let onboardingChanged = () => {}
let accountService: DeepSeekAccountService | undefined
let managedHost: DeepSeekHostService | undefined
let managedHostIdentity = ''
let managedHostFlight: Promise<DeepSeekHostClient> | undefined
let installPhase: DeepSeekInstallPhase = 'idle'
let installAbort: AbortController | undefined
const cancellableInstall = () => !!installAbort && ['preparing', 'downloading', 'verifying'].includes(installPhase)
function setInstallPhase(phase: DeepSeekInstallPhase): void { installPhase = phase; onboardingChanged() }

export function configureDeepSeekOnboarding(options: {
  openBrowser: (url: string) => Promise<void>; authenticated: () => void; changed: () => void
  metadata: () => { version: string; locale: string; timezoneOffsetSeconds: number }
}): void {
  onboardingChanged = options.changed
  accountService = new DeepSeekAccountService({ ...options, client: getDeepSeekHost })
}
export function getDeepSeekHost(): Promise<DeepSeekHostClient> {
  if (managedHostFlight) return managedHostFlight
  const flight = startManagedHost().finally(() => { if (managedHostFlight === flight) managedHostFlight = undefined })
  managedHostFlight = flight
  return flight
}
async function startManagedHost(activating = false): Promise<DeepSeekHostClient> {
  await migrateDeepSeekConnection()
  const { bin, home, root } = paths()
  if (!existsSync(bin)) throw new Error('请先安装 DeepSeek Harness')
  if (installFlight && !activating) throw new Error('DeepSeek 正在安装或更新，请稍后重试')
  const current = connection()
  const identity = bin + ':' + connectionFingerprint(current)
  if (managedHost && identity !== managedHostIdentity) { await managedHost.stop(); managedHost = undefined }
  if (!managedHost) {
    const patchFile = await prepareDeepSeekHostContext(home)
    managedHost = new DeepSeekHostService({ bin, home, cwd: root, patchFile, nodeBin: privateNodeBin(root), modelEnvironment: { DEEPSEEK_API_KEY: current.apiKey, DEEPSEEK_BASE_URL: current.baseUrl } })
    managedHostIdentity = identity
  }
  const client = await managedHost.start()
  registerDeepSeekHostContext(client, home, async sessionId => (await import('./handoff.ts')).handoffMcpServers(sessionId))
  return client
}
export async function readDeepSeekConnection(): Promise<DeepSeekConnectionSnapshot> {
  await migrateDeepSeekConnection()
  const snapshot = deepseekSnapshot()
  if (snapshot.installed && snapshot.version === DEEPSEEK_VERIFIED_VERSION && !installFlight && accountService) {
    // A broken Host must not hide the settings used to repair its installation.
    await accountService.refresh().catch(() => undefined)
  }
  return deepseekSnapshot()
}
/** Main-process only: API Key copy, never the account login grant. */
export async function readDeepSeekReusableConnection(): Promise<Connection> {
  await migrateDeepSeekConnection()
  return connection()
}
export async function signInDeepSeek(): Promise<DeepSeekConnectionSnapshot> {
  if (!accountService) throw new Error('DeepSeek 登录服务未就绪')
  if (connectionCheckFlight) throw new Error('正在检查 API Key，请稍后登录')
  await accountService.start()
  return deepseekSnapshot()
}
export async function cancelDeepSeekSignIn(): Promise<void> { await accountService?.cancel() }
export async function reopenDeepSeekSignIn(): Promise<void> {
  if (!accountService) throw new Error('授权页面尚未就绪')
  await accountService.reopen()
}
export function isDeepSeekMaintenance(): boolean { return !!installFlight || !!connectionCheckFlight || !!accountService?.busy }
export async function signOutDeepSeek(): Promise<DeepSeekConnectionSnapshot> {
  if (!accountService) throw new Error('DeepSeek 登录服务未就绪')
  await accountService.signOut()
  return deepseekSnapshot()
}
export function cancelDeepSeekInstall(): void {
  if (cancellableInstall()) installAbort!.abort()
}
export async function closeDeepSeekHost(): Promise<void> {
  cancelDeepSeekInstall()
  await installFlight?.catch(() => undefined)
  await accountService?.close()
  await managedHostFlight?.catch(() => undefined)
  await managedHost?.stop()
  managedHost = undefined
}
function activeRuntimeDir(root: string): string {
  const pointer = join(root, 'active-runtime.json')
  if (existsSync(pointer)) {
    const active = JSON.parse(readFileSync(pointer, 'utf8'))
    if (active?.schemaVersion !== 1 || typeof active.directory !== 'string'
      || !/^(?:installed-[a-f0-9-]+|runtime(?:-[0-9A-Za-z.+-]+)?)$/.test(active.directory)) {
      throw new Error('DeepSeek 活动版本记录无效，请修复运行时安装')
    }
    return join(root, active.directory)
  }
  // Legacy installations have no pointer. New candidates never use this naming scheme.
  let newest: string | undefined
  try {
    for (const entry of readdirSync(root)) {
      const version = entry.match(/^runtime-(.+)$/)?.[1]
      if (!version || !parseSemver(version)) continue
      if (!newest || (compareSemver(version, newest) ?? 0) > 0) newest = version
    }
  } catch { /* root may not exist yet */ }
  return join(root, newest ? `runtime-${newest}` : 'runtime')
}
function paths() {
  const root = join(resolveUserDataHome(), 'deepseek')
  const runtime = activeRuntimeDir(root)
  return { root, runtime, bin: join(runtime, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), home: join(root, 'home'), file: join(root, 'connection.json') }
}
function installedRuntimeVersion(runtime: string): string {
  if (!existsSync(join(runtime, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))) return ''
  try {
    const manifest = JSON.parse(readFileSync(join(runtime, 'node_modules', DEEPSEEK_PACKAGE, 'package.json'), 'utf8'))
    return typeof manifest?.version === 'string' && parseSemver(manifest.version) ? manifest.version : ''
  } catch { return '' }
}
function stored(): { baseUrl?: string; encryptedKey?: string; verifiedConnection?: string } {
  const file = paths().file
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('DeepSeek 连接配置无法读取') }
}
let credentialMigration: Promise<void> | undefined
function migrateDeepSeekConnection(): Promise<void> {
  if (credentialMigration) return credentialMigration
  const previous = stored()
  if (!previous.encryptedKey || isLocalSecret(previous.encryptedKey)) return Promise.resolve()
  credentialMigration = (async () => {
    const [encryptedKey] = await migrateLegacySecrets([previous.encryptedKey!])
    const current = stored()
    if (current.encryptedKey !== previous.encryptedKey) return
    writeConnection({ ...current, encryptedKey })
  })().finally(() => { credentialMigration = undefined })
  return credentialMigration
}
function writeConnection(state: ReturnType<typeof stored>): void {
  const { root, file } = paths()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 })
  chmodSync(file + '.tmp', 0o600)
  renameSync(file + '.tmp', file)
}
function connection(): Connection & { source: DeepSeekConnectionSnapshot['source'] } {
  const state = stored()
  if (isLocalSecret(state.encryptedKey)) {
    try { return { baseUrl: deepseekBaseUrl(state.baseUrl || DEEPSEEK_BASE_URL), apiKey: decryptLocalSecret(state.encryptedKey!), source: 'harness' } }
    catch { /* Unreadable credentials must not prevent opening settings to replace them. */ }
  }
  return { baseUrl: deepseekBaseUrl(state.baseUrl || DEEPSEEK_BASE_URL), apiKey: '', source: 'none' }
}
export function deepseekSnapshot(): DeepSeekConnectionSnapshot {
  const current = connection()
  const state = stored()
  const legacyKey = !!state.encryptedKey && !isLocalSecret(state.encryptedKey)
  const { bin, runtime } = paths()
  return { baseUrl: current.baseUrl, hasKey: !!current.apiKey || legacyKey, source: legacyKey ? 'harness' : current.source, installed: existsSync(bin), version: installedRuntimeVersion(runtime),
    verified: !!current.apiKey && state.verifiedConnection === connectionFingerprint(current),
    account: accountService?.snapshot(), installation: { phase: installPhase, cancellable: cancellableInstall() } }
}
export async function getDeepSeekQuota(): Promise<CodexSourceQuota | null> {
  await migrateDeepSeekConnection()
  const current = connection()
  return current.apiKey ? fetchSourceQuota('deepseek', current.baseUrl.replace(/\/anthropic$/, ''), current.apiKey) : null
}
function connectionFingerprint(value: Connection): string {
  return createHash('sha256').update(JSON.stringify([value.baseUrl, value.apiKey])).digest('hex')
}
export function saveDeepSeekConnection(input: DeepSeekConnectionInput, verifiedConnection?: string): DeepSeekConnectionSnapshot {
  if (installFlight) throw new Error('DeepSeek 正在安装或更新，请稍后配置连接')
  if (accountService?.busy) throw new Error('请先完成或取消浏览器登录')
  if (!input || typeof input.baseUrl !== 'string' || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new Error('DeepSeek 连接参数无效')
  const baseUrl = deepseekBaseUrl(input.baseUrl)
  const previous = stored()
  let encryptedKey = previous.encryptedKey
  if (input.apiKey?.trim()) {
    encryptedKey = encryptLocalSecret(input.apiKey.trim())
  }
  writeConnection({ baseUrl, encryptedKey, verifiedConnection })
  return deepseekSnapshot()
}
let connectionCheckFlight: Promise<DeepSeekConnectionSnapshot> | undefined
export function checkDeepSeekConnection(input: DeepSeekConnectionInput): Promise<DeepSeekConnectionSnapshot> {
  if (installFlight) return Promise.reject(new Error('DeepSeek 正在安装或更新，请稍后配置连接'))
  if (accountService?.busy) return Promise.reject(new Error('请先完成或取消浏览器登录'))
  if (connectionCheckFlight) return Promise.reject(new Error('正在检查 DeepSeek 连接，请稍后重试'))
  connectionCheckFlight = (async () => {
    if (!input || typeof input.baseUrl !== 'string' || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new Error('DeepSeek 连接参数无效')
    if (!existsSync(paths().bin)) throw new Error('请先安装 DeepSeek Harness，再检查连接')
    if (!input.apiKey?.trim()) await migrateDeepSeekConnection()
    const previous = connection()
    const candidate = { baseUrl: deepseekBaseUrl(input.baseUrl), apiKey: input.apiKey?.trim() || previous.apiKey }
    if (!candidate.apiKey) throw new Error('请先填写 DeepSeek API Key')
    let response: Response
    try {
      response = await fetch(candidate.baseUrl + '/v1/messages', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', 'x-api-key': candidate.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 16, thinking: { type: 'disabled' }, stream: false,
          messages: [{ role: 'user', content: 'Reply with OK.' }] })
      })
    } catch (error) {
      throw new Error(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
        ? '连接检查超时，请检查网络后重试' : '无法连接 DeepSeek，请检查服务地址与网络后重试')
    }
    if (!response.ok) {
      await response.body?.cancel()
      const message = response.status === 401 ? 'API Key 无效，请检查后重试'
        : response.status === 403 ? 'API Key 没有模型访问权限，请检查后重试'
        : response.status === 402 ? '模型余额或额度不足，请检查 DeepSeek 账户'
        : response.status === 429 ? '连接检查过于频繁，请稍后重试'
        : `DeepSeek 服务请求失败（HTTP ${response.status}），请检查服务地址或稍后重试`
      throw new Error(message)
    }
    const result = await response.json().catch((error: unknown) => {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('连接检查超时，请检查网络后重试')
      return null
    })
    if (result?.type !== 'message' || result.role !== 'assistant' || !Array.isArray(result.content)
      || !result.content.some((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
      throw new Error('模型响应无效，未保存配置，请检查服务地址后重试')
    }
    if (connectionFingerprint(connection()) !== connectionFingerprint(previous)) throw new Error('DeepSeek 配置已变化，请重新检查后保存')
    return saveDeepSeekConnection({ baseUrl: candidate.baseUrl, ...(input.apiKey?.trim() ? { apiKey: candidate.apiKey } : {}) }, connectionFingerprint(candidate))
  })().finally(() => { connectionCheckFlight = undefined })
  return connectionCheckFlight
}
function writeRuntimeFile(file: string, contents: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === contents) return
  writeFileSync(file + '.tmp', contents, { mode: 0o600 })
  renameSync(file + '.tmp', file)
}
/** Temporary ACP startup ordering until the chat runner switches to Host. The native account service loads its credential store asynchronously. */
export function deepseekAccountStartupPatch(home: string): string {
  const file = join(home, 'uniagent-acp-account.patch.yml')
  writeRuntimeFile(file, JSON.stringify([{ id: 'acp', inject: ['acpAppStartup', 'deepseekAccount'] }]) + '\n')
  return file
}
function runtimeEnvironment(home: string): NodeJS.ProcessEnv {
  const current = connection()
  mkdirSync(home, { recursive:true, mode:0o700 })
  const patchFile = join(home, 'cordis.patch.yml')
  if (!existsSync(patchFile)) writeRuntimeFile(patchFile, '[]\n')
  const original = readFileSync(patchFile, 'utf8')
  const patch = load(original)
  const ownedIds = new Set(['uniagent-tool-approval', 'uniagent-role', 'uniagent-bridge'])
  // Only the former generated overlay contains our plugin IDs. Preserve native
  // customizations, and retain the complete pre-migration file for recovery.
  if (Array.isArray(patch) && patch.some(entry => Array.isArray(entry?.insert) && entry.insert.some((plugin: any) => ownedIds.has(plugin?.id)))) {
    const generatedIds = new Set(['acp', 'hmr', 'plugin-manager', 'session-persistence-jsonl', 'storage-json', 'attachment-local', 'skill-filesystem', 'sandbox-policy', 'approval'])
    const migrated = patch.flatMap(entry => {
      if (generatedIds.has(entry?.id)) return []
      if (!Array.isArray(entry?.insert)) return [entry]
      const insert = entry.insert.filter((plugin: any) => !ownedIds.has(plugin?.id))
      return insert.length ? [{ ...entry, insert }] : []
    })
    const backup = patchFile + '.uniagent-before-stable-acp'
    if (!existsSync(backup)) writeRuntimeFile(backup, original)
    writeRuntimeFile(patchFile, dump(migrated))
  }
  const fingerprint = createHash('sha256').update(readFileSync(patchFile, 'utf8')).digest('hex')
  const nodeBin = privateNodeBin(paths().root)
  return { ...(nodeBin ? { PATH: nodeBin + delimiter + (process.env.PATH || '') } : {}), DSH_HOME:home, DEEPSEEK_API_KEY:current.apiKey, DEEPSEEK_BASE_URL:current.baseUrl, DSH_TELEMETRY_MODE:'DISABLED',
    UNIAGENT_DEEPSEEK_ACP_PATCH: deepseekAccountStartupPatch(home), UNIAGENT_DEEPSEEK_CONFIG_HASH:`stable-acp-v1:${fingerprint}` }
}
export function deepseekRuntimeEnv(home = paths().home, runtime = paths().runtime): NodeJS.ProcessEnv {
  return runtimeEnvironment(home)
}
export function deepseekSessionRuntimeEnv(sessionId: string, config: SessionConfig): NodeJS.ProcessEnv {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('DeepSeek 会话 ID 无效')
  assertACPProviderConfig('deepseek', config)
  return runtimeEnvironment(paths().home)
}
let installFlight: Promise<DeepSeekConnectionSnapshot> | undefined
async function probeRuntime(agent: AgentDef, bin: string) {
  const nodeBin = privateNodeBin(paths().root)
  const { stdout } = await execFileP(bin, ['--version'], { timeout: 15_000, env: { ...process.env, ...(nodeBin ? { PATH: nodeBin + delimiter + (process.env.PATH || '') } : {}) } })
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-dsh-probe-'))
  const runner = new ACPRunner('deepseek-probe', { n: 0 }, { ...agent, bin }, { agentId: agent.id, workdir: dir, permissionMode: 'ask' }, undefined, deepseekRuntimeEnv(join(dir, 'home'), dirname(dirname(dirname(bin)))))
  try { return { contract:(await runner.probeSession(false)).contract, version:stdout.trim().split('\n')[0] } }
  finally { await runner.disposeAndWait(); await rm(dir, { recursive:true, force:true, maxRetries:5, retryDelay:500 }) }
}
export function installDeepSeek(version = DEEPSEEK_VERIFIED_VERSION): Promise<DeepSeekConnectionSnapshot> {
  if (installFlight) return installFlight
  if (accountService?.busy || connectionCheckFlight) return Promise.reject(new Error('请先完成或取消 DeepSeek 登录配置'))
  const controller = installAbort = new AbortController()
  const signal = controller.signal
  setInstallPhase('preparing')
  installFlight = (async () => {
    const { root, runtime: currentRuntime } = paths()
    const nodeBin = await ensureDeepSeekNode(root, signal)
    const env = { ...process.env, ...(nodeBin ? { PATH: nodeBin + delimiter + (process.env.PATH || '') } : {}) }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const activate = async (directory: string) => {
      const temporary = join(root, `.active-${randomUUID()}.json`)
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, directory }), { mode: 0o600 })
        await rename(temporary, join(root, 'active-runtime.json'))
      } finally { await rm(temporary, { force: true }) }
    }
    const staging = await mkdtemp(join(root, '.install-'))
    try {
      setInstallPhase('downloading')
      await execFileP(nodeBin ? join(nodeBin, 'npm') : process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', staging, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', `${DEEPSEEK_PACKAGE}@${version}`], { timeout:300_000, maxBuffer:2 * 1024 * 1024, signal, env })
      signal.throwIfAborted()
      setInstallPhase('verifying')
      const resolved = installedRuntimeVersion(staging) || (parseSemver(version) ? version : '')
      if (!resolved) throw new Error('无法确认已安装的 DeepSeek Harness 版本')
      if (resolved !== DEEPSEEK_VERIFIED_VERSION) throw new Error(`DeepSeek ${resolved} 尚未通过 Host 接入验证（已验证版本 ${DEEPSEEK_VERIFIED_VERSION}），保留当前版本`)
      const directory = `installed-${randomUUID()}`
      const target = join(root, directory)
      const bin = join(staging, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
      await probeDeepSeekHost(bin, nodeBin)
      // Keep the current ACP contract until HostRunner has passed its full capability gate.
      await probeRuntime({ id:'deepseek', name:'DeepSeek Harness', adapter:'deepseek', bin, icon:'deepseek', builtin:true, models:[], capabilities:{ protocol:'acp', modelSelect:true, reasoningEffort:true, permissionModes:[] } }, bin)
      signal.throwIfAborted()
      setInstallPhase('activating')
      await managedHostFlight?.catch(() => undefined)
      await managedHost?.stop()
      managedHost = undefined
      // Bootstrap the existing selection before promoting; interrupted candidates never become active.
      if (!existsSync(join(root, 'active-runtime.json')) && existsSync(currentRuntime)) {
        await activate(currentRuntime.slice(root.length + 1))
      }
      await rename(staging, target)
      await activate(directory)
      try {
        const client = await startManagedHost(true)
        const [catalog, permissions] = await Promise.all([client.call<any>('session/modelCatalog'), client.call('permissionPresets/catalog')])
        const contract = deepseekHostContract(catalog, { agentId: 'deepseek', workdir: root }, permissions)
        const account = await client.call<{ status: string }>('account/getState')
        if ((connection().apiKey || account.status === 'credential-stored') && !contract.models.length) {
          throw new Error('DeepSeek 更新后未提供可用模型，请检查登录状态后重试')
        }
      } catch (error) {
        await (managedHost as DeepSeekHostService | undefined)?.stop()
        managedHost = undefined
        if (existsSync(currentRuntime)) await activate(currentRuntime.slice(root.length + 1))
        else await rm(join(root, 'active-runtime.json'), { force: true })
        throw error
      }
    } finally {
      await rm(staging, { recursive:true, force:true, maxRetries:5, retryDelay:500 })
    }
    setInstallPhase('completed')
    return deepseekSnapshot()
  })().catch(error => {
    setInstallPhase(signal.aborted ? 'cancelled' : 'failed')
    if (signal.aborted) throw new Error('已取消安装，原有版本保持不变')
    // npm errors embed command output, paths and potentially private registry details.
    if (error && typeof error === 'object' && 'cmd' in error) throw new Error('DeepSeek 安装失败，请检查 Node.js、npm 与网络后重试')
    throw error
  }).finally(() => { installFlight = undefined; installAbort = undefined; onboardingChanged() })
  return installFlight
}
/**
 * In-app update entry used by the agent lifecycle service. Only the qualified
 * release is installable: a registry "newer" pre-release has not passed the Host
 * contract gate, so it is refused instead of replacing a working runtime.
 */
export async function updateDeepSeekRuntime(version?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    if (version && version !== DEEPSEEK_VERIFIED_VERSION) throw new Error(`DeepSeek ${version} 尚未通过 Host 接入验证（已验证版本 ${DEEPSEEK_VERIFIED_VERSION}），保留当前版本`)
    await installDeepSeek(DEEPSEEK_VERIFIED_VERSION)
    return { code: 0, stdout: '', stderr: '' }
  } catch (error) {
    return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}
/** The temporary ACP probe has no account grant. Read authenticated routes from the owned Host. */
export function deepseekAccountModels(catalog: { groups?: { id: string; models: { id: string; name: string; reasoning?: { efforts: { id: string }[]; defaultEffort?: string } }[] }[] }): ModelDef[] {
  return (catalog.groups?.find(group => group.id === 'deepseek-account')?.models || []).map(model => {
    const efforts = ALL_EFFORTS.filter(effort => model.reasoning?.efforts.some(option => option.id === effort))
    return { id: JSON.stringify(['deepseek-account', model.id]), label: `${model.name} · DeepSeek 账户`, efforts,
      defaultEffort: efforts.find(effort => effort === model.reasoning?.defaultEffort) }
  })
}
export async function detectDeepSeek(agent: AgentDef): Promise<AgentDef> {
  const { bin, runtime } = paths()
  if (!existsSync(bin)) return { ...agent, bin, installed: false }
  const version = installedRuntimeVersion(runtime)
  try {
    if (version !== DEEPSEEK_VERIFIED_VERSION) throw new Error(`当前 DeepSeek Host 版本未通过兼容性验证，请在设置中安装已验证版本 ${DEEPSEEK_VERIFIED_VERSION}`)
    const snapshot = await readDeepSeekConnection()
    const authenticated = snapshot.hasKey || snapshot.account?.signedIn
    const client = await getDeepSeekHost()
    const [catalog, permissions] = await Promise.all([client.call<any>('session/modelCatalog'), client.call('permissionPresets/catalog')])
    const contract = deepseekHostContract(catalog, { agentId: agent.id, workdir: paths().root }, permissions)
    const { models, currentModelId, currentPermissionMode: _permission, ...capabilities } = contract
    const accountModels = snapshot.account?.signedIn ? deepseekAccountModels(catalog) : []
    if (snapshot.account?.signedIn && !snapshot.hasKey && !accountModels.length) return { ...agent, bin, installed: true, incompatible: false, version,
      authenticationRequired: true, unavailableReason: '账户已登录，但 DeepSeek 尚未提供可用模型，请重新登录或配置 API Key', models: [] }
    const availableModels = [...accountModels, ...(snapshot.account?.signedIn && !snapshot.hasKey ? [] : models.filter(model => !accountModels.some(account => account.id === model.id)))]
    if (authenticated && !availableModels.length) throw new Error('DeepSeek 未提供可用模型，请检查登录状态后重试')
    return { ...agent, bin, installed: true, incompatible: false, version, authenticationRequired: !authenticated,
      unavailableReason: authenticated ? undefined : '请在设置 → Agent → DeepSeek Harness 填写 API Key 或通过浏览器登录',
      models: availableModels, defaultModel: accountModels[0]?.id || currentModelId,
      capabilities: { ...agent.capabilities, ...capabilities, protocol: 'web', modelSelect: availableModels.length > 0, reasoningEffort: availableModels.some(model => model.efforts.length > 0) } }
  } catch (error) {
    return { ...agent, bin, installed: true, version, incompatible: true, authenticationRequired: false, models: [], unavailableReason: error instanceof Error ? error.message : String(error) }
  }
}
