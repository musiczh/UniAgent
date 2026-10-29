import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { DeepSeekHostClient, DeepSeekHostError } from './deepseekHostClient.ts'

export interface DeepSeekHostOptions {
  bin: string
  home: string
  cwd: string
  timeoutMs?: number
  nodeBin?: string
  patchFile?: string
  /** Explicit model settings only; no credentials are inherited from the App. */
  modelEnvironment?: Pick<NodeJS.ProcessEnv, 'DEEPSEEK_API_KEY' | 'DEEPSEEK_BASE_URL'>
}

/** Keyless installation gate. Uses a synthetic home and never opens user history. */
export async function probeDeepSeekHost(bin: string, nodeBin?: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-host-probe-'))
  const host = new DeepSeekHostService({ bin, home: join(directory, 'home'), cwd: directory, nodeBin })
  try {
    const client = await host.start()
    const catalog = await client.call<{ groups: unknown[] }>('session/modelCatalog')
    if (!Array.isArray(catalog?.groups)) throw new DeepSeekHostError('invalid-model-catalog')
    const account = await client.call<{ status: string }>('account/getState')
    if (account?.status !== 'signed-out') throw new DeepSeekHostError('invalid-account-baseline')
    const stream = client.stream<{ type: string }>('session/control', {}, AbortSignal.timeout(10_000))
    try {
      if ((await stream.next()).value?.type !== 'baseline') throw new DeepSeekHostError('invalid-control-baseline')
    } finally { await stream.return(undefined) }
  } finally {
    await host.stop()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** Only owns its spawned process handle. It never discovers or adopts external PIDs. */
export class DeepSeekHostService {
  #options: DeepSeekHostOptions
  #child?: ChildProcess
  #client?: DeepSeekHostClient
  #starting?: Promise<DeepSeekHostClient>
  #stopping?: Promise<void>
  #generation = 0

  constructor(options: DeepSeekHostOptions) {
    if (![options.bin, options.home, options.cwd, ...(options.nodeBin ? [options.nodeBin] : []), ...(options.patchFile ? [options.patchFile] : [])].every(isAbsolute)) throw new DeepSeekHostError('invalid-host-path')
    this.#options = { ...options, modelEnvironment: options.modelEnvironment ? {
      DEEPSEEK_API_KEY: options.modelEnvironment.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: options.modelEnvironment.DEEPSEEK_BASE_URL
    } : undefined }
  }

  start(): Promise<DeepSeekHostClient> {
    if (this.#stopping) return this.#stopping.then(() => this.start())
    if (this.#client) return Promise.resolve(this.#client)
    if (this.#starting) return this.#starting
    const generation = ++this.#generation
    const flight = this.launch(generation).finally(() => { if (this.#starting === flight) this.#starting = undefined })
    this.#starting = flight
    return flight
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    ++this.#generation
    this.#client?.close(); this.#client = undefined
    const flight = (async () => {
      await this.terminate(this.#child)
      await this.#starting?.catch(() => undefined)
    })().finally(() => { if (this.#stopping === flight) this.#stopping = undefined })
    this.#stopping = flight
    return flight
  }

  private async launch(generation: number): Promise<DeepSeekHostClient> {
    const { bin, home, cwd } = this.#options
    const timeoutMs = this.#options.timeoutMs ?? 30_000
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(cwd, { recursive: true, mode: 0o700 })])
    if (generation !== this.#generation) throw new DeepSeekHostError('start-cancelled')
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      ['PATH', 'SystemRoot', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])
    )
    // A private process HOME also prevents default shared Skills/env discovery in the user's home.
    Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED',
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
      ...this.#options.modelEnvironment })
    if (this.#options.nodeBin) env.PATH = this.#options.nodeBin + delimiter + (env.PATH || '')
    const child = spawn(bin, ['web', ...(this.#options.patchFile ? ['--patch', this.#options.patchFile] : []), '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    this.#child = child
    let client: DeepSeekHostClient | undefined
    child.once('exit', () => {
      client?.close()
      if (this.#child === child) { this.#child = undefined; this.#client = undefined }
    })
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let pending = ''
        const timer = setTimeout(() => finish(new DeepSeekHostError('startup-timeout')), timeoutMs)
        const exit = () => finish(new DeepSeekHostError('startup-exited'))
        const finish = (error?: Error, value?: string) => {
          clearTimeout(timer)
          child.stdout?.off('data', read)
          child.off('exit', exit); child.off('error', exit)
          pending = ''
          if (error) reject(error); else resolve(value!)
        }
        const read = (chunk: Buffer) => {
          pending = (pending + chunk.toString()).slice(-16_384)
          const match = pending.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)\s/)
          if (match) finish(undefined, match[1])
        }
        child.stdout?.on('data', read)
        child.once('exit', exit); child.once('error', exit)
        // Consume without forwarding secret-bearing boot output to logs or the renderer.
        child.stderr?.on('data', () => undefined)
      })
      client = await DeepSeekHostClient.connect(url, timeoutMs)
      const baseline = await client.call<{ items: unknown[] }>('session/list', { _request: {} })
      if (!baseline || !Array.isArray(baseline.items)) throw new DeepSeekHostError('invalid-session-baseline')
      if (generation !== this.#generation || this.#child !== child || child.exitCode !== null) throw new DeepSeekHostError('start-cancelled')
      this.#client = client
      return client
    } catch (error) {
      client?.close()
      await this.terminate(child)
      if (this.#child === child) this.#child = undefined
      throw error
    }
  }

  private async terminate(child?: ChildProcess): Promise<void> {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
}
