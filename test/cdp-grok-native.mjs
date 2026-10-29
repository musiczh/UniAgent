// Packaged renderer/IPC acceptance with an isolated native-protocol fixture.
// Real 1.0.62 is qualified separately by grok-native-cli.ts and grok-goal-native.ts.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createPortServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary=resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release')+'/') && binary.endsWith('/Contents/MacOS/UniAgent Public'),'only repository release App is allowed')
const renderer=binary.replace('/MacOS/UniAgent Public','/Resources/app.asar.unpacked/out/renderer/index.html')
const fixture=await mkdtemp(join(tmpdir(),'ua-grok-packaged-'))
const home=join(fixture,'home'),data=join(fixture,'data'),workdir=join(fixture,'workspace')
const evidence=resolve('out/test-results','grok-packaged-'+Date.now())
const sweeper=createAcceptanceProcessSweeper({termGraceMs:1500,killDeadlineMs:8000})
const checks=[],pending=new Map()
let child,ws,serial=0,stderr='',cleanupPromise,forceCleanup=false
const delay=ms=>new Promise(done=>setTimeout(done,ms))
const sha256=value=>createHash('sha256').update(value).digest('hex')
function check(label, value, detail) {
  assert.ok(value, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)))
  checks.push(label)
  console.log('✓ ' + label)
}
async function put(file, contents) {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  await writeFile(file, contents, { mode: 0o600 })
}
async function waitFor(read, predicate, label, timeout = 90000) {
  const start = Date.now(); let last, reported = start
  while (Date.now() - start < timeout) {
    last = await read()
    if (predicate(last)) return last
    if (Date.now() - reported > 25000) { console.log('… waiting: ' + label); reported = Date.now() }
    await delay(250)
  }
  throw new Error(label + ' timed out: ' + JSON.stringify(last))
}
function cdp(method, params = {}, timeout = 60000) {
  return new Promise((resolveRequest, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeout)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveRequest(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.error || reply.result?.exceptionDetails) throw new Error(reply.result?.exceptionDetails?.exception?.description || JSON.stringify(reply.error))
  return reply.result.result.value
}
const call = (method, ...args) => evaluate('window.uniagent.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')')
const dom = source => evaluate('(async () => {' + source + '})()')
async function click(selector, text) {
  assert.ok(await dom(`const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => !node.closest('[hidden]') && ${text === undefined ? 'true' : `node.textContent.includes(${JSON.stringify(text)})`}); node?.click(); return !!node;`), 'missing control ' + selector + ' ' + (text || ''))
}
async function select(label, value) {
  assert.ok(await dom(`const node = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); if (!node || node.disabled || ![...node.options].some(option => option.value === ${JSON.stringify(value)} && !option.disabled)) return false; node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', {bubbles:true})); return true;`), 'select unavailable: ' + label + ' ' + value)
}
async function input(selector, value) {
  assert.ok(await dom(`const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) return false; const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', {bubbles:true})); return true;`), 'input unavailable: ' + selector)
}
async function screenshot(name) {
  const result = await cdp('Page.captureScreenshot', { format: 'png' }, 10000)
  await put(join(evidence, name + '.png'), Buffer.from(result.result.data, 'base64'))
}
async function prepare() {
  await chmod(fixture,0o700)
  for(const directory of [home,data,workdir,evidence,join(home,'Library'),...['bin','tmp','chromium','config','xdg-data','cache','state','runtime','npm-cache'].map(name=>join(fixture,name))]) await mkdir(directory,{recursive:true,mode:0o700})
  await put(join(data,'app-settings.json'),JSON.stringify({schemaVersion:1,autoUpdateAgentsOnLaunch:false,autoUpdateAgentsWhenIdle:false,autoCheckUpdate:false,enabledAgentIds:['grok']}))
  await put(join(fixture,'native.json'),JSON.stringify({sessions:[]}))
  await put(join(fixture,'bin/grok'),'#!'+process.execPath+'\nrequire('+JSON.stringify(resolve('test/fixtures/fake-grok.cjs'))+')\n')
  await chmod(join(fixture,'bin/grok'),0o700)
  for(const id of ['codex','traecli','claude','kimi','dsh','zcode']) {
    await put(join(fixture,'bin',id),'#!/bin/sh\nexit 127\n');await chmod(join(fixture,'bin',id),0o700)
  }
  await put(join(fixture,'gitconfig'),'');await put(join(fixture,'npmrc'),'')
  const png='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RMQ0AMAzEQLf8OacQ3CWbD8BHcg4Mm+7qOh340A9UiVSJVIlUiVSJVIlUiVSJMA+hxgE/8m7SpQAAAABJRU5ErkJggg=='
  await put(join(workdir,'image.png'),Buffer.from(png,'base64'))
}
async function state(id){return (await call('listSessions')).find(session=>session.id===id)}
async function completed(id,after=-1){return waitFor(async()=>({state:await state(id),events:await call('getEvents',id)}),value=>{
  const latest=value.events.filter(event=>event.seq>after)
  if(value.state?.status==='error')throw new Error(JSON.stringify(latest.filter(event=>event.type==='error')))
  return ['idle','completed'].includes(value.state?.status)&&latest.some(event=>event.type==='turn_completed'&&event.state==='success')
},'completed turn')}
async function selectSession(id){await waitFor(()=>dom('return !!document.querySelector(\'.session-item[data-session-id="'+id+'"]\')'),Boolean,'session row');await click('.session-item[data-session-id="'+id+'"]')}
async function cleanup(){return cleanupPromise ||= (async()=>{ws?.close();await sweeper.sweep({force:forceCleanup,shouldAbort:()=>forceCleanup});if(forceCleanup)await sweeper.forceSweep();await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:250})})()}
const termination=createAcceptanceTerminationHandler({cleanup,requestForceCleanup:()=>{forceCleanup=true},onFirstSignal:signal=>console.error('Acceptance interrupted: '+signal),onCleanupError:error=>console.error(error),exit:code=>process.exit(code)})
process.once('SIGINT',()=>termination.handleTerminationSignal('SIGINT',130))
process.once('SIGTERM',()=>termination.handleTerminationSignal('SIGTERM',143))
async function startApp() {
  const portServer = createPortServer()
  await new Promise(done => portServer.listen(0, '127.0.0.1', done))
  const port = portServer.address().port
  await new Promise(done => portServer.close(done))
  const env = {
    PATH: join(fixture, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, USER: 'ua-beta-test', LOGNAME: 'ua-beta-test',
    UNIAGENT_USER_DATA: data, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_CODE_HOME: join(home, '.kimi-code'), KIMI_HOME: join(home, '.kimi'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
    FAKE_GROK_LOG: join(fixture,'frames.jsonl'), FAKE_GROK_STATE: join(fixture,'native.json'), FAKE_GROK_SCENARIO: JSON.stringify({native:true,childRunning:true}), GROK_GOAL:'1',
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg-data'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), XDG_RUNTIME_DIR: join(fixture, 'runtime'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1'
  }
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.on('error', error => { stderr += String(error) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000) })
  await sweeper.addRoot(child.pid)
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('App exited during startup: ' + stderr)
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) }).then(response => response.json()) } catch { return [] }
  }, targets => targets.some(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer), 'exact packaged renderer', 45000)
  const target = targets.find(target => target.type === 'page' && target.url.startsWith('file:') && fileURLToPath(target.url) === renderer)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (request) { pending.delete(message.id); request.resolve(message) } }
  ws.onclose = () => { for (const request of pending.values()) request.reject(new Error('CDP disconnected')); pending.clear() }
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
  await waitFor(async () => { try { return await call('getLifecycleSnapshot') } catch (error) { if (/Execution context was destroyed|Cannot find context/.test(String(error))) return null; throw error } }, Boolean, 'preload ready')
  check('exact release renderer and public bridge', await evaluate('document.title === "UniAgent Public" && typeof window.uniagent.createSession === "function"'))
}
let failure
try {
  await prepare();await startApp()
  await waitFor(()=>call('getLifecycleSnapshot'),rows=>rows.some(row=>row.id==='grok'&&row.lifecycle?.availability==='available'),'Grok detection')
  const grok=(await call('detectAgents')).find(agent=>agent.id==='grok')
  check('verified native capabilities reach AgentDef',['nativeGoal','steer','sessionFork','sideChat','structuredSubagents','imageAttachments','capabilityInventory'].every(key=>grok.capabilities[key]===true),grok)
  const session=await call('createSession',{agentId:'grok',model:'grok-4.7',workdir,permissionMode:'ask'},'ordinary')
  let result=await completed(session.id)
  await selectSession(session.id)
  await waitFor(()=>dom('return document.querySelector(".composer-wrap")?.textContent || ""'),Boolean,'composer')
  check('session native contract is confirmed',result.state.agentContract?.grokNative?.confirmed)
  await click('.sb-add-btn')
  check('approved menu exposes Goal and attachments only',await dom('const menu=document.querySelector(".composer-wrap .sb-add");return menu.textContent.includes("Goal")&&menu.textContent.includes("添加附件")&&![...menu.querySelectorAll(".native-action-item")].some(node=>/Plan|Review/.test(node.textContent))'))
  await click('.sb-add-btn')
  check('usage cache is retained once',result.events.filter(event=>event.payload.kind==='usage').length===1&&result.events.find(event=>event.payload.kind==='usage').payload.usage.cachedInputTokens===30)
  await screenshot('native-session')
  let seq=Math.max(...result.events.map(event=>event.seq))
  const image={kind:'image',path:join(workdir,'image.png'),name:'image.png',mime:'image/png'}
  await call('sendMessage',session.id,'image admission',[image])
  result=await completed(session.id,seq)
  const owned=result.events.find(event=>event.type==='user_message'&&event.payload.attachments?.length)?.payload.attachments[0].path
  check('packaged image worker stores owned copy',owned?.startsWith(join(data,'grok-images'))&&owned!==image.path,owned)
  await screenshot('native-image')
  await call('sendMessage',session.id,'question')
  await waitFor(()=>dom('return document.querySelector(".question-form")?.textContent || ""'),text=>text.includes('Which scope?'),'question card')
  await click('.question-form label','Workspace')
  await click('.question-form button','提交回答')
  await waitFor(()=>state(session.id),value=>['idle','completed'].includes(value?.status),'question reply')
  const frames=String(await readFile(join(fixture,'frames.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  check('UI question sends native flat answer by question text',frames.some(row=>row.frame?.result?.outcome==='accepted'&&row.frame.result.answers?.['Which scope?']?.[0]==='Workspace'))
  await call('runNativeAction',session.id,{type:'goal.set',objective:'Packaged native Goal',tokenBudget:10000})
  await waitFor(()=>dom('return document.querySelector(".goal-status-bar")?.textContent || ""'),text=>text.includes('Goal'),'Goal status bar')
  await click('.goal-status-bar')
  await waitFor(()=>dom('return document.querySelector(".native-goal-controls")?.textContent || ""'),text=>text.includes('暂停'),'Goal controls')
  await call('forceSend',session.id,'Keep exact scope')
  check('active Goal steer reaches native turn',(await call('getEvents',session.id)).some(event=>event.type==='user_message'&&event.payload.appendedToTurn))
  await screenshot('native-goal')
  await click('.native-goal-controls button','暂停')
  await waitFor(()=>state(session.id),value=>value?.goal?.status==='paused','Goal paused')
  await click('.native-goal-controls button','清除 Goal')
  await waitFor(()=>state(session.id),value=>!value?.goal,'Goal cleared')
  check('Goal pause and clear UI complete',true)
  await call('sendMessage',session.id,'subagent')
  await waitFor(()=>call('getEvents',session.id),events=>events.some(event=>event.type==='subagent'),'child registered')
  const childItems=await call('getSubAgentItems',session.id,'session-child')
  check('owned child detail separates child messages',childItems.some(event=>event.payload.text==='Child inspecting')&&!(await call('getEvents',session.id)).some(event=>event.type==='reasoning'&&event.payload.text==='Child inspecting'))
  await waitFor(()=>dom('return !!document.querySelector(".sa-line")'),Boolean,'child entry')
  await click('.sa-line')
  await waitFor(()=>dom('return document.querySelector(".subagent-detail-stream")?.textContent || ""'),text=>text.includes('Child inspecting'),'child panel detail')
  check('child panel renders owned transcript',true)
  await screenshot('native-child')
  await click('[aria-label="取消子智能体"]')
  await waitFor(async()=>String(await readFile(join(fixture,'frames.jsonl'),'utf8')),text=>text.includes('"method":"_x.ai/subagent/cancel"'),'child cancel request')
  await click('[aria-label="关闭子智能体面板"]')
  await call('interrupt',session.id)
  await waitFor(()=>state(session.id),value=>!['running','cancelling'].includes(value?.status),'parent cancellation')
  check('Side is available on verified session',await call('sideCanOpen',session.id))
  await click('.session-side-toggle')
  await waitFor(()=>dom('return document.querySelector(".side-panel")?.textContent || ""'),text=>text.includes('侧边对话'),'Side panel')
  await call('sendSideMessage',session.id,'Side isolated turn')
  await waitFor(()=>call('getSideState',session.id),value=>value.status==='idle','Side completion')
  const sideEvents=await call('getSideEvents',session.id)
  check('Side runs independent turn',sideEvents.some(event=>event.type==='turn_completed'))
  await screenshot('native-side')
  const promoted=await call('promoteSideToSession',session.id)
  check('Side promotion has independent native identity',promoted.nativeSessionId&&promoted.nativeSessionId!==result.state.nativeSessionId)
  const inventory=(await call('capabilityInventoryList')).inventories.find(value=>value.agentId==='grok')
  check('native inventory is read-only',inventory&&inventory.managementSupported===false,inventory)
  await click('.settings-entry');await click('.set-nav-item','工具能力');await click('.cap-agent-card','Grok')
  await waitFor(()=>dom('return document.body.innerText'),text=>text.includes('fixture-plugin'),'Grok inventory panel')
  check('inventory panel renders native plugin listing',true)
  await screenshot('native-inventory')
  check('Plan and Review remain unavailable',result.state.agentContract.nativeReview===false&&!result.state.agentContract.collaborationModes.includes('plan'))
  await screenshot('native-final')
} catch(error){failure=error;console.error(error);if(ws?.readyState===1){await put(join(evidence,'failure-dom.txt'),await dom('return document.body.innerText').catch(()=>''));await screenshot('failure').catch(()=>{})}}
finally {
  await put(join(evidence,'app-stderr.txt'),stderr)
  await put(join(evidence,'acceptance.json'),JSON.stringify({checkedAt:new Date().toISOString(),appAsarSha256:sha256(await readFile(binary.replace('/MacOS/UniAgent Public','/Resources/app.asar'))),checks,error:failure?String(failure.stack||failure):null},null,2))
  await cleanup()
}
console.log('Evidence: '+evidence)
if(failure)process.exitCode=1
