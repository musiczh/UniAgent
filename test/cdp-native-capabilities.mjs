import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  createAcceptanceProcessSweeper,
  createAcceptanceTerminationHandler
} from './acceptance-process-sweeper.mjs'

const execFileP = promisify(execFile)
const STARTUP_TIMEOUT_MS = 30_000
const EVAL_TIMEOUT_MS = 30_000

export async function sweepOwnedVerifierProcesses(processSweeper, isForceRequested) {
  let gracefulError
  try {
    await processSweeper.sweep({ shouldAbort: isForceRequested })
  } catch (error) {
    gracefulError = error
  }
  if (isForceRequested()) {
    await processSweeper.forceSweep()
    return
  }
  if (gracefulError) throw gracefulError
}

export function requireReadyInjectedMcp(candidates, fixtureName) {
  const expectedId = `mcp:${fixtureName}`
  const fixture = Array.isArray(candidates)
    ? candidates.find((candidate) =>
        candidate?.kind === 'mcp' && candidate.name === fixtureName && candidate.id === expectedId
      )
    : undefined
  assert.ok(fixture, `${fixtureName} MCP fixture missing from provider snapshot`)
  assert.equal(
    fixture.startupStatus,
    'ready',
    `${fixtureName} MCP fixture must be ready; got ${fixture.startupStatus || 'missing status'}`
  )
  return fixture
}

export function cssColorLightness(color) {
  const channels = String(color).match(/[\d.]+/g)?.map(Number) || []
  const alpha = channels.length > 3 ? channels[3] : 1
  return (channels[0] || 0) * alpha + (channels[1] || 0) * alpha + (channels[2] || 0) * alpha
}

export function createNativeVerifierPaths(fixtureRoot) {
  const isolatedHome = join(fixtureRoot, 'home')
  return {
    isolatedHome,
    userData: join(fixtureRoot, 'uniagent-data'),
    chromiumData: join(fixtureRoot, 'chromium-data'),
    isolatedTmp: join(fixtureRoot, 'tmp'),
    workdir: join(fixtureRoot, 'workspace'),
    capabilityData: join(isolatedHome, '.uniagent-capability-data')
  }
}

async function runNativeCapabilitiesVerifier() {
const packagedBinary = process.argv[2]
const provider = process.argv[3] || 'codex'

if (!packagedBinary) throw new Error('usage: node test/cdp-native-capabilities.mjs <packaged executable> <codex|traex>')
if (provider !== 'codex' && provider !== 'traex') throw new Error('provider must be codex or traex')

const resolvedBinary = resolve(packagedBinary)
if (!existsSync(resolvedBinary)) throw new Error(`packaged executable not found: ${resolvedBinary}`)
const executableMarker = sep + 'Contents' + sep + 'MacOS' + sep
const markerIndex = resolvedBinary.lastIndexOf(executableMarker)
if (markerIndex < 0) throw new Error('expected a packaged .app executable under Contents/MacOS')
const expectedRendererPath = join(
  resolvedBinary.slice(0, markerIndex),
  'Contents',
  'Resources',
  'app.asar',
  'out',
  'renderer',
  'index.html'
)

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const withTimeout = async (promise, timeoutMs, label) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function unusedLoopbackPort() {
  const server = createServer()
  const port = await withTimeout(new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('failed to allocate loopback port'))
      else resolvePort(address.port)
    })
  }), 3_000, 'allocating CDP port')
  await withTimeout(new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  }), 3_000, 'releasing CDP port')
  return port
}

async function walkFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

async function resolveProviderBinary(id) {
  const executable = id === 'codex' ? 'codex' : 'traecli'
  try {
    const { stdout } = await execFileP('/usr/bin/which', [executable], {
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' }
    })
    const found = stdout.trim().split('\n')[0]
    return found ? await realpath(found) : null
  } catch (error) {
    if (error?.code === 1 || error?.code === 'ENOENT') return null
    throw error
  }
}

async function verifyProviderSchema(id) {
  const binary = await resolveProviderBinary(id)
  if (!binary) {
    console.log(`⏭ SCHEMA SKIP ${id}: provider binary not found`)
    return { skipped: true }
  }
  const schemaRoot = await mkdtemp(join(tmpdir(), `uniagent-${id}-schema-`))
  const emptyHome = join(schemaRoot, 'home')
  const output = join(schemaRoot, 'generated')
  try {
    await Promise.all([mkdir(emptyHome, { recursive: true }), mkdir(output, { recursive: true })])
    await execFileP(binary, ['app-server', 'generate-ts', '--experimental', '--out', output], {
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        TMPDIR: schemaRoot,
        LANG: process.env.LANG || 'en_US.UTF-8'
      }
    })
    const files = await walkFiles(output)
    const named = async (basename) => {
      const matches = files.filter((path) => path.endsWith(`${sep}${basename}`))
      assert.ok(matches.length > 0, `${id} schema missing ${basename}`)
      return (await Promise.all(matches.map((path) => readFile(path, 'utf8')))).join('\n')
    }
    const [clientRequest, userInput, reviewTarget, startupState, startupFailure, toolStatus, toolResult, toolError, threadItem] = await Promise.all([
      named('ClientRequest.ts'),
      named('UserInput.ts'),
      named('ReviewTarget.ts'),
      named('McpServerStartupState.ts'),
      named('McpServerStartupFailureReason.ts'),
      named('McpToolCallStatus.ts'),
      named('McpToolCallResult.ts'),
      named('McpToolCallError.ts'),
      named('ThreadItem.ts')
    ])
    for (const method of [
      'skills/list',
      'mcpServerStatus/list',
      'thread/goal/set',
      'thread/goal/get',
      'thread/goal/clear',
      'review/start',
      'collaborationMode/list',
      'thread/settings/update'
    ]) {
      assert.ok(clientRequest.includes(`"method": "${method}"`), `${id} schema missing ${method}`)
    }
    assert.ok(userInput.includes('"type": "skill"') && userInput.includes('name: string') && userInput.includes('path: string'), `${id} schema missing structured Skill input`)
    assert.ok(reviewTarget.includes('"type": "custom"') && reviewTarget.includes('instructions: string'), `${id} schema missing custom Review target`)
    for (const state of ['starting', 'ready', 'failed', 'cancelled']) assert.ok(startupState.includes(state), `${id} schema missing MCP startup ${state}`)
    assert.ok(startupFailure.includes('reauthenticationRequired'), `${id} schema missing MCP reauthentication failure`)
    for (const state of ['inProgress', 'completed', 'failed']) assert.ok(toolStatus.includes(state), `${id} schema missing MCP tool status ${state}`)
    assert.ok(toolResult.includes('content') || toolResult.includes('structuredContent'), `${id} schema missing MCP tool result`)
    assert.ok(toolError.includes('message'), `${id} schema missing MCP tool error`)
    for (const token of ['"type": "mcpToolCall"', 'server: string', 'tool: string', 'arguments:', 'result:', 'error:', 'durationMs:']) {
      assert.ok(threadItem.includes(token), `${id} schema missing MCP item token ${token}`)
    }
    console.log(`✅ SCHEMA PASS ${id}: ${files.length} generated files`)
    return { skipped: false, binary }
  } finally {
    await rm(schemaRoot, { recursive: true, force: true })
  }
}

const schema = await verifyProviderSchema(provider)
if (schema.skipped) process.exit(0)

const realHome = homedir()
const fixture = await mkdtemp(join(tmpdir(), `uniagent-native-${provider}-cdp-`))
const {
  isolatedHome,
  userData,
  chromiumData,
  isolatedTmp,
  workdir,
  capabilityData
} = createNativeVerifierPaths(fixture)
const providerSkillName = `isolated-${provider}-skill`
const mcpScript = join(fixture, 'isolated-mcp.cjs')
const processSweeper = createAcceptanceProcessSweeper({
  includeCurrentProcessDescendants: false,
  termGraceMs: 1_500,
  killDeadlineMs: 8_000
})
let child
let childExit
let ws
let cleanupPromise
let forceCleanupRequested = false

const cleanup = () => {
  cleanupPromise ||= (async () => {
    const errors = []
    try { ws?.close() } catch {}
    try {
      await sweepOwnedVerifierProcesses(processSweeper, () => forceCleanupRequested)
    } catch (error) {
      errors.push(error)
    }
    try { await rm(fixture, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'native capability verifier cleanup failed')
  })()
  return cleanupPromise
}
const terminationHandler = createAcceptanceTerminationHandler({
  cleanup,
  requestForceCleanup: () => { forceCleanupRequested = true },
  onFirstSignal: (signal) => console.error(`Received ${signal}; cleaning owned native-capability verifier resources`),
  onCleanupError: (error) => console.error('FATAL native-capability verifier cleanup:', error),
  exit: (code) => process.exit(code)
})
const onSigint = () => terminationHandler.handleTerminationSignal('SIGINT', 130)
const onSigterm = () => terminationHandler.handleTerminationSignal('SIGTERM', 143)
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function copyIfPresent(source, destination) {
  if (!existsSync(source)) return
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

const results = []
function check(name, pass, detail = '') {
  const result = { name, pass: !!pass, detail }
  results.push(result)
  console.log(`${result.pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await Promise.all([
    isolatedHome,
    userData,
    chromiumData,
    isolatedTmp,
    workdir,
    capabilityData,
    ...['xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state', 'xdg-runtime', 'npm-cache', 'zdotdir', 'appdata', 'local-appdata']
      .map((name) => join(fixture, name))
  ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })))

  await Promise.all([
    copyIfPresent(join(realHome, '.codex', 'auth.json'), join(isolatedHome, '.codex', 'auth.json')),
    copyIfPresent(join(realHome, '.codex', 'models_cache.json'), join(isolatedHome, '.codex', 'models_cache.json')),
    copyIfPresent(join(realHome, '.trae', 'cli', 'auth.json'), join(isolatedHome, '.trae', 'cli', 'auth.json')),
    copyIfPresent(join(realHome, '.trae', 'cli', 'models_cache.json'), join(isolatedHome, '.trae', 'cli', 'models_cache.json'))
  ])

  await put(mcpScript, `const readline=require('node:readline');const rl=readline.createInterface({input:process.stdin});rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'uniagent-fixture',version:'1.0.0'}};else if(m.method==='tools/list')result={tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});\n`)
  const mcpConfig = `[mcp_servers.isolated_fixture]\ncommand = "node"\nargs = [${JSON.stringify(mcpScript)}]\n`
  await Promise.all([
    put(join(isolatedHome, '.codex', 'skills', providerSkillName, 'SKILL.md'), `---\ndescription: Isolated ${provider} native Skill\n---\n# ${providerSkillName}\n`),
    put(join(isolatedHome, '.trae', 'skills', providerSkillName, 'SKILL.md'), `---\ndescription: Isolated ${provider} native Skill\n---\n# ${providerSkillName}\n`),
    put(join(isolatedHome, '.trae', 'cli', 'skills', providerSkillName, 'SKILL.md'), `---\ndescription: Isolated ${provider} native Skill\n---\n# ${providerSkillName}\n`),
    put(join(isolatedHome, '.codex', 'config.toml'), mcpConfig),
    put(join(isolatedHome, '.trae', 'cli', 'config.toml'), mcpConfig),
    put(join(isolatedHome, '.trae', 'traecli.toml'), mcpConfig),
    put(join(fixture, 'gitconfig'), '[user]\n\tname = UniAgent Native CDP\n\temail = uniagent-native@example.invalid\n'),
    put(join(fixture, 'npmrc'), `cache=${join(fixture, 'npm-cache')}\n`)
  ])

  const isolatedEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    SHELL: '/usr/bin/false',
    USER: 'uniagent-native-cdp',
    LOGNAME: 'uniagent-native-cdp',
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    UNIAGENT_USER_DATA: userData,
    CODEX_HOME: join(isolatedHome, '.codex'),
    TRAE_HOME: join(isolatedHome, '.trae'),
    CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'),
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    XDG_CONFIG_HOME: join(fixture, 'xdg-config'),
    XDG_DATA_HOME: join(fixture, 'xdg-data'),
    XDG_CACHE_HOME: join(fixture, 'xdg-cache'),
    XDG_STATE_HOME: join(fixture, 'xdg-state'),
    XDG_RUNTIME_DIR: join(fixture, 'xdg-runtime'),
    ZDOTDIR: join(fixture, 'zdotdir'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'),
    NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    APPDATA: join(fixture, 'appdata'),
    LOCALAPPDATA: join(fixture, 'local-appdata'),
    UNIAGENT_CAPABILITY_HOME: isolatedHome,
    UNIAGENT_CAPABILITY_DATA: capabilityData,
    UA_DISABLE_GPU: '1'
  }

  const port = await unusedLoopbackPort()
  let launchError
  let stderr = ''
  child = spawn(resolvedBinary, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${chromiumData}`,
    '--ua-e2e'
  ], {
    env: isolatedEnv,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.once('error', (error) => { launchError = error })
  child.once('exit', (code, signal) => { childExit = { code, signal } })
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000) })
  await withTimeout(new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn)
    child.once('error', reject)
  }), 5_000, 'launching packaged UniAgent')
  await processSweeper.addRoot(child.pid)
  console.log(`🚀 APP LAUNCH ${provider}: pid=${child.pid} cdp=${port}`)

  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastTargets = []
  let lastTargetError = ''
  let page
  while (!page && Date.now() < startupDeadline) {
    if (launchError) throw launchError
    if (childExit) throw new Error(`packaged App exited before CDP ready: ${JSON.stringify(childExit)}${stderr ? `\nstderr tail:\n${stderr}` : ''}`)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1_500)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: controller.signal })
        if (!response.ok) throw new Error(`CDP target endpoint returned HTTP ${response.status}`)
        const targets = await response.json()
        lastTargets = Array.isArray(targets) ? targets.map(({ type, title, url }) => ({ type, title, url })) : []
        page = Array.isArray(targets) ? targets.find((target) => {
          if (target?.type !== 'page' || typeof target.url !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') return false
          try { return new URL(target.url).protocol === 'file:' && fileURLToPath(target.url) === expectedRendererPath } catch { return false }
        }) : undefined
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      lastTargetError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    if (!page) await delay(200)
  }
  if (!page) {
    throw new Error(`waiting for exact packaged renderer target timed out after ${STARTUP_TIMEOUT_MS}ms\npid=${child.pid} exit=${JSON.stringify(childExit || null)}\nlastTargetError=${lastTargetError || 'none'}\ntargets=${JSON.stringify(lastTargets)}${stderr ? `\nstderr tail:\n${stderr}` : ''}`)
  }

  ws = new WebSocket(page.webSocketDebuggerUrl)
  let requestId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
  })
  await withTimeout(new Promise((resolveOpen, reject) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', reject, { once: true })
  }), 5_000, 'opening CDP WebSocket')
  const send = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const id = requestId++
    pending.set(id, { resolve: resolveRequest, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const response = await withTimeout(send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }), EVAL_TIMEOUT_MS, 'Runtime.evaluate')
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  const waitFor = async (expression, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    let value
    while (Date.now() < deadline) {
      value = await evaluate(expression)
      if (value) return value
      await delay(150)
    }
    throw new Error(`${label} timed out; last=${JSON.stringify(value)}`)
  }
  const setTextarea = async (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  const clickNativeAction = async (scope, name) => evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)});if(!root)return false;const details=root.querySelector('details.sb-add');if(!details)return false;details.open=true;details.dispatchEvent(new Event('toggle'));const button=[...details.querySelectorAll('.native-action-item')].find((item)=>item.textContent.trim().startsWith(${JSON.stringify(name)}));if(!button)return false;button.click();return true})()`)

  await waitFor(`!!document.querySelector('.new-task .prompt-input')`, 'New Task UI')
  const detected = JSON.parse(await evaluate(`(async()=>JSON.stringify(await window.uniagent.detectAgents()))()`))
  const target = detected.find((agent) => agent.id === provider)
  assert.ok(target?.installed, `${provider} is not installed in the isolated packaged App`)

  if (await evaluate(`document.querySelector('.new-task .sb-agent')?.dataset.agentId!==${JSON.stringify(provider)}`)) {
    const opened = await evaluate(`(()=>{const details=document.querySelector('.new-task .sb-agent');if(!details)return false;details.open=true;details.dispatchEvent(new Event('toggle'));const entry=[...details.querySelectorAll('.sb-sub-entry')].find((node)=>node.textContent.includes('Agent'));if(!entry)return false;entry.click();return true})()`)
    assert.equal(opened, true, 'unable to open the New Task Agent picker')
    await waitFor(`[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].some((node)=>node.textContent.includes(${JSON.stringify(target.name)}))`, `${provider} Agent option`)
    const selected = await evaluate(`(()=>{const option=[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].find((node)=>node.textContent.includes(${JSON.stringify(target.name)}));if(!option)return false;option.click();return true})()`)
    assert.equal(selected, true, `unable to select ${provider} in New Task`)
    await waitFor(`document.querySelector('.new-task .sb-agent')?.dataset.agentId===${JSON.stringify(provider)}`, `${provider} New Task selection`)
  }

  const snapshot = JSON.parse(await evaluate(`(async()=>JSON.stringify(await window.uniagent.getNativeCapabilities({agentId:${JSON.stringify(provider)},workdir:window.uniagent.homeDir,force:true})))()`))
  const structuredSkill = snapshot.candidates.find((candidate) => candidate.kind === 'skill' && candidate.name === providerSkillName)
  check('provider-native Skill schema', !!structuredSkill?.id && !!structuredSkill?.path, structuredSkill?.name || 'missing fixture skill')
  check('provider-native candidates are Skill/MCP only', snapshot.candidates.every((candidate) => candidate.kind === 'skill' || candidate.kind === 'mcp'), `${snapshot.candidates.length} candidates`)
  const injectedMcpCandidate = snapshot.candidates.find((candidate) => candidate.kind === 'mcp' && candidate.id === 'mcp:isolated_fixture' && candidate.name === 'isolated_fixture')
  assert.ok(injectedMcpCandidate, 'isolated_fixture MCP fixture missing from provider snapshot')
  const environmentalMcp = snapshot.candidates.filter((candidate) => candidate.kind === 'mcp' && candidate.id !== injectedMcpCandidate.id)
  if (environmentalMcp.length === 0) console.log(`⏭ MCP ENVIRONMENT NOTE ${provider}: no additional MCP candidate beyond isolated_fixture`)
  else check('provider-native environmental MCP metadata', environmentalMcp.every((candidate) => candidate.id && candidate.name && candidate.startupStatus), environmentalMcp.map((candidate) => `${candidate.name}:${candidate.startupStatus}`).join(','))

  await evaluate(`(()=>{const details=document.querySelector('.new-task details.sb-add');if(!details)return false;details.open=true;details.dispatchEvent(new Event('toggle'));return true})()`)
  await waitFor(`['Goal','Review','Plan'].every((name)=>[...document.querySelectorAll('.new-task .native-action-item')].some((item)=>item.textContent.trim().startsWith(name)))`, `${provider} native actions after Agent switch`)
  const plusActions = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.new-task .native-action-item')].map((item)=>item.textContent.trim()))`))
  check('+ exposes Goal Review Plan', ['Goal', 'Review', 'Plan'].every((name) => plusActions.some((text) => text.startsWith(name))), plusActions.join(' | '))

  await setTextarea('.new-task .prompt-input', 'review-preserve-text')
  assert.equal(await clickNativeAction('.new-task', 'Review'), true)
  const reviewState = JSON.parse(await evaluate(`(()=>JSON.stringify({dialog:!!document.querySelector('.review-start-dialog'),text:document.querySelector('.new-task .prompt-input')?.value,commands:document.querySelectorAll('.new-task .composer-command-chip').length}))()`))
  check('Review opens structured dialog without mutating draft', reviewState.dialog && reviewState.text === 'review-preserve-text' && reviewState.commands === 0, JSON.stringify(reviewState))
  await evaluate(`document.querySelector('[aria-label="关闭 Review"]')?.click()`)

  await setTextarea('.new-task .prompt-input', '')
  assert.equal(await clickNativeAction('.new-task', 'Goal'), true)
  await setTextarea('.new-task .prompt-input', '/')
  await waitFor(`!!document.querySelector('.new-task .slash-kind-skill')`, 'provider-native Slash Skill')
  const slashStyle = JSON.parse(await evaluate(`(()=>{const name=document.querySelector('.new-task .slash-name');const desc=document.querySelector('.new-task .slash-desc');const style=getComputedStyle(name);const parse=${cssColorLightness.toString()};return JSON.stringify({background:style.backgroundImage,backgroundColor:style.backgroundColor,boxShadow:style.boxShadow,nameLight:parse(style.color),descLight:desc?parse(getComputedStyle(desc).color):-1,commandItems:document.querySelectorAll('.slash-kind-command').length,groups:[...document.querySelectorAll('.slash-group')].map((node)=>node.textContent)})})()`))
  check('Slash has Skill/MCP only with flat brighter names', slashStyle.commandItems === 0 && !slashStyle.groups.some((group) => /预设命令/.test(group)) && slashStyle.background === 'none' && /^(?:rgba\(0, 0, 0, 0\)|transparent)$/.test(slashStyle.backgroundColor) && slashStyle.boxShadow === 'none' && slashStyle.nameLight > slashStyle.descLight, JSON.stringify(slashStyle))
  await evaluate(`([...document.querySelectorAll('.new-task .slash-kind-skill')].find((node)=>node.textContent.includes(${JSON.stringify(providerSkillName)})))?.click()`)
  await waitFor(`document.querySelectorAll('.new-task .capability-chip-skill').length===1`, 'Skill chip selection')
  await setTextarea('.new-task .prompt-input', '/isolated_fixture')
  await waitFor(`[...document.querySelectorAll('.new-task .slash-kind-mcp')].some((node)=>node.textContent.includes('isolated_fixture'))`, 'provider-native Slash MCP')
  await evaluate(`([...document.querySelectorAll('.new-task .slash-kind-mcp')].find((node)=>node.textContent.includes('isolated_fixture')))?.click()`)
  await waitFor(`document.querySelectorAll('.new-task .capability-chip-mcp').length===1`, 'MCP chip selection')
  assert.equal(await clickNativeAction('.new-task', 'Plan'), true)
  const replaced = JSON.parse(await evaluate(`(()=>{const row=document.querySelector('.new-task .composer-capability-chips');return JSON.stringify({commands:row?.querySelectorAll('.composer-command-chip').length||0,plan:!!row?.querySelector('[data-command="plan"]'),first:row?.firstElementChild?.classList.contains('composer-command-chip')||false,skills:row?.querySelectorAll('.capability-chip-skill').length||0,mcp:row?.querySelectorAll('.capability-chip-mcp').length||0})})()`))
  check('Goal is replaced by Plan and command remains first', replaced.commands === 1 && replaced.plan && replaced.first && replaced.skills === 1 && replaced.mcp === 1, JSON.stringify(replaced))

  assert.equal(await clickNativeAction('.new-task', 'Goal'), true)
  const goalObjective = `Native ${provider} Goal ${Date.now()}`
  await setTextarea('.new-task .prompt-input', goalObjective)
  const sentGoal = await evaluate(`(()=>{const button=document.querySelector('.new-task-send-btn');if(!button||button.disabled)return false;button.click();return true})()`)
  assert.equal(sentGoal, true, 'Goal action send button must be enabled')
  await waitFor(`!!document.querySelector('.session-view .goal-status-bar')`, 'provider-confirmed Goal bar', 30_000)
  await waitFor(`[...document.querySelectorAll('.session-view .user-msg')].some((row)=>row.querySelector('.bubble-goal-label')?.textContent==='Goal'&&row.querySelector('.bubble')?.textContent?.includes(${JSON.stringify(goalObjective)}))`, 'Goal user bubble')
  const collapsedGoal = JSON.parse(await evaluate(`(()=>{const bar=document.querySelector('.goal-status-bar');return JSON.stringify({expanded:bar?.getAttribute('aria-expanded'),role:bar?.getAttribute('role'),title:bar?.querySelector('.goal-status-title')?.textContent||'',objective:bar?.querySelector('.goal-status-objective')?.textContent||'',clear:!!bar?.querySelector('.goal-clear-btn')})})()`))
  check('Goal bar defaults collapsed as the complete toggle surface without a clear action', collapsedGoal.expanded === 'false' && collapsedGoal.role === 'button' && collapsedGoal.title === 'Goal' && collapsedGoal.objective === '' && !collapsedGoal.clear, JSON.stringify(collapsedGoal))
  await evaluate(`document.querySelector('.goal-status-title')?.click()`)
  await waitFor(`document.querySelector('.goal-status-objective')?.textContent===${JSON.stringify(goalObjective)}`, 'expanded Goal objective')
  check('Goal title click expands the complete banner', await evaluate(`document.querySelector('.goal-status-bar')?.getAttribute('aria-expanded')==='true'`), goalObjective)
  await evaluate(`document.querySelector('.goal-status-objective')?.click()`)
  await waitFor(`!document.querySelector('.goal-status-objective')`, 'collapsed Goal objective')
  await evaluate(`document.querySelector('.goal-status-bar')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
  await waitFor(`document.querySelector('.goal-status-bar')?.getAttribute('aria-expanded')==='true'`, 'keyboard-expanded Goal objective')
  await evaluate(`document.querySelector('.goal-status-bar')?.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`)
  await waitFor(`document.querySelector('.goal-status-bar')?.getAttribute('aria-expanded')==='false'`, 'keyboard-collapsed Goal objective')
  const sessionId = await evaluate(`(async()=>{const sessions=await window.uniagent.listSessions();return sessions.find((session)=>session.goal?.objective===${JSON.stringify(goalObjective)})?.id||''})()`)
  assert.ok(sessionId, 'provider-confirmed Goal session missing')
  await waitFor(`document.querySelectorAll('.session-view .capability-chip-skill').length===1&&document.querySelectorAll('.session-view .capability-chip-mcp').length===1`, 'Goal-preserved native capability chips')
  const nativeTurnPrompt = `Consume native selections ${provider} ${Date.now()}`
  await setTextarea('.session-view .composer-input', nativeTurnPrompt)
  const sentNativeTurn = await evaluate(`(()=>{const button=document.querySelector('.session-view .composer-send-btn');if(!button||button.disabled)return false;button.click();return true})()`)
  assert.equal(sentNativeTurn, true, 'native capability turn send button must be enabled')
  await waitFor(`(async()=>{const events=await window.uniagent.getEvents(${JSON.stringify(sessionId)});const event=events.find((item)=>item.type==='user_message'&&item.payload?.text===${JSON.stringify(nativeTurnPrompt)});return event?.payload?.nativeContext?.skills?.some((skill)=>skill.name===${JSON.stringify(providerSkillName)})&&event?.payload?.nativeContext?.mcpServers?.some((server)=>server.name==='isolated_fixture')})()`, 'real turn consumes preserved Skill/MCP selection', 30_000)
  await waitFor(`(async()=>{const snapshot=await window.uniagent.getNativeCapabilities({agentId:${JSON.stringify(provider)},workdir:window.uniagent.homeDir,force:false});return snapshot.candidates.some((candidate)=>candidate.id==='mcp:isolated_fixture'&&candidate.startupStatus==='ready')})()`, 'selected provider-native MCP readiness')
  const readySnapshot = JSON.parse(await evaluate(`(async()=>JSON.stringify(await window.uniagent.getNativeCapabilities({agentId:${JSON.stringify(provider)},workdir:window.uniagent.homeDir,force:false})))()`))
  const injectedMcp = requireReadyInjectedMcp(readySnapshot.candidates, 'isolated_fixture')
  check('provider-native Skill/MCP selection is consumed and MCP is ready', true, `${providerSkillName}+${injectedMcp.id}:${injectedMcp.startupStatus}`)
  await evaluate(`window.uniagent.interrupt(${JSON.stringify(sessionId)})`)
  await waitFor(`(async()=>{const sessions=await window.uniagent.listSessions();return sessions.find((session)=>session.id===${JSON.stringify(sessionId)})?.status==='idle'})()`, 'native capability turn interruption', 30_000)

  const baseTs = Date.now()
  const runningEvent = {
    sessionId,
    seq: 90_001,
    ts: baseTs + 2,
    type: 'tool_call',
    state: 'running',
    payload: {
      id: 'fixture-mcp-call',
      provider: 'mcp',
      server: 'FixtureServer',
      name: 'fixture_tool',
      input: { query: 'running-input' }
    }
  }
  await evaluate(`window.uniagent.e2eInjectEvents(${JSON.stringify([
    { sessionId, seq: 89_999, ts: baseTs, type: 'user_message', payload: { text: 'MCP fixture turn' } },
    { sessionId, seq: 90_000, ts: baseTs + 1, type: 'turn_started', payload: { turnId: 'fixture-turn' } },
    runningEvent
  ])})`)
  await waitFor(`[...document.querySelectorAll('.tool-call-title')].some((node)=>node.textContent.includes('FixtureServer')&&node.textContent.includes('fixture_tool'))`, 'MCP running card')
  await evaluate(`(()=>{const card=[...document.querySelectorAll('.tool-call')].find((node)=>node.querySelector('.tool-call-title')?.textContent.includes('FixtureServer'));if(!card)return false;card.dataset.nativeProbe='stable';return true})()`)
  const terminalEvent = {
    ...runningEvent,
    seq: 90_002,
    ts: baseTs + 3,
    state: 'success',
    payload: {
      ...runningEvent.payload,
      result: { content: [{ type: 'text', text: 'captured-result' }] },
      error: null,
      durationMs: 12
    }
  }
  await evaluate(`window.uniagent.e2eInjectEvents(${JSON.stringify([terminalEvent, {
    sessionId,
    seq: 90_003,
    ts: baseTs + 4,
    type: 'plan_update',
    state: 'running',
    payload: { id: 'fixture-plan', steps: [{ text: 'Fixture plan step', status: 'in_progress' }] }
  }] )})`)
  await waitFor(`[...document.querySelectorAll('.tool-call.state-success')].some((node)=>node.dataset.nativeProbe==='stable')`, 'MCP terminal in-place update')
  const mcpCard = JSON.parse(await evaluate(`(()=>{const cards=[...document.querySelectorAll('.tool-call')].filter((node)=>node.querySelector('.tool-call-title')?.textContent.includes('FixtureServer'));const card=cards[0];card?.querySelector('.card-head')?.click();return JSON.stringify({count:cards.length,stable:card?.dataset.nativeProbe==='stable',title:card?.querySelector('.tool-call-title')?.textContent||'',state:card?.className||''})})()`))
  await waitFor(`[...document.querySelectorAll('.tool-call .tool-body')].some((node)=>node.textContent.includes('captured-result'))`, 'MCP terminal result detail')
  check('MCP running→terminal updates one DOM card', mcpCard.count === 1 && mcpCard.stable && /FixtureServer/.test(mcpCard.title) && /fixture_tool/.test(mcpCard.title) && /state-success/.test(mcpCard.state), JSON.stringify(mcpCard))
  check('agent PlanStatusBar remains independent', await waitFor(`!!document.querySelector('.plan-bar')`, 'PlanStatusBar'), 'injected plan event visible')

  const widths = JSON.parse(await evaluate(`(()=>{const goal=document.querySelector('.goal-status-bar');const eventCard=document.querySelector('.event-stream .card');const composer=document.querySelector('.composer-wrap');const view=document.querySelector('.session-view');const shell=goal?.parentElement;const header=view?.querySelector('.session-header');const body=view?.querySelector('.session-body');return JSON.stringify({goal:goal?.getBoundingClientRect().width||0,event:eventCard?.getBoundingClientRect().width||0,composer:composer?.getBoundingClientRect().width||0,ordered:!!(shell&&header&&body&&[...view.children].indexOf(header)<[...view.children].indexOf(shell)&&[...view.children].indexOf(shell)<[...view.children].indexOf(body))})})()`))
  check('Goal persists between header and scroll body at conversation width', widths.ordered && Math.abs(widths.goal - widths.event) < 1 && Math.abs(widths.goal - widths.composer) < 1, JSON.stringify(widths))

  const permissionBefore = await evaluate(`document.querySelector('.composer-wrap select[title="权限模式"]')?.value||''`)
  await evaluate(`window.uniagent.setCollaborationMode(${JSON.stringify(sessionId)},'plan')`)
  await waitFor(`!!document.querySelector('.plan-mode-badge[data-collaboration-mode="plan"]')`, 'Plan collaboration badge')
  const permissionDuring = await evaluate(`document.querySelector('.composer-wrap select[title="权限模式"]')?.value||''`)
  await evaluate(`document.querySelector('.plan-mode-badge button[aria-label="退出 Plan"]')?.click()`)
  await waitFor(`!document.querySelector('.plan-mode-badge')`, 'exit Plan collaboration mode')
  const permissionAfter = await evaluate(`document.querySelector('.composer-wrap select[title="权限模式"]')?.value||''`)
  check('Plan collaboration mode is independent from permission', !!permissionBefore && permissionBefore === permissionDuring && permissionDuring === permissionAfter, `${permissionBefore} → ${permissionDuring} → ${permissionAfter}`)

  check('Goal remains resident after collapse', await evaluate(`!!document.querySelector('.goal-status-bar')`), provider)
  check('legacy renderer APIs are absent', await evaluate(`typeof window.uniagent.runCommand==='undefined'&&typeof window.uniagent.listCandidates==='undefined'`))

  const failures = results.filter((result) => !result.pass)
  if (failures.length > 0) throw new Error(`${failures.length} native-capability checks failed: ${failures.map((failure) => failure.name).join(', ')}`)
  console.log(`\n✅ native-capability packaged verifier passed for ${provider} (${results.length}/${results.length})`)
} finally {
  await cleanup()
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  console.log(`✅ CLEANUP PASS ${provider}: owned child tree terminated; isolated fixture removed`)
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNativeCapabilitiesVerifier()
}
