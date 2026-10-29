// ContextMeter hover regression test against the packaged Electron renderer.
// It sends real CDP mouseMoved events one point at a time; DOM-dispatched hover
// events cannot reproduce the gap that originally made the popover disappear.
//
// Usage:
//   node test/cdp-context-meter-hover.mjs [port]
//   node test/cdp-context-meter-hover.mjs /path/to/UniAgent Public.app/Contents/MacOS/UniAgent Public [port]
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOVER_GRACE_MS = 260
const REQUEST_TIMEOUT_MS = 10_000
const STARTUP_TIMEOUT_MS = 25_000
const EXIT_TIMEOUT_MS = 5_000
const SESSION_ID = 'ua_context_meter_hover_fixture'
const inputArg = process.argv[2] || '9222'
const explicitPortArg = process.argv[3]
const packagedMode = !/^\d+$/.test(inputArg)

function withTimeout(promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function reservePort() {
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

function packagedPaths(input) {
  const executable = resolve(input)
  const marker = `${sep}Contents${sep}MacOS${sep}`
  const markerIndex = executable.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error('expected a packaged executable under UniAgent Public.app/Contents/MacOS')
  const appBundle = executable.slice(0, markerIndex)
  return {
    executable,
    renderer: join(appBundle, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'renderer', 'index.html')
  }
}

function matchesRenderer(target, expectedRenderer) {
  if (target?.type !== 'page' || typeof target.url !== 'string' || !target.webSocketDebuggerUrl) return false
  try {
    return new URL(target.url).protocol === 'file:' && fileURLToPath(target.url) === expectedRenderer
  } catch {
    return false
  }
}

async function getPage(port, expectedRenderer, childState) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastTargets = []
  for (let attempt = 0; attempt < 100; attempt++) {
    if (childState?.error) throw childState.error
    if (childState?.exit) {
      throw new Error(`packaged app exited before CDP was ready: ${JSON.stringify(childState.exit)}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      lastTargets = Array.isArray(targets)
        ? targets.map(({ type, title, url }) => ({ type, title, url }))
        : []
      const page = expectedRenderer
        ? targets.find((target) => matchesRenderer(target, expectedRenderer))
        : targets.find((target) => target.type === 'page' && /index\.html/.test(target.url))
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (Date.now() >= deadline) break
  }
  throw new Error(`no page on port ${port}; targets=${JSON.stringify(lastTargets)}`)
}

async function prepareFixture(root) {
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const uniagentData = join(root, 'uniagent-data')
  const chromiumData = join(root, 'chromium-data')
  const workspace = join(root, 'workspace')
  const isolatedTmp = join(root, 'tmp')
  const xdgConfig = join(root, 'xdg-config')
  const xdgData = join(root, 'xdg-data')
  const xdgCache = join(root, 'xdg-cache')
  const xdgState = join(root, 'xdg-state')
  const xdgRuntime = join(root, 'xdg-runtime')
  const dirs = [home, bin, uniagentData, chromiumData, workspace, isolatedTmp, xdgConfig, xdgData, xdgCache, xdgState, xdgRuntime]
  for (const dir of dirs) await mkdir(dir, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const codex = join(bin, 'codex')
  await writeFile(join(uniagentData, 'sessions.json'), JSON.stringify([{
    id: SESSION_ID,
    title: 'Context hover fixture',
    config: { agentId: 'codex', workdir: workspace, permissionMode: 'read-only' },
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    origin: 'created'
  }], null, 2))
  await writeFile(codex, `#!/bin/sh
case "$1 $2" in
  "--version ") printf '%s\n' 'codex-cli 1.0.0' ;;
  "login status") printf '%s\n' 'Logged in' ;;
  "app-server --help") printf '%s\n' 'Usage: codex app-server [options]' ;;
  "models ") exit 0 ;;
  *) exit 0 ;;
esac
`)
  await chmod(codex, 0o700)
  return { home, bin, uniagentData, chromiumData, workspace, isolatedTmp, xdgConfig, xdgData, xdgCache, xdgState, xdgRuntime }
}

let port = packagedMode
  ? (explicitPortArg === undefined ? await reservePort() : Number(explicitPortArg))
  : Number(inputArg)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('port must be an integer from 1 through 65535')
}

let scratch
let child
let childExited
let ws
const childState = { error: undefined, exit: undefined }
let expectedRenderer
let packagedFixtureSessionId = null
let packagedFixtureWorkdir = null

async function stopApp() {
  try { ws?.close() } catch {}
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  if (childExited) await Promise.race([childExited, pause(700)])
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  if (childExited) await Promise.race([childExited, pause(EXIT_TIMEOUT_MS)])
}

async function cleanup() {
  await stopApp()
  if (scratch) await rm(scratch, { recursive: true, force: true })
}

if (packagedMode) {
  const packaged = packagedPaths(inputArg)
  const executableStat = await stat(packaged.executable)
  if (!executableStat.isFile()) throw new Error(`packaged executable is not a file: ${packaged.executable}`)
  expectedRenderer = packaged.renderer
  scratch = await mkdtemp(join(tmpdir(), 'uniagent-context-hover-'))
  const fixture = await prepareFixture(scratch)
  packagedFixtureWorkdir = fixture.workspace
  child = spawn(packaged.executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${fixture.chromiumData}`, '--ua-e2e'], {
    cwd: fixture.workspace,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || '',
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      USER: 'uniagent-hover',
      LOGNAME: 'uniagent-hover',
      SHELL: '/usr/bin/false',
      TMPDIR: fixture.isolatedTmp,
      TMP: fixture.isolatedTmp,
      TEMP: fixture.isolatedTmp,
      XDG_CONFIG_HOME: fixture.xdgConfig,
      XDG_DATA_HOME: fixture.xdgData,
      XDG_CACHE_HOME: fixture.xdgCache,
      XDG_STATE_HOME: fixture.xdgState,
      XDG_RUNTIME_DIR: fixture.xdgRuntime,
      ZDOTDIR: join(scratch, 'zdotdir'),
      CODEX_HOME: join(fixture.home, '.codex'),
      TRAE_HOME: join(fixture.home, '.trae'),
      CLAUDE_CONFIG_DIR: join(fixture.home, '.claude'),
      UNIAGENT_USER_DATA: fixture.uniagentData,
      UNIAGENT_CAPABILITY_HOME: fixture.home,
      UNIAGENT_CAPABILITY_DATA: join(fixture.home, '.uniagent-capability-data'),
      GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
      GIT_CONFIG_SYSTEM: '/dev/null',
      NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
      NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
      UA_DISABLE_GPU: '1'
    }
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000) })
  child.once('error', (error) => { childState.error = error })
  childExited = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    childState.exit = { code, signal, stderr }
    resolveExit(childState.exit)
  }))
}

const page = await getPage(port, expectedRenderer, childState)
ws = new WebSocket(page.webSocketDebuggerUrl)
let commandId = 1
const pending = new Map()
let phase = 'connect'
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = commandId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} timed out during ${phase}`))
    }, 10_000)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
await send('Runtime.enable')
if (packagedMode) {
  await send('Page.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
}

async function evaluate(body) {
  const result = await send('Runtime.evaluate', {
    expression: `(async()=>{${body}})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

async function move(point, delayMs = 20) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  if (delayMs) await pause(delayMs)
}

async function click(point, delayMs = 20) {
  await move(point, delayMs)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

async function popoverSnapshot() {
  return JSON.parse(await evaluate(`
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    const trigger = meter?.querySelector('.ctx-meter-trigger');
    const anchor = meter?.querySelector('.ctx-pop-anchor');
    const popover = meter?.querySelector('.ctx-pop');
    const button = meter?.querySelector('.ctx-compact-btn');
    const rect = (element) => {
      const value = element?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom,
        width: value.width, height: value.height } : null;
    };
    return JSON.stringify({
      mounted: !!meter,
      open: !!popover,
      trigger: rect(trigger),
      anchor: rect(anchor),
      popover: rect(popover),
      button: rect(button)
    });
  `))
}

async function assertOpenAt(point, label, delayMs = 20) {
  await move(point, delayMs)
  const state = JSON.parse(await evaluate(`
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    const anchor = document.querySelector('.composer-wrap .ctx-pop-anchor');
    const trigger = document.querySelector('.composer-wrap .ctx-meter-trigger');
    const rect = (element) => {
      const value = element?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom } : null;
    };
    const target = document.elementFromPoint(${point.x}, ${point.y});
    return JSON.stringify({
      open: !!document.querySelector('.composer-wrap .ctx-pop'),
      inMeterTree: !!target?.closest('.ctx-meter'),
      inAnchor: !!target?.closest('.ctx-pop-anchor'),
      target: target?.className || target?.tagName || '',
      meter: rect(meter),
      trigger: rect(trigger),
      anchor: rect(anchor)
    });
  `))
  if (!state.open) throw new Error(`${label}: popover closed at (${point.x}, ${point.y}); state=${JSON.stringify(state)}`)
  return state
}

function line(from, to, steps) {
  return Array.from({ length: steps + 1 }, (_, index) => ({
    x: from.x + ((to.x - from.x) * index) / steps,
    y: from.y + ((to.y - from.y) * index) / steps
  }))
}

async function closeFromOutside(trigger) {
  await evaluate(`document.activeElement?.blur?.(); return true;`)
  // Always enter first so this helper generates a real pointerleave even when a
  // prior failed run left the popover open while CDP's pointer was already
  // outside the renderer content area.
  await move({
    x: trigger.left + trigger.width / 2,
    y: trigger.top + trigger.height / 2
  })
  const point = {
    // Stay inside a known rendered strip, but well outside the deliberately
    // wide diagonal hover corridor.
    x: Math.max(4, trigger.left - 240),
    y: Math.max(4, Math.min(windowHeight - 48, trigger.top - 80))
  }
  await move(point)
  await pause(HOVER_GRACE_MS + 100)
  const state = JSON.parse(await evaluate(`
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    const target = document.elementFromPoint(${point.x}, ${point.y});
    return JSON.stringify({
      closed: !document.querySelector('.composer-wrap .ctx-pop'),
      meterHovered: meter?.matches(':hover') === true,
      focusWithin: meter?.contains(document.activeElement) === true,
      activeTag: document.activeElement?.tagName || '',
      target: target?.className || target?.tagName || ''
    });
  `))
  if (!state.closed) {
    throw new Error(
      `popover did not close after pointer left to (${point.x}, ${point.y}); ` +
      `target=${state.target}, meterHovered=${state.meterHovered}, ` +
      `focusWithin=${state.focusWithin}, active=${state.activeTag}`
    )
  }
}

async function pressEscape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53 })
}

const viewport = await send('Runtime.evaluate', { expression: 'JSON.stringify({ width: innerWidth, height: innerHeight })', returnByValue: true })
const { height: windowHeight } = JSON.parse(viewport.result.value)
let passed = false

try {
  if (packagedMode) {
    await withTimeout((async () => {
      for (;;) {
        const ready = JSON.parse(await evaluate(`
          return JSON.stringify({
            app: !!document.querySelector('.app'),
            loading: !!document.querySelector('.startup-loading'),
            sessionsError: !!document.querySelector('.new-task[role="alert"]'),
            e2e: typeof window.uniagent?.e2eEnabled === 'function' ? await window.uniagent.e2eEnabled() : false,
            agents: await window.uniagent.getLifecycleSnapshot().then(
              (agents) => agents.map((agent) => ({
                id: agent.id,
                installed: agent.installed,
                availability: agent.lifecycle?.availability
              })),
              () => []
            )
          })
        `))
        const codexReady = ready.agents.some((agent) => agent.id === 'codex' && agent.availability === 'available')
        if (ready.app && ready.e2e && !ready.loading && !ready.sessionsError && codexReady) return
        await pause(250)
      }
    })(), STARTUP_TIMEOUT_MS, 'waiting for packaged renderer bootstrap')
    packagedFixtureSessionId = await evaluate(`
      const existing = (await window.uniagent.listSessions()).find((session) => session.config?.workdir === ${JSON.stringify(packagedFixtureWorkdir)});
      if (existing) return existing.id;
      const session = await window.uniagent.createSession(
        { agentId: 'codex', workdir: ${JSON.stringify(packagedFixtureWorkdir)}, permissionMode: 'workspace-write' },
        'Context hover fixture'
      );
      return session.id;
    `)
    if (!packagedFixtureSessionId) throw new Error('failed to create packaged fixture session')
    let packagedReadyState = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ready = await evaluate(`
        return JSON.stringify({
          app: !!document.querySelector('.app'),
          loading: !!document.querySelector('.startup-loading'),
          row: !!document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(packagedFixtureSessionId)}]'),
          rows: [...document.querySelectorAll('.sl-body .session-item[data-session-id]')]
            .map((node) => node.getAttribute('data-session-id')),
          sessions: await window.uniagent.listSessions().then(
            (sessions) => sessions.map((session) => ({
              id: session.id,
              title: session.title,
              agentId: session.config?.agentId,
              status: session.status,
              readOnly: session.readOnly,
              origin: session.origin
            })),
            (error) => ({ error: String(error) })
          ),
          agents: await window.uniagent.getLifecycleSnapshot().then(
            (agents) => agents.map((agent) => ({
              id: agent.id,
              installed: agent.installed,
              availability: agent.lifecycle?.availability,
              bin: agent.bin
            })),
            (error) => ({ error: String(error) })
          )
        })
      `)
      const state = JSON.parse(ready)
      packagedReadyState = state
      if (state.app && state.row) break
      await pause(250)
      if (attempt === 119) {
        throw new Error(`fixture writable session did not appear in packaged mode: ${JSON.stringify(packagedReadyState)}`)
      }
    }
  }
  let initial = await popoverSnapshot()
  if (!initial.mounted) {
    const selected = await evaluate(`
      const row = document.querySelector('.sl-body .session-item[data-session-id=${JSON.stringify(packagedMode ? packagedFixtureSessionId : '')}]')
        || document.querySelector('.sl-body .session-item[data-session-id]');
      row?.click();
      return !!row;
    `)
    if (!selected) throw new Error('ContextMeter is not mounted and no writable sidebar session is available')
    for (let attempt = 0; attempt < 80 && !initial.mounted; attempt += 1) {
      await pause(100)
      initial = await popoverSnapshot()
    }
    if (!initial.mounted) throw new Error('ContextMeter did not mount after selecting a writable session')
  }
  const ringSize = JSON.parse(await evaluate(`
    const ring = document.querySelector('.composer-wrap .ctx-bar')?.getBoundingClientRect();
    return JSON.stringify(ring ? { width: ring.width, height: ring.height } : null);
  `))
  if (!ringSize || Math.abs(ringSize.width - 20) > 0.5 || Math.abs(ringSize.height - 20) > 0.5) {
    throw new Error(`context ring must be 20px: ${JSON.stringify(ringSize)}`)
  }
  const composerControls = JSON.parse(await evaluate(`
    const send = document.querySelector('.composer-wrap .composer-send-btn');
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    const sr = send?.getBoundingClientRect();
    const mr = meter?.getBoundingClientRect();
    return JSON.stringify({
      circular: !!sr && Math.abs(sr.width - sr.height) < 0.5 && getComputedStyle(send).borderRadius === '50%',
      sendSize: sr ? { width: sr.width, height: sr.height } : null,
      gap: sr && mr ? sr.left - mr.right : 0,
      unobscured: !!sr && document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2)?.closest('.composer-send-btn') === send
    });
  `))
  if (!composerControls.circular || Math.abs(composerControls.sendSize?.width - 30) > 0.5 || composerControls.gap < 12 || !composerControls.unobscured) {
    throw new Error(`composer primary controls are not circular/spaced: ${JSON.stringify(composerControls)}`)
  }

  // 1. Cross every pixel of the old vertical gap slowly. The target in the
  // visual gap must now be the transparent anchor, never unrelated page content.
  phase = 'vertical-path setup'
  await closeFromOutside(initial.trigger)
  await assertOpenAt({ x: initial.trigger.left + initial.trigger.width / 2, y: initial.trigger.top + initial.trigger.height / 2 }, 'open on trigger')
  let state = await popoverSnapshot()
  const triggerCenterX = state.trigger.left + state.trigger.width / 2
  const popoverCenterX = state.popover.left + state.popover.width / 2
  if (state.popover.bottom > state.trigger.top) {
    throw new Error(`popover is not above trigger: popover.bottom=${state.popover.bottom}, trigger.top=${state.trigger.top}`)
  }
  if (Math.abs(popoverCenterX - triggerCenterX) > 1) {
    throw new Error(`popover is not centered above trigger: popoverCenterX=${popoverCenterX}, triggerCenterX=${triggerCenterX}`)
  }
  if (state.anchor.bottom < state.trigger.top + 1) {
    throw new Error(`popover hitbox does not overlap trigger: anchor.bottom=${state.anchor.bottom}, trigger.top=${state.trigger.top}`)
  }
  if (triggerCenterX < state.popover.left || triggerCenterX > state.popover.right) {
    throw new Error(`popover is not anchored above trigger: triggerCenterX=${triggerCenterX}, popover=[${state.popover.left},${state.popover.right}]`)
  }
  const sendHitWhileOpen = await evaluate(`
    const send = document.querySelector('.composer-wrap .composer-send-btn');
    const rect = send?.getBoundingClientRect();
    return !!rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.composer-send-btn') === send;
  `)
  if (!sendHitWhileOpen) throw new Error('context hover corridor obscures the adjacent send button')
  const overlapLeft = Math.max(state.trigger.left, state.popover.left)
  const overlapRight = Math.min(state.trigger.right, state.popover.right)
  const verticalX = (overlapLeft + overlapRight) / 2
  let bridgeHits = 0
  for (let y = Math.floor(state.trigger.top - 1); y >= Math.ceil(state.popover.bottom + 1); y--) {
    const hit = await assertOpenAt({ x: verticalX, y }, 'vertical gap', 75)
    if (!hit.inMeterTree) throw new Error(`vertical gap is not a continuous hitbox at y=${y}`)
    if (hit.inAnchor) bridgeHits++
  }
  if (!bridgeHits) throw new Error('vertical path never hit the transparent anchor')

  // 2. Reset, then take a diagonal route from the trigger into the opposite
  // side of the popover. Every physical intermediate point must retain it.
  phase = 'diagonal-path setup'
  await closeFromOutside(state.trigger)
  await assertOpenAt({ x: state.trigger.right - 3, y: state.trigger.top + state.trigger.height * 0.7 }, 'reopen for diagonal')
  state = await popoverSnapshot()
  const diagonal = line(
    { x: state.trigger.right - 3, y: state.trigger.top + state.trigger.height * 0.7 },
    { x: state.popover.left + state.popover.width * 0.3, y: state.popover.bottom - 6 },
    24
  )
  phase = 'diagonal path'
  for (const point of diagonal) {
    const hit = await assertOpenAt(point, 'diagonal path', 30)
    if (!hit.inMeterTree) throw new Error(`diagonal path left the hover hitbox at (${point.x}, ${point.y})`)
  }

  // 3. Traverse all the way to the action at human-slow speed (>1 s total),
  // proving this is a continuous hitbox rather than a timing-only workaround.
  const slow = line(
    { x: state.popover.left + state.popover.width * 0.3, y: state.popover.bottom - 6 },
    { x: state.button.left + state.button.width / 2, y: state.button.top + state.button.height / 2 },
    18
  )
  phase = 'slow path'
  for (const point of slow) await assertOpenAt(point, 'slow path', 80)

  // Availability is unrelated to hover geometry. Temporarily enable the DOM
  // control and intercept its click in capture phase so this test can prove a
  // physical click lands on the final action without starting real compaction.
  phase = 'physical click setup'
  await evaluate(`
    const button = document.querySelector('.composer-wrap .ctx-compact-btn');
    button.disabled = false;
    window.__ctxHoverClickCount = 0;
    window.__ctxHoverBlockClick = (event) => {
      if (!event.target?.closest?.('.ctx-compact-btn')) return;
      window.__ctxHoverClickCount++;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('click', window.__ctxHoverBlockClick, true);
    return true;
  `)
  state = await popoverSnapshot()
  const buttonPoint = { x: state.button.left + state.button.width / 2, y: state.button.top + state.button.height / 2 }
  await click(buttonPoint)
  const clickCount = await evaluate(`return window.__ctxHoverClickCount || 0;`)
  if (clickCount !== 1) throw new Error(`physical compact-button click count was ${clickCount}, expected 1`)
  phase = 'button leave close'
  await move({ x: Math.max(8, state.trigger.left - 240), y: Math.max(8, state.trigger.top - 80) })
  await pause(HOVER_GRACE_MS + 100)
  if (await evaluate(`return !!document.querySelector('.composer-wrap .ctx-pop');`)) {
    throw new Error('hover-open popover stayed open after clicking its action and moving away')
  }

  await evaluate(`
    document.removeEventListener('click', window.__ctxHoverBlockClick, true);
    delete window.__ctxHoverBlockClick;
    document.querySelector('.composer-wrap .ctx-meter-trigger')?.blur();
    return true;
  `)

  // 4. A trigger click must take ownership of the already-open popover so it
  // stays visible after the pointer leaves, until an outside click or Esc closes it.
  phase = 'pin-open setup'
  await closeFromOutside(state.trigger)
  const triggerPoint = {
    x: initial.trigger.left + initial.trigger.width / 2,
    y: initial.trigger.top + initial.trigger.height / 2
  }
  await assertOpenAt(triggerPoint, 'reopen before pin')
  await click(triggerPoint)
  const pinnedOutsidePoint = {
    x: Math.max(8, initial.trigger.left - 240),
    y: Math.max(8, Math.min(windowHeight - 48, initial.trigger.top - 80))
  }
  phase = 'pin-open leave'
  await move(pinnedOutsidePoint)
  await pause(HOVER_GRACE_MS + 120)
  let pinnedState = JSON.parse(await evaluate(`
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    return JSON.stringify({
      open: !!document.querySelector('.composer-wrap .ctx-pop'),
      focusWithin: meter?.contains(document.activeElement) === true,
      activeTag: document.activeElement?.tagName || ''
    });
  `))
  if (!pinnedState.open || !pinnedState.focusWithin) {
    throw new Error(`trigger click did not pin the popover; open=${pinnedState.open}, focusWithin=${pinnedState.focusWithin}, active=${pinnedState.activeTag}`)
  }

  phase = 'outside click close'
  await click(pinnedOutsidePoint)
  let closedByOutside = JSON.parse(await evaluate(`
    return JSON.stringify({
      closed: !document.querySelector('.composer-wrap .ctx-pop'),
      activeTag: document.activeElement?.tagName || ''
    });
  `))
  if (!closedByOutside.closed) {
    throw new Error(`popover did not close on outside click; active=${closedByOutside.activeTag}`)
  }

  phase = 'escape close setup'
  await click(triggerPoint)
  pinnedState = JSON.parse(await evaluate(`
    const meter = document.querySelector('.composer-wrap .ctx-meter');
    return JSON.stringify({
      open: !!document.querySelector('.composer-wrap .ctx-pop'),
      focusWithin: meter?.contains(document.activeElement) === true
    });
  `))
  if (!pinnedState.open || !pinnedState.focusWithin) {
    throw new Error(`trigger click did not reopen pinned popover before Escape; open=${pinnedState.open}, focusWithin=${pinnedState.focusWithin}`)
  }
  phase = 'escape close'
  await pressEscape()
  const closedByEscape = JSON.parse(await evaluate(`
    return JSON.stringify({
      closed: !document.querySelector('.composer-wrap .ctx-pop'),
      activeTag: document.activeElement?.tagName || ''
    });
  `))
  if (!closedByEscape.closed) {
    throw new Error(`popover did not close on Escape; active=${closedByEscape.activeTag}`)
  }

  // Hover-only popovers must also respond to Escape while focus remains in the
  // composer textarea; the key event does not bubble through the meter in this path.
  phase = 'hover-only escape close'
  await move({ x: Math.max(8, triggerPoint.x - 240), y: Math.max(8, triggerPoint.y - 80) })
  await evaluate(`document.querySelector('.composer-wrap .composer-input')?.focus(); return true;`)
  await assertOpenAt(triggerPoint, 'hover-only reopen')
  await pressEscape()
  const hoverEscapeClosed = await evaluate(`return !document.querySelector('.composer-wrap .ctx-pop');`)
  if (!hoverEscapeClosed) throw new Error('hover-only popover did not close on Escape')

  passed = true
  console.log(`context-meter-hover: ok (bridgeHits=${bridgeHits}, physicalClicks=${clickCount})`)
} finally {
  if (!passed) {
    await evaluate(`
      if (window.__ctxHoverBlockClick) {
        document.removeEventListener('click', window.__ctxHoverBlockClick, true);
        delete window.__ctxHoverBlockClick;
      }
      return true;
    `).catch(() => {})
  }
  await cleanup().catch(() => {})
}
