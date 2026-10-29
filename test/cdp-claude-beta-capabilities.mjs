// Current release App + installed official Claude CLI + an isolated loopback model.
// Usage: node test/cdp-claude-beta-capabilities.mjs [release/.../Contents/MacOS/UniAgent Public]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/') && binary.endsWith('/Contents/MacOS/UniAgent Public'), 'only repository release App is allowed')
await access(binary)
assert.ok((await realpath(binary)).startsWith(await realpath(resolve('release')) + '/'), 'packaged executable must resolve inside repository release')
const renderer = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
const officialClaude = await realpath(process.env.UNIAGENT_CLAUDE_REAL_BIN || join(homedir(), '.local/bin/claude'))
const fixture = await mkdtemp(join(tmpdir(), 'ua-claude-packaged-'))
const home = join(fixture, 'home'), data = join(fixture, 'data'), workdir = join(fixture, 'workspace')
const evidence = resolve('.uniagent-artifacts', 'claude-packaged-' + new Date().toISOString().replace(/[:.]/g, '-'))
const mcpLog = join(fixture, 'mcp-calls.jsonl')
const marker = 'UA_CLAUDE_PACKAGED_MAIN_1742'
const roleMarker = 'UA_CLAUDE_ROLE_INSTRUCTIONS_1742'
const skillMarker = 'UA_CLAUDE_ALLOWED_REVIEW_1742'
const forbiddenMarker = 'UA_CLAUDE_UNLISTED_SKILL_1742'
const resultMarker = 'UA_CLAUDE_PACKAGED_DONE_1742'
const modelId = 'claude-sonnet-4-5'
const checks = [], requests = [], pending = new Map()
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let app, ws, serial = 0, stderr = '', cleanupPromise, forceCleanup = false, modelError, appEnv, mainCalls = 0
const delay = ms => new Promise(done => setTimeout(done, ms))
const sha256 = value => createHash('sha256').update(value).digest('hex')
function check(label, value, detail) {
  assert.ok(value, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)))
  checks.push(label); console.log('✓ ' + label)
}
async function put(file, contents) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, contents, { mode: 0o600 })
}
async function waitFor(read, predicate, label, timeout = 60000) {
  const start = Date.now(); let last, reported = start
  while (Date.now() - start < timeout) {
    last = await read()
    if (predicate(last)) return last
    if (Date.now() - reported > 25000) { console.log('… waiting: ' + label); reported = Date.now() }
    await delay(200)
  }
  throw new Error(label + ' timed out: ' + JSON.stringify(last))
}
function cdp(method, params = {}, timeout = 30000) {
  return new Promise((done, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeout)
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

function anthropicSSE(index, tools, text) {
  const frames = [{ type: 'message_start', message: { id: 'msg_ua_claude_' + index, type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 128, output_tokens: 0 } } }]
  const blocks = tools.length ? tools : [{ text }]
  blocks.forEach((tool, blockIndex) => {
    frames.push({ type: 'content_block_start', index: blockIndex, content_block: tool.name ? { type: 'tool_use', id: 'toolu_ua_claude_' + index + '_' + blockIndex, name: tool.name, input: {} } : { type: 'text', text: '' } })
    frames.push({ type: 'content_block_delta', index: blockIndex, delta: tool.name ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: tool.text } })
    frames.push({ type: 'content_block_stop', index: blockIndex })
  })
  frames.push({ type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } }, { type: 'message_stop' })
  return frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join('')
}
const model = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":128}'); return }
    if (!req.url?.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
    const main = JSON.stringify(body.messages).includes(marker)
    const index = requests.length
    requests.push({ path: req.url, body, main })
    const first = main && mainCalls++ === 0
    const tools = first ? [
      { name: 'mcp__docs__read', input: {} }, { name: 'mcp__docs__write', input: {} },
      { name: 'Skill', input: { skill: 'review' } }, { name: 'Skill', input: { skill: 'other' } }
    ] : []
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(anthropicSSE(index, tools, main ? resultMarker : 'fixture background summary'))
  } catch (error) {
    modelError = String(error.stack || error)
    res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture model failed"}}')
  }
})

async function prepare() {
  for (const directory of [home, data, workdir, join(fixture, 'bin'), join(fixture, 'tmp')]) await mkdir(directory, { recursive: true, mode: 0o700 })
  await symlink(officialClaude, join(fixture, 'bin/claude'))
  await new Promise((done, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', done) })
  const baseUrl = 'http://127.0.0.1:' + model.address().port
  appEnv = {
    PATH: [join(fixture, 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, USER: 'ua-claude-test', LOGNAME: 'ua-claude-test',
    UNIAGENT_USER_DATA: data, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_CODE_HOME: join(home, '.kimi-code'), KIMI_HOME: join(home, '.kimi'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
    ANTHROPIC_API_KEY: 'sk-ant-uniagent-local-fixture', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId, ANTHROPIC_DEFAULT_SONNET_MODEL: modelId, ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_SKIP_VERSION_CHECK: '1', ENABLE_TOOL_SEARCH: 'false',
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg-data'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), XDG_RUNTIME_DIR: join(fixture, 'runtime'),
    ZDOTDIR: join(fixture, 'zdotdir'), GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'local-appdata'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1'
  }
  await put(join(fixture, 'gitconfig'), '')
  await put(join(fixture, 'npmrc'), '')
  await put(join(home, '.claude/skills/review/SKILL.md'), '---\nname: review\ndescription: Regular review fixture\n---\n' + skillMarker + '\nReview without a subagent.\n')
  await put(join(home, '.claude/skills/other/SKILL.md'), '---\nname: other\ndescription: Unlisted fixture skill\n---\n' + forbiddenMarker + '\n')
  const mcpFile = join(fixture, 'docs-mcp.cjs')
  await put(mcpFile, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const v=JSON.parse(line);if(v.id===undefined)return;let result={};if(v.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'docs',version:'1'}};if(v.method==='tools/list')result={tools:[{name:'read',description:'Reads fixture',inputSchema:{type:'object',properties:{}}},{name:'write',description:'Writes fixture',inputSchema:{type:'object',properties:{}}}]};if(v.method==='tools/call'){fs.appendFileSync(${JSON.stringify(mcpLog)},v.params.name+'\\n');result={content:[{type:'text',text:'UA_CLAUDE_MCP_READ_OK'}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:v.id,result})+'\\n');});\n`)
  await put(join(home, '.claude/.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { docs: { command: process.execPath, args: [mcpFile] } }, projects: { [workdir]: { hasTrustDialogAccepted: true } } }))
  await put(join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: modelId, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: appEnv.ANTHROPIC_API_KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: modelId, ANTHROPIC_DEFAULT_SONNET_MODEL: modelId, ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId } }))
}

async function startApp() {
  const portServer = createPortServer()
  await new Promise((done, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', done) })
  const port = portServer.address().port
  await new Promise(done => portServer.close(done))
  app = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env: appEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  app.on('error', error => { stderr += String(error) })
  app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000) })
  await sweeper.addRoot(app.pid)
  const targets = await waitFor(async () => {
    if (app.exitCode !== null || app.signalCode) throw new Error('App exited during startup: ' + stderr)
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) }).then(response => response.json()) } catch { return [] }
  }, rows => rows.some(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer), 'exact packaged renderer', 45000)
  const target = targets.find(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = event => { const reply = JSON.parse(event.data), request = pending.get(reply.id); if (request) { pending.delete(reply.id); request.resolve(reply) } }
  ws.onclose = () => { for (const request of pending.values()) request.reject(new Error('CDP disconnected')); pending.clear() }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await waitFor(async () => { try { return await call('getLifecycleSnapshot') } catch (error) { if (/Execution context was destroyed|Cannot find context/.test(String(error))) return null; throw error } }, Boolean, 'preload ready')
  check('exact release renderer uses public preload bridge', await evaluate('document.title === "UniAgent Public" && typeof window.uniagent.createSession === "function"'))
}

async function verifyRoleAndReports() {
  const claude = await waitFor(() => call('getLifecycleSnapshot'), rows => rows.find(row => row.id === 'claude')?.lifecycle?.availability === 'available', 'official Claude detection').then(rows => rows.find(row => row.id === 'claude'))
  await put(join(evidence, 'detected-claude.json'), JSON.stringify(claude, null, 2))
  const version = claude.version.match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/)?.slice(1).map(Number)
  check('installed official Claude supports role protocol', claude.installed && version && (version[0] > 2 || version[0] === 2 && (version[1] > 1 || version[1] === 1 && version[2] >= 296)), claude.version)
  check('detected Claude executable is the installed official CLI', await realpath(claude.bin) === officialClaude, claude.bin)
  check('isolated API-key authentication is available', claude.lifecycle.auth === 'authenticated' && !claude.authenticationRequired, claude.lifecycle)
  await call('setAppSettings', { enabledAgentIds: ['claude'] })
  const project = await call('createProject', { name: 'Claude packaged acceptance', primaryDirectory: workdir, additionalDirectories: [] })
  const role = { id: 'ua-claude-packaged-review', name: 'Claude packaged reviewer', agentId: 'claude', model: modelId, permissionMode: 'full-access', projectId: project.id, workdir, instructions: roleMarker, skills: ['review'], toolPolicy: { mode: 'allow-only', tools: ['Skill', 'Read', 'mcp__docs__read'] } }
  const catalog = await call('saveRole', role)
  check('role catalog accepts native instructions, skills and tools', catalog.find(row => row.role.id === role.id)?.executable, catalog.find(row => row.role.id === role.id))
  const session = await call('createSession', { agentId: 'claude', model: modelId, permissionMode: 'full-access', projectId: project.id, workdir, roleSnapshot: role }, marker + ': use review and docs read; attempt other and docs write.')
  const result = await waitFor(async () => ({ session: (await call('listSessions')).find(row => row.id === session.id), events: await call('getEvents', session.id) }), value => {
    if (value.session?.status === 'error' || value.events.some(event => event.type === 'error')) throw new Error('role turn failed: ' + JSON.stringify(value.events.filter(event => event.type === 'error')))
    return ['idle', 'completed'].includes(value.session?.status) && value.events.some(event => event.type === 'turn_completed' && event.state === 'success') && value.events.some(event => event.type === 'agent_message' && event.payload.text?.includes(resultMarker))
  }, 'native role turn', 60000)
  const main = requests.filter(row => row.main)
  check('role instructions reach the native model system prompt', main.length >= 2 && JSON.stringify(main[0].body.system).includes(roleMarker))
  const tools = main[0].body.tools.map(tool => tool.name)
  check('native builtin tool set respects role allowlist and finite-skill child gate', tools.includes('Read') && tools.includes('Skill') && !tools.some(name => ['Write', 'Bash', 'Agent', 'Task'].includes(name)), tools)
  check('both MCP fixture tools were available for native hook enforcement', tools.includes('mcp__docs__read') && tools.includes('mcp__docs__write'), tools)
  check('native allowlisted Skill content loaded', JSON.stringify(main).includes(skillMarker))
  check('unlisted Skill content never entered model context', !JSON.stringify(requests).includes(forbiddenMarker))
  check('MCP read executed and unlisted write never reached server', (await readFile(mcpLog, 'utf8')).trim() === 'read')
  check('native hook denial projects a failed tool result', result.events.some(event => event.type === 'tool_call' && event.state === 'failed' && /hook error/.test(event.payload.output || '')))
  check('role snapshot is persisted with the completed native session', result.session.config.roleSnapshot.id === role.id && typeof result.session.nativeSessionId === 'string')
  const beforeCalls = requests.length, beforeTurns = result.events.filter(event => event.type === 'turn_started').length
  await call('sendMessage', session.id, '/context')
  await call('sendMessage', session.id, '/usage')
  const reports = await call('getEvents', session.id)
  const context = reports.findLast(event => event.payload.kind === 'context_usage')?.payload.contextUsage
  const usage = reports.findLast(event => event.payload.kind === 'usage_report')?.payload.usageReport
  check('native /context inspects the resumed transcript', (context?.totalTokens ?? context?.total_tokens) > 0, context)
  check('native /usage retains session cost and records unavailable API-key quota', usage?.session?.total_cost_usd > 0 && usage.rate_limits_available === false, usage)
  check('native report commands do not start a model turn', requests.length === beforeCalls && reports.filter(event => event.type === 'turn_started').length === beforeTurns)
  check('native report commands preserve completed session state', (await call('listSessions')).find(row => row.id === session.id).status === result.session.status)
  await put(join(evidence, 'session-events.json'), JSON.stringify({ session: result.session, events: reports }, null, 2))
  await put(join(evidence, 'mcp-calls.jsonl'), await readFile(mcpLog))
  // Direct IPC creation bypasses the UI's commit callback; reload the real renderer to hydrate its persisted session list.
  await cdp('Page.reload')
  await waitFor(async () => {
    try { return await call('listSessions') }
    catch (error) { if (/Execution context was destroyed|Cannot find context|uniagent/.test(String(error))) return null; throw error }
  }, rows => rows?.some(row => row.id === session.id), 'renderer session hydration')
  await waitFor(()=>evaluate('!!document.querySelector(".app") && !document.querySelector(".app").inert && document.getElementById("ua-startup")?.hidden === true'),Boolean,'renderer startup settled')
  await evaluate('document.querySelector(".sl-seg [data-view=all]")?.click()')
  await waitFor(() => evaluate(`(() => {const node=document.querySelector('[data-session-id="${session.id}"]');node?.click();return !!node;})()`), Boolean, 'select completed role session')
  await waitFor(() => evaluate(`(async () => ({text:document.querySelector('.session-view')?.innerText || document.body.innerText,events:(await window.uniagent.getEvents(${JSON.stringify(session.id)})).length,html:document.querySelector('.session-view')?.innerHTML.slice(0,1800)}))()`), value => value.text.includes('Claude 上下文') && value.text.includes('Claude 会话用量') && value.text.includes('未返回订阅额度'), 'native report renderer')
  check('packaged renderer displays native context, session usage and missing quota', true)
  await cdp('Page.bringToFront')
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  assert.ok(screenshot.result?.data, 'native report screenshot failed: '+JSON.stringify(screenshot.error))
  await put(join(evidence, 'native-role-reports.png'), Buffer.from(screenshot.result.data, 'base64'))
  await assert.rejects(call('runNativeAction',session.id,{type:'review.start',draft:{scope:{type:'uncommittedChanges'}}}),/技能白名单/)
  check('Review validates finite Skill restrictions before changing session state',(await call('listSessions')).find(row=>row.id===session.id).status===result.session.status)
  const reviewSession=await call('createSession',{agentId:'claude',model:modelId,permissionMode:'full-access',projectId:project.id,workdir},'SDK_REVIEW_CONTEXT')
  const reviewReady=await waitFor(async()=>(await call('listSessions')).find(row=>row.id===reviewSession.id),value=>['idle','completed'].includes(value?.status),'Review session ready')
  const reviewTurns=(await call('getEvents',reviewSession.id)).filter(event=>event.type==='turn_completed').length
  await call('runNativeAction',reviewSession.id,{type:'review.start',draft:{scope:{type:'uncommittedChanges'},instructions:'Only report correctness regressions.'}})
  const reviewed=await waitFor(async()=>({session:(await call('listSessions')).find(row=>row.id===reviewSession.id),events:await call('getEvents',reviewSession.id)}),value=>{
    if(value.session.status==='error')throw new Error('native Review failed: '+JSON.stringify(value.events.filter(event=>event.type==='error')))
    return ['idle','completed'].includes(value.session.status)&&value.events.filter(event=>event.type==='turn_completed').length>reviewTurns
  },'native SDK Review')
  check('structured Review runs through the SDK and preserves native identity',reviewed.session.nativeSessionId===reviewReady.nativeSessionId)
  check('Review instructions reach this turn without changing the stored role',requests.some(request=>JSON.stringify(request.body.messages).includes('Only report correctness regressions.'))&&!reviewed.session.config.roleSnapshot)
  const parentEvents=JSON.stringify(await call('getEvents',session.id))
  check('Claude advertises an isolated side channel',await call('sideCanOpen',session.id))
  let sideReady
  for(const prompt of ['SDK_SIDE_FIRST','SDK_SIDE_SECOND']){
    const previous=(await call('getSideEvents',session.id)).filter(event=>event.type==='turn_completed').length
    await call('sendSideMessage',session.id,prompt)
    sideReady=await waitFor(async()=>({status:await call('getSideStatus',session.id),events:await call('getSideEvents',session.id)}),value=>{
      if(value.events.some(event=>event.type==='error'))throw new Error('native SDK side failed: '+JSON.stringify(value.events.filter(event=>event.type==='error')))
      return value.status==='idle'&&value.events.filter(event=>event.type==='turn_completed').length>previous
    },'SDK side turn')
  }
  check('SDK side turns preserve the main timeline',JSON.stringify(await call('getEvents',session.id))===parentEvents)
  let promoted
  try { promoted=await call('promoteSideToSession',session.id) }
  catch(error){
    await put(join(evidence,'side-promotion-failure.json'),JSON.stringify({before:sideReady,after:{status:await call('getSideStatus',session.id),events:await call('getSideEvents',session.id)}},null,2))
    throw error
  }
  check('side promotion creates a distinct native session',promoted.nativeSessionId&&promoted.nativeSessionId!==result.session.nativeSessionId)
  check('loopback model fixture completed without server error', !modelError, modelError)
}

async function saveEvidence(error) {
  await put(join(evidence, 'app-stderr.txt'), stderr)
  await put(join(evidence, 'model-requests.json'), JSON.stringify(requests, null, 2))
  await put(join(evidence, 'acceptance.json'), JSON.stringify({ checkedAt: new Date().toISOString(), appAsarSha256: sha256(await readFile(binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar'))), officialClaude, checks, error: error ? String(error.stack || error) : null, modelRequests: requests.length, mainRequests: mainCalls,
    scope: 'packaged SDK initialization, role instructions, tool/Skill policy, MCP hook denial, context/usage, report renderer, native Review, isolated side turns and promotion',
    boundaries: ['Finite skills make native Agent/Task unavailable; unrestricted child delegation is outside this verifier.', 'Plugin user uninstall/cache retention is outside this verifier; test/claude-plugin-management.ts owns its contract checks.', 'No real user configuration or user process is used.'] }, null, 2))
}
function cleanup() {
  return cleanupPromise ||= (async () => {
    ws?.close()
    try {
      await sweeper.sweep({ force: forceCleanup, shouldAbort: () => forceCleanup })
      if (forceCleanup) await sweeper.forceSweep()
    } finally {
      model.closeAllConnections()
      if (model.listening) await new Promise(done => model.close(done))
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      const remaining = await sweeper.ownedProcesses()
      await assert.rejects(access(fixture), { code: 'ENOENT' })
      await put(join(evidence, 'cleanup.json'), JSON.stringify({ fixtureRemoved: true, ownedProcessesRemaining: remaining.length, appExitCode: app?.exitCode, appSignalCode: app?.signalCode }, null, 2))
      assert.equal(remaining.length, 0, 'verifier-owned App and CLI processes must exit')
    }
  })()
}
const termination = createAcceptanceTerminationHandler({ cleanup, requestForceCleanup: () => { forceCleanup = true }, onFirstSignal: signal => console.error('Claude acceptance interrupted: ' + signal), onCleanupError: error => console.error(error), exit: code => process.exit(code) })
process.once('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.once('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))
try {
  await prepare(); await startApp(); await verifyRoleAndReports(); await saveEvidence()
  console.log('Claude packaged acceptance passed: ' + evidence)
} catch (error) {
  await saveEvidence(error); console.error('Claude packaged acceptance failed: ' + evidence); throw error
} finally { await cleanup() }
