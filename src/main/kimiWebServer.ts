import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { KimiWebError, KimiWebTransport } from './kimiWebTransport'
import { awaitACPStartup, forgetACPProcesses, inspectACPProcess, inspectACPProcessGroup, rememberACPProcesses, sameProcessIdentity, stopACPProcessGroup, type ProcessIdentity } from './acp/acpProcessLifecycle.ts'

/** Connect only to an authenticated official loopback service in the selected home. */
export async function connectKimiWebServer(origin: string, home: string, timeoutMs?: number): Promise<KimiWebTransport> {
  let token: string
  try {
    const file = join(home, 'server.token')
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || await realpath(file) !== join(await realpath(home), 'server.token')) throw new Error('unsafe token')
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size < 1 || opened.size > 4096 || (opened.mode & 0o077) !== 0 || process.getuid && opened.uid !== process.getuid()) throw new Error('unsafe token')
      token = (await handle.readFile('utf8')).trim()
    } finally { await handle.close() }
  } catch { throw new KimiWebError('token_unreadable') }
  const transport = new KimiWebTransport({ origin, token, timeoutMs })
  try {
    const meta = await transport.request<any>('GET', '/api/v1/meta')
    // The instance registry and /api/v1/meta generate their server_id values
    // independently in the official CLI, so they are never compared. The token
    // handshake and the pid-to-port binding in discovery establish identity.
    if (meta.dangerous_bypass_auth !== false || meta.backend !== 'v2') throw new KimiWebError('server_identity_invalid')
    return transport
  } catch (error) { await transport.closeAndWait(); throw error }
}

/** Owns one web child; account queries and native sessions share its lifecycle. */
export class KimiWebServer {
  private child?: ChildProcessWithoutNullStreams
  private childExit?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private identity?: ProcessIdentity
  private processes: ProcessIdentity[] = []
  private groupExtinct = false
  get alive(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null }
  transport?: KimiWebTransport

  private constructor(private readonly options: {
    bin: string
    cwd: string
    env: NodeJS.ProcessEnv
    argsPrefix?: string[]
    timeoutMs?: number
    onUnexpectedExit?(): void
  }) {}

  static async start(options: KimiWebServer['options']): Promise<KimiWebServer> {
    await awaitACPStartup()
    const server = new KimiWebServer(options)
    try {
      const origin = await server.launch()
      server.transport = await connectKimiWebServer(origin, options.env.KIMI_CODE_HOME!, options.timeoutMs)
      await server.captureProcesses()
      return server
    } catch (error) { await server.closeAndWait(); throw error }
  }

  private async launch(): Promise<string> {
    const child = spawn(this.options.bin, [...(this.options.argsPrefix || []), 'web', '--port', '0', '--host', '127.0.0.1', '--no-open', '--log-level', 'info'], {
      cwd: this.options.cwd, env: this.options.env, stdio: 'pipe', detached: process.platform !== 'win32'
    })
    this.child = child
    this.childExit = new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    child.once('exit', () => { if (!this.closed && this.transport) this.options.onUnexpectedExit?.() })
    // The startup banner and provider logs can contain secrets. Never retain or emit them.
    child.stderr.on('data', () => {})
    const ready = new Promise<string>((resolve, reject) => {
      let ready = ''
      let settled = false
      const timer = setTimeout(() => done(new KimiWebError('startup_timeout')), this.options.timeoutMs ?? 20_000)
      const done = (error?: Error, origin?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer); ready = ''; child.stdout.removeListener('data', onData)
        child.stdout.on('data', () => {})
        if (error) reject(error); else resolve(origin!)
      }
      const onData = (chunk: Buffer): void => {
        ready = (ready + chunk.toString('utf8')).slice(-8192)
        const match = /Kimi server: (http:\/\/127\.0\.0\.1:(\d+))(?=[/#\s])/.exec(ready)
        if (!match) return
        const port = Number(match[2])
        if (port < 1 || port > 65535) return done(new KimiWebError('startup_port_invalid'))
        done(undefined, match[1])
      }
      child.stdout.on('data', onData)
      child.once('error', () => done(new KimiWebError('spawn')))
      child.once('exit', () => done(new KimiWebError('process_exited')))
    })
    void ready.catch(() => {})
    if (process.platform !== 'win32' && child.pid) {
      const inspected = await inspectACPProcess(child.pid)
      if (!inspected.ok || !inspected.process || inspected.process.ppid !== process.pid || inspected.process.uid !== process.getuid?.() || inspected.process.pgid !== child.pid) throw new KimiWebError('server_source_unverified')
      this.identity = inspected.process
      await this.captureProcesses()
    }
    return ready
  }

  private async captureProcesses(): Promise<void> {
    if (!this.identity || this.groupExtinct) return
    const group = await inspectACPProcessGroup(this.identity.pgid)
    const root = group.find(entry => entry.pid === this.identity!.pid)
    if (root && !sameProcessIdentity(root, this.identity)) throw new KimiWebError('server_source_unverified')
    if (!group.length) { this.groupExtinct = true; return }
    if (!root && !group.some(entry => this.processes.some(known => sameProcessIdentity(entry, known)))) throw new KimiWebError('server_source_unverified')
    const known = new Map(this.processes.map(entry => [entry.pid, entry]))
    for (const entry of group) if (entry.uid === this.identity.uid && entry.pid !== process.pid) known.set(entry.pid, entry)
    this.processes = [...known.values()]
    rememberACPProcesses(this.identity, this.processes)
  }

  closeAndWait(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const closing = (async () => {
      await this.transport?.closeAndWait()
      const child = this.child
      if (!child?.pid) return
      if (process.platform === 'win32') {
        if (!this.alive) return
        child.kill('SIGTERM')
        const timer = setTimeout(() => { if (this.alive) child.kill('SIGKILL') }, 1500)
        try { await this.childExit } finally { clearTimeout(timer) }
        return
      }
      if (!this.identity) {
        // ChildProcess still owns an un-reaped PID; never infer ownership from a registry file.
        if (this.alive) { child.kill('SIGKILL'); await this.childExit }
        return
      }
      try { await this.captureProcesses(); await stopACPProcessGroup(this.identity, this.processes) }
      catch { throw new KimiWebError('shutdown_incomplete') }
      await this.childExit
      forgetACPProcesses(this.identity)
    })()
    this.closing = closing
    void closing.catch(() => { if (this.closing === closing) this.closing = undefined })
    return closing
  }
}
