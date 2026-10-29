// Verify the packaged App against the real MiniMax Code CLI and a real API key.
//
// The App is launched from an isolated user-data root without any MiniMax Code
// credentials, exercising native CLI/config reuse → settings detail → real
// turn → approval → file change projection. Installer failures are covered offline.
// Add --local-model to use the installed official CLI (MCODE_LOCAL_CLI can
// override its path), a native CLI shim and a loopback model endpoint.
// This mode needs no real credential and does not contact the MiniMax API.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { createServer as createHttpServer } from 'node:http'
import yaml from 'js-yaml'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/') && binary.endsWith('/Contents/MacOS/UniAgent Public'), 'the packaged App is required')
const localModel = process.argv.includes('--local-model')
const apiKey = localModel ? 'ua-local-model-credential-for-testing' : process.env.MCODE_PROVIDER_API_KEY
assert.ok(apiKey && apiKey.length > 20, 'MCODE_PROVIDER_API_KEY is required for the live verification')

const fixture = await mkdtemp(join(tmpdir(), 'ua-mcode-packaged-'))
const data = join(fixture, 'data'), home = join(fixture, 'home'), workdir = join(fixture, 'workspace')
await mkdir(workdir, { recursive: true })

// Only the isolated native data directory is prepared; the external CLI is reused.
const stderrPath = join(fixture, 'app-stderr.log')
await writeFile(stderrPath, '')
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let ws, child, stderr = '', serial = 0, env
const pending = new Map()
const checks = []
let modelServer
const modelRequests = []
async function prepareLocalModel() {
  const packageRoot = resolve(await realpath(process.env.MCODE_LOCAL_CLI || '/opt/homebrew/bin/mcode'), '..')
  const shimDir = join(fixture, 'bin')
  await mkdir(shimDir)
  await symlink(join(packageRoot, 'cli.js'), join(shimDir, 'mcode'))
  await writeFile(join(shimDir, 'npm'), `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='view'){console.log(JSON.stringify(require(${JSON.stringify(join(packageRoot, 'package.json'))}).version));process.exit(0)}
process.exit(2);
`, { mode: 0o700 })
  env.PATH = shimDir + ':' + env.PATH
  modelServer = createHttpServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      if (!Array.isArray(body.messages)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'ua-mcode-local' }] })); return }
      modelRequests.push(body)
      if (JSON.stringify(body.messages).includes('MCODE_HOLD_GOAL')) return
      const last = body.messages.at(-1)?.content
      const toolResult = Array.isArray(last) && last.some(block => block.type === 'tool_result')
      const task = [...body.messages].reverse().filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content || []).filter(block => block.type === 'text').map(block => block.text)).find(Boolean) || ''
      let tool, input, text = 'UNIAGENT_MCODE_OK'
      if (task.includes('mcode-marker.txt') || task.includes('mcode-auto.txt')) {
        text = task.includes('mcode-auto.txt') ? 'MCODE_AUTO_DONE' : 'MCODE_WRITE_DONE'
        if (!toolResult) {
          tool = body.tools.find(tool => tool.name === 'write')
          assert.ok(tool, 'official CLI exposes the write tool')
          input = { path: join(workdir, task.includes('mcode-auto.txt') ? 'mcode-auto.txt' : 'mcode-marker.txt'), content: task.includes('mcode-auto.txt') ? 'auto' : 'hello' }
        }
      } else if (task.includes('risky-target')) {
        text = 'MCODE_PWD_DONE'
        if (!toolResult) {
          tool = body.tools.find(tool => ['bash', 'shell', 'execute'].includes(tool.name))
          assert.ok(tool, 'official CLI exposes the command tool')
          const target = join(fixture, 'risky-target')
          input = { command: `rm -rf ${target} && mkdir -p ${target} && echo owned > ${target}/x.txt`, description: 'Write an isolated test marker' }
        }
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'ua-mcode-local', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 128, output_tokens: 16 } }))
        return
      }
      const frames = [
        { type: 'message_start', message: { id: 'ua-mcode-local', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'ua-local-tool-' + modelRequests.length, name: tool.name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } },
        { type: 'message_stop' }
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''))
    } catch (error) { console.error('local model:', error.message); res.writeHead(500); res.end() }
  })
  await new Promise(resolveListen => modelServer.listen(0, '127.0.0.1', resolveListen))
}
const delay = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(read, predicate, label, timeout = 90000) {
  const start = Date.now(); let value
  while (Date.now() - start < timeout) { value = await read(); if (predicate(value)) return value; await delay(250) }
  throw new Error(label + ' timed out: ' + JSON.stringify(value))
}
function check(label, value) { assert.ok(value, label); checks.push(label); console.log('✓ ' + label) }
function cdp(method, params = {}, timeout = 60000) {
  return new Promise((resolveRequest, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeout)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveRequest(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression, timeout) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout)
  if (result.error || result.result?.exceptionDetails) throw new Error(result.result?.exceptionDetails?.exception?.description || JSON.stringify(result.error))
  return result.result.result.value
}
const call = (method, ...args) => evaluate('window.uniagent.' + method + '(' + args.map(a => JSON.stringify(a)).join(',') + ')')
const current = id => call('listSessions').then(s => s.find(x => x.id === id))
const terminal = s => s && ['idle', 'completed', 'error', 'cancelled', 'interrupted'].includes(s.status)
async function waitTurn(id, label) {
  const state = await waitFor(() => current(id), terminal, label, 180000)
  const events = await call('getEvents', id)
  assert.notEqual(state.status, 'error', label + ': ' + JSON.stringify(events.filter(e => e.type === 'error')))
  return { state, events }
}
async function approvalFor(id) {
  return waitFor(() => call('getEvents', id), evs => {
    const error = evs.findLast(event => event.type === 'error')
    if (error) throw new Error(error.payload.message)
    return evs.some(e => e.type === 'approval_request' && e.state === 'pending')
  }, 'tool approval', 180000)
    .then(evs => evs.findLast(e => e.type === 'approval_request' && e.state === 'pending'))
}
async function answerApproval(id, approval, optionId) {
  const option = approval.payload.options.find(o => o.optionId === optionId) || approval.payload.options[0]
  assert.ok(option, 'the approval must offer a selectable option')
  await call('respondRequest', id, approval.payload.requestId, { outcome: { outcome: 'selected', optionId: option.optionId } })
}
async function startApp() {
  const portServer = createServer()
  await new Promise(r => portServer.listen(0, '127.0.0.1', r))
  const port = portServer.address().port
  await new Promise(r => portServer.close(r))
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  await sweeper.addRoot(child.pid)
  child.on('error', error => console.error('spawn error', error))
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-200000)
    void appendFile(stderrPath, chunk)
  })
  const expected = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('packaged App exited during startup')
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) }).then(r => r.json()) } catch { return [] }
  }, ts => ts.some(t => t.type === 'page' && decodeURIComponent(t.url).endsWith(expected)), 'packaged renderer', 40000)
  const target = targets.find(t => t.type === 'page' && decodeURIComponent(t.url).endsWith(expected))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id) } }
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('CDP disconnected')); pending.clear() }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  await waitFor(async () => {
    try { return await call('getLifecycleSnapshot') }
    catch (error) { if (/Execution context was destroyed|Cannot find context/.test(String(error))) return null; throw error }
  }, Boolean, 'preload and startup')
}
async function stopApp() { ws?.close(); ws = undefined; await sweeper.sweep(); child = undefined }

async function clickWhenReady(selector, text, label) {
  await waitFor(async () => {
    const outcome = await evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const target = ${text ? `nodes.find(node => node.textContent.includes(${JSON.stringify(text)}))` : 'nodes[0]'}
      if (!target) return { ok: false, sample: document.body.innerText.slice(0, 200) }
      target.click()
      return { ok: true }
    })()`)
    if (!outcome.ok) console.log('   waiting for ' + label + ': ' + JSON.stringify(outcome.sample))
    return outcome.ok
  }, Boolean, label, 30000)
}

process.on('uncaughtException', error => {
  console.error('--- packaged App stderr ---\n' + stderr.slice(-4000))
  console.error('--- app exit ---', child?.exitCode, child?.signalCode)
  console.error(error)
  process.exit(1)
})

try {
  env = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home,
    USER: 'ua-mcode-test', LOGNAME: 'ua-mcode-test', UNIAGENT_USER_DATA: data,
    MCODE_PROVIDER_API_KEY: apiKey,
    MINIMAX_DATA_DIR: join(home, '.minimax'),
    CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_HOME: join(home, '.kimi'), DSH_HOME: join(home, '.dsh'),
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'),
    XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg-data'),
    XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null',
    NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'),
    UA_DISABLE_GPU: '1'
  }
  await mkdir(env.TMPDIR, { recursive: true })
  if (localModel) await prepareLocalModel()
  await mkdir(home, { recursive: true })
  await promisify(execFile)(process.env.MCODE_LOCAL_CLI || 'mcode', ['provider', 'set-minimax-key'], { env, cwd: workdir })
  if (localModel) {
    const configFile = join(env.MINIMAX_DATA_DIR, 'config.yaml')
    const config = yaml.load(await readFile(configFile, 'utf8'))
    config.minimax_api = { ...config.minimax_api, baseURL: `http://127.0.0.1:${modelServer.address().port}/anthropic` }
    await writeFile(configFile, yaml.dump(config), { mode: 0o600 })
  }
  await startApp()
  await call('getLifecycleSnapshot')

  // Reuse the installed CLI and the native provider prepared in this fixture.
  const installedSnapshot = await call('getMCodeConnection')
  check('the external CLI is detected', installedSnapshot.installed === true)
  check('the native connection is reused', installedSnapshot.status === 'ready')
  check('the native data directory is preserved', installedSnapshot.dataDir === env.MINIMAX_DATA_DIR)
  await call('setAppSettings', { enabledAgentIds: ['mcode'] })
  const agent = (await call('detectAgents')).find(a => a.id === 'mcode')
  console.log('   mcode agent:', JSON.stringify({ version: agent.version, incompatible: agent.incompatible, authenticationRequired: agent.authenticationRequired, unavailableReason: agent.unavailableReason, models: (agent.models || []).length, lifecycle: agent.lifecycle }))
  check('the official CLI version is reported', agent.version === installedSnapshot.version)
  check('the advertised models are exposed', Array.isArray(agent.models) && agent.models.length > 0)
  check('the model ids stay in the encoded form', agent.models.every(m => m.id.startsWith('m:')))
  check('the three permission tiers are offered', JSON.stringify(agent.capabilities.permissionModes.map(m => m.id)) === JSON.stringify(['ask', 'approve-for-me', 'full-access']))
  check('the agent reports its availability', agent.lifecycle?.availability === 'available' || !agent.unavailableReason)

  const snapshot = await call('getMCodeConnection')
  check('the existing connection is immediately usable', snapshot.status === 'ready')
  const verified = await call('checkMCodeConnection', {})
  check('rechecking uses the same external program', verified.status === 'ready' && verified.bin === installedSnapshot.bin)

  await clickWhenReady('.settings-entry', undefined, 'settings entry')
  await clickWhenReady('.set-nav-item', 'Agent', 'agent settings tab')
  await clickWhenReady('.settings-agent-open', 'MiniMax Code', 'mcode agent row')
  await waitFor(() => evaluate('document.body.innerText'), text => text.includes('默认模型') && text.includes('可执行路径'), 'native mcode detail', 30000)
  const panel = await evaluate('document.body.innerText')
  check('the standard installation and parameter groups are shown', panel.includes('安装信息') && panel.includes('默认推理强度'))
  check('a ready connection does not require another login', !panel.includes('一键登录') && !panel.includes('一键安装'))

  // 4. A real turn runs on the real model.
  const model = agent.models[0].id
  const session = await call('createSession', { agentId: 'mcode', model, permissionMode: 'ask', workdir }, '只回复 UNIAGENT_MCODE_OK，不要调用工具。')
  let { state, events } = await waitTurn(session.id, 'real first turn')
  check('the real MiniMax Code answer arrives', events.some(e => e.type === 'agent_message' && e.payload.text.includes('UNIAGENT_MCODE_OK')))
  check('the native session identity persists', !!state.nativeSessionId)
  check('the session contract exposes the three tiers', JSON.stringify(state.agentContract.permissionModes.map(m => m.id)) === JSON.stringify(['ask', 'approve-for-me', 'full-access']))

  // 5. A workspace write is projected as a file change. MiniMax Code treats
  //    a plain file write as low risk, so the "ask" tier does not interrupt it.
  const marker = join(workdir, 'mcode-marker.txt')
  await call('sendMessage', session.id, `仅调用一次写文件工具，把内容 hello 写入 ${marker}。写入后只回复 MCODE_WRITE_DONE。`)
  ;({ state, events } = await waitTurn(session.id, 'write turn'))
  check('the write is projected as a file change', events.some(e => e.type === 'file_change' && e.state === 'success' && e.payload.changes.some(c => c.path.endsWith('mcode-marker.txt'))))
  check('the written file really exists', existsSync(marker))

  // 6. A risky command does raise an approval in the "ask" tier, and the
  //    answer reaches the runtime with the option id it advertised.
  //    MiniMax Code classifies commands with a smart policy: benign ones such
  //    as `pwd` are auto-approved, only commands that write outside the
  //    workspace or remove files are escalated. Codex behaves the same way for
  //    sandbox-safe commands, so the risky command is the honest probe.
  const riskyTarget = join(fixture, 'risky-target')
  await call('sendMessage', session.id, `仅调用一次 bash 工具执行: rm -rf ${riskyTarget} && mkdir -p ${riskyTarget} && echo owned > ${riskyTarget}/x.txt。执行完只回复 MCODE_PWD_DONE。`)
  const approval = await approvalFor(session.id)
  check('the ask tier raises an approval request for a risky command', approval.payload.kind === 'command' || approval.payload.kind === 'permission')
  check('the approval offers the MiniMax Code option ids', JSON.stringify(approval.payload.options.map(o => o.optionId)) === JSON.stringify(['allow-once', 'allow-always', 'deny']))
  await answerApproval(session.id, approval, 'allow-once')
  ;({ state, events } = await waitTurn(session.id, 'approved command turn'))
  check('the approved command output is rendered', events.some(e => e.type === 'command_exec' && e.state === 'success'))
  check('the approved command really ran', existsSync(join(riskyTarget, 'x.txt')))

  // 6. The "full access" tier does not ask.
  await call('updateSessionConfig', session.id, { permissionMode: 'full-access' })
  const autoMarker = join(workdir, 'mcode-auto.txt')
  await call('sendMessage', session.id, `仅调用一次写文件工具，把内容 auto 写入 ${autoMarker}。写入后只回复 MCODE_AUTO_DONE。`)
  ;({ state, events } = await waitTurn(session.id, 'automatic write turn'))
  check('the full access tier runs without a manual approval', !events.some(e => e.type === 'approval_request' && e.state === 'pending'))
  check('the automatic write is projected as a file change', events.some(e => e.type === 'file_change' && e.state === 'success' && e.payload.changes.some(c => c.path.endsWith('mcode-auto.txt'))))

  // 7. The native history is readable and the session can be resumed.
  const history = await call('listAgentHistory', 'mcode')
  check('the native history lists the session', Array.isArray(history) && history.some(row => row.id === state.nativeSessionId))
  await call('sendMessage', session.id, '根据本会话第一条请求，只回复当时要求的标记，不调用工具。')
  ;({ events } = await waitTurn(session.id, 'resume turn'))
  check('the resumed session keeps the context', events.findLast(e => e.type === 'agent_message')?.payload.text.includes('UNIAGENT_MCODE_OK'))
  const forked = await call('forkSameSession', 'mcode', state.nativeSessionId, workdir)
  check('native same-agent fork creates a writable independent session', forked && forked.nativeSessionId !== state.nativeSessionId && forked.readOnly === false)
  check('fork history preserves the original user message', (await call('getEvents', forked.id)).some(event => event.type === 'user_message' && event.payload.text.includes('UNIAGENT_MCODE_OK')))
  if (localModel) check('the official CLI really called the local model', modelRequests.some(request => request.stream === true))
  if (localModel) {
    await call('runNativeAction', session.id, { type: 'goal.set', objective: 'MCODE_HOLD_GOAL', tokenBudget: 5000 })
    await waitFor(() => current(session.id), value => value?.status === 'running' && value.goal?.autonomous, 'native Goal starts')
    await waitFor(() => Promise.resolve(modelRequests), requests => requests.some(request => JSON.stringify(request.messages).includes('MCODE_HOLD_GOAL')), 'native Goal model request', 30000)
    await call('runNativeAction', session.id, { type: 'goal.update', action: 'pause' })
    await waitFor(() => current(session.id), value => value?.status === 'idle' && value.goal?.status === 'paused' && !value.goal.autonomous, 'native Goal pauses', 15000)
    check('a real native Goal can pause and release the session', true)
    await call('runNativeAction', session.id, { type: 'goal.update', action: 'resume' })
    await waitFor(() => current(session.id), value => value?.status === 'running' && value.goal?.autonomous, 'native Goal resumes', 15000)
    await call('interrupt', session.id)
    await waitFor(() => current(session.id), value => value?.status === 'idle' && value.goal?.status === 'paused' && !value.goal.autonomous, 'Stop pauses the native Goal', 15000)
    check('Stop pauses the runtime Goal and settles the local turn', true)
    await call('runNativeAction', session.id, { type: 'goal.clear' })
    check('the native Goal can be cleared', !(await current(session.id)).goal)
  }

  console.log('\nmcode packaged verification: ' + checks.length + ' checks passed')
} catch (error) {
  // Never let a cleanup failure hide the real assertion error.
  console.error('--- verification failed ---')
  console.error(error)
  try {
    const sessions = await call('listSessions')
    for (const s of sessions || []) {
      const events = await call('getEvents', s.id)
      console.error('--- session ' + s.id + ' (' + s.status + ') ---')
      console.error(JSON.stringify(events.map(e => ({ type: e.type, state: e.state, payload: e.payload })), null, 2).slice(-8000))
    }
  } catch (dumpError) {
    console.error('could not dump the session events:', dumpError)
  }
  throw error
} finally {
  await stopApp()
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolveClose => modelServer.close(resolveClose)) }
  try {
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (cleanupError) {
    console.error('the fixture cleanup failed (ignored):', cleanupError.message)
  }
}
