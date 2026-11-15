// 任务看板「需要你处理」头部的进入任务按钮：位于收起左侧、复用 dock-toggle 样式，
// 点击走 onOpenTask 进入当前聚焦任务；多任务切换后跟随，收起态保留。
import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-focus-open-task', {
  setup: `
    import { TaskFocusQueue } from './src/renderer/components/TaskFocusQueue';
    const opened = [];
    const entries = [
      { id: 'a', title: '任务 A', readOnly: false, description: '描述 A', updatedAt: 1 },
      { id: 'b', title: '任务 B', readOnly: false, description: '描述 B', updatedAt: 2 },
    ];
    const noop = () => () => {};
    window.uniagent = new Proxy({
      getEvents: async () => [],
      getTaskDecisions: async () => [],
      onEvent: noop, onSideEvent: noop, onSessionUpdated: noop,
    }, { get: (t, k) => k in t ? t[k] : String(k).startsWith('on') ? noop : async () => null });
    const host = document.body.appendChild(document.createElement('div'));
    createRoot(host).render(React.createElement(TaskFocusQueue, { entries, onRefresh: () => {}, onOpenTask: id => { opened.push(id); } }));
    window.fixture = { host, opened };
  `,
  inspect: `(async () => {
    const f = window.fixture, tick = () => new Promise(r => setTimeout(r, 30));
    const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw Error(label + ': ' + f.host.textContent); };
    const head = () => f.host.querySelector('.interaction-dock-head');
    const toolButtons = () => [...head().querySelectorAll('.interaction-dock-tools button')];
    const openButton = () => toolButtons().find(b => (b.textContent || '').includes('进入任务'));
    const toggle = () => toolButtons().find(b => /收起|展开/.test(b.textContent || ''));
    await wait(() => openButton() && toggle(), 'dock head rendered');
    const orderOk = toolButtons().indexOf(openButton()) < toolButtons().indexOf(toggle());
    const className = openButton().className;
    const iconOk = !!openButton().querySelector('.ui-icon-arrow-right');
    openButton().click(); await tick();
    f.host.querySelector('.task-focus-more summary').click(); await tick();
    [...f.host.querySelectorAll('.task-focus-more button')].find(b => (b.textContent || '').includes('任务 B')).click(); await tick();
    const currentTitle = f.host.querySelector('.task-focus-panel:not([hidden]) .task-source-link').textContent;
    openButton().click(); await tick();
    toggle().click(); await tick();
    const collapsed = f.host.querySelector('.interaction-dock').classList.contains('is-collapsed');
    const collapsedButton = !!openButton();
    openButton().click(); await tick();
    toggle().click(); await tick();
    f.host.querySelector('.task-focus-panel:not([hidden]) .task-source-link').click(); await tick();
    return { opened: f.opened, orderOk, className, iconOk, currentTitle, collapsed, collapsedButton };
  })()`,
})

assert.deepEqual(result.opened, ['a', 'b', 'b', 'b'], '进入任务与标题链接都走 onOpenTask，且始终作用于当前展示任务')
assert.equal(result.orderOk, true, '进入任务位于收起/展开左侧')
assert.equal(result.className, 'interaction-dock-toggle', '复用现有 dock-toggle 样式')
assert.equal(result.iconOk, true, '按钮带 arrow-right 图标')
assert.equal(result.currentTitle, '任务 B', '切换待处理任务后聚焦面板跟随')
assert.equal(result.collapsed, true, '收起态生效')
assert.equal(result.collapsedButton, true, '收起态保留进入任务按钮')
console.log('PASS task focus queue open-task button enters the current task in expanded and collapsed states')