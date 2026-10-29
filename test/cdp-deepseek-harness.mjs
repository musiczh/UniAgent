// Run the installed official Harness and real API through an isolated packaged App.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/') && binary.endsWith('/Contents/MacOS/UniAgent Public'))
const fixture = await mkdtemp(join(tmpdir(), 'ua-dsh-packaged-'))
const data = join(fixture, 'data'), home = join(fixture, 'home'), workdir = join(fixture, 'workspace')
const sourceData = process.env.UA_DSH_SOURCE_DATA || join(homedir(), 'Library/Application Support/UniAgent')
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let ws, child, stderr = '', serial = 0, env
const pending = new Map()
const checks = []
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
const terminal = s => s && ['idle','completed','error','cancelled','interrupted'].includes(s.status)
async function waitTurn(id, label) {
  const state = await waitFor(() => current(id), terminal, label)
  const events = await call('getEvents', id)
  assert.notEqual(state.status, 'error', label + ': ' + JSON.stringify(events.filter(e => e.type === 'error')))
  return { state, events }
}
async function approvalFor(id) {
  return waitFor(() => call('getEvents', id), evs => evs.some(e => e.type === 'approval_request' && e.state === 'pending'), 'tool approval')
    .then(evs => evs.findLast(e => e.type === 'approval_request' && e.state === 'pending'))
}
async function answerApproval(id, approval, kind) {
  const option = approval.payload.options.find(o => o.kind === kind)
  assert.ok(option)
  await call('respondRequest', id, approval.payload.requestId, { outcome: { outcome: 'selected', optionId: option.optionId } })
}
async function startApp() {
  const portServer = createServer()
  await new Promise(r => portServer.listen(0, '127.0.0.1', r))
  const port = portServer.address().port
  await new Promise(r => portServer.close(r))
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env, detached:true, stdio:['ignore','ignore','pipe'] })
  await sweeper.addRoot(child.pid)
  child.on('error', error => console.error('spawn error', error))
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000) })
  const expected = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('packaged App exited during startup')
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal:AbortSignal.timeout(1500) }).then(r => r.json()) } catch { return [] }
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
function redImage() {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1 } return (value ^ 0xffffffff) >>> 0 }
  const chunk = (name, data) => { const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type,data]))); return Buffer.concat([length,type,data,checksum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64,4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(64 * (1 + 64 * 3))
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))])
}
let cleanupPromise
const cleanup = () => cleanupPromise ||= (async () => { await stopApp(); await rm(fixture, { recursive:true, force:true, maxRetries:5 }) })()
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })

try {
  for (const path of [join(home,'Library'), data, workdir, join(fixture,'tmp'), join(home,'.uniagent-capability-data'), join(fixture,'chromium'), join(fixture,'config'), join(fixture,'xdg-data'), join(fixture,'cache'), join(fixture,'state'), join(data,'codex-sources'), join(data,'deepseek')]) await mkdir(path, { recursive:true })
  await mkdir(join(data,'credentials'), { mode:0o700 })
  await writeFile(join(data,'credentials/key'), await readFile(join(sourceData,'credentials/key')), { mode:0o600 })
  const sources = JSON.parse(await readFile(join(sourceData,'codex-sources/settings.json'),'utf8'))
  const source = sources.sources.find(s => s.preset === 'deepseek')
  assert.ok(source?.encryptedKey, 'real DeepSeek credential required')
  await writeFile(join(data,'codex-sources/settings.json'), JSON.stringify({ version:1, enabled:false, sources:[source] }), { mode:0o600 })
  const brokenBin = join(data,'deepseek/runtime-0.2.1-rc.2/node_modules/.bin/dsh')
  await mkdir(join(brokenBin, '..'), { recursive:true })
  await writeFile(brokenBin, '#!/usr/bin/env node\nconsole.log("0.0.0-broken")\n')
  await chmod(brokenBin, 0o755)
  env = { PATH:process.env.PATH, LANG:'en_US.UTF-8', SHELL:'/usr/bin/false', HOME:home, USERPROFILE:home, USER:'ua-dsh-test', LOGNAME:'ua-dsh-test', UNIAGENT_USER_DATA:data, CODEX_HOME:join(home,'.codex'), TRAE_HOME:join(home,'.trae'), CLAUDE_CONFIG_DIR:join(home,'.claude'), KIMI_HOME:join(home,'.kimi'), DSH_HOME:join(home,'.dsh'), TMPDIR:join(fixture,'tmp'), TMP:join(fixture,'tmp'), TEMP:join(fixture,'tmp'), XDG_CONFIG_HOME:join(fixture,'config'), XDG_DATA_HOME:join(fixture,'xdg-data'), XDG_CACHE_HOME:join(fixture,'cache'), XDG_STATE_HOME:join(fixture,'state'), GIT_CONFIG_GLOBAL:join(fixture,'gitconfig'), GIT_CONFIG_SYSTEM:'/dev/null', NPM_CONFIG_USERCONFIG:join(fixture,'npmrc'), NPM_CONFIG_CACHE:join(fixture,'npm-cache'), UNIAGENT_CAPABILITY_HOME:home, UNIAGENT_CAPABILITY_DATA:join(home,'.uniagent-capability-data'), UA_DISABLE_GPU:'1' }
  await startApp()
  await call('getLifecycleSnapshot')
  const brokenAgent = (await call('detectAgents')).find(a => a.id === 'deepseek')
  check('damaged managed runtime is detected', brokenAgent?.incompatible)
  await call('setAppSettings', { enabledAgentIds:['deepseek'] })
  await evaluate("document.querySelector('.settings-entry').click()")
  await evaluate("Array.from(document.querySelectorAll('.set-nav-item')).find(x=>x.textContent.includes('Agent')).click()")
  await waitFor(() => evaluate('document.body.innerText'), t => t.includes('DeepSeek Harness'), 'repair settings')
  await evaluate("Array.from(document.querySelectorAll('.settings-agent-open')).find(x=>x.textContent.includes('DeepSeek Harness')).click()")
  await waitFor(() => evaluate('document.body.innerText'), t => t.includes('重新安装 DeepSeek Harness'), 'repair action')
  check('settings exposes repair for an incompatible runtime', true)
  await evaluate('window.uniagent.installDeepSeek()', 360000)
  check('official npm install repairs and verifies the runtime', (await call('getDeepSeekConnection')).installed)
  const agents = await call('detectAgents'), agent = agents.find(a => a.id === 'deepseek')
  check('official CLI is available in packaged App', agent?.lifecycle?.availability === 'available' || (console.log(agent?.lifecycle, agent?.unavailableReason), false))
  check('opaque model catalog and exact efforts', agent.models.length >= 2 && agent.models.some(m => m.efforts.includes('off')))
  check('native bridge exposes history fork, Side and structured usage', agent.capabilities.sessionLoad && agent.capabilities.sessionFork && agent.capabilities.sideChat && agent.capabilities.structuredUsage)
  const snapshot = await call('getDeepSeekConnection')
  check('credential reused without renderer key disclosure', snapshot.hasKey && snapshot.source === 'codex' && !('apiKey' in snapshot))
  await call('saveDeepSeekConnection', { baseUrl:snapshot.baseUrl, apiKey:'' })
  check('blank key save preserves reused credentials', (await call('getDeepSeekConnection')).hasKey)
  await assert.rejects(call('saveDeepSeekConnection', { baseUrl:'file:///tmp/key' }), /HTTP|服务地址/)
  check('invalid endpoint is rejected', (await call('getDeepSeekConnection')).baseUrl === snapshot.baseUrl)
  await call('setAppSettings', { enabledAgentIds:['deepseek'] })
  await waitFor(() => evaluate("document.querySelector('[aria-label=\"DeepSeek API Key\"]')?.type"), v => v === 'password', 'key input')
  check('connection UI and parameter controls render', await evaluate("document.body.innerText.includes('默认推理强度') && !!document.querySelector('[aria-label=\"DeepSeek 服务地址\"]')"))
  await mkdir(resolve('docs/deepseek-harness-2026-10-11'), { recursive:true })
  const shot = await cdp('Page.captureScreenshot', { format:'png' })
  await writeFile(resolve('docs/deepseek-harness-2026-10-11/actual-settings.png'), Buffer.from(shot.result.data,'base64'))
  const model = agent.models.find(m => m.id.includes('deepseek-flash')).id
  const pro = agent.models.find(m => m.id.includes('deepseek-v4-pro')).id
  const imagePath = join(workdir,'red.png'); await writeFile(imagePath, redImage())
  const imageAttachment = { kind:'image', path:imagePath, name:'red.png', mime:'image/png' }
  const session = await call('createSession', { agentId:'deepseek', model, effort:'low', permissionMode:'ask', workdir }, '只回复 UNIAGENT_DSH_OK，不要调用工具。')
  let { state, events } = await waitTurn(session.id, 'real first turn')
  const nativeId = state.nativeSessionId
  check('real DeepSeek response completes', events.some(e => e.type === 'agent_message' && e.payload.text.includes('UNIAGENT_DSH_OK')))
  check('context usage arrives', events.some(e => e.type === 'system_notice' && ['context','usage'].includes(e.payload.kind) && e.payload.usage.contextTokens > 0))
  check('native session identity persists', !!nativeId)
  await call('sendMessage', session.id, '仅调用 bash 工具执行 pwd，随后回复 PWD_DONE。')
  const approval = await approvalFor(session.id)
  check('approval contains the real command', approval.payload.kind === 'command' && !!approval.payload.params.rawInput?.command)
  await answerApproval(session.id, approval, 'allow_once')
  ;({ state, events } = await waitTurn(session.id, 'approved tool turn'))
  check('approved command output is rendered', events.some(e => e.type === 'command_exec' && e.state === 'success' && e.payload.output.includes(basename(fixture))))
  const deniedPath = join(workdir,'must-not-exist.txt')
  await call('sendMessage', session.id, `仅调用一次 bash 执行 printf DENIED > '${deniedPath}'。如果被拒绝，不要重试或调用其他工具，直接回复 DENIED_DONE。`)
  const denied = await approvalFor(session.id)
  await answerApproval(session.id, denied, 'reject_once')
  await waitTurn(session.id, 'rejected tool turn')
  await assert.rejects(access(deniedPath))
  check('rejected command has no filesystem effect', true)
  await call('updateSessionConfig', session.id, { effort:'off', permissionMode:'full-access' })
  state = await current(session.id)
  check('effort commits after native confirmation', state.config.effort === 'off' && state.agentContract.models.find(m => m.id === model).defaultEffort === 'off')
  await call('sendMessage', session.id, '调用 bash 执行 printf AUTO_DSH_OK，随后回复 AUTO_DONE。')
  ;({ events } = await waitTurn(session.id, 'automatic approval turn'))
  check('full access executes without manual approval', events.some(e => e.type === 'command_exec' && e.state === 'success' && e.payload.output.includes('AUTO_DSH_OK')) && !events.some(e => e.type === 'approval_request' && e.state === 'pending'))
  await call('sendMessage', session.id, '调用 UniAgent MCP 的 uniagent_query 工具，参数 action=list、type=agent，不用 bash 或其他方式代替，然后只回复 MCP_DSH_OK。')
  ;({ events } = await waitTurn(session.id, 'real MCP turn'))
  check('official Harness calls UniAgent MCP', events.some(e => e.type === 'tool_call' && e.state === 'success' && e.payload.name === 'uniagent_query' && e.payload.input?.action === 'list'))
  await call('updateSessionConfig', session.id, { model:pro, effort:'high' })
  state = await current(session.id)
  check('model switch confirms Pro and disables images', state.agentContract.currentModelId === pro && !state.agentContract.imageAttachments)
  await call('sendMessage', session.id, '只回复 PRO_DSH_OK，不调用工具。')
  ;({ events } = await waitTurn(session.id, 'real Pro turn'))
  check('Pro produces a real response', events.findLast(e => e.type === 'agent_message')?.payload.text.includes('PRO_DSH_OK'))
  await assert.rejects(call('sendMessage', session.id, '描述图片', [imageAttachment]), /图片/)
  check('Pro rejects unsupported image input before sending', true)
  await assert.rejects(call('updateSessionConfig', session.id, { model:'invalid-model' }))
  check('failed configuration keeps previous model', (await current(session.id)).config.model === pro)
  await call('updateSessionConfig', session.id, { model, effort:'off' })
  const textPath = join(workdir, 'attachment.txt')
  await writeFile(textPath, 'ATTACHMENT_SECRET_DSH_7182')
  await call('sendMessage', session.id, '读取附件中的标记，只回复该标记。', [{ kind:'file', path:textPath, name:'attachment.txt', mime:'text/plain' }])
  ;({ events } = await waitTurn(session.id, 'file attachment turn'))
  check('text attachment can be read by Harness', events.findLast(e => e.type === 'agent_message')?.payload.text.includes('ATTACHMENT_SECRET_DSH_7182'))
  await call('sendMessage', session.id, '图片中是什么颜色？只用英文回复颜色名称，不调用工具。', [imageAttachment])
  ;({ events } = await waitTurn(session.id, 'real image turn'))
  check('Flash accepts and understands image input', /red/i.test(events.findLast(e => e.type === 'agent_message')?.payload.text || ''))
  await call('archiveSession', session.id)
  await call('unarchiveSession', session.id)
  await call('sendMessage', session.id, '根据本会话第一条请求，只回复当时要求的标记，不调用工具。')
  ;({ state, events } = await waitTurn(session.id, 'native resume turn'))
  check('archive and native resume retain context', state.nativeSessionId === nativeId && events.findLast(e => e.type === 'agent_message')?.payload.text.includes('UNIAGENT_DSH_OK'))
  await call('sendMessage', session.id, '调用 bash 执行 sleep 30，然后回复 SLEEP_DONE。')
  await waitFor(() => call('getEvents', session.id), evs => evs.some(e => e.type === 'command_exec' && e.state === 'running' && /sleep 30/.test(e.payload.command)), 'long command starts')
  await call('interrupt', session.id)
  await waitTurn(session.id, 'cancel acknowledgement')
  check('interrupt stops a real executing command', true)
  const beforeRestart = await call('getEvents', session.id)
  await stopApp()
  await startApp()
  await call('detectAgents')
  state = await current(session.id); events = await call('getEvents', session.id)
  check('App restart restores the complete transcript', events.some(e => e.type === 'agent_message' && e.payload.text.includes('UNIAGENT_DSH_OK')) && events.some(e => e.type === 'command_exec' && e.payload.output.includes('AUTO_DSH_OK')))
  check('App restart preserves off effort and native identity', state.config.effort === 'off' && state.nativeSessionId === nativeId)
  check('App restart preserves approval details and decisions', events.some(e => e.type === 'approval_request' && e.payload.kind === 'command' && e.payload.params?.rawInput?.command && e.payload.submittedAnswer?.outcome?.optionId))
  const priorMaxSeq = Math.max(...beforeRestart.map(e => e.seq))
  await call('sendMessage', session.id, '只回复 RESTART_DSH_OK，不调用工具。')
  ;({ events } = await waitTurn(session.id, 'post-restart turn'))
  check('resumed turn appends without replacing earlier messages', events.findLast(e => e.type === 'agent_message')?.payload.text.includes('RESTART_DSH_OK') && events.findLast(e => e.type === 'agent_message').seq > priorMaxSeq && events.some(e => e.type === 'agent_message' && e.payload.text.includes('UNIAGENT_DSH_OK')))
  await call('updateSessionConfig', session.id, { permissionMode:'ask' })
  await call('sendMessage', session.id, '只调用一次 bash 执行 pwd。不要调用其他工具。')
  await approvalFor(session.id)
  await call('archiveSession', session.id)
  events = await call('getEvents', session.id)
  const latestRequests = new Map(events.filter(e=>e.type==='approval_request').map(e=>[e.payload.requestId,e]))
  check('archive retires outstanding approval requests', ![...latestRequests.values()].some(e=>e.state==='pending'))
  await stopApp(); await startApp(); await call('getLifecycleSnapshot'); await call('detectAgents')
  events = await call('getEvents', session.id)
  check('App restart never revives expired approvals', !events.some(e=>e.type==='approval_request' && e.state==='pending'))
  await call('deleteSession', session.id)
  check('local deletion removes session and transcript', !(await call('listSessions')).some(s => s.id === session.id))
  await assert.rejects(access(join(data,'deepseek/events', session.id + '.jsonl')))
  await call('saveDeepSeekConnection', { baseUrl:snapshot.baseUrl, apiKey:'invalid-uniagent-acceptance-key' })
  const stored = await readFile(join(data,'deepseek/connection.json'),'utf8')
  check('dedicated key is encrypted on disk and hidden from renderer', !stored.includes('invalid-uniagent-acceptance-key') && !('apiKey' in await call('getDeepSeekConnection')))
  const badSession = await call('createSession', { agentId:'deepseek', model, effort:'off', permissionMode:'ask', workdir }, '只回复 AUTH_TEST。')
  const badState = await waitFor(() => current(badSession.id), terminal, 'invalid credential error')
  const badEvents = await call('getEvents', badSession.id)
  check('real invalid credential reports actionable error', badState.status === 'error' && badEvents.some(e => e.type === 'error' && e.payload.authRequired && /API Key/.test(e.payload.message)))
  // Restore the isolated fixture's valid source key without exposing it to CDP.
  await rm(join(data,'deepseek/connection.json'))
  await call('saveDeepSeekConnection', { baseUrl:snapshot.baseUrl })
  await call('sendMessage', badSession.id, '只回复 AUTH_RECOVERED_DSH_OK，不调用工具。')
  const recovered = await waitTurn(badSession.id, 'credential recovery in the same session')
  check('changed credentials recover the existing session', recovered.state.nativeSessionId === badState.nativeSessionId && recovered.events.findLast(e => e.type === 'agent_message')?.payload.text.includes('AUTH_RECOVERED_DSH_OK'))
  await call('sendMessage', badSession.id, '只调用一次 bash 执行 pwd，不调用其他工具。')
  await approvalFor(badSession.id)
  await call('deleteSession', badSession.id)
  await assert.rejects(access(join(data,'deepseek/events', badSession.id + '.jsonl')))
  check('deletion during approval removes transcript permanently', !(await call('listSessions')).some(s => s.id === badSession.id))
  await writeFile(resolve('docs/deepseek-harness-2026-10-11/acceptance.json'), JSON.stringify({ checkedAt:new Date().toISOString(), appAsarSha256:createHash('sha256').update(await readFile(binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar'))).digest('hex'), harnessVersion:snapshot.version, models:agent.models.map(m => ({ label:m.label, efforts:m.efforts, imageInput:m.imageInput })), checks }, null, 2))
  console.log('DeepSeek Harness packaged acceptance passed: ' + checks.length + ' checks')
} catch (error) { console.error(error); console.error('packaged stderr tail:', stderr.slice(-4000)); process.exitCode = 1 }
finally { await cleanup() }
