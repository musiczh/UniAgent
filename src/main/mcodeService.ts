import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ACPRunner, type ACPContract } from './acp/acpRunner.ts'
import type { AgentDef } from '../shared/types.ts'
import { MCODE_BIN, type MCodeConnectionInput, type MCodeConnectionSnapshot } from '../shared/mcode.ts'

const execFileP = promisify(execFile)
const baseAgent: AgentDef = { id: 'mcode', name: 'MiniMax Code', adapter: 'mcode', bin: MCODE_BIN, icon: 'mcode', builtin: true,
  models: [], capabilities: { protocol: 'acp', modelSelect: true, reasoningEffort: true, permissionModes: [] } }
const userHome = () => process.env.HOME || homedir()

/** Match the native data directory; never redirect sessions into UniAgent's private runtime. */
function dataDir(): string {
  const explicit = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim()
  if (explicit) return resolve(explicit)
  const profile = process.env.MAVIS_PROFILE?.trim()
  if (profile && !/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error('MiniMax Code Profile 无效')
  return join(userHome(), profile ? `.minimax-${profile}` : '.minimax')
}

export function mcodeRuntimeEnv(): NodeJS.ProcessEnv { return { MINIMAX_DATA_DIR: dataDir() } }
export function mcodeSessionRuntimeEnv(): NodeJS.ProcessEnv { return mcodeRuntimeEnv() }
const childEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, ...mcodeRuntimeEnv(), ...overrides })

async function runInstaller(script: string, signal: AbortSignal): Promise<void> {
  const windows = process.platform === 'win32'
  const child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
  { env: childEnv(), detached: !windows, stdio: 'ignore' })
  let stopping: Promise<void> | undefined
  let timedOut = false
  const send = (kind: NodeJS.Signals) => {
    if (!child.pid) return
    try { if (windows) child.kill(kind); else process.kill(-child.pid, kind) } catch { /* This owned installer may already have exited. */ }
  }
  const stop = () => {
    stopping ||= (async () => { send('SIGTERM'); await new Promise(done => setTimeout(done, 150)); send('SIGKILL') })()
    return stopping
  }
  const abort = () => { void stop() }
  const timer = setTimeout(() => { timedOut = true; void stop() }, 600_000)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    await new Promise<void>((done, reject) => {
      child.once('error', () => reject(new Error('安装程序未启动')))
      child.once('close', code => code === 0 && !timedOut && !signal.aborted ? done() : reject(new Error('安装程序未完成')))
    })
  } catch (error) { await stop(); throw error }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await stopping }
}

async function findExecutable(): Promise<string | undefined> {
  const name = process.platform === 'win32' ? `${MCODE_BIN}.cmd` : MCODE_BIN
  const official = resolve(process.env.MCODE_INSTALL_DIR || join(userHome(), '.minimax-code'), ...(process.platform === 'win32' ? [] : ['bin']), name)
  const candidates = [...(process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => resolve(dir, name)), official]
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, constants.X_OK); return candidate }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw new Error('无法访问本机 MiniMax Code 程序，请检查权限后重新检测') }
  }
  return undefined
}

let state: MCodeConnectionSnapshot = { installed: false, version: '', dataDir: '', status: 'uninstalled', phase: 'idle', cancellable: false, needsLogin: false, region: 'cn' }
let inspection: Promise<{ snapshot: MCodeConnectionSnapshot; contract?: ACPContract }> | undefined
let operation: { controller: AbortController; flight: Promise<MCodeConnectionSnapshot> } | undefined
let authorizationUrl: string | undefined
let browserOpener: ((url: string) => Promise<unknown>) | undefined

/** Only authentication/configuration inputs are copied; probe sessions are always temporary. */
async function withProbeData<T>(run: (home: string, workdir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-mcode-probe-'))
  const home = join(dir, 'home')
  try {
    await mkdir(home, { mode: 0o700 })
    for (const name of ['config.yaml', 'auth', 'preferences']) {
      try { await cp(join(dataDir(), name), join(home, name), { recursive: true, dereference: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    try { await chmod(join(home, 'config.yaml'), 0o600) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return await run(home, dir)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

async function probe(bin: string): Promise<ACPContract> {
  return withProbeData(async (home, workdir) => {
    const runner = new ACPRunner('mcode-probe', { n: 0 }, { ...baseAgent, bin },
      { agentId: 'mcode', workdir, permissionMode: 'ask' }, undefined, childEnv({ MINIMAX_DATA_DIR: home }))
    try { return (await runner.probeSession(false)).contract }
    finally { await runner.disposeAndWait() }
  })
}

function inspect(): Promise<{ snapshot: MCodeConnectionSnapshot; contract?: ACPContract }> {
  if (inspection) return inspection
  inspection = (async () => {
    let bin: string | undefined
    let version = ''
    const root = dataDir()
    let region: 'cn' | 'global' = process.env.MCODE_REGION === 'en' || process.env.MCODE_REGION === 'global' ? 'global' : 'cn'
    try {
      const preferences = JSON.parse(await readFile(join(root, 'preferences/mcode-region.json'), 'utf8'))
      if (preferences.regions?.prod === 'en') region = 'global'
    } catch { /* Native default applies when no preference has been saved. */ }
    const publish = (status: MCodeConnectionSnapshot['status'], message?: string, contract?: ACPContract) => {
      state = { installed: !!bin, bin, version, dataDir: root, status, region, phase: status === 'failed' ? 'failed' : 'idle',
        cancellable: false, needsLogin: status === 'needs-auth', ...(message ? { message } : {}) }
      return { snapshot: { ...state }, contract }
    }
    try {
      bin = await findExecutable()
      if (!bin) return publish('uninstalled')
      const result = await execFileP(bin, ['--version'], { env: childEnv(), timeout: 15_000, maxBuffer: 1024 * 1024 })
      version = result.stdout.trim().split('\n')[0]
      const contract = await probe(bin)
      return publish('ready', undefined, contract)
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      if (/authentication required|not authenticated|unauthenticated|login required/i.test(detail)) return publish('needs-auth')
      return publish('failed', /timeout|timed out|超时/i.test(detail)
        ? 'MiniMax Code 检测超时，请检查服务状态后重新检测'
        : 'MiniMax Code 检测失败，请检查程序版本、配置与访问权限后重试')
    }
  })().finally(() => { inspection = undefined })
  return inspection
}

export async function mcodeSnapshot(): Promise<MCodeConnectionSnapshot> {
  if (operation) return { ...state }
  return (await inspect()).snapshot
}

export async function detectMCode(agent: AgentDef): Promise<AgentDef> {
  const { snapshot, contract } = await inspect()
  const detected: AgentDef = { ...agent, bin: snapshot.bin || 'mcode', installed: snapshot.installed, version: snapshot.version,
    mcode: { region: snapshot.region },
    authenticationRequired: snapshot.needsLogin, incompatible: snapshot.status === 'failed', unavailableReason: snapshot.needsLogin ? '请登录 MiniMax Code 或配置 API Key' : snapshot.message }
  if (snapshot.status === 'failed' && !snapshot.installed) return { ...detected, lifecycle: {
    availability: 'unhealthy', auth: 'unknown', health: 'unhealthy', updateStatus: 'idle', checkedAt: Date.now(),
    detectionStatus: 'failed', detectionError: snapshot.message
  } }
  if (!contract) return detected
  const { models, currentModelId, currentPermissionMode: _permission, ...capabilities } = contract
  return { ...detected, models, defaultModel: currentModelId, capabilities: { ...agent.capabilities, ...capabilities,
    modelSelect: models.length > 0, reasoningEffort: models.some(model => model.efforts.length > 0) } }
}

function perform(phase: MCodeConnectionSnapshot['phase'], run: (signal: AbortSignal) => Promise<void>): Promise<MCodeConnectionSnapshot> {
  if (operation) return Promise.reject(new Error('MiniMax Code 正在安装、登录或检测，请稍后重试'))
  const controller = new AbortController()
  state = { ...state, phase, cancellable: true, message: undefined }
  const flight = (async () => {
    try {
      await run(controller.signal)
      controller.signal.throwIfAborted()
      const snapshot = (await inspect()).snapshot
      controller.signal.throwIfAborted()
      return snapshot
    } catch (error) {
      const message = controller.signal.aborted ? '操作已取消，可重新检测或重试' : error instanceof Error ? error.message : 'MiniMax Code 操作未完成，请重试'
      state = { ...state, phase: controller.signal.aborted ? 'cancelled' : 'failed', cancellable: false, message }
      throw new Error(message)
    } finally { operation = undefined; authorizationUrl = undefined; browserOpener = undefined }
  })()
  operation = { controller, flight }
  return flight
}

/** Called only by the user's install button; the official installer prepares a shared native installation. */
export function installMCode(): Promise<MCodeConnectionSnapshot> {
  return perform('installing', async signal => {
    if (await findExecutable()) return
    const dir = await mkdtemp(join(tmpdir(), 'uniagent-mcode-install-'))
    try {
      const windows = process.platform === 'win32'
      const script = join(dir, windows ? 'install.ps1' : 'install.sh')
      let stage = '下载安装程序'
      try {
        const response = await fetch(`https://filecdn.minimax.chat/public/install.${windows ? 'ps1' : 'sh'}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) })
        if (!response.ok) throw new Error('download')
        await writeFile(script, await response.text(), { mode: 0o700 })
        // Another installer may have finished while downloading. Do not overwrite it.
        if (await findExecutable()) return
        stage = '执行安装程序'
        await runInstaller(script, signal)
      } catch { throw new Error(`MiniMax Code ${stage}未完成，请重试或使用提示词安装`) }
      if (!await findExecutable()) throw new Error('安装程序已结束，但未检测到 mcode，请使用提示词安装排查')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

/** Validate in a temporary native configuration before committing through the official CLI. */
export function checkMCodeConnection(input: MCodeConnectionInput = {}): Promise<MCodeConnectionSnapshot> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.reject(new Error('MiniMax Code 连接参数无效'))
  if (input.region !== undefined && !['cn', 'global'].includes(input.region)) return Promise.reject(new Error('MiniMax 账号区域无效'))
  if (input.apiKey === undefined) return mcodeSnapshot()
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) return Promise.reject(new Error('请填写 MiniMax API Key'))
  const apiKey = input.apiKey.trim()
  return perform('verifying', async signal => {
    const bin = await findExecutable()
    if (!bin) throw new Error('请先安装 MiniMax Code')
    const keyEnv = { MCODE_PROVIDER_API_KEY: apiKey, ...(input.region ? { MCODE_REGION: input.region === 'global' ? 'en' : 'cn' } : {}) }
    try {
      await withProbeData(async home => {
        const env = childEnv({ ...keyEnv, MINIMAX_DATA_DIR: home })
        await execFileP(bin, ['provider', 'set-minimax-key'], { env, signal, timeout: 60_000 })
        const { stdout } = await execFileP(bin, ['provider', 'test', 'minimax_api', '--json'], { env, signal, timeout: 90_000 })
        if (JSON.parse(stdout).success !== true) throw new Error('invalid key')
      })
    } catch { throw new Error('MiniMax API Key 验证失败，请检查后重试；原有配置仍保留') }
    signal.throwIfAborted()
    try { await execFileP(bin, ['provider', 'set-minimax-key'], { env: childEnv(keyEnv), signal, timeout: 60_000 }) }
    catch { throw new Error('MiniMax API Key 校验通过，但保存未完成，请重新检测连接') }
  })
}

export function signInMCode(region: 'cn' | 'global', openBrowser: (url: string) => Promise<unknown>): Promise<MCodeConnectionSnapshot> {
  if (!['cn', 'global'].includes(region)) return Promise.reject(new Error('MiniMax 账号区域无效'))
  return perform('login', async signal => {
    const existing = await inspect()
    if (existing.snapshot.status === 'ready') return
    const bin = existing.snapshot.bin
    if (!bin || existing.snapshot.status !== 'needs-auth') throw new Error('请先完成 MiniMax Code 程序检测，再开始登录')
    state = { ...state, phase: 'login', cancellable: true, region }
    browserOpener = openBrowser
    let output = ''
    let opened = false
    const child = execFile(bin, ['login', '--region', region, '--no-browser'], { env: childEnv(), signal, timeout: 600_000, maxBuffer: 1024 * 1024 })
    const capture = (chunk: Buffer) => {
      if (signal.aborted) return
      output = (output + chunk.toString()).slice(-16384)
      const raw = output.match(/Open:\s*(https:\/\/[^\s]+)/)?.[1]
      if (!raw || opened) return
      try {
        const url = new URL(raw)
        if (url.username || url.password || !/(^|\.)(minimaxi\.com|minimax\.io|minimax\.cn|minimax\.chat)$/.test(url.hostname)) return
        authorizationUrl = url.href; opened = true
        void openBrowser(url.href).catch(() => {
          if (operation?.controller.signal === signal && !signal.aborted) state = { ...state, message: '浏览器未打开，请点击“重新打开浏览器”' }
        })
      } catch { /* Never open an untrusted CLI URL. */ }
    }
    child.stdout?.on('data', capture); child.stderr?.on('data', capture)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const abort = () => { killTimer ||= setTimeout(() => { child.kill('SIGKILL') }, 1000) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      await new Promise<void>((done, reject) => {
        let failed = false
        child.once('error', () => { failed = true })
        child.once('close', code => !failed && code === 0 ? done() : reject(new Error('MiniMax Code 登录未完成或已过期，请重试')))
      })
    } finally { clearTimeout(killTimer); signal.removeEventListener('abort', abort) }
  })
}

export async function reopenMCodeSignIn(): Promise<void> {
  if (!authorizationUrl || !browserOpener) throw new Error('授权页面尚未就绪，请稍后重试')
  try { await browserOpener(authorizationUrl) } catch { throw new Error('无法打开浏览器，请检查默认浏览器后重试') }
}
export async function cancelMCodeOperation(): Promise<void> {
  operation?.controller.abort()
  await operation?.flight.catch(() => {})
}
