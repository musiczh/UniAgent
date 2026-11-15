import { basename, extname, resolve } from 'node:path'
import type { RequirementDocument, RequirementMaterial } from '../shared/requirementTypes'

const documentExtensions = new Set(['MD', 'MARKDOWN', 'MDX', 'TXT', 'HTML', 'HTM', 'PDF', 'DOC', 'DOCX', 'ODT', 'RTF', 'PPT', 'PPTX', 'XLS', 'XLSX', 'ODS', 'CSV', 'ZIP'])
const mediaExtensions = new Set(['PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'GIF', 'AVIF', 'MP4', 'MOV', 'WEBM', 'MP3', 'WAV', 'M4A'])

function importantMaterial(doc: Omit<RequirementDocument, 'content'>, name: string, path: string, host: string): boolean {
  const extension = extname(name).slice(1).toUpperCase()
  const purpose = `${doc.title} ${doc.summary} ${name}`.replace(/[_-]/g, ' ')
  const mediaPurpose = /设计|原型|交互稿|效果图|插画|海报|封面|图标|配图|示意图|生成.{0,12}(?:图片|图像|视频|音频)|\b(?:design|mockup|illustration|poster|generated (?:image|video|audio))\b/i.test(purpose)
  if (mediaExtensions.has(extension) || (!extension && host && mediaPurpose)) {
    if (/(?:^|\/)(?:screenshots?|evidence)(?:\/|[._-])|截图|取证/i.test(path) || /截图|取证/.test(doc.title)) return false
    return mediaPurpose
  }
  if (extension ? !documentExtensions.has(extension) : !host) return false
  if (/^(?:trace|stdout|stderr|debug|config|context|state|agents|claude)(?:[._-]|$)/i.test(name) || /^(?:运行中间文件|工具流水|取证截图)/.test(doc.title)) return false
  return /方案|报告|设计|原型|架构|技术文档|接口文档|接口规范|实施说明|需求|调研|使用指南|操作手册|群聊|\b(?:prd|meego|report|specification|architecture|proposal|design|mockup|plan|research)\b/i.test(purpose)
}

/** Project recorded material entrances without reading or changing the underlying documents. */
export function requirementMaterials(documents: Omit<RequirementDocument, 'content'>[], root: string): RequirementMaterial[] {
  const materials = new Map<string, RequirementMaterial>()
  const visible = documents.filter(doc => ['source', 'artifact'].includes(doc.kind) && !['archived', 'superseded'].includes(doc.status))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  for (const doc of visible) {
    const references = [...new Set(doc.sources.filter(source => source.kind === 'reference' && source.uri).map(source => source.uri!))]
    for (const reference of references) {
      let uri: string, path: string, host = ''
      if (/^https?:\/\//i.test(reference)) {
        const url = new URL(reference)
        uri = url.href; path = url.pathname; host = url.hostname
      } else {
        uri = resolve(root, reference); path = uri
      }
      if (materials.has(uri)) continue
      let name = basename(path) || host
      try { name = decodeURIComponent(name) } catch { /* Keep the recorded name when it is not URI encoded. */ }
      if (!importantMaterial(doc, name, path, host)) continue
      const extension = extname(name).slice(1).toUpperCase()
      const format = /(^|\.)figma\.com$/.test(host) ? 'Figma'
        : /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(host) && /^\/(wiki|docx?|sheets|base|mindnotes)\//.test(path) ? '飞书文档'
          : extension === 'MD' ? 'Markdown' : extension || (host ? '网页' : '文件')
      materials.set(uri, { documentId: doc.id, title: references.length > 1 ? `${doc.title} · ${name}` : doc.title,
        summary: doc.summary, origin: doc.kind === 'source' ? 'user' : 'agent', uri, format, updatedAt: doc.updatedAt })
    }
  }
  return [...materials.values()]
}
