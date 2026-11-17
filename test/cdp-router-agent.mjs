import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, symlink, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'
import { installMarkdownInputDriver } from './fixtures/markdown-input-driver.mjs'

const binary=resolve(process.argv[2]||'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.includes('/release/')&&binary.endsWith('/Contents/MacOS/UniAgent Public'))
const fixture=await mkdtemp(join(tmpdir(),'ua-router-packaged-')),data=join(fixture,'data'),home=join(fixture,'home'),workdir=join(fixture,'workspace')
const source=join(homedir(),'Library/Application Support/UniAgent'),output=resolve('docs/router-agent-review-2026-11-06/evaluation')
const sweeper=createAcceptanceProcessSweeper({termGraceMs:1500,killDeadlineMs:8000}),pending=new Map()
const report={startedAt:new Date().toISOString(),mode:'real-packaged-router-and-business-deepseek-with-isolated-data',checks:[],screenshots:[],errors:[]}
let child,ws,env,sequence=0,stderr=''
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(read,predicate,label,timeout=120000){const deadline=Date.now()+timeout;let value;while(Date.now()<deadline){value=await read();if(predicate(value))return value;await delay(150)}const summary=Array.isArray(value)?value.slice(-8).map(row=>({type:row.type,state:row.state,seq:row.seq})):value;throw Error(label+' timed out: '+JSON.stringify(summary).slice(0,2000))}
function check(label,value){assert.ok(value,label);report.checks.push(label);console.log('PASS '+label)}
function cdp(method,params={},timeout=120000){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value}
const call=(method,...args)=>evaluate('window.uniagent.'+method+'('+args.map(value=>JSON.stringify(value)).join(',')+')')
async function start(){
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve))
  child=spawn(binary,['--ua-e2e','--remote-debugging-port='+port,'--user-data-dir='+join(fixture,'chromium')],{env,detached:true,stdio:['ignore','ignore','pipe']});await sweeper.addRoot(child.pid)
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000)})
  const expected=binary.replace('/MacOS/UniAgent Public','/Resources/app.asar.unpacked/out/renderer/index.html')
  const targets=await wait(async()=>{try{return await fetch('http://127.0.0.1:'+port+'/json',{signal:AbortSignal.timeout(1000)}).then(value=>value.json())}catch{return []}},rows=>rows.some(row=>row.type==='page'&&decodeURIComponent(row.url).endsWith(expected)),'exact packaged renderer',40000)
  ws=new WebSocket(targets.find(row=>row.type==='page'&&decodeURIComponent(row.url).endsWith(expected)).webSocketDebuggerUrl)
  ws.onmessage=event=>{const message=JSON.parse(event.data),entry=pending.get(message.id);if(entry){pending.delete(message.id);message.error?entry.reject(Error(JSON.stringify(message.error))):entry.resolve(message.result)}}
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  await wait(()=>evaluate('!!window.uniagent&&!!document.querySelector(".sidebar")&&document.getElementById("ua-startup")?.hidden===true'),Boolean,'startup complete',60000)
  await evaluate('('+installMarkdownInputDriver.toString()+')()')
}
async function stop(){ws?.close();ws=undefined;await sweeper.sweep();child=undefined}
async function shot(name){await cdp('Page.enable');await cdp('Page.bringToFront');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},20000);await writeFile(join(output,name),Buffer.from(result.data,'base64'));report.screenshots.push(name)}
async function finished(id){return wait(()=>call('getEvents',id),events=>events.some(row=>row.type==='turn_completed'),'business turn '+id)}
async function conversationBounds(){return evaluate(`(()=>{const view=document.querySelector('.main > .session-view'),box=selector=>{const rect=view.querySelector(selector).getBoundingClientRect();return {left:rect.left,width:rect.width}};return {input:box('.composer-wrap'),message:box('.user-msg'),assignment:view.querySelector('.router-assignment')?box('.router-assignment'):undefined}})()`)}
try{
  for(const directory of [data,home,workdir,join(fixture,'tmp'),join(data,'credentials'),join(data,'deepseek')])await mkdir(directory,{recursive:true})
  await copyFile(join(source,'credentials/key'),join(data,'credentials/key'))
  for(const file of ['connection.json','active-runtime.json'])await copyFile(join(source,'deepseek',file),join(data,'deepseek',file))
  const runtime=JSON.parse(await readFile(join(data,'deepseek/active-runtime.json'),'utf8'));assert.match(runtime.directory,/^installed-[a-f0-9-]+$/)
  await symlink(join(source,'deepseek',runtime.directory),join(data,'deepseek',runtime.directory))
  try{const node=JSON.parse(await readFile(join(source,'deepseek/node-runtime.json'),'utf8'));await copyFile(join(source,'deepseek/node-runtime.json'),join(data,'deepseek/node-runtime.json'));await symlink(join(source,'deepseek',node.directory),join(data,'deepseek',node.directory))}catch(error){if(error.code!=='ENOENT')throw error}
  await writeFile(join(data,'app-settings.json'),JSON.stringify({schemaVersion:1,enabledAgentIds:['deepseek'],autoCheckUpdate:false,autoUpdateAgentsOnLaunch:false,autoUpdateAgentsWhenIdle:false,requirementsEnabled:true,spaceRequirementSidebar:true,taskTitleGeneration:{enabled:false}}))
  env={PATH:process.env.PATH,LANG:'en_US.UTF-8',SHELL:'/usr/bin/false',HOME:home,USERPROFILE:home,USER:'ua-router-test',LOGNAME:'ua-router-test',UNIAGENT_USER_DATA:data,CODEX_HOME:join(home,'.codex'),TRAE_HOME:join(home,'.trae'),CLAUDE_CONFIG_DIR:join(home,'.claude'),KIMI_HOME:join(home,'.kimi'),DSH_HOME:join(home,'.dsh'),TMPDIR:join(fixture,'tmp'),TMP:join(fixture,'tmp'),TEMP:join(fixture,'tmp'),XDG_CONFIG_HOME:join(fixture,'config'),XDG_DATA_HOME:join(fixture,'xdg-data'),XDG_CACHE_HOME:join(fixture,'cache'),XDG_STATE_HOME:join(fixture,'state'),GIT_CONFIG_GLOBAL:join(fixture,'gitconfig'),GIT_CONFIG_SYSTEM:'/dev/null',NPM_CONFIG_USERCONFIG:join(fixture,'npmrc'),NPM_CONFIG_CACHE:join(fixture,'npm-cache'),UNIAGENT_CAPABILITY_HOME:home,UNIAGENT_CAPABILITY_DATA:join(home,'.uniagent-capability-data'),UA_DISABLE_GPU:'1'}
  await start()
  const snapshot=await call('getRouterSnapshot');check('Router defaults off',snapshot.config.enabled===false)
  await evaluate('[...document.querySelectorAll("button")].find(row=>row.textContent.trim()==="RouterAgent").click()')
  await wait(()=>evaluate('document.body.innerText'),text=>text.includes('RouterAgent 尚未启用'),'disabled Router page')
  await shot('packaged-01-disabled.png')
  const agent=(await call('detectAgents')).find(row=>row.id==='deepseek');check('real Harness is available',agent?.lifecycle?.availability==='available')
  const model=JSON.stringify(['deepseek-official','deepseek-flash']);check('Flash Max exists in actual catalog',agent.models.some(row=>row.id===model&&row.efforts.includes('max')))
  await call('saveRouterConfig',{...snapshot.config,enabled:true,agentId:'deepseek',model,effort:'max'},snapshot.config.version)
  const routerSession=await call('openRouter');report.routerSessionId=routerSession.id
  await wait(()=>evaluate(`!!document.querySelector('[aria-label="配置 RouterAgent"]')`),Boolean,'Router config button')
  await evaluate(`document.querySelector('[aria-label="配置 RouterAgent"]').click()`)
  await wait(()=>evaluate('document.body.innerText'),text=>text.includes('自动生成任务标题')&&text.includes('路由模型'),'superAgent settings with title section')
  await shot('packaged-05-settings.png')
  await evaluate('[...document.querySelectorAll("button")].find(row=>row.textContent.trim()==="RouterAgent").click()')
  const space=await call('createProject',{name:'Router 隔离测试',primaryDirectory:workdir,additionalDirectories:[]})
  const execution={agentId:'deepseek',model,effort:'low',permissionMode:'read-only',projectId:space.id,workdir}
  const target=await call('createSession',execution,'这是图片漏显测试任务，只回复 ROUTER_TARGET_READY，不调用工具。')
  await finished(target.id);await call('renameSession',target.id,'图片漏显测试')
  const native=(await call('listSessions')).find(row=>row.id===target.id).nativeSessionId
  const input={requestId:randomUUID(),prompt:'继续图片漏显测试，沿用原任务，只回复 ROUTER_REUSED_OK，不调用工具。',scope:{kind:'space',projectId:space.id}}
  await call('submitRouterInput',input)
  let routed=await wait(()=>call('getRouterSnapshot'),value=>value.requests.find(row=>row.requestId===input.requestId)?.state==='bound','real reuse')
  check('real reuse binds original Task',routed.requests.find(row=>row.requestId===input.requestId).targetId===target.id)
  const targetEvents=await wait(()=>call('getEvents',target.id),events=>events.some(row=>row.type==='agent_message'&&row.payload.text?.includes('ROUTER_REUSED_OK')),'real routed reply')
  check('routed input reaches original conversation',targetEvents.some(row=>row.type==='user_message'&&row.payload.routedInputId===input.requestId))
  check('reuse keeps native identity',(await call('listSessions')).find(row=>row.id===target.id).nativeSessionId===native)
  const before=targetEvents.filter(row=>row.type==='user_message').length;await call('submitRouterInput',input);await delay(300)
  check('duplicate input returns original receipt',(await call('getEvents',target.id)).filter(row=>row.type==='user_message').length===before)
  await wait(()=>evaluate('document.querySelectorAll(".router-assignment").length'),value=>value>0,'real assignment UI')
  await shot('packaged-02-reused.png')
  const newInput={requestId:randomUUID(),prompt:'新建一个独立的天气组件测试任务，不复用图片漏显任务；只回复 ROUTER_CREATED_OK，不调用工具。',scope:{kind:'space',projectId:space.id},execution}
  await call('submitRouterInput',newInput)
  routed=await wait(()=>call('getRouterSnapshot'),value=>value.requests.find(row=>row.requestId===newInput.requestId)?.state==='bound','real new task')
  const created=routed.requests.find(row=>row.requestId===newInput.requestId)
  check('real new task has a distinct identity',created.targetId&&created.targetId!==target.id)
  await wait(()=>call('getEvents',created.targetId),events=>events.some(row=>row.type==='agent_message'&&row.payload.text?.includes('ROUTER_CREATED_OK')),'new task reply')
  await wait(()=>call('getEvents',routerSession.id),events=>events.filter(row=>row.type==='turn_completed').length>=2,'Router completed both requests')
  await shot('packaged-03-created.png')
  const conflictInput={requestId:randomUUID(),prompt:'继续图片漏显测试，复用原目标；本次明确选用 Max 思考强度。',scope:{kind:'space',projectId:space.id},execution:{...execution,effort:'max'}}
  await call('submitRouterInput',conflictInput)
  const conflictSnapshot=await wait(()=>call('getRouterSnapshot'),value=>value.requests.find(row=>row.requestId===conflictInput.requestId)?.state==='needs_input','configuration conflict')
  const conflict=conflictSnapshot.requests.find(row=>row.requestId===conflictInput.requestId)
  check('config conflict exposes original task choice',conflict.targetId===target.id&&conflict.decision.action==='reuse_task')
  await call('resolveRouterInput',{requestId:conflictInput.requestId,expectedVersion:conflict.version,action:'continue_original'})
  check('original execution config is retained',(await call('listSessions')).find(row=>row.id===target.id).config.effort==='low')
  await wait(()=>call('getEvents',routerSession.id),events=>events.filter(row=>row.type==='turn_completed').length>=3,'configuration Router turn finished')
  const requirementInput={requestId:randomUUID(),prompt:'这是全新的持续目标：在 Router 隔离测试空间中新建名为「音频组件验证」的需求，并创建独立任务；只回复 ROUTER_REQUIREMENT_OK，不调用工具。',scope:{kind:'space',projectId:space.id},execution}
  await call('submitRouterInput',requirementInput)
  const requirementSnapshot=await wait(()=>call('getRouterSnapshot'),value=>value.requests.find(row=>row.requestId===requirementInput.requestId)?.state==='bound','new requirement with task')
  const requirementTask=requirementSnapshot.requests.find(row=>row.requestId===requirementInput.requestId)
  const requirementSession=(await call('listSessions')).find(row=>row.id===requirementTask.targetId)
  check('new requirement and task are bound',requirementSession?.config.requirementId===requirementInput.requestId)
  await wait(()=>call('getEvents',requirementTask.targetId),events=>events.some(row=>row.type==='agent_message'&&row.payload.text?.includes('ROUTER_REQUIREMENT_OK')),'new requirement task reply')
  await wait(()=>call('listSessions'),rows=>['idle','completed'].includes(rows.find(row=>row.id===target.id)?.status),'original task idle')
  await call('sendMessage',target.id,'只调用 bash 工具以前台方式执行 sleep 20，工具超时设为 60000 毫秒，等待命令完成后回复 BUSY_PROBE_DONE；不要启动后台任务。')
  await wait(()=>call('getEvents',target.id),events=>events.some(row=>row.type==='command_exec'&&row.state==='running'&&row.payload.command?.includes('sleep 20')),'real running business turn')
  const busyInput={requestId:randomUUID(),prompt:'继续图片漏显测试，等原任务当前操作结束后只回复 ROUTER_BUSY_QUEUE_OK，不调用工具。',scope:{kind:'space',projectId:space.id}}
  await call('submitRouterInput',busyInput)
  const busySnapshot=await wait(()=>call('getRouterSnapshot'),value=>value.requests.find(row=>row.requestId===busyInput.requestId)?.state==='bound','busy task routing')
  check('busy task input joins original queue',busySnapshot.requests.find(row=>row.requestId===busyInput.requestId)?.delivery==='queued')
  check('queued input waits for the original turn',!(await call('getEvents',target.id)).some(row=>row.type==='user_message'&&row.payload.routedInputId===busyInput.requestId))
  await wait(()=>call('getEvents',target.id),events=>events.some(row=>row.type==='agent_message'&&row.payload.text?.includes('ROUTER_BUSY_QUEUE_OK')),'queued input executes after original turn')
  check('removed global memory API is absent',(await evaluate('typeof window.uniagent.globalMemory'))==='undefined')
  const projectMemoryPage=await call('projectMemory',space.id,{action:'read'})
  check('project memory remains available on demand',Array.isArray(projectMemoryPage.items))
  const count=(await call('listSessions')).length;await stop();await start()
  const restored=await call('openRouter');check('Router fixed Session survives real restart',restored.id===routerSession.id)
  check('restart creates no duplicate Session',(await call('listSessions')).length===count)
  check('persistent receipts survive restart',(await call('getRouterSnapshot')).requests.some(row=>row.requestId===newInput.requestId&&row.targetId===created.targetId))
  await evaluate('[...document.querySelectorAll("button")].find(row=>row.textContent.trim()==="RouterAgent").click()')
  await wait(()=>evaluate('document.querySelectorAll(".router-assignment").length'),value=>value>=2,'restored assignment cards')
  await shot('packaged-04-restored.png')
  const routerBounds=await conversationBounds()
  await evaluate(`document.querySelector('[data-router-conversation] .router-assignment footer button').click()`)
  await wait(()=>evaluate(`!!document.querySelector('.main > .session-view:not([data-router-conversation]) .composer-wrap')`),Boolean,'original conversation layout')
  const originalBounds=await conversationBounds()
  report.layout={router:routerBounds,ordinary:originalBounds}
  console.log(JSON.stringify(report.layout))
  check('Router input and messages match ordinary conversation margins',Math.abs(routerBounds.input.left-originalBounds.input.left)<1&&Math.abs(routerBounds.input.width-originalBounds.input.width)<1&&Math.abs(routerBounds.message.left-originalBounds.message.left)<1&&Math.abs(routerBounds.message.width-originalBounds.message.width)<1)
  check('assignment card stays in the ordinary message column',Math.abs(routerBounds.assignment.left-originalBounds.message.left)<1&&Math.abs(routerBounds.assignment.width-originalBounds.message.width)<1)
  await evaluate('[...document.querySelectorAll("button")].find(row=>row.textContent.trim()==="RouterAgent").click()')
  await wait(()=>evaluate('document.querySelectorAll(".router-assignment").length'),value=>value>0,'Router conversation restored')
  const beforeUi=(await call('getRouterSnapshot')).requests.length
  await evaluate('document.querySelector("[aria-label=\\"新建任务\\"]").click()')
  await delay(300)
  await evaluate('document.querySelector(".new-task .project-picker-trigger").click()')
  await wait(()=>evaluate('document.querySelector(".new-task .scope-picker-auto")?.disabled===false'),Boolean,'new task routing option')
  await evaluate('document.querySelector(".new-task .scope-picker-auto").click();window.__markdownInput.fill(".new-task .prompt-input","继续图片漏显测试，沿用已有目标，只回复 ROUTER_UI_INPUT_OK，不调用工具。");')
  await wait(()=>evaluate('window.__markdownInput.text(".new-task .prompt-input")'),text=>text.includes('ROUTER_UI_INPUT_OK'),'new task text remains after mounting')
  await wait(()=>evaluate('!!document.querySelector(".new-task .btn-send:not(:disabled)")'),Boolean,'new task submit button')
  await evaluate('document.querySelector(".new-task .btn-send").click()')
  const uiSnapshot=await wait(()=>call('getRouterSnapshot'),value=>value.requests.length>beforeUi&&value.requests.at(-1)?.state!=='queued'&&value.requests.at(-1)?.state!=='routing','new task UI routes input')
  check('new task UI registers Router input',uiSnapshot.requests.at(-1).prompt.includes('ROUTER_UI_INPUT_OK'))
  await wait(()=>evaluate('!!document.querySelector("[data-router-conversation]")'),Boolean,'automatic routing opens fixed conversation')
  report.appAsarSha256=createHash('sha256').update(await readFile(binary.replace('/MacOS/UniAgent Public','/Resources/app.asar'))).digest('hex')
}catch(error){report.errors.push(String(error));console.error(String(error));process.exitCode=1}
finally{await stop();report.completedAt=new Date().toISOString();report.passed=report.errors.length===0;await mkdir(output,{recursive:true});await writeFile(join(output,'packaged-results.json'),JSON.stringify(report,null,2));await rm(fixture,{recursive:true,force:true})}
