import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class DeepSeekHostError extends Error {
  constructor(readonly code: string, reason?: unknown) {
    super(code === 'session/writer-held'
      ? '该会话正在被其他应用使用，请释放后手动重试，或 fork 独立会话'
      : code === 'session/attachment-invalid' && reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
        ? '当前 DeepSeek 模型不支持图片输入，请切换支持图片的模型或移除图片后重试'
        : `DeepSeek Host 请求失败（${code}）`)
    this.name = 'DeepSeekHostError'
  }
}

interface StreamState {
  items: unknown[]
  done: boolean
  error?: Error
  wake?: () => void
}

/** Main-process transport for the qualified 0.2.1-rc.2 Host wire contract.
 * No mutation is retried here: in particular writer-held must never become a queue.
 */
export class DeepSeekHostClient {
  #cookie = ''
  #origin: string
  #closed = false
  #lifetime = new AbortController()
  #socket?: WebSocket
  #opening?: Promise<WebSocket>
  #streams = new Map<string, StreamState>()

  private constructor(origin: string, private readonly timeoutMs: number) { this.#origin = origin }

  /** Public loopback callback origin only; never includes the launch token or cookie. */
  get callbackOrigin(): string { return this.#origin }

  static async connect(launchUrl: string, timeoutMs = 15_000): Promise<DeepSeekHostClient> {
    let url: URL
    try { url = new URL(launchUrl) } catch { throw new DeepSeekHostError('invalid-launch-url') }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
      || url.username || url.password || url.hash || !url.searchParams.get('token')
      || [...url.searchParams.keys()].some(key => key !== 'token')) throw new DeepSeekHostError('invalid-launch-url')
    const client = new DeepSeekHostClient(url.origin, timeoutMs)
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      await response.body?.cancel()
      if (response.status !== 303) throw new DeepSeekHostError('authentication-failed')
      const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
      if (!cookies.length || cookies.some(value => !/^[^\s=;,]+=[^\s;,]+$/.test(value))) throw new DeepSeekHostError('authentication-failed')
      client.#cookie = cookies.join('; ')
      return client
    } catch (error) {
      client.close()
      if (error instanceof DeepSeekHostError) throw error
      throw new DeepSeekHostError('authentication-unavailable')
    }
  }

  async call<T = unknown>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    this.assertEndpoint(method)
    const rpcId = randomUUID()
    try {
      const response = await fetch(`${this.#origin}/api/${method}`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Cookie: this.#cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])])
      })
      if (!response.ok) { await response.body?.cancel(); throw new DeepSeekHostError(`http-${response.status}`) }
      if (!response.headers.get('content-type')?.startsWith('application/json')) {
        await response.body?.cancel()
        throw new DeepSeekHostError('unsupported-response-format')
      }
      const envelope: unknown = await response.json()
      if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !record(envelope.result)) {
        throw new DeepSeekHostError('invalid-response')
      }
      if (envelope.result.ok === true) return envelope.result.value as T
      if (envelope.result.ok === false && record(envelope.result.error) && typeof envelope.result.error.code === 'string') {
        // Do not surface arbitrary Host messages or details, which can contain credentials.
        const code = envelope.result.error.code
        throw new DeepSeekHostError(/^[a-zA-Z0-9_/-]{1,96}$/.test(code) ? code : 'remote-error', envelope.result.error.details?.reason)
      }
      throw new DeepSeekHostError('invalid-response')
    } catch (error) {
      if (error instanceof DeepSeekHostError) throw error
      throw new DeepSeekHostError(this.#closed ? 'closed' : signal?.aborted ? 'cancelled' : 'transport-failed')
    }
  }

  async *stream<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): AsyncGenerator<T> {
    this.assertEndpoint(endpoint)
    const socket = await this.openSocket()
    if (signal?.aborted) throw new DeepSeekHostError('cancelled')
    const id = randomUUID()
    const state: StreamState = { items: [], done: false }
    const cancel = () => { state.error = new DeepSeekHostError('cancelled'); state.done = true; state.wake?.() }
    this.#streams.set(id, state)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      socket.send(JSON.stringify({ type: 'open', streamId: id, endpoint, payload: { args } }))
      while (true) {
        if (state.error) throw state.error
        if (state.items.length) { yield state.items.shift() as T; continue }
        if (state.done) return
        await new Promise<void>(resolve => { state.wake = resolve })
        state.wake = undefined
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.#streams.delete(id)
      if (!state.done || signal?.aborted) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId: id }))
      }
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#cookie = ''
    this.#lifetime.abort()
    this.failStreams(new DeepSeekHostError('closed'))
    this.#socket?.terminate()
  }

  private assertEndpoint(endpoint: string): void {
    if (this.#closed) throw new DeepSeekHostError('closed')
    if (!/^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/.test(endpoint)
      || endpoint.split('/').some(part => part === '.' || part === '..')) throw new DeepSeekHostError('invalid-endpoint')
  }

  private openSocket(): Promise<WebSocket> {
    if (this.#closed) return Promise.reject(new DeepSeekHostError('closed'))
    if (this.#opening) return this.#opening
    const socket = new WebSocket(this.#origin.replace('http:', 'ws:') + '/api/remote.mux', {
      headers: { Cookie: this.#cookie }, handshakeTimeout: this.timeoutMs, maxPayload: 16 * 1024 * 1024,
      followRedirects: false
    })
    this.#socket = socket
    this.#opening = new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket))
      socket.on('error', () => {
        const error = new DeepSeekHostError('stream-transport-failed')
        reject(error); this.failStreams(error)
      })
      socket.on('close', () => {
        const error = new DeepSeekHostError('stream-closed')
        reject(error); this.failStreams(error)
        if (this.#socket === socket) { this.#socket = undefined; this.#opening = undefined }
      })
      socket.on('message', (bytes, binary) => {
        try {
          const frame = binary ? undefined : JSON.parse(bytes.toString())
          if (!record(frame) || typeof frame.streamId !== 'string' || !['item', 'end', 'error'].includes(frame.type)) throw new Error()
          const state = this.#streams.get(frame.streamId)
          if (!state || state.done) return
          if (frame.type === 'item') {
            if (state.items.length >= 4096) throw new Error()
            state.items.push(frame.value)
          } else {
            state.done = true
            if (frame.type === 'error') {
              if (!record(frame.error) || typeof frame.error.code !== 'string') throw new Error()
              state.error = new DeepSeekHostError(/^[a-zA-Z0-9_/-]{1,96}$/.test(frame.error.code) ? frame.error.code : 'remote-error')
            }
          }
          state.wake?.()
        } catch {
          this.failStreams(new DeepSeekHostError('invalid-stream-frame'))
          socket.terminate()
        }
      })
    })
    return this.#opening
  }

  private failStreams(error: Error): void {
    for (const state of this.#streams.values()) { state.error = error; state.done = true; state.wake?.() }
  }
}
