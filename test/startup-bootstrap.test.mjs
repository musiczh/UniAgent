import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const orchestrator = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')
const settingsPanel = readFileSync(new URL('../src/renderer/components/SettingsPanel.tsx', import.meta.url), 'utf8')
const newTask = readFileSync(new URL('../src/renderer/components/NewTaskPanel.tsx', import.meta.url), 'utf8')
const env = readFileSync(new URL('../src/main/env.ts', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const startupHtml = readFileSync(new URL('../src/renderer/startup.html', import.meta.url), 'utf8')
const launch = readFileSync(new URL('../src/main/launch.ts', import.meta.url), 'utf8')
const windowFactory = readFileSync(new URL('../src/main/startupWindow.ts', import.meta.url), 'utf8')
const mainAst = ts.createSourceFile('index.ts', main, ts.ScriptTarget.Latest, true)

const startup = main.slice(main.indexOf('app.whenReady().then'))
const createWindowAt = startup.indexOf('createWindow(showStartupProgress)')
const pathHydrationAt = startup.indexOf('await hydratePathFromLoginShell()')
const detectionAt = startup.indexOf('agentLifecycle.detectStartup()')

const refreshAt = main.indexOf('async function refreshDetectedAgents(')
const refreshSource = main.slice(refreshAt, main.indexOf('\n}\n', refreshAt) + 2)
const knownAgents = [{ id: 'codex', models: [], lifecycle: { updateStatus: 'available', availableVersion: '1.2.4' } }]
let availabilityChecks = 0, versionChecks = 0, reconciliations = 0
const refresh = vm.runInNewContext('(' + refreshSource.replace(': Promise<AgentDef[]>', '') + ')', {
  agents: [],
  agentLifecycle: {
    detectAll: async force => { assert.equal(force, true); availabilityChecks++; return knownAgents },
    checkAllUpdates: async () => { versionChecks++; return knownAgents }
  },
  awaitSessionHydration: async () => {}, orchestrator: { reconcileAgentConfigs: () => { reconciliations++ } },
  reconcilePricing: async () => {}, publishHandoffCatalog: () => {}, mainWindow: null
})
assert.equal(await refresh(), knownAgents)
assert.equal(availabilityChecks, 1)
assert.equal(versionChecks, 0, 'availability refreshes must not check every Agent for updates')
assert.equal(reconciliations, 1)
const autoUpdateAt = startup.indexOf('// Auto-update performs')
assert.ok(autoUpdateAt > 0)
assert.doesNotMatch(startup.slice(0, autoUpdateAt), /agentLifecycle\.checkAllUpdates\(/, 'startup must not launch an unconditional Agent update check')
assert.match(startup.slice(autoUpdateAt), /if \(e2eEnabled \|\| !appSettings\.get\(\)\.autoUpdateAgentsOnLaunch\) return[\s\S]{0,100}agentLifecycle\.checkAllUpdates\(/)
// 外部列表的「可更新」结论由后台检查维持：启动就绪后静默执行、按间隔节流、只查版本。
assert.ok(main.includes('new AgentUpdateStatusChecker('), 'the throttled background update-status checker is wired')
const backgroundStatusCheckAt = startup.indexOf('agentUpdateStatusChecker.run()')
assert.ok(backgroundStatusCheckAt > autoUpdateAt, 'the background update-status check starts after the opt-in auto-update flow')
const backgroundReadinessAt = startup.lastIndexOf('startupProtocolSettled.then(', backgroundStatusCheckAt)
assert.ok(backgroundReadinessAt > autoUpdateAt && backgroundReadinessAt < backgroundStatusCheckAt, 'the background update-status check waits for the startup protocol to settle')

let mutationWrapper
function findMutationWrapper(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleUserSessionMutation') mutationWrapper = node.initializer
  ts.forEachChild(node, findMutationWrapper)
}
findMutationWrapper(mainAst)
assert.ok(mutationWrapper, 'user session mutations have a shared guard')

function ipcHandler(name) {
  let handler
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isPropertyAccessExpression(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[0].expression) && node.arguments[0].expression.text === 'IPC' && node.arguments[0].name.text === name &&
        (ts.isIdentifier(node.expression) && node.expression.text === 'handleUserSessionMutation' ||
         ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ipcMain' && node.expression.name.text === 'handle')) handler = node
    ts.forEachChild(node, visit)
  }
  visit(mainAst)
  assert.ok(handler, 'missing IPC handler for ' + name)
  const sharedGuard = ts.isIdentifier(handler.expression) && handler.expression.text === 'handleUserSessionMutation'
    ? mutationWrapper.getText(mainAst) + '\n' : ''
  return sharedGuard + handler.getText(mainAst)
}

assert.ok(createWindowAt >= 0, 'startup must create a BrowserWindow')
assert.ok(windowFactory.includes('show: false'), 'the startup window stays hidden until the small boot document is painted')
assert.ok(launch.indexOf('window.show()') < launch.indexOf("await import('./index')"), 'the window must be visible before loading business modules')
assert.ok(launch.includes("once(window, 'ready-to-show')"), 'first paint belongs to the small boot document')
assert.ok(main.includes('takeStartupWindow() || createAppWindow()'), 'business startup must reuse the first window')
assert.ok(pathHydrationAt > createWindowAt, 'the first window must precede login-shell PATH hydration')
assert.ok(detectionAt > createWindowAt, 'the first window must precede scoped Agent detection')
assert.match(startup, /phase:\s*'detecting'[\s\S]{0,180}正在初始化 Agent/)
assert.ok(startup.includes('agentLifecycle.detectStartup()'))
const supplementalDetection = startup.slice(startup.indexOf('void Promise.allSettled('), startup.indexOf('return detection'))
assert.match(supplementalDetection, /await detection\.core[\s\S]*refreshDetectedAgent\('codex'\)/)
assert.doesNotMatch(supplementalDetection, /refreshDetectedAgents\(/, 'supplemental Codex models must not restart every Agent probe')
assert.ok(main.includes('if (capabilityRecoveryFlight) await capabilityRecoveryFlight'))
assert.match(main, /async function awaitSessionHydration\(\)[\s\S]{0,160}if \(hydration\) await hydration/)
assert.match(main, /async function awaitAgentReady\(agentId: string\)[\s\S]{0,300}const isProtocolAgent = agentId === 'qoder' \|\| agentId === 'grok'[\s\S]{0,180}startupProtocolSettled[\s\S]{0,120}startupCoreReady/)
assert.match(main, /if \(isProtocolAgent && !agents\.some\(\(agent\) => agent\.id === agentId\)\)[\s\S]{0,700}await agentLifecycle\.detectAll\(\)[\s\S]{0,200}agent_not_available/)
assert.match(main, /async function awaitSessionAgentReady\(sessionId: string\)[\s\S]{0,180}await awaitSessionHydration\(\)[\s\S]{0,220}session\.config\.agentId/)
assert.match(main, /async function awaitAgentsReady\(agentIds: readonly string\[\]\)[\s\S]{0,220}new Set\(agentIds\)[\s\S]{0,120}awaitAgentReady/)
assert.doesNotMatch(main, /awaitStartupReady|startupAgentDetection/)
const coreJoin = startup.slice(startup.indexOf('startupCoreReady ='), startup.indexOf('const protocolResult'))
assert.match(coreJoin, /startupCoreReady = Promise\.all\(\[startupSessionHydration, coreDetection\]\)/)
assert.match(coreJoin, /resumePendingQueues\(readyCoreIds\)/)
assert.match(startup, /startupProtocolSettled = Promise\.all\(\[startupSessionHydration, protocolResult\]\)[\s\S]{0,900}resumePendingQueues\(readyProtocolIds\)/)
// Execute the actual readiness expression: later fire-and-forget consumers may
// reference the protocol barrier without making it a core readiness dependency.
let coreExpression, cloudExpression
function findReadiness(node) {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === 'startupCoreReady' &&
      ts.isCallExpression(node.right) && ts.isPropertyAccessExpression(node.right.expression) && node.right.expression.name.text === 'then') coreExpression = node
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then' &&
      node.arguments.length === 1 && ts.isArrowFunction(node.arguments[0]) && ts.isCallExpression(node.arguments[0].body)) {
    const target = node.arguments[0].body.expression
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'cloudMonitor' && target.name.text === 'start') cloudExpression = node
  }
  ts.forEachChild(node, findReadiness)
}
findReadiness(mainAst)
assert.ok(coreExpression, 'core readiness expression exists')
assert.ok(cloudExpression, 'background monitoring is wired to readiness settlement')
const executeReadiness = (node, context) => vm.runInNewContext(ts.transpileModule('(' + node.getText(mainAst) + ')', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText, context)
let readyIds
const coreAgents = [{ id: 'codex', models: [], lifecycle: { availability: 'available' } }, { id: 'grok', models: [], lifecycle: { availability: 'available' } }]
const coreReadiness = executeReadiness(coreExpression, {
  startupCoreReady: undefined, startupSessionHydration: Promise.resolve(), coreDetection: Promise.resolve(coreAgents), startupProtocolSettled: new Promise(() => {}),
  agents: [], agentLifecycle: { snapshot: () => coreAgents }, orchestrator: { migrateLegacyPlanSessions() {}, reconcileAgentConfigs() {}, resumePendingQueues(ids) { readyIds = Array.from(ids) } },
  personalAssistant: { enforceAgentSupport: async () => [] }, assistantFeishuThreads: { remove() {} }, appSettings: { pendingInitializations: () => [] },
  reconcilePricing() {}, publishHandoffCatalog() {}, recordRuntime() {}, mainWindow: null
})
let readinessTimeout
await Promise.race([coreReadiness, new Promise((_, reject) => { readinessTimeout = setTimeout(() => reject(new Error('core readiness waited for unresolved ACP')), 1000) })]).finally(() => clearTimeout(readinessTimeout))
assert.deepEqual(readyIds, ['codex'], 'only available core Agent queues resume before protocol settlement')
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const mutationHydration = deferred()
let registeredMutation, mutations = 0, enabledChecks = 0
const registerMutation = executeReadiness(mutationWrapper, {
  ipcMain: { handle(_channel, listener) { registeredMutation = listener } },
  assertTrustedCapabilitySyncIpc() {}, awaitSessionHydration: () => mutationHydration.promise,
  orchestrator: { getSessionById: () => ({ config: {} }), assertUserSessionEnabled() { enabledChecks++ } }
})
registerMutation('test:mutation', (_event, sessionId) => { mutations++; return sessionId })
await assert.rejects(registeredMutation({}, ''), /invalid_session_id/)
const pendingMutation = registeredMutation({}, 'session-1')
await new Promise(resolve => setImmediate(resolve))
assert.equal(mutations, 0, 'shared mutation guard must await session hydration before the listener')
assert.equal(enabledChecks, 0, 'session checks must use hydrated state')
mutationHydration.resolve()
assert.equal(await pendingMutation, 'session-1')
assert.equal(mutations, 1)
assert.equal(enabledChecks, 1)
const coreBarrier = deferred(), protocolBarrier = deferred(), recoveryBarrier = deferred()
let cloudStarts = 0
const cloudReadiness = executeReadiness(cloudExpression, { startupCoreReady: coreBarrier.promise, startupProtocolSettled: protocolBarrier.promise,
  capabilityRecoveryFlight: recoveryBarrier.promise, cloudMonitor: { start() { cloudStarts++ } } })
coreBarrier.reject(new Error('core recovery failed'))
await new Promise(resolve => setImmediate(resolve))
assert.equal(cloudStarts, 0)
protocolBarrier.resolve()
await new Promise(resolve => setImmediate(resolve))
assert.equal(cloudStarts, 0, 'monitoring waits until all startup recovery has settled')
recoveryBarrier.resolve()
await cloudReadiness
assert.equal(cloudStarts, 1, 'monitoring can report a startup failure after all barriers settle')
assert.ok(startup.includes('Promise.all([startupHandoffReady, startupSessionHydration, startupProtocolSettled])'))
assert.ok(main.includes('function createWindow(onLoaded?: () => void)'))
assert.ok(main.includes("if (onLoaded) window.webContents.once('did-finish-load', onLoaded)"))
assert.ok(startup.includes('createWindow(rendererReadySettled ? undefined : showStartupProgress)'))

for (const name of [
  'dequeue', 'promoteQueueItem', 'interrupt', 'listSessions', 'listQueues',
  'archiveSession', 'unarchiveSession', 'renameSession', 'pinSession',
  'respondRequest', 'reviewGetFilePair', 'reviewGetChangeSet'
]) {
  assert.ok(ipcHandler(name).includes('await awaitSessionHydration()'), name + ' must wait for session hydration')
}

let deletionRegistration
function findDeletionRegistration(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerSessionDeletionIpc') deletionRegistration = node
  ts.forEachChild(node, findDeletionRegistration)
}
findDeletionRegistration(mainAst)
assert.ok(deletionRegistration, 'session deletion IPC is registered')
const hydration = deletionRegistration.arguments[1].properties.find(property => property.name?.getText(mainAst) === 'hydrate')
assert.equal(hydration?.initializer.getText(mainAst), 'awaitSessionHydration', 'delegated deletion uses the startup hydration barrier')
const deletionSource = readFileSync(new URL('../src/main/sessionDeletionIpc.ts', import.meta.url), 'utf8')
const deletionAst = ts.createSourceFile('sessionDeletionIpc.ts', deletionSource, ts.ScriptTarget.Latest, true)
const deletionFunction = deletionAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerSessionDeletionIpc')
assert.ok(deletionFunction)
const deletionCode = ts.transpileModule(deletionFunction.getText(deletionAst).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const deletionIpc = { deleteSession: 'delete', previewSessionDeletion: 'preview', cancelSessionDeletionPreview: 'cancel' }
const registerDeletion = vm.runInNewContext(deletionCode + '\nregisterSessionDeletionIpc', { IPC: deletionIpc, AbortController })
const deletionHandlers = new Map()
let releaseDeletionHydration, deletionCompleted = false, deletionTrusted = false
const deletionBarrier = new Promise(resolve => { releaseDeletionHydration = resolve })
registerDeletion({ handle: (name, handler) => deletionHandlers.set(name, handler) }, {
  assertTrusted: () => { deletionTrusted = true }, hydrate: () => deletionBarrier,
  orchestrator: { assertUserSessionEnabled: () => {}, getSessionById: () => ({ config: {} }), deleteSession: async () => { deletionCompleted = true } },
  teams: { catalog: () => ({ projects: [] }) }, deletingIds: new Set(), changed: () => {}
})
const deletionFlight = deletionHandlers.get(deletionIpc.deleteSession)({}, 'hydrated-session')
await Promise.resolve()
assert.equal(deletionTrusted, true)
assert.equal(deletionCompleted, false, 'deleteSession cannot run before startup hydration')
releaseDeletionHydration()
await deletionFlight
assert.equal(deletionCompleted, true, 'deleteSession resumes once startup hydration finishes')

for (const name of [
  'sendMessage', 'forceSend', 'getEvents', 'getSessionRuntimeState',
  'updateSessionConfig', 'compactSession', 'subagentItems'
]) {
  assert.ok(ipcHandler(name).includes('await awaitSessionAgentReady(sessionId)'), name + ' must wait for its session Agent')
}

for (const name of [
  'checkAgentUpdate', 'updateAgent', 'listAgentHistory',
  'previewHistory', 'importSession', 'forkSameSession'
]) {
  assert.ok(ipcHandler(name).includes('await awaitAgentReady('), name + ' must wait for its explicit Agent')
}
assert.ok(ipcHandler('createSession').includes('return createWorkspaceSession('))
const workspaceCreationStart = main.indexOf('async function createWorkspaceSession(')
const workspaceCreation = main.slice(workspaceCreationStart, main.indexOf('\n}\n', workspaceCreationStart))
assert.match(workspaceCreation, /await awaitAgentReady\(config\.agentId\)[\s\S]*return create\(config\)/,
  'workspace session creation must wait for its explicit Agent before invoking the creation callback')
const updateAgentHandler = ipcHandler('updateAgent')
assert.match(updateAgentHandler, /updateOne\(agentId, \(id\) => orchestrator\.hasActiveAgentSessions\(id\)\)/)
assert.doesNotMatch(updateAgentHandler, /hasAnyActiveSessions/)
assert.match(startup, /updateAll\(ids, \(id\) => orchestrator\.hasActiveAgentSessions\(id\)\)/)
assert.match(settingsPanel, /该 Agent 有会话正在运行，请在其空闲后再更新/)
assert.match(settingsPanel, /role="alertdialog"[\s\S]{0,300}>确认<\/button>/)
assert.ok(ipcHandler('exportNativeSession').includes('await awaitAgentsReady([sourceAgentId, targetAgentId])'))
assert.ok(ipcHandler('forkCrossSession').includes('await awaitAgentsReady([sourceAgentId, targetAgentId])'))
assert.match(
  ipcHandler('compactSession'),
  /assertTrustedCapabilitySyncIpc\(event\)[\s\S]{0,180}invalid_session_id[\s\S]{0,180}await awaitSessionAgentReady\(sessionId\)[\s\S]{0,180}orchestrator\.compactSession\(sessionId\)/
)
assert.match(ipcHandler('getLifecycleSnapshot'), /startupCoreReady[\s\S]{0,100}await core/)
assert.doesNotMatch(
  ipcHandler('getLifecycleSnapshot'),
  /startupProtocolSettled/,
  'the lifecycle snapshot boundary must not wait for ACP providers'
)

assert.match(orchestrator, /resumePendingQueues\([\s\S]{0,180}ReadonlySet<string>[\s\S]{0,240}agentIsReady/)
assert.ok(orchestrator.includes('canResumePendingQueue(session, agentIsReady)'))
const resumePendingQueue = orchestrator.slice(
  orchestrator.indexOf('private resumePendingQueue('),
  orchestrator.indexOf('createSession(', orchestrator.indexOf('private resumePendingQueue('))
)
assert.ok(resumePendingQueue.includes('this.sendTails.set('), 'queue tail must be installed synchronously')

assert.ok(env.includes("import { execFile } from 'node:child_process'"))
assert.doesNotMatch(env, /execFileSync/)
assert.ok(env.includes('export function hydratePathFromLoginShell(): Promise<void>'))
const loginShellTimeout = Number(env.match(/const LOGIN_SHELL_TIMEOUT_MS = (\d+)/)?.[1])
assert.ok(
  loginShellTimeout > 0 && loginShellTimeout <= 6000,
  'login-shell PATH hydration must not hold Agent detection for more than 6 seconds'
)
assert.ok(
  env.includes('timeout: LOGIN_SHELL_TIMEOUT_MS'),
  'login-shell PATH hydration must enforce the bounded startup timeout'
)

assert.ok(app.includes('const [agentsLoading, setAgentsLoading] = useState(true)'))
assert.ok(app.includes('const [sessionsLoading, setSessionsLoading] = useState(true)'))
assert.ok(app.includes('const [sessionsLoadError, setSessionsLoadError] = useState<string | null>(null)'))
assert.match(app, /getLifecycleSnapshot\(\)[\s\S]{0,160}setAgents\(detected\)/)
assert.doesNotMatch(app, /cached\.length \? cached : await window\.uniagent\.detectAgents\(\)/)
const newTaskStart = app.indexOf('<NewTaskPanel')
const newTaskInvocation = app.slice(newTaskStart, app.indexOf('/>', newTaskStart) + 2)
assert.ok(newTaskInvocation.includes('agents={agents}'))
assert.ok(newTaskInvocation.includes('loading={agentsLoading || agentsRedetecting || agentChoiceSettingsLoading || sessionsLoading}'))
assert.ok(newTaskInvocation.includes('loadError={sessionsLoadError}'))
const redetect = app.slice(app.indexOf('async function redetectAgents'), app.indexOf('function handleDequeue'))
assert.doesNotMatch(redetect, /setSessionsLoadError/, 'Agent re-detection must not clear a fatal session hydration error')
assert.match(newTask, /if \(loadError\)[\s\S]{0,320}暂时无法新建任务/)
assert.ok(newTask.includes('if (loading)'))
assert.doesNotMatch(newTask, /loading && agents\.length/)
assert.ok(newTask.includes('正在加载会话并检查本机 Agent'))
assert.ok(html.includes('<!-- uniagent-startup -->'))
assert.match(startupHtml, /id="ua-startup-stage">正在准备界面/)

console.log('startup bootstrap ordering, scoped readiness, and loading UI: ok')
