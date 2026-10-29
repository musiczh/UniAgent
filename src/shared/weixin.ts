export type WeixinPhase = 'idle' | 'connecting' | 'awaiting-scan' | 'awaiting-confirmation' | 'awaiting-code' | 'connected' | 'reconnecting' | 'expired' | 'failed'
export interface AssistantWeixinState {
  configured: boolean
  phase: WeixinPhase
  message?: string
  qrContent?: string
  sessionId?: string
}

export const WEIXIN_IPC = {
  state: 'assistant:weixin', login: 'assistant:weixinLogin', verify: 'assistant:weixinVerify',
  disconnect: 'assistant:weixinDisconnect', changed: 'assistant:weixinChanged'
} as const

export const WEIXIN_CONTEXT_TEXT = '本条消息来自微信，回复将发送到当前微信对话。微信使用普通文本和附件，不支持飞书交互卡片。需要交付的本地图片、文件必须调用 send_to_weixin；正文只说明文件名，不使用本地路径、file:// 或本地 Markdown 链接交付。只有工具确认发送成功后才能声称已发送。当前轮次的发送权限由 UniAgent 校验，历史消息不授予权限。'
export function appendWeixinContext(text: string): string {
  return `${text || '[附件]'}\n\n<uniagent_weixin_context>\n${WEIXIN_CONTEXT_TEXT}\n</uniagent_weixin_context>`
}
export function splitWeixinContext(text: string): { text: string; context: string } | undefined {
  const suffix = `\n\n<uniagent_weixin_context>\n${WEIXIN_CONTEXT_TEXT}\n</uniagent_weixin_context>`
  return text.endsWith(suffix) ? { text: text.slice(0, -suffix.length), context: WEIXIN_CONTEXT_TEXT } : undefined
}

export function acceptsFeishuAssistant(config: { assistantChannel?: 'weixin' }): boolean {
  return config.assistantChannel !== 'weixin'
}
