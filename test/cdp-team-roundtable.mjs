// Real packaged App + real provider turns. No injected session/agent state.
// node test/cdp-team-roundtable.mjs <packaged executable> [traex|codex] [member provider]
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
const output = resolve('.test-build/team-roundtable-' + provider + '-' + new Date().toISOString().replace(/[:.]/g, '-'))
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
  const agent = agents.find(a => a.id === provider)
  console.log('PROVIDER ' + JSON.stringify({ id: agent.id, model: agent.defaultModel, availability: agent.lifecycle.availability }))
  const homeMetrics = await ev('(() => { const b=document.querySelector(".composer-box"), t=document.querySelector(".prompt-input"); return {width:b.getBoundingClientRect().width,height:t.getBoundingClientRect().height,font:getComputedStyle(t).fontSize} })()')
  await ev(`window.uniagent.createProject(${JSON.stringify({ name: 'Roundtable acceptance', primaryDirectory: workdir, additionalDirectories: [] })})`)
  await ev("window.dispatchEvent(new Event('uniagent-projects-changed'))")
  for (const name of ['Coordinator', 'Analyst', 'Reviewer']) await ev(`window.uniagent.saveRole(${JSON.stringify({ id: '', name, agentId: name === 'Coordinator' ? provider : memberProvider, permissionMode: memberProvider === 'claude' && name !== 'Coordinator' ? 'ask' : 'read-only', ...(memberProvider === 'claude' && name !== 'Coordinator' ? { toolPolicy: { mode: 'allow-only', tools: ['Read', 'mcp__uniagent__get_team_context', 'mcp__uniagent__report_team_task'] } } : {}), instructions: '用于验收的专家：严格执行团队协议，只读取 facts.txt，不联网、不创建其他 Agent。' })})`)
  check('unified home retains ordinary Session dimensions',await ev('!!document.querySelector(".new-task .composer-box") && !document.querySelector(".team-mode-toggle")'))
  await screenshot('new-empty')
  await ev('document.querySelector(".sidebar-footer .settings-entry").click()')
  await poll(()=>ev('!!document.querySelector(".set-nav")'),Boolean,'settings')
  await ev('[...document.querySelectorAll(".set-nav-item")].find(b=>b.textContent.trim()==="专家团").click()')
  await poll(()=>ev('!!document.querySelector(".team-grid")'),Boolean,'team management')
  await click('创建团队')
  check('team editor reuses styled action buttons', await ev(`(() => { const b=document.querySelector('.team-form .set-save-btn'); return !!b && parseFloat(getComputedStyle(b).borderRadius) >= 7 })()`))
  await fill('textarea[placeholder="例如：产品专家团"]', 'Acceptance team')
  await fill('.team-field:nth-of-type(2) textarea', '团队描述')
  const fields = await ev('[...document.querySelectorAll("textarea.team-text-input")].map(t=>({y:t.getBoundingClientRect().y,font:getComputedStyle(t).fontSize,max:getComputedStyle(t).maxHeight}))')
  check('team name description and rules share 14px text and ten-line cap',fields.length===3 && fields.every(f=>f.font==='14px'&&f.max==='246px') && fields[1].y>fields[0].y)
  const rules = await ev('document.querySelectorAll("textarea.team-text-input")[2].value')
  await fill('textarea.team-text-input[rows="3"]', Array.from({length:15},(_,i)=>'规则 '+i).join('\n'))
  check('long team rules scroll after ten lines',await ev('(() => {const t=document.querySelectorAll("textarea.team-text-input")[2];return t.getBoundingClientRect().height<=246 && t.scrollHeight>t.clientHeight && getComputedStyle(t).overflowY==="auto"})()'))
  await fill('textarea.team-text-input[rows="3"]', rules)
  for (const name of ['Coordinator', 'Analyst', 'Reviewer']) {
    await click('＋ 添加成员')
    await poll(() => ev(`!![...document.querySelectorAll('.team-role-options button')].find(b => b.querySelector('strong')?.textContent === ${JSON.stringify(name)})`), Boolean, 'role picker')
    await ev(`[...document.querySelectorAll('.team-role-options button')].find(b => b.querySelector('strong')?.textContent === ${JSON.stringify(name)}).click()`)
  }
  await screenshot('team-editor')
  check('execution limits are expanded by default', await ev('document.querySelector(".limit-settings").open'))
  await click('＋ 添加成员'); await screenshot('member-picker')
  check('picker marks existing members', await ev('[...document.querySelectorAll(".team-picker-state")].every(el => el.textContent === "已添加")'))
  await ev('document.querySelector(".team-modal .btn-ghost").click()')
  await ev('document.querySelector(".team-member-label").click()')
  await poll(() => ev('!!document.querySelector(".set-detail-top")'), Boolean, 'member role editor')
  await screenshot('member-role')
  check('editing an existing team member does not offer global creation switch',await ev('!document.querySelector("[aria-label=同时保存到角色列表]")'))
  const roleSpaceHidden = await ev(`(() => { const field = document.querySelector('[aria-label="角色空间策略"]'); return !field || !field.getClientRects().length })()`)
  await ev('document.querySelector(".team-back-icon").click()')
  await click('＋ 添加成员'); await click('＋ 创建团队专属角色')
  await poll(()=>ev('!!document.querySelector("[aria-label=同时保存到角色列表]")'),Boolean,'new team role switch')
  check('new team role stays inside the member picker modal',await ev('!!document.querySelector(".team-modal.team-role-modal .role-detail-top") && !document.querySelector(".team-page.team-role-form")'))
  check('new team role global switch is off and immediately left of save',await ev('(() => {const t=document.querySelector("[aria-label=同时保存到角色列表]"), b=document.querySelector(".team-role-modal-actions .set-save-btn"), g=document.querySelector(".team-role-form .set-group"); return t.getAttribute("aria-checked")==="false" && t.getBoundingClientRect().right<b.getBoundingClientRect().left && Math.abs(b.getBoundingClientRect().right-g.getBoundingClientRect().right)<2 })()'))
  check('member name and description reuse team input typography',await ev('[...document.querySelectorAll(".team-role-form .set-fld-inp")].every(t=>getComputedStyle(t).fontSize==="14px")'))
  await screenshot('new-team-role')
  for (const global of [false,true]) {
    if (global) { await click('＋ 添加成员'); await click('＋ 创建团队专属角色'); await ev('document.querySelector("[aria-label=同时保存到角色列表]").click()') }
    const name=global?'Shared acceptance role':'Team-only acceptance role'
    await fill('.team-role-form input.set-fld-inp',name)
    await ev(`(() => {const s=document.querySelector('select[aria-label="角色 Agent"]');s.value=${JSON.stringify(provider)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await ev('document.querySelector(".team-role-modal-actions .set-save-btn").click()')
    await poll(()=>ev('!!document.querySelector(".team-member-row") && !document.querySelector(".role-detail-top")'),Boolean,'new role saved to team')
    check('new role '+(global?'also saved globally':'stays team-only'),(await ev('window.uniagent.listRoles()')).some(r=>r.role.name===name)===global)
    await ev('document.querySelector('+JSON.stringify('[aria-label="移除 '+name+'"]')+').click()')
  }
  await click('＋ 添加成员'); await click('＋ 创建团队专属角色')
  await ev('document.querySelector(".team-role-modal [aria-label=\"返回成员列表\"]").click()')
  await poll(()=>ev('!!document.querySelector(".team-role-options")'),Boolean,'new role back returns to member picker')
  await ev('document.querySelector(".team-modal .btn-ghost").click()')
  await ev('document.querySelector("[aria-label=启用团队]").click()'); await click('保存')
  await poll(() => ev('window.uniagent.teamCatalog()'), c => c.teams.length === 1, 'save team')
  await screenshot('teams')
  await ev('document.querySelector(".team-tile").click()')
  check('saved team has delete enable and save on the same toolbar',await ev('(() => {const t=document.querySelector(".team-page-title");return t.innerText.includes("删除团队") && !!t.querySelector("[aria-label=启用团队]") && !document.querySelector(".team-form").innerText.includes("保存草稿") && !document.querySelector(".team-form").innerText.includes("保存并启用")})()'))
  await click('删除团队'); await screenshot('delete-team-confirmation')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await poll(()=>ev('!document.querySelector("[role=alertdialog]")'),Boolean,'delete dismisses without change')
  await ev('document.querySelector("[aria-label=返回团队]").click()')
  check('UI creates one Leader and two members', await ev('(async()=>{const c=await window.uniagent.teamCatalog();return c.teams[0].members.length===3 && !!c.teams[0].leaderMemberId})()'))
  check('team role editor hides the inapplicable space strategy', roleSpaceHidden)
  await ev('document.querySelector(".btn-new").click()')
  await poll(() => ev('!!document.querySelector(".new-task textarea.prompt-input")'), Boolean, 'composer')
  await ev('document.querySelector(".new-task .sb-agent summary").click()')
  await ev('[...document.querySelectorAll(".new-task .sb-sub-entry")].find(b=>b.textContent.includes("专家团")).click()')
  await ev('[...document.querySelectorAll(".new-task .sb-sub-opt")].find(b=>b.textContent.includes("Acceptance team")).click()')
  await ev('document.querySelector(".new-task .sb-agent").removeAttribute("open")')
  check('team choice is configuration, not an immediate start', (await ev('window.uniagent.teamCatalog()')).projects.length===0)
  // Select the isolated workspace through the same ProjectPicker used by users.
  const task = '验收任务：读取空间中的 facts.txt，计算 Alpha + Beta。请给 Analyst 派一次独立求和任务；给 Reviewer 派一次独立核对任务；两者完成后，再给 Reviewer 派一次互审任务，并通过 contextRefs 授权读取 Analyst 的结果。三次任务都必须调用 dispatch_team_task。首轮派单后，请调用 wait_members 并结束本轮等待交付。成员用 report_team_task 返回结果并结束回合。你必须读取结果，用 review_team_task 验收每次成功交付，再通过 update_team_project(action=complete) 完成，最后发送普通回复；summary 和回复均须包含 ROUND_TABLE_OK=42。无需用户澄清，不联网、不写文件。';
  // The default space is also isolated; set the explicit selected space in the picker.
  await ev(`(() => { const picker=document.querySelector('.new-task .project-picker'); if(picker) picker.querySelector('summary,button')?.click() })()`)
  await fill('.new-task textarea.prompt-input', task)
  // Choose the space via the visible picker option.
  await ev(`(() => { const option=[...document.querySelectorAll('.new-task .project-picker-list button')].find(b => b.textContent.includes('Roundtable acceptance')); if (!option) throw Error('space missing'); option.click() })()`)
  await ev('document.querySelector(".new-task-send-btn").click()')
  let lastState = '', liveSeen = false
  await poll(()=>ev('!!document.querySelector(".session-header") && !!document.querySelector(".event-stream")'),Boolean,'ordinary Leader Session')
  const expandSteps = () => ev('document.querySelectorAll(".process-step-head[aria-expanded=false]").forEach(b=>b.click())')
  check('team uses ordinary Composer and header without old capsule',await ev('!!document.querySelector(".composer-input") && !document.querySelector(".session-summary-toggle") && !document.querySelector(".team-project-view,.team-progress-pill")'))
  await screenshot('accepted')
  async function readProject() {
    const p = (await ev('window.uniagent.teamCatalog()')).projects[0]
    if (!p) return p
    latest = p
    const state=JSON.stringify({status:p.status,assignments:p.assignments.map(a=>[a.title,a.status]),error:p.error})
    if(state!==lastState){console.log(state);lastState=state}
    if(p.status==='failed') throw Error(state)
    const running=p.assignments.find(a=>a.runId===p.runId && ['queued','running'].includes(a.status))
    if(running && !liveSeen) {
      await expandSteps()
      liveSeen=await ev('!!document.querySelector('+JSON.stringify('[data-assignment-id="'+running.id+'"]')+')')
      if(liveSeen) await screenshot('member-running')
    }
    for(const i of p.interactions.filter(i=>i.state==='pending')) {
      assert.equal(i.event?.payload?.params?._meta?.codex_approval_kind,'mcp_tool_call','only approve test task MCP calls')
      assert.equal(i.kind,'native_approval')
    }
    if(p.interactions.some(i=>i.state==='pending')) {
      await expandSteps()
      await ev('document.querySelectorAll(".event-stream .appr-session").forEach(b=>b.click())')
    }
    return p
  }
  latest=await poll(readProject,p=>p?.status==='completed','real dispatch / review / delivery',360000)
  check('three assignments are delivered and explicitly accepted',latest.assignments.length>=3 && latest.assignments.every(a=>a.status==='succeeded' && a.review?.decision==='accept') && latest.assignments.some(a=>a.contextRefs.length) && latest.finalResult.summary.includes('ROUND_TABLE_OK=42'))
  check('member appears before completion',liveSeen)
  const bindings=latest.memberSessions
  const leaderId=bindings[latest.team.leaderMemberId]
  const leaderEvents=()=>ev('window.uniagent.getEvents('+JSON.stringify(leaderId)+')')
  await poll(leaderEvents,events=>events.some(e=>e.type==='agent_message' && e.payload.text?.includes('ROUND_TABLE_OK=42')),'ordinary final reply')
  await expandSteps()
  check('tools and readable member conclusions share ordinary steps',await ev('document.querySelectorAll(".team-member-event").length>=3 && !!document.querySelector(".team-member-result") && document.querySelector(".event-stream").textContent.includes("dispatch_team_task")'))
  await screenshot('completed')
  await expandHeader()
  await poll(()=>ev('document.querySelectorAll("button.team-progress-role").length'),n=>n===2,'members in summary')
  check('Leader identity has no separate detail page',await ev('!!document.querySelector("div.team-leader-identity") && !document.querySelector("button.team-leader-identity")'))
  await screenshot('summary')
  await ev('document.querySelector("button.team-progress-role").click()')
  await poll(()=>ev('!!document.querySelector(".team-session .event-stream")'),Boolean,'member detail')
  check('member detail preserves transcript and is read-only',await ev('!document.querySelector(".team-session .composer-wrap") && !!document.querySelector(".team-session .event-stream")'))
  await screenshot('member-session')
  await ev('document.querySelector("[aria-label=返回主会话]").click()')
  await fill('textarea.composer-input','继续验收：再派 Analyst 复查一次 17+25，保持固定成员 Session；读取结果后调用 review_team_task 验收，再 complete，最后普通回复 FOLLOWUP_OK=42。')
  await ev('document.querySelector(".composer-send-btn").click()')
  latest=await poll(readProject,p=>p.runId===2 && p.status==='completed','ordinary follow-up',240000)
  check('follow-up preserves Sessions and previous delivery',JSON.stringify(latest.memberSessions)===JSON.stringify(bindings) && latest.previousResults.length===1 && latest.finalResult.summary.includes('FOLLOWUP_OK=42'))
  await poll(leaderEvents,events=>events.some(e=>e.type==='agent_message' && e.payload.text?.includes('FOLLOWUP_OK=42')),'follow-up final reply')
  await screenshot('follow-up')
  await fill('textarea.composer-input','验收静默等待与全员中断：给 Analyst 和 Reviewer 各派一个长等待任务，prompt 要求通过终端执行 sleep 420，执行结束再读取 facts.txt 汇报，不得提前返回。两项派出后立即 wait_members 并结束本轮，等待成员结果，先不要 complete。')
  await ev('document.querySelector(".composer-send-btn").click()')
  latest=await poll(readProject,p=>p.status==='waiting_members' && p.assignments.filter(a=>a.runId===3 && a.status==='running').length===2,'members work while Leader waits',180000)
  const runtimeSessions=await ev('window.uniagent.listSessions()')
  check('dispatch preserves role permissions',latest.team.members.every(m=>runtimeSessions.find(s=>s.id===bindings[m.id]).config.permissionMode===m.role.permissionMode))
  check('stop remains available while only members run',await ev('!!document.querySelector(".composer-stop-btn")'))
  const beforeWait=(await leaderEvents()).at(-1)?.seq ?? -1
  const waitStarted=performance.now()
  latest=await poll(readProject,()=>performance.now()-waitStarted>=310000,'silent member wait beyond five minutes',390000)
  check('waiting does not inject progress events or wake the Leader',latest.status==='waiting_members' && !latest.inbox.some(e=>e.runId===3 && e.kind==='progress') && !(await leaderEvents()).some(e=>e.seq>beforeWait && ['turn_started','user_message','agent_message'].includes(e.type)))
  await screenshot('waiting-members')
  await ev('document.querySelector(".composer-stop-btn").click()')
  latest=await poll(readProject,p=>p.status==='interrupted','whole-team stop')
  check('stop ends all Agents and retains earlier results',(await ev('window.uniagent.listSessions()')).filter(s=>s.teamBinding).every(s=>!['running','queued','awaiting-approval','cancelling'].includes(s.status)) && latest.assignments.filter(a=>a.runId<3).every(a=>a.status==='succeeded'))
  ws.close();await sweeper.sweep();await launch()
  latest=await poll(readProject,p=>p.status==='interrupted','restart restores without running')
  check('restart preserves fixed Sessions',JSON.stringify(latest.memberSessions)===JSON.stringify(bindings))
  await poll(()=>ev('window.uniagent.listAgents()'),a=>a.some(a=>a.id===provider && a.lifecycle?.availability==='available'),'provider ready',90000)
  await ev('document.querySelector(".session-list .session-item").click()')
  await expandHeader();await click('恢复协作')
  latest=await poll(readProject,p=>!['interrupted','stopping'].includes(p.status),'manual resume')
  await ev('document.querySelector(".composer-stop-btn").click()')
  latest=await poll(readProject,p=>p.status==='interrupted','resumed stop')
  await ev('window.uniagent.archiveSession('+JSON.stringify(leaderId)+')')
  latest=(await ev('window.uniagent.teamCatalog()')).projects[0]
  check('ordinary archive retains team history',!!latest.archivedAt)
  await screenshot('archived')
  await ev('document.querySelector(".sidebar-footer .settings-entry").click()'); await poll(()=>ev('!!document.querySelector(".set-nav")'),Boolean,'settings'); await ev('[...document.querySelectorAll(".set-nav-item")].find(b=>b.textContent.trim()==="专家团").click()'); await poll(()=>ev('!!document.querySelector(".team-tile")'),Boolean,'teams'); await ev('document.querySelector(".team-tile").click()')
  await ev('document.querySelector("[aria-label=启用团队]").click()'); await click('保存')
  check('enable toggle saves disabled status', (await ev('window.uniagent.teamCatalog()')).teams[0].status==='draft')
  await ev('document.querySelector(".team-tile").click()'); await click('删除团队'); await click('确认删除')
  await poll(()=>ev('window.uniagent.teamCatalog()'),c=>c.teams.length===0,'delete template through UI')
  check('template deletion retains project and role Sessions', (await ev('window.uniagent.teamCatalog()')).projects.length===1 && (await ev('window.uniagent.listSessions()')).filter(s=>s.teamBinding).length===3)
  for (const sid of Object.values(bindings)) await put(join(output, sid + '.json'), JSON.stringify(await ev(`window.uniagent.getEvents(${JSON.stringify(sid)})`), null, 2))
  check('unified sidebar excludes member seats after archival', await ev('!document.querySelector(".team-app") && !document.querySelector(".session-list .session-item:not(.archived)")'))
  console.log('PASS real roundtable lifecycle')
} catch (error) {
  console.error(error.stack || error); process.exitCode = 1
  if (ev) { try { latest = await ev('window.uniagent.teamCatalog()'); await put(join(output, 'failure-dom.txt'), await ev('document.body.innerText')); const sessions=await ev('window.uniagent.listSessions()'); for(const s of sessions.filter(s=>s.teamBinding)) await put(join(output, s.id+'.json'), JSON.stringify(await ev(`window.uniagent.getEvents(${JSON.stringify(s.id)})`), null, 2)) } catch {} }
} finally {
  await put(join(output, 'report.json'), JSON.stringify({ passed: !process.exitCode, provider, memberProvider, appSha256, checkedAt: new Date().toISOString(), checks: results, project: latest }, null, 2))
  await put(join(output, 'app-stderr.log'), stderr)
  await cleanup()
}
