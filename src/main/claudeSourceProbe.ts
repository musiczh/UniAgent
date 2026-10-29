import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { claudeSourceUsesAuthToken } from '../shared/claudeSources'
import type { ClaudeConnection } from './claudeSourceRuntime'

export function testClaudeConnection(connection: ClaudeConnection, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(connection.baseUrl.replace(/\/+$/, '') + '/v1/messages')
    const body = JSON.stringify({ model: connection.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }] })
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'POST', headers: {
      'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body),
      ...(claudeSourceUsesAuthToken(connection.preset) ? { authorization: `Bearer ${connection.apiKey}` } : { 'x-api-key': connection.apiKey })
    } }, response => {
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', chunk => {
        size += chunk.length
        if (size > 1024 * 1024) { request.destroy(new Error('连接测试响应过大')); return }
        chunks.push(chunk)
      })
      response.on('error', () => finish(new Error('连接测试响应中断，请重试')))
      response.on('end', () => {
        const code = response.statusCode || 0
        if (code !== 200) {
          const message = code === 401 || code === 403 ? '密钥无效或无模型访问权限' : code === 402 ? '余额或套餐额度不足' : code === 404 ? '接口或模型不存在' : code === 429 ? '请求限流或额度不足，请稍后重试' : `厂商接口返回 HTTP ${code}`
          finish(new Error(message)); return
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (result.type !== 'message' || !Array.isArray(result.content) || result.error) throw new Error()
          finish()
        } catch { finish(new Error('厂商响应格式不符合 Anthropic Messages 协议')) }
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('连接测试超时，请检查网络后重试')), timeoutMs)
    let settled = false
    function finish(error?: Error): void {
      if (settled) return
      settled = true; clearTimeout(timer)
      error ? reject(error) : resolve('连接成功，所选模型已返回有效响应')
    }
    request.on('error', error => finish(new Error(error.message.startsWith('连接测试') ? error.message : '无法连接厂商接口，请检查网络和地址')))
    request.end(body)
  })
}
