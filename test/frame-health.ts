import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { FrameHealthMonitor, FRAME_PROBE_INTERVAL_MS } from '../src/main/frameHealth'
import { createFrameProbe } from '../src/preload/frameHealth'
import type { FrameHealthReply } from '../src/shared/frameHealth'
import { FRAME_HEALTH_PROBE, FRAME_HEALTH_REPLY } from '../src/shared/frameHealth'
import { APP_NAME, INTERNAL_DISTRIBUTION } from '../src/shared/distribution'

async function launchSwitches(platform: string, initial: Record<string, string> = {}) {
  const switches = new Map(Object.entries(initial))
  let atReady: Map<string, string> | undefined
  let applicationName = 'uniagent'
  const priorData = process.env.UNIAGENT_USER_DATA
  delete process.env.UNIAGENT_USER_DATA
  ;(globalThis as any).__frameHealthApp = {
    setName: (name: string) => { applicationName = name },
    getPath: (name: string) => { assert.equal(name, 'userData'); return '/isolated/' + applicationName },
    commandLine: {
      getSwitchValue: (name: string) => switches.get(name) || '',
      appendSwitch: (name: string, value: string) => switches.set(name, value)
    },
    disableHardwareAcceleration: () => assert.fail('frame recovery must retain GPU acceleration'),
    whenReady: () => { atReady = new Map(switches); return new Promise(() => {}) }
  }
  try {
    const result = await build({
      entryPoints: ['src/main/launch.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
      define: { 'process.platform': JSON.stringify(platform), 'process.env.UA_DISABLE_GPU': 'undefined' },
      plugins: [{ name: 'launch-fixture', setup(builder) {
        builder.onResolve({ filter: /^electron$|^\.\/startupWindow$|^\.\/index$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
          ? 'export const app = globalThis.__frameHealthApp; export const BrowserWindow = null, dialog = null, ipcMain = null;'
          : args.path === './startupWindow'
            ? 'export const createAppWindow = null, rememberStartupWindow = null, resolveUiPath = null, startupTimings = {};'
            : '' }))
      } }]
    })
    await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`)
    assert.equal(applicationName, INTERNAL_DISTRIBUTION ? 'uniagent' : APP_NAME)
    assert.equal(process.env.UNIAGENT_USER_DATA, INTERNAL_DISTRIBUTION ? undefined : '/isolated/UniAgent Public')
    return atReady!
  } finally {
    delete (globalThis as any).__frameHealthApp
    if (priorData === undefined) delete process.env.UNIAGENT_USER_DATA
    else process.env.UNIAGENT_USER_DATA = priorData
  }
}

const mac = await launchSwitches('darwin', { 'disable-features': 'ExistingFeature' })
assert.equal(mac.get('disable-features'), 'ExistingFeature,CVDisplayLinkBeginFrameSource',
  'macOS must select the bounded timer frame source before Electron becomes ready')
assert.equal(mac.has('disable-frame-rate-limit'), false, 'do not enable an unbounded frame loop')
assert.equal(mac.has('disable-gpu-vsync'), false)
assert.equal((await launchSwitches('darwin', { 'disable-features': 'CVDisplayLinkBeginFrameSource,ExistingFeature' }))
  .get('disable-features'), 'CVDisplayLinkBeginFrameSource,ExistingFeature', 'preserve existing switches without duplicates')
for (const platform of ['linux', 'win32']) {
  assert.equal((await launchSwitches(platform, { 'disable-features': 'ExistingFeature' })).get('disable-features'), 'ExistingFeature')
}

function fixture(recoveries: number[] = []) {
  let now = 0, id = 0, restarts = 0
  const records: { kind: string; data: Record<string, unknown> }[] = []
  const monitor = new FrameHealthMonitor({
    recoveries, send: value => { id = value }, recover: () => { restarts++; return true },
    record: (kind, data) => records.push({ kind, data })
  })
  return {
    monitor, records, recoveries,
    get restarts() { return restarts }, get id() { return id }, get now() { return now },
    tick(visible = true, elapsed = FRAME_PROBE_INTERVAL_MS) { now += elapsed; monitor.tick(now, visible) },
    reply(kind: FrameHealthReply['kind'], delay = 10, replyId = id) { monitor.reply({ id: replyId, kind }, now + delay) },
    stall(count = 3) { for (let n = 0; n < count; n++) { this.reply('responsive'); this.tick() } }
  }
}

{
  const f = fixture()
  f.tick()
  for (let n = 0; n < 10; n++) { f.reply('responsive'); f.reply('painted', 40); f.tick() }
  assert.equal(f.restarts, 0, 'healthy frames must never restart the GPU')
  f.stall(2)
  assert.equal(f.restarts, 0, 'one delayed frame sequence is insufficient')
  f.stall(1)
  assert.equal(f.restarts, 1, 'responsive JS with three missing frame probes reproduces the freeze')
  assert.equal(f.records[0].kind, 'frame_stalled')
  f.reply('responsive'); f.reply('painted', 40); f.tick()
  assert.equal(f.records.at(-1)?.kind, 'frame_recovered', 'recovery must be confirmed by new frames')
  f.stall(3)
  assert.equal(f.restarts, 1, 'recovery cooldown avoids rapid GPU restarts')
}
{
  const f = fixture()
  f.tick()
  for (let n = 0; n < 10; n++) f.tick()
  assert.equal(f.restarts, 0, 'unresponsive JS is not evidence of a GPU frame-source failure')
  for (let n = 0; n < 10; n++) { f.reply('responsive', 1_500); f.tick() }
  assert.equal(f.restarts, 0, 'late IPC replies must not misclassify a busy renderer')
  f.stall(2)
  f.reply('hidden'); f.tick()
  f.stall(2)
  assert.equal(f.restarts, 0, 'occlusion must clear partial stall evidence')
  f.tick(false)
  f.tick(); f.stall(2)
  assert.equal(f.restarts, 0, 'minimization/hidden windows must start with fresh evidence')
  f.reply('responsive'); f.tick(true, 60_000)
  f.tick(); f.stall(2)
  assert.equal(f.restarts, 0, 'sleep or a main-thread stall must clear elapsed-time evidence')
  f.monitor.reset(); f.tick(); f.stall(2)
  assert.equal(f.restarts, 0, 'navigation and wake must clear partial stall evidence')
}
{
  const f = fixture()
  f.tick()
  for (let n = 0; n < 10; n++) { f.reply('responsive', 10, f.id - 1); f.tick() }
  assert.equal(f.restarts, 0, 'old documents/replies cannot advance the current probe')
  for (const input of [null, [], 'responsive', { kind: 'responsive' }, { id: f.id, kind: 'unknown' }]) f.monitor.reply(input, f.now)
  f.tick()
  assert.equal(f.restarts, 0)
  f.stall(3)
  for (let n = 0; n < 40; n++) f.stall(1)
  assert.equal(f.restarts, 2, 'persistent failure is limited to two attempts in ten minutes')
  assert.equal(f.records.filter(record => record.kind === 'frame_recovery_limited').length, 1, 'diagnostics must be bounded too')
  const reopened = fixture(f.recoveries)
  reopened.tick(true, f.now + 1)
  reopened.tick(); reopened.stall(3)
  assert.equal(reopened.restarts, 0, 'reopening a window cannot evade the app-wide budget')
  f.tick(true, 10 * 60_000); f.tick(); f.stall(3)
  assert.equal(f.restarts, 3, 'recovery becomes available after the bounded budget window')
}
for (const recover of [() => false, () => { throw Object.assign(new Error('failure'), { code: 'ESRCH' }) }]) {
  let id = 0
  const records: string[] = []
  const monitor = new FrameHealthMonitor({ recoveries: [], recover, send: value => { id = value }, record: kind => records.push(kind) })
  for (let now = 0; now <= 6_000; now += 2_000) { monitor.tick(now, true); monitor.reply({ id, kind: 'responsive' }, now + 10) }
  assert.match(records.at(-1)!, /^frame_recovery_(unavailable|failed)$/)
}

// Exercise the actual preload probe with a controllable browser frame scheduler.
{
  let hidden = false, nextFrame = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const listeners = new Map<string, EventListenerOrEventListenerObject>()
  const replies: FrameHealthReply[] = []
  const probe = createFrameProbe({
    requestAnimationFrame: callback => { callbacks.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => { callbacks.delete(id) }
  }, {
    get hidden() { return hidden },
    addEventListener: (event, callback) => { listeners.set(event, callback) },
    removeEventListener: event => { listeners.delete(event) }
  }, message => replies.push(message))
  const frame = () => { const batch = [...callbacks.values()]; callbacks.clear(); for (const callback of batch) callback(1) }
  for (const invalid of [null, '1', 0, -1, NaN, 1.5]) probe.probe(invalid)
  assert.equal(replies.length, 0)
  probe.probe(1)
  assert.deepEqual(replies, [{ id: 1, kind: 'responsive' }])
  frame()
  assert.equal(replies.length, 1, 'one synthetic MISSED frame does not establish a live frame source')
  frame()
  assert.deepEqual(replies.at(-1), { id: 1, kind: 'painted' })
  probe.probe(2); probe.probe(3)
  assert.equal(callbacks.size, 1, 'stalled probes cannot accumulate RAF callbacks')
  frame(); frame()
  assert.deepEqual(replies.at(-1), { id: 3, kind: 'painted' })
  probe.probe(4)
  hidden = true
  ;(listeners.get('visibilitychange') as () => void)()
  assert.deepEqual(replies.at(-1), { id: 4, kind: 'hidden' })
  assert.equal(callbacks.size, 0, 'becoming hidden must cancel pending frames immediately')
  probe.probe(5)
  assert.deepEqual(replies.at(-1), { id: 5, kind: 'hidden' })
  assert.equal(callbacks.size, 0)
  hidden = false; probe.probe(6); probe.dispose()
  assert.equal(callbacks.size, 0)
  assert.equal(listeners.size, 0, 'unloading the document removes all probe work')
}

const adapter = await build({
  entryPoints: ['src/main/windowFrameHealth.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  define: { 'process.platform': '"darwin"' },
  plugins: [{ name: 'electron-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$|^node:perf_hooks$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
      ? 'export const { app, ipcMain, powerMonitor } = globalThis.__frameHealthElectron;'
      : 'export const performance = { now: () => globalThis.__frameHealthNow };' }))
  } }]
})

async function adapterFixture(metrics: () => { type: string; pid: number; creationTime: number }[]) {
  const app = Object.assign(new EventEmitter(), { getAppMetrics: metrics })
  const ipcMain = new EventEmitter(), powerMonitor = new EventEmitter()
  let probeId = 0, interval: (() => void) | undefined, timerCleared = false
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false, isLoadingMainFrame: () => false,
    send(channel: string, id: number) { assert.equal(channel, FRAME_HEALTH_PROBE); probeId = id }
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false
  })
  const old = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, kill: process.kill, warn: console.warn }
  const signals: { pid: number; signal: unknown }[] = []
  const records: string[] = []
  ;(globalThis as any).__frameHealthElectron = { app, ipcMain, powerMonitor }
  ;(globalThis as any).__frameHealthNow = 0
  globalThis.setInterval = ((callback: () => void) => { interval = callback; return { unref() {} } }) as any
  globalThis.clearInterval = (() => { timerCleared = true }) as any
  process.kill = ((pid: number, signal: unknown) => { signals.push({ pid, signal }); return true }) as any
  console.warn = () => {}
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(adapter.outputFiles[0].text).toString('base64')}#${Math.random()}`)
    module.setFrameHealthReporter((kind: string) => records.push(kind))
    module.monitorWindowFrames(window)
    for (const event of ['show', 'hide', 'minimize', 'restore']) assert.equal(window.listenerCount(event), 1)
    const tick = () => { (globalThis as any).__frameHealthNow += 2_000; interval!() }
    const reply = (sender = contents, senderFrame = contents.mainFrame) => ipcMain.emit(FRAME_HEALTH_REPLY, { sender, senderFrame }, { id: probeId, kind: 'responsive' })
    tick()
    for (let i = 0; i < 4; i++) { reply({} as any); tick(); reply(contents, {}); tick() }
    assert.equal(signals.length, 0, 'other windows and subframes cannot request GPU recovery')
    reply(); tick(); reply(); tick()
    contents.emit('did-start-navigation', {}, 'new-page', false, true)
    tick(); reply(); tick(); reply(); tick()
    assert.equal(signals.length, 0, 'document navigation invalidates prior evidence')
    powerMonitor.emit('suspend')
    for (let i = 0; i < 4; i++) { reply(); tick() }
    assert.equal(signals.length, 0, 'suspended applications do not recover graphics processes')
    powerMonitor.emit('lock-screen'); powerMonitor.emit('resume')
    for (let i = 0; i < 4; i++) { reply(); tick() }
    assert.equal(signals.length, 0, 'resume does not clear a separate screen-lock pause')
    powerMonitor.emit('unlock-screen')
    tick()
    for (let i = 0; i < 3; i++) { reply(); tick() }
    window.emit('closed')
    for (const event of ['show', 'hide', 'minimize', 'restore']) assert.equal(window.listenerCount(event), 0)
    assert.equal(timerCleared, true)
    assert.equal(ipcMain.listenerCount(FRAME_HEALTH_REPLY), 0)
    assert.equal(contents.listenerCount('did-start-navigation'), 0)
    assert.equal(app.listenerCount('before-quit'), 0)
    assert.equal(powerMonitor.eventNames().length, 0)
    const afterClose = signals.length
    interval!()
    assert.equal(signals.length, afterClose)
    return { signals, records }
  } finally {
    window.emit('closed')
    globalThis.setInterval = old.setInterval; globalThis.clearInterval = old.clearInterval
    process.kill = old.kill; console.warn = old.warn
    delete (globalThis as any).__frameHealthElectron
    delete (globalThis as any).__frameHealthNow
  }
}

assert.deepEqual((await adapterFixture(() => [
  { type: 'Browser', pid: process.pid, creationTime: 1 },
  { type: 'Utility', pid: 100, creationTime: 1 },
  { type: 'GPU', pid: 200, creationTime: 2 }
])).signals, [{ pid: 200, signal: 'SIGTERM' }], 'only this Electron app\'s GPU child can be restarted')
for (const type of ['Browser', 'Utility', 'Tab']) {
  assert.deepEqual((await adapterFixture(() => [{ type, pid: 200, creationTime: 1 }])).signals, [])
}
assert.deepEqual((await adapterFixture(() => [{ type: 'GPU', pid: process.pid, creationTime: 1 }])).signals, [])
let lookup = 0
assert.deepEqual((await adapterFixture(() => [{ type: 'GPU', pid: 200, creationTime: ++lookup }])).signals, [],
  'a recycled PID must not be signalled')

console.log('frame-health: startup switches, stopped frames, recovery limits, visibility, delayed JS, IPC ownership, GPU targeting and lifecycle cleanup passed')
