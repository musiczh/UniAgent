// Requirement reading: owned packaged App, real Codex retrieval and background summaries.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, cpSync, rmSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { build } from 'esbuild'
import * as TOML from '@iarna/toml'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
const backButtonOnly = process.argv.includes('--back-button')
assert.ok(binary.startsWith(resolve('release') + '/'), 'only launch the repository package')
const output = resolve(process.env.UA_READER_OUTPUT || 'docs/verification/requirement-context')
const realSnapshot = process.env.UA_REQUIREMENT_MEMORY_SNAPSHOT; if (!realSnapshot) throw Error('provide a read-only requirement snapshot home')
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
const nativeConfig=TOML.parse(readFileSync(join(homedir(),'.codex/config.toml'),'utf8'))
// Reuse the user's existing native endpoint; do not copy native hooks/tools or a live router.
put(join(home,'.codex/config.toml'),TOML.stringify({...(typeof nativeConfig.openai_base_url==='string'?{openai_base_url:nativeConfig.openai_base_url}:{})}))
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
const api = (method, ...args) => evaluate('return window.uniagent[' + JSON.stringify(method) + '](' + args.map(arg=>arg===undefined?'undefined':JSON.stringify(arg)).join(',') + ')')
async function click(selector, text) {
  const point = await evaluate('const el=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.getBoundingClientRect().width>0 && getComputedStyle(e).visibility!=="hidden"' + (text ? '&&e.textContent.includes(' + JSON.stringify(text) + ')' : '') + ');if(!el)throw Error("missing control: "+' + JSON.stringify(selector + ' ' + (text || '')) + ');el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw Error("control obscured: "+' + JSON.stringify(selector) + ');return {x,y}')
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });await sleep(180)
}
async function shot(name, description) {
  await sleep(300);const { data: pixels } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });const file = 'curation-' + name + '.png';put(join(output, file), Buffer.from(pixels, 'base64'));shots.push({ file, description });console.log('SCREENSHOT ' + file)
}
function pass(name, detail) { results.push({ name, status: 'PASS', detail });console.log('PASS ' + name) }

const source = JSON.parse(readFileSync(join(realSnapshot,'requirements.json'),'utf8')).find(r=>r.id==='2de4e0ab-3262-4698-ad3b-c9f69d7f678f')
assert.ok(source, 'DeepSeek source snapshot must exist')
const originalManifest = hash(readFileSync(join(source.dir,'.uniagent-public/manifest.json')))
const requirement = {...source,dir:join(data,'requirements',source.name),docPath:join(data,'requirements',source.name,'context.md'),projectId:projectA.id}
cpSync(source.dir,requirement.dir,{recursive:true})
function storageSize(root) {
  let files=0,bytes=0
  for(const entry of readdirSync(root,{withFileTypes:true})) {
    const target=join(root,entry.name)
    if(entry.isDirectory()){const nested=storageSize(target);files+=nested.files;bytes+=nested.bytes}
    else if(entry.isFile()){files++;bytes+=statSync(target).size}
  }
  return {files,bytes}
}
const beforeStorage=storageSize(requirement.dir)
put(join(data,'requirements.json'),JSON.stringify([requirement]))
put(join(data,'sessions.json'),JSON.stringify([{id:'s_context_curation_fixture',title:'整理验证来源（隔离占位，不执行任务）',status:'idle',createdAt:Date.now(),updatedAt:Date.now(),config:{agentId:'codex',model:'gpt-6.1-sol',permissionMode:'full-access',projectId:projectB.id,requirementId:requirement.id,workdir:workspaceB}}]))
async function openRequirement() {
  await evaluate('const e=document.querySelector("[aria-label=\\"展开产品工作台\\"]");if(e)e.click();return true')
  await wait(()=>evaluate('return [...document.querySelectorAll(".scope-nav-name")].some(e=>e.textContent.includes('+JSON.stringify(requirement.name)+'))'))
  await click('.scope-nav-name',requirement.name)
  await wait(()=>evaluate('return !!document.querySelector(".workspace-detail")'))
  await click('[role=tab]','概览')
  await wait(()=>evaluate('return !!document.querySelector(".rr-curation-entry")'))
}
try {
  await launch()
  await wait(()=>evaluate('return !document.querySelector("#ua-startup") || document.querySelector("#ua-startup").hidden'),Boolean,'startup',90000)
  await openRequirement()
  const old = await api('requirementStorage',requirement.id)
  assert.ok(old.files>500)
  await api('requirementCuration',requirement.id,'organize')
  await wait(async()=> (await api('readRequirementOverview',requirement.id)).tasks?.length)
  const compact = await api('requirementStorage',requirement.id,old.token)
  assert.equal((await api('requirementStorage',requirement.id)).files,0)
  const overview = await api('readRequirementOverview',requirement.id)
  assert.ok(overview.tasks.length)
  pass('真实需求副本：旧资料备份校验、聚合存储、任务摘要归集',{files:compact.files,bytes:compact.bytes,before:beforeStorage,after:storageSize(requirement.dir),tasks:JSON.parse(readFileSync(join(requirement.dir,'.uniagent-public/task-digests.json'),'utf8')),archive:compact.archive,sourcesFiles:readdirSync(join(requirement.dir,'sources')).length})
  const measure=join(resolve('out/test'),'curation-measure-'+randomUUID()+'.mjs')
  await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`import{RequirementStore}from'./src/main/requirementStore';import{configureRequirementRuntime,prepareRequirementTurn,setRequirementsEnabled}from'./src/main/requirementRuntime';const store=new RequirementStore(process.argv[2]),id=process.argv[3],session={id:'measure',config:{agentId:'codex',requirementId:id}};setRequirementsEnabled(true);configureRequirementRuntime(()=>session,(_id,request)=>store.context(id,'measure',request));const turn=prepareRequirementTurn(session,'需求上下文后台整理');const text=await turn.ready;turn.complete();console.log(JSON.stringify({bytes:Buffer.byteLength(text),characters:text.length}));`},bundle:true,platform:'node',format:'esm',packages:'external',outfile:measure})
  const brief=JSON.parse(execFileSync(process.execPath,[measure,data,requirement.id],{env:{...env,PATH:process.env.PATH},encoding:'utf8'}).trim())
  assert.ok(brief.bytes<5500,'envelope plus task stays within a small context budget')
  pass('默认上下文注入预算',brief)
  await shot('overview','新包实际运行：DeepSeek superAgent 真实资料副本的精简概览')
  await click('.rr-task-digests details summary')
  await evaluate('document.querySelector(".rr-task-digests").scrollIntoView({block:"start"});return true')
  await shot('task-summary','按 Session 聚合真实资料中的重要结论，标记历史摘录待复核')
  await click('.rr-curation-entry')
  await click('.settings-entry')
  await click('.set-nav-item','superAgent配置')
  await wait(()=>evaluate('return !!document.querySelector(".requirement-curation-settings")'))
  await evaluate('document.querySelector(".requirement-curation-settings").scrollIntoView({block:"center"});return true')
  const agents = await api('listAgents'), codex=agents.find(agent=>agent.id==='codex')
  const model=codex.models.find(model=>model.id==='ferry-deepseek-v4-1-flash')
  assert.ok(model,'verify with an actually available Flash model')
  async function select(label,selector) {
    await click('.requirement-curation-settings [aria-label="'+label+'"]')
    await click(selector)
  }
  await select('整理 Agent','[data-title-agent="codex"]')
  await select('整理模型','[data-title-model="'+model.id+'"][data-title-model-source="'+(model.modelSource?.sourceId||'')+'"]')
  await click('.requirement-curation-settings button[role="switch"]')
  await click('.requirement-curation-settings button','保存整理配置')
  await wait(()=>api('getAppSettings'),settings=>settings.requirementCuration?.enabled&&settings.requirementCuration?.model===model.id,'settings saved')
  assert.equal(await evaluate('return document.querySelector(".requirement-curation-settings button[role=switch]").getAttribute("aria-checked")'),'true')
  await evaluate('document.querySelector(".requirement-curation-settings").scrollIntoView({block:"center"});return true')
  await shot('settings','新包实际设置：Flash 模型、独立配置及下一整理项生效')
  await click('.settings-back')
  await api('readRequirementOverview',requirement.id,undefined,{refresh:true})
  const running=await wait(async()=>api('requirementCuration',requirement.id),state=>state.status==='running'||state.status==='failed'||state.status==='unconfigured','native reading start',30000)
  assert.equal(running.status,'running',JSON.stringify(running.lastError))
  await api('readRequirementOverview',requirement.id,undefined,{refresh:true})
  await wait(async()=>api('requirementCuration',requirement.id),state=>state.queue.length>0,'second item queued')
  await openRequirement()
  await click('.rr-curation-entry')
  await wait(()=>evaluate('return document.querySelector(".rr-curation-entry").textContent.includes("正在整理")'),Boolean,'running status displayed')
  await shot('queue','真实 Flash 模型处理需求重点；第二次事件进入同一 Session 的队列')
  await click('.rr-curation-panel button','查看会话')
  await wait(()=>evaluate('return !!document.querySelector(".requirement-curation-conversation .event-stream")'),Boolean,'read-only curation conversation')
  assert.equal(await evaluate('const pane=document.querySelector(".requirement-curation-conversation");return pane.textContent.includes("只读")&&!pane.querySelector(".composer-wrap,textarea,[contenteditable=true],.fork-bar")'),true)
  const completed=await wait(async()=>api('requirementCuration',requirement.id),state=>state.status==='idle'||state.status==='failed','two native jobs',240000)
  assert.equal(completed.status,'idle',completed.lastError)
  assert.ok(completed.nativeThreadId)
  assert.ok(completed.history.filter(item=>item.status==='completed'&&item.title==='整理需求重点').length>=2)
  const refined=await api('readRequirementOverview',requirement.id)
  assert.equal(refined.reading.goal.text,overview.reading.goal.text,'source-valid compact goal survives organization')
  assert.equal(refined.reading.current.text,overview.reading.current.text,'source-valid compact progress survives organization')
  const thread=completed.nativeThreadId
  await wait(()=>evaluate('const message=[...document.querySelectorAll(".requirement-curation-conversation .agent-msg")].at(-1);return message?.textContent.includes("topics")&&Number(getComputedStyle(message).opacity)>.95'),Boolean,'native model output is visible')
  const conversation=await api('requirementCurationConversation',requirement.id)
  assert.equal(conversation.nativeThreadId,thread)
  assert.ok(conversation.events.some(event=>event.type==='user_message'))
  assert.ok(conversation.events.some(event=>event.type==='agent_message'))
  await evaluate('const message=[...document.querySelectorAll(".requirement-curation-conversation .agent-msg")].at(-1);message.scrollIntoView({block:"center"});return true')
  await shot('conversation','后台整理 Session 的原始聊天消息流：只读，后台更新，无发送入口')
  await click('[aria-label="返回需求概览"]')
  await wait(()=>evaluate('return !!document.querySelector(".rr-curation-entry")'),Boolean,'return from conversation')
  await click('.rr-curation-entry')
  pass('后台整理会话入口：原生消息、自动更新、只读与返回',{nativeThreadId:thread,events:conversation.events.length})
  await shot('completed','同一后台 Session 的两项真实整理结果')
  await stopApp();await launch()
  const restored=await api('requirementCuration',requirement.id)
  assert.equal(restored.nativeThreadId,thread)
  await api('readRequirementOverview',requirement.id,undefined,{refresh:true})
  await wait(async()=>api('requirementCuration',requirement.id),state=>state.status==='running','restored job starts')
  const again=await wait(async()=>api('requirementCuration',requirement.id),state=>state.status==='idle'||state.status==='failed','restored native job',180000)
  assert.equal(again.status,'idle',again.lastError);assert.equal(again.nativeThreadId,thread)
  pass('Flash 模型：串行队列、两次原生调用及 App 重启后继续复用同一 thread',{model:model.id,threadId:thread,logicalSessionId:again.sessionId,jobs:again.history.length})
  assert.equal(hash(readFileSync(join(source.dir,'.uniagent-public/manifest.json'))),originalManifest,'the live requirement must not be changed')
  assert.deepEqual(await evaluate('return window.__acceptanceErrors'),[])
} catch(error) { failure=error;console.error(error.message);if(cdp)await shot('failure','验证失败现场').catch(()=>{}) }
finally {
  // The report contains counts, IDs and outcomes, never model credentials or full source contents.
  for(const row of results)if(row.detail?.tasks)row.detail.tasks=Object.keys(row.detail.tasks).length
  put(join(output,'report.json'),JSON.stringify({packageHash,results,shots,error:failure?.message},null,2))
  await cleanup()
}
if(failure)throw failure
