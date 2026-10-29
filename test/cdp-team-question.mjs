import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/') && binary.endsWith('.app/Contents/MacOS/UniAgent Public'))
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-question-cdp-'))
const home = join(fixture, 'home'), userData = join(fixture, 'data')
const output = resolve('out/test/team-question-' + Date.now())
const sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
let child, socket, evaluate, stderr = '', cleanupPromise, forceCleanup = false
const cleanup = () => cleanupPromise ||= (async () => {
  socket?.close()
  try { await sweeper.sweep({ shouldAbort: () => forceCleanup }) }
  finally { if (forceCleanup) await sweeper.forceSweep(); await rm(fixture, { recursive: true, force: true }) }
})()
const termination = createAcceptanceTerminationHandler({ cleanup, requestForceCleanup: () => { forceCleanup = true }, exit: code => process.exit(code) })
process.on('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.on('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function poll(callback, accept, label) {
  const deadline = Date.now() + 30000
  let value
  while (Date.now() < deadline) { value = await callback(); if (accept(value)) return value; await delay(200) }
  throw new Error(label + ': timeout; last=' + JSON.stringify(value))
}
async function put(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }

try {
  await Promise.all([home, userData, output].map(path => mkdir(path, { recursive: true })))
  const now = Date.now() - 10000
  const nativeId = '00000000-0000-4000-8000-000000000042'
  const team = { id: 'team_question', revision: 1, name: 'Question fixture', description: '', rules: '等待回答后继续', leaderMemberId: 'leader', members: ['leader', 'worker'].map(id => ({ id, role: { id: 'role-' + id, name: id, agentId: 'codex', permissionMode: 'read-only' } })), limits: { concurrency: 1, maxAssignments: 12, taskMinutes: 20, runMinutes: 60 }, status: 'active', createdAt: now, updatedAt: now }
  const question = { id: 'question', revision: 1, kind: 'leader_question', runId: 1, memberId: 'leader', sessionId: 's-question-leader', requestId: 'question-request', state: 'pending', createdAt: now + 3000, decision: { title: '确认执行范围', purpose: 'information', questions: [{ id: 'scope', question: '继续分析哪个模块？', type: 'text', required: true }], materials: [] } }
  const project = { id: 'tp_question', revision: 1, name: '专家团阻塞提问验收', goal: '确认后继续', spaceId: 'default', spaceRoots: [home], teamId: team.id, team, memberSessions: { leader: 's-question-leader', worker: 's-question-worker' }, runId: 1, status: 'waiting_user', phase: '确认执行范围', summary: '', sharedContext: { brief: '', decisions: [], openQuestions: [] }, assignments: [{ id: 'task', runId: 1, memberId: 'worker', requestId: 'task-request', requestFingerprint: 'fixture', title: '成员后台执行', prompt: '只读分析', contextRefs: [], artifactRefs: [], status: 'succeeded', attempt: 1, history: [], summary: 'LATE_MEMBER_DELIVERY', result: 'LATE_MEMBER_DELIVERY', createdAt: now + 2000, dispatchedAt: now + 2000, endedAt: now + 4000, activeMs: 2000 }], inbox: [{ eventId: 'result', seq: 1, runId: 1, kind: 'result', summary: 'LATE_MEMBER_DELIVERY', state: 'pending', assignmentId: 'task', attempt: 1 }], inboxSeq: 1, handledInboxSeq: 0, interactions: [question], artifacts: [], messages: [], previousResults: [], createdAt: now, updatedAt: now, activeMs: 3000 }
  await put(join(userData, 'teams.json'), JSON.stringify([team]))
  await put(join(userData, 'team-projects', project.id + '.json'), JSON.stringify(project))
  await put(join(userData, 'sessions.json'), JSON.stringify(team.members.map(member => ({ id: project.memberSessions[member.id], title: member.id === 'leader' ? project.name : '后台成员', config: { agentId: 'codex', workdir: home, permissionMode: 'read-only' }, ...(member.id === 'leader' ? { nativeSessionId: nativeId } : {}), status: 'idle', createdAt: now, teamBinding: { teamProjectId: project.id, memberId: member.id } }))))
  await put(join(home, '.codex/sessions/rollout-2026-10-10T00-00-00-' + nativeId + '.jsonl'), [
    { timestamp: new Date(now).toISOString(), type: 'session_meta', payload: { id: nativeId, cwd: home, source: 'cli' } },
    { timestamp: new Date(now + 100).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'HISTORY_BEFORE_QUESTION' } },
    { timestamp: new Date(now + 200).toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'HISTORICAL_LEADER_REPLY' } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  await put(join(userData, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, autoCheckUpdate: false, enabledAgentIds: [], theme: 'dark', notificationMode: 'off' }))
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, UNIAGENT_USER_DATA: userData, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.capabilities'), UA_DISABLE_GPU: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'), ZDOTDIR: join(fixture, 'zdotdir') }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA']) { env[key] = join(fixture, key); await mkdir(env[key], { recursive: true }) }
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  child = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium'), '--ua-e2e'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  await sweeper.addRoot(child.pid)
  const renderer = join(dirname(dirname(binary)), 'Resources/app.asar.unpacked/out/renderer/index.html')
  const page = await poll(async () => {
    if (child.exitCode !== null) throw new Error('App exited: ' + stderr)
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) })).json()).find(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer) } catch { return null }
  }, Boolean, 'packaged renderer')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let serial = 0
  const pending = new Map()
  socket.addEventListener('message', message => { const value = JSON.parse(message.data); const request = pending.get(value.id); if (request) { pending.delete(value.id); clearTimeout(request.timer); value.error ? request.reject(new Error(JSON.stringify(value.error))) : request.resolve(value.result) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 30000) }); socket.send(JSON.stringify({ id, method, params })) })
  evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)); return result.result.value }
  await poll(() => evaluate('!!window.uniagent && !!document.querySelector(".session-list .session-item")'), Boolean, 'Leader sidebar')
  const sessions = await evaluate('window.uniagent.listSessions()')
  assert.equal(sessions.find(session => session.id === project.memberSessions.leader).status, 'awaiting-approval')
  const catalog = await evaluate('window.uniagent.teamCatalog()')
  assert.equal(catalog.projects.find(item => item.id === project.id).status, 'waiting_user')
  await evaluate('document.querySelector(".session-list .session-item").click()')
  await poll(() => evaluate('!!document.querySelector(".approval.pending.question-card")'), Boolean, 'blocking question card')
  assert.equal(await evaluate('document.querySelectorAll(".approval.pending.question-card").length'), 1)
  assert.equal(await evaluate('document.querySelectorAll(".event-stream .team-question-step .interaction-compact").length'), 1, 'team question retains one compact timeline node')
  assert.ok(await evaluate('!!document.querySelector(".interaction-dock-slot .approval.pending.question-card")'), 'full question stays above the composer')
  assert.ok(await evaluate('!document.querySelector(".event-stream .team-question-step fieldset")'), 'timeline node has no answer form')
  assert.ok(await evaluate('!!document.querySelector(".session-list .si-ask")'))
  const transcript = await poll(() => evaluate('document.querySelector(".event-stream").textContent'), text => text.includes('HISTORY_BEFORE_QUESTION') && text.includes('HISTORICAL_LEADER_REPLY'), 'restart retains the native transcript')
  assert.ok(!transcript.includes('LATE_MEMBER_DELIVERY'), 'later member delivery stays deferred')
  const runtime = await evaluate('window.uniagent.getSessionRuntimeState("s-question-leader")')
  assert.equal(runtime.events.filter(event => event.payload.teamInteractionId === question.id).length, 1)
  const invalid = await evaluate(`window.uniagent.respondTeamInteraction(${JSON.stringify(project.id)}, "question", 1, {answers: {scope: {answers: []}}}).then(() => null, error => error.message)`)
  assert.match(invalid, /question_required/)
  await delay(5500)
  assert.equal((await evaluate('window.uniagent.listSessions()')).find(session => session.id === project.memberSessions.leader).status, 'awaiting-approval')
  assert.equal((await evaluate('window.uniagent.getSessionRuntimeState("s-question-leader")')).events.length, runtime.events.length, 'scheduler produces no subsequent Leader output')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'waiting-question.png'), Buffer.from(shot.data, 'base64'))
  await evaluate(`window.uniagent.stopTeamProject(${JSON.stringify(project.id)})`)
  await poll(() => evaluate('window.uniagent.teamCatalog()'), result => result.projects.find(item => item.id === project.id).interactions[0].state === 'cancelled', 'stop cancels the question')
  console.log('PASS packaged question status, transcript recovery, deferred delivery, invalid answer and cancellation')
  console.log('EVIDENCE ' + output)
} catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
  if (evaluate) try { await put(join(output, 'failure-dom.txt'), await evaluate('document.body.innerText')) } catch {}
} finally {
  await put(join(output, 'app-stderr.log'), stderr)
  await cleanup()
}
