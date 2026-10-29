import { stat, realpath } from 'node:fs/promises'
import { isAbsolute, extname } from 'node:path'
import type { Attachment } from '../../shared/types'
import type { ZCodeAttachmentRef } from '../../shared/zcode'

export async function zcodeAttachmentRefs(attachments: Attachment[] = [], imageInput = false): Promise<ZCodeAttachmentRef[]> {
  if (attachments.length > 32) throw new Error('ZCode 每次最多发送 32 个附件')
  return Promise.all(attachments.map(async attachment => {
    if (!isAbsolute(attachment.path)) throw new Error('ZCode 附件必须使用绝对路径')
    if (attachment.kind === 'image' && !imageInput) throw new Error('ZCode 所选模型不支持图片输入')
    const ref = await realpath(attachment.path)
    const file = await stat(ref)
    if (!file.isFile()) throw new Error('ZCode 附件必须是文件')
    const imageMime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    const mime = attachment.mime || (attachment.kind === 'image' ? imageMime[extname(ref).toLowerCase()] : extname(ref).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream')
    if (!mime || attachment.kind === 'image' && !mime.startsWith('image/')) throw new Error('ZCode 图片附件缺少有效 MIME 类型')
    return { ref, fileName: attachment.name, mime, bytes: file.size }
  }))
}
