// Requirement reading: owned packaged App, real Codex retrieval and background summaries.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, cpSync, rmSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { build } from 'esbuild'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
const backButtonOnly = process.argv.includes('--back-button')
assert.ok(binary.startsWith(resolve('release') + '/'), 'only launch the repository package')
const output = resolve(process.env.UA_READER_OUTPUT || 'docs/mockups')
const realSnapshot = process.env.UA_REQUIREMENT_MEMORY_SNAPSHOT
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'ua-requirement-reader-'))
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
for (const name of backButtonOnly ? [] : ['auth.json', 'models_cache.json']) {
  const source = join(homedir(), '.codex', name), target = join(home, '.codex', name)
  if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
}
put(join(scratch, 'gitconfig'), '[user]\n name = UniAgent Acceptance\n email = acceptance@example.invalid\n')
put(join(scratch, 'npmrc'), '')
put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, requirementsEnabled: true, theme: 'dark',
  autoCheckUpdate: false, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, enabledAgentIds: ['codex'], notificationMode: 'off' }))
for (const path of [workspaceA, workspaceB]) {
  execFileSync('/usr/bin/git', ['init', '-q', path], { env, stdio: 'ignore' })
  put(join(path, '验收样例.md'), '# 需求阅读验收\n\n此目录仅用于隔离验证。禁止启动子 Agent、修改文件或读取目录外资料。\n')
}
const projectA = { id: randomUUID(), name: '产品工作台', primaryDirectory: workspaceA, additionalDirectories: [], isDefault: true, createdAt: Date.now(), updatedAt: Date.now() };
const projectB = { ...projectA, id: randomUUID(), name: '执行验证', primaryDirectory: workspaceB, isDefault: false };
put(join(data, 'projects.json'), JSON.stringify([projectA, projectB]));

put(join(data,'sessions.json'),'[]');
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
  await evaluate('window.__acceptanceErrors=[];window.addEventListener("error",event=>window.__acceptanceErrors.push(event.message));return true')
  console.log('LAUNCH packaged App connected')
}
async function evaluate(body) { const value = await cdp('Runtime.evaluate', { expression: '(async()=>{' + body + '\n})()', awaitPromise: true, returnByValue: true, userGesture: true });if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);return value.result?.value }
const api = (method, ...args) => evaluate('return window.uniagent[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')')
async function click(selector, text) {
  const point = await evaluate('const el=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.getBoundingClientRect().width>0 && getComputedStyle(e).visibility!=="hidden"' + (text ? '&&e.textContent.includes(' + JSON.stringify(text) + ')' : '') + ');if(!el)throw Error("missing control: "+' + JSON.stringify(selector + ' ' + (text || '')) + ');el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw Error("control obscured: "+' + JSON.stringify(selector) + ');return {x,y}')
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });await sleep(180)
}
async function shot(name, description) {
  await sleep(300);const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });const file = 'requirement-reader-' + name + '.png';put(join(output, file), Buffer.from(pixels, 'base64'));shots.push({ file, description });console.log('SCREENSHOT ' + file)
}
function pass(name, detail) { results.push({ name, status: 'PASS', detail });console.log('PASS ' + name) }

const seedScript = join(scratch, 'seed.mjs')
await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import {RequirementStore} from './src/main/requirementStore';
const store=new RequirementStore(process.argv[2]);
const r=await store.create({name:'需求阅读验收',projectId:process.argv[3]});
const event={sessionId:'fixture',seq:0,ts:1,type:'user_message',payload:{text:'保存需求背景与决定。基础已交付，设计已确认，正在实施验证；用户验收未确认。下一步验证目录浏览。'}};
store.configureContext({events:async()=>[event],requirementId:()=>r.id});
let revision=(await store.context(r.id,'fixture',{action:'bootstrap'})).revision;
const proof=[{kind:'user',sessionId:'fixture',seq:0,quote:event.payload.text}];
const docs=[{id:'core',kind:'core',title:r.name,content:'目标：让用户快速了解需求、当前进度与下一步。保留原任务四列，复用内置文件浏览器。',sources:proof},{id:'state',kind:'state',title:'当前阶段',content:event.payload.text,sources:proof},{id:'acceptance-design',kind:'spec',title:'验收规范',summary:'目录与概览的验收材料',triggers:['验收'],content:'标记：CONTEXT_READER_TARGET_K7。验收：需求目录在 App 内打开；代码交付、测试与用户验收分别判断。',sources:proof},{id:'old-decision',kind:'decision',title:'旧版阅读约定',content:'原文集中展示。',sources:proof}];
revision=(await store.context(r.id,'fixture',{action:'commit',expectedRevision:revision,operationId:'reader-fixture',documents:docs})).revision;
revision=(await store.context(r.id,'fixture',{action:'commit',expectedRevision:revision,operationId:'reader-replace',documents:[{id:'new-decision',kind:'decision',title:'人读概览与 Agent 按需上下文',content:'人先看概览，Agent 按需取资料。',sources:proof,supersedes:'old-decision'}]})).revision;
for(let page=0;page<2;page++)revision=(await store.context(r.id,'fixture',{action:'propose',expectedRevision:revision,operationId:'reader-materials-'+page,documents:Array.from({length:20},(_,i)=>({id:'material-'+(page*20+i),kind:'${backButtonOnly ? 'artifact' : 'proposal'}',title:'参考建议 '+(page*20+i),summary:'仅为候选，不能自动生效',content:'# 候选资料\\n\\n尚未确认的建议。',sources:${backButtonOnly ? '[{kind:"reference",uri:"https://example.invalid/material/"+(page*20+i)}]' : '[]'}}))})).revision;
console.log(JSON.stringify({requirement:r,revision}));
` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: seedScript })
function copyRealSnapshot() {
  const [source] = JSON.parse(readFileSync(join(realSnapshot, 'requirements.json'), 'utf8'))
  const dir = join(data, 'requirements', source.name)
  cpSync(source.dir, dir, { recursive: true })
  const requirement = { ...source, dir, docPath: join(dir, 'context.md'), projectId: projectA.id }
  put(join(data, 'requirements.json'), JSON.stringify([requirement]))
  return { requirement }
}
const { requirement } = realSnapshot ? copyRealSnapshot() : JSON.parse(execFileSync(process.execPath, [seedScript, data, projectA.id], { env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trim())
async function openRequirement() {
  await evaluate('const e=document.querySelector('+JSON.stringify('[aria-label="展开产品工作台"]')+');if(e)e.click();return true')
  await wait(() => evaluate('return [...document.querySelectorAll(".scope-nav-name")].some(e=>e.textContent.includes(' + JSON.stringify(requirement.name) + '))'))
  await click('.scope-nav-name', requirement.name)
  await wait(() => evaluate('return !!document.querySelector(".workspace-detail")'))
}
try {
  await launch()
  await wait(() => evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'), Boolean, 'startup', 90000)
  await openRequirement()
  if (backButtonOnly) {
    for (const width of [1440, 1024]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 960 : 640, deviceScaleFactor: 1, mobile: false })
      for (const [tab, label, list] of [['context', '概览', '.rr-hero'], ['decisions', '变更与决策', '.rr-decision'], ['resources', '资料', '.rr-categories']]) {
        if (tab === 'resources') await evaluate('const key=' + JSON.stringify('ua.scopeBrowser.requirement:' + requirement.id + '.reader.resources') + ';localStorage.setItem(key+".document",JSON.stringify("core"));localStorage.setItem(key+".offset","30");return true')
        await click('[role=tab]', label)
        if (tab !== 'resources') await wait(() => evaluate('return !!document.querySelector(' + JSON.stringify(list) + ') && document.querySelector(".requirement-reader").getAttribute("aria-busy")==="false"'))
        if (tab === 'context') await click('.rr-hero>.scope-link')
        else if (tab === 'decisions') {
          await click('.rr-decision summary', '人读概览与 Agent 按需上下文')
          await click('.rr-decision[open] .scope-link', '查看结论')
        }
        await wait(() => evaluate('return !!document.querySelector(".rr-document-head h2")'))
        const layout = await evaluate('const button=document.querySelector(".rr-back-button"),title=document.querySelector(".rr-document-head h2"),reader=document.querySelector(".requirement-reader");const b=button.getBoundingClientRect(),t=title.getBoundingClientRect();button.focus();return {label:button.getAttribute("aria-label"),tooltip:button.title,icon:!!button.querySelector(".ui-icon-back"),text:button.textContent.trim(),width:b.width,height:b.height,left:b.right<t.left,sameRow:Math.abs(b.top-t.top)<5,overflow:reader.scrollWidth>reader.clientWidth+1,focused:document.activeElement===button,outline:getComputedStyle(button).outlineStyle,standalone:!!document.querySelector(".requirement-reader>.scope-link")}')
        assert.equal(layout.label, '返回' + label)
        assert.equal(layout.tooltip, layout.label)
        assert.equal(layout.icon, true)
        assert.equal(layout.text, '')
        assert.ok(layout.width >= 32 && layout.height >= 32 && layout.left && layout.sameRow && layout.focused)
        assert.equal(layout.overflow, false)
        assert.equal(layout.standalone, false)
        await shot('back-' + tab + '-' + width, width + 'px 实际正文页：标题左侧图标返回，原入口为' + label)
        if (tab === 'decisions') {
          await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
          await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        } else await click('.rr-back-button')
        await wait(() => evaluate('return !!document.querySelector(' + JSON.stringify(list) + ') && !document.querySelector(".rr-back-button") && document.querySelector(".requirement-reader").getAttribute("aria-busy")==="false"'))
        if (tab === 'resources') {
          assert.equal(await evaluate('return localStorage.getItem(' + JSON.stringify('ua.scopeBrowser.requirement:' + requirement.id + '.reader.resources.offset') + ')'), '30')
          assert.equal(await evaluate('return document.querySelector(".rr-pagination span").textContent'), '2 / 2')
        }
        pass(width + 'px ' + label + '正文图标与返回', layout)
      }
    }
    assert.deepEqual(await api('listSessions'), [], 'page checks must not create Agent sessions')
    assert.deepEqual(await evaluate('return window.__acceptanceErrors'), [])
    pass('实际包三入口、两种窗口、鼠标及 Enter 返回、分页恢复，无 renderer 错误或新建会话')
  } else if (realSnapshot) {
    await click('[role=tab]', '概览')
    const overview = await api('readRequirementOverview', requirement.id)
    assert.equal(overview.readingStatus, 'ready')
    assert.equal(overview.reading.version, 2)
    await wait(() => evaluate('return !!document.querySelector(".rr-topic") && !!document.querySelector(".rr-change")'))
    const density = await evaluate('return {headingGap:document.querySelector(".rr-topic").getBoundingClientRect().top-document.querySelector(".rr-topics-title").getBoundingClientRect().bottom,rowHeight:document.querySelector(".rr-topic").getBoundingClientRect().height}')
    assert.ok(density.headingGap < 24 && density.rowHeight < 80, 'real scope styles must preserve compact topic rows')
    await shot('real-01-概览', '真实需求资料与真实模型投影：当前情况、重要变化、主题与关注')
    pass('真实数据概览优先展示现状与重要变化', { topics: overview.reading.topics.length, changes: overview.reading.changes.length, density })
    const live = await api('createSession', { agentId: 'codex', model: 'gpt-6.1-sol', permissionMode: 'full-access', projectId: projectB.id, requirementId: requirement.id, workdir: workspaceB },
      '这是隔离的需求记忆验收。只依据自动注入的需求资料，说明需求上下文的核心目标、三类使用者、此前做过的变更，以及仍未确认的边界。不要调用工具或修改文件。返回 JSON：{primaryGoal:string,consumers:string[],priorChanges:string[],unverified:string[],startAuthorization:"confirmed"|"pending"|"unknown"}。startAuthorization 只说明此前用户是否明确要求开始本轮优化，不代表功能验收或当前会话执行授权。不知道的保持未知。')
    await wait(() => api('listSessions'), rows => rows.some(row => row.id === live.id && !['running', 'queued', 'awaiting-approval', 'cancelling'].includes(row.status)), 'real packaged cross-Session inheritance', 180000)
    const liveEvents = await api('getEvents', live.id)
    const reply = liveEvents.filter(event => event.type === 'agent_message' && event.payload.kind !== 'thinking').map(event => String(event.payload.text || '')).join('\n')
    const answer = JSON.parse(reply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim())
    assert.match(answer.primaryGoal, /Session|会话/i)
    assert.ok(answer.consumers.some(text => /router/i.test(text)))
    assert.ok(answer.consumers.some(text => /用户|人类|^人[：:]|human|reader|user/i.test(text)))
    assert.ok(answer.consumers.some(text => !/router/i.test(text) && /执行|Session|智能体|agent/i.test(text)))
    assert.ok(answer.priorChanges.length, 'the new Session recalls prior work as well as the requirement goal')
    assert.ok(answer.unverified.length)
    assert.equal(answer.startAuthorization, 'confirmed', 'the later instruction to start optimization must survive the earlier pending design report')
    assert.equal(liveEvents.some(event => event.type === 'command_exec'), false)
    pass('真实打包 App 新建原生 Session 自动继承需求记忆，无工具读取', answer)
    await openRequirement()
    await click('[role=tab]', '概览')
    await wait(() => evaluate('return !!document.querySelector(".rr-topic")'))
    await click('.rr-topic summary')
    assert.equal(await evaluate('return !!document.querySelector(".rr-topic[open] .rr-topic-body").textContent.trim()'), true)
    await click('.rr-topic[open] .scope-link')
    await wait(() => evaluate('return !!document.querySelector(".rr-sources")'))
    await shot('real-02-依据', '主题展开后按需阅读真实原文和来源性质')
    await click('.rr-back-button[aria-label="返回概览"]')
    await wait(() => evaluate('return !!document.querySelector(".rr-hero")'))
    pass('主题展开、真实依据读取及返回')
    await click('[role=tab]', '变更与决策')
    await wait(() => evaluate('return !!document.querySelector(".rr-history-filters")'))
    await click('.rr-history-filters button', '包含历史建议')
    await wait(() => evaluate('return document.querySelector(".requirement-reader").getAttribute("aria-busy")==="false"'))
    await shot('real-03-变更与决策', '真实决定与变更记录，历史内容按需显示')
    pass('当前结论与历史入口分层')
    await click('[role=tab]', '资料')
    await wait(() => evaluate('return !!document.querySelector(".rr-search")'))
    await evaluate('const e=document.querySelector(".rr-search");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"Router");e.dispatchEvent(new Event("input",{bubbles:true}));return true')
    await wait(() => evaluate('return document.querySelector(".requirement-reader").getAttribute("aria-busy")==="false" && !!document.querySelector(".rr-document")'))
    await shot('real-04-资料', '以真实主题查询资料用途和状态')
    pass('真实资料主题搜索与状态区分')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false })
    await click('[role=tab]', '概览')
    await wait(() => evaluate('return !!document.querySelector(".rr-topic")'))
    assert.equal(await evaluate('const e=document.querySelector(".requirement-reader");return e.scrollWidth<=e.clientWidth+1'), true)
    await shot('real-05-窄窗口', '1024×640 真实资料概览保持可读和无横向溢出')
    assert.deepEqual(await evaluate('return window.__acceptanceErrors'), [])
    pass('真实打包 App 窄窗口与 renderer 错误检查')
  } else {
  await click('[role=tab]', '概览')
  await wait(() => evaluate('return !!document.querySelector(".rr-hero")'))
  assert.equal((await api('readRequirementOverview', requirement.id)).readingStatus, 'missing')
  assert.equal(await evaluate('return !!document.querySelector(".scope-directory-button")'), true)
  await shot('01-初次概览', '首次未整理时保留原资料和应用内目录入口，页面可操作')
  pass('缺少阅读投影时的明确状态与资料入口')

  const live = await api('createSession', { agentId: 'codex', model: 'gpt-6.1-sol', permissionMode: 'full-access', projectId: projectB.id, requirementId: requirement.id, workdir: workspaceB },
    '这是隔离需求阅读验收。只用 requirement_context 的 read(query="验收",limit=1) 找到验收规范，再按文档 ID 读取正文。只回复规范中的标记。不要启动子 Agent、调用文件或 shell 工具、改写资料或申报交付。')
  assert.equal(typeof live.id, 'string')
  console.log('LIVE requirement reader session ' + live.id)
  await wait(() => api('listSessions'), rows => rows.some(row => row.id === live.id && !['running', 'queued', 'awaiting-approval', 'cancelling'].includes(row.status)), 'real Codex requirement read', 180000).catch(async error => {
    const events = await api('getEvents', live.id)
    console.log('LIVE diagnostics ' + JSON.stringify(events.filter(event => ['error', 'approval_request', 'turn_completed'].includes(event.type)).map(event => ({ type: event.type, state: event.state, message: String(event.payload.message || event.payload.kind || '').replace(/Bearer\\s+\\S+/g, '[redacted]').slice(0, 400) }))))
    throw error
  })
  const events = await api('getEvents', live.id)
  assert.ok(events.some(event => event.type === 'agent_message' && String(event.payload.text || '').includes('CONTEXT_READER_TARGET_K7')), 'live Agent retrieves the marker absent from its prompt and brief navigation')
  pass('真实 Codex 通过资料入口与单篇读取获得正文', { sessionId: live.id, replies: events.filter(event => event.type === 'agent_message').length })
  await openRequirement()
  await click('[role=tab]', '概览')
  const reading = await wait(() => api('readRequirementOverview', requirement.id), result => result.readingStatus === 'ready', 'real background reading projection', 180000)
  assert.ok(reading.reading.goal.text)
  assert.ok(reading.reading.stages.every(stage => stage.status !== 'accepted'), 'design confirmation cannot become user acceptance')
  await wait(() => evaluate('return !!document.querySelector(".rr-topic,.rr-stage")'))
  await shot('02-真实概览', '实际受限模型整理出的目标、阶段、问题和下一步，用户验收仍独立标识')
  pass('真实后台模型生成带原文引用的阅读投影', { sourceRevision: reading.reading.sourceRevision, stages: reading.reading.stages.length })
  const briefSession = await api('createSession', { agentId: 'codex', model: 'gpt-6.1-sol', permissionMode: 'full-access', projectId: projectB.id, requirementId: requirement.id, workdir: workspaceB },
    '只依据注入的需求概述，用一句话说明当前需求目标。再按资料中的用户验收情况选择并输出 STATUS:CONFIRMED 或 STATUS:PENDING。不要调用任何工具或修改资料。')
  await wait(() => api('listSessions'), rows => rows.some(row => row.id === briefSession.id && !['running', 'queued', 'awaiting-approval', 'cancelling'].includes(row.status)), 'fresh Session uses only the brief', 180000)
  const briefEvents = await api('getEvents', briefSession.id)
  const briefText = briefEvents.filter(event => event.type === 'agent_message').map(event => String(event.payload.text || '')).join('\n')
  assert.ok(briefText.includes('STATUS:PENDING') && /进度|下一步|背景|概览/.test(briefText))
  assert.equal(briefEvents.some(event => event.type === 'command_exec'), false)
  pass('新原生 Session 仅凭短概述理解目标与验收状态，无工具读取')
  await click('[role=tab]', '变更与决策')
  await wait(() => evaluate('return !!document.querySelector(".rr-decision")'))
  await click('.rr-decision summary', '人读概览与 Agent 按需上下文')
  assert.equal(await evaluate('return document.querySelector(".rr-decision[open]").textContent.includes("替代历史版本")'), true)
  await shot('03-变更与决策', '当前决定可追溯被替代的历史版本，并保留来源')
  pass('决定与历史版本回查')
  const sourceInput = events.find(event => event.type === 'user_message')
  assert.ok(sourceInput)
  put(join(scratch, 'source-event.json'), JSON.stringify(sourceInput))
  const sourceScript = join(scratch, 'source.mjs')
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import{readFileSync}from'node:fs';import{RequirementStore}from'./src/main/requirementStore';
const store=new RequirementStore(process.argv[2]),id=process.argv[3],event=JSON.parse(readFileSync(process.argv[4],'utf8')),sessionId=process.argv[5];
store.configureContext({events:async()=>[event],requirementId:()=>id});const snapshot=await store.context(id,sessionId,{action:'check'});
await store.context(id,sessionId,{action:'commit',expectedRevision:snapshot.revision,operationId:'native-discussion',documents:[{id:'native-discussion',kind:'decision',title:'资料读取的原讨论',content:'本次讨论要求按目录定位资料，再读取单篇正文。',sources:[{kind:'user',sessionId,seq:event.seq,quote:event.payload.displayText||event.payload.text},{kind:'reference',uri:process.argv[6]}]}]});
` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: sourceScript })
  execFileSync(process.execPath, [sourceScript, data, requirement.id, join(scratch, 'source-event.json'), live.id, join(workspaceB, '验收样例.md')], { env: { ...env, PATH: process.env.PATH }, stdio: 'pipe' })
  await click('[role=tab]', '资料')
  await click('[role=tab]', '变更与决策')
  await wait(() => evaluate('return [...document.querySelectorAll(".rr-decision summary")].some(e=>e.textContent.includes("资料读取的原讨论"))'))
  await click('.rr-decision summary', '资料读取的原讨论')
  await click('.rr-decision[open] .scope-link', '查看结论')
  await wait(() => evaluate('return !!document.querySelector(".rr-sources button")'))
  await click('.rr-sources button', '原讨论')
  await wait(() => evaluate('return !!document.querySelector('+JSON.stringify('[data-source-seq="'+sourceInput.seq+'"]')+')'))
  await shot('04-原讨论跳转', '由真实用户来源打开同一原生任务，并定位到原输入')
  await click('[aria-label="返回工作详情"]')
  await wait(() => evaluate('return !!document.querySelector(".workspace-detail")'))
  pass('真实来源任务与消息定位、返回需求')
  await wait(() => evaluate('return !!document.querySelector(".rr-sources a.md-path")'))
  await click('.rr-sources a.md-path', '查看参考资料')
  await wait(() => evaluate('return document.querySelector(".fb-preview-body")?.textContent.includes("此目录仅用于隔离验证")'))
  assert.equal(realpathSync(await evaluate('return document.querySelector(".filebrowser-overlay .scene-head p").textContent')), realpathSync(workspaceB))
  await click('.scene-back-btn', '返回需求')
  await wait(() => evaluate('return !document.querySelector(".filebrowser-overlay") && !!document.querySelector(".rr-sources a.md-path")'))
  pass('需求外参考文件按自身目录预览，并返回原需求资料')
  await click('[role=tab]', '资料')
  await wait(() => evaluate('return document.querySelectorAll(".rr-document").length===30'))
  await click('.rr-pagination button', '下一页')
  await wait(() => evaluate('return document.querySelector(".rr-pagination span")?.textContent==="2 / 2" && document.querySelector(".requirement-reader").getAttribute("aria-busy")==="false"'))
  const pageTitles = await evaluate('return [...document.querySelectorAll(".rr-document .scope-document")].map(e=>e.textContent)')
  await click('.scope-directory-button')
  await wait(() => evaluate('return !!document.querySelector(".filebrowser-overlay .fb-tree-node")'))
  assert.equal(realpathSync(await evaluate('return document.querySelector(".filebrowser-overlay .scene-head p").textContent')), realpathSync(requirement.dir))
  await shot('05-应用内目录', '打开当前需求根目录，保留左侧导航；其它执行空间不会替代目录来源')
  await click('.fb-tree-node', 'context.md')
  await wait(() => evaluate('return document.querySelector(".fb-preview-body")?.textContent.includes("快速了解需求")'))
  await shot('06-目录正文预览', '通过原文件浏览器预览需求 Markdown')
  await click('.scene-back-btn', '返回需求')
  await wait(() => evaluate('return !document.querySelector(".filebrowser-overlay")'))
  assert.deepEqual(await evaluate('return [...document.querySelectorAll(".rr-document .scope-document")].map(e=>e.textContent)'), pageTitles)
  pass('应用内目录、原文件预览和返回原资料页', { root: requirement.dir, taskWorkdir: workspaceB })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false })
  await click('[role=tab]', '概览')
  await wait(() => evaluate('return !!document.querySelector(".rr-topics,.rr-stages")'))
  assert.equal(await evaluate('const e=document.querySelector(".requirement-reader");return e.scrollWidth<=e.clientWidth+1'), true)
  await shot('07-窄窗口', '1024×640 下概览无横向溢出，目录入口保持可点击')
  pass('窄窗口与实际包 renderer 运行错误检查')
  assert.deepEqual(await evaluate('return window.__acceptanceErrors'), [])
  }
} catch (error) {
  failure = error
  if (cdp) await shot('99-失败现场', '失败诊断，不计为通过截图').catch(() => {})
  console.error('FAIL ' + error.message)
  if (!cdp) console.error('targets=' + JSON.stringify(lastTargets) + '\n' + lastStderr)
} finally {
  const report = { date: new Date().toISOString(), status: failure ? 'FAIL' : 'PASS', packageHash, binary, results, shots, limitation: backButtonOnly ? '隔离样例的真实打包 App 页面检查；未运行 Agent 对话或完整发布回归' : '隔离数据和真实 Codex；不等于全部 Agent 或完整发布回归', failure: failure?.message }
  put(resolve(process.env.UA_READER_REPORT || 'docs/requirement-reader-acceptance.json'), JSON.stringify({ ...report, realSnapshot: !!realSnapshot }, null, 2))
  await cleanup()
}
if (failure) process.exitCode = 1
