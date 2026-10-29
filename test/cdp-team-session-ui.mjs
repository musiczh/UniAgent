// Packaged UI with isolated persisted fixtures and real artifact/navigation IPC. Live answer validation is covered by team-service and cdp-team-direct.
// node test/cdp-team-session-ui.mjs <packaged executable> [traex|codex]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/') && binary.endsWith('.app/Contents/MacOS/UniAgent Public'), 'use a repository release App')
const provider = process.argv[3] || 'traex'
const memberProvider = process.argv[4] || provider
assert.ok(['traex', 'codex'].includes(provider), 'supported Leader provider')
assert.ok(['traex', 'codex', 'claude'].includes(memberProvider), 'supported member provider')
const appSha256 = createHash('sha256').update(await readFile(join(dirname(dirname(binary)), 'Resources/app.asar'))).digest('hex')
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-team-cdp-'))
const home = join(fixture, 'home'), userData = join(fixture, 'data'), workdir = join(fixture, 'workspace')
const output = resolve('.test-build/team-session-ui-' + new Date().toISOString().replace(/[:.]/g, '-'))
console.log('EVIDENCE ' + output)
const sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
const results = []
let ws, child, stderr = '', cleanupPromise, forceCleanup = false, ev, send, latest
const cleanup = () => cleanupPromise ||= (async () => {
  ws?.close()
  try { await sweeper.sweep({ shouldAbort: () => forceCleanup }) }
  finally { if (forceCleanup) await sweeper.forceSweep(); await rm(fixture, { recursive: true, force: true }) }
})()
const termination = createAcceptanceTerminationHandler({ cleanup, requestForceCleanup: () => { forceCleanup = true }, exit: code => process.exit(code) })
process.on('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.on('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))
const delay = ms => new Promise(r => setTimeout(r, ms))
async function poll(fn, accept, label, ms = 30000) {
  const until = Date.now() + ms
  let value
  while (Date.now() < until) { value = await fn(); if (accept(value)) return value; await delay(300) }
  throw new Error(label + ': timeout; last=' + JSON.stringify(value))
}
function check(name, condition) { assert.ok(condition, name); results.push(name); console.log('PASS ' + name) }
async function put(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, value) }
try {
  await Promise.all([home, userData, workdir, output, join(fixture, 'tmp')].map(p => mkdir(p, { recursive: true })))
  await put(join(fixture, 'gitconfig'), '[user]\nname = Roundtable Test\nemail = roundtable@example.invalid\n')
  await put(join(workdir, 'facts.txt'), 'Alpha: 17\nBeta: 25\n')
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, UNIAGENT_USER_DATA: userData, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'), UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.capabilities'), UA_DISABLE_GPU: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'), ZDOTDIR: join(fixture, 'zdotdir') }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA']) { env[key] = join(fixture, key); await mkdir(env[key], { recursive: true }) }
  async function launch() {
  const server = createServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise(r => server.close(r))
  child = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium'), '--ua-e2e', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
  await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail) })
  await sweeper.addRoot(child.pid)
  console.log('LAUNCH owned App pid=' + child.pid)
  const renderer = join(dirname(dirname(binary)), 'Resources/app.asar.unpacked/out/renderer/index.html')
  const page = await poll(async () => {
    if (child.exitCode !== null) throw new Error('App exited: ' + stderr)
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) })).json()).find(t => t.type === 'page' && t.url.startsWith('file:') && fileURLToPath(t.url) === renderer) } catch { return null }
  }, Boolean, 'exact packaged renderer')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }) })
  let serial = 0
  const pending = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.fail(new Error(JSON.stringify(m.error))) : p.ok(m.result) } })
  send = (method, params = {}) => new Promise((ok, fail) => { const id = ++serial; pending.set(id, { ok, fail, timer: setTimeout(() => { pending.delete(id); fail(new Error('CDP timeout: ' + method)) }, 30000) }); ws.send(JSON.stringify({ id, method, params })) })
  ev = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value }
  await poll(() => ev('!!window.uniagent && !!document.querySelector(".sidebar-header .logo")'), Boolean, 'app UI')
  }
  const now = Date.now() - 10000
  const assignmentPrompt = payload => ['[团队派单]', JSON.stringify(payload), '在当前固定 Session 执行。开始前可 get_team_context；完成后报告结果并结束本轮。'].join('\n')
  const team = { id:'team_ui', revision:1, name:'脑爆团', description:'UI 验证团队', rules:'按分工处理任务', status:'active', leaderMemberId:'leader', members:['leader','analyst','reviewer'].map((id,index)=>({id,role:{id:'role-'+id,name:['sol子','A畜','sol女'][index],agentId:'codex',permissionMode:'read-only',model:'gpt-5.4'}})), limits:{concurrency:2,maxAssignments:12,taskMinutes:20,runMinutes:60},createdAt:now,updatedAt:now }
  const project = { id:'tp_ui',revision:1,name:'专家团信息流验收',goal:'核对 Session 信息流、任务结论和问答审批记录。',spaceId:'default',spaceRoots:[home],teamId:team.id,team,memberSessions:{leader:'s-ui-leader',analyst:'s-ui-analyst',reviewer:'s-ui-reviewer'},runId:1,status:'interrupted',phase:'待用户补充',summary:'项目概要',sharedContext:{brief:'UI acceptance',decisions:[],openQuestions:[]},assignments:[],inbox:[],inboxSeq:0,handledInboxSeq:0,interactions:[],artifacts:[],messages:[{id:'user',kind:'user',text:'请两位成员梳理项目并汇总结论。',createdAt:now}],previousResults:[],createdAt:now,updatedAt:now,activeMs:134000}
  project.communications = [{id:'communication-ui',requestId:'direct-ui',requestFingerprint:'fp',runId:1,memberId:'analyst',sessionId:'s-ui-analyst',assignmentId:'task-analyst',attempt:1,turnId:'turn-ui',message:'用户已确认：只读分析，不修改代码。',state:'sent',createdAt:now+500,settledAt:now+600}, {id:'communication-failed',requestId:'direct-failed',requestFingerprint:'fp2',runId:1,memberId:'analyst',sessionId:'s-ui-analyst',assignmentId:'task-analyst',attempt:1,message:'补充限制',state:'failed',error:'team_turn_not_running',createdAt:now+700,settledAt:now+701}]
  project.assignments = ['analyst','reviewer'].map((memberId,i)=>({id:'task-'+memberId,runId:1,memberId,requestId:'task-'+i,requestFingerprint:'fp-'+i,title:['梳理技术债与依赖','核对项目进度与风险'][i],prompt:'Verify fixture',contextRefs:[],expectedOutput:'Result',status:'succeeded',attempt:1,history:[],summary:'已完成',result:['依赖关系已梳理，发现两项待处理技术债。','核心链路已完成，建议补齐交互验证。'][i],artifactRefs:[],createdAt:now+300+i*100,endedAt:now+1500,activeMs:1000}))
  const approval = (id,kind,seq,answer)=>({id,revision:2,kind:kind==='question'?'native_question':'native_approval',runId:1,memberId:'analyst',sessionId:'s-ui-analyst',requestId:id,state:'answered',answer,createdAt:now+2000+seq,event:{sessionId:'s-ui-analyst',seq,ts:now+2000+seq,type:'approval_request',state:'pending',payload:{requestId:id,kind,method:kind==='question'?'item/tool/requestUserInput':'item/commandExecution/requestApproval',params:kind==='question'?{questions:[{id:'scope',question:'原生问题：检查范围？'}]}:{command:'echo verification'}}}})
  project.interactions=[{id:'business',revision:1,kind:'leader_question',runId:1,memberId:'leader',sessionId:'s-ui-leader',state:'pending',createdAt:now+3000,questions:[{id:'first',prompt:'优先验证哪条链路？'},{id:'second',prompt:'需要保留哪些记录？'}]},approval('allowed','command',10,{decision:'accept'}),approval('denied','command',11,{decision:'decline'}),approval('native-answer','question',12,{answers:{scope:{answers:['完整范围']}}})]
  // A completed fixture exercises final delivery through the real App and artifact IPC.
  const doneProject=structuredClone(project)
  doneProject.id='tp_delivery';doneProject.name='完成态 · 结论与过程交付物';doneProject.status='completed';doneProject.phase='已交付'
  doneProject.interactions=[];doneProject.memberSessions={leader:'s-delivery-leader',analyst:'s-delivery-analyst',reviewer:'s-delivery-reviewer'}
  doneProject.communications.forEach(c=>{c.sessionId=doneProject.memberSessions[c.memberId]})
  doneProject.messages=[{id:'delivery-user',kind:'user',text:'请汇总项目现状，并保留两位成员的过程成果。',createdAt:now}]
  doneProject.assignments.forEach((a,i)=>a.artifactRefs=['delivery-report-'+i])
  doneProject.artifacts=doneProject.assignments.map((a,i)=>({id:'delivery-report-'+i,title:a.title,text:a.result,assignmentId:a.id,createdAt:now+1600+i*100}))
  doneProject.artifacts[1].text += '\n\n<details><summary>查看验证依据</summary><p>信息流、问答审批及交付物均已核对。</p><a href="https://example.invalid">验收参考</a></details>'
  const reportPath=join(home,'delivery-report.md')
  await put(reportPath,'# 文件交付报告\n\n文件预览验收：42。\n')
  doneProject.artifacts.push({id:'delivery-file',title:'交付报告.md',path:reportPath,assignmentId:doneProject.assignments[0].id,createdAt:now+1900})
  doneProject.assignments[0].artifactRefs.push('delivery-file')
  doneProject.finalResult={deliveredAt:now+2000,summary:'两位成员已完成梳理。核心链路可用；后续优先处理技术债，并补齐交互验证。过程报告保留在下方，可直接查看。',artifactRefs:['delivery-file'],acceptedFindings:[],unresolvedDisagreements:[],validationGaps:[]}
  await put(join(userData,'team-projects',doneProject.id+'.json'),JSON.stringify(doneProject))
  await put(join(userData,'teams.json'),JSON.stringify([team]))
  await put(join(userData,'team-projects',project.id+'.json'),JSON.stringify(project))
  const stoppedProject=structuredClone(project)
  stoppedProject.id='tp_stopped';stoppedProject.name='停止态 · 所有 Agent 已中断';stoppedProject.interactions=[]
  stoppedProject.memberSessions={leader:'s-stopped-leader',analyst:'s-stopped-analyst',reviewer:'s-stopped-reviewer'}
  stoppedProject.communications.forEach(c=>{c.sessionId=stoppedProject.memberSessions[c.memberId]})
  stoppedProject.assignments.forEach(a=>{a.status='cancelled';a.summary='执行中';delete a.result})
  await put(join(userData,'team-projects',stoppedProject.id+'.json'),JSON.stringify(stoppedProject))
  await put(join(userData,'sessions.json'),JSON.stringify(team.members.map(m=>({id:project.memberSessions[m.id],title:'验收 · '+m.role.name,config:{agentId:'codex',workdir:home,permissionMode:'read-only'},status:'idle',createdAt:now,teamBinding:{teamProjectId:project.id,memberId:m.id}}))))
  const sessionFile=join(userData,'sessions.json')
  await put(sessionFile,JSON.stringify([...JSON.parse(await readFile(sessionFile,'utf8')), ...team.members.map(m=>({id:stoppedProject.memberSessions[m.id],title:'停止验收 · '+m.role.name,config:{agentId:'codex',workdir:home,permissionMode:'read-only'},status:'idle',createdAt:now,teamBinding:{teamProjectId:stoppedProject.id,memberId:m.id}}))]))
  await put(sessionFile,JSON.stringify([...JSON.parse(await readFile(sessionFile,'utf8')), ...team.members.map(m=>({id:doneProject.memberSessions[m.id],title:'交付验收 · '+m.role.name,config:{agentId:'codex',workdir:home,permissionMode:'read-only'},status:'idle',createdAt:now,teamBinding:{teamProjectId:doneProject.id,memberId:m.id}}))]))
  await put(join(userData,'app-settings.json'),JSON.stringify({schemaVersion:1,autoUpdateAgentsOnLaunch:false,autoCheckUpdate:false,enabledAgentIds:[],theme:'dark',notificationMode:'off'}))
  await launch()
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  const screenshot = async name => { await ev("Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))"); const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(output, name + '.png'), Buffer.from(shot.data, 'base64')) }
  const expandHeader = () => ev("if (!document.querySelector('.timer-summary-pop.open .team-session-summary')) { const t = document.querySelector('.turn-timer'); if (t) t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) }")
  const expandSteps = () => ev("document.querySelectorAll('.process-step:not(.open) .process-step-head').forEach(b=>b.click()); document.querySelectorAll('.processed-head[aria-expanded=false]').forEach(b=>b.click())")
  const select = name => ev(`[...document.querySelectorAll('.session-list .session-item')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`)
  const escape = async () => { await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}) }
  await poll(()=>ev('document.querySelectorAll(".session-list .session-item").length'), n=>n===3, 'persisted Leader rows')
  await select('专家团信息流验收')
  await poll(()=>ev('!!document.querySelector(".session-header") && !!document.querySelector(".event-stream")'), Boolean, 'ordinary Leader Session')
  const leaderEvent = (seq, text, id, type='agent_message') => ({sessionId:'s-ui-leader',seq,ts:now+seq*100,type,state:'success',payload:{id,text}})
  const memberAssignment = assignmentPrompt({assignmentId:'task-analyst',attempt:1,title:'梳理技术债与依赖',goal:'逐项阅读现有实现。长任务目标必须完整展示。',permissionMode:'read-only',expectedOutput:'结构化结论',contextRefs:[],projectSummary:'项目概要',sharedContext:{brief:'UI acceptance',decisions:['沿用现有会话布局'],openQuestions:[]},revision:1})
  await ev('window.uniagent.e2eInjectEvents('+JSON.stringify([
    leaderEvent(1,'','start','turn_started'), leaderEvent(2,'我先拆分任务，再汇总。','first'),
    {sessionId:'s-ui-leader',seq:3,ts:now+300,type:'tool_call',state:'success',payload:{id:'tool',name:'dispatch_team_task',provider:'mcp',input:{memberId:'analyst'},result:{assignmentId:'task-analyst'}}},
    leaderEvent(20,'两位成员已返回结果。','second'),leaderEvent(21,'','end','turn_completed'),
    {sessionId:'s-ui-analyst',seq:0,ts:now+50,type:'user_message',payload:{text:memberAssignment}},
    {sessionId:'s-ui-analyst',seq:1,ts:now+100,type:'agent_message',state:'success',payload:{id:'private',text:'PRIVATE_MEMBER_CHAT'}}
  ])+')')
  await expandSteps()
  await poll(()=>ev('document.querySelector(".event-stream").textContent.includes("dispatch_team_task")'),Boolean,'ordinary MCP record')
  check('Leader tools use ordinary steps and private member transcript stays in detail',await ev('!!document.querySelector(".process-step") && !document.querySelector(".event-stream").textContent.includes("PRIVATE_MEMBER_CHAT")'))
  check('old stream and floating capsule are removed',await ev('!document.querySelector(".team-project-view,.team-timeline,.team-task-card,.team-progress-pill,.team-interaction") && !!document.querySelector(".composer-input")'))
  check('recovery expires outstanding questions instead of resubmitting them', (await ev('window.uniagent.teamCatalog()')).projects.find(p=>p.id==='tp_ui').interactions.find(i=>i.id==='business').state==='expired')
  await screenshot('leader-session')
  await expandHeader()
  await poll(()=>ev('!!document.querySelector(".team-session-summary")'),Boolean,'team section in ordinary summary')
  check('Leader is static and only two member seats navigate',await ev('!!document.querySelector("div.team-leader-identity") && !document.querySelector("button.team-leader-identity") && document.querySelectorAll("button.team-progress-role").length===2'))
  await screenshot('summary')
  await ev('document.querySelector("button.team-progress-role").click()')
  await poll(()=>ev('!!document.querySelector(".team-session .event-stream")'),Boolean,'member Session')
  await expandSteps()
  check('member detail keeps assignment and private transcript but no Composer',await ev('!!document.querySelector(".team-assignment") && document.querySelector(".team-session").textContent.includes("PRIVATE_MEMBER_CHAT") && !document.querySelector(".team-session .composer-wrap")'))
  check('member business answer stays in member detail',await ev('document.querySelector(".team-session").textContent.includes("完整范围")'))
  await screenshot('member-session')
  await ev('document.querySelector("[aria-label=返回主会话]").click()')
  await poll(()=>ev('!!document.querySelector(".session-header") && !document.querySelector(".team-session")'),Boolean,'back to Leader')
  await select('完成态 ·')
  await poll(()=>ev('document.querySelector(".topbar-title").textContent.includes("完成态")'),Boolean,'completed Leader Session')
  await expandSteps()
  check('member conclusions are preserved in ordinary process steps',await ev('document.querySelectorAll(".team-member-event").length===2 && document.querySelector(".event-stream").textContent.includes("依赖关系已梳理")'))
  await expandHeader()
  await ev('document.querySelector(".team-session-summary details > summary").click()')
  await ev('[...document.querySelectorAll(".team-session-summary .team-delivery-artifact")].find(b=>b.textContent.includes("核对项目进度")).click()')
  await poll(()=>ev('!!document.querySelector(".team-artifact-dialog[open]")'),Boolean,'text artifact via IPC')
  check('artifact opens its full report',await ev('document.querySelector(".team-artifact-dialog").textContent.includes("核心链路已完成")'))
  await screenshot('text-artifact')
  await escape()
  await poll(()=>ev('!document.querySelector(".team-artifact-dialog")'),Boolean,'native dialog Escape')
  await ev('[...document.querySelectorAll(".team-session-summary .team-delivery-artifact")].find(b=>b.textContent.includes("交付报告.md")).click()')
  await poll(()=>ev('document.querySelector(".filebrowser-overlay .fb-preview")?.textContent'),t=>t?.includes('文件预览验收：42'),'file report via existing browser')
  await screenshot('file-artifact')
  await escape()
  await select('停止态 ·')
  await expandSteps()
  check('stopped members have truthful terminal labels',await ev('document.querySelector(".event-stream").textContent.includes("已取消") && !document.querySelector(".team-progress-pill")'))
  await screenshot('stopped')
  console.log('PASS packaged Leader Session / summary / member detail / artifacts')
} catch(error) {
  console.error(error.stack||error);process.exitCode=1
  try { await put(join(output,'failure-dom.txt'),await ev('document.body.innerText'));const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'failure.png'),Buffer.from(shot.data,'base64')) } catch {}
} finally {
  await put(join(output,'report.json'),JSON.stringify({passed:!process.exitCode,appSha256,checks:results},null,2))
  await put(join(output,'app-stderr.log'),stderr)
  await cleanup()
}
