// Packaged UI and IPC with isolated native history; no model turns or injected IPC.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isolatedEnvironment } from '../scripts/run-regression.mjs'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/') && binary.endsWith('/Contents/MacOS/UniAgent Public'))
const fixture = await mkdtemp(join(tmpdir(), 'ua-router-history-'))
const env = { ...isolatedEnvironment(fixture), SHELL: '/usr/bin/false', UA_DISABLE_GPU: '1' }
const home = env.HOME, data = env.UNIAGENT_USER_DATA
env.UNIAGENT_CAPABILITY_HOME = home
env.UNIAGENT_CAPABILITY_DATA = join(home, '.uniagent-capability-data')
const output = resolve('out/test-results/router-history-packaged.json')
const archive = join(dirname(dirname(binary)), 'Resources/app.asar')
const digest = async () => createHash('sha256').update(await readFile(archive)).digest('hex')
const report = { mode: 'packaged-ui-and-ipc-with-isolated-Codex-history', startedAt: new Date().toISOString(), packageHash: await digest(), checks: [] }
const routerId = 's_' + randomUUID(), nativeId = randomUUID(), acceptedId = randomUUID(), cancelledId = randomUUID()
let child, socket, sweeper, rpc, stderr = '', cleanupFlight
const pending = new Map()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(probe, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await probe()) return; await delay(100) }
  throw Error(label + ' timed out; ' + stderr.slice(-1500))
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
}
const api = (method, ...args) => evaluate('window.uniagent.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')')
function check(name, value) { assert.ok(value, name); report.checks.push(name); console.log('PASS ' + name) }
async function stop() {
  socket?.close(); socket = undefined
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('verifier stopped')) }
  pending.clear()
  if (sweeper) { await sweeper.sweep(); assert.equal((await sweeper.ownedProcesses()).length, 0) }
  sweeper = undefined; child = undefined
}
const cleanup = () => cleanupFlight ||= (async () => { await stop(); await rm(fixture, { recursive: true, force: true }) })()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })
async function launch() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  sweeper = createAcceptanceProcessSweeper()
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  await sweeper.addRoot(child.pid)
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000) })
  const renderer = join(dirname(dirname(binary)), 'Resources/app.asar.unpacked/out/renderer/index.html')
  let target
  await wait(async () => {
    try { target = (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1000) }).then(r => r.json())).find(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer); return !!target }
    catch { return false }
  }, 'exact packaged renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  socket.onmessage = message => {
    const result = JSON.parse(message.data), entry = pending.get(result.id)
    if (!entry) return
    pending.delete(result.id); clearTimeout(entry.timer)
    result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result)
  }
  rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')) }, 30000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  await wait(() => evaluate('!!window.uniagent && !!document.querySelector(".sidebar") && document.getElementById("ua-startup")?.hidden===true'), 'workbench ready')
}
async function openRouter() {
  await evaluate(`window.__routerFrames=[];window.__routerObserver?.disconnect();window.__routerObserver=new MutationObserver(()=>{
    const view=document.querySelector('.router-list-view');if(!view)return;
    window.__routerFrames.push({cards:view.querySelectorAll('.router-assignment').length,users:view.querySelectorAll('.user-msg').length});
  });window.__routerObserver.observe(document.body,{subtree:true,childList:true});
  [...document.querySelectorAll('button')].find(row=>row.textContent.trim()==='RouterAgent').click()`)
  await wait(() => evaluate(`!!document.querySelector('[data-router-request="${acceptedId}"]') && !!document.querySelector('.router-list-view .user-msg')`), 'native history and accepted assignment')
  check('history is shown before saved cards form the restored transcript', await evaluate('window.__routerFrames.every(frame=>frame.cards===0||frame.users>0)'))
  check('saved cancelled card uses a terminal state', await evaluate(`! /正在判断|正在确定|正在读取候选/.test(document.querySelector('[data-router-request="${cancelledId}"]').textContent)`))
  check('original input and assigned target survive restoration', await evaluate(`document.querySelector('.router-list-view').textContent.includes('历史原始输入') && document.querySelector('[data-router-request="${acceptedId}"]').textContent.includes('历史目标任务')`))
  await evaluate('window.__routerObserver.disconnect()')
}
try {
  await mkdir(join(home, '.codex'), { recursive: true })
  for (const name of ['auth.json', 'models_cache.json']) await copyFile(join(homedir(), '.codex', name), join(home, '.codex', name))
  const now = Date.now(), config = { enabled: false, agentId: 'codex', model: 'gpt-6.1-sol', version: 1 }
  await writeFile(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, enabledAgentIds: ['codex'], router: config, theme: 'dark', autoCheckUpdate: false, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, notificationMode: 'off' }))
  await writeFile(join(data, 'sessions.json'), JSON.stringify([{ id: routerId, title: 'RouterAgent', status: 'idle', nativeSessionId: nativeId, titleLocked: true, createdAt: now, config: { agentId: 'codex', model: config.model, workdir: home, managedPurpose: 'router', permissionMode: 'full-access' } }]))
  const rollout = join(home, '.codex/sessions/2026/11/13')
  await mkdir(rollout, { recursive: true })
  const line = (ms, type, payload) => JSON.stringify({ timestamp: new Date(now + ms).toISOString(), type, payload })
  await writeFile(join(rollout, 'rollout-2026-11-13T00-00-00-' + nativeId + '.jsonl'), [line(0, 'session_meta', { id: nativeId, cwd: home }), line(1, 'event_msg', { type: 'user_message', message: '历史原始输入' }), line(2, 'event_msg', { type: 'task_started', turn_id: 'saved-turn' }), line(3, 'event_msg', { type: 'agent_message', message: '历史分配回复' }), line(4, 'event_msg', { type: 'task_complete', turn_id: 'saved-turn' })].join('\n') + '\n')
  const base = { scope: { kind: 'global' }, config, version: 1, createdAt: now, updatedAt: now }
  const requests = [{ ...base, requestId: cancelledId, prompt: '继续', state: 'cancelled', delivery: 'pending', createdAt: now - 1000 }, { ...base, requestId: acceptedId, routerSessionId: routerId, prompt: '历史原始输入', state: 'bound', delivery: 'finished', targetId: 'saved-task', targetTitle: '历史目标任务', decision: { action: 'reuse_task', taskId: 'saved-task', reason: '继续原任务' } }]
  await mkdir(join(data, 'router'), { recursive: true })
  execFileSync('python3', ['-c', `import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1])
db.executescript('CREATE TABLE router_meta(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE router_requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);')
db.execute('INSERT INTO router_meta VALUES (?,?)',('session',sys.argv[2]))
for r in json.loads(sys.argv[3]): db.execute('INSERT INTO router_requests VALUES (?,?,?,?,?)',(r['requestId'],'fixture',r['version'],r['createdAt'],json.dumps(r)))
db.commit();db.close()`, join(data, 'router/router.sqlite'), routerId, JSON.stringify(requests)], { env })
  await launch()
  const agents = await api('listAgents'), agent = agents.find(row => row.id === 'codex')
  const model = agent?.models.find(row => row.imageInput !== false && (!row.modelSource || row.modelSource.kind === 'native'))
  assert.ok(model, 'an installed Codex image-capable model is required')
  let snapshot = await api('getRouterSnapshot')
  snapshot = await api('saveRouterConfig', { ...snapshot.config, enabled: true, model: model.id, effort: undefined }, snapshot.config.version)
  await openRouter()
  await evaluate(`document.querySelector('[aria-label="配置 RouterAgent"]').click()`)
  await wait(() => evaluate('!!document.querySelector(".settings-panel")'), 'settings page')
  assert.ok(model.efforts.length, 'the model supplies an effort option for the settings return check')
  await api('saveRouterConfig', { ...snapshot.config, effort: model.efforts[0] }, snapshot.config.version)
  await openRouter()
  check('settings return keeps one original input and one accepted card', await evaluate(`document.querySelectorAll('.router-list-view .user-msg').length===1 && document.querySelectorAll('[data-router-request="${acceptedId}"]').length===1`))
  await stop(); await launch(); await openRouter()
  check('real restart retains the same Router Session', (await api('getRouterSnapshot')).sessionId === routerId)
  check('packaged artifact remains unchanged during verification', await digest() === report.packageHash)
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = error.message; throw error }
finally { await cleanup(); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log('Report: ' + output) }
