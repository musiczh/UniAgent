import { Marked, type Token, type Tokens, type TokensList } from 'marked'

export interface HtmlPreviewReference {
  path?: string
  title?: string
  pending?: boolean
  error?: string
}

export type PreviewMarkdownPart =
  | { html: string }
  | { preview: HtmlPreviewReference }
  | { mermaid: string }

const ATTACHMENT_IMAGE = new RegExp('^attachment://([^/?#]+)(?:[?#].*)?$', 'i')

/** UniAgent has no attachment:// registry; map image-only references to the
 * conventional mockup directory in the current project instead. */
export function resolveAttachmentImageSrc(href: string): string | null {
  const match = ATTACHMENT_IMAGE.exec(href.trim())
  if (!match) return null
  let name: string
  try { name = decodeURIComponent(match[1]) } catch { return null }
  return /^[^/\\\0]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(name)
    ? `.trae/mockups/${name}`
    : null
}

function isMermaidCode(token: Token): token is Tokens.Code {
  return token.type === 'code' && (token.lang || '').trim().toLowerCase() === 'mermaid'
}

/** Preserve file-relative assets when an HTML file is rendered through srcdoc. */
export function withHtmlPreviewBase(html: string, baseUrl?: string): string {
  if (!baseUrl || /<base\b[^>]*\bhref\s*=/i.test(html)) return html

  const escapedUrl = baseUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const baseTag = `<base href="${escapedUrl}">`
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head?.index !== undefined) {
    const insertion = head.index + head[0].length
    return `${html.slice(0, insertion)}${baseTag}${html.slice(insertion)}`
  }

  const documentHead = `<head>${baseTag}</head>`
  const htmlTag = /<html(?:\s[^>]*)?>/i.exec(html)
  if (htmlTag?.index !== undefined) {
    const insertion = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, insertion)}${documentHead}${html.slice(insertion)}`
  }

  const doctype = /<!doctype[^>]*>/i.exec(html)
  if (doctype?.index !== undefined) {
    const insertion = doctype.index + doctype[0].length
    return `${html.slice(0, insertion)}${documentHead}${html.slice(insertion)}`
  }
  return `${documentHead}${html}`
}

function parseReference(payload: string): HtmlPreviewReference {
  if (!payload.trimEnd().endsWith('')) return { pending: true }
  try {
    const value = JSON.parse(payload.trimEnd().slice(0, -1))
    if (!value || typeof value.path !== 'string' || !value.path.trim()) {
      return { error: '预览引用缺少文件路径' }
    }
    const path = value.path.trim()
    if (!/\.html?$/i.test(path) || /[\0\r\n]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) {
      return { error: '预览仅支持本地 HTML 文件' }
    }
    if (path.split('/').includes('..')) return { error: '无效的文件路径' }
    return { path, title: typeof value.title === 'string' ? value.title : undefined }
  } catch {
    return { error: '预览引用格式无效' }
  }
}

/** Only standalone references become previews; code examples remain Markdown. */
export function parsePreviewMarkdown(text: string): PreviewMarkdownPart[] {
  const parser = new Marked({ gfm: true, breaks: true })
  parser.use({
    renderer: {
      image(token) {
        const src = resolveAttachmentImageSrc(token.href)
        if (!src) return false
        const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<img src="${escape(src)}" alt="${escape(token.text)}"${token.title ? ` title="${escape(token.title)}"` : ''}>`
      }
    },
    extensions: [{
      name: 'htmlPreview',
      level: 'block',
      start(source) {
        const match = /(?:^|\n)( {0,3}visualize)/.exec(source)
        return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined
      },
      tokenizer(source) {
        const match = /^ {0,3}visualize([^\r\n]*)(?:\r?\n|$)/.exec(source)
        if (match) return { type: 'htmlPreview', raw: match[0], preview: parseReference(match[1]) }
      },
      // Nested examples (lists / blockquotes) keep their literal reference.
      renderer(token) {
        return `<p>${token.raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
      },
    }],
  })
  const tokens = parser.lexer(text)
  const parts: PreviewMarkdownPart[] = []
  let buffered: Token[] = []
  const flush = (): void => {
    if (!buffered.length) return
    parts.push({ html: parser.parser(Object.assign(buffered, { links: tokens.links }) as TokensList) })
    buffered = []
  }
  for (const token of tokens) {
    if (token.type === 'htmlPreview') {
      flush()
      parts.push({ preview: token.preview as HtmlPreviewReference })
    } else if (isMermaidCode(token)) {
      flush()
      parts.push({ mermaid: token.text })
    } else {
      buffered.push(token)
    }
  }
  flush()
  return parts.length ? parts : [{ html: '' }]
}
