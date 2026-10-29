import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const root = await mkdtemp(join(tmpdir(), 'uniagent-performance-worker-'))
let worker: Worker | undefined
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out: ' + label)
}
async function rows(stream: string): Promise<any[]> {
  try { return (await readFile(join(root, 'logs', stream + '.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

try {
  const entry = join(root, 'performanceWorker.mjs')
  await build({ entryPoints: ['src/main/performanceWorker.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry })
  worker = new Worker(pathToFileURL(entry), { workerData: { root: join(root, 'logs'), pid: process.pid, appVersion: 'worker-test' } })
  const failure: Error[] = []
  worker.on('error', error => failure.push(error))
  worker.postMessage({ kind: 'main_sample', data: { heapBytes: 1024, processes: [{ pid: process.pid, type: 'Browser' }] } })
  worker.postMessage({ kind: 'startup', data: { windowShownMs: 1, initializedMs: 2 } })
  const snapshot = await until(async () => (await rows('app')).find(row => row.kind === 'snapshot'), 'real worker resource snapshot')
  assert.equal(snapshot.data.main.heapBytes, 1024)
  assert.equal(snapshot.data.tree.processes.find((row: any) => row.pid === process.pid).type, 'Browser')
  assert.equal(snapshot.data.mainHeartbeatAgeMs < 12_000, true)
  assert.equal((await rows('app')).find(row => row.kind === 'startup').data.windowShownMs, 1, 'startup timing records remain compatible')
  worker.postMessage({ kind: 'renderer_stall', data: { longestMs: 500, visible: true } })
  const incident = await until(async () => (await rows('incidents')).find(row => row.kind === 'incident_event'), 'stall incident')
  assert.equal(incident.data.kind, 'renderer_stall')
  assert.equal((await rows('incidents')).find(row => row.kind === 'incident_context').data.sample.at, snapshot.data.at)
  worker.postMessage({ kind: 'suspend' })
  await until(async () => (await rows('app')).find(row => row.kind === 'monitor_reset' && row.data.reason === 'suspend'), 'suspend boundary')
  worker.postMessage({ kind: 'resume' })
  worker.postMessage({ kind: 'startup-ui', data: { uiReadyMs: 3 } })
  const exited = once(worker, 'exit')
  worker.postMessage({ kind: 'close' })
  const exitCode = await Promise.race([exited.then(([code]) => code), new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not close')), 3000)
    timer.unref()
  })])
  assert.equal(exitCode, 0)
  assert.deepEqual(failure, [])
  assert.equal((await rows('app')).some(row => row.kind === 'startup-ui'), true, 'close must drain earlier messages before exiting')
  worker = undefined

  // Exercise the real main-process facade with controlled Electron and worker boundaries.
  let tick: () => void = () => {}, clock = 5000, disabled = false, cleared = false, throwOnStart = false
  const power = new EventEmitter()
  const messages: any[] = []
  const created: FakeWorker[] = []
  class FakeWorker extends EventEmitter {
    constructor(public url: URL, public options: unknown) {
      super()
      if (throwOnStart) throw new Error('start failed')
      created.push(this)
    }
    unref() {}
    postMessage(message: any) {
      messages.push(message)
      if (message.kind === 'close') queueMicrotask(() => this.emit('exit', 0))
    }
    terminate() { assert.fail('a healthy worker must close without forced termination') }
  }
  const fixture = {
    Worker: FakeWorker, powerMonitor: power,
    app: { getVersion: () => 'test', getAppMetrics: () => [{ pid: process.pid, type: 'Browser', memory: { workingSetSize: 100 } }] },
    performance: { now: () => clock, eventLoopUtilization: () => ({ utilization: 0.1 }) },
    monitorEventLoopDelay: () => ({ max: 500_000_000, percentile: () => 250_000_000, enable() {}, disable() { disabled = true }, reset() {} }),
    setInterval: (callback: () => void) => { tick = callback; return { unref() {} } },
    clearInterval: () => { cleared = true }
  }
  ;(globalThis as any).__performanceFixture = fixture
  const facade = join(root, 'facade.mjs')
  await build({ entryPoints: ['src/main/performanceMonitor.ts'], bundle: true, platform: 'node', format: 'esm', outfile: facade,
    banner: { js: 'const { setInterval, clearInterval } = globalThis.__performanceFixture;' },
    plugins: [{ name: 'monitor-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(electron|node:worker_threads|node:perf_hooks)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
        ? 'export const { app, powerMonitor } = globalThis.__performanceFixture;'
        : args.path === 'node:worker_threads' ? 'export const { Worker } = globalThis.__performanceFixture;'
          : 'export const { performance, monitorEventLoopDelay } = globalThis.__performanceFixture;' }))
    } }] })
  const { PerformanceMonitor } = await import(pathToFileURL(facade).href)
  const monitor = new PerformanceMonitor(root, () => ({ sessions: 2 }))
  assert.equal(created[0].url.pathname.endsWith('/performanceWorker.js'), true)
  clock = 10_000; monitor.event(); tick()
  assert.equal(messages.find(row => row.kind === 'main_sample').data.sessions, 2)
  assert.equal(messages.some(row => row.kind === 'main_stall'), true)
  monitor.rendererSample({ heapBytes: 1e20, longestMs: -1, count: NaN, visible: true, secret: 'must-not-be-logged' }, true)
  const metrics = messages.at(-1).data
  assert.equal(metrics.heapBytes, 64 * 1024 ** 3)
  assert.equal(metrics.longestMs, 0)
  assert.equal('count' in metrics, false)
  assert.equal('secret' in metrics, false)
  const before = messages.length
  for (const bad of [null, [], 'invalid']) monitor.rendererSample(bad, false)
  assert.equal(messages.length, before)
  power.emit('suspend'); power.emit('resume')
  const stalls = messages.filter(row => row.kind === 'main_stall').length
  clock = 15_000; tick()
  assert.equal(messages.filter(row => row.kind === 'main_stall').length, stalls, 'resume must discard sleep-inflated event loop delay')
  await monitor.close()
  assert.equal(disabled && cleared, true)
  assert.equal(power.listenerCount('resume') + power.listenerCount('suspend'), 0)
  const closedCount = messages.length
  monitor.record('after-close', {})
  assert.equal(messages.length, closedCount)
  await monitor.close()
  const warn = console.warn
  console.warn = () => {}
  try {
    throwOnStart = true
    const failed = new PerformanceMonitor(root, () => ({}))
    await failed.close()
  } finally { console.warn = warn }
} finally {
  delete (globalThis as any).__performanceFixture
  await worker?.terminate()
  await rm(root, { recursive: true, force: true })
}
console.log('performance-worker: ok; real collection, startup records, incident correlation, clean exit and main facade')
