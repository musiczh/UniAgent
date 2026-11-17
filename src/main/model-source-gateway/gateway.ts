import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ModelProtocol, SourceEndpoint } from '../../shared/modelSources'
import { modelEndpointUrl } from '../../shared/modelSources'
import { kimiTools, contextErrorEvent } from '../codexSourceRouter'

export interface GatewayRoute { id: string; endpoint: SourceEndpoint; token: string; apiKey: string; models: string[]; modelMap?: Record<string, string>; upstream?: 'trae'; files?: boolean; kimi?: boolean; traceKey?: string }
export interface GatewayState { routes: GatewayRoute[] }
const HOP = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'authorization', 'x-api-key', 'cookie', 'origin', 'referer', 'accept-encoding'])
const MAX_BODY = 64 * 1024 * 1024
const paths: Record<ModelProtocol, string[]> = { 'openai-chat': ['/chat/completions'], 'openai-responses': ['/responses', '/responses/compact'], 'anthropic-messages': ['/messages', '/messages/count_tokens'] }
export interface ModelGateway { server: Server; update(state: GatewayState): void }
export async function startModelGateway(port: number, initial: GatewayState, specialRelay?: (route: GatewayRoute, resource: string, input: any, res: ServerResponse) => Promise<void>): Promise<ModelGateway> {
  let routes = new Map(initial.routes.map(route => [route.id, structuredClone(route)]))
  const reply = (res: ServerResponse, code: number, message: string) => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'model_source_error', message } }))
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, '仅允许本机 Agent 访问')
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health' && req.method === 'GET') { res.end('{"ok":true}'); return }
    const match = /^\/s\/([\w-]+)\/e\/([\w-]+)(?:\/a\/([\w-]+)(?:\/r\/(\d+))?)?(\/.*)$/.exec(url.pathname)
    const route = match && routes.get(match[1] + '/' + match[2] + (match[3] ? '/' + match[3] : '') + (match[4] ? '/' + match[4] : ''))
    if (!route) return reply(res, 404, '数据源或协议端点不存在')
    const token = String(req.headers.authorization || '').replace(/^Bearer /i, '') || String(req.headers['x-api-key'] || '')
    if (token !== route.token) return reply(res, 401, '模型来源访问凭据无效')
    // Each request keeps its own route object while updates publish a new map.
    const resource = match![5].replace(/^\/v1\//, '/')
    const fileRequest = route.files && /^\/files(?:\/[A-Za-z0-9_-]+)?$/.test(resource) && ['GET','POST','DELETE'].includes(req.method || '')
    const betaQuery = route.endpoint.protocol === 'anthropic-messages' && req.method === 'POST' && paths['anthropic-messages'].includes(resource) && [...url.searchParams].length === 1 && ['true', 'false'].includes(url.searchParams.get('beta') || '')
    if (url.search && !betaQuery && (!fileRequest || req.method !== 'GET' || [...url.searchParams.keys()].some(key => !['limit','after_id','before_id'].includes(key)))) return reply(res, 404, '不支持的资源查询参数')
    if (fileRequest) {
      if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(res, 413, '文件上传超过 64 MiB')
      await forward(req, res, route, resource + url.search); return
    }
    if (resource === '/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: route.models.map(id => ({ id, object: 'model' })) })); return
    }
    if (req.method !== 'POST' || !paths[route.endpoint.protocol].includes(resource)) return reply(res, 404, '此数据源不支持当前协议资源')
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return reply(res, 415, '请重新创建会话以关闭请求压缩')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return reply(res, 413, '模型请求超过 64 MiB'); chunks.push(chunk) }
    let value: any
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(res, 400, '请求不是有效 JSON') }
    if (!value || typeof value !== 'object' || !route.models.includes(value.model)) return reply(res, 400, '所选模型未在该来源中启用')
    if (route.kimi && resource === '/responses') {
      if (Array.isArray(value.tools)) value.tools = kimiTools(value.tools)
      if (Array.isArray(value.input)) value.input = value.input.map((item: any) => { if (item?.type !== 'message' || !(Array.isArray(item.content) || typeof item.content === 'string')) return item; const { id: _id, ...message } = item; return message })
    }
    value.model = route.modelMap?.[value.model] ?? value.model
    if (route.upstream) { if (!specialRelay) return reply(res, 503, '此来源的接入服务不可用'); try { await specialRelay(route, resource, value, res) } catch (error) { reply(res, 502, error instanceof Error && error.message.startsWith('企业模型') ? error.message : '企业模型请求未完成，请检查账号和模型权限') } return }
    await forward(req, res, route, resource + url.search, Buffer.from(JSON.stringify(value)))
  })().catch(() => reply(res, 502, '模型接入请求未完成')) })
  async function forward(req: IncomingMessage, res: ServerResponse, route: GatewayRoute, resource: string, body?: Buffer): Promise<void> {
    const target = new URL(modelEndpointUrl(route.endpoint, resource))
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !HOP.has(key.toLowerCase())))
    if (route.endpoint.auth === 'bearer') headers.authorization = `Bearer ${route.apiKey}`
    if (route.endpoint.auth === 'x-api-key') headers['x-api-key'] = route.apiKey
    if (route.endpoint.protocol === 'anthropic-messages' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length) }
    else if (req.headers['content-length']) headers['content-length'] = req.headers['content-length']
    await new Promise<void>(resolve => {
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers }, response => {
        if (res.destroyed) { response.destroy(); return }
        const status = response.statusCode || 502, responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !HOP.has(key.toLowerCase())))
        const normalizeContext = resource === '/responses' && body && JSON.parse(body.toString()).stream === true && status === 400 && /^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')
        if (normalizeContext) {
          const chunks: Buffer[] = []; let bytes = 0, streaming = false
          const bufferError = (chunk: Buffer) => { chunks.push(chunk); bytes += chunk.length; if (bytes > 8192) { streaming = true; response.off('data', bufferError); res.writeHead(status, responseHeaders); for (const value of chunks) res.write(value); chunks.length = 0; response.pipe(res) } }
          response.on('data', bufferError)
          response.once('end', () => { if (!streaming) { const value = Buffer.concat(chunks), event = contextErrorEvent(value); res.writeHead(event ? 200 : status, event ? { ...responseHeaders, 'content-type': 'text/event-stream' } : responseHeaders); res.end(event || value) } resolve() })
        } else { res.writeHead(status, responseHeaders); response.pipe(res) }
        response.once('error', () => { res.destroy(); resolve() })
        response.once('aborted', () => { res.destroy(); resolve() })
        response.once('end', resolve)
      })
      const cancel = () => { if (!res.writableEnded) upstream.destroy(); resolve() }
      res.once('close', cancel)
      upstream.setTimeout(120_000, () => upstream.destroy(new Error('timeout')))
      upstream.once('error', () => { reply(res, 502, '模型上游连接失败或超时'); resolve() })
      upstream.once('close', () => res.off('close', cancel))
      if (body) upstream.end(body)
      else { let size = 0; req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reply(res, 413, '文件上传超过 64 MiB'); upstream.destroy() } }); req.pipe(upstream) }
    })
  }
  server.headersTimeout = 15_000; server.requestTimeout = 120_000
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  return { server, update: state => { routes = new Map(state.routes.map(route => [route.id, structuredClone(route)])) } }
}
