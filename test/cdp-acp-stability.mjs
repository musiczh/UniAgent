// Real installed CLIs, loopback model responses, and the current packaged renderer.
// Usage: node test/cdp-acp-stability.mjs [release/.../Contents/MacOS/UniAgent Public]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import TOML from '@iarna/toml'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/') && binary.endsWith('/Contents/MacOS/UniAgent Public'), 'only repository release App is allowed')
const renderer = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
const fixture = await mkdtemp(join(tmpdir(), 'ua-beta-packaged-'))
const home = join(fixture, 'home'), data = join(fixture, 'data'), workdir = join(fixture, 'workspace')
const evidence = resolve('.uniagent-artifacts', 'acp-stable-packaged-' + new Date().toISOString().replace(/[:.]/g, '-'))
const readMarker = 'UA_BETA_FILE_READ_7182'
const inputFile = join(workdir, 'read-proof.txt')
const agentIds = ['deepseek', 'kimi', 'grok']
const checks = [], models = new Map(), sessions = new Map()
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let child, ws, serial = 0, stderr = '', cleanupPromise, forceCleanup = false
const pending = new Map()
const delay = ms => new Promise(done => setTimeout(done, ms))
const sha256 = value => createHash('sha256').update(value).digest('hex')
function check(label, value, detail) {
  assert.ok(value, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)))
  checks.push(label)
  console.log('✓ ' + label)
}
async function put(file, contents) {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  await writeFile(file, contents, { mode: 0o600 })
}
async function waitFor(read, predicate, label, timeout = 90000) {
  const start = Date.now(); let last, reported = start
  while (Date.now() - start < timeout) {
    last = await read()
    if (predicate(last)) return last
    if (Date.now() - reported > 25000) { console.log('… waiting: ' + label); reported = Date.now() }
    await delay(250)
  }
  throw new Error(label + ' timed out: ' + JSON.stringify(last))
}
function cdp(method, params = {}, timeout = 60000) {
  return new Promise((resolveRequest, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeout)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveRequest(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.error || reply.result?.exceptionDetails) throw new Error(reply.result?.exceptionDetails?.exception?.description || JSON.stringify(reply.error))
  return reply.result.result.value
}
const call = (method, ...args) => evaluate('window.uniagent.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')')
const dom = source => evaluate('(async () => {' + source + '})()')
async function click(selector, text) {
  assert.ok(await dom(`const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => !node.closest('[hidden]') && ${text === undefined ? 'true' : `node.textContent.includes(${JSON.stringify(text)})`}); node?.click(); return !!node;`), 'missing control ' + selector + ' ' + (text || ''))
}
async function select(label, value) {
  assert.ok(await dom(`const node = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); if (!node || node.disabled || ![...node.options].some(option => option.value === ${JSON.stringify(value)} && !option.disabled)) return false; node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', {bubbles:true})); return true;`), 'select unavailable: ' + label + ' ' + value)
}
async function input(selector, value) {
  assert.ok(await dom(`const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) return false; const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', {bubbles:true})); return true;`), 'input unavailable: ' + selector)
}
async function screenshot(name) {
  const result = await cdp('Page.captureScreenshot', { format: 'png' }, 10000)
  await put(join(evidence, name + '.png'), Buffer.from(result.result.data, 'base64'))
}
async function waitTurn(id, marker, afterSeq = -1) {
  const result = await waitFor(async () => ({ state: (await call('listSessions')).find(session => session.id === id), events: await call('getEvents', id) }), result => {
    const latest = result.events.filter(event => event.seq > afterSeq)
    if (result.state?.status === 'error' || latest.some(event => event.type === 'error')) throw new Error(marker + ' failed: ' + JSON.stringify(latest.filter(event => event.type === 'error')))
    return ['idle', 'completed'].includes(result.state?.status) && latest.some(event => event.type === 'turn_completed' && event.state === 'success') && latest.some(event => event.type === 'agent_message' && event.payload.text?.includes(marker))
  }, marker)
  await put(join(evidence, id + '-events.json'), JSON.stringify(result, null, 2))
  return result
}

function toolResponse(agentId) {
  const name = { deepseek: 'read', kimi: 'Read', grok: 'read_file' }[agentId]
  const args = agentId === 'grok' ? { target_file: inputFile } : agentId === 'kimi' ? { path: inputFile } : { file_path: inputFile }
  return { name, args }
}
function openaiSSE(model, value, finish) {
  return 'data: ' + JSON.stringify({ id: 'ua-beta-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n'
}
function anthropicSSE(model, tool, text) {
  const frames = [
    { type: 'message_start', message: { id: 'ua-beta-fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'ua-beta-read', name: tool.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } },
    { type: 'message_stop' }
  ]
  return frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join('')
}
async function startModel(agentId) {
  const capture = { requests: [], mainRequests: [], goalRequests: [], readIssued: false, error: null }
  const heldResponses = new Set()
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      if (!Array.isArray(body.messages)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'ua-beta-local', object: 'model', context_window: 200000 }] }))
        return
      }
      const main = JSON.stringify(body.messages).includes('UA_STABLE_INITIAL_' + agentId)
      const row = { path: req.url, body, main }
      capture.requests.push(row)
      if (main) capture.mainRequests.push(row)
      if (capture.holdEnabled !== false && JSON.stringify(body.messages.filter(x=>x.role==='user')).includes('UA_STABLE_HOLD_' + agentId)) {
        capture.held = (capture.held || 0) + 1
        heldResponses.add(res)
        res.on('close', () => heldResponses.delete(res))
        return
      }
      const tool = main && !capture.readIssued ? toolResponse(agentId) : undefined
      if (tool) capture.readIssued = true
      const text = main ? 'UA_STABLE_DONE_' + agentId : 'fixture background summary'
      const response = agentId === 'deepseek' ? anthropicSSE(body.model, tool, text) : openaiSSE(body.model,
        tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ua-beta-read', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: text }, tool ? 'tool_calls' : 'stop')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(response)
    } catch (error) {
      capture.error = String(error)
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture failed' } }))
    }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  const model = { server, capture, baseUrl:'http://127.0.0.1:' + port, releaseAllGoals:() => { for (const res of heldResponses) res.end(); heldResponses.clear() } }
  models.set(agentId, model)
  return model
}
// Actual installed CLIs and isolated native configuration; model traffic uses loopback.
async function prepare() {
  await chmod(fixture, 0o700)
  for (const directory of [home, data, workdir, evidence, join(home, 'Library'), ...['tmp', 'chromium', 'config', 'xdg-data', 'cache', 'state', 'runtime', 'npm-cache'].map(name => join(fixture, name))]) await mkdir(directory, { recursive: true, mode: 0o700 })
  await put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, autoCheckUpdate: false, enabledAgentIds: ['codex', 'traex', 'claude', ...agentIds] }))
  await put(inputFile, readMarker + '\n')
  for (const name of ['alpha', 'beta']) await put(join(workdir, '.agents/skills', 'ua-beta-' + name, 'SKILL.md'), `---\nname: ua-beta-${name}\ndescription: UA_BETA_SKILL_${name.toUpperCase()}\n---\n${name} fixture\n`)
  const runtime = join(data, 'deepseek/runtime-0.2.1-rc.2')
  const sourceRuntime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || join(homedir(), 'Library/Application Support/UniAgent/deepseek/runtime-0.2.1-rc.2')
  await access(join(sourceRuntime, 'node_modules/.bin/dsh'))
  await mkdir(runtime, { recursive: true })
  await symlink(await realpath(join(sourceRuntime, 'node_modules')), join(runtime, 'node_modules'), 'dir')
  for (const id of agentIds) await startModel(id)
  await put(join(home, '.kimi-code/config.toml'), TOML.stringify({ default_model: 'ua-beta-local', telemetry: false, watch: { enabled: false }, models: { 'ua-beta-local': { provider:'ua-beta-loopback', name:'ua-beta-local', max_context_size:200000 } }, providers: { 'ua-beta-loopback': { type:'openai', base_url:models.get('kimi').baseUrl + '/v1', api_key:'fixture-kimi-key' } } }))
  await put(join(home, '.grok/config.toml'), TOML.stringify({ cli: { use_leader: false }, features: { managed_config: false }, managed_mcps: { enabled: false }, models: { default: 'ua-beta-local' }, model: { 'ua-beta-local': { model: 'ua-beta-local', base_url: models.get('grok').baseUrl + '/v1', api_key: 'fixture-grok-key', api_backend: 'chat_completions', agent_type: 'grok-build', max_retries: 0, context_window: 200000 } } }))
  await put(join(fixture, 'gitconfig'), '')
  await put(join(fixture, 'npmrc'), '')
}
async function startApp() {
  const portServer = createPortServer()
  await new Promise(done => portServer.listen(0, '127.0.0.1', done))
  const port = portServer.address().port
  await new Promise(done => portServer.close(done))
  const env = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, USER: 'ua-beta-test', LOGNAME: 'ua-beta-test',
    UNIAGENT_USER_DATA: data, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_CODE_HOME: join(home, '.kimi-code'), KIMI_HOME: join(home, '.kimi'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
    DEEPSEEK_API_KEY: 'fixture-deepseek-key', DEEPSEEK_BASE_URL: models.get('deepseek').baseUrl + '/anthropic', XAI_API_KEY: 'fixture-grok-key', GROK_SUBAGENTS: '0', DSH_TELEMETRY_MODE: 'DISABLED',
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg-data'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), XDG_RUNTIME_DIR: join(fixture, 'runtime'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1'
  }
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.on('error', error => { stderr += String(error) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000) })
  await sweeper.addRoot(child.pid)
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('App exited during startup: ' + stderr)
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) }).then(response => response.json()) } catch { return [] }
  }, targets => targets.some(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer), 'exact packaged renderer', 45000)
  const target = targets.find(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (request) { pending.delete(message.id); request.resolve(message) } }
  ws.onclose = () => { for (const request of pending.values()) request.reject(new Error('CDP disconnected')); pending.clear() }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await waitFor(async () => { try { return await call('getLifecycleSnapshot') } catch (error) { if (/Execution context was destroyed|Cannot find context/.test(String(error))) return null; throw error } }, Boolean, 'preload ready')
  check('exact release renderer and public bridge', await evaluate('document.title === "UniAgent Public" && typeof window.uniagent.createSession === "function"'))
}
async function saveEvidence(error) {
  await put(join(evidence, 'app-stderr.txt'), stderr)
  for (const [id, model] of models) await put(join(evidence, id + '-model-requests.json'), JSON.stringify(model.capture, null, 2))
  await put(join(evidence, 'acceptance.json'), JSON.stringify({ checkedAt: new Date().toISOString(), appAsarSha256: sha256(await readFile(binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar'))), checks, error: error ? String(error.stack || error) : null, modelRequests: Object.fromEntries([...models].map(([id, model]) => [id, { all: model.capture.requests.length, main: model.capture.mainRequests.length }])) }, null, 2))
}
function cleanup() {
  return cleanupPromise ||= (async () => {
    ws?.close()
    await sweeper.sweep({ force: forceCleanup, shouldAbort: () => forceCleanup })
    if (forceCleanup) await sweeper.forceSweep()
    for (const model of models.values()) { model.releaseAllGoals(); model.server.closeAllConnections(); await new Promise(done => model.server.close(done)) }
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  })()
}
const termination = createAcceptanceTerminationHandler({ cleanup, requestForceCleanup: () => { forceCleanup = true }, onFirstSignal: signal => console.error('Acceptance interrupted: ' + signal), onCleanupError: error => console.error(error), exit: code => process.exit(code) })
process.once('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.once('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))

try {
  await prepare()
  await startApp()
  await waitFor(()=>call('getLifecycleSnapshot'), rows=>agentIds.every(id=>rows.some(agent=>agent.id===id&&agent.lifecycle)), 'startup protocol detection settles')
  const agents = await call('detectAgents')
  const grokQuota = await call('getGrokQuota', true)
  check('Grok account quota reports missing login', grokQuota?.status === 'needs-auth', grokQuota)
  await click('.quota-entry')
  await waitFor(() => dom('return document.querySelector(".quota-pop")?.textContent || ""'), text => text.includes('Grok') && text.includes('请先登录 Grok 后刷新额度'), 'Grok quota login hint is visible')
  check('Grok quota stays visible without account data', true)
  await click('.quota-entry')
  await put(join(evidence,'detected-agents.json'),JSON.stringify(agents,null,2))
  for (const id of agentIds) {
    const agent = agents.find(a=>a.id===id)
    check(id + ' actual CLI accepts stable ACP',agent?.installed&&!agent.incompatible&&!agent.authenticationRequired,agent)
    check(id + ' extensions disabled', ['sessionFork','sideChat','steer','nativeGoal','structuredSubagents','capabilityInventory'].every(key=>agent.capabilities[key]===false),agent.capabilities)
  }
  await click('.settings-entry')
  await click('.set-nav-item','工具能力')
  await waitFor(()=>dom('return document.body.innerText'),text=>text.includes('工具能力'),'capability panel')
  for (const id of agentIds) {
    await click('.cap-agent-card',id==='deepseek'?'DeepSeek':id==='kimi'?'Kimi':'Grok')
    check(id+' native management explains stable boundary',(await dom('return document.body.innerText')).includes('稳定 ACP'))
    check(id+' inventory has no native management', (await call('capabilityInventoryList')).inventories.find(x=>x.agentId===id)?.managementSupported===false)
  }
  await screenshot('stable-capabilities')
  await click('.set-nav-item','角色')
  await click('.set-add-btn','添加角色')
  for (const id of agentIds) {
    await select('角色 Agent',id)
    check(id+' role editor shows stable support',(await dom('return document.body.innerText')).includes('稳定 ACP 仅支持'))
    check(id+' role restrictions disabled',await dom(`return [...document.querySelectorAll('select[aria-label="角色工具策略"] option')].filter(x=>x.value!=='inherit').every(x=>x.disabled)`))
  }
  await screenshot('stable-role')
  const inventories = await call('capabilityInventoryList')
  check('non-beta inventories remain available', ['codex','traex','claude'].every(id=>inventories.inventories.some(x=>x.agentId===id)))
  for (const id of agentIds) {
    const agent = agents.find(a=>a.id===id), model = id==='deepseek'?agent.models.find(m=>m.id.includes('flash')):agent.models.find(m=>m.id==='ua-beta-local')
    check(id+' model catalog preserved',!!model,agent.models)
    const config={agentId:id,model:model.id,workdir,permissionMode:'full-access'}
    const session=await call('createSession',config,'UA_STABLE_INITIAL_'+id+': read the proof file and reply with marker.')
    sessions.set(id,session.id)
    const result=await waitTurn(session.id,'UA_STABLE_DONE_'+id)
    check(id+' standard response completes',result.events.some(e=>e.type==='agent_message'&&e.payload.text?.includes('UA_STABLE_DONE_'+id)))
    check(id+' tool reads actual file',result.events.some(e=>['tool_call','command_exec'].includes(e.type)&&JSON.stringify(e.payload).includes(readMarker)),result.events.filter(e=>e.type==='tool_call'))
    check(id+' native identity persisted',!!result.state.nativeSessionId)
    await assert.rejects(call('createSession',{...config,roleSnapshot:{id:'unsupported-'+id,name:'Restricted',agentId:id,permissionMode:'full-access',instructions:'DO_NOT_IGNORE',toolPolicy:{mode:'allow-only',tools:[]}}},'must never run'),/稳定 ACP/)
    check(id+' unsupported role rejected before model call',true)
    await assert.rejects(call('updateSessionConfig',session.id,{permissionMode:'read-only'}),/权限|unsupported/)
    check(id+' readonly does not silently broaden',true)
    const lastSeq=Math.max(...result.events.map(e=>e.seq))
    await call('sendMessage',session.id,'second ordinary turn')
    const continued=await waitTurn(session.id,'UA_STABLE_DONE_'+id,lastSeq)
    check(id+' second turn reuses native session',continued.state.nativeSessionId===result.state.nativeSessionId)
    const held = await call('createSession',config,'UA_STABLE_HOLD_'+id)
    await waitFor(()=>models.get(id).capture.held,Boolean,id+' real CLI has pending model turn')
    await call('interrupt',held.id)
    const cancelled=await waitFor(async()=>({state:(await call('listSessions')).find(x=>x.id===held.id),events:await call('getEvents',held.id)}),x=>x.state.status==='idle'&&x.events.some(e=>e.type==='turn_completed'&&e.state==='cancelled'),id+' cancel settles',20000)
    check(id+' real CLI cancellation settles',cancelled.state.status==='idle')
    // Native CLIs can merge successive user prompts into one content array.
    // Stop withholding responses after the deliberately cancelled turn.
    models.get(id).capture.holdEnabled = false
    models.get(id).releaseAllGoals()
    const afterCancel=Math.max(...cancelled.events.map(e=>e.seq))
    await call('sendMessage',held.id,'UA_STABLE_INITIAL_'+id+': continue after cancel')
    const restarted=await waitTurn(held.id,'UA_STABLE_DONE_'+id,afterCancel)
    check(id+' cancelled session accepts another turn',restarted.state.nativeSessionId===cancelled.state.nativeSessionId)
    const preset=await call('createSession',{...config,roleSnapshot:{id:'preset-'+id,name:'Parameter preset',agentId:id,model:model.id,permissionMode:'full-access'}},'UA_STABLE_INITIAL_'+id+': role parameter preset')
    const presetResult=await waitTurn(preset.id,'UA_STABLE_DONE_'+id)
    check(id+' parameter role runs with exact model',presetResult.state.config.model===model.id&&presetResult.state.config.roleSnapshot.model===model.id)


  }
  // Reopen the same isolated packaged App and native stores.
  ws.close(); await sweeper.sweep({force:false}); child=undefined; ws=undefined
  await startApp()
  for (const id of agentIds) {
    const sessionId=sessions.get(id), previous=(await call('listSessions')).find(s=>s.id===sessionId), events=await call('getEvents',sessionId), after=Math.max(...events.map(e=>e.seq))
    await call('sendMessage',sessionId,'continue after packaged app restart')
    const result=await waitTurn(sessionId,'UA_STABLE_DONE_'+id,after)
    check(id+' cold resume preserves exact native identity',result.state.nativeSessionId===previous.nativeSessionId)
  }
  await saveEvidence()
  console.log('Stable ACP packaged acceptance passed: '+checks.length+' checks; evidence: '+evidence)
} catch (error) {
  console.error(error)
  try { if (ws?.readyState === WebSocket.OPEN) await screenshot('failure') } catch {}
  try { await saveEvidence(error) } catch (evidenceError) { console.error('Evidence save failed:', evidenceError) }
  console.error('Failure evidence: ' + evidence)
  process.exitCode = 1
} finally {
  try { await cleanup() } catch (error) { console.error('Acceptance cleanup failed:', error); process.exitCode = 1 }
}
