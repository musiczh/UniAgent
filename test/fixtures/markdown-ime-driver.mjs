import assert from 'node:assert/strict'

// Exercise Chromium's composition buffer, not synthetic DOM CompositionEvents.
export async function runImeRegression(window) {
  const { webContents } = window
  const evaluate = expression => webContents.executeJavaScript('MarkdownEditorTests.' + expression)
  const snapshot = () => evaluate('readImeEditor()')
  const results = []
  webContents.debugger.attach('1.3')
  const compose = text => webContents.debugger.sendCommand('Input.imeSetComposition', {
    text, selectionStart: text.length, selectionEnd: text.length
  })
  const commit = text => webContents.debugger.sendCommand('Input.insertText', { text })
  try {
    for (const sample of [
      { source: '', initial: "wo'xian'z", deletions: ["wo'xian"], continued: "wo'xianz", committed: '我先', prefix: '' },
      { source: '前文：', initial: 'woxianz', deletions: ['woxian', 'woxia'], continued: 'woxiang', committed: '我想', prefix: '前文：' },
      { source: '1. 已有内容', initial: 'woxianz', deletions: ['woxian'], continued: 'woxiang', committed: '我想', prefix: '已有内容' }
    ]) {
      await evaluate(`prepareImeEditor(${JSON.stringify(sample.source)})`)
      await compose(sample.initial)
      assert.equal((await snapshot()).starts, 1, 'typing starts one composition')
      for (const text of sample.deletions) {
        await compose(text)
        const state = await snapshot()
        assert.equal(state.text, sample.prefix + text, 'backspace only shortens the composing pinyin')
        assert.equal(state.ends, 0, 'backspace must not end composition')
      }
      await compose(sample.continued)
      const continued = await snapshot()
      assert.equal(continued.text, sample.prefix + sample.continued, 'continued pinyin must replace the same composition, without duplicating the old pinyin')
      assert.equal(continued.starts, 1, 'backspace must preserve Chromium composition instead of silently restarting it')
      await commit(sample.committed)
      const committed = await snapshot()
      assert.equal(committed.text, sample.prefix + sample.committed, 'committing Chinese replaces all composing pinyin')
      assert.equal(committed.markdown, (sample.source.startsWith('1. ') ? '1. ' : '') + sample.prefix + sample.committed, 'React receives the committed Markdown')
      assert.equal(committed.ends, 1, 'selecting Chinese ends composition once')
      for (const type of ['keyDown', 'keyUp']) {
        await webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8
        })
      }
      assert.equal((await snapshot()).text, sample.prefix + sample.committed.slice(0, -1), 'ordinary backspace still deletes committed text')
    }
    results.push('Chromium IME backspace, repeated deletion, continued input, Chinese commit and ordinary deletion in paragraphs and lists')

    await evaluate('prepareImeEditor()')
    for (const text of ['ni', 'n', '']) await compose(text)
    const empty = await snapshot()
    assert.equal(empty.text, '', 'deleting the complete composition leaves an empty editor')
    assert.equal(empty.markdown, '', 'React receives an empty draft')
    await compose('hao')
    const restarted = await snapshot()
    assert.equal(restarted.text, 'hao', 'typing after clearing pinyin starts a fresh composition')
    assert.equal(restarted.starts, 2, 'only an explicitly cleared composition starts a new composition')
    await commit('好')
    assert.equal((await snapshot()).markdown, '好', 'the fresh composition commits without leftover pinyin')
    results.push('Chromium IME complete deletion and fresh composition')
    return results
  } finally {
    await evaluate('destroyImeEditor()')
    webContents.debugger.detach()
  }
}
