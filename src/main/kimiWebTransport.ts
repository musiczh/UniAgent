import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { KimiWebTranscriptState, projectKimiWebTask } from './kimiWebTranscriptState.ts'

/** Remote messages may contain provider credentials or private prompt content. */
export class KimiWebError extends Error {
  recovered = false
  constructor(readonly kind: string, readonly code?: number) {
    super(`kimi_web_${kind}${code === undefined ? '' : `: ${code}`}`)
    this.name = 'KimiWebError'
  }
}

export function isKimiWebServiceFailure(error: unknown): error is KimiWebError {
  return error instanceof KimiWebError && (['connection', 'request_aborted', 'hello_timeout', 'stream_connection', 'stream_timeout'].includes(error.kind)
    || error.kind === 'http' && (error.code || 0) >= 500)
}

export interface KimiWebFrame {
  type: string
  session_id?: string
  seq?: number
  epoch?: string
  volatile?: boolean
  offset?: number
  payload: any
  timestamp?: string
}
export interface KimiWebSnapshot {
  as_of_seq: number
  epoch: string
  [key: string]: unknown
}
export interface KimiWebStreamHandlers {
  onEvent(frame: KimiWebFrame): void | Promise<void>
  onSnapshot?(snapshot: KimiWebSnapshot): void | Promise<void>
  onError?(error: KimiWebError): void
}
export interface KimiWebSubscription { closeAndWait(): Promise<void> }

export class KimiWebTransport {
  onFailure?: (error: KimiWebError) => Promise<boolean>
  transcriptProtocol = false
  turnsProtocol = false
  private readonly origin: string
  private readonly token: string
  readonly timeoutMs: number
  private readonly requests = new Set<AbortController>()
  private readonly streams = new Set<KimiWebStream>()
  private readonly stateStreams = new Map<string, Promise<KimiWebStream>>()
  private closed = false

  constructor(options: { origin: string; token: string; timeoutMs?: number }) {
    const url = new URL(options.origin)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new KimiWebError('loopback_origin_required')
    if (!options.token || /[\r\n]/.test(options.token)) throw new KimiWebError('token_invalid')
    this.origin = url.origin
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, acceptedCodes: readonly number[] = [0]): Promise<T> {
    const session = method === 'GET' && this.transcriptProtocol && path.match(/^\/api\/v1\/sessions\/([^/]+)\/(status|snapshot)$/)
    if (session) {
      try {
        const stream = await this.stateStream(decodeURIComponent(session[1]))
        await stream.refreshState()
        return (session[2] === 'status' ? stream.state!.status() : stream.state!.snapshot()) as T
      } catch (error) {
        if (error instanceof KimiWebError) error.recovered = await this.recoverFailure(error)
        throw error
      }
    }
    const value = await this.fetchJson(method, path, body)
    if (!isObject(value) || !Number.isInteger(value.code) || !Object.hasOwn(value, 'data')) throw new KimiWebError('protocol')
    if (!acceptedCodes.includes(value.code as number)) throw new KimiWebError('remote', value.code as number)
    return value.data as T
  }

  async specification(path: '/openapi.json' | '/asyncapi.json'): Promise<Record<string, any>> {
    const value = await this.fetchJson('GET', path)
    if (!isObject(value)) throw new KimiWebError('specification_invalid')
    if (path === '/openapi.json') {
      this.turnsProtocol = !!(value as any).paths?.['/api/v1/sessions/{session_id}/agents/{agent_id}/turns']?.get
      this.transcriptProtocol = this.turnsProtocol || !!(value as any).paths?.['/api/v1/sessions/{session_id}/transcript/ops']?.get
        && !(value as any).paths?.['/api/v1/sessions/{session_id}/snapshot']?.get
    }
    return value
  }

  /** Independent local check: a slow session or an upstream model error is not a dead host. */
  async checkHealth(): Promise<void> {
    const probe = new KimiWebTransport({ origin: this.origin, token: this.token, timeoutMs: Math.min(this.timeoutMs, 3000) })
    try {
      const meta = await probe.request<any>('GET', '/api/v1/meta')
      if (meta.backend !== 'v2' || meta.dangerous_bypass_auth !== false) throw new KimiWebError('server_identity_invalid')
    } finally { await probe.closeAndWait() }
  }

  async recoverFailure(error: KimiWebError): Promise<boolean> {
    if (this.closed || !isKimiWebServiceFailure(error)) return false
    return await this.onFailure?.(error) || false
  }

  private async fetchJson(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.closed) throw new KimiWebError('closed')
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path)) throw new KimiWebError('path_invalid')
    const controller = new AbortController()
    this.requests.add(controller)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.origin + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) throw new KimiWebError('http', response.status)
      // Read incrementally so tool output cannot allocate unbounded memory.
      const reader = response.body?.getReader()
      if (!reader) throw new KimiWebError('protocol')
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new KimiWebError('response_too_large') }
        chunks.push(next.value)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new KimiWebError('protocol') }
    } catch (error) {
      const failure = error instanceof KimiWebError ? error : new KimiWebError(controller.signal.aborted ? 'request_aborted' : 'connection')
      // Recover the host, but never replay this request: a POST may already have committed.
      failure.recovered = await this.recoverFailure(failure)
      throw failure
    } finally { clearTimeout(timer); this.requests.delete(controller) }
  }

  async subscribe(sessionId: string, handlers: KimiWebStreamHandlers, initialCursor?: { seq: number; epoch: string }): Promise<KimiWebSubscription> {
    if (this.closed) throw new KimiWebError('closed')
    if (this.transcriptProtocol) return (await this.stateStream(sessionId)).observe(handlers)
    const stream = new KimiWebStream(this, sessionId, handlers, () => this.streams.delete(stream), initialCursor)
    this.streams.add(stream)
    try { await stream.start(); return stream }
    catch (error) { await stream.closeAndWait(); throw error }
  }

  private stateStream(sessionId: string): Promise<KimiWebStream> {
    let flight = this.stateStreams.get(sessionId)
    if (!flight) {
      const stream = new KimiWebStream(this, sessionId, { onEvent() {} }, () => this.streams.delete(stream))
      this.streams.add(stream)
      flight = (async () => {
        await stream.start()
        stream.state!.session = await this.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`)
        return stream
      })().catch(async error => { this.stateStreams.delete(sessionId); await stream.closeAndWait(); throw error })
      this.stateStreams.set(sessionId, flight)
    }
    return flight
  }

  async tasks(sessionId: string): Promise<{ items: any[] }> {
    const stream = await this.stateStream(sessionId)
    await stream.refreshState()
    return { items: stream.state!.tasks() }
  }

  async subagentTask(sessionId: string, task: any, stop = false): Promise<any> {
    const stream = await this.stateStream(sessionId)
    const owned = stream.state!.tasks().find(row => row.id === task.id && row.kind === 'subagent' && row.agent_id === task.agent_id)
    if (!owned) throw new KimiWebError('subagent_not_owned')
    return stream.subagentTask(owned, stop)
  }

  openSocket(): WebSocket {
    if (this.closed) throw new KimiWebError('closed')
    return new WebSocket(this.origin.replace(/^http:/, 'ws:') + '/api/v1/ws', { headers: { Authorization: `Bearer ${this.token}` }, maxPayload: 8 * 1024 * 1024, handshakeTimeout: this.timeoutMs })
  }

  /** Check the live protocol without creating or subscribing to a session. */
  async verifyProtocol(): Promise<void> {
    const socket = this.openSocket()
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new KimiWebError('hello_timeout')), this.timeoutMs)
        const finish = (error?: Error): void => { clearTimeout(timer); error ? reject(error) : resolve() }
        if (this.turnsProtocol) { socket.once('open', () => socket.ping()); socket.once('pong', () => finish()) }
        socket.on('error', () => finish(new KimiWebError('connection')))
        socket.once('close', () => finish(new KimiWebError('connection')))
        socket.on('message', raw => {
          let frame: any
          try { frame = JSON.parse(raw.toString()) } catch { finish(new KimiWebError('stream_protocol')); return }
          if (frame?.type === 'server_hello') finish(frame.payload?.protocol_version === 2 ? undefined : new KimiWebError('protocol_version'))
        })
      })
    } catch (error) {
      if (error instanceof KimiWebError) error.recovered = await this.recoverFailure(error)
      throw error
    } finally { socket.terminate(); await closed }
  }

  async closeAndWait(): Promise<void> {
    this.closed = true
    for (const request of this.requests) request.abort()
    await Promise.all([...this.streams].map((stream) => stream.closeAndWait()))
  }
}

class KimiWebStream implements KimiWebSubscription {
  readonly state?: KimiWebTranscriptState
  private readonly listeners = new Set<KimiWebStreamHandlers>()
  private refreshing?: Promise<void>
  private socket?: WebSocket
  private socketClosed?: Promise<void>
  private closed = false
  private chain = Promise.resolve()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private cursor?: { seq: number; epoch: string }
  private recovering = false
  private recoveryAgain = false
  private retry = 0
  private offsets = new Map<string, number>()
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private taskOperations = Promise.resolve()
  private taskOutput?: { taskId: string; resolve: (text: string) => void; reject: (error: Error) => void }
  private baseline?: { resolve(): void; reject(error: Error): void }

  constructor(private readonly transport: KimiWebTransport, private readonly sessionId: string, private readonly handlers: KimiWebStreamHandlers, private readonly remove: () => void, initialCursor?: { seq: number; epoch: string }) {
    if (!sessionId) throw new KimiWebError('session_id_required')
    if (initialCursor && (!Number.isSafeInteger(initialCursor.seq) || initialCursor.seq < 0 || !initialCursor.epoch)) throw new KimiWebError('initial_cursor_invalid')
    this.cursor = initialCursor
    if (transport.transcriptProtocol) this.state = new KimiWebTranscriptState(sessionId)
    this.listeners.add(handlers)
  }

  async start(): Promise<void> { await this.connect(false) }

  async observe(handlers: KimiWebStreamHandlers): Promise<KimiWebSubscription> {
    this.listeners.add(handlers)
    if (this.state?.ready) await handlers.onSnapshot?.(this.state.snapshot())
    return { closeAndWait: async () => { this.listeners.delete(handlers); await this.chain } }
  }

  refreshState(): Promise<void> {
    if (!this.state) return Promise.resolve()
    if (this.transport.turnsProtocol && this.state.ready) {
      this.refreshing ||= this.send('subscribe', { session_id: this.sessionId }, true).then(() => {}).finally(() => { this.refreshing = undefined })
      return this.refreshing
    }
    this.refreshing ||= this.subscribeCursor().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async connect(recovery: boolean): Promise<void> {
    const socket = this.transport.openSocket()
    this.socket = socket
    let helloResolve!: () => void
    let helloReject!: (error: Error) => void
    const hello = new Promise<void>((resolve, reject) => { helloResolve = resolve; helloReject = reject })
    void hello.catch(() => {})
    const helloTimer = setTimeout(() => { helloReject(new KimiWebError('hello_timeout')); socket.terminate() }, this.transport.timeoutMs)
    this.socketClosed = new Promise((resolve) => socket.once('close', () => resolve()))
    socket.on('error', () => {}) // WS can emit error again while closing.
    socket.on('message', (raw) => {
      if (this.socket !== socket || this.closed) return
      let frame: any
      try { frame = JSON.parse(raw.toString()) }
      catch { this.fail(new KimiWebError('stream_protocol')); socket.terminate(); return }
      if (frame?.type === 'server_hello') {
        clearTimeout(helloTimer)
        if (frame.payload?.protocol_version === 2) { this.state?.reset(frame.payload.ws_connection_id || randomUUID()); helloResolve() }
        else { helloReject(new KimiWebError('protocol_version')); socket.terminate() }
        return
      }
      if (frame?.type === 'ack' || frame?.type === 'response') {
        const id = frame.type === 'response' ? frame.request_id : frame.id
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer); this.pending.delete(id)
        if (frame.code === 0) pending.resolve(frame.type === 'response' ? frame.task : frame.payload)
        else pending.reject(new KimiWebError('stream_remote', frame.code))
        return
      }
      const taskOutput = this.taskOutput
      if (frame?.type === 'task.output' && taskOutput && frame.session_id === this.sessionId && frame.agent_id === 'main' && frame.task_id === taskOutput.taskId) {
        if (!Number.isSafeInteger(frame.offset) || frame.offset < 0 || typeof frame.text !== 'string') taskOutput.reject(new KimiWebError('task_output_invalid'))
        else taskOutput.resolve(frame.text)
        return
      }
      if (frame?.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', payload: frame.payload })); return }
      let changed = false
      try { changed = this.state?.apply(frame) || false }
      catch (error) {
        if (error instanceof KimiWebError && error.kind === 'turns_failed') { this.baseline?.reject(error); this.fail(error); return }
        this.chain = this.chain.then(() => this.recover()).catch(() => this.fail(new KimiWebError('stream_handler')))
        return
      }
      if (frame?.type === 'turns' && frame.agent_id === 'main') this.baseline?.resolve()
      const snapshot = changed && this.state?.ready ? this.state.snapshot() : undefined
      this.chain = this.chain.then(() => this.socket === socket ? this.handleFrame(frame, snapshot) : undefined).catch(() => this.fail(new KimiWebError('stream_handler')))
    })
    socket.on('close', () => {
      clearTimeout(helloTimer); helloReject(new KimiWebError('stream_closed'))
      if (this.socket !== socket) return
      if (this.heartbeat) clearInterval(this.heartbeat)
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new KimiWebError('stream_closed')) }
      this.pending.clear()
      this.taskOutput?.reject(new KimiWebError('stream_closed'))
      this.baseline?.reject(new KimiWebError('stream_closed'))
      if (!this.closed) this.scheduleReconnect()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new KimiWebError('stream_timeout')) }, this.transport.timeoutMs)
      socket.once('open', () => {
        clearTimeout(timer)
        if (this.transport.turnsProtocol) { clearTimeout(helloTimer); this.state?.reset(randomUUID()); helloResolve() }
        resolve()
      })
      socket.once('error', () => { clearTimeout(timer); reject(new KimiWebError('stream_connection')) })
      socket.once('close', () => { clearTimeout(timer); reject(new KimiWebError('stream_closed')) })
    })
    await hello
    if (this.state && !this.transport.turnsProtocol) await this.send('client_hello', {})
    if (this.closed) return
    this.retry = 0
    let alive = true
    socket.on('pong', () => { alive = true })
    this.heartbeat = setInterval(() => { if (!alive) socket.terminate(); else { alive = false; socket.ping() } }, 15_000)
    // Volatile text deltas are not replayed by a cursor. Reconcile every reconnect.
    if (recovery && !this.state) await this.recover()
    else await this.subscribeCursor()
    if (recovery && this.state?.ready) for (const listener of this.listeners) await listener.onSnapshot?.(this.state.snapshot())
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect(true).catch(() => { this.fail(new KimiWebError('stream_reconnect')); this.scheduleReconnect() })
    }, Math.min(250 * 2 ** this.retry++, 5000))
  }

  private send(type: string, payload: any, flat = false): Promise<any> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new KimiWebError('stream_closed'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new KimiWebError('stream_timeout')) }, this.transport.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify(flat ? { type, request_id: id, ...payload } : { type, id, payload }))
    })
  }

  subagentTask(task: any, stop: boolean): Promise<any> {
    const operation = this.taskOperations.then(async () => {
      const address = { session_id: this.sessionId, agent_id: 'main', task_id: task.id }
      const validate = (row: any): any => {
        const result = projectKimiWebTask(this.sessionId, 'main', row)
        if (result.id !== task.id || result.kind !== 'subagent' || result.agent_id !== task.agent_id) throw new KimiWebError('subagent_identity_invalid')
        return result
      }
      if (stop) return validate(await this.send('task.stop', address, true))
      const output = new Promise<string>((resolve, reject) => { this.taskOutput = { taskId: task.id, resolve, reject } })
      void output.catch(() => {})
      const timer = setTimeout(() => this.taskOutput?.reject(new KimiWebError('stream_timeout')), this.transport.timeoutMs)
      try {
        const result = validate(await this.send('task.watch', { ...address, tail_bytes: 32768 }, true))
        return { ...result, output_preview: await output }
      } finally {
        clearTimeout(timer)
        this.taskOutput = undefined
        if (!this.closed && this.socket?.readyState === WebSocket.OPEN) await this.send('task.unwatch', address, true)
      }
    })
    this.taskOperations = operation.then(() => {}, () => {})
    return operation
  }

  private async subscribeCursor(): Promise<void> {
    if (this.transport.turnsProtocol) {
      let timer: ReturnType<typeof setTimeout>
      const ready = new Promise<void>((resolve, reject) => {
        this.baseline = { resolve, reject }
        timer = setTimeout(() => reject(new KimiWebError('transcript_baseline_missing')), this.transport.timeoutMs)
      })
      void ready.catch(() => {})
      try {
        await this.send('subscribe', { session_id: this.sessionId }, true)
        await ready
      } finally { clearTimeout(timer!); this.baseline = undefined }
      return
    }
    const ack = this.state ? await this.send('subscribe_v2', { session_id: this.sessionId, transcript: { '*': 'delta' } })
      : await this.send('subscribe', { session_ids: [this.sessionId], ...(this.cursor ? { cursors: { [this.sessionId]: this.cursor } } : {}) })
    if (ack?.not_found?.includes(this.sessionId)) throw new KimiWebError('session_not_found')
    if (ack?.resync_required?.includes(this.sessionId)) {
      if (this.recovering) this.recoveryAgain = true
      else await this.recover()
    }
  }

  private async recover(): Promise<void> {
    if (this.recovering || this.closed) return
    this.recovering = true
    try {
      if (this.state) {
        await this.send(this.transport.turnsProtocol ? 'unsubscribe' : 'unsubscribe_v2', { session_id: this.sessionId }, this.transport.turnsProtocol)
        this.state.reset()
        await this.subscribeCursor()
        if (!this.state.ready) throw new KimiWebError('transcript_baseline_missing')
        for (const listener of this.listeners) await listener.onSnapshot?.(this.state.snapshot())
        return
      }
      const snapshot = await this.transport.request<KimiWebSnapshot>('GET', `/api/v1/sessions/${encodeURIComponent(this.sessionId)}/snapshot`)
      if (!Number.isSafeInteger(snapshot?.as_of_seq) || typeof snapshot.epoch !== 'string') throw new KimiWebError('snapshot_invalid')
      await this.handlers.onSnapshot?.(snapshot)
      this.offsets.clear()
      const turn: any = snapshot.in_flight_turn
      if (turn) {
        this.offsets.set(`main:${turn.turn_id}:assistant.delta`, (turn.assistant_text || '').length)
        this.offsets.set(`main:${turn.turn_id}:thinking.delta`, (turn.thinking_text || '').length)
      }
      this.cursor = { seq: snapshot.as_of_seq, epoch: snapshot.epoch }
      this.recoveryAgain = false
      await this.subscribeCursor()
      if (this.recoveryAgain) throw new KimiWebError('snapshot_stale')
    } finally { this.recovering = false }
  }

  private async handleFrame(frame: any, snapshot?: KimiWebSnapshot): Promise<void> {
    if (this.closed || !frame || typeof frame.type !== 'string') return
    if (this.state) {
      if (frame.session_id !== this.sessionId || this.recovering) return
      for (const listener of this.listeners) {
        await listener.onEvent({ ...frame, payload: frame.payload || {} })
        if (snapshot) await listener.onSnapshot?.(snapshot)
      }
      return
    }
    if (frame.type === 'server_hello') {
      if (frame.payload?.protocol_version !== 2) { this.fail(new KimiWebError('protocol_version')); this.socket?.terminate() }
      return
    }
    if (frame.type === 'resync_required') {
      if (frame.payload?.session_id === this.sessionId) await this.recover()
      return
    }
    if (frame.session_id !== this.sessionId || this.recovering) return
    if (frame.volatile !== true && Number.isSafeInteger(frame.seq)) {
      if (this.cursor && frame.epoch === this.cursor.epoch && frame.seq <= this.cursor.seq) return
      if (this.cursor && frame.epoch && frame.epoch !== this.cursor.epoch) { await this.recover(); return }
    }
    if (frame.type === 'turn.step.started') {
      this.offsets.delete(`${frame.payload.agentId || 'main'}:${frame.payload.turnId}:assistant.delta`)
      this.offsets.delete(`${frame.payload.agentId || 'main'}:${frame.payload.turnId}:thinking.delta`)
    }
    if ((frame.type === 'assistant.delta' || frame.type === 'thinking.delta') && Number.isSafeInteger(frame.offset)) {
      const key = `${frame.payload.agentId || 'main'}:${frame.payload.turnId}:${frame.type}`
      const expected = this.offsets.get(key) || 0
      if (frame.offset > expected) { await this.recover(); return }
      const delta = String(frame.payload.delta || '').slice(Math.max(0, expected - frame.offset))
      if (!delta) return
      this.offsets.set(key, expected + delta.length)
      frame = { ...frame, payload: { ...frame.payload, delta } }
    }
    await this.handlers.onEvent(frame)
    if (frame.volatile !== true && Number.isSafeInteger(frame.seq) && typeof frame.epoch === 'string') this.cursor = { seq: frame.seq, epoch: frame.epoch }
  }

  private fail(error: KimiWebError): void { for (const listener of this.listeners) { try { listener.onError?.(error) } catch {} } }

  async closeAndWait(): Promise<void> {
    if (this.closed) { await this.socketClosed; return }
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    const socket = this.socket
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const timer = setTimeout(() => socket.terminate(), 500)
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else socket.terminate()
      await this.socketClosed
      clearTimeout(timer)
    }
    this.remove()
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
