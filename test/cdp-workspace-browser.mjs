// R03/R04: real packaged renderer / preload / main, isolated data and one live Codex turn.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync, renameSync as fsRename } from 'node:fs'
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
const output = resolve('docs/mockups')
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'ua-workspace-acceptance-'))
const home = join(scratch, 'home'), data = join(scratch, 'data'), chromium = join(scratch, 'chromium')
const workspaceA = join(scratch, '产品工作台'), workspaceB = join(scratch, '执行验证')
const seedScript = resolve('out/test/workspace-acceptance-seed-' + process.pid + '.mjs')
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
const projectA = { id: randomUUID(), name: '产品工作台', primaryDirectory: workspaceA, additionalDirectories: [], isDefault: true, createdAt: Date.now(), updatedAt: Date.now() };
const projectB = { ...projectA, id: randomUUID(), name: '执行验证', primaryDirectory: workspaceB, isDefault: false };
put(join(data, 'projects.json'), JSON.stringify([projectA, projectB]));
await build({ stdin: { resolveDir: process.cwd(), contents: "import {RequirementStore} from './src/main/requirementStore';import{join}from'node:path';const store=new RequirementStore(process.argv[2]);const requirement=await store.create({name:'R03 R04 浏览验收',projectId:process.argv[3]});const empty=await store.create({name:'空需求验收',projectId:process.argv[3]});const c=await store.context(requirement.id,'fixture',{action:'bootstrap'});await store.context(requirement.id,'fixture',{action:'propose',expectedRevision:c.revision,operationId:'acceptance-draft',documents:[{id:'sample-source',kind:'proposal',title:'验收资料（草稿）',content:'仅用于隔离验收，不能作为用户确认的产品规则。'}]});console.log(JSON.stringify({requirement,empty,coreBody:join(requirement.dir,'.uniagent-public/bodies',c.core.contentHash+'.md')}));", loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: seedScript });
const seeded = JSON.parse(execFileSync(process.execPath,[seedScript,data,projectA.id],{env:{...env,PATH:process.env.PATH},encoding:'utf8'}).trim());
const {requirement,empty,coreBody}=seeded;
put(join(data,'requirements.json'),JSON.stringify([requirement,empty].map(r=>({...r,projectId:projectA.id,ownershipVersion:1}))));
const seedSessions=Array.from({length:200},(_,i)=>{const project=i%2?projectB:projectA;return{id:randomUUID(),title:'历史验收任务 '+String(i+1).padStart(3,'0'),status:'completed',createdAt:Date.now()-(i+1)*60000,config:{agentId:'codex',model:'gpt-5.4',permissionMode:'read-only',projectId:project.id,requirementId:requirement.id,workdir:project.primaryDirectory}}});
seedSessions.push({id:randomUUID(),title:'空间直属验收任务',status:'completed',createdAt:Date.now(),config:{agentId:'codex',model:'gpt-5.4',permissionMode:'read-only',projectId:projectA.id,workdir:workspaceA}});
put(join(data,'sessions.json'),JSON.stringify(seedSessions));

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
  await sleep(300);const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });const file = 'r03-r04-' + name + '.png';put(join(output, file), Buffer.from(pixels, 'base64'));shots.push({ file, description });console.log('SCREENSHOT ' + file)
}
function pass(name, detail) { results.push({ name, status: 'PASS', detail });console.log('PASS ' + name) }
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

async function openRequirement() {
  await click('.scope-nav-name', requirement.name)
  await wait(() => evaluate('return document.querySelector(".workspace-detail h1")?.textContent===' + JSON.stringify(requirement.name)))
}
async function settings() {
  await click('.sidebar-footer .settings-entry')
  await click('.set-nav-item', 'superAgent配置')
  await wait(() => evaluate('const el=document.querySelector(".settings-panel [aria-label=按项目和需求组织侧栏]");return !!el&&!el.disabled'))
}

try {
  await launch()
  await wait(() => evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'), Boolean, 'startup', 90000)
  await wait(() => evaluate('return !!document.querySelector(".scope-navigation")'), Boolean, 'new navigation')
  await click('[aria-label="展开产品工作台"]')
  await wait(() => evaluate('return document.querySelectorAll(".scope-nav-row.requirement").length===2'), Boolean, 'fixture space expanded')
  assert.equal((await api('getAppSettings')).spaceRequirementSidebar,true)
  assert.equal(await evaluate('return document.querySelectorAll(".scope-navigation [data-session-id]").length'),0)
  const baseline=originalSessions(await api('listSessions'))
  await click('.scope-nav-name',projectA.name)
  await wait(() => evaluate('return document.querySelectorAll(".scope-list-row").length===2'))
  await shot('01-空间详情','真实包空间页：需求与直属任务分开，侧栏没有 Session 子项')
  pass('默认新侧栏与空间详情', {seededTasks:seedSessions.length,sidebarRequirements:2})
  await click('.scope-list-row',empty.name)
  await wait(() => evaluate('return !!document.querySelector(".scope-empty button")'))
  await click('.scope-empty button')
  await wait(() => evaluate('return document.querySelector(".new-task .project-picker>summary")?.textContent.includes('+JSON.stringify(empty.name)+')'))
  assert.equal((await api('listSessions')).length,seedSessions.length)
  pass('空需求的新建入口带入归属，进入输入页不会提前创建任务')
  await click('.scope-nav-name',projectA.name)
  await click('.task-detail-tabs button','直属任务')
  assert.equal(await evaluate('return document.querySelectorAll(".scope-list-row[data-task-id]").length'),1)
  await openRequirement()
  await wait(() => evaluate('return document.querySelectorAll(".scope-list-row[data-task-id]").length===50'))
  await click('.scope-pagination button','下一页')
  assert.equal(await evaluate('return document.querySelector(".scope-pagination span").textContent'),'2 / 4')
  await evaluate('const el=document.querySelector(".workspace-detail-scroll");el.scrollTop=180;el.dispatchEvent(new Event("scroll",{bubbles:true}));return true')
  const rowId=await evaluate('return document.querySelector(".scope-list-row[data-task-id]").dataset.taskId')
  await click('.scope-list-row[data-task-id]')
  await wait(() => evaluate('return !!document.querySelector(".session-task-content")'))
  assert.equal(await evaluate('return document.querySelector(".session-task-content").dataset.taskId'),rowId)

  await click('[aria-label="返回工作详情"]')
  await wait(() => evaluate('return document.querySelector(".scope-pagination span")?.textContent==="2 / 4"'))
  assert.equal(await evaluate('return document.querySelector(".workspace-detail-scroll").scrollTop'),180)
  pass('200 条跨空间任务分页与任务详情返回', {taskId:rowId,page:2,scroll:180})
  await shot('02-需求任务列表','真实包需求任务列表：跨执行项目聚合，按页浏览')
  await click('.task-detail-tabs button','上下文')
  await wait(() => evaluate('return !!document.querySelector(".scope-context")'))
  assert.ok((await api('readRequirementOverview',requirement.id)).documents.some(doc=>doc.id==='sample-source'&&doc.status==='draft'))
  await shot('03-需求上下文','真实受管上下文只读展示，资料按需打开')
  const backup=coreBody+'.acceptance-backup'
  assert.ok(existsSync(coreBody),'fixture body exists')
  fsRename(coreBody,backup)
  try {
    await click('.task-detail-tabs button','任务');await click('.task-detail-tabs button','上下文')
    await wait(() => evaluate('return !!document.querySelector(".scope-error [type=button], .scope-error button")'))
    await click('.task-detail-tabs button','任务')
    assert.equal(await evaluate('return document.querySelectorAll(".scope-list-row[data-task-id]").length'),50)
  } finally { fsRename(backup,coreBody) }
  await click('.task-detail-tabs button','上下文');await wait(() => evaluate('return !!document.querySelector(".scope-context")'))
  pass('实际正文缺失时局部失败，任务浏览可用；恢复正文后可读取')

  await click('[aria-label="在R03 R04 浏览验收下新建任务"]')
  await wait(() => evaluate('return document.querySelector(".new-task .project-picker>summary")?.textContent.includes(' + JSON.stringify(requirement.name) + ')'))
  const beforeTurns=(await api('listSessions')).length
  const live=await createThroughUI('这是隔离真包验收。不要使用工具、修改文件或启动子 Agent；只回复“验收通过：R03 R04 任务已启动”。')
  assert.equal(live.config.requirementId,requirement.id);assert.equal(live.config.projectId,projectA.id)
  assert.equal(live.taskRegistration?.delivery,'dispatched')
  assert.ok(live.nativeSessionId)
  await wait(() => evaluate('return !!document.querySelector(".session-task-content")'))
  await shot('04-真实任务详情','通过侧栏加号创建并收到真实 Codex 回复，共享现有任务详情与对话')
  pass('实际输入框创建与真实 Codex 回复', {model:live.config.model,taskId:live.id})

  await openRequirement()
  await click('.scope-more>summary');await click('.scope-more button','需求设置')
  await wait(() => evaluate('return !!document.querySelector("[aria-label=需求主项目]")'))
  await evaluate('const el=document.querySelector("[aria-label=需求主项目]");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,'+JSON.stringify(projectB.id)+');el.dispatchEvent(new Event("change",{bubbles:true}));return true')
  await click('.project-editor-actions button','保存')
  await wait(() => evaluate('return !document.querySelector("[aria-label=需求主项目]")'))
  assert.equal(await evaluate('return !!document.querySelector(".scope-more[open]")'),false)
  await wait(() => evaluate('return document.querySelector(".workspace-detail .scope-space-link")?.textContent === ' + JSON.stringify(projectB.name)))
  assert.deepEqual(originalSessions(await api('listSessions')),baseline)
  await shot('05-需求换绑与导航更新','需求换主空间后侧栏与标题旁空间入口同步，原任务执行目录不变')
  await click('[aria-label="在R03 R04 浏览验收下新建任务"]')
  await wait(() => evaluate('return !!document.querySelector(".new-task .project-picker>summary")'))
  await click('.new-task .project-picker>summary')
  assert.ok(await evaluate('return [...document.querySelectorAll(".new-task .project-picker [aria-selected=true]")].some(el=>el.textContent.includes('+JSON.stringify(requirement.name)+'))'))
  assert.ok(await evaluate('const selected=[...document.querySelectorAll(".new-task .project-picker [aria-selected=true]")].find(el=>el.textContent.includes('+JSON.stringify(requirement.name)+'));return selected.parentElement.querySelector("button").textContent.includes('+JSON.stringify(projectB.name)+')'))
  await evaluate('document.querySelector(".new-task .project-picker").removeAttribute("open");return true')
  pass('实际换绑与新建归属，既有执行环境保持', {newOwner:projectB.name})

  await settings()
  await evaluate('document.querySelector("[aria-label=按项目和需求组织侧栏]").scrollIntoView({block:"center"});return true')
  await shot('06-侧栏样式设置','设置 → superAgent配置：默认开启，关闭恢复原多 Session 侧栏')
  await click('[aria-label="按项目和需求组织侧栏"]')
  await wait(() => api('getAppSettings'),s=>s.spaceRequirementSidebar===false,'style saved off')
  await click('.settings-panel .settings-back')
  await wait(() => evaluate('return !!document.querySelector(".session-list")&&!document.querySelector(".scope-navigation")'))
  await shot('07-恢复多会话侧栏','关闭开关后直接使用原 SessionList')
  assert.deepEqual(await evaluate('return window.__acceptanceErrors'),[])
  await stopApp();await launch()
  await wait(() => evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'),Boolean,'restart startup',90000)
  await wait(() => evaluate('return !!document.querySelector(".session-list")&&!document.querySelector(".scope-navigation")'))
  assert.equal((await api('getAppSettings')).spaceRequirementSidebar,false)
  pass('开关关闭值与旧侧栏在真实包重启后保留')
  await settings();await click('[aria-label="按项目和需求组织侧栏"]');await click('.settings-panel .settings-back')
  await wait(() => evaluate('return !!document.querySelector(".scope-navigation")&&!document.querySelector(".session-list")'))
  await openRequirement()
  assert.equal((await api('listSessions')).length,beforeTurns+1)
  assert.deepEqual(originalSessions(await api('listSessions')),baseline)
  pass('重新开启新侧栏，不重复创建任务或改变 Session 身份')
  await cdp('Emulation.setDeviceMetricsOverride',{width:1024,height:640,deviceScaleFactor:1,mobile:false})
  assert.ok(await evaluate('const el=document.querySelector("main.main");return el.scrollWidth<=el.clientWidth+1'))
  await shot('08-窄窗口需求详情','1024 × 640 真实 App，列表和导航不横向溢出')
  await settings();await click('.set-nav-item','需求')
  await wait(() => evaluate('return !!document.querySelector("[aria-label=启用需求]")'))
  await click('[aria-label="启用需求"]')
  await wait(() => api('getAppSettings'),s=>s.requirementsEnabled===false,'requirement feature off')
  await click('.settings-panel .settings-back')
  await wait(() => evaluate('return document.querySelectorAll(".scope-nav-row.requirement").length===0'))
  await click('.scope-nav-name',projectA.name)
  await wait(() => evaluate('return document.querySelectorAll(".scope-list-row[data-task-id]").length>0'))
  assert.equal((await api('getAppSettings')).spaceRequirementSidebar,true)
  pass('需求总开关独立，关闭后原任务仍可按执行项目浏览')
  assert.equal(hash(readFileSync(archive)),packageHash)
  assert.deepEqual(await evaluate('return window.__acceptanceErrors'),[])
} catch(error) {
  failure=error;console.error('FAIL '+error.message)
  if(cdp&&socket?.readyState===WebSocket.OPEN){try{await shot('99-失败现场','真实包验证失败现场')}catch{}}
} finally {
  try{await cleanup()}catch(error){failure ||= error}
  const report={status:failure?'failed':'passed',baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),packageSha256:packageHash,mode:'real packaged App, actual IPC and UI, isolated 201 historical tasks and one live Codex turn',results,screenshots:shots,...(failure?{error:failure.message}:{}),cleanup:'only verifier-owned processes and isolated fixtures'}
  put(resolve('docs/workspace-browser-acceptance.json'),JSON.stringify(report,null,2));console.log('RESULT '+report.status+' '+results.length+' checks')
}
if(failure)process.exitCode=1
