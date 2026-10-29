// Real packaged App + real provider turns. No injected session/agent state.
// node test/cdp-team-direct.mjs <packaged executable> [traex|codex] [member provider]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
const output = resolve('.test-build/team-direct-' + provider + '-' + new Date().toISOString().replace(/[:.]/g, '-'))
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
  for (const name of ['.codex/auth.json', '.codex/models_cache.json', '.trae/cli/auth.json', '.trae/cli/models_cache.json']) {
    const dst = join(home, name); await mkdir(dirname(dst), { recursive: true })
    try { await copyFile(join(homedir(), name), dst) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const name of ['.codex/config.toml', '.trae/cli/config.toml', '.trae/traecli.toml']) await put(join(home, name), '')
  if (memberProvider === 'claude') {
    const settings = JSON.parse(await readFile(join(homedir(), '.claude/settings.json'), 'utf8'))
    await put(join(home, '.claude/settings.json'), JSON.stringify({ env: Object.fromEntries(Object.entries(settings.env || {}).filter(([key]) => key.startsWith('ANTHROPIC_'))) }))
  }
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
  await launch()
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  const screenshot = async name => { await ev("Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))"); const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(output, name + '.png'), Buffer.from(shot.data, 'base64')) }
  const expandHeader = () => ev("if (!document.querySelector('.timer-summary-pop.open .team-session-summary')) { const t = document.querySelector('.turn-timer'); if (t) t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) }")
  const click = text => ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw Error('button missing: ' + ${JSON.stringify(text)}); b.click() })()`)
  const fill = (selector, value) => ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('input missing'); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await poll(() => ev('!!window.uniagent && !!document.querySelector(".sidebar-header .logo")'), Boolean, 'app UI')

  const agents = await poll(() => ev('window.uniagent.listAgents()'), a => [provider, memberProvider].every(id => a.some(a => a.id === id && a.lifecycle?.availability === 'available')), 'real providers ready', 90000)
  const space = await ev('window.uniagent.createProject(' + JSON.stringify({ name: 'Direct message acceptance', primaryDirectory: workdir, additionalDirectories: [] }) + ')')
  const requirement = await ev('window.uniagent.createRequirement({name:"直接消息验收"})')
  const team = await ev('window.uniagent.saveTeam(' + JSON.stringify({ name: 'Direct acceptance team', description: 'Isolated test', rules: '严格执行验收步骤，不创建团队外子 Agent。', leaderMemberId: 'leader', members: [
    { id:'leader', role:{ id:'leader-role', name:'Coordinator', agentId:provider, permissionMode:'full-access', instructions:'协调验收；只执行用户指定的团队 MCP 流程。' } },
    { id:'worker', role:{ id:'worker-role', name:'Reviewer', agentId:memberProvider, permissionMode:'full-access', instructions:'收到派单后用 shell 执行 sleep 90，保持回合运行以接收 Leader 直接消息；之后报告 resultText，必须如实说明是否看到 DIRECT_SCOPE_42。禁止修改文件。' } }
  ], limits:{ concurrency:1,maxAssignments:3,taskMinutes:5,runMinutes:10 }, status:'active' }) + ')')
  await ev("window.dispatchEvent(new Event('uniagent-projects-changed'))")
  await poll(()=>ev('!!document.querySelector(".new-task .sb-agent")'),Boolean,'new task ready')
  const prompt = '这是直接消息端到端验收。请先 get_team_context，再给 memberId=worker 派一个任务：用 shell 执行 sleep 90 保持当前回合，然后报告是否收到 DIRECT_SCOPE_42。派单后读取上下文，在 worker 仍运行时用 Agent 原生提问能力询问 scope：本轮约束是什么？随后结束 Leader 当前轮。用户回答会由原生提问事件恢复当前 Session。收到答案后，读取当前 assignmentId 和 attempt，调用 send_team_message，requestId=scope-confirmed，message=用户回答中的 DIRECT_SCOPE_42 约束。只能直接发送一次，不得再派单或排队。成员结果到达后确认 inbox，调用 review_team_task 验收成功交付，再 action=complete，最后发送普通回复，summary 包含 DIRECT_MESSAGE_ACCEPTANCE_OK。不得直接读取/写入系统状态。';
  await fill('.new-task textarea.prompt-input', prompt)
  await ev('document.querySelector(".new-task .sb-agent summary").click()')
  await ev('[...document.querySelectorAll(".new-task .sb-sub-entry")].find(b=>b.textContent.includes("专家团")).click()')
  await poll(()=>ev('[...document.querySelectorAll(".new-task .sb-sub-opt")].some(b=>b.textContent.includes("Direct acceptance team") && !b.disabled)'),Boolean,'available team option')
  await screenshot('executor-picker')
  await ev('[...document.querySelectorAll(".new-task .sb-sub-opt")].find(b=>b.textContent.includes("Direct acceptance team")).click()')
  check('team selection hides single-Agent model, effort and permission controls',await ev('![...document.querySelectorAll(".new-task .sb-agent .sb-entry-body")].some(e=>["模型","推理强度"].includes(e.firstChild?.textContent.trim())) && ![...document.querySelectorAll(".new-task label.cfg")].some(e=>e.textContent.trim().startsWith("权限"))'))
  check('choosing team retains draft and does not create work', await ev('document.querySelector(".new-task textarea").value===' + JSON.stringify(prompt)) && (await ev('window.uniagent.teamCatalog()')).projects.length===0)
  await ev('document.querySelector(".new-task .sb-agent").removeAttribute("open");document.querySelector(".new-task .project-picker summary").click()')
  await poll(()=>ev('[...document.querySelectorAll(".new-task .project-picker-list button")].some(b=>b.textContent.includes("Direct message acceptance"))'),Boolean,'space list refreshed')
  await ev('[...document.querySelectorAll(".new-task .project-picker-list button")].find(b=>b.textContent.includes("Direct message acceptance")).click()')
  await ev('document.querySelector(".new-task .requirement-picker summary").click()')
  await ev('[...document.querySelectorAll(".new-task .requirement-picker button")].find(b=>b.textContent.includes("直接消息验收")).click()')
  // A real backend path-validation failure must keep the entire creation draft.
  await rename(workdir, workdir + '-unavailable')
  try {
    await ev('document.querySelector(".new-task-send-btn").click()')
    await poll(()=>ev('document.querySelector(".new-task").innerText.includes("创建任务失败")'),Boolean,'creation failure shown')
    check('failed creation keeps prompt, executor, space and requirement',await ev('document.querySelector(".new-task textarea").value===' + JSON.stringify(prompt) + ' && document.querySelector(".new-task .sb-agent summary").innerText.includes("Direct acceptance team") && document.querySelector(".new-task .project-picker").innerText.includes("Direct message acceptance") && document.querySelector(".new-task .requirement-picker").innerText.includes("直接消息验收")') && (await ev('window.uniagent.teamCatalog()')).projects.length===0)
  } finally { await rename(workdir + '-unavailable', workdir) }
  await ev('document.querySelector(".new-task-send-btn").click(); document.querySelector(".new-task-send-btn").click()')
  await poll(()=>ev('!!document.querySelector(".session-header")'),Boolean,'team conversation')
  async function readProject() {
    const p = (await ev('window.uniagent.teamCatalog()')).projects[0]; latest = p
    if (p?.status === 'failed') throw Error(p.error || 'project failed')
    return p
  }
  check('double submit creates only one team project', (await ev('window.uniagent.teamCatalog()')).projects.length===1)
  latest = await poll(readProject, p => p?.interactions.some(i=>i.kind==='native_question' && i.memberId==='leader' && i.state==='pending') && p.assignments.some(a=>a.status==='running' && a.turnId), 'Leader native question while member runs', 240000)
  check('new task preserves actual space and requirement in all member Sessions',latest.spaceId===space.id && latest.requirementId===requirement.id && (await ev('window.uniagent.listSessions()')).filter(s=>s.teamBinding).every(s=>s.config.requirementId===requirement.id && s.config.projectId===space.id))
  await screenshot('question-and-running-member')
  await fill('.event-stream .approval-answer','DIRECT_SCOPE_42：仅只读分析，禁止修改任何文件。')
  await click('提交回答')
  latest = await poll(readProject,p=>p.communications?.some(c=>c.requestId==='scope-confirmed' && c.state!=='sending'),'Provider direct message receipt',180000)
  const receipt = latest.communications.find(c=>c.requestId==='scope-confirmed')
  check('Provider acknowledges direct send without a new assignment', receipt.state==='sent' && latest.assignments.length===1 && receipt.turnId===latest.assignments[0].turnId)
  await ev('document.querySelectorAll(".process-step-head[aria-expanded=false]").forEach(b=>b.click())')
  check('ordinary stream retains answer and real send tool',await ev('document.querySelector(".event-stream").textContent.includes("DIRECT_SCOPE_42") && document.querySelector(".event-stream").textContent.includes("send_team_message") && !document.querySelector(".team-communication")'))
  await screenshot('direct-message-sent')
  await expandHeader()
  await ev('document.querySelector("button.team-progress-role").click()')
  await poll(()=>ev('!!document.querySelector(".team-session")'),Boolean,'member detail')
  await ev('document.querySelectorAll(".process-step-head[aria-expanded=false]").forEach(b=>b.click())')
  check('member detail retains full Leader supplement',await ev('document.querySelector(".team-session").textContent.includes("DIRECT_SCOPE_42")'))
  await screenshot('member-direct-receipt')
  await ev('document.querySelector("[aria-label=返回主会话]").click()')
  latest = await poll(readProject,p=>p.status==='completed','member observes constraint and Leader delivers',300000)
  check('member acknowledges direct constraint and Leader completes once',latest.assignments[0].result?.includes('DIRECT_SCOPE_42') && latest.finalResult.summary.includes('DIRECT_MESSAGE_ACCEPTANCE_OK') && latest.communications.length===1)
  await screenshot('final-delivery')
  await ev('document.querySelector(".sidebar-header .btn-new").click()')
  await poll(()=>ev('!!document.querySelector(".new-task textarea") && !!document.querySelector(".new-task textarea").getClientRects().length'),Boolean,'return to unified create')
  await ev('document.querySelector(".new-task .sb-agent summary").click()')
  await ev('[...document.querySelectorAll(".new-task .sb-sub-entry")].find(b=>b.querySelector(".sb-entry-body")?.firstChild?.textContent.trim()==="Agent").click()')
  await ev('[...document.querySelectorAll(".new-task .sb-sub-opt")].find(b=>b.textContent.includes("TraeX")).click()')
  await fill('.new-task textarea.prompt-input','仅回复 ORDINARY_SESSION_OK，不要使用工具。')
  await ev('document.querySelector(".new-task .sb-agent").removeAttribute("open"); document.querySelector(".new-task-send-btn").click()')
  const ordinary = await poll(()=>ev('window.uniagent.listSessions()'),sessions=>sessions.some(s=>!s.teamBinding), 'ordinary Agent created alongside team',30000)
  const standalone = ordinary.find(s=>!s.teamBinding)
  const ordinaryEvents = await poll(()=>ev('window.uniagent.getEvents(' + JSON.stringify(standalone.id) + ')'),events=>events.some(e=>e.type==='turn_completed') && events.some(e=>e.type==='agent_message' && e.payload.text?.includes('ORDINARY_SESSION_OK')), 'ordinary Agent response completes',120000)
  check('ordinary Agent still starts and replies from unified create', ordinaryEvents.some(e=>e.type==='agent_message' && e.payload.text?.includes('ORDINARY_SESSION_OK')))
  check('ordinary and team tasks coexist in the same sidebar', await ev('document.querySelectorAll(".session-list .session-item").length===2 && document.querySelectorAll(".session-list .si-tag").length===0 && document.querySelectorAll(".session-list .ui-icon-users").length===1'))
  await screenshot('unified-agent-and-team')
  console.log('PASS native Leader question / user answer / active member direct message')
} catch (error) {
  console.error(error.stack || error); process.exitCode = 1
  if (ev) { try { latest = await ev('window.uniagent.teamCatalog()'); await put(join(output, 'failure-dom.txt'), await ev('document.body.innerText')); const sessions=await ev('window.uniagent.listSessions()'); for(const s of sessions.filter(s=>s.teamBinding)) await put(join(output, s.id+'.json'), JSON.stringify(await ev(`window.uniagent.getEvents(${JSON.stringify(s.id)})`), null, 2)) } catch {} }
} finally {
  await put(join(output, 'report.json'), JSON.stringify({ passed: !process.exitCode, provider, memberProvider, appSha256, checkedAt: new Date().toISOString(), checks: results, project: latest }, null, 2))
  await put(join(output, 'app-stderr.log'), stderr)
  await cleanup()
}
