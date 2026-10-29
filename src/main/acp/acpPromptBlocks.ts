import { open, readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Attachment } from '../../shared/types.ts'
import { grokImageBlocks } from '../grokImages.ts'

const TEXT_SNIFF_BYTES = 64 * 1024

async function assertTextFile(path: string, label: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(TEXT_SNIFF_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead)
    if (prefix.includes(0)) throw new Error(`${label} 仅支持文本文件附件`)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: bytesRead === buffer.length })
    } catch {
      throw new Error(`${label} 仅支持文本文件附件`)
    }
  } finally {
    await file.close()
  }
}

export async function buildTextPromptBlocks(
  prompt: string,
  attachments: Attachment[] | undefined,
  options: { imageAttachments: boolean; fileAttachments: boolean; provider?: 'grok' | 'kimi' | 'deepseek' | 'mcode'; env?: NodeJS.ProcessEnv }
): Promise<any[]> {
  const label = options.provider === 'deepseek' ? 'DeepSeek Harness' : options.provider === 'kimi' ? 'Kimi Code' : options.provider === 'mcode' ? 'MiniMax Code' : 'Grok'
  const blocks: any[] = prompt ? [{ type: 'text', text: prompt }] : []
  const grokImages = options.provider === 'grok' && options.imageAttachments
    ? await grokImageBlocks((attachments || []).filter(item => item.kind === 'image'),options.env) : []
  let imageIndex = 0
  for (const attachment of attachments || []) {
    if (attachment.kind === 'image') {
      if (!options.imageAttachments) throw new Error(`当前 ${label} ACP 不支持图片输入`)
      if (options.provider === 'grok') { blocks.push(grokImages[imageIndex++]); continue }
      const metadata = await stat(attachment.path)
      if (!metadata.isFile()) throw new Error(`${label} 图片附件不是普通文件`)
      const mimeType = attachment.mime?.startsWith('image/') ? attachment.mime : 'image/png'
      blocks.push({ type: 'image', data: (await readFile(attachment.path)).toString('base64'), mimeType })
      continue
    }
    if (!options.fileAttachments) throw new Error(`当前 ${label} ACP 不支持文件附件`)
    const metadata = await stat(attachment.path)
    if (!metadata.isFile()) throw new Error(`${label} 文件附件不是普通文件`)
    await assertTextFile(attachment.path, label)
    if (options.provider === 'kimi') {
      blocks.push({
        type: 'resource',
        resource: {
          uri: pathToFileURL(attachment.path).href,
          text: await readFile(attachment.path, 'utf8'),
          ...(attachment.mime ? { mimeType: attachment.mime } : {})
        }
      })
    } else {
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(attachment.path).href,
        name: attachment.name,
        ...(attachment.mime ? { mimeType: attachment.mime } : {})
      })
    }
  }
  return blocks
}
