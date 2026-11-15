import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'

let delay = 15_000
let workerStarted: (worker: FixtureWorker) => void
class FixtureWorker extends EventEmitter {
  closed = false
  constructor(_path: unknown, readonly launch: any) { super(); workerStarted(this) }
  postMessage({ id, method }: { id?: string; method: string }) {
    if (method === 'close') { this.closed = true; queueMicrotask(() => this.emit('exit', 0)); return }
    const value = method === 'initialize' ? { capabilities: ['goal_v1'], commands: [], skills: [] }
      : method === 'auth' ? true : method === 'models' ? [{ value: 'qfmodel', displayName: 'Flash' }]
        : method === 'plugins.list' ? [] : method === 'mcp' ? { mcpServers: [] } : { remaining: 42 }
    const reply = () => { if (!this.closed) this.emit('message', { id, value }) }
    if (method === 'initialize') setTimeout(reply, delay)
    else queueMicrotask(reply)
  }
  async terminate() { this.closed = true; return 0 }
}

const stubs = {
  'node:worker_threads': 'export const Worker = globalThis.FixtureWorker',
  './agentSetupCredentials': 'export const nativeCredentialEnv = () => ({}); export const loadNativeCredentials = async () => {}',
  './agentSetupProcess.ts': 'export const findAgentExecutable = async () => process.execPath'
}
const bundle = await build({
  stdin: { contents: `export { configureQoderRegionProvider, detectAgents } from './src/main/agents.ts';
    export { qoderOperation } from './src/main/qoderSdk.ts';
    export { discoverQoderNativeSnapshot } from './src/main/qoderNativeCapabilities.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('src/main/sdkWorkerClient.ts')).href) },
  plugins: [{ name: 'qoder-worker-fixture', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const path = args.path === './agentSetupCredentials.ts' ? './agentSetupCredentials' : args.path
      return Object.hasOwn(stubs, path) ? { path, namespace: 'fixture' } : undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }]
})
const context = vm.createContext({ module: { exports: {} }, require: createRequire(import.meta.url),
  process, console, Buffer, URL, AbortController, FixtureWorker,
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer) })
context.exports = context.module.exports
vm.runInContext(bundle.outputFiles[0].text, context)
const api = context.module.exports

for (const region of ['cn', 'global']) {
  const bin = region === 'cn' ? '/fixture/qoderclicn' : '/fixture/qodercli'
  const agent = { id: 'qoder', bin }
  for (const operation of ['detection', 'account', 'capabilities']) {
    test(`Qoder ${region} ${operation} accepts initialization after 15 seconds`, async t => {
      let started!: (worker: FixtureWorker) => void
      const starting = new Promise<FixtureWorker>(resolve => { started = resolve })
      workerStarted = started
      delay = 15_000
      t.mock.timers.enable({ apis: ['setTimeout'] })
      api.configureQoderRegionProvider(() => region)
      const pending = operation === 'detection' ? api.detectAgents('all', 'qoder')
        : operation === 'account' ? api.qoderOperation(bin, 'usage') : api.discoverQoderNativeSnapshot(agent, '/fixture')
      const worker = await starting
      t.mock.timers.tick(15_000)
      const result = await pending
      assert.equal(worker.launch.workerData.initializeTimeoutMs, 30_000, 'the daemon receives the same 30-second initialization budget')
      assert.equal(worker.closed, true, 'completed probes close their SDK worker')
      if (operation === 'detection') {
        assert.equal(result[0].installed, true)
        assert.notEqual(result[0].lifecycle?.detectionStatus, 'failed', 'initialization beyond 10 seconds must remain usable')
        assert.equal(result[0].models[0].id, 'qfmodel')
      } else if (operation === 'account') assert.equal(result.remaining, 42)
      else assert.equal(result.actions.goal, true)
    })
  }
  test(`Qoder ${region} still times out and closes its worker at 30 seconds`, async t => {
    const starting = new Promise<FixtureWorker>(resolve => { workerStarted = resolve })
    delay = 60_000
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = api.qoderOperation(bin, 'usage')
    const rejected = assert.rejects(pending, /Qoder SDK initialize 超时/)
    const worker = await starting
    t.mock.timers.tick(29_999)
    assert.equal(worker.closed, false, 'a slow initialization keeps its full budget')
    t.mock.timers.tick(1)
    await rejected
    assert.equal(worker.closed, true, 'the timeout retains SDK cleanup')
  })
}
