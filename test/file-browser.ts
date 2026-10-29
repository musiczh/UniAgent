import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  listDir, MAX_DIRECTORY_ENTRIES, MAX_PREVIEW_BYTES, pickedFile, readFileForPreview, resolveHtmlWithinRoot, resolveWithinRoot
} from '../src/main/fileBrowser'

test('file browser confines paths and returns bounded previews', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'uniagent-file-browser-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  const outside = join(base, 'outside.txt')
  await mkdir(join(root, 'z-dir'), { recursive: true })
  await mkdir(join(root, 'a-dir'))
  await writeFile(join(root, 'b.txt'), 'plain text')
  await writeFile(join(root, 'slash\\name.txt'), 'backslash name')
  await writeFile(join(root, 'a.bin'), Buffer.from([1, 0, 2]))
  await writeFile(join(root, 'inside.txt'), 'inside')
  await writeFile(outside, 'secret')
  await symlink(join(root, 'inside.txt'), join(root, 'inside-link'))
  await symlink(outside, join(root, 'escape-link'))

  const listing = await listDir(root, '.')
  assert.equal(listing.ok, true)
  assert.deepEqual(listing.entries.slice(0, 2).map(({ name }) => name), ['a-dir', 'z-dir'])
  assert.equal(listing.entries.find(({ name }) => name === 'escape-link')?.isSymlink, true)
  const slashName = listing.entries.find(({ name }) => name === 'slash\\name.txt')
  assert.equal(slashName?.path, 'slash\\name.txt')
  assert.equal((await readFileForPreview(root, slashName!.path)).text, 'backslash name')
  assert.equal((await readFileForPreview(root, 'inside-link')).text, 'inside')

  assert.equal(await resolveWithinRoot(root, '../outside.txt'), null)
  assert.equal(await resolveWithinRoot(root, outside), null)
  assert.equal(await resolveWithinRoot(root, 'escape-link'), null)
  const escaped = await readFileForPreview(root, 'escape-link')
  assert.equal(escaped.ok, false)
  assert.equal(escaped.error?.includes(base), false)

  const binary = await readFileForPreview(root, 'a.bin')
  assert.equal(binary.kind, 'binary')

  const largePath = join(root, 'large.ts')
  await writeFile(largePath, `one\ntwo\nthree\n${'x'.repeat(MAX_PREVIEW_BYTES)}`)
  const guarded = await readFileForPreview(root, 'large.ts')
  assert.equal(guarded.tooLarge, true)
  assert.equal(guarded.text, undefined)

  const forced = await readFileForPreview(root, 'large.ts', { force: true, maxLines: 2 })
  assert.equal(forced.text, 'one\ntwo')
  assert.equal(forced.truncated, true)
  assert.equal(forced.lineLimit, 2)
  assert.equal(await resolveWithinRoot(root, 'b.txt'), await realpath(join(root, 'b.txt')))
})

test('file browser rejects oversized directories without returning a partial listing', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'uniagent-file-browser-cap-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  await mkdir(root)
  await Promise.all(
    Array.from({ length: MAX_DIRECTORY_ENTRIES + 1 }, (_, index) =>
      writeFile(join(root, `entry-${String(index).padStart(5, '0')}`), '')
    )
  )

  const listing = await listDir(root)
  assert.equal(listing.ok, false)
  assert.deepEqual(listing.entries, [])
  assert.match(listing.error || '', /目录条目过多/)
})

test('picked files include bounded image previews without changing regular files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-picked-file-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const image = join(dir, 'small.png')
  const large = join(dir, 'large.png')
  const text = join(dir, 'notes.txt')
  await writeFile(image, Buffer.from([137, 80, 78, 71]))
  await writeFile(large, Buffer.alloc(MAX_PREVIEW_BYTES + 1))
  await writeFile(text, 'hello')

  assert.equal((await pickedFile(image)).previewDataUrl, 'data:image/png;base64,iVBORw==')
  assert.equal((await pickedFile(large)).previewDataUrl, undefined)
  assert.deepEqual(await pickedFile(text), { kind: 'file', path: text, name: 'notes.txt' })
})

test('recorded image previews can read larger screenshots with a bounded forced preview', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-recorded-image-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const image = join(dir, 'screenshot.png')
  const bytes = Buffer.alloc(16 * 1024 * 1024)
  await writeFile(image, bytes)
  assert.equal((await pickedFile(image)).previewDataUrl, undefined, 'file picking keeps its existing preview limit')
  assert.ok((await pickedFile(image, { force: true })).previewDataUrl === `data:image/png;base64,${bytes.toString('base64')}`, 'forced preview must contain the complete image')
  const oversized = join(dir, 'oversized.png')
  await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1))
  assert.equal((await pickedFile(oversized, { force: true })).previewDataUrl, undefined, 'forced image reads remain bounded')
})

test('HTML browser targets stay inside the root and reject other file types', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'uniagent-html-browser-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  await mkdir(root)
  await writeFile(join(root, 'report.HTML'), '<h1>report</h1>')
  await writeFile(join(root, 'notes.txt'), 'notes')

  const htmlPreview = await readFileForPreview(root, 'report.HTML')
  assert.equal(htmlPreview.htmlBaseUrl, pathToFileURL(`${await realpath(root)}${sep}`).href)
  assert.equal(htmlPreview.htmlUrl, pathToFileURL(await realpath(join(root, 'report.HTML'))).href)
  assert.equal((await readFileForPreview(root, 'notes.txt')).htmlBaseUrl, undefined)
  assert.equal((await readFileForPreview(root, 'notes.txt')).htmlUrl, undefined)

  const namedHtml = join(root, '设计 #1%.html')
  await writeFile(namedHtml, '<h1>original document</h1>')
  await symlink(namedHtml, join(root, 'alias.html'))
  const aliasPreview = await readFileForPreview(root, 'alias.html')
  assert.equal(aliasPreview.htmlUrl, pathToFileURL(await realpath(namedHtml)).href)
  assert.equal(aliasPreview.text, '<h1>original document</h1>')
  assert.equal((await readFileForPreview(root, '../notes.txt')).htmlUrl, undefined)
  assert.equal(await resolveHtmlWithinRoot(root, 'report.HTML'), await realpath(join(root, 'report.HTML')))
  assert.equal(await resolveHtmlWithinRoot(root, 'notes.txt'), null)
  assert.equal(await resolveHtmlWithinRoot(root, '../notes.txt'), null)
})
