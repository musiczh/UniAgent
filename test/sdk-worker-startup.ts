import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-worker-startup-')))
const app = join(root, 'UniAgent.app')
const moved = join(root, 'rebuilding.app')
const main = join(app, 'Contents/Resources/app.asar/out/main')
const workerSource = `import { parentPort, workerData } from 'node:worker_threads'
if (workerData.fail) throw Object.assign(new Error(workerData.fail), { code: 'ENOENT', path: workerData.errorPath })
parentPort.on('message', ({ id, method, args }) => {
  if (method === 'close') { parentPort.close(); return }
  if (method === 'runtimeFailure') throw Object.assign(new Error('runtime failure'), { code: 'ENOENT', path: workerData.app })
  parentPort.postMessage({ id, value: method === 'initialize' ? workerData.label : args })
})`
let starts = 0
let beforeStart: (() => void) | undefined
let failed: (() => void) | undefined
class FixtureWorker extends Worker {
  constructor(path: string | URL, options: any) {
    starts++
    beforeStart?.()
    // Resolve the real file before importing it so the fixture reproduces the
    // observed lstat ENOENT independently of the host Node entry loader.
    super(`const { workerData } = require('node:worker_threads')
      require('node:fs').realpathSync(workerData.entry)
      import(require('node:url').pathToFileURL(workerData.entry).href)`, {
      ...options, eval: true, workerData: { ...options.workerData, entry: path instanceof URL ? fileURLToPath(path) : path }
    })
    this.once('error', () => failed?.())
  }
}
;(globalThis as any).SdkFixtureWorker = FixtureWorker

try {
  await mkdir(main, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  for (const name of ['qoderSdkWorker', 'claudeSdkWorker']) await writeFile(join(main, name + '.js'), workerSource)
  const entry = join(main, 'client.mjs')
  await build({ entryPoints: ['src/main/sdkWorkerClient.ts'], bundle: true, platform: 'node', format: 'esm', outfile: entry,
    plugins: [{ name: 'real-worker-startup-race', setup(builder) {
      builder.onResolve({ filter: /^node:worker_threads$/ }, () => ({ path: 'worker', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const Worker = globalThis.SdkFixtureWorker', loader: 'js' }))
    } }] })
  const { SdkWorkerClient } = await import(pathToFileURL(entry).href)
  const launch = (label: string, extras = {}) => ({ options: { env: {} }, initializeTimeoutMs: 1_000, label, app, ...extras })
  const open = (label: string, extras = {}) => {
    const client = new SdkWorkerClient(launch(label, extras), label, label === 'Qoder' ? 'qoderSdkWorker' : 'claudeSdkWorker')
    client.on('failure', () => {})
    return client
  }

  for (const label of ['Qoder', 'Claude']) {
    starts = 0
    beforeStart = () => { if (starts === 1) renameSync(app, moved) }
    failed = () => { if (starts === 1) renameSync(moved, app) }
    const client = open(label)
    const failures: Error[] = []
    client.on('failure', (error: Error) => failures.push(error))
    try {
      assert.equal(await client.ready, label, 'a real Worker recovers when the App disappears between checking and loading its entry')
      assert.equal(starts, 2)
      assert.deepEqual(failures, [], 'a recovered initialization does not publish a task failure')
      assert.equal(await client.request('echo', 'one input'), 'one input', 'the recovered worker receives requests once')
    } finally { await client.close() }
  }

  starts = 0
  beforeStart = undefined
  failed = undefined
  renameSync(app, moved)
  const restoring = open('Qoder')
  const restored = new Promise<void>(resolve => setTimeout(() => { renameSync(moved, app); resolve() }, 100))
  try {
    assert.equal(await restoring.ready, 'Qoder', 'a missing bundle at the initial check is given the same recovery budget')
    assert.equal(starts, 1, 'no worker starts before its entry returns')
  } finally { await restored; await restoring.close() }

  starts = 0
  const unrelated = open('Qoder', { fail: 'unrelated missing file', errorPath: join(root, 'unrelated') })
  try {
    await assert.rejects(unrelated.ready, /unrelated missing file/)
    assert.equal(starts, 1, 'an unrelated ENOENT is not retried')
  } finally { await unrelated.close() }

  starts = 0
  const running = open('Qoder')
  try {
    await running.ready
    await assert.rejects(running.request('runtimeFailure'), /runtime failure/)
    assert.equal(starts, 1, 'errors after initialization do not restart or replay a running task')
  } finally { await running.close() }

  starts = 0
  beforeStart = () => { if (starts === 1) renameSync(app, moved) }
  const missing = open('Qoder', { initializeTimeoutMs: 300 })
  const startedAt = Date.now()
  try {
    await assert.rejects(missing.ready, /后台运行文件缺失|ENOENT/)
    assert.ok(Date.now() - startedAt >= 250, 'a missing App is allowed to recover before failing')
    assert.ok(Date.now() - startedAt < 1_000, 'a permanently missing App cannot extend the initialization budget')
  } finally { await missing.close(); renameSync(moved, app) }

  starts = 0
  let workerFailed!: () => void
  const firstError = new Promise<void>(resolve => { workerFailed = resolve })
  failed = workerFailed
  const cancelled = open('Claude')
  const rejection = assert.rejects(cancelled.ready)
  try {
    await firstError
    await new Promise(resolve => setTimeout(resolve, 25))
    await cancelled.close()
    await rejection
    assert.equal(starts, 1, 'closing during recovery never starts another worker')
  } finally { await cancelled.close(); renameSync(moved, app) }
  console.log('SDK Worker startup recovery, failure boundaries and cancellation passed')
} finally {
  delete (globalThis as any).SdkFixtureWorker
  await rm(root, { recursive: true, force: true })
}
