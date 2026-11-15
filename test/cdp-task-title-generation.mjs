// Opt-in: packaged App, selected native title Agent/model and real Codex task; all App state is isolated.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath, symlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = await realpath(resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public'))
assert.ok(binary.startsWith(await realpath(resolve('release')) + '/'), 'only launch the repository package')
const model = process.argv[3] || 'gpt-6-luna'
const agentId = process.argv[4] || 'codex', effort = process.argv[5] || 'low'
const taskModel = 'gpt-6-luna'
const layoutOnly = process.argv[6] === 'layout-only'
const bundle = binary.slice(0, binary.indexOf('/Contents/MacOS/'))
const packageHash = createHash('sha256').update(await readFile(join(bundle, 'Contents/Resources/app.asar'))).digest('hex')
const evidence = resolve('docs/mockups')
const scratch = await mkdtemp(join(tmpdir(), 'ua-title-acceptance-'))
const home = join(scratch, 'home'), data = join(scratch, 'data'), workdir = join(scratch, 'workspace')
const checks = [], screenshots = []
let app, socket, sweeper, rpc, lastTargets = [], stderr = '', cleanupFlight, agentDiagnostic
const delay = ms => new Promise(done => setTimeout(done, ms))
async function put(file, content) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, { mode: 0o600 }) }
async function wait(probe, accept = Boolean, label = 'condition', timeout = 60000) {
  const started = Date.now(); let last
  while (Date.now() - started < timeout) { last = await probe(); if (accept(last)) return last; await delay(150) }
  throw new Error('Timeout: ' + label + '; last=' + JSON.stringify(last)?.slice(0, 500))
}
async function evaluate(body) {
  const value = await rpc('Runtime.evaluate', { expression: '(async()=>{' + body + '\n})()', awaitPromise: true, returnByValue: true, userGesture: true })
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text)
  return value.result?.value
}
const api = (method, ...args) => evaluate('return window.uniagent[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')')
function pass(name, detail) { checks.push({ name, detail, status: 'PASS' }); console.log('PASS ' + name) }
async function click(selector, text) {
  const point = await wait(() => evaluate('const el=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.getBoundingClientRect().width>0' + (text ? '&&e.textContent.trim()===' + JSON.stringify(text) : '') + ');if(!el||el.disabled)return null;el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,ready:el.contains(hit),blocker:hit?.className}'), value => value?.ready, 'clickable ' + selector + ' ' + (text || ''), 15000)
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(150)
}
async function openParameter(label) {
  if (!await evaluate('return document.querySelector(".title-generator-picker")?.open')) await click('.title-generator-picker > summary')
  await click('.title-generator-picker .sb-sub-entry', label + (label === 'Agent' ? await evaluate('return document.querySelector(".title-generator-picker .sb-sub-entry small")?.textContent') : label === '模型' ? await evaluate('return document.querySelectorAll(".title-generator-picker .sb-sub-entry small")[1]?.textContent') : await evaluate('return document.querySelectorAll(".title-generator-picker .sb-sub-entry small")[2]?.textContent')))
}
async function selectGenerator() {
  await openParameter('Agent'); await click('[data-title-agent="' + agentId + '"]')
  await openParameter('模型'); await click('[data-title-model=' + JSON.stringify(model) + ']')
  const available = await evaluate('return !!document.querySelector(' + JSON.stringify('[data-title-effort="' + effort + '"]') + ')')
  if (!available) await openParameter('思考强度')
  await click('[data-title-effort="' + effort + '"]')
}
async function shot(name) {
  const file = 'task-title-multi-agent-' + agentId + '-' + name + '.png'
  const image = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await put(join(scratch, 'evidence', file), Buffer.from(image.data, 'base64')); screenshots.push(file)
}
async function stopApp() {
  socket?.close(); socket = undefined
  if (sweeper) { await sweeper.sweep(); assert.equal((await sweeper.ownedProcesses()).length, 0) }
  sweeper = undefined; app = undefined
}
async function cleanup() { cleanupFlight ??= (async () => { await stopApp(); await rm(scratch, { recursive: true, force: true }) })(); return cleanupFlight }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })

const env = { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8', SHELL: '/usr/bin/false',
  HOME: home, USERPROFILE: home, UNIAGENT_USER_DATA: data, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'), KIMI_CODE_HOME: join(home, '.kimi-code'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
  TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'), ZDOTDIR: join(scratch, 'zdotdir'),
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'), NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local-appdata'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data') }
async function launch() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port; await new Promise(done => server.close(done))
  sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
  app = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + join(scratch, 'chromium'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { env, cwd: workdir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((done, reject) => { app.once('spawn', done); app.once('error', reject) }); await sweeper.addRoot(app.pid)
  app.stdout.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) }); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
  const renderer = join(bundle, 'Contents/Resources/app.asar.unpacked/out/renderer/index.html')
  const target = await wait(async () => {
    try { const rows = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1000) })).json(); lastTargets = rows.map(row => ({ type: row.type, url: row.url })); return rows.find(row => row.type === 'page' && row.url.startsWith('file:') && fileURLToPath(row.url) === renderer) } catch { return undefined }
  }, Boolean, 'exact packaged renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0; const pending = new Map()
  socket.addEventListener('message', message => { const value = JSON.parse(message.data), item = pending.get(value.id); if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result) } })
  rpc = (method, params = {}) => new Promise((resolveResult, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 60000); pending.set(id, { resolve: resolveResult, reject, timer }); socket.send(JSON.stringify({ id, method, params })) })
  await rpc('Page.enable'); await rpc('Runtime.enable'); await rpc('Emulation.setFocusEmulationEnabled', { enabled: true })
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await wait(() => evaluate('return !!window.uniagent&&!!document.querySelector("[title=设置]")'), Boolean, 'startup ready')
  await wait(() => evaluate('return [...document.querySelectorAll(".startup-screen,.startup-portal")].every(el=>el.hidden||getComputedStyle(el).display==="none")'), Boolean, 'startup animation completed')
  await evaluate('window.__titleErrors=[];window.addEventListener("error",e=>window.__titleErrors.push(e.message));window.addEventListener("unhandledrejection",()=>window.__titleErrors.push("unhandledrejection"));return true')
}
async function settings() {
  await click('[title="设置"]')
  await click('button', 'superAgent配置')
  await wait(() => evaluate('return !!document.querySelector("#task-title-sample")'), Boolean, 'title settings')
}
async function trial() {
  await click('button', '试生成')
  return wait(() => evaluate('return {text:document.querySelector(".title-preview-result strong")?.textContent,busy:!![...document.querySelectorAll("button")].find(e=>e.textContent==="取消试生成"),error:!!document.querySelector(".title-preview-result[role=alert]")}'), value => value && !value.busy && value.text, 'real title result', 45000)
}

try {
  for (const directory of [home, data, workdir, ...Object.entries(env).filter(([key]) => /^(TMP|XDG_|ZDOTDIR|APPDATA|LOCALAPPDATA|NPM_CONFIG_CACHE|UNIAGENT_CAPABILITY_DATA|CODEX_HOME|TRAE_HOME|CLAUDE_CONFIG_DIR)/.test(key)).map(([, value]) => value)]) await mkdir(directory, { recursive: true })
  for (const name of ['auth.json', 'models_cache.json']) await copyFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), name), join(env.CODEX_HOME, name))
  await put(env.GIT_CONFIG_GLOBAL, '[user]\n name = Title Acceptance\n email = acceptance@example.invalid\n'); await put(env.NPM_CONFIG_USERCONFIG, '')
  execFileSync('/usr/bin/git', ['init', '-q', workdir], { env, stdio: 'ignore' })
  await put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, requirementsEnabled: true, theme: 'dark', autoCheckUpdate: false, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, enabledAgentIds: ['codex'], notificationMode: 'off' }))
  const nativeData = process.env.UNIAGENT_USER_DATA || join(homedir(), 'Library/Application Support/uniagent')
  const credentialKey = join(nativeData, 'credentials/key')
  const copyOptional = async (source, destination) => { await mkdir(dirname(destination), { recursive: true }); try { await copyFile(source, destination) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  if (agentId === 'claude') {
    const raw = JSON.parse(await readFile(join(homedir(), '.claude/settings.json'), 'utf8'))
    const connection = Object.fromEntries(Object.entries(raw.env || {}).filter(([key, value]) => typeof value === 'string' && /^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN$|ENABLE_GATEWAY_MODEL_DISCOVERY$|EFFORT_LEVEL$|DISABLE_NONESSENTIAL_TRAFFIC$|EXTRA_BODY$))/.test(key)))
    await put(join(home, '.claude/settings.json'), JSON.stringify({ env: connection, disableAllHooks: true }));await put(join(home,'.claude/.claude.json'),JSON.stringify({hasCompletedOnboarding:true,projects:{[workdir]:{hasTrustDialogAccepted:true}}}))
    await copyOptional(join(homedir(), '.claude/.credentials.json'), join(home, '.claude/.credentials.json'))
    await copyOptional(join(nativeData, 'agent-credentials.json'), join(data, 'agent-credentials.json'))
  }
  if (agentId === 'grok') {
    await mkdir(join(home, '.grok/bin'), { recursive: true })
    await symlink(await realpath(join(homedir(), '.grok/bin/grok')), join(home, '.grok/bin/grok'))
    for (const name of ['auth.json', 'models_cache.json', 'config.toml']) await copyOptional(join(homedir(), '.grok', name), join(home, '.grok', name))
    await copyOptional(join(nativeData, 'agent-credentials.json'), join(data, 'agent-credentials.json'))
  }
  if (agentId === 'deepseek') {
    await copyOptional(credentialKey, join(data,'credentials/key'))
    const sourceRoot = join(nativeData, 'deepseek')
    const active = JSON.parse(await readFile(join(sourceRoot, 'active-runtime.json'), 'utf8'))
    assert.match(active.directory, /^(?:installed-[a-f0-9-]+|runtime(?:-[0-9A-Za-z.+-]+)?)$/)
    const runtime = join(data, 'deepseek', active.directory); await mkdir(runtime, { recursive: true })
    await symlink(join(sourceRoot, active.directory, 'node_modules'), join(runtime, 'node_modules'))
    await copyOptional(join(sourceRoot, 'active-runtime.json'), join(data, 'deepseek/active-runtime.json'))
    await copyOptional(join(sourceRoot, 'connection.json'), join(data, 'deepseek/connection.json'))
    const nodeRoot = join(sourceRoot, 'node'); try { await symlink(nodeRoot, join(data, 'deepseek/node')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const configuration = JSON.parse(await readFile(join(data, 'app-settings.json'), 'utf8'));configuration.enabledAgentIds=[...new Set(['codex',agentId])];await put(join(data,'app-settings.json'),JSON.stringify(configuration))
  await launch(); await settings()
  const codex = (await api('listAgents')).find(agent => agent.id === 'codex')
  assert.ok(codex?.installed && codex.bin, 'installed Codex is used for real acceptance')
  const before = (await api('listSessions')).length
  const selectedAgent = (await api('listAgents')).find(agent => agent.id === agentId)
  agentDiagnostic={id:selectedAgent?.id,installed:selectedAgent?.installed,incompatible:selectedAgent?.incompatible,authenticationRequired:selectedAgent?.authenticationRequired,modelSelect:selectedAgent?.capabilities?.modelSelect,models:selectedAgent?.models?.length,lifecycle:selectedAgent?.lifecycle};
  assert.ok(selectedAgent?.installed && selectedAgent.bin, 'selected title Agent is installed')
  await selectGenerator()
  const compact = await evaluate('const el=document.querySelector(".title-generator-picker > summary");return {count:document.querySelectorAll(".title-generator-picker > summary").length,width:el.getBoundingClientRect().width,effort:document.querySelector(".title-generator-picker").dataset.effort}')
  assert.equal(compact.count, 1); assert.ok(compact.width < 420); assert.equal(compact.effort, effort)
  if (layoutOnly) {
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false })
    await openParameter('Agent'); await delay(300)
    const geometry = await evaluate('const r=document.querySelector(".title-generator-picker .sb-sub-menu").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,placement:document.querySelector(".title-generator-picker .sb-sub-menu").dataset.placement,agents:[...document.querySelectorAll("[data-title-agent]")].map(e=>e.dataset.titleAgent),hittable:[...document.querySelectorAll(".title-generator-picker .sb-sub-entry,.title-generator-picker .sb-sub-opt")].every(e=>{const p=e.getBoundingClientRect();return e.contains(document.elementFromPoint(p.x+p.width/2,p.y+p.height/2))})}')
    assert.ok(geometry.left >= 12 && geometry.right <= 1012 && geometry.top >= 12 && geometry.bottom <= 628, JSON.stringify(geometry))
    assert.equal(geometry.hittable, true, 'primary and child menus must remain visible through ancestor containers')
    assert.ok(!geometry.agents.includes('kimi') && !geometry.agents.includes('traex'))
    pass('1024×640 compact picker and viewport-safe submenu', geometry); await shot('04-紧凑菜单-1024x640')
  } else {
  const result = await trial()
  assert.equal(result.error, false, result.text); assert.match(result.text, /修复/); assert.match(result.text, /图片/); assert.match(result.text, /历史|重启/); assert.ok([...result.text].length <= 36)
  assert.equal((await api('listSessions')).length, before); assert.equal((await api('getAppSettings')).taskTitleGeneration?.model, undefined)
  pass('unsaved UI trial uses requested real title Agent/model without creating or saving a task', { model, title: result.text }); await shot('01-试生成成功')
  await click('button', '保存配置')
  const saved = await wait(() => api('getAppSettings'), value => value.taskTitleGeneration?.model === model && value.taskTitleGeneration.effort === effort, 'saved title configuration')
  assert.equal(saved.taskTitleGeneration.agentId, agentId); await stopApp(); await launch(); await settings()
  assert.equal(await evaluate('return document.querySelector(".title-generator-picker").dataset.model'), model); assert.equal(await evaluate('return document.querySelector(".title-generator-picker").dataset.effort'), effort)
  const restored = await trial(); assert.equal(restored.error, false, restored.text); assert.match(restored.text, /图片/)
  pass('saved configuration survives a real App restart and generates again', { model, title: restored.text }); await shot('02-重启后试生成')
  await click('button', '试生成'); await wait(() => evaluate('return !![...document.querySelectorAll("button")].find(e=>e.textContent==="取消试生成")'))
  await click('button', '取消试生成'); await delay(1200)
  assert.ok(await evaluate('return !document.querySelector(".title-preview-result[role=alert]")&&!![...document.querySelectorAll("button")].find(e=>e.textContent==="试生成")'))
  pass('real UI cancellation returns to a usable trial control')
  const project = await api('createProject', { name: '标题生成验收', primaryDirectory: workdir, additionalDirectories: [] })
  const session = await api('createSession', { agentId: 'codex', model: taskModel, modelSource: { kind: 'native' }, permissionMode: 'read-only', projectId: project.id, workdir }, '修复重启后任务历史图片不显示。这是标题链路验收，无需实施。不要调用工具、不要修改文件、不要发起子任务，只回复“已确认图片问题”。')
  const generated = await wait(async () => (await api('listSessions')).find(row => row.id === session.id), row => { if (row?.status === 'error') throw new Error('main native turn failed'); return row?.taskMetadata?.source === 'generated' }, 'real task background title', 90000)
  assert.equal(generated.config.model, taskModel); assert.equal(generated.taskMetadata.generator.model, model); assert.equal(generated.taskMetadata.generator.agentId, agentId); assert.equal(generated.taskMetadata.generator.effort, effort)
  pass('real native task triggers background title without changing execution model', { title: generated.taskMetadata.title, model })
  await wait(async () => (await api('listSessions')).find(row => row.id === session.id), row => ['idle', 'completed'].includes(row?.status), 'main native turn completed', 90000)
  await api('renameSession', session.id, '手动保留的任务标题'); await stopApp(); await launch()
  const manual = (await api('listSessions')).find(row => row.id === session.id)
  assert.equal(manual.taskMetadata.source, 'manual'); assert.equal(manual.taskMetadata.title, '手动保留的任务标题')
  pass('manual task title survives a real restart')
  assert.deepEqual(await evaluate('return window.__titleErrors'), [])
  await settings(); await shot('03-最终配置')
  }
  const hash = createHash('sha256').update(await readFile(join(bundle, 'Contents/Resources/app.asar'))).digest('hex')
  assert.equal(hash, packageHash, 'the tested package must stay unchanged throughout acceptance')
  for (const file of screenshots) await copyFile(join(scratch, 'evidence', file), join(evidence, file))
  await put(resolve(layoutOnly ? 'docs/task-title-combined-layout-acceptance.json' : 'docs/task-title-multi-agent-' + agentId + '-acceptance.json'), JSON.stringify({ status: 'passed', scope: layoutOnly ? 'packaged App layout only; no model request' : 'packaged App with real selected title Agent/model and real Codex task', at: new Date().toISOString(), appBundle: bundle, appAsarSha256: hash, agent: { id: selectedAgent.id, bin: await realpath(selectedAgent.bin), version: selectedAgent.version }, model, effort, checks, screenshots, installedAppReplaced: false }, null, 2) + '\n')
  console.log('PASS packaged title generation acceptance')
} catch (error) {
  console.error(JSON.stringify({ error: String(error), targets: lastTargets, stderrPresent: !!stderr,agentDiagnostic })); throw error
} finally { await cleanup() }
