import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const outDir = resolve('out/renderer')
const html = await readFile(resolve(outDir, 'index.html'), 'utf8')
const entry = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]
assert.ok(entry, 'renderer entry script is emitted')
const js = await readFile(resolve(outDir, entry.replace(/^\.\//, '')), 'utf8')
assert.match(js, /Mermaid 图表/, 'Mermaid renderer is bundled into the entry')
assert.doesNotMatch(js, /import\("\.\/[^"]+\.js"\)/, 'renderer has no runtime chunk dependency')

console.log('mermaid bundle is self-contained: ok')
