import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderEventStream } from './regression/render-event-stream.mjs'
import { APP_NAME } from '../src/shared/distribution'

const result = await renderEventStream([], 'idle', 'sidebar-attention-restart', {
  setup: `
    const publicBase = document.createElement('base');
    publicBase.href = ${JSON.stringify(pathToFileURL(resolve('src/renderer/public') + '/').href)};
    document.head.append(publicBase);
    document.body.insertAdjacentHTML('beforeend', '<div id="ua-startup" hidden><div class="cluster"><div class="core"></div><svg class="orbit"><path class="spokes"></path></svg><div class="halo"></div>' +
      ['codex','claude','kimi','deepseek','grok','minimax','zcode'].map(id => '<div data-agent="' + id + '"></div>').join('') +
      '</div><div class="glow"></div><div class="constellation"></div><h1 id="ua-startup-title"></h1><div id="ua-startup-stage"></div><button id="ua-startup-restart"></button></div>');
    const listeners = {};
    const subscribe = name => callback => { listeners[name] = callback; return () => { if (listeners[name] === callback) delete listeners[name]; }; };
    const session = id => ({ id, title: id, status: 'idle', createdAt: 1, config: { agentId: 'codex', workdir: '/fixture', projectId: 'default' } });
    const sessions = ['main', 'side', 'question', 'native', 'status'].map(session);
    const agent = { id: 'codex', name: 'Codex', adapter: 'codex', bin: 'codex', installed: true,
      lifecycle: { availability: 'available' }, capabilities: { permissionModes: [] }, models: [] };
    const runtime = {};
    const historyLoads = [];
    const methods = {
      startupState: async () => ({ ready: true }), teamCatalog: async () => ({ teams: [], projects: [], errors: [] }),
      getLifecycleSnapshot: async () => [agent], getAppSettings: async () => ({}), listSessions: async () => sessions,
      getAssistantPrivateSessions: async () => [], listQueues: async () => ({}), e2eEnabled: async () => false,
      listProjects: async () => [{ id: 'default', name: '默认项目', primaryDirectory: '/fixture', additionalDirectories: [], isDefault: true, createdAt: 1, updatedAt: 1 }],
      listRequirements: async () => [], listPresets: async () => [], getPrefs: async () => ({ lastByAgent: {} }),
      getSessionRuntimeState: async (id, includeEvents = true) => { if (includeEvents) historyLoads.push(id); return { events: runtime[id] || [], hasLiveStreamer: false, nativeSessionOccupancy: { state: 'unknown' } }; },
      archiveSession: async id => { const index = sessions.findIndex(item => item.id === id); return sessions[index] = { ...sessions[index], archived: true }; },
      unarchiveSession: async id => { const index = sessions.findIndex(item => item.id === id); return sessions[index] = { ...sessions[index], archived: false }; },
      onEvent: subscribe('event'), onStatusChange: subscribe('status'), onSideStatus: subscribe('side'),
      onAppNotificationOpenSession: subscribe('open')
    };
    window.uniagent = new Proxy(methods, { get: (target, key) => key in target ? target[key] :
      String(key).startsWith('on') ? () => () => {} : async () => null });
    localStorage.clear();
    window.fixture = { listeners, runtime, historyLoads, session };
    window.appReady = import('./src/renderer/App').then(({ App }) => {
      const node = document.body.appendChild(document.createElement('div'));
      let root;
      window.mountApp = () => { root = createRoot(node); root.render(React.createElement(App)); };
      window.unmountApp = () => root.unmount();
      window.mountApp();
    });
  `,
  inspect: `(async () => {
    const pause = () => new Promise(resolve => setTimeout(resolve, 40));
    const wait = async predicate => { for (let i = 0; i < 80; i++) { if (predicate()) return; await pause(); } throw new Error('sidebar fixture did not settle: ' + document.body.innerHTML.slice(-2000)); };
    await window.appReady;
    await wait(() => document.querySelectorAll('.session-item[data-session-id]').length === 5 && window.fixture.listeners.status);
    const logo = document.querySelector('.sidebar-header .logo');
    const icon = logo.querySelector('img');
    await wait(() => !icon || icon.complete);
    const brand = { text: logo.textContent.trim(), src: icon?.getAttribute('src'),
      loaded: !!icon?.naturalWidth, width: icon?.getBoundingClientRect().width,
      height: icon?.getBoundingClientRect().height, alt: icon?.getAttribute('alt'),
      draggable: icon?.draggable };
    const emitStatus = (id, status, side = false) => window.fixture.listeners[side ? 'side' : 'status']({ sessionId: id, status });
    const emit = event => window.fixture.listeners.event(event);
    const question = id => ({ sessionId: 'question', seq: id === 'q1' ? 1 : 2, ts: id === 'q1' ? 1 : 2, type: 'agent_message', state: 'success', payload: { id, delivery: 'async', questions: [{ id: 'scope', question: '继续吗？' }] } });
    const native = { sessionId: 'native', seq: 1, ts: 1, type: 'approval_request', state: 'pending', payload: { requestId: 'native-q', kind: 'question', params: { questions: [{ id: 'scope', question: '继续吗？' }] } } };
    emitStatus('main', 'running'); emitStatus('side', 'running', true); await pause();
    emitStatus('main', 'completed'); emitStatus('side', 'idle', true); emitStatus('status', 'awaiting-approval'); emit(question('q1')); emit(question('q2')); emit(native);
    const marker = id => document.querySelector('[data-session-id="' + id + '"] .si-ask, [data-session-id="' + id + '"] .si-unread')?.getAttribute('class') || null;
    await wait(() => marker('main') && marker('side') && marker('question') && marker('native') && marker('status'));
    const before = Object.fromEntries(['main','side','question','native','status'].map(id => [id, marker(id)]));
    await pause(); window.unmountApp(); window.mountApp();
    await wait(() => document.querySelectorAll('.session-item[data-session-id]').length === 5 && window.fixture.listeners.event);
    await pause();
    const restored = Object.fromEntries(['main','side','question','native','status'].map(id => [id, marker(id)]));
    emit({ sessionId: 'question', seq: 10, ts: 10, type: 'system_notice', payload: { text: 'unrelated' } }); await pause();
    const afterUnrelated = marker('question');
    window.fixture.runtime.question = [question('q1'), question('q2')];
    document.querySelector('[data-session-id="question"]').click();
    await wait(() => window.fixture.historyLoads.includes('question'));
    await pause();
    const afterOpenQuestion = marker('question');
    emit({ ...question('q1'), payload: { ...question('q1').payload, submittedAnswer: { action: 'skip' } } }); await pause();
    const afterOneAnswer = marker('question');
    emit({ ...question('q2'), payload: { ...question('q2').payload, submittedAnswer: { action: 'skip' } } }); await pause();
    const afterAllAnswers = marker('question');
    window.fixture.runtime.native = [{ ...native, state: 'cancelled', payload: { ...native.payload, interactionExpired: true } }];
    document.querySelector('[data-session-id="native"]').click();
    await wait(() => window.fixture.historyLoads.includes('native') && !marker('native'));
    const afterExpiredQuestion = marker('native');
    document.querySelector('[data-session-id="status"]').click();
    await wait(() => window.fixture.historyLoads.includes('status') && !marker('status'));
    const afterExpiredStatus = marker('status');
    document.querySelector('[data-session-id="main"]').click();
    await wait(() => !marker('main'));
    await pause(); window.unmountApp(); window.mountApp();
    await wait(() => document.querySelectorAll('.session-item[data-session-id]').length === 5);
    await pause();
    const secondRestart = Object.fromEntries(['main','side','question','native','status'].map(id => [id, marker(id)]));
    document.querySelector('[data-session-id="side"] button[aria-label="归档会话"]').click();
    await wait(() => !document.querySelector('[data-session-id="side"]'));
    document.querySelector('.sl-archive-head').click();
    await wait(() => document.querySelector('[data-session-id="side"] button[aria-label="恢复会话"]'));
    document.querySelector('[data-session-id="side"] button[aria-label="恢复会话"]').click();
    await wait(() => document.querySelector('[data-session-id="side"] button[aria-label="归档会话"]'));
    const afterArchiveAndRestore = marker('side');
    window.unmountApp();
    localStorage.setItem('ua.sidebarUnread', '{');
    localStorage.setItem('ua.sidebarPendingInteractions', JSON.stringify({ question: ['request:q', 12], main: ['invalid'], bad: 'invalid' }));
    window.mountApp();
    await wait(() => document.querySelectorAll('.session-item[data-session-id]').length === 5);
    await pause();
    const malformed = Object.fromEntries(['main','side','question','native','status'].map(id => [id, marker(id)]));
    return { brand, before, restored, afterUnrelated, afterOpenQuestion, afterOneAnswer, afterAllAnswers, afterExpiredQuestion, afterExpiredStatus, secondRestart, afterArchiveAndRestore, malformed };
  })()`
})

assert.equal(result.brand.text, APP_NAME, 'the sidebar brand uses the current distribution name with the application icon')
assert.equal(result.brand.src, './app-icon.svg')
assert.equal(result.brand.loaded, true, 'the application icon loads from the renderer public assets')
assert.equal(result.brand.width, 18)
assert.equal(result.brand.height, 18)
assert.equal(result.brand.alt, '', 'the adjacent application name labels the decorative icon')
assert.equal(result.brand.draggable, false, 'the brand image cannot start a drag operation')
assert.equal(readFileSync('src/renderer/public/app-icon.svg', 'utf8'), readFileSync('build/icon.svg', 'utf8'),
  'the sidebar uses the same artwork as the packaged application')
assert.deepEqual(result.before, { main: 'si-unread ', side: 'si-unread side', question: 'si-ask', native: 'si-ask', status: 'si-ask' })
assert.deepEqual(result.restored, result.before, 'unread and pending indicators survive a renderer/app restart')
assert.equal(result.afterUnrelated, 'si-ask', 'an unrelated event cannot erase a restored pending question')
assert.equal(result.afterOpenQuestion, 'si-ask', 'opening an unanswered recoverable question keeps its marker')
assert.equal(result.afterOneAnswer, 'si-ask', 'answering one question leaves another pending question visible')
assert.equal(result.afterAllAnswers, null, 'answering all questions removes the indicator')
assert.equal(result.afterExpiredQuestion, null, 'loading an expired native question clears the stale reminder')
assert.equal(result.afterExpiredStatus, null, 'loading an expired status-only request clears the stale reminder')
assert.deepEqual(result.secondRestart, { main: null, side: 'si-unread side', question: null, native: null, status: null }, 'reading and answering remain cleared after another restart')
assert.equal(result.afterArchiveAndRestore, null, 'archiving and restoring a session does not resurrect unread attention')
assert.deepEqual(result.malformed, { main: null, side: null, question: 'si-ask', native: null, status: null }, 'malformed storage is ignored while valid pending ids remain readable')
console.log('sidebar attention restart: ok')
