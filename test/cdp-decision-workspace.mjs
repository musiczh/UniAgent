// Decision workspace: owned packaged App, real native turns, existing composer and four-column decisions.
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
  await sleep(300);const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });const file = 'decision-workspace-' + name + '.png';put(join(output, file), Buffer.from(pixels, 'base64'));shots.push({ file, description });console.log('SCREENSHOT ' + file)
}
function pass(name, detail) { results.push({ name, status: 'PASS', detail });console.log('PASS ' + name) }
async function board() { await click('.sidebar-nav-item','任务看板'); await wait(()=>evaluate('return !!document.querySelector(".task-board-card")'),Boolean,'board data') }
async function openTask(id) { await board();for(const title of ['进行中','待决策','待推进','已归档']){for(let i=0;i<40;i++){if(!await evaluate('const e=document.querySelector('+JSON.stringify('[aria-label="'+title+'上一页"]')+');return !!e&&!e.disabled'))break;await click('[aria-label="'+title+'上一页"]')}}await click('.task-board-card[data-task-id="'+id+'"]'); await wait(()=>evaluate('return document.querySelector(".session-task-content")?.dataset.taskId==='+JSON.stringify(id)),Boolean,'task detail') }
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
  assert.equal(await evaluate('return document.querySelectorAll(".task-board-column").length'),4)
  assert.equal(await evaluate('return document.querySelectorAll("[data-column=decision] .task-board-card").length'),30)
  assert.equal(await evaluate('return document.querySelectorAll("[data-column=archived] .task-board-card").length'),30)
  assert.equal((await api('getTaskBoard')).columns.archived.total,1000)
  await click('[aria-label="待决策下一页"]')
  await wait(()=>evaluate('return document.querySelector("[data-column=decision] .task-board-pagination span")?.textContent==="2 / 3"'))
  await evaluate('const e=document.querySelector("[data-column=decision] .task-board-column-scroll");e.scrollTop=180;e.dispatchEvent(new Event("scroll"));return true')
  const historical=await evaluate('return document.querySelector("[data-column=decision] .task-board-card:nth-child(4)").dataset.taskId')
  await click('[data-task-id="'+historical+'"]');await wait(()=>evaluate('return !!document.querySelector(".session-task-content")'))

  await click('[aria-label="返回任务看板"]')
  await wait(()=>evaluate('return document.querySelector("[data-column=decision] .task-board-pagination span")?.textContent==="2 / 3"'))
  assert.equal(await evaluate('return document.querySelector("[data-column=decision] .task-board-column-scroll").scrollTop'),180)
  await shot('01-四列看板','普通已结束任务待决策，归档第四列分页；轻卡不内联审批')
  pass('四列真实 IPC、75 条任务分页返回与 1000 条归档按页读取')

  const ordinary=await live({},'这是隔离验收。不要使用工具、不要读取或修改文件，也不要申报交付，只回复“第一轮普通回答已完成”。')
  await idle(ordinary.id)
  assert.equal((await api('getTaskState',ordinary.id)).record.delivery,undefined)
  assert.equal((await api('getTaskBoard')).columns.decision.items.some(row=>row.id===ordinary.id),true)
  await evaluate('window.__originalComposer=document.querySelector(".session-view .composer-input");return true')
  await fill('.session-view .composer-input','待保留的草稿')

  await wait(()=>evaluate('return !!document.querySelector(".session-task-content .task-decision-actions")'))
  assert.equal(await evaluate('return document.querySelector(".session-view .composer-input")===window.__originalComposer'),true)
  assert.ok(await evaluate('return document.querySelector(".session-view .composer-input").textContent.includes("待保留的草稿")'))
  await shot('02-普通回答决策','不调用交付工具，普通回答后显示暂定与任务完成；同一原输入框')
  await click('.task-decision-actions button','暂定')
  await wait(()=>api('getTaskState',ordinary.id),state=>state.record.phase==='standby','deferred by user')
  const native=(await api('listSessions')).find(session=>session.id===ordinary.id).nativeSessionId
  await board();await shot('03-待推进','用户暂定后进入待推进，原 Task 与 Session 保留')
  await stopApp();await launch()
  await wait(()=>evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'),Boolean,'restart startup',90000)
  assert.equal((await api('getTaskState',ordinary.id)).record.phase,'standby')
  await openTask(ordinary.id)
  await fill('.session-view .composer-input','继续同一个任务，不使用工具、不申报交付，只回复“第二轮继续推进成功”。')
  await click('.session-view .composer-send-btn')
  await wait(()=>api('getTaskState',ordinary.id),state=>state.record.phase==='active','accepted input resumes original task')
  await assert.rejects(api('archiveSession',ordinary.id),/仍在执行|排队/)
  await idle(ordinary.id)
  assert.equal((await api('listSessions')).find(session=>session.id===ordinary.id).nativeSessionId,native)
  await wait(()=>evaluate('return !!document.querySelector(".task-decision-actions button.primary")&&!document.querySelector(".task-decision-actions button.primary").disabled'))
  await wait(()=>evaluate('return document.querySelectorAll(".session-task-content .user-msg").length===2'))
  assert.ok(await evaluate('return document.querySelector(".session-task-content .event-stream").textContent.includes("第二轮继续推进成功")'))
  await shot('04-完整对话历史','统一聊天流保留两轮输入、回答与执行记录')
  await click('.task-decision-actions button','任务完成')
  await wait(()=>evaluate('return !!document.querySelector(".task-board")'))
  assert.equal((await api('getTaskState',ordinary.id)).record.phase,'archived')
  pass('普通回答无需工具申报、原输入框节点与草稿、暂定重启、同一原生 Session 继续、忙归档拒绝和完成返回看板')

  const requirement=await api('createRequirement',{name:'决策工作台验收',projectId:projectA.id})
  const prompt=marker=>'这是隔离 UI 验收。请仅用 exec_command 执行无副作用命令 printf '+marker+'。必须设置 sandbox_permissions=require_escalated，并填写 justification=“验证聚合卡原生审批通道”。审批通过后只回复“'+marker+' 已完成”。不要读写文件，不要调用其他工具或子 Agent。'
  const approvals=[]
  for(const [index,project] of [projectA,projectB].entries()) approvals.push(await api('createSession',{agentId:'codex',model:'gpt-6.1-sol',permissionMode:'ask',projectId:project.id,requirementId:requirement.id,workdir:project.primaryDirectory},prompt('DECISION_'+index+'_OK')))
  for(const task of approvals) await wait(()=>api('getTaskDecisions',task.id),items=>items.some(item=>item.type==='approval'),'real native approval '+task.id,180000)
  await board()
  await wait(()=>evaluate('return document.querySelector(".task-focus-queue .approval-wait-chip")?.textContent.includes("2")'))
  await shot('05-聚合原生审批','真实 Codex 两个任务同时等待审批，一张主卡与折叠队列')
  if(!await evaluate('return [...document.querySelectorAll(".scope-nav-row.requirement .scope-nav-name")].some(e=>e.textContent.includes('+JSON.stringify(requirement.name)+'))')) await click('[aria-label="展开'+projectA.name+'"]')
  await click('.scope-nav-row.requirement .scope-nav-name',requirement.name)
  await wait(()=>evaluate('return !!document.querySelector(".workspace-detail .task-focus-queue")'))
  assert.equal((await api('getTaskBoard',{requirementId:requirement.id})).focus.length,2)
  assert.equal(await evaluate('return document.querySelectorAll(".workspace-detail .task-board-column").length'),4)
  await shot('06-需求详情聚焦','同一需求的两个跨空间任务，上方带背景的原生审批，下方四列')
  const visibleId=await evaluate('return [...document.querySelectorAll(".task-focus-panel")].find(e=>!e.hidden).dataset.focusTaskId')
  const first=approvals.find(task=>task.id===visibleId),second=approvals.find(task=>task.id!==visibleId)
  await click('.task-focus-panel:not([hidden]) .appr-accept')
  await wait(()=>evaluate('return [...document.querySelectorAll(".task-focus-panel")].some(e=>!e.hidden&&e.dataset.focusTaskId==='+JSON.stringify(second.id)+')'),Boolean,'next focused task')
  await idle(first.id)
  await shot('07-下一张审批卡','原生响应确认后移除已处理任务，下一张进入')
  await click('.task-board-card[data-task-id="'+second.id+'"]')
  await wait(()=>evaluate('const stream=document.querySelector(".session-task-content .event-stream");return !!stream&&getComputedStyle(stream).visibility==="visible"&&!!document.querySelector(".interaction-dock-slot .appr-accept")'))
  await shot('08-任务页原审批','完整对话持续可见；同一原对话审批卡与原输入框')
  await click('.interaction-dock-slot .appr-accept');await idle(second.id)
  await wait(()=>evaluate('return !!document.querySelector(".task-decision-actions button.primary")&&!document.querySelector(".task-decision-actions button.primary").disabled'))
  await click('.task-decision-actions button','任务完成')
  await wait(()=>evaluate('return !!document.querySelector(".workspace-detail .task-board-columns")'))
  assert.equal((await api('getTaskState',second.id)).record.phase,'archived')
  await api('sendMessage',first.id,'继续此任务，仅使用 exec_command 执行 sleep 5 然后 printf CURRENT_ROUND_OK，不读取文件、不修改文件、不请求提权、不使用其他工具。结束后回复“本轮执行完成”。')
  await wait(()=>api('getEvents',first.id),events=>events.some(event=>event.type==='command_exec'&&event.state==='running'),'native running command',180000)
  await openTask(first.id)
  assert.ok(await evaluate('return !!document.querySelector(".session-task-content .composer-stop-btn")'))
  await shot('09-当前轮运行','当前轮输入与原执行时间轴，工具默认折叠，原中断和模型控件保留')
  await idle(first.id)
  await evaluate('document.querySelectorAll(".processed-fold.closed>.processed-head,.steps-fold-row[aria-expanded=false]").forEach(button=>button.click());return true')
  await wait(()=>evaluate('return document.querySelector(".session-task-content .event-stream").textContent.includes("CURRENT_ROUND_OK")'))
  await shot('10-展开工作过程','原聊天流展开工具及阶段输出，工具详情仍折叠')
  pass('两个真实原生审批、需求跨执行空间聚合、主卡确认后换卡、任务页原审批与当前轮真实工具时间轴')

  await board();assert.equal(await evaluate('return !!document.querySelector(".task-focus-queue")'),false)
  await cdp('Emulation.setDeviceMetricsOverride',{width:1024,height:640,deviceScaleFactor:1,mobile:false})
  assert.equal(await evaluate('const e=document.querySelector("main.main");return e.scrollWidth<=e.clientWidth+1'),true)
  assert.equal(await evaluate('return document.querySelectorAll(".task-board-column").length'),4)
  await shot('11-窄窗口四列','1024×640 真实 App 四列看板，无问题区域不占位')
  pass('真实包窄窗口四列与无问题零占位')
  assert.equal(hash(readFileSync(archive)),packageHash)
  assert.deepEqual(await evaluate('return window.__acceptanceErrors'),[])
} catch(error) {
  failure=error;console.error('FAIL '+error.stack)
  if(cdp&&socket?.readyState===WebSocket.OPEN){try{await shot('99-失败现场','真实包验证失败现场，不计为通过截图')}catch{}}
} finally {
  try{await cleanup()}catch(error){failure ||= error}
  const report={status:failure?'failed':'passed',baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),packageSha256:packageHash,
    mode:'real packaged App and IPC/UI; ordinary reply without task_delivery, original composer, durable defer/restart, same Session, two native Codex approvals, requirement scope and current-turn tools',results,screenshots:shots,...(failure?{error:failure.message}:{}),cleanup:'only verifier-owned processes and isolated fixtures'}
  put(resolve('docs/decision-workspace-acceptance.json'),JSON.stringify(report,null,2));console.log('RESULT '+report.status+' '+results.length+' checks')
}
if(failure)process.exitCode=1
