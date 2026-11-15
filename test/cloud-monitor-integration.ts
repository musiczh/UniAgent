import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { RouterController } from '../src/main/router/controller'

const root = await mkdtemp(join(tmpdir(), 'uniagent-monitor-integration-'))
const messages: any[] = [], workers: FakeWorker[] = []
class FakeWorker extends EventEmitter {
  constructor(..._args: unknown[]) { super(); workers.push(this) }
  unref() {}
  postMessage(message: any) {
    messages.push(message)
    if (message.kind === 'close') queueMicrotask(() => this.emit('exit', 0))
    else queueMicrotask(() => this.emit('message', { kind: 'ack', id: message.id, stored: true }))
  }
  terminate() { return Promise.resolve(0) }
}
(globalThis as any).__monitorWorker = FakeWorker
try {
  const entry = join(root, 'facade.mjs')
  await build({ entryPoints: ['src/main/cloudMonitor.ts'], bundle: true, format: 'esm', platform: 'node', outfile: entry,
    plugins: [{ name: 'worker-boundary', setup(value) {
      value.onResolve({ filter: /^node:worker_threads$/ }, () => ({ path: 'worker', namespace: 'worker' }))
      value.onLoad({ filter: /.*/, namespace: 'worker' }, () => ({ contents: 'export const Worker = globalThis.__monitorWorker' }))
    } }] })
  const { CloudMonitor } = await import(pathToFileURL(entry).href)
  const monitor = new CloudMonitor({ root, config: { url: 'https://fixture.supabase.co', publishableKey: 'public-fixture' }, appVersion: '1.1.0', distribution: 'public', enabledAt: Date.now() })
  assert.equal(workers.length, 0, 'constructing monitoring must not start work on the startup critical path')
  monitor.diagnostic({ ts: Date.now(), code: 'failed', level: 'error', agentId: 'codex', source: 'transport', message: 'failed', count: 1, sessionId: 'private-session', sample: 'private-code' })
  monitor.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workers.length, 1)
  assert.ok(!('sample' in messages[0].data)); assert.ok(!('sessionId' in messages[0].data))
  const feedback = { requestId: randomUUID(), revision: 1, savedAt: Date.now(), matches: true, expectedRevision: 0, actual: {} }
  assert.equal(await monitor.feedback(feedback), true)
  workers[0].emit('error', new Error('worker failed'))
  assert.equal(await monitor.feedback(feedback), false, 'worker failure must not leave feedback saving waiting forever')
  await monitor.close()
  const order: string[] = []
  const controller = Object.create(RouterController.prototype) as any
  controller.store = { reviewSave: async () => { order.push('saved'); return { feedback } } }
  controller.deps = { changed: () => order.push('changed'), reviewSaved: async () => { order.push('queue'); throw new Error('disk unavailable') } }
  const result = await controller.saveReview({ requestId: feedback.requestId, expectedRevision: 0, matches: true })
  assert.equal(result.feedback, feedback)
  assert.deepEqual(order, ['saved', 'queue', 'changed'], 'monitoring failure does not undo or misreport a saved local review')
  console.log('cloud monitor integration: deferred startup, field selection, failure isolation passed')
} finally { delete (globalThis as any).__monitorWorker; await rm(root, { recursive: true, force: true }) }
