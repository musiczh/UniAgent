import { createHash } from 'node:crypto'

export const PUBLIC_REPO = 'https://github.com/musiczh/UniAgent'
export const PUBLIC_SITE = 'https://musiczh.github.io/UniAgent/'
export const PUBLIC_APP_NAME = 'UniAgent Public'
export const PUBLIC_ARTIFACT_PREFIX = 'UniAgent-Public'

export function removeMatchingElements(html, tag, matches) {
  const token = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi')
  const stack = [], ranges = []
  for (const match of html.matchAll(token)) {
    if (!match[0].startsWith('</')) stack.push({ start: match.index, open: match[0] })
    else {
      const start = stack.pop()
      if (start && matches(start.open, html.slice(start.start, match.index + match[0].length))) ranges.push([start.start, match.index + match[0].length])
    }
  }
  const outer = ranges.filter(([start, end]) => !ranges.some(([a, b]) => a < start && b > end))
  for (const [start, end] of outer.sort((a, b) => b[0] - a[0])) html = html.slice(0, start) + html.slice(end)
  return html
}

export function buildPublicWebsite(html, { version, desktopImage, connectionImage } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid public website version')
  for (const [id, source] of [['workbench-image', desktopImage], ['mobile-image', connectionImage], ['modal-image', desktopImage]]) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(source || '')) throw new Error(`Missing reviewed public image: ${id}`)
    const image = new RegExp(`(<img\\b[^>]*id="${id}"[^>]*src=")[^"]*(")`)
    if (!image.test(html)) throw new Error(`Missing image element: ${id}`)
    html = html.replace(image, (_, before, after) => before + source + after)
  }
  html = removeMatchingElements(html, 'div', (open, content) => /class="agent"/.test(open) && /TraeX|\bNika\b/.test(content))
  html = removeMatchingElements(html, 'a', open => /\bid="nav-docs"/.test(open))
  html = removeMatchingElements(html, 'div', (open, content) => /class="peer-node"/.test(open) && /TraeX|\bNika\b/.test(content))
  html = removeMatchingElements(html, 'li', (_open, content) => /Kaboo|Bonsai|\bNika\b|公司内部|更新检查迁移到 Bits/.test(content))
  html = html.replace('Nika、侧边评论与原生会话控制', '侧边评论与原生会话控制')
  html = html.replace('原生能力、会话导入与 Bits 更新', '原生能力与会话导入')
  html = removeMatchingElements(html, 'button', open => /id="tab-local"/.test(open))
  html = removeMatchingElements(html, 'div', open => /id="panel-local"/.test(open))
  html = removeMatchingElements(html, 'span', (_open, content) => content.replace(/<[^>]*>/g, '').trim() === '本地大模型')
  html = removeMatchingElements(html, 'p', (_open, content) => content.includes('也可以下载、校验并部署受支持的本地模型'))
  html = html.replace('共用第三方来源；本地模型独立管理。', '共用第三方来源。')
    .replace('；也可在 Mac 上部署受支持的本地模型供 Codex 调用。', '。')
    .replace('；也可下载并运行供 Codex 调用的本地模型。', '。')
    .replace('；本地大模型拥有独立设置入口。', '。')
    .replace('本地模型推理在本机进行，不等于 Agent 调用的联网工具也离线。', '')
    .replace('本地“下载”不修改 Codex，“配置并运行”会写入配置；运行受硬件与模型目录限制。', '')
    .replace('下载并运行受支持的本地模型，', '')
    .replace('与本地模型入口。', '模型来源。')
    .replace("document.getElementById('tab-local')];", "document.getElementById('tab-local')].filter(Boolean);")
    .replace('Codex 与 TraeX 提供较完整的工作台能力', 'Codex 提供较完整的工作台能力')
  html = html.replace(/connect-src[^;"]*/g, "connect-src 'self'")
  html = html.replace(/https:\/\/code\.byted\.org\/zhenghuan\.zheng\/UniAgent\/raw\/master\/release\/v[^/]+\/UniAgent-[^"<>\s]+\.dmg/g,
    `${PUBLIC_REPO}/releases/download/v${version}/${PUBLIC_ARTIFACT_PREFIX}-${version}-arm64.dmg`)
  html = html.replace(/https:\/\/code\.byted\.org\/zhenghuan\.zheng\/UniAgent\/raw\/master\/release\/latest\.json/g, `${PUBLIC_SITE}latest.json`)
  html = html.replace(/url='https:\/\/code\.byted\.org\/zhenghuan\.zheng\/UniAgent\/raw\/master\/'\+manifest\.path/g,
    `url='${PUBLIC_REPO}/releases/download/v'+manifest.version+'/${PUBLIC_ARTIFACT_PREFIX}-'+manifest.version+'-arm64.dmg'`)
  html = html.replace("name='UniAgent-'+manifest.version+'-arm64.dmg'", `name='${PUBLIC_ARTIFACT_PREFIX}-'+manifest.version+'-arm64.dmg'`)
  html = html.replace(/https:\/\/code\.byted\.org\/zhenghuan\.zheng\/UniAgent(?:\.git)?/g, PUBLIC_REPO)
  html = html.replace(/https:\/\/bytedance\.larkoffice\.com\/[^\s'"<>]+/g, PUBLIC_REPO + '#readme')
  html = html.replace('再选择 TraeX。', '再选择目标 Agent。')
    .replace(/Codex、TraeX 与 Claude Code/g, 'Codex 与 Claude Code').replace(/Codex 与 TraeX/g, 'Codex 与 Claude Code')
    .replace(/TraeX、?/g, '').replace(/、\s*与/g, '与')
  html = html.replace('九种 Agent，一个工作台。', '七种 Agent，一个工作台。')
    .replace('统一八种 Agent', '统一七种 Agent')
    .replace('新增第八种 Agent，', '新增 Agent，')
  html = html.replace(/(<a id="latest-download"[\s\S]*?href=")[^"]*(")/, `$1${PUBLIC_REPO}/releases/download/v${version}/${PUBLIC_ARTIFACT_PREFIX}-${version}-arm64.dmg$2`)
    .replace(/(<a id="latest-download"[\s\S]*?download=")[^"]*(")/, `$1${PUBLIC_ARTIFACT_PREFIX}-${version}-arm64.dmg$2`)
  html = html.replace('UniAgent 实际桌面界面：在统一会话中展示工作过程、Hook 与工具调用。', 'UniAgent 公共组件演示：在统一会话中展示工作过程与工具调用，内容为示例数据。')
    .replace('UniAgent 真实手机通知截图：用户在移动端查看 Agent 任务与此前回复。', 'UniAgent 飞书连接设置示例，内容为示例数据。')
    .replace('UniAgent 工作台 · 进展、工具调用与交付，一处查看', 'UniAgent 工作台 · 组件演示，使用示例数据')
    .replace('飞书会话 · 查看进展，随时接手', '飞书连接设置 · 组件演示，使用示例数据')
    .replace('aria-label="UniAgent 实际截图"', 'aria-label="UniAgent 界面示例"')
    .replace('UniAgent 实际产品截图放大图。', 'UniAgent 公共组件演示放大图，内容为示例数据。')
  if (!html.includes('id="public-distribution-styles"')) html = html.replace('</head>', '<style id="public-distribution-styles">\n#feishu .two-col{grid-template-columns:1fr 1fr}.mobile-proof{width:100%;max-width:480px}.mobile-proof-frame{border-radius:12px}\n@media(max-width:740px){#feishu .two-col{grid-template-columns:1fr}}\n</style>\n</head>')
  html = html.replace(/^[ \t]+$/gm, '')
  // Rename visible branding while preserving repository URLs, script and style code.
  html = html.split(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>|<[^>]+>)/gi)
    .map(part => part.startsWith('<') ? part : part.replace(/\bUniAgent\b(?! Public)/g, PUBLIC_APP_NAME)).join('')
    .replace('content="UniAgent 多 Agent', `content="${PUBLIC_APP_NAME} 多 Agent`)
  const privateContent = html.match(/https?:\/\/[^\s'"<>]*(?:byted|byteintl|nika\.fan)[^\s'"<>]*|Kaboo|Bonsai|TraeX|\bNika\b|本地大模型|本地模型|八种 Agent|九种 Agent|第八种 Agent/g)
  if (privateContent) throw new Error('Private website content remains: ' + [...new Set(privateContent)].map(value => value.slice(0, 100)).join(', '))
  const anchor = html.match(/<a id="latest-download"[\s\S]*?<\/a>/)?.[0]
  if (!anchor?.includes(`/releases/download/v${version}/`)) throw new Error('Public download fallback is not in sync')
  return { html, sha256: createHash('sha256').update(html).digest('hex') }
}
