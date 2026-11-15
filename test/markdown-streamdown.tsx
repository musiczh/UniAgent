import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const markdown = '# 阅读方案\n\n正文包含 **重点** 与 `inline`。\n\n| 参数 | 值 |\n| --- | --- |\n| 样式 | compact |\n\n```kotlin\nval mode = "compact"\nstartTask(mode)\n```'
const result = await renderEventStream([
  { sessionId: 'markdown-streamdown', seq: 1, ts: 1, type: 'user_message', payload: { text: markdown } },
  { sessionId: 'markdown-streamdown', seq: 2, ts: 2, type: 'agent_message', payload: { text: markdown, phase: 'final_answer' } },
], 'idle', 'markdown-streamdown', {
  setup: `
    window.__copies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.__copies.push(text) } });
  `,
  inspect: `(async () => {
    const replies = [...document.querySelectorAll('.user-msg .agent-md, .agent-msg .agent-md')];
    const code = replies[1].querySelector('[data-streamdown="code-block"]');
    const copy = code?.querySelector('[data-streamdown="code-block-copy-button"]');
    copy?.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    replies[1].querySelector('button[title="全屏查看"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const fullscreen=document.querySelector('[data-streamdown="table-fullscreen"]');
    const fullscreenPosition=fullscreen ? getComputedStyle(fullscreen).position : null;
    const fullscreenOwner=!!fullscreen?.closest('.agent-md');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    return {
      count: replies.length,
      renderers: replies.map(root => ({
        heading: root.querySelector('[data-streamdown="heading-1"]')?.textContent,
        table: !!root.querySelector('[data-streamdown="table-wrapper"]'),
        code: !!root.querySelector('[data-streamdown="code-block"]'),
        inline: root.querySelector('[data-streamdown="inline-code"]')?.textContent,
      })),
      copies: window.__copies, fullscreenPosition, fullscreenOwner,
    };
  })()`,
})

assert.equal(result.count, 2)
assert.deepEqual(result.renderers, Array.from({ length: 2 }, () => ({
  heading: '阅读方案', table: true, code: true, inline: 'inline',
})), 'user and agent Markdown share the selected Streamdown rendering')
assert.deepEqual(result.copies, ['val mode = "compact"\nstartTask(mode)\n'], 'the native code toolbar copies the complete source')
assert.equal(result.fullscreenPosition, 'fixed', 'the native fullscreen table keeps its layout styles')
assert.equal(result.fullscreenOwner, true, 'overlays share the Markdown style scope')
console.log('markdown-streamdown: shared rendering and native copy passed')
