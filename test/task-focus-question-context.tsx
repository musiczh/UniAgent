// 看板「需要你处理」提问卡片应展示提问前紧邻的 Agent 输出（与对话内 question-context 同源），
// 被命令隔开或非提问审批不展示；背景与问题左缘对齐、同排版，间隔一行；无背景不留额外空行。
import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-focus-question-context', {
  setup: `
    import { TaskFocusQueue } from './src/renderer/components/TaskFocusQueue';
    import './src/renderer/components/taskBoard.css';
    const ev = (seq, type, payload, state) => ({ sessionId: 's', seq, ts: seq, type, state, payload });
    const question = (seq, requestId) => ev(seq, 'approval_request', {
      requestId, method: 'item/tool/requestUserInput', kind: 'question',
      params: { questions: [{ id: 'design', header: '设计确认', prompt: '设计稿是否确认？', options: [{ label: '确认', description: '开始实施' }] }] },
    }, 'pending');
    const events = [
      ev(0, 'user_message', { text: '这里增加一个按钮' }),
      ev(1, 'agent_message', { id: 'reply', text: '设计要点背景：位置与样式复用现有实现。' }, 'success'),
      ev(2, 'tool_call', { id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: '设计稿是否确认？' }] } }, 'success'),
      question(3, 'req-1'),
      ev(4, 'agent_message', { id: 'reply2', text: '被命令隔开的正文' }, 'success'),
      ev(5, 'command_exec', { command: 'echo block' }, 'success'),
      ev(6, 'tool_call', { id: 't2', name: 'AskUserQuestion', input: { questions: [{ question: '设计稿是否确认？' }] } }, 'success'),
      question(7, 'req-2'),
      ev(8, 'agent_message', { id: 'reply3', text: '审批前的正文' }, 'success'),
      ev(9, 'approval_request', { requestId: 'req-3', kind: 'command', params: { command: 'ls' } }, 'pending'),
    ];
    const decisions = [
      { id: 'd1', version: 'v1', type: 'question', priority: 'high', blocking: true, requestId: 'req-1', event: events[3], title: '设计确认', status: 'open' },
      { id: 'd2', version: 'v1', type: 'question', priority: 'high', blocking: true, requestId: 'req-2', event: events[7], title: '设计确认 2', status: 'open' },
      { id: 'd3', version: 'v1', type: 'approval', priority: 'high', blocking: true, requestId: 'req-3', event: events[9], title: '需要审批', status: 'open' },
    ];
    const noop = () => () => {};
    window.uniagent = new Proxy({
      getEvents: async () => events,
      getTaskDecisions: async () => decisions,
      onEvent: noop, onSideEvent: noop, onSessionUpdated: noop,
    }, { get: (t, k) => k in t ? t[k] : String(k).startsWith('on') ? noop : async () => null });
    const host = document.body.appendChild(document.createElement('div'));
    createRoot(host).render(React.createElement(TaskFocusQueue, { entries: [{ id: 's', title: '任务 A', readOnly: false, description: '描述', updatedAt: 1 }], onRefresh: () => {}, onOpenTask: () => {} }));
    window.fixture = { host };
  `,
  inspect: `(async () => {
    const f = window.fixture, tick = () => new Promise(r => setTimeout(r, 30));
    const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw Error(label + ': ' + f.host.textContent); };
    const panel = () => f.host.querySelector('.task-focus-panel:not([hidden])');
    const activeItem = () => panel().querySelector('.interaction-panel:not([hidden])');
    await wait(() => panel() && activeItem().querySelector('.question-context .agent-md'), 'question context rendered');
    const context = activeItem().querySelector('.question-context .agent-md');
    const title = activeItem().querySelector('.question-title');
    const prompt = activeItem().querySelector('.question-prompt .agent-md');
    const typography = node => { const style = getComputedStyle(node); return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }; };
    const withBackground = {
      text: context.textContent,
      aligned: context.getBoundingClientRect().left === title.getBoundingClientRect().left && title.getBoundingClientRect().left === prompt.getBoundingClientRect().left,
      sameTypography: JSON.stringify(typography(context)) === JSON.stringify(typography(prompt)),
      gap: title.getBoundingClientRect().top - context.getBoundingClientRect().bottom,
    };
    const tabs = [...panel().querySelectorAll('.interaction-tabs button')];
    tabs[1].click(); await tick();
    const separated = { contexts: activeItem().querySelectorAll('.question-context').length, approvalPaddingTop: getComputedStyle(activeItem().querySelector('.card.approval')).paddingTop };
    tabs[2].click(); await tick();
    const approval = { contexts: activeItem().querySelectorAll('.question-context').length, hasCommand: !!activeItem().querySelector('.approval-cmd') };
    tabs[0].click(); await tick();
    const toggle = [...f.host.querySelectorAll('.interaction-dock-tools button')].find(b => /收起|展开/.test(b.textContent || ''));
    toggle.click(); await tick();
    const collapsed = f.host.querySelector('.interaction-dock').classList.contains('is-collapsed') && [...f.host.querySelectorAll('.task-focus-panel')].every(p => p.offsetParent === null);
    return { withBackground, separated, approval, collapsed };
  })()`,
})

assert.match(result.withBackground.text, /设计要点背景：位置与样式复用现有实现。/, '看板展示提问前紧邻的 Agent 输出')
assert.equal(result.withBackground.aligned, true, '背景与问题标题、正文左缘对齐')
assert.equal(result.withBackground.sameTypography, true, '背景与问题正文同字号、行距与颜色')
assert.ok(Math.abs(result.withBackground.gap - 25) <= 2, '背景与问题之间空一行')
assert.deepEqual(result.separated, { contexts: 0, approvalPaddingTop: '0px' }, '被命令隔开的提问不展示背景，也不留额外空行')
assert.deepEqual(result.approval, { contexts: 0, hasCommand: true }, '非提问审批不展示背景')
assert.equal(result.collapsed, true, '收起态不展示背景')
console.log('PASS task focus queue shows the agent output preceding a question, with conversation parity rules')