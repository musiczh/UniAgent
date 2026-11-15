// R07/R08/R09: owned packaged App, real IPC/UI and native Codex turns.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'
import { installMarkdownInputDriver } from './fixtures/markdown-input-driver.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/'), 'only launch the repository package')
const output = resolve('docs/mockups')
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'ua-task-acceptance-'))
const home = join(scratch, 'home'), data = join(scratch, 'data'), chromium = join(scratch, 'chromium')
const workspaceA = join(scratch, '产品工作台'), workspaceB = join(scratch, '执行验证')
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
  put(join(path, '验收样例.md'), '# Task 生命周期验收\n\n此目录仅用于隔离验证。禁止启动子 Agent、修改文件或读取目录外资料。\n')
}
const projectA = { id: randomUUID(), name: '产品工作台', primaryDirectory: workspaceA, additionalDirectories: [], isDefault: true, createdAt: Date.now(), updatedAt: Date.now() };
const projectB = { ...projectA, id: randomUUID(), name: '执行验证', primaryDirectory: workspaceB, isDefault: false };
put(join(data, 'projects.json'), JSON.stringify([projectA, projectB]));
const seedSessions=Array.from({length:75},(_,i)=>({id:randomUUID(),title:'历史任务 '+String(i+1).padStart(3,'0'),status:'completed',createdAt:Date.now()-(i+1)*60000,config:{agentId:'codex',model:'gpt-6.1-sol',permissionMode:'read-only',projectId:projectA.id,workdir:workspaceA}}));
seedSessions.push(...Array.from({length:1000},(_,i)=>({...seedSessions[0],id:randomUUID(),title:'已归档任务 '+i,archived:true})));
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
  cleaning ??= (async () => { await stopApp(); rmSync(scratch, { recursive: true, force: true }) })()
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
  await sleep(300);const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });const file = 'r07-r09-' + name + '.png';put(join(output, file), Buffer.from(pixels, 'base64'));shots.push({ file, description });console.log('SCREENSHOT ' + file)
}
function pass(name, detail) { results.push({ name, status: 'PASS', detail });console.log('PASS ' + name) }
async function board() { await click('.sidebar-nav-item','任务看板'); await wait(()=>evaluate('return !!document.querySelector(".task-board-card")'),Boolean,'board data') }
async function openTask(id) { await board(); await click('.task-board-card[data-task-id="'+id+'"]'); await wait(()=>evaluate('return document.querySelector(".session-task-content")?.dataset.taskId==='+JSON.stringify(id)),Boolean,'task detail') }
async function idle(id) { return wait(()=>api('listSessions'),rows=>{const s=rows.find(s=>s.id===id);return s&&['idle','completed','error','interrupted'].includes(s.status)},'native turn finished',240000) }
async function live(config, prompt) {
  const before=new Set((await api('listSessions')).map(row=>row.id))
  await click('[aria-label="新建任务"]')
  await wait(()=>evaluate('return !!document.querySelector(".new-task .project-picker>summary")'))
  await click('.new-task .project-picker>summary');await click('.new-task .project-picker [role=option]',projectA.name)
  await evaluate('const el=[...document.querySelectorAll(".new-task label.cfg")].find(e=>e.querySelector("span")?.textContent==="权限")?.querySelector("select");if(!el)throw Error("permission selector unavailable");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,'+JSON.stringify(config.permissionMode||'full-access')+');el.dispatchEvent(new Event("change",{bubbles:true}));return true')
  await fill('.new-task .prompt-input',prompt);await click('.new-task .btn-send')
  const rows=await wait(()=>api('listSessions'),rows=>rows.some(row=>!before.has(row.id)),'UI creates task',45000)
  const created=rows.find(row=>!before.has(row.id));assert.equal(created.config.projectId,projectA.id);assert.equal(created.config.model,'gpt-6.1-sol');return created
}

try {
  await launch()
  await wait(()=>evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'),Boolean,'startup',90000)
  await board()
  assert.equal(await evaluate('return document.querySelectorAll(".task-board-column").length'),3)
  assert.equal(await evaluate('return document.querySelectorAll("[data-column=active] .task-board-card").length'),30)
  assert.equal(await evaluate('return document.querySelector(".task-board-archive-toggle span").textContent'),'1000')
  assert.equal(await evaluate('return !!document.querySelector(".task-board-archive-area")'),false)
  assert.equal((await api('getTaskBoard')).archived,undefined)
  await click('[aria-label="进行中下一页"]')
  await wait(()=>evaluate('return document.querySelector("[data-column=active] .task-board-pagination span")?.textContent==="2 / 3"'))
  await evaluate('const e=document.querySelector("[data-column=active] .task-board-column-scroll");e.scrollTop=180;e.dispatchEvent(new Event("scroll"));return true')
  const historical=await evaluate('return document.querySelector("[data-column=active] .task-board-card:nth-child(3)").dataset.taskId')
  await click('[data-task-id="'+historical+'"]');await wait(()=>evaluate('return !!document.querySelector(".session-task-content")'))

  await click('[aria-label="返回任务看板"]')
  await wait(()=>evaluate('return document.querySelector("[data-column=active] .task-board-pagination span")?.textContent==="2 / 3"'))
  assert.equal(await evaluate('return document.querySelector("[data-column=active] .task-board-column-scroll").scrollTop'),180)
  await click('.task-board-archive-toggle');await wait(()=>evaluate('return document.querySelectorAll(".task-board-archive-cards .task-board-card").length===30'))
  await click('.task-board-archive-toggle')
  pass('真实看板的三列、75 条任务分页和返回位置、1000 条归档折叠按需分页')
  await click('[aria-label="进行中上一页"]');await wait(()=>evaluate('return document.querySelector("[data-column=active] .task-board-pagination span")?.textContent==="1 / 3"'))
  await shot('01-任务看板','三列、轻卡片和默认折叠的归档')

  const approval=await live({permissionMode:'ask'},'这是隔离验收任务。请立即使用 exec_command 执行一个无副作用命令：printf R07_APPROVAL_OK。此次必须设置 sandbox_permissions=require_escalated，并用 justification=“验证任务页的原生审批通道”，从而请求用户审批。不要读写文件，不要调用其他工具或子 Agent。审批通过、看到输出后只回复“审批验收通过”。')
  await wait(()=>api('getTaskDecisions',approval.id),list=>list.some(item=>item.type==='approval'),'real native approval',180000)
  await board();await wait(()=>evaluate('return !!document.querySelector("[data-column=decision] .task-board-card.high")'))
  await shot('02a-待决策看板','真实审批进入待决策列，卡片只提示状态，进详情再审批')
  await openTask(approval.id)
  await wait(()=>evaluate('return !!document.querySelector(".interaction-dock-slot .appr-accept")'),Boolean,'task focused approval')
  assert.ok(await evaluate('return document.querySelector(".interaction-dock-slot").textContent.includes("R07_APPROVAL_OK")'))
  await shot('02-原生审批','任务详情显示真实 Codex 命令审批，复用原审批表单')
  const before=await api('getTaskDecisions',approval.id)
  await click('.interaction-dock-slot .appr-accept');await idle(approval.id)
  assert.equal((await api('getTaskDecisions',approval.id)).length,0)
  await assert.rejects(api('resolveTaskDecision',approval.id,{id:before[0].id,version:before[0].version,actionId:randomUUID(),answer:{decision:'accept'}}),/失效/)
  assert.equal((await api('getTaskState',approval.id)).record.delivery,undefined)
  pass('真实原生审批在任务详情提交、陈旧操作拒绝、普通回复结束不进入验收',{taskId:approval.id})

  const decisionTask=await live({},'这是任务决策验收。不使用工具、子 Agent，只回复“本轮任务回答已完成”。')
  await idle(decisionTask.id)
  assert.equal((await api('getTaskState',decisionTask.id)).record.reports.length,0)
  await openTask(decisionTask.id)
  await wait(()=>evaluate('return !!document.querySelector(".task-decision-actions")'))
  assert.equal(await evaluate('return !!document.querySelector(".task-optional-delivery,.task-delivery-form,[aria-label=任务更多操作]")'),false)
  await shot('03-普通回复待决策','普通回复结束后直接决策，无交付材料或人工申报入口')
  await click('.task-decision-actions button','暂定')
  await wait(()=>api('getTaskState',decisionTask.id),s=>s.record.phase==='standby','user-deferred standby')
  await wait(()=>evaluate('return !!document.querySelector(".task-standby")'))
  await shot('04-待推进详情','用户暂定后进入待推进，原任务与对话保留')
  await board();await wait(()=>evaluate('return !!document.querySelector("[data-column=standby] [data-task-id=\\"'+decisionTask.id+'\\"]")'))
  pass('普通回复直接决策、移除交付材料与入口、待推进栏目唯一卡片',{taskId:decisionTask.id})

  const native=(await api('listSessions')).find(s=>s.id===decisionTask.id).nativeSessionId
  await stopApp();await launch()
  await wait(()=>evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'),Boolean,'restart startup',90000)
  assert.equal((await api('getTaskState',decisionTask.id)).record.phase,'standby')
  await openTask(decisionTask.id);await wait(()=>evaluate('return !!document.querySelector(".task-standby")'))
  assert.equal((await api('getTaskState',decisionTask.id)).record.phase,'standby','opening original composer does not accept new input')
  await wait(()=>evaluate('return !!document.querySelector(".session-view .composer-input")'))
  await fill('.session-view .composer-input','继续同一个任务，不使用工具、子 Agent 或交付申报，只回复“继续推进验收通过”。')
  await click('.session-view .composer-send-btn')
  await wait(()=>api('getTaskState',decisionTask.id),s=>s.record.phase==='active','accepted new input resumes task')
  const attempts=await Promise.allSettled([api('archiveSession',decisionTask.id)])
  assert.equal(attempts[0].status,'rejected','busy archive must refuse')
  await idle(decisionTask.id)
  assert.equal((await api('listSessions')).find(s=>s.id===decisionTask.id).nativeSessionId,native)
  assert.equal((await api('getTaskState',decisionTask.id)).record.reports.length,0)
  await wait(()=>evaluate('return !!document.querySelector(".session-task-content .event-stream")'))
  await wait(()=>evaluate('return !!document.querySelector(".session-task-content .event-stream")'))
  assert.ok(await evaluate('return document.querySelector(".session-task-content .event-stream").textContent.includes("继续推进验收通过")'))
  await shot('05-继续任务时间线','重启保留待推进，新输入接受后同一 Task/Session 继续')
  pass('真实 App 重启、原输入框继续、同一原生 Session、执行中归档拒绝和状态时间线',{nativeSessionPreserved:true})

  await api('archiveSession',decisionTask.id);await board()
  assert.equal((await api('getTaskBoard')).columns.active.items.some(row=>row.id===decisionTask.id),false)
  await click('.task-board-archive-toggle');await wait(()=>evaluate('return document.querySelector(".task-board-archive-cards")?.textContent.includes("任务")'))
  await shot('06-归档按需浏览','归档后移出活动列，仅展开归档区才显示')
  await api('unarchiveSession',decisionTask.id)
  assert.equal((await api('getTaskState',decisionTask.id)).record.phase,'active')
  pass('受控归档与恢复可见，不重放原输入')

  await click('.sidebar-footer .settings-entry');await click('.set-nav-item','superAgent配置')
  await wait(()=>evaluate('const el=document.querySelector("[aria-label=按项目和需求组织侧栏]");return !!el&&!el.disabled'))
  await click('[aria-label="按项目和需求组织侧栏"]');await click('.settings-panel .settings-back')
  await wait(()=>evaluate('return !!document.querySelector(".session-list")'))
  await board();await openTask(decisionTask.id)
  await wait(()=>evaluate('return !!document.querySelector(".session-view .composer-input")'))
  await shot('07-旧侧栏与原对话','关闭新侧栏后仍可进入看板，原对话与输入框完整复用')
  await board();await cdp('Emulation.setDeviceMetricsOverride',{width:1024,height:640,deviceScaleFactor:1,mobile:false})
  assert.ok(await evaluate('const e=document.querySelector("main.main");return e.scrollWidth<=e.clientWidth+1'))
  await shot('08-窄窗口看板','1024×640 真实包，三列看板不横向溢出')
  pass('新旧侧栏均有看板入口、对话原 UI 保留、1024px 布局')
  assert.equal(hash(readFileSync(archive)),packageHash)
  assert.deepEqual(await evaluate('return window.__acceptanceErrors'),[])
} catch(error) {
  failure=error;console.error('FAIL '+error.message)
  if(cdp&&socket?.readyState===WebSocket.OPEN){try{await shot('99-失败现场','真实包验证失败现场')}catch{}}
} finally {
  try{await cleanup()}catch(error){failure ||= error}
  const report={status:failure?'failed':'passed',baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),packageSha256:packageHash,
    mode:'real packaged App and IPC/UI, 75 historical tasks, 1000 archives, native Codex approval and ordinary reply decisions; same-Session continuation',results,screenshots:shots,...(failure?{error:failure.message}:{}),cleanup:'only verifier-owned processes and isolated fixtures'}
  put(resolve('docs/task-workbench-acceptance.json'),JSON.stringify(report,null,2));console.log('RESULT '+report.status+' '+results.length+' checks')
}
if(failure)process.exitCode=1
