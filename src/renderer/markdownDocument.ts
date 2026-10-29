import { marked, type Token, type Tokens } from 'marked'
import type { JSONContent } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown'
import { decodeHTMLStrict as decodeEntities } from 'entities'

const options = { gfm: true, breaks: true }

function textNode(text: string, marks: JSONContent['marks'] = []): JSONContent[] {
  return text ? [{ type: 'text', text, ...(marks.length ? { marks } : {}) }] : []
}

function inline(tokens: Token[] = [], marks: JSONContent['marks'] = [], inTable = false): JSONContent[] {
  let skipUntil = 0
  return tokens.flatMap((token, index): JSONContent[] => {
    if (index < skipUntil) return []
    // Table code with a literal backslash before a pipe cannot use a GFM code
    // span losslessly. Decode our attribute-free <code> representation as text.
    if (inTable && token.type === 'html' && token.raw === '<code>') {
      const end = tokens.findIndex((part, i) => i > index && part.type === 'html' && part.raw === '</code>')
      if (end !== -1) {
        skipUntil = end + 1
        return textNode(decodeEntities(tokens.slice(index + 1, end).map(part => part.raw).join('')), [{ type: 'code' }])
      }
    }
    switch (token.type) {
      case 'checkbox': return []
      case 'strong': case 'em': case 'del': {
        const type = { strong: 'bold', em: 'italic', del: 'strike' }[token.type]!
        return inline(token.tokens, [...marks, { type }], inTable)
      }
      case 'codespan': return textNode(token.text, [{ type: 'code' }])
      case 'link':
        return safeEditorLink(token.href)
          ? inline(token.tokens, [...marks, { type: 'link', attrs: { href: token.href, title: token.title || null } }], inTable)
          : textNode(token.raw, marks)
      case 'br': return [{ type: 'hardBreak' }]
      case 'escape': return textNode(token.text, marks)
      case 'image': return [{ type: 'markdownImage', attrs: { source: token.raw } }]
      case 'text':
        return token.tokens ? inline(token.tokens, marks, inTable) : textNode(decodeEntities(token.text), marks)
      case 'html':
        // GFM cells use <br> for line breaks; all other HTML remains literal text.
        if (inTable && /^<br\s*\/?\s*>$/i.test(token.raw)) return [{ type: 'hardBreak' }]
        return textNode(token.raw, marks)
      default: return textNode(token.raw, marks)
    }
  })
}

function paragraph(tokens: Token[], inTable = false): JSONContent {
  return { type: 'paragraph', content: inline(tokens, [], inTable) }
}

function blocks(tokens: Token[] = []): JSONContent[] {
  return tokens.flatMap((token): JSONContent[] => {
    switch (token.type) {
      case 'space': case 'checkbox': return []
      case 'heading': return [{ type: 'heading', attrs: { level: token.depth }, content: inline(token.tokens) }]
      case 'paragraph': case 'text':
        return [paragraph(token.tokens || marked.lexer(token.text, options).flatMap(t => 'tokens' in t ? t.tokens || [] : []))]
      case 'code': return [{ type: 'codeBlock', attrs: { language: token.lang || null }, content: textNode(token.text) }]
      case 'blockquote': {
        const content = blocks(token.tokens)
        return [{ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] }]
      }
      case 'hr': return [{ type: 'horizontalRule' }]
      case 'list': {
        const lists: JSONContent[] = []
        token.items.forEach((item: Tokens.ListItem, index: number) => {
          const type = item.task ? 'taskList' : token.ordered ? 'orderedList' : 'bulletList'
          let list = lists.at(-1)
          if (list?.type !== type) {
            list = { type, ...(token.ordered ? { attrs: { start: Number(token.start) + index } } : {}), content: [] }
            lists.push(list)
          }
          const content = blocks(item.tokens)
          if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' })
          list.content!.push({ type: item.task ? 'taskItem' : 'listItem',
            ...(item.task ? { attrs: { checked: !!item.checked } } : {}), content })
        })
        return lists
      }
      case 'table': {
        const row = (cells: Tokens.TableCell[], header: boolean): JSONContent => ({
          type: 'tableRow', content: cells.map((cell, i) => ({
            type: header ? 'tableHeader' : 'tableCell', attrs: { align: token.align[i] || null },
            content: [paragraph(cell.tokens, true)]
          }))
        })
        return [{ type: 'table', content: [row(token.header, true), ...token.rows.map((cells: Tokens.TableCell[]) => row(cells, false))] }]
      }
      default: return [{ type: 'paragraph', content: textNode(token.raw.replace(/\n+$/, '')) }]
    }
  })
}

export function parseEditorMarkdown(value: string): JSONContent {
  const content = blocks(marked.lexer(value, options))
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

export function safeEditorLink(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href)
}

const base = defaultMarkdownSerializer
function codeDelimiter(node: Node, opening: boolean): string {
  const text = node.textContent
  const fence = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
  const padding = text.includes('`') || (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) ? ' ' : ''
  return opening ? fence + padding : padding + fence
}
const serializer = new MarkdownSerializer({
  ...base.nodes,
  codeBlock(state, node) {
    const fence = '`'.repeat(Math.max(3, ...Array.from(node.textContent.matchAll(/`+/g), match => match[0].length + 1)))
    state.write(fence + String(node.attrs.language || '').replace(/[\r\n`]/g, '') + '\n')
    state.text(node.textContent, false)
    state.write('\n' + fence)
    state.closeBlock(node)
  },
  horizontalRule: base.nodes.horizontal_rule,
  markdownImage(state, node) { state.write(node.attrs.source) },
  hardBreak(state) { state.write('  \n') },
  bulletList(state, node) { state.renderList(node, '  ', () => '- ') },
  orderedList(state, node) {
    const start = node.attrs.start ?? 1
    state.renderList(node, ' '.repeat(String(start + node.childCount - 1).length + 2), i => `${start + i}. `)
  },
  listItem: base.nodes.list_item,
  taskList(state, node) { state.renderList(node, '  ', i => `- [${node.child(i).attrs.checked ? 'x' : ' '}] `) },
  taskItem: base.nodes.list_item,
  table(state, node) {
    node.forEach((row, _offset, index) => {
      const cells: string[] = []
      row.forEach(cell => cells.push(tableCellSerializer.serialize(cell, { tightLists: true }).replace(/\|/g, '\\|').replace(/  \n|\n+/g, '<br>')))
      state.write('| ' + cells.join(' | ') + ' |\n')
      if (index === 0) {
        const separators: string[] = []
        row.forEach(cell => separators.push(cell.attrs.align === 'center' ? ':---:' : cell.attrs.align === 'right' ? '---:' : cell.attrs.align === 'left' ? ':---' : '---'))
        state.write('| ' + separators.join(' | ') + ' |\n')
      }
    })
    state.closeBlock(node)
  }
}, {
  bold: base.marks.strong,
  italic: base.marks.em,
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  code: {
    open: (_state, _mark, parent, index) => codeDelimiter(parent.child(index), true),
    close: (_state, _mark, parent, index) => codeDelimiter(parent.child(index - 1), false),
    escape: false
  },
  link: base.marks.link
}, { hardBreakNodeName: 'hardBreak', escapeExtraCharacters: /[~&]/g })

function needsHtmlCode(node: Node): boolean {
  return node.textContent.includes('\\|')
}

const tableCellSerializer = new MarkdownSerializer({
  ...serializer.nodes,
  text(state, node, parent, index) {
    if (node.marks.some(mark => mark.type.name === 'code')) {
      const text = needsHtmlCode(node) ? node.textContent.replace(/[&<>\\|]/g, char => `&#${char.charCodeAt(0)};`) : node.textContent
      state.text(text, false)
    } else base.nodes.text(state, node, parent, index)
  }
}, {
  ...serializer.marks,
  code: {
    open: (_state, _mark, parent, index) => needsHtmlCode(parent.child(index)) ? '<code>' : codeDelimiter(parent.child(index), true),
    close: (_state, _mark, parent, index) => needsHtmlCode(parent.child(index - 1)) ? '</code>' : codeDelimiter(parent.child(index - 1), false)
  }
}, { hardBreakNodeName: 'hardBreak', escapeExtraCharacters: /[~&]/g })

export function serializeEditorMarkdown(doc: Node): string {
  // Bare list markers, empty headings and empty code blocks are not a message.
  if (!doc.textContent.trim() && !hasStructuralContent(doc)) return ''
  return serializer.serialize(doc, { tightLists: true })
}

function hasStructuralContent(doc: Node): boolean {
  let found = false
  doc.descendants(node => {
    if (node.type.name === 'horizontalRule' || node.type.name === 'markdownImage' ||
      (node.type.spec.code && node.content.size > 0) || node.marks.some(mark => mark.type.spec.code)) found = true
  })
  return found
}
