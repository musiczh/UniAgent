// Browser-side helpers for acceptance tests. Use DOM keyboard/clipboard events,
// not editor internals, so the same path is exercised as user input.
export function installMarkdownInputDriver() {
  const input = target => {
    const node = typeof target === 'string' ? document.querySelector(target) : target
    const field = node?.matches('textarea,.markdown-editor-content') ? node : node?.querySelector('.markdown-editor-content,textarea')
    if (!field) throw new Error('Markdown input is not mounted: ' + target)
    return field
  }
  const key = (field, name, modifiers = {}) => field.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers }))
  const fill = (target, value) => {
    const field = input(target)
    field.focus()
    if (field instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.setSelectionRange(value.length, value.length)
    } else {
      key(field, 'a', /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true })
      key(field, 'Backspace')
      if (value) {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text/plain', value)
        field.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
      }
    }
    return true
  }
  const text = target => {
    const field = input(target)
    return field instanceof HTMLTextAreaElement ? field.value : field.innerText.replace(/\n+$/, '')
  }
  window.__markdownInput = { input, fill, text }
}
