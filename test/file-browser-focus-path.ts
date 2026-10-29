import assert from 'node:assert/strict'
import { focusedLinePreviewError, toWorkdirRelative } from '../src/renderer/components/FileBrowser.tsx'
import { retainAttachmentPreviews } from '../src/renderer/hooks.ts'
import { withHtmlPreviewBase } from '../src/renderer/htmlPreview.ts'

const root = '/Users/me/proj'
const home = '/Users/me'

// Relative paths pass through, normalized.
assert.equal(toWorkdirRelative(root, home, 'src/a.ts'), 'src/a.ts')
assert.equal(toWorkdirRelative(root, home, './src/a.ts'), 'src/a.ts')

// Absolute inside root → relative; the root itself → ''.
assert.equal(toWorkdirRelative(root, home, '/Users/me/proj/src/a.ts'), 'src/a.ts')
assert.equal(toWorkdirRelative(root, home, '/Users/me/proj'), '')

// Home expansion when the resolved path lands inside root.
assert.equal(toWorkdirRelative(root, home, '~/proj/src/a.ts'), 'src/a.ts')

// Outside root, parent-escape, and bogus input are rejected.
assert.equal(toWorkdirRelative(root, home, '/etc/passwd'), null)
assert.equal(toWorkdirRelative(root, home, '../other/x'), null)
assert.equal(toWorkdirRelative(root, home, 'src/../../escape'), null)
assert.equal(toWorkdirRelative(root, home, '~/notes/todo.md'), null)
assert.equal(toWorkdirRelative('', home, '/Users/me/proj/a.ts'), null)
assert.equal(toWorkdirRelative(root, home, 'file:///Users/me/proj/src/a.ts'), null)
assert.equal(toWorkdirRelative(root, home, 'src/a\0.ts'), null)

// Focus requests never silently point at a row absent from the loaded preview.
assert.equal(focusedLinePreviewError(1_000, undefined), undefined)
assert.match(focusedLinePreviewError(1_001, undefined) || '', /前 1000 行/)
assert.equal(focusedLinePreviewError(3, 'one\ntwo\nthree'), undefined)
assert.match(focusedLinePreviewError(4, 'one\ntwo\nthree') || '', /只有 3 行/)

const htmlWithRelativeStyle = '<!doctype html><html><head><link rel="stylesheet" href="./page.css"></head><body></body></html>'
assert.match(
  withHtmlPreviewBase(htmlWithRelativeStyle, 'file:///Users/me/proj/'),
  /<head><base href="file:\/\/\/Users\/me\/proj\/">/
)
const htmlWithOwnBase = '<html><head><base href="https://example.com/"></head></html>'
assert.equal(withHtmlPreviewBase(htmlWithOwnBase, 'file:///Users/me/proj/'), htmlWithOwnBase)

assert.deepEqual(
  retainAttachmentPreviews(
    { '/tmp/a.png': 'data:a', '/tmp/b.png': 'data:b' },
    [{ kind: 'image', path: '/tmp/b.png', name: 'b.png' }]
  ),
  { '/tmp/b.png': 'data:b' }
)

console.log('file browser focus-path resolution tests passed')
