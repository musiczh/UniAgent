import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await realpath(await mkdtemp(join(tmpdir(), 'qoder-send-')))
await writeFile(join(root, 'package.json'), '{"type":"module"}')
const sdkFixture = `
import { workerData } from 'node:worker_threads'
const messages = [], inputs = []
let wake, closed = false
function push(row) { messages.push(row); wake?.(); wake = undefined }
export async function startDaemon() { return { onFailure() {}, async stop() {} } }
export function qodercliAuth() { return {} }
export function query({ prompt }) {
  void (async () => {
    for await (const input of prompt) {
      inputs.push(input)
      const fixture = workerData.fixture
      if (fixture.state) push({ type: 'command_lifecycle', command_uuid: fixture.foreign ? 'foreign-input' : input.uuid, state: fixture.state, uuid: 'event-id' })
      if (fixture.replay) push({ type: 'user', uuid: input.uuid, isReplay: true, message: input.message })
      push({ type: 'tool_progress', tool_use_id: 'tool-id', tool_name: 'Bash', output: 'still running' })
    }
  })()
  return {
    async initializationResult() { return {} },
    async getContextUsage() { return { inputs } },
    async setModel(row) { push(row) },
    async close() { closed = true; wake?.() },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (messages.length) yield messages.shift()
        else await new Promise(resolve => { wake = resolve })
      }
    }
  }
}`
await build({ entryPoints: ['src/main/qoderSdkWorker.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: join(root, 'qoderSdkWorker.js'), plugins: [{ name: 'qoder-protocol-fixture', setup(builder) {
    builder.onResolve({ filter: /^@qoder(?:cn)?-ai\/qoder(?:cn)?-agent-sdk$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: sdkFixture, loader: 'js' }))
  } }] })
await build({ entryPoints: ['src/main/sdkWorkerClient.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'client.mjs') })
const { SdkWorkerClient } = await import(pathToFileURL(join(root, 'client.mjs')).href)
const clients = new Set<InstanceType<typeof SdkWorkerClient>>()
after(async () => { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }) })

async function open(region: string, fixture: Record<string, unknown>) {
  const client = new SdkWorkerClient({ region, options: { env: {}, cwd: root }, fixture }, 'Qoder', 'qoderSdkWorker')
  clients.add(client)
  await client.ready
  return client
}

for (const region of ['cn', 'global']) {
  for (const state of ['queued', 'started', 'completed']) {
    test(`Qoder ${region} acknowledges ${state} before the task finishes`, async t => {
      const client = await open(region, { state })
      const rows: any[] = []
      client.on('message', row => rows.push(row))
      try {
        const progress = once(client, 'message').then(() => {})
        await client.request('send', { uuid: 'input-1', content: 'run a long tool', waitForReplay: true }, 250)
        await progress
        assert.ok(rows.some(row => row.type === 'command_lifecycle' && row.command_uuid === 'input-1'))
        assert.equal(rows.some(row => row.type === 'result'), false, 'delivery completes while execution is still active')
        t.mock.timers.enable({ apis: ['setTimeout'] })
        t.mock.timers.tick(30_000)
        assert.equal((await client.request('context')).inputs.length, 1, 'a long task does not time out or resubmit its input')
        const finished = once(client, 'message')
        await client.request('setModel', { type: 'result', subtype: 'success', is_error: false })
        assert.equal((await finished)[0].type, 'result', 'the same worker remains connected until the task result')
      } finally { await client.close(); clients.delete(client) }
    })
  }
  for (const state of ['cancelled', 'discarded']) {
    test(`Qoder ${region} rejects ${state} input immediately`, async () => {
      const client = await open(region, { state })
      try {
        await assert.rejects(client.request('send', { uuid: 'cancelled-input', content: 'one input', waitForReplay: true }, 250), /Qoder 输入已被取消|Qoder 输入已被丢弃/)
      } finally { await client.close(); clients.delete(client) }
    })
  }
  test(`Qoder ${region} ignores lifecycle receipts for another input`, async () => {
    const client = await open(region, { state: 'queued', foreign: true })
    try {
      await assert.rejects(client.request('send', { uuid: 'own-input', content: 'one input', waitForReplay: true }, 100), /Qoder SDK send 超时/)
    } finally { await client.close(); clients.delete(client) }
  })
  test(`Qoder ${region} retains replay receipts and rejects pending input on close`, async () => {
    const replay = await open(region, { replay: true })
    try { await replay.request('send', { uuid: 'replayed', content: 'one input', waitForReplay: true }, 250) }
    finally { await replay.close(); clients.delete(replay) }
    const pending = await open(region, {})
    const progress = once(pending, 'message')
    const sent = pending.request('send', { uuid: 'pending', content: 'one input', waitForReplay: true })
    const rejected = assert.rejects(sent, /Qoder SDK 会话已关闭/)
    await progress
    await pending.close(); clients.delete(pending)
    await rejected
  })
}
