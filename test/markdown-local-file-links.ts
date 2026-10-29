import assert from 'node:assert/strict'
import type { UAEvent } from '../src/shared/types'
import { renderEventStream } from './regression/render-event-stream.mjs'

// Regression: agent replies that reference sibling files as ordinary relative
// Markdown (e.g. `![alt](docs/mockup.png)`, `[HTML](docs/mockup.html)`) used to
// lose their src/href during sanitization because the custom DOMPurify URI
// allowlist parsed `.-:` as a character range containing `/`. The image then
// showed Chromium's broken-image placeholder and the link had no href, so no
// click handler could ever run.
const sessionId = 'markdown-local-file-links'
const message = `## 设计稿

![Token 消耗日视图：当前历史分布 vs 改后当天每小时用量](docs/token-usage-hourly-mockup.png)

源文件在 [设计稿 HTML](docs/token-usage-hourly-mockup.html)，可按反馈直接改。

[官网](https://example.com/docs) 与 [危险链接](javascript:alert(1))。
`
const events: UAEvent[] = [
  { sessionId, seq: 1, ts: 1, type: 'user_message', state: 'success', payload: { text: '确认' } },
  { sessionId, seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: { text: message } }
]

const setup = `
  window.uniagent = {
    homeDir: '/Users/me',
    fsListDir: async (_sessionId, path) => {
      if (path === 'docs') return { ok: true, root: '/repo', dirPath: 'docs', entries: [
        { name: 'token-usage-hourly-mockup.html', path: 'docs/token-usage-hourly-mockup.html', kind: 'file', size: 1, ext: 'html', isSymlink: false },
        { name: 'token-usage-hourly-mockup.png', path: 'docs/token-usage-hourly-mockup.png', kind: 'file', size: 1, ext: 'png', isSymlink: false }
      ] };
      return { ok: false, root: '/repo', dirPath: path, entries: [], error: 'missing' };
    },
    fsReadFile: async (_sessionId, path) => {
      (window.__imageReads ||= []).push(path);
      return path.endsWith('.png')
        ? { ok: true, path, kind: 'image', size: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzGQAAAABJRU5ErkJggg==' }
        : { ok: false, path, kind: 'binary', size: 0, error: 'unused' };
    },
    openExternal: async (url) => { (window.__externalOpens ||= []).push(url); }
  };
`
const inspect = `(async () => {
  const root = document.querySelector('.agent-md');
  const image = root.querySelector('img');
  const link = [...root.querySelectorAll('a')].find((anchor) => anchor.textContent === '设计稿 HTML');
  const external = [...root.querySelectorAll('a')].find((anchor) => anchor.textContent === '官网');
  const dangerous = [...root.querySelectorAll('a')].find((anchor) => anchor.textContent === '危险链接');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (image?.getAttribute('src')?.startsWith('data:image/png;base64,') && link?.classList.contains('md-path')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  external?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return JSON.stringify({
    imageSrc: image?.getAttribute('src')?.slice(0, 22) || null,
    imageResolved: image?.dataset.localResolved || null,
    imageReads: window.__imageReads || [],
    localHref: link?.getAttribute('href') || null,
    localClass: link?.className || '',
    localPath: link?.dataset.path || null,
    openedFiles: window.__openedFiles || [],
    externalHref: external?.getAttribute('href') || null,
    externalOpens: window.__externalOpens || [],
    dangerousHref: dangerous?.getAttribute('href') ?? null
  });
})()`

type Rendered = {
  imageSrc: string | null
  imageResolved: string | null
  imageReads: string[]
  localHref: string | null
  localClass: string
  localPath: string | null
  openedFiles: Array<[string, number | null]>
  externalHref: string | null
  externalOpens: string[]
  dangerousHref: string | null
}

const rendered = JSON.parse(await renderEventStream(events, 'idle', sessionId, {
  setup,
  inspect,
  fileLinks: true
})) as Rendered

assert.equal(rendered.imageSrc, 'data:image/png;base64,', 'relative image src survives sanitization and resolves to a data URL')
assert.equal(rendered.imageResolved, '1', 'image resolver processed the relative reference')
assert.deepEqual(rendered.imageReads, ['docs/token-usage-hourly-mockup.png'])

assert.equal(rendered.localHref, 'docs/token-usage-hourly-mockup.html', 'relative Markdown href survives sanitization')
assert.ok(rendered.localClass.split(' ').includes('md-path'), 'verified local link is actionable')
assert.equal(rendered.localPath, 'docs/token-usage-hourly-mockup.html')
assert.equal(rendered.openedFiles.length, 1, 'clicking the HTML link opens the built-in file viewer exactly once')
assert.equal(rendered.openedFiles[0][0], 'docs/token-usage-hourly-mockup.html')

assert.equal(rendered.externalHref, 'https://example.com/docs')
assert.deepEqual(rendered.externalOpens, ['https://example.com/docs'], 'external links still go through the shell')
assert.equal(rendered.dangerousHref, null, 'dangerous URI schemes stay stripped')

console.log('markdown local file link and image rendering tests passed')
