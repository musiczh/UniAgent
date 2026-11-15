// Real packaged App, ownership IPC, persisted schedules and live native Codex turns.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'
import { build } from 'esbuild'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/'), 'only launch the repository package')
const output = resolve('docs/automation-scope-acceptance')
const scratch = mkdtempSync(join(tmpdir(), 'ua-automation-ownership-'))
const home = join(scratch, 'home'), data = join(scratch, 'data'), chromium = join(scratch, 'chromium')
const env = { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8', SHELL: '/usr/bin/false',
  USER: 'uniagent-acceptance', LOGNAME: 'uniagent-acceptance', HOME: home, USERPROFILE: home, UNIAGENT_USER_DATA: data,
  CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
  TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'), ZDOTDIR: join(scratch, 'zdotdir'),
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
  NPM_CONFIG_CACHE: join(scratch, 'npm-cache'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local-appdata'),
  UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1' }
for (const path of [home, data, chromium, ...Object.entries(env).filter(([key]) => /^(TMP|XDG_|ZDOTDIR|APPDATA|LOCALAPPDATA|NPM_CONFIG_CACHE|UNIAGENT_CAPABILITY_DATA)/.test(key)).map(([, value]) => value)]) mkdirSync(path, { recursive: true })
const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value, { mode: 0o600 }) }
for (const name of ['auth.json', 'models_cache.json']) {
  const source = join(homedir(), '.codex', name), target = join(home, '.codex', name)
  if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
}
put(join(scratch, 'gitconfig'), '[user]\n name = UniAgent Acceptance\n email = acceptance@example.invalid\n')
put(join(scratch, 'npmrc'), '')
put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, requirementsEnabled: true, spaceRequirementSidebar: true,
  sidebarShortcuts: ['automations', 'agent', 'tokens'],
  taskTitleGeneration: { enabled: false }, autoCheckUpdate: false, autoUpdateAgentsOnLaunch: false,
  autoUpdateAgentsWhenIdle: false, enabledAgentIds: ['codex'], notificationMode: 'off' }))
const workspaces = [join(scratch, '空间 A'), join(scratch, '空间 B')]
for (const workspace of workspaces) {
  mkdirSync(workspace); execFileSync('/usr/bin/git', ['init', '-q', workspace], { env, stdio: 'ignore' })
  put(join(workspace, 'AGENTS.md'), '# 隔离验收\n不要修改文件、调用工具或创建子 Agent。只回复用户要求的标记。\n')
}
const seed = resolve('out/test/automation-scope-seed-' + process.pid + '.mjs')
await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import {ProjectStore} from './src/main/projectStore';import {RequirementStore} from './src/main/requirementStore';
  const store=new ProjectStore(process.argv[2]);
  const a=store.create({name:'空间 A',primaryDirectory:process.argv[3],additionalDirectories:[]});
  const b=store.create({name:'空间 B',primaryDirectory:process.argv[4],additionalDirectories:[]});
  const requirement=await new RequirementStore(process.argv[2]).create({name:'定时任务归属验收',projectId:a.id});
  console.log(JSON.stringify({a,b,requirement}));
` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: seed })
const { a, b, requirement } = JSON.parse(execFileSync(process.execPath, [seed, data, ...workspaces], { env, cwd: workspaces[0], encoding: 'utf8' }).trim())
rmSync(seed, { force: true })
const results = [], screenshots = []
const asar = join(binary.slice(0, binary.indexOf('/Contents/MacOS/')), 'Contents/Resources/app.asar')
const packageHash = createHash('sha256').update(readFileSync(asar)).digest('hex')
let child, socket, cdp, sweeper, cleaning, failure, stderr = '', step = 'launch'
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
async function wait(probe, accept = Boolean, label = 'condition', timeout = 30000) {
  const until = Date.now() + timeout; let last
  while (Date.now() < until) { last = await probe(); if (accept(last)) return last; await sleep(150) }
  throw Error('Timeout: ' + label + '; last=' + JSON.stringify(last)?.slice(0, 500))
}
async function stopApp() { socket?.close(); socket = undefined; await sweeper?.sweep(); sweeper = undefined; child = undefined }
async function cleanup() { cleaning ??= (async () => { await stopApp(); rmSync(scratch, { recursive: true, force: true }) })(); return cleaning }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })
async function launch() {
  const server = createServer(); await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port; await new Promise(resolveClose => server.close(resolveClose))
  sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
  child = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + chromium, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
    { env, cwd: workspaces[0], detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject) }); await sweeper.addRoot(child.pid)
  child.stdout.on('data', chunk => { stderr = (stderr + chunk).slice(-1500) }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1500) })
  const renderer = join(dirname(asar), 'app.asar.unpacked/out/renderer/index.html')
  const page = await wait(async () => {
    if (child.exitCode !== null) throw Error('App exited: ' + stderr)
    try { const pages = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1000) })).json(); return pages.find(item => item.type === 'page' && item.url.startsWith('file:') && fileURLToPath(item.url) === renderer) }
    catch { return null }
  }, Boolean, 'exact packaged renderer', 45000)
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0; const pending = new Map()
  socket.addEventListener('message', message => { const value = JSON.parse(message.data), entry = pending.get(value.id); if (entry) { pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result) } })
  cdp = (method, params = {}) => new Promise((resolveCall, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 30000); pending.set(id, { resolve: resolveCall, reject, timer }); socket.send(JSON.stringify({ id, method, params })) })
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await wait(() => evaluate('return !!window.uniagent && !!document.querySelector(".new-task")'), Boolean, 'app UI', 45000)
  await wait(() => evaluate('const startup=document.getElementById("ua-startup");if(startup?.classList.contains("error"))throw Error(document.getElementById("ua-startup-title")?.textContent);return startup?.hidden && !document.querySelector(".app")?.inert'), Boolean, 'visible usable workbench', 300000)
  console.log('Connected to verifier-owned packaged renderer')
}
async function evaluate(body) { const value = await cdp('Runtime.evaluate', { expression: '(async()=>{' + body + '\n})()', awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result?.value }
const api = (method, ...args) => { step = 'API ' + method; return evaluate('return window.uniagent[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')') }
async function click(selector, text) {
  step = 'click ' + selector + ' ' + (text ?? '')
  assert.ok(await evaluate('const nodes=[...document.querySelectorAll(' + JSON.stringify(selector) + ')];const node=nodes.find(item=>!item.disabled&&' + (text ? 'item.textContent.includes(' + JSON.stringify(text) + ')' : 'true') + ');node?.click();return !!node'), 'click ' + selector + ' ' + text)
}
async function fill(selector, value) {
  await evaluate('const el=document.querySelector(' + JSON.stringify(selector) + ');const p=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(el,' + JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return true')
}
async function shot(name) { const result = await cdp('Page.captureScreenshot', { format: 'png' }); put(join(output, name), Buffer.from(result.data, 'base64')); screenshots.push(name) }
async function choose(text) { if (!await evaluate('return !!document.querySelector(".auto-ownership [role=listbox]")')) await click('.auto-ownership summary'); await wait(() => evaluate('return !!document.querySelector(".auto-ownership [role=listbox]")')); await click('.auto-ownership [role=option]', text); await wait(() => evaluate('return !document.querySelector(".auto-ownership [role=listbox]")')) }
async function run(task, token) {
  assert.equal(await api('updateAutomation', task, { schedule: 'ONCE:' + new Date(Date.now() + 1500).toISOString(), prompt: '不要调用工具、读取文件或创建子 Agent，只回复：' + token }), true)
  const updated = await wait(() => api('getAutomationDetail', task), value => value.lastSessionId && value.lastSessionId !== task.lastSessionId, 'scheduled session created', 45000)
  const session = await wait(() => api('listSessions'), rows => rows.some(item => item.id === updated.lastSessionId && ['idle', 'completed', 'error', 'interrupted'].includes(item.status)), 'live native turn', 180000)
  const current = session.find(item => item.id === updated.lastSessionId)
  const events = await api('getEvents', current.id)
  assert.ok(events.some(event => event.type === 'agent_message' && event.payload?.text?.includes(token)), 'live native response: ' + token)
  return { task: await api('getAutomationDetail', task), session: current }
}
try {
  await launch()
  const codex = await wait(async () => (await api('listAgents')).find(agent => agent.id === 'codex'), agent => agent?.lifecycle?.availability === 'available', 'Codex available', 180000)
  console.log('Codex is available for real scheduled turns')
  const model = codex.models.find(item => item.id === 'gpt-6.1-sol')?.id ?? codex.defaultModel
  await click('button', '定时任务'); await wait(() => evaluate('return !!document.querySelector(".auto-agent-tabs")'))
  await click('button', '新建任务'); await wait(() => evaluate('return !!document.querySelector(".auto-ownership summary")'))
  await fill('[aria-label="任务名称"]', '需求归属定时验收'); await fill('[aria-label="指令 / 提示词"]', '只回复验收标记')
  await fill('[aria-label="执行 Agent"]', 'codex'); await fill('[aria-label="模型"]', model)
  await choose(requirement.name)
  await wait(() => evaluate('return !!document.querySelector(".auto-save:not(:disabled)")'))
  await click('.auto-save'); await wait(() => evaluate('return !!document.querySelector(".auto-list")'))
  let task = (await api('listAutomations')).find(item => item.name === '需求归属定时验收')
  assert.deepEqual(task.taskScope, { kind: 'requirement', requirementId: requirement.id }); assert.equal(task.projectId, undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'native-automations.json'), 'utf8'))[0].taskScope, task.taskScope)
  await click('.auto-name', task.name); await wait(() => evaluate('return document.querySelector(".auto-ownership-space")?.textContent.includes("空间 A")'))
  await shot('01-需求归属.png'); await click('.auto-ownership summary'); await wait(() => evaluate('return !!document.querySelector(".auto-ownership [role=listbox]")')); await shot('02-选择器.png'); await choose(requirement.name)
  console.log('Validated requirement selection and real persistence')
  const first = await run(task, 'AUTOMATION_A_OK'); task = first.task
  assert.equal(first.session.config.requirementId, requirement.id); assert.equal(first.session.config.projectId, a.id); assert.equal(first.session.config.workdir, workspaces[0])
  results.push('UI 选择需求、真实保存、实际定时触发及 Codex 回复，执行目录为空间 A'); console.log('PASS first live scheduled run')
  const oldSession = JSON.stringify(first.session.config)
  await api('updateRequirement', requirement.id, { projectId: b.id })
  await wait(() => evaluate('return document.querySelector(".auto-ownership-space")?.textContent.includes("空间 B")')); await shot('03-换绑后的主空间.png')
  const second = await run(task, 'AUTOMATION_B_OK'); task = second.task
  assert.equal(second.session.config.requirementId, requirement.id); assert.equal(second.session.config.projectId, b.id); assert.equal(second.session.config.workdir, workspaces[1])
  assert.equal(JSON.stringify((await api('listSessions')).find(item => item.id === first.session.id).config), oldSession)
  results.push('换绑后真实触发使用空间 B，历史 Session 配置和目录保持不变'); console.log('PASS rebound live scheduled run')
  await choose('空间 A'); await wait(() => evaluate('return !!document.querySelector(".auto-save:not(:disabled)")')); await click('.auto-save')
  await wait(() => evaluate('return !!document.querySelector(".auto-save:disabled")')); await shot('04-空间归属.png')
  task = await api('getAutomationDetail', task)
  const third = await run(task, 'AUTOMATION_SPACE_OK'); task = third.task
  assert.equal(third.session.config.requirementId, undefined); assert.equal(third.session.config.projectId, a.id)
  results.push('编辑回空间、真实保存和定时执行解除需求归属'); console.log('PASS space-only scheduled run')
  await api('updateAutomation', task, { taskScope: { kind: 'requirement', requirementId: requirement.id } })
  await api('updateRequirement', requirement.id, { status: 'archived' })
  await click('.auto-back'); await wait(() => evaluate('return !!document.querySelector(".auto-list")')); await click('.auto-name', task.name)
  await wait(() => evaluate('return document.querySelector(".auto-ownership-error")?.textContent.includes("所选需求已不可用")')); await shot('05-归属失效.png')
  const before = (await api('listSessions')).length
  const rejected = await evaluate('try { await window.uniagent.createAutomation(' + JSON.stringify({ name: '不可用归属', prompt: '不要运行', agentId: 'codex', model, permissionMode: 'read-only', taskScope: { kind: 'requirement', requirementId: requirement.id }, schedule: 'ONCE:' + new Date(Date.now() + 60000).toISOString() }) + ');return false } catch(error) {return error.message}')
  assert.match(rejected, /需求不可用/); assert.equal((await api('listSessions')).length, before)
  results.push('归属失效显示具体原因并拒绝创建，未产生默认空间 Session')
  await click('.settings-entry'); await wait(() => evaluate('return !!document.querySelector(".set-nav-item")'))
  await click('.set-nav-item', '定时任务'); await wait(() => evaluate('return !!document.querySelector(".automations-embedded .auto-list")'))
  await click('.auto-name', task.name); await wait(() => evaluate('return document.querySelector(".auto-ownership-error")?.textContent.includes("所选需求已不可用")'))
  await choose('空间 A'); await wait(() => evaluate('return !!document.querySelector(".auto-save:not(:disabled)")')); await click('.auto-save')
  await wait(() => evaluate('return !!document.querySelector(".auto-save:disabled")')); await shot('06-设置页归属.png')
  assert.deepEqual((await api('getAutomationDetail', task)).taskScope, { kind: 'space', projectId: a.id })
  results.push('设置页内嵌入口也可选择和保存空间／需求，保持需求开关一致')
  await stopApp(); await launch()
  const restored = (await api('listAutomations')).find(item => item.id === task.id)
  assert.deepEqual(restored.taskScope, { kind: 'space', projectId: a.id })
  assert.equal(createHash('sha256').update(readFileSync(asar)).digest('hex'), packageHash, 'the accepted package must remain unchanged during verification')
  results.push('真实退出并重新启动隔离 App，归属与历史执行会话保留'); console.log('PASS real packaged restart')
} catch (error) { failure = error; console.error(step + ': ' + error.message); process.exitCode = 1 }
finally {
  put(join(output, 'result.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), mode: 'real packaged App, actual IPC, real schedule dispatch and live Codex',
    packageSha256: packageHash, results, screenshots,
    ...(failure ? { error: failure.message, step } : {}), cleanup: 'verifier-owned processes and temporary fixtures only' }, null, 2) + '\n')
  await cleanup()
}
