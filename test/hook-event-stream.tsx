import assert from 'node:assert/strict'
import DOMPurify from 'dompurify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderOpenChains } from './regression/open-chain'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { mergeSessionEvent } from '../src/renderer/App.tsx'
import { EventStream, groupChainEvents, TurnStatusBar } from '../src/renderer/components/EventStream.tsx'
import { projectDeepSeekNativeEvent } from '../src/main/deepseekEventProjection.ts'
import type { UAEvent } from '../src/shared/types.ts'

// SSR checks layout only; browser sanitization is covered by engine acceptance.
DOMPurify.sanitize = (html: string) => html

function hook(seq: number, id: string, state: UAEvent['state'], durationMs: number | null): UAEvent {
  return {
    sessionId: 'hook-session', seq, ts: 1_000 + seq, type: 'hook' as UAEvent['type'], state,
    payload: {
      id, turnId: 'turn-1', eventName: 'userPromptSubmit', handlerType: 'command',
      executionMode: 'sync', scope: 'turn', source: 'user',
      sourcePath: `/repo/${id}.json`, statusMessage: 'Tracking hook...', durationMs,
      entries: state === 'success' ? [{ kind: 'warning', text: `output-${id}` }] : []
    }
  }
}

function command(seq: number, id: string, durationMs: number): UAEvent {
  return {
    sessionId: 'hook-session', seq, ts: 1_000 + seq, type: 'command_exec', state: 'success',
    payload: { id, command: `echo ${id}`, output: id, exitCode: 0, durationMs },
  }
}

const merged = [
  hook(1, 'hook-a', 'running', null),
  hook(2, 'hook-b', 'running', null),
  hook(3, 'hook-a', 'success', 96),
].reduce<UAEvent[]>(mergeSessionEvent, [])

assert.equal(merged.length, 2, 'started/completed updates for one hook must replace in place')
assert.equal(merged[0].state, 'success')
assert.equal(merged[0].payload.durationMs, 96)

const grouped = groupChainEvents([
  ...merged,
  { sessionId: 'hook-session', seq: 4, ts: 1_004, type: 'reasoning', state: 'success', payload: { id: 'r', text: 'done' } }
])
assert.deepEqual(grouped.map((entry) => entry.kind), ['reasoning'], 'Hooks no longer belong to the work chain')

const markup = renderOpenChains(createElement(EventStream, {
  sessionId: 'hook-session',
  status: 'running',
  events: [
    { sessionId: 'hook-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    ...merged,
  ]
}))
assert.doesNotMatch(markup, /Hook|hook-batch|hook-row|data-step-id=|process-timeline-head/, 'running Hooks leave no visible cards, activity labels or empty steps')

// Stop hooks after the final reply stay out of the timeline and remain available
// through the completed turn's action bar.
const lateHookEvents: UAEvent[] = [
  { sessionId: 'late-hook-session', seq: 1, ts: 1_001, type: 'user_message', payload: { text: '继续' } },
  { sessionId: 'late-hook-session', seq: 2, ts: 1_002, type: 'agent_message', state: 'success', payload: { id: 'narr-1', phase: 'commentary', text: '第一段工作' } },
  { sessionId: 'late-hook-session', seq: 3, ts: 1_003, type: 'tool_call', state: 'success', payload: { id: 'work-1', name: 'read_file', provider: 'native' } },
  { sessionId: 'late-hook-session', seq: 4, ts: 1_004, type: 'agent_message', state: 'success', payload: { id: 'narr-2', phase: 'commentary', text: '第二段工作' } },
  { sessionId: 'late-hook-session', seq: 5, ts: 1_005, type: 'tool_call', state: 'success', payload: { id: 'work-2', name: 'read_file', provider: 'native' } },
  { sessionId: 'late-hook-session', seq: 6, ts: 1_006, type: 'tool_call', state: 'success', payload: { id: 'work-3', name: 'read_file', provider: 'native' } },
  { sessionId: 'late-hook-session', seq: 7, ts: 1_007, type: 'tool_call', state: 'success', payload: { id: 'work-4', name: 'read_file', provider: 'native' } },
  { sessionId: 'late-hook-session', seq: 8, ts: 1_008, type: 'tool_call', state: 'success', payload: { id: 'work-5', name: 'read_file', provider: 'native' } },
  { sessionId: 'late-hook-session', seq: 9, ts: 1_009, type: 'agent_message', state: 'success', payload: { id: 'reply', phase: 'final_answer', text: '最终回复' } },
  ...[
    hook(10, 'late-hook-a', 'success', 50),
    hook(11, 'late-hook-b', 'success', 40),
    hook(12, 'late-hook-c', 'running', null),
  ].map(event => ({ ...event, sessionId: 'late-hook-session' })),
]
const finalReplyHooks = renderOpenChains(createElement(EventStream, {
  sessionId: 'late-hook-session',
  status: 'running',
  events: lateHookEvents,
}))
assert.equal((finalReplyHooks.match(/data-step-id=/g) || []).length, 2, 'late Hooks must not create a third execution step')
assert.doesNotMatch(finalReplyHooks, /执行调用/, 'no standalone execution step is rendered after the final reply')
assert.doesNotMatch(finalReplyHooks, /Hook|hook-batch|hook-row/, 'late Hooks stay hidden until the entire turn ends')
const finalReplyAt = finalReplyHooks.indexOf('最终回复')
assert.ok(!finalReplyHooks.slice(finalReplyAt).includes('data-step-id='), 'nothing after the final reply opens another step')

// Opening the completed process fold must not reveal another copy of the Hooks.
const completedFinalReplyHooks = renderOpenChains(createElement(EventStream, {
  sessionId: 'late-hook-session',
  status: 'idle',
  events: [
    ...lateHookEvents,
    { sessionId: 'late-hook-session', seq: 13, ts: 1_013, type: 'turn_completed', state: 'success', payload: { turnId: 'turn-1' } },
  ],
}), { processed: true })
assert.equal((completedFinalReplyHooks.match(/data-step-id=/g) || []).length, 2, 'completed late Hooks must not create a third execution step')
assert.doesNotMatch(completedFinalReplyHooks, /执行调用/, 'the completed fold has no trailing execution step')
assert.match(completedFinalReplyHooks, /aria-label="查看本轮 Hook（3 个）" aria-expanded="false"/, 'completed turns expose a collapsed Hook action')
assert.doesNotMatch(completedFinalReplyHooks, /hook-batch|hook-row/, 'Hook details are not rendered before clicking the action')

// A plain answer needs no work-process step to keep its Hook history accessible.
const orphanLateHookEvents: UAEvent[] = [
  { sessionId: 'late-hook-session', seq: 1, ts: 1_001, type: 'user_message', payload: { text: '你好' } },
  { sessionId: 'late-hook-session', seq: 2, ts: 1_002, type: 'agent_message', state: 'success', payload: { id: 'plain-reply', phase: 'final_answer', text: '你好' } },
  { ...hook(3, 'orphan-hook', 'running', null), sessionId: 'late-hook-session' },
]
const replyOnlyLateHook = renderOpenChains(createElement(EventStream, {
  sessionId: 'late-hook-session',
  status: 'running',
  events: orphanLateHookEvents,
}))
assert.doesNotMatch(replyOnlyLateHook, /data-step-id=|process-timeline-head/, 'an orphan late Hook must not open a process step')
assert.doesNotMatch(replyOnlyLateHook, /执行调用/, 'a plain reply keeps no trailing execution step')
assert.doesNotMatch(replyOnlyLateHook, /Hook|hook-row/, 'the activity label also hides running Hooks')
const completedReplyOnlyLateHook = renderOpenChains(createElement(EventStream, {
  sessionId: 'late-hook-session',
  status: 'idle',
  events: [
    ...orphanLateHookEvents,
    { sessionId: 'late-hook-session', seq: 4, ts: 1_004, type: 'turn_completed', state: 'success', payload: { turnId: 'turn-1' } },
  ],
}), { processed: true })
assert.doesNotMatch(completedReplyOnlyLateHook, /data-step-id=|process-timeline-head|processed-fold/, 'an orphan late Hook must not leave an empty processed fold')
assert.match(completedReplyOnlyLateHook, /你好/, 'the plain final reply still renders')
assert.match(completedReplyOnlyLateHook, /aria-label="查看本轮 Hook（1 个）"/, 'a plain reply retains its late Hook')

for (const [status, state] of [['idle', 'success'], ['error', 'failed'], ['cancelled', 'cancelled'], ['interrupted', 'cancelled']] as const) {
  const terminal = renderToStaticMarkup(createElement(EventStream, {
    sessionId: 'hook-session', status,
    events: [
      { sessionId: 'hook-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
      hook(1, 'terminal-hook', state, 12),
      { sessionId: 'hook-session', seq: 2, ts: 1_002, type: 'turn_completed', state, payload: {} },
    ],
  }))
  assert.match(terminal, /aria-label="查看本轮 Hook（1 个）"/, `${status}: no reply is required to inspect Hooks`)
  assert.doesNotMatch(terminal, /data-step-id=|process-timeline-head|hook-row/, 'a Hook-only terminal turn has no empty steps or eager details')
  assert.equal((terminal.match(/aria-label="复制消息"/g) || []).length, 1, 'only the user bubble offers copying when no agent reply exists')
}

const noHooks = renderToStaticMarkup(createElement(EventStream, {
  sessionId: 'late-hook-session', status: 'idle',
  events: orphanLateHookEvents.filter(event => event.type !== 'hook').concat({
    sessionId: 'late-hook-session', seq: 4, ts: 1_004, type: 'turn_completed', state: 'success', payload: {},
  }),
}))
assert.doesNotMatch(noHooks, /本轮 Hook|turn-hooks/, 'turns without Hooks have no action or panel')

const hookTypes = [
  'userPromptSubmit', 'preToolUse', 'postToolUse', 'userPromptSubmit', 'preToolUse',
  'postToolUse', 'userPromptSubmit', ...Array(16).fill('preToolUse'),
  ...Array(3).fill('postToolUse'), 'customLifecycle', undefined,
]
const typedHooks = hookTypes.map((eventName, index) => {
  const event = hook(index + 1, `typed-${index}`, 'success', 25)
  event.payload.eventName = eventName
  return event
})
const groupedHooks = await renderEventStream([
  { sessionId: 'hook-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: '分组检查' } },
  ...typedHooks,
  { sessionId: 'hook-session', seq: 29, ts: 1_029, type: 'agent_message', state: 'success', payload: { text: '分组完成', phase: 'final_answer' } },
  { sessionId: 'hook-session', seq: 30, ts: 1_030, type: 'turn_completed', state: 'success', payload: {} },
], 'idle', 'hook-session', {
  setup: `
    window.hookForks = [];
    window.hookCopies = [];
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => window.hookCopies.push(text)}});
    window.__eventStreamProps = {historyFork: {agentName: 'Codex', busy: false,
      points: [{eventSeq: 29, kind: 'after-turn', nativeId: 'grouped-native'}],
      onFork: point => window.hookForks.push(point.eventSeq)}};
  `,
  inspect: `(async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 180));
    const turn = document.querySelector('.turn-response');
    const actions = turn.querySelector('.message-actions.agent');
    const toggle = actions.querySelector('button[aria-controls]');
    toggle.click(); await tick();
    const panel = turn.querySelector('.turn-hooks');
    const groups = [...panel.querySelectorAll('.turn-hook-group')];
    const initial = {names: groups.map(group => group.getAttribute('aria-label')),
      counts: groups.map(group => group.querySelector('.hook-batch-count').textContent),
      collapsed: groups.every(group => !group.open),
      rowsHidden: [...panel.querySelectorAll('.hook-row')].every(row => !row.checkVisibility())};
    if (groups.length !== 5) return {initial};
    groups[1].querySelector('summary').click();
    groups[0].querySelector('summary').click(); await tick();
    const independent = groups.map(group => group.open);
    groups[0].querySelector('summary').click(); await tick();
    const sources = [...groups[1].querySelectorAll('.hook-source')].map(node => node.textContent);
    groups[1].querySelector('.hook-row').click(); await tick();
    const list = panel.querySelector('.hook-batch-body');
    const headerTop = panel.querySelector('.hook-batch-head').getBoundingClientRect().top;
    list.scrollTop = list.scrollHeight; await tick();
    document.activeElement?.blur(); await tick();
    const layout = {bounded: panel.getBoundingClientRect().height <= Math.min(420, innerHeight / 2) + 1,
      scrollable: list.scrollHeight > list.clientHeight && list.scrollTop > 0,
      headerFixed: panel.querySelector('.hook-batch-head').getBoundingClientRect().top === headerTop,
      pointerAway: !turn.matches(':hover'), focusAway: !turn.contains(document.activeElement),
      opacity: getComputedStyle(actions).opacity,
      actions: [...actions.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))};
    actions.querySelector('[aria-label="复制消息"]').click();
    actions.querySelector('[aria-label="从此位置分叉新会话"]').click(); await tick();
    toggle.click(); await tick();
    const closedOpacity = getComputedStyle(actions).opacity;
    toggle.click(); await tick();
    const resetCollapsed = [...turn.querySelectorAll('.turn-hook-group')].every(group => !group.open);
    return {initial, independent, sources, layout, closedOpacity, resetCollapsed,
      copies: window.hookCopies, forks: window.hookForks};
  })()`,
})
assert.deepEqual(groupedHooks.initial, {
  names: ['userPromptSubmit', 'preToolUse', 'postToolUse', 'customLifecycle', 'Hook'],
  counts: ['3 个', '18 个', '5 个', '1 个', '1 个'], collapsed: true, rowsHidden: true,
}, 'interleaved Hooks group by type in first-seen order, including unknown and missing types; all groups start collapsed')
assert.deepEqual(groupedHooks.independent, [true, true, false, false, false], 'type groups expand independently')
assert.deepEqual(groupedHooks.sources, typedHooks.filter(event => event.payload.eventName === 'preToolUse')
  .map(event => `${event.payload.id}.json`), 'each group retains execution order without duplicate calls')
assert.deepEqual(groupedHooks.layout, {
  bounded: true, scrollable: true, headerFixed: true, pointerAway: true, focusAway: true, opacity: '1',
  actions: ['复制消息', '从此位置分叉新会话', '查看本轮 Hook（28 个）'],
}, 'expanded rows scroll within the bounded panel while its header and all three actions remain visible without hover or focus')
assert.equal(groupedHooks.closedOpacity, '0', 'closing the panel restores the existing action visibility rule')
assert.equal(groupedHooks.resetCollapsed, true, 'reopening the panel starts with every type collapsed')
assert.deepEqual(groupedHooks.copies, ['分组完成'])
assert.deepEqual(groupedHooks.forks, [29], 'the visible fork action still targets the completed reply')

const historyEvents: UAEvent[] = [
  { sessionId: 'hook-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: '第一轮' } },
  hook(1, 'hook-a', 'success', 96),
  hook(2, 'hook-b', 'failed', 20),
  { sessionId: 'hook-session', seq: 3, ts: 1_003, type: 'agent_message', state: 'success', payload: { text: '第一轮完成', phase: 'final_answer' } },
  { sessionId: 'hook-session', seq: 4, ts: 1_004, type: 'turn_completed', state: 'success', payload: {} },
  hook(5, 'stop-hook', 'running', null),
  hook(6, 'stop-hook', 'success', 35),
  { sessionId: 'hook-session', seq: 7, ts: 1_007, type: 'system_notice', payload: { kind: 'usage', usage: { inputTokens: 50, outputTokens: 10 } } },
  { sessionId: 'hook-session', seq: 8, ts: 1_008, type: 'user_message', payload: { text: '第二轮' } },
  hook(9, 'cancelled-hook', 'cancelled', 15),
  { sessionId: 'hook-session', seq: 10, ts: 1_010, type: 'turn_completed', state: 'cancelled', payload: {} },
  { sessionId: 'hook-session', seq: 11, ts: 1_011, type: 'user_message', payload: { text: '第三轮' } },
  { sessionId: 'hook-session', seq: 12, ts: 1_012, type: 'agent_message', state: 'success', payload: { text: '无 Hook 的回复', phase: 'final_answer' } },
  { sessionId: 'hook-session', seq: 13, ts: 1_013, type: 'turn_completed', state: 'success', payload: {} },
  { sessionId: 'hook-session', seq: 14, ts: 1_014, type: 'user_message', payload: { text: '第四轮' } },
  hook(15, 'current-hook', 'running', null),
]
const interactions = await renderEventStream([], 'idle', 'empty', {
  setup: `
    window.hookCopies = [];
    window.hookReads = [];
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => window.hookCopies.push(text)}});
    const host = document.body.appendChild(document.createElement('div'));
    host.id = 'hook-fixture';
    function HookFixture() {
      const [state, setState] = React.useState({events: ${JSON.stringify(historyEvents)}, status: 'running'});
      window.setHookFixture = setState;
      return React.createElement(EventStream, {...state, sessionId: 'hook-session', onOpenReader: event => window.hookReads.push(event.seq)});
    }
    createRoot(host).render(React.createElement(HookFixture));
  `,
  inspect: `(async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 40));
    const root = document.getElementById('hook-fixture');
    const turns = () => [...root.querySelectorAll('.turn-response')];
    const button = turn => turn.querySelector('.message-actions.agent button[aria-controls]');
    const before = {buttons: turns().map(turn => button(turn)?.getAttribute('aria-label') ?? null), panels: root.querySelectorAll('.turn-hooks').length};
    const first = button(turns()[0]);
    first.click(); await tick();
    const panel = turns()[0].querySelector('.turn-hooks');
    const rows = [...panel.querySelectorAll('.hook-row')];
    const opened = {
      count: rows.length, names: [...panel.querySelectorAll('.hook-source')].map(node => node.textContent),
      summary: panel.querySelector('.hook-batch-summary').textContent,
      expanded: first.getAttribute('aria-expanded'), linked: panel.id === first.getAttribute('aria-controls'),
      afterActions: panel.previousElementSibling === first.parentElement,
      afterUsage: first.parentElement.previousElementSibling?.classList.contains('usage'),
      rowsClosed: rows.every(row => row.getAttribute('aria-expanded') === 'false'),
      othersClosed: turns().slice(1).every(turn => !turn.querySelector('.turn-hooks')),
    };
    panel.querySelector('.hook-type-head').click(); await tick();
    rows[0].click(); await tick();
    const detail = {expanded: rows[0].getAttribute('aria-expanded'), text: rows[0].parentElement.querySelector('.hook-detail').textContent};
    turns()[0].querySelector('[aria-label="复制消息"]').click();
    turns()[0].querySelector('[aria-label="沉浸阅读"]').click(); await tick();
    first.click(); await tick();
    const closed = {expanded: first.getAttribute('aria-expanded'), panels: root.querySelectorAll('.turn-hooks').length};
    button(turns()[1]).click(); await tick();
    const cancelled = turns()[1].querySelector('.turn-hooks').textContent;
    window.setHookFixture({events: ${JSON.stringify(historyEvents.slice(0, -1).concat(hook(15, 'current-hook', 'success', 40), {
      sessionId: 'hook-session', seq: 16, ts: 1_016, type: 'turn_completed', state: 'success', payload: {},
    }))}, status: 'idle'});
    await tick();
    const completed = {buttons: turns().map(turn => button(turn)?.getAttribute('aria-label') ?? null),
      earlierStillOpen: !!turns()[1].querySelector('.turn-hooks'), latestClosed: !turns()[3].querySelector('.turn-hooks')};
    return {before, opened, detail, closed, cancelled, completed, copies: window.hookCopies, reads: window.hookReads};
  })()`,
})
assert.deepEqual(interactions.before, {
  buttons: ['查看本轮 Hook（3 个）', '查看本轮 Hook（1 个）', null, null], panels: 0,
}, 'history actions remain available while the current turn hides Hooks; snapshots count as one call')
assert.deepEqual(interactions.opened, {
  count: 3, names: ['hook-a.json', 'hook-b.json', 'stop-hook.json'], summary: '2 已完成1 失败',
  expanded: 'true', linked: true, afterActions: true, afterUsage: true, rowsClosed: true, othersClosed: true,
}, 'the action opens only its own turn after usage, including late Stop Hooks')
assert.equal(interactions.detail.expanded, 'true')
assert.match(interactions.detail.text, /来源\/repo\/hook-a.json/)
assert.match(interactions.detail.text, /command · sync · turn/, 'individual disclosure retains handler metadata')
assert.match(interactions.detail.text, /output-hook-a/, 'individual disclosure retains Hook output')
assert.deepEqual(interactions.closed, { expanded: 'false', panels: 0 }, 'clicking again removes the details')
assert.match(interactions.cancelled, /cancelled-hook.json[\s\S]*已取消 · 15ms/, 'cancelled Hooks remain inspectable without an agent reply')
assert.deepEqual(interactions.completed, {
  buttons: ['查看本轮 Hook（3 个）', '查看本轮 Hook（1 个）', null, '查看本轮 Hook（1 个）'],
  earlierStillOpen: true, latestClosed: true,
}, 'finishing the current turn reveals its action without changing earlier disclosures')
assert.deepEqual(interactions.copies, ['第一轮完成'], 'the existing copy action still copies the reply')
assert.deepEqual(interactions.reads, [3], 'the existing reader action still targets the final reply')

const realNow = Date.now
try {
  // 计时胶囊重构 — the capsule shows only the turn's total wall-clock time plus a
  // state color/glyph; the per-bucket timing split (模型思考/工具调用/…) is gone.
  Date.now = () => 6_000
  const runningEvents = [
    { sessionId: 'hook-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'run' } },
    hook(1_000, 'hook-finished', 'success', 1_000),
  ]
  const runningMarkup = renderToStaticMarkup(createElement(TurnStatusBar, {
    status: 'running',
    events: runningEvents,
  }))
  assert.match(runningMarkup, /turn-timer st-running/, 'a running turn must show the blue running capsule')
  assert.match(runningMarkup, /turn-timer-mark is-dot/, 'the running capsule leads with a pulsing dot')
  assert.match(runningMarkup, /turn-timer-text">5s</, 'the running capsule counts wall-clock time since the user message')
  assert.doesNotMatch(runningMarkup, /模型思考|Hook 执行|等待 Agent|tt-stack/, 'the per-turn timing split is removed')

  const waitingMarkup = renderToStaticMarkup(createElement(TurnStatusBar, {
    status: 'awaiting-approval',
    events: runningEvents,
  }))
  assert.match(waitingMarkup, /turn-timer st-waiting/, 'awaiting approval must show the yellow capsule')
  assert.match(waitingMarkup, /turn-timer-mark"[^>]*>\?</, 'the waiting capsule leads with a question mark')
  assert.match(waitingMarkup, /turn-timer-text">5s</, 'the waiting capsule keeps counting')

  const doneMarkup = renderToStaticMarkup(createElement(TurnStatusBar, {
    status: 'idle',
    events: runningEvents,
  }))
  assert.match(doneMarkup, /turn-timer st-done/, 'an ended turn must show the green capsule')
  assert.match(doneMarkup, /turn-timer-mark"[^>]*>✓</, 'the done capsule leads with a check mark')
  assert.match(doneMarkup, /turn-timer-text">1s</, 'the done capsule freezes at the last turn\'s duration')

  const errorMarkup = renderToStaticMarkup(createElement(TurnStatusBar, {
    status: 'error',
    events: runningEvents,
  }))
  assert.match(errorMarkup, /turn-timer st-error/, 'a failed turn must show the red capsule')
  assert.match(errorMarkup, /turn-timer-mark"[^>]*>!</, 'the error capsule leads with an exclamation mark')

  const emptyMarkup = renderToStaticMarkup(createElement(TurnStatusBar, {
    status: 'idle',
    events: [],
  }))
  assert.equal(emptyMarkup, '', 'a session without any turn renders no capsule')
} finally {
  Date.now = realNow
}

const roleTaskId = '53f4b2d4-eb9a-4bf1-b7de-f6c55dd7cb1e'
const roleCardMarkup = renderToStaticMarkup(createElement(EventStream, {
  sessionId: 'caller-session',
  status: 'running',
  events: [
    { sessionId: 'caller-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'delegate' } },
    {
      sessionId: 'caller-session', seq: 1, ts: 1_001, type: 'tool_call', state: 'success',
      payload: {
        id: 'role-handoff', provider: 'mcp', server: 'uniagent', name: 'create_uniagent_task',
        input: { prompt: '检查设计', role: 'role_internal_id' },
        result: `已向 UniAgent 提交新任务，taskId=${roleTaskId}。\n\n[uniagent:event=started]`
      }
    }
  ],
  handoffSessionTargets: {
    [roleTaskId]: { sessionId: 'target-session', roleName: 'A畜', agentName: 'Codex' }
  },
  onJumpToSession: () => {}
}))
assert.match(roleCardMarkup, /跨agent调用[\s\S]*A畜[\s\S]*（Codex）[\s\S]*派发任务/, '角色交接卡展示角色、Agent 与右侧动作')
assert.doesNotMatch(roleCardMarkup, /role_internal_id/, '角色内部 id 不应出现在卡片中')
assert.match(roleCardMarkup, /class="hx"[^>]*role="button"/, '能匹配 session 的交接卡应整卡可点击')
assert.match(roleCardMarkup, /title="点击跳转到该任务会话"/)
assert.match(roleCardMarkup, /aria-label="跳转到A畜的任务会话"/)
assert.match(roleCardMarkup, /process-step-node[^>]*><svg width="13"[^>]*ui-icon-dispatch/,
  'MCP 任务在时间轴上使用与用户追加消息等大的独立图标')
assert.doesNotMatch(roleCardMarkup, /hx-ic|hx-dot|hx-tag/, '卡片不重复放图标、圆点和状态标签')

const lifecycleMarkup = renderToStaticMarkup(createElement(EventStream, {
  sessionId: 'caller-session',
  status: 'completed',
  events: [
    { sessionId: 'caller-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'delegate' } },
    {
      sessionId: 'caller-session', seq: 1, ts: 1_001, type: 'tool_call', state: 'success',
      payload: {
        id: 'accepted-only', provider: 'mcp', server: 'uniagent', name: 'create_uniagent_task',
        input: { prompt: 'not delivered', followupTaskId: roleTaskId },
        result: `UniAgent 已受理请求，taskId=${roleTaskId}。`
      }
    },
    {
      sessionId: 'caller-session', seq: 2, ts: 1_002, type: 'tool_call', state: 'success',
      payload: {
        id: 'force-delivered', provider: 'mcp', server: 'uniagent', name: 'create_uniagent_task',
        input: { prompt: 'change now', followupTaskId: roleTaskId, force: true },
        result: `已强制发送，taskId=${roleTaskId}。\n\n[uniagent:event=force-delivered]`
      }
    },
    {
      sessionId: 'caller-session', seq: 3, ts: 1_003, type: 'tool_call', state: 'success',
      payload: {
        id: 'stop-task', provider: 'mcp', server: 'uniagent', name: 'stop_uniagent_task',
        input: { taskId: roleTaskId },
        result: `任务已中止，taskId=${roleTaskId}。\n\n已停止当前回合并清空待发队列。\n\n[uniagent:terminal=stopped]\n[uniagent:source=stop_uniagent_task]`
      }
    },
    {
      sessionId: 'caller-session', seq: 4, ts: 1_004, type: 'tool_call', state: 'success',
      payload: {
        id: 'terminal-poll', provider: 'mcp', server: 'uniagent', name: 'get_uniagent_task',
        input: { taskId: roleTaskId },
        result: JSON.stringify({ taskId: roleTaskId, status: 'stopped', done: true, latestReply: '已停止', stoppedBy: 'stop_uniagent_task' })
      }
    },
  ],
  handoffSessionTargets: {
    [roleTaskId]: { sessionId: 'target-session', roleName: 'A畜' }
  }
}))
assert.equal((lifecycleMarkup.match(/class="hx"/g) || []).length, 2, '只有强制送达与首次终态应显示交接卡片')
assert.match(lifecycleMarkup, /强制追加/)
assert.match(lifecycleMarkup, /change now/, '强制追加仍保留实际输入摘要')
assert.match(lifecycleMarkup, /由 MCP 中止/)
assert.equal((lifecycleMarkup.match(/process-handoff-end/g) || []).length, 1, '同一 taskId 的终态只显示一次')

// DeepSeek 交接卡回归 — DeepSeek 原生事件把 MCP 工具名记为
// mcp__uniagent__create_uniagent_task；投影必须拆出 provider/server/name，
// 否则运行中的交接只显示链路里的普通工具行，交接卡片永远不出现。
const deepseekHandoffId = '8b604c16-3174-46b0-bf3b-755a0e67a110'
const deepseekHandoffCall = projectDeepSeekNativeEvent({
  seq: 1, time: 1_001, type: 'tool/call',
  data: {
    turn: 1, step: 0, callId: 'ds-handoff', name: 'mcp__uniagent__create_uniagent_task',
    arguments: JSON.stringify({ prompt: '审查方案', wait: true, agent: 'codex' })
  }
}, { sessionId: 'caller-session' })[0]
const deepseekCardMarkup = renderToStaticMarkup(createElement(EventStream, {
  sessionId: 'caller-session',
  status: 'running',
  events: [
    { sessionId: 'caller-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: 'delegate' } },
    { ...deepseekHandoffCall, sessionId: 'caller-session' }
  ],
  waitingForHandoff: {
    handoffId: deepseekHandoffId, awaitedSessionId: 'target-session',
    agentId: 'codex', agentName: 'Codex', label: '审查方案'
  },
  onJumpToSession: () => {}
}))
assert.match(deepseekCardMarkup, /process-handoff/, 'DeepSeek 投影的交接调用必须渲染交接卡片，而不是普通工具行')
assert.match(deepseekCardMarkup, /Codex[\s\S]*派发任务/, '交接卡片应显示目标 Agent 名称和派发动作')
assert.doesNotMatch(deepseekCardMarkup, /已开始/, '不再额外重复已开始状态')
assert.match(deepseekCardMarkup, /等待 Codex 的 审查方案/, '等待行与交接卡片应同时存在')

console.log('hook event stream: ok')
