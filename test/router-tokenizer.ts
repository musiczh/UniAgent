import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadRouterTokenizer } from '../src/main/router/tokenizer'

const tokenizer = await loadRouterTokenizer()
const fixture = JSON.parse(await readFile('test/fixtures/router-tokenizer.json', 'utf8'))
for (const row of fixture.samples) {
  assert.equal(tokenizer.count(row.text), row.tokens, 'official Rust tokenizer parity: ' + row.label)
  const clipped = tokenizer.clip(row.text, 200)
  assert.ok(tokenizer.count(clipped) <= 200)
  assert.equal(Buffer.from(clipped).toString('utf8'), clipped, 'clipping preserves complete Unicode code points')
}
for (const count of [199, 200, 201]) {
  const text = ' a'.repeat(count)
  assert.equal(tokenizer.count(text), count)
  assert.equal(tokenizer.count(tokenizer.clip(text, 200)), Math.min(count, 200))
}
assert.equal(await loadRouterTokenizer(), tokenizer, 'model assets load once')
await assert.rejects(loadRouterTokenizer('/nonexistent/uniagent-tokenizer'), /ENOENT/)
const items = Array.from({ length: 60 }, (_, id) => ({ id, description: ' a'.repeat(200) }))
let offset = 0, pages = 0
do {
  const page = tokenizer.page(items, offset)
  assert.ok(tokenizer.count(JSON.stringify(page.items)) <= 3500)
  assert.equal(page.items[0].id, offset)
  offset += page.items.length; pages++
  if (page.next === null) break
  assert.equal(page.next, offset)
} while (true)
assert.equal(offset, 60); assert.ok(pages > 1)
console.log('PASS Router tokenizer: official Rust golden data, exact 199/200/201 limits, Unicode boundaries, asset cache and paginated token budget')
