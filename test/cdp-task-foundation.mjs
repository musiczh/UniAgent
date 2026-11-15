// Real packaged renderer / preload / main and live Codex turns. No mocked IPC or UI.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { build } from 'esbuild'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'
import { installMarkdownInputDriver } from './fixtures/markdown-input-driver.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/'), 'only launch the repository package')
const output = resolve('docs/task-foundation-acceptance')
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'ua-task-acceptance-'))
const home = join(scratch, 'home'), data = join(scratch, 'data'), chromium = join(scratch, 'chromium')
const workspaceA = join(scratch, '产品工作台'), workspaceB = join(scratch, '执行验证')
const seedScript = resolve('out/test/task-acceptance-seed-' + process.pid + '.mjs')
const env = { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8', SHELL: '/usr/bin/false',
  USER: 'uniagent-acceptance', LOGNAME: 'uniagent-acceptance', HOME: home, USERPROFILE: home, UNIAGENT_USER_DATA: data,
  CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
  TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'), ZDOTDIR: join(scratch, 'zdotdir'),
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
  NPM_CONFIG_CACHE: join(scratch, 'npm-cache'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local-appdata'),
  UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1' }
for (const dir of [home, data, chromium, workspaceA, workspaceB, ...Object.entries(env).filter(([key]) => /^(TMP|XDG_|ZDOTDIR|APPDATA|LOCALAPPDATA|NPM_CONFIG_CACHE|UNIAGENT_CAPABILITY_DATA)/.test(key)).map(([, value]) => value)]) mkdirSync(dir, { recursive: true })
const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value, { mode: 0o600 }) }
for (const name of ['auth.json', 'models_cache.json']) {
  const source = join(homedir(), '.codex', name), target = join(home, '.codex', name)
  if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
}
put(join(scratch, 'gitconfig'), '[user]\n name = UniAgent Acceptance\n email = acceptance@example.invalid\n')
put(join(scratch, 'npmrc'), '')
put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, requirementsEnabled: true, theme: 'dark',
  autoCheckUpdate: false, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, enabledAgentIds: ['codex'], notificationMode: 'off' }))
for (const path of [workspaceA, workspaceB]) {
  execFileSync('/usr/bin/git', ['init', '-q', path], { env, stdio: 'ignore' })
  put(join(path, '验收样例.md'), '# Task 基础验收\n\n此目录仅用于隔离验证。禁止启动子 Agent、修改文件或读取目录外资料。\n')
}
await build({ stdin: { resolveDir: process.cwd(), contents: `import {RequirementStore} from './src/main/requirementStore'; const r=await new RequirementStore(process.argv[2]).create({name:'Task 基础验收'});console.log(JSON.stringify(r));`, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: seedScript })
const requirement = JSON.parse(execFileSync(process.execPath, [seedScript, data], { env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trim())
const projectA = { id: randomUUID(), name: '产品工作台', primaryDirectory: workspaceA, additionalDirectories: [], createdAt: Date.now(), updatedAt: Date.now() }
const projectB = { ...projectA, id: randomUUID(), name: '执行验证', primaryDirectory: workspaceB }
put(join(data, 'projects.json'), JSON.stringify([projectA, projectB]))
const seedSessions = [projectA, projectB, projectB, projectB].map((project, i) => ({ id: randomUUID(), title: '历史验收记录 ' + (i + 1),
  status: 'idle', createdAt: Date.now() - (i + 1) * 60000, config: { agentId: 'codex', model: 'gpt-5.4', permissionMode: 'ask', projectId: project.id, requirementId: requirement.id, workdir: project.primaryDirectory } }))
put(join(data, 'sessions.json'), JSON.stringify(seedSessions))
put(join(data, 'requirements.json'), JSON.stringify([{ ...requirement, projectId: projectA.id }]))

const results = [], shots = []
const hash = value => createHash('sha256').update(value).digest('hex')
const archive = join(binary.slice(0, binary.indexOf('/Contents/MacOS/')), 'Contents/Resources/app.asar')
const packageHash = hash(readFileSync(archive))
let child, socket, cdp, sweeper, lastStderr = '', cleaning, failure, lastTargets = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(probe, accept = Boolean, label = 'condition', timeout = 30000) {
  const until = Date.now() + timeout
  let last
  while (Date.now() < until) { last = await probe(); if (accept(last)) return last; await sleep(150) }
  throw new Error('Timeout: ' + label + '; last=' + JSON.stringify(last)?.slice(0, 700))
}
async function stopApp() { socket?.close(); socket = undefined; if (sweeper) await sweeper.sweep(); child = undefined; sweeper = undefined }
async function cleanup() {
  cleaning ??= (async () => { await stopApp(); rmSync(scratch, { recursive: true, force: true }); rmSync(seedScript, { force: true }) })()
  return cleaning
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })
async function launch() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
  child = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + chromium, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { env, cwd: workspaceA, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  await sweeper.addRoot(child.pid)
  console.log('LAUNCH verifier-owned packaged process')
  child.stdout.on('data', chunk => { lastStderr = (lastStderr + chunk).slice(-2000) });child.stderr.on('data', chunk => { lastStderr = (lastStderr + chunk).slice(-2000) })
  const renderer = join(binary.slice(0, binary.indexOf('/Contents/MacOS/')), 'Contents/Resources/app.asar.unpacked/out/renderer/index.html')
  const page = await wait(async () => {
    try { const pages = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1000) })).json();lastTargets=pages.map(page=>({type:page.type,url:page.url}));return pages.find(page => page.type === 'page' && page.url.startsWith('file:') && fileURLToPath(page.url) === renderer) }
    catch { return null }
  }, Boolean, 'exact packaged renderer', 45000)
  socket = new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true });socket.addEventListener('error', reject, { once: true }) })
  let seq = 0;const pending = new Map()
  socket.addEventListener('message', message => { const value = JSON.parse(message.data), entry = pending.get(value.id);if (entry) { pending.delete(value.id);clearTimeout(entry.timer);value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result) } })
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id);reject(new Error('CDP timeout: ' + method)) }, 30000);pending.set(id, { resolve, reject, timer });socket.send(JSON.stringify({ id, method, params })) })
  await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await wait(() => evaluate('return !!window.uniagent && !!document.querySelector(".new-task")'), Boolean, 'app UI', 45000)
  await evaluate('(' + installMarkdownInputDriver.toString() + ')();window.__acceptanceErrors=[];window.addEventListener("error",event=>window.__acceptanceErrors.push(event.message));return true')
  console.log('LAUNCH packaged App connected')
}
async function evaluate(body) { const value = await cdp('Runtime.evaluate', { expression: '(async()=>{' + body + '\n})()', awaitPromise: true, returnByValue: true, userGesture: true });if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);return value.result?.value }
const api = (method, ...args) => evaluate('return window.uniagent[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')')
async function click(selector, text) {
  const point = await evaluate('const el=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.getBoundingClientRect().width>0 && getComputedStyle(e).visibility!=="hidden"' + (text ? '&&e.textContent.includes(' + JSON.stringify(text) + ')' : '') + ');if(!el)throw Error("missing control: "+' + JSON.stringify(selector + ' ' + (text || '')) + ');el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw Error("control obscured: "+' + JSON.stringify(selector) + ');return {x,y}')
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });await sleep(180)
}
async function fill(selector, value) { await evaluate('return window.__markdownInput.fill(' + JSON.stringify(selector) + ',' + JSON.stringify(value) + ')');await sleep(150) }
async function shot(name, description) {
  await sleep(300);const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });const file = name + '.png';put(join(output, file), Buffer.from(pixels, 'base64'));shots.push({ file, description });console.log('SCREENSHOT ' + file)
}
function pass(name, detail) { results.push({ name, status: 'PASS', detail });console.log('PASS ' + name) }
async function homePage() {
  await wait(() => evaluate('return !document.querySelector(".project-editor-overlay")'), Boolean, 'editor closed')
  if (await evaluate('return !!document.querySelector(".settings-back")')) await click('.settings-back')
  await wait(() => evaluate('const el=document.querySelector("[aria-label=新建任务]");if(!el)return false;const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))'), Boolean, 'main navigation restored')
  await click('[aria-label="新建任务"]');await wait(() => evaluate('return !!document.querySelector(".new-task .project-picker > summary")'), Boolean, 'new task controls')
}
async function selectScope(name) {
  await click('.new-task .project-picker > summary');await wait(() => evaluate('return !!document.querySelector(".new-task .project-picker[open] [role=option]")'), Boolean, 'scope options');await click('.new-task .project-picker [role=option]', name)
  await evaluate('document.querySelector(".new-task .project-picker")?.removeAttribute("open");return true')
}
async function createThroughUI(prompt) {
  const before = new Set((await api('listSessions')).map(session => session.id))
  await fill('.new-task .prompt-input', prompt)
  await click('.new-task .btn-send')
  const session = await wait(() => api('listSessions'), rows => rows.find(session => !before.has(session.id)), 'created task', 45000)
  const created = session.find(item => !before.has(item.id))
  await wait(() => api('getSessionRuntimeState', created.id), runtime => runtime.events.some(event => event.type === 'agent_message' && event.state === 'success' && String(event.payload.text || '').includes('验收通过')), 'live Codex reply', 180000)
  const current = (await api('listSessions')).find(session => session.id === created.id)
  assert.notEqual(current.status, 'error')
  return current
}
function originalSessions(rows) { return rows.filter(row => seedSessions.some(seed => seed.id === row.id)).map(row => ({ id: row.id, projectId: row.config.projectId, workdir: row.config.workdir, nativeSessionId: row.nativeSessionId })).sort((a, b) => a.id.localeCompare(b.id)) }

try {
  await launch()
  const initial = await api('listRequirements');assert.equal(initial.find(row => row.id === requirement.id)?.projectId, projectB.id)
  assert.ok(existsSync(join(data, 'requirements-before-ownership-v1.json')))
  const baseline = originalSessions(await api('listSessions'))
  assert.deepEqual(baseline.map(row => ({ id: row.id, projectId: row.projectId, workdir: row.workdir })), seedSessions.map(row => ({ id: row.id, projectId: row.config.projectId, workdir: row.config.workdir })).sort((a, b) => a.id.localeCompare(b.id)))
  pass('历史需求按 3:1 的 Session 使用量绑定空间，原 Session 环境不变', { majority: '执行验证', oldOwner: '产品工作台' })
  const agents = await wait(() => api('listAgents'), rows => rows.some(agent => agent.id === 'codex' && agent.lifecycle?.availability === 'available'), 'Codex ready', 90000)
  const codex = agents.find(agent => agent.id === 'codex');assert.ok(codex.models.length)
  await wait(() => evaluate('return document.querySelector(".new-task .sb-agent")?.dataset.agentId === "codex"'), Boolean, 'Codex UI selected', 30000)
  await wait(() => evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'), Boolean, 'visible startup complete', 90000)
  await selectScope('Task 基础验收')
  await click('.new-task .project-picker > summary')
  const selected = await evaluate('return [...document.querySelectorAll(".new-task .project-picker [role=option][aria-selected=true]")].map(e=>e.textContent)')
  assert.equal(selected.length, 1);assert.match(selected[0], /Task 基础验收/)
  assert.equal(await evaluate('return document.querySelectorAll(".new-task .config-bar > .project-picker").length'), 1)
  await shot('01-空间需求统一选择器', '真实新建页：空间与需求在同一个弹层中选择，只选中需求')
  await evaluate('document.querySelector(".new-task .project-picker").removeAttribute("open");return true')
  pass('输入区只有一个归属选择器，空间与需求互斥')
  const first = await createThroughUI('这是隔离真包验收样例。不要运行工具、启动子 Agent 或修改任何文件；只回复“验收通过：需求任务已在正确空间启动”。')
  assert.equal(first.config.projectId, projectB.id);assert.equal(first.config.requirementId, requirement.id);assert.equal(first.config.workdir, workspaceB);assert.equal(first.config.taskScope, undefined)
  pass('通过实际输入框创建需求任务，真实 Codex 回复完成', { model: first.config.model, agent: first.config.agentId, executionSpace: '执行验证' })
  await api('renameSession', first.id, '需求任务 · 真包验收')
  await fill('.composer-wrap .composer-input', '这是一条尚未发送的草稿，切换任务视图后应保留。')
  const draftBefore = await evaluate('return window.__markdownInput.text(".composer-wrap .composer-input")')
  await wait(() => evaluate('return !!document.querySelector(".session-task-content")'))
  assert.equal(await evaluate('return document.querySelector(".session-task-content").dataset.taskId'), first.id)
  assert.ok(await evaluate('return !!document.querySelector(".session-header .session-info-trigger [data-page-type=task]")&&!document.querySelector(".task-view-switch")'))
  await shot('02-统一任务对话','原聊天流展示任务标记、名称与完整执行过程')
  await click('.session-info-trigger')
  await wait(()=>evaluate('return !!document.querySelector(".session-info-popover [data-field=sessionId]")'))
  assert.ok(await evaluate('return document.querySelector(".session-info-popover [data-field=sessionId]").textContent.includes('+JSON.stringify(first.id)+')'))
  assert.ok(await evaluate('return !!document.querySelector(".session-info-popover [data-field=taskDescription]")'))
  await shot('03-任务与会话信息','标题浮层保留任务名称、描述和实际可获取的会话信息')
  await click('[aria-label="关闭会话信息"]')
  assert.ok(await evaluate('return document.querySelectorAll(".session-task-content .user-msg").length>=1&&document.querySelector(".session-task-content .event-stream").textContent.includes("验收通过")'))
  assert.equal(await evaluate('return window.__markdownInput.text(".composer-wrap .composer-input")'),draftBefore)
  await shot('04-完整信息流与草稿','关闭标题浮层后保留原输入草稿与历史消息')
  pass('统一任务对话保留任务身份、标题描述、Session 信息、完整执行流与草稿')
  await click('.settings-entry');await click('.set-nav-item', '需求');await wait(() => evaluate('return !!document.querySelector(".project-settings-actions")'))
  await click('.project-settings-actions button', '编辑');await wait(() => evaluate('return !!document.querySelector(' + JSON.stringify('[aria-label="需求主项目"] option[value="' + projectA.id + '"]') + ')'))
  await evaluate('const select=document.querySelector("[aria-label=需求主项目]");select.value=' + JSON.stringify(projectA.id) + ';select.dispatchEvent(new Event("change",{bubbles:true}));return true')
  await shot('06-需求主项目换绑', '编辑需求可换绑主空间；保留历史 Session 各自执行项目')
  await click('.project-editor-actions button', '保存');await wait(() => api('listRequirements'), rows => rows.find(row => row.id === requirement.id)?.projectId === projectA.id, 'ownership saved')
  assert.deepEqual(originalSessions(await api('listSessions')), baseline)
  assert.equal((await api('listSessions')).find(row => row.id === first.id)?.config.projectId, projectB.id)
  pass('UI 换绑已持久化，历史与本轮既有 Session 均未搬迁')
  await homePage();await selectScope('Task 基础验收');await selectScope('执行验证')
  assert.ok(!(await evaluate('return document.querySelector(".new-task .project-picker > summary").textContent')).includes('Task 基础验收'))
  const spaceTask = await createThroughUI('这是隔离真包验收样例。不要运行工具、启动子 Agent 或修改文件；只回复“验收通过：空间直属任务已启动”。')
  assert.equal(spaceTask.config.projectId, projectB.id);assert.equal(spaceTask.config.requirementId, undefined)
  pass('选择空间后清除需求归属，实际创建空间直属任务')
  await homePage();await selectScope('Task 基础验收')
  const reboundTask = await createThroughUI('这是隔离真包验收样例。不要运行工具、启动子 Agent 或修改文件；只回复“验收通过：换绑后的新任务使用新的主空间”。')
  assert.equal(reboundTask.config.projectId, projectA.id);assert.equal(reboundTask.config.requirementId, requirement.id);assert.equal(reboundTask.config.workdir, workspaceA)
  pass('换绑后新建需求任务使用新主空间，旧任务仍保留原空间')
  await click('.session-info-trigger');await wait(()=>evaluate('return !!document.querySelector(".session-info-popover [data-field=workdir]")'))
  await shot('07-换绑后新任务执行环境', '新需求任务使用产品工作台；旧任务继续保留执行验证空间')
  await stopApp();await launch();assert.equal((await api('listRequirements')).find(row => row.id === requirement.id)?.projectId, projectA.id)
  assert.deepEqual(originalSessions(await api('listSessions')), baseline)
  pass('真实包重启后手动归属保留，不被 Session 使用量重新覆盖')
  assert.equal(hash(readFileSync(archive)), packageHash, 'validated package was not replaced during the run')
} catch (error) {
  failure = error;console.error('FAIL ' + error.message)
  console.error('Target diagnostics: '+JSON.stringify(lastTargets)+'; childExit='+child?.exitCode)
  if (cdp && socket?.readyState === WebSocket.OPEN) { try { console.error('UI diagnostics: '+JSON.stringify(await evaluate('return {startupHidden:document.querySelector("#ua-startup")?.hidden,pickerOpen:document.querySelector(".new-task .project-picker")?.open,options:document.querySelectorAll(".new-task .project-picker [role=option]").length,errors:window.__acceptanceErrors}'))) } catch {} }
  console.error(lastStderr.replace(/(?:[^\s]*token[^\s]*|authorization|password|secret)[=:][^\n]*/gi,'[redacted]').slice(-1800))
  if (cdp && socket?.readyState === WebSocket.OPEN) { try { await shot('99-失败现场', '真实包验证失败现场') } catch {} }
} finally {
  try { await cleanup() } catch (error) { failure ||= error }
  const report = { status: failure ? 'failed' : 'passed', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), packageSha256: packageHash,
    mode: 'real packaged App, actual IPC, isolated historical fixtures and three live Codex turns', results, screenshots: shots,
    ...(failure ? { error: failure.message } : {}), cleanup: 'only verifier-owned processes and isolated fixtures' }
  put(join(output, 'result.json'), JSON.stringify(report, null, 2));console.log('RESULT ' + report.status + ' ' + results.length + ' checks')
}
if (failure) process.exitCode = 1
