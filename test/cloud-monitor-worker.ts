import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { validateMonitorRecord } from '../src/shared/cloudMonitor'

const root = await mkdtemp(join(tmpdir(), 'uniagent-monitor-worker-'))
const source = randomUUID(), attempt = randomUUID(), user = randomUUID(), enabledAt = Date.now() - 1000
let worker: Worker | undefined, rejectUpload = true, signups = 0
const uploads: any[][] = [], accepted = new Map<string, unknown>()
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  response.setHeader('content-type', 'application/json')
  if (request.url === '/auth/v1/signup') {
    signups++; response.end(JSON.stringify({ access_token: 'worker-access', refresh_token: 'worker-refresh', expires_in: 3600, user: { id: user, is_anonymous: true } })); return
  }
  if (request.url === '/functions/v1/monitor-ingest') {
    const rows = JSON.parse(body); uploads.push(rows)
    if (rejectUpload) { response.statusCode = 503; response.end('{}'); return }
    const saved: string[] = [], duplicates: string[] = []
    for (const row of rows) {
      if (!validateMonitorRecord(row)) { response.statusCode = 400; response.end('{}'); return }
      if (accepted.has(row.eventId)) duplicates.push(row.eventId)
      else { accepted.set(row.eventId, row); saved.push(row.eventId) }
    }
    response.end(JSON.stringify({ accepted: saved, duplicates, rejected: [], limited: [] })); return
  }
  response.statusCode = 404; response.end('{}')
})
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('Timed out: ' + label)
}
async function state(): Promise<any> { try { return JSON.parse(await readFile(join(root, 'cloud-monitor/state.json'), 'utf8')) } catch { return undefined } }
async function closeWorker() { if (!worker) return; const exited = once(worker, 'exit'); worker.postMessage({ kind: 'close' }); await exited; worker = undefined }
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const entry = join(root, 'cloudMonitorWorker.mjs')
  await build({ entryPoints: ['src/main/cloudMonitorWorker.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry })
  await mkdir(join(root, 'router/reviews', source), { recursive: true })
  const feedback = { requestId: source, attemptId: attempt, revision: 1, savedAt: enabledAt + 100, matches: false, reason: '应复用 /Users/private/path', actual: { prompt: 'private source prompt', decision: { action: 'create_task_in_space' } }, expected: { kind: 'reuse_task', taskTitle: 'private title' } }
  await writeFile(join(root, 'router/reviews', source, 'review.json'), JSON.stringify({ schemaVersion: 1, feedbacks: [{ ...feedback, revision: 0, savedAt: enabledAt - 1 }, feedback] }))
  const start = () => new Worker(new URL('file://' + entry), { workerData: { root, config: { url: 'http://127.0.0.1:' + address.port, publishableKey: 'public-worker-fixture' }, appVersion: '1.1.0', distribution: 'public', enabledAt, intervalMs: 25 }, env: { ...process.env, UNIAGENT_USER_DATA: root } })
  worker = start()
  worker.postMessage({ kind: 'diagnostic', id: 1, data: { ts: Date.now(), code: 'failed', level: 'error', agentId: 'codex', source: 'transport', message: 'token=private-credential /Users/private/code', count: 1, prompt: 'private prompt', sample: 'private code' } })
  worker.postMessage({ kind: 'performance', id: 2, code: 'resource_sample', at: Date.now(), data: { cpuPercent: 12, rssBytes: 1024, processes: [{ name: 'private-application' }], commandLine: 'private command' } })
  await until(async () => (await state())?.lastError === 'http_503' ? true : undefined, 'failed upload remains durable')
  await closeWorker()
  const pending = await state()
  assert.equal(pending.records.length, 3, 'post-enable feedback is recovered alongside live diagnostics and metrics')
  assert.ok(pending.session?.startsWith('local:v1:'))
  assert.doesNotMatch(JSON.stringify(pending), /worker-access|worker-refresh|private-credential|private source|private title|private-application|private command/)
  assert.doesNotMatch(JSON.stringify(uploads), new RegExp(source + '|' + attempt))
  assert.equal(signups, 1)
  pending.nextAttemptAt = 0
  await writeFile(join(root, 'cloud-monitor/state.json'), JSON.stringify(pending))
  rejectUpload = false; worker = start()
  await until(async () => (await state())?.records.length === 0 && accepted.size === 3 ? true : undefined, 'restart retries and drains the same durable events')
  await closeWorker()
  assert.equal(signups, 1, 'a worker restart reuses the encrypted identity')
  assert.equal([...accepted.values()].filter((row: any) => row.category === 'router_feedback').length, 1, 'pre-enable feedback was not uploaded')
  console.log('cloud monitor real worker: durable recovery, offline retry, redaction, encrypted identity passed')
} finally {
  if (worker) await worker.terminate()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
