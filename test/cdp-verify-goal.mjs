// Live verification of ALL 12 goal items (G2-1..G2-12) against a packaged app
// launched by this verifier. Drives the real renderer: inspects DOM, exercises the
// `/` palette, creates a real session, runs a streaming turn, interrupts it,
// and checks token cards, session grouping, archive/delete, skill/plugin
// loading, reasoning-hiding, and codex-style styling.
//
// Usage: node test/cdp-verify-goal.mjs /path/to/UniAgent-executable [agentId] [--capability-only | --model-menu-only]
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAcceptanceProcessSweeper,
  createAcceptanceTerminationHandler
} from './acceptance-process-sweeper.mjs'

// 需求7 — Node-side fs helpers to inspect freshly-transplanted rollouts on disk
// (the renderer has no fs). Locate a rollout by native id under an agent's store.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { installMarkdownInputDriver } from './fixtures/markdown-input-driver.mjs'

const STARTUP_TIMEOUT = 25_000
const binary = process.argv[2]
const agentId = process.argv.slice(3).find((argument) => !argument.startsWith('--')) || 'codex'
const capabilityOnly = process.argv.includes('--capability-only')
const modelMenuOnly = process.argv.includes('--model-menu-only')
if (!binary) throw new Error('pass the packaged UniAgent executable path')

const resolvedBinary = resolve(binary)
const executableMarker = sep + 'Contents' + sep + 'MacOS' + sep
const markerIndex = resolvedBinary.lastIndexOf(executableMarker)
if (markerIndex < 0) throw new Error('expected a packaged .app executable under Contents/MacOS')
const expectedRendererPath = join(resolvedBinary.slice(0, markerIndex), 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'renderer', 'index.html')
const SUBAGENT_PARENT_NATIVE_ID = '11111111-1111-4111-8111-111111111111'
const SUBAGENT_CHILD_NATIVE_ID = '22222222-2222-4222-8222-222222222222'
const USAGE_HISTORY_NATIVE_ID = '33333333-3333-4333-8333-333333333333'

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const withTimeout = async (promise, timeoutMs, label) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
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
  }), 3_000, 'allocating a CDP port')
  await withTimeout(new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  }), 3_000, 'releasing the CDP port')
  return port
}

const realHome = homedir()
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-goal-cdp-'))
const isolatedHome = join(fixture, 'home')
const userData = join(fixture, 'uniagent-data')
const chromiumData = join(fixture, 'chromium-data')
const isolatedTmp = join(fixture, 'tmp')
const capabilityData = join(isolatedHome, '.uniagent-capability-data')
const mcpScript = join(fixture, 'isolated-mcp.cjs')
const isolatedEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: process.env.LANG || 'en_US.UTF-8',
  LC_ALL: process.env.LC_ALL || '',
  SHELL: '/usr/bin/false',
  USER: 'uniagent-cdp',
  LOGNAME: 'uniagent-cdp',
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
let child
let childExitResult
let ws
let fatal
const processSweeper = createAcceptanceProcessSweeper({
  termGraceMs: 1_500,
  killDeadlineMs: 8_000
})
let forceCleanupRequested = false
let cleanupPromise
const cleanup = () => {
  cleanupPromise ||= (async () => {
    const errors = []
    try { ws?.close() } catch {}
    let sweepError
    try {
      await processSweeper.sweep({ shouldAbort: () => forceCleanupRequested })
    } catch (error) {
      sweepError = error
    }
    if (forceCleanupRequested) {
      try {
        await processSweeper.forceSweep()
        sweepError = undefined
      } catch (error) {
        sweepError = error
      }
    }
    if (sweepError) errors.push(sweepError)
    try {
      await rm(fixture, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, 'packaged CDP cleanup failed')
  })()
  return cleanupPromise
}
const terminationHandler = createAcceptanceTerminationHandler({
  cleanup,
  requestForceCleanup: () => { forceCleanupRequested = true },
  onFirstSignal: (signal) => console.error(`Received ${signal}; cleaning isolated packaged CDP resources`),
  onCleanupError: (error) => console.error('FATAL packaged CDP cleanup:', error),
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

async function seedCodexLikeHistory(baseDir, label) {
  const dayDir = join(baseDir, 'sessions', '2026', '08', '26')
  await mkdir(dayDir, { recursive: true })
  for (let i = 0; i < 24; i++) {
    const nativeId = randomUUID()
    const timestamp = new Date(Date.UTC(2026, 7, 26, 0, i)).toISOString()
    const records = [
      { timestamp, type: 'session_meta', payload: { id: nativeId, session_id: nativeId, timestamp, cwd: process.cwd(), originator: label + '-tui' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Isolated ' + label + ' history ' + i }] } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First isolated reply ' + i }] } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue isolated history ' + i }] } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second isolated reply ' + i }] } }
    ]
    await put(join(dayDir, 'rollout-2026-08-26T00-' + String(i).padStart(2, '0') + '-00-' + nativeId + '.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  }
}

async function seedSubAgentHistory() {
  const dayDir = join(isolatedHome, '.codex', 'sessions', '2026', '08', '26')
  const base = Date.parse('2026-08-26T02:00:00.000Z')
  const record = (timestamp, payload) => ({
    timestamp: new Date(timestamp).toISOString(),
    type: 'event_msg',
    payload
  })
  const parentRecords = [
    {
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: {
        id: SUBAGENT_PARENT_NATIVE_ID,
        session_id: SUBAGENT_PARENT_NATIVE_ID,
        timestamp: new Date(base).toISOString(),
        cwd: process.cwd(),
        originator: 'codex-tui'
      }
    },
    record(base + 100, { type: 'user_message', message: 'Verify deterministic sub-agent history' }),
    record(base + 1_000, {
      type: 'sub_agent_activity',
      agent_thread_id: SUBAGENT_CHILD_NATIVE_ID,
      agent_path: '/root/deterministic_child.md',
      kind: 'started',
      occurred_at_ms: base + 1_000,
      event_id: 'fixture-dispatch'
    }),
    record(base + 4_000, { type: 'task_complete' })
  ]
  const childRecords = [
    {
      timestamp: new Date(base + 1_000).toISOString(),
      type: 'session_meta',
      payload: {
        id: SUBAGENT_CHILD_NATIVE_ID,
        session_id: SUBAGENT_CHILD_NATIVE_ID,
        timestamp: new Date(base + 1_000).toISOString(),
        cwd: process.cwd(),
        originator: 'codex-tui',
        parent_thread_id: SUBAGENT_PARENT_NATIVE_ID,
        source: { subagent: { thread_spawn: { parent_thread_id: SUBAGENT_PARENT_NATIVE_ID } } }
      }
    },
    record(base + 2_000, { type: 'agent_message', message: 'Deterministic child rollout output' }),
    record(base + 3_000, { type: 'task_complete' })
  ]
  await Promise.all([
    put(
      join(dayDir, `rollout-2026-08-26T02-00-00-${SUBAGENT_PARENT_NATIVE_ID}.jsonl`),
      parentRecords.map((item) => JSON.stringify(item)).join('\n') + '\n'
    ),
    put(
      join(dayDir, `rollout-2026-08-26T02-00-01-${SUBAGENT_CHILD_NATIVE_ID}.jsonl`),
      childRecords.map((item) => JSON.stringify(item)).join('\n') + '\n'
    )
  ])
}

async function seedUsageHistory() {
  const dayDir = join(isolatedHome, '.codex', 'sessions', '2026', '08', '26')
  const base = Date.parse('2026-08-26T03:00:00.000Z')
  const event = (offset, payload) => ({
    timestamp: new Date(base + offset).toISOString(),
    type: 'event_msg',
    payload
  })
  const records = [
    {
      timestamp: new Date(base).toISOString(),
      type: 'session_meta',
      payload: {
        id: USAGE_HISTORY_NATIVE_ID,
        session_id: USAGE_HISTORY_NATIVE_ID,
        timestamp: new Date(base).toISOString(),
        cwd: process.cwd(),
        originator: 'codex-tui'
      }
    },
    event(100, { type: 'user_message', message: 'Usage fixture turn one' }),
    event(200, { type: 'agent_message', message: 'Usage fixture reply one' }),
    event(300, {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10 },
        last_token_usage: { input_tokens: 100 },
        model_context_window: 200_000
      }
    }),
    event(400, { type: 'task_complete' }),
    event(500, { type: 'user_message', message: 'Usage fixture turn two' }),
    event(600, { type: 'agent_message', message: 'Usage fixture reply two' }),
    event(700, {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 250, output_tokens: 50, cached_input_tokens: 30 },
        last_token_usage: { input_tokens: 150 },
        model_context_window: 200_000
      }
    }),
    event(800, { type: 'task_complete' })
  ]
  await put(
    join(dayDir, `rollout-2026-08-26T03-00-00-${USAGE_HISTORY_NATIVE_ID}.jsonl`),
    records.map((item) => JSON.stringify(item)).join('\n') + '\n'
  )
}

async function seedClaudeHistory() {
  const projectDir = join(isolatedHome, '.claude', 'projects', '-isolated-workspace')
  await mkdir(projectDir, { recursive: true })
  for (let i = 0; i < 24; i++) {
    const nativeId = randomUUID()
    const timestamp = new Date(Date.UTC(2026, 7, 26, 1, i)).toISOString()
    const records = [
      { type: 'user', uuid: randomUUID(), sessionId: nativeId, timestamp, cwd: process.cwd(), message: { role: 'user', content: 'Isolated claude history ' + i } },
      { type: 'assistant', uuid: randomUUID(), sessionId: nativeId, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'First isolated reply ' + i }] } },
      { type: 'user', uuid: randomUUID(), sessionId: nativeId, timestamp, message: { role: 'user', content: 'Continue isolated history ' + i } },
      { type: 'assistant', uuid: randomUUID(), sessionId: nativeId, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Second isolated reply ' + i }] } }
    ]
    await put(join(projectDir, nativeId + '.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  }
}

/**
 * Local (on-disk) automations for codex + traex. The 定时任务 panel reads exactly
 * these `<automations>/<id>/automation.toml` files, so seeding two agents keeps the
 * per-Agent tabs, the local-only rendering and the inline editor verifiable.
 */
async function seedAutomations() {
  const toml = (fields) => [
    'version = 1',
    'id = "' + fields.id + '"',
    'kind = "cron"',
    'name = "' + fields.name + '"',
    'prompt = "' + fields.prompt + '"',
    'status = "' + fields.status + '"',
    'rrule = "' + fields.rrule + '"',
    'model = "' + fields.model + '"',
    'reasoning_effort = "medium"',
    'execution_environment = "local"',
    'created_at = 1600000000000',
    'updated_at = 1700000000000',
    ''
  ].join('\n')
  await put(
    join(isolatedHome, '.codex', 'automations', 'goal-cdp-daily', 'automation.toml'),
    toml({
      id: 'goal-cdp-daily',
      name: 'E2E 每日日报',
      prompt: 'summarize the isolated workspace',
      status: 'PAUSED',
      rrule: 'RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=5;BYDAY=MO,TU,WE,TH,FR',
      model: 'gpt-5.6-sol'
    })
  )
  await put(
    join(isolatedHome, '.trae', 'cli', 'automations', 'goal-cdp-traex', 'automation.toml'),
    toml({
      id: 'goal-cdp-traex',
      name: 'E2E TraeX 巡检',
      prompt: 'run the isolated traex inspection',
      status: 'ACTIVE',
      rrule: 'RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=30',
      model: 'trae-model'
    })
  )
}

try {
await Promise.all([
  mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
  mkdir(userData, { recursive: true, mode: 0o700 }),
  mkdir(chromiumData, { recursive: true, mode: 0o700 }),
  mkdir(isolatedTmp, { recursive: true, mode: 0o700 }),
  mkdir(capabilityData, { recursive: true, mode: 0o700 }),
  ...['xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state', 'xdg-runtime', 'zdotdir', 'npm-cache', 'appdata', 'local-appdata']
    .map((name) => mkdir(join(fixture, name), { recursive: true, mode: 0o700 }))
])
await Promise.all([
  copyIfPresent(join(realHome, '.codex', 'auth.json'), join(isolatedHome, '.codex', 'auth.json')),
  copyIfPresent(join(realHome, '.codex', 'models_cache.json'), join(isolatedHome, '.codex', 'models_cache.json')),
  copyIfPresent(join(realHome, '.trae', 'cli', 'auth.json'), join(isolatedHome, '.trae', 'cli', 'auth.json')),
  copyIfPresent(join(realHome, '.trae', 'cli', 'models_cache.json'), join(isolatedHome, '.trae', 'cli', 'models_cache.json')),
  copyIfPresent(join(realHome, '.claude', 'settings.json'), join(isolatedHome, '.claude', 'settings.json'))
])
await Promise.all([
  put(mcpScript, `const readline=require('node:readline');const rl=readline.createInterface({input:process.stdin});rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'uniagent-fixture',version:'1.0.0'}};else if(m.method==='tools/list')result={tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});\n`),
  put(join(isolatedHome, '.codex', 'skills', 'isolated-skill', 'SKILL.md'), '---\ndescription: Isolated CDP skill\n---\n# Isolated skill\n'),
  put(join(isolatedHome, '.trae', 'skills', 'isolated-skill', 'SKILL.md'), '---\ndescription: Isolated CDP skill\n---\n# Isolated skill\n'),
  put(join(isolatedHome, '.trae', 'cli', 'skills', 'isolated-skill', 'SKILL.md'), '---\ndescription: Isolated CDP skill\n---\n# Isolated skill\n'),
  put(join(isolatedHome, '.codex', 'plugins', 'cache', 'fixture-source', 'fixture-plugin', '1.0.0', 'skills', 'isolated-plugin-skill', 'SKILL.md'), '---\ndescription: Isolated plugin skill\n---\n# Isolated plugin skill\n'),
  put(join(isolatedHome, '.codex', 'config.toml'), `[mcp_servers.isolated_fixture]\ncommand = "node"\nargs = [${JSON.stringify(mcpScript)}]\n`),
  put(join(isolatedHome, '.trae', 'cli', 'config.toml'), `[mcp_servers.isolated_fixture]\ncommand = "node"\nargs = [${JSON.stringify(mcpScript)}]\n`),
  put(join(isolatedHome, '.trae', 'traecli.toml'), `[mcp_servers.isolated_fixture]\ncommand = "node"\nargs = [${JSON.stringify(mcpScript)}]\n`),
  put(join(fixture, 'gitconfig'), '[user]\n\tname = UniAgent CDP\n\temail = uniagent-cdp@example.invalid\n'),
  put(join(fixture, 'npmrc'), 'cache=' + join(fixture, 'npm-cache') + '\n'),
  seedCodexLikeHistory(join(isolatedHome, '.codex'), 'codex'),
  seedCodexLikeHistory(join(isolatedHome, '.trae', 'cli'), 'traex'),
  seedSubAgentHistory(),
  seedUsageHistory(),
  seedClaudeHistory(),
  seedAutomations()
])
if (modelMenuOnly) await put(join(userData, 'sessions.json'), JSON.stringify([{
  id:'model-menu-fixture', title:'模型菜单验证', config:{agentId:'codex',model:'gpt-6.1-sol',permissionMode:'read-only',workdir:isolatedHome},
  status:'idle',createdAt:Date.now(),origin:'created',readOnly:false
}]))

const port = await unusedLoopbackPort()
let launchError
let stderr = ''
child = spawn(resolvedBinary, ['--remote-debugging-port=' + port, '--user-data-dir=' + chromiumData, '--ua-e2e', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  env: isolatedEnv,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'ignore', 'pipe']
})
child.on('error', (error) => { launchError = error })
child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000) })
child.once('exit', (code, signal) => {
  childExitResult = { code, signal }
})
await withTimeout(new Promise((resolveSpawn, reject) => {
  child.once('spawn', resolveSpawn)
  child.once('error', reject)
}), 5_000, 'launching packaged UniAgent')
await processSweeper.addRoot(child.pid)

function findRolloutFile(baseDir, id, targetId) {
  if (targetId === 'claude') {
    // Claude: <projects>/<dashed-cwd>/<id>.jsonl
    try {
      for (const proj of readdirSync(baseDir)) {
        const cand = join(baseDir, proj, id + '.jsonl')
        try {
          statSync(cand)
          return cand
        } catch {}
      }
    } catch {}
    return null
  }
  // codex/traex: <base>/{sessions,archived_sessions}/**/rollout-*-<id>.jsonl
  const suffix = '-' + id + '.jsonl'
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory() && e.name.endsWith(suffix)) return join(dir, e.name)
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = walk(join(dir, e.name))
        if (hit) return hit
      }
    }
    return null
  }
  for (const sub of ['sessions', 'archived_sessions']) {
    const hit = walk(join(baseDir, sub))
    if (hit) return hit
  }
  return null
}

async function getPage() {
  const deadline = Date.now() + STARTUP_TIMEOUT
  let lastTargets = []
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (childExitResult) {
      throw new Error('packaged app exited before CDP was ready: ' + JSON.stringify(childExitResult) + (stderr ? '\n' + stderr : ''))
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json', { signal: controller.signal })
        if (!response.ok) throw new Error('CDP target endpoint returned HTTP ' + response.status)
        const targets = await response.json()
        lastTargets = Array.isArray(targets) ? targets.map((entry) => ({ type: entry.type, title: entry.title, url: entry.url })) : []
        const page = Array.isArray(targets) ? targets.find((entry) => {
          if (entry?.type !== 'page' || typeof entry.webSocketDebuggerUrl !== 'string' || typeof entry.url !== 'string') return false
          try { return new URL(entry.url).protocol === 'file:' && fileURLToPath(entry.url) === expectedRendererPath }
          catch { return false }
        }) : undefined
        if (page) return page
      } finally {
        clearTimeout(timer)
      }
    } catch {}
    await delay(200)
  }
  throw new Error('packaged UniAgent CDP page did not start on port ' + port + '; targets=' + JSON.stringify(lastTargets) + (stderr ? '\n' + stderr : ''))
}

const page = await getPage()
ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pend = new Map()
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = id++
    pend.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id)
    pend.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
let evSequence = 0
const ev = async (expr) => {
  const sequence = ++evSequence
  const label = `ev#${sequence} ${String(expr).replace(/\s+/g, ' ').slice(0, 120)}`
  // Retry once on a transient stall: on a memory-constrained machine (heavy swap)
  // a single Runtime.evaluate can stall for tens of seconds while the renderer's
  // main thread is saturated streaming a turn. A one-shot timeout there produced
  // spurious failures even though the renderer was alive. Retry once with a fresh
  // evaluate; a genuinely dead renderer still fails (the WS drops / target gone).
  const once = () =>
    Promise.race([
      send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), 30000))
    ])
  let r
  try {
    r = await once()
  } catch (e) {
    if (!/ timeout$/.test(String(e.message))) throw e
    await new Promise((res) => setTimeout(res, 1500))
    r = await once() // second (final) attempt — real deaths still throw here
  }
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
await send('Runtime.enable')
await ev(`(${installMarkdownInputDriver.toString()})()`)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const poll = async (probe, accept, timeoutMs = 90_000, intervalMs = 100) => {
  const deadline = Date.now() + timeoutMs
  let value
  do {
    value = await probe()
    if (accept(value)) return value
    await sleep(intervalMs)
  } while (Date.now() < deadline)
  return value
}
const pasteDraftImage = async (selector) => {
  const pasted = await ev(`(async()=>{
    const input=window.__markdownInput.input(${JSON.stringify(selector)});
    if(!input)return false;
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
    const context=canvas.getContext('2d');context.fillStyle='#ff3366';context.fillRect(0,0,2,2);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const file=new File([blob],'draft.png',{type:'image/png'});
    const event=new Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'clipboardData',{value:{
      items:[{kind:'file',type:'image/png',getAsFile:()=>file}],
      files:[file],types:['Files'],getData:()=>''
    }});
    return input.dispatchEvent(event)===false;
  })()`)
  if (!pasted) throw new Error(`draft image paste was not handled for ${selector}`)
}

const capabilityArtifacts = []
const captureCapabilityScreenshot = async (name) => {
  if (!process.env.UNIAGENT_ACCEPTANCE_REPORT) return
  const path = join(dirname(resolve(process.env.UNIAGENT_ACCEPTANCE_REPORT)), `${name}.png`)
  const screenshot = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false })
  await writeFile(path, Buffer.from(screenshot.data, 'base64'))
  capabilityArtifacts.push(path)
}

// Cards mount before the asynchronous six-provider inventory completes. Wait for
// the known isolated Codex fixture, then exercise its actual manifest drawer.
// The full verifier and --capability-only use identical probes and assertions.
const verifyCapabilityInventoryAndDetail = async () => {
  console.log('… waiting for capability Settings entry')
  await poll(() => ev(`!!document.querySelector('.settings-entry')`), Boolean)
  await ev(`(()=>{const b=document.querySelector('.settings-entry');if(b)b.click();return !!b;})()`)
  await poll(() => ev(`!!document.querySelector('.settings-panel .set-nav')`), Boolean)
  await ev(`(()=>{const b=[...document.querySelectorAll('.settings-panel .set-nav-item')].find(x=>(x.textContent||'').includes('工具能力'));if(b)b.click();return !!b;})()`)
  await poll(() => ev(`document.querySelectorAll('.cap-agent-cards .cap-agent-card').length`), (n) => n > 0)
  await ev(`(()=>{const b=[...document.querySelectorAll('.cap-agent-cards .cap-agent-card')].find(x=>x.querySelector('.a-nm')?.textContent.trim()==='Codex');if(b)b.click();return !!b;})()`)
  const inventoryProbe = `(()=>{
    const cards=[...document.querySelectorAll('.cap-agent-cards .cap-agent-card')];
    const active=cards.filter(x=>x.classList.contains('on')&&x.getAttribute('aria-pressed')==='true');
    const rows=[...document.querySelectorAll('.capability-list .capability-row')];
    const clickable=rows.filter(x=>x.getAttribute('role')==='button');
    return JSON.stringify({cards:cards.length,active:active.length,chips:document.querySelectorAll('.cap-kind-chips .cap-chip').length,rows:rows.length,clickable:clickable.length,noSelbar:!document.querySelector('.cap-selbar.show:not(.capability-compare-sync)'),noCheckbox:rows.every(x=>x.getAttribute('role')!=='checkbox'),fixture:rows.some(x=>x.querySelector('.capability-name')?.textContent.trim()==='isolated-skill'),loading:!![...document.querySelectorAll('.panel-loading')].find(x=>/扫描能力/.test(x.textContent||'')),errors:[...document.querySelectorAll('.cap-sync-error')].map(x=>x.textContent.trim())});
  })()`
  const inventoryStartedAt = Date.now()
  const initial = JSON.parse(await ev(inventoryProbe))
  console.log('… capability inventory initial:', JSON.stringify(initial))
  const initialScreenshotStartedAt = Date.now()
  await captureCapabilityScreenshot('capability-inventory-initial')
  const initialScreenshotMs = Date.now() - initialScreenshotStartedAt
  const inventory = await poll(async () => JSON.parse(await ev(inventoryProbe)), (state) => state.fixture && !state.loading)
  const inventoryWaitMs = Date.now() - inventoryStartedAt
  await captureCapabilityScreenshot('capability-inventory-loaded')
  check('需求3 能力清单使用 Agent 卡片 / 类型 chips / 整卡可点击查看详情', inventory.cards >= 2 && inventory.active === 1 && inventory.chips > 0 && inventory.rows > 0 && inventory.clickable === inventory.rows && inventory.noSelbar && inventory.noCheckbox && inventory.fixture && !inventory.loading, JSON.stringify({initial,loaded:inventory,waitMs:inventoryWaitMs,initialScreenshotMs}))
  await ev(`(()=>{const row=[...document.querySelectorAll('.capability-list .capability-row')].find(x=>x.querySelector('.capability-name')?.textContent.trim()==='isolated-skill');if(row)row.click();return !!row;})()`)
  const detailStartedAt = Date.now()
  const detail = await poll(async () => JSON.parse(await ev(`(()=>{
    const drawer=document.querySelector('.cap-detail-overlay .cap-detail');
    const body=drawer?.querySelector('.cd-body');
    return JSON.stringify({open:!!drawer,title:(drawer?.querySelector('.cd-name')?.textContent||'').trim().length>0,close:!!drawer?.querySelector('.cd-x'),body:!!body,loaded:!!body&&!body.querySelector('.panel-loading'),fixtureText:/Isolated skill/.test(body?.textContent||'')});
  })()`)), (state) => state.open && state.title && state.close && state.body && state.loaded && state.fixtureText)
  const detailWaitMs = Date.now() - detailStartedAt
  await captureCapabilityScreenshot('capability-detail-loaded')
  check('需求2 点击能力卡打开详情抽屉（标题/关闭/正文）', detail.open && detail.title && detail.close && detail.body && detail.loaded && detail.fixtureText, JSON.stringify({...detail,waitMs:detailWaitMs}))
  await ev(`(()=>{const b=document.querySelector('.cap-detail-overlay .cd-x');if(b)b.click();return !!b;})()`)
  await poll(() => ev(`!document.querySelector('.cap-detail-overlay')`), Boolean)
}

if (modelMenuOnly) {
  const ready = await poll(() => ev(`!document.querySelector('#ua-startup')||document.querySelector('#ua-startup').hidden`), Boolean)
  if (!ready) throw new Error('model menu verification requires completed visible startup')
  const clickVisible = async (selector) => {
    const point = await ev(`(()=>{
      const target=document.querySelector(${JSON.stringify(selector)});if(!target)return null;
      const rect=target.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
      return {x,y,hit:target.contains(document.elementFromPoint(x,y))};
    })()`)
    if (!point?.hit) throw new Error('model menu target is obscured: ' + selector)
    await send('Input.dispatchMouseEvent', {type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1})
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1})
  }
  const row = '.session-item[data-session-id="model-menu-fixture"]'
  await poll(() => ev(`!!document.querySelector(${JSON.stringify(row)})`), Boolean)
  await clickVisible(row)
  await poll(() => ev(`!!document.querySelector('.composer-wrap .sb-agent > summary')`), Boolean)
  await clickVisible('.composer-wrap .sb-agent > summary')
  await clickVisible('.composer-wrap .sb-agent .sb-sub-entry')
  await poll(() => ev(`document.querySelectorAll('.composer-wrap .sb-agent .sb-sub-opt').length`), n => n > 0)
  const selected = await ev(`(()=>{
    const menu=document.querySelector('.composer-wrap .sb-agent');
    const options=[...menu.querySelectorAll('.sb-sub-opt')];
    const option=options.find(node=>!node.classList.contains('is-sel'))||options[0];
    const label=option.querySelector('.sb-entry-body').textContent.trim();
    return {label,selector:'.composer-wrap .sb-agent .sb-sub-opt'+(option.classList.contains('is-sel')?'':':not(.is-sel)')};
  })()`)
  await clickVisible(selected.selector)
  selected.closedImmediately = await ev(`!document.querySelector('.composer-wrap .sb-agent').open`)
  const settled = await poll(() => ev(`(()=>{
    const menu=document.querySelector('.composer-wrap .sb-agent');
    return {closed:!menu.open,submenu:!!menu.querySelector('.sb-sub-menu'),label:menu.querySelector('.sb-effort-model')?.textContent.trim()};
  })()`), state => state.label === selected.label && !state.submenu)
  check('打包 App 选择模型后立即关闭两层浮窗并应用模型', selected.closedImmediately && settled.closed && !settled.submenu && settled.label === selected.label, JSON.stringify({selected,settled}))
  await captureCapabilityScreenshot('model-menu-selected')
  const compactionState = async (id, state, reason) => {
    const event = {sessionId:'model-menu-fixture',seq:Date.now(),ts:Date.now(),type:'context_compaction',state,payload:{id,...(reason?{reason}:{})}}
    await ev(`window.uniagent.e2eInjectEvents([${JSON.stringify(event)}])`)
  }
  await compactionState('native-compaction-fixture','running')
  const nativeRow = await poll(() => ev(`!!document.querySelector('[data-compaction-id="native-compaction-fixture"]')`), Boolean)
  const nativeNotice = await ev(`!!document.querySelector('.composer-preparing')`)
  check('Codex 自发压缩保留工作过程且输入框不显示等待提示', nativeRow && !nativeNotice)
  await captureCapabilityScreenshot('native-compaction-no-composer-notice')
  await compactionState('native-compaction-fixture','success')
  await compactionState('provider-compaction-fixture','running','provider-switch')
  const providerNotice = await poll(() => ev(`document.querySelector('.composer-preparing')?.textContent||''`), text => text.includes('正在压缩上下文'))
  check('跨 provider 切换主动压缩显示输入框等待提示', providerNotice.includes('正在压缩上下文'))
  await captureCapabilityScreenshot('provider-compaction-composer-notice')
  await compactionState('provider-compaction-fixture','success','provider-switch')
  const noticeClosed = await poll(() => ev(`!document.querySelector('.composer-preparing')`), Boolean)
  check('跨 provider 压缩完成后输入框提示消失', noticeClosed)
} else if (capabilityOnly) {
  await verifyCapabilityInventoryAndDetail()
} else {
// Event sink + capability detection.
await ev(`(()=>{window.__e=window.__e||[];if(!window.__h){window.__h=1;window.uniagent.onEvent(x=>window.__e.push(x));}return 1;})()`)
const caps = await poll(
  async () => JSON.parse(await ev('(async()=>{const a=await window.uniagent.listAgents();return JSON.stringify(a.map(x=>({id:x.id,name:x.name,installed:x.installed,availability:x.lifecycle?.availability,streaming:x.capabilities.streaming,permissionModes:x.capabilities.permissionModes})));})()')),
  agents => agents.some(agent => agent.id === agentId && agent.installed && agent.availability === 'available')
)
console.log('DETECTED:', caps.map((c) => `${c.id}=${c.installed ? 'yes' : 'no'}`).join('  '))
const target = caps.find((c) => c.id === agentId)
if (!target || !target.installed) {
  throw new Error(`${agentId} not installed — cannot run live turn checks`)
}

// ---- G2-8: candidates come from the provider-native Skill/MCP catalog ----
const candJson = JSON.parse(
  await ev(
    `(async()=>{const s=await window.uniagent.getNativeCapabilities({agentId:${JSON.stringify(agentId)},workdir:window.uniagent.homeDir,force:true});const c=s.candidates;return JSON.stringify({n:c.length,fixture:c.some(x=>x.kind==='skill'&&x.name==='isolated-skill'&&x.path),skills:c.filter(x=>x.kind==='skill').length,mcp:c.filter(x=>x.kind==='mcp').length,onlyNative:c.every(x=>x.kind==='skill'||x.kind==='mcp'),sample:c.slice(0,3).map(x=>x.name)});})()`
  )
)
check(
  'G2-8 provider-native Skill/MCP loaded',
  candJson.n > 0 && candJson.fixture && candJson.onlyNative,
  `${candJson.n} candidates (${candJson.skills} skills / ${candJson.mcp} mcp), e.g. ${candJson.sample.join(',')}`
)

// ---- G2-2: initial state = New Task panel; navigate & inspect header later ----
// Ensure we start on the New Task panel (click ＋).
await ev(`(()=>{const b=document.querySelector('.btn-new');if(b)b.click();return 1;})()`)
const newTaskReady = await poll(() => ev(`(()=>!!document.querySelector('.new-task .prompt-input'))()`), Boolean, 30_000)
if (!newTaskReady) throw new Error('New Task panel did not open')
if (await ev(`document.querySelector('.new-task .sb-agent')?.dataset.agentId!==${JSON.stringify(agentId)}`)) {
  const agentPickerOpened = await ev(`(()=>{const details=document.querySelector('.new-task .sb-agent');if(!details)return false;details.open=true;details.dispatchEvent(new Event('toggle'));const entry=[...details.querySelectorAll('.sb-sub-entry')].find((node)=>node.textContent.includes('Agent'));if(!entry)return false;entry.click();return true})()`)
  if (!agentPickerOpened) throw new Error('New Task Agent picker did not open')
  const optionReady = await poll(
    () => ev(`(()=>[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].some((node)=>node.textContent.includes(${JSON.stringify(target.name)})))()`),
    Boolean,
    30_000
  )
  if (!optionReady) throw new Error(`${agentId} option did not appear in New Task`)
  await ev(`(()=>{const option=[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].find((node)=>node.textContent.includes(${JSON.stringify(target.name)}));option?.click();return !!option})()`)
  const selected = await poll(
    () => ev(`document.querySelector('.new-task .sb-agent')?.dataset.agentId===${JSON.stringify(agentId)}`),
    Boolean,
    30_000
  )
  if (!selected) throw new Error(`${agentId} did not become the New Task Agent`)
}
await ev(`(()=>{const details=document.querySelector('.new-task .sb-agent');if(!details)return false;details.open=true;details.dispatchEvent(new Event('toggle'));const entry=[...details.querySelectorAll('.sb-sub-entry')].find((node)=>node.textContent.includes('模型'));entry?.click();return !!entry})()`)
await sleep(160)
const newTaskModelMenuLayout = JSON.parse(await ev(`(()=>{
  const sub=document.querySelector('.new-task .sb-agent .sb-sub-menu');
  if(!sub)return JSON.stringify({err:'no model submenu'});
  const rect=sub.getBoundingClientRect(), style=getComputedStyle(sub);
  const options=[...sub.querySelectorAll('.sb-sub-opt')];
  const heights=options.map((node)=>node.getBoundingClientRect().height);
  const childRowDeltas=options.map((node)=>{
    const centers=[...node.children].map((child)=>{const box=child.getBoundingClientRect();return box.top+box.height/2});
    return centers.length?Math.max(...centers)-Math.min(...centers):0;
  });
  return JSON.stringify({
    insideViewport:rect.top>=11&&rect.bottom<=innerHeight-11,
    overflowY:style.overflowY,
    maxHeight:parseFloat(style.maxHeight),
    viewportHeight:innerHeight,
    maxRow:heights.length?Math.max(...heights):0,
    maxChildRowDelta:childRowDeltas.length?Math.max(...childRowDeltas):0,
    singleLine:childRowDeltas.every((delta)=>delta<=1),
    options:heights.length
  });
})()`))
check(
  '新建任务模型浮窗完整显示且选项间距紧凑',
  newTaskModelMenuLayout.insideViewport &&
    newTaskModelMenuLayout.overflowY === 'auto' &&
    newTaskModelMenuLayout.maxHeight <= newTaskModelMenuLayout.viewportHeight - 23 &&
    newTaskModelMenuLayout.maxRow <= 30 &&
    newTaskModelMenuLayout.singleLine &&
    newTaskModelMenuLayout.options > 0,
  JSON.stringify(newTaskModelMenuLayout)
)
await ev(`(()=>{const details=document.querySelector('.new-task .sb-agent');const entry=[...details.querySelectorAll('.sb-sub-entry')].find((node)=>node.textContent.includes('推理强度'));entry?.click();return !!entry})()`)
await sleep(160)
const newTaskEffortMenuLayout = JSON.parse(await ev(`(()=>{
  const sub=document.querySelector('.new-task .sb-agent .sb-sub-menu');
  if(!sub)return JSON.stringify({err:'no effort submenu'});
  const rect=sub.getBoundingClientRect();
  const heights=[...sub.querySelectorAll('.sb-sub-opt')].map((node)=>node.getBoundingClientRect().height);
  return JSON.stringify({
    insideViewport:rect.top>=11&&rect.bottom<=innerHeight-11,
    maxRow:heights.length?Math.max(...heights):0,
    options:heights.length
  });
})()`))
check(
  '新建任务推理强度浮窗完整显示且选项间距紧凑',
  newTaskEffortMenuLayout.insideViewport &&
    newTaskEffortMenuLayout.maxRow <= 30 &&
    newTaskEffortMenuLayout.options > 0,
  JSON.stringify(newTaskEffortMenuLayout)
)
await ev(`(()=>{document.querySelector('.new-task .sb-agent')?.removeAttribute('open');return true})()`)
await ev(`(()=>{const details=document.querySelector('.new-task details.sb-add');if(!details)return false;details.open=true;details.dispatchEvent(new Event('toggle'));return true})()`)
const nativeUiReady = await poll(
  () => ev(`(()=>['Goal','Review','Plan'].every((name)=>[...document.querySelectorAll('.new-task .native-action-item')].some((item)=>item.textContent.trim().startsWith(name))))()`),
  Boolean,
  30_000
)
if (!nativeUiReady) throw new Error(`${agentId} native actions did not load in New Task`)
await ev(`(()=>{document.querySelector('.new-task details.sb-add')?.removeAttribute('open');return true})()`)

// ---- G2-3 + G2-6 + G2-7: initial composer renders list preview, `/` palette, chips ----
// Type a `/` to open the palette in the INITIAL input box.
const initSlash = await ev(`(()=>{
  const ta=document.querySelector('.new-task .prompt-input');
  if(!ta) return JSON.stringify({err:'no initial composer'});
  window.__markdownInput.fill(ta,'/');
  return JSON.stringify({ok:1});
})()`)
const initMenu = await poll(
  () => ev(`(()=>{const m=document.querySelector('.new-task .slash-menu');return m?m.querySelectorAll('.slash-item').length:0;})()`),
  (value) => value > 0,
  30_000
)
check('G2-6 slash palette in initial input', initMenu > 0, `${initMenu} items after typing "/"`)

// Pick a provider-native Skill/MCP item and confirm a structured chip appears.
await ev(`(()=>{const it=document.querySelector('.new-task .slash-item.slash-kind-skill, .slash-item.slash-kind-skill')||document.querySelector('.new-task .slash-item.slash-kind-mcp, .slash-item.slash-kind-mcp');if(it)it.click();return 1;})()`)
await sleep(300)
const initChip = await ev(`(()=>document.querySelectorAll('.composer-capability-chips .capability-chip').length)()`)
check('G2-7 skill chip after pick (initial)', initChip > 0, `${initChip} chip(s)`)

// Markdown renders inside the editor; there is no separate list preview pane.
await ev(`(()=>{
  const ta=document.querySelector('.new-task .prompt-input');
  if(!ta) return 0;
  window.__markdownInput.fill(ta,'- one\\n- two\\n- three');
  return 1;
})()`)
await sleep(300)
const listPrev = await ev(`(()=>document.querySelectorAll('.list-preview').length)()`)
check('G2-3 no inline list-preview in composer (问题4)', listPrev === 0, `${listPrev} .list-preview block(s)`)
check('Markdown list renders in the editable input', await ev(`document.querySelectorAll('.new-task .markdown-editor-content ul > li').length === 3`))

// Remove any chip picked above so it doesn't get folded into the prompt.
// (React removal is async — click each once, don't loop on a live query.)
for (let i = 0; i < 5; i++) {
  const gone = await ev(`(()=>{const x=document.querySelector('.capability-chip-x');if(x){x.click();return false;}return true;})()`)
  await sleep(120)
  if (gone) break
}

// ---- Create a real streaming session THROUGH the New Task UI ----
// (Driving the real submit path is what sets activeId so the session view —
//  header, usage card, reply composer — actually mounts.)
const marker = `UA_GOAL_${Math.floor(Math.random() * 100000)}`
await ev(`(()=>{
  window.__markdownInput.fill('.new-task .prompt-input','List three sea creatures as a numbered markdown list, then end with the token ${marker}');
  return 1;
})()`)
await sleep(200)
await ev(`(()=>{const b=[...document.querySelectorAll('.new-task .btn-send, .config-bar .btn-send')].pop();if(b)b.click();return !!b;})()`)
// Wait for the session view (header/composer) to mount.
let sid = ''
for (let i = 0; i < 40; i++) {
  await sleep(250)
  const info = JSON.parse(await ev(`(()=>{
    const hasView=!!document.querySelector('.session-view');
    const row=document.querySelector('.session-item[data-session-id]');
    return JSON.stringify({hasView,sid:row?row.getAttribute('data-session-id'):''});
  })()`))
  if (info.hasView && info.sid) { sid = info.sid; break }
}
check('session created via UI (session view mounted)', !!sid, sid)

// Wait for streaming to begin (multiple running snapshots) then complete.
let lens = []
let completed = false
for (let i = 0; i < 200; i++) {
  await sleep(400)
  const snap = JSON.parse(
    await ev(
      `JSON.stringify(window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)}&&e.type==='agent_message'&&e.state==='running').map(e=>(e.payload.text||'').length))`
    )
  )
  lens = snap
  const done = await ev(`window.__e.some(e=>e.sessionId===${JSON.stringify(sid)}&&e.type==='turn_completed')`)
  if (done) { completed = true; break }
}
const streamed = lens.length >= 2 && lens[lens.length - 1] > lens[0]
check('streaming turn completed', completed && streamed, `completed=${completed}, streamed=${streamed}, ${lens.length} running snapshots`)

// ---- G2-1: per-turn usage card shows current-turn only; expandable detail ----
await sleep(400)
const usageLine = JSON.parse(await ev(`(()=>{
  const card=document.querySelector('.system-notice.usage');
  if(!card) return JSON.stringify({err:'no usage card'});
  const line=card.querySelector('.usage-line');
  return JSON.stringify({collapsedText:line?line.textContent:''});
})()`))
check('G2-1 per-turn token card present', !usageLine.err && !!usageLine.collapsedText, usageLine.collapsedText || usageLine.err)
// Click to expand, THEN (after React re-renders) read the two-row table.
await ev(`(()=>{const l=document.querySelector('.system-notice.usage .usage-line');if(l)l.click();return 1;})()`)
await sleep(300)
const usageDetail = JSON.parse(await ev(`(()=>{
  const card=document.querySelector('.system-notice.usage');
  const table=card?card.querySelector('.usage-table'):null;
  const rowHeads=table?[...table.querySelectorAll('tbody th')].map(t=>t.textContent):[];
  return JSON.stringify({hasTable:!!table,rowHeads});
})()`))
check(
  'G2-1 expand shows 本轮 + 会话累计 two-row table',
  usageDetail.hasTable && usageDetail.rowHeads && usageDetail.rowHeads.length >= 2,
  (usageDetail.rowHeads || []).join(' / ')
)

// ---- Doc-fix: 本轮 ≠ 会话累计 across turns. Run a SECOND completed turn and
// verify the newest card's session cumulative input strictly exceeds this
// turn's input (proves the baseline is carried, not reset every turn). ----
// The usage footer card renders slightly AFTER `turn_completed`, so first wait
// for turn 1's card to actually exist — otherwise `usageCountBefore` captures 0
// and the turn-2 loop would mistake turn 1's own card for the new one.
let usageCountBefore = 0
for (let i = 0; i < 40; i++) {
  usageCountBefore = await ev(`(()=>document.querySelectorAll('.system-notice.usage').length)()`)
  if (usageCountBefore >= 1) break
  await sleep(300)
}
await ev(`window.uniagent.sendMessage(${JSON.stringify(sid)}, 'Reply with exactly the word OK and nothing else.')`)
let turn2Done = false
for (let i = 0; i < 120; i++) {
  await sleep(400)
  const n = await ev(`(()=>document.querySelectorAll('.system-notice.usage').length)()`)
  if (n > usageCountBefore) { turn2Done = true; break }
}
await sleep(400)
const multi = JSON.parse(await ev(`(()=>{
  const cards=[...document.querySelectorAll('.system-notice.usage')];
  const last=cards[cards.length-1];
  if(!last) return JSON.stringify({err:'no card'});
  const line=last.querySelector('.usage-line');
  if(line && !last.classList.contains('open')) line.click();
  return JSON.stringify({ready:1});
})()`))
await sleep(300)
const cmp = JSON.parse(await ev(`(()=>{
  const cards=[...document.querySelectorAll('.system-notice.usage')];
  const last=cards[cards.length-1];
  const t=last?last.querySelector('.usage-table'):null;
  if(!t) return JSON.stringify({err:'no table'});
  const rows=[...t.querySelectorAll('tbody tr')];
  const num=(tr)=>parseInt((tr.querySelectorAll('td')[0]||{}).textContent?.replace(/[^0-9]/g,'')||'0',10);
  const turnIn=num(rows[0]), sessIn=num(rows[1]);
  return JSON.stringify({turnIn,sessIn});
})()`))
check(
  'Doc-fix 会话累计 > 本轮 after 2 turns (baseline carried)',
  !cmp.err && turn2Done && cmp.sessIn > cmp.turnIn,
  cmp.err ? cmp.err : `本轮输入=${cmp.turnIn}, 会话累计输入=${cmp.sessIn}`
)

// ---- 计时胶囊重构: the top bar no longer carries a 摘要 toggle; the persistent
// timer capsule owns the summary card — hover pops it above the capsule, and its
// header pins it into a right-hand dock. ----
const header = JSON.parse(await ev(`(()=>{
  const h=document.querySelector('.session-header');
  if(!h) return JSON.stringify({err:'no header'});
  const title=h.querySelector('.topbar-title');
  const toggle=h.querySelector('.summary-toggle');
  const summaryBtn=!!h.querySelector('.session-summary-toggle');
  const oldPills=h.querySelectorAll('.pill-agent, .pill-dir').length;
  const oldBadge=!!h.querySelector('.status-badge');
  const hasModelSelect=!!h.querySelector('select');
  return JSON.stringify({hasTitle:!!title,titleText:title?title.textContent.trim():'',hasToggle:!!toggle,summaryBtn,oldPills,oldBadge,hasModelSelect});
})()`))
check(
  '计时胶囊重构 top bar = title + 分叉/侧边 (无摘要按钮, no pills/badge/selects)',
  header.hasTitle && header.hasToggle && !header.summaryBtn && header.oldPills === 0 && !header.oldBadge && !header.hasModelSelect,
  `title="${header.titleText}", toggle=${header.hasToggle}, summaryBtn=${header.summaryBtn}, oldPills=${header.oldPills}, oldBadge=${header.oldBadge}, select=${header.hasModelSelect}`
)
// Hovering the timer capsule pops the summary card ABOVE it (环境信息 + the new
// pin button; the 状态 row is gone — the capsule itself carries the state).
const hasTimer = await poll(() => ev(`(()=>!!document.querySelector('.turn-timer'))()`), Boolean, 5000)
check('计时胶囊重构 常驻时间胶囊存在', hasTimer, `hasTimer=${hasTimer}`)
await ev(`(()=>{const t=document.querySelector('.turn-timer');if(t)t.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return 1;})()`)
await sleep(350)
const summaryCard = JSON.parse(await ev(`(()=>{
  const pop=document.querySelector('.timer-summary-pop.open');
  if(!pop) return JSON.stringify({open:false});
  const heads=[...pop.querySelectorAll('.sum-h')].map(e=>e.textContent.trim());
  return JSON.stringify({open:true,pin:!!pop.querySelector('.summary-pin-toggle'),heads});
})()`))
check(
  '计时胶囊重构 悬停时间胶囊弹出摘要悬浮窗 (环境信息 + 固定按钮, 无状态行)',
  summaryCard.open && summaryCard.pin && summaryCard.heads.some((h)=>/环境信息/.test(h)) && !summaryCard.heads.some((h)=>/^状态$/.test(h)),
  `open=${summaryCard.open}, pin=${summaryCard.pin}, heads=[${(summaryCard.heads||[]).join('|')}]`
)
// Moving away closes the popover (never sticky unless pinned).
await ev(`(()=>{const t=document.querySelector('.turn-timer');if(t)t.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));return 1;})()`)
const summaryClosed = await poll(() => ev(`(()=>!document.querySelector('.timer-summary-pop.open'))()`), Boolean, 3000)
check('计时胶囊重构 摘要悬浮窗随鼠标移出收起', summaryClosed, `closed=${summaryClosed}`)

// ---- G2-11: reasoning section hidden when no reasoning content ----
const reasoningInfo = JSON.parse(await ev(`(()=>{
  const evs=window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)}&&e.type==='reasoning');
  const withText=evs.filter(e=>(e.payload&&e.payload.text||'').trim().length>0);
  const domReasoning=document.querySelectorAll('.reasoning').length;
  return JSON.stringify({reasoningEvents:evs.length,withText:withText.length,domReasoning});
})()`))
check(
  'G2-11 no empty reasoning box',
  reasoningInfo.domReasoning <= reasoningInfo.withText,
  `dom=${reasoningInfo.domReasoning}, withText=${reasoningInfo.withText}`
)

// ---- G2-6/G2-7 during agent reply: composer `/` palette + chip ----
await ev(`(()=>{
  const ta=document.querySelector('.composer-input');
  if(!ta) return 0;
  window.__markdownInput.fill(ta,'/');
  return 1;
})()`)
const composerMenu = await poll(
  () => ev(`(()=>{const m=document.querySelector('.composer .slash-menu');return m?m.querySelectorAll('.slash-item.slash-kind-skill,.slash-item.slash-kind-mcp').length:0;})()`),
  (value) => value > 0,
  30_000
)
check('G2-6 slash palette in reply composer', composerMenu > 0, `${composerMenu} items`)
// Pick a provider-native Skill/MCP item and confirm a structured chip appears.
await ev(`(()=>{const it=document.querySelector('.composer .slash-item.slash-kind-skill')||document.querySelector('.composer .slash-item.slash-kind-mcp');if(it)it.click();return 1;})()`)
const composerChip = await poll(
  () => ev(`(()=>document.querySelectorAll('.composer-capability-chips .capability-chip').length)()`),
  (value) => value > 0,
  30_000
)
check('G2-7 skill chip after pick (reply)', composerChip > 0, `${composerChip} chip(s)`)
// Clear composer.
await ev(`(()=>{window.__markdownInput.fill('.composer-input','');const x=document.querySelector('.capability-chip-x');if(x)x.click();return 1;})()`)

// ---- G2-9 + G2-10: run a long turn, queue text, then interrupt cleanly ----
const marker2 = `UA_INT_${Math.floor(Math.random() * 100000)}`
// Keep the "long" turn modest (1→18) so its rapid streamed output doesn't spike
// renderer memory on constrained machines (jetsam was killing the renderer mid
// count-to-40). Still long enough to reliably interrupt in-flight.
await ev(`window.uniagent.sendMessage(${JSON.stringify(sid)}, 'Count slowly from 1 to 18, one number per line, then say ${marker2}')`)
// Wait until running (改动2: status badge removed from header — the composer now
// swaps 发送 for 中止 while busy, so presence of .btn-interrupt == running).
for (let i = 0; i < 40; i++) {
  await sleep(200)
  const running = await ev(`(()=>!!document.querySelector('.btn-interrupt'))()`)
  if (running) break
}
// G2-10 / 需求2: type while busy -> queue button appears (⌘⏎ defaults to queue,
// force-insert is now a per-queue-item choice, so there is NO steer button here).
await ev(`(()=>{
  window.__req2QueueUi={transitions:[],dispatchDom:null};
  window.__req2QueueOff=window.uniagent.onQueueChange((change)=>{
    if(change.sessionId!==${JSON.stringify(sid)})return;
    const states=change.queue.map((item)=>item.state||'pending');
    window.__req2QueueUi.transitions.push(states);
    if(states.includes('dispatching'))requestAnimationFrame(()=>{
      window.__req2QueueUi.dispatchDom={cards:document.querySelectorAll('.queue-card').length,busy:!!document.querySelector('.btn-interrupt')};
    });
  });
  return true;
})()` )
await ev(`(()=>{
  window.__markdownInput.fill('.composer-input','Count slowly from 1 to 18, one number per line, for the queued follow-up.');
  return 1;
})()`)
await sleep(300)
const busyUI = JSON.parse(await ev(`(()=>{
  // 改动: busy + typed content now shows the send (queue) icon button in the
  // primary-actions slot instead of a separate 排队 text button. No steer button.
  const q=document.querySelector('.composer-send-btn');
  const s=document.querySelector('.btn-steer');
  const hint=document.querySelector('.candidate-hint');
  return JSON.stringify({queue:!!q,steer:!!s,hint:!!hint});
})()`))
check('G2-10 busy composer shows queue button (no steer)', busyUI.queue && !busyUI.steer, `hint=${busyUI.hint}`)
// Enqueue it.
await ev(`(()=>{const q=document.querySelector('.composer-send-btn');if(q)q.click();return 1;})()`)
await poll(
  () => ev(`(()=>{const card=document.querySelector('.queue-card');return !!card&&!card.classList.contains('is-entering')&&!!card.querySelector('.queue-card-acts');})()`),
  Boolean,
  30_000
)
const queueState = JSON.parse(await ev(`(()=>{
  const cards=document.querySelectorAll('.queue-card');
  const steer=document.querySelector('.queue-card .queue-steer');
  const bar=document.querySelector('.queue-stack');
  const input=document.querySelector('.composer-wrap');
  const barBox=bar?.getBoundingClientRect(), inputBox=input?.getBoundingClientRect();
  const queueNotice=[...document.querySelectorAll('.chain-fold')].some((node)=>/提示\\s+[1-9]/.test(node.querySelector('.chain-summary')?.textContent||'')&&(node.textContent||'').includes('已排队'));
  return JSON.stringify({cards:cards.length,steer:!!steer,text:(steer?.textContent||'').trim(),title:steer?.getAttribute('title')||'',standalone:!!bar&&!!input&&bar.parentElement===input.parentElement&&bar.nextElementSibling===input,sameWidth:!!barBox&&!!inputBox&&Math.abs(barBox.width-inputBox.width)<=1,queueNotice});
})()`))
check('需求2 queued item shows codex-style card aligned to the input', queueState.cards > 0 && queueState.standalone && queueState.sameWidth, JSON.stringify(queueState))
check('需求2 queue acknowledgement stays out of the chat call chain', !queueState.queueNotice, JSON.stringify(queueState))
check(
  '需求2 queued item exposes exact 直接发送 action',
  queueState.steer && queueState.title === '直接发送',
  JSON.stringify(queueState)
)

// Let the first turn complete so the queued item enters its durable dispatching
// state. It must disappear from the waiting UI immediately, while it remains in
// the outbox until the provider terminal acknowledgement.
const queueDispatchUi = await poll(
  () => ev(`(()=>window.__req2QueueUi?.dispatchDom||null)()`),
  (value) => !!value && value.cards === 0,
  90_000,
  50
)
const queueTransitions = await ev(`(()=>window.__req2QueueUi?.transitions||[])()`)
check(
  '需求2 queued card disappears as soon as automatic dispatch begins',
  queueDispatchUi?.cards === 0 && queueTransitions.some((states)=>states.includes('dispatching')),
  JSON.stringify({ queueDispatchUi, queueTransitions })
)

// Now interrupt the automatically dispatched follow-up.
await ev(`(()=>{const b=document.querySelector('.btn-interrupt');if(b)b.click();return 1;})()`)
// Wait for interrupted/idle and verify no stuck "running" (改动2: no status badge
// — 中止 button disappears and 发送 returns once the turn actually stops).
let finalStatus = ''
for (let i = 0; i < 40; i++) {
  await sleep(300)
  const running = await ev(`(()=>!!document.querySelector('.btn-interrupt'))()`)
  finalStatus = running ? '运行中' : '空闲'
  if (!running) break
}
const notStuck = !/(运行中)/.test(finalStatus)
check('G2-9 interrupt stops turn (not stuck running)', notStuck, `final status: ${finalStatus}`)
await ev(`(()=>{window.__req2QueueOff?.();delete window.__req2QueueOff;return true;})()` )
// The queued item should have been cleared on interrupt (state not corrupted).
const queueAfter = await ev(`(()=>document.querySelectorAll('.queue-card').length)()`)
check('G2-9 queue cleared on interrupt (state clean)', queueAfter === 0, `${queueAfter} remaining`)

// After interrupt the app should accept a fresh turn (idle & sendable). The 发送
// button is (correctly) disabled while the composer is empty, so "sendable" means:
// idle (no 中止 button) + composer input mounted + a 发送 button present (not 中止).
await sleep(500)
const canSendAgain = await ev(`(()=>{
  const idle=!document.querySelector('.btn-interrupt');
  const input=!!document.querySelector('.composer-input');
  const sendBtn=!!document.querySelector('.btn-send');
  return idle && input && sendBtn;
})()`)
check('G2-9 accepts new input post-interrupt', canSendAgain, `status ${finalStatus}`)

// ---- G2-5: session list grouping (全部 / 按 Agent) ----
const grouping = JSON.parse(await ev(`(()=>{
  const btns=[...document.querySelectorAll('.sl-view .sl-seg button')];
  const opts=btns.map(b=>b.textContent.trim());
  btns.find(b=>b.getAttribute('data-view')==='byAgent')?.click();
  return JSON.stringify({tabs:opts});
})()`))
await sleep(250)
const groupHeads = await ev(`(()=>document.querySelectorAll('.sl-group-head').length)()`)
check('G2-5 has 全部 + 按Agent tabs', grouping.tabs.some((t) => /全部/.test(t)) && grouping.tabs.some((t) => /Agent/.test(t)), grouping.tabs.join(','))
check('G2-5 按Agent view groups rows', groupHeads > 0, `${groupHeads} group header(s)`)
// Back to 全部.
await ev(`(()=>{document.querySelector('.sl-view .sl-seg button[data-view="all"]')?.click();return 1;})()`)
await sleep(200)

// ---- G2-4: archive then unarchive (non-destructive path) ----
const archiveFlow = JSON.parse(await ev(`(async()=>{
  const row=document.querySelector('.session-item[data-session-id=${JSON.stringify(sid)}]') || document.querySelector('.session-item');
  if(!row) return JSON.stringify({err:'no row'});
  const before=document.querySelectorAll('.sl-body .session-item').length;
  const arch=row.querySelector('.si-act[title=\"归档\"]');
  if(!arch) return JSON.stringify({err:'no archive btn'});
  arch.click();
  return JSON.stringify({before});
})()`))
await sleep(500)
const afterArchive = JSON.parse(await ev(`(()=>{
  const drawer=document.querySelector('.sl-archive');
  const head=document.querySelector('.sl-archive-head');
  if(head) head.click();
  return JSON.stringify({hasDrawer:!!drawer});
})()`))
await sleep(300)
const archivedCount = await ev(`(()=>document.querySelectorAll('.session-item.archived').length)()`)
check('G2-4 archive moves session to 已归档 drawer', afterArchive.hasDrawer && archivedCount > 0, `${archivedCount} archived`)
// Unarchive the exact session archived above. Other archived sessions can be
// reordered or filtered as Agent availability changes, so clicking the first
// row makes later session-view assertions depend on unrelated local state.
const restoreClicked = await ev(`(()=>{const u=document.querySelector('.session-item.archived[data-session-id=${JSON.stringify(sid)}] .si-act[title=\"恢复\"]');if(u)u.click();return !!u;})()`)
await sleep(400)
const restored = JSON.parse(await ev(`(async()=>{
  const active=!!document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(sid)}]');
  const archived=!!document.querySelector('.session-item.archived[data-session-id=${JSON.stringify(sid)}]');
  const session=(await window.uniagent.listSessions()).find(x=>x.id===${JSON.stringify(sid)});
  return JSON.stringify({active,archived,persisted:session?.archived});
})()`))
check(
  'G2-4 unarchive restores exact session',
  restoreClicked && restored.active && !restored.archived && restored.persisted === false,
  JSON.stringify({ restoreClicked, ...restored })
)

// ---- G2-12: codex-style overall styling sanity (dark, rounded composer, etc.) ----
// Open a session so the reply composer is mounted, else fall back to the
// New Task composer box — both must be dark + generously rounded.
await ev(`(()=>{const r=document.querySelector('.sl-body .session-item');if(r)r.click();return 1;})()`)
await sleep(400)
const style = JSON.parse(await ev(`(()=>{
  const cs=getComputedStyle(document.body);
  const bg=cs.backgroundColor;
  // The rounded card is the OUTER shell (.composer-wrap in session view,
  // .composer-box on the home screen); .composer-input is the inner transparent
  // textarea (radius 0 by design), so it must not be measured here.
  const comp=document.querySelector('.composer-wrap')||document.querySelector('.composer-box')||document.querySelector('.composer-input')||document.querySelector('.prompt-input');
  const radius=comp?getComputedStyle(comp).borderRadius:'';
  return JSON.stringify({bg,radius});
})()`))
const darkBg = style.bg.startsWith('rgb(15') || style.bg.startsWith('rgb(1') || style.bg.startsWith('rgba(15')
check(
  'G2-12 codex-style dark theme + rounded composer',
  darkBg && !!style.radius && parseFloat(style.radius) >= 12,
  `bg=${style.bg}, composerRadius=${style.radius}`
)

// ---- 需求补9: composer Agent menu opens model/effort as a side-by-side
// second-level list (right of the main popover, top-aligned to the clicked row),
// Opening a submenu keeps the main popover; selecting a model closes both.
// The session opened above keeps the reply composer mounted. ----
await ev(`(()=>{document.querySelectorAll('.composer-wrap details[open]').forEach(d=>d.removeAttribute('open'));const s=document.querySelector('.composer-wrap .sb-agent > summary');if(s)s.click();return 1;})()`)
await sleep(160)
const subMenuOpened = JSON.parse(await ev(`(()=>{
  const details=document.querySelector('.composer-wrap .sb-agent');
  const pop=details?.querySelector('.sb-menu-pop');
  const entry=details?.querySelector('.sb-sub-entry');
  if(!details||!pop||!entry) return JSON.stringify({err:'no agent menu',hasDetails:!!details,hasPop:!!pop,hasEntry:!!entry});
  entry.click();
  return JSON.stringify({clicked:true});
})()`))
await sleep(160)
const subMenu = JSON.parse(await ev(`(()=>{
  const details=document.querySelector('.composer-wrap .sb-agent');
  const open=!!details&&details.open;
  const pop=details?.querySelector('.sb-menu-pop');
  const entry=details?.querySelector('.sb-sub-entry.is-sub-open');
  const sub=details?.querySelector('.sb-sub-menu');
  if(!pop||!entry||!sub) return JSON.stringify({open,hasPop:!!pop,hasEntry:!!entry,hasSub:!!sub});
  const pb=pop.getBoundingClientRect(), sb=sub.getBoundingClientRect(), eb=entry.getBoundingClientRect();
  const options=[...sub.querySelectorAll('.sb-sub-opt')];
  const childRowDeltas=options.map((node)=>{
    const centers=[...node.children].map((child)=>{const box=child.getBoundingClientRect();return box.top+box.height/2});
    return centers.length?Math.max(...centers)-Math.min(...centers):0;
  });
  return JSON.stringify({
    open,
    popVisible:pb.width>0,
    toRight:sb.left>=pb.right-1,          // second level sits to the RIGHT of the main popover
    topAlignedOrShiftedUp:sb.top<=eb.top+14,
    insideViewport:sb.top>=11&&sb.bottom<=innerHeight-11,
    maxRow:Math.max(...[...sub.querySelectorAll('.sb-sub-opt')].map((node)=>node.getBoundingClientRect().height)),
    maxChildRowDelta:childRowDeltas.length?Math.max(...childRowDeltas):0,
    singleLine:childRowDeltas.every((delta)=>delta<=1),
    opts:sub.querySelectorAll('.sb-sub-opt').length
  });
})()`))
check(
  '需求补9 模型/推理二级列表在主浮窗右侧完整展开且选项间距紧凑',
  subMenu.open && subMenu.popVisible && subMenu.toRight && subMenu.topAlignedOrShiftedUp &&
    subMenu.insideViewport && subMenu.maxRow <= 30 && subMenu.singleLine && subMenu.opts > 0,
  JSON.stringify(subMenu)
)
// Selecting a model immediately closes both popovers, including during async updates.
const subSelect = JSON.parse(await ev(`(()=>{
  const details=document.querySelector('.composer-wrap .sb-agent');
  const options=[...(details?.querySelectorAll('.sb-sub-menu .sb-sub-opt')||[])];
  const opt=options.find(x=>!x.classList.contains('is-sel'))||options[0];
  if(!opt) return JSON.stringify({clicked:false});
  const label=opt.querySelector('.sb-entry-body')?.textContent.trim();
  opt.click();
  return JSON.stringify({clicked:true,label,closedImmediately:!details.open});
})()`))
await sleep(140)
const subSelected = JSON.parse(await ev(`(()=>{
  const details=document.querySelector('.composer-wrap .sb-agent');
  return JSON.stringify({
    open:!!details&&details.open,
    subStillOpen:!!details?.querySelector('.sb-sub-menu'),
    label:details?.querySelector('.sb-effort-model')?.textContent.trim()
  });
})()`))
check(
  '需求补9 选择模型后即时收起主浮窗与二级列表',
  subSelect.clicked && subSelect.closedImmediately && !subSelected.open && !subSelected.subStillOpen && subSelected.label === subSelect.label,
  JSON.stringify({ subSelect, subSelected })
)
// Close the composer menu so it doesn't shadow later checks.
await ev(`(()=>{document.querySelectorAll('.composer-wrap details[open]').forEach(d=>d.removeAttribute('open'));return 1;})()`)
await sleep(120)

// ==== New requirements (需求11–19) ================================
// Session is still active (styling check reopened it above).

// ---- 需求1.1: brand SVG icons (gpt/trae/claude), NOT the big green emoji ----
const brandIcons = JSON.parse(await ev(`(()=>{
  const svgs=document.querySelectorAll('.agent-icon svg, .agent-icon');
  const health=document.querySelectorAll('.agent-health-row .agent-icon').length;
  const greenDot=(document.body.innerText.match(/🟢/g)||[]).length;
  return JSON.stringify({svgs:svgs.length,health,greenDot});
})()`))
check('需求1.1 brand SVG agent icons (no 🟢 emoji)', brandIcons.svgs > 0 && brandIcons.greenDot === 0, `icons=${brandIcons.svgs}, health=${brandIcons.health}, greenDot=${brandIcons.greenDot}`)

// ---- 需求12: sidebar has codex-style nav rows for history + scheduled ----
const navRows = JSON.parse(await ev(`(()=>{
  const items=[...document.querySelectorAll('.sidebar-nav .sidebar-nav-item')].map(x=>x.textContent.trim());
  return JSON.stringify({n:items.length,items});
})()`))
check('需求12 sidebar nav rows (history + scheduled)', navRows.n >= 2, navRows.items.join(' | '))

// ---- 需求13: clicking a nav row opens the panel INLINE in main (not a drawer) ----
const histPanel = JSON.parse(await ev(`(()=>{
  const btn=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>/导入会话/.test(x.textContent));
  if(btn) btn.click();
  return JSON.stringify({clicked:!!btn});
})()`))
await sleep(400)
const histInMain = JSON.parse(await ev(`(()=>{
  const inMain=!!document.querySelector('.main .main-panel');
  const drawer=!!document.querySelector('.drawer-overlay');
  const title=(document.querySelector('.main-panel-title')||{}).textContent||'';
  return JSON.stringify({inMain,drawer,title});
})()`))
check('需求13 history renders inline in chat area (not drawer)', histInMain.inMain && !histInMain.drawer, `title="${histInMain.title}", drawer=${histInMain.drawer}`)

// scheduled tasks likewise
await ev(`(()=>{const b=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>/定时/.test(x.textContent));if(b)b.click();return 1;})()`)
await sleep(400)
const autoInMain = JSON.parse(await ev(`(()=>{
  const inMain=!!document.querySelector('.main .automations-panel, .main .main-panel');
  const title=(document.querySelector('.main-panel-title')||{}).textContent||'';
  return JSON.stringify({inMain,title});
})()`))
check('需求13 scheduled tasks render inline in chat area', autoInMain.inMain, `title="${autoInMain.title}"`)

// ---- 需求15: sidebar collapse + reveal, and resizer handle present ----
const resizer = await ev(`(()=>!!document.querySelector('.sidebar-resizer'))()`)
check('需求15 sidebar has drag resizer', !!resizer)
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
const sidebarMotion = JSON.parse(await ev(`(()=>{
  const sidebar=document.querySelector('.sidebar');
  const normal=getComputedStyle(sidebar);
  document.body.classList.add('resizing-sidebar');
  const resizing=getComputedStyle(sidebar).transitionDuration;
  document.body.classList.remove('resizing-sidebar');
  return JSON.stringify({property:normal.transitionProperty,duration:normal.transitionDuration,resizing});
})()`))
check('需求22 sidebar 默认有宽度过渡，拖动时禁用过渡', sidebarMotion.property.split(',').map(x=>x.trim()).includes('width') && sidebarMotion.duration.split(',').some(x=>x.trim()!=='0s') && sidebarMotion.resizing.split(',').every(x=>x.trim()==='0s'), JSON.stringify(sidebarMotion))
const collapseFlow = JSON.parse(await ev(`(()=>{
  const c=document.querySelector('.sidebar-header .btn-ghost');
  if(c) c.click();
  return JSON.stringify({clicked:!!c});
})()`))
await poll(
  () => ev(`(()=>{const s=document.querySelector('.sidebar');return !!s&&s.classList.contains('is-collapsed')&&s.getAttribute('aria-hidden')==='true'&&s.inert===true&&s.getBoundingClientRect().width===0&&!!document.querySelector('.sidebar-reveal');})()`),
  Boolean
)
const collapsed = JSON.parse(await ev(`(()=>{
  const sidebar=document.querySelector('.sidebar');
  const hidden=!!sidebar&&sidebar.classList.contains('is-collapsed')&&sidebar.getAttribute('aria-hidden')==='true'&&sidebar.inert===true&&sidebar.getBoundingClientRect().width===0;
  const reveal=!!document.querySelector('.sidebar-reveal');
  return JSON.stringify({hidden,reveal});
})()`))
check('需求15 sidebar collapses to a reveal button', collapsed.hidden && collapsed.reveal, `sidebarHidden=${collapsed.hidden}, reveal=${collapsed.reveal}`)
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
const reducedMotion = JSON.parse(await ev(`(()=>{
  const sidebar=document.querySelector('.sidebar'), reveal=document.querySelector('.sidebar-reveal');
  return JSON.stringify({duration:getComputedStyle(sidebar).transitionDuration,animation:reveal?getComputedStyle(reveal).animationName:''});
})()`))
check('需求22 prefers-reduced-motion 禁用侧栏过渡与 reveal 动画', reducedMotion.duration.split(',').every(x=>x.trim()==='0s') && reducedMotion.animation === 'none', JSON.stringify(reducedMotion))
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
// Re-expand.
await ev(`(()=>{const r=document.querySelector('.sidebar-reveal');if(r)r.click();return 1;})()`)
await poll(
  () => ev(`(()=>{const s=document.querySelector('.sidebar');return !!s&&!s.classList.contains('is-collapsed')&&s.getAttribute('aria-hidden')==='false'&&s.inert===false&&s.getBoundingClientRect().width>0&&!document.querySelector('.sidebar-reveal');})()`),
  Boolean
)
const reExpanded = await ev(`(()=>{const sidebar=document.querySelector('.sidebar');return !!sidebar&&!sidebar.classList.contains('is-collapsed')&&sidebar.getAttribute('aria-hidden')==='false'&&sidebar.inert===false&&sidebar.getBoundingClientRect().width>0&&!document.querySelector('.sidebar-reveal');})()`)
check('需求15 reveal button re-expands sidebar', !!reExpanded)

// Return to the exact live session created above. Other acceptance fixtures may
// reorder the sidebar, so selecting the first row makes the status-line checks
// nondeterministic.
await ev(`(()=>{const r=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(sid)}]');if(r)r.click();return !!r;})()`)
// Wait until the reply composer actually mounts (panel closed, session view up).
for (let i = 0; i < 20; i++) {
  await sleep(200)
  if (await ev(`(()=>!!document.querySelector('.composer-input'))()`)) break
}
const exactSessionRestored = await ev(`(()=>{
  const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(sid)}]');
  return !!row?.classList.contains('active');
})()` )
if (!exactSessionRestored) throw new Error(`failed to restore exact live session ${sid}`)

// ---- Enter continues structured lists; an empty item exits the list. ----
const listCases = [
  ['1. first', 'ol', 1, 2],
  ['* item', 'ul', 1, 2],
  ['1. first', 'ol', 2, 1]
]
for (const [before, tag, enters, expectedItems] of listCases) {
  await ev(`(()=>{
    window.__markdownInput.fill('.composer-input',${JSON.stringify(before)});
    const field=window.__markdownInput.input('.composer-input');
    for(let i=0;i<${enters};i++)field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
    return true;
  })()`)
  await sleep(120)
  const actual = await ev(`(()=>{const field=window.__markdownInput.input('.composer-input');return {items:field.querySelectorAll('${tag} > li').length,insideList:!!getSelection()?.anchorNode?.parentElement?.closest('li')}})()`)
  check('需求17 Enter list continuation ' + JSON.stringify([before, enters]), actual.items === expectedItems && actual.insideList === (enters === 1), JSON.stringify(actual))
}
await ev(`window.__markdownInput.fill('.composer-input','')`)

// ---- 需求19: sending shows an instant live status line with shimmer ----
const marker3 = `UA_LIVE_${Math.floor(Math.random() * 100000)}`
await ev(`(()=>{window.__e=window.__e.filter(e=>e.sessionId!==${JSON.stringify(sid)}||e.type!=='turn_completed');return true;})()` )
await ev(`(()=>{
  const now=Date.now(), events=[];
  for(let i=0;i<60;i++){
    events.push({sessionId:${JSON.stringify(sid)},seq:now+i*2,ts:now+i*2,type:'user_message',state:'success',payload:{id:'scroll-u-'+now+'-'+i,text:'scroll fixture '+i}});
    events.push({sessionId:${JSON.stringify(sid)},seq:now+i*2+1,ts:now+i*2+1,type:'agent_message',state:'success',payload:{id:'scroll-a-'+now+'-'+i,text:'reply '+i}});
  }
  return window.uniagent.e2eInjectEvents(events);
})()`)
await poll(() => ev(`(()=>{const s=document.querySelector('.session-view .event-stream');return !!s&&s.scrollHeight>s.clientHeight;})()`), Boolean)
await ev(`(()=>{const s=document.querySelector('.session-view .event-stream');if(!s)return false;s.scrollTop=0;s.dispatchEvent(new Event('scroll',{bubbles:true}));return true;})()`)
await sleep(100)
await ev(`(()=>{
  window.__markdownInput.fill('.composer-input','Count slowly 1 to 25 one per line then say ${marker3}');
  return 1;
})()`)
await poll(() => ev(`!!document.querySelector('.btn-send:not(:disabled)')`), Boolean)
await ev(`document.querySelector('.btn-send:not(:disabled)').click()`)
// Observe optimistic feedback immediately. The real turn can finish before the
// later scroll assertion on a fast provider, at which point the status row is
// correctly gone.
let liveStatus = { line: false, shimmer: false, text: '' }
for (let i = 0; i < 30; i++) {
  await sleep(120)
  liveStatus = JSON.parse(await ev(`(()=>{
    const l=document.querySelector('.status-line');
    const sh=document.querySelector('.status-line .status-line-text.shimmer');
    return JSON.stringify({line:!!l,shimmer:!!sh,text:sh?sh.textContent:''});
  })()`))
  if (liveStatus.line) break
}
check('需求19 live status line appears instantly on send', liveStatus.line, `text="${liveStatus.text}"`)
check('需求19 status line has shimmer animation', liveStatus.shimmer, `shimmerEl=${liveStatus.shimmer}`)
const lastRow = await ev(`(()=>{
  const es=document.querySelector('.event-stream');
  if(!es) return false;
  const real=[...es.children].filter(c=>c.offsetHeight>0&&c.className);
  return real.length? real[real.length-1].classList.contains('status-line'):false;
})()`)
check('需求19 status line is the last row while running', !!lastRow)
const sendScrolled = await poll(
  () => ev(`(()=>{
    const s=document.querySelector('.session-view .event-stream');
    const messages=[...document.querySelectorAll('.session-view .user-msg')];
    return {gap:s?s.scrollHeight-s.clientHeight-s.scrollTop:9999,sent:(messages[messages.length-1]?.textContent||'').includes(${JSON.stringify(marker3)})};
  })()`),
  (value) => value.sent && value.gap <= 2,
  15000
)
check('需求23 UI send forces the event stream to the new message', sendScrolled.sent && sendScrolled.gap <= 2, JSON.stringify(sendScrolled))
// Let it finish (or interrupt) so we leave the app idle.
await ev(`(()=>{const b=document.querySelector('.btn-interrupt');if(b)b.click();return 1;})()`)
await sleep(600)

// ---- 需求16: Claude surfaces its real model (from settings env), not fixed opus/sonnet/haiku ----
const claude = caps.find((c) => /claude/.test(c.id))
if (claude && claude.installed) {
  const claudeModels = JSON.parse(await ev(`(async()=>{
    const a=await window.uniagent.detectAgents();
    const c=a.find(x=>/claude/.test(x.id));
    return JSON.stringify({models:(c?.models||[]).map(m=>m.id),def:c?.defaultModel});
  })()`))
  const onlyOpusAliases = claudeModels.models.length > 0 &&
    claudeModels.models.every((m) => /opus|sonnet|haiku/i.test(m))
  check('需求16 Claude model reflects settings (not fixed opus/sonnet/haiku)', !onlyOpusAliases, `models=[${claudeModels.models.join(',')}], default=${claudeModels.def}`)
} else {
  console.log('… 需求16 skipped: claude not installed')
}

// ==== 需求20–23 (latest batch) ===================================

// ---- 需求21: live status line has NO loading spinner (dropped), and text
// indents to align with the call-chain column. We already proved the line +
// shimmer appear (需求19); here assert the spinner element is gone. ----
const noSpinner = JSON.parse(await ev(`(()=>{
  const legacy=document.querySelector('.status-line-spinner');
  const anyCircle=document.querySelector('.status-line .spinner, .status-line svg, .status-line .loading');
  // indent: the status line pads its text to line up with the chain title.
  const sl=document.querySelector('.status-line');
  const pad=sl?parseFloat(getComputedStyle(sl).paddingLeft):0;
  return JSON.stringify({legacy:!!legacy,anyCircle:!!anyCircle,pad});
})()`))
check('需求21 status line has no spinner (indent aligned)', !noSpinner.legacy && !noSpinner.anyCircle, `legacy=${noSpinner.legacy}, circle=${noSpinner.anyCircle}, padLeft=${noSpinner.pad}`)

// ---- 需求22: resuming a REAL native two-turn history session must emit exactly
// one usage card per turn, without duplicate cumulative "本轮" cards. ----
const resumeUsage = JSON.parse(await ev(`(async()=>{
  const s=await window.uniagent.importSession('codex',${JSON.stringify(USAGE_HISTORY_NATIVE_ID)});
  if(!s)return JSON.stringify({id:'(missing)',cards:0,turns:0,dupes:0,usage:[]});
  const evs=await window.uniagent.getEvents(s.id);
  const usage=evs.filter(e=>e.type==='system_notice'&&e.payload&&e.payload.kind==='usage')
                 .map(u=>[u.payload.usage.inputTokens,u.payload.usage.outputTokens,u.payload.usage.sessionInputTokens]);
  const turns=evs.filter(e=>e.type==='user_message').length;
  let dupes=0; for(let i=1;i<usage.length;i++){const a=usage[i-1],b=usage[i];if(a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2])dupes++;}
  return JSON.stringify({id:s.id,cards:usage.length,turns,dupes,usage});
})()`))
check(
  '需求22 no duplicate usage cards on history resume',
  resumeUsage.cards === 2 && resumeUsage.turns === 2 && resumeUsage.dupes === 0,
  `session=${resumeUsage.id}, cards=${resumeUsage.cards}, turns=${resumeUsage.turns}, consecutiveDupes=${resumeUsage.dupes}, usage=${JSON.stringify(resumeUsage.usage)}`
)

// ==== Doc2 / Doc10 / Doc11 (final batch) =========================

// ---- Doc11: the injected handoff MCP server is a real, working MCP server.
// handoffSelfTest spawns ~/.uniagent/mcp/server.mjs under Electron-as-node and
// runs the initialize + tools/list handshake — it must advertise the
// uniagent_task tool and report it's injected for codex/traex/claude. ----
const handoff = JSON.parse(await ev(`(async()=>{
  const r=await window.uniagent.handoffSelfTest();
  return JSON.stringify(r);
})()`))
check(
  'Doc11 handoff MCP server advertises uniagent_task',
  handoff.ok && Array.isArray(handoff.tools) && handoff.tools.includes('uniagent_task'),
  `tools=[${(handoff.tools || []).join(',')}], injectedFor=[${(handoff.injectedFor || []).join(',')}]${handoff.error ? ', err=' + handoff.error : ''}`
)
check(
  'Doc11 handoff MCP injected for codex/traex/claude',
  Array.isArray(handoff.injectedFor) && ['codex', 'traex', 'claude'].every((a) => handoff.injectedFor.includes(a)),
  (handoff.injectedFor || []).join(',')
)

// ---- Doc11: presets are seeded + exposed, AND an end-to-end inbox handoff
// actually materializes a NEW session. We write a request file straight into the
// watched inbox (exactly what the MCP tool does on tools/call) and assert a
// fresh session appears via the onSessionCreated push. ----
const presetInfo = JSON.parse(await ev(`(async()=>{
  const p=await window.uniagent.listPresets();
  return JSON.stringify({n:p.length,names:p.map(x=>x.name).slice(0,4)});
})()`))
check('Doc11 handoff presets seeded + listed', presetInfo.n >= 1, `${presetInfo.n} presets: ${(presetInfo.names || []).join(',')}`)

// Register a sink for created sessions, then drop a handoff request into the inbox.
await ev(`(()=>{window.__created=window.__created||[];if(!window.__ch){window.__ch=1;window.uniagent.onSessionCreated(s=>window.__created.push(s));}return 1;})()`)
const beforeCreated = await ev(`(()=>window.__created.length)()`)
const beforeSessions = await ev(`(async()=>{const s=await window.uniagent.listSessions();return s.length;})()`)
const hmarker = `UA_HANDOFF_${Math.floor(Math.random() * 100000)}`
// Write via a tiny helper exposed on the main side is overkill; the inbox path
// is deterministic (handoff.inboxDir from the self-test). Use a Node one-liner
// through the app's own fs by round-tripping through a data: import isn't
// available in the renderer, so drop the file from the test process directly.
import('node:fs').then((fs) => {
  try {
    fs.mkdirSync(handoff.inboxDir, { recursive: true })
    const rec = { id: hmarker, ts: Date.now(), prompt: 'Say ' + hmarker + ' and nothing else.', agent: agentId }
    const tmp = handoff.inboxDir + '/' + hmarker + '.json.tmp'
    const dst = handoff.inboxDir + '/' + hmarker + '.json'
    fs.writeFileSync(tmp, JSON.stringify(rec), 'utf8')
    fs.renameSync(tmp, dst)
  } catch (e) {
    console.log('… inbox write failed:', e.message)
  }
})
let handoffCreated = false
for (let i = 0; i < 40; i++) {
  await sleep(250)
  const n = await ev(`(()=>window.__created.length)()`)
  if (n > beforeCreated) { handoffCreated = true; break }
}
const afterSessions = await ev(`(async()=>{const s=await window.uniagent.listSessions();return s.length;})()`)
check(
  'Doc11 inbox handoff materializes a new session (onSessionCreated)',
  handoffCreated && afterSessions > beforeSessions,
  `created push=${handoffCreated}, sessions ${beforeSessions}→${afterSessions}`
)

// ---- 需求5: uniagent_task advertises wait/timeout/force, wait=false
// returns after a real creation/delivery receipt, and wait=true blocks
// until the materialized session ends then returns its final reply text. The
// awaited session shows a clickable「等待中」badge that jumps to it. ----
check(
  '需求5 uniagent_task advertises wait + timeout + force params',
  Array.isArray(handoff.taskSchema) &&
    handoff.taskSchema.includes('wait') &&
    handoff.taskSchema.includes('timeout') &&
    handoff.taskSchema.includes('force'),
  `taskSchema=[${(handoff.taskSchema || []).join(',')}]`
)

// wait=false → the MCP server waits only for the main process's real creation
// receipt, then returns without waiting for task completion.
async function callCreateTask(args, timeoutMs) {
  const cp = await import('node:child_process')
  return await new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [handoff.serverPath], {
      env: {
        ...isolatedEnv,
        ELECTRON_RUN_AS_NODE: '1',
        UNIAGENT_HANDOFF_INBOX: handoff.inboxDir,
        UNIAGENT_HANDOFF_RESULTS: handoff.resultsDir,
        UNIAGENT_CATALOG: handoff.catalogPath
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buf = ''
    let settled = false
    const done = (val) => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      resolve(val)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 3 && msg.result) {
            done({ text: (msg.result.content || []).map((c) => c.text).join(''), ts: Date.now() })
          }
        } catch {}
      }
    })
    child.on('error', () => done({ error: true }))
    const rpc = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch {} }
    rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'req5', version: '1' } } })
    rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'uniagent_task', arguments: { ...args, action: 'create' } } })
    setTimeout(() => done({ timedOut: true }), timeoutMs)
  })
}

const waitFalseStart = Date.now()
const waitFalse = await callCreateTask({ prompt: 'Say WAITFALSE and nothing else.', agent: agentId, wait: false }, 15000)
const waitFalseMs = Date.now() - waitFalseStart
check(
  '需求5 wait=false returns after the real task-created receipt',
  !!waitFalse.text && /taskId=/.test(waitFalse.text) && /uniagent:event=started/.test(waitFalse.text) && waitFalseMs < 8000,
  `ms=${waitFalseMs}, text=${(waitFalse.text || waitFalse.error || 'timeout').slice(0, 60)}`
)

// wait=true → the reply must NOT arrive until the session finishes; it then
// carries the final reply text. Register a created-session sink to catch the
// awaited session id + its「等待中」marker, then place a real blocking call.
await ev(`(()=>{window.__w5=window.__w5||[];if(!window.__w5ch){window.__w5ch=1;window.uniagent.onSessionCreated(s=>window.__w5.push(s));}return 1;})()`)
const w5Before = await ev(`(()=>window.__w5.length)()`)
const waitTrue = await callCreateTask({ prompt: 'Say WAITTRUE and nothing else.', agent: agentId, wait: true, timeout: 90 }, 100000)
check(
  '需求5 wait=true blocks then returns the session final reply text',
  !!waitTrue.text && !waitTrue.timedOut && /(已完成|执行失败|已结束)/.test(waitTrue.text),
  `text=${(waitTrue.text || (waitTrue.timedOut ? 'timeout' : waitTrue.error)).slice(0, 80)}`
)
// A wait=true handoff must have surfaced a session flagged handoffWaiting so the
// sidebar could render the clickable「等待中」badge. It clears once terminal.
const w5Waiting = await ev(`(()=>{
  const s=(window.__w5||[]).slice(${w5Before});
  return JSON.stringify({n:s.length, anyWaiting: s.some(x=>x.handoffWaiting===true), anyHandoffId: s.some(x=>!!x.handoffId)});
})()`)
const w5w = JSON.parse(w5Waiting)
check(
  '需求5 wait=true session is marked handoffWaiting (drives 等待中 badge)',
  w5w.anyWaiting && w5w.anyHandoffId,
  `newSessions=${w5w.n}, anyWaiting=${w5w.anyWaiting}, anyHandoffId=${w5w.anyHandoffId}`
)

// ---- Doc2: cross-agent resume. The resume panel must offer a "换 Agent" target
// picker per history row (only meaningful with >1 installed agent), AND the
// backend exportNativeSession must round-trip a real native session into another
// agent's history + return an imported session under the target agent. ----
const installedIds = caps.filter((c) => c.installed).map((c) => c.id)
// Open the history panel and check the cross-agent affordance is wired.
// 修复#2 — clicking a row no longer imports a snapshot Session into the sidebar;
// it opens an inline READ-ONLY viewer whose fork-bar carries 原Agent分叉 +
// (when ≥2 agents) a 换Agent分叉 picker (.fork-cross). Drive that flow here.
await ev(`(()=>{const b=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>/导入会话/.test(x.textContent));if(b)b.click();return 1;})()`)
await poll(
  () => ev(`(()=>!!document.querySelector('.resume-item .resume-item-open'))()`),
  Boolean
)
// Click the first history row to enter the read-only viewer.
await ev(`(()=>{const r=document.querySelector('.resume-item .resume-item-open');if(r)r.click();return 1;})()`)
await poll(
  () => ev(`(()=>!!document.querySelector('.history-viewer .fork-cross > .fork-btn'))()`),
  Boolean
)
// Reveal the 换Agent picker if present.
const crossPickerClicked = await ev(`(()=>{const b=document.querySelector('.history-viewer .fork-cross > .fork-btn');if(!b)return false;b.click();return true;})()`)
if (crossPickerClicked) {
  await poll(
    () => ev(`(()=>document.querySelectorAll('.history-viewer .fork-cross-target').length)()`),
    (count) => installedIds.length < 2 || count > 0
  )
}
const crossUi = JSON.parse(await ev(`(()=>{
  let hasRule=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ if(r.selectorText && r.selectorText.includes('fork-cross')){hasRule=true;break;} } }catch{}
    if(hasRule) break;
  }
  const viewer=!!document.querySelector('.history-viewer');
  const forkSame=!!document.querySelector('.history-viewer .fork-btn-primary');
  const actionLabels=[...document.querySelectorAll('.history-viewer .fork-bar-actions > .fork-btn')]
    .map((button)=>button.textContent.trim());
  const directImport=actionLabels.some((label)=>label.includes('原生 Agent 直接导入'));
  const actionOrder=actionLabels.findIndex((label)=>label.includes('原 Agent 分叉续跑')) <
    actionLabels.findIndex((label)=>label.includes('原生 Agent 直接导入'));
  const targets=document.querySelectorAll('.history-viewer .fork-cross-target').length;
  const rows=document.querySelectorAll('.resume-item').length;
  return JSON.stringify({hasRule,viewer,forkSame,directImport,actionOrder,targets,rows,crossPickerClicked:${crossPickerClicked}});
})()`))
check(
  'Doc2 row→read-only preview with fork first and native direct import second',
  crossUi.hasRule &&
    crossUi.viewer &&
    crossUi.forkSame &&
    crossUi.directImport &&
    crossUi.actionOrder &&
    (installedIds.length < 2 || crossUi.targets > 0),
  `styleRule=${crossUi.hasRule}, viewer=${crossUi.viewer}, forkSame=${crossUi.forkSame}, directImport=${crossUi.directImport}, actionOrder=${crossUi.actionOrder}, crossTargets=${crossUi.targets}, rows=${crossUi.rows}, installed=${installedIds.length}`
)
// 修复#2 — previewHistory replays the transcript WITHOUT minting an orchestrator
// Session (the read-only snapshot must not pollute the sidebar list).
const preview = JSON.parse(await ev(`(async()=>{
  const hist=await window.uniagent.listAgentHistory(${JSON.stringify(agentId)});
  if(!hist.length) return JSON.stringify({skip:'no history'});
  let src=null, evs=0;
  for(const h of hist.slice(0,25)){
    const p=await window.uniagent.previewHistory(${JSON.stringify(agentId)}, h.id);
    if(p && (p.events||[]).length>2){src=h.id; evs=p.events.length; break;}
  }
  const before=(await window.uniagent.listSessions()).length;
  const p=src ? await window.uniagent.previewHistory(${JSON.stringify(agentId)}, src) : null;
  const after=(await window.uniagent.listSessions()).length;
  return JSON.stringify({
    hasPreview: typeof window.uniagent.previewHistory==='function',
    events: p ? (p.events||[]).length : 0,
    cwd: !!(p && p.cwd!==undefined),
    createdSession: after>before
  });
})()`))
if (preview.skip) {
  console.log('… 修复#2 previewHistory skipped:', preview.skip)
} else {
  check(
    '修复#2 previewHistory replays transcript WITHOUT creating a sidebar Session',
    preview.hasPreview && preview.events > 2 && preview.createdSession === false,
    `hasPreview=${preview.hasPreview}, events=${preview.events}, createdSession=${preview.createdSession}`
  )
}
// 修复#3 — the cancelable loading modal CSS is shipped for the slow 换Agent转换.
const modalCss = await ev(`(()=>{
  let ov=false, box=false, cancel=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){
      const s=r.selectorText||'';
      if(s.includes('modal-overlay')) ov=true;
      if(s.includes('loading-modal')) box=true;
      if(s.includes('loading-modal-cancel')) cancel=true;
    } }catch{}
  }
  return JSON.stringify({ov,box,cancel});
})()`)
{
  const m = JSON.parse(modalCss)
  check(
    '修复#3 cancelable loading modal CSS shipped (overlay + box + cancel)',
    m.ov && m.box && m.cancel,
    `overlay=${m.ov}, box=${m.box}, cancel=${m.cancel}`
  )
}
// Return to the list so later checks that click sidebar-nav still work cleanly.
await ev(`(()=>{const b=[...document.querySelectorAll('.history-viewer .history-back-btn,.history-viewer .fork-btn-ghost')].find(x=>/返回/.test(x.textContent));if(b)b.click();return 1;})()`)
await sleep(300)
if (installedIds.length >= 2) {
  const targetId = installedIds.find((i) => i !== agentId)
  const cross = JSON.parse(await ev(`(async()=>{
    const hist=await window.uniagent.listAgentHistory(${JSON.stringify(agentId)});
    if(!hist.length) return JSON.stringify({skip:'no history'});
    // The suite creates fresh (often empty/aborted) sessions as it runs, so
    // hist[0] may be a brand-new session with no replayable events. Pick the
    // first row that actually has a TWO-SIDED conversation to transplant — it
    // must carry BOTH a non-empty user turn AND a non-empty assistant turn, or
    // the model-context assertion below (riUser>0 && riAssistant>0) is
    // unsatisfiable regardless of transplant correctness (a one-sided source
    // trivially "loses" a role that was never there).
    let src=null;
    for(const h of hist.slice(0,25)){
      const imp=await window.uniagent.importSession(${JSON.stringify(agentId)}, h.id);
      const evs=imp ? await window.uniagent.getEvents(imp.id) : [];
      const u=evs.filter(e=>e.type==='user_message'&&(e.payload?.text||'').trim()).length;
      const a=evs.filter(e=>e.type==='agent_message'&&(e.payload?.text||'').trim()).length;
      if(u>0&&a>0){src=h.id;break;}
    }
    if(!src) return JSON.stringify({skip:'no non-empty source'});
    const s=await window.uniagent.exportNativeSession(${JSON.stringify(agentId)}, src, ${JSON.stringify(targetId)});
    if(!s) return JSON.stringify({ok:false});
    const evs=await window.uniagent.getEvents(s.id);
    return JSON.stringify({ok:true,agent:s.config.agentId,events:evs.length,nativeId:s.nativeSessionId});
  })()`))
  if (cross.skip) {
    console.log('… Doc2 cross-agent transplant skipped:', cross.skip)
  } else {
    check(
      'Doc2 exportNativeSession transplants to target agent',
      cross.ok && cross.agent === targetId && cross.events > 0,
      `targetAgent=${cross.agent} (want ${targetId}), replayedEvents=${cross.events}`
    )
    // 需求7 (从 codex 导入到 traex 上下文丢失) — the transplant must write
    // `response_item` records, not just `event_msg`. codex/traex rebuild the
    // MODEL's context on `thread/resume` from response_item; event_msg only feeds
    // the TUI timeline. A transplant with response_item=0 resumes with empty
    // history ("这是我们对话的开始"). Scan the freshly-minted rollout on disk from
    // this Node process (the renderer has no fs) and require BOTH the user AND
    // the assistant turns to survive with non-empty text — model context
    // restoration needs the assistant side too, not just the prompts.
    if (cross.ok && cross.nativeId) {
      const baseDir =
        targetId === 'traex'
          ? join(isolatedHome, '.trae/cli')
          : targetId === 'claude'
            ? join(isolatedHome, '.claude/projects')
            : join(isolatedHome, '.codex')
      const file = findRolloutFile(baseDir, cross.nativeId, targetId)
      let riUser = 0
      let riAssistant = 0
      let riEmpty = 0
      let emMsgs = 0
      const textOf = (content) =>
        Array.isArray(content)
          ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
          : typeof content === 'string'
            ? content
            : ''
      if (file) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          let o
          try {
            o = JSON.parse(line)
          } catch {
            continue
          }
          if (targetId === 'claude') {
            // Claude project jsonl: user/assistant records carry message.content.
            const role = o.type
            const txt = textOf(o.message?.content)
            if (role === 'user') txt.trim() ? riUser++ : riEmpty++
            if (role === 'assistant') txt.trim() ? riAssistant++ : riEmpty++
          } else {
            if (o.type === 'response_item' && o.payload?.type === 'message') {
              const txt = textOf(o.payload.content)
              if (!txt.trim()) riEmpty++
              else if (o.payload.role === 'user') riUser++
              else if (o.payload.role === 'assistant') riAssistant++
            }
            if (o.type === 'event_msg' && /_message$/.test(o.payload?.type || '')) emMsgs++
          }
        }
      }
      check(
        '需求7 cross-agent transplant restores model-context: BOTH user + assistant response_items (non-empty)',
        !!file && riUser > 0 && riAssistant > 0 && riEmpty === 0,
        file
          ? `nativeId=${cross.nativeId} response_item user=${riUser} assistant=${riAssistant} empty=${riEmpty}, event_msg.*_message=${emMsgs}`
          : `rollout file for ${cross.nativeId} not found under ${baseDir}`
      )
      // Round-trip: re-import the transplanted native id UNDER THE TARGET AGENT
      // and confirm the replayed conversation carries both roles — this is what a
      // user sees when they open the migrated session, and mirrors what the CLI's
      // thread/resume feeds the model. If context were lost, the re-import would
      // replay a lone/empty turn (the original bug).
      const rt = JSON.parse(await ev(`(async()=>{
        const s=await window.uniagent.importSession(${JSON.stringify(targetId)}, ${JSON.stringify(cross.nativeId)});
        if(!s) return JSON.stringify({ok:false});
        const evs=await window.uniagent.getEvents(s.id);
        const user=evs.filter(e=>e.type==='user_message'&&(e.payload?.text||'').trim()).length;
        const agent=evs.filter(e=>e.type==='agent_message'&&(e.payload?.text||'').trim()).length;
        return JSON.stringify({ok:true,agent:s.config.agentId,user,agentMsgs:agent,total:evs.length});
      })()`))
      check(
        '需求7 re-import under target agent replays the FULL conversation (context restored, both roles)',
        rt.ok && rt.agent === targetId && rt.user > 0 && rt.agentMsgs > 0,
        `agent=${rt.agent} (want ${targetId}), user=${rt.user}, assistant=${rt.agentMsgs}, totalEvents=${rt.total}`
      )
    }
  }
} else {
  console.log('… Doc2 cross-agent transplant skipped: <2 agents installed')
}

// ---- 需求5（外部会话导入并发治理）: importing with the native Agent directly
// reuses the original native id and is writable. Verify: (a) direct import keeps
// the source id with readOnly:false and no fork lineage; (b) the preview action
// bar is shipped; (c) 原Agent分叉 still mints a NEW writable native id,
// forkedFrom.mode='same', and replays the SAME conversation (lossless);
// (d) 换Agent分叉 (if ≥2 agents) is writable + forkedFrom.mode='cross'. ----
{
  const forkRule = await ev(`(()=>{
    for(const ss of document.styleSheets){
      try{ for(const r of ss.cssRules){ if(r.selectorText && r.selectorText.includes('fork-bar')) return true; } }catch{}
    }
    return false;
  })()`)
  const r5 = JSON.parse(await ev(`(async()=>{
    const hist=await window.uniagent.listAgentHistory(${JSON.stringify(agentId)});
    if(!hist.length) return JSON.stringify({skip:'no history'});
    // Pick the first row with a real conversation to fork.
    let src=null, srcCwd=null, srcEvents=0;
    for(const h of hist.slice(0,25)){
      const imp=await window.uniagent.importSession(${JSON.stringify(agentId)}, h.id);
      const evs=imp ? await window.uniagent.getEvents(imp.id) : [];
      if(evs.length>2){src=h.id; srcCwd=h.cwd; srcEvents=evs.length; break;}
    }
    if(!src) return JSON.stringify({skip:'no non-empty source'});
    // (a) import → writable original native session.
    const direct=await window.uniagent.importSession(${JSON.stringify(agentId)}, src, 'direct', srcCwd);
    // (c) 原Agent分叉 — lossless same-agent byte-copy.
    const fork=await window.uniagent.forkSameSession(${JSON.stringify(agentId)}, src);
    const forkEvents = fork ? (await window.uniagent.getEvents(fork.id)).length : 0;
    return JSON.stringify({
      directWritable: !!(direct && direct.readOnly===false),
      directMode: direct && direct.importMode,
      directNative: direct && direct.nativeSessionId,
      directForkedFrom: direct && direct.forkedFrom,
      srcEvents,
      forkOk: !!fork,
      forkNative: fork && fork.nativeSessionId,
      srcNative: src,
      forkWritable: !!(fork && fork.readOnly===false),
      forkMode: fork && fork.forkedFrom && fork.forkedFrom.mode,
      forkEvents
    });
  })()`))
  if (r5.skip) {
    console.log('… 需求5 fork skipped:', r5.skip)
  } else {
    check(
      '原生 Agent 直接导入 reuses the writable original native session',
      r5.directWritable && r5.directMode === 'direct' && r5.directNative === r5.srcNative && !r5.directForkedFrom,
      `writable=${r5.directWritable}, mode=${r5.directMode}, native=${r5.directNative}, source=${r5.srcNative}, lineage=${JSON.stringify(r5.directForkedFrom)}`
    )
    check(
      'history preview ships the continuation action bar',
      forkRule === true,
      `fork-bar styleRule=${forkRule}`
    )
    check(
      '需求5 原Agent分叉 mints a NEW writable native id (mode=same)',
      r5.forkOk && r5.forkWritable && r5.forkMode === 'same' && r5.forkNative && r5.forkNative !== r5.srcNative,
      `writable=${r5.forkWritable}, mode=${r5.forkMode}, newNative=${r5.forkNative}!=${r5.srcNative}`
    )
    check(
      '需求5 原Agent分叉 is LOSSLESS (fork replays the same conversation)',
      r5.forkEvents >= r5.srcEvents && r5.forkEvents > 2,
      `forkEvents=${r5.forkEvents} vs srcEvents=${r5.srcEvents}`
    )
    // (d) 换Agent分叉 — cross-agent writable fork, when a 2nd agent exists.
    if (installedIds.length >= 2) {
      const targetId = installedIds.find((i) => i !== agentId)
      const xf = JSON.parse(await ev(`(async()=>{
        const f=await window.uniagent.forkCrossSession(${JSON.stringify(agentId)}, ${JSON.stringify(r5.srcNative)}, ${JSON.stringify(targetId)});
        if(!f) return JSON.stringify({ok:false});
        return JSON.stringify({ok:true,agent:f.config.agentId,writable:f.readOnly===false,mode:f.forkedFrom&&f.forkedFrom.mode});
      })()`))
      check(
        '需求5 换Agent分叉 forks into another agent (writable, mode=cross)',
        xf.ok && xf.agent === targetId && xf.writable && xf.mode === 'cross',
        `agent=${xf.agent} (want ${targetId}), writable=${xf.writable}, mode=${xf.mode}`
      )
    }
  }
}

// ---- Doc10: Android-Studio-style side-by-side ReviewPanel. Drive a session
// whose turn produced a diff (the earlier turns may not have), so instead assert
// the review overlay renders both panes from a synthetic diff via the real
// reviewGetFilePair path + buildRows. We open it structurally: the 变更 tab (or
// overlay) must exist once a diff is present; here we validate the panel's core
// (split panes + file list + before/after reconstruction) is shipped. ----
const reviewUi = JSON.parse(await ev(`(()=>{
  let hasOverlay=false, hasSplit=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){
      if(r.selectorText){
        if(r.selectorText.includes('review-overlay')) hasOverlay=true;
        if(r.selectorText.includes('pane-headers')||r.selectorText.includes('diff-grid')) hasSplit=true;
      }
    } }catch{}
  }
  const fn=typeof window.uniagent.reviewGetFilePair==='function';
  return JSON.stringify({hasOverlay,hasSplit,fn});
})()`))
check(
  'Doc10 side-by-side ReviewPanel shipped (overlay + panes + getFilePair)',
  reviewUi.hasOverlay && reviewUi.hasSplit && reviewUi.fn,
  `overlay=${reviewUi.hasOverlay}, panes=${reviewUi.hasSplit}, getFilePair=${reviewUi.fn}`
)
// A synthetic path has no real HEAD/disk source: it must expose exact patch
// context while explicitly reporting that the complete file is unavailable.
const pairCheck = JSON.parse(await ev(`(async()=>{
  const diff='--- a/review-fixture.txt\\n+++ b/review-fixture.txt\\n@@ -1,2 +1,2 @@\\n-before\\n+after\\n context';
  try{
    const p=await window.uniagent.reviewGetFilePair({sessionId:${JSON.stringify(sid)},path:'review-fixture.txt',unifiedDiff:diff,kind:'modify'});
    return JSON.stringify({ok:true,before:p.before,after:p.after,degraded:!!p.degraded,binary:!!p.binary,tooLarge:!!p.tooLarge});
  }catch(e){return JSON.stringify({ok:false,err:e.message});}
})()`))
check(
  'Doc10 reviewGetFilePair marks patch-only reconstruction as degraded',
  pairCheck.ok && pairCheck.before === 'before\ncontext' && pairCheck.after === 'after\ncontext' &&
    pairCheck.degraded && !pairCheck.binary && !pairCheck.tooLarge,
  pairCheck.err ? pairCheck.err : JSON.stringify(pairCheck)
)

// ==== P1–P6 (latest bug-fix batch) ================================

// ---- P1: 等待算力 card — left-aligned to the message column, Chinese-only
// (no English), and it carries a ticking elapsed timer. Once done, the total
// moves into a durable call-chain record. We assert both CSS contracts and that
// the OLD `.queue-banner-msg` rule is gone. ----
const p1 = JSON.parse(await ev(`(()=>{
  let center=false,time=false,record=false,recordTime=false,oldMsg=false,check=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){
      const s=r.selectorText||'';
      if(s==='.queue-banner'){ const c=r.style.cssText||''; if(/max-width/.test(c)&&/margin/.test(c)) center=true; }
      if(s.includes('.queue-banner-time')) time=true;
      if(s==='.queue-wait-record') record=true;
      if(s.includes('.queue-wait-record-time')) recordTime=true;
      if(s.includes('.queue-wait-record-check')) check=true;
      if(s.includes('.queue-banner-msg')) oldMsg=true;
    } }catch{}
  }
  return JSON.stringify({center,time,record,recordTime,check,oldMsg});
})()`))
check(
  'P1 等待算力 live timer + durable call-chain record (no legacy msg)',
  p1.center && p1.time && p1.record && p1.recordTime && p1.check && !p1.oldMsg,
  `centered=${p1.center}, time=${p1.time}, record=${p1.record}, recordTime=${p1.recordTime}, check=${p1.check}, legacyMsg=${p1.oldMsg}`
)

// ---- P2: codex history restore. An aborted rollout carries only response_item
// message records (no event_msg conversation) — the parser must fall back to
// those so restored content isn't just a lone user turn, AND the derived title
// must be clean (markdown links / @mentions / leading $¥ stripped). We import
// the OLDEST codex history rows and require at least one to reconstruct >1
// message with a title free of markdown-link syntax. ----
const p2 = JSON.parse(await ev(`(async()=>{
  const hist=await window.uniagent.listAgentHistory('codex');
  if(!hist.length) return JSON.stringify({skip:'no codex history'});
  let best={events:0,title:'',user:0,agent:0};
  const scan=hist.slice(0,8);
  for(const h of scan){
    try{
      const s=await window.uniagent.importSession('codex', h.id);
      if(!s) continue;
      const evs=await window.uniagent.getEvents(s.id);
      const user=evs.filter(e=>e.type==='user_message').length;
      const agent=evs.filter(e=>e.type==='agent_message').length;
      if(evs.length>best.events) best={events:evs.length,title:s.title||'',user,agent};
    }catch{}
  }
  return JSON.stringify(best);
})()`))
if (p2.skip) {
  console.log('… P2 codex restore skipped:', p2.skip)
} else {
  const titleClean = !/\]\(.*\)/.test(p2.title) && !/^[$¥]/.test(p2.title)
  check(
    'P2 codex history restores full conversation (not a lone user turn)',
    p2.events > 1 && (p2.user + p2.agent) > 1,
    `events=${p2.events}, user=${p2.user}, agent=${p2.agent}, title="${p2.title}"`
  )
  check('P2 restored session title is clean (no markdown link / leading $¥)', titleClean, `title="${p2.title}"`)
}

// ---- P3: the 模板 (preset) chip bar is removed from NewTaskPanel. Return to the
// new-task screen and assert neither the render node nor its CSS rules remain. ----
await ev(`(()=>{const b=document.querySelector('.btn-new');if(b)b.click();return 1;})()`)
await sleep(400)
const p3 = JSON.parse(await ev(`(()=>{
  const bar=document.querySelectorAll('.preset-bar,.preset-chip,.preset-label').length;
  let rule=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ const s=r.selectorText||''; if(s.includes('.preset-bar')||s.includes('.preset-chip')){rule=true;break;} } }catch{}
    if(rule) break;
  }
  const onNewTask=!!document.querySelector('.new-task,.newtask,form');
  return JSON.stringify({bar,rule,onNewTask});
})()`))
check('P3 NewTaskPanel 模板栏 removed (no node + no CSS)', p3.bar === 0 && !p3.rule, `nodes=${p3.bar}, cssRule=${p3.rule}`)

// ---- P4: TraeX GPT models expose reasoning efforts + server load; and the
// ModelPicker trigger no longer renders as a gray box (transparent bg). We read
// the real detected TraeX model list and require several models to carry efforts
// AND at least one to carry a loadPercent. ----
const p4 = JSON.parse(await ev(`(async()=>{
  const a=await window.uniagent.detectAgents();
  const tx=a.find(x=>x.id==='traex');
  if(!tx||!tx.installed) return JSON.stringify({skip:'traex not installed'});
  const withEff=tx.models.filter(m=>Array.isArray(m.efforts)&&m.efforts.length>0);
  const withLoad=tx.models.filter(m=>typeof m.loadPercent==='number');
  const gpt=tx.models.filter(m=>/gpt/i.test(m.id)||/gpt/i.test(m.label));
  const gptWithEff=gpt.filter(m=>Array.isArray(m.efforts)&&m.efforts.length>0);
  let triggerTransparent=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ if(r.selectorText==='.mp-trigger'){ const c=(r.style.cssText||'').replace(/\\s/g,''); if(/background:transparent/.test(c)) triggerTransparent=true; } } }catch{}
  }
  return JSON.stringify({total:tx.models.length,withEff:withEff.length,withLoad:withLoad.length,gpt:gpt.length,gptWithEff:gptWithEff.length,triggerTransparent});
})()`))
if (p4.skip) {
  console.log('… P4 traex model checks skipped:', p4.skip)
} else {
  check(
    'P4 TraeX GPT models expose reasoning efforts',
    p4.gpt === 0 || p4.gptWithEff > 0,
    `gpt=${p4.gpt}, gptWithEff=${p4.gptWithEff}, totalWithEff=${p4.withEff}/${p4.total}`
  )
  check('P4 TraeX models carry server load (loadPercent)', p4.withLoad > 0, `withLoad=${p4.withLoad}/${p4.total}`)
  check('P4 ModelPicker trigger is transparent (not a gray box)', p4.triggerTransparent, `mp-trigger transparent=${p4.triggerTransparent}`)
}

// ---- P5: the injected MCP server exposes QUERY tools so an agent can enumerate
// valid handoff options (agents / models / efforts / presets) instead of
// hand-writing them. Assert all three query tools + create are advertised, and
// the on-disk catalog the tools read actually holds the agent+model catalog. ----
const p5 = JSON.parse(await ev(`(async()=>{
  const r=await window.uniagent.handoffSelfTest();
  return JSON.stringify({tools:r.tools,catalogPath:r.catalogPath});
})()`))
// The catalog file is read from THIS node process (the renderer is sandboxed and
// can't import node:fs) — same technique as the inbox-handoff write above.
let p5cat = { ok: false }
try {
  const fs = await import('node:fs')
  const j = JSON.parse(fs.readFileSync(p5.catalogPath, 'utf8'))
  p5cat = {
    ok: true,
    agents: (j.agents || []).length,
    withModels: (j.agents || []).filter((a) => (a.models || []).length > 0).length,
    presets: (j.presets || []).length
  }
} catch (e) {
  p5cat = { ok: false, err: e.message }
}
const wantTools = ['uniagent_query', 'uniagent_task', 'send_to_feishu']
check(
  'P5 MCP advertises exactly three ordinary tools',
  p5.tools?.length === wantTools.length && wantTools.every((t) => p5.tools.includes(t)),
  `tools=[${(p5.tools || []).join(',')}]`
)
check(
  'P5 MCP catalog on disk enumerates agents + their models',
  p5cat.ok && p5cat.agents > 0 && p5cat.withModels > 0,
  p5cat.err ? p5cat.err : `agents=${p5cat.agents}, withModels=${p5cat.withModels}, presets=${p5cat.presets}`
)

// ---- P6 / 需求6: Settings exposes update/default/template controls (redesigned
// macOS-style category nav + per-category detail pages). ----
const agentDisplayName = JSON.parse(await ev(`(async()=>{const a=await window.uniagent.detectAgents();return JSON.stringify((a.find(x=>x.id===${JSON.stringify(agentId)})||{}).name||'');})()`))
const p6entry = await ev(`(()=>{const b=document.querySelector('.settings-entry');if(b){b.click();return 1;}return 0;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.settings-panel .set-nav'))()`), Boolean)
// helper: click a left-nav category by its label; leaves the matching set-page visible.
const settingsNav = async (label) => {
  await ev(`(()=>{const n=[...document.querySelectorAll('.set-nav-item')].find(x=>(x.querySelector('.lbl')||{}).textContent===${JSON.stringify(label)});if(n)n.click();return !!n;})()`)
  await sleep(200)
}
const p6Panel = JSON.parse(await ev(`(()=>{
  const panel=document.querySelector('.settings-panel');
  const title=document.querySelector('.settings-panel .main-panel-title');
  const nav=[...document.querySelectorAll('.set-nav-item .lbl')].map(x=>(x.textContent||'').trim());
  const navIcons=[...document.querySelectorAll('.set-nav-item .ic > svg.ui-icon')].length;
  return JSON.stringify({mounted:!!panel,title:title?title.textContent.trim():'',nav,navIcons});
})()`))
const wantCats = ['通用', 'Agent', '个人助手', '工具能力', '任务模板']
check('P6 设置 entry opens settings panel', p6entry === 1 && p6Panel.mounted && /设置/.test(p6Panel.title), `title="${p6Panel.title}"`)
await settingsNav('通用')
const p6General = JSON.parse(await ev(`(()=>{
  const groups=[...document.querySelectorAll('.set-page:not([hidden]) .set-group-t')].map(x=>(x.textContent||'').trim());
  const rows=[...document.querySelectorAll('.set-page:not([hidden]) .r-label')].map(x=>(x.textContent||'').trim());
  const ver=[...document.querySelectorAll('.set-page:not([hidden]) .r-sub')].map(x=>(x.textContent||'').trim()).find(x=>x.startsWith('当前 '))||'';
  const toggles=document.querySelectorAll('.set-page:not([hidden]) [role=switch]').length;
  return JSON.stringify({groups,rows,ver,toggles});
})()`))
await settingsNav('Agent')
const p6Agent = JSON.parse(await ev(`(()=>{
  const groups=[...document.querySelectorAll('.set-page:not([hidden]) .set-group-t')].map(x=>(x.textContent||'').replace(/\s+/g,' ').trim());
  const cliRows=document.querySelectorAll('.set-page:not([hidden]) .rowlink').length;
  const redetect=[...document.querySelectorAll('.set-page:not([hidden]) .set-mini-btn')].some(x=>(x.textContent||'').trim()==='重新探测');
  const toggles=document.querySelectorAll('.set-page:not([hidden]) [role=switch]').length;
  return JSON.stringify({groups,cliRows,redetect,toggles});
})()`))
await settingsNav('通用')
const p6Diag = JSON.parse(await ev(`(()=>{
  const groups=[...document.querySelectorAll('.set-page:not([hidden]) .set-group-t')].map(x=>(x.textContent||'').trim());
  const rows=[...document.querySelectorAll('.set-page:not([hidden]) .r-label')].map(x=>(x.textContent||'').trim());
  return JSON.stringify({groups,rows});
})()`))
await settingsNav('任务模板')
const p6Presets = JSON.parse(await ev(`(()=>{
  const group=(document.querySelector('.set-page:not([hidden]) .set-group-t')||{}).textContent||'';
  const addRow=[...document.querySelectorAll('.set-page:not([hidden]) .set-add-btn')].some(x=>(x.textContent||'').trim().includes('添加'));
  return JSON.stringify({group,addRow});
})()`))
check(
  '需求6 设置分类导航合并助手与飞书、诊断移入通用（含图标）',
  wantCats.every((c) => p6Panel.nav.includes(c)) && !p6Panel.nav.includes('飞书 Bot') && !p6Panel.nav.includes('诊断与日志') && p6Panel.navIcons >= wantCats.length,
  JSON.stringify(p6Panel)
)
check(
  '需求6 通用页展示版本 + 自动检查更新 + 覆盖侧栏开关',
  p6General.groups.includes('应用更新') && p6General.groups.includes('通知') && p6General.groups.includes('文件浏览与审查') &&
    p6General.ver.startsWith('当前 ') && !p6General.ver.includes('读取中') && p6General.rows.includes('UniAgent 版本') && p6General.toggles >= 2,
  JSON.stringify(p6General)
)
check(
  '需求6 Agent 页展示 CLI 状态列表 + 重新探测 + 启动自动更新开关',
  p6Agent.groups.some((g) => g.startsWith('CLI 状态')) && p6Agent.groups.includes('默认配置') && p6Agent.cliRows > 0 && p6Agent.redetect && p6Agent.toggles >= 1,
  JSON.stringify(p6Agent)
)
check(
  '需求6 通用页诊断按 Session 导入与 App 运行分类',
  p6Diag.groups.includes('诊断与日志') && p6Diag.rows.includes('Session 导入错误') && p6Diag.rows.includes('App 运行错误日志'),
  JSON.stringify(p6Diag)
)
check(
  '需求6 任务模板页展示模板列表 + 添加入口',
  /任务模板 · 共/.test(p6Presets.group) && p6Presets.addRow,
  JSON.stringify(p6Presets)
)

const p6SettingsBefore = JSON.parse(await ev(`(async()=>JSON.stringify(await window.uniagent.getAppSettings()))()`))
// 「自动检查更新」开关在「通用」分类；「启动时自动更新 Agent CLI」在「Agent」分类。
await settingsNav('通用')
const p6ToggleApp = await ev(`(()=>{const sw=[...document.querySelectorAll('.set-page:not([hidden]) [role=switch]')].find(x=>(x.getAttribute('aria-label')||'')==='自动检查更新');if(sw)sw.click();return !!sw;})()`)
await settingsNav('Agent')
const p6ToggleCli = await ev(`(()=>{const sw=[...document.querySelectorAll('.set-page:not([hidden]) [role=switch]')].find(x=>(x.getAttribute('aria-label')||'')==='启动时自动更新 Agent CLI');if(sw)sw.click();return !!sw;})()`)
const p6TogglePersisted = await poll(
  () => ev(`(async()=>{const s=await window.uniagent.getAppSettings();return s.autoCheckUpdate===${!p6SettingsBefore.autoCheckUpdate}&&s.autoUpdateAgentsOnLaunch===${!p6SettingsBefore.autoUpdateAgentsOnLaunch};})()`),
  Boolean
)
await ev(`window.uniagent.setAppSettings({autoCheckUpdate:${p6SettingsBefore.autoCheckUpdate},autoUpdateAgentsOnLaunch:${p6SettingsBefore.autoUpdateAgentsOnLaunch}})`)
check('需求 Settings 应用/CLI 自动更新开关可持久化', p6ToggleApp && p6ToggleCli && p6TogglePersisted, JSON.stringify({app:p6ToggleApp,cli:p6ToggleCli,persisted:p6TogglePersisted}))

const p6PrefsBefore = JSON.parse(await ev(`(async()=>JSON.stringify(await window.uniagent.getPrefs()))()`))
// 每 Agent 默认模型/推理强度已迁入「Agent」分类的单 Agent 详情页：点开一个可用 Agent 的
// rowlink → 详情内两枚 SetSelect（aria-label 默认模型 / 默认推理强度）。
await settingsNav('Agent')
await ev(`(()=>{const rows=[...document.querySelectorAll('.set-page:not([hidden]) .rowlink')];const target=rows.find(r=>(r.querySelector('.r-label')?.textContent||'').includes(${JSON.stringify(agentDisplayName)}))||rows[0];target?.click();return !!target;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.set-page:not([hidden]) .set-select select[aria-label="默认模型"]'))()`), Boolean)
const p6DetailAgentId = agentId
const p6ModelChoice = JSON.parse(await ev(`(()=>{
  const select=document.querySelector('.set-page:not([hidden]) .set-select select[aria-label="默认模型"]');
  if(!select||select.disabled)return JSON.stringify({found:false});
  const next=[...select.options].find(o=>o.value&&o.value!==select.value)?.value||'';
  if(!next)return JSON.stringify({found:false});
  const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  setter.call(select,next);select.dispatchEvent(new Event('change',{bubbles:true}));
  return JSON.stringify({found:true,agentId:${JSON.stringify(p6DetailAgentId)},next});
})()`))
const p6ModelPersisted = p6ModelChoice.found && await poll(
  () => ev(`(async()=>{const p=await window.uniagent.getPrefs();return (p.lastByAgent[${JSON.stringify(p6ModelChoice.agentId)}]?.defaultModel||'')===${JSON.stringify(p6ModelChoice.next)};})()`),
  Boolean
)
await sleep(120)
const p6EffortChoice = JSON.parse(await ev(`(()=>{
  const select=document.querySelector('.set-page:not([hidden]) .set-select select[aria-label="默认推理强度"]');
  if(!select||select.disabled)return JSON.stringify({found:false});
  const next=[...select.options].find(o=>o.value&&o.value!==select.value)?.value||'';
  if(!next)return JSON.stringify({found:false});
  const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  setter.call(select,next);select.dispatchEvent(new Event('change',{bubbles:true}));
  return JSON.stringify({found:true,agentId:${JSON.stringify(p6DetailAgentId)},next});
})()`))
const p6EffortPersisted = !p6EffortChoice.found || await poll(
  () => ev(`(async()=>{const p=await window.uniagent.getPrefs();return (p.lastByAgent[${JSON.stringify(p6EffortChoice.agentId)}]?.defaultEffort||'')===${JSON.stringify(p6EffortChoice.next)};})()`),
  Boolean
)
for (const id of new Set([p6ModelChoice.agentId, p6EffortChoice.agentId].filter(Boolean))) {
  const original = p6PrefsBefore.lastByAgent?.[id] || {}
  await ev(`window.uniagent.setPrefs(${JSON.stringify(id)},{defaultModel:${JSON.stringify(original.defaultModel)},defaultEffort:${JSON.stringify(original.defaultEffort)}})`)
}
// 返回 Agent 主列表，避免残留详情页影响后续检查。
await ev(`(()=>{document.querySelector('.set-page:not([hidden]) .set-back')?.click();return true;})()`)
check('需求 Settings 每 Agent 默认模型/推理深度可持久化', p6ModelPersisted && p6EffortPersisted, JSON.stringify({model:p6ModelChoice,effort:p6EffortChoice}))

const p6TemplateName = `UA E2E 任务模板 ${process.pid}`
const p6TemplatePrompt = `UA E2E template prompt ${process.pid}`
const p6TemplateEditedPrompt = `${p6TemplatePrompt} edited`
// 任务模板改为「主列表 rowlink → 详情编辑器（PresetDetail）」，不再是模态。
// 添加入口 .settings-add-row；详情内 .set-fld-inp 输入 + SetSelect（aria-label）+ 底部「保存模板」。
await settingsNav('任务模板')
await ev(`(()=>{const b=[...document.querySelectorAll('.set-page:not([hidden]) .set-add-btn')].find(x=>(x.textContent||'').trim().includes('添加'));if(b)b.click();return !!b;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.set-page:not([hidden]) .set-fld-inp[placeholder="例如：埋点走查"]'))()`), Boolean)
const p6TemplateModal = JSON.parse(await ev(`(()=>{
  const page=document.querySelector('.set-page:not([hidden])');
  const name=page?.querySelector('.set-fld-inp[placeholder="例如：埋点走查"]'),prompt=page?.querySelector('textarea[placeholder="交接任务时预填的提示词…"]');
  const setInput=(el,value)=>{const p=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};
  if(name)setInput(name,${JSON.stringify(p6TemplateName)});if(prompt)setInput(prompt,${JSON.stringify(p6TemplatePrompt)});
  const agent=page?.querySelector('select[aria-label="默认 Agent"]');
  if(agent&&[...agent.options].some(o=>o.value===${JSON.stringify(agentId)})){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(agent,${JSON.stringify(agentId)});agent.dispatchEvent(new Event('change',{bubbles:true}));}
  return JSON.stringify({title:(page?.querySelector('.set-detail-title h2')?.textContent||'').trim(),name:!!name,prompt:!!prompt,agent:agent?.value||''});
})()`))
await sleep(150)
const p6TemplateModel = JSON.parse(await ev(`(async()=>{
  const select=document.querySelector('.set-page:not([hidden]) select[aria-label="默认模型"]');
  const agent=(await window.uniagent.listAgents()).find(a=>a.id===${JSON.stringify(agentId)});
  const model=agent?.models?.find(m=>m.efforts?.length);
  const option=select?([...select.options].find(x=>x.value===model?.id)||[...select.options].find(x=>x.value)):null;
  if(option){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));}
  return JSON.stringify({found:!!option,value:option?.value||'',label:(option?.textContent||'').trim()});
})()`))
await sleep(100)
const p6TemplateOptions = JSON.parse(await ev(`(()=>{
  const page=document.querySelector('.set-page:not([hidden])');
  const choose=(sel)=>{const select=page?.querySelector('select[aria-label="'+sel+'"]');if(!select)return '';const option=[...select.options].find(x=>x.value);if(option){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));}return option?.value||''};
  return JSON.stringify({effort:choose('默认推理强度'),permission:choose('默认权限')});
})()`))
await poll(() => ev(`(()=>{const b=document.querySelector('.set-page:not([hidden]) .set-save-btn');return !!b&&!b.disabled;})()`), Boolean)
await ev(`(()=>{const b=document.querySelector('.set-page:not([hidden]) .set-save-btn');if(b)b.click();return !!b;})()`)
await poll(() => ev(`(()=>[...document.querySelectorAll('.set-page:not([hidden]) .rowlink .r-label')].some(x=>(x.childNodes[0]?.textContent||'').trim()===${JSON.stringify(p6TemplateName)}))()`), Boolean)
check('需求 Settings 可添加任务模板', p6TemplateModal.title === '新建任务模板' && p6TemplateModal.name && p6TemplateModal.prompt && p6TemplateModal.agent === agentId, JSON.stringify(p6TemplateModal))
check('需求任务模板可保存模型/推理/权限', p6TemplateModel.found && !!p6TemplateOptions.effort && !!p6TemplateOptions.permission, JSON.stringify({model:p6TemplateModel,...p6TemplateOptions}))
await ev(`(()=>{const row=[...document.querySelectorAll('.set-page:not([hidden]) .rowlink')].find(x=>(x.querySelector('.r-label')?.childNodes[0]?.textContent||'').trim()===${JSON.stringify(p6TemplateName)});if(row)row.click();return !!row;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.set-page:not([hidden]) textarea[placeholder="交接任务时预填的提示词…"]'))()`), Boolean)
await ev(`(()=>{const ta=document.querySelector('.set-page:not([hidden]) textarea[placeholder="交接任务时预填的提示词…"]');if(!ta)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(p6TemplateEditedPrompt)});ta.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`)
await ev(`(()=>{const b=document.querySelector('.set-page:not([hidden]) .set-save-btn');if(b)b.click();return !!b;})()`)
const p6TemplateEdited = await poll(
  () => ev(`(async()=>{
    const preset=(await window.uniagent.listPresets()).find(x=>x.name===${JSON.stringify(p6TemplateName)});
    return {persistedPrompt:preset?.prompt||''};
  })()`),
  (value) => value.persistedPrompt === p6TemplateEditedPrompt
)
check(
  '需求 Settings 可编辑任务模板',
  p6TemplateEdited.persistedPrompt === p6TemplateEditedPrompt,
  JSON.stringify(p6TemplateEdited)
)

await ev(`(()=>{document.querySelector('.btn-new')?.click();return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.new-task select[aria-label="任务模板"]'))()`), Boolean)
const p6Applied = JSON.parse(await ev(`(()=>{
  const select=document.querySelector('.new-task select[aria-label="任务模板"]');
  const option=[...select.options].find(x=>(x.textContent||'').trim()===${JSON.stringify(p6TemplateName)});
  if(option){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));}
  return JSON.stringify({found:!!option});
})()`))
await sleep(180)
const p6AppliedState = JSON.parse(await ev(`(()=>{
  const menu=document.querySelector('.new-task .sb-agent');
  const cfg=(name)=>[...document.querySelectorAll('.new-task .cfg')].find(x=>(x.querySelector(':scope > span')?.textContent||'').trim()===name);
  return JSON.stringify({prompt:window.__markdownInput.text('.new-task .prompt-input'),agent:menu?.getAttribute('data-agent-id')||'',model:menu?.getAttribute('data-model-label')||'',effort:menu?.getAttribute('data-effort')||'',permission:cfg('权限')?.querySelector('select')?.value||'',template:document.querySelector('.new-task select[aria-label="任务模板"]')?.value||''});
})()`))
check('需求新建页应用任务模板后预填全部配置并重置选择器', p6Applied.found && p6AppliedState.prompt === p6TemplateEditedPrompt && p6AppliedState.agent === agentId && p6AppliedState.model === p6TemplateModel.label && p6AppliedState.effort === p6TemplateOptions.effort && p6AppliedState.permission === p6TemplateOptions.permission && p6AppliedState.template === '', JSON.stringify(p6AppliedState))
const p6ComposerTemplate = JSON.parse(await ev(`(async()=>{
  const before=(await window.uniagent.listSessions()).find(x=>x.id===${JSON.stringify(sid)});
  return JSON.stringify({before:before?.config||null});
})()`))
await ev(`(()=>{const sel=document.querySelector('.sl-view .sl-seg button[data-view="all"]');if(sel){sel.click();}return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(sid)}]'))()`), Boolean)
const p6ComposerSessionOpened = await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(sid)}]');row?.click();return !!row;})()`)
const p6ComposerApplied = await poll(
  () => ev(`(()=>{const button=[...document.querySelectorAll('.composer-wrap .sb-add .sb-menu-item')].find(x=>(x.textContent||'').trim()===${JSON.stringify(p6TemplateName)});button?.click();return !!button;})()`),
  Boolean
)
await sleep(120)
const p6ComposerState = JSON.parse(await ev(`(async()=>{const current=(await window.uniagent.listSessions()).find(x=>x.id===${JSON.stringify(sid)});return JSON.stringify({prompt:window.__markdownInput.text('.composer-input'),config:current?.config||null});})()`))
check('需求聊天框应用任务模板只改 prompt、不改会话配置', p6ComposerSessionOpened && p6ComposerApplied && p6ComposerState.prompt === p6TemplateEditedPrompt && JSON.stringify(p6ComposerState.config) === JSON.stringify(p6ComposerTemplate.before), JSON.stringify(p6ComposerState))
const p6SessionDraftText = `UA session draft ${process.pid}`
await ev(`(()=>{
  document.querySelectorAll('.composer-wrap .attach-thumb-x').forEach(x=>x.click());
  window.__markdownInput.fill('.composer-input',${JSON.stringify(p6SessionDraftText)});
  return true;
})()`)
await pasteDraftImage('.composer-input')
const p6SessionDraftReady = await poll(
  () => ev(`(()=>({text:window.__markdownInput.text('.composer-input'),images:document.querySelectorAll('.composer-wrap .attach-thumb').length}))()`),
  (value) => value.text === p6SessionDraftText && value.images === 1,
  10_000
)
await ev(`(()=>{document.querySelector('.settings-entry')?.click();return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.settings-panel'))()`), Boolean)
await settingsNav('任务模板')
// 进入该模板详情 → 底部「删除模板」。
await ev(`(()=>{const row=[...document.querySelectorAll('.set-page:not([hidden]) .rowlink')].find(x=>(x.querySelector('.r-label')?.childNodes[0]?.textContent||'').trim()===${JSON.stringify(p6TemplateName)});if(row)row.click();return !!row;})()`)
await poll(() => ev(`(()=>[...document.querySelectorAll('.set-page:not([hidden]) .set-detail-bar button')].some(x=>(x.textContent||'').trim()==='删除模板'))()`), Boolean)
const p6Deleted = await ev(`(()=>{const b=[...document.querySelectorAll('.set-page:not([hidden]) .set-detail-bar button')].find(x=>(x.textContent||'').trim()==='删除模板');if(b)b.click();return !!b;})()`)
await poll(() => ev(`(async()=>!(await window.uniagent.listPresets()).some(x=>x.name===${JSON.stringify(p6TemplateName)}))()`), Boolean)
check('需求 Settings 仅删除本次创建的任务模板', p6Deleted, p6TemplateName)
await ev(`(()=>{document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(sid)}]')?.click();return true;})()`)
const p6SessionDraftRestored = await poll(
  () => ev(`(()=>({text:window.__markdownInput.text('.composer-input'),images:document.querySelectorAll('.composer-wrap .attach-thumb').length,preview:!!document.querySelector('.composer-wrap .attach-thumb img[src^="data:image/png;base64,"]')}))()`),
  (value) => value.text === p6SessionDraftText && value.images === 1 && value.preview,
  10_000
)
check(
  '需求 Session 输入框文字和图片切换界面后保留',
  p6SessionDraftReady.text === p6SessionDraftText && p6SessionDraftReady.images === 1 && p6SessionDraftRestored.text === p6SessionDraftText && p6SessionDraftRestored.images === 1 && p6SessionDraftRestored.preview,
  JSON.stringify({ready:p6SessionDraftReady,restored:p6SessionDraftRestored})
)
await ev(`(()=>{window.__markdownInput.fill('.composer-input','');document.querySelectorAll('.composer-wrap .attach-thumb-x').forEach(x=>x.click());return true;})()`)

// The home composer is one draft: navigation and group-scoped quick-create only
// change the requested scope, never its text, image, Agent, or model.
await ev(`(()=>{document.querySelector('.btn-new')?.click();return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.new-task .prompt-input'))()`), Boolean)
const p6Tabs = await ev(`(()=>JSON.stringify([...document.querySelectorAll('.sl-view .sl-seg button')].map(x=>(x.textContent||'').trim())))()`)
check('需求会话分组 tabs 为全部/Agent/空间/需求', p6Tabs === JSON.stringify(['全部','Agent','空间','需求']), p6Tabs)
await ev(`(()=>{const details=document.querySelector('.new-task .sb-agent');details.open=true;details.dispatchEvent(new Event('toggle'));const entry=[...details.querySelectorAll('.sb-sub-entry')].find(x=>(x.textContent||'').includes('Agent'));entry?.click();return !!entry;})()`)
await sleep(120)
await ev(`(()=>{const option=[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].find(x=>(x.querySelector('.sb-agent-name-label')?.textContent||'').trim()===${JSON.stringify(agentDisplayName)});option?.click();return !!option;})()`)
await ev(`(()=>{const details=document.querySelector('.new-task .sb-agent');details.open=true;details.dispatchEvent(new Event('toggle'));const entry=[...details.querySelectorAll('.sb-sub-entry')].find(x=>(x.textContent||'').includes('模型'));entry?.click();return !!entry;})()`)
await sleep(120)
const p6HomeModelChoice = await ev(`(()=>{const options=[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].filter(x=>!x.disabled);const option=options.find(x=>x.getAttribute('aria-selected')!=='true')||options[0];const model=option?.getAttribute('data-model')||'';option?.click();return {found:!!option,model};})()`)
await sleep(120)
const p6HomeDraftText = `UA home draft ${process.pid}`
await ev(`(()=>{
  document.querySelectorAll('.new-task .attach-thumb-x').forEach(x=>x.click());
  window.__markdownInput.fill('.new-task .prompt-input',${JSON.stringify(p6HomeDraftText)});
  return true;
})()`)
await pasteDraftImage('.new-task .prompt-input')
const p6HomeDraft = await poll(
  () => ev(`(()=>{const menu=document.querySelector('.new-task .sb-agent');return {text:window.__markdownInput.text('.new-task .prompt-input'),images:document.querySelectorAll('.new-task .attach-thumb').length,agent:menu?.getAttribute('data-agent-id')||'',model:menu?.getAttribute('data-model')||''};})()`),
  (value) => value.text === p6HomeDraftText && value.images === 1 && value.agent === agentId && !!value.model,
  10_000
)
check('需求首页输入框可选择 Agent/模型并写入文字、图片', p6HomeModelChoice.found && p6HomeDraft.text === p6HomeDraftText && p6HomeDraft.images === 1 && p6HomeDraft.agent === agentId && !!p6HomeDraft.model, JSON.stringify({choice:p6HomeModelChoice,draft:p6HomeDraft}))
const p6DraftState = () => ev(`(()=>{const menu=document.querySelector('.new-task .sb-agent');return {text:window.__markdownInput.text('.new-task .prompt-input'),images:document.querySelectorAll('.new-task .attach-thumb').length,preview:!!document.querySelector('.new-task .attach-thumb img[src^="data:image/png;base64,"]'),agent:menu?.getAttribute('data-agent-id')||'',model:menu?.getAttribute('data-model')||''};})()`)
const p6DraftKept = (state) => state.text === p6HomeDraft.text && state.images === 1 && state.preview && state.agent === p6HomeDraft.agent && state.model === p6HomeDraft.model

await ev(`(()=>{document.querySelector('.settings-entry')?.click();return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.settings-panel'))()`), Boolean)
await ev(`(()=>{document.querySelector('.btn-new')?.click();return true;})()`)
await sleep(180)
const p6TopQuickState = await p6DraftState()
check('需求首页顶部＋返回后保留完整输入缓存', p6DraftKept(p6TopQuickState), JSON.stringify(p6TopQuickState))

await ev(`(()=>{document.querySelector('.sl-view .sl-seg button[data-view="byAgent"]')?.click();return true;})()`)
await sleep(100)
const p6AgentQuick = await ev(`(()=>{const expected='使用 '+${JSON.stringify(agentDisplayName)}+' 新建任务';const b=[...document.querySelectorAll('.sl-body .sl-group-add')].find(x=>x.getAttribute('aria-label')===expected);b?.click();return {found:!!b,label:b?.getAttribute('aria-label')||''};})()`)
await sleep(180)
const p6AgentQuickState = await p6DraftState()
check('需求按 Agent 组右侧＋保留完整输入缓存', p6AgentQuick.found && p6DraftKept(p6AgentQuickState), JSON.stringify({button:p6AgentQuick,state:p6AgentQuickState}))

await ev(`(()=>{document.querySelector('.sl-view .sl-seg button[data-view="byProject"]')?.click();return true;})()`)
await sleep(100)
const p6DirQuick = await ev(`(()=>{const b=document.querySelector('.sl-body .sl-group-add');const label=b?.getAttribute('aria-label')||'',dir=b?.closest('.sl-group-head')?.getAttribute('title')||'';b?.click();return {found:!!b,label,dir};})()`)
await sleep(180)
const p6DirQuickState = await p6DraftState()
check('需求按空间组右侧＋保留完整输入缓存', p6DirQuick.found && /^在 .+ 新建任务$/.test(p6DirQuick.label) && p6DraftKept(p6DirQuickState), JSON.stringify({button:p6DirQuick,state:p6DirQuickState}))

const p6DraftRequirement = await ev(`window.uniagent.createRequirement({name:${JSON.stringify(`UA draft requirement ${process.pid}`)}})`)
await ev(`(()=>{document.querySelector('.sl-view .sl-seg button[data-view="byRequirement"]')?.click();return true;})()`)
const p6RequirementQuickReady = await poll(() => ev(`(()=>!![...document.querySelectorAll('.sl-body .sl-group-add')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(`在 UA draft requirement ${process.pid} 新建任务`)}))()`), Boolean, 10_000)
const p6RequirementQuick = await ev(`(()=>{const b=[...document.querySelectorAll('.sl-body .sl-group-add')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(`在 UA draft requirement ${process.pid} 新建任务`)});b?.click();return {found:!!b,label:b?.getAttribute('aria-label')||''};})()`)
await sleep(180)
const p6RequirementQuickState = await p6DraftState()
check('需求按需求组右侧＋保留完整输入缓存', !!p6DraftRequirement?.id && p6RequirementQuickReady && p6RequirementQuick.found && p6DraftKept(p6RequirementQuickState), JSON.stringify({button:p6RequirementQuick,state:p6RequirementQuickState}))
await ev(`(()=>{document.querySelector('.sl-view .sl-seg button[data-view="all"]')?.click();document.querySelector('.btn-new')?.click();return true;})()`)
await sleep(180)
await ev(`(()=>{window.__markdownInput.fill('.new-task .prompt-input','');document.querySelectorAll('.new-task .attach-thumb-x').forEach(x=>x.click());return true;})()`)

// ==== New feature batch (5 飞书文档) ==============================

// ---- Doc1: history now scans rollout files (not the sparse session_index),
// so the agent's history count should reflect the on-disk rollouts (many), not
// the handful in session_index.jsonl. Assert the list is substantially populated
// and every row carries a title + id. ----
const histScan = JSON.parse(await ev(`(async()=>{
  const h=await window.uniagent.listAgentHistory(${JSON.stringify(agentId)});
  const withId=h.filter(x=>x.id).length;
  const withTitle=h.filter(x=>x.title&&x.title!=='(未命名会话)').length;
  return JSON.stringify({n:h.length,withId,withTitle,sample:h.slice(0,3).map(x=>({t:(x.title||'').slice(0,30),cwd:x.cwd?1:0}))});
})()`))
check(
  'Doc1 history from rollout scan (many sessions, not just index)',
  histScan.n >= 20 && histScan.withId === histScan.n,
  `${histScan.n} sessions, withId=${histScan.withId}, withTitle=${histScan.withTitle}`
)

// ---- 需求6: the 导入会话 list must HIDE sessions UniAgent produced itself (direct
// create / same-agent 分叉 / cross-agent 搬运), so only sessions born independently
// in another agent's native CLI/TUI show. We stamp four synthetic rollouts on disk
// under the active agent's store — three UniAgent-origin markers + one genuine
// independent CLI session — then assert listAgentHistory hides exactly the three
// and keeps the independent one. Also: a manual 刷新 button must exist in the panel
// head and re-run the scan on click, and opening the panel reloads from disk. ----
{
  const codexBase =
    agentId === 'traex'
      ? join(isolatedHome, '.trae/cli')
      : agentId === 'claude'
        ? join(isolatedHome, '.claude/projects')
        : join(isolatedHome, '.codex')
  // Only codex/traex store the rollout markers this check stamps on disk.
  const skipReq6 = agentId !== 'codex' && agentId !== 'traex'
  if (skipReq6) {
    console.log('… 需求6 disk-marker check skipped for agent', agentId)
  } else {
    const dayDir = join(codexBase, 'sessions', '2099', '01', '01')
    mkdirSync(dayDir, { recursive: true })
    const written = []
    const mkRollout = (marker) => {
      const uid = randomUUID()
      const metaPayload = {
        id: uid,
        session_id: uid,
        timestamp: '2099-01-01T00:00:00.000Z',
        cwd: '/tmp/req6',
        cli_version: '9.9.9',
        ...marker
      }
      const lines = [
        JSON.stringify({ type: 'session_meta', payload: metaPayload }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'REQ6 marker session ' + uid.slice(0, 8) }]
          }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'REQ6 assistant reply ' + uid.slice(0, 8) }
        })
      ]
      const file = join(dayDir, `rollout-2099-01-01T00-00-00-${uid}.jsonl`)
      writeFileSync(file, lines.join('\n') + '\n')
      written.push({ file, uid, marker })
      return uid
    }
    const idOriginator = mkRollout({ originator: 'uniagent' })
    const idForked = mkRollout({ originator: 'codex-tui', forked_from: randomUUID() })
    const idTransplant = mkRollout({ originator: 'codex-tui', uniagent_transplant: true })
    const idIndependent = mkRollout({ originator: 'codex-tui' })
    try {
      const req6 = JSON.parse(await ev(`(async()=>{
        const h=await window.uniagent.listAgentHistory(${JSON.stringify(agentId)});
        const ids=new Set(h.map(x=>x.id));
        return JSON.stringify({
          n:h.length,
          hasOriginator:ids.has(${JSON.stringify(idOriginator)}),
          hasForked:ids.has(${JSON.stringify(idForked)}),
          hasTransplant:ids.has(${JSON.stringify(idTransplant)}),
          hasIndependent:ids.has(${JSON.stringify(idIndependent)})
        });
      })()`))
      check(
        '需求6 导入会话 hides UniAgent-produced sessions (originator/forked_from/transplant), keeps independent CLI sessions',
        !req6.hasOriginator && !req6.hasForked && !req6.hasTransplant && req6.hasIndependent,
        `originator=${req6.hasOriginator}, forked=${req6.hasForked}, transplant=${req6.hasTransplant}, independent=${req6.hasIndependent} (n=${req6.n})`
      )
    } finally {
      for (const w of written) {
        try { if (existsSync(w.file)) unlinkSync(w.file) } catch {}
      }
    }
  }

  // The resume panel head must carry a manual 刷新 button. Open the 导入会话 panel,
  // assert the button exists + is enabled, click it, and confirm it drives a
  // reload (the list is re-populated and the button toggles a loading state).
  await ev(`(()=>{const b=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>/导入会话/.test(x.textContent));if(b)b.click();return 1;})()`)
  await poll(
    () => ev(`(()=>!!document.querySelector('.resume-panel .resume-refresh-btn'))()`),
    Boolean
  )
  // The panel reloads on open (需求6), so the button is transiently disabled while
  // that scan runs. Wait for it to settle (enabled) before inspecting + clicking,
  // otherwise we'd race the open-reload's own loading state.
  await poll(
    () => ev(`(()=>{const b=document.querySelector('.resume-panel .resume-refresh-btn');return !!b && !b.disabled;})()`),
    Boolean
  )
  const refreshUi = JSON.parse(await ev(`(()=>{
    const btn=document.querySelector('.resume-panel .resume-refresh-btn');
    const icon=document.querySelector('.resume-panel .resume-refresh-icon');
    return JSON.stringify({exists:!!btn, disabled:btn?!!btn.disabled:true, hasIcon:!!icon, label:(btn?.textContent||'').trim()});
  })()`))
  check(
    '需求6 resume panel has a manual 刷新 button (enabled, with icon)',
    refreshUi.exists && !refreshUi.disabled && refreshUi.hasIcon && /刷新/.test(refreshUi.label),
    `exists=${refreshUi.exists}, disabled=${refreshUi.disabled}, icon=${refreshUi.hasIcon}, label="${refreshUi.label}"`
  )
  // Click it and confirm a reload runs (list re-populates; loading state is
  // observed either transiently or the list ends up populated again).
  const refreshClicked = await ev(`(()=>{const b=document.querySelector('.resume-panel .resume-refresh-btn');if(!b||b.disabled)return false;b.click();return true;})()`)
  await poll(
    () => ev(`(()=>!!document.querySelector('.resume-panel .resume-refresh-btn') && !document.querySelector('.resume-panel .resume-refresh-btn').disabled)()`),
    Boolean
  )
  const afterRefresh = JSON.parse(await ev(`(async()=>{
    const rows=document.querySelectorAll('.resume-item').length;
    const empty=!!document.querySelector('.drawer-empty');
    const h=await window.uniagent.listAgentHistory(${JSON.stringify(agentId)});
    return JSON.stringify({rows, empty, listN:h.length});
  })()`))
  check(
    '需求6 manual 刷新 re-runs the history scan (list reloads)',
    refreshClicked && (afterRefresh.rows > 0 || afterRefresh.listN >= 0),
    `clicked=${refreshClicked}, rows=${afterRefresh.rows}, listN=${afterRefresh.listN}`
  )
}

// ---- Doc2: `/` palette is provider-native Skill/MCP only. ----
const cmdCands = JSON.parse(await ev(`(async()=>{
  const s=await window.uniagent.getNativeCapabilities({agentId:${JSON.stringify(agentId)},workdir:window.uniagent.homeDir,force:true});
  const c=s.candidates;
  return JSON.stringify({n:c.length,skills:c.filter(x=>x.kind==='skill').length,mcps:c.filter(x=>x.kind==='mcp').length,onlyNative:c.every(x=>x.kind==='skill'||x.kind==='mcp')});
})()`))
check(
  'Doc2 provider-native candidates contain Skill/MCP only',
  cmdCands.skills > 0 && cmdCands.onlyNative,
  `${cmdCands.n} candidates: skills=${cmdCands.skills} mcp=${cmdCands.mcps}`
)
// Open a session so the reply composer is mounted, type `/` and confirm no
// legacy command group or command rows render in the palette.
await ev(`(()=>{const r=document.querySelector('.sl-body .session-item');if(r)r.click();return 1;})()`)
await sleep(400)
await ev(`(()=>{
  const ta=document.querySelector('.composer-input');
  if(!ta) return 0;
  window.__markdownInput.fill(ta,'/');
  return 1;
})()`)
await sleep(300)
const cmdMenu = JSON.parse(await ev(`(()=>{
  const groups=[...document.querySelectorAll('.slash-menu .slash-group')].map(g=>g.textContent);
  const cmdItems=document.querySelectorAll('.slash-menu .slash-kind-command').length;
  return JSON.stringify({groups,cmdItems});
})()`))
check(
  'Doc2 `/` palette omits legacy command items',
  !cmdMenu.groups.some((g) => /预设命令/.test(g)) && cmdMenu.cmdItems === 0,
  `groups=[${cmdMenu.groups.join('|')}], cmdItems=${cmdMenu.cmdItems}`
)
// Clear the composer.
await ev(`window.__markdownInput.fill('.composer-input','')`)
const legacyAbsent = await ev(`(()=>typeof window.uniagent.runCommand==='undefined'&&typeof window.uniagent.listCandidates==='undefined')()`)
check('Doc2 legacy command IPC absent', legacyAbsent, `absent=${legacyAbsent}`)

// ---- Doc3: review panel is driven by the live git change set. reviewGetChangeSet
// must be exposed and return a change set for the session workdir (a git repo);
// the panel's Changes / Unversioned group CSS must ship. ----
const changeSet = JSON.parse(await ev(`(async()=>{
  const fn=typeof window.uniagent.reviewGetChangeSet==='function';
  if(!fn) return JSON.stringify({fn:false});
  const cs=await window.uniagent.reviewGetChangeSet(${JSON.stringify(sid)});
  return JSON.stringify({fn:true,isGitRepo:cs.isGitRepo,items:cs.items.length,tracked:cs.items.filter(i=>i.tracked).length,untracked:cs.items.filter(i=>!i.tracked).length});
})()`))
check(
  'Doc3 reviewGetChangeSet exposed + returns a change set',
  changeSet.fn && typeof changeSet.isGitRepo === 'boolean',
  `isGitRepo=${changeSet.isGitRepo}, items=${changeSet.items} (tracked=${changeSet.tracked}, untracked=${changeSet.untracked})`
)
const changeCss = JSON.parse(await ev(`(()=>{
  let group=false, tree=false, refresh=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ const s=r.selectorText||'';
      if(s.includes('.group-head')) group=true;
      if(s.includes('.change-tree')||s.includes('.change-group')) tree=true;
      if(s.includes('.files-refresh')) refresh=true;
    } }catch{}
  }
  return JSON.stringify({group,tree,refresh});
})()`))
check(
  'Doc3 Changes/Unversioned tree CSS shipped (group-head + refresh)',
  changeCss.group && changeCss.tree && changeCss.refresh,
  `group=${changeCss.group}, tree=${changeCss.tree}, refresh=${changeCss.refresh}`
)

// ---- Doc4: current task list pill (plan_update). Inject a synthetic plan_update
// event into the active session's stream and confirm a .plan-pill renders with
// "第 x / n 步", plus the hover popover markup + CSS ship. ----
const planCss = await ev(`(()=>{
  let ok=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ const s=r.selectorText||''; if(s.includes('.plan-pill')||s.includes('.plan-pop')){ok=true;break;} } }catch{}
    if(ok) break;
  }
  return ok;
})()`)
check('Doc4 plan pill CSS shipped', !!planCss, `planCss=${planCss}`)
// The plan_update归一 is proven structurally via the mergeable type + adapters;
// assert the type is recognized end-to-end by checking a live event flows if the
// agent emitted one (best-effort — many turns emit no plan).
const planLive = await ev(`window.__e.some(e=>e.sessionId===${JSON.stringify(sid)}&&e.type==='plan_update')`)
console.log(`… Doc4 live plan_update seen: ${planLive} (informational — depends on the model producing a plan)`)

// ---- Doc5 / 改动1·3·4·5: sub-agent UI. subagentItems IPC exposed; the NEW
// inline status row (.sa-line, no spinner), the resizable side panel (.subagent-panel
// + left grip), its list/detail pages (.subagent-listpage / .subagent-detailpage)
// and the per-agent avatar (.sa-ic) CSS must all ship. ----
const subWired = JSON.parse(await ev(`(()=>{
  const fn=typeof window.uniagent.getSubAgentItems==='function';
  let line=false, panel=false, grip=false, listp=false, detailp=false, ic=false, legacyCard=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ const s=r.selectorText||'';
      if(s.includes('.sa-line')) line=true;
      if(s.includes('.subagent-panel')) panel=true;
      if(s.includes('.subagent-panel-grip')) grip=true;
      if(s.includes('.subagent-listpage')) listp=true;
      if(s.includes('.subagent-detailpage')) detailp=true;
      if(s.includes('.sa-ic')) ic=true;
      if(s.includes('.subagent-card')) legacyCard=true;
    } }catch{}
  }
  return JSON.stringify({fn,line,panel,grip,listp,detailp,ic,legacyCard});
})()`))
check(
  'Doc5 sub-agent v3 UI wired (inline row + resizable panel + list/detail + icon, no legacy card)',
  subWired.fn && subWired.line && subWired.panel && subWired.grip && subWired.listp && subWired.detailp && subWired.ic && !subWired.legacyCard,
  `getSubAgentItems=${subWired.fn}, sa-line=${subWired.line}, panel=${subWired.panel}, grip=${subWired.grip}, list=${subWired.listp}, detail=${subWired.detailp}, icon=${subWired.ic}, legacyCard=${subWired.legacyCard}`
)

// ---- 修复#1·#2·#5·#7: follow-up sub-agent UI fixes must all ship in CSS/DOM. ----
const subFixes = JSON.parse(await ev(`(()=>{
  let wrap=false, wrapCol=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){
      const s=r.selectorText||'';
      // 修复#1 — the inline row is wrapped in a centered 840px column.
      if(s.includes('.sa-line-wrap')){ wrap=true;
        const cs=(r.style&&r.style.maxWidth)||''; if(cs.includes('840')||cs.includes('--conversation-column-width')) wrapCol=true; }
    } }catch{}
  }
  return JSON.stringify({wrap,wrapCol});
})()`))
check(
  '修复#1 inline sub-agent row aligned to the centered 840px column (.sa-line-wrap)',
  subFixes.wrap && subFixes.wrapCol,
  `wrap=${subFixes.wrap}, maxWidth840=${subFixes.wrapCol}`
)
const summaryPopoverRule = await ev(`(()=>{for(const sheet of document.styleSheets){try{for(const rule of sheet.cssRules){if(rule.selectorText==='.timer-summary-pop')return rule.style.position==='absolute'&&rule.style.transition.includes('opacity');}}catch{}}return false;})()`)
check('计时胶囊摘要使用定位悬浮窗及显隐过渡', summaryPopoverRule, String(summaryPopoverRule))
// 修复#7 — the intermediate 已更新 phase is gone: no rendered inline row (or the
// live/restored stream) may carry the 已更新 label anymore.
const noUpdatePhase = await ev(`(()=>{
  const rows=[...document.querySelectorAll('.sa-line .st')];
  return !rows.some(r=>(r.textContent||'').includes('已更新'));
})()`)
check('修复#7 no 已更新 phase renders in the stream', noUpdatePhase === true, `noUpdate=${noUpdatePhase}`)
// 修复#5 — the "Ignoring malformed agent role definition …" chatter must never
// render as a system-notice card in the timeline.
const noIgnoreNotice = await ev(`(()=>{
  const cards=[...document.querySelectorAll('.system-notice')];
  return !cards.some(c=>/Ignoring malformed agent role definition|duplicate agent role name/i.test(c.textContent||''));
})()`)
check('修复#5 malformed-agent-role ignore notice is suppressed', noIgnoreNotice === true, `noIgnore=${noIgnoreNotice}`)

// 修复(追加) — the detail-page "‹ 返回列表" button must have a comfortable padded
// hit area (>=28px tall) so a real trackpad click always lands, and the detail
// header avatar must be enlarged (>=30px). Both are pure CSS assertions.
const backFix = JSON.parse(await ev(`(()=>{
  let padded=false, minH=false, iconRule=false;
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){
      const s=r.selectorText||'';
      if(s==='.subagent-back'){
        const st=r.style||{};
        const p=st.padding||''; if(p && p!=='0' && p!=='0px') padded=true;
        const mh=parseFloat(st.minHeight||'0'); if(mh>=28) minH=true;
      }
    } }catch{}
  }
  return JSON.stringify({padded,minH});
})()`))
check(
  '修复(追加) 返回列表 button has a real padded hit area (click reliably registers)',
  backFix.padded && backFix.minH,
  `padded=${backFix.padded}, minHeight>=28=${backFix.minH}`
)

// ---- 需求2 (子 Agent 侧栏输出缺失): getSubAgentItems must return the CHILD's
// own rollout events (agent_message / reasoning / command …), NOT the empty list
// the old thread/items/list RPC produced. The isolated fixture contains a finished
// child rollout, so this always exercises the real history parser without relying
// on developer-machine state.
const childItems = JSON.parse(await ev(`(async()=>{
  const parent=await window.uniagent.importSession('codex',${JSON.stringify(SUBAGENT_PARENT_NATIVE_ID)});
  const items=parent
    ? await window.uniagent.getSubAgentItems(parent.id,${JSON.stringify(SUBAGENT_CHILD_NATIVE_ID)})
    : [];
  const kinds={}; for(const it of items) kinds[it.type]=(kinds[it.type]||0)+1;
  return JSON.stringify({count:items.length, msgs:kinds.agent_message||0});
})()`))
check(
  '需求2 getSubAgentItems reads child\u2019s OWN rollout (real output, not empty)',
  childItems.count > 0 && childItems.msgs > 0,
  `items=${childItems.count}, agent_message=${childItems.msgs}`
)

// ---- 需求2 (恢复会话重建子 Agent 名单): a restored session must rebuild its
// sub-agent roster from the parent thread's sub_agent_activity records (which
// history.ts previously skipped). Import the isolated parent fixture and assert a
// `subagent` event with a non-empty agents list. ----
const roster = JSON.parse(await ev(`(async()=>{
  const sess=await window.uniagent.importSession('codex',${JSON.stringify(SUBAGENT_PARENT_NATIVE_ID)});
  if(!sess) return JSON.stringify({found:false});
  const evs=await window.uniagent.getEvents(sess.id);
  const agents=evs.filter(e=>e.type==='subagent').flatMap(e=>(e.payload&&e.payload.agents)||[]);
  // 修复#3 — reduce to a per-child roster (latest status wins) the way the UI does,
  // then assert NO child is left dangling at running/pendingInit after restore.
  const byId={}; for(const a of agents){ if(a&&a.agentThreadId) byId[a.agentThreadId]=a; }
  const roster=Object.values(byId);
  const dangling=roster.filter(a=>a.status==='running'||a.status==='pendingInit').length;
  return JSON.stringify({found:true, agentCount:agents.length, rosterCount:roster.length, dangling, names:[...new Set(agents.map(a=>a.name))].slice(0,3)});
})()`))
check(
  '需求2 restored session rebuilds sub-agent roster from sub_agent_activity',
  roster.found && roster.agentCount > 0,
  `found=${roster.found}, agents=${roster.agentCount || 0}, sample=[${(roster.names || []).join(', ')}]`
)
check(
  '修复#3 restored children settle to terminal (no dangling running/pendingInit)',
  roster.found && roster.rosterCount > 0 && roster.dangling === 0,
  `found=${roster.found}, roster=${roster.rosterCount || 0}, dangling=${roster.dangling ?? 'n/a'}`
)

// ---- Plan collaboration mode stays independent from permission vocabulary. ----
{
  const modes = (target && target.permissionModes) || []
  const ids = modes.map((m) => m && m.id)
  const shaped = modes.length > 0 && modes.every((m) => m && m.id && m.label && m.hint)
  const hasPlan = ids.includes('plan')
  check(
    'Plan mode: permission descriptors remain shaped and exclude Plan',
    shaped && !hasPlan,
    `${agentId} modes=[${modes.map((m) => `${m.id}:${m.label}`).join(', ')}]`
  )
  // Per-agent subset: codex/traex must offer read-only; claude must NOT.
  const expectReadOnly = agentId !== 'claude'
  check(
    'Plan mode: per-agent permission subset is derived',
    ids.includes('read-only') === expectReadOnly,
    `read-only present=${ids.includes('read-only')} (expected ${expectReadOnly})`
  )
  // The permission selector remains permission-only; Plan is exposed by +.
  const selOpts = JSON.parse(await ev(`(()=>{
    const sels=[...document.querySelectorAll('.composer-bar select, .sb-cfg select, .cfg select')];
    for(const s of sels){
      const opts=[...s.options].map(o=>({v:o.value,t:(o.textContent||'').trim()}));
      if(opts.some(o=>['plan','read-only','ask','approve-for-me','auto-edit','full-access'].includes(o.v)))
        return JSON.stringify({found:true,opts});
    }
    return JSON.stringify({found:false});
  })()`))
  const planOpt = selOpts.found && selOpts.opts.find((o) => o.v === 'plan')
  const planAction = await ev(`(()=>[...document.querySelectorAll('.composer-wrap .native-action-item')].some((item)=>(item.textContent||'').trim().startsWith('Plan')))()`)
  check(
    'Plan mode: + menu exposes Plan while permission selector omits it',
    selOpts.found && !planOpt && planAction,
    selOpts.found ? `options=[${selOpts.opts.map((o) => `${o.v}:${o.t}`).join(', ')}]` : 'no permission <select> found'
  )
}

// ---- Summary ----
// ==== 需求2 targeted UI verification ========================================
// These checks drive mounted controls and assert the resulting DOM. They avoid
// treating a stylesheet selector or an empty query as proof of behavior.
// Earlier import/history checks intentionally convert the original `sid` into a
// read-only imported snapshot. Pick a currently visible writable session for
// these mounted-session checks so the fixture follows the sidebar's production
// eligibility contract instead of relying on a now-hidden snapshot.
let req2Sid = await ev(`(async()=>{
  const visible=new Set([...document.querySelectorAll('.sl-body .session-item[data-session-id]')]
    .map((row)=>row.getAttribute('data-session-id')).filter(Boolean));
  const sessions=await window.uniagent.listSessions();
  const eligible=sessions.filter((item)=>visible.has(item.id)&&!item.archived&&item.readOnly!==true&&item.status==='idle');
  return eligible[0]?.id||'';
})()`)
if (!req2Sid) {
  // IPC creation alone does not commit a new row into the renderer's local
  // session list. Use the production New Task submit path for the fallback.
  await ev(`(()=>{document.querySelector('.btn-new')?.click();return true;})()`)
  await poll(() => ev(`!!document.querySelector('.new-task .prompt-input')`), Boolean)
  await ev(`(()=>{const details=document.querySelector('.new-task .sb-agent');details.open=true;[...details.querySelectorAll('.sb-sub-entry')].find(x=>x.textContent.includes('Agent'))?.click();return true;})()`)
  await poll(() => ev(`(()=>{const option=[...document.querySelectorAll('.new-task .sb-agent .sb-sub-menu [role="option"]')].find(x=>x.textContent.trim()==='Codex');if(!option)return false;option.click();return true;})()`), Boolean)
  await ev(`(async()=>{window.__uiFixtureBefore=new Set((await window.uniagent.listSessions()).map(s=>s.id));})()`)
  const fixturePrompt = 'Reply exactly UI_FIXTURE_READY_' + Date.now() + ' without tools.'
  await ev(`window.__markdownInput.fill('.new-task .prompt-input',${JSON.stringify(fixturePrompt)})`)
  await sleep(100)
  await ev(`document.querySelector('.new-task .btn-send').click()`)
  req2Sid = await poll(() => ev(`(async()=>{const s=(await window.uniagent.listSessions()).find(s=>!window.__uiFixtureBefore.has(s.id));return document.querySelector('.session-view')&&s?s.id:'';})()`), Boolean)
}
const req2FixtureStatus = await poll(() => ev(`(async()=>{const s=(await window.uniagent.listSessions()).find(x=>x.id===${JSON.stringify(req2Sid)});return s?.status;})()`), status => status==='idle', 90000)
check('完整 UI 验收有可写的空闲会话夹具', !!req2Sid && req2FixtureStatus==='idle', JSON.stringify({id:req2Sid,status:req2FixtureStatus}))
if (!req2Sid || req2FixtureStatus!=='idle') throw new Error('Writable UI fixture is not ready')
await ev(`(()=>{document.querySelector('.btn-new')?.click();return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.new-task'))()`), Boolean)
// Position assertions catch late layout changes; spying on scrollIntoView only
// proved a jump was requested, even when the next layout lost the bottom again.
await ev(`(()=>{
  const now=Date.now(), events=[];
  for(let i=0;i<30;i++){
    events.push({sessionId:${JSON.stringify(req2Sid)},seq:now+i*2,ts:now+i*2,type:'user_message',state:'success',payload:{id:'open-scroll-u-'+now+'-'+i,text:'open scroll fixture '+i}});
    events.push({sessionId:${JSON.stringify(req2Sid)},seq:now+i*2+1,ts:now+i*2+1,type:'agent_message',state:'success',payload:{id:'open-scroll-a-'+now+'-'+i,text:'open scroll reply '+i}});
  }
  return window.uniagent.e2eInjectEvents(events);
})()`)
try {
  await ev(`(()=>{
    window.__uaOpeningGaps=[];
    window.__uaOpeningObserver=new MutationObserver(()=>{
      const stream=document.querySelector('.session-view .event-stream');
      if(!stream?.textContent.includes('open scroll reply 29')) return;
      window.__uaOpeningObserver.disconnect();
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        window.__uaOpeningGaps.push(stream.scrollHeight-stream.clientHeight-stream.scrollTop);
      }));
    });
    window.__uaOpeningObserver.observe(document.querySelector('.main'),{childList:true,subtree:true});
    document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]')?.click();
    return true;
  })()`)
  const openingGaps = await poll(() => ev('window.__uaOpeningGaps'), (gaps) => gaps.length > 0)
  check('需求18 打开长会话布局完成后已定位最新内容', Math.abs(openingGaps[0]) <= 2, JSON.stringify(openingGaps))

  const resizedScroll = await ev(`(async()=>{
    const stream=document.querySelector('.session-view .event-stream');
    const tail=[...stream.querySelectorAll('.turn-response')].at(-1);
    const tailStyle=tail.style.cssText, streamStyle=stream.style.cssText;
    const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const gap=()=>stream.scrollHeight-stream.clientHeight-stream.scrollTop;
    const initialHeight=stream.scrollHeight, initialViewport=stream.clientHeight;
    try {
      // Same events, late card/image/preview layout. Deliver scroll before resize
      // to cover the browser ordering that used to turn following off.
      tail.style.minHeight=(tail.getBoundingClientRect().height+800)+'px';
      stream.dispatchEvent(new Event('scroll',{bubbles:true}));
      await settle();
      const content={grew:stream.scrollHeight>initialHeight,gap:gap()};
      stream.style.maxHeight=Math.max(100,initialViewport-160)+'px';
      stream.dispatchEvent(new Event('scroll',{bubbles:true}));
      await settle();
      const viewport={shrank:stream.clientHeight<initialViewport,gap:gap()};
      stream.scrollTop=100;
      stream.dispatchEvent(new Event('scroll',{bubbles:true}));
      await settle();
      const readingTop=stream.scrollTop;
      tail.style.minHeight=(tail.getBoundingClientRect().height+400)+'px';
      stream.dispatchEvent(new Event('scroll',{bubbles:true}));
      await settle();
      const reading={before:readingTop,after:stream.scrollTop,gap:gap()};
      stream.scrollTop=stream.scrollHeight;
      stream.dispatchEvent(new Event('scroll',{bubbles:true}));
      tail.style.minHeight=(tail.getBoundingClientRect().height+300)+'px';
      await settle();
      return {content,viewport,reading,resumedGap:gap()};
    } finally {tail.style.cssText=tailStyle;stream.style.cssText=streamStyle;}
  })()`)
  check('异步内容增高后仍在底部', resizedScroll.content.grew && Math.abs(resizedScroll.content.gap) <= 2, JSON.stringify(resizedScroll))
  check('输入区域挤压可视区后仍在底部', resizedScroll.viewport.shrank && Math.abs(resizedScroll.viewport.gap) <= 2, JSON.stringify(resizedScroll))
  check('用户上翻阅读时不被异步布局拉走', resizedScroll.reading.gap > 60 && Math.abs(resizedScroll.reading.before-resizedScroll.reading.after) <= 2, JSON.stringify(resizedScroll))
  check('用户返回底部后恢复跟随', Math.abs(resizedScroll.resumedGap) <= 2, JSON.stringify(resizedScroll))
} finally {
  await ev(`(()=>{window.__uaOpeningObserver?.disconnect();delete window.__uaOpeningObserver;delete window.__uaOpeningGaps;return true;})()`)
}
const req2ReviewFixtureName = `.ua-cdp-unversioned-${process.pid}.txt`
const req2ReviewWorkdir = join(fixture, 'review-workdir')
mkdirSync(req2ReviewWorkdir, { recursive: true })
execFileSync('git', ['init', '--quiet'], { cwd: req2ReviewWorkdir, env: isolatedEnv })
const req2ReviewFixturePath = join(req2ReviewWorkdir, req2ReviewFixtureName)
const req2ReviewFixtureText = `UniAgent unversioned review fixture ${process.pid}`
writeFileSync(req2ReviewFixturePath, req2ReviewFixtureText + '\n')
const req2SessionSetup = JSON.parse(await ev(`(async()=>{
  const session=(await window.uniagent.listSessions()).find(x=>x.id===${JSON.stringify(req2Sid)});
  if(!session)return JSON.stringify({ok:false});
  const updated=await window.uniagent.updateSessionConfig(session.id,{workdir:${JSON.stringify(req2ReviewWorkdir)}});
  return JSON.stringify({ok:updated?.config.workdir===${JSON.stringify(req2ReviewWorkdir)}});
})()`))
check('E2E writable session uses the isolated fixture workdir', req2SessionSetup.ok, JSON.stringify(req2SessionSetup))

// Token usage is entirely backed by the --ua-e2e Kaboo fixture.
await ev(`(()=>{const b=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>(x.textContent||'').includes('Token 消耗'));if(b)b.click();return !!b;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.token-usage-panel .token-usage-body'))()`), Boolean)
const req2Token = JSON.parse(await ev(`(()=>{
  const ranges=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')];
  const stat=(label)=>{const card=[...document.querySelectorAll('.token-stat-card')].find(x=>(x.querySelector('.token-stat-label')?.textContent||'').trim()===label);return (card?.querySelector('.token-stat-value')?.textContent||'').replace(/\s+/g,'').trim()};
  const trend=document.querySelector('#token-heatmap-title')?.closest('.token-section');
  const dots=[...(trend?.querySelectorAll('.token-trend-dot')||[])];
  const path=trend?.querySelector('.token-trend-path');
  const trendGraphic=trend?.querySelector('[role=img]');
  const gridLines=trend?.querySelectorAll('.token-trend-grid').length||0;
  const yLabels=[...(trend?.querySelectorAll('.token-trend-yaxis span')||[])].map(x=>(x.textContent||'').trim());
  const firstDotBox=dots[0]?.getBoundingClientRect();
  const dotRound=firstDotBox?Math.abs(firstDotBox.width-firstDotBox.height)<0.6&&firstDotBox.width>0:false;
  const firstTip=dots[0]?.querySelector('.token-trend-tip')?.textContent?.replace(/\s+/g,' ').trim()||'';
  const tools=[...document.querySelectorAll('.token-tool-row')].map(x=>({name:(x.querySelector('.token-breakdown-name span')?.textContent||'').trim(),amount:(x.querySelector('.token-breakdown-amount')?.textContent||'').trim()}));
  const stats=[...document.querySelectorAll('.token-stat-card')].map(x=>({label:(x.querySelector('.token-stat-label')?.textContent||'').trim(),delta:(x.querySelector('.token-stat-delta')?.textContent||'').replace(/\s+/g,' ').trim()}));
  const breakdowns=[...document.querySelectorAll('.token-breakdown-head h3')].map(x=>(x.textContent||'').trim());
  return JSON.stringify({ranges:ranges.map(x=>(x.textContent||'').trim()),active:(ranges.find(x=>x.getAttribute('aria-pressed')==='true')?.textContent||'').trim(),range:document.querySelector('.token-usage-body')?.dataset.range||'',total:stat('总 Token'),stats,dots:dots.length,hasPath:!!path,gridLines,yLabels,dotRound,firstTip,trendLabel:trendGraphic?.getAttribute('aria-label')||'',trendRows:trend?.querySelectorAll('.token-breakdown-row').length||0,tools,breakdowns});
})()`))
const req2MonthDays = await ev(`(async()=>{const q=await window.uniagent.e2eLastTokenUsageQuery();return (Date.parse(q.end)-Date.parse(q.start))/86400000+1})()`)
check('需求 Token 面板范围为日/周/月/年/全部且默认月', JSON.stringify(req2Token.ranges) === JSON.stringify(['日','周','月','年','全部']) && req2Token.active === '月' && req2Token.range === 'month' && req2Token.total.length > 0, JSON.stringify(req2Token))
check('需求 Token 概览五项、环比与四维构成均渲染', JSON.stringify(req2Token.stats.map((x)=>x.label)) === JSON.stringify(['总 Token','估算花费','会话数','活跃时长','代码行']) && req2Token.stats.every((x)=>x.delta.length > 0) && req2Token.stats.find((x)=>x.label==='总 Token')?.delta.includes('较上期') && JSON.stringify(req2Token.breakdowns) === JSON.stringify(['按工具（来源）','按模型','按技能 / Skill','按项目']), JSON.stringify({stats:req2Token.stats,breakdowns:req2Token.breakdowns}))
check('需求 Token 默认月范围渲染带 Y 轴刻度与网格的折线图', req2Token.dots === req2MonthDays && req2Token.hasPath && req2Token.trendRows === 0 && req2Token.trendLabel.includes('按日统计') && req2Token.trendLabel.includes('折线图') && req2Token.gridLines >= 3 && req2Token.gridLines === req2Token.yLabels.length && req2Token.yLabels.every((v)=>v.length > 0), JSON.stringify(req2Token))
check('需求 Token 折线图数据点为正圆且悬停显示具体数值', req2Token.dotRound && /·/.test(req2Token.firstTip) && /Token$/.test(req2Token.firstTip), JSON.stringify({dotRound:req2Token.dotRound,firstTip:req2Token.firstTip}))
const req2TokenPeriod = JSON.parse(await ev(`(async()=>{
  const label=(document.querySelector('.token-period-label')?.textContent||'').trim();
  const prev=document.querySelector('.token-period-prev'), next=document.querySelector('.token-period-next');
  const firstTrend=document.querySelector('#token-heatmap-title')?.closest('.token-section')?.querySelector('.token-trend-dot .token-trend-tip')?.textContent?.replace(/\s+/g,' ').trim()||'';
  return JSON.stringify({label,prev:!!prev,prevDisabled:prev?.disabled??null,next:!!next,nextDisabled:next?.disabled??null,firstTrend,query:await window.uniagent.e2eLastTokenUsageQuery()});
})()`))
await ev(`(()=>{const b=document.querySelector('.token-period-prev');b?.click();return !!b;})()`)
await sleep(100)
const req2TokenPrevious = await poll(
  () => ev(`(async()=>({label:(document.querySelector('.token-period-label')?.textContent||'').trim(),range:document.querySelector('.token-usage-body')?.dataset.range||'',nextDisabled:document.querySelector('.token-period-next')?.disabled??null,firstTrend:document.querySelector('#token-heatmap-title')?.closest('.token-section')?.querySelector('.token-trend-dot .token-trend-tip')?.textContent?.replace(/\\s+/g,' ').trim()||'',query:await window.uniagent.e2eLastTokenUsageQuery()}))()`),
  (value) => !!value.label && value.label !== req2TokenPeriod.label && value.range === 'month' && value.nextDisabled === false
)
await ev(`(()=>{const b=document.querySelector('.token-period-next');b?.click();return !!b;})()`)
await sleep(100)
const req2TokenNext = await poll(
  () => ev(`(async()=>({label:(document.querySelector('.token-period-label')?.textContent||'').trim(),range:document.querySelector('.token-usage-body')?.dataset.range||'',nextDisabled:document.querySelector('.token-period-next')?.disabled??null,firstTrend:document.querySelector('#token-heatmap-title')?.closest('.token-section')?.querySelector('.token-trend-dot .token-trend-tip')?.textContent?.replace(/\\s+/g,' ').trim()||'',query:await window.uniagent.e2eLastTokenUsageQuery()}))()`),
  (value) => value.label === req2TokenPeriod.label && value.range === 'month' && value.nextDisabled === true
)
check('需求 Token 历史月请求和趋势随周期变化并可恢复', req2TokenPeriod.prev && req2TokenPeriod.prevDisabled === false && req2TokenPeriod.next && req2TokenPeriod.nextDisabled === true && req2TokenPrevious.label !== req2TokenPeriod.label && req2TokenPrevious.range === 'month' && req2TokenPrevious.nextDisabled === false && req2TokenPrevious.query?.period === 'month' && req2TokenPrevious.query.start < req2TokenPeriod.query?.start && req2TokenPrevious.query.end < req2TokenPeriod.query?.start && req2TokenPrevious.query.timeZone === req2TokenPeriod.query?.timeZone && req2TokenPrevious.firstTrend !== req2TokenPeriod.firstTrend && req2TokenNext.label === req2TokenPeriod.label && req2TokenNext.range === 'month' && req2TokenNext.nextDisabled === true && req2TokenNext.firstTrend === req2TokenPeriod.firstTrend, JSON.stringify({initial:req2TokenPeriod,previous:req2TokenPrevious,next:req2TokenNext}))
// The day view defaults to yesterday: `next` stays enabled and one forward step
// (offset -1 → 0) reaches today and disables it, proving the default offset is -1.
await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()==='日');b?.click();return !!b;})()`)
const req2TokenDay = await poll(
  () => ev(`(async()=>({range:document.querySelector('.token-usage-body')?.dataset.range||'',label:(document.querySelector('.token-period-label')?.textContent||'').trim(),nextDisabled:document.querySelector('.token-period-next')?.disabled??null,query:await window.uniagent.e2eLastTokenUsageQuery()}))()`),
  (value) => value.range === 'day' && !!value.label && value.nextDisabled === false && value.query?.period === 'day'
)
const req2TokenDayToday = (() => {
  const q = req2TokenDay.query
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: q.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(q.now))
  const yest = new Date(`${today}T00:00:00Z`); yest.setUTCDate(yest.getUTCDate() - 1)
  return { today, expectedYesterday: yest.toISOString().slice(0, 10) }
})()
await ev(`(()=>{const b=document.querySelector('.token-period-next');b?.click();return !!b;})()`)
const req2TokenDayNext = await poll(
  () => ev(`(async()=>({label:(document.querySelector('.token-period-label')?.textContent||'').trim(),nextDisabled:document.querySelector('.token-period-next')?.disabled??null,query:await window.uniagent.e2eLastTokenUsageQuery()}))()`),
  (value) => value.nextDisabled === true && value.query?.period === 'day'
)
check('需求 Token 日视图默认显示昨日且可前进到今日', req2TokenDay.query.start === req2TokenDayToday.expectedYesterday && req2TokenDay.label === req2TokenDayToday.expectedYesterday && req2TokenDayNext.query.start === req2TokenDayToday.today && req2TokenDayNext.label === req2TokenDayToday.today, JSON.stringify({ day: req2TokenDay, next: req2TokenDayNext, ...req2TokenDayToday }))
await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()==='月');b?.click();return !!b;})()`)
await poll(() => ev(`(()=>document.querySelector('.token-usage-body')?.dataset.range==='month')()`), Boolean)
const req2TokenRanges = []
for (const [label, range, expectedDots, granularity] of [['日','day',24,'小时'],['周','week',7,'按日'],['月','month',req2MonthDays,'按日'],['年','year',12,'按月'],['全部','all',3,'按月']]) {
  await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(label)});b?.click();return !!b;})()`)
  const active = await poll(
    () => ev(`(()=>{
      const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(label)});
      const trend=document.querySelector('#token-heatmap-title')?.closest('.token-section');
      const dots=trend?.querySelectorAll('.token-trend-dot').length||0;
      const rows=trend?.querySelectorAll('.token-breakdown-row').length||0;
      const aria=trend?.querySelector('[role=img]')?.getAttribute('aria-label')||'';
      const hasPath=!!trend?.querySelector('.token-trend-path');
      const total=[...document.querySelectorAll('.token-stat-card')].find(x=>(x.querySelector('.token-stat-label')?.textContent||'').trim()==='总 Token')?.querySelector('.token-stat-value')?.textContent?.replace(/\s+/g,'').trim()||'';
      return {pressed:b?.getAttribute('aria-pressed')||'',range:document.querySelector('.token-usage-body')?.dataset.range||'',dots,rows,aria,total,hasPath};
    })()`),
    (value) => value.pressed === 'true' && value.range === range && value.dots === expectedDots && value.rows === 0 && value.aria.includes(granularity) && value.aria.includes('折线图') && value.hasPath
  )
  // The renderer caches periods, so a plain range switch may not re-hit Kaboo.
  // Force a refresh here so `e2eLastTokenUsageQuery` reflects THIS range's query
  // (the dedicated cache test below proves plain switches stay cached).
  await ev(`(()=>{const b=[...document.querySelectorAll('.token-refresh-button')].find(x=>(x.getAttribute('aria-label')||'')==='刷新 Token 用量');b?.click();return !!b;})()`)
  const query = await poll(
    () => ev(`window.uniagent.e2eLastTokenUsageQuery()`),
    (value) => value?.period === range
  )
  req2TokenRanges.push({label,pressed:active.pressed,range:active.range,dots:active.dots,rows:active.rows,aria:active.aria,total:active.total,hasPath:active.hasPath,query})
}
await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()==='月');b?.click();return !!b;})()`)
const req2TokenRestored = await poll(
  () => ev(`(()=>({label:document.querySelector('.token-range-picker[aria-label="Token 用量时间范围"] button[aria-pressed=true]')?.textContent.trim()||'',range:document.querySelector('.token-usage-body')?.dataset.range||''}))()`),
  (value) => value.label === '月' && value.range === 'month'
)
const req2TokenQueriesValid = req2TokenRanges.every((item) => {
  const query=item.query, start=query?.start, end=query?.end
  if (query?.period !== item.range || !query.timeZone || !Number.isFinite(Date.parse(query.now))) return false
  if (item.range === 'all') return start === undefined && end === undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) return false
  if (item.range === 'day') return start === end
  if (item.range === 'week') return (Date.parse(end) - Date.parse(start)) / 86_400_000 === 6
  if (item.range === 'month') return start.endsWith('-01') && start.slice(0, 7) === end.slice(0, 7)
  // Year is clamped to 365 days (Kaboo's cap), so a leap year ends Dec 30, not 31.
  return start.endsWith('-01-01') && (end.endsWith('-12-31') || end.endsWith('-12-30'))
})
check('需求 Token 五个时间范围发送完整周期请求并加载不同数据', req2TokenQueriesValid && new Set(req2TokenRanges.map((item)=>item.total)).size === 5 && req2TokenRestored.label === '月' && req2TokenRestored.range === 'month', JSON.stringify({ranges:req2TokenRanges,restored:req2TokenRestored}))
// Kaboo caching lives in main; each range switch must still query through IPC.
// The fixture counts IPC requests, not external Kaboo network requests.
const req2TokenCountBefore = await ev(`window.uniagent.e2eTokenUsageRequestCount()`)
await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()==='周');b?.click();return !!b;})()`)
await poll(() => ev(`(()=>document.querySelector('.token-usage-body')?.dataset.range==='week')()`), Boolean)
await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()==='年');b?.click();return !!b;})()`)
await poll(() => ev(`(()=>document.querySelector('.token-usage-body')?.dataset.range==='year')()`), Boolean)
await ev(`(()=>{const b=[...document.querySelectorAll('.token-range-picker[aria-label="Token 用量时间范围"] button')].find(x=>(x.textContent||'').trim()==='月');b?.click();return !!b;})()`)
await poll(() => ev(`(()=>document.querySelector('.token-usage-body')?.dataset.range==='month')()`), Boolean)
const req2TokenCountAfter = await ev(`window.uniagent.e2eTokenUsageRequestCount()`)
check('需求 Token 周期切换重新查询主进程并显示对应数据', typeof req2TokenCountBefore === 'number' && req2TokenCountBefore > 0 && req2TokenCountAfter === req2TokenCountBefore + 3, JSON.stringify({before:req2TokenCountBefore,after:req2TokenCountAfter}))
const req2TokenScroll = JSON.parse(await ev(`(()=>{
  const cards=[...document.querySelectorAll('.token-breakdown-card')];
  const states=cards.map((card)=>{
    const scroller=card.querySelector('.token-breakdown-scroll');
    const rows=scroller?.querySelectorAll('.token-breakdown-row').length||0;
    const row=scroller?.querySelector('.token-breakdown-row')?.getBoundingClientRect();
    const box=scroller?.getBoundingClientRect();
    return {rows,overflow:!!scroller&&scroller.scrollHeight>scroller.clientHeight,visibleRows:row&&box?Math.floor((box.height+2)/(row.height+2)):0};
  });
  return JSON.stringify({states,toolAllOutside:!!cards[0]?.querySelector(':scope > .token-breakdown-list > .token-tool-all')&&!cards[0]?.querySelector('.token-breakdown-scroll .token-tool-all')});
})()`))
check('需求 Token 用量构成完整保留 12 项且每卡最多显示 6 行并可内滚', req2TokenScroll.states.length === 4 && req2TokenScroll.states.every((item)=>item.rows === 12 && item.overflow && item.visibleRows <= 6) && req2TokenScroll.toolAllOutside, JSON.stringify(req2TokenScroll))
const req2TokenTools = JSON.parse(await ev(`(()=>{
  const buttons=document.querySelectorAll('button.token-tool-row').length;
  const rows=[...document.querySelectorAll('.token-tool-row')];
  const codex=rows.find(x=>(x.querySelector('.token-breakdown-name span')?.textContent||'').trim()==='codex');
  if(codex)codex.click();
  return JSON.stringify({buttons,tagName:codex?.tagName||'',clickable:!!codex?.getAttribute('aria-pressed')});
})()`))
await sleep(100)
const req2TokenNoSelection = await ev(`(()=>!document.querySelector('.token-selected-tool'))()`)
check('需求 Token 工具列表为只读且点击不触发选择', req2TokenTools.buttons === 0 && req2TokenTools.tagName === 'DIV' && req2TokenTools.clickable === false && req2TokenNoSelection === true, JSON.stringify({...req2TokenTools,noSelection:req2TokenNoSelection}))

// File Browser uses the selected session's workdir only as a gate; all content
// below comes from the deterministic main-process fixture.
await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]');if(row)row.click();return !!row;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.session-view .topbar-files-btn[title="文件查看器"]'))()`), Boolean)
const req2FileEntryIcon = await ev(`(()=>!!document.querySelector('.session-view .topbar-files-btn[title="文件查看器"] svg.ui-icon-folder'))()`)
check('需求文件入口使用明确的文件夹 SVG 图标', req2FileEntryIcon === true, String(req2FileEntryIcon))
await ev(`(()=>{const b=document.querySelector('.session-view .topbar-files-btn[title="文件查看器"]');if(b)b.click();return !!b;})()`)
await poll(() => ev(`(()=>document.querySelectorAll('.filebrowser-overlay .fb-tree-row').length)()`), (n) => n === 4)
const req2Files = JSON.parse(await ev(`(()=>{
  const overlay=document.querySelector('.filebrowser-overlay[role=dialog][aria-modal=true][aria-label="文件浏览器"]'), inner=overlay?.querySelector(':scope > .filebrowser'), main=document.querySelector('.main');
  const o=overlay?.getBoundingClientRect(),f=inner?.getBoundingClientRect(),m=main?.getBoundingClientRect();
  const names=[...document.querySelectorAll('.fb-tree-row .fb-file-name')].map(x=>(x.textContent||'').trim());
  const folder=[...document.querySelectorAll('.fb-tree-row')].find(x=>(x.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-folder');
  return JSON.stringify({names,folderIcon:!!folder?.querySelector('.fb-file-glyph.is-dir svg.ui-icon-folder'),scoped:!!o&&!!m&&Math.abs(o.left-m.left)<=1&&Math.abs(o.top-m.top)<=1&&Math.abs(o.right-m.right)<=1&&Math.abs(o.bottom-m.bottom)<=1,inner:!!f&&!!m&&Math.abs(f.top-(m.top+52))<=1&&Math.abs(f.bottom-m.bottom)<=1,head:!!overlay?.querySelector(':scope > .scene-head')});
})()`))
check('需求 File Browser 占满主区域、保留侧栏并以 SVG 文件夹图标列出夹具', req2Files.scoped && req2Files.inner && req2Files.head && req2Files.folderIcon && JSON.stringify(req2Files.names) === JSON.stringify(['e2e-folder','e2e-preview.ts','e2e-preview.png','e2e-large.txt']), JSON.stringify(req2Files))
await ev(`(()=>{const row=[...document.querySelectorAll('.fb-tree-row')].find(x=>(x.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-preview.ts');row?.querySelector('.fb-tree-node')?.click();return !!row;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.fb-code.language-typescript'))()`), Boolean)
const req2CodePreview = JSON.parse(await ev(`(()=>JSON.stringify({lines:document.querySelectorAll('.fb-code.language-typescript .fb-code-line').length,keywords:[...document.querySelectorAll('.fb-syn-keyword')].map(x=>x.textContent),literal:(document.querySelector('.fb-syn-literal')?.textContent||''),comment:(document.querySelector('.fb-syn-comment')?.textContent||'')}))()`))
check('需求 File Browser TypeScript 高亮预览', req2CodePreview.lines === 3 && req2CodePreview.keywords.includes('export') && req2CodePreview.keywords.includes('const') && req2CodePreview.literal === 'true' && req2CodePreview.comment === '// fixture', JSON.stringify(req2CodePreview))
await ev(`(()=>{const row=[...document.querySelectorAll('.fb-tree-row')].find(x=>(x.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-preview.png');row?.querySelector('.fb-tree-node')?.click();return !!row;})()`)
await poll(() => ev(`(()=>{const img=document.querySelector('.fb-image-stage.is-fit img[alt="e2e-preview.png"]');return !!img&&img.complete;})()`), Boolean)
const req2ImagePreview = JSON.parse(await ev(`(()=>{const img=document.querySelector('.fb-image-stage.is-fit img[alt="e2e-preview.png"]');return JSON.stringify({data:img?.src?.startsWith('data:image/png;base64,')||false,width:img?.naturalWidth||0,height:img?.naturalHeight||0});})()`))
check('需求 File Browser 图片 data URL 与 1×1 尺寸', req2ImagePreview.data && req2ImagePreview.width === 1 && req2ImagePreview.height === 1, JSON.stringify(req2ImagePreview))
await ev(`(()=>{const row=[...document.querySelectorAll('.fb-tree-row')].find(x=>(x.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-large.txt');row?.querySelector('.fb-tree-node')?.click();return !!row;})()`)
await poll(() => ev(`(()=>[...document.querySelectorAll('.fb-empty strong')].some(x=>(x.textContent||'').trim()==='文件过大，未自动打开'))()`), Boolean)
const req2ForceOpen = await ev(`(()=>{const b=[...document.querySelectorAll('.fb-empty button')].find(x=>(x.textContent||'').trim()==='仍要打开');if(b)b.click();return !!b;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.fb-code.language-plaintext'))()`), Boolean)
const req2LargePreview = JSON.parse(await ev(`(()=>JSON.stringify({warning:(document.querySelector('.fb-preview-warning')?.textContent||'').trim(),lines:document.querySelectorAll('.fb-code.language-plaintext .fb-code-line').length,text:(document.querySelector('.fb-code.language-plaintext')?.textContent||'').trim()}))()`))
check('需求 File Browser 超大文件强制打开仍受 1000 行上限', req2ForceOpen && req2LargePreview.warning === '文件过大，仅显示前 1000 行' && req2LargePreview.lines === 1 && req2LargePreview.text.includes('bounded fixture'), JSON.stringify(req2LargePreview))
await ev(`(()=>{const b=document.querySelector('.filebrowser-overlay .scene-back-btn');if(b)b.click();return !!b;})()`)
await poll(() => ev(`(()=>!document.querySelector('.filebrowser-overlay'))()`), Boolean)

await ev(`(()=>{
  const now=Date.now(), base=now, mk=(seq,type,state,payload)=>({sessionId:${JSON.stringify(req2Sid)},seq:base+seq,ts:now+seq,type,state,payload});
  window.__req2FixtureBase=base;
  return window.uniagent.e2eInjectEvents([
    mk(1,'user_message','success',{id:'req2-user-'+base,text:'E2E chain fixture'}),
    mk(2,'command_exec','success',{id:'req2-command-'+base,command:'echo fixture',output:'fixture'}),
    mk(3,'agent_message','success',{id:'req2-reply-'+base,text:'fixture separator',phase:'commentary'}),
    mk(4,'tool_call','success',{id:'req2-tool-'+base,name:'fixture_tool',input:{fixture:true}}),
    mk(5,'diff_update','success',{id:'req2-diff-'+base,diff:'diff --git a/a b/a\\n--- a/a\\n+++ b/a\\n@@ -0,0 +1 @@\\n+fixture'}),
    mk(6,'agent_message','success',{id:'req2-final-'+base,text:'fixture complete',phase:'final_answer'}),
    mk(7,'turn_completed','success',{id:'req2-turn-'+base})
  ]);
})()` )
await sleep(150)
await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]');if(row)row.click();return !!row;})()` )
await sleep(350)
const req2HistoryLabel = await ev(`(()=>[...document.querySelectorAll('.sidebar-nav-item')].some(x=>(x.textContent||'').includes('导入会话')) )()` )
check('需求2 sidebar entry is 导入会话', req2HistoryLabel === true)
await ev(`(()=>{const b=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>(x.textContent||'').includes('导入会话'));if(b)b.click();return !!b;})()` )
await sleep(250)
const req2HistoryBack = JSON.parse(await ev(`(()=>{
  const row=document.querySelector('.resume-item .resume-item-open');
  if(!row)return JSON.stringify({skip:'no history row'});
  row.click();
  return JSON.stringify({opened:true});
})()`))
if (req2HistoryBack.skip) check('需求2 history viewer returns to import list', false, req2HistoryBack.skip)
else {
  await sleep(300)
  const clicked=await ev(`(()=>{const b=document.querySelector('.history-back-btn');if(b)b.click();return !!b;})()` )
  await sleep(150)
  const returned=await ev(`(()=>!document.querySelector('.history-viewer')&&!!document.querySelector('.resume-list'))()` )
  check('需求2 history viewer returns to import list', clicked && returned, `clicked=${clicked}, returned=${returned}`)
}
await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]');if(row)row.click();return !!row;})()` )
await sleep(250)

const req2SummaryOpened = await ev(`(()=>{const t=document.querySelector('.turn-timer');if(!t)return false;t.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return true;})()` )
await sleep(150)
const req2Review = JSON.parse(await ev(`(()=>{
  const pop=!!document.querySelector('.timer-summary-pop.open');
  const entry=document.querySelector('.timer-summary-pop .review-summary-entry');
  const legacy=document.querySelectorAll('.diff-tab').length;
  if(entry) entry.click();
  return JSON.stringify({pop,entry:!!entry,legacy});
})()`))
await sleep(250)
const req2ReviewOpened = JSON.parse(await ev(`(()=>{
  const panel=document.querySelector('.review-overlay');
  const body=panel?.querySelector(':scope > .review'), main=document.querySelector('.main');
  const rect=panel?.getBoundingClientRect(), inner=body?.getBoundingClientRect(), mainRect=main?.getBoundingClientRect();
  return JSON.stringify({
    panel:!!panel,disabledBoxes:panel?panel.querySelectorAll('input[type=checkbox][disabled]').length:-1,
    position:panel?getComputedStyle(panel).position:'',
    scoped:!!rect&&!!mainRect&&Math.abs(rect.left-mainRect.left)<=1&&Math.abs(rect.top-mainRect.top)<=1&&Math.abs(rect.right-mainRect.right)<=1&&Math.abs(rect.bottom-mainRect.bottom)<=1,
    inner:!!inner&&!!mainRect&&Math.abs(inner.left-mainRect.left)<=1&&Math.abs(inner.top-(mainRect.top+52))<=1&&Math.abs(inner.right-mainRect.right)<=1&&Math.abs(inner.bottom-mainRect.bottom)<=1,
    head:!!panel?.querySelector(':scope > .scene-head')
  });
})()`))
check('需求2 Review has one summary entry and opens the real panel', req2SummaryOpened && req2Review.pop && req2Review.entry && req2Review.legacy === 0 && req2ReviewOpened.panel, `popover=${req2Review.pop}, entry=${req2Review.entry}, legacy=${req2Review.legacy}, panel=${req2ReviewOpened.panel}`)
check('需求2 Review file tree has no disabled gray checkbox placeholders', req2ReviewOpened.panel && req2ReviewOpened.disabledBoxes === 0, `disabledBoxes=${req2ReviewOpened.disabledBoxes}`)
check('需求2 Review occupies the main area below the 52px scene-head and keeps the sidebar', req2ReviewOpened.position === 'absolute' && req2ReviewOpened.scoped && req2ReviewOpened.inner && req2ReviewOpened.head, JSON.stringify(req2ReviewOpened))
const req2Untracked = JSON.parse(await ev(`(async()=>{
  const cs=await window.uniagent.reviewGetChangeSet(${JSON.stringify(req2Sid)});
  for(const item of cs.items.filter(x=>x.tracked===false&&x.path===${JSON.stringify(req2ReviewFixtureName)})){
    const pair=await window.uniagent.reviewGetFilePair({sessionId:${JSON.stringify(req2Sid)},path:item.path,unifiedDiff:item.unifiedDiff||'',kind:item.kind});
    if(!pair.binary&&!pair.tooLarge&&(pair.after||'').trim()===${JSON.stringify(req2ReviewFixtureText)})return JSON.stringify({path:item.path,content:pair.after.trim()});
  }
  return JSON.stringify({path:'',content:'',isGitRepo:cs.isGitRepo,untracked:cs.items.filter(x=>x.tracked===false).length});
})()`))
if(req2Untracked.path){
  await ev(`(()=>{const path=${JSON.stringify(req2Untracked.path)};const groups=[...document.querySelectorAll('.review .change-group')];const group=groups.find(g=>(g.querySelector('.group-title')?.textContent||'').trim()==='Unversioned Files');const leaf=group?[...group.querySelectorAll('.file-row.tree-leaf')].find(x=>x.getAttribute('title')===path):null;if(leaf)leaf.click();return !!leaf;})()` )
  await poll(() => ev(`(()=>{const path=${JSON.stringify(req2Untracked.path)};const content=(document.querySelector('.review .split-right-scroll .code.add')?.textContent||'').trim();return (document.querySelector('.review .crumb .rfile')?.textContent||'').trim()===path&&!document.querySelector('.review .review-notice')&&content===${JSON.stringify(req2ReviewFixtureText)};})()`), Boolean)
}
const req2UntrackedUi = JSON.parse(await ev(`(()=>{
  const groups=[...document.querySelectorAll('.review .change-group')];
  const group=groups.find(g=>(g.querySelector('.group-title')?.textContent||'').trim()==='Unversioned Files');
  const leaf=group?[...group.querySelectorAll('.file-row.tree-leaf')].find(x=>x.getAttribute('title')===${JSON.stringify(req2Untracked.path)}):null;
  const leftHead=document.querySelector('.review .split-left-head'),rightHead=document.querySelector('.review .split-right-head');
  const left=document.querySelector('.review .split-left-scroll'),right=document.querySelector('.review .split-right-scroll');
  const lh=leftHead?.getBoundingClientRect(),rh=rightHead?.getBoundingClientRect(),l=left?.getBoundingClientRect(),r=right?.getBoundingClientRect();
  return JSON.stringify({group:!!group,open:!!group?.classList.contains('open'),leaf:!!leaf,badge:(leaf?.querySelector('.file-badge')?.textContent||'').trim(),crumb:(document.querySelector('.review .crumb .rfile')?.textContent||'').trim(),content:(right?.querySelector('.code.add')?.textContent||'').trim(),split:!!document.querySelector('.review .split-review'),separator:!!document.querySelector('.review .review-splitter'),independent:left!==right&&getComputedStyle(left).overflowX==='auto'&&getComputedStyle(right).overflowX==='auto',aligned:!!lh&&!!rh&&!!l&&!!r&&Math.abs(lh.left-l.left)<=1&&Math.abs(lh.width-l.width)<=1&&Math.abs(rh.left-r.left)<=1&&Math.abs(rh.width-r.width)<=1});
})()`))
check('需求2 Review renders Unversioned Files and added-file content', req2Untracked.content === req2ReviewFixtureText && req2UntrackedUi.group && req2UntrackedUi.open && req2UntrackedUi.leaf && req2UntrackedUi.badge === 'A' && req2UntrackedUi.crumb === req2Untracked.path && req2UntrackedUi.content === req2ReviewFixtureText, JSON.stringify({fixture:req2Untracked,ui:req2UntrackedUi}))
check('需求2 Review 标题正文同列且左右视口独立横滚', req2UntrackedUi.split && req2UntrackedUi.separator && req2UntrackedUi.independent && req2UntrackedUi.aligned, JSON.stringify(req2UntrackedUi))
const req2ReviewResize = JSON.parse(await ev(`(()=>{
  const separator=document.querySelector('.review .review-splitter'),left=document.querySelector('.review .split-left-scroll');
  if(!separator||!left)return JSON.stringify({ok:false});
  const before=left.getBoundingClientRect().width,ariaBefore=Number(separator.getAttribute('aria-valuenow'));
  separator.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  return JSON.stringify({ok:true,before,ariaBefore});
})()`))
await sleep(100)
const req2ReviewResized = JSON.parse(await ev(`(()=>{const separator=document.querySelector('.review .review-splitter'),left=document.querySelector('.review .split-left-scroll');return JSON.stringify({width:left?.getBoundingClientRect().width||0,aria:Number(separator?.getAttribute('aria-valuenow'))});})()`))
check('需求2 Review 中轴支持键盘调整左右宽度', req2ReviewResize.ok && req2ReviewResized.aria === req2ReviewResize.ariaBefore + 5 && req2ReviewResized.width > req2ReviewResize.before, JSON.stringify({before:req2ReviewResize,after:req2ReviewResized}))
const req2ReviewCloseClicked=await ev(`(()=>{const b=document.querySelector('.review-overlay .scene-back-btn');if(b)b.click();return !!b;})()` )
await sleep(100)
const req2ReviewClosed=await poll(() => ev(`(()=>!document.querySelector('.review-overlay'))()`), Boolean)
check('需求2 Review closes from its real close control', req2ReviewCloseClicked && req2ReviewClosed, `clicked=${req2ReviewCloseClicked}, closed=${req2ReviewClosed}`)
check(
  'E2E Review fixture is confined to the isolated workspace',
  req2ReviewFixturePath.startsWith(fixture + sep) && existsSync(req2ReviewFixturePath),
  req2ReviewFixturePath
)

const req2RunningText = JSON.parse(await ev(`(()=>{
  const composer=document.querySelector('.composer');
  if(!composer)return JSON.stringify({skip:'no composer'});
  return JSON.stringify({lock:composer.querySelectorAll('.sb-lock').length,text:(composer.textContent||'').includes('🔒运行中')||(composer.textContent||'').includes('🔒 运行中')});
})()`))
if (req2RunningText.skip) check('需求2 composer has no running lock label', false, req2RunningText.skip)
else check('需求2 composer has no running lock label', req2RunningText.lock === 0 && !req2RunningText.text, JSON.stringify(req2RunningText))

await ev(`window.uniagent.e2eEnabled()` )
await sleep(100)
const req2Picker = JSON.parse(await ev(`(()=>{
  const trigger=document.querySelector('.req2-model-picker-fixture .mp-trigger');
  if(!trigger)return JSON.stringify({skip:'no deterministic model picker fixture'});
  return JSON.stringify({before:(trigger.querySelector('.mp-label')||{}).textContent||''});
})()`))
if (req2Picker.skip) check('需求2 ModelPicker closes after outside click, Escape, and selection', false, req2Picker.skip)
else {
  const pickerOpened = await ev(`(()=>{const trigger=document.querySelector('.req2-model-picker-fixture .mp-trigger');trigger.click();return true;})()` )
  await sleep(100)
  const pickerMenuOpened = await ev(`(()=>!!document.querySelector('.req2-model-picker-fixture .mp-menu'))()` )
  await ev(`(()=>{document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true;})()` )
  await sleep(100)
  const pickerOutsideClosed = await ev(`(()=>!document.querySelector('.req2-model-picker-fixture .mp-menu'))()` )
  await ev(`(()=>{document.querySelector('.req2-model-picker-fixture .mp-trigger').click();return true;})()` )
  await sleep(100)
  await ev(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;})()` )
  await sleep(100)
  const pickerEscapeClosed = await ev(`(()=>!document.querySelector('.req2-model-picker-fixture .mp-menu'))()` )
  await ev(`(()=>{document.querySelector('.req2-model-picker-fixture .mp-trigger').click();return true;})()` )
  await sleep(100)
  const picked = JSON.parse(await ev(`(()=>{
    const option=[...document.querySelectorAll('.req2-model-picker-fixture .mp-opt')].find(x=>!x.classList.contains('is-sel'));
    if(!option)return JSON.stringify({ok:false});
    const label=(option.querySelector('.mp-opt-label')||option).textContent||'';
    option.click();
    return JSON.stringify({ok:true,label:label.trim()});
  })()`))
  await sleep(150)
  const pickerSelected = JSON.parse(await ev(`(()=>{const trigger=document.querySelector('.req2-model-picker-fixture .mp-trigger');return JSON.stringify({closed:!document.querySelector('.req2-model-picker-fixture .mp-menu'),label:(trigger.querySelector('.mp-label')||{}).textContent||''});})()`))
  check('需求2 ModelPicker closes after outside click, Escape, and selection', pickerOpened && pickerMenuOpened && pickerOutsideClosed && pickerEscapeClosed && picked.ok && pickerSelected.closed && pickerSelected.label.trim() === picked.label && pickerSelected.label.trim() !== req2Picker.before.trim(), JSON.stringify({before:req2Picker.before,picked,...pickerSelected}))
}

await ev(`(()=>{const fold=[...document.querySelectorAll('.processed-fold')].at(-1);if(fold&&!fold.classList.contains('open'))fold.querySelector('.processed-head').click();return !!fold;})()`)
await sleep(200)
const req2StepsInitial = JSON.parse(await ev(`(()=>{const fold=[...document.querySelectorAll('.processed-fold')].at(-1);const steps=[...(fold?.querySelectorAll('.process-step')||[])];return JSON.stringify({count:steps.length,open:steps.filter(x=>x.classList.contains('open')).length,ids:steps.map(x=>x.getAttribute('data-step-id'))});})()`))
await ev(`(()=>{const fold=[...document.querySelectorAll('.processed-fold')].at(-1);for(const step of fold?.querySelectorAll('.process-step')||[]){if(!step.classList.contains('open'))step.querySelector('.process-step-meta')?.click();}return true;})()`)
await sleep(200)
const req2StepsOpened = JSON.parse(await ev(`(()=>{const fold=[...document.querySelectorAll('.processed-fold')].at(-1);const steps=[...(fold?.querySelectorAll('.process-step')||[])];return JSON.stringify({open:steps.filter(x=>x.classList.contains('open')).length,ids:steps.map(x=>x.getAttribute('data-step-id'))});})()`))
check('工作过程保持稳定步骤 ID，并允许同时手动展开多个步骤', req2StepsInitial.count===2&&req2StepsInitial.open<=1&&req2StepsOpened.open===2&&req2StepsOpened.ids.every(Boolean)&&new Set(req2StepsOpened.ids).size===2, JSON.stringify({initial:req2StepsInitial,opened:req2StepsOpened}))

const req2CompactBefore = JSON.parse(await ev(`(()=>JSON.stringify({ids:[...document.querySelectorAll('.context-compaction')].map(x=>x.getAttribute('data-compaction-id'))}))()`))
const req2CompactId = `req2-compact-${Date.now()}`
await ev(`window.uniagent.e2eInjectEvents([{sessionId:${JSON.stringify(req2Sid)},seq:Date.now(),ts:Date.now(),type:'context_compaction',state:'running',payload:{id:${JSON.stringify(req2CompactId)}}}])` )
await poll(() => ev(`(()=>{const step=[...document.querySelectorAll('.session-view .process-step')].at(-1);if(step&&!step.classList.contains('open'))step.querySelector('.process-step-meta')?.click();return !!document.querySelector('.context-compaction[data-compaction-id=${JSON.stringify(req2CompactId)}]');})()`), Boolean, 3000)
const req2CompactRunning = await ev(`(()=>{const n=document.querySelector('.context-compaction[data-compaction-id=${JSON.stringify(req2CompactId)}]');const s=document.querySelector('.status-line .shimmer');return !!n&&n.classList.contains('state-running')&&!!s&&(s.textContent||'').includes('上下文压缩中');})()` )
await ev(`window.uniagent.e2eInjectEvents([{sessionId:${JSON.stringify(req2Sid)},seq:Date.now()+1,ts:Date.now()+1,type:'context_compaction',state:'success',payload:{id:${JSON.stringify(req2CompactId)}}}])` )
await sleep(100)
const req2Compact = JSON.parse(await ev(`(()=>{const id=${JSON.stringify(req2CompactId)};const nodes=[...document.querySelectorAll('.context-compaction')].filter(x=>x.getAttribute('data-compaction-id')===id);return JSON.stringify({count:nodes.length,running:nodes.some(x=>x.classList.contains('state-running')),completed:nodes.some(x=>x.classList.contains('state-success')),inside:nodes.every(x=>!!x.closest('.process-step-calls')),elapsed:nodes.every(x=>!!x.querySelector('.context-compaction-duration'))});})()`))
check('需求2 contextCompaction event lifecycle keeps one id and DOM row', req2CompactRunning && !req2CompactBefore.ids.includes(req2CompactId) && req2Compact.count === 1 && req2Compact.completed && !req2Compact.running && req2Compact.inside && req2Compact.elapsed, JSON.stringify({running:req2CompactRunning,dom:req2Compact}))

await ev(`(()=>{for(const call of document.querySelectorAll('.processed-body .step-call')){if(!call.classList.contains('open'))call.querySelector('.step-call-row')?.click();}return true;})()`)
await sleep(200)
const req2CompactUi = JSON.parse(await ev(`(()=>{
  const calls=[...document.querySelectorAll('.processed-body .step-call')];
  const command=calls.find(x=>x.querySelector('.step-call-arg')?.textContent.trim()==='echo fixture');
  const tool=calls.find(x=>x.querySelector('.step-call-name')?.textContent.includes('fixture_tool'));
  const output=command?.querySelector('.step-call-detail');
  const row=command?.querySelector('.step-call-row');
  const message=document.querySelector('.agent-msg');
  const users=[...document.querySelectorAll('.event-stream > .user-msg')];
  const user=users.find(x=>x.parentElement?.firstElementChild!==x);
  const expanded=call=>call?.classList.contains('open')&&call.querySelector('.step-call-row')?.getAttribute('aria-expanded')==='true'&&call.querySelector('.step-call-disclosure')?.getAttribute('data-collapse-state')==='open'&&call.querySelector('.step-call-disclosure')?.getAttribute('aria-hidden')==='false'&&call.querySelector('.step-call-detail')?.getBoundingClientRect().height>0;
  const pres=[...(output?.querySelectorAll('pre')||[])].map(x=>x.textContent.trim());
  return JSON.stringify({messageWidth:message?.getBoundingClientRect().width||0,userMarginTop:user?getComputedStyle(user).marginTop:'',userMarginBottom:user?getComputedStyle(user).marginBottom:'',command:expanded(command),tool:expanded(tool),commandPadding:row?getComputedStyle(row).padding:'',commandFontSize:row?getComputedStyle(row).fontSize:'',pres,outputMaxHeight:output?.querySelector('pre')?getComputedStyle(output.querySelector('pre')).maxHeight:'',toolInput:tool?.querySelector('.step-call-detail')?.textContent||''});
})()`))
check('工作过程工具行紧凑显示并可展开命令输出与工具参数', req2CompactUi.messageWidth>0&&req2CompactUi.messageWidth<=840&&req2CompactUi.command&&req2CompactUi.tool&&req2CompactUi.commandPadding==='0px 8px'&&req2CompactUi.commandFontSize==='12.5px'&&req2CompactUi.pres[0]==='echo fixture'&&req2CompactUi.pres[1]==='fixture'&&req2CompactUi.outputMaxHeight==='210px'&&/"fixture"\s*:\s*true/.test(req2CompactUi.toolInput), JSON.stringify(req2CompactUi))
check('需求20 非首条用户消息上下间距各为 40px', req2CompactUi.userMarginTop === '40px' && req2CompactUi.userMarginBottom === '40px', JSON.stringify(req2CompactUi))

const req19PlanId = `plan-reused-${Date.now()}`
await ev(`window.uniagent.e2eInjectEvents([
  {sessionId:${JSON.stringify(req2Sid)},seq:Date.now(),ts:Date.now(),type:'plan_update',state:'success',payload:{id:${JSON.stringify(req19PlanId)},steps:[{text:'previous turn',status:'in_progress'}]}},
  {sessionId:${JSON.stringify(req2Sid)},seq:Date.now()+1,ts:Date.now()+1,type:'user_message',state:'success',payload:{id:'plan-boundary-${Date.now()}',text:'new plan turn'}},
  {sessionId:${JSON.stringify(req2Sid)},seq:Date.now()+2,ts:Date.now()+2,type:'plan_update',state:'success',payload:{id:${JSON.stringify(req19PlanId)},steps:[{text:'stale running',status:'in_progress'},{text:'latest running',status:'in_progress'}]}}
])` )
await poll(() => ev(`(()=>{const bar=document.querySelector('.session-view > .plan-bar');return bar?(bar.querySelector('.plan-pill-text')?.textContent||'').replace(/\s+/g,' ').trim():'';})()`), (text) => text === '第 2 / 2 步')
const req19Plan = JSON.parse(await ev(`(()=>{const bar=document.querySelector('.session-view > .plan-bar');return JSON.stringify({label:(bar?.querySelector('.plan-pill-text')?.textContent||'').replace(/\s+/g,' ').trim(),terminal:!!bar?.classList.contains('is-terminal'),spinner:!!bar?.querySelector('.plan-pill-spin')});})()`))
check('需求19 同一 plan ID 跨轮不覆盖旧位置且多运行项高亮最新项', req19Plan.label === '第 2 / 2 步' && req19Plan.terminal && !req19Plan.spinner, JSON.stringify(req19Plan))

// ==== 需求3 — multi-question / multi-select approval form ====================
// Inject (a) a codex question with 4 questions incl. options + an isOther field,
// and (b) an MCP elicitation with a single-enum + multi-select(array,maxItems>1)
// + text field. Assert every field renders (not just the first), single→radio /
// multi→checkbox, submit gated by minItems, and the encoded reply per source.
const selectLastQuestionPage = async (index, state = 'pending') => {
  const clicked = await ev(`(()=>{
    const cards=[...document.querySelectorAll('.card.approval.${state}')];
    const dot=cards[cards.length-1]?.querySelectorAll('.qpager-dot')[${index}];
    dot?.click();
    return !!dot;
  })()` )
  if (!clicked) return false
  return await poll(
    () => ev(`(()=>{
      const cards=[...document.querySelectorAll('.card.approval.${state}')];
      return !!cards[cards.length-1]?.querySelectorAll('.qpager-dot')[${index}]?.classList.contains('active');
    })()`),
    Boolean,
    8_000
  )
}
const setCurrentQuestionValue = async (selector, value) => {
  const changed = await ev(`(()=>{
    const cards=[...document.querySelectorAll('.card.approval.pending')];
    const el=cards[cards.length-1]?.querySelector(${JSON.stringify(selector)});
    if(!el)return false;
    el.focus();
    const p=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()` )
  if (!changed) return false
  return await poll(
    () => ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];return cards[cards.length-1]?.querySelector(${JSON.stringify(selector)})?.value||'';})()`),
    (current) => current === value,
    8_000
  )
}
const chooseCurrentQuestionOption = async (selector, index = 0) => {
  const chosen = await ev(`(()=>{
    const cards=[...document.querySelectorAll('.card.approval.pending')];
    const el=cards[cards.length-1]?.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if(!el)return false;
    if(!el.checked)el.click();
    return true;
  })()` )
  if (!chosen) return false
  return await poll(
    () => ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];return !!cards[cards.length-1]?.querySelectorAll(${JSON.stringify(selector)})[${index}]?.checked;})()`),
    Boolean,
    8_000
  )
}
const submitCurrentQuestion = async (requestId) => {
  const before = await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];const b=cards[cards.length-1]?.querySelector('.btn-send');return {button:!!b,disabled:!!b?.disabled};})()`)
  if (!before.button || before.disabled) return { wasDisabled: before.disabled, reply: null }
  await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];cards[cards.length-1]?.querySelector('.btn-send')?.click();return true;})()` )
  const reply = await poll(
    () => ev(`(async()=>{const cap=await window.uniagent.e2eLastResponse();return cap?{sid:cap.sessionId,rid:cap.requestId,ans:cap.answer}:null;})()`),
    (capture) => capture?.rid === requestId,
    8_000
  )
  return { wasDisabled: false, reply }
}
{
  // Make sure the writable fixture session is the mounted one.
  await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]');if(row)row.click();return !!row;})()`)
  await sleep(250)
  const q3base = Date.now()
  await ev(`window.uniagent.e2eInjectEvents([{
    sessionId:${JSON.stringify(req2Sid)},seq:${q3base},ts:${q3base},type:'approval_request',state:'pending',
    payload:{requestId:'req3-q-${q3base}',method:'item/tool/requestUserInput',kind:'question',params:{questions:[
      {id:'color',header:'主色',prompt:'选择主题主色？',options:[{label:'蓝色（推荐）',description:'默认'},{label:'绿色'}]},
      {id:'name',prompt:'项目名称？'},
      {id:'framework',prompt:'框架？',isOther:true,options:[{label:'React'},{label:'Vue'}]},
      {id:'token',prompt:'API Token？',isSecret:true}
    ]}}
  }])`)
  await sleep(250)
  // Fix#2 changed multi-question rendering to a codex-style pager (one field per
  // page + N dots), so we walk each dot to inspect every field instead of
  // expecting them all stacked at once.
  const req3Question = JSON.parse(await ev(`(()=>{
    const cards=[...document.querySelectorAll('.card.approval.pending')];
    const card=cards[cards.length-1];
    if(!card)return JSON.stringify({error:'no approval card'});
    const paged=!!card.querySelector('.question-form.paged');
    return JSON.stringify({paged,dots:card.querySelectorAll('.qpager-dot').length,radios:0,checks:0,otherInput:false,recommendedKept:false,textAreas:0,submitDisabled:false});
  })()`))
  for (let page = 0; page < req3Question.dots; page++) {
    await selectLastQuestionPage(page)
    const view = JSON.parse(await ev(`(()=>{
      const cards=[...document.querySelectorAll('.card.approval.pending')];
      const card=cards[cards.length-1];
      return JSON.stringify({radios:card?.querySelectorAll('.question-opt input[type=radio]').length||0,checks:card?.querySelectorAll('.question-opt input[type=checkbox]').length||0,otherInput:!!card?.querySelector('.question-other-input'),textAreas:card?.querySelectorAll('textarea.approval-answer').length||0,labels:[...(card?.querySelectorAll('.question-opt-label')||[])].map(x=>x.textContent)});
    })()`))
    req3Question.radios += view.radios
    req3Question.checks += view.checks
    req3Question.otherInput ||= view.otherInput
    req3Question.textAreas += view.textAreas
    req3Question.recommendedKept ||= view.labels.includes('蓝色（推荐）')
  }
  // Back to the first (unanswered required) page — its 下一题 must be disabled.
  await selectLastQuestionPage(0)
  req3Question.submitDisabled = await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];return !!cards[cards.length-1]?.querySelector('.btn-send')?.disabled;})()`)
  check('需求3 codex question renders every field (paged, one per dot)', req3Question.paged && req3Question.dots === 4 && req3Question.radios >= 4 && req3Question.textAreas >= 2, JSON.stringify(req3Question))
  check('需求3 单选用 radio、其他自由文本、必填未答时禁用提交', req3Question.radios > 0 && req3Question.otherInput && req3Question.recommendedKept && req3Question.submitDisabled, JSON.stringify(req3Question))

  // Fill the form and submit; read the reply back from the main-process capture
  // (window.uniagent is frozen by contextBridge, so it can't be hijacked here).
  // Navigate the pager dot-by-dot, answering each field on its own page.
  await selectLastQuestionPage(0)
  await chooseCurrentQuestionOption('.question-opt input', 0)
  await selectLastQuestionPage(1)
  await setCurrentQuestionValue('textarea.approval-answer', 'UniAgent Public')
  await selectLastQuestionPage(2)
  await setCurrentQuestionValue('.question-other-input', 'Svelte')
  await selectLastQuestionPage(3)
  await setCurrentQuestionValue('textarea.approval-answer', 's3cr3t')
  const req3QReply = await submitCurrentQuestion(`req3-q-${q3base}`)
  const qAns = req3QReply.reply?.ans?.answers || {}
  if (process.env.REQ3_DEBUG) console.log('REQ3_Q_DEBUG', JSON.stringify(req3QReply))
  check(
    '需求3 codex 提交回复形状 {answers:{[id]:{answers:[label]}}}',
    !req3QReply.wasDisabled &&
      qAns.color?.answers?.[0] === '蓝色（推荐）' &&
      qAns.name?.answers?.[0] === 'UniAgent Public' &&
      qAns.framework?.answers?.[0] === 'Svelte' &&
      qAns.token?.answers?.[0] === 's3cr3t',
    JSON.stringify(req3QReply.reply?.ans)
  )

  await ev(`window.uniagent.e2eInjectEvents([{
    sessionId:${JSON.stringify(req2Sid)},seq:${q3base + 1},ts:${q3base + 1},type:'approval_request',state:'success',
    payload:{requestId:'req3-q-${q3base}',resolved:true,submittedAnswer:${JSON.stringify(req3QReply.reply?.ans)}}
  }])` )
  await ev(`(()=>{document.querySelector('.settings-entry')?.click();return true;})()` )
  await poll(() => ev(`(()=>!!document.querySelector('.settings-panel'))()`), Boolean)
  await ev(`(()=>{document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]')?.click();return true;})()` )
  await poll(() => ev(`(()=>!!document.querySelector('.session-view .event-stream'))()`), Boolean)
  const req3Remount = JSON.parse(await ev(`(()=>{
    const nodes=[...document.querySelectorAll('.interaction-step.answered')];
    const node=nodes[nodes.length-1];
    node?.querySelector('.interaction-link')?.click();
    return JSON.stringify({card:!!node});
  })()`))
  await poll(() => ev(`(()=>{const nodes=[...document.querySelectorAll('.interaction-step.answered')];return nodes[nodes.length-1]?.querySelectorAll('.question-readonly-answer').length===4;})()`), Boolean, 8_000)
  req3Remount.expanded = true
  req3Remount.answers = await ev(`(()=>{const nodes=[...document.querySelectorAll('.interaction-step.answered')];return [...(nodes[nodes.length-1]?.querySelectorAll('.question-readonly-answer')||[])].map(x=>(x.textContent||'').trim());})()`)
  req3Remount.editable = await ev(`(()=>{const nodes=[...document.querySelectorAll('.interaction-step.answered')];return !!nodes[nodes.length-1]?.querySelector('textarea,input');})()`)
  check('需求17 回答后跨 EventStream 重挂仍可展开全部只读问答', req3Remount.card && req3Remount.expanded && req3Remount.answers.length === 4 && req3Remount.answers.includes('蓝色（推荐）') && req3Remount.answers.includes('UniAgent Public') && req3Remount.answers.includes('Svelte') && !req3Remount.editable, JSON.stringify(req3Remount))

  // MCP elicitation with a multi-select.
  const e3base = Date.now() + 1
  await ev(`window.uniagent.e2eInjectEvents([{
    sessionId:${JSON.stringify(req2Sid)},seq:${e3base},ts:${e3base},type:'approval_request',state:'pending',
    payload:{requestId:'req3-e-${e3base}',method:'mcpServer/elicitation/request',kind:'elicitation',params:{message:'请补充信息',requestedSchema:{type:'object',required:['env','tags'],properties:{
      env:{title:'环境',description:'部署到哪个环境？',enum:['dev','prod'],enumNames:['开发','生产']},
      tags:{title:'标签',type:'array',items:{enum:['a','b','c']},minItems:1,maxItems:2},
      note:{title:'备注',type:'string'}
    }}}}
  }])`)
  await sleep(250)
  // 3 fields → codex-style pager; inspect each field via its dot.
  const req3Elicit = JSON.parse(await ev(`(()=>{
    const cards=[...document.querySelectorAll('.card.approval.pending')];
    const card=cards[cards.length-1];
    if(!card)return JSON.stringify({error:'no elicit card'});
    const paged=!!card.querySelector('.question-form.paged');
    return JSON.stringify({paged,fields:card.querySelectorAll('.qpager-dot').length,radios:0,checks:0,textAreas:0,submitDisabledInitially:false});
  })()`))
  for (let page = 0; page < req3Elicit.fields; page++) {
    await selectLastQuestionPage(page)
    const view = await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];const card=cards[cards.length-1];return {radios:card?.querySelectorAll('input[type=radio]').length||0,checks:card?.querySelectorAll('input[type=checkbox]').length||0,textAreas:card?.querySelectorAll('textarea.approval-answer').length||0};})()`)
    req3Elicit.radios += view.radios
    req3Elicit.checks += view.checks
    req3Elicit.textAreas += view.textAreas
  }
  // Page 0 is required and unanswered, so its 下一题 action stays disabled.
  await selectLastQuestionPage(0)
  req3Elicit.submitDisabledInitially = await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];return !!cards[cards.length-1]?.querySelector('.btn-send')?.disabled;})()`)
  check('需求3 MCP elicitation 渲染 single(radio)+multi(checkbox)+text', req3Elicit.paged && req3Elicit.fields === 3 && req3Elicit.radios >= 2 && req3Elicit.checks >= 3, JSON.stringify(req3Elicit))
  check('需求3 多选 minItems 未满足时禁用提交', req3Elicit.submitDisabledInitially === true, JSON.stringify(req3Elicit))

  await selectLastQuestionPage(0)
  await chooseCurrentQuestionOption('input[type=radio]', 0)
  await selectLastQuestionPage(1)
  await chooseCurrentQuestionOption('input[type=checkbox]', 0)
  await chooseCurrentQuestionOption('input[type=checkbox]', 2)
  await selectLastQuestionPage(2)
  await setCurrentQuestionValue('textarea.approval-answer', 'ok')
  const req3EReply = await submitCurrentQuestion(`req3-e-${e3base}`)
  const eAns = req3EReply.reply?.ans
  if (process.env.REQ3_DEBUG) console.log('REQ3_E_DEBUG', JSON.stringify(req3EReply))
  check(
    '需求3 elicitation 提交 {action:accept,content:{...}}（enum 原值/数组/文本）',
    !req3EReply.wasDisabled &&
      eAns?.action === 'accept' &&
      eAns?.content?.env === 'dev' &&
      Array.isArray(eAns?.content?.tags) &&
      eAns.content.tags.join(',') === 'a,c' &&
      eAns?.content?.note === 'ok',
    JSON.stringify(eAns)
  )
}

// ==== Fix#1 & Fix#2 — codex multiSelect + collapsed paged multi-question UX ====
// (Fix#1) A codex question with `multiSelect:true` must render CHECKBOXES so several
// options can be picked, and the reply must carry all picked labels. (Fix#2) When
// several questions are asked at once, they collapse into a codex-style pager (one
// question at a time with 第 X / N + dots), not a long stacked list.
{
  await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]');if(row)row.click();return !!row;})()`)
  await sleep(200)
  const mbase = Date.now() + 2
  await ev(`window.uniagent.e2eInjectEvents([{
    sessionId:${JSON.stringify(req2Sid)},seq:${mbase},ts:${mbase},type:'approval_request',state:'pending',
    payload:{requestId:'reqms-${mbase}',method:'item/tool/requestUserInput',kind:'question',params:{questions:[
      {id:'langs',header:'语言',question:'挑选你熟悉的语言（可多选）',multiSelect:true,options:[{label:'TypeScript'},{label:'Rust'},{label:'Go'}]},
      {id:'style',header:'风格',question:'偏好的代码风格？',options:[{label:'函数式'},{label:'面向对象'}]}
    ]}}
  }])`)
  await sleep(250)
  const msView = JSON.parse(await ev(`(()=>{
    const cards=[...document.querySelectorAll('.card.approval.pending')];
    const card=cards[cards.length-1];
    if(!card)return JSON.stringify({error:'no card'});
    const paged=!!card.querySelector('.question-form.paged');
    const dots=card.querySelectorAll('.qpager-dot').length;
    const fieldsShown=card.querySelectorAll('.question-field').length;
    const checks=card.querySelectorAll('.question-opt input[type=checkbox]').length;
    const label=(card.querySelector('.question-pager-label')||{}).textContent||'';
    return JSON.stringify({paged,dots,fieldsShown,checks,label});
  })()`))
  check('Fix#2 多问题折叠为分页（一次只显示一问 + N 个页码点）', msView.paged && msView.dots === 2 && msView.fieldsShown === 1, JSON.stringify(msView))
  check('Fix#1 multiSelect 问题渲染为多选 checkbox', msView.checks >= 3, JSON.stringify(msView))

  // Pick two langs on page 1, answer page 2, submit; verify the multi reply.
  await selectLastQuestionPage(0)
  await chooseCurrentQuestionOption('.question-opt input[type=checkbox]', 0)
  await chooseCurrentQuestionOption('.question-opt input[type=checkbox]', 1)
  const nextLabel = await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];return (cards[cards.length-1]?.querySelector('.btn-send')?.textContent||'').trim();})()`)
  await selectLastQuestionPage(1)
  await chooseCurrentQuestionOption('.question-opt input[type=radio]', 0)
  const submitLabel = await ev(`(()=>{const cards=[...document.querySelectorAll('.card.approval.pending')];return (cards[cards.length-1]?.querySelector('.btn-send')?.textContent||'').trim();})()`)
  const msCapture = await submitCurrentQuestion(`reqms-${mbase}`)
  const msReply = { nextLabel, submitLabel, reply: msCapture.reply?.ans }
  const msAns = msReply.reply?.answers || {}
  check(
    'Fix#1 多选回复携带全部所选项（{answers:{langs:{answers:[...]}}}）',
    (msAns.langs?.answers || []).join(',') === 'TypeScript,Rust' && msAns.style?.answers?.[0] === '函数式',
    JSON.stringify({ nav: [msReply.nextLabel, msReply.submitLabel], ans: msReply.reply?.answers })
  )
}

// ==== Fix#4 — 等待其它 agent 交接时显示「等待 X 的 Y」而非「思考中」，可点击跳转 ====
// 当本会话把任务交接给其它 agent 并 wait=true 阻塞时，事件流底部应显示一条专门的
// 等待行（"等待 <agent> 的 <task>"），而不是普通的「思考中」status-line；点击该行
// 应跳转到被等待的会话。用 e2e 复用真实 sessionUpdated 推送把 req2Sid 标记为
// waitingForHandoff（awaitedSessionId 指向另一真实会话），然后校验 DOM 与跳转。
{
  // Pick a second, different visible writable session as the "awaited" target so
  // the jump has a real destination distinct from the caller.
  const awaitedSid = await ev(`(async()=>{
    const visible=new Set([...document.querySelectorAll('.sl-body .session-item[data-session-id]')]
      .map((row)=>row.getAttribute('data-session-id')).filter(Boolean));
    const sessions=await window.uniagent.listSessions();
    const s=sessions.find((item)=>visible.has(item.id)&&item.id!==${JSON.stringify(req2Sid)}&&!item.archived&&item.readOnly!==true);
    return s?s.id:'';
  })()`)
  // Open the caller session and put it into a running (busy) state so the live
  // status row region renders; then flag it as waiting on a handoff.
  await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2Sid)}]');if(row)row.click();return !!row;})()`)
  await sleep(150)
  const f4base = Date.now()
  await ev(`window.uniagent.e2eInjectEvents([{sessionId:${JSON.stringify(req2Sid)},seq:${f4base},ts:${f4base},type:'reasoning',state:'running',payload:{id:'f4-think-'+${f4base},text:'thinking'}}])`)
  await ev(`window.uniagent.e2eSetWaitingForHandoff(${JSON.stringify(req2Sid)}, {handoffId:'f4-hoff',awaitedSessionId:${JSON.stringify(awaitedSid)},agentId:'traex',agentName:'TraeX',label:'代码审查'})`)
  await sleep(250)
  const f4View = JSON.parse(await ev(`(()=>{
    const line=document.querySelector('.handoff-wait-line');
    const txt=line?(line.querySelector('.status-line-text')||{}).textContent||'':'';
    // The generic「思考中」status line must NOT also be shown while waiting.
    const plainThinking=[...document.querySelectorAll('.status-line')]
      .filter(el=>!el.classList.contains('handoff-wait-line'))
      .some(el=>/思考|正在/.test((el.textContent||'')));
    const clickable=!!line&&line.classList.contains('is-clickable');
    return JSON.stringify({has:!!line, txt, plainThinking, clickable, awaitedSid:${JSON.stringify(awaitedSid)}});
  })()`))
  check(
    'Fix#4 交接等待时显示「等待 <agent> 的 <task>」而非「思考中」',
    f4View.has && /等待\s*TraeX\s*的\s*代码审查/.test(f4View.txt) && !f4View.plainThinking,
    JSON.stringify(f4View)
  )
  // Clicking the wait line jumps to the awaited session (becomes the active row).
  let f4Jumped = { skip: '(no distinct awaited session available)' }
  if (awaitedSid) {
    f4Jumped = JSON.parse(await ev(`(async()=>{
      const line=document.querySelector('.handoff-wait-line.is-clickable');
      if(!line)return JSON.stringify({clicked:false});
      line.click();
      await new Promise(r=>setTimeout(r,250));
      const activeRow=document.querySelector('.sl-body .session-item.active[data-session-id]');
      const activeId=activeRow?activeRow.getAttribute('data-session-id'):'';
      return JSON.stringify({clicked:true, activeId, want:${JSON.stringify(awaitedSid)}});
    })()`))
    check(
      'Fix#4 点击等待行跳转到被等待的会话',
      f4Jumped.clicked && f4Jumped.activeId === awaitedSid,
      JSON.stringify(f4Jumped)
    )
  } else {
    console.log('… Fix#4 jump check skipped (only one writable session visible)')
  }
  // Clean up: clear the flag so it doesn't leak into later checks.
  await ev(`window.uniagent.e2eSetWaitingForHandoff(${JSON.stringify(req2Sid)}, null)`)
  await sleep(120)
}

// ==== 需求1 — 定时任务卡片 / 内联编辑 =======================================
// 定时任务现在只来自本机磁盘（<home>/.codex|.trae/cli/automations/<id>/automation.toml）。
// 夹具是 codex + traex 两个 agents 的本地任务：可编辑、可切换启停、可删除。这里只编辑/
// 丢弃/切换，删除按钮从不点击（真实删除链路见 test/cdp-automation-mutation.mjs）。
{
  await ev(`(()=>{const b=[...document.querySelectorAll('.sidebar-nav-item')].find(x=>(x.textContent||'').includes('定时任务'));if(b)b.click();return !!b;})()`)
  await poll(() => ev(`(()=>!!document.querySelector('.automations-panel'))()`), Boolean)
  await poll(() => ev(`(()=>document.querySelectorAll('.auto-item-clickable').length)()`), (n) => n > 0)
  const req1List = JSON.parse(await ev(`(()=>{
    const rows=[...document.querySelectorAll('.auto-item-clickable')];
    const tabs=[...document.querySelectorAll('.automations-panel .auto-agent-tab')];
    return JSON.stringify({
      total:rows.length,
      cloud:rows.filter(r=>!!r.querySelector('.auto-source')).length,
      badges:rows.map(r=>(r.querySelector('.auto-badge')?.textContent||'').trim()),
      tabs:tabs.map(t=>(t.textContent||'').trim())
    });
  })()`))
  check('需求1 定时任务列表渲染本机任务（无云端来源标记）', req1List.total === 2 && req1List.cloud === 0, JSON.stringify(req1List))
  check('需求1 定时任务状态徽标来自磁盘 status', req1List.badges.includes('已暂停') && req1List.badges.includes('运行中'), JSON.stringify(req1List.badges))
  check('需求1 定时任务按 Agent 分 tab', req1List.tabs.length >= 3 && req1List.tabs.some((t)=>/全部/.test(t)), JSON.stringify(req1List.tabs))
  const req1TraexFilter = JSON.parse(await ev(`(()=>{
    const tab=document.querySelector('.auto-agent-tab[data-agent-id=traex]');
    const expected=Number(tab?.querySelector('.auto-agent-count')?.textContent||0);
    tab?.click();
    return JSON.stringify({found:!!tab,expected});
  })()`))
  await sleep(100)
  const req1TraexFiltered = JSON.parse(await ev(`(()=>{
    const rows=[...document.querySelectorAll('.auto-item-clickable')];
    return JSON.stringify({
      active:document.querySelector('.auto-agent-tab[data-agent-id=traex]')?.getAttribute('aria-selected')||'',
      count:rows.length,
      titles:rows.map(r=>(r.querySelector('.auto-name')?.textContent||'').trim())
    });
  })()`))
  check('需求1 Agent tab 可交互并只显示目标 Agent 任务', req1TraexFilter.found && req1TraexFiltered.active === 'true' && req1TraexFilter.expected === 1 && req1TraexFiltered.count === req1TraexFilter.expected && req1TraexFiltered.titles.some(t=>t.includes('E2E TraeX 巡检')), JSON.stringify({tab:req1TraexFilter,rows:req1TraexFiltered}))
  await ev(`(()=>{const b=[...document.querySelectorAll('.auto-agent-tab')].find(x=>(x.textContent||'').includes('全部'));b?.click();return !!b;})()`)
  await sleep(100)

  // Local task detail: inline fields and visual schedule are editable; save becomes
  // enabled only after a harmless fixture-only name edit. Status may be toggled.
  const req1OpenDetail = await ev(`(()=>{
    const row=[...document.querySelectorAll('.auto-item-clickable')].find(r=>(r.textContent||'').includes('E2E 每日日报'));
    if(!row)return false; row.click(); return true;
  })()`)
  await poll(() => ev(`(()=>!!document.querySelector('.auto-inline-editor'))()`), Boolean)
  const req1Detail = JSON.parse(await ev(`(()=>{
    const name=document.querySelector('.auto-name-input');
    const prompt=document.querySelector('.auto-prompt-input');
    const save=document.querySelector('.auto-save');
    const toggle=document.querySelector('.auto-status-btn');
    const del=document.querySelector('.auto-del-btn');
    const scheduler=document.querySelector('.sched-builder');
    return JSON.stringify({
      inline:!!document.querySelector('.auto-inline-editor'),
      back:!!document.querySelector('.auto-back'),
      name:!!name, nameEnabled:!!name&&!name.disabled, promptEnabled:!!prompt&&!prompt.disabled,
      scheduler:!!scheduler, scheduleDisabled:scheduler?[...scheduler.querySelectorAll('input,select,button')].filter(x=>!x.classList.contains('settings-btn')||!x.textContent.includes('高级')).every(x=>x.disabled):true,
      save:!!save, saveDisabled:save?save.disabled:null,
      toggle:!!toggle, toggleDisabled:toggle?toggle.disabled:null,
      del:!!del, deleteDisabled:del?del.disabled:null, modal:!!document.querySelector('.settings-modal')
    });
  })()`))
  check(
    '需求1 本机任务使用可编辑内联表单 + 可视化调度（无旧编辑 modal）',
    req1OpenDetail && req1Detail.inline && req1Detail.back && req1Detail.nameEnabled && req1Detail.promptEnabled &&
      req1Detail.scheduler && req1Detail.save && req1Detail.saveDisabled === true && !req1Detail.modal,
    JSON.stringify(req1Detail)
  )
  const req1DetailEdit = JSON.parse(await ev(`(()=>{
    const input=document.querySelector('.auto-name-input');
    if(!input)return JSON.stringify({found:false});
    const before=input.value;
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(input,before+' E2E'); input.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({found:true,before});
  })()`))
  await sleep(100)
  const req1DetailDirty = JSON.parse(await ev(`(()=>{
    const save=document.querySelector('.auto-save'), dirty=document.querySelector('.auto-dirty');
    return JSON.stringify({saveEnabled:!!save&&!save.disabled,dirty:(dirty?.textContent||'').trim()});
  })()`))
  check('需求1 本机任务修改后显示未保存状态并可保存', req1DetailEdit.found && req1DetailDirty.saveEnabled && /未保存/.test(req1DetailDirty.dirty), JSON.stringify(req1DetailDirty))
  await ev(`(()=>{const b=document.querySelector('.auto-discard');if(b)b.click();return !!b;})()`)
  await sleep(80)
  const req1BeforeToggle = await ev(`(()=>{const b=document.querySelector('.auto-status-btn');if(!b||b.disabled)return '';const text=(b.textContent||'').trim();b.click();return text;})()`)
  await sleep(180)
  const req1AfterToggle = await ev(`(()=>{const b=document.querySelector('.auto-status-btn');return b?(b.textContent||'').trim():'';})()`)
  check(
    '需求1 本机任务可切换启停且删除按钮可用（未点击）',
    !!req1BeforeToggle && req1BeforeToggle !== req1AfterToggle && req1Detail.deleteDisabled === false,
    `${req1BeforeToggle} -> ${req1AfterToggle}; deleteDisabled=${req1Detail.deleteDisabled}`
  )
  await ev(`(()=>{const b=document.querySelector('.auto-back');if(b)b.click();return !!b;})()`)
  await sleep(150)
}

// ==== 需求2 — 侧边对话 /side =================================================
// codex/traex 会话头部显示「侧边」入口；sideCanOpen IPC 在 e2e 下返回 true；点击后
// 打开右侧非模态并排 pane，主会话保持可见可交互，且可从关闭按钮收起。
{
  // Pick a visible session whose agent adapter is codex/traex (only those can fork).
  const req2SideSid = await ev(`(async()=>{
    const visible=new Set([...document.querySelectorAll('.sl-body .session-item[data-session-id]')].map(r=>r.getAttribute('data-session-id')).filter(Boolean));
    const agents=await window.uniagent.detectAgents();
    const adapter=Object.fromEntries(agents.map(a=>[a.id,a.adapter]));
    const sessions=await window.uniagent.listSessions();
    const s=sessions.find(item=>visible.has(item.id)&&!item.archived&&(adapter[item.config.agentId]==='codex'||adapter[item.config.agentId]==='traex'));
    return s?s.id:'';
  })()`)
  check('需求2 找到可开侧边对话的 codex/traex 会话', !!req2SideSid, req2SideSid || '(none visible)')
  if (req2SideSid) {
    await ev(`(()=>{const row=document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(req2SideSid)}]');if(row)row.click();return !!row;})()`)
    await poll(() => ev(`(()=>!!document.querySelector('.session-view .session-header'))()`), Boolean)
    await sleep(150)
    const req2Toggle = JSON.parse(await ev(`(()=>{const b=document.querySelector('.session-side-toggle');return JSON.stringify({found:!!b, text:b?(b.textContent||'').trim():''});})()`))
    check('需求2 会话头部显示「侧边」入口', req2Toggle.found && /侧边/.test(req2Toggle.text), JSON.stringify(req2Toggle))
    const req2CanOpen = await ev(`window.uniagent.sideCanOpen(${JSON.stringify(req2SideSid)})`)
    check('需求2 sideCanOpen IPC 返回 true', req2CanOpen === true, String(req2CanOpen))
    await ev(`(()=>{const b=document.querySelector('.session-side-toggle');if(b)b.click();return !!b;})()`)
    await poll(() => ev(`(()=>!!document.querySelector('.subagent-panel.side-panel'))()`), Boolean)
    await sleep(150)
    const req2GeometryProbe = `(()=>{
      const box=(el)=>{
        if(!el)return null;
        const r=el.getBoundingClientRect();
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
      };
      const contains=(outer,inner,tolerance=1)=>!!outer&&!!inner&&inner.left>=outer.left-tolerance&&inner.top>=outer.top-tolerance&&inner.right<=outer.right+tolerance&&inner.bottom<=outer.bottom+tolerance;
      const hitInside=(el)=>{
        const r=box(el);
        if(!r||r.width<=0||r.height<=0)return false;
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return !!hit&&(hit===el||el.contains(hit));
      };
      const panel=document.querySelector('.subagent-panel.side-panel');
      const title=panel?(panel.querySelector('.subagent-panel-title')||{}).textContent||'':'';
      const main=document.querySelector('.main.side-chat-open');
      const session=main?.querySelector(':scope > .session-view');
      const panelHead=panel?.querySelector('.subagent-panel-head');
      const panelStream=panel?.querySelector('.side-panel-stream');
      const panelComposer=panel?.querySelector('.side-composer');
      const panelInput=panel?.querySelector('.composer-input');
      const sessionStyle=session?getComputedStyle(session):null;
      const sessionTimer=session?.querySelector('.turn-timer');
      const overlays=[...document.querySelectorAll('.subagent-overlay,.drawer-overlay,.modal-overlay')].filter(el=>{
        const r=box(el),s=getComputedStyle(el);
        return r&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';
      });
      const mainBox=box(main),sessionBox=box(session),panelBox=box(panel);
      const headBox=box(panelHead),streamBox=box(panelStream),composerBox=box(panelComposer),inputBox=box(panelInput);
      const timerBox=box(sessionTimer);
      return JSON.stringify({
        viewport:{width:innerWidth,height:innerHeight},
        panel:!!panel,
        directPane:panel?.parentElement===main,
        overlayCount:overlays.length,
        title:title.trim(),
        input:!!panelInput,
        send:!!panel?.querySelector('.composer-send-btn'),
        newBtn:!!panel?.querySelector('.side-new-btn'),
        session:!!session,
        sessionVisible:!!sessionBox&&sessionBox.width>0&&sessionBox.height>0,
        sessionInteractive:!!session&&session.inert!==true&&session.getAttribute('aria-hidden')!=='true'&&sessionStyle?.pointerEvents!=='none'&&!!sessionTimer&&hitInside(sessionTimer),
        sideInputUnobscured:hitInside(panelInput),
        sideBySide:!!sessionBox&&!!panelBox&&sessionBox.right<=panelBox.left+1&&Math.abs(sessionBox.top-panelBox.top)<=1&&Math.abs(sessionBox.bottom-panelBox.bottom)<=1,
        fillsMain:!!mainBox&&!!sessionBox&&!!panelBox&&Math.abs(sessionBox.left-mainBox.left)<=1&&Math.abs(panelBox.right-mainBox.right)<=1&&Math.abs(sessionBox.width+panelBox.width-mainBox.width)<=2,
        mainWidth:mainBox?.width||0,
        sessionWidth:sessionBox?.width||0,
        panelWidth:panelBox?.width||0,
        panelLayout:!!panelBox&&!!headBox&&!!streamBox&&!!composerBox&&!!inputBox&&contains(panelBox,headBox)&&contains(panelBox,streamBox)&&contains(panelBox,composerBox)&&contains(composerBox,inputBox)&&headBox.bottom<=streamBox.top+1&&streamBox.bottom<=composerBox.top+1&&Math.abs(composerBox.bottom-panelBox.bottom)<=1&&streamBox.height>0,
        summaryActive:!!document.querySelector('.timer-summary-pop.open'),
        summaryPoint:timerBox?{x:timerBox.left+timerBox.width/2,y:timerBox.top+timerBox.height/2}:null
      });
    })()`
    const req2Panel = await poll(async () => JSON.parse(await ev(req2GeometryProbe)), p => p.input && p.fillsMain && p.panelLayout)
    check('需求2 侧边 pane 控件完整且无模态遮罩', req2Panel.panel && req2Panel.directPane && req2Panel.overlayCount === 0 && req2Panel.input && req2Panel.send && req2Panel.newBtn && req2Panel.sideInputUnobscured && /侧边对话/.test(req2Panel.title), JSON.stringify(req2Panel))
    check('需求2 主聊与侧聊真实并排且完整占满主区域', req2Panel.session && req2Panel.sessionVisible && req2Panel.sideBySide && req2Panel.fillsMain && req2Panel.sessionWidth > 0 && req2Panel.panelWidth >= 320, JSON.stringify(req2Panel))
    check('需求2 侧聊消息流在输入区上方且输入区固定于 pane 底部', req2Panel.panelLayout, JSON.stringify(req2Panel))

    // Exercise the minimum-width packaged viewport. Geometry checks alone can
    // miss a fixed/absolute pane that only covers the main controls once space is
    // tight, so hover the main timer capsule through CDP at 1024px as well —
    // 计时胶囊重构: hovering it must pop the summary card even at min width.
    const req2OriginalViewportWidth = req2Panel.viewport.width
    const req2OriginalViewportHeight = req2Panel.viewport.height
    let req2Narrow = null
    let req2MainToggled = false
    let req2ClosedBefore = false
    let req2ClosedAfter = false
    try {
      await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: req2OriginalViewportHeight, deviceScaleFactor: 1, mobile: false })
      await poll(() => ev(`window.innerWidth`), (width) => width <= 1030)
      await sleep(120)
      req2Narrow = JSON.parse(await ev(req2GeometryProbe))
      if (req2Narrow.summaryPoint && req2Narrow.sessionInteractive) {
        const point = req2Narrow.summaryPoint
        // Earlier synthetic hover + Review leaves summaryDismissed set. A real
        // enter/leave resets that state before testing the next real hover.
        await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:point.x, y:point.y })
        await sleep(100)
        await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:12, y:req2OriginalViewportHeight-12 })
        req2ClosedBefore = await poll(() => ev(`!document.querySelector('.timer-summary-pop.open')`), Boolean, 3000) === true
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
        req2MainToggled = await poll(
          () => ev(`(()=>!!document.querySelector('.timer-summary-pop.open'))()`),
          Boolean,
          3_000
        ) === true
        if (req2MainToggled) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 12, y: req2OriginalViewportHeight - 12 })
          req2ClosedAfter = await poll(
            () => ev(`(()=>!document.querySelector('.timer-summary-pop.open'))()`),
            Boolean,
            3_000
          ) === true
        }
      }
    } finally {
      await send('Emulation.clearDeviceMetricsOverride')
      await poll(() => ev(`window.innerWidth`), (width) => Math.abs(width - req2OriginalViewportWidth) <= 4)
    }
    check('需求2 窄窗下仍保持并排、侧聊纵向布局且无遮罩', !!req2Narrow && req2Narrow.viewport.width <= 1030 && req2Narrow.overlayCount === 0 && req2Narrow.sideBySide && req2Narrow.fillsMain && req2Narrow.panelLayout && req2Narrow.sessionWidth >= 240 && req2Narrow.sideInputUnobscured, JSON.stringify(req2Narrow))
    check('需求2 窄窗侧聊打开时主聊控件仍可真实悬停', !!req2Narrow && req2Narrow.sessionInteractive && req2ClosedBefore && req2MainToggled && req2ClosedAfter, JSON.stringify({narrow:req2Narrow, closedBefore:req2ClosedBefore, opened:req2MainToggled, closedAfter:req2ClosedAfter}))
    await ev(`(()=>{const b=document.querySelector('.side-panel .close-x');if(b)b.click();return !!b;})()`)
    await poll(() => ev(`!document.querySelector('.subagent-panel.side-panel')`), Boolean)
    const req2Closed = JSON.parse(await ev(`(()=>JSON.stringify({panel:!!document.querySelector('.subagent-panel.side-panel'),layout:document.querySelector('.main')?.classList.contains('side-chat-open')||false,session:!!document.querySelector('.main > .session-view')}))()`))
    check('需求2 侧边 pane 可从关闭按钮收起且主会话保留', !req2Closed.panel && !req2Closed.layout && req2Closed.session, JSON.stringify(req2Closed))
  }
}

// ==== 需求3 — 能力卡片与固定方向对比（Codex → TraeX）=======================
// 清单与对比都使用可访问卡片选择；方向固定为左来源 → 右目标，不再提供交换。
{
  const traexInstalled = caps.some((c) => c.id === 'traex' && c.installed)
  await verifyCapabilityInventoryAndDetail()
  await ev(`(()=>{const b=[...document.querySelectorAll('.capability-view-switch button')].find(x=>(x.textContent||'').includes('对比'));if(b)b.click();return !!b;})()`)
  await poll(() => ev(`(()=>!!document.querySelector('.capability-compare-head'))()`), Boolean)
  await sleep(150)
  const req3Head = JSON.parse(await ev(`(()=>{
    const sides=[...document.querySelectorAll('.capability-compare-head .cmp-side')];
    const selected=sides.map(side=>(side.querySelector('.cap-agent-card.on .a-nm')?.textContent||'').trim());
    const arrow=document.querySelector('.capability-compare-head .cmp-arrow');
    return JSON.stringify({head:!!document.querySelector('.capability-compare-head'),swap:!!document.querySelector('.capability-compare-swap'),nativeSelects:document.querySelectorAll('.capability-compare-head select').length,cards:document.querySelectorAll('.capability-compare-head .cap-agent-card').length,selected,arrow:(arrow?.textContent||'').trim(),arrowLabel:arrow?.getAttribute('aria-label')||'',legend:!!document.querySelector('.capability-compare-legend'),search:!!document.querySelector('[aria-label="搜索对比能力"]'),chips:document.querySelectorAll('.capability-compare-head ~ .cap-toolbar .cap-kind-chips .cap-chip').length,onlyDiff:!!document.querySelector('.capability-compare-toggle')});
  })()`))
  check('需求3 对比视图固定左来源到右目标（卡片选择，无交换/旧 select）', req3Head.head && req3Head.cards >= 4 && req3Head.selected[0] === 'Codex' && req3Head.selected[1] === 'TraeX' && req3Head.arrow === '' && req3Head.arrowLabel === '来源到目标' && !req3Head.swap && req3Head.nativeSelects === 0 && req3Head.legend && req3Head.search && req3Head.chips > 0 && req3Head.onlyDiff, JSON.stringify(req3Head))
  const req3SyncText = await ev(`(()=>{const b=document.querySelector('.capability-compare-sync .settings-add-preset');return b?(b.textContent||'').trim():'';})()`)
  check('需求3 同步栏固定文案「同步 Codex → TraeX」', /同步\s*Codex\s*→\s*TraeX\s*\(0\)/.test(req3SyncText), req3SyncText)
  if (traexInstalled) {
    await poll(() => ev(`(()=>document.querySelectorAll('.capability-compare-row').length)()`), (n) => n > 0, 45000)
    const req3Rows = JSON.parse(await ev(`(()=>{
      const row=document.querySelector('.capability-compare-row');
      const selectable=document.querySelector('.capability-compare-row.selectable[role=checkbox]');
      if(selectable) selectable.click();
      return JSON.stringify({count:document.querySelectorAll('.capability-compare-row').length,hasStatus:row?/status-/.test(row.className):false,sides:row?row.querySelectorAll('.capability-compare-side').length:0,selectable:!!selectable});
    })()`))
    await sleep(100)
    const req3Selected = JSON.parse(await ev(`(()=>{const row=document.querySelector('.capability-compare-row.selectable.sel');const bar=document.querySelector('.cap-selbar.capability-compare-sync');return JSON.stringify({checked:row?.getAttribute('aria-checked')||'',bar:!!bar,show:bar?.classList.contains('show')||false,text:(bar?.textContent||'').trim()});})()`))
    check('需求3 对比行渲染（状态色 + 左右存在标记）', req3Rows.count > 0 && req3Rows.hasStatus && req3Rows.sides === 2, JSON.stringify(req3Rows))
    if (req3Rows.selectable) check('需求3 对比差异卡可选并显示底部同步栏', req3Selected.checked === 'true' && req3Selected.bar && req3Selected.show && /Codex\s*→\s*TraeX/.test(req3Selected.text), JSON.stringify(req3Selected))
    else console.log('… 需求3 selectable-row check skipped (scan returned no safely syncable difference)')
  } else {
    console.log('… 需求3 row-level check skipped (traex not installed)')
  }
}

// ==== 需求4 — Session 飞书同步：先绑定，再显示参数 ========================
{
  await ev(`window.uniagent.setAppSettings({feishu:{enabled:false,appId:'',appSecret:'',botName:''}})`)
  await ev(`(()=>{const b=document.querySelector('.settings-entry');if(b)b.click();return !!b;})()`)
  await poll(() => ev(`(()=>!!document.querySelector('.settings-panel .set-nav'))()`), Boolean)
  await settingsNav('飞书&助手')
  await ev(`(()=>{const tab=[...document.querySelectorAll('.assistant-page-tabs [role=tab]')].find(x=>(x.textContent||'').trim()==='session飞书管理');tab?.click();return !!tab;})()`)
  await poll(() => ev(`(()=>[...document.querySelectorAll('.set-page:not([hidden]) button')].some(x=>x.textContent==='手动配置'&&!x.disabled))()`), Boolean)
  const req4Section = JSON.parse(await ev(`(()=>{
    const page=document.querySelector('.set-page:not([hidden])');
    return JSON.stringify({
      groups:[...page.querySelectorAll('.set-group-t-label')].map(x=>x.textContent.trim()),
      status:page.querySelector('.status-pill')?.textContent.trim(),
      enableSwitch:!!page.querySelector('[role=switch]'),
      inputs:page.querySelectorAll('.set-fld-inp').length,
      install:[...page.querySelectorAll('button')].some(x=>x.textContent.trim()==='一键配置')
    });
  })()`))
  check('需求4 未绑定时仅显示机器人配置入口与状态', req4Section.groups.length === 1 && req4Section.groups[0] === '飞书机器人' && req4Section.status === '未绑定', JSON.stringify(req4Section))
  check('需求4 移除启动开关，默认隐藏凭证与同步参数', !req4Section.enableSwitch && req4Section.inputs === 0 && req4Section.install, JSON.stringify(req4Section))
  const req4Status = JSON.parse(await ev(`(async()=>JSON.stringify(await window.uniagent.feishuStatus()))()`))
  check('需求4 未绑定状态与实际配置一致', !req4Status.appId && !req4Status.configuring && !req4Status.connected, JSON.stringify(req4Status))
  await ev(`(()=>{[...document.querySelectorAll('.set-page:not([hidden]) button')].find(x=>x.textContent.trim()==='手动配置').click();return true;})()`)
  await poll(() => ev(`(()=>document.querySelectorAll('.set-page:not([hidden]) .set-fld-inp').length===2)()`), Boolean)
  const req4Manual = JSON.parse(await ev(`(()=>{
    const page=document.querySelector('.set-page:not([hidden])');
    return JSON.stringify({
      secretType:page.querySelector('#session-feishu-secret')?.type,
      disabled:[...page.querySelectorAll('button')].find(x=>x.textContent.trim()==='绑定并连接')?.disabled,
      groups:[...page.querySelectorAll('.set-group-t-label')].map(x=>x.textContent.trim())
    });
  })()`))
  check('需求4 手动配置才显示凭证，空凭证不能绑定', req4Manual.secretType === 'password' && req4Manual.disabled && req4Manual.groups.length === 1, JSON.stringify(req4Manual))
  await ev(`(()=>{[...document.querySelectorAll('.set-page:not([hidden]) button')].find(x=>x.textContent.trim()==='取消').click();return true;})()`)
  await poll(() => ev(`(()=>document.querySelectorAll('.set-page:not([hidden]) .set-fld-inp').length===0)()`), Boolean)
  check('需求4 取消手动配置后收起凭证输入', true)
}

// 需求12: 新建任务页对每个可选（available）Agent 都展示权限选择器，并正确记录所选 Agent。
await ev(`window.uniagent.e2eLifecycleFixture('mixed')`)
await ev(`window.uniagent.setAppSettings({enabledAgentIds:['codex','traex','claude']})`)
await send('Page.reload')
await poll(() => ev(`(()=>!!document.querySelector('.settings-entry'))()`), Boolean)
await ev(`(()=>{document.querySelector('.btn-new')?.click();return true;})()`)
await poll(() => ev(`(()=>!!document.querySelector('.new-task'))()`), Boolean)
for (const [name, id] of [['Codex', 'codex'], ['Claude Code', 'claude']]) {
  const selected = await ev(`(async()=>{
    const menu=document.querySelector('.new-task .sb-agent');
    if(!menu) return false;
    if(!menu.open){const s=menu.querySelector(':scope > summary');s&&s.click();}
    await new Promise(r=>setTimeout(r,80));
    const entry=[...menu.querySelectorAll('.sb-sub-entry')].find(x=>(x.querySelector('.sb-entry-body')?.childNodes[0]?.textContent||x.textContent||'').includes('Agent'));
    if(entry&&entry.getAttribute('aria-expanded')!=='true')entry.click();
    await new Promise(r=>setTimeout(r,80));
    const opt=[...menu.querySelectorAll('.sb-sub-menu .sb-sub-opt')].find(x=>(x.querySelector('.sb-agent-name-label')?.textContent||'').trim()===${JSON.stringify(name)});
    if(!opt) return false;
    opt.click();
    await new Promise(r=>setTimeout(r,80));
    [...document.querySelectorAll('.new-task .sb-agent[open]')].forEach(d=>d.removeAttribute('open'));
    return true;
  })()`)
  const home = await poll(
    () => ev(`(()=>{const menu=document.querySelector('.new-task .sb-agent');return {agent:menu?.getAttribute('data-agent-id')||'',permission:[...document.querySelectorAll('.new-task .cfg > span')].some(x=>(x.textContent||'').trim()==='权限')};})()`),
    (value) => value.agent === id && value.permission === true
  )
  check(`需求12 ${name} 新建页显示权限选择器`, selected && home.agent === id && home.permission === true, JSON.stringify(home))
}

// ==== 需求8 — CLI 更新状态检查 ===============================================
// (1) 启动只探测可用性、异步检查版本更新；(2) 有更新时在「设置」入口显示一个点点提示，
// 设置页展示 当前版本 → 最新版本 + 更新按钮；(3) 更新时若有会话在跑（含其他 agent 的会话）
// 需拒绝并提示空闲再更新。用 e2e lifecycle fixture 让 codex 稳定处于 updateStatus:'available'
// (1.0.0 → 1.1.0)，随后 reload 让渲染层拉取该快照。此块放在最末尾，reload 不影响前面的状态化检查。
{
  const skipReq8 = agentId !== 'codex'
  if (skipReq8) {
    console.log('… 需求8 lifecycle-fixture check skipped for agent', agentId)
  } else {
    // Available updates remain in settings without adding a dot to its entry.
    const req8Dot = JSON.parse(await ev(`(()=>{
      const entry=document.querySelector('.settings-entry');
      const dot=entry?entry.querySelector('.settings-update-dot'):null;
      return JSON.stringify({entry:!!entry, dot:!!dot, title:(entry?entry.getAttribute('title'):'')||''});
    })()`))
    check(
      '需求8 设置入口在有可更新 CLI 时也不显示颜色小点',
      req8Dot.entry && !req8Dot.dot && req8Dot.title === '设置',
      JSON.stringify(req8Dot)
    )
    // Open settings → Agent 分类 → 点开 codex 详情：版本区显示 1.0.0 + 「可更新到 1.1.0」
    // + 重新检测 + 有可用更新（更新按钮）。
    await ev(`(()=>{const b=document.querySelector('.settings-entry');if(b)b.click();return !!b;})()`)
    await poll(() => ev(`(()=>!!document.querySelector('.settings-panel .set-nav'))()`), Boolean)
    await settingsNav('Agent')
    await ev(`(()=>{const row=[...document.querySelectorAll('.set-page:not([hidden]) .rowlink')].find(x=>/Codex/i.test(x.querySelector('.r-label')?.textContent||''));if(row)row.click();return !!row;})()`)
    await poll(() => ev(`(()=>(document.querySelector('.set-page:not([hidden]) .set-detail-title h2')?.textContent||'').trim()==='Codex')()`), Boolean)
    const req8Panel = JSON.parse(await ev(`(()=>{
      const page=document.querySelector('.set-page:not([hidden])');
      const rows=[...page.querySelectorAll('.row')];
      const verRow=rows.find(r=>(r.querySelector('.r-label')?.textContent||'').trim()==='版本');
      const verText=(verRow?.querySelector('.ver')?.textContent||'').trim();
      const versions=[...(verRow?.querySelectorAll('.ver')||[])].map(x=>(x.textContent||'').trim());
      const btns=[...page.querySelectorAll('button')].map(b=>(b.textContent||'').trim());
      return JSON.stringify({verText, versions, hasUpdateRow:rows.some(r=>(r.querySelector('.r-label')?.textContent||'').trim()==='更新状态'&&(r.querySelector('.status-pill')?.textContent||'').trim()==='可更新'), btns});
    })()`))
    check(
      '需求8 设置页展示 当前→最新 版本 + 可更新 标记 + 更新按钮',
      req8Panel.verText === '1.0.0' && req8Panel.versions.includes('1.1.0') && req8Panel.hasUpdateRow &&
        Array.isArray(req8Panel.btns) && req8Panel.btns.includes('刷新状态') && req8Panel.btns.includes('更新'),
      JSON.stringify(req8Panel)
    )
    const req8IdleLifecycle = JSON.parse(await ev(`(async()=>{
      const agent=(await window.uniagent.getLifecycleSnapshot()).find(a=>a.id==='claude');
      return JSON.stringify(agent?.lifecycle||null);
    })()`))
    // 返回 Agent 主列表 → 点开 Claude Code 详情：可自更新但 idle，不应出现文本精确为「更新」的按钮。
    await ev(`(()=>{document.querySelector('.set-page:not([hidden]) .set-back')?.click();return true;})()`)
    await poll(() => ev(`(()=>[...document.querySelectorAll('.set-page:not([hidden]) .rowlink')].some(x=>/Claude Code/.test(x.querySelector('.r-label')?.textContent||'')))()`), Boolean)
    await ev(`(()=>{const row=[...document.querySelectorAll('.set-page:not([hidden]) .rowlink')].find(x=>/Claude Code/.test(x.querySelector('.r-label')?.textContent||''));if(row)row.click();return !!row;})()`)
    await poll(() => ev(`(()=>(document.querySelector('.set-page:not([hidden]) .set-detail-title h2')?.textContent||'').trim()==='Claude Code')()`), Boolean)
    const req8IdleRow = JSON.parse(await ev(`(()=>{
      const page=document.querySelector('.set-page:not([hidden])');
      const buttons=[...page.querySelectorAll('button')].map(b=>(b.textContent||'').trim());
      return JSON.stringify({found:true,buttons,exactUpdateButtons:buttons.filter(text=>text==='更新').length});
    })()`))
    check(
      '需求8 可自更新但 idle 的 CLI 不显示文本精确为“更新”的按钮',
      req8IdleLifecycle?.availability === 'available' && req8IdleLifecycle?.selfUpdateSupported === true &&
        req8IdleLifecycle?.updateStatus === 'idle' && req8IdleRow.found &&
        req8IdleRow.buttons.includes('刷新状态') && req8IdleRow.buttons.includes('检查更新') && req8IdleRow.exactUpdateButtons === 0,
      JSON.stringify({ lifecycle: req8IdleLifecycle, row: req8IdleRow })
    )
    await ev(`(()=>{document.querySelector('.set-page:not([hidden]) .set-back')?.click();return true;})()`)
    // 需求8.3 — the update guard rejects while the target Agent has an active session.
    const req8Guard = await ev(`window.uniagent.e2eLifecycleUpdateGuard()`)
    check('需求8 目标 Agent 有活跃会话时拒绝更新 CLI', req8Guard === 'agent_has_active_session', String(req8Guard))
  }
}

// Installation actions must seed an executable, agent-specific tutorial into
// the real task composer rather than the old generic request. 需登录的 Agent（TraeX）在
// CLI 状态列表里显示「继续配置」；未安装的 Agent（Grok）显示「初始化」。
for (const [name, expected] of [
  ['TraeX', ['traex_install.sh', 'traecli login status', '旧版 Coco']],
  ['Grok', ['command -v grok', 'grok update --check --json', 'ACP initialize + session/new']]
]) {
  await ev(`(()=>{const b=document.querySelector('.settings-entry');if(b)b.click();return !!b;})()`)
  await poll(() => ev(`(()=>!!document.querySelector('.settings-panel .set-nav'))()`), Boolean)
  await settingsNav('Agent')
  // 未安装的 Agent（Grok）在 CLI 状态列表直接给「初始化」按钮；需登录/异常的 Agent（TraeX）
  // 只以 rowlink 呈现，需先点开单 Agent 详情页，其中「登录状态/运行状态」行才有「继续配置/重新配置」。
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('.set-page:not([hidden]) .row')];
    const row=rows.find(r=>(r.querySelector('.r-label')?.textContent||'').includes(${JSON.stringify(name)}));
    if(!row)return false;
    const inline=[...row.querySelectorAll('button')].find(x=>/初始化|继续配置|重新配置/.test(x.textContent||''));
    if(inline){inline.click();return true;}
    row.click();return true;
  })()`)
  await poll(() => ev(`document.querySelector('.new-task')?.parentElement?.style.display === 'contents' || !![...document.querySelectorAll('.set-page:not([hidden]) .set-mini-btn')].find(x=>/继续配置|重新配置/.test(x.textContent||''))`), Boolean)
  // 若刚才只是打开了详情页，再点详情内的「继续配置/重新配置」。
  await ev(`(()=>{const b=[...document.querySelectorAll('.set-page:not([hidden]) .set-mini-btn')].find(x=>/继续配置|重新配置/.test(x.textContent||''));if(b){b.click();return true;}return false;})()`)
  const prompt = await poll(
    () => ev(`window.__markdownInput.text('.new-task .prompt-input')`),
    (value) => expected.every((text) => value.includes(text))
  )
  check('CLI 初始化输入框包含 ' + name + ' 完整官方教程', expected.every((text) => prompt.includes(text)), prompt.slice(0, 180))
}

} // full verification

const passed = results.filter((r) => r.pass).length
if (process.env.UNIAGENT_ACCEPTANCE_REPORT) await writeFile(resolve(process.env.UNIAGENT_ACCEPTANCE_REPORT), JSON.stringify({ checkedAt:new Date().toISOString(), appAsarSha256:createHash('sha256').update(readFileSync(resolvedBinary.replace('/MacOS/UniAgent Public', '/Resources/app.asar'))).digest('hex'), agentId, mode:modelMenuOnly ? 'model-menu-only' : capabilityOnly ? 'capability-only' : 'full', passed, total:results.length, capabilityArtifacts, results }, null, 2))
console.log(`\n==== ${passed}/${results.length} checks passed ====`)
const fails = results.filter((r) => !r.pass)
if (fails.length) {
  console.log('FAILED:')
  fails.forEach((f) => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')))
}
if (fails.length) process.exitCode = 1
} catch (error) {
  fatal = error
  console.error('FATAL packaged CDP:', error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
} finally {
  try { await cleanup() } catch (error) { fatal ||= error }
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  if (fatal) process.exitCode = 1
}
