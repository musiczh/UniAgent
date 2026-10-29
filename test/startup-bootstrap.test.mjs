import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

const startup = main.slice(main.indexOf('app.whenReady().then'))
const ipcRegistration = main.slice(main.indexOf('function registerIpc'))
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

function ipcHandler(name) {
  const channelAt = ipcRegistration.indexOf('IPC.' + name)
  assert.ok(channelAt >= 0, 'missing IPC handler for ' + name)
  const start = ipcRegistration.lastIndexOf('ipcMain.handle', channelAt)
  const next = ipcRegistration.indexOf('ipcMain.handle', channelAt + name.length + 4)
  assert.ok(start >= 0, 'missing handler start for ' + name)
  return ipcRegistration.slice(start, next < 0 ? ipcRegistration.length : next)
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
assert.match(main, /async function awaitAgentReady\(agentId: string\)[\s\S]{0,300}const isProtocolAgent = agentId === 'grok'[\s\S]{0,160}startupProtocolSettled[\s\S]{0,120}startupCoreReady/)
assert.match(main, /if \(isProtocolAgent && !agents\.some\(\(agent\) => agent\.id === agentId\)\)[\s\S]{0,700}await agentLifecycle\.detectAll\(\)[\s\S]{0,200}agent_not_available/)
assert.match(main, /async function awaitSessionAgentReady\(sessionId: string\)[\s\S]{0,180}await awaitSessionHydration\(\)[\s\S]{0,220}session\.config\.agentId/)
assert.match(main, /async function awaitAgentsReady\(agentIds: readonly string\[\]\)[\s\S]{0,220}new Set\(agentIds\)[\s\S]{0,120}awaitAgentReady/)
assert.doesNotMatch(main, /awaitStartupReady|startupAgentDetection/)
const coreJoin = startup.slice(startup.indexOf('startupCoreReady ='), startup.indexOf('const protocolResult'))
assert.match(coreJoin, /startupCoreReady = Promise\.all\(\[startupSessionHydration, coreDetection\]\)/)
assert.match(coreJoin, /resumePendingQueues\(readyCoreIds\)/)
assert.match(startup, /startupProtocolSettled = Promise\.all\(\[startupSessionHydration, protocolResult\]\)[\s\S]{0,900}resumePendingQueues\(readyProtocolIds\)/)
assert.doesNotMatch(coreJoin, /startupProtocolSettled/, 'core readiness must not wait for ACP providers')
assert.ok(startup.includes('Promise.all([startupHandoffReady, startupSessionHydration, startupProtocolSettled])'))
assert.ok(main.includes('function createWindow(onLoaded?: () => void)'))
assert.ok(main.includes("if (onLoaded) window.webContents.once('did-finish-load', onLoaded)"))
assert.ok(startup.includes('createWindow(rendererReadySettled ? undefined : showStartupProgress)'))

for (const name of [
  'dequeue', 'promoteQueueItem', 'interrupt', 'listSessions', 'listQueues',
  'archiveSession', 'unarchiveSession', 'deleteSession', 'renameSession', 'pinSession',
  'respondRequest', 'reviewGetFilePair', 'reviewGetChangeSet'
]) {
  assert.ok(ipcHandler(name).includes('await awaitSessionHydration()'), name + ' must wait for session hydration')
}

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
