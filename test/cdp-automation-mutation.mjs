// Packaged-App acceptance for the local automation detail/edit/delete chain.
// Usage: node test/cdp-automation-mutation.mjs /path/to/UniAgent-executable [port]
// This script deliberately does not build or pack.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

const STARTUP_TIMEOUT_MS = 30_000
const OPERATION_TIMEOUT_MS = 12_000
const POLL_INTERVAL_MS = 75
const FIXTURE_NAME = 'E2E 本地持久化任务'
const UPDATED_NAME = 'E2E 本地持久化任务（已修改）'
const UPDATED_PROMPT = 'packaged CDP persisted this prompt through the real local IPC path'
const UPDATED_SCHEDULE = 'RRULE:FREQ=WEEKLY;BYHOUR=14;BYMINUTE=35;BYDAY=MO,WE,FR'
const PRIVATE_SENTINEL = 'private_cli_field = "preserve-me"'

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

async function reservePort() {
  const server = createServer()
  const port = await withTimeout(new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('failed to allocate a CDP port'))
      else resolvePort(address.port)
    })
  }), 3_000, 'allocating a CDP port')
  await withTimeout(new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  }), 3_000, 'releasing the CDP port')
  return port
}

async function resolvePackagedExecutable(argument) {
  if (!argument) throw new Error('pass the packaged UniAgent executable path')
  let candidate = resolve(argument)
  if ((await stat(candidate)).isDirectory() && candidate.endsWith('.app')) {
    candidate = join(candidate, 'Contents', 'MacOS', 'UniAgent Public')
  }
  const executable = await realpath(candidate)
  const marker = sep + 'Contents' + sep + 'MacOS' + sep
  const markerIndex = executable.lastIndexOf(marker)
  assert.ok(markerIndex >= 0, 'expected a packaged .app executable under Contents/MacOS')
  const asarPath = join(executable.slice(0, markerIndex), 'Contents', 'Resources', 'app.asar')
  await access(asarPath)
  return { executable, expectedRendererPath: join(asarPath, 'out', 'renderer', 'index.html') }
}

function createCdpClient(socket) {
  const pending = new Map()
  let nextId = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const request = message.id && pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP WebSocket closed'))
    }
    pending.clear()
  })

  function send(method, params = {}) {
    return new Promise((resolveSend, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('CDP ' + method + ' timed out after ' + OPERATION_TIMEOUT_MS + 'ms'))
      }, OPERATION_TIMEOUT_MS)
      pending.set(id, { resolve: resolveSend, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(body) {
    const response = await send('Runtime.evaluate', {
      expression: '(async () => { ' + body + ' })()',
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'CDP evaluation failed')
    }
    return response.result?.value
  }

  return { send, evaluate }
}

async function findPackagedPage(port, expectedRendererPath, child, stderr) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastTargets = []
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('packaged UniAgent exited before CDP was ready (code=' + child.exitCode + ', signal=' + child.signalCode + ')\n' + stderr.value)
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1_000) })
      const targets = await response.json()
      lastTargets = targets.map((target) => ({ type: target.type, url: target.url }))
      const page = targets.find((target) => {
        if (target?.type !== 'page' || !target.webSocketDebuggerUrl || !target.url) return false
        try { return new URL(target.url).protocol === 'file:' && fileURLToPath(target.url) === expectedRendererPath }
        catch { return false }
      })
      if (page) return page
    } catch {}
    await sleep(200)
  }
  throw new Error('packaged renderer did not start; targets=' + JSON.stringify(lastTargets) + '\n' + stderr.value)
}

async function waitFor(evaluate, body, label, timeoutMs = OPERATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let latest
  let lastError
  while (Date.now() < deadline) {
    try {
      latest = await evaluate(body)
      if (latest) return latest
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(label + ' was not observed; latest=' + JSON.stringify(latest) + (lastError ? '; lastError=' + String(lastError) : ''))
}

async function clickByText(evaluate, selector, text) {
  const clicked = await waitFor(evaluate,
    'const text = ' + JSON.stringify(text) + ';' +
    'const node = [...document.querySelectorAll(' + JSON.stringify(selector) + ')]' +
    '.find((candidate) => candidate.textContent?.includes(text));' +
    'node?.click(); return Boolean(node);',
    selector + ' containing ' + JSON.stringify(text)
  )
  assert.equal(clicked, true, 'missing ' + selector + ' containing ' + JSON.stringify(text))
}

async function setControl(evaluate, selector, value) {
  const changed = await evaluate(
    'const node = document.querySelector(' + JSON.stringify(selector) + ');' +
    'if (!node) return false;' +
    'const setter = Object.getOwnPropertyDescriptor(' +
    'node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :' +
    'node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,' +
    "'value')?.set;" +
    'setter.call(node, ' + JSON.stringify(value) + ');' +
    "node.dispatchEvent(new Event('input', { bubbles: true }));" +
    "node.dispatchEvent(new Event('change', { bubbles: true }));" +
    'return node.value === ' + JSON.stringify(value) + ';'
  )
  assert.equal(changed, true, 'failed to set ' + selector)
}

const packaged = await resolvePackagedExecutable(process.argv[2])
const explicitPort = process.argv[3]
if (explicitPort !== undefined && (!/^\d+$/.test(explicitPort) || Number(explicitPort) < 1 || Number(explicitPort) > 65535)) {
  throw new Error('port must be an integer from 1 through 65535')
}
const port = explicitPort === undefined ? await reservePort() : Number(explicitPort)
const scratch = await mkdtemp(join(tmpdir(), 'uniagent-automation-cdp-'))
const home = join(scratch, 'home')
const uniagentData = join(scratch, 'uniagent-data')
const chromiumData = join(scratch, 'chromium-data')
const isolatedTmp = join(scratch, 'tmp')
const workspace = join(scratch, 'workspace')
const automationDir = join(home, '.codex', 'automations', 'packaged-cdp-fixture')
const automationPath = join(automationDir, 'automation.toml')
const siblingPath = join(automationDir, 'state.json')
const originalUpdatedAt = 1_700_000_000_000
const originalToml = [
  'version = 1',
  'id = "packaged-cdp-fixture"',
  'kind = "cron"',
  'name = "' + FIXTURE_NAME + '"',
  'prompt = "original packaged CDP prompt"',
  'status = "PAUSED"',
  'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=5;BYDAY=MO,WE,FR"',
  'model = "gpt-5.6-sol-before"',
  'reasoning_effort = "medium"',
  'execution_environment = "local"',
  'target = { type = "project", project_id = "e2e-project" }',
  'cwds = [' + JSON.stringify(workspace) + ']',
  'created_at = 1600000000000',
  'updated_at = ' + originalUpdatedAt,
  PRIVATE_SENTINEL,
  ''
].join('\n')
const sweeper = createAcceptanceProcessSweeper({ termGraceMs: 1_500, killDeadlineMs: 8_000 })
let child
let socket
let cleanupPromise
let interruptedSignal

async function cleanup() {
  cleanupPromise ||= (async () => {
    const errors = []
    try { socket?.close() } catch {}
    try { await sweeper.sweep({ force: Boolean(interruptedSignal) }) } catch (error) { errors.push(error) }
    try { await rm(scratch, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'automation packaged CDP cleanup failed')
  })()
  return cleanupPromise
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    interruptedSignal = signal
    void cleanup().then(() => process.exit(code), (error) => {
      console.error(error)
      process.exit(code)
    })
  })
}

try {
  await Promise.all([
    automationDir, uniagentData, chromiumData, isolatedTmp, workspace,
    join(scratch, 'xdg-config'), join(scratch, 'xdg-cache'), join(scratch, 'xdg-data'),
    join(scratch, 'xdg-state'), join(scratch, 'xdg-runtime'), join(scratch, 'zdotdir')
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
  await writeFile(automationPath, originalToml, { encoding: 'utf8', mode: 0o600 })
  await writeFile(siblingPath, '{"preserve-until-delete":true}\n', { encoding: 'utf8', mode: 0o600 })

  const stderr = { value: '' }
  child = spawn(packaged.executable, [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + chromiumData,
    '--ua-e2e'
  ], {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      USERPROFILE: home,
      USER: process.env.USER || 'uniagent-e2e',
      LOGNAME: process.env.LOGNAME || process.env.USER || 'uniagent-e2e',
      LANG: process.env.LANG || 'en_US.UTF-8',
      SHELL: '/usr/bin/false',
      TMPDIR: isolatedTmp,
      TMP: isolatedTmp,
      TEMP: isolatedTmp,
      XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
      XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
      XDG_DATA_HOME: join(scratch, 'xdg-data'),
      XDG_STATE_HOME: join(scratch, 'xdg-state'),
      XDG_RUNTIME_DIR: join(scratch, 'xdg-runtime'),
      ZDOTDIR: join(scratch, 'zdotdir'),
      CODEX_HOME: join(home, '.codex'),
      TRAE_HOME: join(home, '.trae'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      APPDATA: join(scratch, 'appdata'),
      LOCALAPPDATA: join(scratch, 'local-appdata'),
      NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
      NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
      GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
      GIT_CONFIG_SYSTEM: '/dev/null',
      UNIAGENT_USER_DATA: uniagentData,
      UNIAGENT_CAPABILITY_HOME: home,
      UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'),
      UA_E2E_AUTOMATION_PASSTHROUGH: '1',
      UA_DISABLE_GPU: '1'
    }
  })
  await withTimeout(new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn)
    child.once('error', reject)
  }), 5_000, 'launching packaged UniAgent')
  assert.ok(child.pid, 'packaged UniAgent did not expose a pid')
  await sweeper.addRoot(child.pid)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr.value = (stderr.value + chunk).slice(-16_000) })

  const page = await findPackagedPage(port, packaged.expectedRendererPath, child, stderr)
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await withTimeout(new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  }), OPERATION_TIMEOUT_MS, 'opening the CDP socket')
  const cdp = createCdpClient(socket)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const evaluate = cdp.evaluate

  await waitFor(evaluate, "return typeof window.uniagent?.e2eEnabled === 'function' && await window.uniagent.e2eEnabled()", '--ua-e2e preload surface')
  await evaluate("await window.uniagent.getLifecycleSnapshot(); await window.uniagent.e2eLifecycleFixture('mixed'); return true;")
  await evaluate("window.__automationInitialReloadMarker = 'before'")
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor(evaluate, "return window.__automationInitialReloadMarker !== 'before' && typeof window.uniagent?.e2eEnabled === 'function' && await window.uniagent.e2eEnabled()", 'fixture renderer reload')

  // #1: leaving during the first scan and immediately re-entering must retain
  // the pending state instead of flashing the empty-state copy.
  await clickByText(evaluate, '.sidebar-nav-item', '定时任务')
  await waitFor(evaluate, "return !!document.querySelector('.automations-panel .panel-loading.auto-loading')", 'initial automation pending state')
  await clickByText(evaluate, '.sidebar-nav-item', '导入会话')
  await clickByText(evaluate, '.sidebar-nav-item', '定时任务')
  const automationReentry = await evaluate(
    "const empty = document.querySelector('.automations-panel .drawer-empty')?.textContent || '';" +
    "return { loading: !!document.querySelector('.automations-panel .panel-loading.auto-loading'), falseEmpty: empty.includes('未发现定时任务') };"
  )
  assert.deepEqual(automationReentry, { loading: true, falseEmpty: false })
  await waitFor(evaluate, 'return [...document.querySelectorAll(\'.auto-item-clickable\')].some((row) => row.textContent?.includes(' + JSON.stringify(FIXTURE_NAME) + '))', 'local fixture row')

  // #11: cached content stays visible while refreshing, and the slower prior
  // agent response cannot cross-write the currently selected agent.
  await clickByText(evaluate, '.sidebar-nav-item', '导入会话')
  await clickByText(evaluate, '.drawer-agent-tab', 'Codex')
  await waitFor(evaluate, "return document.querySelector('.drawer-agent-tab.active')?.textContent?.includes('Codex')", 'Codex history request start')
  await waitFor(evaluate, "return [...document.querySelectorAll('.resume-item-title')].some((node) => node.textContent?.trim() === 'E2E history codex cached')", 'initial codex history cache')
  await clickByText(evaluate, '.drawer-agent-tab', 'TraeX')
  await waitFor(evaluate, "return document.querySelector('.drawer-agent-tab.active')?.textContent?.includes('TraeX')", 'TraeX history request start')
  await clickByText(evaluate, '.drawer-agent-tab', 'Codex')
  const cachedDuringRefresh = await evaluate(
    "const titles = [...document.querySelectorAll('.resume-item-title')].map((node) => node.textContent?.trim());" +
    "return { active: document.querySelector('.drawer-agent-tab.active')?.textContent?.trim() || '', titles, blocking: document.querySelector('.resume-list .drawer-empty')?.textContent?.includes('加载中') === true };"
  )
  assert.equal(cachedDuringRefresh.active.includes('Codex'), true)
  assert.equal(cachedDuringRefresh.titles.includes('E2E history codex cached'), true)
  assert.equal(cachedDuringRefresh.blocking, false)
  // Switch away while Codex's slower refresh is still in flight: its late
  // response must never land in TraeX's list.
  await clickByText(evaluate, '.drawer-agent-tab', 'TraeX')
  await sleep(850)
  const afterStaleHistory = await evaluate(
    "const titles = [...document.querySelectorAll('.resume-item-title')].map((node) => node.textContent?.trim());" +
    "return { active: document.querySelector('.drawer-agent-tab.active')?.textContent?.trim() || '', titles };"
  )
  assert.equal(afterStaleHistory.active.includes('TraeX'), true)
  assert.equal(afterStaleHistory.titles.includes('E2E history codex cached'), false)
  console.log('PASS packaged automation pending re-entry + history cache/stale-response isolation')

  await clickByText(evaluate, '.sidebar-nav-item', '定时任务')
  const opened = await evaluate(
    'const row = [...document.querySelectorAll(\'.auto-item-clickable\')]' +
    '.find((candidate) => candidate.textContent?.includes(' + JSON.stringify(FIXTURE_NAME) + '));' +
    'row?.click(); return Boolean(row);'
  )
  assert.equal(opened, true, 'failed to open the local fixture detail')
  const detail = await waitFor(evaluate,
    'const name = document.querySelector(\'.auto-name-input\');' +
    'if (!name || name.value !== ' + JSON.stringify(FIXTURE_NAME) + ') return null;' +
    'return {' +
    'prompt: document.querySelector(\'.auto-prompt-input\')?.value,' +
    'schedule: document.querySelector(\'.sched-builder\')?.getAttribute(\'data-schedule\'),' +
    'effort: document.querySelector(\'select[aria-label="推理强度"]\')?.value,' +
    'deleteDisabled: document.querySelector(\'.auto-del-btn\')?.disabled,' +
    'saveDisabled: document.querySelector(\'.auto-save\')?.disabled};',
    'local fixture detail')
  assert.equal(detail.prompt, 'original packaged CDP prompt')
  assert.equal(detail.schedule, 'RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=5;BYDAY=MO,WE,FR')
  assert.equal(detail.effort, 'medium')
  assert.equal(detail.deleteDisabled, false)
  assert.equal(detail.saveDisabled, true)
  assert.equal(await evaluate("return !document.querySelector('.sched-raw') && !document.querySelector('.sched-advanced')"), true)

  const detailLayout = await evaluate(`
    const editor = document.querySelector('.auto-config')?.getBoundingClientRect();
    const savebar = document.querySelector('.auto-config-savebar')?.getBoundingClientRect();
    const label = document.querySelector('.auto-config-section .auto-config-label')?.getBoundingClientRect();
    const name = document.querySelector('.auto-name-input')?.getBoundingClientRect();
    const prompt = document.querySelector('.auto-prompt-input');
    const style = prompt ? getComputedStyle(prompt) : null;
    const lineHeight = style ? parseFloat(style.lineHeight) : 0;
    const chrome = style ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) : 0;
    return {
      groupedLayout: !!label && !!name && name.left > label.right,
      fixedSavebar: !!editor && !!savebar && Math.abs(editor.bottom - savebar.bottom) < 0.51,
      tenLineMax: !!style && Math.abs(parseFloat(style.maxHeight) - (lineHeight * 10 + chrome)) < 0.51,
      overflowY: style?.overflowY,
      resize: style?.resize,
      hasDetailLoadingRule: [...document.styleSheets].some((sheet) => {
        try { return [...sheet.cssRules].some((rule) => rule.selectorText === '.auto-detail-loading'); } catch { return false; }
      }),
      hasLegacyDetailLoadingText: [...document.querySelectorAll('.subagent-empty')].some((node) => node.textContent?.includes('加载详情中'))
    };
  `)
  assert.deepEqual(detailLayout, {
    groupedLayout: true,
    fixedSavebar: true,
    tenLineMax: true,
    overflowY: 'auto',
    resize: 'none',
    hasDetailLoadingRule: true,
    hasLegacyDetailLoadingText: false
  })

  await setControl(evaluate, '.auto-name-input', UPDATED_NAME)
  await setControl(evaluate, '.auto-prompt-input', UPDATED_PROMPT)
  await setControl(evaluate, '.sched-time-picker', '14:35')
  await setControl(evaluate, 'select[aria-label="推理强度"]', 'high')
  assert.equal(await waitFor(evaluate, "return document.querySelector('.auto-dirty')?.textContent?.includes('未保存')", 'dirty editor state'), true)
  assert.equal(await evaluate("return document.querySelector('.auto-save')?.disabled"), false)
  await evaluate("document.querySelector('.auto-save')?.click(); return true;")
  await waitFor(evaluate, "return document.querySelector('.auto-dirty')?.textContent?.trim() === '已保存'", 'saved editor state')

  const persisted = await readFile(automationPath, 'utf8')
  assert.ok(persisted.includes('name = ' + JSON.stringify(UPDATED_NAME)))
  assert.ok(persisted.includes('prompt = ' + JSON.stringify(UPDATED_PROMPT)))
  assert.ok(persisted.includes('rrule = ' + JSON.stringify(UPDATED_SCHEDULE)))
  assert.match(persisted, /^reasoning_effort = "high"$/m)
  assert.match(persisted, /^model = "gpt-5\.6-sol-before"$/m)
  assert.match(persisted, /^target = \{ type = "project", project_id = "e2e-project" \}$/m)
  assert.ok(persisted.includes('cwds = [' + JSON.stringify(workspace) + ']'))
  assert.ok(persisted.includes(PRIVATE_SENTINEL), 'private CLI field was not preserved')
  const updatedAt = Number(persisted.match(/^updated_at = (\d+)$/m)?.[1])
  assert.ok(updatedAt > originalUpdatedAt, 'updated_at was not advanced')
  await access(siblingPath)

  await evaluate("document.querySelector('.auto-back')?.click(); return true;")
  await waitFor(evaluate, 'return [...document.querySelectorAll(\'.auto-item-clickable\')].some((row) => row.textContent?.includes(' + JSON.stringify(UPDATED_NAME) + '))', 'updated row in list')
  await evaluate("window.__automationReloadMarker = 'persisted'")
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor(evaluate, "return window.__automationReloadMarker !== 'persisted' && typeof window.uniagent?.e2eEnabled === 'function' && await window.uniagent.e2eEnabled()", 'reloaded preload surface')
  await clickByText(evaluate, '.sidebar-nav-item', '定时任务')
  await waitFor(evaluate, 'return [...document.querySelectorAll(\'.auto-item-clickable\')].some((row) => row.textContent?.includes(' + JSON.stringify(UPDATED_NAME) + '))', 'persisted row after renderer reload')
  await evaluate(
    'const row = [...document.querySelectorAll(\'.auto-item-clickable\')]' +
    '.find((candidate) => candidate.textContent?.includes(' + JSON.stringify(UPDATED_NAME) + '));' +
    'row?.click(); return Boolean(row);'
  )
  const reloaded = await waitFor(evaluate,
    'const name = document.querySelector(\'.auto-name-input\');' +
    'if (!name || name.value !== ' + JSON.stringify(UPDATED_NAME) + ') return null;' +
    'return {' +
    'prompt: document.querySelector(\'.auto-prompt-input\')?.value,' +
    'schedule: document.querySelector(\'.sched-builder\')?.getAttribute(\'data-schedule\'),' +
    'effort: document.querySelector(\'select[aria-label="推理强度"]\')?.value};',
    'persisted detail after renderer reload')
  assert.deepEqual(reloaded, { prompt: UPDATED_PROMPT, schedule: UPDATED_SCHEDULE, effort: 'high' })

  await evaluate("document.querySelector('.auto-del-btn')?.click(); return true;")
  await waitFor(evaluate, "return Boolean(document.querySelector('.auto-confirm'))", 'delete confirmation')
  await clickByText(evaluate, '.auto-confirm button', '取消')
  assert.equal(await evaluate("return Boolean(document.querySelector('.auto-inline-editor'))"), true)
  await access(automationPath)
  await access(siblingPath)

  await evaluate("document.querySelector('.auto-del-btn')?.click(); return true;")
  await waitFor(evaluate, "return Boolean(document.querySelector('.auto-confirm'))", 'second delete confirmation')
  await evaluate("document.querySelector('.auto-del-confirm')?.click(); return true;")
  await waitFor(evaluate,
    'return !document.querySelector(\'.auto-inline-editor\') && ![...document.querySelectorAll(\'.auto-item-clickable\')].some((row) => row.textContent?.includes(' + JSON.stringify(UPDATED_NAME) + '))',
    'deleted task absent from list')
  await assert.rejects(access(automationDir), { code: 'ENOENT' })

  await evaluate("window.__automationReloadMarker = 'deleted'")
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor(evaluate, "return window.__automationReloadMarker !== 'deleted' && typeof window.uniagent?.e2eEnabled === 'function' && await window.uniagent.e2eEnabled()", 'post-delete reload')
  await clickByText(evaluate, '.sidebar-nav-item', '定时任务')
  assert.equal(await waitFor(evaluate,
    'const panel = document.querySelector(\'.automations-panel\');' +
    'const rows = [...(panel?.querySelectorAll(\'.auto-item-clickable\') || [])];' +
    'return rows.some((row) => row.textContent?.includes(\'E2E 每日日报\')) && !rows.some((row) => row.textContent?.includes(' + JSON.stringify(UPDATED_NAME) + '));',
    'deleted task absent after renderer reload'), true)
  assert.equal(await readFile(siblingPath, 'utf8').catch((error) => error.code), 'ENOENT')

  console.log('PASS packaged automation UI detail -> edit -> persisted reload -> confirmed delete -> disk/list absence')
} finally {
  await cleanup()
}
