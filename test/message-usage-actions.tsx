import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'
import type { UAEvent } from '../src/shared/types.ts'

const event = (seq: number, type: UAEvent['type'], payload: UAEvent['payload'], state?: UAEvent['state']): UAEvent => ({
  sessionId: 'usage-actions', seq, ts: 1_000 + seq, type, payload, state,
})
const events = [
  event(0, 'user_message', { text: '第一轮' }),
  event(1, 'hook', { id: 'hook', eventName: 'stop', durationMs: 12 }, 'success'),
  event(2, 'agent_message', { text: '第一轮回复', phase: 'final_answer' }, 'success'),
  event(3, 'system_notice', { kind: 'usage', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, cost: 0.25 } }),
  event(4, 'turn_completed', {}, 'success'),
  event(5, 'user_message', { text: '第二轮' }),
  event(6, 'queue_status', { id: 'queue', queue: { state: 'ready', waitedMs: 12_000 } }, 'success'),
  event(7, 'agent_message', { text: '第二轮回复', phase: 'final_answer' }, 'success'),
  event(8, 'system_notice', { kind: 'usage', usage: { input_tokens: 200, output_tokens: 20, sessionInputTokens: 500, sessionOutputTokens: 50, sessionCost: null } }),
  event(9, 'turn_completed', {}, 'success'),
  event(10, 'user_message', { text: '没有用量的回复' }),
  event(11, 'agent_message', { text: '无用量', phase: 'final_answer' }, 'success'),
  event(12, 'turn_completed', {}, 'success'),
  event(13, 'user_message', { text: '中断回合' }),
  event(14, 'system_notice', { kind: 'usage', usage: { inputTokens: 30, outputTokens: 3 } }),
  event(15, 'turn_completed', {}, 'cancelled'),
]

const result = await renderEventStream(events, 'idle', 'usage-actions', {
  setup: `
    window.usageCopies = []; window.usageReads = [];
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => window.usageCopies.push(text)}});
    window.__eventStreamProps = {onOpenReader: event => window.usageReads.push(event.seq)};
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = '#root {display:flex;flex-direction:column;height:100vh}';
  `,
  inspect: `(async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 180));
    const turns = [...document.querySelectorAll('.turn-response')];
    const actions = turns[0].querySelector('.message-actions.agent');
    const button = turn => turn.querySelector('.message-usage > button');
    const popup = trigger => document.getElementById(trigger.getAttribute('aria-controls'));
    const table = panel => [...panel.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
    const initial = {
      order: [...actions.querySelectorAll('button')].map(node => node.getAttribute('aria-label')),
      counts: turns.map(turn => turn.querySelectorAll('.message-usage > button').length),
      tables: document.querySelectorAll('.usage-table').length,
      oldRows: document.querySelectorAll('.usage-line, .system-notice.usage').length,
      expanded: button(turns[0])?.getAttribute('aria-expanded'),
      margins: [...document.querySelectorAll('.event-stream > .user-msg')].map(node => [getComputedStyle(node).marginTop, getComputedStyle(node).marginBottom]),
    };
    if (!button(turns[0])) return {initial};
    turns[0].scrollIntoView(); await tick();
    const first = button(turns[0]);
    first.click(); await tick();
    const panel = popup(first);
    const opened = {rows: table(panel), role: panel.getAttribute('role'),
      expanded: first.getAttribute('aria-expanded'), attachedToBody: panel.parentElement === document.body,
      bounded: (() => { const rect = panel.getBoundingClientRect(); return rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 11 && rect.bottom <= innerHeight - 11; })(),
      iconWidth: first.getBoundingClientRect().width,
      toolbarVisible: getComputedStyle(actions).opacity};
    panel.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); await tick();
    const internalClickKeptOpen = !!popup(first);
    first.click(); await tick();
    const toggledClosed = first.getAttribute('aria-expanded') === 'false' && !popup(first);
    first.click(); await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await tick();
    const escapeClosed = !popup(first) && document.activeElement === first;
    first.click(); await tick();
    document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); await tick();
    const outsideClosed = !popup(first);
    first.click(); await tick();
    popup(first).querySelector('[aria-label="关闭 Token 明细"]').click(); await tick();
    const closeButton = !popup(first) && document.activeElement === first;
    const second = button(turns[1]);
    turns[1].scrollIntoView(); await tick(); second.click(); await tick();
    const secondRows = table(popup(second));
    const wait = popup(second).textContent.includes('等待算力 12s');
    document.querySelector('.event-stream').dispatchEvent(new Event('scroll')); await tick();
    const scrollClosed = !popup(second);
    const hook = actions.querySelector('[aria-label^="查看本轮 Hook"]');
    hook.click(); await tick(); first.click(); await tick();
    const independent = !!turns[0].querySelector('.turn-hooks') && !!popup(first);
    actions.querySelector('[aria-label="复制消息"]').click();
    actions.querySelector('[aria-label="沉浸阅读"]').click(); await tick();
    return {initial, opened, internalClickKeptOpen, toggledClosed, escapeClosed, outsideClosed, closeButton,
      secondRows, wait, scrollClosed, independent, copies: window.usageCopies, reads: window.usageReads};
  })()`,
})
assert.deepEqual(result.initial, {
  order: ['复制消息', '沉浸阅读', '查看本轮 Hook（1 个）', '查看 Token 用量'],
  counts: [1, 1, 0, 1], tables: 0, oldRows: 0, expanded: 'false',
  margins: [['0px', '28px'], ['28px', '28px'], ['28px', '28px'], ['28px', '28px']],
}, 'Token is the fourth icon; absent usage adds no icon, and user message spacing is reduced')
assert.deepEqual(result.opened, {
  rows: [['100', '10', '40', '$0.2500'], ['100', '10', '40', '$0.2500']],
  role: 'dialog', expanded: 'true', attachedToBody: true, bounded: true, iconWidth: 26, toolbarVisible: '1',
}, 'the icon opens a bounded popup with exact turn and cumulative totals')
for (const key of ['internalClickKeptOpen', 'toggledClosed', 'escapeClosed', 'outsideClosed', 'closeButton', 'wait', 'scrollClosed', 'independent']) {
  assert.equal(result[key], true, key)
}
assert.deepEqual(result.secondRows, [['200', '20', '—', '—'], ['500', '50', '40', '—']],
  'native session totals take precedence; missing cache/cost and explicitly unknown session cost remain accurate')
assert.deepEqual(result.copies, ['第一轮回复'])
assert.deepEqual(result.reads, [2])

const combined = await renderEventStream([
  event(0, 'user_message', { text: '历史多次用量结算' }),
  event(1, 'system_notice', { kind: 'usage', id: 'snapshot', turnId: 'turn', usage: { inputTokens: 999, outputTokens: 999 } }),
  event(2, 'system_notice', { kind: 'usage', id: 'snapshot', turnId: 'turn', usage: { inputTokens: 10, outputTokens: 2, cost: 0.1 } }),
  event(3, 'system_notice', { kind: 'usage', usage: { inputTokens: 20, outputTokens: 3, cost: 0.2 } }),
  event(4, 'turn_completed', {}, 'cancelled'),
], 'idle', 'usage-actions', {
  inspect: `(async () => {
    const buttons = [...document.querySelectorAll('.message-usage > button')];
    buttons[0]?.click(); await new Promise(resolve => setTimeout(resolve, 50));
    return {count: buttons.length, rows: [...document.querySelectorAll('.usage-table tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))};
  })()`,
})
assert.deepEqual(combined, {count: 1, rows: [['30', '5', '—', '$0.3000'], ['30', '5', '—', '$0.3000']]},
  'a turn without an assistant reply still has one icon; snapshots are deduplicated before multiple settlements are summed')

const narrow = await renderEventStream([
  event(0, 'system_notice', { kind: 'usage', usage: { inputTokens: 1_234_567_890_123, outputTokens: 9_876_543_210, cachedInputTokens: 123_456_789, cost: 12345 } }),
], 'idle', 'usage-actions', {
  screenshot: {path: process.cwd() + '/out/test/message-usage-narrow.png', width: 360, height: 320},
  inspect: `(async () => {
    const button = document.querySelector('.message-usage > button');
    button.click(); await new Promise(resolve => setTimeout(resolve, 180));
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    const rect = panel.getBoundingClientRect();
    const table = panel.querySelector('.usage-table-scroll');
    table.scrollLeft = table.scrollWidth;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {bounded: rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 11 && rect.bottom <= innerHeight - 11,
      scrollable: table.scrollWidth > table.clientWidth && table.scrollLeft > 0, stillOpen: panel.isConnected};
  })()`,
})
assert.deepEqual(narrow, {bounded: true, scrollable: true, stillOpen: true},
  'long token counts scroll inside a narrow popup without clipping it or dismissing it')

console.log('message-usage-actions: icon order, spacing, popup data, dismissal, history and existing actions passed')
