const LEGACY_FEISHU_CONTEXT_TEXT = '本条消息来自飞书；图片、文件用 send_to_feishu 回传当前话题，不带此context的消息为非飞书发送消息。'
export const FEISHU_CONTEXT_TEXT = `${LEGACY_FEISHU_CONTEXT_TEXT} 回复将发送到飞书，正文不得引用本地文件路径、file:// URL 或本地 Markdown 链接、图片；需要用户查看或下载的图片、设计稿、文档等文件，必须用 send_to_feishu 单独发送，正文只写文件名和必要说明。只有发送成功后才可声称附件已发送；失败时说明原因，不用本地链接替代。`
export const FEISHU_CONTEXT = `<uniagent_feishu_context>\n${FEISHU_CONTEXT_TEXT}\n</uniagent_feishu_context>`

export function appendFeishuContext(text: string): string {
  return `${text || '[图片]'}\n\n${FEISHU_CONTEXT}`
}

/** Display-only parsing, including the old JSON suffix. Never grants send permission. */
export function splitFeishuContext(text: string): { text: string; context: string } | undefined {
  const start = text.lastIndexOf('<uniagent_feishu_context>')
  if (start < 0) return undefined
  const prefix = text.slice(0, start)
  if (prefix && !/\r?\n\r?\n$/.test(prefix)) return undefined
  const match = /^<uniagent_feishu_context>\r?\n([\s\S]*?)\r?\n<\/uniagent_feishu_context>\s*$/.exec(text.slice(start))
  if (!match) return undefined
  const body = match[1]
  if (body !== FEISHU_CONTEXT_TEXT && body !== LEGACY_FEISHU_CONTEXT_TEXT) {
    try {
      if (JSON.parse(body.split(/\r?\n/)[0])?.source !== 'feishu') return undefined
    } catch { return undefined }
  }
  return { text: prefix.replace(/\r?\n\r?\n$/, ''), context: body }
}
