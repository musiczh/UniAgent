import assert from 'node:assert/strict'
import { matchLocalPaths, classifyAnchorHref, classifyExternalHref, classifyImageSrc, canOpenLocalPath } from '../src/renderer/components/Markdown.tsx'
import { resolveAttachmentImageSrc } from '../src/renderer/htmlPreview.ts'
import type { FileBrowserListResult } from '../src/shared/types'

// Relative paths, with and without line suffixes.
assert.deepEqual(matchLocalPaths('见 src/main/index.ts 里'), [
  { index: 2, length: 17, path: 'src/main/index.ts', line: undefined }
])
assert.deepEqual(matchLocalPaths('src/a.ts:42 崩溃'), [
  { index: 0, length: 11, path: 'src/a.ts', line: 42 }
])
assert.deepEqual(matchLocalPaths('src/a.ts:42:7'), [
  { index: 0, length: 13, path: 'src/a.ts', line: 42 }
])
assert.deepEqual(matchLocalPaths('看 README.md#L10'), [
  { index: 2, length: 13, path: 'README.md', line: 10 }
])

// Absolute paths.
const abs = matchLocalPaths('打开 /Users/foo/bar/App.tsx:5 看看')
assert.equal(abs.length, 1)
assert.equal(abs[0].path, '/Users/foo/bar/App.tsx')
assert.equal(abs[0].line, 5)

// Home + dot-relative.
assert.equal(matchLocalPaths('~/notes/todo.md')[0].path, '~/notes/todo.md')
assert.equal(matchLocalPaths('../shared/types.ts')[0].path, '../shared/types.ts')
assert.equal(matchLocalPaths('./run.sh')[0].path, './run.sh')
assert.equal(matchLocalPaths('见 docs/My File.md 里')[0].path, 'docs/My File.md')
assert.equal(matchLocalPaths('见 My Project/file.ts 里')[0].path, 'My Project/file.ts')
assert.equal(matchLocalPaths('见 /Users/me/My File.ts:8 里')[0].path, '/Users/me/My File.ts')
assert.equal(matchLocalPaths('见 docs/My%20File.md')[0].path, 'docs/My File.md')
assert.equal(matchLocalPaths(String.raw`见 docs/My\ File.md`)[0].path, 'docs/My File.md')
assert.deepEqual(matchLocalPaths('文档 docs/UpStep-项目详情页改版方案.md'), [
  { index: 3, length: 24, path: 'docs/UpStep-项目详情页改版方案.md', line: undefined }
])

// Trailing sentence punctuation is trimmed off a separator path.
assert.equal(matchLocalPaths('改了 src/x/y。')[0].path, 'src/x/y')
// …but a real extension keeps its dot.
assert.equal(matchLocalPaths('改了 foo/bar.ts.')[0].path, 'foo/bar.ts')

// Non-paths: plain words, version numbers, URLs are not matched.
assert.deepEqual(matchLocalPaths('hello world'), [])
assert.deepEqual(matchLocalPaths('版本 1.2.3 发布'), [])
assert.deepEqual(matchLocalPaths('see https://example.com/a/b path'), [
  // Only the trailing bare word 'path' has neither sep nor ext → nothing;
  // the URL is excluded by the lookbehind. So no local paths.
].filter(Boolean))
// A bare extensionless word without a separator is ignored.
assert.deepEqual(matchLocalPaths('config'), [])

console.log('markdown path detection tests passed')

// --- classifyAnchorHref: markdown-link hrefs (需求8) ---
// External URLs → null (fall back to openExternal).
assert.equal(classifyAnchorHref('https://example.com/a/b'), null)
assert.equal(classifyAnchorHref('http://foo'), null)
assert.equal(classifyAnchorHref('//example.com/docs'), null)
assert.equal(classifyAnchorHref('mailto:a@b.com'), null)
assert.equal(classifyAnchorHref('#section'), null)
assert.equal(classifyAnchorHref('file:///etc/passwd'), null)
assert.equal(classifyAnchorHref('file%3A///etc/passwd'), null)
assert.equal(classifyAnchorHref('javascript:alert(1)'), null)
assert.equal(classifyAnchorHref('custom:thing/path.ts'), null)

// Relative local paths → candidate.
assert.deepEqual(classifyAnchorHref('src/main/index.ts'), {
  path: 'src/main/index.ts',
  line: undefined
})
assert.deepEqual(classifyAnchorHref('src/a.ts:42'), { path: 'src/a.ts', line: 42 })
assert.deepEqual(classifyAnchorHref('src/a.ts:42:7'), { path: 'src/a.ts', line: 42 })
assert.deepEqual(classifyAnchorHref('README.md#L10'), { path: 'README.md', line: 10 })
assert.deepEqual(classifyAnchorHref('./run.sh'), { path: './run.sh', line: undefined })
assert.deepEqual(classifyAnchorHref('../shared/types.ts'), {
  path: '../shared/types.ts',
  line: undefined
})

// Absolute local paths → candidate.
assert.deepEqual(classifyAnchorHref('/Users/foo/bar/App.tsx:5'), {
  path: '/Users/foo/bar/App.tsx',
  line: 5
})
assert.deepEqual(classifyAnchorHref('docs/My%20File.md#L7'), {
  path: 'docs/My File.md',
  line: 7
})
assert.deepEqual(classifyAnchorHref(String.raw`docs/My\ File.md:9`), {
  path: 'docs/My File.md',
  line: 9
})
assert.deepEqual(classifyAnchorHref('docs/My File.md'), {
  path: 'docs/My File.md',
  line: undefined
})

// Line suffixes are positive, safe, and bounded.
for (const suffix of [':0', '#L0', ':1000001', '#L1000001']) {
  assert.equal(classifyAnchorHref(`src/a.ts${suffix}`), null)
  assert.deepEqual(matchLocalPaths(`src/a.ts${suffix}`), [])
}

// Non-path bare words / numbers → null.
assert.equal(classifyAnchorHref('config'), null)
assert.equal(classifyAnchorHref('1.2.3'), null)
assert.equal(classifyAnchorHref(''), null)
assert.equal(classifyExternalHref('https://example.com/docs'), 'https://example.com/docs')
assert.equal(classifyExternalHref('//example.com/docs'), 'https://example.com/docs')
assert.equal(classifyExternalHref('https://'), null)
assert.equal(classifyExternalHref('mailto:a@example.com'), null)
assert.equal(classifyExternalHref('#section'), null)

console.log('markdown anchor classification tests passed')

// Link styling follows the file browser's actual navigation boundary: a
// slash-shaped prose phrase stays inert unless its parent listing contains a file.
const listings = new Map<string, FileBrowserListResult>([
  ['src/renderer', {
    ok: true, root: '/repo', dirPath: 'src/renderer',
    entries: [{
      name: 'Markdown.tsx', path: 'src/renderer/Markdown.tsx', kind: 'file',
      size: 1, ext: 'tsx', isSymlink: false
    }]
  }],
  ['可变', { ok: true, root: '/repo', dirPath: '可变', entries: [] }]
])
const listDir = async (_sessionId: string, path: string): Promise<FileBrowserListResult> =>
  listings.get(path) || { ok: false, root: '/repo', dirPath: path, entries: [], error: 'missing' }
assert.equal(await canOpenLocalPath('session', 'src/renderer/Markdown.tsx', '/Users/me', listDir), true)
assert.equal(await canOpenLocalPath('session', '可变/固定判断', '/Users/me', listDir), false)
listings.set('docs', {
  ok: true, root: '/repo', dirPath: 'docs',
  entries: [{ name: 'archive', path: 'docs/archive', kind: 'dir', isSymlink: false }]
})
assert.equal(await canOpenLocalPath('session', 'docs/archive', '/Users/me', listDir), false)
let absoluteRequest: [string, string, string | undefined] | undefined
assert.equal(await canOpenLocalPath('session', '/tmp/report.md', '/Users/me', async (...args) => {
  absoluteRequest = args
  return {
    ok: true, root: '/tmp', dirPath: '',
    entries: [{ name: 'report.md', path: 'report.md', kind: 'file', size: 0, isSymlink: false }]
  }
}), true)
assert.deepEqual(absoluteRequest, ['session', '', '/tmp'])

console.log('markdown path openability tests passed')

// --- classifyImageSrc: local `![](src)` images (需求8-图片) ---
const HOME = '/Users/me'
// Remote / data / blob srcs are left untouched (null → keep original <img src>).
assert.equal(classifyImageSrc('https://example.com/a.png', HOME), null)
assert.equal(classifyImageSrc('http://foo/a.png', HOME), null)
assert.equal(classifyImageSrc('data:image/png;base64,AAAA', HOME), null)
assert.equal(classifyImageSrc('blob:abc', HOME), null)
assert.equal(classifyImageSrc('', HOME), null)

// Relative paths pass through unchanged (fileBrowser resolves against workdir).
assert.deepEqual(classifyImageSrc('assets/logo.png', HOME), {
  path: 'assets/logo.png',
  rootOverride: undefined
})
assert.deepEqual(classifyImageSrc('./shot.png', HOME), {
  path: './shot.png',
  rootOverride: undefined
})

// `~/` expands via homeDir, then splits like an absolute path.
assert.deepEqual(classifyImageSrc('~/pics/cat.png', HOME), {
  path: 'cat.png',
  rootOverride: '/Users/me/pics'
})

// Absolute paths split into directory (rootOverride) + filename (path).
assert.deepEqual(classifyImageSrc('/Users/me/pics/cat.png', HOME), {
  path: 'cat.png',
  rootOverride: '/Users/me/pics'
})
// A file at filesystem root keeps rootOverride '/'.
assert.deepEqual(classifyImageSrc('/cat.png', HOME), {
  path: 'cat.png',
  rootOverride: '/'
})

console.log('markdown image src classification tests passed')

// attachment:// is only a display alias for image files in the project's mockup directory.
assert.equal(resolveAttachmentImageSrc('attachment://session-multiselect-context.png'), '.trae/mockups/session-multiselect-context.png')
assert.equal(resolveAttachmentImageSrc('attachment://session%20preview.webp'), '.trae/mockups/session preview.webp')
assert.equal(resolveAttachmentImageSrc('attachment://../secret.png'), null)
assert.equal(resolveAttachmentImageSrc('attachment://notes.txt'), null)
