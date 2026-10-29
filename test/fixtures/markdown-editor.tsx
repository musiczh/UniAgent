import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMarkdownEditor, editorSlashMatch } from '../../src/renderer/markdownEditor'
import { parseEditorMarkdown, serializeEditorMarkdown } from '../../src/renderer/markdownDocument'
import { MarkdownEditor } from '../../src/renderer/components/MarkdownEditor'
import { Composer } from '../../src/renderer/components/Composer'
import { useSlashField } from '../../src/renderer/hooks'
import type { MarkdownInputHandle } from '../../src/renderer/markdownInput'
import { installMarkdownInputDriver } from './markdown-input-driver.mjs'
import '../../src/renderer/styles.css'

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function equal(actual: unknown, expected: unknown, message: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
}
const tick = () => new Promise(resolve => setTimeout(resolve, 35))
async function waitFor(probe: () => unknown) {
  const deadline = Date.now() + 5000
  while (!probe()) { check(Date.now() < deadline, 'renderer fixture timed out'); await tick() }
}

export async function run() {
  installMarkdownInputDriver()
  const results: string[] = []
  const host = document.createElement('div')
  host.className = 'markdown-editor composer-input'
  host.style.width = '500px'
  document.body.append(host)
  let value = '', sends = 0, pastedImages = 0
  const control = createMarkdownEditor({
    element: host, value: '', placeholder: '输入消息',
    onChange: next => { value = next }, onSelectionChange: () => {},
    onKeyDown: event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sends++ } },
    onPaste: event => { if (event.clipboardData?.files.length) { event.preventDefault(); pastedImages++ } }
  })
  const { editor } = control
  const reset = async (source = '') => { control.setValue(source); editor.commands.focus('end'); value = source; await tick() }
  const type = (text: string) => {
    for (const char of text) {
      const { from, to } = editor.state.selection
      const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)))
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
    }
  }
  const key = (name: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true, ...options })
    editor.view.dom.dispatchEvent(event)
    return event
  }
  const paste = (text: string, html?: string) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    if (html) data.setData('text/html', html)
    editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }
  const doc = () => editor.state.doc.toJSON()
  const exported = () => serializeEditorMarkdown(editor.state.doc)
  try {
    await reset()
    type('1. ')
    check(editor.isActive('orderedList'), 'number + space must create an ordered list')
    equal(editor.view.dom.dataset.empty, 'false', 'placeholder must not overlap an active empty list')
    type('第一项'); key('Enter'); type('第二项')
    equal(editor.state.doc.firstChild?.childCount, 2, 'Enter continues list')
    key('Tab')
    check(editor.state.selection.$from.depth === 5, 'Tab nests the second item under the first')
    key('Enter'); type('子项二')
    key('Tab', { shiftKey: true })
    equal(editor.state.doc.firstChild?.childCount, 2, 'Shift-Tab lifts the nested item')
    check(exported().includes('2. 子项二'), 'top-level numbering remains sequential')
    key('Enter'); key('Enter')
    check(!editor.isActive('listItem'), 'Enter on an empty top-level item exits the list')
    results.push('ordered list input, continuation, nesting, outdent and exit')

    await reset('9. first\n10. last')
    key('Enter'); type('next')
    check(exported().includes('11. next'), 'ordered list start and continuation must survive import')
    await reset('1. hello world')
    editor.commands.setTextSelection(8)
    key('Enter')
    equal(editor.state.doc.firstChild?.childCount, 2, 'Enter in the middle splits the item')
    await reset()
    type('2) '); check(editor.isActive('orderedList'), 'parenthesis marker is supported')
    type('text'); key('Enter', { shiftKey: true }); type('same item')
    equal(editor.state.doc.firstChild?.childCount, 1, 'Shift-Enter keeps the same list item')
    check(exported().includes('  \n'), 'soft line breaks are exported explicitly')
    results.push('non-default numbering, middle split and soft break')

    await reset()
    type('- [ ] '); type('任务')
    check(editor.isActive('taskItem'), 'typing a task marker must create a task item')
    check(!editor.isActive('bulletList'), 'task conversion must not leave an extra bullet wrapper')
    const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    check(checkbox, 'task checkbox must be visible'); checkbox.click()
    check(exported().includes('- [x] 任务'), 'checkbox click updates Markdown')
    editor.commands.setTextSelection(5); editor.commands.focus(); key('Enter'); type('下一项')
    check(exported().includes('- [ ] 下一项'), 'continued task is unchecked')
    results.push('task marker, checkbox and unchecked continuation')

    await reset()
    type('# '); type('标题'); key('Enter'); type('正文 **粗体** 和 *斜体* ~~删除~~ `code`')
    check(host.querySelector('h1')?.textContent === '标题', 'heading input rule')
    for (const tag of ['strong', 'em', 's', 'code']) check(host.querySelector(tag), `inline formatting must render ${tag}: ${JSON.stringify(doc())}`)
    await reset(); type('**粗体**')
    key('z', { metaKey: true })
    equal(editor.state.doc.textContent, '**粗体**', 'undo must restore the input-rule markers')
    check(!host.querySelector('strong'), 'undo must remove the bold mark')
    results.push('headings, inline formatting and undo conversion')

    await reset(); type('```kotlin'); key('Enter')
    check(editor.isActive('codeBlock'), 'fence + Enter creates code block')
    type('1. **原文**'); key('Enter'); key('Tab'); type('code')
    check(!host.querySelector('ol,strong'), 'code content must not trigger Markdown rules')
    check(editor.state.doc.firstChild?.textContent.includes('\n  code'), 'code Tab inserts spaces')
    key('Tab', { shiftKey: true }); key('Enter'); type('```'); key('Enter')
    check(!editor.isActive('codeBlock'), 'closing fence exits code')
    key('Enter', { metaKey: true }); key('Enter', { ctrlKey: true })
    equal(sends, 2, 'both send shortcuts are reserved for the parent')
    results.push('code fences, literal text, indentation, exit and send shortcuts')

    await reset(); type('> '); type('引用'); key('Enter'); key('Enter')
    check(!editor.isActive('blockquote'), 'Enter on an empty quote exits the block')
    await reset(); type('---'); key('Enter')
    check(host.querySelector('hr'), 'horizontal rule renders after Enter')
    await reset(); type('[文档](https://example.com) ')
    check(host.querySelector('a')?.getAttribute('href') === 'https://example.com', 'Markdown link converts while typing')
    await reset(); type('1234567890. ')
    check(!editor.isActive('orderedList'), 'ten-digit number stays plain text')
    await reset(); type('- [x] 完成')
    check(exported().startsWith('- [x] 完成'), 'checked task marker is supported')
    await reset(); type('1. '); key('Tab')
    equal(editor.state.selection.$from.depth, 3, 'first list item cannot indent without a preceding sibling')
    control.clear()
    check(!host.querySelector('ol'), 'clear removes empty list structure even when Markdown was already empty')
    await reset('1. first\n2. second\n\n   ```\n   code\n   ```')
    let codePos = 0
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'codeBlock') codePos = pos + 1 })
    check(codePos, 'nested code fixture must contain a code block')
    editor.commands.setTextSelection(codePos); key('Tab')
    equal(editor.state.doc.firstChild?.childCount, 2, 'code Tab must not nest its parent list item')
    check(editor.state.selection.$from.parent.textContent.startsWith('  code'), 'nested code Tab inserts spaces')
    results.push('quote exit, divider, typed link, marker limits, empty reset and code inside a list')

    await reset(); type('| 名称 | 内容 |'); key('Enter'); type('| --- | --- |'); key('Enter')
    check(host.querySelector('table'), 'completed table header becomes an editable table')
    type('第一格'); key('Tab'); type('第二格'); key('Tab'); type('下一行')
    equal(host.querySelectorAll('tr').length, 3, 'Tab in the last cell adds a row')
    key('Tab', { shiftKey: true })
    check(editor.isActive('table'), 'Shift-Tab stays within the previous cell')
    const tableText = exported()
    equal(editor.schema.nodeFromJSON(parseEditorMarkdown(tableText)).firstChild?.childCount, 3, 'table structure survives export')
    results.push('typed table, cell navigation and row creation')

    await reset(); type('/skill')
    const match = editorSlashMatch(editor)
    check(match, 'slash candidate range is available')
    control.replaceSlash(match, '/goal ')
    equal(editor.state.doc.textContent, '/goal ', 'command replacement uses document positions')
    await reset('**前文** /skill')
    const richMatch = editorSlashMatch(editor)
    check(richMatch, 'slash match works after formatted text')
    control.replaceSlash(richMatch, '')
    check(host.querySelector('strong')?.textContent === '前文', 'candidate removal preserves preceding formatting')
    await reset('```\n/skill\n```')
    editor.commands.setTextSelection(7)
    equal(editorSlashMatch(editor), null, 'slash menu is suppressed in code')
    results.push('slash replacement and code exclusion')

    await reset()
    paste('## 粘贴标题\n\n- 项目\n- [x] 完成')
    check(host.querySelector('h2,ul[data-type=taskList]'), 'Markdown paste is parsed')
    await reset(); paste('安全文本', '<p><strong>安全文本</strong><img src="https://invalid.test/pixel"><script>window.pwned=1</script></p>')
    check(host.querySelector('strong')?.textContent === '安全文本', 'rich text paste keeps supported formatting')
    check(!host.querySelector('img,script'), 'rich paste cannot introduce script or image fetches')
    await reset(); key('v', { metaKey: true, shiftKey: true }); paste('**保留标记**', '<strong>保留标记</strong>')
    equal(editor.state.doc.textContent, '**保留标记**', 'plain paste keeps literal markers')
    check(!host.querySelector('strong'), 'plain paste must not apply formatting')
    await reset('```\ncode\n```'); editor.commands.setTextSelection(5); paste('1. **原文**\n  缩进')
    check(!host.querySelector('strong,ol'), 'paste inside code stays literal')
    const imageData = new DataTransfer()
    imageData.items.add(new File(['fixture'], 'test.png', { type: 'image/png' }))
    editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: imageData, bubbles: true, cancelable: true }))
    equal(pastedImages, 1, 'image paste stays on the existing attachment path')
    results.push('Markdown, rich text, plain text, code and image paste')

    await reset()
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    type('中文')
    key('Enter', { isComposing: true, metaKey: true })
    equal(sends, 2, 'IME Enter must not send')
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
    await tick()
    equal(editor.state.doc.textContent, '中文', 'composition preserves committed Chinese text')
    await reset('旧草稿'); type('追加'); control.setValue('新草稿'); key('z', { metaKey: true })
    equal(editor.state.doc.textContent, '新草稿', 'external draft replacement resets undo history')
    control.setValue(''); equal(exported(), '', 'send/reset clears content')
    check(editor.view.dom.dataset.empty === 'true', 'empty editor shows placeholder')
    control.setOptions(true, '不可输入')
    equal(editor.view.dom.getAttribute('contenteditable'), 'false', 'disabled editor rejects editing')
    control.setOptions(false, '输入消息')
    await reset('实体 &amp; &lt;b&gt; 与 \\*星号\\*')
    equal(editor.state.doc.textContent, '实体 & <b> 与 *星号*', 'entities and escaped markers display literally')
    const before = doc(); control.setValue(exported() + '\n\n');
    equal(doc().content, before.content, 'entities remain stable on import/export')
    results.push('IME, draft replacement, reset, disabled state and escaped entities')

    window.__markdownInput.fill(host, '## 验收脚本\n\n- 第一项')
    check(host.querySelector('h2')?.textContent === '验收脚本', 'acceptance driver pastes through the real editor')
    window.__markdownInput.fill(host, '替换列表')
    equal(exported(), '替换列表', 'acceptance driver replaces all prior structure')
    equal(window.__markdownInput.text(host), '替换列表', 'acceptance driver reads visible content')
    results.push('acceptance driver contenteditable replacement and reading')

    const start = performance.now()
    await reset(Array.from({ length: 300 }, (_, i) => `段落 ${i}：**说明** 和代码 \`value\`。`).join('\n\n'))
    type('末尾输入')
    const duration = performance.now() - start
    check(duration < 2000, `long draft edit exceeded 2s: ${duration}`)
    check(host.querySelector('.markdown-editor-content')!.scrollHeight > host.querySelector('.markdown-editor-content')!.clientHeight, 'long draft scrolls inside the input')
    check(host.getBoundingClientRect().height <= innerHeight / 3 + 2, 'input height is capped at one third of the window')
    results.push(`long draft import/edit and bounded height (${Math.round(duration)} ms)`)
  } finally { control.destroy(); host.remove() }

  // Exercise the React value loop and the same slash hook used by both inputs.
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let changeDraft: (text: string) => void = () => {}
  let focusDraft: () => void = () => {}
  let hookPick: () => void = () => {}
  const candidate = { id: 'skill:test', kind: 'skill' as const, name: 'test', path: '/fixture/SKILL.md', description: '', enabled: true }
  function Fixture() {
    const [draft, setDraft] = useState('**原文** /te')
    const ref = useRef<MarkdownInputHandle>(null)
    const slash = useSlashField(ref, [candidate])
    changeDraft = setDraft; focusDraft = () => ref.current?.focus('end'); hookPick = () => slash.pick(candidate)
    return <><MarkdownEditor ref={ref} value={draft} onChange={setDraft} placeholder="测试" className="composer-input" onSelectionChange={slash.onSelectionChange} onKeyDown={event => { slash.onKeyDownSlash(event) }} /><output>{draft}</output><span data-selected>{slash.selectedIds.join(',')}</span><span data-slash>{String(slash.slashOpen)}</span></>
  }
  try {
    root.render(<Fixture />)
    await waitFor(() => container.querySelector('[contenteditable=true]'))
    focusDraft(); await tick()
    check(container.querySelector('[data-slash]')?.textContent === 'true', 'React receives rich cursor updates')
    hookPick(); await tick()
    check(container.querySelector('[data-selected]')?.textContent === candidate.id, 'slash hook retains trusted candidate ID')
    equal(container.querySelector('output')?.textContent, '**原文** ', 'React exports Markdown after removing only the slash token')
    changeDraft('## 回填\n\n1. 内容'); await tick()
    check(container.querySelector('h2')?.textContent === '回填', 'external Markdown draft renders through React')
    check(container.querySelector('ol'), 'restored list stays structured')
    results.push('React value synchronization, slash candidates and external draft hydration')
  } finally { root.unmount(); container.remove() }

  await composerIntegration(results)
  return results
}

let imeFixture: { root: ReturnType<typeof createRoot>; container: HTMLDivElement; starts: number; ends: number } | undefined

export async function prepareImeEditor(source = '') {
  destroyImeEditor()
  const container = document.createElement('div')
  document.body.append(container)
  const fixture = { root: createRoot(container), container, starts: 0, ends: 0 }
  imeFixture = fixture
  container.addEventListener('compositionstart', () => fixture.starts++)
  container.addEventListener('compositionend', () => fixture.ends++)
  const ref = React.createRef<MarkdownInputHandle>()
  function Fixture() {
    const [draft, setDraft] = useState(source)
    return <><MarkdownEditor ref={ref} value={draft} onChange={setDraft} placeholder="IME 测试" className="composer-input" onSelectionChange={() => {}} onKeyDown={() => {}} /><output>{draft}</output></>
  }
  fixture.root.render(<Fixture />)
  await waitFor(() => container.querySelector('.markdown-editor-content[contenteditable=true]'))
  ref.current!.focus('end')
  await tick()
}

export async function readImeEditor() {
  await tick()
  const fixture = imeFixture!
  return {
    text: fixture.container.querySelector('.markdown-editor-content')!.textContent,
    markdown: fixture.container.querySelector('output')!.textContent,
    starts: fixture.starts,
    ends: fixture.ends
  }
}

export function destroyImeEditor() {
  imeFixture?.root.unmount()
  imeFixture?.container.remove()
  imeFixture = undefined
}

async function composerIntegration(results: string[]) {
  const noop = () => {}
  Object.assign(window, { uniagent: { listPresets: async () => [], getPrefs: async () => null, onPrefsChanged: () => noop } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const sent: string[] = []
  let failSend = false
  const queue = [{ id: 'q1', prompt: '## 等待任务\n\n- [x] 已检查', createdAt: Date.now(), state: 'pending' as const }]
  const saved: string[] = []
  const agent: any = { id: 'codex', name: 'Codex', adapter: 'codex', bin: 'codex', installed: true, icon: 'codex', builtin: true, models: [], capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [] } }
  const render = (sessionId: string, prefill?: { text: string; nonce: number }) => root.render(<Composer key={sessionId}
    sessionId={sessionId} status="idle" agent={agent} config={{ agentId: 'codex', workdir: '/fixture' }}
    onSend={async text => { if (failSend) throw new Error('fixture send failed'); sent.push(text) }} onForceSend={noop} onInterrupt={noop} onUpdateConfig={noop} onSetCollaborationMode={noop} onRunNativeAction={noop}
    queue={queue} onDequeue={noop} onPromoteQueue={noop} onEditQueueItem={async (_id, prompt) => { saved.push(prompt) }}
    capabilities={{ agentId: 'codex', workdir: '/fixture', source: 'provider-native', candidates: [], actions: { goal: false, review: false, plan: false }, errors: [] }}
    capabilitiesReady contextUsed={0} onCompact={async () => {}} canCompact={false} compacting={false} prefill={prefill}
  />)
  try {
    render('a'); await waitFor(() => container.querySelector('[contenteditable=true]'))
    render('a', { text: '**发送格式**\n\n1. 项目', nonce: 1 }); await tick()
    await waitFor(() => container.querySelector('strong')?.textContent === '发送格式')
    failSend = true
    container.querySelector<HTMLButtonElement>('.composer-send-btn')!.click(); await tick()
    check(container.querySelector('[role=alert]')?.textContent?.includes('fixture send failed'), 'send errors remain visible')
    check(container.querySelector('strong'), 'send failure must retain the formatted draft')
    failSend = false
    container.querySelector<HTMLButtonElement>('.composer-send-btn')!.click(); await tick()
    equal(sent, ['**发送格式**\n\n1. 项目'], 'actual Composer sends Markdown to the existing handler')
    equal(container.querySelector('[contenteditable=true]')?.textContent, '', 'successful send clears the editor')
    render('a', { text: '- [x] 保存草稿', nonce: 2 }); await tick()
    render('b'); await tick()
    render('a'); await tick()
    await waitFor(() => container.querySelector('li[data-checked=true]'))
    check(container.querySelector('li[data-checked=true]')?.textContent?.includes('保存草稿'), 'session draft restores task state')
    container.querySelector<HTMLButtonElement>('.queue-edit')!.click(); await tick()
    const field = container.querySelector<HTMLElement>('.markdown-editor-content')!
    check(field.querySelector('h2')?.textContent === '等待任务', 'queue edit restores Markdown structure')
    window.__markdownInput.fill(field, '## 修改后\n\n- [x] 已检查')
    await tick()
    container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.click(); await tick()
    equal(saved, ['## 修改后\n\n- [x] 已检查'], 'queue save keeps heading and checkbox state in Markdown')
    equal(field.textContent, '', 'queue save clears the structured draft')
    results.push('actual Composer sending, failure recovery, clear and session draft restoration')
    results.push('actual Composer queue edit, Markdown save and clear')
  } finally { root.unmount(); container.remove() }
}
