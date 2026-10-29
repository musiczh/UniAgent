import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createAcceptanceProcessSweeper, createAcceptanceTerminationHandler } from './acceptance-process-sweeper.mjs'

const binary = resolve(process.argv[2] || 'release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(!binary.startsWith('/Applications/'), 'verification must use the repository packaged artifact')
const fixture = await mkdtemp(join(tmpdir(), 'uniagent-startup-performance-'))
const home = join(fixture, 'home'), data = join(fixture, 'data')
const sweeper = createAcceptanceProcessSweeper()
let ws, child, stderr = ''
let cleanupPromise, forceCleanup = false
const cleanup = () => cleanupPromise ||= (async () => {
  ws?.close()
  await sweeper.sweep({ shouldAbort: () => forceCleanup })
  await rm(fixture, { recursive: true, force: true })
})()
const termination = createAcceptanceTerminationHandler({ cleanup,
  requestForceCleanup: () => { forceCleanup = true },
  onCleanupError: error => console.error('isolated startup cleanup failed:', error),
  exit: code => process.exit(code) })
process.on('SIGINT', () => termination.handleTerminationSignal('SIGINT', 130))
process.on('SIGTERM', () => termination.handleTerminationSignal('SIGTERM', 143))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result } catch {} await sleep(100) }
  throw new Error(label + ' timed out; stderr: ' + stderr.slice(-2500))
}
try {
  await Promise.all(['home', 'data', 'chromium', 'tmp', 'xdg', 'bin'].map(name => mkdir(join(fixture, name), { recursive: true })))
  // Synthetic metadata matches the reported session/team scale without reading user history.
  const rows = Array.from({ length: 1286 }, (_, index) => ({ id: 'perf-session-' + index,
    title: 'Startup sample ' + index, titleLocked: true,
    config: { agentId: 'codex', workdir: home, permissionMode: 'read-only' },
    status: 'idle', createdAt: Date.now() - index * 1000, archived: index >= 367 }))
  const members = ['leader', 'alpha', 'beta'].map(id => ({ id,
    role: { id: 'role_' + id, name: id, agentId: 'codex', permissionMode: 'read-only' } }))
  const team = { id: 'team_perf', revision: 1, name: 'Startup team', description: '', rules: 'Test',
    leaderMemberId: 'leader', members, limits: { concurrency: 3, maxAssignments: 30, taskMinutes: 0, runMinutes: 0 },
    status: 'active', createdAt: Date.now(), updatedAt: Date.now() }
  await mkdir(join(data, 'team-projects'))
  await writeFile(join(data, 'teams.json'), JSON.stringify([team]))
  for (let i = 0; i < 55; i++) {
    const id = 'tp_perf-' + i, name = 'Startup team ' + i
    const memberSessions = Object.fromEntries(members.map((member, j) => [member.id, rows[i * 3 + j].id]))
    members.forEach((member, j) => {
      rows[i * 3 + j].teamBinding = { teamProjectId: id, memberId: member.id }
      rows[i * 3 + j].archived = true
      if (j === 0) rows[i * 3 + j].title = name
    })
    const project = { id, revision: 1, runId: 1, name, team, spaceId: 'space_perf', spaceRoots: [home],
      status: 'interrupted', archivedAt: Date.now(), memberSessions, goal: 'Test', teamId: team.id,
      phase: 'Test', summary: '', inboxSeq: 0, handledInboxSeq: 0, activeMs: 0, assignments: [],
      communications: [], inbox: [], interactions: [], artifacts: [], messages: [], previousResults: [],
      sharedContext: { brief: 'x'.repeat(50000), decisions: [], openQuestions: [] },
      createdAt: Date.now(), updatedAt: Date.now() }
    await writeFile(join(data, 'team-projects', id + '.json'), JSON.stringify(project))
  }
  await writeFile(join(data, 'sessions.json'), JSON.stringify(rows))
  const slowShell = join(fixture, 'bin', 'shell')
  await writeFile(slowShell, '#!/bin/bash\nsleep 3\nexec /bin/bash "$@"\n')
  await chmod(slowShell, 0o700)
  const isolatedBundle = join(fixture, 'UniAgent Public.app')
  await cp(dirname(dirname(dirname(binary))), isolatedBundle, { recursive: true, verbatimSymlinks: true })
  const isolatedBinary = join(isolatedBundle, 'Contents/MacOS/UniAgent Public')
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  child = spawn(isolatedBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(fixture, 'chromium')}`, '--ua-e2e', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: home, USERPROFILE: home,
      SHELL: slowShell, TMPDIR: join(fixture, 'tmp'), UNIAGENT_USER_DATA: data,
      CODEX_HOME: join(home, '.codex'), TRAE_HOME: join(home, '.trae'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
      KIMI_CODE_HOME: join(home, '.kimi'), GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, '.dsh'),
      XDG_CONFIG_HOME: join(fixture, 'xdg'), XDG_DATA_HOME: join(fixture, 'xdg'), XDG_CACHE_HOME: join(fixture, 'xdg'),
      GIT_CONFIG_GLOBAL: join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: join(fixture, 'npm-cache'),
      UNIAGENT_CAPABILITY_HOME: home, UNIAGENT_CAPABILITY_DATA: join(home, '.uniagent-capability-data'),
      UA_DISABLE_GPU: process.env.UA_DISABLE_GPU || ''
    }
  })
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-12_000)
    if (/\[startup\]|Error:|ReferenceError/.test(String(chunk))) console.error(String(chunk).slice(0, 1500))
  })
  await once(child, 'spawn'); await sweeper.addRoot(child.pid)
  const target = await until(async () => (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()))
    .find(t => t.type === 'page' && /out\/renderer\/(boot|index)\.html$/.test(t.url)), 'renderer target', 20_000)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await Promise.race([once(ws, 'open'), sleep(5000).then(() => { throw new Error('CDP websocket open timed out') })])
  let sequence = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  })
  async function cdp(method, params = {}) {
    const id = ++sequence
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP ' + method + ' timed out')) }, 5000)
      pending.set(id, message => { clearTimeout(timer); resolve(message) })
    })
  }
  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text)
    return response.result?.result?.value
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await until(() => evaluate("!!document.querySelector('.app')"), 'business renderer')
  console.log('✓ business renderer mounted')
  await cdp('Page.bringToFront')
  await evaluate(`window.__uaEntryProbe = { frames: [], startedAt: 0, endedAt: 0, tasks: [] };
    new PerformanceObserver(list => window.__uaEntryProbe.tasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: 'longtask' });
    const sample = time => {
      const probe = window.__uaEntryProbe;
      const screen = document.querySelector('.startup-screen');
      if (screen.classList.contains('entering') && !screen.hidden) {
        if (!probe.startedAt) {
          probe.startedAt = performance.timeOrigin + time;
          probe.loadingAtEntry = !!document.querySelector('.startup-loading');
        }
        probe.frames.push(time);
      } else if (probe.startedAt) { probe.endedAt = performance.timeOrigin + time; return; }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);`)
  await until(() => evaluate("document.querySelector('.startup-screen').hidden && !document.querySelector('.app').inert"), 'UI readiness unlock')
  const probe = await evaluate('window.__uaEntryProbe')
  assert.ok(probe.frames.length > 0, 'the entrance animation must be sampled')
  assert.equal(probe.loadingAtEntry, false, 'workbench loading must finish before the entrance animation')
  assert.equal(await evaluate("!!document.querySelector('.startup-loading')"), false, 'workbench must not show startup loading after entrance')
  const gaps = probe.frames.slice(1).map((time, index) => time - probe.frames[index]).sort((a, b) => a - b)
  const maxGapMs = Math.round(gaps.at(-1) || 0), p95GapMs = Math.round(gaps[Math.floor(gaps.length * .95)] || 0)
  console.log('✓ entrance frames: ' + JSON.stringify({ frames: probe.frames.length, maxGapMs, p95GapMs }))
  console.log('entrance diagnostics: ' + JSON.stringify({ slowFrames: probe.frames.slice(1).flatMap((time, index) => time - probe.frames[index] > 50 ? [{ at: Math.round(probe.frames[index] - probe.frames[0]), gap: Math.round(time - probe.frames[index]) }] : []), tasks: probe.tasks.map(task => ({ at: Math.round(task.startTime - probe.frames[0]), duration: Math.round(task.duration) })) }))
  console.log('✓ UI unlocked after startup loading finishes')
  assert.ok(p95GapMs <= 34 && maxGapMs <= 100, 'entrance must remain responsive with restored sessions and teams')
  const catalog = await evaluate('window.uniagent.teamCatalog().then(c => ({ projects: c.projects.length, errors: c.errors }))')
  assert.equal(catalog.projects, 55, 'all fixture teams must be restored')
  assert.deepEqual(catalog.errors, [])
  const startup = await until(async () => (await readFile(join(data, 'performance-logs', 'app.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse).find(row => row.kind === 'startup'), 'startup metrics')
  const uiReady = await until(async () => (await readFile(join(data, 'performance-logs', 'app.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse).find(row => row.kind === 'startup-ui'), 'UI readiness metrics')
  assert.ok(startup.data.windowShownMs < startup.data.backendLoadedMs, 'window must be visible before business imports finish')
  assert.ok(startup.data.initializedMs - startup.data.windowShownMs >= 2500, 'slow initialization must remain in the background')
  console.log('✓ startup timings: ' + JSON.stringify({ ...startup.data, ...uiReady.data }))
  // The two handlers resume from the same readiness barriers; log callbacks may run in either order.
  assert.ok(uiReady.data.uiReadyMs + 50 >= startup.data.initializedMs, 'UI readiness must wait for all startup loading')
  await evaluate("window.uniagent.e2eLifecycleFixture('mixed')")
  await until(() => evaluate("!!document.querySelector('textarea') && !document.querySelector('textarea').disabled"), 'fixture composer')
  await evaluate("document.querySelector('textarea')?.focus()")
  await cdp('Input.insertText', { text: 'READY' })
  assert.equal(await evaluate("document.querySelector('textarea')?.value.includes('READY')"), true, 'input works after initialization')
  await cdp('Page.bringToFront')
  await until(() => evaluate('!document.hidden'), 'visible performance sample')
  console.log('✓ renderer monitor: ' + JSON.stringify(await evaluate("({ visible: !document.hidden, longTaskObserver: PerformanceObserver.supportedEntryTypes.includes('longtask') })")))
  await evaluate("setTimeout(() => { const end = performance.now() + 250; while (performance.now() < end) {} }, 0)")
  await until(async () => (await readFile(join(data, 'performance-logs', 'app.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse).find(row => row.kind === 'renderer_stall' && row.data.longestMs >= 200), 'renderer stall logging', 15_000)
  console.log('cdp-startup-performance: ok; overlay/input/unlock/stall logging; ' + JSON.stringify(startup.data))
} finally {
  await cleanup()
}
