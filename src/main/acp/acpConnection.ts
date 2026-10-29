import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ACPInitialize } from './acpTypes.ts'
import {
  assertACPStartAllowed, awaitACPStartup, flushACPProcessRecords, forgetACPProcesses,
  inspectACPProcess, parsePsProcess, registerACPConnection, rememberACPProcesses,
  sameProcessIdentity, signalACPProcess, unregisterACPConnection,
  type ProcessIdentity, type ProcessInspection
} from './acpProcessLifecycle.ts'

/** Default ceiling for one serialized JSON-RPC frame, in bytes. */
const ACP_MAX_FRAME_BYTES = 8 * 1024 * 1024

const ACP_PROTOCOL_VERSION = 1
const RPC_TIMEOUT_MS = 15_000
const MAX_RPC_TOMBSTONES = 256
const ACP_CLOSE_ESCALATION_MS = 500
const ACP_PROTOCOL_ERROR_FLUSH_MS = 100
const ACP_PROTOCOL_ERROR_FALLBACK_MS = 500
const ACP_PROCESS_TRACK_INTERVAL_MS = 100
const ACP_PROCESS_SWEEP_INTERVAL_MS = 50
const ACP_PROCESS_SWEEP_MIN_MS = 250
const ACP_PROCESS_SWEEP_DEADLINE_MS = 1_500
const ACP_PROCESS_SWEEP_EMPTY_SCANS = 3

export class ACPRemoteError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly remoteMessage?: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'ACPRemoteError'
  }
}
export class ACPTimeoutError extends Error {}

type JsonRpcId = number | string | null
type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method?: string
  params?: any
  result?: any
  error?: { code?: number; message?: string; data?: any }
}

export interface ACPConnectionOptions {
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  providerLabel: string
  maxFrameBytes?: number
  validateInitialize?: (value: any) => void
  authenticate?: (connection: ACPConnection, value: any) => Promise<void> | void
}

interface OwnedProcess {
  identity: ProcessIdentity
  // Preserve the greatest observed ancestry depth. A child may be reparented
  // before teardown, but it must still be signaled before its former parents.
  depth: number
}

interface ProcessTreeOwner {
  child: ChildProcessWithoutNullStreams
  uid?: number
  rootPid?: number
  rootIdentity?: ProcessIdentity
  rootPgid?: number
  rootGroupExtinct: boolean
  processes: Map<number, OwnedProcess>
  lastScanGeneration: number
  trackingTimer?: ReturnType<typeof setTimeout>
  sweepTimer?: ReturnType<typeof setTimeout>
  sweepDeadlineTimer?: ReturnType<typeof setTimeout>
  sweepStartedAt?: number
  sweepDeadline?: number
  consecutiveEmptyScans: number
  finalized: boolean
  closed: Promise<void>
  drained: Promise<boolean>
  finishDrain: (confirmed: boolean) => void
}

type ProcessScan =
  | { ok: true; processes: ProcessIdentity[] }
  | { ok: false; error: unknown }

interface SharedProcessScan {
  generation: number
  completedAt: number
  result: ProcessScan
}

// Every ACP connection observes the same kernel process table. Share both the
// in-flight enumeration and a single tracking-period snapshot so N idle
// connections never launch N copies of `ps` every 100ms. Teardown passes bypass
// the completed cache, while still joining a scan that is already in flight.
let processScanInFlight: Promise<SharedProcessScan> | undefined
let processScanInFlightGeneration: number | undefined
let processScanGeneration = 0
let lastProcessScan: SharedProcessScan | undefined

/**
 * Strict newline-delimited JSON-RPC transport for a provider's `acp` mode. ACP
 * owns stdout: one non-empty non-JSON line is a protocol violation, never
 * user-visible raw output. Stderr is diagnostic-only and retained as a bounded
 * tail. Provider identity, argv and handshake validation are injected by the
 * caller through ACPConnectionOptions.
 */
export class ACPConnection extends EventEmitter {
  private bin: string
  private args: string[]
  private cwd?: string
  private spawnEnv: NodeJS.ProcessEnv
  private providerLabel: string
  private maxFrameBytes: number
  private validateInitializeHook?: (value: any) => void
  private authenticateHook?: (connection: ACPConnection, value: any) => Promise<void> | void
  private child: ChildProcessWithoutNullStreams | null = null
  // A root may exit before descendants release inherited pipes, and callers may
  // already start a replacement generation while the old tree is still being
  // drained. ChildProcess object identity, rather than a reusable numeric PID,
  // keeps those owners and their timers isolated.
  private processTrees = new Map<ChildProcessWithoutNullStreams, ProcessTreeOwner>()
  private termination: {
    child: ChildProcessWithoutNullStreams
    timer: ReturnType<typeof setTimeout>
    deadline: number
  } | null = null
  private buffer = ''
  private bufferBytes = 0
  private nextId = 1
  private pending = new Map<
    JsonRpcId,
    {
      method: string
      resolve: (value: any) => void
      reject: (reason: Error) => void
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  // A response may legitimately arrive after a local timeout/close raced the
  // server. Remember only those known request ids; every other unknown response
  // is a strict protocol violation rather than something we silently discard.
  private tombstones = new Set<JsonRpcId>()
  private closing = false
  private failed = false
  // Never retain raw child stderr. Providers, tools, and MCP servers can print
  // credentials or user content, while transport errors become persisted UAE
  // events. A byte count is sufficient for safe diagnostics.
  private stderrBytes = 0
  private closeFlight?: Promise<void>

  constructor(options: ACPConnectionOptions)
  constructor(options: ACPConnectionOptions) {
    super()
    this.bin = options.bin
    this.args = [...options.args]
    this.cwd = options.cwd
    this.spawnEnv = { ...(options.env ?? process.env) }
    this.providerLabel = options.providerLabel
    this.maxFrameBytes = options.maxFrameBytes ?? ACP_MAX_FRAME_BYTES
    this.validateInitializeHook = options.validateInitialize
    this.authenticateHook = options.authenticate
  }

  start(): void {
    assertACPStartAllowed()
    if (this.child) return
    this.closing = false
    this.failed = false
    this.buffer = ''
    this.bufferBytes = 0
    this.stderrBytes = 0
    this.tombstones.clear()
    this.closeFlight = undefined
    const child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX, make this exact child the leader of a private process group so
      // tool and MCP descendants can be terminated with the transport. Windows
      // has no negative-pid process-group signaling, so it uses child.kill below.
      detached: process.platform !== 'win32'
    })
    this.child = child
    registerACPConnection(this)
    const processTree = this.createProcessTreeOwner(child)
    this.processTrees.set(child, processTree)
    this.captureSpawnedRoot(processTree)
    if (processTree.rootIdentity) rememberACPProcesses(processTree.rootIdentity, [...processTree.processes.values()].map(entry => entry.identity))
    child.stdin.on('error', (err) => {
      if (this.child === child && !this.closing) {
        this.fail(new Error(`${this.providerLabel} ACP stdin 失败：${err.message}`))
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child || this.closing) return
      try {
        this.onStdout(chunk)
      } catch (error) {
        // EventEmitter invokes notification/request listeners synchronously. A
        // buggy or malicious nested ACP payload must fail this transport, not
        // escape the stdout callback as an uncaught Electron main exception.
        this.fail(new Error(`${this.providerLabel} ACP 消息处理失败`))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.stderrBytes + Buffer.byteLength(chunk, 'utf8')
      )
    })
    child.on('error', (err) => {
      if (this.child === child && !this.closing) {
        this.fail(new Error(`${this.providerLabel} ACP 进程启动失败：${err.message}`))
      }
    })
    let exitResult: { code: number | null; signal: NodeJS.Signals | null; unexpected: boolean } | null = null
    child.once('exit', (code, signal) => {
      const unexpected = !this.closing && !this.failed
      exitResult = { code, signal, unexpected }
      const activeGeneration = this.child === child

      // `exit` identifies the exact generation while `close` may be delayed by
      // inherited descendant stdio. Reject owned RPCs now and begin a bounded
      // drain, but retain this generation's owner until its late-process sweeps
      // converge (or reach their deadline).
      this.clearTermination(child)
      if (activeGeneration && unexpected) this.fail(this.exitError(code, signal), false)
      this.hardKill(child)
      if (activeGeneration && this.child === child) this.child = null
    })
    child.once('close', (code, signal) => {
      // A close callback belongs to this exact ChildProcess generation. Clear
      // only its escalation timer/reference so a stale callback can never affect
      // a later process that happens to reuse the numeric PID.
      this.clearTermination(child)
      let unexpected = exitResult?.unexpected ?? (!this.closing && !this.failed)
      if (this.child === child) {
        // Spawn failures may reach `close` without a useful `exit`. Apply the
        // same exact-generation cleanup as the exit path.
        if (unexpected) this.fail(this.exitError(code, signal), false)
        this.hardKill(child)
        if (this.child === child) this.child = null
      } else if (this.processTrees.has(child)) {
        // `close` can arrive after a replacement child has started. It may only
        // advance its own retained drain and must never inspect the new child.
        this.hardKill(child)
      }
      try {
        this.emit('close', { code, signal, unexpected })
      } catch {
        // A close observer cannot make an already-terminal child callback crash
        // Electron's main process.
      }
    })
    void this.refreshProcessTree(processTree, true)
    this.scheduleProcessTracking(processTree)
  }

  async initialize(timeoutMs = RPC_TIMEOUT_MS): Promise<ACPInitialize> {
    await awaitACPStartup()
    this.start()
    await flushACPProcessRecords()
    const result = await this.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          auth: { terminal: true },
          fs: { readTextFile: false, writeTextFile: false },
          // MiniMax Code asks for structured input (the Plan-mode review)
          // through `elicitation/create`; the agent only sends it to clients
          // that declared the form capability.
          elicitation: { form: {} }
        },
        clientInfo: { name: 'UniAgent', version: '1.0.0' }
      },
      timeoutMs
    )
    this.validateInitializeHook?.(result)
    await this.authenticateHook?.(this, result)
    return result as ACPInitialize
  }

  request(method: string, params: any = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    return this.requestTracked(method, params, timeoutMs).promise
  }

  requestTracked(
    method: string,
    params: any = {},
    timeoutMs = RPC_TIMEOUT_MS
  ): { id: number; promise: Promise<any> } {
    if (!this.child || this.closing || this.failed) {
      return {
        id: this.nextId,
        promise: Promise.reject(new Error(`${this.providerLabel} ACP transport is not running`))
      }
    }
    // Keep late-response bookkeeping exact and bounded. Refuse additional wire
    // requests while every slot is occupied by an in-flight or timed-out id;
    // evicting a tombstone would make its legitimate late response
    // indistinguishable from a never-issued response and could poison an
    // unrelated turn. A consumed late response immediately frees a slot.
    if (this.pending.size + this.tombstones.size >= MAX_RPC_TOMBSTONES) {
      const error = new Error(
        `${this.providerLabel} ACP 过期响应跟踪已达上限；已终止连接以保持响应归属严格`
      )
      this.fail(error)
      return {
        id: this.nextId,
        promise: Promise.reject(error)
      }
    }
    const id = this.nextId++
    const promise = new Promise<any>((resolve, reject) => {
      const entry: {
        method: string
        resolve: (value: any) => void
        reject: (reason: Error) => void
        timer?: ReturnType<typeof setTimeout>
      } = { method, resolve, reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          this.rememberTombstone(id)
          reject(new ACPTimeoutError(`${this.providerLabel} ACP ${method} 超时`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err: any) {
        if (entry.timer) clearTimeout(entry.timer)
        this.pending.delete(id)
        this.rememberTombstone(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    return { id, promise }
  }

  notify(method: string, params: any = {}): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: JsonRpcId, result: any): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /**
   * Reject a malformed server request and briefly leave the pipe alive for the
   * JSON-RPC error to flush. Killing synchronously after write() can discard the
   * buffered response, leaving the peer with neither a protocol error nor a
   * usable connection. Local pending RPCs and UI state still fail synchronously;
   * process-tree termination follows on a short fail-safe timer.
   */
  respondErrorAndFail(id: JsonRpcId, code: number, message: string, error: Error): void {
    const child = this.child
    if (!child || child.stdin.destroyed || this.failed) {
      this.fail(error)
      return
    }

    const kill = (): void => this.hardKill(child)
    // This is the outer bound if the Writable callback never fires. Once Node
    // confirms the frame left its buffer, retain a smaller consumption window
    // so the peer can observe/log the JSON-RPC error before group teardown.
    this.scheduleHardKill(child, ACP_PROTOCOL_ERROR_FALLBACK_MS)
    try {
      const frame = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
      if (Buffer.byteLength(frame, 'utf8') > this.maxFrameBytes) {
        kill()
        this.fail(error, false)
        return
      }
      child.stdin.write(
        frame + '\n',
        (writeError?: Error | null) => {
          if (writeError) {
            kill()
            return
          }
          this.scheduleHardKill(child, ACP_PROTOCOL_ERROR_FLUSH_MS)
        }
      )
      // Keep the pipe alive for a short, bounded grace period. The local
      // transport is failed immediately, while the peer gets a deterministic
      // chance to consume the JSON-RPC error before process teardown.
      this.fail(error, false)
    } catch {
      kill()
      this.fail(error, false)
    }
  }

  close(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.closing = true
    const child = this.child
    this.rejectPending(new Error(`${this.providerLabel} ACP connection closed`), true)
    if (child) {
      if (signal === 'SIGKILL') this.hardKill(child)
      else if (this.failed && this.termination?.child === child) {
        // respondErrorAndFail() already owns a shorter hard-stop deadline so its
        // JSON-RPC error can flush. Do not replace that deadline with SIGTERM:
        // the leader could exit before the group-wide SIGKILL and orphan a
        // descendant that ignored the graceful signal.
      } else {
        void this.signalChildTree(child, signal)
        if (signal === 'SIGTERM') this.scheduleHardKill(child, ACP_CLOSE_ESCALATION_MS)
      }
    }
  }

  /** Wait for every owned generation and its descendants before releasing runtime files. */
  closeAndWait(): Promise<void> {
    if (this.closeFlight) return this.closeFlight
    const owners = [...this.processTrees.values()]
    this.close()
    this.closeFlight = new Promise<void>((resolveClose, rejectClose) => {
      const timer = setTimeout(() => {
        for (const owner of owners) this.hardKill(owner.child)
        rejectClose(new Error(`${this.providerLabel} ACP transport did not close`))
      }, 3000)
      void Promise.all(owners.map(async owner => {
        const [, confirmed] = await Promise.all([owner.closed, owner.drained])
        if (!confirmed) throw new Error(`${this.providerLabel} ACP 子进程清理未完成`)
      })).then(() => { clearTimeout(timer); resolveClose() }, error => { clearTimeout(timer); rejectClose(error) })
    })
    return this.closeFlight
  }

  get diagnosticTail(): string {
    return this.stderrBytes > 0
      ? `${this.providerLabel} ACP stderr 已隐藏（${this.stderrBytes} 字节）`
      : ''
  }

  protocolViolation(error: Error): void {
    this.fail(error)
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child || this.closing || this.child.stdin.destroyed || this.failed) {
      throw new Error(`${this.providerLabel} ACP stdin is unavailable`)
    }
    const frame = JSON.stringify(message)
    const frameBytes = Buffer.byteLength(frame, 'utf8')
    if (frameBytes > this.maxFrameBytes) {
      throw new Error(`${this.providerLabel} ACP 出站 JSON-RPC 帧超过 ${this.maxFrameBytes} 字节上限`)
    }
    this.child.stdin.write(frame + '\n')
  }

  private onStdout(chunk: string): void {
    if (this.failed) return
    let offset = 0
    while (offset < chunk.length) {
      const nl = chunk.indexOf('\n', offset)
      const end = nl >= 0 ? nl : chunk.length
      const fragment = chunk.slice(offset, end)
      const nextBytes = this.bufferBytes + Buffer.byteLength(fragment, 'utf8')
      if (nextBytes > this.maxFrameBytes) {
        this.buffer = ''
        this.bufferBytes = 0
        this.fail(
          new Error(
            `${this.providerLabel} ACP JSON-RPC 帧超过 ${this.maxFrameBytes} 字节上限`
          )
        )
        return
      }
      this.buffer += fragment
      this.bufferBytes = nextBytes
      if (nl < 0) return

      const line = this.buffer
      this.buffer = ''
      this.bufferBytes = 0
      if (line.trim()) this.onLine(line)
      if (this.failed) return
      offset = nl + 1
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(
        new Error(
          `${this.providerLabel} ACP stdout 污染（非 JSON-RPC，${Buffer.byteLength(line, 'utf8')} 字节）`
        )
      )
      return
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      this.fail(new Error(`${this.providerLabel} ACP 返回了无效 JSON-RPC 消息`))
      return
    }

    const hasMethod = Object.prototype.hasOwnProperty.call(message, 'method')
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    const hasParams = Object.prototype.hasOwnProperty.call(message, 'params')
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error')
    const responseId = message.id
    if (hasId && !isJsonRpcId(responseId)) {
      this.fail(new Error(`${this.providerLabel} ACP 返回了无效 JSON-RPC id`))
      return
    }
    if (hasMethod) {
      if (
        typeof message.method !== 'string' ||
        !message.method ||
        hasResult ||
        hasError ||
        (hasParams && !isJsonRpcParams(message.params))
      ) {
        this.fail(new Error(`${this.providerLabel} ACP 返回了无效请求/通知`))
        return
      }
      if (hasId) this.emit('request', message)
      else this.emit('notification', message)
      return
    }
    if (!hasId) {
      this.fail(new Error(`${this.providerLabel} ACP 返回了没有 id/method 的 JSON-RPC 消息`))
      return
    }
    if (hasResult === hasError || (hasError && !isJsonRpcError(message.error))) {
      this.fail(new Error(`${this.providerLabel} ACP 返回了无效响应`))
      return
    }
    // `hasId` plus the validation above proves this is a concrete JSON-RPC id.
    // Keep the narrowed local value: an optional object property is not stable
    // enough for TypeScript to retain that narrowing across the branches above.
    if (!isJsonRpcId(responseId)) {
      this.fail(new Error(`${this.providerLabel} ACP 返回了无效 JSON-RPC id`))
      return
    }
    const pending = this.pending.get(responseId)
    if (!pending) {
      if (this.tombstones.delete(responseId)) {
        return
      }
      // This connection only ever issues integer ids (nextId++). A response
      // carrying a string or null id is provably foreign traffic the provider
      // leaked onto the wire — Grok 1.0.34 emits internal-bus responses such as
      // "skills-reload" on stdout — so drop it instead of failing the session.
      // Unknown numeric ids stay fatal: they cannot be told apart from broken
      // late-response bookkeeping, where attribution must fail closed.
      if (typeof responseId !== 'number') {
        return
      }
      this.fail(new Error(`${this.providerLabel} ACP 返回了未知 JSON-RPC 响应 id`))
      return
    }
    this.pending.delete(responseId)
    if (pending.timer) clearTimeout(pending.timer)
    try {
      this.emit('responseSettled', { id: responseId, method: pending.method })
    } catch (error) {
      const callbackError = new Error(`${this.providerLabel} ACP 响应处理失败`)
      pending.reject(callbackError)
      this.fail(callbackError)
      return
    }
    if (message.error) {
      pending.reject(
        new ACPRemoteError(
          `${this.providerLabel} ACP ${pending.method} 被远端拒绝（code=${String(message.error.code ?? 'unknown')}）：${message.error.message || 'unknown error'}`,
          message.error.code,
          message.error.message,
          message.error.data
        )
      )
    } else {
      pending.resolve(message.result)
    }
  }

  private fail(error: Error, killChild = true): void {
    if (this.failed) return
    this.failed = true
    this.buffer = ''
    this.bufferBytes = 0
    this.rejectPending(error)
    const child = this.child
    try {
      this.emit('protocolError', error)
    } catch {
      // The transport is already failed and all owned RPCs are rejected. Never
      // let a consumer callback turn a protocol failure into a process crash.
    }
    if (child && killChild) this.hardKill(child)
  }

  private scheduleHardKill(child: ChildProcessWithoutNullStreams, delayMs: number): void {
    if (!this.ownsRunningChild(child)) return
    const deadline = Date.now() + delayMs
    if (
      this.termination?.child === child &&
      this.termination.deadline <= deadline
    ) {
      return
    }
    this.clearTermination()
    const timer = setTimeout(() => {
      if (this.termination?.child !== child) return
      this.termination = null
      this.hardKill(child)
    }, delayMs)
    timer.unref?.()
    this.termination = { child, timer, deadline }
  }

  private hardKill(child: ChildProcessWithoutNullStreams): void {
    this.clearTermination(child)
    const owner = this.processTrees.get(child)
    if (owner) {
      this.beginProcessSweep(owner)
      return
    }
    if (this.ownsRunningChild(child)) child.kill('SIGKILL')
  }

  private async signalChildTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals
  ): Promise<void> {
    const owner = this.processTrees.get(child)
    if (!owner || owner.finalized) return
    if (process.platform === 'win32') {
      if (this.ownsRunningChild(child)) child.kill(signal)
      return
    }
    // Signal remembered identities promptly while a fresh enumeration looks for
    // descendants created since the most recent tracking snapshot.
    const refresh = this.refreshProcessTree(owner, true)
    await this.signalOwnedProcesses(owner, signal)
    await refresh
    if (owner.finalized || (signal !== 'SIGKILL' && owner.sweepStartedAt !== undefined)) return
    await this.signalOwnedProcesses(owner, signal)
  }

  /**
   * Build a generation-scoped owner before any asynchronous child event can
   * fire. The first synchronous snapshot binds the numeric spawn pid to its uid,
   * start time, and the private process group created by detached spawn.
   */
  private createProcessTreeOwner(
    child: ChildProcessWithoutNullStreams
  ): ProcessTreeOwner {
    const rootPid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : undefined
    let finishDrain!: (confirmed: boolean) => void
    const drained = new Promise<boolean>(resolve => { finishDrain = resolve })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    return {
      child,
      uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
      rootPid,
      // POSIX detached spawn makes the child a new session and process-group
      // leader, so its initial pgid must equal its exact spawn pid. Do not use
      // this expected value until a uid/start-time snapshot verifies the root.
      rootPgid: process.platform === 'win32' ? undefined : rootPid,
      rootGroupExtinct: false,
      processes: new Map(),
      // A scan that started before this generation was spawned cannot prove its
      // private process group empty. The first refresh must use a newer snapshot.
      lastScanGeneration: processScanGeneration,
      consecutiveEmptyScans: 0,
      finalized: false,
      closed, drained, finishDrain
    }
  }

  /**
   * Bind the spawn result to immutable kernel metadata immediately. Failure is
   * deliberately fail-closed: without an exact root identity we may signal the
   * ChildProcess handle, but never infer ownership from a reusable numeric pid.
   */
  private captureSpawnedRoot(owner: ProcessTreeOwner): void {
    if (
      process.platform === 'win32' ||
      owner.uid === undefined ||
      owner.rootPid === undefined ||
      owner.rootPgid === undefined ||
      !this.ownsRunningChild(owner.child)
    ) {
      return
    }
    const inspected = this.inspectProcessSync(owner.rootPid)
    if (
      !inspected.ok ||
      !inspected.process ||
      inspected.process.uid !== owner.uid ||
      inspected.process.pgid !== owner.rootPgid ||
      !this.ownsRunningChild(owner.child)
    ) {
      return
    }
    owner.rootIdentity = inspected.process
    this.mergeOwnedProcess(owner, inspected.process, 0)
  }

  /**
   * Return one same-uid process-table snapshot. Keeping failures explicit is
   * essential: a failed `ps` is not evidence that a process tree is empty.
   */
  private scanProcesses(
    afterGeneration = -1,
    allowRecent = true
  ): Promise<SharedProcessScan> {
    const getuid = process.getuid
    if (typeof getuid !== 'function') {
      return Promise.resolve({
        generation: processScanGeneration,
        completedAt: Date.now(),
        result: { ok: true, processes: [] }
      })
    }
    const requestedAt = Date.now()
    if (
      allowRecent &&
      lastProcessScan &&
      requestedAt - lastProcessScan.completedAt < ACP_PROCESS_TRACK_INTERVAL_MS
    ) {
      return Promise.resolve(lastProcessScan)
    }
    if (processScanInFlight) {
      const inFlight = processScanInFlight
      if ((processScanInFlightGeneration ?? 0) > afterGeneration) return inFlight
      return inFlight.then(() => this.scanProcesses(afterGeneration, false))
    }

    const uid = getuid()
    const generation = ++processScanGeneration
    // Never request argv or environment columns here: those fields can expose
    // ambient same-uid process secrets. The five metadata fields below are
    // sufficient to establish immutable identities and ancestry.
    const scanPromise = new Promise<ProcessScan>((resolveScan) => {
      execFile(
        '/bin/ps',
        ['-axo', 'pid=,ppid=,uid=,pgid=,lstart='],
        {
          encoding: 'utf8',
          env: { LC_ALL: 'C' },
          maxBuffer: 16 * 1024 * 1024,
          timeout: 1_000
        },
        (error, stdout) => {
          if (error) {
            resolveScan({ ok: false, error })
            return
          }
          try {
            const processes: ProcessIdentity[] = []
            for (const line of stdout.split('\n')) {
              if (!line.trim()) continue
              const parsed = parsePsProcess(line)
              // A successful `ps` exit with an unparseable non-empty row is still
              // unusable enumeration, not evidence that an owner's tree is empty.
              if (!parsed) {
                resolveScan({ ok: false, error: new Error('无法解析进程表') })
                return
              }
              if (parsed.uid === uid) processes.push(parsed)
            }
            resolveScan({ ok: true, processes })
          } catch (error) {
            resolveScan({ ok: false, error })
          }
        }
      )
    })
    const shared = scanPromise.then((result) => ({ generation, completedAt: Date.now(), result }))
    processScanInFlight = shared
    processScanInFlightGeneration = generation
    void shared.then(
      (snapshot) => {
        lastProcessScan = snapshot
        if (processScanInFlight === shared) {
          processScanInFlight = undefined
          processScanInFlightGeneration = undefined
        }
      },
      () => {
        if (processScanInFlight === shared) {
          processScanInFlight = undefined
          processScanInFlightGeneration = undefined
        }
      }
    )
    return shared
  }

  /**
   * Bind the just-spawned leader before it can exit or its numeric pid can be
   * reused. This is the sole synchronous process lookup; all recurring and
   * teardown inspection runs asynchronously.
   */
  private inspectProcessSync(pid: number): ProcessInspection {
    try {
      const output = execFileSync(
        '/bin/ps',
        ['-p', String(pid), '-o', 'pid=,ppid=,uid=,pgid=,lstart='],
        {
          encoding: 'utf8',
          env: { LC_ALL: 'C' },
          maxBuffer: 64 * 1024,
          timeout: 500
        }
      )
      let found: ProcessIdentity | undefined
      for (const line of output.split('\n')) {
        if (!line.trim()) continue
        const parsed = parsePsProcess(line)
        if (!parsed) return { ok: false, error: new Error(`无法解析 ${this.providerLabel} 进程身份`) }
        if (parsed.pid === pid) found = parsed
      }
      return { ok: true, process: found }
    } catch (error: any) {
      // Darwin `ps -p` exits 1 with no row when the pid disappeared between the
      // snapshot and inspection. Other failures remain failures, not absence.
      if (error?.status === 1 && !String(error?.stdout || '').trim()) {
        return { ok: true }
      }
      return { ok: false, error }
    }
  }

  /** Inspect one pid asynchronously; absence and `ps` failure differ. */
  private inspectProcess(pid: number): Promise<ProcessInspection> { return inspectACPProcess(pid) }

  private refreshProcessTree(owner: ProcessTreeOwner, forceFresh = false): Promise<ProcessScan> {
    if (owner.finalized || process.platform === 'win32' || owner.uid === undefined) {
      return Promise.resolve({ ok: true, processes: [] })
    }
    const refresh = this.scanProcesses(
      forceFresh ? owner.lastScanGeneration : -1,
      !forceFresh
    ).then((snapshot) => {
      const scan = snapshot.result
      if (owner.finalized || !scan.ok) return scan
      owner.lastScanGeneration = Math.max(owner.lastScanGeneration, snapshot.generation)

      const liveByPid = new Map(scan.processes.map((entry) => [entry.pid, entry]))
      for (const [pid, owned] of owner.processes) {
        const live = liveByPid.get(pid)
        if (!live || !sameProcessIdentity(live, owned.identity) || live.uid !== owner.uid) {
          owner.processes.delete(pid)
        } else {
          // Parentage and process groups can legitimately change after spawn; the
          // immutable pid/uid/start tuple remains the generation identity. Keep
          // the historical depth separately for leaf-first teardown after reparent.
          owned.identity = live
        }
      }

      const root = owner.rootPid === undefined ? undefined : liveByPid.get(owner.rootPid)
      if (
        !owner.rootIdentity &&
        root &&
        root.uid === owner.uid &&
        owner.rootPgid !== undefined &&
        root.pgid === owner.rootPgid &&
        this.ownsRunningChild(owner.child)
      ) {
        owner.rootIdentity = root
      }
      if (root && owner.rootIdentity && sameProcessIdentity(root, owner.rootIdentity)) {
        this.mergeOwnedProcess(owner, root, 0)
      }

      // The verified leader's detached group is private to its new session. It
      // catches children that outlive/reparent away from the leader without ever
      // inspecting argv or environment. Once a successful snapshot proves that
      // group empty it can never acquire members again; permanently retire the
      // numeric pgid so later pgid reuse cannot create false ownership.
      if (owner.rootIdentity && owner.rootPgid !== undefined && !owner.rootGroupExtinct) {
        const group = scan.processes.filter(
          (entry) => entry.pid !== process.pid && entry.pgid === owner.rootPgid
        )
        if (group.length === 0) {
          // A successful snapshot proving the verified leader's private process
          // group empty is the only safe retirement boundary. In particular, the
          // leader may exit before the first periodic sweep observes a child; a
          // non-empty group in that first sweep is still owned and must be merged.
          owner.rootGroupExtinct = true
        } else {
          for (const entry of group) {
            this.mergeOwnedProcess(
              owner,
              entry,
              this.observedProcessDepth(entry, liveByPid, owner.rootPid)
            )
          }
        }
      }

      // Repeated ancestry closure discovers descendants that deliberately create
      // another session/group or scrub their entire environment. Their immutable
      // identities stay owned after a later reparent or leader exit.
      const ownedPids = new Set(owner.processes.keys())
      let added = true
      while (added) {
        added = false
        for (const entry of scan.processes) {
          if (entry.pid === process.pid || ownedPids.has(entry.pid) || !ownedPids.has(entry.ppid)) {
            continue
          }
          const parentDepth = owner.processes.get(entry.ppid)?.depth ?? 0
          this.mergeOwnedProcess(owner, entry, parentDepth + 1)
          ownedPids.add(entry.pid)
          added = true
        }
      }
      if (owner.rootIdentity) rememberACPProcesses(owner.rootIdentity, [...owner.processes.values()].map(entry => entry.identity))
      return scan
    }).catch((error): ProcessScan => ({ ok: false, error }))
    return refresh
  }

  private mergeOwnedProcess(
    owner: ProcessTreeOwner,
    identity: ProcessIdentity,
    depth: number
  ): void {
    const current = owner.processes.get(identity.pid)
    if (current && sameProcessIdentity(current.identity, identity)) {
      current.identity = identity
      current.depth = Math.max(current.depth, depth)
      return
    }
    owner.processes.set(identity.pid, { identity, depth })
  }

  private observedProcessDepth(
    identity: ProcessIdentity,
    liveByPid: Map<number, ProcessIdentity>,
    rootPid: number | undefined
  ): number {
    let depth = 0
    let cursor = identity
    const seen = new Set<number>([cursor.pid])
    while (cursor.pid !== rootPid && !seen.has(cursor.ppid)) {
      const parent = liveByPid.get(cursor.ppid)
      if (!parent) break
      depth += 1
      cursor = parent
      seen.add(cursor.pid)
    }
    return identity.pid === rootPid ? 0 : Math.max(1, depth)
  }

  private scheduleProcessTracking(owner: ProcessTreeOwner): void {
    if (owner.finalized || owner.sweepStartedAt !== undefined || process.platform === 'win32') return
    if (owner.trackingTimer) clearTimeout(owner.trackingTimer)
    const timer = setTimeout(() => {
      owner.trackingTimer = undefined
      if (owner.finalized || owner.sweepStartedAt !== undefined) return
      void this.trackProcessTree(owner)
    }, ACP_PROCESS_TRACK_INTERVAL_MS)
    timer.unref?.()
    owner.trackingTimer = timer
  }

  private async trackProcessTree(owner: ProcessTreeOwner): Promise<void> {
    await this.refreshProcessTree(owner)
    if (owner.finalized || owner.sweepStartedAt !== undefined) return
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
      this.beginProcessSweep(owner)
    } else {
      this.scheduleProcessTracking(owner)
    }
  }

  private beginProcessSweep(owner: ProcessTreeOwner): void {
    if (owner.finalized) return
    if (process.platform === 'win32') {
      if (this.ownsRunningChild(owner.child)) owner.child.kill('SIGKILL')
      this.finalizeProcessTree(owner, true)
      return
    }
    if (owner.sweepStartedAt !== undefined) return
    if (owner.trackingTimer) clearTimeout(owner.trackingTimer)
    owner.trackingTimer = undefined
    owner.sweepStartedAt = Date.now()
    owner.sweepDeadline = owner.sweepStartedAt + ACP_PROCESS_SWEEP_DEADLINE_MS
    owner.consecutiveEmptyScans = 0
    const deadlineTimer = setTimeout(
      () => this.finalizeProcessTree(owner),
      ACP_PROCESS_SWEEP_DEADLINE_MS
    )
    deadlineTimer.unref?.()
    owner.sweepDeadlineTimer = deadlineTimer
    // Do not make the first kill attempt wait for a full-table enumeration.
    // Remembered identities (including the root) can be revalidated in parallel
    // while a fresh scan looks for descendants that appeared since tracking.
    void this.signalOwnedProcesses(owner, 'SIGKILL')
    this.runProcessSweep(owner)
  }

  private runProcessSweep(owner: ProcessTreeOwner): void {
    if (owner.finalized || owner.sweepStartedAt === undefined || owner.sweepDeadline === undefined) return
    owner.sweepTimer = undefined
    void this.performProcessSweep(owner)
  }

  private async performProcessSweep(owner: ProcessTreeOwner): Promise<void> {
    if (owner.finalized || owner.sweepStartedAt === undefined || owner.sweepDeadline === undefined) return
    const scan = await this.refreshProcessTree(owner, true)
    if (owner.finalized) return
    if (scan.ok) {
      if (owner.processes.size === 0) {
        owner.consecutiveEmptyScans += 1
      } else {
        owner.consecutiveEmptyScans = 0
        await this.signalOwnedProcesses(owner, 'SIGKILL')
      }
    } else {
      // A failed scan breaks the required run of consecutive successful empty
      // snapshots. Revalidate and kill remembered identities best-effort.
      owner.consecutiveEmptyScans = 0
      await this.signalOwnedProcesses(owner, 'SIGKILL')
    }

    if (owner.finalized) return
    const now = Date.now()
    if (
      now >= owner.sweepDeadline ||
      (now - owner.sweepStartedAt >= ACP_PROCESS_SWEEP_MIN_MS &&
        owner.consecutiveEmptyScans >= ACP_PROCESS_SWEEP_EMPTY_SCANS)
    ) {
      this.finalizeProcessTree(owner, now < owner.sweepDeadline && owner.consecutiveEmptyScans >= ACP_PROCESS_SWEEP_EMPTY_SCANS)
      return
    }
    const delayMs = Math.min(ACP_PROCESS_SWEEP_INTERVAL_MS, owner.sweepDeadline - now)
    const timer = setTimeout(() => this.runProcessSweep(owner), Math.max(0, delayMs))
    timer.unref?.()
    owner.sweepTimer = timer
  }

  /** Signal tracked leaves before the exact root/group on every teardown pass. */
  private async signalOwnedProcesses(
    owner: ProcessTreeOwner,
    signal: NodeJS.Signals
  ): Promise<void> {
    const rootPid = owner.rootIdentity?.pid
    const leaves = [...owner.processes.values()]
      .filter((owned) => owned.identity.pid !== rootPid)
      .sort((left, right) =>
        right.depth - left.depth ||
        right.identity.pid - left.identity.pid
      )
    const rootOwned = rootPid === undefined ? undefined : owner.processes.get(rootPid)
    const owned = rootOwned ? [...leaves, rootOwned] : leaves
    const inspectedByPid = new Map(
      await Promise.all(
        owned.map(async (entry) => [
          entry.identity.pid,
          await this.inspectProcess(entry.identity.pid)
        ] as const)
      )
    )
    if (owner.finalized || (signal !== 'SIGKILL' && owner.sweepStartedAt !== undefined)) return

    for (const entry of leaves) {
      this.signalOwnedProcess(owner, entry, signal, inspectedByPid.get(entry.identity.pid))
    }

    let groupSignaled = false
    if (
      rootPid !== undefined &&
      rootOwned &&
      owner.rootIdentity &&
      owner.rootPgid !== undefined &&
      !owner.rootGroupExtinct
    ) {
      const inspected = inspectedByPid.get(rootPid)
      if (
        inspected?.ok &&
        inspected.process &&
        sameProcessIdentity(inspected.process, owner.rootIdentity) &&
        inspected.process.uid === owner.uid &&
        inspected.process.pgid === owner.rootPgid
      ) {
        try {
          process.kill(-owner.rootPgid, signal)
          groupSignaled = true
        } catch (error: any) {
          if (error?.code !== 'ESRCH') {
            // The positive-root fallback below remains identity checked.
          }
        }
      }
      if (!groupSignaled) {
        this.signalOwnedProcess(owner, rootOwned, signal, inspected)
      }
    } else if (this.ownsRunningChild(owner.child)) {
      // A process that exits before the initial ps snapshot cannot safely own a
      // negative process-group signal. ChildProcess.kill is the narrow fallback.
      owner.child.kill(signal)
    }
  }

  private signalOwnedProcess(
    owner: ProcessTreeOwner,
    owned: OwnedProcess,
    signal: NodeJS.Signals,
    inspected: ProcessInspection | undefined
  ): boolean {
    if (inspected?.ok && inspected.process?.uid !== owner.uid) return false
    return signalACPProcess(owned.identity, inspected, signal)
  }

  private finalizeProcessTree(owner: ProcessTreeOwner, confirmed = false): void {
    if (owner.finalized) return
    owner.finalized = true
    if (owner.trackingTimer) clearTimeout(owner.trackingTimer)
    if (owner.sweepTimer) clearTimeout(owner.sweepTimer)
    if (owner.sweepDeadlineTimer) clearTimeout(owner.sweepDeadlineTimer)
    owner.trackingTimer = undefined
    owner.sweepTimer = undefined
    owner.sweepDeadlineTimer = undefined
    owner.processes.clear()
    if (confirmed && owner.rootIdentity) forgetACPProcesses(owner.rootIdentity)
    owner.finishDrain(confirmed)
    void owner.closed.then(() => {
      if (this.processTrees.get(owner.child) === owner) this.processTrees.delete(owner.child)
      if (!this.child && !this.processTrees.size) unregisterACPConnection(this)
    })
  }

  private ownsRunningChild(child: ChildProcessWithoutNullStreams): boolean {
    return (
      this.child === child &&
      child.exitCode === null &&
      child.signalCode === null
    )
  }

  private clearTermination(child?: ChildProcessWithoutNullStreams): void {
    if (!this.termination || (child && this.termination.child !== child)) return
    clearTimeout(this.termination.timer)
    this.termination = null
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const trailingBytes = this.bufferBytes
    return new Error(
      trailingBytes > 0
        ? `${this.providerLabel} ACP stdout 污染（未终止的 JSON-RPC 帧，${trailingBytes} 字节）`
        : `${this.providerLabel} ACP 意外退出（code=${String(code)}, signal=${String(signal)}, stderrBytes=${this.stderrBytes}）`
    )
  }

  private rejectPending(error: Error, tombstone = false): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      if (tombstone) this.rememberTombstone(id)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private rememberTombstone(id: JsonRpcId): void {
    if (this.tombstones.size < MAX_RPC_TOMBSTONES) this.tombstones.add(id)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  // JSON-RPC permits strings, numbers, and null (the latter is normally used
  // when an error response cannot identify its request). ACP's generated SDK
  // narrows numeric ids to integers, so reject lossy/fractional JS numbers.
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
}

function isJsonRpcError(value: unknown): value is { code: number; message: string; data?: any } {
  return (
    isRecord(value) &&
    typeof value.code === 'number' &&
    Number.isFinite(value.code) &&
    Number.isInteger(value.code) &&
    typeof value.message === 'string'
  )
}

function isJsonRpcParams(value: unknown): value is Record<string, any> | any[] {
  return Array.isArray(value) || isRecord(value)
}
