import assert from 'node:assert/strict'
import type { UAEvent } from '../src/shared/types'
import { renderEventStream } from './regression/render-event-stream.mjs'

const sessionId = 'user-bubble-markdown'
const screenshotText = '```\nlvcc-settings\n```\n\n这个skill是只负责setting配置吗？实验的配置是否在这个skill内？'
const richText = '## 配置说明\n\n**重点**、*强调*、~~删除~~与 `settings`。\n\n- 第一项\n- 第二项\n\n1. 步骤一\n2. 步骤二\n\n> 引用内容\n\n| 配置 | 值 |\n| --- | --- |\n| 环境 | 测试 |\n\n[官网](https://example.com) 与 [源码](src/settings.ts:12)\n\n[危险链接](javascript:alert(1))\n\n<script>window.__unsafe = true</script>'
const events: UAEvent[] = [
  { sessionId, seq: 1, ts: 1, type: 'user_message', payload: { text: screenshotText, turnId: 'first', generationKind: 'title-description' } },
  { sessionId, seq: 2, ts: 2, type: 'turn_completed', state: 'success', payload: { turnId: 'first' } },
  { sessionId, seq: 3, ts: 3, type: 'user_message', payload: { text: richText } },
  { sessionId, seq: 4, ts: 4, type: 'turn_completed', state: 'success', payload: {} },
  { sessionId, seq: 5, ts: 5, type: 'user_message', payload: { text: '第一行\n第二行' } },
  { sessionId, seq: 6, ts: 6, type: 'turn_completed', state: 'success', payload: {} },
  { sessionId, seq: 7, ts: 7, type: 'goal_message', payload: {
    text: '完整指令', displayText: '**带评论的目标**',
    comments: [{ quote: '原文', comment: '检查配置' }],
    attachments: [{ kind: 'file', name: 'settings.json', path: '/repo/settings.json' }],
  } },
  { sessionId, seq: 8, ts: 8, type: 'turn_completed', state: 'success', payload: {} },
  { sessionId, seq: 9, ts: 9, type: 'user_message', payload: { text: '' } },
  { sessionId, seq: 10, ts: 10, type: 'turn_completed', state: 'success', payload: {} },
  { sessionId, seq: 11, ts: 11, type: 'user_message', payload: { text: '```kotlin\n' + 'val config = "' + 'x'.repeat(180) + '"\n```' } },
]

const result = await renderEventStream(events, 'idle', sessionId, {
  fileLinks: true,
  setup: `
    import { COLOR_THEMES } from './src/shared/colorThemes';
    import { applyColorTheme } from './src/renderer/colorTheme';
    window.__themes = COLOR_THEMES; window.__applyTheme = applyColorTheme;
    window.__copies = []; window.__rewinds = []; window.__external = [];
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => window.__copies.push(text)}});
    window.__eventStreamProps = {onRewindToTurn: point => window.__rewinds.push(point)};
    window.uniagent = new Proxy({
      homeDir: '/Users/me',
      openExternal: async url => window.__external.push(url),
      fsListDir: async () => ({ok: true, entries: [{kind: 'file', size: 1, name: 'settings.ts'}]}),
    }, {get: (target, key) => key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null});
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = '#root {width:360px;display:flex;flex-direction:column;height:100vh}';
  `,
  inspect: `(async () => {
    const rows = [...document.querySelectorAll('.user-msg')];
    const bodies = rows.map(row => row.querySelector('.bubble .agent-md'));
    const rich = bodies[1];
    const local = [...(rich?.querySelectorAll('a') || [])].find(a => a.textContent === '源码');
    for (let i = 0; i < 100 && local && !local.classList.contains('md-path'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    rows[0].querySelector('[aria-label="复制消息"]').click();
    rows[0].querySelector('[aria-label="回退到本轮对话发起前"]')?.click();
    rows[3].querySelector('[aria-label="复制消息"]').click();
    local?.click();
    [...(rich?.querySelectorAll('a') || [])].find(a => a.textContent === '官网')?.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const colors = [];
    if (rich) for (const theme of window.__themes) {
      window.__applyTheme(theme.id);
      const bubbleColor = getComputedStyle(rows[1].querySelector('.bubble')).color;
      colors.push({theme: theme.id, matches: [rich, ...rich.querySelectorAll('strong,a,blockquote,code')].every(el => getComputedStyle(el).color === bubbleColor)});
    }
    const longCode = bodies[5]?.querySelector('[data-streamdown="code-block-body"]');
    if (longCode) longCode.scrollLeft = longCode.scrollWidth;
    return {
      count: rows.length,
      generationLabels: document.querySelectorAll('[aria-label="生成调用类型"]').length,
      code: bodies[0]?.querySelector('pre code')?.textContent,
      question: bodies[0]?.querySelector('p')?.textContent,
      heading: rich?.querySelector('h2')?.textContent,
      strong: rich?.querySelector('strong')?.textContent,
      emphasis: rich?.querySelector('em')?.textContent,
      deleted: rich?.querySelector('del')?.textContent,
      unordered: [...(rich?.querySelectorAll('ul li') || [])].map(li => li.textContent),
      ordered: [...(rich?.querySelectorAll('ol li') || [])].map(li => li.textContent),
      quote: rich?.querySelector('blockquote')?.textContent.trim(),
      table: rich?.querySelector('td')?.textContent,
      plainBreaks: bodies[2]?.querySelectorAll('br').length,
      unsafe: window.__unsafe === true || !!rich?.querySelector('script,a[href^="javascript:"]'),
      goal: rows[3].querySelector('.capability-chip')?.textContent,
      displayText: bodies[3]?.querySelector('strong')?.textContent,
      comment: rows[3].querySelector('.bubble-comment-note')?.textContent,
      attachment: rows[3].querySelector('.bubble-attach')?.textContent.trim(),
      empty: bodies[4]?.textContent,
      copies: window.__copies, rewinds: window.__rewinds, files: window.__openedFiles || [], external: window.__external,
      colors,
      whitespace: bodies[0] ? [getComputedStyle(bodies[0]).whiteSpace, getComputedStyle(bodies[0].querySelector('pre')).whiteSpace] : [],
      bounded: rows.every(row => row.querySelector('.bubble').getBoundingClientRect().right <= row.getBoundingClientRect().right + 1 && row.querySelector('.bubble').scrollWidth <= row.querySelector('.bubble').clientWidth + 1),
      scrollableCode: !!longCode && longCode.scrollLeft > 0,
    };
  })()`,
})

assert.equal(result.code, 'lvcc-settings', 'the native code block displays the screenshot source without a trailing empty line')
assert.equal(result.question, screenshotText.split('\n\n')[1])
assert.equal(result.count, 6)
assert.equal(result.generationLabels, 0, 'generation metadata cannot alter an ordinary writable conversation')
assert.equal(result.heading, '配置说明')
assert.equal(result.strong, '重点')
assert.equal(result.emphasis, '强调')
assert.equal(result.deleted, '删除')
assert.deepEqual(result.unordered, ['第一项', '第二项'])
assert.deepEqual(result.ordered, ['步骤一', '步骤二'])
assert.equal(result.quote, '引用内容')
assert.equal(result.table, '环境')
assert.equal(result.plainBreaks, 1, 'plain-text line breaks remain visible')
assert.equal(result.unsafe, false, 'Markdown uses the existing sanitizer')
assert.match(result.goal, /Goal/)
assert.equal(result.displayText, '带评论的目标')
assert.equal(result.comment, '检查配置')
assert.match(result.attachment, /settings\.json/)
assert.equal(result.empty, '')
assert.deepEqual(result.copies, [screenshotText, '**带评论的目标**\n\n> 原文\n检查配置'], 'copy preserves Markdown and structured comments')
assert.deepEqual(result.rewinds, [{turnId: 'first', userEventSeq: 1}], 'rewind keeps the original turn identity')
assert.deepEqual(result.files, [['src/settings.ts', 12]])
assert.deepEqual(result.external, ['https://example.com'])
assert.equal(result.colors.length, 9)
assert.ok(result.colors.every(item => item.matches), JSON.stringify(result.colors))
assert.deepEqual(result.whitespace, ['normal', 'pre'], 'HTML formatting does not inherit bubble pre-wrap')
assert.equal(result.bounded, true, 'rich content stays within narrow bubbles')
assert.equal(result.scrollableCode, true, 'long code scrolls without widening the bubble')
console.log('user-bubble-markdown: code, rich text, links, sanitization, copy, rewind, comments, attachments, themes and narrow layout passed')
