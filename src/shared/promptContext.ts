export type MessageChannel = 'app' | 'feishu' | 'weixin'

export interface SessionPromptContext {
  version: 1
  agentId: string
  nativeSessionId?: string
  binding: string
  snapshot: string
  rules?: string
  fallback: 'ready' | 'pending' | 'accepted' | 'legacy'
  lastChannel?: MessageChannel
  channelContextPending?: boolean
  inputOrdinal?: number
  acceptedInputOrdinal?: number
  pendingInput?: { id: string; channel: MessageChannel; initialization: boolean; nativeInputId?: string; inputHash?: string }
  compactedId?: string
  rebuild?: boolean
}

export const RESPONSE_ANNOTATION_INSTRUCTION = '以下各项包含引用原文及可选批注；结合所有引用逐项回应批注，在对应回答附 :codex-annotation{index="N"}，N 为条目从 1 开始的序号。'
export const RESPONSE_COMMENT_INSTRUCTION = '以下各项包含引用原文及可选评论；结合所有引用逐项回应评论。'

export function parseSessionPromptContext(value: unknown): SessionPromptContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as SessionPromptContext
  if (v.version !== 1 || typeof v.agentId !== 'string' || typeof v.binding !== 'string' || typeof v.snapshot !== 'string' ||
    !['ready', 'pending', 'accepted', 'legacy'].includes(v.fallback)) return undefined
  if (v.lastChannel !== undefined && !['app', 'feishu', 'weixin'].includes(v.lastChannel)) return undefined
  if (v.channelContextPending !== undefined && typeof v.channelContextPending !== 'boolean') return undefined
  if (v.pendingInput && (typeof v.pendingInput.id !== 'string' || !['app', 'feishu', 'weixin'].includes(v.pendingInput.channel) || typeof v.pendingInput.initialization !== 'boolean')) return undefined
  return structuredClone(v)
}
