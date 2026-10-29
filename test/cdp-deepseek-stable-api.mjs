// Run the installed official Harness and real API through an isolated packaged App.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile, symlink, rm, access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHash, randomInt } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/') && binary.endsWith('/Contents/MacOS/UniAgent Public'))
const fixture = await mkdtemp(join(tmpdir(), 'ua-dsh-packaged-'))
const data = join(fixture, 'data'), home = join(fixture, 'home'), workdir = join(fixture, 'workspace')
const sourceData = process.env.UA_DSH_SOURCE_DATA || join(homedir(), 'Library/Application Support/UniAgent')
// Match the managed active pointer; installation time is not version ordering.
const resolveSourceRuntime = () => {
 const root = join(sourceData, 'deepseek')
 const pointer = join(root, 'active-runtime.json')
 if (existsSync(pointer)) {
   const active = JSON.parse(readFileSync(pointer, 'utf8'))
   assert.equal(active.schemaVersion, 1)
   assert.match(active.directory, /^(?:installed-[a-f0-9-]+|runtime(?:-[0-9A-Za-z.+-]+)?)$/)
   return join(root, active.directory)
 }
 const installed = existsSync(root) ? readdirSync(root).filter(name => /^runtime-.+/.test(name)) : []
 installed.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
 return join(root, installed[0] || 'runtime-0.2.1-rc.2')
}
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let ws, child, stderr = '', serial = 0, env
const pending = new Map()
const checks = []
const evidence=resolve('.uniagent-artifacts','deepseek-stable-api-'+new Date().toISOString().replace(/[:.]/g,'-'))
const delay = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(read, predicate, label, timeout = 90000) {
  const start = Date.now(); let value
  while (Date.now() - start < timeout) { value = await read(); if (predicate(value)) return value; await delay(250) }
  throw new Error(label + ' timed out: ' + JSON.stringify(value))
}
function check(label, value, detail) { assert.ok(value, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks.push(label); console.log('✓ ' + label) }
function cdp(method, params = {}, timeout = 60000) {
  return new Promise((resolveRequest, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeout)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveRequest(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression, timeout) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout)
  if (result.error || result.result?.exceptionDetails) throw new Error(result.result?.exceptionDetails?.exception?.description || JSON.stringify(result.error))
  return result.result.result.value
}
const call = (method, ...args) => evaluate('window.uniagent.' + method + '(' + args.map(a => JSON.stringify(a)).join(',') + ')')
const current = id => call('listSessions').then(s => s.find(x => x.id === id))
const terminal = s => s && ['idle','completed','error','cancelled','interrupted'].includes(s.status)
async function waitTurn(id, label) {
  const state = await waitFor(() => current(id), terminal, label)
  const events = await call('getEvents', id)
  assert.notEqual(state.status, 'error', label + ': ' + JSON.stringify(events.filter(e => e.type === 'error')))
  return { state, events }
}
async function openSession(id) {
  const selector = '.session-item[data-session-id=' + JSON.stringify(id) + ']'
  await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), Boolean, 'session sidebar row')
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function pasteImage(selector, code) {
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.placeholder.includes('可粘贴图片')`), Boolean, 'image-enabled input')
  await evaluate(`(async()=>{
    const canvas=document.createElement('canvas'); canvas.width=600; canvas.height=180;
    const context=canvas.getContext('2d'); context.fillStyle='white'; context.fillRect(0,0,600,180);
    context.fillStyle='black'; context.font='bold 88px monospace'; context.fillText(${JSON.stringify(code)},110,120);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const clipboard=new DataTransfer(); clipboard.items.add(new File([blob],'vision-test.png',{type:'image/png'}));
    document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:clipboard}));
  })()`)
  await waitFor(() => evaluate(`!![...document.querySelectorAll('.attach-thumb img')].find(i=>i.complete&&i.naturalWidth>0)`), Boolean, 'real pasted image preview')
}
async function typePrompt(selector, prompt) {
  await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
}
async function verifyImageInputs(agent) {
  const prompt='只回复这张图片中的六位数字，不调用工具。'
  const firstCode=String(randomInt(100000,1000000))
  await pasteImage('.new-task textarea',firstCode)
  check('new-task image paste creates a decoded preview',true)
  await typePrompt('.new-task textarea',prompt)
  const before=new Set((await call('listSessions')).map(s=>s.id))
  await waitFor(() => evaluate(`!document.querySelector('.new-task-send-btn')?.disabled`),Boolean,'new image task ready')
  await evaluate(`document.querySelector('.new-task-send-btn').click()`)
  const sessions=await waitFor(() => call('listSessions'), rows=>rows.some(s=>!before.has(s.id)),'image session creation')
  const session=sessions.find(s=>!before.has(s.id))
  const first=await waitTurn(session.id,'new-task real image recognition')
  check('new-task UI sends image bytes and real model reads unpredictable digits',first.events.findLast(e=>e.type==='agent_message')?.payload.text.includes(firstCode))
  await openSession(session.id)
  let nextCode
  do { nextCode=String(randomInt(100000,1000000)) } while(nextCode===firstCode)
  await pasteImage('.composer-input',nextCode)
  check('existing-session image paste creates a decoded preview',true)
  await typePrompt('.composer-input',prompt)
  const completed=first.events.filter(e=>e.type==='turn_completed').length
  await waitFor(() => evaluate(`!document.querySelector('.composer-send-btn')?.disabled`),Boolean,'image continuation ready')
  await evaluate(`document.querySelector('.composer-send-btn').click()`)
  await waitFor(() => call('getEvents',session.id), events=>events.filter(e=>e.type==='turn_completed').length>completed,'image continuation completion')
  const second=await waitTurn(session.id,'continuation real image recognition')
  check('continuation UI sends the new image and model reads different digits',second.events.findLast(e=>e.type==='agent_message')?.payload.text.includes(nextCode))
  await verifyUsageUI(session.id,second.events,'image-input')
  const textModel=agent.models.find(model=>JSON.parse(model.id)[1]==='deepseek-v4-pro')
  assert.ok(textModel,'qualified Harness exposes its text-only Pro route')
  const attachments=second.events.findLast(e=>e.type==='user_message')?.payload.attachments
  assert.ok(attachments?.some(a=>a.kind==='image'))
  const rejected=await call('createSession',{agentId:'deepseek',model:textModel.id,effort:'off',permissionMode:'full-access',workdir},prompt,attachments)
  const rejectedState=await waitFor(()=>current(rejected.id),terminal,'text-only image rejection')
  const rejectedEvents=await call('getEvents',rejected.id)
  check('real Host rejects text-only model images with actionable guidance',rejectedState.status==='error'&&rejectedEvents.some(e=>e.type==='error'&&e.payload.message?.includes('模型不支持图片输入')))
  await call('deleteSession',rejected.id)
  return session.id
}
async function verifyUsageUI(id, events, label) {
  const usage = events.filter(e => e.type === 'system_notice' && e.payload.kind === 'usage')
  assert.ok(usage.length, 'real provider must report usage')
  assert.equal(new Set(usage.map(e => JSON.stringify([e.payload.turnId,e.payload.id]))).size, usage.length,
    'main-process snapshot must not retain intermediate usage settlements')
  await openSession(id)
  const expected = usage.map(e => e.payload.usage)
  await waitFor(() => evaluate(`[...document.querySelectorAll('.usage-line')].map(e=>e.textContent)`),
    lines => lines.length === expected.length && lines.every((line,i) => line.includes(expected[i].inputTokens.toLocaleString('en-US'))), label + ' visible usage')
  const tables = await evaluate(`(async()=>{
    document.querySelectorAll('.card.usage:not(.open) .usage-line').forEach(e=>e.click());
    await new Promise(r=>setTimeout(r,100));
    return [...document.querySelectorAll('.usage-table')].map(t=>[...t.querySelectorAll('tbody tr')].map(r=>[...r.querySelectorAll('td')].slice(0,3).map(c=>c.textContent)));
  })()`)
  let input=0, output=0, cached=0
  assert.deepEqual(tables, expected.map(u => {
    input+=u.inputTokens; output+=u.outputTokens; cached+=u.cachedInputTokens
    const fmt=(n,cache=false)=>cache&&!n?'—':n.toLocaleString('en-US')
    return [[fmt(u.inputTokens),fmt(u.outputTokens),fmt(u.cachedInputTokens,true)], [fmt(input),fmt(output),fmt(cached,true)]]
  }), label + ' actual expanded DOM totals')
  check(label + ': one usage card per turn and exact session totals', true)
  await writeFile(join(evidence,label+'-usage.json'),JSON.stringify(tables,null,2))
  const screenshot=await cdp('Page.captureScreenshot',{format:'png'})
  await writeFile(join(evidence,label+'.png'),Buffer.from(screenshot.result.data,'base64'))
}
async function approvalFor(id) {
  return waitFor(() => call('getEvents', id), evs => evs.some(e => e.type === 'approval_request' && e.state === 'pending'), 'tool approval')
    .then(evs => evs.findLast(e => e.type === 'approval_request' && e.state === 'pending'))
}
async function answerApproval(id, approval, kind) {
  const option = approval.payload.options.find(o => o.kind === kind)
  assert.ok(option)
  await call('respondRequest', id, approval.payload.requestId, { outcome: { outcome: 'selected', optionId: option.optionId } })
}
async function startApp() {
  const portServer = createServer()
  await new Promise(r => portServer.listen(0, '127.0.0.1', r))
  const port = portServer.address().port
  await new Promise(r => portServer.close(r))
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], { env, detached:true, stdio:['ignore','ignore','pipe'] })
  await sweeper.addRoot(child.pid)
  child.on('error', error => console.error('spawn error', error))
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000) })
  const expected = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
  const targets = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error('packaged App exited during startup')
    try { return await fetch('http://127.0.0.1:' + port + '/json', { signal:AbortSignal.timeout(1500) }).then(r => r.json()) } catch { return [] }
  }, ts => ts.some(t => t.type === 'page' && decodeURIComponent(t.url).endsWith(expected)), 'packaged renderer', 40000)
  const target = targets.find(t => t.type === 'page' && decodeURIComponent(t.url).endsWith(expected))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id) } }
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('CDP disconnected')); pending.clear() }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  await waitFor(async () => {
    try { return await call('getLifecycleSnapshot') }
    catch (error) { if (/Execution context was destroyed|Cannot find context/.test(String(error))) return null; throw error }
  }, Boolean, 'preload and startup')
}
async function stopApp() { ws?.close(); ws = undefined; await sweeper.sweep(); child = undefined }
let cleanupPromise
const cleanup = () => cleanupPromise ||= (async () => { await stopApp(); await rm(fixture, { recursive:true, force:true, maxRetries:5 }) })()
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })

try {
 for (const name of ['tmp','chromium','config','xdg-data','cache','state','runtime','npm-cache']) await mkdir(join(fixture,name),{recursive:true})
 for (const path of [data,workdir,evidence,join(home,'Library'),join(data,'deepseek')]) await mkdir(path,{recursive:true})
 await mkdir(join(data,'credentials'),{mode:0o700})
 await writeFile(join(data,'credentials/key'),await readFile(join(sourceData,'credentials/key')),{mode:0o600})
 const source=JSON.parse(await readFile(join(sourceData,'deepseek/connection.json'),'utf8'))
 assert.equal(source.baseUrl,'https://api.deepseek.com/anthropic','only the official model service may receive the existing credential')
 assert.ok(source.encryptedKey,'UniAgent-owned DeepSeek credential required')
 await writeFile(join(data,'deepseek/connection.json'),JSON.stringify(source),{mode:0o600})
 const sourceRuntime=resolveSourceRuntime()
 const runtime=join(data,'deepseek',basename(sourceRuntime)); await mkdir(runtime,{recursive:true})
 await symlink(join(sourceRuntime,'node_modules'),join(runtime,'node_modules'))
 await writeFile(join(data,'deepseek/active-runtime.json'),JSON.stringify({schemaVersion:1,directory:basename(runtime)}))
 await writeFile(join(data,'app-settings.json'),JSON.stringify({schemaVersion:1,autoUpdateAgentsOnLaunch:false,autoUpdateAgentsWhenIdle:false,autoCheckUpdate:false,enabledAgentIds:['deepseek']}))
 await writeFile(join(fixture,'gitconfig'),''); await writeFile(join(fixture,'npmrc'),'')
 env={PATH:process.env.PATH,LANG:'en_US.UTF-8',SHELL:'/usr/bin/false',HOME:home,USERPROFILE:home,USER:'ua-dsh-test',LOGNAME:'ua-dsh-test',UNIAGENT_USER_DATA:data,CODEX_HOME:join(home,'.codex'),TRAE_HOME:join(home,'.trae'),CLAUDE_CONFIG_DIR:join(home,'.claude'),KIMI_CODE_HOME:join(home,'.kimi-code'),GROK_HOME:join(home,'.grok'),DSH_HOME:join(home,'.dsh'),TMPDIR:join(fixture,'tmp'),TMP:join(fixture,'tmp'),TEMP:join(fixture,'tmp'),XDG_CONFIG_HOME:join(fixture,'config'),XDG_DATA_HOME:join(fixture,'xdg-data'),XDG_CACHE_HOME:join(fixture,'cache'),XDG_STATE_HOME:join(fixture,'state'),XDG_RUNTIME_DIR:join(fixture,'runtime'),GIT_CONFIG_GLOBAL:join(fixture,'gitconfig'),GIT_CONFIG_SYSTEM:'/dev/null',NPM_CONFIG_USERCONFIG:join(fixture,'npmrc'),NPM_CONFIG_CACHE:join(fixture,'npm-cache'),UNIAGENT_CAPABILITY_HOME:home,UNIAGENT_CAPABILITY_DATA:join(home,'.uniagent-capability-data'),UA_DISABLE_GPU:'1'}
 await startApp()
 const agent=(await call('detectAgents')).find(x=>x.id==='deepseek')
 check('official Harness available through Host API',agent.installed&&!agent.incompatible&&!agent.authenticationRequired&&agent.capabilities.protocol==='web')
 const snapshot=await call('getDeepSeekConnection')
 check('owned credential reused without disclosure',snapshot.hasKey&&snapshot.source==='harness'&&!('apiKey' in snapshot))
 const model=agent.models.find(x=>x.id.includes('flash'))
 assert.ok(model)
 const imageSessionId=await verifyImageInputs(agent)
 const session=await call('createSession',{agentId:'deepseek',model:model.id,effort:'off',permissionMode:'full-access',workdir},'只回复 UNIAGENT_STABLE_API_OK，不调用工具。')
 let result=await waitTurn(session.id,'real API first turn'),nativeId=result.state.nativeSessionId
 check('real DeepSeek API response completes',result.events.some(e=>e.type==='agent_message'&&e.payload.text?.includes('UNIAGENT_STABLE_API_OK')))
 check('exact native identity saved',!!nativeId)
 await verifyUsageUI(session.id,result.events,'first-turn')
 const proof=join(workdir,'proof.txt'); await writeFile(proof,'UA_REAL_API_READ_9216')
 await call('sendMessage',session.id,`调用 read 工具读取 ${proof}，然后原样回复文件内容。`)
 result=await waitTurn(session.id,'real API file read')
 check('real tool reads isolated file',result.events.some(e=>['tool_call','command_exec'].includes(e.type)&&JSON.stringify(e.payload).includes('UA_REAL_API_READ_9216')))
 check('real model uses tool result',result.events.findLast(e=>e.type==='agent_message')?.payload.text.includes('UA_REAL_API_READ_9216'))
 await verifyUsageUI(session.id,result.events,'multi-step-live')
 await stopApp(); await startApp()
 const imageRestored=await call('getEvents',imageSessionId)
 await verifyUsageUI(imageSessionId,imageRestored,'image-restored')
 check('image attachments survive a cold restart',imageRestored.filter(e=>e.type==='user_message'&&e.payload.attachments?.some(a=>a.kind==='image')).length===2)
 await waitFor(() => evaluate(`[...document.querySelectorAll('.bubble-attachments img')].filter(i=>i.complete&&i.naturalWidth>0).length`),n=>n===2,'restored image pixels')
 check('restored image bubbles load their actual pixels',true)
 await verifyUsageUI(session.id,await call('getEvents',session.id),'cold-restored')
 await call('sendMessage',session.id,'只回复 UNIAGENT_STABLE_RESUME_OK，不调用工具。')
 result=await waitTurn(session.id,'real API cold resume')
 check('real API resumes exact native session',result.state.nativeSessionId===nativeId&&result.events.findLast(e=>e.type==='agent_message')?.payload.text.includes('UNIAGENT_STABLE_RESUME_OK'))
 await verifyUsageUI(session.id,result.events,'cold-resumed')
 const histories=await call('listAgentHistory','deepseek')
 check('Host history lists the persisted native session',histories.some(row=>row.id===nativeId))
 const forked=await call('forkSameSession','deepseek',nativeId,workdir)
 check('native fork creates a separate writable session',forked?.nativeSessionId&&forked.nativeSessionId!==nativeId&&!forked.readOnly)
 await call('sendMessage',forked.id,'只根据上下文原样回复之前 proof.txt 的内容，不调用工具。')
 const forkResult=await waitTurn(forked.id,'real native fork context')
 check('fork continues with original tool-result context',forkResult.events.findLast(e=>e.type==='agent_message')?.payload.text.includes('UA_REAL_API_READ_9216'))
 check('fork does not replace the source native identity',(await current(session.id)).nativeSessionId===nativeId)
 await call('deleteSession',forked.id)
 await call('saveDeepSeekConnection',{baseUrl:snapshot.baseUrl,apiKey:'invalid-uniagent-acceptance-key'})
 const stored=await readFile(join(data,'deepseek/connection.json'),'utf8')
 check('dedicated key encrypted and hidden',!stored.includes('invalid-uniagent-acceptance-key')&&!('apiKey' in await call('getDeepSeekConnection')))
 const bad=await call('createSession',{agentId:'deepseek',model:model.id,effort:'off',permissionMode:'ask',workdir},'只回复 AUTH_TEST。')
 const badState=await waitFor(()=>current(bad.id),terminal,'real invalid credential')
 const badEvents=await call('getEvents',bad.id)
 check('real invalid key produces actionable error',badState.status==='error'&&badEvents.some(e=>e.type==='error'&&e.payload.authRequired), {
   status:badState.status,events:badEvents.filter(e=>e.type==='error'||e.type==='turn_completed').map(e=>({type:e.type,state:e.state,message:e.payload.message,authRequired:e.payload.authRequired,reason:e.payload.reason?.kind,code:e.payload.reason?.error?.code}))
 })
 await writeFile(join(data,'deepseek/connection.json'),JSON.stringify(source),{mode:0o600})
 await call('detectAgents')
 await call('sendMessage',bad.id,'只回复 UNIAGENT_AUTH_RECOVERED_OK，不调用工具。')
 const recovered=await waitTurn(bad.id,'real credential recovery')
 const recoveryEvidence={
   failed:{status:badState.status,nativeSessionId:badState.nativeSessionId},
   recovered:{status:recovered.state.status,nativeSessionId:recovered.state.nativeSessionId},
   lastMessage:recovered.events.findLast(e=>e.type==='agent_message')?.payload.text,
   events:recovered.events.map(e=>({seq:e.seq,type:e.type,state:e.state}))
 }
 await writeFile(join(evidence,'credential-recovery.json'),JSON.stringify(recoveryEvidence,null,2))
 check('real credential recovery keeps native identity',recovered.state.nativeSessionId===badState.nativeSessionId&&recovered.events.findLast(e=>e.type==='agent_message')?.payload.text.includes('UNIAGENT_AUTH_RECOVERED_OK'),recoveryEvidence)
 await call('deleteSession',session.id)
 check('local transcript deletion succeeds',!(await call('listSessions')).some(x=>x.id===session.id))
 await assert.rejects(access(join(data,'deepseek/events',session.id+'.jsonl')))
 await writeFile(join(evidence,'acceptance.json'),JSON.stringify({checkedAt:new Date().toISOString(),appAsarSha256:createHash('sha256').update(await readFile(binary.replace('/MacOS/UniAgent Public','/Resources/app.asar'))).digest('hex'),version:agent.version,model:model.id,checks},null,2))
 console.log('DeepSeek stable real API acceptance passed: '+checks.length+' checks; evidence: '+evidence)
} catch(error) { console.error(error); await writeFile(join(evidence,'error.txt'),String(error.stack||error)); process.exitCode=1 }
finally { await cleanup() }
