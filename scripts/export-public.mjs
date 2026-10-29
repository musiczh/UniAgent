import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { buildPublicWebsite, PUBLIC_APP_NAME, PUBLIC_ARTIFACT_PREFIX } from './public-website.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const internalFiles = new Set([
  'src/main/kaboo.ts', 'src/main/localModelCli.ts', 'src/main/localModelService.ts',
  'src/main/localModelDiagnostics.ts', 'src/main/bitsReleaseSource.ts',
  'src/renderer/components/LocalModelSettings.tsx', 'src/renderer/components/NikaSettings.tsx', 'scripts/release.sh', 'scripts/sync-download-page.mjs',
  'test/kaboo.test.mjs', 'test/local-model-cli.ts', 'test/local-model-service.ts',
  'test/local-model-ui.tsx', 'test/local-model-overlay.ts', 'test/bits-release-source.test.ts',
  'test/release-workflow.test.mjs'
])
const rootFiles = new Set(['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'electron.vite.config.ts', 'LICENSE', '.gitignore'])
const sourceDirectories = ['src/', 'native/', 'build/', 'resources/', 'patches/', 'scripts/', 'test/']
const privateHost = /(?:https?:\/\/[^\s'"<>)]*(?:code\.byted\.org|bnpm\.byted\.org|kaboo\.bytedance\.net|bytedance\.larkoffice\.com|ida-app\.bytedance\.net|nika\.fan)|@bytedance-dev\/bonsai-codex)/i

/** Remove only explicitly delimited source regions; malformed/nested markers fail closed. */
export function stripInternalRegions(text, path = '') {
  const marker = /\{\/\*\s*@internal:(start|end)\s+([\w-]+)\s*\*\/\}|\/\*\s*@internal:(start|end)\s+([\w-]+)\s*\*\//g
  const ranges = []
  let open
  for (const match of text.matchAll(marker)) {
    const kind = match[1] || match[3], key = match[2] || match[4]
    if (kind === 'start') {
      if (open) throw new Error(`Nested internal region in ${path}`)
      open = { key, start: match.index }
    } else {
      if (!open || open.key !== key) throw new Error(`Unbalanced internal region in ${path}`)
      ranges.push([open.start, match.index + match[0].length])
      open = undefined
    }
  }
  if (open) throw new Error(`Unclosed internal region in ${path}`)
  for (const [start, end] of ranges.reverse()) text = text.slice(0, start) + text.slice(end)
  return text
}

// Keep shared protocol/history types, but remove the private built-in and private installation material.
export function stripPrivateAgentEntries(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  if (source.parseDiagnostics.length) throw new Error(`Invalid source before public export: ${path}`)
  const removals = []
  const visit = node => {
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
      const elements = ts.isArrayLiteralExpression(node) ? node.elements : node.properties
      elements.forEach((element, index) => {
        const privateBuiltin = path === 'src/main/agents.ts' && ts.isObjectLiteralExpression(element) && element.properties.some(property =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'id' && ts.isStringLiteral(property.initializer) && ['traex', 'nika'].includes(property.initializer.text))
        const privateGuide = ts.isPropertyAssignment(element) && ['traex', 'nika'].includes(element.name.getText(source).replace(/['"]/g, '')) &&
          (privateHost.test(element.getText(source)) || /bytedance\.com|byteintl\.net/.test(element.getText(source)))
        const privateAsset = path === 'src/renderer/components/agentIconData.ts' && ts.isPropertyAssignment(element) && element.name.getText(source) === 'nika'
        if (!privateBuiltin && !privateGuide && !privateAsset) return
        let start = element.getFullStart(), end = element.end
        if (text[end] === ',') end++
        else if (index > 0) start = elements[index - 1].end
        removals.push([start, end])
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + text.slice(end)
  return text
}

export function publicSource(text, path) {
  if (path.startsWith('src/')) text = stripInternalRegions(text, path)
  if (path === 'src/shared/distribution.ts') return `export const INTERNAL_DISTRIBUTION = false\nexport const APP_NAME = '${PUBLIC_APP_NAME}'\nexport const APP_BUNDLE_ID = 'com.uniagent.public'\nexport const PUBLIC_ARTIFACT_PREFIX = '${PUBLIC_ARTIFACT_PREFIX}'\nexport const PUBLIC_REPOSITORY = 'https://github.com/musiczh/UniAgent'\nexport const PUBLIC_WEBSITE = 'https://musiczh.github.io/UniAgent/'\nexport const APP_REPOSITORY = PUBLIC_REPOSITORY\nexport function isDistributionAgent(agentId: string, adapter?: string): boolean { return !['traex', 'nika'].includes(agentId) && !['traex', 'nika'].includes(adapter || '') }\n`
  if (path === 'src/main/releaseSource.ts') return "export { RELEASE_REPOSITORY_PAGE, ReleaseSourceError, readLatestRelease } from './githubReleaseSource'\n"
  if (path.startsWith('src/') && /\.[cm]?[jt]sx?$/.test(path)) text = stripPrivateAgentEntries(text, path)
  text = text.replace('', '')
  if (/^test\/cdp[^/]*\.mjs$/.test(path)) text = text.replaceAll('UniAgent.app', PUBLIC_APP_NAME + '.app')
    .replace(/\/MacOS\/UniAgent(?! Public)/g, '/MacOS/' + PUBLIC_APP_NAME)
    .replace(/(['"])UniAgent\1/g, (_match, quote) => quote + PUBLIC_APP_NAME + quote)
  // Requirement metadata belongs to the project format and is shared by both editions.
  // Only its application-level default home changes with the distribution.
  if (/^(?:src\/main|test)\/requirement/.test(path)) {
    text = text.replace("resolveUserDataHome(join(homedir(), '.uniagent-public'))", "resolveUserDataHome(join(homedir(), '.uniagent-public'))")
  } else if (!['src/main/kimiInstallation.ts', 'test/kimi-installation.ts'].includes(path)) {
    text = text.replace(/(['"])\.uniagent(?=\1|\/)/g, '$1.uniagent-public')
  }
  if (path.startsWith('src/') && privateHost.test(text)) throw new Error(`Private runtime dependency remains in ${path}`)
  return text
}

export function publicPackage(value, version = value.version) {
  return {
    ...value, version, name: 'uniagent-public', productName: PUBLIC_APP_NAME,
    description: PUBLIC_APP_NAME + ' — a desktop workbench for coding agents',
    repository: { type: 'git', url: 'git+https://github.com/musiczh/UniAgent.git' },
    homepage: 'https://musiczh.github.io/UniAgent/',
    keywords: value.keywords.filter(word => word !== 'traex'),
    scripts: Object.fromEntries(Object.entries({ ...value.scripts, release: 'node scripts/release-public.mjs --publish' })
      .filter(([, command]) => ![...internalFiles].some(path => command.includes(path)))
      .map(([name, command]) => [name, command.replaceAll('release/mac-arm64/UniAgent.app/Contents/MacOS/UniAgent', '"release/mac-arm64/' + PUBLIC_APP_NAME + '.app/Contents/MacOS/' + PUBLIC_APP_NAME + '"')])),
    build: { ...value.build, appId: 'com.uniagent.public', productName: PUBLIC_APP_NAME, artifactName: PUBLIC_ARTIFACT_PREFIX + '-${version}-${arch}.${ext}',
      dmg: { ...value.build?.dmg, artifactName: PUBLIC_ARTIFACT_PREFIX + '-${version}-${arch}.${ext}' } }
  }
}

const publicReadme = `# UniAgent Public\n\nmacOS 多 Agent 桌面工作台。支持 Codex、Claude Code、Grok、Kimi Code、DeepSeek Harness、MiniMax Code 和 ZCode，保留各家原生协议、账号和能力。\n\n官网：https://musiczh.github.io/UniAgent/\n\n下载：https://github.com/musiczh/UniAgent/releases/latest\n\n将 \`UniAgent Public.app\` 拖入 Applications，可与内网 \`UniAgent.app\` 同时安装。应用 ID、UniAgent 会话与设置、缓存和更新源彼此独立。本机原生 Agent 程序、配置、历史、Skills 和登录态继续共用；修改原生配置会同时影响两版。UniAgent 托管服务的连接配置、运行状态与输入账本仍各自保存。\n\n## 开发\n\n需要 Node.js 20+、pnpm 9+、Xcode Command Line Tools。\n\n\`\`\`bash\npnpm install --frozen-lockfile --registry=https://registry.npmjs.org\npnpm dev\npnpm test\npnpm run pack\n\`\`\`\n\n会话、工具与插件、团队、飞书助手、定时任务、评论和本机用量沿用同一套公共实现。各 Agent 的安装、登录与模型计费由对应官方服务提供；API Key 只在专用设置表单输入。\n\n公开源码由维护者的统一研发主线生成。外部贡献请提交 PR，维护者回流主线后同步，避免生成结果覆盖贡献。\n\nMIT License；第三方通知见应用内许可证资源。\n`

export async function exportPublic({ sourceRoot = root, destination, ref = 'HEAD', workingTree = false, version } = {}) {
  if (!destination) throw new Error('Public export requires an empty destination directory')
  destination = resolve(destination)
  if (destination === resolve(sourceRoot) || resolve(sourceRoot).startsWith(destination + '/')) throw new Error('Unsafe export destination')
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Public export destination must be empty')
  const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const commit = git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').toString().trim()
  const files = git(...(workingTree ? ['ls-files', '-z'] : ['ls-tree', '-r', '--name-only', '-z', commit])).toString().split('\0').filter(Boolean)
  const modes = new Map(git(...(workingTree ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', commit])).toString().split('\0').filter(Boolean).map(row => {
    const [header, path] = row.split('\t'); return [path, header.split(' ')[0]]
  }))
  const read = path => workingTree ? readFile(join(sourceRoot, path)) : Promise.resolve(git('show', `${commit}:${path}`))
  const digest = createHash('sha256')
  const paths = []
  let count = 0
  for (const path of files.sort()) {
    if (internalFiles.has(path) || path.startsWith('src/main/nika/') || /^test\/(?:nika-[^/]+|cdp-nika)\.[cm]?[jt]sx?$/.test(path) || path.startsWith('test/fixtures/nika-') || path.startsWith('test/fixtures/traex/') ||
        !rootFiles.has(path) && !sourceDirectories.some(prefix => path.startsWith(prefix)) &&
        !['docs/research/hermes-assistant-notices.md', 'docs/testing/engine-cases.md',
          'docs/mockups/public-workbench-v1.1.0.png', 'docs/mockups/public-feishu-v1.1.0.png',
          'docs/share/uniagent-introduction/web-design-preview.html'].includes(path)) continue
    // Runtime dumps, probe outputs and design artifacts are not build inputs.
    if (/\.(?:log|dmg|app|png\.json)$/.test(path) || path.startsWith('scripts/public-assets/')) continue
    if (modes.get(path) === '120000' || workingTree && (await lstat(join(sourceRoot, path))).isSymbolicLink()) throw new Error(`Symlinks require an explicit public export rule: ${path}`)
    let content = await read(path)
    if (path === 'package.json') content = Buffer.from(JSON.stringify(publicPackage(JSON.parse(content), version), null, 2) + '\n')
    else if (path === 'docs/share/uniagent-introduction/web-design-preview.html') {
      content = Buffer.from(buildPublicWebsite(content.toString(), {
        version: version || JSON.parse(await read('package.json')).version,
        desktopImage: 'data:image/png;base64,' + (await read('docs/mockups/public-workbench-v1.1.0.png')).toString('base64'),
        connectionImage: 'data:image/png;base64,' + (await read('docs/mockups/public-feishu-v1.1.0.png')).toString('base64')
      }).html)
    }
    else if (/^src\/renderer\/[^/]+\.html$/.test(path)) {
      content = Buffer.from(content.toString().replace(/(<title>)[^<]*(<\/title>)/, `$1${PUBLIC_APP_NAME}$2`)
        .replace(/(<h1 id="ua-startup-title">)UniAgent(<\/h1>)/, `$1${PUBLIC_APP_NAME}$2`))
    }
    else if (/\.[cm]?[jt]sx?$/.test(path)) content = Buffer.from(publicSource(content.toString(), path))
    if (path === '.gitignore') content = Buffer.from('node_modules/\nout/\nrelease/\ndist/\n*.log\n.DS_Store\n')
    await mkdir(dirname(join(destination, path)), { recursive: true })
    await writeFile(join(destination, path), content)
    await chmod(join(destination, path), modes.get(path) === '100755' ? 0o755 : 0o644)
    digest.update(path + '\0').update(content).update('\0')
    paths.push(path)
    count++
  }
  await writeFile(join(destination, 'README.md'), publicReadme)
  await writeFile(join(destination, 'AGENTS.md'), '# UniAgent public development\n\nKeep startup UI responsive. Preserve native Agent protocols. Add behavioral regression coverage for changes. Run pnpm test and pnpm run pack before delivery. Do not print or commit credentials. Public release and website publication require maintainer review.\n')
  const fingerprint = digest.update(publicReadme).digest('hex')
  return { destination, files: count + 2, fingerprint, paths: [...paths, 'README.md', 'AGENTS.md'] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2]
  const result = await exportPublic({ destination, workingTree: process.argv.includes('--working-tree') })
  console.log(JSON.stringify({ ...result, paths: undefined }))
}
