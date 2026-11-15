import assert from 'node:assert/strict'
import { renderEventStream } from './regression/render-event-stream.mjs'

const result = await renderEventStream([], 'idle', 'task-board-sidebar-attention', {
  setup: `
    import { App } from './src/renderer/App';
    import { projectTaskBoard } from './src/shared/taskBoard';
    import { projectTaskDecisions } from './src/shared/taskDecisions';
    import { sessionAttentionFixture } from './test/regression/session-attention-fixture';
    const listeners = new Map();
    const subscribe = name => cb => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return () => listeners.get(name).delete(cb);
    };
    const emit = (name, value) => { attention.push(name, value); [...(listeners.get(name) || [])].forEach(cb => cb(value)); };
    const sessions = ['a', 'b'].map((id, i) => ({ id, title: '任务 ' + id, status: 'idle', createdAt: i + 1,
      config: { agentId: i === 0 ? 'company-agent' : 'codex', workdir: '/fixture', projectId: 'p', requirementId: 'r' } }));
    const logs = Object.fromEntries(sessions.map(s => [s.id, [{ sessionId: s.id, seq: 1, ts: 1,
      type: 'user_message', state: 'success', payload: { text: '任务描述 ' + s.id } }]]));
    const questions = {
      a: { sessionId: 'a', seq: 2, ts: 2, type: 'approval_request', state: 'pending', payload: {
        requestId: 'native-q', kind: 'question', params: { questions: [{ id: 'scope', question: '选择范围', options: [{ label: '当前范围' }] }] } } },
      b: { sessionId: 'b', seq: 2, ts: 2, type: 'agent_message', state: 'success', payload: {
        id: 'async-q', delivery: 'async', questions: [{ id: 'scope', question: '继续吗', options: [{ label: '继续' }] }] } }
    };
    const attention = sessionAttentionFixture(() => sessions, (id, source) => source === 'main' ? logs[id] || [] : []);
    const decisions = id => projectTaskDecisions(sessions.find(s => s.id === id), logs[id]);
    const runtimeLoads = [], calls = [], deleted = [];
    let fail = true, sessionSnapshotGate;
    const methods = {
      ...attention.methods,
      getWorktreeArchiveReviews: async () => [],
      getSessionAttention: async legacy => { const snapshot = await attention.methods.getSessionAttention(legacy); if (sessionSnapshotGate) await sessionSnapshotGate; return snapshot; },
      startupState: async () => ({ ready: true }), teamCatalog: async () => ({ teams: [], projects: [], errors: [] }),
      getLifecycleSnapshot: async () => ['codex','company-agent'].map(id => ({ id, adapter: 'codex', name: 'Codex', installed: true, lifecycle: { availability: 'available' }, capabilities: { permissionModes: [] }, models: [] })),
      getAppSettings: async () => ({ requirementsEnabled: true, spaceRequirementSidebar: true }),
      listSessions: async () => { const snapshot = structuredClone(sessions); if (sessionSnapshotGate) await sessionSnapshotGate; return snapshot; }, getAssistantPrivateSessions: async () => [], listQueues: async () => ({}),
      listProjects: async () => [{ id: 'p', name: '空间', primaryDirectory: '/fixture', additionalDirectories: [], isDefault: true, createdAt: 1, updatedAt: 1 }],
      listRequirements: async () => [{ id: 'r', name: '需求', projectId: 'p', status: 'active' }],
      listPresets: async () => [], listForkJobs: async () => [], getPrefs: async () => ({ lastByAgent: {} }), e2eEnabled: async () => false,
      getEvents: async id => logs[id], getTaskDecisions: async id => decisions(id),
      getTaskBoard: async query => projectTaskBoard(sessions, decisions, query),
      previewSessionDeletion: async id => ({ confirmationId: 'checked-' + id, title: sessions.find(session => session.id === id).title, team: false, worktrees: [] }),
      deleteSession: async (id, confirmationId) => { if (confirmationId !== 'checked-' + id) throw Error('deletion preview required'); deleted.push(id); attention.badge.removeSession(id); sessions.splice(sessions.findIndex(session => session.id === id), 1); emit('board'); },
      getSessionRuntimeState: async id => { runtimeLoads.push(id); return { events: logs[id], hasLiveStreamer: false, nativeSessionOccupancy: { state: 'unknown' } }; },
      resolveTaskDecision: async (id, input) => {
        calls.push({ id, input });
        if (fail) throw Error('发送失败，保留问题');
        const answered = { ...questions[id], state: 'success', payload: { ...questions[id].payload, submittedAnswer: input.answer } };
        logs[id][1] = answered;
        emit('event', answered);
        if (id === 'a') { sessions[0] = { ...sessions[0], status: 'running' }; emit('status', { sessionId: id, status: 'running' }); }
        emit('board');
      },
      onEvent: subscribe('event'), onStatusChange: subscribe('status'), onSideEvent: subscribe('side'),
      onSideStatus: subscribe('sideStatus'), onSessionCreated: subscribe('created'), onSessionUpdated: subscribe('updated'), onTaskBoardChanged: subscribe('board')
    };
    window.uniagent = new Proxy(methods, { get: (t, k) => k in t ? t[k] : String(k).startsWith('on') ? () => () => {} : async () => null });
    localStorage.clear();
    Object.defineProperty(document, 'hasFocus', { value: () => true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible' });
    const host = document.body.appendChild(document.createElement('div'));
    let root;
    const mount = () => { root = createRoot(host); root.render(React.createElement(App)); };
    mount();
    window.fixture = { host, emit, logs, questions, calls, runtimeLoads, deleted, attention, allow: () => fail = false, restart: (legacy = false) => { root.unmount(); attention.restart(legacy); mount(); }, deferSnapshot: () => { let release; sessionSnapshotGate = new Promise(resolve => release = resolve); return () => { sessionSnapshotGate = undefined; release(); }; }, update: (id, patch) => { const index = sessions.findIndex(s => s.id === id); sessions[index] = { ...sessions[index], ...patch }; emit('updated', { session: sessions[index] }); }, publishSnapshot: session => { sessions.push(session); logs[session.id] = []; emit('updated', { session }); emit('board'); } };
  `,
  inspect: `(async () => {
    const f = window.fixture, tick = () => new Promise(r => setTimeout(r, 30));
    const storedUnread = () => f.attention.badge.snapshot().unreadBySession;
    const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw Error(label + ': ' + f.host.textContent); };
    const requirement = () => f.host.querySelector('.scope-nav-row.requirement');
    const badge = () => { const el = requirement()?.querySelector('.scope-badge'); return el ? { text: el.textContent, waiting: el.classList.contains('waiting') } : null; };
    const boardButton = () => [...f.host.querySelectorAll('.sidebar-nav-item')].find(el => el.textContent.includes('任务看板'));
    const panel = () => [...f.host.querySelectorAll('.task-focus-panel')].find(el => !el.hidden);
    const radio = () => panel()?.querySelector('input[type=radio]');
    const submit = () => panel()?.querySelector('.approval-actions .btn-send');
    await wait(() => requirement() && boardButton() && f.host.querySelector('.new-task'), 'App ready');
    const chooseSidebarView = async value => { f.host.querySelector('[aria-label="切换侧栏视图"]').click();await tick();f.host.querySelector('[data-sidebar-view='+value+']').click();await tick(); };
    await chooseSidebarView('task');const agentAdapterFromApp = !!f.host.querySelector('[data-task-id=a] .agent-icon-codex');await chooseSidebarView('space');
    for (const id of ['a', 'b']) { f.logs[id].push(f.questions[id]); f.emit('event', f.questions[id]); }
    f.emit('status', { sessionId: 'a', status: 'awaiting-approval' });
    await wait(() => badge()?.text === '2', 'both tasks require handling');
    const before = badge();
    boardButton().click();
    await wait(() => radio() && !radio().disabled, 'board native question');
    const boardAgentAdapterFromApp = !!f.host.querySelector('.task-board [data-task-id=a] .task-board-agent .agent-icon-codex');
    radio().click(); submit().click();
    await wait(() => panel()?.textContent.includes('发送失败'), 'failed response');
    const afterFailure = badge(), dockAfterFailure = f.attention.text();
    f.allow(); submit().click();
    await wait(() => panel()?.dataset.focusTaskId === 'b' && radio() && !radio().disabled, 'next async question');
    const afterNative = badge();
    radio().click(); submit().click();
    await wait(() => !f.host.querySelector('.task-focus-queue'), 'all questions resolved');
    const afterAll = badge(), persisted = storedUnread(), dockAfterAll = f.attention.text();
    f.restart();
    await wait(() => requirement() && boardButton(), 'restart'); await tick();
    const afterRestart = badge();
    f.emit('event', { sessionId: 'b', seq: 3, ts: 3, type: 'turn_completed', state: 'success', payload: {} });
    await tick();
    const afterCompletion = badge(), dockAfterCompletion = f.attention.text();
    f.emit('event', f.logs.b[1]); await tick();
    const afterCompletionReplay = badge();
    f.emit('status', { sessionId: 'b', status: 'running' }); await tick();
    const afterBackgroundResume = badge(), resumedPersisted = storedUnread();
    f.emit('status', { sessionId: 'b', status: 'idle' }); await tick();
    f.emit('event', f.logs.b[1]); await tick();
    const afterStatusReplay = badge();
    f.emit('side', { sessionId: 'b', event: { sessionId: 'b', seq: 4, ts: 4, type: 'turn_completed', state: 'success', payload: {} } });
    await tick();
    f.emit('event', f.logs.b[1]); await tick();
    const afterMainAnswerWithSideUnread = badge();
    const icons = () => [...requirement().querySelectorAll('.requirement-count')].map(el => [el.dataset.taskCount, el.textContent.trim()]);
    const reply = { sessionId: 'b', seq: 5, ts: 5, type: 'agent_message', state: 'success', payload: { text: '本轮任务结果' } };
    f.logs.b.push(reply);f.emit('event', reply);
    f.emit('event', { sessionId: 'b', seq: 6, ts: 6, type: 'turn_completed', state: 'success', payload: {} });
    f.update('b', { nativeSessionId: 'native-b', status: 'completed' });await tick();
    const afterReply = icons();
    await chooseSidebarView('task');const sidebarUnreadBeforeOpen=!!f.host.querySelector('.scope-nav-row.task[data-task-id=b] .si-unread');await chooseSidebarView('space');
    requirement().querySelector('.scope-nav-name').click();await tick();
    await wait(() => f.host.querySelector('.requirement-detail [data-task-id=a] .task-board-card-heading'), 'requirement board ready');
    const requirementAgentAdapterFromApp = !!f.host.querySelector('.requirement-detail [data-task-id=a] .task-board-agent .agent-icon-codex');
    const boardUnreadBeforeOpen=!!f.host.querySelector('.requirement-detail [data-task-id=b] .task-board-unread');
    const afterRequirementOpen = icons(), loadsBeforeViewing = [...f.runtimeLoads];
    f.host.querySelector('[data-task-id=b] .task-board-card-open').click();
    await wait(() => !requirement().querySelector('[data-task-count=acceptance]') && f.runtimeLoads.includes('b'), 'view task result');
    const afterReadingResult = icons(), viewedPersisted = storedUnread();
    await chooseSidebarView('task');const sidebarUnreadAfterOpen=!!f.host.querySelector('.scope-nav-row.task[data-task-id=b] .si-unread');await chooseSidebarView('space');
    f.update('b', { status: 'completed' });await tick();const afterSnapshotReplay = icons();
    f.restart();await wait(() => requirement(), 'restart with result');await tick();const restoredResult = icons();
    f.emit('status', { sessionId: 'b', status: 'running' });await tick();const afterNewInput = icons();
    f.update('b', { status: 'completed' });await tick();const afterSnapshotCompletion = icons();
    f.update('b', { status: 'completed', taskState: { phase: 'standby', version: 1, updatedAt: 1, awaitingAcceptance: false } });await tick();const afterDeferral = icons();
    f.update('a', { status: 'completed', archived: true });await tick();const afterArchive = icons();
    const result = { agentAdapterFromApp, boardAgentAdapterFromApp, requirementAgentAdapterFromApp, sidebarUnreadBeforeOpen, boardUnreadBeforeOpen, sidebarUnreadAfterOpen, before, afterFailure, dockAfterFailure, afterNative, afterAll, dockAfterAll, afterRestart, persisted, afterCompletion, dockAfterCompletion, afterCompletionReplay, afterBackgroundResume, resumedPersisted, afterStatusReplay, afterMainAnswerWithSideUnread, afterReply, afterRequirementOpen, loadsBeforeViewing, afterReadingResult, afterSnapshotReplay, viewedPersisted, restoredResult, afterNewInput, afterSnapshotCompletion, afterDeferral, afterArchive, runtimeLoads: [...f.runtimeLoads], calls: f.calls.map(c => c.id) };
    f.update('a', { status: 'running', archived: false });localStorage.setItem('ua.sidebarUnread', '{}');f.restart(true);
    await wait(() => requirement(), 'restore active task');await tick();
    f.update('a', { status: 'completed' });await tick();
    const restoredActiveCompletion = icons();
    const attention = () => ({ badge: badge(), icons: icons() });
    let sequence = 20;
    const event = (type, payload = {}, state) => ({ sessionId: 'a', seq: ++sequence, ts: sequence, type, payload, state });
    const input = (type, source) => event(type, { text: '继续原任务', source });
    f.emit('event', event('user_message', { text: '自动恢复', automaticRecovery: 'retry' }));await tick();
    const afterRecoveryInput = attention();
    f.emit('event', event('goal_message', { text: '内部输入', hidden: true }));await tick();const afterHiddenInput = attention();
    f.emit('event', input('user_message', 'feishu'));await tick();
    const afterChannelInput = attention(), channelPersisted = storedUnread();
    f.emit('side', { event: event('turn_completed', {}, 'success') });await tick();
    f.emit('event', input('goal_message', 'mcp'));await tick();const afterMainInputWithSideUnread = badge();
    f.emit('side', { event: input('user_message', 'app') });await tick();const afterSideInput = badge();
    f.emit('event', event('turn_completed', {}, 'success'));await tick();
    f.emit('sideStatus', { sessionId: 'a', status: 'running' });await tick();const afterSideResumeWithMainUnread = attention();
    f.emit('event', input('goal_message', 'mcp'));await tick();const afterGoalInput = attention();
    f.emit('side', { event: event('turn_completed', {}, 'success') });await tick();
    f.emit('sideStatus', { sessionId: 'a', status: 'idle' });await tick();
    f.emit('sideStatus', { sessionId: 'a', status: 'running' });await tick();const afterSideResume = badge();
    f.emit('created', { id:'c',title:'后台新任务',status:'running',createdAt:30,config:{agentId:'codex',projectId:'p',requirementId:'r'} });await tick();
    const afterBackgroundCreation = attention();
    f.update('a', { status: 'running' });f.update('b', { status: 'running' });await tick();
    localStorage.setItem('ua.sidebarUnread', JSON.stringify({a:'main',b:'side'}));f.restart(true);
    await wait(() => requirement(), 'restore stale running marker');await tick();
    const restoredRunning = attention(), restoredRunningPersisted = storedUnread();
    const restoredQuestionEvent = { sessionId:'a',seq:90,ts:90,type:'agent_message',state:'success',payload:{id:'new-question',delivery:'async',questions:[{id:'q',question:'继续吗？'}]} };
    f.logs.a.push(restoredQuestionEvent);
    localStorage.setItem('ua.sidebarUnread', JSON.stringify({a:'main'}));
    localStorage.setItem('ua.sidebarPendingInteractions', JSON.stringify({a:['request:async-question:new-question']}));f.restart(true);
    await wait(() => requirement(), 'restore unanswered question');await tick();
    const restoredQuestion = badge(), restoredQuestionPersisted = storedUnread();
    restoredQuestionEvent.payload.submittedAnswer = '继续';f.emit('event', restoredQuestionEvent);
    localStorage.setItem('ua.sidebarUnread','{}');localStorage.setItem('ua.sidebarPendingInteractions','{}');
    const releaseSnapshot = f.deferSnapshot();f.restart(true);await wait(() => requirement(), 'delayed startup snapshot');
    f.emit('event', { sessionId:'a',seq:100,ts:100,type:'agent_message',state:'success',payload:{id:'live-q',delivery:'async',questions:[{id:'q',question:'继续吗？'}]} });await tick();
    releaseSnapshot();await wait(() => icons().some(([kind]) => kind === 'running'), 'startup snapshot delivered');await tick();
    const freshQuestion = badge(), freshQuestionPersisted = storedUnread();
    f.emit('event', { sessionId:'a',seq:100,ts:100,type:'agent_message',state:'success',payload:{id:'live-q',delivery:'async',questions:[{id:'q',question:'继续吗？'}],submittedAnswer:'继续'} });
    f.update('a', { status:'running' });
    f.emit('side', { event:{sessionId:'b',seq:101,ts:101,type:'user_message',payload:{text:'已读侧边回复'}} });
    f.update('b', { status:'completed',taskState:{phase:'active',version:2,updatedAt:101,awaitingAcceptance:false} });await tick();
    f.emit('event', {sessionId:'b',seq:101,ts:101,type:'turn_completed',state:'success',payload:{}});await tick();
    const beforeSnapshotResume = attention();
    f.update('b', { status:'running' });await tick();
    const afterSnapshotResume = attention(), snapshotResumePersisted = storedUnread();
    boardButton().click();f.emit('board');
    await wait(() => f.host.querySelector('[data-column=active] [data-task-id=b]'), 'resumed task on board');
    const dot = id => { const el=f.host.querySelector('[data-task-id='+id+'] .task-board-unread');return el ? {label:el.getAttribute('aria-label'),color:getComputedStyle(el).backgroundColor}:null; };
    const cleanRunningCard = dot('b');
    f.emit('side', {event:{sessionId:'b',seq:102,ts:102,type:'turn_completed',state:'success',payload:{}}});await tick();
    const runningSideReply = {attention:attention(),dot:dot('b'),other:dot('a')};
    f.emit('event', {sessionId:'b',seq:103,ts:103,type:'user_message',payload:{text:'继续主任务',source:'feishu'}});await tick();
    f.update('b', {status:'running'});await tick();const afterMainContinue = {attention:attention(),dot:dot('b')};
    f.emit('side', {event:{sessionId:'b',seq:104,ts:104,type:'user_message',payload:{text:'继续侧边对话'}}});await tick();
    const afterSideContinue = {attention:attention(),dot:dot('b')};
    f.update('b', {status:'completed'});await tick();
    f.emit('event', {sessionId:'b',seq:105,ts:105,type:'agent_message',state:'success',payload:{id:'resume-q',delivery:'async',questions:[{id:'q',question:'请选择范围'}]}});await tick();
    f.update('b', {status:'running'});await tick();
    const pendingQuestionAfterResume = {badge:badge(),dot:dot('b')};
    f.update('a', {archived:true});f.update('b', {archived:true});await tick();
    const routed = {id:'routed',title:'RouterAgent 创建的任务',status:'queued',createdAt:200,config:{agentId:'codex',workdir:'/fixture',projectId:'p',requirementId:'r'}};
    f.publishSnapshot(routed);
    await wait(() => f.host.querySelector('[data-task-id=routed] .si-spinner'), 'routed task on board');await tick();
    const routedQueued = attention(), stayedOnBoard = !!f.host.querySelector('.task-board-workspace');
    f.update('routed', {status:'running'});await tick();const routedRunning = attention();
    f.update('routed', {status:'running'});f.emit('created', {...routed,status:'running'});await tick();const routedRepeated = attention();
    f.update('routed', {status:'completed'});await tick();const routedCompleted = attention();
    f.update('routed', {archived:true});await tick();const routedArchived = attention();
    f.update('routed', {archived:false});
    f.emit('side', {event:{sessionId:'routed',seq:201,ts:201,type:'turn_completed',state:'success',payload:{}}});await tick();
    requirement().querySelector('.scope-nav-name').click();
    await wait(() => f.host.querySelector('.requirement-detail [data-task-id=routed] [data-action=delete]'), 'requirement delete entry');
    window.confirm = () => true;
    f.host.querySelector('[data-task-id=routed] [data-action=delete]').click();
    await wait(() => document.querySelector('[data-confirm-delete]'), 'deletion confirmation');
    document.querySelector('[data-confirm-delete]').click();
    await wait(() => f.deleted.length === 1 && !f.host.querySelector('[data-task-id=routed]'), 'task deleted from requirement board');await tick();
    const deletion = { ids:f.deleted, attention:attention(), unread:storedUnread().routed ?? null };
    return { ...result, restoredActiveCompletion, afterRecoveryInput, afterHiddenInput, afterChannelInput, channelPersisted, afterMainInputWithSideUnread, afterSideInput, afterSideResumeWithMainUnread, afterGoalInput, afterSideResume, afterBackgroundCreation, restoredRunning, restoredRunningPersisted, restoredQuestion, restoredQuestionPersisted, freshQuestion, freshQuestionPersisted, beforeSnapshotResume, afterSnapshotResume, snapshotResumePersisted, cleanRunningCard, runningSideReply, afterMainContinue, afterSideContinue, pendingQuestionAfterResume, routedQueued, stayedOnBoard, routedRunning, routedRepeated, routedCompleted, routedArchived, deletion };
  })()`
})

assert.deepEqual(result.before, { text: '2', waiting: true })
assert.equal(result.agentAdapterFromApp, true, 'App passes custom Agent adapters through navigation to task row icons')
assert.equal(result.boardAgentAdapterFromApp, true, 'App passes custom Agent adapters to global board cards')
assert.equal(result.requirementAgentAdapterFromApp, true, 'App passes custom Agent adapters to requirement board cards')
assert.equal(result.sidebarUnreadBeforeOpen, true, 'a new reply appears in the task sidebar')
assert.equal(result.boardUnreadBeforeOpen, true, 'the same unread reply appears on the requirement board')
assert.equal(result.sidebarUnreadAfterOpen, false, 'opening the board task clears the shared sidebar unread state')
assert.deepEqual(result.deletion, { ids:['routed'], attention:{badge:null,icons:[]}, unread:null }, 'App deletion clears task records, requirement counts and persisted unread state together')
assert.deepEqual(result.afterFailure, result.before, 'failed answers retain both reminders')
assert.equal(result.dockAfterFailure, '2', 'failed submission keeps the same two sessions in the Dock and sidebar')
assert.deepEqual(result.afterNative, { text: '1', waiting: true }, 'another task still needs an answer')
assert.equal(result.afterAll, null, 'answering from the board clears the requirement badge without opening a task')
assert.equal(result.dockAfterAll, '', 'the same accepted answers also clear the Dock without opening the tasks')
assert.deepEqual(result.persisted, {}, 'answered task unread markers are cleared in storage')
assert.equal(result.afterRestart, null, 'answered reminders stay cleared after remount')
assert.deepEqual(result.afterCompletion, { text: '1', waiting: false }, 'new results still produce unread progress')
assert.equal(result.dockAfterCompletion, '1', 'a real new result returns one unread session everywhere')
assert.deepEqual(result.afterCompletionReplay, result.afterCompletion, 'replayed answers cannot erase later completion events')
assert.equal(result.afterBackgroundResume, null, 'background execution clears the old result without opening the task')
assert.equal(result.resumedPersisted.b, undefined, 'resuming execution also clears the persisted old result')
assert.deepEqual(result.afterStatusReplay, result.afterCompletion, 'replayed answers cannot erase later status-only completion')
assert.deepEqual(result.afterMainAnswerWithSideUnread, result.afterCompletion, 'handling a main question preserves unread side progress')
assert.deepEqual(result.afterReply, [['running', '1'], ['acceptance', '1']], 'App snapshot updates show a normally answered task alongside running work')
assert.deepEqual(result.afterRequirementOpen, result.afterReply, 'opening a requirement does not mark its task results viewed')
assert.deepEqual(result.afterReadingResult, [['running', '1']], 'opening the task result clears only its orange reminder')
assert.equal(result.viewedPersisted.b, undefined, 'the viewed result marker is removed from persistent sidebar state')
assert.deepEqual(result.afterSnapshotReplay, result.afterReadingResult, 'replayed terminal snapshots cannot recreate a viewed result reminder')
assert.deepEqual(result.restoredResult, result.afterReadingResult, 'viewed results stay cleared after remount')
assert.deepEqual(result.afterNewInput, [['running', '2']], 'App status events resume the same task and remove the old result count')
assert.deepEqual(result.afterSnapshotCompletion, result.afterReply, 'terminal snapshots repair missed status pushes and mark a new unviewed result')
assert.deepEqual(result.restoredActiveCompletion, [['acceptance', '1']], 'restored running sessions also receive unread results without a prior live status event')
assert.deepEqual(result.afterRecoveryInput, { badge: null, icons: result.restoredActiveCompletion }, 'automatic recovery input does not read a user result')
assert.deepEqual(result.afterHiddenInput, result.afterRecoveryInput, 'internal hidden input does not read a user result')
assert.deepEqual(result.afterChannelInput, { badge: null, icons: [] }, 'accepted channel input clears the old result without navigating into the task')
assert.equal(result.channelPersisted.a, undefined, 'channel input clears the persisted old result')
assert.deepEqual(result.afterMainInputWithSideUnread, { text: '1', waiting: false }, 'main input preserves unread side progress')
assert.equal(result.afterSideInput, null, 'accepted side input clears its own unread reply')
assert.deepEqual(result.afterSideResumeWithMainUnread, result.afterRecoveryInput, 'side execution preserves unread main results')
assert.deepEqual(result.afterGoalInput, { badge: null, icons: [] }, 'accepted goal input clears its own unread result')
assert.equal(result.afterSideResume, null, 'resuming side execution clears its old unread reply')
assert.deepEqual(result.afterBackgroundCreation, { badge: null, icons: [['running','1']] }, 'a newly running background task does not fabricate an unread reply')
assert.deepEqual(result.restoredRunning, { badge: { text: '1', waiting: false }, icons: [['running', '2']] }, 'restoring running tasks clears stale main results while keeping side progress')
assert.deepEqual(result.restoredRunningPersisted, { b: 'side' }, 'restored stale main markers are removed from storage')
assert.deepEqual(result.restoredQuestion, { text: '1', waiting: true }, 'restoration preserves an unanswered async question during execution')
assert.deepEqual(result.restoredQuestionPersisted, { a: 'main' }, 'restoration keeps the unread marker for a real pending question')
assert.deepEqual(result.freshQuestion, { text: '1', waiting: true }, 'a live question that arrives during startup is not mistaken for a stale result')
assert.deepEqual(result.freshQuestionPersisted, { a: 'main' }, 'startup reconciliation preserves newly pushed attention in storage')
assert.deepEqual(result.afterDeferral, [['running', '1']], 'user deferral snapshots remove the acceptance counter')
assert.deepEqual(result.afterArchive, [], 'archiving the remaining running task removes its counter')
assert.deepEqual(result.loadsBeforeViewing, [], 'board answers and requirement browsing do not hydrate tasks')
assert.deepEqual(result.runtimeLoads, ['b', 'b'], 'viewing and remounting restore the same original task')
assert.deepEqual(result.calls, ['a', 'a', 'b'])
assert.deepEqual(result.beforeSnapshotResume, {badge:null,icons:[['running','1'],['acceptance','1']]}, 'the previous result is initially unread')
assert.deepEqual(result.afterSnapshotResume, {badge:null,icons:[['running','2']]}, 'a running snapshot repairs a missed status push and clears the old result')
assert.equal(result.snapshotResumePersisted.b, undefined, 'snapshot resume also clears the persisted unread result')
assert.equal(result.cleanRunningCard, null, 'ordinary ongoing work has no unread dot')
assert.deepEqual(result.runningSideReply, {attention:{badge:{text:'1',waiting:false},icons:[['running','2']]},dot:{label:'侧边对话有新回复',color:'rgb(91, 157, 255)'},other:null}, 'the requirement unread count identifies the running task with a blue side reply dot')
assert.deepEqual(result.afterMainContinue, {attention:result.runningSideReply.attention,dot:result.runningSideReply.dot}, 'continuing the main task preserves a real unread side reply')
assert.deepEqual(result.afterSideContinue, {attention:result.afterSnapshotResume,dot:null}, 'continuing the side conversation clears its count and card dot together')
assert.deepEqual(result.pendingQuestionAfterResume, {badge:{text:'1',waiting:true},dot:{label:'有新回复',color:'rgb(91, 157, 255)'}}, 'a fresh unanswered question is preserved when a running snapshot repairs a missed status push')
assert.deepEqual(result.routedQueued, {badge:null,icons:[['running','1']]}, 'a RouterAgent task first delivered as a queued snapshot contributes to sidebar execution without a creation push')
assert.equal(result.stayedOnBoard, true, 'discovering a background task keeps the current board open')
assert.deepEqual(result.routedRunning, result.routedQueued, 'the same snapshot-discovered task remains visible while running')
assert.deepEqual(result.routedRepeated, result.routedRunning, 'repeated snapshots and a late creation push do not count the task twice')
assert.deepEqual(result.routedCompleted, {badge:null,icons:[['acceptance','1']]}, 'completion of the discovered task replaces execution with the unread result reminder')
assert.deepEqual(result.routedArchived, {badge:null,icons:[]}, 'archiving the discovered task removes its sidebar indicators')
console.log('PASS task board answers clear sidebar reminders; failed answers, other pending tasks, persistence and later unread progress remain correct')
