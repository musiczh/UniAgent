import { startModelGateway, type ModelGateway, type GatewayState } from './gateway'
import { fetchModelSourceQuota } from '../model-sources/quota'
import type { QuotaProviderId, QuotaQueryContext } from '../../shared/modelSourceQuota'


let gateway: ModelGateway | undefined
let tail = Promise.resolve()
process.on('message', (message: { id: string; action?: string; preset: QuotaProviderId; baseUrl: string; apiKey: string; context?: QuotaQueryContext; port: number; state: GatewayState }) => {
  if (message.action === 'quota') {
    void fetchModelSourceQuota(message.preset, message.baseUrl, message.apiKey, message.context).then(result => process.send?.({ id: message.id, result }), error => process.send?.({ id: message.id, error: error instanceof Error ? error.message : '额度查询失败' }))
    return
  }
  tail = tail.then(async () => {
    try {
      if (gateway) gateway.update(message.state)
      else gateway = await startModelGateway(message.port, message.state, )
      const address = gateway.server.address()
      process.send?.({ id: message.id, port: typeof address === 'object' && address ? address.port : 0 })
    } catch { process.send?.({ id: message.id, error: '模型网关启动或更新失败，请检查端口后重试' }) }
  })
})
const stop = async () => { gateway?.server.closeAllConnections(); gateway?.server.close();  process.exit(0) }
process.once('disconnect', stop); process.once('SIGTERM', stop)
