import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, readFile, readdir, chmod, rm, realpath, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/'), 'Only the repository packaged App may be tested')
const root = await mkdtemp(join(tmpdir(), 'uniagent-cdp-kimi-web-'))
const home = join(root, 'home'), data = join(root, 'data'), workdir = join(root, 'project'), kimi = join(home, '.kimi-code')
const sweeper = createAcceptanceProcessSweeper()
const checks = [], pending = new Map()
let socket, child, serial = 0, mode = 'done', requests = 0, stderr = '', env, modelServer, lastRequest
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, accept, label, timeout = 45000) {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) { value = await read(); if (accept(value)) return value; await wait(100) }
  throw new Error(label + ' timed out: ' + JSON.stringify(value))
}
function check(label, value) { assert.ok(value, label); checks.push(label); console.log('✓ ' + label) }
function cdp(method, params = {}) {
  const id = ++serial
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, 60000)
    pending.set(id, result => { clearTimeout(timer); resolve(result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.error || result.result?.exceptionDetails) throw new Error(result.result?.exceptionDetails?.exception?.description || JSON.stringify(result.error))
  return result.result.result.value
}
const call = (method, ...args) => evaluate(`window.uniagent.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
const events = id => call('getEvents', id)
async function turn(id) {
  const state = await until(() => call('listSessions'), rows => ['completed', 'idle', 'error', 'interrupted', 'cancelled'].includes(rows.find(row => row.id === id)?.status), 'turn completion')
  const rows = await events(id)
  assert.notEqual(state.find(row => row.id === id).status, 'error', JSON.stringify(rows.filter(row => row.type === 'error')))
  return rows
}
async function trackCli() {
  for (const file of await readdir(join(kimi, 'server/instances')).catch(() => [])) {
    try { const row = JSON.parse(await readFile(join(kimi, 'server/instances', file), 'utf8')); if (Number.isInteger(row.pid)) await sweeper.addRoot(row.pid) } catch {}
  }
}
async function stop() { await trackCli(); socket?.close(); socket = undefined; await sweeper.sweep(); child = undefined }
async function start() {
  const server = portServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(root, 'chromium')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  await once(child, 'spawn'); await sweeper.addRoot(child.pid)
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
  const targets = await until(async () => {
    if (child.exitCode !== null) throw new Error('Packaged App exited before readiness')
    return fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) }).then(response => response.json()).catch(() => [])
  }, rows => rows.some(row => row.type === 'page' && decodeURIComponent(row.url).includes(binary.replace('/MacOS/UniAgent Public', '/Resources/')) && /\/out\/renderer\/index\.html$/.test(row.url)), 'packaged renderer')
  const target = targets.find(row => row.type === 'page' && /\/out\/renderer\/index\.html$/.test(row.url))
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.onmessage = event => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) } }
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  await until(() => evaluate('!!window.uniagent && !!document.querySelector(".app")'), Boolean, 'preload')
  await until(() => call('getLifecycleSnapshot'), rows => rows.some(row => row.id === 'kimi' && row.lifecycle?.availability === 'available'), 'Kimi Web readiness')
  await until(() => evaluate('!document.querySelector(".startup-loading") && !document.querySelector(".app").inert'), Boolean, 'startup completion')
}

try {
  for (const path of [home, data, workdir, kimi, join(root, 'bin'), join(root, 'tmp'), join(root, 'xdg'), join(root, 'chromium')]) await mkdir(path, { recursive: true })
  modelServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); lastRequest = body; requests++
    res.setHeader('Content-Type', 'text/event-stream')
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    send({ role: 'assistant' })
    if (mode === 'hold') { send({ content: 'KIMI_STREAMING ' }); const timer = setInterval(() => send({ content: '.' }), 100); res.on('close', () => clearInterval(timer)); return }
    if (mode === 'attachment' && body.messages.at(-1)?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'read-attachment', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: join(workdir, 'fixture.txt') }) } }] }); send({}, 'tool_calls')
    } else if (mode === 'complete' && body.messages.at(-1)?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'goal-complete', type: 'function', function: { name: 'UpdateGoal', arguments: '{"status":"complete"}' } }] }); send({}, 'tool_calls')
    } else if (mode === 'question' && body.messages.at(-1)?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'ask', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ question: 'Choose fixture?', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }] }) } }] }); send({}, 'tool_calls')
    } else if (mode === 'approval' && body.messages.at(-1)?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'write', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: join(workdir, 'denied.txt'), content: 'must not exist' }) } }] }); send({}, 'tool_calls')
    } else { send({ reasoning_content: 'Fixture reasoning.' }); send({ content: 'UNIAGENT_KIMI_WEB_OK' }); send({}, 'stop') }
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }) + '\n\n'); res.end('data: [DONE]\n\n')
  })
  modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening')
  await writeFile(join(kimi, 'config.toml'), `default_model = "local"\n[models.local]\nprovider = "local"\nname = "fixture"\nmax_context_size = 8192\ncapabilities = ["image_in"]\n[providers.local]\ntype = "openai"\nbase_url = "http://127.0.0.1:${modelServer.address().port}/v1"\napi_key = "synthetic-local-fixture-key"\n`)
  const wrapper = join(root, 'bin', 'kimi')
  if (process.env.UNIAGENT_KIMI_TEST_BIN) await symlink(process.env.UNIAGENT_KIMI_TEST_BIN, wrapper)
  else { await writeFile(wrapper, '#!/bin/sh\nexec /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs "$@"\n'); await chmod(wrapper, 0o700) }
  await writeFile(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, enabledAgentIds: ['kimi'], autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, autoCheckUpdate: false }))
  env = { PATH: join(root, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: home, USERPROFILE: home, SHELL: '/usr/bin/false', TMPDIR: join(root, 'tmp'), UNIAGENT_USER_DATA: data, KIMI_CODE_HOME: kimi, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'), XDG_CONFIG_HOME: join(root, 'xdg'), XDG_DATA_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'xdg'), GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: join(root, 'npm-cache'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1' }
  await start()
  const agent = (await call('getLifecycleSnapshot')).find(row => row.id === 'kimi')
  check('Packaged App detects official Kimi Web 2.2.0', agent.version === '2.2.0' && agent.capabilities.protocol === 'web')
  check('Native capability gates exclude Side, exact-node Fork and additional directories', !agent.capabilities.sideChat && !agent.capabilities.sessionForkAtTurn && !agent.capabilities.additionalDirectoriesNew)
  check('Install action reuses existing CLI and returns actual readiness', (await call('installKimi')).status === 'ready' && requests === 0)
  check('Login action skips an already configured CLI', (await call('signInKimi')).status === 'ready' && requests === 0)
  const config = { agentId: 'kimi', model: 'local', permissionMode: 'ask', workdir }
  const session = await call('createSession', config, 'Packaged native message')
  let rows = await turn(session.id)
  check('Real App → native CLI → local model → rendered event', rows.some(row => row.type === 'agent_message' && row.payload.text === 'UNIAGENT_KIMI_WEB_OK'))
  const nativeId = (await call('listSessions')).find(row => row.id === session.id).nativeSessionId
  check('Native session ID and storage home are persisted', !!nativeId && (await call('listSessions')).find(row => row.id === session.id).config.kimiDataHome === await realpath(kimi))
  const imagePath = join(workdir, 'pixel.png'), filePath = join(workdir, 'fixture.txt')
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64'))
  await writeFile(filePath, 'UNIAGENT_FILE_ATTACHMENT_FIXTURE')
  mode = 'attachment'
  await call('sendMessage', session.id, 'Inspect fixture image and file', [{ kind: 'image', path: imagePath, name: 'pixel.png', mime: 'image/png' }, { kind: 'file', path: filePath, name: 'fixture.txt', mime: 'text/plain' }]); await turn(session.id)
  check('Image input and native Read of the file reference reach the model', JSON.stringify(lastRequest.messages).includes('data:image/png;base64,') && JSON.stringify(lastRequest.messages).includes(filePath) && JSON.stringify(lastRequest.messages).includes('UNIAGENT_FILE_ATTACHMENT_FIXTURE'))
  mode = 'done'
  await call('setCollaborationMode', session.id, 'plan')
  check('Native Plan mode round-trips through IPC', (await call('listSessions')).find(row => row.id === session.id).config.collaborationMode === 'plan')
  await call('setCollaborationMode', session.id, 'default')
  mode = 'question'; await call('sendMessage', session.id, 'Ask native question')
  const question = await until(() => events(session.id), rows => rows.some(row => row.type === 'approval_request' && row.state === 'pending' && row.payload.kind === 'question'), 'native question')
  const pendingQuestion = question.findLast(row => row.type === 'approval_request' && row.state === 'pending' && row.payload.kind === 'question')
  const first = pendingQuestion.payload.params.questions[0]; mode = 'done'
  await call('respondRequest', session.id, pendingQuestion.payload.requestId, { answers: { [first.id]: { answers: [first.options[0].label] } } }); await turn(session.id)
  check('Structured native question can be answered through preload IPC', true)
  mode = 'approval'; await call('sendMessage', session.id, 'Request write approval')
  const approvals = await until(() => events(session.id), rows => rows.some(row => row.type === 'approval_request' && row.state === 'pending' && row.payload.kind === 'permission'), 'native approval')
  const approval = approvals.findLast(row => row.type === 'approval_request' && row.state === 'pending' && row.payload.kind === 'permission'); mode = 'done'
  await call('respondRequest', session.id, approval.payload.requestId, { outcome: { outcome: 'selected', optionId: 'reject_once' } }); await turn(session.id)
  check('Denied native write leaves the workspace unchanged', !(await readFile(join(workdir, 'denied.txt')).catch(() => null)))
  const usageEvents = (await events(session.id)).filter(row => row.type === 'system_notice' && row.payload.kind === 'usage')
  check('Multi-step turns report one total without inflating context occupancy', usageEvents.length === 4 && usageEvents.at(-1).payload.usage.inputTokens === 60 && usageEvents.at(-1).payload.usage.outputTokens === 20 && usageEvents.at(-1).payload.usage.contextTokens === 30)
  mode = 'hold'; await call('sendMessage', session.id, 'Hold for cancellation')
  await until(() => events(session.id), rows => rows.some(row => row.type === 'agent_message' && row.payload.text?.startsWith('KIMI_STREAMING')), 'streaming text')
  await call('forceSend', session.id, 'Native steer fixture')
  check('Ordinary Steer records the native accepted input', (await events(session.id)).some(row => row.type === 'user_message' && row.payload.text === 'Native steer fixture' && row.payload.appendedToTurn === true))
  await call('interrupt', session.id); rows = await turn(session.id)
  check('Native cancellation reaches a cancelled terminal event', rows.some(row => row.type === 'turn_completed' && row.state === 'cancelled'))
  mode = 'complete'
  const goalSession = await call('createNativeActionSession', config, { type: 'goal.set', objective: 'Complete the synthetic native Goal' })
  await until(() => call('listSessions'), rows => rows.find(row => row.id === goalSession.id)?.goal?.status === 'complete', 'native goal completion')
  await turn(goalSession.id)
  check('Native Goal completes through the App without a second host continuation', (await call('listSessions')).find(row => row.id === goalSession.id).goal.status === 'complete')
  await evaluate(`document.querySelector('[data-session-id="${session.id}"]')?.click()`)
  await until(() => evaluate('document.body.innerText.includes("UNIAGENT_KIMI_WEB_OK")'), Boolean, 'visible native response')
  await evaluate('new Promise(resolve => setTimeout(resolve, 600))')
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile('docs/kimi-web-packaged-verification-2026-10-17.png', Buffer.from(screenshot.result.data, 'base64'))
  await stop(); mode = 'done'; await start()
  check('Restart retains the same native session ID', (await call('listSessions')).find(row => row.id === session.id)?.nativeSessionId === nativeId)
  check('Restart retains the canonical native storage binding', (await call('listSessions')).find(row => row.id === session.id)?.config.kimiDataHome === await realpath(kimi))
  await call('sendMessage', session.id, 'Resume after packaged restart'); await turn(session.id)
  check('Restart resumes existing native history', JSON.stringify(lastRequest.messages).includes('Packaged native message'))
  await evaluate('document.querySelector(".settings-entry")?.click()')
  await until(() => evaluate('!!document.querySelector(".set-nav")'), Boolean, 'settings navigation')
  await evaluate('[...document.querySelectorAll(".set-nav-item")].find(el => el.textContent.trim() === "Agent")?.click()')
  await until(() => evaluate('!!document.querySelector(\'[aria-label="查看 Kimi Code 详情"]\')'), Boolean, 'Kimi settings entry')
  await evaluate('document.querySelector(\'[aria-label="查看 Kimi Code 详情"]\').click()')
  await until(() => evaluate('!!document.querySelector(".kimi-setup")'), Boolean, 'native onboarding UI')
  check('Packaged settings renders the approved onboarding flow', await evaluate('document.querySelector(".kimi-setup").innerText.includes("其它安装方式")'))
  await evaluate('document.querySelector(".kimi-setup details").open = true')
  check('Packaged fallback prompt remains selectable without an executor', await evaluate('document.querySelector(".kimi-setup textarea").value.includes("kimi web")'))
  await evaluate('new Promise(resolve => setTimeout(resolve, 600))')
  const setupScreenshot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile('docs/kimi-web-onboarding-verification-2026-10-17.png', Buffer.from(setupScreenshot.result.data, 'base64'))
  console.log(JSON.stringify({ checks, requests, model: 'isolated local SSE fixture; no cloud credentials used' }))
} finally {
  await stop()
  modelServer?.closeAllConnections(); if (modelServer) await new Promise(resolve => modelServer.close(resolve))
  await rm(root, { recursive: true, force: true })
}
