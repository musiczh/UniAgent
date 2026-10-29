// Real installed CLIs, loopback model responses, and the current packaged renderer.
// Usage: node test/cdp-beta-agent-capabilities.mjs [release/.../Contents/MacOS/UniAgent Public]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import TOML from '@iarna/toml'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(binary.startsWith(resolve('release') + '/') && binary.endsWith('/Contents/MacOS/UniAgent Public'), 'only repository release App is allowed')
const renderer = binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar.unpacked/out/renderer/index.html')
const fixture = await mkdtemp(join(tmpdir(), 'ua-beta-packaged-'))
const home = join(fixture, 'home'), data = join(fixture, 'data'), workdir = join(fixture, 'workspace')
const evidence = resolve('.uniagent-artifacts', 'beta-packaged-' + new Date().toISOString().replace(/[:.]/g, '-'))
const readMarker = 'UA_BETA_FILE_READ_7182'
const inputFile = join(workdir, 'read-proof.txt')
const agentIds = ['deepseek', 'kimi', 'grok']
const checks = [], models = new Map(), sessions = new Map()
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1500, killDeadlineMs: 8000 })
let child, ws, serial = 0, stderr = '', cleanupPromise, forceCleanup = false, appEnv
let coldHistory
const pending = new Map()
const delay = ms => new Promise(done => setTimeout(done, ms))
const sha256 = value => createHash('sha256').update(value).digest('hex')
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
async function waitTurn(id, marker, afterSeq = -1) {
  const result = await waitFor(async () => ({ state: (await call('listSessions')).find(session => session.id === id), events: await call('getEvents', id) }), result => {
    const latest = result.events.filter(event => event.seq > afterSeq)
    if (result.state?.status === 'error' || latest.some(event => event.type === 'error')) throw new Error(marker + ' failed: ' + JSON.stringify(latest.filter(event => event.type === 'error')))
    return ['idle', 'completed'].includes(result.state?.status) && latest.some(event => event.type === 'turn_completed' && event.state === 'success') && latest.some(event => event.type === 'agent_message' && event.payload.text?.includes(marker))
  }, marker)
  await put(join(evidence, id + '-events.json'), JSON.stringify(result, null, 2))
  return result
}

function toolResponse(agentId) {
  const name = { deepseek: 'read', kimi: 'Read', grok: 'read_file' }[agentId]
  const args = agentId === 'grok' ? { target_file: inputFile } : agentId === 'kimi' ? { path: inputFile } : { file_path: inputFile }
  return { name, args }
}
function openaiSSE(model, value, finish) {
  return 'data: ' + JSON.stringify({ id: 'ua-beta-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n'
}
function anthropicSSE(model, tool, text) {
  const frames = [
    { type: 'message_start', message: { id: 'ua-beta-fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'ua-beta-read', name: tool.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } },
    { type: 'message_stop' }
  ]
  return frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join('')
}
async function startModel(agentId) {
  const capture = { requests: [], mainRequests: [], goalRequests: [], readIssued: false, error: null }
  const goalReleases = new Map()
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      if (!Array.isArray(body.messages)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'ua-beta-local', object: 'model', context_window: 200000 }] }))
        return
      }
      const main = JSON.stringify(body.messages).includes('UA_BETA_INITIAL_' + agentId)
      const row = { path: req.url, body, main }
      capture.requests.push(row)
      if (main) capture.mainRequests.push(row)
      const goal = agentId === 'deepseek' && JSON.stringify(body.messages).includes('UA_BETA_GOAL')
      if (goal) {
        capture.goalRequests.push(row)
        await new Promise((done, reject) => {
          const index = capture.goalRequests.length
          const timeout = setTimeout(() => { goalReleases.delete(index); reject(new Error('Goal fixture response was not released')) }, 45000)
          goalReleases.set(index, () => { clearTimeout(timeout); goalReleases.delete(index); done() })
        })
      }
      const fork = JSON.stringify(body.messages).includes('UA_BETA_FORK_' + agentId)
      const side = JSON.stringify(body.messages).includes('UA_BETA_SIDE_' + agentId)
      const tool = main && !fork && !capture.readIssued ? toolResponse(agentId) : undefined
      if (tool) capture.readIssued = true
      const text = goal ? 'UA_BETA_GOAL_ROUND_OK' : side ? 'UA_BETA_SIDE_OK_' + agentId : main ? (fork ? 'UA_BETA_FORK_OK_' : 'UA_BETA_DONE_') + agentId : 'fixture background summary'
      const response = agentId === 'deepseek' ? anthropicSSE(body.model, tool, text) : openaiSSE(body.model,
        tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ua-beta-read', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: text }, tool ? 'tool_calls' : 'stop')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(response)
    } catch (error) {
      capture.error = String(error)
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture failed' } }))
    }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  const model = { server, capture, baseUrl: 'http://127.0.0.1:' + port, releaseGoal: index => { const release = goalReleases.get(index); assert.ok(release, 'Goal response is not waiting: ' + index); release() }, releaseAllGoals: () => { for (const release of [...goalReleases.values()]) release() } }
  models.set(agentId, model)
  return model
}
function systemText(body) {
  return JSON.stringify(body.system || body.messages.filter(message => message.role === 'system'))
}
function tools(body, agentId) {
  return (body.tools || []).map(tool => agentId === 'deepseek' ? tool.name : tool.function.name).sort()
}
async function nativeLogBytes(directory) {
  const files = (await readdir(directory, { recursive:true })).filter(file => /\.jsonl(?:\.zstd)?$/.test(file)).sort()
  return Object.fromEntries(await Promise.all(files.map(async file => [file, (await readFile(join(directory, file))).toString('base64')])))
}

// Seed through the installed SDK's public Session and Attachment APIs. No CLI
// replacement, bridge override, or mocked IPC participates in packaged reads.
async function prepareColdHistory(runtime) {
  const localId = 'beta-cold-native-owner'
  const nativeHome = join(data, 'deepseek/home')
  const resolveSDK = createRequire(join(runtime, 'package.json'))
  const sdk = name => import(pathToFileURL(resolveSDK.resolve(name)).href)
  const [{ Context }, { Session, SESSION_FORMAT_VERSION }, { default: Persistence }, { LocalAttachmentStore }, llm, {default:sharp}] = await Promise.all([
    sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-session'), sdk('@deepseek-ai/dsh-session-persistence-jsonl'),
    sdk('@deepseek-ai/dsh-attachment-local'), sdk('@deepseek-ai/dsh-llm'), sdk('sharp')
  ])
  const context = new Context()
  const storage = await context.plugin(Persistence, { root:join(nativeHome, 'sessions') })
  const attachments = await context.plugin(LocalAttachmentStore, { dshHome:nativeHome })
  const imageBytes = await sharp({create:{width:2,height:2,channels:4,background:{r:25,g:90,b:190,alpha:1}}}).png().toBuffer()
  const references = []
  const headers = []
  async function seed(id, parentSession, content) {
    const header = { id, version:SESSION_FORMAT_VERSION, createdAt:Date.now(), cwd:workdir, isSeeded:false,
      ...(parentSession ? { parentSession, origin:'subagent' } : {}) }
    const session = Session.create(id, [], header)
    if (content) {
      const image = await context.attachments.saveImage({ data:imageBytes, mediaType:'image/png' })
      const stored = await context.attachments.readImage(image)
      const expectedImage = 'data:' + stored.ref.mediaType + ';base64,' + Buffer.from(stored.data).toString('base64')
      session.append('turn/start', { turn:1 })
      session.append('step/start', { turn:1, step:1 })
      session.append('request/header', { header:{ config:{ provider:'deepseek-official', model:'deepseek-flash', reasoningEffort:'off' } }, reason:'initial' })
      session.append('user/message', llm.createUserMessage({ id:id + '-prompt', source:{kind:'user'}, content:[{type:'text',text:content + ' input'}] }), {surfaceOp:'append'})
      const assistant = session.append('assistant/message', { turn:1, step:1, message:llm.createAssistantMessage({
        source:{provider:'deepseek-official',model:'deepseek-flash'}, content:[{type:'reasoning',text:content + ' thought'},{type:'text',text:content + ' answer'},{type:'image',attachment:image},{type:'tool-call',id:id + '-read',name:'read',arguments:'{}'}]
      }), stream:[] }, {surfaceOp:'append'})
      const call = session.append('tool/call', {turn:1,step:1,callId:id + '-read',name:'read',arguments:'{}'})
      const result = session.append('tool/result', {turn:1,step:1,message:llm.createToolResultMessage({callId:id + '-read',isError:false,content:[{type:'text',text:content + ' tool output'},{type:'image',attachment:image}]}),meta:{packagedCold:true}}, {surfaceOp:'append',sourceEventSeqs:[call.seq]})
      session.append('step/end',{turn:1,step:1})
      session.append('turn/end',{turn:1,reason:{kind:'completed'}})
      references.push({id,assistantSeq:assistant.seq,resultSeq:result.seq,expectedImage})
    }
    const handle = await context.sessionPersistence.create(session.header)
    try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
    headers.push({session:session.header,events:session.snapshotEvents()})
    return session
  }
  try {
    const parent = await seed('beta-native-parent', undefined, 'UA_BETA_COLD_PARENT_PRIVATE')
    await seed('beta-native-middle', parent.id)
    await seed('beta-native-leaf', 'beta-native-middle', 'UA_BETA_COLD_CHILD')
    await seed('beta-foreign-parent')
    await seed('beta-foreign-leaf', 'beta-foreign-parent', 'UA_BETA_FOREIGN_CHILD')
    const roster = [
      {agentThreadId:'beta-native-leaf',parentThreadId:parent.id,name:'Cold native child',status:'completed',prompt:'UA_BETA_COLD_CHILD'},
      // Listed locally on purpose: native ancestry must still reject this child.
      {agentThreadId:'beta-foreign-leaf',parentThreadId:parent.id,name:'Foreign child',status:'completed'}
    ]
    await put(join(data, 'sessions.json'), JSON.stringify([{id:localId,title:'Beta cold native history',config:{agentId:'deepseek',model:JSON.stringify(['deepseek-official','deepseek-flash']),effort:'off',permissionMode:'full-access',workdir},status:'idle',createdAt:Date.now(),nativeSessionId:parent.id,origin:'created',subagents:roster}]))
    // The existing App cache is projected from SDK-persisted native events. The
    // roster event is the App's durable display record for the seeded delegation.
    const rootRequire = createRequire(import.meta.url)
    const { build } = createRequire(rootRequire.resolve('electron-vite'))('esbuild')
    const projectionModule = join(fixture, 'native-projection.mjs')
    await build({entryPoints:[resolve('src/main/deepseekEventProjection.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:projectionModule})
    const { normalizeDeepSeekHistory } = await import(pathToFileURL(projectionModule).href)
    const parentSnapshot = headers.find(item => item.session.id === parent.id)
    const events = normalizeDeepSeekHistory(parentSnapshot).events.map(event => ({...event,sessionId:localId}))
    events.splice(events.findIndex(event=>event.type === 'user_message')+1,0,{sessionId:localId,seq:0,ts:Date.now(),type:'subagent',state:'success',payload:{id:'beta-cold-roster',agents:[roster[0]]}})
    await put(join(data,'deepseek/events',localId + '.jsonl'), events.map((event,seq)=>JSON.stringify({...event,seq})).join('\n')+'\n')
    coldHistory = {localId,nativeHome,parentId:parent.id,references,headers,before:await nativeLogBytes(join(nativeHome,'sessions'))}
    await put(join(evidence,'cold-native-sdk-seed.json'), JSON.stringify({headers,references,beforeSha256:Object.fromEntries(Object.entries(coldHistory.before).map(([file,bytes])=>[file,sha256(Buffer.from(bytes,'base64'))]))},null,2))
  } finally { await attachments.dispose(); await storage.dispose() }
}
async function prepare() {
  await chmod(fixture, 0o700)
  for (const directory of [home, data, workdir, evidence, join(home, 'Library'), ...['tmp', 'chromium', 'config', 'xdg-data', 'cache', 'state', 'runtime', 'npm-cache'].map(name => join(fixture, name))]) await mkdir(directory, { recursive: true, mode: 0o700 })
  await put(join(data, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, autoCheckUpdate: false, enabledAgentIds: ['codex', 'traex', 'claude', ...agentIds] }))
  await put(inputFile, readMarker + '\n')
  for (const name of ['alpha', 'beta']) await put(join(workdir, '.agents/skills', 'ua-beta-' + name, 'SKILL.md'), `---\nname: ua-beta-${name}\ndescription: UA_BETA_SKILL_${name.toUpperCase()}\n---\n${name} fixture\n`)
  // The managed runtime is no longer pinned: resolve the newest installed runtime-<version> dir.
  const sourceRuntime = process.env.UNIAGENT_DEEPSEEK_TEST_RUNTIME || (() => {
    const root = join(homedir(), 'Library/Application Support/UniAgent/deepseek')
    const installed = existsSync(root) ? readdirSync(root).filter((name) => /^runtime-.+/.test(name)) : []
    installed.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
    return join(root, installed[0] || 'runtime-0.2.1-rc.2')
  })()
  const runtime = join(data, 'deepseek', basename(sourceRuntime))
  await access(join(sourceRuntime, 'node_modules/.bin/dsh'))
  await mkdir(runtime, { recursive: true })
  await symlink(await realpath(join(sourceRuntime, 'node_modules')), join(runtime, 'node_modules'), 'dir')
  await prepareColdHistory(runtime)
  const bundle = join(fixture, 'plugin-bundle'), packageManager = join(fixture, 'package-fixture.cjs')
  const metadata = { name: 'ua-beta-plugin-fixture', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } }
  await put(join(bundle, 'package.json'), JSON.stringify(metadata))
  await put(join(bundle, 'ua-beta-plugin.mjs'), 'export function apply() {}\n')
  await put(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'ua-beta-plugin-fixture-row', name: './ua-beta-plugin.mjs' }] }]))
  // The installed official native manager owns lifecycle/profile mutation. This fixture isolates registry and package I/O only.
  await put(packageManager, `#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),root=${JSON.stringify(join(data, 'deepseek/home/profiles/acp'))};if(fs.realpathSync(process.cwd())!==fs.realpathSync(root))throw new Error('unexpected package fixture cwd');fs.appendFileSync(${JSON.stringify(join(evidence, 'native-package-operations.jsonl'))},JSON.stringify({args,cwd:process.cwd()})+'\\n');if(args[0]==='config'){console.log('https://registry.npmjs.org/');process.exit(0)}if(args[0]==='view'){console.log(${JSON.stringify(JSON.stringify(metadata))});process.exit(0)}if(!['add','remove'].includes(args[0])||!args[1]?.startsWith('ua-beta-plugin-fixture'))throw new Error('unexpected package fixture operation');const file=path.join(root,'package.json'),manifest=JSON.parse(fs.readFileSync(file));if(args[0]==='add'){manifest.dependencies={...manifest.dependencies,'ua-beta-plugin-fixture':'1.0.0'};const target=path.join(root,'node_modules','ua-beta-plugin-fixture');fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(${JSON.stringify(bundle)},target,{recursive:true});}else{delete manifest.dependencies['ua-beta-plugin-fixture'];fs.rmSync(path.join(root,'node_modules','ua-beta-plugin-fixture'),{recursive:true,force:true})}fs.writeFileSync(file,JSON.stringify(manifest));fs.writeFileSync(path.join(root,'pnpm-lock.yaml'),'fixture lock');console.log('package fixture completed');\n`)
  await chmod(packageManager, 0o755)
  await put(join(data, 'deepseek/home/profiles/acp/cordis.patch.yml'), JSON.stringify([{ id: 'plugin-manager', config: { pnpmCommand: packageManager, inspectTimeoutMs: 1500, lockWaitMs: 1500, idleTimeoutMs: 1500, fallbackRegistries: [] } }]))
  await put(join(fixture, 'grok-plugin/.grok-plugin/plugin.json'), JSON.stringify({ name: 'ua-beta-grok-plugin', version: '1.0.0' }))
  await put(join(fixture, 'grok-plugin/skills/ua-beta-plugin-skill/SKILL.md'), '---\nname: ua-beta-plugin-skill\ndescription: Native plugin acceptance fixture\n---\nUA_BETA_GROK_PLUGIN_SKILL\n')
  for (const id of agentIds) await startModel(id)
  await put(join(home, '.kimi-code/config.toml'), TOML.stringify({ default_model: 'ua-beta-local', telemetry: false, watch: { enabled: false }, models: { 'ua-beta-local': { provider:'ua-beta-loopback', name:'ua-beta-local', max_context_size:200000 } }, providers: { 'ua-beta-loopback': { type:'openai', base_url:models.get('kimi').baseUrl + '/v1', api_key:'fixture-kimi-key' } } }))
  await put(join(home, '.grok/config.toml'), TOML.stringify({ cli: { use_leader: false }, features: { managed_config: false }, managed_mcps: { enabled: false }, models: { default: 'ua-beta-local' }, model: { 'ua-beta-local': { model: 'ua-beta-local', base_url: models.get('grok').baseUrl + '/v1', api_key: 'fixture-grok-key', api_backend: 'chat_completions', agent_type: 'grok-build', max_retries: 0, context_window: 200000 } } }))
  await put(join(fixture, 'gitconfig'), '')
  await put(join(fixture, 'npmrc'), '')
}
async function startApp() {
  const portServer = createPortServer()
  await new Promise(done => portServer.listen(0, '127.0.0.1', done))
  const port = portServer.address().port
  await new Promise(done => portServer.close(done))
  const env = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false', HOME: home, USERPROFILE: home, USER: 'ua-beta-test', LOGNAME: 'ua-beta-test',
    UNIAGENT_USER_DATA: data, CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_CODE_HOME: join(home, '.kimi-code'), KIMI_HOME: join(home, '.kimi'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
    DEEPSEEK_API_KEY: 'fixture-deepseek-key', DEEPSEEK_BASE_URL: models.get('deepseek').baseUrl + '/anthropic', XAI_API_KEY: 'fixture-grok-key', GROK_SUBAGENTS: '0', DSH_TELEMETRY_MODE: 'DISABLED',
    TMPDIR: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), TEMP: join(fixture, 'tmp'), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'xdg-data'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), XDG_RUNTIME_DIR: join(fixture, 'runtime'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'), UA_DISABLE_GPU: '1'
  }
  appEnv = env
  child = spawn(binary, ['--ua-e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + join(fixture, 'chromium')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
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
async function verifyUI(agents) {
  await click('.settings-entry')
  await click('.set-nav-item', '工具能力')
  await waitFor(() => dom('return [...document.querySelectorAll(".capability-tabs .a-nm")].map(node => node.textContent.trim())'), names => names.length === 6, 'six Agent cards')
  const names = await dom('return [...document.querySelectorAll(".capability-tabs .a-nm")].map(node => node.textContent.trim())')
  check('six real Agent capability cards', ['Codex', 'TraeX', 'Claude Code', 'Kimi Code', 'Grok', 'DeepSeek'].every(name => names.includes(name)), names)
  await screenshot('actual-capabilities')
  await click('.set-nav-item', '角色')
  await click('.set-add-btn', '添加角色')
  const choices = await dom(`return [...document.querySelector('select[aria-label="角色 Agent"]').options].map(option => option.value)`)
  check('role editor offers all six Agents', ['codex', 'traex', 'claude', 'kimi', 'grok', 'deepseek'].every(id => choices.includes(id)), choices)
  for (const id of agentIds) {
    await select('角色 Agent', id)
    await delay(100)
    const state = await dom(`const skills = document.querySelector('select[aria-label="角色 Skills 策略"]'); const policy = document.querySelector('select[aria-label="角色工具策略"]'); return {skills:[...skills.options].map(option => ({value:option.value,disabled:option.disabled})), tools:[...policy.options].map(option => ({value:option.value,disabled:option.disabled})), text:document.querySelector('.settings-scroll')?.innerText || document.body.innerText};`)
    const disabled = state.skills.filter(option => option.value !== 'all').every(option => option.disabled)
    check(id + ' Skills controls match support', id === 'deepseek' ? !state.skills.some(option => option.disabled) : disabled && state.text.includes('仅支持全部'), state.skills)
    check(id + ' role native tool policy controls enabled', state.tools.every(option => !option.disabled), state.tools)
    if (id === 'deepseek') {
      const efforts = await dom(`return [...document.querySelector('select[aria-label="角色推理深度"]').options].map(option => option.value)`)
      check('DeepSeek role exposes off effort', efforts.includes('off'), efforts)
    }
    if (id === 'kimi') {
      await select('角色模型', agents.find(agent => agent.id === id).models.find(model => model.id === 'ua-beta-local').id)
      const thinking = await dom(`const node = document.querySelector('select[aria-label="角色思考级别"]'); return {exists:!!node,values:[...node.options].map(option=>option.value)}`)
      const native = agents.find(agent => agent.id === id).models.find(model => model.id === 'ua-beta-local').thinkingOptions || []
      check('Kimi role thinking options use native model catalog', thinking.exists && native.every(value => thinking.values.includes(value)), { thinking, native })
    }
    await screenshot('actual-role-' + id)
  }
}
async function verifyColdHistory() {
  const {localId,parentId,references,nativeHome,before} = coldHistory
  const state = (await call('listSessions')).find(session => session.id === localId)
  check('DeepSeek packaged cold restore loads owned parent and durable child roster', state?.nativeSessionId === parentId && state.subagents?.some(child=>child.agentThreadId === 'beta-native-leaf' && child.status === 'completed'), state)
  const initialModelCount = models.get('deepseek').capture.requests.length
  const child = references.find(reference=>reference.id === 'beta-native-leaf')
  const items = await call('getSubAgentItems',localId,child.id)
  check('DeepSeek cold child transcript comes from persisted native descendant only', items.length > 0 && items.every(event=>event.sessionId === localId) && items.some(event=>event.payload.text === 'UA_BETA_COLD_CHILD answer') && items.some(event=>event.payload.text === 'UA_BETA_COLD_CHILD thought') && !JSON.stringify(items).includes('UA_BETA_COLD_PARENT_PRIVATE'), items)
  check('DeepSeek cold child retains successful real SDK tool result and metadata', items.some(event=>event.type === 'tool_call' && event.state === 'success' && event.payload.id === child.id + '-read' && event.payload.meta?.packagedCold === true && JSON.stringify(event.payload.result).includes('UA_BETA_COLD_CHILD tool output')), items)
  const selectors = [
    {childSessionId:child.id,eventSeq:child.assistantSeq,blockIndex:2},
    {childSessionId:child.id,eventSeq:child.resultSeq,blockIndex:1,toolResult:true}
  ]
  const imageSelectors = items.flatMap(event=>[
    ...(event.payload.result?.nativeImage ? [event.payload.result.nativeImage] : []),
    ...(Array.isArray(event.payload.nativeImages) ? event.payload.nativeImages : [])
  ])
  check('DeepSeek cold child assistant/toolResult image selectors retain exact native provenance', isDeepStrictEqual(imageSelectors,selectors), imageSelectors)
  const missing = await call('getSubAgentItems',localId,'unlisted-native-child')
  const foreign = await call('getSubAgentItems',localId,'beta-foreign-leaf')
  const foreignReference = references.find(reference=>reference.id === 'beta-foreign-leaf')
  const foreignImage = await call('fsReadNativeImage',localId,{childSessionId:foreignReference.id,eventSeq:foreignReference.assistantSeq,blockIndex:2})
  check('DeepSeek packaged child reads reject both unlisted ID and roster entry with foreign native ancestry', missing.length === 0 && foreign.length === 0 && foreignImage === null, {missing,foreign,foreignImage})
  for (const selector of selectors) {
    const image = await call('fsReadNativeImage',localId,selector)
    check('DeepSeek packaged IPC returns SDK-verified cold child ' + (selector.toolResult?'toolResult':'assistant') + ' image bytes', image === child.expectedImage)
  }
  const parent = references.find(reference=>reference.id === parentId)
  for (const selector of [{eventSeq:parent.assistantSeq,blockIndex:2},{eventSeq:parent.resultSeq,blockIndex:1,toolResult:true}]) {
    check('DeepSeek packaged IPC reads only recorded parent ' + (selector.toolResult?'toolResult':'assistant') + ' image selector', await call('fsReadNativeImage',localId,selector) === parent.expectedImage)
  }
  check('DeepSeek packaged IPC rejects unrecorded image block', await call('fsReadNativeImage',localId,{eventSeq:parent.assistantSeq,blockIndex:99}) === null)
  await click('[data-session-id="' + localId + '"]')
  async function preview(scope,name,expectedImage) {
    // Only assistant images keep a standalone card; a tool-returned image previews
    // inside its own call row and is covered by the deepseek-native-image unit test.
    const images = await waitFor(()=>dom(`return [...document.querySelectorAll(${JSON.stringify(scope + ' .generated-image-preview img')})].map(image=>({src:image.src,ready:image.complete&&image.naturalWidth>0}));`),images=>images.length===1&&images.every(image=>image.ready&&image.src===expectedImage),name+' actual native image card')
    check(name + ' actual assistant image preview loads',images.length===1&&images.every(image=>image.ready&&image.src===expectedImage),images)
    await dom(`document.querySelector(${JSON.stringify(scope+' .generated-image-preview')}).click(); return true;`)
    const lightbox = await waitFor(()=>dom('const image=document.querySelector(".bubble-image-preview img");return image?{src:image.src,ready:image.complete&&image.naturalWidth>0}:null;'),image=>image?.ready&&image.src===expectedImage,name+' image lightbox')
    check(name+' assistant image opens actual shared lightbox',lightbox.src===expectedImage&&lightbox.ready,lightbox)
    await screenshot('actual-cold-'+name+'-image-assistant')
    await click('.bubble-image-preview-close')
    await waitFor(()=>dom('return !document.querySelector(".bubble-image-preview")'),Boolean,'image lightbox closes')
  }
  await preview('.main > .session-view','parent',parent.expectedImage)
  await dom('const fold=document.querySelector(".main > .session-view .processed-fold.closed .processed-head"); fold?.click(); return true;')
  await waitFor(()=>dom('return !!document.querySelector(".main > .session-view .sa-line")'),Boolean,'persisted child opens from actual parent event')
  await click('.main > .session-view .sa-line')
  await waitFor(()=>dom('return document.querySelector(".subagent-detail-stream")?.textContent || ""'),text=>text.includes('UA_BETA_COLD_CHILD answer'),'actual cold child detail')
  await preview('.subagent-detail-stream','child',child.expectedImage)
  await click('.subagent-panel .close-x')
  await waitFor(()=>dom('return !document.querySelector(".subagent-panel")'),Boolean,'cold child drawer closes')
  const after = await nativeLogBytes(join(nativeHome,'sessions'))
  await put(join(evidence,'cold-native-log-bytes.json'),JSON.stringify({before,after},null,2))
  check('DeepSeek packaged cold reads and image previews leave all native logs byte-for-byte unchanged',JSON.stringify(after)===JSON.stringify(before),{before:Object.keys(before),after:Object.keys(after)})
  check('DeepSeek cold child/image reads never invoke model or prompt a turn',models.get('deepseek').capture.requests.length===initialModelCount)
  await put(join(evidence,'cold-native-packaged-items.json'),JSON.stringify({state,items,selectors,foreign,afterSha256:Object.fromEntries(Object.entries(after).map(([file,bytes])=>[file,sha256(Buffer.from(bytes,'base64'))]))},null,2))
}
const inventoryFor = async agentId => (await call('capabilityInventoryList')).inventories.find(inventory => inventory.agentId === agentId)
async function capabilityAgent(agentId) {
  const names = { deepseek: 'DeepSeek', kimi: 'Kimi Code', grok: 'Grok' }
  await click('.capability-tabs .cap-agent-card', names[agentId])
  await waitFor(() => dom('return [...document.querySelectorAll(".capability-tabs .cap-agent-card")].find(node=>node.getAttribute("aria-pressed")==="true")?.textContent'), text => text?.includes(names[agentId]), agentId + ' capability selection')
  await waitFor(() => dom('const card=document.querySelector(".capability-tabs .cap-agent-card[aria-pressed=true]"); return document.querySelector(".capability-center .settings-redetect")?.disabled === false && card && !card.textContent.includes("等待扫描");'),Boolean,agentId+' native capability scan ready')
}
async function capabilityRow(name) {
  const selector = '.capability-row[aria-label=' + JSON.stringify('查看 ' + name + ' 详情') + ']'
  await waitFor(() => dom('return !!document.querySelector(' + JSON.stringify(selector) + ')'), Boolean, name + ' capability row')
  await click(selector)
  await waitFor(() => dom('return document.querySelector(".cap-detail [data-capability-state], .cap-detail [data-capability-edit]")?.disabled === false'), Boolean, name + ' native detail ready')
}
async function capabilityCreate(kind, name, text) {
  await waitFor(() => dom('return document.querySelector(' + JSON.stringify('[data-capability-create="' + kind + '"]') + ')?.disabled === false'), Boolean, name + ' native create ready')
  await click('[data-capability-create="' + kind + '"]')
  await input('[data-capability-name]', name)
  if (text !== undefined) await input('[data-capability-config]', text)
  await screenshot('actual-capability-form-' + name)
  await click('[data-capability-save]')
  await waitFor(() => dom('return {open:!!document.querySelector("#capability-management-form"),error:document.querySelector("#capability-management-form [role=alert]")?.textContent}'), state => { if(state.error) throw new Error(name + ': ' + state.error); return !state.open }, name + ' native create')
}
async function capabilityState(agentId, name, enabled) {
  await waitFor(() => dom('return document.querySelector("[data-capability-state]")?.textContent'), text => text?.trim() === (enabled ? '启用' : '停用'), name + ' current state button')
  await click('[data-capability-state]')
  await waitFor(() => dom('return document.querySelector("[data-capability-state]")?.textContent'), text => text?.trim() === (enabled ? '停用' : '启用'), name + ' changed state button')
  const inventory = await inventoryFor(agentId), item = inventory.items.find(item => item.name === name)
  check(agentId + ' ' + name + ' ' + (enabled ? 'enable' : 'disable') + ' survives fresh native scan', item && /disabled/.test(item.source || '') !== enabled, item)
  await screenshot('actual-capability-' + name + '-' + (enabled ? 'enabled' : 'disabled'))
  return item
}
async function capabilityRemove(agentId, name) {
  await click('.cap-detail-uninstall')
  await waitFor(() => dom('return !!document.querySelector(".cap-confirm-actions .cap-confirm-danger")'), Boolean, name + ' removal confirmation')
  await click('.cap-confirm-actions .cap-confirm-danger')
  await waitFor(() => dom('return {open:!!document.querySelector(".cap-confirm-overlay"),error:document.querySelector(".cap-confirm-error, .capability-center .cap-sync-error")?.textContent}'), state => { if(state.error) throw new Error(name + ': ' + state.error); return !state.open }, name + ' removal confirmation accepted')
  // Native plugin confirmation closes before its asynchronous CLI mutation. The
  // successful uninstall closes its detail only after that mutation resolves.
  await waitFor(() => dom('return {open:!!document.querySelector(".cap-detail"),error:document.querySelector(".cap-confirm-error, .capability-center .cap-sync-error")?.textContent}'), state => { if(state.error) throw new Error(name + ': ' + state.error); return !state.open }, name + ' native removal completes')
  const inventory = await inventoryFor(agentId)
  check(agentId + ' ' + name + ' removal survives fresh native scan', !inventory.items.some(item => item.name === name), inventory.items.filter(item => item.name === name))
}
async function verifyManagement(agents) {
  await click('.set-nav-item', '工具能力')
  await capabilityAgent('kimi')
  const skillName = 'ua-beta-managed-skill', skillText = body => `---\nname: ${skillName}\ndescription: Native management acceptance\n---\n${body}\n`
  await capabilityCreate('skill', skillName, skillText('UA_BETA_SKILL_CREATE'))
  let current = await inventoryFor('kimi'), item = current.items.find(item => item.name === skillName)
  check('Kimi new Skill is native user-manageable after fresh scan', item?.manageable && item.owner === 'user' && item.scope === 'agent', item)
  const initialSkillFingerprint = item.fingerprint
  await capabilityRow(skillName)
  await click('[data-capability-edit]')
  await input('[data-capability-config]', skillText('UA_BETA_SKILL_EDIT'))
  await click('[data-capability-save]')
  await waitFor(() => dom('return !document.querySelector("#capability-management-form")'), Boolean, 'Kimi Skill edited')
  current = await inventoryFor('kimi'); item = current.items.find(item => item.name === skillName)
  check('Kimi edited Skill content persists and returns fresh fingerprint', item.fingerprint !== initialSkillFingerprint && (await call('capabilityInventoryDetail', item.id)).manifestText.includes('UA_BETA_SKILL_EDIT'))
  await capabilityRow(skillName)
  await capabilityRemove('kimi', skillName)
  for (const agentId of ['kimi', 'grok']) {
    await capabilityAgent(agentId)
    const name = 'ua-beta-managed-mcp-' + agentId
    await capabilityCreate('mcp', name, JSON.stringify({ transport: 'stdio', command: '/usr/bin/false', args: [], env: { UA_FIXTURE_KEY: 'fixture-mcp-only' } }, null, 2))
    let inventory = await inventoryFor(agentId), original = inventory.items.find(item => item.name === name)
    check(agentId + ' MCP create is native user-manageable', original?.manageable, original)
    await capabilityRow(name)
    const before = JSON.parse((await call('capabilityInventoryDetail', original.id)).manifestText)
    await click('[data-capability-edit]')
    await input('[data-capability-config]', JSON.stringify({ ...before, command: '/usr/bin/true' }, null, 2))
    await click('[data-capability-save]')
    await waitFor(() => dom('return !document.querySelector("#capability-management-form")'), Boolean, agentId + ' MCP update')
    inventory = await inventoryFor(agentId)
    const updated = inventory.items.find(item => item.name === name)
    check(agentId + ' MCP edit returns updated native fingerprint', updated?.fingerprint !== original.fingerprint, updated)
    await assert.rejects(call('capabilityInventoryManage', { agentId, action: 'mcp-disable', id: original.id, expectedFingerprint: original.fingerprint }), /capability_inventory_stale/)
    check(agentId + ' stale MCP fingerprint rejects mutation', true)
    await capabilityRow(name)
    await capabilityState(agentId, name, false)
    await capabilityState(agentId, name, true)
    await capabilityRemove(agentId, name)
    const file = agentId === 'kimi' ? join(home, '.kimi-code/mcp.json') : join(home, '.grok/config.toml')
    check(agentId + ' native MCP removal is persisted on disk', !(await readFile(file, 'utf8')).includes(name))
  }
  // Local source is setup for the real CLI registry; the public UI accepts repository sources only.
  const grok = agents.find(agent => agent.id === 'grok')
  await new Promise((done, reject) => {
    let output = ''
    const installer = spawn(grok.bin, ['plugin', 'install', join(fixture, 'grok-plugin'), '--trust'], { cwd: workdir, env: appEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => reject(new Error('native Grok local plugin fixture install timed out')), 45000)
    installer.stdout.on('data', chunk => { output += chunk }); installer.stderr.on('data', chunk => { output += chunk })
    installer.on('error', error => { clearTimeout(timeout); reject(error) })
    installer.on('close', async code => { clearTimeout(timeout); await put(join(evidence, 'grok-plugin-install.txt'), output); code === 0 ? done() : reject(new Error('native Grok local plugin fixture install failed: ' + output)) })
    sweeper.addRoot(installer.pid).catch(reject)
  })
  await click('.capability-center .settings-redetect')
  await waitFor(() => dom('return document.querySelector(".capability-center .settings-redetect")?.disabled === false'), Boolean, 'Grok native plugin rescan')
  await capabilityRow('ua-beta-grok-plugin')
  let grokInventory = await inventoryFor('grok'), grokPlugin = grokInventory.items.find(item => item.name === 'ua-beta-grok-plugin')
  check('Grok actual local plugin install produces native manageable inventory', grokPlugin?.manageable, grokPlugin)
  await capabilityState('grok', grokPlugin.name, false)
  await capabilityState('grok', grokPlugin.name, true)
  await capabilityRemove('grok', grokPlugin.name)
  await capabilityAgent('deepseek')
  await capabilityCreate('plugin', 'ua-beta-plugin-fixture')
  let inventory = await inventoryFor('deepseek'), plugin = inventory.items.find(item => item.name === 'ua-beta-plugin.mjs')
  check('DeepSeek official plugin install is manageable after fresh runtime', plugin?.manageable && /enabled/.test(plugin.source || ''), plugin)
  const protectedEntry = inventory.items.find(item => item.name === 'deepseekBridgePlugin.mjs')
  assert.ok(protectedEntry, 'DeepSeek required bridge listed')
  await assert.rejects(call('capabilityInventoryManage', { agentId: 'deepseek', action: 'plugin-disable', id: protectedEntry.id, expectedFingerprint: protectedEntry.fingerprint }), /capability_inventory_read_only/)
  check('DeepSeek native management protects UniAgent bridge', true)
  await capabilityRow(plugin.name)
  plugin = await capabilityState('deepseek', plugin.name, false)
  await capabilityState('deepseek', plugin.name, true)
  await capabilityRemove('deepseek', plugin.name)
  const manifest = JSON.parse(await readFile(join(data, 'deepseek/home/profiles/acp/package.json'), 'utf8'))
  check('DeepSeek official plugin removal persists dependency and bundle lifecycle', !manifest.dependencies?.['ua-beta-plugin-fixture'] && !manifest.dsh?.profile?.bundles?.includes('ua-beta-plugin-fixture'), manifest)
  await put(join(evidence, 'managed-capabilities-final.json'), JSON.stringify(await call('capabilityInventoryList'), null, 2))
}
async function verifyAgent(agent) {
  const id = agent.id, capture = models.get(id).capture
  const selected = id === 'deepseek' ? agent.models.find(model => model.id.includes('deepseek-flash')) : agent.models.find(model => model.id === 'ua-beta-local')
  assert.ok(selected, id + ' fixture model available: ' + JSON.stringify(agent.models))
  const role = { id: 'beta-role-' + id, name: 'Beta role ' + id, agentId: id, model: selected.id, permissionMode: 'full-access', instructions: 'UA_BETA_ROLE_' + id + ' literal $HOME {{unbound}}', toolPolicy: { mode: 'allow-only', tools: id === 'deepseek' ? ['read','skill'] : [toolResponse(id).name] }, ...(id === 'deepseek' ? { skills: ['ua-beta-alpha'], effort: 'off' } : {}) }
  const saved = (await call('saveRole', role)).find(entry => entry.role.id === role.id)
  check(id + ' native role is executable in catalog', saved?.executable, saved)
  if (id !== 'deepseek') {
    for (const skills of [[], ['ua-beta-alpha']]) await assert.rejects(call('saveRole', { ...role, id: role.id + '-invalid', skills }), /role_skills_unsupported|Skills|技能/)
    check(id + ' backend rejects both unsupported Skills strategies', true)
  }
  const session = await call('createSession', { agentId: id, model: role.model, effort: role.effort, permissionMode: role.permissionMode, workdir, roleSnapshot: role }, 'UA_BETA_INITIAL_' + id + ': read the fixture once, then finish.')
  sessions.set(id, session.id)
  const first = await waitTurn(session.id, 'UA_BETA_DONE_' + id)
  check(id + ' installed CLI emits native session identity', !!first.state.nativeSessionId, first.state)
  check(id + ' real native Read executes successfully', first.events.some(event => ['tool_call', 'command_exec'].includes(event.type) && event.state === 'success' && JSON.stringify(event.payload).includes(readMarker)), first.events.filter(event => ['tool_call', 'command_exec'].includes(event.type)))
  assert.ok(capture.mainRequests.length >= 2, id + ' native tool round trip did not reach model')
  const initialRequest = capture.mainRequests[0].body
  check(id + ' literal role instructions enter native system prompt', systemText(initialRequest).includes(role.instructions), systemText(initialRequest))
  if (id === 'deepseek') {
    const context = JSON.stringify({system:initialRequest.system,messages:initialRequest.messages})
    check('DeepSeek role exposes only selected Skill in model context',context.includes('ua-beta-alpha') && !context.includes('ua-beta-beta'),context)
  }
  check(id + ' native model tool list obeys exact allow-only policy', JSON.stringify(tools(initialRequest, id)) === JSON.stringify(role.toolPolicy.tools), tools(initialRequest, id))
  check(id + ' model receives actual Read result', capture.mainRequests.some(request => JSON.stringify(request.body.messages).includes(readMarker)))
  await assert.rejects(call('updateSessionConfig', session.id, { permissionMode: 'ask' }), /role_session_config_locked|role.*locked|角色/)
  check(id + ' role execution config remains immutable', true)
  if (id === 'deepseek') {
    const history = await call('listAgentHistory', id)
    check('DeepSeek native history lists real turn', history.some(row => row.id === first.state.nativeSessionId), history)
    const preview = await call('previewHistory', id, first.state.nativeSessionId, workdir)
    check('DeepSeek native preview keeps user, response and tool', preview.events.some(event => event.type === 'user_message' && event.payload.text?.includes('UA_BETA_INITIAL_' + id)) && preview.events.some(event => event.type === 'agent_message' && event.payload.text?.includes('UA_BETA_DONE_' + id)) && preview.events.some(event => ['tool_call', 'command_exec'].includes(event.type) && JSON.stringify(event.payload).includes(readMarker)), preview)
    await call('setCollaborationMode', session.id, 'plan')
    check('DeepSeek native Plan commits without a model turn', (await call('listSessions')).find(row => row.id === session.id).config.collaborationMode === 'plan')
  }
  const fork = await call('forkSameSession', id, first.state.nativeSessionId, workdir)
  check(id + ' official fork produces independent writable identity', fork?.nativeSessionId && fork.nativeSessionId !== first.state.nativeSessionId && fork.id !== session.id && fork.readOnly === false && fork.forkedFrom?.nativeId === first.state.nativeSessionId, fork)
  check(id + ' native fork retains role snapshot and permission', JSON.stringify(fork.config.roleSnapshot) === JSON.stringify(role) && fork.config.permissionMode === role.permissionMode, fork.config)
  if (id === 'deepseek') await call('setCollaborationMode', fork.id, 'plan')
  const before = await call('getEvents', fork.id)
  const beforeSeq = Math.max(-1, ...before.map(event => event.seq))
  const requestCount = capture.mainRequests.length
  await call('sendMessage', fork.id, 'UA_BETA_FORK_' + id + ': finish this independent fork.')
  const followup = await waitTurn(fork.id, 'UA_BETA_FORK_OK_' + id, beforeSeq)
  const forkRequest = capture.mainRequests.slice(requestCount).find(request => request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('UA_BETA_FORK_' + id)))?.body
  assert.ok(forkRequest, id + ' fork did not reach actual CLI model')
  check(id + ' resumed fork keeps complete native context', JSON.stringify(forkRequest.messages).includes('UA_BETA_INITIAL_' + id) && JSON.stringify(forkRequest.messages).includes(readMarker), forkRequest.messages)
  check(id + ' fork runtime retains literal role and native tool restrictions', systemText(forkRequest).includes(role.instructions) && JSON.stringify(tools(forkRequest, id)) === JSON.stringify(role.toolPolicy.tools), { system: systemText(forkRequest), tools: tools(forkRequest, id) })
  if (id === 'deepseek') check('DeepSeek native Plan reaches resumed fork model context', /plan mode|planning mode|plan-mode/i.test(systemText(forkRequest) + JSON.stringify(forkRequest.messages)), systemText(forkRequest))
  const source = await call('getEvents', session.id)
  check(id + ' fork writes stay separate from source transcript', !source.some(event => event.type === 'user_message' && event.payload.text?.includes('UA_BETA_FORK_' + id)))
  check(id + ' completed fork retains original native identity', followup.state.nativeSessionId === fork.nativeSessionId)
}
async function verifySide(agent) {
  const id = agent.id, sessionId = sessions.get(id), capture = models.get(id).capture
  const source = (await call('listSessions')).find(session => session.id === sessionId)
  check(id + ' native Side capability and readiness', agent.capabilities.sideChat === true && await call('sideCanOpen', sessionId))
  await click('[data-session-id="' + sessionId + '"]')
  await waitFor(() => dom('return !!document.querySelector(".session-side-toggle")'), Boolean, id + ' Side entry')
  await click('.session-side-toggle')
  await waitFor(() => dom('return document.querySelector(".side-panel")?.getAttribute("aria-hidden") === "false"'), Boolean, id + ' Side panel opens')
  const requestCount = capture.mainRequests.length
  await input('.side-panel .composer-input', 'UA_BETA_SIDE_' + id + ': finish this isolated Side conversation.')
  await click('.side-panel .composer-send-btn')
  const side = await waitFor(async () => ({ state: await call('getSideState', sessionId), events: await call('getSideEvents', sessionId) }), result => {
    if(result.events.some(event => event.type === 'error')) throw new Error(id + ' Side failed: ' + JSON.stringify(result.events.filter(event => event.type === 'error')))
    return result.state.status === 'idle' && result.events.some(event => event.type === 'turn_completed' && event.state === 'success') && result.events.some(event => event.type === 'agent_message' && event.payload.text?.includes('UA_BETA_SIDE_OK_' + id))
  }, id + ' actual CLI Side turn')
  const nativeId = side.events.find(event => event.type === 'turn_started')?.payload.threadId
  check(id + ' Side uses independent native identity', nativeId && nativeId !== source.nativeSessionId, nativeId)
  const request = capture.mainRequests.slice(requestCount).find(request => request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('UA_BETA_SIDE_' + id)))?.body
  check(id + ' Side model keeps native source context and role policy', request && JSON.stringify(request.messages).includes(readMarker) && systemText(request).includes(source.config.roleSnapshot.instructions) && JSON.stringify(tools(request, id)) === JSON.stringify(source.config.roleSnapshot.toolPolicy.tools))
  check(id + ' Side writes stay outside main transcript', !(await call('getEvents', sessionId)).some(event => event.type === 'user_message' && event.payload.text?.includes('UA_BETA_SIDE_' + id)))
  await put(join(evidence, id + '-side-events.json'), JSON.stringify(side, null, 2))
  await screenshot('actual-side-' + id)
  await click('.side-promote-btn')
  const promoted = await waitFor(() => call('listSessions'), rows => rows.some(session => session.id !== sessionId && session.title.includes('UA_BETA_SIDE_' + id)), id + ' Side promotion')
  const independent = promoted.find(session => session.id !== sessionId && session.title.includes('UA_BETA_SIDE_' + id))
  check(id + ' Side promotion creates a third writable native identity', independent.nativeSessionId && independent.nativeSessionId !== source.nativeSessionId && independent.nativeSessionId !== nativeId && independent.readOnly === false, independent)
  check(id + ' Side promotion keeps role config and transcript', JSON.stringify(independent.config.roleSnapshot) === JSON.stringify(source.config.roleSnapshot) && (await call('getEvents', independent.id)).some(event => event.type === 'agent_message' && event.payload.text?.includes('UA_BETA_SIDE_OK_' + id)))
  check(id + ' promoted Side leaves source native identity unchanged', (await call('listSessions')).find(session => session.id === sessionId).nativeSessionId === source.nativeSessionId)
}
async function verifyGoalInputs() {
  const fields = { deepseek:'DeepSeek Goal 最多回合', grok:'Grok Goal Token 预算' }
  const values = { deepseek:'3', grok:'1200' }
  const labels = { deepseek:'最多回合', grok:'Token 预算', kimi:'预算不可设置' }
  const requests = () => [...models.values()].reduce((count, model) => count + model.capture.requests.length, 0)
  async function inspect(scope, id) {
    const state = await waitFor(() => dom(`const node=document.querySelector(${JSON.stringify(scope + ' .native-goal-options')}); return node?{text:node.textContent,inputs:[...node.querySelectorAll('input')].map(input=>({label:input.getAttribute('aria-label'),value:input.value,min:input.min,step:input.step}))}:null;`), state => state?.text.includes(labels[id]), id + ' ' + scope + ' native Goal input')
    check(id + ' ' + scope + ' only exposes supported Goal limit', id === 'kimi'
      ? state.inputs.length === 0 && state.text.includes('原生 Goal')
      : state.inputs.length === 1 && state.inputs[0].label === fields[id] && state.inputs[0].min === '1' && state.inputs[0].step === '1' && !state.text.includes(id === 'deepseek' ? 'Token' : '最多回合'), state)
    return state
  }
  async function invalid(scope, id) {
    if (id === 'kimi') return
    const selector = scope + ' input[aria-label=' + JSON.stringify(fields[id]) + ']'
    await input(selector, '0')
    await input(scope + (scope === '.new-task' ? ' .prompt-input' : ' .composer-input'), 'UA_BETA_INVALID_INPUT_' + id)
    const count = requests()
    await click(scope + (scope === '.new-task' ? ' .new-task-send-btn' : ' .composer-send-btn'))
    await waitFor(() => dom(`return [...document.querySelectorAll(${JSON.stringify(scope + ' [role=alert]')})].map(node=>node.textContent).join(' ');`), text => text.includes('正整数'), id + ' ' + scope + ' rejects invalid Goal limit')
    check(id + ' ' + scope + ' invalid limit is blocked before native execution', requests() === count)
    await input(selector, values[id])
    await input(scope + (scope === '.new-task' ? ' .prompt-input' : ' .composer-input'), '')
  }
  for (const id of agentIds) {
    await click('[data-session-id="' + sessions.get(id) + '"]')
    await waitFor(() => dom('return !!document.querySelector(".composer-wrap .sb-add summary")'), Boolean, id + ' Composer ready')
    await click('.composer-wrap .sb-add summary')
    await waitFor(() => dom('return [...document.querySelectorAll(".composer-wrap .native-action-item")].some(node=>node.querySelector(".sb-entry-body")?.firstChild?.textContent.trim()==="Goal"&&!node.disabled)'), Boolean, id + ' Composer native Goal action')
    await click('.composer-wrap .native-action-item', 'Goal')
    await inspect('.composer-wrap', id)
    await invalid('.composer-wrap', id)
    await screenshot('actual-goal-input-composer-' + id)
    await click('.composer-wrap .composer-command-chip button')
  }
  await click('.btn-new')
  await waitFor(() => dom('return !!document.querySelector(".new-task .prompt-input")'), Boolean, 'New Task Goal controls')
  async function choose(id) {
    assert.ok(await dom('const details=document.querySelector(".new-task .sb-agent"); details.open=true; details.dispatchEvent(new Event("toggle")); const item=[...details.querySelectorAll(".sb-sub-entry")].find(node=>node.querySelector(".sb-entry-body")?.firstChild?.textContent.trim()==="Agent"); if(item?.getAttribute("aria-expanded")!=="true")item?.click(); return !!item;'), 'New Task Agent entry')
    const names = { deepseek:'DeepSeek Harness', kimi:'Kimi Code', grok:'Grok' }
    await waitFor(() => dom(`return [...document.querySelectorAll('.new-task .sb-agent [role=option]')].some(node=>node.querySelector('.sb-agent-name-label')?.textContent.trim()===${JSON.stringify(names[id])});`), Boolean, id + ' New Task Agent option')
    await click('.new-task .sb-agent [role=option]', names[id])
    await dom('document.querySelector(".new-task .sb-agent").open=false; return true;')
    await waitFor(() => dom('return document.querySelector(".new-task .sb-agent")?.dataset.agentId'), selected => selected === id, id + ' New Task selection')
  }
  for (const id of ['deepseek', 'grok', 'kimi', 'deepseek', 'grok']) {
    await choose(id)
    await waitFor(() => dom('return !document.querySelector(".new-task .composer-command-chip")'), Boolean, 'Provider change clears previous native command')
    await click('.new-task .sb-add summary')
    await waitFor(() => dom('return [...document.querySelectorAll(".new-task .native-action-item")].some(node=>node.querySelector(".sb-entry-body")?.firstChild?.textContent.trim()==="Goal"&&!node.disabled)'), Boolean, 'New Task native Goal action')
    await click('.new-task .native-action-item', 'Goal')
    const state = await inspect('.new-task', id)
    if (id !== 'kimi') {
      if (state.inputs[0].value) check(id + ' New Task retains its own Goal limit across Provider switches', state.inputs[0].value === values[id], state)
      await invalid('.new-task', id)
    }
    await screenshot('actual-goal-input-new-task-' + id)
    await click('.new-task .composer-command-chip button')
  }
}
async function verifyNativeGoal(agent) {
  const model = models.get('deepseek'), capture = model.capture
  const selected = agent.models.find(model => model.id.includes('deepseek-flash'))
  assert.ok(agent.capabilities.nativeGoal, 'DeepSeek native Goal must be detected')
  const config = { agentId: 'deepseek', model: selected.id, effort: 'off', permissionMode: 'full-access', workdir }
  await assert.rejects(call('createNativeActionSession', config, { type: 'goal.set', objective: 'UA_BETA_GOAL_INVALID', tokenBudget: 10 }), /Token|token|预算/)
  check('DeepSeek Goal rejects Token budget instead of changing units', capture.goalRequests.length === 0)
  await click('[data-session-id="' + sessions.get('deepseek') + '"]')
  await waitFor(() => dom('return !!document.querySelector(".composer-wrap .sb-add summary")'), Boolean, 'DeepSeek source Composer')
  await click('.composer-wrap .sb-add summary')
  await click('.composer-wrap .native-action-item', 'Goal')
  await waitFor(() => dom(`return !!document.querySelector('.composer-wrap input[aria-label="DeepSeek Goal 最多回合"]')`), Boolean, 'DeepSeek Goal round limit control')
  await input('.composer-wrap input[aria-label="DeepSeek Goal 最多回合"]', '3')
  check('actual DeepSeek Composer exposes native rounds with no Token budget', await dom('const node = document.querySelector(".composer-wrap .native-goal-options"); return node?.querySelector("input")?.value === "3" && node.textContent.includes("最多回合") && !/Token|预算/i.test(node.textContent)'))
  await screenshot('actual-native-goal-options')
  await click('.composer-wrap .composer-command-chip button')
  const objective = 'UA_BETA_GOAL: verify one native driver and pause/resume'
  const session = await call('createNativeActionSession', config, { type: 'goal.set', objective, maxRounds: 3 })
  await waitFor(async () => ({ session: (await call('listSessions')).find(row => row.id === session.id), requests: capture.goalRequests.length }), value => value.requests === 1 && value.session?.goal?.roundLimit?.roundsStarted === 1, 'first official Goal driver round')
  const first = capture.goalRequests[0].body
  const lastUser = first.messages.findLast(message => message.role === 'user')
  check('DeepSeek Goal uses one official goal_round prompt', JSON.stringify(lastUser?.content).includes('<goal_round>') && !JSON.stringify(lastUser?.content).includes('UA_BETA_GOAL_INVALID'), lastUser)
  await click('[data-session-id="' + session.id + '"]')
  await waitFor(() => dom('return document.querySelector(".goal-status-bar")?.textContent'), text => text?.includes('自动执行'), 'native Goal status bar')
  await click('.goal-status-bar')
  const nativeId = (await call('listSessions')).find(row => row.id === session.id).nativeSessionId
  await waitFor(() => dom('return document.querySelector(".goal-status-details")?.textContent'), text => text?.includes('已运行 1 / 3 回合') && text.includes('暂停'), 'native Goal round UI')
  check('native Goal labels session cumulative Tokens without invented execution time', await dom('const text = document.querySelector(".goal-status-usage")?.textContent || ""; return text.includes("会话累计") && text.includes("Token") && !text.includes("执行时间")'))
  await screenshot('actual-native-goal-running')
  await click('.native-goal-controls button', '暂停')
  await waitFor(() => call('listSessions'), rows => rows.find(row => row.id === session.id)?.goal?.status === 'paused', 'native Goal pause button')
  const paused = (await call('listSessions')).find(row => row.id === session.id).goal
  check('DeepSeek native Goal pause is committed while round runs', paused?.continuation === 'native' && paused.status === 'paused' && paused.autonomous === false && paused.tokenBudget === null && paused.roundLimit.maxRounds === 3, paused)
  model.releaseGoal(1)
  // Official external pause cancels the running round and keeps its inbox.
  const cancelled = await waitFor(async () => ({ session: (await call('listSessions')).find(row => row.id === session.id), events: await call('getEvents', session.id) }), value => {
    if (value.session?.status === 'error' || value.events.some(event => event.type === 'error')) throw new Error('paused native Goal failed: ' + JSON.stringify(value))
    return value.session?.status === 'idle' && value.events.some(event => event.type === 'turn_completed' && event.state === 'cancelled')
  }, 'paused native Goal round is natively cancelled')
  check('DeepSeek external pause cancels exactly one native round and preserves its goal context', cancelled.events.filter(event => event.type === 'turn_completed').length === 1 && !cancelled.events.some(event => event.type === 'agent_message' && event.payload?.text?.includes('UA_BETA_GOAL_ROUND_OK')) && cancelled.events.some(event => event.type === 'goal_message' && event.payload?.source?.kind === 'goal' && event.payload.source.round === 1))
  await put(join(evidence, session.id + '-goal-paused-events.json'), JSON.stringify(cancelled, null, 2))
  check('paused Goal does not dispatch a duplicate or next model request', capture.goalRequests.length === 1)
  await waitFor(() => dom('return document.querySelector(".goal-status-bar")?.textContent'), text => text?.includes('已暂停') && text.includes('继续'), 'native Goal paused UI')
  await screenshot('actual-native-goal-paused')
  await click('.native-goal-controls button', '继续')
  const resumed = await waitFor(async () => ({ session: (await call('listSessions')).find(row => row.id === session.id), requests: capture.goalRequests.length }), value => value.requests === 2 && value.session?.goal?.roundLimit?.roundsStarted === 2, 'native Goal resume round')
  const resumedPrompt = JSON.stringify(capture.goalRequests[1].body.messages)
  check('DeepSeek Goal resume reactivates the same native driver and keeps durable Goal history', resumed.session.goal.status === 'active' && resumed.session.goal.autonomous === true && resumed.session.nativeSessionId === nativeId && resumedPrompt.includes(objective) && resumedPrompt.includes('Round: 1/3') && resumedPrompt.includes('Round: 2/3'), resumed.session.goal)
  await click('.native-goal-controls button', '清除 Goal')
  await waitFor(() => call('listSessions'), rows => !rows.find(row => row.id === session.id)?.goal, 'native Goal clear button')
  check('DeepSeek Goal clear removes persisted native Goal during a round', !(await call('listSessions')).find(row => row.id === session.id).goal)
  model.releaseGoal(2)
  const final = await waitFor(async () => ({ session: (await call('listSessions')).find(row => row.id === session.id), events: await call('getEvents', session.id) }), value => {
    if (value.session?.status === 'error' || value.events.some(event => event.type === 'error')) throw new Error('cleared native Goal failed: ' + JSON.stringify(value))
    return ['idle','completed'].includes(value.session?.status) && value.events.some(event => event.type === 'turn_completed' && event.state === 'success') && value.events.some(event => event.type === 'agent_message' && event.payload?.text?.includes('UA_BETA_GOAL_ROUND_OK'))
  }, 'cleared Goal second round finishes successfully')
  const ends = final.events.filter(event => event.type === 'turn_completed')
  check('cleared Goal remains stopped with one cancelled round, one successful round and exactly two model requests', !final.session.goal && final.session.nativeSessionId === nativeId && capture.goalRequests.length === 2 && ends.length === 2 && ends[0].state === 'cancelled' && ends[1].state === 'success', final.session)
  const intent = final.events.filter(event => event.type === 'goal_message' && event.payload?.command === 'goal' && event.payload?.text === objective)
  check('Goal objective intent is published exactly once', intent.length === 1, intent)
  check('both Goal model rounds come from the official native driver', capture.goalRequests.every((request, index) => {
    const prompt = JSON.stringify(request.body.messages.findLast(message => message.role === 'user')?.content)
    return prompt.includes('<goal_round>') && prompt.includes('Round: ' + (index + 1) + '/3')
  }), capture.goalRequests.map(request => request.body.messages.findLast(message => message.role === 'user')))
  await put(join(evidence, session.id + '-goal-events.json'), JSON.stringify(final, null, 2))
}
async function saveEvidence(error) {
  await put(join(evidence, 'app-stderr.txt'), stderr)
  for (const [id, model] of models) await put(join(evidence, id + '-model-requests.json'), JSON.stringify(model.capture, null, 2))
  await put(join(evidence, 'acceptance.json'), JSON.stringify({ checkedAt: new Date().toISOString(), appAsarSha256: sha256(await readFile(binary.replace('/MacOS/UniAgent Public', '/Resources/app.asar'))), checks, error: error ? String(error.stack || error) : null, modelRequests: Object.fromEntries([...models].map(([id, model]) => [id, { all: model.capture.requests.length, main: model.capture.mainRequests.length }])) }, null, 2))
}
function cleanup() {
  return cleanupPromise ||= (async () => {
    ws?.close()
    await sweeper.sweep({ force: forceCleanup, shouldAbort: () => forceCleanup })
    if (forceCleanup) await sweeper.forceSweep()
    for (const model of models.values()) { model.releaseAllGoals(); model.server.closeAllConnections(); await new Promise(done => model.server.close(done)) }
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  })()
}
const termination = createAcceptanceTerminationHandler({ cleanup, requestForceCleanup: () => { forceCleanup = true }, onFirstSignal: signal => console.error('Acceptance interrupted: ' + signal), onCleanupError: error => console.error(error), exit: code => process.exit(code) })
process.once('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.once('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))

try {
  await prepare()
  await startApp()
  await waitFor(()=>call('getLifecycleSnapshot'),rows=>agentIds.every(id=>rows.some(agent=>agent.id===id&&agent.lifecycle)), 'startup protocol detection settles')
  const agents = await call('detectAgents')
  await put(join(evidence, 'detected-agents.json'), JSON.stringify(agents, null, 2))
  for (const id of agentIds) {
    const agent = agents.find(agent => agent.id === id)
    check(id + ' real CLI available with native fork', agent?.installed && !agent.incompatible && !agent.authenticationRequired && agent.capabilities.sessionFork, agent)
  }
  const settings = await call('getAppSettings')
  check('isolated App starts with all six Agent choices enabled', ['codex', 'traex', 'claude', ...agentIds].every(id => settings.enabledAgentIds.includes(id)))
  await verifyColdHistory()
  await verifyUI(agents)
  for (const id of agentIds) await verifyAgent(agents.find(agent => agent.id === id))
  for (const id of agentIds) await verifySide(agents.find(agent => agent.id === id))
  await click('.settings-entry')
  await verifyManagement(agents)
  await verifyGoalInputs()
  await verifyNativeGoal(agents.find(agent => agent.id === 'deepseek'))
  await saveEvidence()
  console.log('Beta packaged acceptance passed: ' + checks.length + ' checks; evidence: ' + evidence)
} catch (error) {
  console.error(error)
  try { if (ws?.readyState === WebSocket.OPEN) await screenshot('failure') } catch {}
  try { await saveEvidence(error) } catch (evidenceError) { console.error('Evidence save failed:', evidenceError) }
  console.error('Failure evidence: ' + evidence)
  process.exitCode = 1
} finally {
  try { await cleanup() } catch (error) { console.error('Acceptance cleanup failed:', error); process.exitCode = 1 }
}
