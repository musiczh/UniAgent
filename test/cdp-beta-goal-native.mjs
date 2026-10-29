// Actual packaged App, installed official CLIs, and isolated loopback model responses.
// Run only after packing current source: node test/cdp-beta-goal-native.mjs [release/.../Contents/MacOS/UniAgent Public]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import TOML from '@iarna/toml'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/') && binary.endsWith('/Contents/MacOS/UniAgent Public'), 'only repository release App is allowed')
const renderer = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
const fixture = await mkdtemp(join(tmpdir(), 'ua-beta-goal-native-'))
const home = join(fixture, 'home'), data = join(fixture, 'data'), workdir = join(fixture, 'workspace')
const evidence = resolve('.uniagent-artifacts', 'beta-goal-native-' + new Date().toISOString().replace(/[:.]/g, '-'))
const fact = 'UA_NATIVE_GOAL_FACT_CONFIRMED'
const inputFile = join(workdir, 'EVIDENCE.txt')
const official = { kimi: '/opt/homebrew/bin/kimi', grok: '/Users/bytedance/.grok/bin/grok' }
const requestedAgents = (process.env.UNIAGENT_NATIVE_GOAL_AGENTS || 'kimi,grok').split(',')
assert.ok(requestedAgents.length && requestedAgents.every(id => id in official), 'unknown requested native Goal Agent')
const checks = [], ownershipScanWarnings = [], nativeControlTimings = [], models = new Map(), sessionIds = new Set(), pending = new Map()
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let child, ws, serial = 0, stderr = '', cleanupPromise, forceCleanup = false, failure, appAsarSha256, appEnv, lastOwnershipScan = 0
const delay = ms => new Promise(done => setTimeout(done, ms))
const sha256 = value => createHash('sha256').update(value).digest('hex')
function check(label, condition, detail) {
  assert.ok(condition, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)))
  checks.push(label); console.log('✓ ' + label)
}
async function put(file, content) {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  await writeFile(file, content, { mode: 0o600 })
}
async function waitFor(read, predicate, label, timeout = 45000) {
  const start = Date.now(); let last, reported = start
  while (Date.now() - start < timeout) {
    last = await read()
    if (predicate(last)) return last
    for (const [id, model] of models) if (model.capture.error) throw new Error(id + ' model fixture: ' + model.capture.error)
    if (Date.now() - reported > 20000) { console.log('… waiting: ' + label); reported = Date.now() }
    await delay(100)
  }
  throw new Error(label + ' timed out: ' + JSON.stringify(last))
}
function cdp(method, params = {}, timeout = 60000) {
  return new Promise((done, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeout)
    pending.set(id, { resolve: value => { clearTimeout(timer); done(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.error || reply.result?.exceptionDetails) throw new Error(reply.result?.exceptionDetails?.exception?.description || JSON.stringify(reply.error))
  return reply.result.result.value
}
const call = (method, ...args) => evaluate('window.uniagent.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')')
const state = async id => {
  // Retain identities while native runtimes are descendants, even if they later reparent.
  if (Date.now() - lastOwnershipScan > 1000) {
    lastOwnershipScan = Date.now()
    try { await sweeper.ownedProcesses() } catch (error) { ownershipScanWarnings.push(String(error)) }
  }
  return { session: (await call('listSessions')).find(row => row.id === id), events: await call('getEvents', id), queue: (await call('listQueues'))[id] || [] }
}
function healthy(value, label) {
  if (value.session?.status === 'error' || value.events.some(event => event.type === 'error')) throw new Error(label + ': ' + JSON.stringify(value))
  return true
}
async function screenshot(name) {
  const result = await cdp('Page.captureScreenshot', { format: 'png' }, 10000)
  await put(join(evidence, name + '.png'), Buffer.from(result.result.data, 'base64'))
}
async function selectSession(id) {
  await evaluate(`document.querySelector('[data-session-id="${id}"]')?.click()`)
  await waitFor(() => evaluate('document.querySelector(".goal-status-bar")?.textContent'), Boolean, 'native Goal bar')
}

const tool = (name, args, id) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const toolDone = (body, id) => body.messages.some(message => message.role === 'tool' && message.tool_call_id === id)
const textOf = (body, role) => body.messages.filter(message => message.role === role).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
function uniquePath(pattern, text) {
  const matches = [...text.matchAll(pattern)].map(match => match[1])
  assert.ok(matches.length, 'official Goal prompt did not provide an artifact path')
  const path = matches.at(-1)
  assert.ok(path.startsWith(fixture + '/'), 'native artifact must remain in the isolated fixture')
  return path
}
function grokResponse(body, behavior) {
  const user = textOf(body, 'user'), names = (body.tools || []).map(entry => entry.function?.name)
  const schema = body.response_format?.json_schema?.schema
  if (names.length === 1 && names[0] === 'session_title') return { route: 'title', delta: tool('session_title', { title: 'Isolated native Goal' }, 'ua-title') }
  if (user.includes('You are the Goal Plan Writer')) {
    const target = uniquePath(/(\/[^`\n]+\/goal\/plan-[^`\n]+\.md)/g, user)
    const content = '# Plan: Confirm the isolated evidence fact\n\n## Goal kind\nanalysis\n\n## Acceptance criteria\n1. Report that EVIDENCE.txt contains ' + fact + '.\n\n## Verification plan\n1. gating: Read EVIDENCE.txt and verify its text equals ' + fact + '; report that fact.\n\n## Non-goals\n- No project changes.\n\n## Assumed scope\nEVIDENCE.txt in the isolated workspace.\n'
    return { route: 'planner', delta: toolDone(body, 'ua-plan-write') ? { role: 'assistant', content: 'Done' } : tool('write', { file_path: target, content }, 'ua-plan-write') }
  }
  if (user.includes('### 1. JSON verdict')) {
    const verdict = uniquePath(/(\/[^`\n]+\/goal-verdict-[^`\n]+\.json)/g, user)
    const details = uniquePath(/(\/[^`\n]+\/goal-classifier-[^`\n]+-skeptic-\d+\.md)/g, user)
    if (!toolDone(body, 'ua-skeptic-read')) return { route: 'skeptic', delta: tool('read_file', { target_file: inputFile }, 'ua-skeptic-read') }
    if (!toolDone(body, 'ua-verdict-write')) return { route: 'skeptic', delta: tool('write', { file_path: verdict, content: JSON.stringify({ refuted: false, findings: [], evidence: 'EVIDENCE.txt:1 contains ' + fact + '. Native read_file confirmed.', confidence: 'high', blocking: 'none', details_md: 'Observed evidence confirms the required fact.' }) }, 'ua-verdict-write') }
    if (!toolDone(body, 'ua-detail-write')) return { route: 'skeptic', delta: tool('write', { file_path: details, content: 'Observed EVIDENCE.txt:1 confirms ' + fact + '.' }, 'ua-detail-write') }
    return { route: 'skeptic', delta: { role: 'assistant', content: 'Not Refuted' } }
  }
  if (schema?.properties?.decision) return { route: 'evaluator', delta: { role: 'assistant', content: JSON.stringify({ decision: behavior.startsWith('control') ? 'continue' : 'candidate_complete', evidence: 'Native read_file EVIDENCE.txt:1 confirms ' + fact + '.', next_step: behavior.startsWith('control') ? 'Check the evidence fact once more in the next bounded native round.' : 'Run independent verification.', blocker_key: '' }) } }
  assert.ok(!schema, 'unexpected official Grok structured response schema')
  if (names.length && user.includes('A goal has been set:')) {
    return { route: 'implementer', hold: behavior.startsWith('control'), delta: toolDone(body, 'ua-impl-read') ? { role: 'assistant', content: 'EVIDENCE.txt:1 contains ' + fact + '.' } : tool('read_file', { target_file: inputFile }, 'ua-impl-read') }
  }
  return { route: 'other', delta: { role: 'assistant', content: 'EVIDENCE.txt:1 contains ' + fact + '.' } }
}
function kimiResponse(body, behavior) {
  if (behavior === 'complete') {
    if (!toolDone(body, 'ua-kimi-read')) return { route: 'complete-read', delta: tool('Read', { path: inputFile }, 'ua-kimi-read') }
    if (!toolDone(body, 'ua-kimi-complete')) return { route: 'complete-update', delta: tool('UpdateGoal', { status: 'complete' }, 'ua-kimi-complete') }
    return { route: 'complete-summary', delta: { role: 'assistant', content: 'EVIDENCE.txt:1 contains ' + fact + '.' } }
  }
  if (behavior === 'control-first' && !toolDone(body, 'ua-kimi-get-goal')) return { route: 'control', hold: true, delta: tool('GetGoal', {}, 'ua-kimi-get-goal') }
  return { route: 'control', hold: behavior === 'control-resumed', delta: { role: 'assistant', content: 'UA_NATIVE_GOAL_CONTROL_FINISHED' } }
}
async function startModel(id) {
  const capture = { requests: [], error: null }, holds = new Map(), heldStages = new Set()
  let behavior = 'control-first'
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      if (!Array.isArray(body.messages)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'ua-native-local', object: 'model', context_window: 200000 }] })); return
      }
      const chosen = id === 'kimi' ? kimiResponse(body, behavior) : grokResponse(body, behavior)
      const row = { observedAt: Date.now(), path: req.url, behavior, route: chosen.route, body, held: false, closedBeforeRelease: false }
      capture.requests.push(row)
      const finish = chosen.delta.tool_calls ? 'tool_calls' : 'stop'
      const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'ua-native-goal', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
      if (body.stream !== false) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); send({ role: 'assistant' })
      }
      if (chosen.hold && !heldStages.has(behavior)) {
        heldStages.add(behavior); row.held = true
        await new Promise(done => {
          const timer = setTimeout(() => { capture.error = 'held model response was not released'; release() }, 45000)
          const heartbeat = body.stream !== false ? setInterval(() => res.write(': held native model response\n\n'), 500) : undefined
          function release() { row.releasedAt ??= Date.now(); clearTimeout(timer); clearInterval(heartbeat); holds.delete(behavior); done() }
          holds.set(behavior, release)
          res.once('close', () => { row.closedBeforeRelease = holds.has(behavior); release() })
        })
      }
      if (res.destroyed || res.writableEnded) return
      const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      if (body.stream !== false) {
        send(chosen.delta, finish)
        res.write('data: ' + JSON.stringify({ id: 'ua-native-goal', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage }) + '\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        const { tool_calls, ...message } = chosen.delta
        res.end(JSON.stringify({ id: 'ua-native-goal', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { ...message, ...(tool_calls ? { tool_calls: tool_calls.map(({ index, ...call }) => call) } : {}) }, finish_reason: finish }], usage }))
      }
    } catch (error) {
      capture.error = String(error.stack || error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'isolated fixture failed' } }))
    }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const model = { capture, server, baseUrl: 'http://127.0.0.1:' + server.address().port, setBehavior: value => { behavior = value }, held: stage => holds.has(stage), release: stage => { const release = holds.get(stage); assert.ok(release, 'no held ' + id + ' response: ' + stage); release() }, releaseAll: () => { for (const release of [...holds.values()]) release() } }
  models.set(id, model); return model
}

async function prepare() {
  await chmod(fixture, 0o700)
  for (const directory of [home, data, workdir, evidence, ...['tmp', 'chromium', 'config', 'xdg-data', 'cache', 'state', 'runtime', 'npm-cache', 'bin'].map(name => join(fixture, name))]) await mkdir(directory, { recursive: true, mode: 0o700 })
  appAsarSha256 = sha256(await readFile(binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar')))
  for (const [id, bin] of Object.entries(official)) { await access(bin); await symlink(await realpath(bin), join(fixture, 'bin', id)) }
  await put(inputFile, fact + '\n')
  for (const id of Object.keys(official)) await startModel(id)
  await put(join(home, '.kimi-code/config.toml'), TOML.stringify({ default_model: 'ua-native-local', telemetry: false, models: { 'ua-native-local': { provider: 'local', name: 'fixture', max_context_size: 8192 } }, providers: { local: { type: 'openai', base_url: models.get('kimi').baseUrl + '/v1', api_key: 'fixture-kimi-key' } } }))
  await put(join(home, '.kimi-code/mcp.json'), JSON.stringify({ mcpServers: {} }))
  await put(join(home, '.kimi-code/device_id'), 'ua-isolated-native-goal')
  const base = models.get('grok').baseUrl + '/v1'
  await put(join(home, '.grok/config.toml'), TOML.stringify({ cli: { use_leader: false }, features: { managed_config: false, feedback: false, telemetry: false }, managed_mcps: { enabled: false }, models: { default: 'ua-native-local' }, model: { 'ua-native-local': { model: 'ua-native-local', base_url: base, api_key: 'fixture-grok-key', api_backend: 'chat_completions', agent_type: 'grok-build', max_retries: 0, context_window: 200000 } }, endpoints: { models_base_url: base, xai_api_base_url: base, cli_chat_proxy_base_url: base } }))
  await put(join(fixture, 'gitconfig'), ''); await put(join(fixture, 'npmrc'), '')
  appEnv = {
    PATH: join(fixture, 'bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, USER: 'ua-native-test', LOGNAME: 'ua-native-test',
    UNIAGENT_USER_DATA: data, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'), KIMI_CODE_HOME: join(home, '.kimi-code'), KIMI_HOME: join(home, '.kimi'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
    XAI_API_KEY: 'fixture-grok-key', GROK_SUBAGENTS: '0', GROK_GOAL: '1', GROK_GOAL_USE_CURRENT_MODEL_ONLY: '1', GROK_GOAL_VERIFIER_N: '1', GROK_GOAL_CLASSIFIER: '1', GROK_GOAL_SUMMARY: '0',
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg-data'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), XDG_RUNTIME_DIR: join(fixture, 'runtime'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1'
  }
}
async function startApp() {
  const portServer = createPortServer()
  await new Promise(done => portServer.listen(0, '127.0.0.1', done))
  const port = portServer.address().port
  await new Promise(done => portServer.close(done))
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env: appEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.on('error', error => { stderr += String(error) }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000) })
  await sweeper.addRoot(child.pid)
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('App exited during startup: ' + stderr)
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) }).then(response => response.json()) } catch { return [] }
  }, targets => targets.some(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer), 'exact packaged renderer')
  const target = targets.find(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (request) { pending.delete(message.id); request.resolve(message) } }
  ws.onclose = () => { for (const request of pending.values()) request.reject(new Error('CDP disconnected')); pending.clear() }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await waitFor(async () => { try { return await call('getLifecycleSnapshot') } catch (error) { if (/Execution context was destroyed|Cannot find context/.test(String(error))) return null; throw error } }, Boolean, 'public preload ready')
  check('exact release renderer and public bridge', await evaluate('document.title === "UniAgent Public" && typeof window.uniagent.createNativeActionSession === "function"'))
}
const configFor = id => ({ agentId: id, model: 'ua-native-local', permissionMode: id === 'grok' ? 'full-access' : 'approve-for-me', workdir })
async function verifyBoundaries(id) {
  const model = models.get(id), before = model.capture.requests.length
  const config = configFor(id)
  await assert.rejects(call('createNativeActionSession', config, { type: 'goal.set', objective: 'UA_NATIVE_INVALID_ROUNDS', maxRounds: 2 }), /轮数|回合|round/i)
  if (id === 'kimi') await assert.rejects(call('createNativeActionSession', config, { type: 'goal.set', objective: 'UA_NATIVE_INVALID_TOKENS', tokenBudget: 100 }), /Token|token|预算/)
  check(id + ' rejects unsupported external Goal limits before model execution', model.capture.requests.length === before)
}
async function grokControlAtRoundEnd(sessionId, action, model, stage) {
  const label = action.type === 'goal.clear' ? 'clear' : action.action
  const timing = { action: label, sessionId, sentAt: Date.now(), releasedAt: null, settledAt: null }
  nativeControlTimings.push(timing)
  let settled = false
  // Official Grok slash controls wait for the current model round. Retain the
  // pending RPC while independently observing the real host state over CDP.
  const pendingControl = call('runNativeAction', sessionId, action).then(
    () => { settled = true; timing.settledAt = Date.now(); return { success: true } },
    error => { settled = true; timing.settledAt = Date.now(); return { error } }
  )
  await delay(1200)
  const beforeRelease = await state(sessionId)
  timing.beforeRelease = { observedAt: Date.now(), settled, held: model.held(stage), session: beforeRelease.session, queue: beforeRelease.queue }
  check('Grok ' + label + ' remains pending while the official current model round runs', healthy(beforeRelease, 'Grok pending ' + label) && !settled && model.held(stage) && beforeRelease.session?.goal?.status === 'active' && beforeRelease.session.goal.autonomous, timing.beforeRelease)
  await screenshot('grok-goal-' + label + '-pending-current-round')
  timing.releasedAt = Date.now()
  model.release(stage)
  const result = await pendingControl
  if (result.error) throw result.error
  const confirmed = await waitFor(() => state(sessionId), value => healthy(value, 'Grok ' + label + ' settlement') && ['idle', 'completed'].includes(value.session?.status) && (label === 'clear' ? !value.session?.goal : value.session?.goal?.status === 'paused' && !value.session.goal.autonomous), 'Grok ' + label + ' confirmed after current round')
  timing.confirmedAt = Date.now()
  timing.afterRelease = { session: confirmed.session, queue: confirmed.queue }
  check('Grok ' + label + ' is confirmed by the native runtime after the current round ends', timing.settledAt >= timing.releasedAt && confirmed.session.nativeSessionId === beforeRelease.session.nativeSessionId, timing)
  await put(join(evidence, 'grok-' + label + '-timing.json'), JSON.stringify(timing, null, 2))
  return confirmed
}
async function verifyControls(id) {
  const model = models.get(id), objective = 'UA_NATIVE_CONTROL_' + id + ': Analyze EVIDENCE.txt and report its confirmed fact without changing project files'
  model.setBehavior('control-first')
  const session = await call('createNativeActionSession', configFor(id), { type: 'goal.set', objective, ...(id === 'grok' ? { tokenBudget: 10000 } : {}) })
  sessionIds.add(session.id)
  const initial = await waitFor(() => state(session.id), value => healthy(value, id + ' startup') && model.held('control-first') && value.session?.goal?.status === 'active', id + ' held official Goal model turn')
  const nativeId = initial.session.nativeSessionId
  check(id + ' starts one native Goal on the official CLI', nativeId && initial.session.goal.continuation === 'native' && initial.session.goal.autonomous, initial.session)
  check(id + ' preserves actual external budget units', initial.session.goal.tokenBudget === (id === 'grok' ? 10000 : null), initial.session.goal)
  await selectSession(session.id); await screenshot(id + '-goal-active')
  const queued = 'UA_NATIVE_QUEUED_' + id, steering = 'UA_NATIVE_STEER_' + id
  await call('sendMessage', session.id, queued)
  const queue = (await state(session.id)).queue
  assert.equal(queue.length, 1, id + ' busy message queues once')
  await call('setQueueEditing', session.id, queue[0].id)
  await call('forceSend', session.id, steering)
  const steered = await state(session.id)
  check(id + ' native steer is acknowledged without host queue fallback', steered.queue.length === 1 && steered.queue[0].prompt === queued && steered.events.filter(event => event.type === 'user_message' && event.payload?.text === steering && event.payload.appendedToTurn).length === 1, steered)
  await assert.rejects(call('runNativeAction', session.id, { type: 'goal.update', action: 'edit', objective: 'must reject edit' }), /不支持/)
  if (id === 'grok') {
    await grokControlAtRoundEnd(session.id, { type: 'goal.update', action: 'pause' }, model, 'control-first')
    await screenshot('grok-goal-paused')
  } else {
    await call('runNativeAction', session.id, { type: 'goal.update', action: 'pause' })
    const paused = await waitFor(() => state(session.id), value => healthy(value, id + ' pause') && value.session?.goal?.status === 'paused', id + ' native pause confirmation')
    check(id + ' pause disarms native continuation during the active model call', !paused.session.goal.autonomous && paused.session.nativeSessionId === nativeId && model.held('control-first'), paused.session)
    await screenshot(id + '-goal-paused-active-turn')
    model.release('control-first')
  }
  const settled = await waitFor(() => state(session.id), value => healthy(value, id + ' paused settlement') && ['idle', 'completed'].includes(value.session?.status), id + ' paused round settles')
  check(id + ' paused native round preserves the frozen host outbox', settled.session.goal?.status === 'paused' && settled.queue.length === 1 && settled.queue[0].prompt === queued, settled)
  check(id + ' official model receives native steer in the current history', model.capture.requests.some(row => JSON.stringify(row.body.messages).includes(steering)), model.capture.requests.map(row => ({ route: row.route, behavior: row.behavior })))
  const count = model.capture.requests.length
  await delay(1000)
  check(id + ' pause prevents another autonomous model round and queue delivery', model.capture.requests.length === count && !model.capture.requests.some(row => JSON.stringify(row.body.messages).includes(queued)))
  await put(join(evidence, id + '-paused-events.json'), JSON.stringify(settled, null, 2))
  await call('dequeue', session.id, queue[0].id)
  await call('setQueueEditing', session.id, null)
  model.setBehavior('control-resumed')
  await call('runNativeAction', session.id, { type: 'goal.update', action: 'resume' })
  const resumed = await waitFor(() => state(session.id), value => healthy(value, id + ' resume') && value.session?.goal?.status === 'active' && model.held('control-resumed'), id + ' same native Goal resumed round')
  check(id + ' resumes the same official native session', resumed.session.nativeSessionId === nativeId && resumed.session.goal.autonomous && resumed.queue.length === 0, resumed.session)
  await screenshot(id + '-goal-resumed')
  if (id === 'grok') await grokControlAtRoundEnd(session.id, { type: 'goal.clear' }, model, 'control-resumed')
  else {
    await call('runNativeAction', session.id, { type: 'goal.clear' })
    await waitFor(() => state(session.id), value => !value.session?.goal, id + ' native Goal clear')
    if (model.held('control-resumed')) model.release('control-resumed')
  }
  const cleared = await waitFor(() => state(session.id), value => healthy(value, id + ' clear settlement') && !value.session?.goal && ['idle', 'completed'].includes(value.session?.status), id + ' cleared Goal settles')
  const clearedCount = model.capture.requests.length
  await delay(1000)
  check(id + ' cleared native Goal leaves no host phantom busy or pending message', !cleared.session.goal && cleared.queue.length === 0 && model.capture.requests.length === clearedCount, cleared)
  check(id + ' publishes Goal intent exactly once', cleared.events.filter(event => event.type === 'goal_message' && event.payload?.text === objective).length === 1)
  await put(join(evidence, id + '-control-events.json'), JSON.stringify(cleared, null, 2))
}
async function verifyCompletion(id) {
  const model = models.get(id), start = model.capture.requests.length
  model.setBehavior('complete')
  const objective = 'UA_NATIVE_COMPLETE_' + id + ': Analyze EVIDENCE.txt and report its confirmed fact without changing project files'
  const session = await call('createNativeActionSession', configFor(id), { type: 'goal.set', objective, ...(id === 'grok' ? { tokenBudget: 10000 } : {}) })
  sessionIds.add(session.id)
  const final = await waitFor(() => state(session.id), value => healthy(value, id + ' completion') && value.session?.goal?.status === 'complete' && value.session?.status === 'completed', id + ' official Goal terminal completion', 60000)
  const requests = model.capture.requests.slice(start), count = model.capture.requests.length
  await delay(1000)
  check(id + ' native terminal state completes host Goal exactly once', final.session.goal.continuation === 'native' && !final.session.goal.autonomous && final.events.filter(event => event.type === 'goal_message' && event.payload?.text === objective).length === 1 && model.capture.requests.length === count, final.session)
  check(id + ' completion uses official evidence tools', final.events.some(event => event.type === 'tool_call' && (event.payload?.name === (id === 'kimi' ? 'Read' : 'read_file') || JSON.stringify(event.payload).includes(inputFile))), final.events.filter(event => event.type === 'tool_call'))
  if (id === 'kimi') check('Kimi model controls terminal Goal through official UpdateGoal', requests.some(row => row.route === 'complete-update') && final.events.some(event => event.type === 'tool_call' && event.payload?.name === 'UpdateGoal'))
  else check('Grok official Goal owns planner, implementer, evaluator and skeptic lifecycle', ['planner', 'implementer', 'evaluator', 'skeptic'].every(route => requests.some(row => row.route === route)), requests.map(row => row.route))
  await selectSession(session.id); await screenshot(id + '-goal-complete')
  await put(join(evidence, id + '-complete-events.json'), JSON.stringify(final, null, 2))
}
async function verifyGrokBudget() {
  const model = models.get('grok')
  model.setBehavior('budget')
  const objective = 'UA_NATIVE_GROK_BUDGET: Analyze EVIDENCE.txt and report its confirmed fact without changing project files'
  const session = await call('createNativeActionSession', configFor('grok'), { type: 'goal.set', objective, tokenBudget: 1 })
  sessionIds.add(session.id)
  const final = await waitFor(() => state(session.id), value => healthy(value, 'Grok budget') && value.session?.goal?.status === 'budgetLimited' && ['idle', 'completed'].includes(value.session?.status), 'Grok official Token budget limit')
  const count = model.capture.requests.length
  await delay(1000)
  // Native usage is committed at round boundaries; a current round may finish
  // before Grok confirms budget_limited. Its terminal state owns the stop.
  check('Grok native Token budget stops execution using official counted usage', final.session.goal.tokenBudget === 1 && final.session.goal.tokensUsed > 1 && !final.session.goal.autonomous && model.capture.requests.length === count, final.session)
  await selectSession(session.id); await screenshot('grok-goal-budget-limited')
  await put(join(evidence, 'grok-budget-events.json'), JSON.stringify(final, null, 2))
}
async function saveEvidence(error) {
  await put(join(evidence, 'app-stderr.txt'), stderr)
  for (const [id, model] of models) await put(join(evidence, id + '-model-requests.json'), JSON.stringify(model.capture, null, 2))
  if (ws?.readyState === WebSocket.OPEN) for (const id of sessionIds) {
    try { await put(join(evidence, id + '-final-state.json'), JSON.stringify(await state(id), null, 2)) } catch { /* CDP may already be closed by signal cleanup. */ }
  }
  await put(join(evidence, 'acceptance.json'), JSON.stringify({ checkedAt: new Date().toISOString(), binary, appAsarSha256, requestedAgents, officialCli: official, checks, nativeControlTimings, ownershipScanWarnings, error: error ? String(error.stack || error) : null, modelRequests: Object.fromEntries([...models].map(([id, model]) => [id, model.capture.requests.length])) }, null, 2))
}
function cleanup() {
  return cleanupPromise ||= (async () => {
    ws?.close()
    for (const model of models.values()) model.releaseAll()
    await sweeper.sweep({ force: forceCleanup, shouldAbort: () => forceCleanup })
    if (forceCleanup) await sweeper.forceSweep()
    const remaining = await sweeper.ownedProcesses()
    await put(join(evidence, 'cleanup.json'), JSON.stringify({ appPid: child?.pid, remainingOwnedPids: remaining.map(row => row.pid), fixtureRemoved: false }, null, 2))
    for (const model of models.values()) { model.server.closeAllConnections(); await new Promise(done => model.server.close(done)) }
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
    await put(join(evidence, 'cleanup.json'), JSON.stringify({ appPid: child?.pid, remainingOwnedPids: remaining.map(row => row.pid), fixtureRemoved: true }, null, 2))
  })()
}
const termination = createAcceptanceTerminationHandler({ cleanup, requestForceCleanup: () => { forceCleanup = true }, onFirstSignal: signal => console.error('Native Goal acceptance interrupted: ' + signal), onCleanupError: error => console.error(error), exit: code => process.exit(code) })
process.on('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.on('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))

try {
  await prepare(); await startApp()
  // Bootstrap runs a protocol detection after the fast core snapshot. Wait for
  // that existing real probe before requesting another complete detection.
  await waitFor(() => call('listAgents'), agents => Object.keys(official).every(id => agents.find(agent => agent.id === id)?.lifecycle?.checkedAt > 0), 'startup official protocol detection', 60000)
  const agents = await call('detectAgents')
  await put(join(evidence, 'detected-agents.json'), JSON.stringify(agents.filter(agent => agent.id in official), null, 2))
  await call('setAppSettings', { enabledAgentIds: requestedAgents })
  for (const id of requestedAgents) {
    const agent = agents.find(agent => agent.id === id)
    check(id + ' official installed CLI advertises native Goal and steer', agent?.installed && !agent.incompatible && !agent.authenticationRequired && agent.capabilities?.nativeGoal && agent.capabilities?.steer, agent)
    check(id + ' packaged App resolves the installed official executable', await realpath(agent.bin) === await realpath(official[id]), { bin: agent.bin, official: official[id], version: agent.version })
    await verifyBoundaries(id); await verifyControls(id); await verifyCompletion(id)
  }
  if (requestedAgents.includes('grok')) await verifyGrokBudget()
} catch (error) { failure = error; console.error(error) }
finally {
  try { await saveEvidence(failure) } catch (error) { failure ||= error; console.error(error) }
  try { await cleanup() } catch (error) {
    failure ||= error; console.error(error)
    try { await saveEvidence(failure) } catch (saveError) { console.error(saveError) }
  }
}
console.log('Native Goal evidence: ' + evidence)
if (failure) process.exitCode = 1
