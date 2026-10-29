import { Editor, Extension, InputRule, Node, wrappingInputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import CodeBlock from '@tiptap/extension-code-block'
import Paragraph from '@tiptap/extension-paragraph'
import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableKit } from '@tiptap/extension-table'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import DOMPurify from 'dompurify'
import { parseEditorMarkdown, safeEditorLink, serializeEditorMarkdown } from './markdownDocument'
import { detectSlash, type MarkdownInputHandle, type MarkdownSlashMatch } from './markdownInput'

const ComposerOrderedList = OrderedList.extend({
  addInputRules() {
    return [wrappingInputRule({
      find: /^(\d{1,9})[.)]\s$/,
      type: this.type,
      getAttributes: match => ({ start: Number(match[1]) }),
      joinPredicate: (match, node) => node.childCount + node.attrs.start === Number(match[1])
    })]
  }
})

// Preserve Markdown image sources without fetching remote resources in a draft.
const MarkdownImage = Node.create({
  name: 'markdownImage', inline: true, group: 'inline', atom: true,
  addAttributes: () => ({ source: { default: '' } }),
  renderHTML: ({ node }) => ['span', { 'data-markdown-image': '', contenteditable: 'false' }, node.attrs.source]
})

const ComposerTaskItem = TaskItem.extend({
  addInputRules() {
    return [new InputRule({
      find: /^\[([ xX])\]\s$/,
      handler: ({ range, match, chain }) => {
        chain().deleteRange(range).toggleTaskList().updateAttributes('taskItem', { checked: match[1].toLowerCase() === 'x' }).run()
      }
    })]
  }
}).configure({ nested: true, a11y: { checkboxLabel: node => `任务：${node.textContent || '未填写'}` } })

const ComposerKeys = Extension.create({
  name: 'composerKeys',
  priority: 1100,
  addKeyboardShortcuts() {
    return {
      // Sending is owned by the composer, never by a code-block/hard-break shortcut.
      'Mod-Enter': () => true,
      'Mod-z': () => this.editor.commands.undoInputRule() || this.editor.commands.undo(),
      Tab: () => {
        const type = currentListItem(this.editor)
        if (!type) return false
        this.editor.commands.sinkListItem(type)
        return true
      },
      'Shift-Tab': () => {
        const type = currentListItem(this.editor)
        return type ? this.editor.commands.liftListItem(type) : false
      },
      Enter: () => {
        const { state } = this.editor
        const { $from, empty } = state.selection
        if (!empty) return false
        if ($from.parent.type.name === 'codeBlock') {
          const before = $from.parent.textContent.slice(0, $from.parentOffset)
          const match = /(?:^|\n)(`{3,}|~{3,})$/.exec(before)
          if (!match || $from.parentOffset !== $from.parent.content.size) return false
          return this.editor.chain().deleteRange({ from: $from.start() + match.index, to: $from.pos }).exitCode().run()
        }
        // A table is only converted after its complete separator row is entered.
        if ($from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false
        const parent = $from.node(-1)
        const index = $from.index(-1)
        const previous = index > 0 ? parent.child(index - 1) : null
        if (previous?.type.name !== 'paragraph' || !/^\s*\|?\s*:?-{3,}/.test($from.parent.textContent)) return false
        const parsed = parseEditorMarkdown(previous.textContent + '\n' + $from.parent.textContent)
        const table = parsed.content?.[0]
        if (parsed.content?.length !== 1 || table?.type !== 'table') return false
        const header = table.content![0]
        table.content!.push({ type: 'tableRow', content: header.content!.map(cell => ({ type: 'tableCell', attrs: cell.attrs, content: [{ type: 'paragraph' }] })) })
        const from = $from.before() - previous.nodeSize
        const node = state.schema.nodeFromJSON(table)
        const tr = state.tr.replaceWith(from, $from.after(), node)
        tr.setSelection(TextSelection.create(tr.doc, from + node.child(0).nodeSize + 4))
        this.editor.view.dispatch(tr.scrollIntoView())
        return true
      }
    }
  }
})

function currentListItem(editor: Editor): 'taskItem' | 'listItem' | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const type = $from.node(depth).type.name
    if (type === 'codeBlock' || type === 'table') return null
    if (type === 'taskItem' || type === 'listItem') return type
  }
  return null
}

export function markdownEditorExtensions() {
  return [
    StarterKit.configure({
      underline: false, orderedList: false, codeBlock: false, paragraph: false,
      link: { openOnClick: false, markdownLinks: true, defaultProtocol: 'https', isAllowedUri: safeEditorLink }
    }),
    // Keep paragraph first in the schema, the default block after headings/lists.
    Paragraph.extend({ priority: 1200 }),
    ComposerOrderedList, TaskList, ComposerTaskItem, MarkdownImage,
    // Code and table Tab handlers must run before their ancestor list's handlers.
    CodeBlock.extend({ priority: 1050 }).configure({ enableTabIndentation: true, tabSize: 2 }),
    TableKit.configure({ table: false }),
    Table.extend({ priority: 1050 }).configure({ resizable: false }),
    ComposerKeys
  ]
}

export interface MarkdownEditorOptions {
  element: HTMLElement
  value: string
  disabled?: boolean
  placeholder: string
  onChange: (value: string) => void
  onSelectionChange: (match: MarkdownSlashMatch | null) => void
  onKeyDown: (event: KeyboardEvent) => void
  onPaste?: (event: ClipboardEvent) => void
}

export interface MarkdownEditorController extends MarkdownInputHandle {
  editor: Editor
  setValue: (value: string) => void
  setOptions: (disabled: boolean, placeholder: string) => void
  destroy: () => void
}

export function editorSlashMatch(editor: Editor): MarkdownSlashMatch | null {
  const { empty, $from } = editor.state.selection
  if (!empty || $from.parent.type.spec.code || $from.marks().some(mark => mark.type.spec.code)) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\uFFFC')
  const match = detectSlash(before, before.length)
  return match ? { ...match, start: $from.start() + match.start, end: $from.pos } : null
}

export function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorController {
  let currentValue = options.value
  let plainPaste = false
  const editor: Editor = new Editor({
    element: options.element,
    extensions: markdownEditorExtensions(),
    content: parseEditorMarkdown(options.value),
    editable: !options.disabled,
    injectCSS: false,
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': options.placeholder, 'data-placeholder': options.placeholder, class: 'markdown-editor-content', spellcheck: 'false' },
      handleDOMEvents: {
        keydown(view, event) {
          if (event.isComposing || view.composing || event.keyCode === 229) return true
          plainPaste = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v'
          options.onKeyDown(event)
          return event.defaultPrevented
        },
        keyup() { plainPaste = false; return false },
        paste(_view, event) {
          if (!editor.isEditable) return true
          options.onPaste?.(event)
          return event.defaultPrevented
        },
        click(_view, event) {
          const link = (event.target as HTMLElement).closest('a')
          if (!link) return false
          event.preventDefault()
          if ((event.metaKey || event.ctrlKey) && safeEditorLink(link.href)) void window.uniagent.openExternal(link.href)
          return true
        }
      },
      handlePaste(view, event) {
        const clipboard = event.clipboardData
        if (!clipboard) return false
        const text = clipboard.getData('text/plain')
        if (editor.isActive('codeBlock') || editor.isActive('code')) {
          view.dispatch(view.state.tr.insertText(text).scrollIntoView())
        } else if (plainPaste) {
          editor.commands.insertContent(text.split(/\r?\n/).map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })))
        } else {
          const html = clipboard.getData('text/html')
          if (html) {
            const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'], ALLOWED_ATTR: ['href', 'title', 'start', 'align'] })
            editor.commands.insertContent(clean)
          } else {
            editor.commands.insertContent(parseEditorMarkdown(text).content || [])
          }
        }
        plainPaste = false
        return true
      },
      clipboardTextSerializer: (slice): string => serializeEditorMarkdown(editor.schema.topNodeType.create(null, slice.content))
    },
    onUpdate() {
      currentValue = serializeEditorMarkdown(editor.state.doc)
      options.onChange(currentValue)
      publishSelection()
    },
    onSelectionUpdate: () => publishSelection()
  })

  function publishSelection(): void {
    const doc = editor.state.doc
    editor.view.dom.dataset.empty = String(doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph' && doc.firstChild.content.size === 0)
    options.onSelectionChange(editorSlashMatch(editor))
  }
  publishSelection()

  function setValue(value: string, force = false): void {
    if (!force && value === currentValue) return
    currentValue = value
    // A new draft must not be able to undo back into a sent or different message.
    const doc = editor.schema.nodeFromJSON(parseEditorMarkdown(value))
    editor.view.updateState(EditorState.create({ doc, schema: editor.schema, plugins: editor.state.plugins }))
    publishSelection()
  }

  return {
    editor,
    focus: position => { editor.commands.focus(position) },
    clear: () => setValue('', true),
    replaceSlash(match, replacement) {
      const current = editorSlashMatch(editor)
      if (!current || current.start !== match.start || current.end !== match.end || current.query !== match.query) return
      const tr = editor.state.tr.insertText(replacement, match.start, match.end)
      editor.view.dispatch(tr.scrollIntoView())
      editor.commands.focus()
    },
    setValue,
    setOptions(disabled, placeholder) {
      if (editor.isEditable === disabled) editor.setEditable(!disabled, false)
      editor.view.dom.setAttribute('data-placeholder', placeholder)
      editor.view.dom.setAttribute('aria-label', placeholder)
      editor.view.dom.setAttribute('aria-disabled', String(disabled))
    },
    destroy: () => editor.destroy()
  }
}
