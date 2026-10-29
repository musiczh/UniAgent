// Packaged-App CDP supplement for two acceptance gaps:
//   A. Kaboo unauthenticated / CLI-missing degradation without secret leakage.
//   B. Deterministic FileBrowser renderer -> preload -> main IPC interactions.
//
// The harness owns the App process, fixture HOME/workdir, and every user-data
// directory. It never opens Finder: --ua-e2e records the guarded fsReveal call
// instead. A stale package that predates an opt-in fixture reports SKIP, not PASS.
//
// Usage:
//   node test/cdp-packaged-token-filebrowser.mjs [packaged-executable] [port]

// This test intentionally is not part of test:release; it must run against a
// freshly packaged app when release/mac-arm64/UniAgent Public.app is available.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REQUEST_TIMEOUT_MS = 10_000
const STARTUP_TIMEOUT_MS = 30_000
const UI_TIMEOUT_MS = 12_000
const EXIT_TIMEOUT_MS = 5_000
const SESSION_ID = 'ua_packaged_filebrowser_fixture'
const KABOO_SECRET = 'ua-kaboo-secret-must-not-reach-renderer'
const KABOO_QUERY = `{period:'month',start:'2026-08-01',end:'2026-08-31',now:'2026-08-26T00:00:00.000Z',timeZone:'Asia/Shanghai'}`

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function withTimeout(promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

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
    appAsar: join(appBundle, 'Contents', 'Resources', 'app.asar'),
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

async function findPage(port, expectedRenderer, childState) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastTargets = []
  while (Date.now() < deadline) {
    if (childState.error) throw childState.error
    if (childState.exit) throw new Error(`packaged app exited before CDP was ready: ${JSON.stringify(childState.exit)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1_500) })
      const targets = await response.json()
      lastTargets = Array.isArray(targets)
        ? targets.map(({ type, title, url }) => ({ type, title, url }))
        : []
      const page = Array.isArray(targets)
        ? targets.find((target) => matchesRenderer(target, expectedRenderer))
        : undefined
      if (page) return page
    } catch {}
    await sleep(150)
  }
  throw new Error(`no packaged UniAgent renderer on CDP port ${port}; targets=${JSON.stringify(lastTargets)}`)
}

function createCdp(socket) {
  let sequence = 0
  const pending = new Map()
  const rejectPending = (error) => {
    for (const [id, task] of pending) {
      clearTimeout(task.timer)
      task.reject(error)
      pending.delete(id)
    }
  }
  socket.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    const task = message.id && pending.get(message.id)
    if (!task) return
    pending.delete(message.id)
    clearTimeout(task.timer)
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result)
  })
  socket.addEventListener('close', () => rejectPending(new Error('CDP socket closed')))
  socket.addEventListener('error', () => rejectPending(new Error('CDP socket failed')))

  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`CDP socket is not open for ${method}`))
      return
    }
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve: resolveSend, reject, timer })
    try { socket.send(JSON.stringify({ id, method, params }))
    } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })

  const evaluate = async (body) => {
    const response = await send('Runtime.evaluate', {
      expression: `(async()=>{${body}\n})()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result?.value
  }
  return { send, evaluate }
}

async function waitFor(probe, accept, label, timeout = UI_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  let value
  let lastError
  while (Date.now() < deadline) {
    try {
      value = await probe()
      if (accept(value)) return value
    } catch (error) { lastError = error }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(value)}${lastError ? `; error=${lastError}` : ''}`)
}

const results = []
function pass(name, detail = '') {
  results.push({ status: 'PASS', name, detail })
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`)
}
function fail(name, detail = '') {
  results.push({ status: 'FAIL', name, detail })
  console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`)
}
function skip(name, detail) {
  results.push({ status: 'SKIP', name, detail })
  console.log(`SKIP ${name} - ${detail}`)
}
function check(name, condition, detail = '') {
  condition ? pass(name, detail) : fail(name, detail)
  return condition
}

const executableArg = process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public'
const packaged = packagedPaths(executableArg)
assert.equal(process.platform, 'darwin', 'packaged CDP supplement requires macOS')
const executableStat = await stat(packaged.executable)
assert.ok(executableStat.isFile(), `packaged executable is not a file: ${packaged.executable}`)
const appAsar = await readFile(packaged.appAsar)
const fixtureSupport = {
  kabooPassthrough: appAsar.includes(Buffer.from('UA_E2E_KABOO_PASSTHROUGH')),
  fileBrowserPassthrough: appAsar.includes(Buffer.from('UA_E2E_FILE_BROWSER_PASSTHROUGH')),
  finderIpcLog: appAsar.includes(Buffer.from('UA_E2E_FS_REVEAL_LOG'))
}
const currentFixtureSupport = Object.values(fixtureSupport).every(Boolean)
if (!currentFixtureSupport) {
  throw new Error(
    `packaged artifact is stale and was not tested; rebuild current source first: ${JSON.stringify(fixtureSupport)}`
  )
}

const portArg = process.argv[3]
if (portArg !== undefined && (!/^\d+$/.test(portArg) || Number(portArg) < 1 || Number(portArg) > 65535)) {
  throw new Error('port must be an integer from 1 through 65535')
}
const port = portArg === undefined ? await reservePort() : Number(portArg)
const scratch = await mkdtemp(join(tmpdir(), 'uniagent-token-files-cdp-'))
const home = join(scratch, 'home')
const uniagentData = join(scratch, 'uniagent-data')
const chromiumData = join(scratch, 'chromium-data')
const workspace = join(scratch, 'workspace')
const nested = join(workspace, 'nested')
const deep = join(nested, 'deep')
const bin = join(scratch, 'bin')
const isolatedTmp = join(scratch, 'tmp')
const xdgConfig = join(scratch, 'xdg-config')
const xdgData = join(scratch, 'xdg-data')
const xdgCache = join(scratch, 'xdg-cache')
const xdgState = join(scratch, 'xdg-state')
const xdgRuntime = join(scratch, 'xdg-runtime')
const loginShell = join(scratch, 'login-shell')
const bytedcli = join(bin, 'bytedcli')
const codex = join(bin, 'codex')
const revealLog = join(scratch, 'finder-ipc.jsonl')
const markdownPath = join(workspace, 'e2e-preview.md')
const htmlPath = join(workspace, 'e2e-preview.html')
const htmlCssPath = join(workspace, 'e2e-preview.css')
const htmlAbsoluteCssPath = join(scratch, 'e2e-absolute.css')
const htmlScriptPath = join(workspace, 'e2e-preview.js')
const binaryPath = join(workspace, 'e2e-binary.bin')
const imagePath = join(workspace, 'e2e-preview.png')
const leafPath = join(deep, 'leaf.txt')
const focusMarkdownPath = join(deep, 'focus file.md')
const fixtureDirs = [
  home, uniagentData, chromiumData, workspace, deep, bin, isolatedTmp,
  xdgConfig, xdgData, xdgCache, xdgState, xdgRuntime
]

async function prepareFixture() {
  for (const directory of fixtureDirs) await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(markdownPath, '# E2E Markdown\n\n- nested item\n- renderer proof\n\n**safe**\n')
  await writeFile(htmlPath, `<link rel="stylesheet" href="./e2e-preview.css">
    <link rel="stylesheet" href="${pathToFileURL(htmlAbsoluteCssPath).href}">
    <h1>E2E HTML</h1><img src="./e2e-preview.png">
    <script src="./e2e-preview.js"></script><script>
    window.addEventListener('load', () => {
      const heading = document.querySelector('h1');
      parent.postMessage({
        type: 'e2e-html-proof',
        heading: heading.textContent,
        relativeStyle: document.querySelector('link').getAttribute('href'),
        color: getComputedStyle(heading).color,
        background: getComputedStyle(heading).backgroundColor,
        imageWidth: document.querySelector('img').naturalWidth,
        scriptRan: heading.dataset.externalScript,
        fileUrl: location.href
      }, '*');
    });
  </script>\n`)
  await writeFile(htmlCssPath, 'h1 { color: rgb(12, 34, 56); }\n')
  await writeFile(htmlAbsoluteCssPath, 'h1 { background-color: rgb(65, 43, 21); }\n')
  await writeFile(htmlScriptPath, "document.querySelector('h1').dataset.externalScript = 'loaded';\n")
  await writeFile(binaryPath, Buffer.from([1, 0, 2]))
  await writeFile(leafPath, 'nested lazy fixture\n')
  await writeFile(focusMarkdownPath, 'one\ntwo\nrelative target\nabsolute target\n')
  await writeFile(join(workspace, 'e2e-preview.ts'), 'export const e2eFileBrowser = true\n// fixture\n')
  await writeFile(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzGQAAAABJRU5ErkJggg==', 'base64')
  )
  await writeFile(join(uniagentData, 'sessions.json'), JSON.stringify([{
    id: SESSION_ID,
    title: 'Packaged file browser fixture',
    config: { agentId: 'codex', workdir: workspace, permissionMode: 'read-only' },
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    origin: 'created'
  }], null, 2))
  await writeFile(codex, `#!/bin/sh
case "$*" in
  "--version") printf '%s\n' 'codex-cli 1.0.0' ;;
  "login status") printf '%s\n' 'Logged in' ;;
  "app-server --help") exit 1 ;;
  *) exit 0 ;;
esac
`)
  await writeFile(bytedcli, `#!/bin/sh
printf '%s\n' '${KABOO_SECRET}'
printf '%s\n' '${KABOO_SECRET}' >&2
exit 9
`)
  await writeFile(loginShell, `#!/bin/sh
printf '%s%s%s' '__UA_PATH_START__' "$PATH" '__UA_PATH_END__'
`)
  await Promise.all([chmod(codex, 0o700), chmod(bytedcli, 0o700), chmod(loginShell, 0o700)])
}

const isolatedPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`
const childState = { error: undefined, exit: undefined }
let child
let childExited
let socket
let fatal

async function stopApp() {
  try { socket?.close() } catch {}
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    if (childExited) {
      await Promise.race([childExited, sleep(700)])
    }
    // The Electron leader may exit before helpers in its detached process group.
    // Always sweep the exact group after the grace period.
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    if (childExited) {
      await Promise.race([childExited, sleep(EXIT_TIMEOUT_MS)])
    }
  }
}

let handlingSignal = false
async function handleSignal(signal) {
  if (handlingSignal) return
  handlingSignal = true
  await stopApp()
  await rm(scratch, { recursive: true, force: true })
  process.exit(signal === 'SIGINT' ? 130 : 143)
}
process.once('SIGINT', () => { void handleSignal('SIGINT') })
process.once('SIGTERM', () => { void handleSignal('SIGTERM') })

try {
  await prepareFixture()
  child = spawn(
    packaged.executable,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${chromiumData}`, '--ua-e2e'],
    {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: isolatedPath,
        HOME: home,
        USERPROFILE: home,
        USER: process.env.USER || 'uniagent-e2e',
        LOGNAME: process.env.LOGNAME || process.env.USER || 'uniagent-e2e',
        SHELL: loginShell,
        TMPDIR: isolatedTmp,
        TMP: isolatedTmp,
        TEMP: isolatedTmp,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_CACHE_HOME: xdgCache,
        XDG_STATE_HOME: xdgState,
        XDG_RUNTIME_DIR: xdgRuntime,
        ZDOTDIR: join(scratch, 'zdotdir'),
        CODEX_HOME: join(home, '.codex'),
        TRAE_HOME: join(home, '.trae'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        UNIAGENT_USER_DATA: uniagentData,
        UNIAGENT_CAPABILITY_HOME: home,
        UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'),
        GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
        GIT_CONFIG_SYSTEM: '/dev/null',
        NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
        NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
        UA_DISABLE_GPU: '1',
        UA_E2E_KABOO_PASSTHROUGH: '1',
        UA_E2E_FILE_BROWSER_PASSTHROUGH: '1',
        UA_E2E_FS_REVEAL_LOG: revealLog
      }
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8_000) })
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000) })
  child.once('error', (error) => { childState.error = error })
  childExited = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    childState.exit = { code, signal, stdout, stderr }
    resolveExit(childState.exit)
  }))

  const page = await findPage(port, packaged.renderer, childState)
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await withTimeout(new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), { once: true })
  }), REQUEST_TIMEOUT_MS, 'opening CDP socket')
  const cdp = createCdp(socket)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Browser.grantPermissions', {
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
  })
  await cdp.send('Page.bringToFront')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(
    () => cdp.evaluate(`return !!document.querySelector('.app') && typeof window.uniagent?.e2eEnabled === 'function'`),
    Boolean,
    'renderer bootstrap'
  )
  check('packaged renderer exposes guarded e2e surface', await cdp.evaluate('return await window.uniagent.e2eEnabled()') === true)

  // Reuse the established lifecycle fixture so the persisted read-only-free
  // session is deterministically eligible in the sidebar without a real agent.
  const lifecycleFixture = await cdp.evaluate(`
    if (typeof window.uniagent.e2eLifecycleFixture !== 'function') return false;
    await window.uniagent.getLifecycleSnapshot();
    await window.uniagent.e2eLifecycleFixture('mixed');
    return true;
  `)
  check('current packaged artifact exposes the deterministic lifecycle fixture', lifecycleFixture === true)
  if (lifecycleFixture) {
    await cdp.send('Page.reload', { ignoreCache: true })
    await waitFor(
      () => cdp.evaluate(`return document.readyState === 'complete' && !!document.querySelector('.app')`),
      Boolean,
      'renderer reload after lifecycle fixture'
    )
    await cdp.send('Page.bringToFront')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  check('packaged renderer is focused for clipboard interaction', await cdp.evaluate('return document.hasFocus()') === true)

  // A. Exercise the actual TokenUsagePanel and IPC. The fake bytedcli emits a
  // sentinel on both streams and fails; main must reduce that to unauthenticated.
  const tokenApi = await cdp.evaluate(`return typeof window.uniagent?.getTokenUsage === 'function'`)
  if (!tokenApi) {
    fail('Kaboo degraded-state UI', 'current fixture marker is present but the Token usage API is missing')
  } else {
    const opened = await cdp.evaluate(`
      const button=[...document.querySelectorAll('.sidebar-nav-item')].find((node)=>(node.textContent||'').includes('Token 消耗'));
      button?.click();
      return !!button;
    `)
    if (!opened) {
      fail('Kaboo degraded-state UI', 'current fixture marker is present but Token panel navigation is missing')
    } else {
      await waitFor(
        () => cdp.evaluate(`return !!document.querySelector('.token-state-unavailable, .token-usage-body')`),
        Boolean,
        'Kaboo result state'
      )
      const first = await cdp.evaluate(`
        const state=document.querySelector('.token-state-unavailable');
        return {
          fixtureBody:!!document.querySelector('.token-usage-body'),
          title:(state?.querySelector('strong')?.textContent||'').trim(),
          detail:(state?.querySelector('p')?.textContent||'').trim(),
          commands:[...document.querySelectorAll('.token-login-commands code')].map((node)=>(node.textContent||'').trim()),
          retry:!!state?.querySelector('button'),
          leaked:document.documentElement.outerHTML.includes(${JSON.stringify(KABOO_SECRET)}),
          ipc:await window.uniagent.getTokenUsage(${KABOO_QUERY})
        };
      `)
      if (first.fixtureBody) {
        fail('Kaboo degraded-state UI', 'Kaboo passthrough marker is present but the fixed success fixture was returned')
      } else {
        check(
          'Kaboo unauthenticated result renders an actionable login state',
          first.title === 'Kaboo 尚未登录' &&
            first.detail === 'unauthenticated' &&
            first.retry &&
            first.commands.includes('bytedcli kaboo status') &&
            first.commands.includes('kaboo report'),
          JSON.stringify({ title: first.title, detail: first.detail, commands: first.commands, retry: first.retry })
        )
        check(
          'Kaboo failure output is reduced to an allowlisted unavailable result',
          first.ipc?.unavailable === true && first.ipc?.reason === 'unauthenticated' && !first.leaked && !JSON.stringify(first.ipc).includes(KABOO_SECRET),
          JSON.stringify({ ipc: first.ipc, leaked: first.leaked })
        )
        check('Kaboo helper secret is absent from App process output', !stdout.includes(KABOO_SECRET) && !stderr.includes(KABOO_SECRET))

        await unlink(bytedcli)
        const refreshed = await cdp.evaluate(`
          const button=document.querySelector('.token-refresh-button');
          button?.click();
          return !!button;
        `)
        check('Kaboo refresh control remains usable in degraded state', refreshed)
        await waitFor(
          () => cdp.evaluate(`return (document.querySelector('.token-state-unavailable p')?.textContent||'').trim()`),
          (value) => value === '当前无法启动 bytedcli，Kaboo 用量读取暂不可用，与所选日期无关。',
          'Kaboo CLI-missing state'
        )
        await cdp.evaluate(`return window.uniagent.refreshTokenUsage(${KABOO_QUERY})`)
        const missing = await cdp.evaluate(`
          const state=document.querySelector('.token-state-unavailable');
          return {
            title:(state?.querySelector('strong')?.textContent||'').trim(),
            detail:(state?.querySelector('p')?.textContent||'').trim(),
            leaked:document.documentElement.outerHTML.includes(${JSON.stringify(KABOO_SECRET)}),
            ipc:await window.uniagent.getTokenUsage(${KABOO_QUERY})
          };
        `)
        check(
          'missing bytedcli degrades without exposing helper output',
          missing.title === '暂时无法读取 Token 用量' &&
            missing.detail === '当前无法启动 bytedcli，Kaboo 用量读取暂不可用，与所选日期无关。' &&
            missing.ipc?.unavailable === true &&
            missing.ipc?.reason === 'cli-unavailable' &&
            !missing.leaked,
          JSON.stringify({ title: missing.title, detail: missing.detail, ipc: missing.ipc, leaked: missing.leaked })
        )
      }
    }
  }

  // B. Open the persisted fixture session, then drive only mounted controls.
  const fileApi = await cdp.evaluate(`return typeof window.uniagent?.fsListDir === 'function' && typeof window.uniagent?.fsReveal === 'function' && typeof window.uniagent?.fsOpenHtml === 'function'`)
  if (!fileApi) {
    fail('FileBrowser packaged interactions', 'current fixture markers are present but the FileBrowser API is missing')
  } else {
    const sessionRow = await waitFor(
      () => cdp.evaluate(`return !!document.querySelector('.session-item[data-session-id=${JSON.stringify(SESSION_ID)}]')`),
      Boolean,
      'fixture session in sidebar'
    ).catch(() => false)
    if (!sessionRow) {
      fail('FileBrowser fixture session is visible', 'persisted session did not become eligible after lifecycle fixture')
    } else {
      await cdp.evaluate(`
        document.querySelector('.session-item[data-session-id=${JSON.stringify(SESSION_ID)}]')?.click();
        return true;
      `)
      await waitFor(
        () => cdp.evaluate(`return !!document.querySelector('.session-view .topbar-files-btn[title="文件查看器"]')`),
        Boolean,
        'FileBrowser toolbar entry'
      )
      const toolbarFolderIcon = await cdp.evaluate(`return !!document.querySelector('.session-view .topbar-files-btn svg.ui-icon-folder')`)
      check('toolbar file entry uses a folder SVG', toolbarFolderIcon === true, String(toolbarFolderIcon))

      const pathReply = [
        'Relative focus: nested/deep/focus file.md:3',
        `Absolute focus: [absolute focus](${(await realpath(focusMarkdownPath)).replaceAll(' ', '%20')}#L4)`
      ].join('\n\n')
      const injectedPaths = await cdp.evaluate(`
        const now=Date.now();
        return await window.uniagent.e2eInjectEvents([
          {
            sessionId:${JSON.stringify(SESSION_ID)},
            seq:now,
            ts:now,
            type:'user_message',
            state:'success',
            payload:{id:'path-user-'+now,text:'path click fixture'}
          },
          {
            sessionId:${JSON.stringify(SESSION_ID)},
            seq:now+1,
            ts:now+1,
            type:'agent_message',
            state:'success',
            payload:{id:'path-reply-'+now,text:${JSON.stringify(pathReply)}}
          }
        ]);
      `)
      check('path-click reply fixture is injected', injectedPaths === true)

      await waitFor(
        () => cdp.evaluate(`
          return !!document.querySelector(
            '.agent-md .md-path[data-path="nested/deep/focus file.md"][data-line="3"]'
          );
        `),
        Boolean,
        'relative prose path'
      )
      await cdp.evaluate(`
        window.__uaFileFocusScroll=[];
        window.__uaFileFocusOriginal=Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView=function(options){
          if(this.matches?.('.fb-code-line')) {
            window.__uaFileFocusScroll.push({line:this.dataset.line,block:options?.block});
          }
          return window.__uaFileFocusOriginal.call(this,options);
        };
        document.querySelector(
          '.agent-md .md-path[data-path="nested/deep/focus file.md"][data-line="3"]'
        )?.click();
        return true;
      `)
      const relativeFocus = await waitFor(
        () => cdp.evaluate(`
          const active=document.querySelector('.fb-tree-row.is-active');
          const focused=document.querySelector('.fb-code-line.is-focus-line');
          return {
            overlay:!!document.querySelector('.filebrowser-overlay'),
            path:(document.querySelector('.fb-preview-path')?.textContent||'').trim(),
            active:(active?.querySelector('.fb-file-name')?.textContent||'').trim(),
            source:!!document.querySelector('.fb-code.language-markdown'),
            line:focused?.dataset.line||'',
            scroll:window.__uaFileFocusScroll||[]
          };
        `),
        (value) =>
          value.overlay &&
          value.path === 'nested/deep/focus file.md' &&
          value.active === 'focus file.md' &&
          value.source &&
          value.line === '3' &&
          value.scroll.some((call) => call.line === '3' && call.block === 'center'),
        'relative reply path focus'
      )
      check(
        'plain relative reply path opens FileBrowser at line 3',
        relativeFocus.line === '3',
        JSON.stringify(relativeFocus)
      )

      await cdp.evaluate(`
        document.querySelector('.fb-toolbar .close-x[title="关闭文件浏览器 (Esc)"]')?.click();
        return true;
      `)
      await waitFor(
        () => cdp.evaluate(`return !document.querySelector('.filebrowser-overlay')`),
        Boolean,
        'close relative focus'
      )
      await cdp.evaluate(`
        [...document.querySelectorAll('.agent-md a')]
          .find((node)=>(node.textContent||'').trim()==='absolute focus')
          ?.click();
        return true;
      `)
      const absoluteFocus = await waitFor(
        () => cdp.evaluate(`
          const focused=document.querySelector('.fb-code-line.is-focus-line');
          return {
            path:(document.querySelector('.fb-preview-path')?.textContent||'').trim(),
            source:!!document.querySelector('.fb-code.language-markdown'),
            line:focused?.dataset.line||'',
            scroll:window.__uaFileFocusScroll||[]
          };
        `),
        (value) =>
          value.path === 'nested/deep/focus file.md' &&
          value.source &&
          value.line === '4' &&
          value.scroll.some((call) => call.line === '4' && call.block === 'center'),
        'absolute encoded Markdown-link focus'
      )
      check(
        'absolute %20 Markdown link opens FileBrowser at line 4',
        absoluteFocus.line === '4',
        JSON.stringify(absoluteFocus)
      )

      await cdp.evaluate(`
        document.querySelector('.fb-toolbar .close-x[title="关闭文件浏览器 (Esc)"]')?.click();
        Element.prototype.scrollIntoView=window.__uaFileFocusOriginal;
        delete window.__uaFileFocusOriginal;
        delete window.__uaFileFocusScroll;
        return true;
      `)
      await waitFor(
        () => cdp.evaluate(`return !document.querySelector('.filebrowser-overlay')`),
        Boolean,
        'close absolute focus'
      )

      await cdp.evaluate(`document.querySelector('.session-view .topbar-files-btn[title="文件查看器"]')?.click(); return true;`)
      await waitFor(
        () => cdp.evaluate(`return [...document.querySelectorAll('.fb-tree-row .fb-file-name')].map((node)=>(node.textContent||'').trim())`),
        (names) => names.includes('nested') || names.includes('e2e-preview.ts'),
        'FileBrowser root listing'
      )
      const rootNames = await cdp.evaluate(`return [...document.querySelectorAll('.fb-tree-row .fb-file-name')].map((node)=>(node.textContent||'').trim())`)
      if (!rootNames.includes('nested') || !rootNames.includes('e2e-preview.md') || !rootNames.includes('e2e-binary.bin')) {
        fail(
          'FileBrowser extended packaged interactions',
          `current fixture markers are present but the isolated root was not returned: ${JSON.stringify(rootNames)}`
        )
      } else {
        const folderGlyph = await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='nested');
          return !!row?.querySelector('.fb-file-glyph.is-dir svg.ui-icon-folder');
        `)
        check('directory tree uses a recognizable folder SVG', folderGlyph === true, String(folderGlyph))
        check('directory rows omit inline path actions', await cdp.evaluate(`return !document.querySelector('.fb-row-actions')`))
        const initialLazy = await cdp.evaluate(`return {
          deep:[...document.querySelectorAll('.fb-file-name')].some((node)=>(node.textContent||'').trim()==='deep'),
          leaf:[...document.querySelectorAll('.fb-file-name')].some((node)=>(node.textContent||'').trim()==='leaf.txt')
        }`)
        check('nested tree starts lazy (children absent)', !initialLazy.deep && !initialLazy.leaf, JSON.stringify(initialLazy))

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='nested');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        await waitFor(
          () => cdp.evaluate(`return [...document.querySelectorAll('.fb-file-name')].some((node)=>(node.textContent||'').trim()==='deep')`),
          Boolean,
          'first lazy directory expansion'
        )
        const firstDepth = await cdp.evaluate(`return {
          nestedExpanded:[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='nested')?.getAttribute('aria-expanded'),
          leaf:[...document.querySelectorAll('.fb-file-name')].some((node)=>(node.textContent||'').trim()==='leaf.txt')
        }`)
        check('first nested level loads without eagerly loading its child', firstDepth.nestedExpanded === 'true' && firstDepth.leaf === false, JSON.stringify(firstDepth))

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='deep');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        await waitFor(
          () => cdp.evaluate(`return [...document.querySelectorAll('.fb-file-name')].some((node)=>(node.textContent||'').trim()==='leaf.txt')`),
          Boolean,
          'second lazy directory expansion'
        )
        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='leaf.txt');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        await waitFor(
          () => cdp.evaluate(`return (document.querySelector('.fb-code')?.textContent||'').includes('nested lazy fixture')`),
          Boolean,
          'nested leaf preview'
        )
        pass('nested lazy expansion reaches the real leaf preview')
        check('non-HTML toolbar omits path actions', await cdp.evaluate(`return !document.querySelector('.fb-toolbar .fb-path-action')`))

        const menu = await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='leaf.txt');
          const box=row?.getBoundingClientRect();
          row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:(box?.left||0)+20,clientY:(box?.top||0)+8}));
          await new Promise((resolve)=>setTimeout(resolve,30));
          return [...document.querySelectorAll('.fb-context-menu [role=menuitem]')].map((node)=>(node.textContent||'').trim());
        `)
        check(
          'right-click menu exposes copy and Finder actions',
          ['复制绝对路径', '复制相对路径', '复制文件名', '在访达中显示'].every((label) => menu.some((text) => text.includes(label))),
          JSON.stringify(menu)
        )
        await cdp.evaluate(`
          const item=[...document.querySelectorAll('.fb-context-menu [role=menuitem]')].find((node)=>(node.textContent||'').includes('复制相对路径'));
          item?.click();
          return !!item;
        `)
        const relativeToast = await waitFor(
          () => cdp.evaluate(`return (document.querySelector('.fb-toast')?.textContent||'').trim()`),
          (value) => value === '已复制相对路径' || value === '复制失败',
          'relative-path copy result'
        )
        check('context-menu copy completes through navigator.clipboard', relativeToast === '已复制相对路径', relativeToast)
        const relativeClipboard = await cdp.evaluate(`
          try { return {ok:true,value:await navigator.clipboard.readText()} }
          catch (error) { return {ok:false,error:String(error)} }
        `)
        if (relativeClipboard.ok) {
          check('relative-path clipboard payload is exact', relativeClipboard.value === 'nested/deep/leaf.txt', JSON.stringify(relativeClipboard.value))
        } else {
          fail('relative-path clipboard readback', relativeClipboard.error)
        }

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='leaf.txt');
          const box=row?.getBoundingClientRect();
          row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:(box?.left||0)+20,clientY:(box?.top||0)+8}));
          await new Promise((resolve)=>setTimeout(resolve,30));
          const item=[...document.querySelectorAll('.fb-context-menu [role=menuitem]')].find((node)=>(node.textContent||'').includes('复制文件名'));
          item?.click();
          return !!item;
        `)
        const nameToast = await waitFor(
          () => cdp.evaluate(`return (document.querySelector('.fb-toast')?.textContent||'').trim()`),
          (value) => value === '已复制文件名' || value === '复制失败',
          'file-name copy result'
        )
        check('context-menu file-name copy completes', nameToast === '已复制文件名', nameToast)
        const nameClipboard = await cdp.evaluate(`
          try { return {ok:true,value:await navigator.clipboard.readText()} }
          catch (error) { return {ok:false,error:String(error)} }
        `)
        if (nameClipboard.ok) {
          check('file-name clipboard payload is exact', nameClipboard.value === 'leaf.txt', JSON.stringify(nameClipboard.value))
        } else {
          fail('file-name clipboard readback', nameClipboard.error)
        }

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='leaf.txt');
          const box=row?.getBoundingClientRect();
          row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:(box?.left||0)+20,clientY:(box?.top||0)+8}));
          await new Promise((resolve)=>setTimeout(resolve,30));
          const item=[...document.querySelectorAll('.fb-context-menu [role=menuitem]')].find((node)=>(node.textContent||'').includes('复制绝对路径'));
          item?.click();
          return !!item;
        `)
        const absoluteToast = await waitFor(
          () => cdp.evaluate(`return (document.querySelector('.fb-toast')?.textContent||'').trim()`),
          (value) => value === '已复制绝对路径' || value === '复制失败',
          'absolute-path copy result'
        )
        check('context-menu absolute-path copy completes', absoluteToast === '已复制绝对路径', absoluteToast)
        const absoluteClipboard = await cdp.evaluate(`
          try { return {ok:true,value:await navigator.clipboard.readText()} }
          catch (error) { return {ok:false,error:String(error)} }
        `)
        if (absoluteClipboard.ok) {
          check('absolute-path clipboard payload is exact', absoluteClipboard.value === await realpath(leafPath), JSON.stringify(absoluteClipboard.value))
        } else {
          fail('absolute-path clipboard readback', absoluteClipboard.error)
        }

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='leaf.txt');
          const box=row?.getBoundingClientRect();
          row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:(box?.left||0)+20,clientY:(box?.top||0)+8}));
          await new Promise((resolve)=>setTimeout(resolve,30));
          const item=[...document.querySelectorAll('.fb-context-menu [role=menuitem]')].find((node)=>(node.textContent||'').includes('在访达中显示'));
          item?.click();
          return !!item;
        `)
        const revealRecord = await waitFor(async () => {
          try {
            const lines = (await readFile(revealLog, 'utf8')).trim().split('\n').filter(Boolean)
            return lines.length ? JSON.parse(lines.at(-1)) : null
          } catch { return null }
        }, Boolean, 'recorded Finder IPC')
        check(
          'Finder action crosses renderer/preload/main and resolves inside workdir',
          revealRecord.sessionId === SESSION_ID &&
            revealRecord.path === 'nested/deep/leaf.txt' &&
            revealRecord.target === await realpath(leafPath),
          JSON.stringify(revealRecord)
        )
        skip('Finder external window assertion', 'intentionally suppressed in --ua-e2e; the guarded fsReveal IPC invocation and target are asserted instead')

        await cdp.evaluate(`
          window.addEventListener('message', (event) => {
            if (event.source === document.querySelector('.fb-html-preview')?.contentWindow &&
                event.data?.type === 'e2e-html-proof') window.__htmlPreviewProof = event.data;
          });
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-preview.html');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        await waitFor(() => cdp.evaluate(`return !!document.querySelector('.fb-html-preview')`), Boolean, 'rendered HTML preview')
        await waitFor(() => cdp.evaluate(`return !!window.__htmlPreviewProof`), Boolean, 'HTML preview script execution')
        const htmlPreview = await cdp.evaluate(`
          const frame=document.querySelector('.fb-html-preview');
          const toggle=document.querySelector('.fb-html-toggle');
          const chrome=document.querySelector('.fb-path-action[aria-label="在浏览器中打开"]');
          const proof=window.__htmlPreviewProof;
          return {
            sandbox:frame?.getAttribute('sandbox'),
            srcdoc:frame?.hasAttribute('srcdoc'),
            fileUrl:frame?.src,
            source:proof.heading === 'E2E HTML',
            relativeStyle:proof.relativeStyle === './e2e-preview.css' && proof.color === 'rgb(12, 34, 56)',
            absoluteStyle:proof.background === 'rgb(65, 43, 21)',
            imageLoaded:proof.imageWidth === 1,
            scriptRan:proof.scriptRan === 'loaded',
            originalDocument:proof.fileUrl === frame?.src,
            toggle:(toggle?.textContent||'').trim(),
            chrome:!!chrome?.querySelector('.fb-chrome-icon')
          };
        `)
        check('HTML preview opens the original file with local styles, images and scripts',
          htmlPreview.sandbox === null && !htmlPreview.srcdoc &&
          htmlPreview.fileUrl === pathToFileURL(await realpath(htmlPath)).href &&
          htmlPreview.source && htmlPreview.originalDocument && htmlPreview.relativeStyle &&
          htmlPreview.absoluteStyle && htmlPreview.imageLoaded && htmlPreview.scriptRan,
          JSON.stringify(htmlPreview))
        check('HTML toolbar uses compact source toggle and Chrome action', htmlPreview.toggle === '源码' && htmlPreview.chrome, JSON.stringify(htmlPreview))
        await cdp.evaluate(`document.querySelector('.fb-html-toggle')?.click(); return true;`)
        await waitFor(() => cdp.evaluate(`return !!document.querySelector('.fb-code.language-html')`), Boolean, 'HTML source mode')
        check('HTML source toggle exposes original text', await cdp.evaluate(`return (document.querySelector('.fb-code.language-html')?.textContent||'').includes('<h1>E2E HTML</h1>')`))

        const resized = await cdp.evaluate(`
          const grip=document.querySelector('.fb-tree-grip');
          const overlay=document.querySelector('.filebrowser-overlay');
          const start=grip?.getBoundingClientRect();
          const left=overlay?.getBoundingClientRect().left||0;
          grip?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window,clientX:start?.left||300,clientY:80,button:0,buttons:1}));
          window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,clientX:left+410,clientY:80,buttons:1}));
          window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,clientX:left+410,clientY:80,button:0}));
          await new Promise((resolve)=>setTimeout(resolve,80));
          return {width:document.querySelector('.fb-tree')?.getBoundingClientRect().width||0,saved:localStorage.getItem('ua.fileTreeWidth')};
        `)
        check('tree drag resize updates DOM and persistence', Math.abs(resized.width - 410) <= 2 && resized.saved === '410', JSON.stringify(resized))

        const collapsed = await cdp.evaluate(`
          document.querySelector('[aria-label="折叠目录树"]')?.click();
          await new Promise((resolve)=>setTimeout(resolve,30));
          return {collapsed:document.querySelector('.filebrowser')?.classList.contains('is-tree-collapsed'),tree:!!document.querySelector('.fb-tree'),expand:!!document.querySelector('[title="展开目录树"]')};
        `)
        check('directory tree collapses to an explicit expand control', collapsed.collapsed && !collapsed.tree && collapsed.expand, JSON.stringify(collapsed))
        await cdp.evaluate(`document.querySelector('[title="展开目录树"]')?.click(); return true;`)
        await waitFor(() => cdp.evaluate(`return !!document.querySelector('.fb-tree')`), Boolean, 'directory tree expansion')

        await cdp.evaluate(`document.querySelector('.fb-toolbar .close-x[title="关闭文件浏览器 (Esc)"]')?.click(); return true;`)
        await waitFor(() => cdp.evaluate(`return !document.querySelector('.filebrowser-overlay')`), Boolean, 'FileBrowser close before remount')
        await cdp.evaluate(`document.querySelector('.session-view .topbar-files-btn[title="文件查看器"]')?.click(); return true;`)
        await waitFor(
          () => cdp.evaluate(`return [...document.querySelectorAll('.fb-file-name')].some((node)=>(node.textContent||'').trim()==='e2e-preview.png')`),
          Boolean,
          'FileBrowser remount and root listing'
        )
        const restoredWidth = await cdp.evaluate(`return {width:document.querySelector('.fb-tree')?.getBoundingClientRect().width||0,saved:localStorage.getItem('ua.fileTreeWidth')}`)
        check('tree width survives a FileBrowser unmount/remount', Math.abs(restoredWidth.width - 410) <= 2 && restoredWidth.saved === '410', JSON.stringify(restoredWidth))

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-preview.png');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        await waitFor(
          () => cdp.evaluate(`const image=document.querySelector('.fb-image-stage.is-fit img[alt="e2e-preview.png"]'); return !!image && image.complete && image.naturalWidth === 1 && image.naturalHeight === 1`),
          Boolean,
          'image preview'
        )
        await sleep(50)
        await cdp.evaluate(`document.querySelector('.fb-toolbar-group[aria-label="图片缩放"] button[title="放大"]')?.click(); return true;`)
        const zoom = await waitFor(
          () => cdp.evaluate(`
            const group=document.querySelector('.fb-toolbar-group[aria-label="图片缩放"]');
            const image=document.querySelector('.fb-image-stage.is-actual img');
            return {label:(group?.querySelector('span')?.textContent||'').trim(),actual:!!image,width:image?.style.width||'',height:image?.style.height||''};
          `),
          (value) => value.label === '110%' && value.actual && value.width === '1.1px' && value.height === '1.1px',
          'image zoom to 110%'
        )
        check('image zoom switches to actual-size mode and changes dimensions', zoom.actual && zoom.width === '1.1px' && zoom.height === '1.1px', JSON.stringify(zoom))

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-preview.md');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        await waitFor(() => cdp.evaluate(`return !!document.querySelector('.fb-markdown .agent-md h1')`), Boolean, 'rendered Markdown preview')
        const markdown = await cdp.evaluate(`return {
          heading:(document.querySelector('.fb-markdown h1')?.textContent||'').trim(),
          items:[...document.querySelectorAll('.fb-markdown li')].map((node)=>(node.textContent||'').trim()),
          strong:(document.querySelector('.fb-markdown strong')?.textContent||'').trim()
        }`)
        check('Markdown opens in rendered mode', markdown.heading === 'E2E Markdown' && markdown.items.length === 2 && markdown.strong === 'safe', JSON.stringify(markdown))
        await cdp.evaluate(`
          const button=[...document.querySelectorAll('.fb-toolbar-group[aria-label="Markdown 查看方式"] button')].find((node)=>(node.textContent||'').trim()==='源码');
          button?.click();
          return !!button;
        `)
        await waitFor(() => cdp.evaluate(`return !!document.querySelector('.fb-code.language-markdown')`), Boolean, 'Markdown source mode')
        check(
          'Markdown source toggle exposes original text',
          await cdp.evaluate(`return (document.querySelector('.fb-code.language-markdown')?.textContent||'').includes('# E2E Markdown')`)
        )

        await cdp.evaluate(`
          const row=[...document.querySelectorAll('.fb-tree-row')].find((node)=>(node.querySelector('.fb-file-name')?.textContent||'').trim()==='e2e-binary.bin');
          row?.querySelector('.fb-tree-node')?.click();
          return !!row;
        `)
        const binaryText = await waitFor(
          () => cdp.evaluate(`return (document.querySelector('.fb-preview-body .fb-empty strong')?.textContent||'').trim()`),
          (value) => value === '二进制文件不支持预览',
          'binary preview fallback'
        )
        check('binary file renders an explicit unsupported-preview state', binaryText === '二进制文件不支持预览', binaryText)

        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await waitFor(() => cdp.evaluate(`return !document.querySelector('.filebrowser-overlay')`), Boolean, 'Escape closing FileBrowser')
        pass('Escape closes the mounted FileBrowser dialog')
      }
    }
  }
} catch (error) {
  fatal = error
  console.error(`FATAL ${error?.stack || error}`)
} finally {
  await stopApp()
  await rm(scratch, { recursive: true, force: true })
}

const allowedSkips = new Set([
  'Finder external window assertion'
])
const unexpectedSkips = results.filter((result) =>
  result.status === 'SKIP' && !allowedSkips.has(result.name)
)
for (const result of unexpectedSkips) {
  fail('required packaged assertion must not skip', `${result.name}: ${result.detail}`)
}
const counts = Object.fromEntries(['PASS', 'FAIL', 'SKIP'].map((status) => [
  status,
  results.filter((result) => result.status === status).length
]))
console.log(`SUMMARY pass=${counts.PASS} fail=${counts.FAIL} skip=${counts.SKIP}`)
if (fatal || counts.FAIL > 0) process.exitCode = 1
