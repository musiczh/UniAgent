import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/') && binary.endsWith('/Contents/MacOS/UniAgent Public'))
assert.ok(isAbsolute(process.env.ZCODE_TEST_RUNTIME_CONFIG || ''), 'Set ZCODE_TEST_RUNTIME_CONFIG to the verified official runtime')
const prepared = JSON.parse(await readFile(process.env.ZCODE_TEST_RUNTIME_CONFIG, 'utf8'))
const root = await mkdtemp('/tmp/uz-cdp-'), data = join(root, 'data'), home = join(root, 'home'), workdir = join(root, 'workspace')
const evidence = resolve('release/verification/zcode-initialization')
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let child, ws, serial = 0, calls = 0
const pending = new Map(), checks = []
const model = createServer(async (req, res) => {
  let text = ''
  for await (const part of req) text += part
  const input = JSON.parse(text); calls++
  const common = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'ZCODE_PACKAGED_OK' }, finish_reason: null }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\n')
  res.end('data: [DONE]\n\n')
})
const waitFor = async (read, predicate, label, timeout = 60000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)) }
  throw new Error(label + ' timed out')
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')) }, 60000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.error || response.result?.exceptionDetails) throw new Error(response.result?.exceptionDetails?.exception?.description || JSON.stringify(response.error))
  return response.result.result.value
}
const call = (method, ...args) => evaluate(`window.uniagent.${method}(${args.map(arg => JSON.stringify(arg)).join(',')})`)
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('✓ ' + label) }
async function clickButton(label) {
  await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`), Boolean, label)
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`)
}
async function startApp() {
  const portServer = createPortServer()
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
  const port = portServer.address().port
  await new Promise(resolve => portServer.close(resolve))
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home,
    USER: 'zcode-test', LOGNAME: 'zcode-test', UNIAGENT_USER_DATA: data, UA_DISABLE_GPU: '1',
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_CODE_HOME: join(home, '.kimi-code'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(root, 'npmrc'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data') }
  child = spawn(binary, ['--ua-e2e', `--remote-debugging-port=${port}`, `--user-data-dir=${join(root, 'chromium')}`], { env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  await sweeper.addRoot(child.pid)
  const expected = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('Isolated packaged App exited')
    try { return await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) }).then(response => response.json()) } catch { return [] }
  }, rows => rows.some(row => row.type === 'page' && decodeURIComponent(row.url).endsWith(expected)), 'renderer')
  ws = new WebSocket(targets.find(row => row.type === 'page' && decodeURIComponent(row.url).endsWith(expected)).webSocketDebuggerUrl)
  ws.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.resolve(message); pending.delete(message.id) }
  ws.onclose = () => { for (const value of pending.values()) value.reject(new Error('CDP closed')); pending.clear() }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  await waitFor(() => evaluate('!!document.querySelector(".settings-entry")'), Boolean, 'usable workbench')
  await waitFor(() => evaluate('!document.querySelector(".startup-loading") && !document.querySelector(".app")?.inert'), Boolean, 'startup completion')
}
async function stopApp() { ws?.close(); ws = undefined; await sweeper.sweep(); child = undefined }
async function openSettings() {
  await evaluate('document.querySelector(".settings-entry").click()')
  await clickButton('Agent')
  const entry = `document.querySelector('[aria-label="查看 ZCode 详情"]') || document.querySelector('[aria-label="启用 ZCode"]')?.closest('.row')?.querySelector('.set-mini-btn')`
  await waitFor(() => evaluate(`!!(${entry})`), Boolean, 'ZCode settings entry')
  await evaluate(`(${entry}).click()`)
  await waitFor(() => evaluate('document.body.innerText.includes("安装 ZCode")'), Boolean, 'setup group')
}
let cleanupFlight
const cleanup = () => cleanupFlight ||= (async () => { await stopApp(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }) })()
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })
try {
  for (const path of [data, home, workdir, evidence, ...['tmp', 'config', 'cache', 'xdg-data', 'state', 'runtime', 'npm-cache', 'chromium'].map(name => join(root, name))]) await mkdir(path, { recursive: true })
  await writeFile(join(root, 'gitconfig'), ''); await writeFile(join(root, 'npmrc'), '')
  await writeFile(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, enabledAgentIds: ['zcode'], autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, autoCheckUpdate: false }))
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  await startApp(); await openSettings()
  check('fresh setup disables model credentials until installation', await evaluate('document.querySelector(\'[aria-label="ZCode API Key"]\').disabled'))
  await clickButton('一键安装')
  await waitFor(() => call('getZCodeInstallation'), value => value.cancellable, 'cancellable installation')
  await clickButton('取消')
  await waitFor(() => call('getZCodeInstallation'), value => value.phase === 'cancelled', 'cancelled installation')
  check('packaged install cancels without activating a runtime', !(await call('getZCodeInstallation')).installed)
  check('installation cancellation is recorded', (await call('listDiagnostics')).some(entry => entry.code === 'zcode_installation_cancelled'))
  await waitFor(() => evaluate('document.body.innerText.includes("重试安装")'), Boolean, 'retry button')
  check('packaged UI exposes retry and Agent fallback after cancellation', await evaluate('document.body.innerText.includes("使用 Agent 初始化")'))
  await stopApp()
  await mkdir(join(data, 'zcode'), { recursive: true })
  await writeFile(join(data, 'zcode/runtime.json'), JSON.stringify({ ...prepared, personalProviderConfigPath: undefined }), { mode: 0o600 })
  await startApp(); await openSettings()
  await waitFor(() => call('getZCodeInstallation'), value => value.installed, 'installed official engine')
  check('official engine is recognized without a separate verification action', (await call('getZCodeRuntime')).phase === 'needs-auth')
  await waitFor(() => evaluate('!document.querySelector(\'[aria-label="ZCode API Key"]\').disabled'), Boolean, 'credentials enabled')
  check('installed UI hides verification and Agent fallback', await evaluate('!document.body.innerText.includes("验证安装") && !document.body.innerText.includes("Agent 协助初始化")'))
  check('unconfigured UI hides empty defaults', await evaluate('!document.querySelector(\'[aria-label="默认模型"]\')'))
  await evaluate(`(() => { const input = document.querySelector('[aria-label="ZCode API Key"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'uniagent-invalid-test-key'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await clickButton('检测配置')
  check('checking has one status indicator', await evaluate('document.body.innerText.split("检测中").length === 2'))
  await waitFor(() => evaluate('document.body.innerText.includes("API Key 无效")'), Boolean, 'invalid key result')
  check('invalid key is not saved', !(await call('getZCodeConfiguration')).hasKey)
  const authDiagnostic = (await call('listDiagnostics')).find(entry => entry.code === 'zcode_configuration_auth')
  const authSample = JSON.parse(authDiagnostic?.sample || '{}')
  check('authorization failure includes safe HTTP and stage diagnostics', authSample.httpStatus === 401 && authSample.stage === 'model_list'
    && !!authSample.operationId && !JSON.stringify(authDiagnostic).includes('uniagent-invalid-test-key'))
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'installed-awaiting-model.png'), Buffer.from(shot.result.data, 'base64'))
  const selection = { providerId: 'personal:packaged-fixture', modelId: 'fixture', options: { reasoningLevel: 'disabled' } }
  const provider = join(root, 'provider.json')
  await writeFile(provider, JSON.stringify({ schemaVersion: 1, config: { defaultModelSelection: selection,
    providerConfigRules: { providerRules: [{ providerId: selection.providerId, enabled: true, config: { group: 'standard-personal',
      access: { type: 'api-key', apiKey: 'LOCAL_FIXTURE_ONLY' }, api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${model.address().port}/v1` }, personalModelIds: ['fixture'] } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }), { mode: 0o600 })
  await call('saveZCodeRuntime', { ...prepared, personalProviderConfigPath: provider, dataRootId: 'packaged-fixture' })
  await clickButton('刷新状态')
  await waitFor(() => evaluate('!!document.querySelector(\'[aria-label="默认模型"]\')'), Boolean, 'default model settings')
  check('configured runtime exposes editable default model', await evaluate('!document.querySelector(\'[aria-label="默认模型"]\').disabled && document.querySelector(\'[aria-label="默认模型"]\').selectedOptions[0].textContent === "fixture"'))
  check('configured runtime exposes thinking settings', await evaluate('!!document.querySelector(\'[aria-label="默认思考级别"]\')'))
  const configuredShot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'configured-defaults.png'), Buffer.from(configuredShot.result.data, 'base64'))
  const session = await call('createSession', { agentId: 'zcode', workdir, permissionMode: 'full-access', zcodeModelSelection: selection }, 'Reply with ZCODE_PACKAGED_OK without using tools.')
  await waitFor(() => call('getEvents', session.id), events => events.some(event => event.type === 'agent_message' && event.payload.text?.includes('ZCODE_PACKAGED_OK')), 'real engine turn')
  await waitFor(() => call('listSessions'), sessions => !['running', 'queued'].includes(sessions.find(item => item.id === session.id)?.status), 'terminal turn')
  check('packaged App runs official ZCode through local model fixture', calls > 0)
  const nativeId = (await call('listSessions')).find(item => item.id === session.id).nativeSessionId
  await stopApp(); await startApp()
  check('authorization diagnostic survives restart', (await call('listDiagnostics')).some(entry => entry.code === 'zcode_configuration_auth'))
  await call('sendMessage', session.id, 'Continue with ZCODE_PACKAGED_OK.')
  await waitFor(() => call('getEvents', session.id), events => events.filter(event => event.type === 'agent_message' && event.payload.text?.includes('ZCODE_PACKAGED_OK')).length >= 2, 'cold resume')
  check('cold restart resumes the same native session', (await call('listSessions')).find(item => item.id === session.id).nativeSessionId === nativeId)
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, realEngine: true, model: 'loopback fixture', realAccount: false }, null, 2))
} catch (error) {
  if (ws?.readyState === WebSocket.OPEN) {
    await writeFile(join(evidence, 'failure.txt'), await evaluate('document.body.innerText')).catch(() => {})
  }
  throw error
} finally { await cleanup() }
