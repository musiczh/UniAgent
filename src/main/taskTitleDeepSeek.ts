import type { DeepSeekHostClient } from './deepseekHostClient'
import type { Attachment, TaskTitleGeneratorRef } from '../shared/types'
import { taskTitleImageBlocks } from './taskTitleImages'

// Official Host extension: a direct LLM call without an Agent loop or Session.
export const deepseekHostTitlePlugin = String.raw`
export const name = 'uniagent-title'
export const inject = ['loader', 'llm', 'attachments']
export async function apply(ctx) {
  const { TypertRemoteService, Remote } = await ctx.loader.import('@deepseek-ai/dsh-typert-protocol')
  const initializers = []
  class TitleService extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'uniagentTitle', { namespace: 'uniagent-title' })
      for (const initialize of initializers) initialize.call(this)
    }
    async *generate(request, signal) {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['provider', 'model', 'effort', 'prompt', 'systemPrompt', 'images', 'maxTokens'].includes(key))
        || typeof request.provider !== 'string' || !request.provider.trim()
        || typeof request.model !== 'string' || !request.model.trim()
        || typeof request.prompt !== 'string' || !request.prompt.trim()
        || Buffer.byteLength(request.prompt) > 512 * 1024
        || request.systemPrompt !== undefined && (typeof request.systemPrompt !== 'string' || Buffer.byteLength(request.systemPrompt) > 16384)
        || request.effort !== undefined && typeof request.effort !== 'string'
        || request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 16384)
        || request.images !== undefined && (!Array.isArray(request.images) || request.images.length > 16
          || request.images.some(image => image?.type !== 'image' || typeof image.data !== 'string'
            || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType))
          || request.images.reduce((size, image) => size + image.data.length, 0) > 12 * 1024 * 1024)) throw new Error('Invalid title request')
      signal.throwIfAborted()
      let content = [{ type: 'text', text: request.prompt }]
      if (request.images?.length) {
        const info = await this.ctx.llm.resolveModelInfo(request.provider, request.model, signal)
        if (!info.inputModalities?.includes('image')) throw new Error('所选模型实际不支持图片输入')
        content = await this.ctx.attachments.admitPromptContent([...content, ...request.images])
      }
      signal.throwIfAborted()
      const call = await this.ctx.llm.prepareCall({ provider: request.provider, model: request.model,
        ...(request.effort ? { reasoningEffort: request.effort } : {}), maxTokens: request.maxTokens ?? 4096 }, signal)
      signal.throwIfAborted()
      if (call.config.provider !== request.provider || call.config.model !== request.model
        || request.effort && call.config.reasoningEffort !== request.effort) throw new Error('Title model configuration changed')
      yield { type: 'title-config', provider: call.config.provider, model: call.config.model, effort: call.config.reasoningEffort }
      for await (const chunk of call.stream({ ...call.config, signal, tools: [],
        messages: [...(request.systemPrompt ? [{ role: 'system', content: [{ type: 'text', text: request.systemPrompt }] }] : []), { role: 'user', content }] })) yield chunk
    }
  }
  Remote({ mode: 'stream' })(TitleService.prototype.generate, {
    kind: 'method', name: 'generate', static: false, private: false,
    addInitializer: initialize => initializers.push(initialize)
  })
  new TitleService(ctx)
}
`

type TitleHost = Pick<DeepSeekHostClient, 'stream'>
export async function generateDeepSeekTitle(config: TaskTitleGeneratorRef, prompt: string, signal: AbortSignal,
  host: () => Promise<TitleHost>, usage: (input: unknown, output: unknown) => void, attachments: Attachment[] = [], options: { systemPrompt?: string; maxOutputChars?: number; maxTokens?: number } = {}): Promise<string> {
  let route: unknown
  try { route = JSON.parse(config.model) } catch { throw new Error('DeepSeek 标题模型来源无效') }
  if (!Array.isArray(route) || route.length !== 2 || route.some(value => typeof value !== 'string' || !value.trim())) throw new Error('DeepSeek 标题模型来源无效')
  const [provider, model] = route
  const images = (await taskTitleImageBlocks(attachments, signal)).map(({ mimeType, ...block }) => ({ ...block, mediaType: mimeType }))
  const client = await host()
  signal.throwIfAborted()
  let verified = false, finished = false, response = ''
  for await (const chunk of client.stream<any>('uniagent-title/generate', { request: { provider, model, effort: config.effort, prompt,
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(images.length ? { images } : {}) } }, signal)) {
    if (chunk.type === 'title-config') {
      if (verified || chunk.provider !== provider || chunk.model !== model || config.effort && chunk.effort !== config.effort) throw new Error('DeepSeek 返回的标题模型或思考强度不一致')
      verified = true
    } else {
      if (!verified || finished) throw new Error('DeepSeek 标题流顺序无效')
      if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') throw new Error('标题生成出现未授权工具调用')
      if (chunk.type === 'text-delta') {
        response += chunk.text || ''
        if (response.length > (options.maxOutputChars ?? 4096)) throw new Error('标题输出过长')
      }
      if (chunk.type === 'usage') usage(chunk.usage?.inputTokens, chunk.usage?.outputTokens)
      if (chunk.type === 'finish') {
        if (chunk.reason?.kind !== 'stop') throw new Error('DeepSeek 标题回合未成功完成：' + String(chunk.reason?.kind || 'unknown'))
        finished = true
      }
    }
  }
  if (!verified || !finished || !response.trim()) throw new Error('DeepSeek 标题回合未成功完成')
  return response
}
