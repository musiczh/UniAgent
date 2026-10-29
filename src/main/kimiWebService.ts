import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectKimiWebServer, KimiWebServer } from './kimiWebServer.ts'
import { isKimiWebServiceFailure, KimiWebError, type KimiWebTransport } from './kimiWebTransport.ts'
import { parseSemver } from './semver.ts'

export interface KimiWebServiceOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  argsPrefix?: string[]
  timeoutMs?: number
}
export interface KimiWebLease {
  transport: KimiWebTransport
  home: string
  version: string
  interactionResponses: boolean
  readonly replaced: boolean
  trackSession(id: string): void
  release(): Promise<void>
}
type Service = { transport: KimiWebTransport; version: string; interactionResponses: boolean; server?: KimiWebServer; users: number; sessions: Set<string>; timer?: ReturnType<typeof setTimeout>; closing?: Promise<void>; recovery?: Promise<boolean>; replaced?: boolean }
const services = new Map<string, Promise<Service>>()
type RecoveryBudget = { attempts: number[]; error?: KimiWebError; failedAt?: number }
const recoveryBudgets = new Map<string, RecoveryBudget>()
const RECOVERY_WINDOW_MS = 5 * 60_000
const MAX_RESTARTS = 2
let epoch = 0

function recoveryBudget(key: string): RecoveryBudget {
  let budget = recoveryBudgets.get(key)
  if (!budget) { budget = { attempts: [] }; recoveryBudgets.set(key, budget) }
  budget.attempts = budget.attempts.filter(at => Date.now() - at < RECOVERY_WINDOW_MS)
  if (budget.failedAt !== undefined && Date.now() - budget.failedAt >= RECOVERY_WINDOW_MS) budget.error = undefined
  return budget
}

function failRecovery(budget: RecoveryBudget, kind: string): never {
  budget.failedAt = kind === 'shutdown_incomplete' ? Infinity : Date.now()
  budget.error = new KimiWebError(kind)
  throw budget.error
}

function startService(key: string, options: KimiWebServiceOptions, env: NodeJS.ProcessEnv): Promise<Service> {
  const generation = epoch
  const flight: Promise<Service> = open(options, env).then(service => {
    service.transport.onFailure = () => recoverService(key, flight, service, options, env, generation)
    return service
  })
  void flight.catch(() => { if (services.get(key) === flight) services.delete(key) })
  return flight
}

function recoverService(key: string, flight: Promise<Service>, service: Service, options: KimiWebServiceOptions, env: NodeJS.ProcessEnv, generation: number): Promise<boolean> {
  if (service.recovery) return service.recovery
  if (!service.server || services.get(key) !== flight || generation !== epoch) return Promise.resolve(false)
  const recovering = (async () => {
    if (service.server!.alive) {
      try { await service.transport.checkHealth(); return false }
      catch (error) { if (!isKimiWebServiceFailure(error)) return false }
    }
    if (services.get(key) !== flight || generation !== epoch) return false
    const budget = recoveryBudget(key)
    if (service.timer) clearTimeout(service.timer)
    // Publish the replacement flight before stopping the old writer. All callers
    // share the same recovery and must wait for confirmed process termination.
    const replacement: Promise<Service> = (async () => {
      service.closing = service.server!.closeAndWait()
      try { await service.closing }
      catch { services.set(key, flight); failRecovery(budget, 'shutdown_incomplete') }
      if (budget.attempts.length >= MAX_RESTARTS) failRecovery(budget, 'recovery_limit')
      while (budget.attempts.length < MAX_RESTARTS) {
        if (generation !== epoch) throw new KimiWebError('closed')
        budget.attempts.push(Date.now())
        let next: Service | undefined
        try {
          next = await open(options, env)
          await next.transport.verifyProtocol()
          if (generation !== epoch) throw new KimiWebError('closed')
          next.sessions = new Set(service.sessions)
          next.transport.onFailure = () => recoverService(key, replacement, next!, options, env, generation)
          next.timer = setTimeout(() => {
            if (generation === epoch && services.get(key) === replacement) void acquireKimiWebService(options).then(lease => lease.release()).catch(() => {})
          }, 5000)
          next.timer.unref()
          service.replaced = true
          return next
        } catch (error) {
          try {
            if (next?.server) await next.server.closeAndWait()
            else await next?.transport.closeAndWait()
          } catch { failRecovery(budget, 'shutdown_incomplete') }
          if (error instanceof KimiWebError && error.kind === 'shutdown_incomplete') failRecovery(budget, 'shutdown_incomplete')
          if (generation !== epoch) throw new KimiWebError('closed')
        }
      }
      failRecovery(budget, 'recovery_failed')
    })()
    services.set(key, replacement)
    try { await replacement; return true }
    finally { if (budget.error && services.get(key) === replacement) services.delete(key) }
  })()
  service.recovery = recovering
  void recovering.finally(() => { if (service.recovery === recovering) service.recovery = undefined }).catch(() => {})
  return recovering
}

export function kimiWebEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, KIMI_CODE_WATCH: 'false', NO_COLOR: '1' }
  env.KIMI_CODE_HOME = resolve(env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code'))
  // A shared process cannot carry one UniAgent session's trusted MCP identity.
  for (const name of Object.keys(env)) if (name.startsWith('UNIAGENT_')) delete env[name]
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function discover(home: string, timeoutMs?: number): Promise<KimiWebTransport | undefined> {
  const directory = join(home, 'server', 'instances')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(directory, entry.name)
    const stat = await lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.size > 16384 || process.getuid && stat.uid !== process.getuid()) continue
    let row: any
    try { row = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
    if (row.host !== '127.0.0.1' || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || typeof row.server_id !== 'string' || !Number.isInteger(row.pid) || row.pid <= 0) continue
    try { process.kill(row.pid, 0) } catch { continue }
    // kimi rewrites its process title to "kimi-code", so the command line can
    // never prove the executable. Bind the registered pid to the listening port
    // instead, then require same-uid ownership of that process.
    const listeners = await promisify(execFile)('/usr/sbin/lsof', ['-nP', `-iTCP:${row.port}`, '-sTCP:LISTEN', '-t'], { timeout: 2000, maxBuffer: 16384 })
      .then(result => new Set(result.stdout.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0)))
      .catch((error: any) => (error?.code === 1 && !String(error.stderr || '').trim() ? new Set<number>() : undefined))
    if (!listeners) throw new KimiWebError('server_source_unverified')
    // Stale registration (recycled pid, or a service that already went away):
    // skip it and fall through to a normal start instead of failing discovery.
    if (!listeners.has(row.pid)) continue
    const identity = await promisify(execFile)('/bin/ps', ['-p', String(row.pid), '-o', 'uid='], { timeout: 2000, maxBuffer: 4096 }).catch(() => undefined)
    if (!identity || process.getuid && Number(identity.stdout.trim().split(/\s+/)[0]) !== process.getuid()) throw new KimiWebError('server_source_unverified')
    // A live service with failed authentication is an error, not permission to
    // silently start another writer against the same session storage.
    return connectKimiWebServer(`http://127.0.0.1:${row.port}`, home, timeoutMs)
  }
}

async function open(options: KimiWebServiceOptions, env: NodeJS.ProcessEnv): Promise<Service> {
  const existing = await discover(env.KIMI_CODE_HOME!, options.timeoutMs)
  if (!existing && !options.argsPrefix?.length) {
    const result = await promisify(execFile)(options.bin, ['--version'], { env, cwd: options.cwd, timeout: 8000, maxBuffer: 8192 }).catch(() => undefined)
    if (!parseSemver(result?.stdout.trim().match(/(?:^|\s)v?(\S+)$/)?.[1])) throw new KimiWebError('version_unsupported')
  }
  const server = existing ? undefined : await KimiWebServer.start({ ...options, env })
  const transport = existing || server!.transport!
  try {
    const meta = await transport.request<any>('GET', '/api/v1/meta')
    if (typeof meta.server_version !== 'string' || !parseSemver(meta.server_version)) throw new KimiWebError('version_unsupported')
    const spec = await transport.specification('/openapi.json')
    for (const [path, method] of [
      ['/api/v1/sessions/{session_id}/goal', 'get'], ['/api/v1/sessions/{session_id}/profile', 'post'],
      ['/api/v1/sessions/{session_id}/prompts', 'post'], ['/api/v1/sessions/{session_id}/prompts/{tail}', 'post']
    ]) if (!spec.paths?.[path]?.[method]) throw new KimiWebError('official_api_unsupported')
    if (typeof (await transport.specification('/asyncapi.json')).asyncapi !== 'string') throw new KimiWebError('official_events_unsupported')
    return { transport, version: meta.server_version, interactionResponses: !!spec.paths?.['/api/v1/sessions/{session_id}/interactions/{interaction_id}']?.post, server, users: 0, sessions: new Set() }
  } catch (error) {
    if (server) await server.closeAndWait(); else await transport.closeAndWait()
    throw error
  }
}

/** One transport per canonical home and executable; borrowed services are never stopped. */
export async function acquireKimiWebService(options: KimiWebServiceOptions): Promise<KimiWebLease> {
  const env = kimiWebEnvironment(options.env)
  if (!isAbsolute(options.bin)) {
    const path = await promisify(execFile)('/usr/bin/which', [options.bin], { env, timeout: 5000 }).catch(() => undefined)
    if (!path?.stdout.trim()) throw new KimiWebError('cli_not_found')
    options = { ...options, bin: path.stdout.trim().split('\n')[0] }
  }
  const home = await realpath(env.KIMI_CODE_HOME!).catch(() => env.KIMI_CODE_HOME!)
  env.KIMI_CODE_HOME = home
  const key = JSON.stringify([home, await realpath(options.bin).catch(() => options.bin), options.argsPrefix || []])
  const budget = recoveryBudget(key)
  let flight = services.get(key)
  if (budget.error) {
    if (budget.error.kind !== 'shutdown_incomplete' || !flight) throw budget.error
    const blocked = await flight.catch(() => undefined)
    if (!blocked?.server) throw budget.error
    const generation = epoch
    blocked.closing = blocked.server.closeAndWait()
    try { await blocked.closing } catch { throw budget.error }
    if (generation !== epoch) throw new KimiWebError('closed')
    if (services.get(key) !== flight) return acquireKimiWebService(options)
    budget.error = undefined
    budget.failedAt = undefined
    await recoverService(key, flight, blocked, options, env, generation)
    return acquireKimiWebService(options)
  }
  if (!flight) {
    flight = startService(key, options, env)
    services.set(key, flight)
  }
  const service = await flight
  if (!service.closing && service.server && !service.server.alive) {
    await service.transport.recoverFailure(new KimiWebError('connection'))
    return acquireKimiWebService(options)
  }
  if (service.closing) {
    try { await service.closing }
    catch (error) {
      if (!service.server) throw error
      service.closing = service.server.closeAndWait()
      await service.closing
    }
    if (services.get(key) === flight) services.delete(key)
    await service.transport.closeAndWait()
    return acquireKimiWebService(options)
  }
  service.users++
  if (service.timer) clearTimeout(service.timer)
  let released = false
  const idleClose = async (): Promise<void> => {
    if (service.users || services.get(key) !== flight) return
    if (service.server) {
      if (!service.server.alive) {
        service.closing = service.server.closeAndWait()
        await service.closing
        if (services.get(key) === flight) services.delete(key)
        return
      }
      try {
        const busy = await service.transport.request<any>('GET', '/api/v1/sessions?busy=true&page_size=100')
        if (!Array.isArray(busy.items) || busy.items.length || busy.has_more) throw new KimiWebError('service_busy')
        for (const id of service.sessions) {
          const base = `/api/v1/sessions/${encodeURIComponent(id)}`
          const [status, goal, tasks] = await Promise.all([
            service.transport.request<any>('GET', base + '/status'),
            service.transport.request<any>('GET', base + '/goal'),
            service.transport.request<any>('GET', base + '/tasks')
          ])
          if (status.busy || goal?.status === 'active' || tasks.items?.some((task: any) => task.status === 'running')) throw new KimiWebError('service_busy')
        }
      } catch {
        if (services.get(key) !== flight) return
        // Unknown activity must not be converted into a process termination.
        service.timer = setTimeout(() => { void idleClose() }, 5000)
        service.timer.unref()
        return
      }
    }
    if (service.users) return
    service.closing = service.server ? service.server.closeAndWait() : service.transport.closeAndWait()
    await service.closing
    if (services.get(key) === flight) services.delete(key)
  }
  return { transport: service.transport, home, version: service.version, interactionResponses: service.interactionResponses, get replaced() { return service.replaced === true }, trackSession: id => service.sessions.add(id), release: async () => {
    if (released) return
    released = true; service.users--
    await idleClose()
  } }
}

/** Stop services UniAgent started so quitting never leaves orphaned kimi web processes. */
export async function closeKimiWebServices(): Promise<void> {
  epoch++
  const flights = [...services.values()]
  services.clear()
  await Promise.allSettled(flights.map(async flight => {
    const service = await flight.catch(() => undefined)
    if (!service) return
    if (service.timer) clearTimeout(service.timer)
    // Owned children die with their process group; borrowed user services are
    // only disconnected — their lifecycle belongs to whoever started them.
    if (service.server) await service.server.closeAndWait()
    else await service.transport.closeAndWait()
  }))
}
