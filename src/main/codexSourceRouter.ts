import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { isProviderQuotaExceeded, isProviderRateLimited, providerContextLimit } from '../shared/providerErrors'
import type { CodexSourceId, CodexSourceRuntimeEvent, CodexSourceRuntimeIssue } from '../shared/codexSources'

export interface RouterConfig {
  port: number
  sources: { id: CodexSourceId; baseUrl: string; models: string[]; apiKey: string }[]
}
const PREFIX = '/api/codex/v1'
const MAX_BODY = 64 * 1024 * 1024
const HOP_HEADERS = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** Kimi rejects some finite $defs graphs; inline local references without changing tool arguments. */
function inlineToolSchema(schema: any): any {
  let expanded = false
  let nodes = 0
  const visit = (node: any, refs: string[]): any => {
    if (++nodes > 100_000) throw new Error('schema expansion limit')
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node
    if ((node !== schema && node.$id) || node.$dynamicRef || node.$recursiveRef) throw new Error('unsupported schema scope')
    let resolved: Record<string, unknown> = Object.create(null)
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#/') || refs.includes(node.$ref)) throw new Error('non-local or recursive schema')
      let target = schema
      for (const part of node.$ref.slice(2).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
        if (!target || !Object.hasOwn(target, key)) throw new Error('missing schema reference')
        target = target[key]
      }
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('unsupported schema reference')
      resolved = visit(target, [...refs, node.$ref])
      expanded = true
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' || key === '$defs' || key === 'definitions') continue
      if (Object.hasOwn(resolved, key) && !['description', 'title', 'default', 'examples'].includes(key) &&
          JSON.stringify(resolved[key]) !== JSON.stringify(value)) throw new Error('conflicting schema constraints')
      if (['properties', 'patternProperties', 'dependentSchemas', 'dependencies'].includes(key) && value && typeof value === 'object') {
        resolved[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child, refs)]))
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'].includes(key) && Array.isArray(value)) {
        resolved[key] = value.map(child => visit(child, refs))
      } else if (['items', 'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'].includes(key)) {
        resolved[key] = visit(value, refs)
      } else resolved[key] = value
    }
    return resolved
  }
  try {
    const result = visit(schema, [])
    return expanded ? result : schema
  } catch { return schema }
}

function kimiTools(tools: any[]): any[] {
  return tools.map(tool => !tool || typeof tool !== 'object' ? tool : tool.type === 'namespace' && Array.isArray(tool.tools)
    ? { ...tool, tools: kimiTools(tool.tools) }
    : tool.type === 'function' && tool.parameters ? { ...tool, parameters: inlineToolSchema(tool.parameters) } : tool)
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' })
  res.end(JSON.stringify({ error: { message, type: 'codex_source_error' } }))
}

function runtimeError(error: unknown): CodexSourceRuntimeIssue['error'] {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const code = (error as NodeJS.ErrnoException).code
  return { name: error.name, message: error.message, ...(code ? { code } : {}) }
}

/** 按上游错误体归类提示：403 也可能是额度耗尽而非 Key 失效，400 也可能是上下文超限。 */
function httpErrorMessage(status: number, body: string): string {
  const text = body.toLowerCase()
  const hint = isProviderQuotaExceeded(body)
    ? '，额度或用量已达上限，请等待重置或检查套餐'
    : isProviderRateLimited(body)
      ? '，请求频率受限，请稍后重试'
      : status === 402 || /insufficient[_ ](?:account[_ ])?balance/.test(text)
        ? '，余额或套餐额度不足，请充值后重试'
        : /unsupported_feature|responses_feature_not_supported|not supported by this gateway/.test(text)
          ? '，上游不支持当前请求的工具或能力，请关闭对应功能或更新接入配置'
          : /token limit|context window|context length|maximum context|上下文/.test(text)
            ? '，请求超过模型上下文限制，请压缩上下文或新建会话'
            : /tools?\.function\.parameters|(?:tool|function).*json[ _]schema|infinite recursion/.test(text)
              ? '，工具参数 Schema 不兼容，请检查或更新 MCP 工具配置'
              : status === 401 || status === 403
                ? '，请检查 API Key'
                : status === 429
                  ? '，请检查额度或稍后重试'
                  : ''
  return `请求失败（HTTP ${status}）${hint}`
}

function contextErrorEvent(body: Buffer): string | undefined {
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (providerContextLimit(value?.error?.message)) {
      // Codex 0.162 classifies this code in failed Responses events; HTTP 400
      // JSON remains an untyped transport error even with the same code.
      return `data: ${JSON.stringify({ type: 'response.failed', response: {
        status: 'failed', error: { ...value.error, code: 'context_length_exceeded' }
      } })}\n\n`
    }
  } catch { /* Preserve unknown upstream error bodies. */ }
  return undefined
}

/** Observe SSE without rewriting it or keeping model output in diagnostics. */
function responseStreamObserver(): { write(chunk: Buffer): void; end(): string | undefined } {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let data = ''
  let event = ''
  let oversized = false
  let terminal: string | undefined
  const terminals = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])
  const line = (value: string): void => {
    if (value.endsWith('\r')) value = value.slice(0, -1)
    if (!value) {
      let type: string | undefined
      if (data && !oversized) {
        try {
          const payload = JSON.parse(data)
          if (payload && typeof payload === 'object') type = typeof payload.type === 'string' ? payload.type : event
        } catch { /* unknown or truncated frame is not completion */ }
      }
      if (type && terminals.has(type)) terminal = type
      data = ''; event = ''; oversized = false
    } else if (value.startsWith('event:')) {
      event = value.slice(6).trim()
    } else if (value.startsWith('data:') && !oversized) {
      const next = value.slice(5).replace(/^ /, '')
      if (data.length + next.length > MAX_BODY) { data = ''; oversized = true }
      else data += (data ? '\n' : '') + next
    }
  }
  const consume = (text: string): void => {
    pending += text
    let boundary: number
    while ((boundary = pending.indexOf('\n')) !== -1) {
      line(pending.slice(0, boundary))
      pending = pending.slice(boundary + 1)
    }
    if (pending.length > MAX_BODY) { pending = ''; oversized = true }
  }
  return {
    write: chunk => consume(decoder.write(chunk)),
    end: () => {
      consume(decoder.end())
      // An unfinished SSE frame at EOF is not a delivered completion event.
      return terminal
    }
  }
}

export async function startCodexSourceRouter(config: RouterConfig, onRuntimeEvent: (event: CodexSourceRuntimeEvent) => void = () => {}): Promise<Server> {
  const routes = new Map(config.sources.map(source => [source.id, source] as const))
  const server = createServer((req, res) => { void relay(req, res).catch(() => reply(res, 502, '接入服务无法处理请求')) })
  server.headersTimeout = 15_000
  server.requestTimeout = 120_000
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return server

  async function relay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, '仅允许本机 Codex 访问')
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"service":"uniagent-codex-sources"}')
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const [sourceId, ...pathParts] = url.pathname.slice(PREFIX.length + 1).split('/')
    const path = '/' + pathParts.join('/')
    const source = routes.get(sourceId as CodexSourceId)
    if (!url.pathname.startsWith(PREFIX + '/') || (url.search && !(req.method === 'GET' && path === '/models')) ||
        !(req.method === 'POST' && (path === '/responses' || path === '/responses/compact') || req.method === 'GET' && path === '/models')) {
      return reply(res, 404, '不支持的 Codex 接口')
    }
    if (!source) return reply(res, 404, '未知的第三方来源')
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: source.models.map(id => ({ id, object: 'model' })) }))
      return
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      const message = '请重新打开 Codex 会话，使接入配置生效（当前请求仍开启压缩）'
      onRuntimeEvent({ type: 'service-issue', issue: { code: 'codex_source_request_compression', message, occurredAt: Date.now(), stage: 'request_validation' } })
      return reply(res, 415, message)
    }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(res, 413, 'Codex 请求超过 64 MiB')
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) { reply(res, 413, 'Codex 请求超过 64 MiB'); return }
      chunks.push(chunk)
    }
    let body = Buffer.concat(chunks)
    let model: string | undefined
    let stream = false
    if (req.method === 'POST') {
      let value: unknown
      try {
        const input = JSON.parse(body.toString('utf8'))
        value = input?.model
        stream = input?.stream === true
        if (source.id === 'kimi') {
          if (Array.isArray(input?.tools)) input.tools = kimiTools(input.tools)
          // Inline messages carry their full content, so do not reuse another
          // provider's message IDs. Keep real references and tool call IDs intact.
          if (Array.isArray(input?.input)) input.input = input.input.map((item: any) => {
            if (item?.type !== 'message' || !(Array.isArray(item.content) || typeof item.content === 'string')) return item
            const { id, ...message } = item
            return message
          })
          body = Buffer.from(JSON.stringify(input))
          if (body.length > MAX_BODY) return reply(res, 413, 'Codex 请求超过 64 MiB')
        }
      } catch { return reply(res, 400, '请求必须是有效 JSON') }
      if (typeof value !== 'string') return reply(res, 400, '请求缺少模型 ID')
      model = value
    }
    if (!model || !source.models.includes(model)) return reply(res, 404, '模型不属于当前第三方来源')
    const destination = new URL(source.baseUrl.replace(/\/$/, '') + path + url.search)
    const headers: Record<string, string | string[]> = {}
    headers.authorization = 'Bearer ' + source.apiKey
    headers['content-type'] = 'application/json'
    headers.accept = req.headers.accept || 'text/event-stream'
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent']
    headers['content-length'] = String(body.length)
    const label = source.id
    const issue = (code: string, message: string, stage: CodexSourceRuntimeIssue['stage'], statusCode?: number, error?: unknown): void => {
      if (!source || !model) return
      onRuntimeEvent({
        type: 'issue',
        issue: { sourceId: source.id, model, code, message, occurredAt: Date.now(), stage, ...(statusCode ? { statusCode } : {}), ...(error === undefined ? {} : { error: runtimeError(error) }) }
      })
    }
    let downstreamCancelled = false
    const upstream = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, { method: req.method, headers }, response => {
      const status = response.statusCode || 502
      const responseHeaders: Record<string, string | string[]> = {}
      const connectionHeaders = new Set((response.headers.connection || '').toLowerCase().split(',').map(h => h.trim()))
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !HOP_HEADERS.has(name) && !connectionHeaders.has(name)) responseHeaders[name] = value
      }
      const normalizeContext = path === '/responses' && stream && status === 400 && !response.headers['content-encoding'] &&
        /^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')
      if (!normalizeContext) res.writeHead(status, responseHeaders)
      // 旁路采样前 8KB 用于归类；明确的上下文超限单独适配为原生失败事件。
      // 其它响应保持原样，避免只看到状态码就误报「检查 API Key」。
      let errorSample = ''
      let errorReported = false
      const reportHttpError = (): void => {
        if (errorReported || !source || status < 400) return
        errorReported = true
        issue('codex_source_http_error', httpErrorMessage(status, errorSample), 'upstream_response', status)
      }
      const observer = status < 400 && path === '/responses' && /^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] || '')
        ? responseStreamObserver() : undefined
      if (observer) response.on('data', (chunk: Buffer) => observer.write(chunk))
      if (status >= 400) {
        const decoder = new StringDecoder('utf8')
        response.on('data', (chunk: Buffer) => {
          if (errorSample.length < 8192) errorSample += decoder.write(chunk).slice(0, 8192 - errorSample.length)
        })
      }
      response.on('error', error => { reportHttpError(); if (!downstreamCancelled) issue('codex_source_response_aborted', '响应中断，请重试', 'upstream_response', status, error); res.destroy() })
      response.on('end', () => {
        reportHttpError()
        if (!source || !model || status >= 400 || downstreamCancelled) return
        const terminal = observer?.end()
        if (observer && terminal !== 'response.completed') {
          issue('codex_source_response_incomplete', terminal
            ? '上游返回失败或未完成的响应，请查看会话中的具体错误'
            : '响应流提前结束，未收到 response.completed，请检查上游服务或网络后重试', 'upstream_response', status)
          return
        }
        onRuntimeEvent({ type: 'recovered', sourceId: source.id, model })
      })
      if (normalizeContext) {
        let chunks: Buffer[] = []
        let bytes = 0
        let streaming = false
        const bufferError = (chunk: Buffer): void => {
          chunks.push(chunk)
          bytes += chunk.length
          if (bytes > 8192) {
            streaming = true
            response.off('data', bufferError)
            res.writeHead(status, responseHeaders)
            for (const buffered of chunks) res.write(buffered)
            chunks = []
            response.pipe(res)
          }
        }
        response.on('data', bufferError)
        response.on('end', () => {
          if (!streaming) {
            const body = Buffer.concat(chunks)
            const event = contextErrorEvent(body)
            res.writeHead(event ? 200 : status, event ? { ...responseHeaders, 'content-type': 'text/event-stream' } : responseHeaders)
            res.end(event || body)
          }
        })
      } else response.pipe(res)
    })
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('timeout')))
    upstream.on('error', error => {
      if (res.destroyed || downstreamCancelled) return
      const message = `${label} 连接失败或超时，请检查接口地址与网络`
      issue('codex_source_connection_failed', '连接失败或超时，请检查接口地址与网络', 'upstream_request', undefined, error)
      reply(res, 502, message)
    })
    res.once('close', () => { downstreamCancelled = !res.writableEnded; upstream.destroy() })
    upstream.end(body)
  }
}

// Kept in the packaged app; no system Node or Python installation is required.
if (process.env.UNIAGENT_CODEX_ROUTER === '1' && process.send) {
  let server: Server | undefined
  const stop = (): void => {
    server?.closeAllConnections()
    server?.close()
    process.exit(0)
  }
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('message', (config: RouterConfig) => {
    void startCodexSourceRouter(config, event => process.send?.({ type: 'runtime', event })).then(value => {
      server = value
      const address = value.address()
      process.send?.({ type: 'ready', port: typeof address === 'object' && address ? address.port : config.port })
    }).catch((error: NodeJS.ErrnoException) => {
      process.send?.({ type: 'failed', message: error.code === 'EADDRINUSE' ? '接入端口被占用，请关闭其他接入服务后重试' : '接入服务启动失败' }, () => process.exit(1))
    })
  })
}
