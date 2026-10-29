import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'sidebar-assistant-sessions', {
  setup: `
    import {SessionList} from './src/renderer/components/SessionList';
    const assistantSnapshot = { assistantId: 'personal', soul: '', soulRevision: 1, workingRules: '', workingRulesRevision: 1 };
    const session = (id, extra = {}, config = {}) => ({
      id, title: id, status: 'idle', createdAt: 1,
      config: { agentId: 'codex', workdir: '/work', projectId: 'work', ...config }, ...extra
    });
    const assistant = (id, extra = {}, config = {}) => session(id, extra, {
      assistantSnapshot, projectId: 'default', requirementId: 'req', ...config
    });
    window.sidebarSessions = [
      assistant('assistant-feishu', { pinned: true }, { agentId: 'claude' }),
      session('pinned-normal', { pinned: true }),
      assistant('assistant-weixin', {}, { assistantChannel: 'weixin' }),
      assistant('assistant-local'),
      session('normal', {}, { requirementId: 'req' }),
      assistant('downstream-task', { handoffId: 'handoff', handoffUserContinued: true }, { projectId: 'work', requirementId: undefined }),
      assistant('assistant-archived', { archived: true }),
      session('normal-archived', { archived: true }),
      assistant('assistant-unavailable', {}, { agentId: 'missing' }),
      assistant('assistant-readonly', { readOnly: true })
    ];
    window.uniagent = {
      listProjects: async () => [
        { id: 'default', name: '默认项目', primaryDirectory: '/default', additionalDirectories: [], isDefault: true, createdAt: 1, updatedAt: 1 },
        { id: 'work', name: '工作空间', primaryDirectory: '/work', additionalDirectories: [], createdAt: 1, updatedAt: 1 }
      ],
      listRequirements: async () => [{ id: 'req', name: '需求一', dir: '/req', docPath: '/req/context.md', status: 'active', createdAt: 1, updatedAt: 1 }],
      onRequirementsChanged: () => () => {}
    };
    const noop = () => {};
    function Harness() {
      const [sessions, setSessions] = React.useState(window.sidebarSessions);
      window.setSidebarSessions = setSessions;
      return React.createElement(SessionList, {
        requirementsEnabled: true,
        sessions, assistantPrivateSessionIds: ['assistant-feishu', 'assistant-weixin'],
        agents: ['codex', 'claude'].map(id => ({ id, name: id, adapter: id, lifecycle: { availability: 'available' } })),
        activeId: 'assistant-weixin', statusBySession: {}, unreadBySession: { 'assistant-local': 'main' },
        onSelect: id => { window.selectedSession = id; }, onArchive: noop, onUnarchive: noop, onDelete: noop,
        onArchiveMany: noop, onDeleteMany: noop, onRename: noop, onPin: noop
      });
    }
    createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(Harness));
  `,
  inspect: `(async () => {
    const settle = () => new Promise(resolve => setTimeout(resolve, 25));
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 80; attempt++) { if (predicate()) return; await settle(); }
      throw new Error('sidebar state did not settle: ' + document.querySelector('.session-list')?.outerHTML);
    };
    const names = () => [...document.querySelectorAll('.sl-body .sl-group-name')].map(node => node.textContent);
    const assistantHead = () => [...document.querySelectorAll('.sl-group-head')]
      .find(node => node.querySelector('.sl-group-name')?.textContent === '助手session');
    const snapshot = () => ({
      expanded: assistantHead()?.getAttribute('aria-expanded') ?? null,
      assistantCount: assistantHead()?.querySelector('.sl-group-count')?.textContent ?? null,
      groups: names(),
      counts: [...document.querySelectorAll('.sl-body .sl-group-head')].map(node => [
        node.querySelector('.sl-group-name')?.textContent,
        node.querySelector('.sl-group-count')?.textContent
      ]),
      rows: [...document.querySelectorAll('.session-list .session-item[data-session-id]')].map(node => node.dataset.sessionId),
      archiveCount: document.querySelector('.sl-drawer-heads .sl-archive-head .sl-group-count')?.textContent ?? null,
      firstGroup: document.querySelector('.sl-body > .sl-group .sl-group-name')?.textContent ?? null
    });
    const switchView = async view => {
      document.querySelector('.sl-seg [data-view="' + view + '"]').click();
      await waitFor(() => document.querySelector('.sl-seg .is-on')?.dataset.view === view);
    };
    await waitFor(() => document.querySelector('.session-list'));
    const initial = snapshot();
    if (!assistantHead()) return { initial, missingAssistantGroup: true };
    assistantHead().click();
    await waitFor(() => assistantHead()?.getAttribute('aria-expanded') === 'true');
    const expanded = snapshot();
    const badges = [...assistantHead().parentElement.querySelectorAll('.si-tag-feishu')].map(node => node.textContent);
    document.querySelector('[data-session-id="assistant-weixin"]').click();
    const selected = window.selectedSession;
    assistantHead().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await waitFor(() => assistantHead()?.getAttribute('aria-expanded') === 'false');
    const keyboardCollapsed = snapshot();
    assistantHead().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => assistantHead()?.getAttribute('aria-expanded') === 'true');
    const keyboardExpanded = snapshot();
    document.querySelector('.sl-drawer-heads .sl-archive-head').click();
    await waitFor(() => document.querySelector('[data-session-id="assistant-archived"]'));
    const allArchived = snapshot();
    await switchView('byAgent');
    const byAgent = snapshot();
    await switchView('byProject');
    await waitFor(() => names().includes('工作空间'));
    const byProject = snapshot();
    await switchView('byRequirement');
    await waitFor(() => names().includes('需求一'));
    const byRequirement = snapshot();
    await switchView('all');
    const returned = snapshot();
    window.setSidebarSessions(window.sidebarSessions.filter(session => session.id === 'assistant-local'));
    await waitFor(() => assistantHead()?.querySelector('.sl-group-count')?.textContent === '1');
    const assistantOnly = { ...snapshot(), empty: !!document.querySelector('.sl-empty') };
    await switchView('byProject');
    const categoryEmpty = { ...snapshot(), empty: document.querySelector('.sl-empty')?.textContent };
    window.setSidebarSessions([]);
    await switchView('all');
    const noSessions = { ...snapshot(), empty: document.querySelector('.sl-empty')?.textContent };
    return { initial, expanded, badges, selected, keyboardCollapsed, keyboardExpanded,
      allArchived, byAgent, byProject, byRequirement, returned, assistantOnly, categoryEmpty, noSessions };
  })()`
})

assert.equal(result.initial.assistantCount, '3', 'the group includes local and historical assistant sessions, not only channel bindings')
assert.equal(result.initial.expanded, 'false', 'assistant sessions start collapsed even when active or unread')
assert.equal(result.initial.firstGroup, '助手session', 'the fixed assistant group precedes ordinary pinned sessions')
assert.deepEqual(result.initial.rows, ['pinned-normal', 'normal', 'downstream-task'], 'assistant rows are hidden while regular tasks remain visible')
assert.deepEqual(result.expanded.rows, ['assistant-feishu', 'assistant-weixin', 'assistant-local', 'pinned-normal', 'normal', 'downstream-task'],
  'expansion shows assistants once, including pinned assistants, without moving downstream tasks into the group')
assert.deepEqual(result.expanded.counts, [['助手session', '3'], ['置顶', '1']])
assert.deepEqual(result.badges, ['飞书', '微信'], 'channel badges retain their existing binding behavior')
assert.equal(result.selected, 'assistant-weixin', 'assistant rows still select their session')
assert.equal(result.keyboardCollapsed.expanded, 'false', 'Space collapses the group')
assert.deepEqual(result.keyboardCollapsed.rows, result.initial.rows)
assert.equal(result.keyboardExpanded.expanded, 'true', 'Enter expands the group')
assert.equal(result.initial.archiveCount, '2', 'all retains the existing archive drawer for assistant and regular sessions')
assert.ok(result.allArchived.rows.includes('assistant-archived'), 'archived assistants remain accessible in all')
for (const view of ['byAgent', 'byProject', 'byRequirement'] as const) {
  assert.equal(result[view].expanded, null, view + ' has no assistant group')
  assert.ok(!result[view].rows.some((id: string) => id.startsWith('assistant-')), view + ' excludes active, pinned and archived assistant sessions')
  assert.equal(result[view].archiveCount, '1', view + ' only counts ordinary archived sessions')
  assert.ok(result[view].rows.includes('normal') && result[view].rows.includes('downstream-task'), view + ' preserves ordinary and downstream tasks')
}
assert.deepEqual(result.byAgent.counts, [['置顶', '1'], ['codex', '2']], 'assistant-only Agent groups disappear and counts exclude assistants')
assert.deepEqual(result.byProject.counts, [['置顶', '1'], ['工作空间', '2']], 'the assistant-only default project disappears')
assert.deepEqual(result.byRequirement.counts, [['需求一', '1'], ['未归入需求', '2']], 'requirement and unassigned counts exclude assistants')
assert.equal(result.returned.expanded, 'true', 'switching views preserves the user-selected expansion state')
assert.equal(result.assistantOnly.assistantCount, '1')
assert.equal(result.assistantOnly.empty, false, 'an assistant-only all view is not empty')
assert.equal(result.categoryEmpty.empty, '还没有会话分组')
assert.equal(result.noSessions.assistantCount, null, 'the assistant group disappears when no assistant sessions remain')
assert.equal(result.noSessions.empty, '还没有会话，点击 ＋ 新建任务')
console.log('sidebar assistant sessions: ok')
