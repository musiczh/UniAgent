// Actual packaged renderer + preload/main IPC + live Agent acceptance. No mocked DOM or IPC.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/'), 'only repository packaged App can be launched')
const output = resolve(process.argv[3] || 'docs/requirements-space/acceptance-v2')
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'ua-requirements-cdp-'))
const isolatedHome = join(scratch, 'home')
const data = join(scratch, 'uniagent-data')
const workspace = join(scratch, '订单服务')
const otherWorkspace = join(scratch, '管理后台')
const chromium = join(scratch, 'chromium')
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8', SHELL: '/usr/bin/false',
  HOME: isolatedHome, USERPROFILE: isolatedHome, USER: 'uniagent-test', LOGNAME: 'uniagent-test',
  UNIAGENT_USER_DATA: data, CODEX_HOME: join(isolatedHome, '.codex'), TRAE_HOME: join(isolatedHome, '.trae'),
  CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'), TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
  XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
  XDG_STATE_HOME: join(scratch, 'xdg-state'), XDG_RUNTIME_DIR: join(scratch, 'xdg-runtime'), ZDOTDIR: join(scratch, 'zdotdir'),
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
  NPM_CONFIG_CACHE: join(scratch, 'npm-cache'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local-appdata'),
  UNIAGENT_CAPABILITY_HOME: isolatedHome, UNIAGENT_CAPABILITY_DATA: join(isolatedHome, '.uniagent-capability-data'), UA_DISABLE_GPU: '1'
}
for (const path of [isolatedHome, data, workspace, otherWorkspace, chromium, ...Object.entries(env).filter(([k]) => /^(XDG_|TMP|ZDOTDIR|APPDATA|LOCALAPPDATA|NPM_CONFIG_CACHE|UNIAGENT_CAPABILITY_DATA)/.test(k)).map(([,v]) => v)]) mkdirSync(path, { recursive: true })
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode: 0o600 }) }
for (const relative of ['.codex/auth.json', '.codex/models_cache.json', '.trae/cli/auth.json', '.trae/cli/models_cache.json']) {
  const source = join(homedir(), relative), target = join(isolatedHome, relative)
  if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
}
put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, autoCheckUpdate: false, enabledAgentIds: ['codex','traex'], theme: 'dark', notificationMode: 'off' }))
put(join(workspace, 'src/orders.ts'), 'export function orderTotal(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + price, 0)\n}\n')
put(join(workspace, '验收说明.md'), '# 订单导出验收\n\n产品暗号：琥珀海豚。导出格式：CSV。数据保留期：30天。\n')
put(join(scratch, 'gitconfig'), '[user]\n name = UniAgent Acceptance\n email = test@example.invalid\n')
put(join(scratch, 'npmrc'), '')
for (const root of [workspace, otherWorkspace]) execFileSync('/usr/bin/git', ['init', '-q', root], { env, stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = [], shots = []
const sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
let child, socket, cdp, stderr = '', failed, cleaning
async function cleanup() {
  if (cleaning) return cleaning
  cleaning = (async () => { socket?.close(); await sweeper.sweep(); rmSync(scratch, { recursive: true, force: true }) })()
  return cleaning
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })
async function wait(probe, accept = Boolean, label = 'condition', timeout = 20000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) { last = await probe(); if (accept(last)) return last; await sleep(150) }
  throw new Error('Timeout: ' + label + '; last=' + JSON.stringify(last))
}
async function launch() {
  const server = createServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise(r => server.close(r))
  child = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + chromium, '--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling'], { env, cwd: workspace, detached: true, stdio: ['ignore','pipe','pipe'] })
  console.log('LAUNCH pid=' + child.pid + ' port=' + port)
  child.stdout.on('data', c => { stderr = (stderr + c).slice(-12000) })
  child.stderr.on('data', c => { stderr = (stderr + c).slice(-12000) })
  await new Promise((r,j) => { child.once('spawn',r); child.once('error',j) })
  await sweeper.addRoot(child.pid)
  const renderer = join(binary.slice(0, binary.indexOf('/Contents/MacOS/')), 'Contents/Resources/app.asar.unpacked/out/renderer/index.html')
  const page = await wait(async () => {
    try { const pages = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1200) })).json(); const page=pages.find(p => p.type === 'page' && p.url.startsWith('file:') && fileURLToPath(p.url) === renderer); return page }
    catch { return null }
  }, Boolean, 'exact packaged renderer', 35000)
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r,j) => { socket.addEventListener('open',r,{once:true}); socket.addEventListener('error',j,{once:true}) })
  let seq = 0
  const pending = new Map()
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data), task = pending.get(m.id)
    if (task) { pending.delete(m.id); clearTimeout(task.timer); m.error ? task.reject(new Error(JSON.stringify(m.error))) : task.resolve(m.result) }
  })
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)) }, 30000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Runtime.enable'); await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await wait(() => evaluate('return !!window.uniagent && !!document.querySelector(".new-task")'), Boolean, 'app UI')
  if (existsSync(join(output,'debug-main.log'))) rmSync(join(output,'debug-main.log'))
  await evaluate('window.__acceptanceEvents=[]; window.uniagent.onEvent(e=>window.__acceptanceEvents.push(e)); return true')
}
async function evaluate(body) {
  const r = await cdp('Runtime.evaluate', { expression: '(async()=>{' + body + '\n})()', awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
const api = (method, ...args) => evaluate('return window.uniagent[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')')
async function click(selector, text) {
  const point = await evaluate('const el=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.getBoundingClientRect().width>0' + (text ? '&&e.textContent.includes(' + JSON.stringify(text) + ')' : '') + '); if(!el)throw Error("missing element: " + ' + JSON.stringify(selector+' '+(text||'')) + ');el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}')
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(180)
}
async function fill(selector, value) {
  await click(selector)
  await evaluate('const el=document.querySelector(' + JSON.stringify(selector) + ');const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(el,' + JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));return true')
  await sleep(100)
}
async function shot(file, title) {
  await sleep(250)
  const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(output, file+'.png'), Buffer.from(pixels, 'base64'))
  shots.push({ file:file+'.png', title }); console.log('SCREENSHOT ' + file + ': ' + title)
}
function pass(name, detail = '') { results.push({ name, status: 'PASS', detail }); console.log('PASS ' + name + (detail ? ': '+detail : '')) }
async function newTask() { await click('[aria-label="新建任务"]'); await wait(() => evaluate('return !!document.querySelector(".new-task")')); }
async function settings() { await click('.settings-entry'); await click('.set-nav-item', '需求'); }
async function viewByRequirement() {
  await evaluate('const b=document.querySelector(".sl-view .sl-seg button[data-view=\\"byRequirement\\"]");if(b){b.click();}else{[...document.querySelectorAll(".sl-tab")].find(e=>e.textContent.includes("按需求"))?.click();}return true')
  await sleep(200)
}
async function selectSession(id) {
  await wait(()=>evaluate('return !!document.querySelector(' + JSON.stringify('[data-session-id="' + id + '"]') + ')'),Boolean,'session row '+id,30000)
  await click('[data-session-id="' + id + '"]')
}
async function completed(id) {
  return wait(() => api('listSessions'), rows => rows.find(s => s.id===id && ['completed','idle','error'].includes(s.status)), 'Agent completion '+id, 210000)
}
async function createLiveSession(projectName, prompt) {
  const previous = new Set((await api('listSessions')).map(s=>s.id))
  if (await evaluate('return document.querySelector(".new-task .sb-agent")?.dataset.agentId!=="traex"')) {
    await click('.new-task .sb-agent > summary')
    await click('.new-task .sb-agent .sb-sub-entry','Agent')
    await wait(()=>evaluate('return [...document.querySelectorAll(".sb-sub-menu [role=option]")].some(e=>e.textContent.includes("TraeX"))'))
    await click('.sb-sub-menu [role=option]','TraeX')
    await evaluate('document.querySelector(".new-task .sb-agent")?.removeAttribute("open");return true')
  }
  await click('.project-picker:not(.requirement-picker) > summary')
  await click('.project-picker:not(.requirement-picker) [role="option"]', projectName)
  await evaluate('const s=[...document.querySelectorAll(".new-task select")].find(e=>[...e.options].some(o=>o.value==="full-access"));if(s){s.value="full-access";s.dispatchEvent(new Event("change",{bubbles:true}));}return true')
  await fill('.new-task .prompt-input', prompt)
  await click('.new-task .btn-send')
  const rows=await wait(()=>api('listSessions'),r=>r.some(s=>!previous.has(s.id)),'session created through UI')
  return rows.find(s=>!previous.has(s.id))
}
try {
  await launch()
  assert.ok(existsSync(join(data,'requirements.json')) && existsSync(join(data,'requirement-guide.md')))
  assert.deepEqual(await api('listRequirements'), [])
  pass('启动自动准备索引和规范，尚未创建任何 Agent 会话')
  await wait(() => evaluate('return !!document.querySelector(".requirement-picker > summary")'), Boolean, 'new task Agent initialization', 90000)
  await shot('01-new-task','新建任务中的需求选择入口')
  await click('.requirement-picker > summary')
  await click('.requirement-picker .project-picker-create')
  await fill('.requirement-picker .requirement-create-input input', '订单导出需求')
  await shot('02-create-requirement','这一行原地变输入框，独立于空间创建')
  await click('.requirement-picker .requirement-create-ok')
  await wait(() => api('listRequirements'), r => r.length===1, 'requirement creation')
  const requirement = (await api('listRequirements'))[0]
  assert.equal(requirement.docPath, join(data,'requirements','订单导出需求','context.md'))
  assert.ok(existsSync(requirement.docPath))
  pass('通过实际创建弹窗生成命名目录与 context.md')
  await click('.requirement-picker > summary')
  await fill('.requirement-picker input', '订单')
  await shot('03-requirement-picker','搜索并选择需求；可不归入需求')
  await click('.requirement-picker [role="option"]','订单导出需求')
  const project = await api('createProject', { name:'订单服务',primaryDirectory:workspace,additionalDirectories:[] })
  const otherProject = await api('createProject', { name:'管理后台',primaryDirectory:otherWorkspace,additionalDirectories:[] })
  await evaluate('window.dispatchEvent(new Event("uniagent-projects-changed"));return true')
  const agents = await wait(() => api('listAgents'), a => a.some(x=>x.id==='traex'&&x.lifecycle?.availability==='available'), 'TraeX ready', 90000)
  const target = agents.find(a=>a.id==='traex')
  console.log('LIVE_AGENT ' + JSON.stringify({id:target.id,available:target.lifecycle?.availability}))
  const prompt = '这是隔离验收任务，不允许启动子 Agent。已确认需求：产品暗号琥珀海豚，导出格式 CSV，保留期30天。请读取工作目录的验收说明.md 和 src/orders.ts，禁止直接编辑需求受管文档。使用 requirement_context bootstrap 获取核心、状态、导航和规范；用 pending 找到本条用户原文的 sessionId、seq。用 commit（expectedRevision、唯一 operationId、documents）原子维护 core（背景和已确认约束）、state（当前验收阶段）、knowledge/order-total（id=order-total，共享的 orderTotal 职责说明），并引用真实用户或工具事件的 sources。核心和状态用本条用户原文证据，知识优先用实际读取代码的工具证据；将源码实际位置作为 reference。不要把知识链路全文塞进 core，不保存逐轮日志。当前轮次未结束，不确认当前输入游标；只可确认已读 completedSeq 以内的前轮稳定内容，最终只回复验收首轮完成。'
  const first = await createLiveSession('订单服务',prompt)
  await viewByRequirement(); await selectSession(first.id)
  await shot('04-session-running','真实 TraeX 会话在需求分组中运行')
  await completed(first.id)
  const events = await evaluate('return window.__acceptanceEvents.filter(e=>e.sessionId===' + JSON.stringify(first.id) + ')')
  put(join(output,'first-turn-events.json'),JSON.stringify(events,null,2))
  await wait(async()=>readFileSync(requirement.docPath,'utf8'),t=>t.includes('琥珀海豚')&&/30\s*天/.test(t),'first context write',15000)
  assert.match(readFileSync(join(requirement.dir,'knowledge','order-total.md'),'utf8'), /orderTotal/)
  assert.ok(!readFileSync(requirement.docPath,'utf8').includes('<!-- turn:'))
  pass('真实 TraeX 维护分层文档，不保存逐轮日志')
  await evaluate('const t=document.querySelector(".turn-timer");t&&t.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))')
  await wait(() => evaluate('return !!document.querySelector(".timer-summary-pop.open .requirement-summary")'))
  await shot('05-summary-requirement','摘要显示所属需求，点击可打开文档')
  await click('.requirement-summary')
  await wait(() => evaluate('return document.querySelector(".fb-markdown")?.textContent.includes("琥珀海豚")'))
  assert.ok(await evaluate('return document.querySelector(".fb-root")?.textContent.includes("订单导出需求") || document.querySelector(".filebrowser")?.textContent.includes("context.md")'))
  await shot('06-context-document','实际 Markdown 需求上下文与需求目录文件树')
  pass('摘要在现有 FileBrowser 打开真实 context.md')
  put(join(requirement.dir,'验收附件.md'),'# 验收附件\n\n这是独立需求目录内的辅助资料。\n')
  await click('[aria-label="关闭文件浏览器"]')
  await viewByRequirement();await click('.sl-group .sl-group-add')
  const second = await createLiveSession('管理后台','这是隔离验收第二会话，不启动子 Agent，不查看其他会话历史。使用宿主核心和 requirement_context bootstrap，并按 documentId=order-total 读取相关知识，回答产品暗号、导出格式、原保留期及 orderTotal 职责。本轮明确要求将保留期改为90天，其余有效约定保留。用 pending 获取本轮用户原文的真实 sessionId 和 seq 后，以用户来源 commit 原子更新 core 和 state；核心不保留30天的旧规则，state 不宣称未做的验证已通过。expectedRevision 冲突时重读合并，当前轮次未结束，不确认当前输入游标；只可确认已读 completedSeq 以内的前轮稳定内容。最终回答这些信息。')
  await viewByRequirement(); await selectSession(second.id)
  await completed(second.id)
  await wait(async()=>readFileSync(requirement.docPath,'utf8'),t=>/90\s*天/.test(t),'second context write',15000)
  const secondEvents = await evaluate('return window.__acceptanceEvents.filter(e=>e.sessionId===' + JSON.stringify(second.id) + ')')
  put(join(output,'second-turn-events.json'),JSON.stringify(secondEvents,null,2))
  assert.ok(JSON.stringify(secondEvents).includes('琥珀海豚'))
  await shot('07-cross-space-memory','另一空间新会话读取需求背景并将保留期更新为90天')
  pass('跨空间新 Session 从共享文档获得信息并修正背景')
  const actualBackground=readFileSync(requirement.docPath,'utf8')
  assert.match(actualBackground,/90\s*天/)
  assert.doesNotMatch(actualBackground,/30\s*天/)
  await viewByRequirement()
  const group = await evaluate('return [...document.querySelectorAll(".sl-group")].find(e=>e.querySelector(".sl-group-name")?.textContent==="订单导出需求")?.querySelectorAll("[data-session-id]").length')
  assert.equal(group,2)
  await shot('08-requirement-group','同一需求聚合两个不同空间的会话')
  pass('按需求分组聚合跨空间会话')
  await click('.sl-group .sl-group-add')
  assert.ok(await evaluate('return document.querySelector(".requirement-picker summary")?.textContent.includes("订单导出需求")'))
  await shot('09-group-quick-create','分组加号新建会话，自动预选所属需求')
  pass('分组快捷新建自动预选需求')
  await settings()
  await shot('10-requirement-settings','设置中的需求管理：改名、完成、归档、打开目录')
  await click('.project-settings-actions button','完成')
  await wait(()=>api('listRequirements'),r=>r[0].status==='done')
  await shot('10b-completed-requirement','需求标记已完成，仍保留文档和会话')
  pass('需求标记完成且保留会话')
  await api('updateRequirement',requirement.id,{status:'active'})
  await click('.project-settings-actions button','改名')
  await fill('.project-editor input','订单导出需求 · 验收')
  await click('.project-editor .is-primary')
  await wait(() => api('listRequirements'),r=>r[0].name==='订单导出需求 · 验收')
  const renamed = (await api('listRequirements'))[0]
  assert.equal(renamed.id,requirement.id)
  assert.ok(existsSync(join(renamed.dir,'验收附件.md')))
  assert.equal(existsSync(requirement.dir),false)
  await shot('11-rename','改名后稳定关联不变，目录与附件同步迁移')
  pass('需求改名移动目录，保留两会话关联与附件')
  await selectSession(second.id)
  await viewByRequirement()
  const sessionPoint = await evaluate('const e=document.querySelector(' + JSON.stringify('[data-session-id="'+second.id+'"]') + ');const r=e.getBoundingClientRect();return {x:r.x+90,y:r.y+r.height/2}')
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...sessionPoint})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...sessionPoint})
  await wait(() => evaluate('return !!document.querySelector(".ctx-menu")'))
  assert.ok(!(await evaluate('return document.querySelector(".ctx-menu")?.textContent.includes("归档需求")')))
  await click('.ctx-backdrop')
  const requirementPoint = await evaluate('const e=[...document.querySelectorAll(".sl-group-head")].find(e=>e.querySelector(".sl-group-name")?.textContent===' + JSON.stringify(renamed.name) + ');const r=e.getBoundingClientRect();return {x:r.x+90,y:r.y+r.height/2}')
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...requirementPoint})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...requirementPoint})
  await wait(() => evaluate('return document.querySelector(".ctx-menu")?.textContent.includes("打开需求上下文")'))
  await shot('12-archive-context-menu','需求目录右键提供打开上下文与归档，Session 右键移除归档需求')
  await click('.ctx-menu button','打开需求上下文')
  await wait(()=>evaluate('return document.querySelector(".fb-markdown")?.textContent.includes("90")'))
  pass('需求目录右键可打开需求上下文')
  await click('[aria-label="关闭文件浏览器"]')
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...requirementPoint})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...requirementPoint})
  // Accept the real native confirm via CDP, never replace window.confirm.
  const dialog = new Promise(resolveDialog => {
    const listener = e => { const m=JSON.parse(e.data);if(m.method==='Page.javascriptDialogOpening'){socket.removeEventListener('message',listener);resolveDialog(m.params)} }
    socket.addEventListener('message',listener)
  })
  const archiveClick = click('.ctx-menu button','归档需求')
  const params = await Promise.race([dialog,sleep(10000).then(()=>{throw Error('archive confirm not opened')})])
  assert.match(params.message,/只修改需求状态/)
  put(join(output,'archive-confirm.json'),JSON.stringify(params,null,2))
  await cdp('Page.handleJavaScriptDialog',{accept:false});await archiveClick
  assert.equal((await api('listRequirements'))[0].status,'active')
  pass('原生归档确认框取消后保持原状态')
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...requirementPoint})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...requirementPoint})
  const acceptedDialog = new Promise(resolveDialog => {
    const listener=e=>{const m=JSON.parse(e.data);if(m.method==='Page.javascriptDialogOpening'){socket.removeEventListener('message',listener);resolveDialog(m.params)}}
    socket.addEventListener('message',listener)
  })
  const acceptedClick=click('.ctx-menu button','归档需求')
  await Promise.race([acceptedDialog,sleep(10000).then(()=>{throw Error('archive confirm not opened')})])
  await cdp('Page.handleJavaScriptDialog',{accept:true});await acceptedClick
  await wait(()=>api('listRequirements'),r=>r[0].status==='archived')
  const sessions = await api('listSessions')
  assert.ok([first.id,second.id].every(id=>!sessions.find(s=>s.id===id).archived))
  await viewByRequirement();await click('.sl-archive-head','已归档需求')
  await shot('13-archived-requirement','归档需求折叠区保留两个会话')
  pass('归档仅改变需求状态，不归档或删除所属会话')
  const archiveStyle=await evaluate('const b=[...document.querySelectorAll(".sl-archive-head")].find(e=>e.textContent.includes("已归档需求"));const s=getComputedStyle(b);return {border:s.borderTopWidth,background:s.backgroundColor}')
  assert.equal(archiveStyle.border,'0px')
  assert.notEqual(archiveStyle.background,'rgb(239, 239, 239)')
  pass('归档需求入口沿用现有侧栏深色样式')
  await evaluate('const t=document.querySelector(".turn-timer");t&&t.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))');await click('.timer-summary-pop .requirement-summary')
  await wait(()=>evaluate('return document.querySelector(".fb-markdown")?.textContent.includes("已归档")'))
  await shot('13b-archived-document','已归档需求仍可从摘要打开上下文')
  await click('[aria-label="关闭文件浏览器"]')
  await newTask();await click('.requirement-picker > summary')
  assert.ok(!(await evaluate('return document.querySelector(".requirement-picker .project-picker-list")?.textContent')).includes('订单导出需求'))
  pass('新建任务选择器隐藏已归档需求')
  await settings();await click('.project-settings-actions button','恢复')
  await wait(() => api('listRequirements'),r=>r[0].status==='active')
  await shot('14-restored-requirement','在设置中恢复已归档需求')
  pass('恢复需求后重新可用')
  await selectSession(second.id);await evaluate('const t=document.querySelector(".turn-timer");t&&t.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))');await click('.timer-summary-pop .requirement-summary')
  await wait(() => evaluate('return /90\\s*天/.test(document.querySelector(".fb-markdown")?.textContent||"")'))
  await shot('15-evolved-context','最新需求核心；进展和技术知识保存在独立文档')
  await click('.fb-tree-node','验收附件.md')
  await wait(() => evaluate('return document.querySelector(".fb-markdown")?.textContent.includes("独立需求目录")'))
  await shot('16-supporting-files','需求目录中的辅助资料可直接阅读')
  pass('需求辅助资料可在同一文件查看器阅读')
  put(join(output,'context-result.md'),readFileSync(renamed.docPath,'utf8'))
  socket.close(); await sweeper.sweep(); await launch()
  const restored = await api('listRequirements'), restoredSessions = await api('listSessions')
  assert.equal(restored[0].name,'订单导出需求 · 验收')
  assert.ok([first.id,second.id].every(id=>restoredSessions.find(s=>s.id===id)?.config.requirementDocPath===restored[0].docPath))
  await wait(()=>evaluate('return document.querySelectorAll(".session-item").length>=2'),Boolean,'rehydrated sidebar',30000)
  await viewByRequirement();await selectSession(second.id)
  await shot('17-restart-persistence','重启实际 App 后恢复需求名称、会话分组与文档关联')
  pass('实际 App 重启后需求与 Session 关联持久化')
  await selectSession(first.id)
  const hoverPoint=await evaluate('const r=document.querySelector('+JSON.stringify('[data-session-id="'+first.id+'"]')+').getBoundingClientRect();return {x:r.x+80,y:r.y+r.height/2}')
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverPoint})
  await click('[data-session-id="'+first.id+'"] .si-act[title="归档"]')
  await wait(()=>api('listSessions'),rows=>rows.find(s=>s.id===first.id)?.archived)
  await click('.sl-drawer-heads .sl-archive-head','已归档')
  const archivedPoint=await evaluate('const e=document.querySelector(' + JSON.stringify('[data-session-id="'+first.id+'"]') + ');const r=e.getBoundingClientRect();return {x:r.x+85,y:r.y+r.height/2}')
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...archivedPoint})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...archivedPoint})
  assert.ok(!(await evaluate('return document.querySelector(".ctx-menu")?.textContent.includes("归档需求")')))
  await shot('18-archived-session-menu','已归档会话右键仅保留会话级操作')
  pass('Session 右键不再提供归档需求')
  await click('.ctx-backdrop')
  await click('.session-item.archived .si-act[title="恢复"]')
  await wait(()=>api('listSessions'),rows=>!rows.find(s=>s.id===first.id)?.archived)
  const concurrentPrompt=marker=>'并发同步验收，不启动子 Agent，不直接写受管文件。用 requirement_context bootstrap 读取最新核心和 state；pending 获取本条用户原文来源。commit 以 expectedRevision 和唯一 operationId 更新 id=state、kind=state 的当前进展，在保留现有内容基础上追加“'+marker+'”，sources 引用本条用户原文。版本冲突时重读并合并，不覆盖另一会话的贡献；当前轮次未结束，不确认当前输入游标；只可确认已读 completedSeq 以内的前轮稳定内容。最终回复“'+marker+'已保存”。'
  await Promise.all([api('sendMessage',first.id,concurrentPrompt('并发验收甲')),api('sendMessage',second.id,concurrentPrompt('并发验收乙'))])
  await Promise.all([completed(first.id),completed(second.id)])
  await wait(async()=>readFileSync(join(renamed.dir,'state.md'),'utf8'),t=>t.includes('并发验收甲')&&t.includes('并发验收乙'),'two concurrent context contributions',15000)
  await selectSession(second.id);await evaluate('const t=document.querySelector(".turn-timer");t&&t.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))');await click('.timer-summary-pop .requirement-summary')
  await click('.fb-tree-node','state.md')
  await wait(()=>evaluate('return document.querySelector(".fb-markdown")?.textContent.includes("并发验收乙")'))
  await shot('19-concurrent-sync','两个真实 Agent 会话并发同步，进展保留双方内容')
  pass('两个真实 TraeX 会话并发同步，双方结果均保留')
  put(join(output,'context-result.md'),readFileSync(renamed.docPath,'utf8'))
  put(join(output,'concurrent-turn-events.json'),JSON.stringify(await evaluate('return window.__acceptanceEvents'),null,2))
} catch(error) {
  failed=error; results.push({name:'acceptance execution',status:'FAIL',detail:String(error.stack||error)});console.error(error)
  try { await shot('failure','失败时的真实界面');put(join(output,'failure-dom.txt'),await evaluate('return document.body.innerText'));put(join(output,'failure-events.json'),JSON.stringify(await evaluate('return window.__acceptanceEvents'),null,2)) } catch {}
} finally {
  put(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),binary,artifactSha256:createHash('sha256').update(readFileSync(join(dirname(dirname(binary)),'Resources/app.asar'))).digest('hex'),results,shots,stderr:failed?stderr:undefined},null,2))
  await cleanup()
}
console.log('SUMMARY '+results.filter(r=>r.status==='PASS').length+' passed; '+results.filter(r=>r.status==='FAIL').length+' failed')
if(failed)process.exitCode=1
