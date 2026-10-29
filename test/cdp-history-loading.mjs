import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createAcceptanceProcessSweeper } from './acceptance-process-sweeper.mjs'

// Measure real, copied local histories through the packaged main/preload/renderer.
// Only sizes, counts and timings leave the isolated fixture; no conversation text.
const baseline = process.argv.includes('--baseline')
const uiOnly = process.argv.includes('--ui-only')
const executable = resolve('release/mac-arm64/UniAgent Public.app/Contents/MacOS/UniAgent Public')
assert.ok(!executable.startsWith('/Applications/'))
const renderer = resolve('release/mac-arm64/UniAgent Public.app/Contents/Resources/app.asar.unpacked/out/renderer/index.html')
const sourceHome = homedir()
const scratch = await mkdtemp(join(tmpdir(), 'uniagent-history-progress-'))
const isolatedHome = join(scratch, 'home')
const sweeper = createAcceptanceProcessSweeper({ includeCurrentProcessDescendants: true })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const samples = []
let socket
let child
let closed = false
async function cleanup() {
  if (closed) return
  closed = true
  socket?.close()
  await sweeper.sweep()
  await rm(scratch, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)) })
}

async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.name.endsWith('.jsonl')) files.push(path)
  }
  return files
}

try {
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
  for (const [agentId, directory] of [
    ['codex', '.codex/sessions'], ['traex', '.trae/cli/sessions'], ['claude', '.claude/projects']
  ]) {
    const files = []
    for (const file of await filesUnder(join(sourceHome, directory))) {
      const id = basename(file).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0]
      const info = await stat(file)
      if (id && info.size > 0 && Date.now() - info.mtimeMs > 60_000) files.push({ file, id, size: info.size })
    }
    files.sort((a, b) => a.size - b.size)
    const byId = new Map(files.map((file) => [file.id, file]))
    const copied = new Set()
    async function copyHistory(row) {
      if (!row || copied.has(row.id)) return
      copied.add(row.id)
      const destination = join(isolatedHome, relative(sourceHome, row.file))
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(row.file, destination)
      if (agentId === 'claude') return
      const text = await readFile(destination, 'utf8')
      for (const line of text.split('\n')) {
        let record
        try { record = JSON.parse(line) } catch { continue }
        const p = record.payload || {}
        await copyHistory(byId.get(p.history_base?.thread_id))
        await copyHistory(byId.get(p.agent_thread_id || p.agentThreadId || p.new_thread_id))
      }
    }
    for (const quantile of [0.5, 0.9, 0.99]) {
      const row = files[Math.floor((files.length - 1) * quantile)]
      if (!row) continue
      await copyHistory(row)
      samples.push({ agentId, id: row.id, quantile, bytes: row.size })
    }
  }
  assert.ok(samples.length > 0, 'no local history samples')
  const dirs = ['tmp', 'user-data', 'chromium', 'config', 'data', 'cache', 'state', 'runtime']
  for (const dir of dirs) await mkdir(join(scratch, dir), { recursive: true })
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  const env = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/usr/bin/false',
    HOME: isolatedHome, USERPROFILE: isolatedHome,
    UNIAGENT_USER_DATA: join(scratch, 'user-data'),
    CODEX_HOME: join(isolatedHome, '.codex'), TRAE_HOME: join(isolatedHome, '.trae'),
    CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'),
    UNIAGENT_CAPABILITY_HOME: isolatedHome,
    UNIAGENT_CAPABILITY_DATA: join(isolatedHome, '.uniagent-capability-data'),
    TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'),
    XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'),
    XDG_RUNTIME_DIR: join(scratch, 'runtime'), ZDOTDIR: join(scratch, 'zdotdir'),
    GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null',
    NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'), NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
    UA_DISABLE_GPU: '1'
  }
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, 'chromium')}`, '--ua-e2e'], {
    env, cwd: scratch, stdio: 'ignore', detached: true
  })
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject) })
  await sweeper.addRoot(child.pid)
  let target
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && !target) {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => [])
    target = targets.find((t) => t.type === 'page' && decodeURIComponent(t.url).endsWith(renderer))
    if (!target) await sleep(200)
  }
  assert.ok(target?.webSocketDebuggerUrl, 'packaged renderer startup timed out')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timer)
    message.error ? call.reject(new Error(message.error.message)) : call.done(message.result)
  })
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 90_000)
    pending.set(id, { done, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.ok(!response.exceptionDetails, response.exceptionDetails?.text)
    return response.result?.value
  }
  await send('Runtime.enable')
  while (!await evaluate('!!window.uniagent')) await sleep(100)
  await evaluate("window.uniagent.listAgentHistory('codex').then(() => true)")
  const agents = await evaluate('window.uniagent.listAgents().then(agents => agents.map(a => ({id:a.id,installed:a.installed,version:a.version})))')
  console.log(JSON.stringify({ agents }))
  const results = []
  for (const sample of uiOnly ? [] : samples) {
    if (!agents.some((agent) => agent.id === sample.agentId)) continue
    for (let run = 0; run < 3; run++) {
      const measured = await evaluate(`(async () => {
        const sample = ${JSON.stringify(sample)};
        const requestId = crypto.randomUUID();
        const start = performance.now();
        const ticks = [];
        const off = window.uniagent.onHistoryPreviewProgress(p => {
          if (p.requestId === requestId) ticks.push({ ...p, requestId:undefined, ms:performance.now()-start });
        });
        try {
          const result = await window.uniagent.previewHistory(sample.agentId,sample.id,undefined,requestId);
          return {ms:performance.now()-start,events:result.events.length,forkPoints:result.forkPoints?.length||0,ticks};
        } finally { off(); }
      })()`)
      assert.ok(measured.events > 0, `${sample.agentId} sample ${sample.quantile} contains no replayable events`)
      const phases = {}
      for (let i = 0; i < measured.ticks.length; i++) {
        const tick = measured.ticks[i]
        phases[tick.phase] = (phases[tick.phase] || 0) + ((measured.ticks[i + 1]?.ms ?? measured.ms) - tick.ms)
      }
      if (!baseline) {
        const percentages = measured.ticks.map((tick) => tick.percent)
        assert.ok(percentages.every((p) => Number.isFinite(p) && p >= 0 && p <= 100))
        assert.ok(percentages.every((p, i) => !i || p >= percentages[i - 1]), 'overall progress moved backwards')
        assert.equal(percentages.at(-1), 98)
        assert.ok(measured.ticks.every((tick) => tick.percent < 100), 'backend must reserve renderer completion')
      }
      const result = { agentId:sample.agentId,quantile:sample.quantile,bytes:sample.bytes,run,ms:measured.ms,events:measured.events,forkPoints:measured.forkPoints,phases }
      results.push(result)
      console.log(JSON.stringify(result))
    }
  }
  let ui
  if (!baseline) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await evaluate("window.uniagent.e2eLifecycleFixture('mixed').then(() => true)")
    await send('Page.reload', { ignoreCache: true })
    const readyDeadline = Date.now() + 30_000
    while (!await evaluate("!!document.querySelector('.sidebar-nav-item')").catch(() => false)) {
      assert.ok(Date.now() < readyDeadline, 'renderer reload timed out')
      await sleep(100)
    }
    await send('Page.bringToFront')
    await evaluate(`document.querySelector('.sidebar-nav-item').click()`)
    const listDeadline = Date.now() + 30_000
    while (!await evaluate("[...document.querySelectorAll('.resume-item-open:not(.is-disabled)')].some(row => !row.textContent.includes('E2E history fixture'))")) {
      assert.ok(Date.now() < listDeadline, 'history list did not become available')
      await sleep(100)
    }
    ui = await evaluate(`new Promise((resolve, reject) => {
      const samples = [];
      let seen = false;
      const start = performance.now();
      const poll = () => {
        const track = document.querySelector('.history-loading-track');
        if (track) {
          seen = true;
          const fill = document.querySelector('.history-loading-fill');
          const area = document.querySelector('.history-viewer-body').getBoundingClientRect();
          const content = document.querySelector('.history-loading-content').getBoundingClientRect();
          samples.push({ms:performance.now()-start,percent:Number(track.getAttribute('aria-valuenow')),
            label:document.querySelector('.history-loading-label [role=status]').textContent,
            contentReady:!!document.querySelector('.history-viewer-body .event-stream'),
            height:track.getBoundingClientRect().height,
            filled:fill.getBoundingClientRect().width/track.getBoundingClientRect().width*100,
            centerX:Math.abs(content.x+content.width/2-area.x-area.width/2),
            centerY:Math.abs(content.y+content.height/2-area.y-area.height/2)});
        } else if (seen) { resolve(samples); return; }
        if (performance.now()-start>60_000) { reject(new Error('UI progress timed out')); return; }
        requestAnimationFrame(poll);
      };
      [...document.querySelectorAll('.resume-item-open:not(.is-disabled)')]
        .find(row => !row.textContent.includes('E2E history fixture')).click();
      requestAnimationFrame(poll);
    })`)
    assert.ok(ui.length > 5, 'no animated UI samples')
    assert.ok(ui.every((s) => s.height === 3 && s.centerX < 1 && s.centerY < 1), 'bar must be thin and centered')
    const backwardsIndex = ui.findIndex((s, i) => i && s.percent < ui[i - 1].percent)
    assert.equal(backwardsIndex, -1, `displayed percent moved backwards: ${JSON.stringify(ui.slice(Math.max(0, backwardsIndex - 1), backwardsIndex + 1))}`)
    assert.ok(ui.every((s, i) => !i || s.filled + 0.01 >= ui[i - 1].filled), 'animated bar moved backwards')
    assert.ok(ui.every((s) => Math.abs(s.percent - s.filled) < 1.1), 'number and bar animation diverged')
    assert.equal(ui.at(-1).percent, 100)
    assert.ok(ui.filter((s) => s.percent === 100).every((s) => s.contentReady), '100% appeared before content was mounted')
    assert.ok(new Set(ui.map((s) => s.percent)).size > 5, 'progress jumped instead of easing')
    console.log(JSON.stringify({ uiFrames:ui.length,finalPercent:ui.at(-1).percent,height:ui[0].height }))
  }
  assert.ok(results.length > 0 || uiOnly, 'no benchmark measurements completed')
  await writeFile(resolve(`docs/history-loading-${baseline ? 'baseline' : uiOnly ? 'ui' : 'verified'}.json`), JSON.stringify({ measuredAt:new Date().toISOString(),agents,samples:results,ui },null,2)+'\n')
  console.log(uiOnly ? 'Packaged history loading UI: passed' : `Packaged history loading: ${results.length} measurements completed`)
} finally {
  await cleanup()
}
