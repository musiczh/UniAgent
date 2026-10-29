// Packaged App + real Claude CLI, isolated homes and local model servers only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve('release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok((await realpath(binary)).startsWith(await realpath(resolve('release')) + '/'))
const fixture = await mkdtemp(join(tmpdir(), 'ua-model-settings-packaged-'))
const home = join(fixture, 'home'), workdir = join(fixture, 'workspace'), data = join(fixture, 'data')
const evidence = resolve('.uniagent-artifacts/model-configuration-' + new Date().toISOString().replace(/[:.]/g, '-'))
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
const pending = new Map(), checks = [], requests = []
const modelBehavior = new Map()
const heldResponses = new Map()
let app, ws, serial = 0, stderr = '', lastTargets = []
const delay = ms => new Promise(done => setTimeout(done, ms))
async function put(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, value, { mode: 0o600 }) }
function check(label, condition) { assert.ok(condition, label); checks.push(label); console.log('✓ ' + label) }
async function wait(read, predicate, label, timeout = 60000) {
  const start = Date.now(); let progress = start
  while (Date.now() - start < timeout) {
    const value = await read(); if (predicate(value)) return value
    if (Date.now() - progress > 20000) { console.log('… ' + label); progress = Date.now() }
    await delay(150)
  }
  throw new Error('Timeout: ' + label)
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, 60000)
    pending.set(id, value => { clearTimeout(timer); resolve(value) }); ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (value.result?.exceptionDetails) throw new Error(value.result.exceptionDetails.exception?.description || 'renderer exception')
  return value.result.result.value
}
const call = (method, ...args) => evaluate(`window.uniagent.${method}(${args.map(arg => JSON.stringify(arg)).join(',')})`)
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw || '{}')
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":80}'); return }
  if (!request.url.includes('/messages')) { response.end('{}'); return }
  const toolResult = JSON.stringify(body.messages).includes('SOURCE_TOOL_FIXTURE')
  const useTool = body.stream && body.tools?.some(tool => tool.name === 'Read') && !toolResult
  const hold = modelBehavior.get(body.model) === 'hold', deny = modelBehavior.get(body.model) === 'deny'
  requests.push({ model: body.model, path: request.url, key: request.headers['x-api-key'] || request.headers.authorization, toolResult, hold, deny,
    effort: body.output_config?.effort, resumed: body.messages?.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('PACKAGED_SOURCE_OK')) })
  if (deny) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Fixture credential rejected' } })); return }
  if (hold) {
    await new Promise(done => { heldResponses.set(body.model, done); response.on('close', done) })
    heldResponses.delete(body.model)
    if (response.destroyed) return
  }
  const message = { id: `msg_test_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'PACKAGED_SOURCE_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 80, output_tokens: 8 } }
  if (useTool) { message.content = [{ type: 'tool_use', id: 'toolu_fixture_read', name: 'Read', input: { file_path: join(workdir, 'source-fixture.txt') } }]; message.stop_reason = 'tool_use' }
  if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
  response.setHeader('content-type', 'text/event-stream')
  for (const frame of [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: useTool ? { type: 'tool_use', id: 'toolu_fixture_read', name: 'Read', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: useTool ? { type: 'input_json_delta', partial_json: JSON.stringify(message.content[0].input) } : { type: 'text_delta', text: 'PACKAGED_SOURCE_OK' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 8 } }, { type: 'message_stop' }]) {
    response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
  }
  response.end()
})
try {
  for (const directory of [home, workdir, data, join(fixture, 'bin')]) await mkdir(directory, { recursive: true })
  await put(join(workdir, 'source-fixture.txt'), 'SOURCE_TOOL_FIXTURE\n')
  await symlink(await realpath(join(homedir(), '.local/bin/claude')), join(fixture, 'bin/claude'))
  await put(join(home, '.kimi-code/config.toml'), '[providers.code]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\napi_key="fixture-import-key"\n[models.alias]\nprovider="code"\nmodel="k3"\n')
  await new Promise(done => model.listen(0, '127.0.0.1', done))
  const portServer = createPortServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done))
  const port = portServer.address().port; await new Promise(done => portServer.close(done))
  const env = { PATH: join(fixture, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USERPROFILE: home, SHELL: '/usr/bin/false', LANG: 'en_US.UTF-8',
    UNIAGENT_USER_DATA: data, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), KIMI_CODE_HOME: join(home, '.kimi-code'), KIMI_HOME: join(home, '.kimi'), TRAE_HOME: join(home, '.trae'), GROK_HOME: join(home, '.grok'),
    XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), XDG_RUNTIME_DIR: join(fixture, 'runtime'),
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'), ZDOTDIR: join(fixture, 'zsh'), GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null',
    NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  await mkdir(env.TMPDIR, { recursive: true }); await put(env.GIT_CONFIG_GLOBAL, ''); await put(env.NPM_CONFIG_USERCONFIG, '')
  app = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  await sweeper.addRoot(app.pid); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000) })
  const renderer = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
  const rows = await wait(async () => {
    if (app.exitCode !== null) throw new Error('App exited: ' + stderr)
    try { lastTargets = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) }).then(value => value.json()); return lastTargets } catch { return [] }
  }, rows => rows.some(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer), 'packaged renderer')
  ws = new WebSocket(rows.find(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer).webSocketDebuggerUrl)
  ws.onmessage = event => { const value = JSON.parse(event.data); const callback = pending.get(value.id); if (callback) { pending.delete(value.id); callback(value) } }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await wait(() => evaluate('typeof window.uniagent?.getClaudeSources === "function"'), Boolean, 'preload')
  await wait(() => call('getLifecycleSnapshot'), rows => rows.some(row => row.id === 'claude' && row.lifecycle?.availability === 'needs-auth'), 'unconfigured official account')
  await call('setAppSettings', { enabledAgentIds: ['claude'] })
  const candidates = await call('listModelCredentials', 'claude')
  check('Kimi Agent API Key detected without exposing it', candidates.length === 1 && !JSON.stringify(candidates).includes('fixture-import-key'))
  const imported = await call('importModelCredential', 'claude', candidates[0])
  check('one-click copy creates encrypted Claude source', imported.sources.some(source => source.id === 'kimi' && source.hasKey))
  await assert.rejects(call('importModelCredential', 'claude', candidates[0]), /已有配置/)
  check('duplicate copy requires editable reimport', true)
  const sources = [
    { id: 'kimi', preset: 'kimi-code', enabled: true, baseUrl: `http://127.0.0.1:${model.address().port}/kimi`, models: ['k3', 'k3-256k'], apiKey: 'fixture-kimi-key' },
    { id: 'deepseek', preset: 'deepseek', enabled: true, baseUrl: `http://127.0.0.1:${model.address().port}/deepseek`, models: ['deepseek-flash'], apiKey: 'fixture-deepseek-key' }
  ]
  for (const source of sources) { await call('saveClaudeSource', source); await call('testClaudeSource', source) }
  const claude = (await call('getLifecycleSnapshot')).find(agent => agent.id === 'claude')
  check('third-party sources enable healthy CLI without official login', claude.lifecycle.availability === 'available' && claude.lifecycle.auth === 'unknown')
  check('both providers appear in Claude model selector', sources.every(source => claude.models.some(item => item.modelSource?.sourceId === source.id)))
  check('third-party models expose actual effort levels', claude.models.filter(item => item.modelSource?.kind === 'third-party').every(item => JSON.stringify(item.efforts) === JSON.stringify(['low', 'high', 'max'])))
  // Provisioning through IPC bypasses App's local enabled-agent settings state.
  // Reload the isolated renderer so its first-run selection sees the saved settings.
  await cdp('Page.reload')
  const openPicker = async root => {
    await wait(() => evaluate('document.getElementById("ua-startup")?.hidden === true'), Boolean, 'startup transition completed')
    await wait(() => evaluate(`!!document.querySelector(${JSON.stringify(root)} + ' .sb-agent')`), Boolean, 'model picker')
    await evaluate(`document.querySelector(${JSON.stringify(root)} + ' .sb-agent').open = true`)
  }
  const openSubmenu = async (root, label) => {
    const selector = JSON.stringify(root + ' .sb-sub-entry')
    await wait(() => evaluate(`[...document.querySelectorAll(${selector})].some(node => node.innerText.startsWith(${JSON.stringify(label)}) && !node.disabled)`), Boolean, label + ' enabled')
    await evaluate(`[...document.querySelectorAll(${selector})].find(node => node.innerText.startsWith(${JSON.stringify(label)})).click()`)
  }
  const chooseOption = async (root, label) => {
    const selector = JSON.stringify(root + ' [role=option]')
    await wait(() => evaluate(`[...document.querySelectorAll(${selector})].some(node => node.innerText.trim() === ${JSON.stringify(label)} && !node.disabled && node.getBoundingClientRect().height > 0)`), Boolean, label + ' option')
    await evaluate(`[...document.querySelectorAll(${selector})].find(node => node.innerText.trim() === ${JSON.stringify(label)} && node.getBoundingClientRect().height > 0).click()`)
  }
  await openPicker('.new-task')
  await openSubmenu('.new-task', 'Agent')
  await wait(() => evaluate('!![...document.querySelectorAll(".sb-agent-name-label")].find(node => node.textContent.trim() === "Claude Code")'), Boolean, 'Claude agent option')
  await evaluate('[...document.querySelectorAll(".sb-agent-name-label")].find(node => node.textContent.trim() === "Claude Code").closest("button").click()')
  await openSubmenu('.new-task', '模型')
  await chooseOption('.new-task', 'DeepSeek · deepseek-flash')
  await openSubmenu('.new-task', '推理强度')
  await chooseOption('.new-task', '最大')
  check('new-task UI lets DeepSeek select Max effort', await evaluate('document.querySelector(".new-task .sb-agent").dataset.effort === "max"'))
  const effortScreenshot = await cdp('Page.captureScreenshot', { format: 'png' }); await put(join(evidence, 'claude-third-party-effort.png'), Buffer.from(effortScreenshot.result.data, 'base64'))
  await evaluate('document.querySelector(".new-task .sb-agent").open = false')
  const project = await call('createProject', { name: 'Model sources acceptance', primaryDirectory: workdir, additionalDirectories: [] })
  const sessions = await Promise.all(sources.map(source => call('createSession', { agentId: 'claude', projectId: project.id, workdir, permissionMode: 'full-access',
    model: `uniagent-model:third-party:${source.id}:${source.models[0]}`, modelSource: { kind: 'third-party', sourceId: source.id }, effort: 'high' }, 'Return PACKAGED_SOURCE_OK.')))
  const finished = async (session, afterSeq = 0) => wait(async () => ({ session: (await call('listSessions')).find(item => item.id === session.id), events: await call('getEvents', session.id) }), value => {
    if (value.session.status === 'error') throw new Error(JSON.stringify(value.events.filter(event => event.type === 'error')))
    return ['idle', 'completed'].includes(value.session.status) && value.events.some(event => event.seq > afterSeq && event.type === 'agent_message' && event.payload.text?.includes('PACKAGED_SOURCE_OK'))
  }, 'provider turn')
  const sendAndFinish = async (session, prompt) => {
    const afterSeq = (await call('getEvents', session.id)).at(-1)?.seq || 0
    await call('sendMessage', session.id, prompt)
    return finished(session, afterSeq)
  }
  await Promise.all(sessions.map(session => finished(session)))
  check('packaged App completes concurrent Kimi and DeepSeek turns', true)
  check('native tools execute and return results to both providers', sources.every(source => requests.some(request => request.path.startsWith('/' + source.id + '/') && request.toolResult)))
  await sendAndFinish(sessions[0], 'Again return PACKAGED_SOURCE_OK.')
  check('same-provider native session resumes', true)
  // The fixture created sessions through IPC rather than App.handleCreate.
  await cdp('Page.reload')
  await wait(async () => { try { return await evaluate(`!!document.querySelector('[data-session-id="${sessions[0].id}"]')`) } catch { return false } }, Boolean, 'provisioned sessions loaded')
  for (const [index, target] of [[0, 1], [1, 0]]) {
    const session = sessions[index], current = (await call('listSessions')).find(item => item.id === session.id)
    const patch = { model: `uniagent-model:third-party:${sources[target].id}:${sources[target].models[0]}`, effort: 'low' }
    const before = requests.length
    modelBehavior.set(sources[index].models[0], 'hold')
    await call('sendMessage', session.id, 'HOLD_SWITCH_TEST')
    await wait(async () => {
      const state = (await call('listSessions')).find(item => item.id === session.id)
      if (state.status === 'error') throw new Error(JSON.stringify((await call('getEvents', session.id)).filter(event => event.type === 'error')))
      return requests.slice(before).some(request => request.hold)
    }, Boolean, 'held provider stream')
    await wait(() => evaluate(`(() => { const row = document.querySelector('[data-session-id="${session.id}"]'); row?.click(); return !!row })()`), Boolean, 'select running session')
    await openPicker('.composer-wrap')
    await openSubmenu('.composer-wrap', '模型')
    await chooseOption('.composer-wrap', (target === 0 ? 'Kimi · ' : 'DeepSeek · ') + sources[target].models[0])
    await wait(async () => (await call('listSessions')).find(item => item.id === session.id), value => value.config.model === patch.model, 'UI-selected model committed')
    await openPicker('.composer-wrap')
    await openSubmenu('.composer-wrap', '推理强度')
    await chooseOption('.composer-wrap', '低')
    const busy = await wait(async () => (await call('listSessions')).find(item => item.id === session.id), value => value.config.model === patch.model && value.config.effort === 'low', 'UI-selected next-turn model')
    check(sources[index].id + ': model selection during generation applies to next turn', busy.config.model === patch.model && busy.status === 'running')
    check(sources[index].id + ': in-flight request retains its original provider and effort', requests.slice(before).every(request => request.model === sources[index].models[0] && request.effort === 'high'))
    modelBehavior.delete(sources[index].models[0])
    if (index === 0) {
      const afterSeq = (await call('getEvents', session.id)).at(-1)?.seq || 0
      await call('sendMessage', session.id, 'Queued follow-up: return PACKAGED_SOURCE_OK.')
      heldResponses.get(sources[index].models[0])()
      await finished(session, afterSeq)
      await wait(async () => requests.slice(before).some(request => request.model === sources[target].models[0] && request.effort === 'low' && request.resumed), Boolean, 'queued turn uses selected model')
      await wait(async () => (await call('listSessions')).find(item => item.id === session.id), value => ['idle', 'completed'].includes(value.status), 'queued turn completed')
      check('queued next turn uses newly selected provider, effort and native history', true)
    } else await call('interrupt', session.id)
    const stopped = await wait(async () => (await call('listSessions')).find(item => item.id === session.id), value => !['running', 'queued', 'cancelling', 'awaiting-approval'].includes(value.status), 'stream interrupted')
    check(sources[index].id + ': completion or cancellation preserves native session', stopped.nativeSessionId === current.nativeSessionId)
    const resumedStart = requests.length
    await sendAndFinish(session, 'Again return PACKAGED_SOURCE_OK.')
    check(sources[index].id + ': cross-provider resume preserves history and effort', requests.slice(resumedStart).some(request => request.model === sources[target].models[0] && request.effort === 'low' && request.resumed))
    await call('updateSessionConfig', session.id, { model: current.config.model, effort: 'max' })
    const backStart = requests.length
    await sendAndFinish(session, 'Again return PACKAGED_SOURCE_OK.')
    check(sources[index].id + ': switch back preserves native identity and sends max effort', (await call('listSessions')).find(item => item.id === session.id).nativeSessionId === current.nativeSessionId && requests.slice(backStart).some(request => request.model === sources[index].models[0] && request.effort === 'max'))
  }
  await call('updateSessionConfig', sessions[0].id, { model: 'uniagent-model:third-party:kimi:k3-256k' })
  const sameProviderStart = requests.length
  await sendAndFinish(sessions[0], 'Again return PACKAGED_SOURCE_OK.')
  check('Kimi model switch applies to the next resumed request', requests.slice(sameProviderStart).some(request => request.model === 'k3-256k'))
  modelBehavior.set('deepseek-flash', 'deny')
  await call('sendMessage', sessions[1].id, 'DENY_SWITCH_TEST')
  await wait(async () => (await call('listSessions')).find(item => item.id === sessions[1].id), value => value.status === 'error', '401 failed turn')
  modelBehavior.delete('deepseek-flash')
  await call('updateSessionConfig', sessions[1].id, { model: 'uniagent-model:third-party:kimi:k3', effort: 'high' })
  await sendAndFinish(sessions[1], 'Again return PACKAGED_SOURCE_OK.')
  check('switching away from a failed provider recovers the original conversation', true)
  for (const request of requests) check('request stays on its selected provider', request.path.startsWith('/kimi/') ? ['k3', 'k3-256k'].includes(request.model) && request.key === 'fixture-kimi-key' : request.model === 'deepseek-flash' && request.key === 'Bearer fixture-deepseek-key')
  await evaluate('document.querySelector("[title=设置]")?.click()')
  await wait(() => evaluate('([...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="模型配置")?.click(),!!document.querySelector("[aria-label=Agent]"))'), Boolean, 'unified settings page')
  const text = await wait(() => evaluate('document.querySelector(".settings-inner")?.innerText || ""'), value => value.includes('DeepSeek') && value.includes('Kimi'), 'provider cards')
  check('packaged UI has unified tabs and no default or native-config items', text.includes('Claude Code') && text.includes('Codex') && !/默认配置|原有 Claude 配置|原有 Codex 配置/.test(text))
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); await put(join(evidence, 'model-configuration.png'), Buffer.from(screenshot.result.data, 'base64'))
  await evaluate('[...document.querySelectorAll("[role=tab]")].find(node=>node.textContent.trim()==="Codex")?.click()')
  await wait(() => evaluate('document.querySelector(".settings-inner")?.innerText || ""'), value => value.includes('启动服务') && value.includes('GLM'), 'Codex service and providers')
  check('Codex service controls are above vendor rows', await evaluate('(() => {const button=[...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="启动服务");const row=[...document.querySelectorAll(".row")].find(node=>node.innerText.includes("Kimi"));return button.getBoundingClientRect().top<row.getBoundingClientRect().top})()'))
  const codexScreenshot = await cdp('Page.captureScreenshot', { format: 'png' }); await put(join(evidence, 'codex-model-configuration.png'), Buffer.from(codexScreenshot.result.data, 'base64'))
  const stored = await readFile(join(data, 'claude-sources/settings.json'), 'utf8')
  check('stored sources contain no plaintext keys', sources.every(source => !stored.includes(source.apiKey)))
  await put(join(evidence, 'acceptance.json'), JSON.stringify({ checks, requests: requests.length, officialCalls: 0 }, null, 2))
  console.log('Packaged model configuration acceptance passed')
} catch (error) {
  console.error(JSON.stringify({ error: String(error), targets: lastTargets.map(row => ({ type: row.type, url: row.url })), stderr: stderr.slice(-4000) })); throw error
} finally {
  ws?.close(); await sweeper.sweep(); model.closeAllConnections()
  if (model.listening) await new Promise(done => model.close(done))
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  assert.equal((await sweeper.ownedProcesses()).length, 0)
}
