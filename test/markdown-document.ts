import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { markdownEditorExtensions } from '../src/renderer/markdownEditor'
import { parseEditorMarkdown, safeEditorLink, serializeEditorMarkdown } from '../src/renderer/markdownDocument'

const schema = getSchema(markdownEditorExtensions())
const parse = (markdown: string) => {
  const doc = schema.nodeFromJSON(parseEditorMarkdown(markdown))
  doc.check()
  return doc
}
const roundtrip = (markdown: string) => {
  const before = parse(markdown)
  const serialized = serializeEditorMarkdown(before)
  assert.deepEqual(parse(serialized).toJSON(), before.toJSON(), `Markdown must preserve structure: ${markdown}\nExport: ${serialized}`)
  assert.equal(serializeEditorMarkdown(parse(serialized)), serialized, 'export must stabilize after one pass')
  return before
}

for (const source of [
  '# 标题\n\n正文 **加粗** *斜体* ~~删除线~~ 与 `foo_bar`。',
  '3. 第一项\n4. 第二项\n   1. 子项\n      - 无序子项\n5. 最后一项',
  '- [x] 已完成\n  - [ ] 嵌套任务\n- [ ] 待完成',
  '> 引用\n>\n> > 嵌套引用\n\n---',
  '开始\n\n>\n> >\n\n结束',
  '- 普通项目\n- [x] 已完成\n- 普通项目二',
  '```kotlin\nfun test() {\n  val s = "**原文**"\n}\n```',
  '````md\n```js\nconst x = 1\n```\n````',
  '[文字](https://example.com/a?q=x) 与 https://example.com',
  '[文档](./README.md) 与 [原始地址](javascript:alert(1))',
  '未闭合 **标记\n\n\\# 普通文本\n\nfoo_bar_baz',
  '实体 &amp; &lt;b&gt; &#x1F600; 与 &#38;amp;',
  '![图片](https://example.com/image.png)',
  '<script>alert(1)</script>\n\n<b>保留源码</b>',
  '| 名称 | 内容 |\n| :--- | ---: |\n| 测试 | **粗体** |',
  '| 列 |\n| --- |\n| a\\|b |',
  '| 列 |\n| --- |\n| `a\\|b`<br>第二行 |',
  '列表项内换行：\n\n- 第一行  \n  第二行',
  '``  `a  ``'
]) roundtrip(source)

for (const text of [' `a', 'a` ', ' `a` ', ' leading ', '  ', '```']) {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text, [schema.marks.code.create()])])])
  const serialized = serializeEditorMarkdown(doc)
  assert.deepEqual(parse(serialized).toJSON(), doc.toJSON(), `inline code must preserve whitespace and backticks: ${JSON.stringify(text)} -> ${serialized}`)
}

for (const text of ['a|b', 'a\\|b', 'a\\\\|b']) {
  for (const marks of [[], [schema.marks.code.create()]]) {
    const cell = schema.node('tableHeader', null, [schema.node('paragraph', null, schema.text(text, marks))])
    const doc = schema.node('doc', null, [schema.node('table', null, [schema.node('tableRow', null, [cell])])])
    const serialized = serializeEditorMarkdown(doc)
    assert.deepEqual(parse(serialized).toJSON(), doc.toJSON(), `table pipes must preserve backslashes: ${serialized}`)
  }
}

assert.equal(serializeEditorMarkdown(parse('')), '')
assert.equal(serializeEditorMarkdown(parse('1. ')), '')
assert.equal(serializeEditorMarkdown(parse('# ')), '')
assert.equal(serializeEditorMarkdown(parse('>\n> >')), '')
assert.equal(serializeEditorMarkdown(parse('```\n```')), '')
assert.equal(serializeEditorMarkdown(parse('---')), '---')
assert.equal(safeEditorLink('https://example.com'), true)
assert.equal(safeEditorLink('javascript:alert(1)'), false)
assert.equal(safeEditorLink('https://example.com\n'), false)
assert.equal(parse('[bad](javascript:alert(1))').firstChild?.firstChild?.marks.length, 0)
assert.equal(parse('[bad](javascript:alert(1))').textContent, '[bad](javascript:alert(1))', 'unsupported URLs remain literal without losing the address')

console.log('markdown-document: parsing, nested structures, safe literals, code and roundtrip checks passed')
