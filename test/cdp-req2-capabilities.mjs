// Requirement 2 packaged-App CDP acceptance. Launches the real app with an
// isolated HOME, user-data directory, capability data directory, and temp/XDG
// roots. It executes one fixture-only removal and rolls it back; normal
// capability sync is never executed.
// Usage: node test/cdp-req2-capabilities.mjs /path/to/UniAgent-executable [port]
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAcceptanceProcessSweeper,
  createAcceptanceTerminationHandler
} from './acceptance-process-sweeper.mjs'

const REQUEST_TIMEOUT = 8000
const STARTUP_TIMEOUT = 25000
const JOB_TIMEOUT = 30000

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
function withTimeout(promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + milliseconds + 'ms')), milliseconds)
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
  }), 3000, 'allocating a CDP port')
  await withTimeout(new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())), 3000, 'releasing the CDP port')
  return port
}

async function snapshotTree(root) {
  const entries = []
  async function visit(path, rel) {
    const info = await lstat(path)
    const mode = info.mode & 0o7777
    if (info.isSymbolicLink()) {
      entries.push({ path: rel, type: 'symlink', mode, target: await readlink(path) })
      return
    }
    if (info.isDirectory()) {
      entries.push({ path: rel, type: 'directory', mode })
      for (const name of (await readdir(path)).sort()) {
        try { await visit(join(path, name), rel === '.' ? name : join(rel, name)) }
        catch (error) { if (error?.code !== 'ENOENT') throw error }
      }
      return
    }
    if (info.isFile()) {
      entries.push({ path: rel, type: 'file', mode, content: (await readFile(path)).toString('base64') })
      return
    }
    entries.push({ path: rel, type: 'other', mode })
  }
  try { await visit(root, '.') }
  catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, entries: [] }
    throw error
  }
  return { exists: true, entries }
}

const snapshotText = (snapshot) => JSON.stringify(snapshot)
const snapshotDiff = (before, after) => {
  const left = new Map(before.entries.map((entry) => [entry.path, JSON.stringify(entry)]))
  const right = new Map(after.entries.map((entry) => [entry.path, JSON.stringify(entry)]))
  return [...new Set([...left.keys(), ...right.keys()])].sort().filter((path) => left.get(path) !== right.get(path))
}
const withoutSubtree = (snapshot, subtree) => ({
  ...snapshot,
  entries: snapshot.entries.filter((entry) => entry.path !== subtree && !entry.path.startsWith(subtree + sep))
})
// Runtime binary probes (codex/traecli arg0 wrapper dirs under */tmp/arg0),
// Claude's own config/backups, and Grok runtime probe logs are ephemeral churn
// recreated on normal launch/scan — unrelated to whether a rollback restored the
// capability tree. Strip them so the tree-equality check measures capability
// dirs only.
const EPHEMERAL = [
  /(^|\/)tmp\/arg0(\/|$)/,
  /^\.claude\/\.claude\.json(?:\.lock)?$/,
  /(^|\/)\.claude\/backups(\/|$)/,
  /^\.claude\/backups$/,
  /^\.local(\/|$)/,
  /^\.grok\/logs\/unified\.jsonl$/,
  /^\.uniagent\/mcp(\/|$)/
]
const withoutEphemeral = (snapshot) => ({
  ...snapshot,
  entries: snapshot.entries.filter((entry) => !EPHEMERAL.some((pattern) => pattern.test(entry.path)))
})
const snapshotHasMetadata = (snapshot) => snapshot.entries.every((entry) =>
  typeof entry.path === 'string' && typeof entry.type === 'string' && Number.isInteger(entry.mode) &&
  (entry.type !== 'file' || typeof entry.content === 'string') &&
  (entry.type !== 'symlink' || typeof entry.target === 'string'))

const binary = process.argv[2]
if (!binary) throw new Error('pass the packaged UniAgent executable path')
const explicitPort = process.argv[3]
if (explicitPort !== undefined && (!/^\d+$/.test(explicitPort) || Number(explicitPort) < 1 || Number(explicitPort) > 65535)) {
  throw new Error('port must be an integer from 1 through 65535')
}
const port = explicitPort === undefined ? await unusedLoopbackPort() : Number(explicitPort)
const resolvedBinary = resolve(binary)
const executableMarker = sep + 'Contents' + sep + 'MacOS' + sep
const markerIndex = resolvedBinary.lastIndexOf(executableMarker)
if (markerIndex < 0) throw new Error('expected a packaged .app executable under Contents/MacOS')
const expectedRendererPath = join(resolvedBinary.slice(0, markerIndex), 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'renderer', 'index.html')
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-req2-cdp-'))
const home = join(fixture, 'home')
const data = join(home, '.uniagent-capability-data')
const userData = join(fixture, 'user-data')
const isolatedTmp = join(fixture, 'tmp')
const xdgConfig = join(fixture, 'xdg-config')
const xdgData = join(fixture, 'xdg-data')
const xdgCache = join(fixture, 'xdg-cache')
const xdgState = join(fixture, 'xdg-state')
const xdgRuntime = join(fixture, 'xdg-runtime')
const zdotdir = join(fixture, 'zdotdir')
const fixtureFiles = new Map()
const put = async (path, content) => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  fixtureFiles.set(path, content)
}
for (const name of ['alpha-remove', 'beta-remove']) await put(join(home, '.codex/skills', name, 'SKILL.md'), '# ' + name + '\n')
for (const name of ['trae-copy-selected', 'trae-copy-other']) await put(join(home, '.trae/skills', name, 'SKILL.md'), '# ' + name + '\n')
await put(join(home, '.codex/config.toml'), '[mcp_servers.fixture_mcp]\ncommand = "node"\n')
await put(join(home, '.trae/traecli.toml'), '[mcp_servers.trae_fixture]\ncommand = "node"\n')
// 需求4: reproduce the real-machine dual-config state — an authoritative
// traecli.toml alongside a stale legacy cli/config.toml. Before the fix this
// flipped traex layoutKnown → false, marking every user skill 只读 and blocking
// codex↔traex transfer. The provider must now treat the layout as KNOWN.
await put(join(home, '.trae/cli/config.toml'), 'model = "stale-legacy"\n')
await put(join(home, '.claude/skills/claude-readonly/SKILL.md'), '# Claude readonly\n')
await put(join(home, '.claude.json'), JSON.stringify({ mcpServers: { claude_mcp: { command: 'node' } } }))
await put(join(home, '.agents/skills/shared-fixture/SKILL.md'), '# Shared fixture\n')
for (const directory of [data, userData, isolatedTmp, xdgConfig, xdgData, xdgCache, xdgState, xdgRuntime, zdotdir]) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
}

let launchError
let stderr = ''
const processSweeper = createAcceptanceProcessSweeper({
  includeCurrentProcessDescendants: true,
  termGraceMs: 1_500,
  killDeadlineMs: 8_000
})
const child = spawn(binary, ['--remote-debugging-port=' + port, '--user-data-dir=' + userData, '--ua-e2e'], {
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    SHELL: process.env.SHELL || '/bin/zsh',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    XDG_RUNTIME_DIR: xdgRuntime,
    ZDOTDIR: zdotdir,
    CODEX_HOME: join(home, '.codex'),
    TRAE_HOME: join(home, '.trae'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    APPDATA: join(fixture, 'appdata'),
    LOCALAPPDATA: join(fixture, 'local-appdata'),
    NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'),
    NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
    GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    UA_DISABLE_GPU: '1',
    UNIAGENT_CAPABILITY_HOME: home,
    UNIAGENT_CAPABILITY_DATA: data
  },
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'ignore', 'pipe']
})
child.on('error', (error) => { launchError = error })
child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
let childExitResult
child.once('exit', (code, signal) => {
  childExitResult = { code, signal }
})

async function fetchTargets() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json', { signal: controller.signal })
    if (!response.ok) throw new Error('CDP target endpoint returned HTTP ' + response.status)
    return await withTimeout(response.json(), 1500, 'decoding CDP target list')
  } finally { clearTimeout(timer) }
}

function matchesPackagedPage(entry) {
  if (entry?.type !== 'page' || typeof entry.webSocketDebuggerUrl !== 'string' || typeof entry.url !== 'string') return false
  try { return new URL(entry.url).protocol === 'file:' && fileURLToPath(entry.url) === expectedRendererPath }
  catch { return false }
}

async function page() {
  const deadline = Date.now() + STARTUP_TIMEOUT
  let lastTargets = []
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (childExitResult) throw new Error('packaged app exited before CDP was ready: ' + JSON.stringify(childExitResult) + (stderr ? '\n' + stderr : ''))
    try {
      const pages = await fetchTargets()
      lastTargets = Array.isArray(pages) ? pages.map((entry) => ({ type: entry.type, title: entry.title, url: entry.url })) : []
      const found = Array.isArray(pages) ? pages.find(matchesPackagedPage) : undefined
      if (found) return found
    } catch {}
    await delay(200)
  }
  throw new Error('packaged UniAgent CDP page did not start on port ' + port + '; targets=' + JSON.stringify(lastTargets) + (stderr ? '\n' + stderr : ''))
}

let socket
let fatal
let forceCleanupRequested = false
let cleanupPromise
const cleanup = () => {
  cleanupPromise ||= (async () => {
    const errors = []
    try { socket?.close() } catch {}
    try {
      await processSweeper.sweep({ shouldAbort: () => forceCleanupRequested })
      if (forceCleanupRequested) await processSweeper.forceSweep()
    } catch (error) {
      errors.push(error)
    }
    try { await rm(fixture, { recursive: true, force: true }) }
    catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'requirement-2 cleanup failed')
  })()
  return cleanupPromise
}
const terminationHandler = createAcceptanceTerminationHandler({
  cleanup,
  requestForceCleanup: () => { forceCleanupRequested = true },
  onCleanupError: (error) => console.error('FATAL requirement-2 cleanup:', error),
  exit: (code) => process.exit(code)
})
const onSigint = () => terminationHandler.handleTerminationSignal('SIGINT', 130)
const onSigterm = () => terminationHandler.handleTerminationSignal('SIGTERM', 143)
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass })
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''))
}
const same = (actual, expected) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index])
try {
  await processSweeper.addRoot(child.pid)
  const target = await page()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  let sequence = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (!message.id || !pending.has(message.id)) return
    const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timer)
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result)
  })
  const rejectPending = (reason) => {
    for (const [id, task] of pending) {
      clearTimeout(task.timer); task.reject(reason); pending.delete(id)
    }
  }
  socket.addEventListener('close', () => rejectPending(new Error('CDP socket closed')))
  socket.addEventListener('error', () => rejectPending(new Error('CDP socket failed')))
  await withTimeout(new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), { once: true })
  }), REQUEST_TIMEOUT, 'opening the CDP socket')
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(new Error('CDP socket is not open for ' + method)); return }
    const id = sequence++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('CDP ' + method + ' timed out after ' + REQUEST_TIMEOUT + 'ms'))
    }, REQUEST_TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    try { socket.send(JSON.stringify({ id, method, params })) }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression: '(async()=>{' + expression + '})()', awaitPromise: true, returnByValue: true, userGesture: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  const waitFor = async (expression, label, timeout = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await evaluate('return Boolean(' + expression + ');')) return
      await delay(100)
    }
    throw new Error('timed out waiting for ' + label)
  }
  const clickAgentTab = async (label) => {
    const clicked = await evaluate(`
      const label = ${JSON.stringify(label)};
      const cards = [...document.querySelectorAll('.capability-tabs .cap-agent-card')];
      const button = cards.find((node) => node.querySelector('.a-nm')?.textContent?.trim().startsWith(label));
      if (button) button.click();
      return !!button;
    `)
    if (!clicked) throw new Error('missing capability agent card: ' + label)
    await waitFor(`document.querySelector('.capability-tabs .cap-agent-card.on .a-nm')?.textContent?.trim().startsWith(${JSON.stringify(label)})`, label + ' agent card tab')
  }
  // 需求2/3 — 工具能力已迁入设置页分类导航：打开设置 → 点「工具能力」分类。
  const gotoCapabilities = async () => {
    const state = await evaluate(`
      const settings = document.querySelector('.settings-entry');
      if (settings) settings.click();
      return { settingsFound: !!settings };
    `)
    await waitFor(`document.querySelector('.settings-panel .main-panel-title')?.textContent.trim() === '设置'`, 'settings panel for capabilities')
    const nav = await evaluate(`
      const button = [...document.querySelectorAll('.settings-panel .set-nav-item')].find((node) => node.textContent.includes('工具能力'));
      if (button) button.click();
      return { navFound: !!button };
    `)
    await waitFor(`document.querySelector('.capability-center .main-panel-title')?.textContent.trim() === '工具能力' &&
      document.querySelectorAll('.capability-row').length > 0`, 'capability center via settings category')
    return { ...state, ...nav }
  }
  const openInventoryDetail = async (name) => {
    await evaluate(`document.querySelector('.cap-detail button[aria-label="关闭详情"]')?.click(); return true;`)
    await waitFor(`!document.querySelector('.cap-detail')`, 'closed previous capability detail')
    await waitFor(`[...document.querySelectorAll('.capability-row')].some((row) => row.querySelector('.capability-name')?.textContent.trim() === ${JSON.stringify(name)})`, name + ' inventory row')
    const state = await evaluate(`
      const row = [...document.querySelectorAll('.capability-row')].find((candidate) =>
        candidate.querySelector('.capability-name')?.textContent?.trim() === ${JSON.stringify(name)});
      const state = { row: !!row, role: row?.getAttribute('role'), readOnly: row?.classList.contains('ro') };
      row?.click(); return state;
    `)
    await waitFor(`document.querySelector('.cap-detail .cd-name')?.textContent.trim() === ${JSON.stringify(name)} && !document.querySelector('.cap-detail .panel-loading')`, name + ' capability detail')
    return state
  }
  const selectOnlyInventoryItem = async (name) => {
    const row = await openInventoryDetail(name)
    const action = await evaluate(`
      const button = document.querySelector('.cap-detail .cap-detail-uninstall');
      const state = { button: !!button, disabled: button?.disabled ?? true, text: button?.textContent.trim() || '' };
      if (button && !button.disabled) button.click(); return state;
    `)
    if (action.button && !action.disabled) await waitFor(`document.querySelector('.cap-confirm')?.textContent.includes(${JSON.stringify(name)})`, name + ' removal confirmation')
    return { ...row, ...action }
  }
  const switchView = async (label) => {
    const clicked = await evaluate(`
      const label = ${JSON.stringify(label)};
      const button = [...document.querySelectorAll('.capability-view-switch button')].find((node) => node.textContent.trim() === label);
      if (button) button.click();
      return !!button;
    `)
    if (!clicked) throw new Error('missing capability view switch: ' + label)
    await waitFor(`document.querySelector('.capability-view-switch button.active')?.textContent.trim() === ${JSON.stringify(label)}`, label + ' capability view')
  }
  const setCompareSide = async (sideIndex, label) => {
    const clicked = await evaluate(`
      const label = ${JSON.stringify(label)};
      const sides = [...document.querySelectorAll('.capability-compare-head .cmp-side')];
      const side = sides[${sideIndex}];
      const cards = [...(side?.querySelectorAll('.cap-agent-card') || [])];
      const card = cards.find((node) => node.querySelector('.a-nm')?.textContent?.trim().startsWith(label));
      if (card) card.click();
      return { found: !!side, clicked: !!card };
    `)
    if (!clicked.found) throw new Error('missing compare side container ' + sideIndex)
    if (!clicked.clicked) throw new Error('missing compare agent card: ' + label)
    await waitFor(`
      (() => {
        const sides = [...document.querySelectorAll('.capability-compare-head .cmp-side')];
        const side = sides[${sideIndex}];
        return side?.querySelector('.cap-agent-card.on .a-nm')?.textContent?.trim().startsWith(${JSON.stringify(label)});
      })()
    `, `compare side ${sideIndex} agent ${label}`)
  }
  const selectOnlyCompareRow = async (name) => {
    // Names include a separate scope badge; wait for this exact private item to become syncable.
    await waitFor(`!document.querySelector('.capability-compare-list .panel-loading') &&
      [...document.querySelectorAll('.capability-compare-row.selectable[role="checkbox"]')].some((row) => row.querySelector('.capability-name .nm')?.textContent.trim() === ${JSON.stringify(name)})`, name + ' ready selectable compare row', 30000)
    return evaluate(`
    const name = ${JSON.stringify(name)};
    const selectable = [...document.querySelectorAll('.capability-compare-row.selectable[role="checkbox"]')];
    for (const row of selectable) {
      if (row.getAttribute('aria-checked') === 'true') row.click();
    }
    const row = selectable.find((candidate) => candidate.querySelector('.capability-name .nm')?.textContent?.trim() === name);
    if (row && row.getAttribute('aria-checked') !== 'true') row.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const selbar = document.querySelector('.cap-selbar.capability-compare-sync');
    const show = selbar?.classList.contains('show') || false;
    const button = [...(selbar?.querySelectorAll('button') || [])].find((node) => node.textContent.includes('同步'));
    return {
      found: !!row,
      selectable: !!row,
      checked: !!row && row.getAttribute('aria-checked') === 'true',
      selbarShow: show,
      selbarText: selbar?.textContent?.trim() || '',
      syncText: button?.textContent?.trim() || '',
      syncDisabled: button?.disabled ?? true
    };
  `)
  }
  const openCompareSync = async () => {
    const state = await evaluate(`
      const selbar = document.querySelector('.cap-selbar.capability-compare-sync');
      const button = [...(selbar?.querySelectorAll('button') || [])].find((node) => node.textContent.includes('同步'));
      const result = { found: !!button, disabled: button?.disabled ?? true, text: button?.textContent.trim() || '' };
      if (button && !button.disabled) button.click();
      return result;
    `)
    await waitFor(`document.querySelector('.capability-sync-panel')`, 'capability sync panel')
    // Compare-triggered sync may arrive before a scan finishes. If nothing is
    // rendered yet, kick an explicit scan and wait for inventory items.
    await waitFor(`document.querySelectorAll('.cap-sync-item').length > 0 ||
      [...document.querySelectorAll('.cap-sync-direction button')].some((node) => node.textContent.includes('扫描能力') && !node.disabled)`,
    'prepared capability sync controls')
    const hasItems = await evaluate(`return document.querySelectorAll('.cap-sync-item').length > 0;`)
    if (!hasItems) {
      await evaluate(`
        const scan = [...document.querySelectorAll('.cap-sync-direction button')]
          .find((node) => node.textContent.includes('扫描能力') && !node.disabled);
        if (scan) scan.click();
        return !!scan;
      `)
      await waitFor(`document.querySelectorAll('.cap-sync-item').length > 0`, 'capability sync scan items', 20000)
    }
    return state
  }
  const syncState = () => evaluate(`
    const rows = [...document.querySelectorAll('.cap-sync-item')];
    return {
      direction: [...document.querySelectorAll('.cap-sync-direction > b')].map((node) => node.textContent.trim()),
      names: rows.map((row) => row.querySelector('.cap-sync-name')?.textContent.trim() || ''),
      checkedNames: rows.filter((row) => row.querySelector(':scope > input[type=checkbox]')?.checked)
        .map((row) => row.querySelector('.cap-sync-name')?.textContent.trim() || '')
    };
  `)
  const backToCapabilities = async () => {
    const state = await evaluate(`
      const button = [...document.querySelectorAll('.capability-sync-panel .main-panel-head button')]
        .find((node) => node.textContent.includes('工具能力'));
      const result = { found: !!button, text: button?.textContent.trim() || '' };
      if (button) button.click();
      return result;
    `)
    await waitFor(`document.querySelector('.capability-center .main-panel-title')?.textContent.trim() === '工具能力' &&
      document.querySelectorAll('.capability-row').length > 0`, 'tools capability center after sync back')
    return { ...state, destination: await evaluate(`return {
      title: document.querySelector('.capability-center .main-panel-title')?.textContent.trim() || '',
      syncVisible: !!document.querySelector('.capability-sync-panel')
    };`) }
  }

  await send('Runtime.enable')
  const identity = await evaluate(`return {
    title: document.title,
    href: location.href,
    hasBridge: typeof window.uniagent?.capabilityInventoryList === 'function',
    hasRoot: !!document.querySelector('#root')
  };`)
  // `/json` can expose the provisional title captured before React finishes
  // loading. The exact packaged file URL selected above plus the live page
  // identity are authoritative.
  check('连接到目标 packaged UniAgent 页面',
    fileURLToPath(identity.href) === expectedRendererPath && identity.title === 'UniAgent Public' && identity.hasBridge && identity.hasRoot,
  JSON.stringify({ port, target: target.url, identity }))
  await delay(500)
  // Native mutation dialogs stay denied. Capability removal uses the in-app
  // confirmation dialog below, while ordinary sync prompts remain denied.
  await evaluate(`
    window.__req2MutationDialogs = { confirm: 0, prompt: 0 };
    window.confirm = () => {
      window.__req2MutationDialogs.confirm += 1;
      return false;
    };
    window.prompt = () => { window.__req2MutationDialogs.prompt += 1; return null; };
    return true;
  `)

  const entry = await gotoCapabilities()
  await waitFor(`document.querySelector('.capability-center .main-panel-title')?.textContent.trim() === '工具能力' &&
    document.querySelectorAll('.capability-tabs button').length === 6 && document.querySelectorAll('.capability-row').length > 0`,
  'capability inventory')
  entry.title = await evaluate(`return document.querySelector('.capability-center .main-panel-title')?.textContent.trim() || '';`)
  check('设置页工具能力分类入口', entry.settingsFound && entry.navFound && entry.title === '工具能力')

  const tabs = await evaluate(`return [...document.querySelectorAll('.capability-tabs .cap-agent-card .a-nm')].map((node) => node.textContent.trim());`)
  check('六 Agent tabs', tabs.length === 6 && ['Codex', 'TraeX', 'Claude Code', 'Kimi Code', 'Grok', 'DeepSeek'].every((name) => tabs.includes(name)), tabs.join(', '))
  const chips = await evaluate(`return {
    wrapper: !!document.querySelector('.cap-kind-chips'),
    buttons: [...document.querySelectorAll('.cap-kind-chips .cap-chip')].map((node) => node.textContent.trim())
  };`)
  check('类型筛选 chips', chips.wrapper && chips.buttons.some((x) => x.startsWith('全部')), JSON.stringify(chips))
  const sources = await evaluate(`return [...document.querySelectorAll('.capability-row')].map((row) => ({
    name: row.querySelector('.capability-name')?.textContent?.trim() || '',
    scope: row.querySelector('.cap-foot .tag.scope')?.textContent?.trim() || '',
    path: row.querySelector('.cap-desc.cap-path')?.textContent?.trim() || ''
  }));`)
  check('来源与作用域展示',
    sources.some((x) => x.name === 'shared-fixture' && x.scope.includes('共享') && x.path.includes('shared-fixture')) &&
    sources.some((x) => x.scope.includes('内置')),
    JSON.stringify(sources.slice(0, 6))
  )
  const readOnly = await evaluate(`
    const builtins = [...document.querySelectorAll('.capability-row')].filter((row) => row.querySelector('.tag.scope')?.textContent.trim() === '内置');
    return { count: builtins.length, allReadOnly: builtins.every((row) => row.classList.contains('ro') && row.getAttribute('role') === 'button' && !row.querySelector('.cap-uninstall')) };
  `)
  check('内置能力保持只读且可查看详情', readOnly.count > 0 && readOnly.allReadOnly, JSON.stringify(readOnly))
  await openInventoryDetail('uniagent-handoff')
  const builtinDetail = await evaluate(`return { readonly: !!document.querySelector('.cap-detail .cd-ro'), removal: !!document.querySelector('.cap-detail .cap-detail-uninstall') };`)
  check('内置详情明确只读且无删除操作', builtinDetail.readonly && !builtinDetail.removal, JSON.stringify(builtinDetail))
  await evaluate(`document.querySelector('.cap-detail button[aria-label="关闭详情"]')?.click(); return true;`)
  const shared = await evaluate(`
    const row = [...document.querySelectorAll('.capability-row')]
      .find((node) => node.querySelector('.capability-name')?.textContent.trim() === 'shared-fixture');
    return { found: !!row, manageable: !!row && !row.classList.contains('ro'), detailRole: row?.getAttribute('role'), removeLabel: row?.querySelector('.cap-uninstall')?.getAttribute('aria-label') || '' };
  `)
  check('共享 Skill 可管理且删除入口明确', shared.found && shared.manageable && shared.detailRole === 'button' && shared.removeLabel === '删除共享 Skill', JSON.stringify(shared))
  const sharedRemoval = await selectOnlyInventoryItem('shared-fixture')
  const sharedConfirm = await evaluate(`return { text: document.querySelector('.cap-confirm')?.textContent || '', impact: document.querySelector('.cap-confirm-impact')?.textContent || '' };`)
  check('共享 Skill 删除确认解释源与依赖影响', sharedRemoval.button && sharedRemoval.text === '删除共享 Skill' && sharedConfirm.text.includes('删除共享源目录') && sharedConfirm.text.includes('此操作不可撤销') && sharedConfirm.impact.includes('受影响 Agent'), JSON.stringify(sharedConfirm))
  await evaluate(`const button = [...document.querySelectorAll('.cap-confirm button')].find((node) => node.textContent.trim() === '取消'); button?.click(); return !!button;`)
  await waitFor(`!document.querySelector('.cap-confirm')`, 'cancelled shared Skill deletion')

  const homeBeforeRemoval = await snapshotTree(home)
  const dataBeforeRemoval = await snapshotTree(data)
  check('隔离 HOME/data 初始递归快照含内容、类型与 mode', snapshotHasMetadata(homeBeforeRemoval) && snapshotHasMetadata(dataBeforeRemoval))

  await switchView('跨 Agent 对比')
  await waitFor(`document.querySelector('.cmp-arrow') && !document.querySelector('.capability-compare-swap')`, 'compare arrow/no swap selector')
  const compareDirection = await evaluate(`
    const arrow = document.querySelector('.cmp-arrow');
    return {
      arrow: arrow?.textContent?.trim() || '',
      label: arrow?.getAttribute('aria-label') || '',
      title: arrow?.getAttribute('title') || '',
      swap: !!document.querySelector('.capability-compare-swap'),
      nativeSelects: document.querySelectorAll('.capability-compare-head select').length
    };
  `)
  check('对比页固定左来源到右目标（无 swap / 原生 select）', compareDirection.arrow === '' && compareDirection.label === '来源到目标' && compareDirection.title === '来源到目标' && !compareDirection.swap && compareDirection.nativeSelects === 0, JSON.stringify(compareDirection))

  await setCompareSide(0, 'Codex')
  await setCompareSide(1, 'TraeX')
  await waitFor(`document.querySelectorAll('.capability-compare-row').length > 0`, 'compare capability rows', 30000)
  const codexComparePick = await selectOnlyCompareRow('alpha-remove')
  check('对比页选择 Codex→TraeX 差异项', codexComparePick.found && codexComparePick.selectable && codexComparePick.checked && codexComparePick.selbarShow && !codexComparePick.syncDisabled && codexComparePick.syncText.includes('(1)'), JSON.stringify(codexComparePick))
  const codexOpen = await openCompareSync()
  const codexSync = await syncState()
  check('Codex → TraeX 精确方向', codexOpen.found && !codexOpen.disabled && same(codexSync.direction, ['codex', 'traex']), JSON.stringify(codexSync.direction))
  check('Codex → TraeX 仅预选所选项', same(codexSync.checkedNames, ['alpha-remove']) && codexSync.names.includes('alpha-remove') && codexSync.names.includes('beta-remove'), JSON.stringify(codexSync.checkedNames))
  // 需求4: transfer modes are 增量转移(默认, merge) / 覆盖转移(clone-supported-scope);
  // the overwrite control is red-bordered/red-texted, distinct from the orange danger class.
  const modeUi = await evaluate(`
    const labels = [...document.querySelectorAll('.capability-sync-panel label')];
    const merge = labels.find((node) => node.textContent.includes('增量转移'));
    const overwrite = labels.find((node) => node.textContent.includes('覆盖转移'));
    const mergeRadio = merge?.querySelector('input[type=radio]');
    const overwriteStyle = overwrite ? getComputedStyle(overwrite) : null;
    const rgb = overwriteStyle ? overwriteStyle.color.match(/\\d+/g)?.map(Number) : null;
    const border = overwriteStyle ? overwriteStyle.borderColor.match(/\\d+/g)?.map(Number) : null;
    return {
      hasMerge: !!merge, hasOverwrite: !!overwrite,
      mergeDefault: !!mergeRadio?.checked,
      overwriteClass: overwrite?.classList.contains('cap-sync-overwrite') || false,
      redText: !!rgb && rgb[0] > 180 && rgb[1] < 120 && rgb[2] < 120,
      redBorder: !!border && border[0] > 180 && border[1] < 120 && border[2] < 120,
      mergeText: merge?.textContent.trim() || '', overwriteText: overwrite?.textContent.trim() || ''
    };
  `)
  check('Codex → TraeX 转移模式文案（增量/覆盖）', modeUi.hasMerge && modeUi.hasOverwrite && modeUi.mergeDefault && modeUi.mergeText.includes('默认') && modeUi.overwriteText.includes('完全复刻支持范围'), JSON.stringify(modeUi))
  check('覆盖转移红框红字', modeUi.overwriteClass && modeUi.redText && modeUi.redBorder, JSON.stringify(modeUi))

  const firstBack = await backToCapabilities()
  check('同步页返回工具能力', firstBack.found && firstBack.text.includes('工具能力') && firstBack.destination.title === '工具能力' && !firstBack.destination.syncVisible, JSON.stringify(firstBack))

  await switchView('清单管理')
  await clickAgentTab('TraeX')
  const traexManageable = await evaluate(`
    const rows = [...document.querySelectorAll('.capability-row')];
    const named = (name) => rows.find((row) => row.querySelector('.capability-name')?.textContent.trim() === name);
    // 需求2: 整卡可点击查看详情（role=button）；可管理项额外带卡内内联「卸载」按钮。
    const manageable = (row) => !!row && row.getAttribute('role') === 'button' &&
      !![...(row?.querySelectorAll('button') || [])].find((node) => /^(卸载|移除链接|删除共享 Skill)$/.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
    const meta = document.querySelector('.capability-tabs .cap-agent-card.on .a-meta')?.textContent?.trim() || '';
    return {
      statsWritable: meta.includes('支持管理'),
      statsReadonly: meta.includes('只读') || meta.includes('仅供查看'),
      selectedManageable: manageable(named('trae-copy-selected')),
      otherManageable: manageable(named('trae-copy-other')),
      sharedManageable: manageable(named('shared-fixture'))
    };
  `)
  check('TraeX 支持管理徽标（dual-config layoutKnown）', traexManageable.statsWritable && !traexManageable.statsReadonly && traexManageable.selectedManageable && traexManageable.otherManageable, JSON.stringify(traexManageable))
  check('TraeX 共享 Skill 可删除', traexManageable.sharedManageable, JSON.stringify(traexManageable))

  await switchView('跨 Agent 对比')
  await setCompareSide(0, 'TraeX')
  await setCompareSide(1, 'Codex')
  await waitFor(`document.querySelectorAll('.capability-compare-row').length > 0`, 'compare capability rows for TraeX→Codex', 30000)
  const traexComparePick = await selectOnlyCompareRow('trae-copy-selected')
  check('对比页选择 TraeX→Codex 差异项', traexComparePick.found && traexComparePick.selectable && traexComparePick.checked && traexComparePick.selbarShow && !traexComparePick.syncDisabled && traexComparePick.syncText.includes('(1)'), JSON.stringify(traexComparePick))
  const traexOpen = await openCompareSync()
  const traexSync = await syncState()
  check('TraeX → Codex 精确方向', traexOpen.found && !traexOpen.disabled && same(traexSync.direction, ['traex', 'codex']), JSON.stringify(traexSync.direction))
  check('TraeX → Codex 仅预选所选项', same(traexSync.checkedNames, ['trae-copy-selected']) && traexSync.names.includes('trae-copy-selected') && traexSync.names.includes('trae-copy-other'), JSON.stringify(traexSync.checkedNames))
  await backToCapabilities()

  await switchView('清单管理')
  await clickAgentTab('Codex')
  const single = await selectOnlyInventoryItem('alpha-remove')
  await waitFor(`document.querySelector('.cap-confirm')?.textContent.includes('卸载能力')`, 'single removal confirmation')
  single.text = await evaluate(`return document.querySelector('.cap-confirm')?.textContent || '';`)
  check('单项卸载先展示确认窗', single.row && single.button && single.text.includes('卸载能力') && single.text.includes('从 Codex 卸载 Skill「alpha-remove」') && single.text.includes('取消') && single.text.includes('卸载'), single.text)

  const executeRemoval = await evaluate(`
    window.__req2SawRemovalLoading = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.cap-confirm[aria-busy="true"]')?.textContent.includes('卸载中…')) {
        window.__req2SawRemovalLoading = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const button = [...document.querySelectorAll('.capability-center .cap-confirm button')]
      .find((node) => node.textContent.trim() === '卸载' && !node.disabled);
    if (button) button.click();
    return { found: !!button };
  `)
  await waitFor(`document.querySelector('.capability-center .capability-job .settings-section-title')?.textContent.trim() === '任务状态：completed' &&
    !!document.querySelector('.capability-center .capability-job .cap-sync-result')`, 'completed remove-selected job', JOB_TIMEOUT)
  await waitFor(`![...document.querySelectorAll('.capability-row')].some((node) => node.querySelector('.capability-name')?.textContent.trim() === 'alpha-remove')`, 'removed capability inventory refresh', JOB_TIMEOUT)
  const completedRemoval = await evaluate(`return {
    title: document.querySelector('.capability-center .capability-job .settings-section-title')?.textContent.trim() || '',
    result: document.querySelector('.capability-center .capability-job .cap-sync-result')?.textContent.trim() || '',
    rollback: [...document.querySelectorAll('.capability-center .capability-job button')].find((node) => /^回滚/.test(node.textContent.trim()))?.textContent.trim() || '',
    removedFromInventory: ![...document.querySelectorAll('.capability-row')].some((node) => node.querySelector('.capability-name')?.textContent.trim() === 'alpha-remove'),
    loadingShown: window.__req2SawRemovalLoading === true,
    dialogClosed: !document.querySelector('.cap-confirm')
  };`)
  const homeAfterRemoval = await snapshotTree(home)
  const dataAfterRemoval = await snapshotTree(data)
  check('remove-selected loading/成功刷新闭环', executeRemoval.found && completedRemoval.loadingShown && completedRemoval.dialogClosed && completedRemoval.title === '任务状态：completed' && completedRemoval.result.includes('已验证 1') && completedRemoval.result.includes('失败 0') && completedRemoval.rollback.startsWith('回滚') && completedRemoval.removedFromInventory, JSON.stringify(completedRemoval))
  check('remove-selected 只改变隔离 HOME 且生成隔离 journal', snapshotText(homeAfterRemoval) !== snapshotText(homeBeforeRemoval) && snapshotText(dataAfterRemoval) !== snapshotText(dataBeforeRemoval) && snapshotHasMetadata(homeAfterRemoval) && snapshotHasMetadata(dataAfterRemoval))

  // 离开工具能力再重新进入 → 触发面板卸载/重挂，验证 completed job/rollback 恢复。
  // 卸载计划刚在「跨 Agent 对比返回」落地的独立能力页执行；点设置入口卸载它，再从
  // 设置页「工具能力」分类重挂 embedded 面板，任务快照由主进程持有应恢复。
  await evaluate(`const settings = document.querySelector('.settings-entry'); if (settings) settings.click(); return !!settings;`)
  await waitFor(`document.querySelector('.settings-panel .main-panel-title')?.textContent.trim() === '设置' && !document.querySelector('.capability-center')`, 'leaving capability center after removal')
  await evaluate(`const button = [...document.querySelectorAll('.settings-panel .set-nav-item')].find((node) => node.textContent.includes('工具能力')); if (button) button.click(); return !!button;`)
  await waitFor(`document.querySelector('.capability-center .capability-job .settings-section-title')?.textContent.trim() === '任务状态：completed' &&
    [...document.querySelectorAll('.capability-center .capability-job button')].some((node) => /^(回滚此任务|回滚最近成功操作)$/.test(node.textContent.trim()) && !node.disabled)`,
  'recovered completed removal and rollback entry', JOB_TIMEOUT)
  const recovered = await evaluate(`
    const button = [...document.querySelectorAll('.capability-center .capability-job button')]
      .find((node) => /^(回滚此任务|回滚最近成功操作)$/.test(node.textContent.trim()) && !node.disabled);
    const result = { title: document.querySelector('.capability-job .settings-section-title')?.textContent.trim() || '', button: button?.textContent.trim() || '' };
    if (button) button.click();
    return result;
  `)
  check('离开再进入后恢复 completed job/rollback 入口', recovered.title === '任务状态：completed' && /^(回滚此任务|回滚最近成功操作)$/.test(recovered.button), JSON.stringify(recovered))
  await waitFor(`document.querySelector('.capability-center .capability-job .settings-section-title')?.textContent.trim() === '任务状态：rolled_back' &&
    document.querySelector('.capability-center .capability-job .cap-sync-result')?.textContent.includes('已回滚 1')`,
  'rolled-back remove-selected job', JOB_TIMEOUT)
  await waitFor(`[...document.querySelectorAll('.capability-row')].some((node) => node.querySelector('.capability-name')?.textContent.trim() === 'alpha-remove')`,
  'restored capability inventory after rollback', JOB_TIMEOUT)
  const rolledBack = await evaluate(`return {
    title: document.querySelector('.capability-center .capability-job .settings-section-title')?.textContent.trim() || '',
    result: document.querySelector('.capability-center .capability-job .cap-sync-result')?.textContent.trim() || ''
  };`)
  const homeAfterRollback = await snapshotTree(home)
  const dataAfterRollback = await snapshotTree(data)
  check('rollback rolled_back/result 闭环', rolledBack.title === '任务状态：rolled_back' && rolledBack.result.includes('已回滚 1'), JSON.stringify(rolledBack))
  const homeBeforeComparable = withoutEphemeral(withoutSubtree(homeBeforeRemoval, '.uniagent-capability-data'))
  const homeAfterComparable = withoutEphemeral(withoutSubtree(homeAfterRollback, '.uniagent-capability-data'))
  const rollbackDiff = snapshotDiff(homeBeforeComparable, homeAfterComparable)
  check('rollback 恢复原能力树内容、类型与 mode', snapshotText(homeAfterComparable) === snapshotText(homeBeforeComparable) && snapshotHasMetadata(homeAfterRollback) && snapshotHasMetadata(dataAfterRollback), JSON.stringify(rollbackDiff))

  const inlineSecond = await selectOnlyInventoryItem('beta-remove')
  const selectionUi = await evaluate(`return {
    multiSelectAvailable: !!document.querySelector('.cap-ms-toggle'),
    multiSelectActive: document.querySelector('.cap-ms-toggle')?.getAttribute('aria-pressed') === 'true',
    batchBarShown: document.querySelector('.cap-ms-bar')?.classList.contains('show') || false,
    selectedRows: document.querySelectorAll('.capability-row[aria-checked="true"]').length
  };`)
  const inlineSecondText = await evaluate(`return document.querySelector('.cap-confirm')?.textContent || '';`)
  check('详情单项卸载确认与多选独立', inlineSecond.row && inlineSecond.button && selectionUi.multiSelectAvailable && !selectionUi.multiSelectActive && !selectionUi.batchBarShown && selectionUi.selectedRows === 0 && inlineSecondText.includes('从 Codex 卸载 Skill「beta-remove」') && inlineSecondText.includes('取消') && inlineSecondText.includes('卸载'), JSON.stringify({ ...inlineSecond, selectionUi, inlineSecondText }))
  await evaluate(`const button = [...document.querySelectorAll('.cap-confirm button')].find((node) => node.textContent.trim() === '取消'); if (button) button.click(); return !!button;`)
  await waitFor(`!document.querySelector('.cap-confirm')`, 'closing second removal confirmation')

  const settingsNavigation = await evaluate(`
    const general = [...document.querySelectorAll('.settings-panel .set-nav-item')].find((node) => node.textContent.includes('通用'));
    if (general) general.click();
    return { settingsFound: !!document.querySelector('.settings-panel .main-panel-title') };
  `)
  await waitFor(`document.querySelector('.settings-panel .main-panel-title')?.textContent.trim() === '设置' && !document.querySelector('.capability-center')`, 'settings general page')
  Object.assign(settingsNavigation, await evaluate(`
    return { entryFound: !!document.querySelector('.settings-panel .capability-sync-entry') };
  `))
  check('设置页不再重复展示工具能力入口', settingsNavigation.settingsFound && !settingsNavigation.entryFound, JSON.stringify(settingsNavigation))
  await evaluate(`const button = [...document.querySelectorAll('.settings-panel .set-nav-item')].find((node) => node.textContent.includes('工具能力')); if (button) button.click(); return !!button;`)
  await waitFor(`document.querySelector('.capability-center .main-panel-title')?.textContent.trim() === '工具能力' &&
    document.querySelectorAll('.capability-row').length > 0`, 'tools capability center from settings')
  Object.assign(settingsNavigation, await evaluate(`return {
    destination: document.querySelector('.capability-center .main-panel-title')?.textContent.trim() || '',
    syncVisible: !!document.querySelector('.capability-sync-panel')
  };`))
  check('设置页工具能力分类可再次打开', settingsNavigation.destination === '工具能力' && !settingsNavigation.syncVisible, JSON.stringify(settingsNavigation))

  await switchView('清单管理')
  await clickAgentTab('Claude Code')
  await waitFor(`[...document.querySelectorAll('.capability-row')].some((row) => row.querySelector('.capability-name')?.textContent.trim() === 'claude-readonly')`, 'Claude inventory')
  const claude = await evaluate(`
    const rows = [...document.querySelectorAll('.capability-row')];
    const named = (name) => rows.find((row) => row.querySelector('.capability-name')?.textContent.trim() === name);
    // 卡片改版: 只读项整卡仍可点击查看详情（role=button），但没有内联卸载按钮，也不再有 › chevron 占位。
    const readonly = (row) => !!row && row.classList.contains('ro') && row.getAttribute('role') === 'button'
      && ![...row.querySelectorAll('button')].some((node) => /^(卸载|移除链接)$/.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
    return {
      meta: document.querySelector('.capability-tabs .cap-agent-card.on .a-meta')?.textContent?.trim() || '',
      notice: document.querySelector('.cap-readonly-note')?.textContent.includes('Claude Code 用户级原生插件可卸载') || false,
      skillReadonly: readonly(named('claude-readonly')),
      mcpReadonly: readonly(named('claude_mcp')),
      rowCount: rows.length,
      allRowsReadonly: rows.length > 0 && rows.every(readonly),
      sharedCount: rows.filter((row) => row.querySelector('.tag.scope')?.textContent.trim() === '共享').length,
      rowUninstallCount: rows.flatMap((row) => [...row.querySelectorAll('button')]).filter((button) => /^(卸载|移除链接)$/.test((button.getAttribute('aria-label') || button.textContent || '').trim())).length
    };
  `)
  check('Claude 原生管理说明与只读 Skill / MCP', claude.notice && claude.skillReadonly && claude.mcpReadonly, JSON.stringify(claude))
  // Claude does not consume .agents/skills; this fixture has no native plugin install.
  check('Claude 夹具只读且不虚构共享来源', claude.meta.includes('仅供查看') && claude.allRowsReadonly && claude.sharedCount === 0 && claude.rowUninstallCount === 0, JSON.stringify(claude))
  await openInventoryDetail('claude-readonly')
  const claudeDetail = await evaluate(`return { readonly: !!document.querySelector('.cap-detail .cd-ro'), removal: !!document.querySelector('.cap-detail .cap-detail-uninstall') };`)
  check('Claude 私有 Skill 详情无删除操作', claudeDetail.readonly && !claudeDetail.removal, JSON.stringify(claudeDetail))
  await evaluate(`document.querySelector('.cap-detail button[aria-label="关闭详情"]')?.click(); return true;`)

  await clickAgentTab('Codex')
  await waitFor(`[...document.querySelectorAll('.capability-row')].some((row) => row.querySelector('.capability-name')?.textContent.trim() === 'alpha-remove')`, 'Codex inventory before narrow layout check')
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 720, deviceScaleFactor: 1, mobile: false, screenWidth: 600, screenHeight: 720 })
  await waitFor(`window.innerWidth === 600`, '600px emulated viewport')
  const narrow = await evaluate(`
    const list = document.querySelector('.capability-list');
    const main = document.querySelector('.main');
    const toolbar = document.querySelector('.capability-toolbar');
    const search = toolbar?.querySelector('input[aria-label="搜索工具能力"]');
    const head = document.querySelector('.capability-center .main-panel-head');
    const row = [...document.querySelectorAll('.capability-row')].find((node) => node.querySelector('.capability-name')?.textContent.trim() === 'alpha-remove');
    const action = row?.querySelector('.cap-uninstall[aria-label="卸载"]');
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const mainRect = main?.getBoundingClientRect();
    const toolbarRect = toolbar?.getBoundingClientRect();
    const searchRect = search?.getBoundingClientRect();
    const actionRect = action?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      mainWidth: main?.clientWidth || 0,
      listDisplay: list ? getComputedStyle(list).display : '',
      listGrid: list ? getComputedStyle(list).gridTemplateColumns : '',
      listInsideMain: !!listRect && !!mainRect && listRect.left >= mainRect.left - 1 && listRect.right <= mainRect.right + 1,
      toolbarWraps: !!toolbar && getComputedStyle(toolbar).flexWrap === 'wrap',
      searchAccessible: !!searchRect && !!toolbarRect && searchRect.width > 0 && searchRect.left >= toolbarRect.left - 1 && searchRect.right <= toolbarRect.right + 1,
      headWraps: !!head && getComputedStyle(head).flexWrap === 'wrap',
      actionAccessible: !!actionRect && actionRect.width > 0 && actionRect.right <= window.innerWidth + 1,
      noHorizontalOverflow: (document.scrollingElement?.scrollWidth || document.documentElement.scrollWidth) <= window.innerWidth + 2
    };
  `)
  check('窄宽布局可访问', narrow.viewportWidth === 600 && narrow.mainWidth > 0 && narrow.listInsideMain && narrow.toolbarWraps && narrow.searchAccessible && narrow.headWraps, JSON.stringify(narrow))
  const renderedColumns = String(narrow.listGrid).split(/\s+/).map((value) => Number.parseFloat(value)).filter(Number.isFinite)
  check('能力卡片网格且无横向溢出', narrow.listDisplay === 'grid' && renderedColumns.length > 0 && renderedColumns.every((width) => width >= 268) && narrow.noHorizontalOverflow && narrow.actionAccessible, JSON.stringify(narrow))
  await send('Emulation.clearDeviceMetricsOverride')

  const dialogs = await evaluate(`return window.__req2MutationDialogs;`)
  let fixturesIntact = true
  const changed = []
  for (const [path, expected] of fixtureFiles) {
    try { if (await readFile(path, 'utf8') !== expected) { fixturesIntact = false; changed.push(path) } }
    catch { fixturesIntact = false; changed.push(path) }
  }
  check('仅执行一次隔离 remove-selected 且未调用原生确认窗', dialogs.confirm === 0 && dialogs.prompt === 0 && fixturesIntact, JSON.stringify({ dialogs, changed }))
} catch (error) {
  fatal = error
  console.error('FATAL requirement-2 CDP:', error instanceof Error ? error.stack || error.message : error)
} finally {
  try { await cleanup() }
  catch (error) {
    fatal ||= error
    console.error('FATAL requirement-2 cleanup:', error instanceof Error ? error.stack || error.message : error)
  }
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
}
const failed = results.filter((result) => !result.pass)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' requirement-2 CDP checks passed')
if (fatal || failed.length) process.exitCode = 1
